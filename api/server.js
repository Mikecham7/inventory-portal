const express = require('express');
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { normalizeInventoryRow, getSheetNameForClient, isAdminClient, getChatSenderRole, getClientInventoryFields, getDashboardColumns, getCreateFormTitleConfig, getChatDriveFolderForClient, isGoogleDriveUrl, normalizeDriveFolderUrl, getShipmentStage, findShipmentFieldKeys, SHIPMENT_STATUS_TEXT } = require('./portalLogic');
const { mapClientSettings, settingsFromInput, isValidQuickEditPin, planClientSettingsMigration } = require('./clientSchema');
const { RATE_SHEET, ENTRY_SHEET, HISTORY_SHEET, BILLING_RATE_HEADERS, BILLING_ENTRY_HEADERS, BILLING_HISTORY_HEADERS, MONTH_PATTERN, sanitizeRateCard, rateCardFromRow, entryFromRow, sanitizeEntry, historyFromRow, sanitizeHistory, currentMonth, summarizeBilling } = require('./billing');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;

app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// Excludes visually-ambiguous characters (0/O, 1/I/L) so codes are easy to read back over chat/phone.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function generateCode(length = 8) {
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return code;
}

async function hashSecret(value) {
  return bcrypt.hash(String(value), 10);
}

function looksHashed(value) {
  return /^\$2[aby]\$/.test(String(value || ''));
}

async function verifySecret(value, hash) {
  if (!looksHashed(hash)) return false;
  return bcrypt.compare(String(value ?? ''), String(hash));
}

// Hashing both sides first gives timingSafeEqual equal-length inputs and hides how much of a guess matched.
function constantTimeEqual(provided, stored) {
  const digest = (value) => crypto.createHash('sha256').update(String(value ?? '')).digest();
  return crypto.timingSafeEqual(digest(provided), digest(stored));
}

function normalizeCode(value) {
  return String(value ?? '').trim().toUpperCase();
}

function codesMatch(provided, stored) {
  return Boolean(normalizeCode(stored)) && constantTimeEqual(normalizeCode(provided), normalizeCode(stored));
}

// In-memory, so on Netlify each warm function instance keeps its own counters.
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_LIMITS = { ip: 20, user: 8 };
const authAttempts = new Map();

function requestIp(req) {
  return String(req.get('x-nf-client-connection-ip') || req.ip || req.socket?.remoteAddress || 'unknown');
}

function authRateLimit(req, res, next) {
  const now = Date.now();
  if (authAttempts.size > 10000) {
    for (const [key, entry] of authAttempts) if (entry.resetAt <= now) authAttempts.delete(key);
  }

  const username = String(req.rateLimitUser || req.body?.username || '').trim().toLowerCase();
  const keys = [[`ip:${requestIp(req)}`, AUTH_LIMITS.ip]];
  if (username) keys.push([`user:${username}`, AUTH_LIMITS.user]);

  const blocked = keys
    .map(([key, limit]) => {
      const entry = authAttempts.get(key);
      return entry && entry.resetAt > now && entry.count >= limit ? entry : null;
    })
    .find(Boolean);
  if (blocked) {
    res.set('Retry-After', String(Math.ceil((blocked.resetAt - now) / 1000)));
    return res.status(429).json({ success: false, error: 'Too many attempts. Please wait a few minutes and try again.' });
  }

  // Count up front so parallel guesses can't all slip past the check before any finish.
  keys.forEach(([key]) => {
    const entry = authAttempts.get(key);
    if (entry && entry.resetAt > now) entry.count += 1;
    else authAttempts.set(key, { count: 1, resetAt: now + AUTH_WINDOW_MS });
  });

  res.on('finish', () => {
    if ([400, 401, 403].includes(res.statusCode)) return;
    const ipEntry = authAttempts.get(keys[0][0]);
    if (ipEntry && ipEntry.count > 0) ipEntry.count -= 1;
    if (!username) return;
    if (res.statusCode < 300) authAttempts.delete(`user:${username}`);
    else {
      const userEntry = authAttempts.get(`user:${username}`);
      if (userEntry && userEntry.count > 0) userEntry.count -= 1;
    }
  });
  next();
}

// Separate purposes get separate keys, so a quick-edit unlock token can never pass as a session.
function signingKey(purpose) {
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!privateKey) throw new Error('Missing Google Sheets environment variables.');
  return crypto.createHash('sha256').update(`portal-${purpose}:${privateKey}`).digest();
}

function signToken(data, purpose) {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  const signature = crypto.createHmac('sha256', signingKey(purpose)).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function readToken(token, purpose) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature) return null;
  const expected = crypto.createHmac('sha256', signingKey(purpose)).update(payload).digest();
  const received = Buffer.from(signature, 'base64url');
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.expires > Date.now() && data.username && data.clientId ? data : null;
  } catch (error) {
    return null;
  }
}

function signNotificationSession(username, clientId, role) {
  return signToken({ username, clientId, role, expires: Date.now() + 12 * 60 * 60 * 1000 }, 'notifications');
}

function readNotificationSession(req) {
  return readToken(String(req.get('Authorization') || '').replace(/^Bearer\s+/i, ''), 'notifications');
}

const QUICK_EDIT_UNLOCK_MS = 30 * 60 * 1000;

function isStaffSession(session) {
  return Boolean(session) && (session.role === 'admin' || session.clientId === 'CL-000');
}

function getServiceAccountAuth() {
  const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  if (!serviceAccountEmail || !privateKey || !SHEET_ID) {
    throw new Error('Missing Google Sheets environment variables.');
  }

  return new JWT({
    email: serviceAccountEmail,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
}

function normalizeClientId(value) {
  const normalized = String(value ?? '').trim();
  return normalized ? normalized.toUpperCase() : '';
}

// Concurrent callers for the same key share one in-flight Sheets read; failures are never cached.
const readCache = new Map();
const INVENTORY_CACHE_MS = 8000;
const PROFILE_CACHE_MS = 60000;
const ROWS_CACHE_MS = 4000;

function cachedRead(key, ttlMs, loader) {
  const hit = readCache.get(key);
  if (hit && (hit.pending || Date.now() - hit.at < ttlMs)) return hit.promise;
  const entry = { pending: true, at: 0 };
  entry.promise = loader().then((value) => {
    entry.pending = false;
    entry.at = Date.now();
    return value;
  }, (error) => {
    if (readCache.get(key) === entry) readCache.delete(key);
    throw error;
  });
  readCache.set(key, entry);
  return entry.promise;
}

function invalidateReadCache(...prefixes) {
  for (const key of [...readCache.keys()]) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) readCache.delete(key);
  }
}

// Reuse a single GoogleSpreadsheet instance instead of re-authenticating and
// re-fetching spreadsheet metadata on every request, which was tripping Google's
// Sheets API rate limit (429 Too Many Requests) whenever multiple tabs/requests fired.
let cachedDoc = null;
let cachedDocLoadedAt = 0;
const DOC_CACHE_TTL_MS = 5 * 60 * 1000;

async function getDoc() {
  const now = Date.now();
  if (cachedDoc && (now - cachedDocLoadedAt) < DOC_CACHE_TTL_MS) {
    return cachedDoc;
  }

  const auth = getServiceAccountAuth();
  const doc = new GoogleSpreadsheet(SHEET_ID, auth);
  await withRetry(() => doc.loadInfo());
  cachedDoc = doc;
  cachedDocLoadedAt = now;
  return doc;
}

// Retries a Google API call with exponential backoff when it hits the 429 rate limit.
async function withRetry(fn, retries = 4, baseDelayMs = 500) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const status = error?.response?.status || error?.code;
      const isRateLimited = status === 429;
      if (!isRateLimited || attempt === retries) throw error;
      const delay = baseDelayMs * (2 ** attempt) + Math.floor(Math.random() * 250);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function getSheetByName(sheetName) {
  const doc = await getDoc();
  const targetName = String(sheetName || '').trim() || 'Inventory';

  if (doc.sheetsByTitle[targetName]) return doc.sheetsByTitle[targetName];
  const found = doc.sheetsByIndex.find((sheet) => sheet.title === targetName);
  if (found) return found;
  return doc.sheetsByIndex[0];
}

// Unlike getSheetByName(), this never falls back to an unrelated sheet (e.g. User_Credentials)
// when the requested tab doesn't exist — important once clients can be deleted.
async function findSheetByTitle(sheetName) {
  const doc = await getDoc();
  const targetName = String(sheetName || '').trim();
  if (!targetName) return null;
  return doc.sheetsByTitle[targetName] || doc.sheetsByIndex.find((sheet) => sheet.title === targetName) || null;
}

async function getOrCreateSheet(sheetName, headers = []) {
  const doc = await getDoc();
  let sheet = doc.sheetsByTitle[sheetName] || doc.sheetsByIndex.find((entry) => entry.title === sheetName);

  if (!sheet) {
    sheet = await doc.addSheet({ title: sheetName, headerValues: headers.length ? headers : undefined });
  }

  if (headers.length) {
    // Only checking cell A1 (as before) let stale sheets with an incomplete header row
    // (e.g. just "Timestamp, Sender, Message") silently keep missing columns like
    // ClientID/IsStaff, so getRows()/row.get() couldn't read data written into them.
    let currentHeaders = [];
    try {
      await withRetry(() => sheet.loadHeaderRow());
      currentHeaders = sheet.headerValues || [];
    } catch (error) {
      currentHeaders = [];
    }

    // Extra trailing columns are tolerated so a newer deploy's added columns aren't wiped.
    const headersMatch = headers.every((header, index) => String(currentHeaders[index] || '').trim().toLowerCase() === String(header).trim().toLowerCase());

    if (!headersMatch) {
      if (Number(sheet.columnCount) < headers.length) {
        await withRetry(() => sheet.resize({ rowCount: sheet.rowCount, columnCount: headers.length }));
      }
      await withRetry(() => sheet.setHeaderRow([...headers, ...currentHeaders.slice(headers.length)]));
    }
  }

  return sheet;
}

async function loadSheetRows(sheetName, rowLimitOverride = null) {
  const sheet = await getSheetByName(sheetName);
  const rowCount = Math.max(Number(sheet.rowCount) || 25, 25);
  const colCount = Math.max(Number(sheet.columnCount) || 9, 9);
  const effectiveRowLimit = rowLimitOverride ? Math.min(rowCount, Number(rowLimitOverride)) : rowCount;
  const effectiveColCount = Math.min(colCount, 26);

  await withRetry(() => sheet.loadCells(`A1:${String.fromCharCode(64 + effectiveColCount)}${effectiveRowLimit}`));

  const rows = [];
  for (let rowIndex = 0; rowIndex < effectiveRowLimit; rowIndex += 1) {
    const row = [];
    for (let colIndex = 0; colIndex < effectiveColCount; colIndex += 1) {
      const cell = sheet.getCell(rowIndex, colIndex);
      row.push(cell && cell.value !== undefined && cell.value !== null ? cell.value : '');
    }
    rows.push(row);
  }

  return rows;
}

// Full extended schema for User_Credentials. Columns A-E already existed in production;
// everything from Edit_PIN onward is appended so existing rows/data are never reordered.
const USER_CREDENTIALS_HEADERS = [
  'Client_ID', 'Username', 'Password', 'Client_Name', 'Email', 'Edit_PIN', 'Role',
  'Portal_Title', 'Portal_Subtitle', 'Inventory_Mode', 'Enable_Add_Item', 'Accent_Color',
  'Allow_Chat', 'Allow_Logs', 'Allow_Update', 'Drive_Folder_URL', 'Read_Only', 'Require_Pin',
  'Title_Field_Label', 'Title_Field_Placeholder', 'Fields_JSON',
  'Activation_Code', 'Recovery_Code_Hash', 'Client_Settings_JSON', 'Quick_Edit_PIN_Hash'
];
const LEGACY_CLIENT_IDS = ['CL-001', 'CL-002', 'CL-003'];

// getDashboardColumns() returns hand-picked label text/order for legacy clients that
// doesn't line up 1:1 with the add-item `fields` array (e.g. CL-002 folds upc/productDescription
// into SKU/Title, and CL-003 shows no custom columns at all on the dashboard). This maps
// each legacy client's dashboard columns back to the field keys used to look up cell values.
const LEGACY_DASHBOARD_FIELD_KEYS = {
  'CL-002': ['asin', 'quantityOrdered', 'quantityReceived', 'quantityShipped', 'expDate', 'merchant', 'fulfillment', 'transparencyCode', 'bundled', 'bundleQty', 'notes'],
  'CL-003': [],
  'CL-001': []
};

function parseBoolCell(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['true', 'yes', '1'].includes(String(value).trim().toLowerCase());
}

function parseFieldsJson(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    return null;
  }
}

function slugifyFieldKey(label, index) {
  const camelCased = String(label || '').trim().replace(/[^a-zA-Z0-9]+(.)/g, (_, chr) => chr.toUpperCase()).replace(/[^a-zA-Z0-9]/g, '');
  const key = camelCased ? camelCased.charAt(0).toLowerCase() + camelCased.slice(1) : '';
  return key || `field${index}`;
}

function sanitizeFieldDefs(rawFields) {
  if (!Array.isArray(rawFields)) return [];
  const reservedLabels = new Set(['sku', 'title', 'product title', 'qty', 'quantity', 'status', 'notes']);
  const seenKeys = new Set();

  return rawFields
    .map((field, index) => {
      const label = String(field?.label || '').trim();
      if (!label || reservedLabels.has(label.toLowerCase())) return null;
      const type = ['text', 'number', 'textarea', 'select'].includes(field?.type) ? field.type : 'text';
      const options = type === 'select' && Array.isArray(field?.options)
        ? field.options.map((option) => String(option || '').trim())
        : undefined;
      let key = String(field?.key || '').trim() || slugifyFieldKey(label, index);
      while (seenKeys.has(key)) key = `${key}${index}`;
      seenKeys.add(key);
      return {
        key,
        label,
        type,
        ...(options ? { options } : {}),
        visibility: { inventory: field?.showInInventory !== false, order: field?.showInOrder !== false }
      };
    })
    .filter(Boolean);
}

function splitFieldVisibility(sanitizedFields) {
  return {
    fields: sanitizedFields.map(({ visibility, ...field }) => field),
    fieldVisibility: Object.fromEntries(sanitizedFields.map((field) => [field.key, field.visibility]))
  };
}

// Best-effort field detection for a client sheet with no explicit Fields_JSON — reads the
// header row and turns each custom column into a field definition automatically.
async function autoDetectFieldsFromSheet(sheetName) {
  try {
    const sheet = await findSheetByTitle(sheetName);
    if (!sheet) return [];
    await withRetry(() => sheet.loadHeaderRow());
    const headers = (sheet.headerValues || []).filter(Boolean);
    const skip = new Set(['sku', 'product title', 'title', 'qty', 'status', 'notes', 'client_id']);
    return headers
      .filter((header) => !skip.has(String(header).trim().toLowerCase()))
      .map((header, index) => ({
        key: slugifyFieldKey(header, index),
        label: String(header).trim(),
        type: /qty|quantity|number|amount/i.test(header) ? 'number' : (/notes|description|comment/i.test(header) ? 'textarea' : 'text')
      }));
  } catch (error) {
    return [];
  }
}

// Resolves full display/behavior config for a client: dashboard columns, add-item form
// fields, drive folder, feature toggles, etc. CL-001/002/003 keep their existing static
// configuration (unchanged behavior); any other client is driven entirely by the
// User_Credentials sheet row plus (if Fields_JSON is blank) auto-detected sheet columns,
// so new clients "just work" once a row + sheet tab exist — no code changes required.
function getClientProfile(clientId) {
  const safeClientId = normalizeClientId(clientId) || 'CL-001';
  return cachedRead(`profile:${safeClientId}`, PROFILE_CACHE_MS, () => loadClientProfile(safeClientId));
}

async function findCredentialsRow(clientId) {
  const sheet = await findSheetByTitle('User_Credentials');
  if (!sheet) return null;
  const rows = await withRetry(() => sheet.getRows());
  return rows.find((entry) => normalizeClientId(entry.get('Client_ID') || entry.get('clientId')) === clientId) || null;
}

function hasQuickEditPin(row) {
  return Boolean(row) && (looksHashed(row.get('Quick_Edit_PIN_Hash')) || isValidQuickEditPin(String(row.get('Edit_PIN') || '').trim()));
}

function applyClientSettings(profile, row) {
  const settings = mapClientSettings(row ? row.get('Client_Settings_JSON') : null, { fields: profile.fields, clientId: profile.clientId });
  // CL-002 quantities are driven by its shipment columns, which the quick-edit endpoint rejects.
  if (profile.clientId === 'CL-002') settings.quickEditMode = 'disabled';
  Object.assign(profile, settings, {
    quickEditPinSet: hasQuickEditPin(row),
    hideQuickEdit: settings.quickEditMode === 'disabled'
  });
  // The folder on the client's own credentials row wins; there is never a cross-client fallback.
  profile.driveFolderUrl = normalizeDriveFolderUrl(row ? row.get('Drive_Folder_URL') : '') || normalizeDriveFolderUrl(profile.driveFolderUrl);
  profile.hasEmail = Boolean(row && String(row.get('Email') || '').trim());
  profile.driveAccessReady = Boolean(profile.driveFolderUrl && profile.hasEmail);
  return profile;
}

function withEditColumn(columns, profile) {
  const base = columns.filter((label) => label !== 'EDIT');
  return profile.readOnly || profile.hideQuickEdit ? base : [...base, 'EDIT'];
}

async function loadClientProfile(clientId) {
  const safeClientId = normalizeClientId(clientId) || 'CL-001';

  if (LEGACY_CLIENT_IDS.includes(safeClientId) || safeClientId === 'CL-000') {
    const configClientId = safeClientId === 'CL-000' ? 'CL-001' : safeClientId;
    const inventoryConfig = getClientInventoryFields(configClientId);
    const titleConfig = getCreateFormTitleConfig(configClientId);
    let row = null;
    try {
      row = await findCredentialsRow(safeClientId);
    } catch (error) {
      console.warn(`Unable to load settings for ${safeClientId}:`, error.message);
    }
    const profile = applyClientSettings({
      clientId: safeClientId,
      clientName: inventoryConfig.label,
      portalTitle: 'ECL Inventory Portal',
      portalSubtitle: 'Professional Prep & Fulfillment Services',
      accentColor: '#F5C518',
      inventoryMode: inventoryConfig.fields.length ? 'custom' : 'legacy',
      enableAddItem: !inventoryConfig.readOnly,
      allowChat: true,
      allowLogs: true,
      allowUpdate: true,
      readOnly: Boolean(inventoryConfig.readOnly),
      requirePin: Boolean(inventoryConfig.requirePin),
      // CL-002 already expresses quantity via its own Quantity Ordered/Received/Shipped
      // fields, so the generic QTY column would be redundant there.
      hideQtyColumn: configClientId === 'CL-002',
      legacy: true,
      driveFolderUrl: safeClientId === 'CL-000' ? '' : getChatDriveFolderForClient(safeClientId),
      titleField: titleConfig,
      fields: inventoryConfig.fields || [],
      dashboardFieldKeys: LEGACY_DASHBOARD_FIELD_KEYS[configClientId] || []
    }, row);
    profile.dashboardColumns = withEditColumn(getDashboardColumns(configClientId), profile);
    return profile;
  }

  const profile = {
    clientId: safeClientId,
    clientName: safeClientId,
    portalTitle: 'ECL Inventory Portal',
    portalSubtitle: 'Professional Prep & Fulfillment Services',
    accentColor: '#F5C518',
    inventoryMode: 'custom',
    enableAddItem: true,
    allowChat: true,
    allowLogs: true,
    allowUpdate: true,
    readOnly: false,
    requirePin: false,
    hideQtyColumn: false,
    hideQuickEdit: false,
    driveFolderUrl: '',
    titleField: { visible: true, label: 'Product Title', placeholder: 'Enter product name' },
    fields: []
  };

  let credentialsRow = null;
  try {
    const row = await findCredentialsRow(safeClientId);
    credentialsRow = row;

    if (row) {
      profile.clientName = String(row.get('Client_Name') || row.get('clientName') || safeClientId).trim();
      profile.portalTitle = String(row.get('Portal_Title') || '').trim() || profile.portalTitle;
      profile.portalSubtitle = String(row.get('Portal_Subtitle') || '').trim() || profile.portalSubtitle;
      profile.accentColor = String(row.get('Accent_Color') || '').trim() || profile.accentColor;
      profile.inventoryMode = String(row.get('Inventory_Mode') || '').trim() || profile.inventoryMode;
      profile.enableAddItem = parseBoolCell(row.get('Enable_Add_Item'), profile.enableAddItem);
      profile.allowChat = parseBoolCell(row.get('Allow_Chat'), profile.allowChat);
      profile.allowLogs = parseBoolCell(row.get('Allow_Logs'), profile.allowLogs);
      profile.allowUpdate = parseBoolCell(row.get('Allow_Update'), profile.allowUpdate);
      profile.readOnly = parseBoolCell(row.get('Read_Only'), profile.readOnly);
      profile.requirePin = parseBoolCell(row.get('Require_Pin'), profile.requirePin);
      profile.driveFolderUrl = String(row.get('Drive_Folder_URL') || '').trim();

      const titleLabel = String(row.get('Title_Field_Label') || '').trim();
      const titlePlaceholder = String(row.get('Title_Field_Placeholder') || '').trim();
      profile.titleField = {
        visible: true,
        label: titleLabel || 'Product Title',
        placeholder: titlePlaceholder || 'Enter product name'
      };

      profile.fields = parseFieldsJson(row.get('Fields_JSON')) || await autoDetectFieldsFromSheet(safeClientId);
    } else {
      profile.fields = await autoDetectFieldsFromSheet(safeClientId);
    }
  } catch (error) {
    console.warn(`Unable to load client profile for ${safeClientId}:`, error.message);
  }

  applyClientSettings(profile, credentialsRow);
  profile.dashboardColumns = withEditColumn([
    'PRODUCT TITLE',
    ...profile.fields.map((field) => String(field.label || field.key).toUpperCase()),
    ...(profile.hideQtyColumn ? [] : ['QTY']),
    'STATUS'
  ], profile);
  profile.dashboardFieldKeys = profile.fields.map((field) => field.key);
  return profile;
}

function normalizeClientRow(row = {}) {
  const clientId = normalizeClientId(row.get('clientId') || row.get('Client_ID') || row.get('ClientID'));
  const clientName = String(row.get('clientName') || row.get('Client_Name') || row.get('ClientName') || clientId || 'Client').trim();
  const username = String(row.get('username') || row.get('Username') || '').trim();
  const password = String(row.get('password') || row.get('Password') || '').trim();
  const role = String(row.get('role') || row.get('Role') || (clientId === 'CL-000' ? 'admin' : 'client')).trim().toLowerCase();

  return {
    clientId,
    clientName,
    username,
    password,
    role,
    email: String(row.get('email') || row.get('Email') || '').trim()
  };
}

async function getClientRoster() {
  try {
    const sheet = await getSheetByName('User_Credentials');
    const rows = await withRetry(() => sheet.getRows());
    const roster = rows
      .map(normalizeClientRow)
      .filter((entry) => entry.clientId || entry.username);

    if (roster.length) return roster;
    return [{ clientId: 'CL-001', clientName: 'Primary Client', role: 'client' }];
  } catch (error) {
    console.warn('Unable to load client roster from Google Sheets:', error.message);
    return [{ clientId: 'CL-001', clientName: 'Primary Client', role: 'client' }];
  }
}

function listInventoryForClient(targetClientId) {
  const key = `inventory:${normalizeClientId(targetClientId) || 'CL-001'}`;
  return cachedRead(key, INVENTORY_CACHE_MS, () => loadInventoryForClient(targetClientId));
}

async function loadInventoryForClient(targetClientId) {
  const sheetName = getSheetNameForClient(targetClientId);
  try {
    // Once clients are deletable, a stale/typo'd clientId must not silently fall back to
    // some other sheet (e.g. User_Credentials) — just report no inventory instead.
    if (!LEGACY_CLIENT_IDS.includes(sheetName) && !(await findSheetByTitle(sheetName))) {
      return [];
    }

    const rows = await loadSheetRows(sheetName, sheetName === 'CL-001' ? null : 500);
    const result = [];

    const parseGenericSheetRow = (row) => {
      const rowText = String((row || []).slice(0, 8).join(' ')).toLowerCase();
      const skuValue = String(row[0] || row[1] || '').trim();
      const titleValue = String(row[1] || row[0] || '').trim();

      if (!skuValue && !titleValue) return null;
      if (rowText.includes('upc') || rowText.includes('product description') || rowText.includes('quantity ordered') || rowText.includes('product name') || rowText.includes('merchant') || rowText.includes('carrier')) {
        return null;
      }
      if (String(skuValue).length > 80 || String(titleValue).length > 180) return null;

      const qtyCandidates = row.slice(2, Math.min(row.length, 16));
      let qty = 0;
      for (const candidate of qtyCandidates) {
        const candidateText = String(candidate ?? '').trim();
        const cleaned = candidateText.replace(/[^0-9.-]/g, '');
        if (!cleaned) continue;
        const parsed = Number(cleaned);
        if (Number.isFinite(parsed)) {
          qty = parsed;
          break;
        }
      }

      if (!skuValue || !titleValue) return null;
      const item = normalizeInventoryRow([sheetName, skuValue, titleValue, qty, qty <= 0 ? 'Out of Stock' : qty <= 5 ? 'Low Stock' : 'In Stock', ''], sheetName);
      item.clientId = String(targetClientId || sheetName || '').trim();
      item.location = String(sheetName || '').trim();
      return item;
    };

    if (sheetName === 'CL-002') {
      const headerRow = rows[0] || [];
      const normalizedHeaders = headerRow.map((cell) => String(cell || '').trim().toLowerCase());
      const columnIndexes = {
        upc: normalizedHeaders.findIndex((name) => name.includes('upc')),
        description: normalizedHeaders.findIndex((name) => name.includes('product description')),
        quantityOrdered: normalizedHeaders.findIndex((name) => name.includes('quantity ordered')),
        quantityReceived: normalizedHeaders.findIndex((name) => name.includes('quantity received')),
        quantityShipped: normalizedHeaders.findIndex((name) => name.includes('quantity shipped')),
        expDate: normalizedHeaders.findIndex((name) => name.includes('exp date')),
        merchant: normalizedHeaders.findIndex((name) => name.includes('merchant')),
        asin: normalizedHeaders.findIndex((name) => name.includes('asin')),
        fulfillment: normalizedHeaders.findIndex((name) => name.includes('fbm') || name.includes('fba')),
        transparencyCode: normalizedHeaders.findIndex((name) => name.includes('transparency')),
        bundled: normalizedHeaders.findIndex((name) => name.includes('bundled')),
        bundleQty: normalizedHeaders.findIndex((name) => name.includes('bundle quantity')),
        notes: normalizedHeaders.findIndex((name) => name.includes('notes'))
      };

      for (let index = 1; index < rows.length; index += 1) {
        const row = rows[index];
        const description = String(row[columnIndexes.description >= 0 ? columnIndexes.description : 1] || '').trim();
        if (!description || description.toLowerCase() === 'product description') continue;

        const orderedValue = row[columnIndexes.quantityOrdered >= 0 ? columnIndexes.quantityOrdered : 2] || '';
        const qtyValue = Number(String(orderedValue).replace(/[^0-9.-]/g, '')) || 0;
        const asinValue = String(row[columnIndexes.asin >= 0 ? columnIndexes.asin : 7] || '').trim();

        const item = {
          id: `CL-002-${index}`,
          clientId: 'CL-002',
          sku: String(row[columnIndexes.upc >= 0 ? columnIndexes.upc : 0] || '').trim() || description,
          title: description,
          itemName: description,
          qty: qtyValue,
          quantity: qtyValue,
          reorderLevel: 0,
          status: String(row[columnIndexes.notes >= 0 ? columnIndexes.notes : 12] || '').trim() || 'In Stock',
          upc: String(row[columnIndexes.upc >= 0 ? columnIndexes.upc : 0] || '').trim(),
          description,
          productDescription: description,
          quantityOrdered: String(orderedValue).trim(),
          quantityReceived: String(row[columnIndexes.quantityReceived >= 0 ? columnIndexes.quantityReceived : 3] || '').trim(),
          quantityShipped: String(row[columnIndexes.quantityShipped >= 0 ? columnIndexes.quantityShipped : 4] || '').trim(),
          expDate: String(row[columnIndexes.expDate >= 0 ? columnIndexes.expDate : 5] || '').trim(),
          merchant: String(row[columnIndexes.merchant >= 0 ? columnIndexes.merchant : 6] || '').trim(),
          asin: asinValue,
          fulfillment: String(row[columnIndexes.fulfillment >= 0 ? columnIndexes.fulfillment : 8] || '').trim(),
          transparencyCode: String(row[columnIndexes.transparencyCode >= 0 ? columnIndexes.transparencyCode : 9] || '').trim(),
          bundled: String(row[columnIndexes.bundled >= 0 ? columnIndexes.bundled : 10] || '').trim(),
          bundleQty: String(row[columnIndexes.bundleQty >= 0 ? columnIndexes.bundleQty : 11] || '').trim(),
          notes: String(row[columnIndexes.notes >= 0 ? columnIndexes.notes : 12] || '').trim(),
          asinDisplay: asinValue
        };

        result.push(item);
      }
      return result;
    }

    if (sheetName === 'CL-003') {
      const headerRow = rows[0] || [];
      const headerText = headerRow.map((cell) => String(cell || '').trim().toLowerCase());
      const map = {
        productName: headerText.indexOf('product description/name') >= 0 ? headerText.indexOf('product description/name') : 0,
        quantityOrdered: headerText.indexOf('quantity ordered') >= 0 ? headerText.indexOf('quantity ordered') : 1,
        quantityReceived: headerText.indexOf('quantity received') >= 0 ? headerText.indexOf('quantity received') : 2,
        quantityShipped: headerText.indexOf('quantity shipped') >= 0 ? headerText.indexOf('quantity shipped') : 3,
        merchant: headerText.indexOf('merchant') >= 0 ? headerText.indexOf('merchant') : 4,
        carrier: headerText.indexOf('carrier') >= 0 ? headerText.indexOf('carrier') : 5,
        trackingNumber: headerText.indexOf('tracking #') >= 0 || headerText.indexOf('tracking number') >= 0 ? Math.max(headerText.indexOf('tracking #'), headerText.indexOf('tracking number')) : 6,
        notes: headerText.indexOf('notes') >= 0 ? headerText.indexOf('notes') : 7
      };

      for (let index = 1; index < rows.length; index += 1) {
        const row = rows[index];
        const productName = String(row[map.productName] || '').trim();
        if (!productName) continue;

        result.push({
          id: `CL-003-${index}`,
          clientId: 'CL-003',
          sku: String(row[map.productName] || '').trim(),
          title: productName,
          itemName: productName,
          qty: Number(String(row[map.quantityReceived] || '').replace(/[^0-9.-]/g, '')) || 0,
          quantity: Number(String(row[map.quantityReceived] || '').replace(/[^0-9.-]/g, '')) || 0,
          reorderLevel: 0,
          status: 'In Stock',
          productName,
          quantityOrdered: String(row[map.quantityOrdered] || '').trim(),
          quantityReceived: String(row[map.quantityReceived] || '').trim(),
          quantityShipped: String(row[map.quantityShipped] || '').trim(),
          merchant: String(row[map.merchant] || '').trim(),
          carrier: String(row[map.carrier] || '').trim(),
          trackingNumber: String(row[map.trackingNumber] || '').trim(),
          notes: String(row[map.notes] || '').trim()
        });
      }
      return result;
    }

    if (sheetName === 'CL-001') {
      const headerRowIndex = rows.findIndex((row) => String(row.join(' ')).toLowerCase().includes('sku code'));
      const startIndex = headerRowIndex >= 0 ? headerRowIndex + 1 : 0;

      for (let index = startIndex; index < rows.length; index += 1) {
        const row = rows[index];
        const clientIdValue = String(row[0] || '').trim();
        const skuValue = String(row[1] || '').trim();
        const titleValue = String(row[2] || '').trim();
        const statusValue = String(row[4] || '').trim();
        const rowText = String(row.join(' ')).toLowerCase();

        if (!skuValue && !titleValue && !statusValue) continue;
        if (!skuValue && !titleValue) continue;
        if (!skuValue || /^\d+$/.test(skuValue)) {
          const titleLower = titleValue.toLowerCase();
          if (!titleValue || (!titleLower.includes('inventory') && !titleLower.includes('client'))) {
            continue;
          }
        }
        if (rowText.includes('last inventory date') || rowText.includes('inventory summary') || rowText.includes('total skus tracked') || rowText.includes('client:') || rowText.includes('fulfilled by:') || rowText.includes('electric city logistics')) {
          continue;
        }
        if (skuValue.toLowerCase().includes('sku code') || titleValue.toLowerCase().includes('product title')) continue;
        if (clientIdValue && !['CL-000', 'CL-001', 'CL-002', 'CL-003'].includes(clientIdValue) && !clientIdValue.toUpperCase().startsWith('CL-')) {
          continue;
        }

        const normalized = normalizeInventoryRow(row, sheetName);
        if (normalized && normalized.sku && normalized.sku !== 'N/A' && normalized.title && normalized.title !== 'Untitled') {
          result.push(normalized);
        }
      }
      return result;
    }

    // Any client provisioned through the "Add Client" admin flow gets a sheet laid out as
    // SKU | Product Title | ...custom fields (in the order configured)... | Qty | Status | Notes.
    // Reading it generically here means new clients need zero code changes to appear correctly.
    if (!LEGACY_CLIENT_IDS.includes(sheetName)) {
      const profile = await getClientProfile(targetClientId);
      if (profile.fields.length || profile.inventoryMode === 'custom') {
        const customFieldCount = profile.fields.length;
        const qtyCol = 2 + customFieldCount;
        const statusCol = qtyCol + 1;
        const notesCol = statusCol + 1;

        for (let index = 1; index < rows.length; index += 1) {
          const row = rows[index];
          const titleValue = String(row[1] || '').trim();
          if (!titleValue) continue;

          const qtyValue = Number(String(row[qtyCol] || '').replace(/[^0-9.-]/g, '')) || 0;
          const item = {
            id: `${sheetName}-${index}`,
            clientId: String(targetClientId || sheetName || '').trim(),
            sku: String(row[0] || '').trim() || titleValue,
            title: titleValue,
            itemName: titleValue,
            qty: qtyValue,
            quantity: qtyValue,
            reorderLevel: 5,
            status: String(row[statusCol] || '').trim() || (qtyValue <= 0 ? 'Out of Stock' : qtyValue <= 5 ? 'Low Stock' : 'In Stock'),
            notes: String(row[notesCol] || '').trim()
          };

          profile.fields.forEach((field, fieldIndex) => {
            item[field.key] = String(row[2 + fieldIndex] || '').trim();
          });

          result.push(item);
        }
        return result;
      }
    }

    for (const row of rows) {
      const parsed = parseGenericSheetRow(row);
      if (parsed && parsed.sku && parsed.title && parsed.sku !== 'N/A' && parsed.title !== 'Untitled') {
        result.push(parsed);
      }
    }

    return result;
  } catch (error) {
    if (error?.response?.status === 429) throw error;
    console.warn(`Inventory sheet ${sheetName} did not load:`, error.message);
    return [];
  }
}

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Quick-Edit-Token');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.get('/api/clients', async (req, res) => {
  const session = readNotificationSession(req);
  if (!session) return res.status(401).json({ message: 'Sign-in required.' });
  try {
    const isAdmin = session.role === 'admin' || session.clientId === 'CL-000';
    const roster = (await getClientRoster())
      .filter((entry) => isAdmin || normalizeClientId(entry.clientId) === normalizeClientId(session.clientId));
    // Never leak password hashes (or legacy plain-text passwords) to the client.
    const publicRoster = roster.map(({ password, ...rest }) => rest);
    return res.json(publicRoster);
  } catch (error) {
    console.error('Client roster error:', error);
    return res.status(500).json({ message: 'Unable to fetch client roster.' });
  }
});

app.get('/api/client-profile', async (req, res) => {
  const session = readNotificationSession(req);
  if (!session) return res.status(401).json({ message: 'Sign-in required.' });
  try {
    const requested = normalizeClientId(req.query.clientId || session.clientId);
    if (!isStaffSession(session) && requested !== normalizeClientId(session.clientId)) {
      return res.status(403).json({ message: 'You can only view your own account.' });
    }
    const profile = await getClientProfile(requested);
    return res.json(profile);
  } catch (error) {
    console.error('Client profile error:', error);
    return res.status(500).json({ message: 'Unable to fetch client profile.' });
  }
});

app.use('/api/admin', (req, res, next) => {
  const session = readNotificationSession(req);
  if (!session || (session.role !== 'admin' && session.clientId !== 'CL-000')) {
    return res.status(401).json({ success: false, error: 'Admin sign-in required.' });
  }
  req.adminSession = session;
  next();
});

app.post('/api/admin/clients/:clientId/reset-password', async (req, res) => {
  try {
    const clientId = normalizeClientId(req.params.clientId);
    const credentialsSheet = await getOrCreateSheet('User_Credentials', USER_CREDENTIALS_HEADERS);
    const rows = await withRetry(() => credentialsSheet.getRows());
    const row = rows.find((entry) => normalizeClientId(entry.get('Client_ID')) === clientId);
    if (!row) return res.status(404).json({ success: false, error: `${clientId} was not found.` });

    const username = String(row.get('Username') || '').trim();
    if (username === req.adminSession.username) {
      return res.status(400).json({ success: false, error: 'You cannot reset the account you are signed in with.' });
    }

    const activationCode = `${generateCode(4)}-${generateCode(4)}`;
    row.set('Password', '');
    row.set('Recovery_Code_Hash', '');
    row.set('Activation_Code', activationCode);
    await withRetry(() => row.save());
    return res.json({ success: true, clientId, username, activationCode });
  } catch (error) {
    console.error('Password reset error:', error.message);
    return res.status(error?.response?.status === 429 ? 429 : 500).json({ success: false, error: 'Unable to reset password.' });
  }
});

app.post('/api/admin/clients', async (req, res) => {
  try {
    const body = req.body || {};
    const clientId = normalizeClientId(body.clientId);
    const clientName = String(body.clientName || '').trim();
    const username = String(body.username || '').trim();

    if (!clientId || !clientName || !username) {
      return res.status(400).json({ success: false, error: 'Client ID, client name, and username are required.' });
    }
    if (!/^CL-\d{3,}$/.test(clientId)) {
      return res.status(400).json({ success: false, error: 'Client ID must look like CL-004.' });
    }
    if (String(body.driveFolderUrl || '').trim() && !normalizeDriveFolderUrl(body.driveFolderUrl)) {
      return res.status(400).json({ success: false, error: 'Drive folder must be a Google Drive folder link or folder ID.' });
    }

    const roster = await getClientRoster();
    if (roster.some((entry) => entry.clientId === clientId)) {
      return res.status(409).json({ success: false, error: `${clientId} already exists.` });
    }
    if (roster.some((entry) => entry.username.toLowerCase() === username.toLowerCase())) {
      return res.status(409).json({ success: false, error: `Username "${username}" is already taken.` });
    }

    const { fields, fieldVisibility } = splitFieldVisibility(sanitizeFieldDefs(body.fields));
    const settings = settingsFromInput({ ...body, fields: [], fieldVisibility }, fields, clientId);
    const quickEditPin = String(body.quickEditPin || '').trim();
    if (quickEditPin && !isValidQuickEditPin(quickEditPin)) {
      return res.status(400).json({ success: false, error: 'Quick Edit PIN must be 4-32 characters with no spaces.' });
    }
    if (settings.quickEditMode === 'password' && !quickEditPin) {
      return res.status(400).json({ success: false, error: 'Set a Quick Edit PIN to use Password Protected mode.' });
    }

    // The client sets their own password later via "Create Account", proven by this
    // one-time code instead of the admin having to hand out (and know) a real password.
    const activationCode = `${generateCode(4)}-${generateCode(4)}`;

    // Create the inventory sheet tab first so a failure here (e.g. a bad header)
    // never leaves an orphaned credentials row behind.
    const doc = await getDoc();
    if (!doc.sheetsByTitle[clientId]) {
      const headerValues = ['SKU', String(body.titleFieldLabel || '').trim() || 'Product Title', ...fields.map((field) => field.label), 'Qty', 'Status', 'Notes'];
      await withRetry(() => doc.addSheet({ title: clientId, headerValues }));
    }

    const credentialsSheet = await getOrCreateSheet('User_Credentials', USER_CREDENTIALS_HEADERS);
    const quickEditPinHash = quickEditPin ? await hashSecret(quickEditPin) : '';
    await withRetry(() => credentialsSheet.addRow({
      Client_ID: clientId,
      Username: username,
      Password: '',
      Client_Name: clientName,
      Email: String(body.email || '').trim(),
      Edit_PIN: String(body.editPin || '').trim(),
      Role: 'client',
      Portal_Title: String(body.portalTitle || '').trim(),
      Portal_Subtitle: String(body.portalSubtitle || '').trim(),
      Inventory_Mode: 'custom',
      Enable_Add_Item: body.enableAddItem === false ? 'false' : 'true',
      Accent_Color: String(body.accentColor || '').trim(),
      Allow_Chat: body.allowChat === false ? 'false' : 'true',
      Allow_Logs: body.allowLogs === false ? 'false' : 'true',
      Allow_Update: body.allowUpdate === false ? 'false' : 'true',
      Drive_Folder_URL: normalizeDriveFolderUrl(body.driveFolderUrl),
      Read_Only: body.readOnly === true ? 'true' : 'false',
      Require_Pin: body.requirePin === true ? 'true' : 'false',
      Title_Field_Label: String(body.titleFieldLabel || '').trim(),
      Title_Field_Placeholder: String(body.titleFieldPlaceholder || '').trim(),
      Fields_JSON: JSON.stringify(fields),
      Activation_Code: activationCode,
      Recovery_Code_Hash: '',
      Client_Settings_JSON: JSON.stringify(settings),
      Quick_Edit_PIN_Hash: quickEditPinHash
    }));

    invalidateReadCache('profile:', 'inventory:');
    const profile = await getClientProfile(clientId);
    return res.json({ success: true, profile, username, activationCode });
  } catch (error) {
    console.error('Add client error:', error);
    return res.status(500).json({ success: false, error: 'Unable to add client.' });
  }
});

// Adds/removes/renames the actual sheet columns so a client's field layout can be
// changed after the fact instead of being locked in permanently at creation time.
async function syncClientFieldColumns(sheet, oldFields, orderedFields, titleLabel) {
  const newKeys = orderedFields.map((field) => field.key);

  const removedIndexes = oldFields
    .map((field, idx) => ({ field, idx }))
    .filter(({ field }) => !newKeys.includes(field.key))
    .map(({ idx }) => idx)
    .sort((a, b) => b - a);

  for (const idx of removedIndexes) {
    const columnIndex = 2 + idx;
    await withRetry(() => sheet._makeSingleUpdateRequest('deleteDimension', {
      range: { sheetId: sheet.sheetId, dimension: 'COLUMNS', startIndex: columnIndex, endIndex: columnIndex + 1 }
    }));
  }

  const oldKeys = oldFields.map((field) => field.key);
  const addedCount = orderedFields.filter((field) => !oldKeys.includes(field.key)).length;
  const keptCount = oldFields.filter((field) => newKeys.includes(field.key)).length;

  for (let i = 0; i < addedCount; i += 1) {
    const insertAt = 2 + keptCount + i;
    await withRetry(() => sheet.insertDimension('COLUMNS', { startIndex: insertAt, endIndex: insertAt + 1 }));
  }

  const headerValues = ['SKU', titleLabel || 'Product Title', ...orderedFields.map((field) => field.label), 'Qty', 'Status', 'Notes'];
  await withRetry(() => sheet.setHeaderRow(headerValues));
}

app.put('/api/admin/clients/:clientId', async (req, res) => {
  try {
    const clientId = normalizeClientId(req.params.clientId);
    if (clientId === 'CL-000') {
      return res.status(400).json({ success: false, error: 'The admin account has no client settings.' });
    }
    const isLegacy = LEGACY_CLIENT_IDS.includes(clientId);

    const credentialsSheet = await getOrCreateSheet('User_Credentials', USER_CREDENTIALS_HEADERS);
    const rows = await withRetry(() => credentialsSheet.getRows());
    const row = rows.find((entry) => normalizeClientId(entry.get('Client_ID')) === clientId);
    if (!row) {
      return res.status(404).json({ success: false, error: `${clientId} was not found.` });
    }

    const body = req.body || {};
    const quickEditPin = String(body.quickEditPin || '').trim();
    if (quickEditPin && !isValidQuickEditPin(quickEditPin)) {
      return res.status(400).json({ success: false, error: 'Quick Edit PIN must be 4-32 characters with no spaces.' });
    }
    if (!isLegacy && String(body.driveFolderUrl || '').trim() && !normalizeDriveFolderUrl(body.driveFolderUrl)) {
      return res.status(400).json({ success: false, error: 'Drive folder must be a Google Drive folder link or folder ID.' });
    }

    let settings;
    let orderedFields = null;
    if (isLegacy) {
      // Built-in layouts keep their sheet columns; only the per-client settings are stored.
      settings = settingsFromInput(body, getClientInventoryFields(clientId).fields || [], clientId);
    } else {
      const oldFields = parseFieldsJson(row.get('Fields_JSON')) || [];
      const { fields: submittedFields, fieldVisibility } = splitFieldVisibility(sanitizeFieldDefs(body.fields));
      const submittedKeys = submittedFields.map((field) => field.key);

      // Keep existing fields in their original column order (renames only change the label);
      // anything brand new is appended at the end. This guarantees the header row we write
      // always lines up with the sheet's actual column order, regardless of what order the
      // fields arrived in from the client.
      orderedFields = oldFields
        .filter((field) => submittedKeys.includes(field.key))
        .map((field) => submittedFields.find((updated) => updated.key === field.key) || field)
        .concat(submittedFields.filter((field) => !oldFields.some((old) => old.key === field.key)));
      settings = settingsFromInput({ ...body, fields: [], fieldVisibility }, orderedFields, clientId);
    }

    if (settings.quickEditMode === 'password' && !quickEditPin && !hasQuickEditPin(row)) {
      return res.status(400).json({ success: false, error: 'Set a Quick Edit PIN to use Password Protected mode.' });
    }

    if (!isLegacy) {
      const oldFields = parseFieldsJson(row.get('Fields_JSON')) || [];
      const titleLabel = String(body.titleFieldLabel || row.get('Title_Field_Label') || '').trim() || 'Product Title';
      const inventorySheet = await getSheetByName(clientId);
      await withRetry(() => inventorySheet.loadHeaderRow());
      await syncClientFieldColumns(inventorySheet, oldFields, orderedFields, titleLabel);

      row.set('Client_Name', String(body.clientName || row.get('Client_Name') || clientId).trim());
      row.set('Portal_Title', String(body.portalTitle ?? row.get('Portal_Title') ?? '').trim());
      row.set('Portal_Subtitle', String(body.portalSubtitle ?? row.get('Portal_Subtitle') ?? '').trim());
      row.set('Accent_Color', String(body.accentColor ?? row.get('Accent_Color') ?? '').trim());
      row.set('Drive_Folder_URL', normalizeDriveFolderUrl(body.driveFolderUrl ?? row.get('Drive_Folder_URL')));
      row.set('Enable_Add_Item', body.enableAddItem === false ? 'false' : 'true');
      row.set('Allow_Chat', body.allowChat === false ? 'false' : 'true');
      row.set('Allow_Logs', body.allowLogs === false ? 'false' : 'true');
      row.set('Allow_Update', body.allowUpdate === false ? 'false' : 'true');
      row.set('Read_Only', body.readOnly === true ? 'true' : 'false');
      row.set('Require_Pin', body.requirePin === true ? 'true' : 'false');
      row.set('Title_Field_Label', titleLabel);
      row.set('Title_Field_Placeholder', String(body.titleFieldPlaceholder ?? row.get('Title_Field_Placeholder') ?? '').trim());
      row.set('Fields_JSON', JSON.stringify(orderedFields));
    }

    row.set('Client_Settings_JSON', JSON.stringify(settings));
    if (quickEditPin) row.set('Quick_Edit_PIN_Hash', await hashSecret(quickEditPin));

    await withRetry(() => row.save());

    invalidateReadCache('profile:', 'inventory:');
    const profile = await getClientProfile(clientId);
    return res.json({ success: true, profile });
  } catch (error) {
    console.error('Update client error:', error);
    return res.status(500).json({ success: false, error: 'Unable to update client.' });
  }
});

app.delete('/api/admin/clients/:clientId', async (req, res) => {
  try {
    const clientId = normalizeClientId(req.params.clientId);
    if (LEGACY_CLIENT_IDS.includes(clientId) || clientId === 'CL-000') {
      return res.status(400).json({ success: false, error: 'This client cannot be deleted here.' });
    }

    const credentialsSheet = await getOrCreateSheet('User_Credentials', USER_CREDENTIALS_HEADERS);
    const rows = await withRetry(() => credentialsSheet.getRows());
    const row = rows.find((entry) => normalizeClientId(entry.get('Client_ID')) === clientId);
    if (row) await withRetry(() => row.delete());

    const doc = await getDoc();
    if (doc.sheetsByTitle[clientId]) await withRetry(() => doc.sheetsByTitle[clientId].delete());
    invalidateReadCache('profile:', 'inventory:');

    return res.json({ success: true });
  } catch (error) {
    console.error('Delete client error:', error);
    return res.status(500).json({ success: false, error: 'Unable to delete client.' });
  }
});

app.get('/api/chat', async (req, res) => {
  const session = readNotificationSession(req);
  if (!session) return res.status(401).json({ message: 'Sign in again to view chat.' });
  try {
    const clientId = isStaffSession(session) ? normalizeClientId(req.query.clientId || session.clientId) : normalizeClientId(session.clientId);
    const allMessages = await cachedRead('rows:Chat_log:history', ROWS_CACHE_MS, async () => {
      const sheet = await getOrCreateSheet('Chat_log', ['Timestamp', 'Sender', 'Message', 'ClientID', 'IsStaff', 'FileUrl', 'FileName']);
      const rows = await withRetry(() => sheet.getRows());
      return rows.map((row) => ({
        timestamp: row.get('Timestamp') || row.get('timestamp') || '',
        sender: row.get('Sender') || row.get('sender') || 'Unknown',
        message: row.get('Message') || row.get('message') || '',
        clientId: normalizeClientId(row.get('ClientID') || row.get('clientId') || row.get('Client_ID') || ''),
        isStaff: String(row.get('IsStaff') || row.get('isStaff') || '0').trim() === '1',
        fileUrl: isGoogleDriveUrl(row.get('FileUrl') || row.get('fileUrl')) ? String(row.get('FileUrl') || row.get('fileUrl')).trim() : '',
        fileName: row.get('FileName') || row.get('fileName') || ''
      }));
    });
    const history = allMessages
      .filter((message) => message.clientId === clientId || (clientId === 'CL-000' && message.clientId))
      .map((message) => ({ ...message, clientId: message.clientId || clientId }));

    return res.json(history);
  } catch (error) {
    console.error('Chat fetch error:', error);
    return res.status(error?.response?.status === 429 ? 429 : 500).json({ message: 'Unable to fetch chat history.' });
  }
});

const NOTIFICATION_STATE_HEADERS = ['Username', 'ClientID', 'ChatSeenAt', 'InventorySeenAt'];
const INVENTORY_EVENT_HEADERS = ['Timestamp', 'ClientID', 'Description', 'ActorUsername'];

async function recordInventoryEvent(clientId, description, username) {
  try {
    const sheet = await getOrCreateSheet('Inventory_Events', INVENTORY_EVENT_HEADERS);
    await withRetry(() => sheet.addRow({
      Timestamp: new Date().toISOString(), ClientID: clientId, Description: description, ActorUsername: username || ''
    }));
    invalidateReadCache('rows:Inventory_Events');
  } catch (error) {
    console.warn('Inventory notification was not recorded:', error.message);
  }
}

function summarizeUnreadNotifications(chatMessages, inventoryEvents, seenAt, username, isStaff) {
  const chatSeen = Date.parse(seenAt.chat || '') || 0;
  const inventorySeen = Date.parse(seenAt.inventory || '') || 0;
  const chat = chatMessages.filter((message) =>
    Date.parse(message.timestamp) > chatSeen && Boolean(message.isStaff) !== isStaff);
  const inventory = inventoryEvents.filter((event) =>
    Date.parse(event.timestamp) > inventorySeen && event.actorUsername !== username);
  return {
    chat: chat.length,
    inventory: inventory.length,
    total: chat.length + inventory.length,
    items: [...chat.map((entry) => ({ ...entry, kind: 'chat' })), ...inventory.map((entry) => ({ ...entry, kind: 'inventory' }))]
  };
}

function loadNotificationRows(sheetName) {
  return cachedRead(`rows:${sheetName}`, ROWS_CACHE_MS, async () => {
    const sheet = await findSheetByTitle(sheetName);
    return sheet ? withRetry(() => sheet.getRows()) : [];
  });
}

app.get('/api/notifications', async (req, res) => {
  try {
    const session = readNotificationSession(req);
    if (!session) return res.status(401).json({ message: 'Sign in again to view notifications.' });
    const isStaff = session.role === 'admin' || session.clientId === 'CL-000';
    const requestedClientId = normalizeClientId(req.query.clientId || session.clientId);
    const clientId = isStaff ? requestedClientId : session.clientId;
    const [chatRows, eventRows, seenRows] = await Promise.all([
      loadNotificationRows('Chat_log'),
      loadNotificationRows('Inventory_Events'),
      loadNotificationRows('Notification_State')
    ]);
    const seenByClient = {};
    for (const row of seenRows) {
      if (row.get('Username') !== session.username) continue;
      seenByClient[normalizeClientId(row.get('ClientID'))] = {
        chat: row.get('ChatSeenAt'), inventory: row.get('InventorySeenAt')
      };
    }
    const globalSeen = isStaff ? seenByClient['CL-000'] || {} : {};
    const chats = chatRows.map((row) => ({
      timestamp: row.get('Timestamp') || '',
      clientId: normalizeClientId(row.get('ClientID')),
      isStaff: String(row.get('IsStaff') || '').trim() === '1',
      description: String(row.get('Sender') || 'Someone') + ': ' + String(row.get('Message') || 'New message')
    }));
    const events = eventRows.map((row) => ({
      timestamp: row.get('Timestamp') || '',
      clientId: normalizeClientId(row.get('ClientID')),
      actorUsername: String(row.get('ActorUsername') || ''),
      description: String(row.get('Description') || 'Inventory updated')
    }));
    const scopedClients = new Set([...chats, ...events].map((entry) => entry.clientId).filter((id) =>
      id && id !== 'CL-000' && (clientId === 'CL-000' || id === clientId)));
    let chat = 0;
    let inventory = 0;
    const items = [];
    for (const scopedId of scopedClients) {
      const localSeen = seenByClient[scopedId] || {};
      const seenAt = {
        chat: Date.parse(localSeen.chat || '') > Date.parse(globalSeen.chat || '') ? localSeen.chat : globalSeen.chat || localSeen.chat,
        inventory: Date.parse(localSeen.inventory || '') > Date.parse(globalSeen.inventory || '') ? localSeen.inventory : globalSeen.inventory || localSeen.inventory
      };
      const summary = summarizeUnreadNotifications(
        chats.filter((entry) => entry.clientId === scopedId),
        events.filter((entry) => entry.clientId === scopedId),
        seenAt, session.username, isStaff
      );
      chat += summary.chat;
      inventory += summary.inventory;
      items.push(...summary.items);
    }
    items.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    return res.json({ chat, inventory, total: chat + inventory, items: items.slice(0, 10) });
  } catch (error) {
    console.error('Notification fetch error:', error.message);
    return res.status(error?.response?.status === 429 ? 429 : 500).json({ message: 'Unable to load notifications.' });
  }
});

app.post('/api/notifications/read', async (req, res) => {
  try {
    const session = readNotificationSession(req);
    if (!session) return res.status(401).json({ message: 'Sign in again to clear notifications.' });
    const isStaff = session.role === 'admin' || session.clientId === 'CL-000';
    const clientId = isStaff ? normalizeClientId(req.body?.clientId || session.clientId) : session.clientId;
    const kind = req.body?.kind;
    if (!clientId || !['chat', 'inventory', 'all'].includes(kind)) {
      return res.status(400).json({ message: 'Client and notification type are required.' });
    }
    const sheet = await getOrCreateSheet('Notification_State', NOTIFICATION_STATE_HEADERS);
    const rows = await withRetry(() => sheet.getRows());
    const row = rows.find((entry) => entry.get('Username') === session.username && normalizeClientId(entry.get('ClientID')) === clientId);
    const now = new Date().toISOString();
    const changes = {};
    if (kind === 'chat' || kind === 'all') changes.ChatSeenAt = now;
    if (kind === 'inventory' || kind === 'all') changes.InventorySeenAt = now;
    if (row) {
      for (const [header, value] of Object.entries(changes)) row.set(header, value);
      await withRetry(() => row.save());
    } else {
      await withRetry(() => sheet.addRow({ Username: session.username, ClientID: clientId, ...changes }));
    }
    invalidateReadCache('rows:Notification_State');
    return res.json({ success: true });
  } catch (error) {
    console.error('Notification read error:', error.message);
    return res.status(error?.response?.status === 429 ? 429 : 500).json({ message: 'Unable to mark notifications read.' });
  }
});

app.post('/api/chat', async (req, res) => {
  const session = readNotificationSession(req);
  if (!session) return res.status(401).json({ success: false, error: 'Sign in again to send messages.' });
  try {
    const { clientId, sender, message, fileUrl, fileName } = req.body || {};
    const isStaff = isStaffSession(session);
    const normalizedClientId = isStaff ? normalizeClientId(clientId) : normalizeClientId(session.clientId);
    if (!normalizedClientId || normalizedClientId === 'CL-000' || !sender || !message) {
      return res.status(400).json({ success: false, error: 'Client, sender, and message are required.' });
    }
    const safeFileUrl = String(fileUrl || '').trim();
    if (safeFileUrl && !isGoogleDriveUrl(safeFileUrl)) {
      return res.status(400).json({ success: false, error: 'Shared files must be Google Drive links.' });
    }

    const sheet = await getOrCreateSheet('Chat_log', ['Timestamp', 'Sender', 'Message', 'ClientID', 'IsStaff', 'FileUrl', 'FileName']);
    const safeFileName = String(fileName || '').trim() || (safeFileUrl ? 'Shared file' : '');
    await withRetry(() => sheet.addRow([new Date().toISOString(), sender, message, normalizedClientId, isStaff ? '1' : '0', safeFileUrl, safeFileName]));
    invalidateReadCache('rows:Chat_log');

    return res.json({
      success: true,
      role: getChatSenderRole(isStaff),
      message: {
        sender,
        clientId: normalizedClientId,
        message,
        isStaff,
        fileUrl: safeFileUrl,
        fileName: safeFileName
      }
    });
  } catch (error) {
    console.error('Chat send error:', error);
    const rateLimited = (error?.response?.status || error?.code) === 429;
    const message = rateLimited
      ? 'Google Sheets is rate-limiting requests. Please wait a few seconds and try again.'
      : 'Unable to send message.';
    return res.status(rateLimited ? 429 : 500).json({ success: false, error: message });
  }
});

app.post('/api/inventory/create', async (req, res) => {
  try {
    const { clientId, sku, title, qty, notes, extraFields = {}, isAdmin } = req.body || {};
    const kind = req.body?.kind === 'order' ? 'order' : 'inventory';
    const status = kind === 'order' ? 'Not Shipped' : req.body?.status;
    const targetClientId = String(clientId || 'CL-001').trim() || 'CL-001';
    const itemSku = String(sku || '').trim();
    const itemTitle = String(title || '').trim();
    const values = extraFields && typeof extraFields === 'object' ? { ...extraFields } : {};
    const adminAccess = Boolean(isAdmin) || String(req.body?.role || '').toLowerCase() === 'admin';

    // Fields the admin switched off for this form are dropped server-side too, not just hidden.
    if (!isStaffSession(readNotificationSession(req))) {
      const { fieldVisibility = {} } = await getClientProfile(targetClientId);
      Object.keys(values).forEach((key) => {
        if (fieldVisibility[key] && fieldVisibility[key][kind] === false) delete values[key];
      });
    }

    const sheetName = getSheetNameForClient(targetClientId);
    const sheet = await getSheetByName(sheetName);

    let row = [];
    if (targetClientId === 'CL-002') {
      row = [
        String(values.upc || itemSku || ''),
        String(values.productDescription || itemTitle || ''),
        String(values.quantityOrdered ?? qty ?? ''),
        ...(adminAccess ? [String(values.quantityReceived ?? ''), String(values.quantityShipped ?? '')] : []),
        String(values.expDate || ''),
        String(values.merchant || ''),
        String(values.asin || ''),
        String(values.fulfillment || ''),
        String(values.transparencyCode || ''),
        String(values.bundled || ''),
        String(values.bundleQty || ''),
        String(values.notes || notes || '')
      ];
    } else if (targetClientId === 'CL-003') {
      row = [
        String(values.productName || itemTitle || ''),
        String(values.quantityOrdered ?? qty ?? ''),
        String(values.merchant || ''),
        String(values.carrier || ''),
        String(values.trackingNumber || ''),
        ...(adminAccess ? [String(values.quantityReceived ?? ''), String(values.quantityShipped ?? '')] : []),
        String(values.notes || notes || '')
      ];
    } else if (!LEGACY_CLIENT_IDS.includes(targetClientId)) {
      // Generic clients (created through the admin "Add Client" flow) always use the
      // SKU | Title | ...custom fields... | Qty | Status | Notes column layout.
      const profile = await getClientProfile(targetClientId);
      const shipmentKeys = findShipmentFieldKeys(profile.fields);
      row = [
        itemSku || itemTitle || 'N/A',
        itemTitle || itemSku || 'Untitled',
        ...profile.fields.map((field) => String(values[field.key] ?? '')),
        Number(qty) || 0,
        shipmentKeys
          ? SHIPMENT_STATUS_TEXT[getShipmentStage(values[shipmentKeys.received], values[shipmentKeys.shipped])]
          : String(status || (Number(qty) <= 5 ? 'Low Stock' : 'In Stock')),
        String(notes || '')
      ];
    } else {
      row = [
        targetClientId,
        itemSku || title || 'N/A',
        itemTitle || title || 'Untitled',
        Number(qty) || 0,
        String(status || (Number(qty) <= 5 ? 'Low Stock' : 'In Stock')),
        String(notes || '')
      ];
    }

    if ((!itemSku && !itemTitle) && row.every((cell) => !String(cell || '').trim())) {
      return res.status(400).json({ success: false, error: 'SKU and product title are required.' });
    }

    await withRetry(() => sheet.addRow(row));
    invalidateReadCache('inventory:');
    await recordInventoryEvent(targetClientId, `Added ${kind === 'order' ? 'order ' : ''}${itemTitle || itemSku}`, readNotificationSession(req)?.username);
    return res.json({ success: true, sheet: sheetName, item: row });
  } catch (error) {
    console.error('Inventory create error:', error);
    return res.status(500).json({ success: false, error: 'Unable to create inventory item.' });
  }
});

async function checkQuickEditAccess(req, session, clientId) {
  const { quickEditMode } = await getClientProfile(clientId);
  if (quickEditMode === 'disabled') {
    return { code: 'QUICK_EDIT_DISABLED', error: 'Quick Edit is turned off for this account.' };
  }
  if (quickEditMode === 'password') {
    const unlock = readToken(req.get('X-Quick-Edit-Token'), 'quick-edit');
    if (!unlock || unlock.username !== session.username || unlock.clientId !== clientId) {
      return { code: 'QUICK_EDIT_PIN_REQUIRED', error: 'Enter the Quick Edit PIN to change quantities.' };
    }
  }
  return null;
}

async function verifyQuickEditPin(row, pin) {
  const provided = String(pin ?? '').trim();
  if (!provided) return false;
  const storedHash = row.get('Quick_Edit_PIN_Hash');
  if (looksHashed(storedHash)) return verifySecret(provided, storedHash);

  // Legacy plain-text Edit_PIN: accept once, then store a hash. Edit_PIN itself is left as-is.
  const legacyPin = String(row.get('Edit_PIN') || '').trim();
  if (!isValidQuickEditPin(legacyPin) || !constantTimeEqual(provided, legacyPin)) return false;
  try {
    row.set('Quick_Edit_PIN_Hash', await hashSecret(legacyPin));
    await withRetry(() => row.save());
  } catch (error) {
    console.warn('Quick Edit PIN hash migration failed:', error.message);
  }
  return true;
}

app.post('/api/quick-edit/unlock', (req, res, next) => {
  const session = readNotificationSession(req);
  if (!session) return res.status(401).json({ success: false, error: 'Sign in again to unlock Quick Edit.' });
  req.unlockSession = session;
  req.rateLimitUser = `quick-edit:${session.username}`;
  next();
}, authRateLimit, async (req, res) => {
  try {
    const session = req.unlockSession;
    const clientId = normalizeClientId(req.body?.clientId);
    if (!clientId || (!isStaffSession(session) && session.clientId !== clientId)) {
      return res.status(400).json({ success: false, error: 'Invalid unlock request.' });
    }
    await getOrCreateSheet('User_Credentials', USER_CREDENTIALS_HEADERS);
    const row = await findCredentialsRow(clientId);
    if (!row || !(await verifyQuickEditPin(row, req.body?.pin))) {
      return res.status(401).json({ success: false, error: 'Incorrect PIN.' });
    }
    const expires = Date.now() + QUICK_EDIT_UNLOCK_MS;
    return res.json({ success: true, token: signToken({ username: session.username, clientId, expires }, 'quick-edit'), expiresAt: expires });
  } catch (error) {
    console.error('Quick Edit unlock error:', error.message);
    return res.status(error?.response?.status === 429 ? 429 : 500).json({ success: false, error: 'Unable to unlock Quick Edit.' });
  }
});

// Column positions for the received/shipped workflow, matching how loadInventoryForClient reads each sheet.
async function getShipmentColumns(clientId, rows) {
  const headers = (rows[0] || []).map((cell) => String(cell || '').trim().toLowerCase());
  const find = (text, fallback) => {
    const index = headers.findIndex((name) => name.includes(text));
    return index >= 0 ? index : fallback;
  };
  if (clientId === 'CL-002') {
    return { title: find('product description', 1), received: find('quantity received', 3), shipped: find('quantity shipped', 4), status: -1 };
  }
  if (clientId === 'CL-003') {
    return { title: find('product description/name', 0), received: find('quantity received', 2), shipped: find('quantity shipped', 3), status: -1 };
  }
  if (LEGACY_CLIENT_IDS.includes(clientId)) return null;
  const { fields } = await getClientProfile(clientId);
  const keys = findShipmentFieldKeys(fields);
  if (!keys) return null;
  const indexOf = (key) => 2 + fields.findIndex((field) => field.key === key);
  return { title: 1, received: indexOf(keys.received), shipped: indexOf(keys.shipped), status: 2 + fields.length + 1 };
}

app.put('/api/inventory/shipment', async (req, res) => {
  const session = readNotificationSession(req);
  if (!isStaffSession(session)) return res.status(401).json({ success: false, error: 'Only ECL staff can update received and shipped quantities.' });
  try {
    const clientId = normalizeClientId(req.body?.clientId);
    const itemId = String(req.body?.itemId || '');
    const received = Number(req.body?.received);
    const shipped = Number(req.body?.shipped);
    const match = itemId.match(/^(.+)-(\d+)$/);
    if (!clientId || !match || normalizeClientId(match[1]) !== clientId) {
      return res.status(400).json({ success: false, error: 'Invalid item.' });
    }
    if (![received, shipped].every((value) => Number.isSafeInteger(value) && value >= 0)) {
      return res.status(400).json({ success: false, error: 'Quantities must be whole numbers of 0 or more.' });
    }
    if (shipped > received) {
      return res.status(400).json({ success: false, error: 'Shipped cannot be more than received.' });
    }

    const sheet = await findSheetByTitle(clientId);
    if (!sheet) return res.status(404).json({ success: false, error: 'Inventory sheet not found.' });
    const rows = await loadSheetRows(clientId, LEGACY_CLIENT_IDS.includes(clientId) ? null : 500);
    const columns = await getShipmentColumns(clientId, rows);
    if (!columns) return res.status(400).json({ success: false, error: 'This client does not track received and shipped quantities.' });
    const rowIndex = Number(match[2]);
    const rowTitle = String(rows[rowIndex]?.[columns.title] || '').trim();
    // Row numbers shift if someone inserts rows in the sheet, so confirm it is still the same product.
    if (rowIndex < 1 || !rowTitle || rowTitle !== String(req.body?.title || '').trim()) {
      return res.status(409).json({ success: false, error: 'This item moved in the sheet. Refresh and try again.' });
    }

    const stage = getShipmentStage(received, shipped);
    sheet.getCell(rowIndex, columns.received).value = received;
    sheet.getCell(rowIndex, columns.shipped).value = shipped;
    if (columns.status >= 0) sheet.getCell(rowIndex, columns.status).value = SHIPMENT_STATUS_TEXT[stage];
    await withRetry(() => sheet.saveUpdatedCells());
    invalidateReadCache('inventory:');
    await recordInventoryEvent(clientId, `Received ${received}, shipped ${shipped}: ${rowTitle}`, session.username);
    return res.json({ success: true, received, shipped, stage, status: SHIPMENT_STATUS_TEXT[stage] });
  } catch (error) {
    console.error('Shipment update error:', error.message);
    return res.status(error?.response?.status === 429 ? 429 : 500).json({ success: false, error: 'Unable to update shipment.' });
  }
});

app.put('/api/inventory/quantity', async (req, res) => {
  try {
    const session = readNotificationSession(req);
    if (!session) return res.status(401).json({ success: false, error: 'Sign in again to update inventory.' });
    const clientId = normalizeClientId(req.body?.clientId);
    const isStaff = session.role === 'admin' || session.clientId === 'CL-000';
    const sku = String(req.body?.sku || '').trim();
    const quantity = Number(req.body?.qty);
    if (!clientId || !sku || !Number.isSafeInteger(quantity) || quantity < 0 || (!isStaff && session.clientId !== clientId)) {
      return res.status(400).json({ success: false, error: 'Invalid inventory update.' });
    }
    if (clientId === 'CL-002') return res.status(400).json({ success: false, error: 'Use the shipment workflow for this client.' });
    if (!isStaff) {
      const denied = await checkQuickEditAccess(req, session, clientId);
      if (denied) return res.status(403).json({ success: false, ...denied });
    }

    const sheet = await findSheetByTitle(clientId);
    if (!sheet) return res.status(404).json({ success: false, error: 'Inventory sheet not found.' });
    const profile = clientId === 'CL-001' || clientId === 'CL-003' ? null : await getClientProfile(clientId);
    const skuColumn = clientId === 'CL-001' ? 1 : 0;
    const quantityColumn = clientId === 'CL-001' ? 3 : clientId === 'CL-003' ? 2 : 2 + profile.fields.length;
    const statusColumn = clientId === 'CL-003' ? -1 : quantityColumn + 1;
    const startRow = clientId === 'CL-001' ? 8 : 1;
    const endRow = sheet.rowCount;
    const lastColumn = Math.max(skuColumn, quantityColumn, statusColumn) + 1;
    await withRetry(() => sheet.loadCells(`A1:${String.fromCharCode(64 + lastColumn)}${endRow}`));
    let rowIndex = -1;
    for (let index = startRow; index < endRow; index += 1) {
      if (String(sheet.getCell(index, skuColumn).value || '').trim() === sku) {
        rowIndex = index;
        break;
      }
    }
    if (rowIndex < 0) return res.status(404).json({ success: false, error: 'Item not found.' });
    sheet.getCell(rowIndex, quantityColumn).value = quantity;
    if (statusColumn >= 0) sheet.getCell(rowIndex, statusColumn).value = quantity === 0 ? 'Out of Stock' : quantity <= 5 ? 'Low Stock' : 'In Stock';
    await withRetry(() => sheet.saveUpdatedCells());
    invalidateReadCache('inventory:');
    await recordInventoryEvent(clientId, `Updated ${sku} to ${quantity}`, session.username);
    return res.json({ success: true, qty: quantity });
  } catch (error) {
    console.error('Inventory quantity update error:', error.message);
    return res.status(error?.response?.status === 429 ? 429 : 500).json({ success: false, error: 'Unable to update inventory.' });
  }
});

app.post('/api/login', authRateLimit, async (req, res) => {
  const { username, password } = req.body || {};

  try {
    const sheet = await getSheetByName('User_Credentials');
    const rows = await withRetry(() => sheet.getRows());
    const user = rows.find((row) => {
      const rowUser = String(row.get('username') || row.get('Username') || '').trim();
      return rowUser === String(username || '').trim();
    });

    // Generic message on every failure path below so a bad guess can't reveal whether
    // the username exists, whether it's activated, etc.
    const invalidCredentials = () => res.status(401).json({ success: false, error: 'Invalid username or password' });

    if (!user) return invalidCredentials();

    const storedPassword = String(user.get('Password') || user.get('password') || '');
    if (!storedPassword) {
      return res.status(403).json({ success: false, error: 'This account has not been activated yet. Use "Create Account" with the username and activation code you were given.' });
    }

    let passwordOk = false;
    if (looksHashed(storedPassword)) {
      passwordOk = await verifySecret(password, storedPassword);
    } else {
      // Legacy plain-text row (pre-dates hashing) — verify, then transparently upgrade it.
      passwordOk = constantTimeEqual(String(password || ''), storedPassword);
      if (passwordOk) {
        try {
          user.set('Password', await hashSecret(password));
          await withRetry(() => user.save());
        } catch (migrateError) {
          console.warn('Password hash migration failed:', migrateError.message);
        }
      }
    }

    if (!passwordOk) return invalidCredentials();

    const clientId = normalizeClientId(user.get('clientId') || user.get('Client_ID') || user.get('ClientID')) || 'CL-001';
    const clientName = String(user.get('clientName') || user.get('Client_Name') || user.get('ClientName') || clientId || 'Client').trim();
    const role = String(user.get('role') || user.get('Role') || (clientId === 'CL-000' ? 'admin' : 'client')).trim().toLowerCase();

    return res.json({
      success: true,
      message: 'Login successful',
      clientId,
      clientName,
      role,
      notificationToken: signNotificationSession(String(user.get('Username') || '').trim(), clientId, role)
    });
  } catch (error) {
    console.error('Google Sheets login error:', error);
    const message = error.message && error.message.includes('Missing Google Sheets environment variables')
      ? 'Google Sheets configuration is missing or invalid. Update the .env values for GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, and GOOGLE_SHEET_ID.'
      : 'Server error connecting to database';
    return res.status(500).json({ success: false, error: message });
  }
});

app.post('/api/account/activate', authRateLimit, async (req, res) => {
  try {
    const { username, activationCode, password } = req.body || {};
    const safeUsername = String(username || '').trim();
    const safePassword = String(password || '');

    if (!safeUsername || !activationCode || safePassword.length < 8) {
      return res.status(400).json({ success: false, error: 'Username, activation code, and an 8+ character password are required.' });
    }

    const sheet = await getSheetByName('User_Credentials');
    const rows = await withRetry(() => sheet.getRows());
    const user = rows.find((row) => String(row.get('Username') || '').trim() === safeUsername);

    // Same generic error whether the username is wrong, already activated, or the code is wrong.
    const invalid = () => res.status(400).json({ success: false, error: 'Invalid username or activation code.' });

    if (!user) return invalid();
    if (String(user.get('Password') || '').trim()) return invalid();

    const storedCode = String(user.get('Activation_Code') || '').trim();
    if (!codesMatch(activationCode, storedCode)) return invalid();

    const recoveryCode = `${generateCode(4)}-${generateCode(4)}`;
    user.set('Password', await hashSecret(safePassword));
    user.set('Activation_Code', '');
    user.set('Recovery_Code_Hash', await hashSecret(recoveryCode));
    await withRetry(() => user.save());

    const clientId = normalizeClientId(user.get('Client_ID')) || 'CL-001';
    const clientName = String(user.get('Client_Name') || clientId).trim();
    const role = String(user.get('Role') || (clientId === 'CL-000' ? 'admin' : 'client')).trim().toLowerCase();

    return res.json({ success: true, clientId, clientName, role, recoveryCode });
  } catch (error) {
    console.error('Account activation error:', error);
    return res.status(500).json({ success: false, error: 'Unable to activate account.' });
  }
});

app.post('/api/account/recover', authRateLimit, async (req, res) => {
  try {
    const { username, recoveryCode, newPassword } = req.body || {};
    const safeUsername = String(username || '').trim();
    const safePassword = String(newPassword || '');

    if (!safeUsername || !recoveryCode || safePassword.length < 8) {
      return res.status(400).json({ success: false, error: 'Username, recovery code, and an 8+ character new password are required.' });
    }

    const sheet = await getSheetByName('User_Credentials');
    const rows = await withRetry(() => sheet.getRows());
    const user = rows.find((row) => String(row.get('Username') || '').trim() === safeUsername);

    const invalid = () => res.status(400).json({ success: false, error: 'Invalid username or recovery code.' });

    if (!user) return invalid();
    if (!(await verifySecret(normalizeCode(recoveryCode), user.get('Recovery_Code_Hash')))) return invalid();

    // Rotate the recovery code so each one only works once.
    const newRecoveryCode = `${generateCode(4)}-${generateCode(4)}`;
    user.set('Password', await hashSecret(safePassword));
    user.set('Recovery_Code_Hash', await hashSecret(newRecoveryCode));
    await withRetry(() => user.save());

    return res.json({ success: true, recoveryCode: newRecoveryCode });
  } catch (error) {
    console.error('Account recovery error:', error);
    return res.status(500).json({ success: false, error: 'Unable to reset password.' });
  }
});

// Inventory rows carry no dates, so "added" and "last activity" come from Inventory_Events
// descriptions that mention the item's SKU or title. Items with no matching events get null.
async function attachActivityDates(items, fallbackClientId = '') {
  let events = [];
  try {
    events = (await loadNotificationRows('Inventory_Events')).map((row) => ({
      clientId: normalizeClientId(row.get('ClientID')),
      text: String(row.get('Description') || '').trim().toLowerCase(),
      time: Date.parse(row.get('Timestamp'))
    })).filter((event) => event.text && Number.isFinite(event.time));
  } catch (error) {
    console.warn('Inventory activity dates unavailable:', error.message);
  }

  const byClient = new Map();
  events.forEach((event) => {
    if (!byClient.has(event.clientId)) byClient.set(event.clientId, []);
    byClient.get(event.clientId).push(event);
  });

  return items.map((item) => {
    const clientEvents = byClient.get(normalizeClientId(item.clientId || fallbackClientId)) || [];
    const needles = [item.sku, item.title]
      .map((value) => String(value || '').trim().toLowerCase())
      .filter((value) => value.length >= 3 && value !== 'n/a');
    let addedAt = null;
    let lastActivityAt = null;
    clientEvents.forEach((event) => {
      if (!needles.some((needle) => event.text.includes(needle))) return;
      if (event.text.startsWith('added') && (addedAt === null || event.time < addedAt)) addedAt = event.time;
      if (lastActivityAt === null || event.time > lastActivityAt) lastActivityAt = event.time;
    });
    return {
      ...item,
      addedAt: addedAt === null ? null : new Date(addedAt).toISOString(),
      lastActivityAt: lastActivityAt === null ? null : new Date(lastActivityAt).toISOString()
    };
  });
}

app.get('/api/inventory', async (req, res) => {
  try {
    const clientId = String(req.query.clientId || '').trim();

    if (clientId && clientId.toUpperCase() === 'CL-000') {
      const roster = await getClientRoster();
      // CL-000 resolves to the CL-001 sheet, so including it would list CL-001 twice.
      const clientIds = [...new Set(roster.map((client) => normalizeClientId(client.clientId)).filter((id) => id && id !== 'CL-000'))];
      const perClient = await Promise.all(clientIds.map((id) => listInventoryForClient(id)));
      return res.json(await attachActivityDates(perClient.flat()));
    }

    const targetClientId = clientId || 'CL-001';
    const items = await listInventoryForClient(targetClientId);
    return res.json(await attachActivityDates(items, targetClientId));
  } catch (error) {
    console.error('Error fetching inventory:', error.message);
    const message = error.message && error.message.includes('Missing Google Sheets environment variables')
      ? 'Google Sheets configuration is missing or invalid. Update the .env values for GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, and GOOGLE_SHEET_ID.'
      : 'Unable to fetch inventory items.';
    res.status(error?.response?.status === 429 ? 429 : 500).json({ message });
  }
});

async function loadBillingRateRow(clientId) {
  const rows = await loadNotificationRows(RATE_SHEET);
  return rows.find((row) => normalizeClientId(row.get('Client_ID')) === clientId) || null;
}

async function loadBillingEntries(clientId) {
  const rows = await loadNotificationRows(ENTRY_SHEET);
  return rows.filter((row) => normalizeClientId(row.get('Client_ID')) === clientId).map(entryFromRow);
}

async function loadBillingHistory(clientId) {
  const rows = await loadNotificationRows(HISTORY_SHEET);
  return rows.filter((row) => normalizeClientId(row.get('Client_ID')) === clientId).map(historyFromRow);
}

function isBillableClient(clientId) {
  return /^CL-\d{3,}$/.test(clientId) && clientId !== 'CL-000';
}

app.get('/api/billing/summary', async (req, res) => {
  const session = readNotificationSession(req);
  if (!session) return res.status(401).json({ message: 'Sign-in required.' });
  try {
    const staff = isStaffSession(session);
    const clientId = staff ? normalizeClientId(req.query.clientId) : normalizeClientId(session.clientId);
    const month = String(req.query.month || currentMonth()).trim();
    if (!isBillableClient(clientId) || !MONTH_PATTERN.test(month)) {
      return res.status(400).json({ message: 'Choose a client and a valid month.' });
    }
    const [rateRow, entries, history] = await Promise.all([loadBillingRateRow(clientId), loadBillingEntries(clientId), loadBillingHistory(clientId)]);
    const rateCard = rateCardFromRow(rateRow);
    if (!staff && !rateCard.clientVisible) {
      return res.status(403).json({ message: 'Billing is not shared for this account.' });
    }
    const summary = summarizeBilling({ rateCard, entries, history, month });
    return res.json({
      clientId,
      configured: Boolean(rateRow),
      ...summary,
      ...(staff ? {
        entries: entries
          .filter((entry) => entry.date.startsWith(`${month}-`))
          .sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt)),
        history: history.sort((a, b) => b.month.localeCompare(a.month) || b.invoiceDate.localeCompare(a.invoiceDate))
      } : {})
    });
  } catch (error) {
    console.error('Billing summary error:', error.message);
    return res.status(error?.response?.status === 429 ? 429 : 500).json({ message: 'Unable to load billing.' });
  }
});

app.put('/api/admin/billing/rates/:clientId', async (req, res) => {
  try {
    const clientId = normalizeClientId(req.params.clientId);
    if (!isBillableClient(clientId)) return res.status(400).json({ success: false, error: 'Choose a client.' });
    const rateCard = sanitizeRateCard(req.body || {});
    const values = {
      Client_ID: clientId,
      Services_JSON: JSON.stringify(rateCard.services),
      Tax_Rate: rateCard.taxRate,
      Client_Visible: rateCard.clientVisible ? 'true' : 'false',
      Updated_At: new Date().toISOString()
    };
    const sheet = await getOrCreateSheet(RATE_SHEET, BILLING_RATE_HEADERS);
    const rows = await withRetry(() => sheet.getRows());
    const row = rows.find((entry) => normalizeClientId(entry.get('Client_ID')) === clientId);
    if (row) {
      Object.entries(values).forEach(([key, value]) => row.set(key, value));
      await withRetry(() => row.save());
    } else {
      await withRetry(() => sheet.addRow(values));
    }
    invalidateReadCache(`rows:${RATE_SHEET}`);
    return res.json({ success: true, rateCard });
  } catch (error) {
    console.error('Billing rate save error:', error.message);
    return res.status(error?.response?.status === 429 ? 429 : 500).json({ success: false, error: 'Unable to save rate card.' });
  }
});

function billingEntryValues(entry, clientId, username) {
  return {
    Client_ID: clientId,
    Date: entry.date,
    Service_Key: entry.serviceKey,
    Service_Name: entry.name,
    Description: entry.description,
    Unit_Price: entry.unitPrice,
    Quantity: entry.quantity,
    Flat_Charge: entry.flat ? 'true' : 'false',
    Note: entry.note,
    Entered_By: username,
    Updated_At: new Date().toISOString()
  };
}

async function findBillingEntryRow(entryId) {
  const sheet = await getOrCreateSheet(ENTRY_SHEET, BILLING_ENTRY_HEADERS);
  const rows = await withRetry(() => sheet.getRows());
  return rows.find((row) => String(row.get('Entry_ID')) === entryId) || null;
}

app.post('/api/admin/billing/entries', async (req, res) => {
  try {
    const body = req.body || {};
    const clientId = normalizeClientId(body.clientId);
    if (!isBillableClient(clientId)) return res.status(400).json({ success: false, error: 'Choose a client.' });
    const rateCard = rateCardFromRow(await loadBillingRateRow(clientId));
    const { entry, error } = sanitizeEntry(body, rateCard);
    if (error) return res.status(400).json({ success: false, error });

    const sheet = await getOrCreateSheet(ENTRY_SHEET, BILLING_ENTRY_HEADERS);
    const id = crypto.randomUUID();
    await withRetry(() => sheet.addRow({ Entry_ID: id, ...billingEntryValues(entry, clientId, req.adminSession.username) }));
    invalidateReadCache(`rows:${ENTRY_SHEET}`);
    return res.json({ success: true, entry: { id, ...entry } });
  } catch (error) {
    console.error('Billing entry error:', error.message);
    return res.status(error?.response?.status === 429 ? 429 : 500).json({ success: false, error: 'Unable to save billing entry.' });
  }
});

app.put('/api/admin/billing/entries/:entryId', async (req, res) => {
  try {
    const row = await findBillingEntryRow(String(req.params.entryId));
    if (!row) return res.status(404).json({ success: false, error: 'That entry no longer exists.' });
    const clientId = normalizeClientId(row.get('Client_ID'));
    const rateCard = rateCardFromRow(await loadBillingRateRow(clientId));
    const { entry, error } = sanitizeEntry(req.body || {}, rateCard, entryFromRow(row));
    if (error) return res.status(400).json({ success: false, error });
    Object.entries(billingEntryValues(entry, clientId, req.adminSession.username)).forEach(([key, value]) => row.set(key, value));
    await withRetry(() => row.save());
    invalidateReadCache(`rows:${ENTRY_SHEET}`);
    return res.json({ success: true, entry: { id: req.params.entryId, ...entry } });
  } catch (error) {
    console.error('Billing entry update error:', error.message);
    return res.status(error?.response?.status === 429 ? 429 : 500).json({ success: false, error: 'Unable to update billing entry.' });
  }
});

app.delete('/api/admin/billing/entries/:entryId', async (req, res) => {
  try {
    const row = await findBillingEntryRow(String(req.params.entryId));
    if (!row) return res.status(404).json({ success: false, error: 'That entry no longer exists.' });
    await withRetry(() => row.delete());
    invalidateReadCache(`rows:${ENTRY_SHEET}`);
    return res.json({ success: true });
  } catch (error) {
    console.error('Billing entry delete error:', error.message);
    return res.status(error?.response?.status === 429 ? 429 : 500).json({ success: false, error: 'Unable to delete billing entry.' });
  }
});

function billingHistoryValues(record, clientId) {
  return {
    Client_ID: clientId,
    Service_Month: record.month,
    Invoice_Date: record.invoiceDate,
    Invoice_Number: record.invoiceNumber,
    Description: record.description,
    Amount: record.amount,
    Updated_At: new Date().toISOString()
  };
}

async function findBillingHistoryRow(historyId) {
  const sheet = await getOrCreateSheet(HISTORY_SHEET, BILLING_HISTORY_HEADERS);
  const rows = await withRetry(() => sheet.getRows());
  return rows.find((row) => String(row.get('History_ID')) === historyId) || null;
}

app.post('/api/admin/billing/history', async (req, res) => {
  try {
    const clientId = normalizeClientId(req.body?.clientId);
    if (!isBillableClient(clientId)) return res.status(400).json({ success: false, error: 'Choose a client.' });
    const { record, error } = sanitizeHistory(req.body || {});
    if (error) return res.status(400).json({ success: false, error });
    const sheet = await getOrCreateSheet(HISTORY_SHEET, BILLING_HISTORY_HEADERS);
    const id = crypto.randomUUID();
    await withRetry(() => sheet.addRow({ History_ID: id, ...billingHistoryValues(record, clientId) }));
    invalidateReadCache(`rows:${HISTORY_SHEET}`);
    return res.json({ success: true, record: { id, ...record } });
  } catch (error) {
    console.error('Billing history error:', error.message);
    return res.status(error?.response?.status === 429 ? 429 : 500).json({ success: false, error: 'Unable to save past invoice.' });
  }
});

app.put('/api/admin/billing/history/:historyId', async (req, res) => {
  try {
    const row = await findBillingHistoryRow(String(req.params.historyId));
    if (!row) return res.status(404).json({ success: false, error: 'That invoice no longer exists.' });
    const { record, error } = sanitizeHistory(req.body || {}, historyFromRow(row));
    if (error) return res.status(400).json({ success: false, error });
    Object.entries(billingHistoryValues(record, normalizeClientId(row.get('Client_ID')))).forEach(([key, value]) => row.set(key, value));
    await withRetry(() => row.save());
    invalidateReadCache(`rows:${HISTORY_SHEET}`);
    return res.json({ success: true, record: { id: req.params.historyId, ...record } });
  } catch (error) {
    console.error('Billing history update error:', error.message);
    return res.status(error?.response?.status === 429 ? 429 : 500).json({ success: false, error: 'Unable to update past invoice.' });
  }
});

app.delete('/api/admin/billing/history/:historyId', async (req, res) => {
  try {
    const row = await findBillingHistoryRow(String(req.params.historyId));
    if (!row) return res.status(404).json({ success: false, error: 'That invoice no longer exists.' });
    await withRetry(() => row.delete());
    invalidateReadCache(`rows:${HISTORY_SHEET}`);
    return res.json({ success: true });
  } catch (error) {
    console.error('Billing history delete error:', error.message);
    return res.status(error?.response?.status === 429 ? 429 : 500).json({ success: false, error: 'Unable to delete past invoice.' });
  }
});

// Fills the newer settings columns for every client row (including legacy CL-001/002/003).
// Only blank, formula-free cells in those two columns are written; nothing else is touched.
async function migrateClientSettings({ apply = false } = {}) {
  const sheet = apply
    ? await getOrCreateSheet('User_Credentials', USER_CREDENTIALS_HEADERS)
    : await findSheetByTitle('User_Credentials');
  if (!sheet) throw new Error('User_Credentials sheet not found.');
  if (!apply) await withRetry(() => sheet.loadHeaderRow());

  const headers = sheet.headerValues || [];
  const settingsCol = headers.indexOf('Client_Settings_JSON');
  const pinHashCol = headers.indexOf('Quick_Edit_PIN_Hash');
  const rows = await withRetry(() => sheet.getRows());
  const read = (row, header) => (headers.includes(header) ? row.get(header) : '');

  const plans = rows
    .map((row) => {
      const clientId = normalizeClientId(read(row, 'Client_ID'));
      if (!clientId || clientId === 'CL-000') return null;
      const fields = LEGACY_CLIENT_IDS.includes(clientId)
        ? (getClientInventoryFields(clientId).fields || [])
        : (parseFieldsJson(read(row, 'Fields_JSON')) || []);
      return {
        row,
        ...planClientSettingsMigration({
          clientId,
          settingsCell: read(row, 'Client_Settings_JSON'),
          pinHashCell: read(row, 'Quick_Edit_PIN_Hash'),
          editPinCell: read(row, 'Edit_PIN'),
          fields
        })
      };
    })
    .filter(Boolean);

  const report = plans.map((plan) => ({
    clientId: plan.clientId,
    settings: plan.settingsJson ? (apply ? 'defaults written' : 'would write defaults') : 'already set',
    quickEditPin: plan.hashLegacyPin ? (apply ? 'hashed from Edit_PIN' : 'would hash Edit_PIN') : 'unchanged'
  }));
  if (!apply || !plans.length) return report;

  const lastRow = Math.max(...plans.map((plan) => plan.row.rowNumber));
  const firstCol = Math.min(settingsCol, pinHashCol);
  const lastCol = Math.max(settingsCol, pinHashCol);
  await withRetry(() => sheet.loadCells({ startRowIndex: 1, endRowIndex: lastRow, startColumnIndex: firstCol, endColumnIndex: lastCol + 1 }));

  const writeIfBlank = (rowNumber, col, value) => {
    const cell = sheet.getCell(rowNumber - 1, col);
    if (cell.formula || String(cell.value ?? '').trim()) return false;
    cell.value = value;
    return true;
  };

  for (const [index, plan] of plans.entries()) {
    if (plan.settingsJson && !writeIfBlank(plan.row.rowNumber, settingsCol, plan.settingsJson)) report[index].settings = 'skipped (cell not blank)';
    if (plan.hashLegacyPin) {
      const hashed = await hashSecret(String(plan.row.get('Edit_PIN')).trim());
      if (!writeIfBlank(plan.row.rowNumber, pinHashCol, hashed)) report[index].quickEditPin = 'skipped (cell not blank)';
    }
  }
  await withRetry(() => sheet.saveUpdatedCells());
  invalidateReadCache('profile:');
  return report;
}

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Inventory API running on http://localhost:${PORT}`);
  });
}

module.exports = {
  app,
  normalizeInventoryRow,
  normalizeClientId,
  getSheetNameForClient,
  isAdminClient,
  getClientRoster,
  listInventoryForClient,
  summarizeUnreadNotifications,
  signNotificationSession,
  readNotificationSession,
  cachedRead,
  invalidateReadCache,
  attachActivityDates,
  migrateClientSettings
};
