const express = require('express');
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { normalizeInventoryRow, getSheetNameForClient, isAdminClient, getChatSenderRole, getClientInventoryFields, getDashboardColumns, getCreateFormTitleConfig, getChatDriveFolderForClient, isGoogleDriveUrl, normalizeDriveFolderUrl, getShipmentStage, findShipmentFieldKeys, SHIPMENT_STATUS_TEXT } = require('./portalLogic');
const { mapClientSettings, settingsFromInput, isValidQuickEditPin, planClientSettingsMigration } = require('./clientSchema');
const { toGenericRows } = require('./inventoryLayout');
const { FULFILLMENT_STATUSES, STOCK_STATUSES, fulfillmentStatus, shipmentStatus } = require('./inventoryStatus');
const { fetchPublicPage, parseCatalog, catalogFeedUrl } = require('./catalogSync');
const { CATALOG_FIELDS, catalogFieldKeys, catalogColumns, validateCatalogValues } = require('./catalogFields');
const { integrationStorageReady, validateStoreConnection, parseStoreConnection, encryptStoreCredentials, readSubmittedCredentials } = require('./storeIntegration');
const { INBOUND_SHEET, INBOUND_HEADERS, normalizeInboundTracking, validateInboundShipment, inboundFromRow, validateReceiving } = require('./inboundShipments');
const { credentialRole, validSessionRole, warehouseAccess } = require('./permissions');
const { validateBranding, scrapeBranding } = require('./branding');
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
  const session = readToken(String(req.get('Authorization') || '').replace(/^Bearer\s+/i, ''), 'notifications');
  return validSessionRole(session) ? session : null;
}

const QUICK_EDIT_UNLOCK_MS = 30 * 60 * 1000;

function isStaffSession(session) {
  return warehouseAccess(session);
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
// Every portal user shares one Google service account (about 60 reads/minute in total), so reads are
// cached long enough for all users to share them; writes invalidate the affected keys immediately.
const readCache = new Map();
const lastGoodReads = new Map();
const INVENTORY_CACHE_MS = 30000;
const PROFILE_CACHE_MS = 5 * 60 * 1000;
const ROWS_CACHE_MS = 20000;
const CHAT_CACHE_MS = 8000;
const STALE_READ_MAX_MS = 15 * 60 * 1000;

function isRateLimitError(error) {
  return (error?.response?.status || error?.code) === 429;
}

function cachedRead(key, ttlMs, loader) {
  const hit = readCache.get(key);
  if (hit && (hit.pending || Date.now() - hit.at < ttlMs)) return hit.promise;
  const entry = { pending: true, at: 0 };
  entry.promise = loader().then((value) => {
    entry.pending = false;
    entry.at = Date.now();
    lastGoodReads.set(key, { value, at: entry.at });
    return value;
  }, (error) => {
    if (readCache.get(key) === entry) readCache.delete(key);
    // When Google is rate limiting, slightly old data is far better than an error screen.
    const stale = lastGoodReads.get(key);
    if (isRateLimitError(error) && stale && Date.now() - stale.at < STALE_READ_MAX_MS) return stale.value;
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

// Sheet objects whose header row has already been checked, so writes don't spend a read re-checking it.
const verifiedHeaderSheets = new WeakSet();

async function getOrCreateSheet(sheetName, headers = []) {
  const doc = await getDoc();
  let sheet = doc.sheetsByTitle[sheetName] || doc.sheetsByIndex.find((entry) => entry.title === sheetName);

  if (!sheet) {
    sheet = await doc.addSheet({ title: sheetName, headerValues: headers.length ? headers : undefined });
  }

  if (headers.length && !verifiedHeaderSheets.has(sheet)) {
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
    const existingHeaders = new Set(currentHeaders.map((header) => String(header).trim().toLowerCase()));
    const missingCredentialHeaders = headers.filter((header) => !existingHeaders.has(header.toLowerCase()));
    const headersMatch = sheetName === 'User_Credentials'
      ? !missingCredentialHeaders.length
      : headers.every((header, index) => String(currentHeaders[index] || '').trim().toLowerCase() === String(header).trim().toLowerCase());

    if (!headersMatch) {
      // Older registries have portal settings before Role; append missing columns without relabelling stored values.
      const nextHeaders = sheetName === 'User_Credentials'
        ? [...currentHeaders, ...missingCredentialHeaders]
        : [...headers, ...currentHeaders.slice(headers.length)];
      if (Number(sheet.columnCount) < nextHeaders.length) {
        await withRetry(() => sheet.resize({ rowCount: sheet.rowCount, columnCount: nextHeaders.length }));
      }
      await withRetry(() => sheet.setHeaderRow(nextHeaders));
    }
    verifiedHeaderSheets.add(sheet);
  }

  return sheet;
}

function columnIndexToLetter(columnIndex) {
  let remainder = Number(columnIndex);
  let letters = '';
  while (remainder > 0) {
    const digit = (remainder - 1) % 26;
    letters = String.fromCharCode(65 + digit) + letters;
    remainder = Math.floor((remainder - 1) / 26);
  }
  return letters;
}

async function loadSheetRows(sheetName, rowLimitOverride = null) {
  const sheet = await getSheetByName(sheetName);
  const rowCount = Math.max(Number(sheet.rowCount) || 25, 25);
  const colCount = Math.max(Number(sheet.columnCount) || 9, 9);
  const effectiveRowLimit = rowLimitOverride ? Math.min(rowCount, Number(rowLimitOverride)) : rowCount;
  const effectiveColCount = colCount;

  await withRetry(() => sheet.loadCells(`A1:${columnIndexToLetter(effectiveColCount)}${effectiveRowLimit}`));

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
  'Activation_Code', 'Recovery_Code_Hash', 'Client_Settings_JSON', 'Quick_Edit_PIN_Hash',
  'Store_Integration_JSON', 'Store_Integration_Secret', 'Packaging_Notes', 'Website_URL', 'Logo_URL'
];
const LEGACY_CLIENT_IDS = ['CL-001', 'CL-002', 'CL-003'];
const USER_LOGINS_HEADERS = ['Timestamp', 'Username', 'ClientID', 'AuthType'];

async function recordUserLogin(username, clientId) {
  const sheet = await getOrCreateSheet('User_Logins', USER_LOGINS_HEADERS);
  await withRetry(() => sheet.addRow({
    Timestamp: new Date().toISOString(), Username: username, ClientID: clientId, AuthType: 'Credentials'
  }));
}

// getDashboardColumns() returns hand-picked label text/order for legacy clients that
// doesn't line up 1:1 with the add-item `fields` array (e.g. CL-002 folds upc
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
    const quantityIndex = headers.findIndex((header) => String(header).trim().toLowerCase() === 'qty');
    const fieldHeaders = quantityIndex >= 0 ? headers.slice(0, quantityIndex) : headers;
    const skip = new Set(['sku', 'product title', 'title', 'qty', 'status', 'notes', 'client_id']);
    return fieldHeaders
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

// Resolves full display/behavior config for a client. Built-in clients use their original
// layout until their first field save migrates them to the configurable sheet schema.
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
  profile.packagingNotes = row ? String(row.get('Packaging_Notes') || '').trim() : '';
  profile.websiteUrl = row ? String(row.get('Website_URL') || '').trim() : '';
  profile.logoUrl = row ? String(row.get('Logo_URL') || '').trim() : '';
  profile.accentColor = row ? String(row.get('Accent_Color') || '').trim() || profile.accentColor : profile.accentColor;
  profile.driveAccessReady = Boolean(profile.driveFolderUrl && profile.hasEmail);
  return profile;
}

function withEditColumn(columns, profile) {
  // Header must match the cells renderTable draws, or later columns shift under the wrong heading.
  const base = columns.filter((label) => label !== 'EDIT' && !(profile.hideQtyColumn && label === 'QTY'));
  return profile.readOnly || profile.hideQuickEdit ? base : [...base, 'EDIT'];
}

async function loadClientProfile(clientId) {
  const safeClientId = normalizeClientId(clientId) || 'CL-001';
  const isBuiltInClient = LEGACY_CLIENT_IDS.includes(safeClientId);
  let builtInCredentialsRow = null;

  if (isBuiltInClient || safeClientId === 'CL-000') {
    const configClientId = safeClientId === 'CL-000' ? 'CL-001' : safeClientId;
    const inventoryConfig = getClientInventoryFields(configClientId);
    const titleConfig = getCreateFormTitleConfig(configClientId);
    try {
      builtInCredentialsRow = await findCredentialsRow(safeClientId);
    } catch (error) {
      console.warn(`Unable to load settings for ${safeClientId}:`, error.message);
    }
    if (!parseFieldsJson(builtInCredentialsRow?.get('Fields_JSON'))) {
      const profile = applyClientSettings({
        clientId: safeClientId,
        clientName: inventoryConfig.label,
        portalTitle: 'ECL Inventory Portal',
        portalSubtitle: 'Professional Prep & Fulfillment Services',
        accentColor: '#F5C518',
        inventoryMode: inventoryConfig.fields.length ? 'custom' : 'inventory',
        enableAddItem: !inventoryConfig.readOnly,
        allowChat: true,
        allowLogs: true,
        allowUpdate: true,
        readOnly: Boolean(inventoryConfig.readOnly),
        requirePin: Boolean(inventoryConfig.requirePin),
        hideQtyColumn: configClientId === 'CL-002',
        legacy: true,
        driveFolderUrl: safeClientId === 'CL-000' ? '' : getChatDriveFolderForClient(safeClientId),
        titleField: titleConfig,
        fields: inventoryConfig.fields || [],
        dashboardFieldKeys: LEGACY_DASHBOARD_FIELD_KEYS[configClientId] || []
      }, builtInCredentialsRow);
      profile.dashboardColumns = withEditColumn(getDashboardColumns(configClientId), profile);
      return profile;
    }
  }

  const profile = {
    clientId: safeClientId,
    clientName: isBuiltInClient ? getClientInventoryFields(safeClientId).label : safeClientId,
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
    hideQtyColumn: safeClientId === 'CL-002',
    hideQuickEdit: false,
    driveFolderUrl: isBuiltInClient ? getChatDriveFolderForClient(safeClientId) : '',
    titleField: {
      ...getCreateFormTitleConfig(safeClientId),
      label: safeClientId === 'CL-003' ? 'Product Description / Name' : 'Product Title'
    },
    fields: []
  };

  let credentialsRow = builtInCredentialsRow;
  try {
    const row = credentialsRow || await findCredentialsRow(safeClientId);
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
      profile.driveFolderUrl = String(row.get('Drive_Folder_URL') || '').trim() || profile.driveFolderUrl;

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
  // Keep legacy custom columns in the storage schema, but not in CL-002's views.
  const dashboardFields = profile.fields.filter((field) => safeClientId !== 'CL-002' || field.key !== 'productDescription');
  profile.dashboardColumns = withEditColumn([
    'PRODUCT TITLE',
    ...dashboardFields.map((field) => String(field.label || field.key).toUpperCase()),
    ...(profile.hideQtyColumn ? [] : ['QTY']),
    'STATUS'
  ], profile);
  profile.dashboardFieldKeys = dashboardFields.map((field) => field.key);
  return profile;
}

function normalizeClientRow(row = {}) {
  const clientId = normalizeClientId(row.get('clientId') || row.get('Client_ID') || row.get('ClientID'));
  const clientName = String(row.get('clientName') || row.get('Client_Name') || row.get('ClientName') || clientId || 'Client').trim();
  const username = String(row.get('username') || row.get('Username') || '').trim();
  const password = String(row.get('password') || row.get('Password') || '').trim();
  const role = credentialRole(row.get('role') || row.get('Role'), clientId);

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
      .filter((entry) => validSessionRole(entry) && (entry.clientId || entry.username));

    if (roster.length) return roster;
    if (rows.length) return [];
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

async function loadInventoryForClient(targetClientId, strict = false) {
  const sheetName = getSheetNameForClient(targetClientId);
  try {
    // Once clients are deletable, a stale/typo'd clientId must not silently fall back to
    // some other sheet (e.g. User_Credentials) — just report no inventory instead.
    if (!LEGACY_CLIENT_IDS.includes(sheetName) && !(await findSheetByTitle(sheetName))) {
      return [];
    }

    const rows = await loadSheetRows(sheetName, sheetName === 'CL-001' ? null : 500);
    const result = [];
    const profile = await getClientProfile(targetClientId);
    const catalog = catalogColumns(rows, profile);
    const catalogMetadata = (row) => Object.fromEntries(CATALOG_FIELDS.map(({ key }) => [key, String(row[catalog.columns[key]] ?? '').trim()]));
    const trackingHeaders = profile.legacy && sheetName === 'CL-001'
      ? rows.find((row) => row.some((value) => /sku code/i.test(String(value)))) || []
      : rows[0] || [];
    const timestampColumn = trackingHeaders.findIndex((value) => String(value || '').trim() === 'Check_In_Timestamp');
    const trackingColumns = trackingHeaders.flatMap((header, index) => {
      const label = String(header || '').trim();
      const key = !profile.legacy ? profile.fields[index - 2]?.key || '' : '';
      return !/^Archived:/i.test(label) && /tracking/i.test(`${label} ${key}`) ? [{ label, index }] : [];
    });
    const trackingMetadata = (row) => {
      return {
        checkInTimestamp: String(row[timestampColumn] || '').trim(),
        trackingNumbers: trackingColumns.flatMap(({ label, index }) => {
          const number = String(row[index] ?? '').trim();
          return number ? [{ label, number }] : [];
        })
      };
    };

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

    if (sheetName === 'CL-002' && profile.legacy) {
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
        const upc = String(row[columnIndexes.upc >= 0 ? columnIndexes.upc : 0] ?? '').trim();
        const asinValue = String(row[columnIndexes.asin >= 0 ? columnIndexes.asin : 7] ?? '').trim();
        if (description.toLowerCase() === 'product description' || (!description && !upc && !asinValue)) continue;
        const displayTitle = description || upc || asinValue;

        const orderedValue = row[columnIndexes.quantityOrdered >= 0 ? columnIndexes.quantityOrdered : 2] || '';
        const qtyValue = Number(String(orderedValue).replace(/[^0-9.-]/g, '')) || 0;

        const item = {
          id: `CL-002-${index}`,
          clientId: 'CL-002',
          sku: upc || displayTitle,
          title: displayTitle,
          itemName: displayTitle,
          qty: qtyValue,
          quantity: qtyValue,
          reorderLevel: 0,
          status: profile.inventoryMode === 'custom'
            ? fulfillmentStatus(row[normalizedHeaders.indexOf('status')], row[columnIndexes.quantityReceived >= 0 ? columnIndexes.quantityReceived : 3], row[columnIndexes.quantityShipped >= 0 ? columnIndexes.quantityShipped : 4])
            : String(row[normalizedHeaders.indexOf('status')] || 'In Stock'),
          upc,
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
        Object.assign(item, trackingMetadata(row), catalogMetadata(row));

        result.push(item);
      }
      return result;
    }

    if (sheetName === 'CL-003' && profile.legacy) {
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
          status: profile.inventoryMode === 'custom'
            ? fulfillmentStatus(row[headerText.indexOf('status')], row[map.quantityReceived], row[map.quantityShipped])
            : String(row[headerText.indexOf('status')] || 'In Stock'),
          productName,
          quantityOrdered: String(row[map.quantityOrdered] || '').trim(),
          quantityReceived: String(row[map.quantityReceived] || '').trim(),
          quantityShipped: String(row[map.quantityShipped] || '').trim(),
          merchant: String(row[map.merchant] || '').trim(),
          carrier: String(row[map.carrier] || '').trim(),
          trackingNumber: String(row[map.trackingNumber] || '').trim(),
          notes: String(row[map.notes] || '').trim(),
          ...trackingMetadata(row), ...catalogMetadata(row)
        });
      }
      return result;
    }

    if (sheetName === 'CL-001' && profile.legacy) {
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
        if (!skuValue || (/^\d+$/.test(skuValue) && !/^CL-\d{3,}$/i.test(clientIdValue))) {
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
          Object.assign(normalized, trackingMetadata(row), catalogMetadata(row));
          result.push(normalized);
        }
      }
      return result;
    }

    // Any client provisioned through the "Add Client" admin flow gets a sheet laid out as
    // SKU | Product Title | ...custom fields (in the order configured)... | Qty | Status | Notes.
    // Reading it generically here means new clients need zero code changes to appear correctly.
    if (!profile.legacy) {
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
            rawSku: String(row[0] || '').trim(),
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
          if (profile.inventoryMode === 'custom') {
            const keys = findShipmentFieldKeys(profile.fields);
            item.status = fulfillmentStatus(row[statusCol], keys ? item[keys.received] : 0, keys ? item[keys.shipped] : 0);
          }
          Object.assign(item, trackingMetadata(row), catalogMetadata(row));

          result.push(item);
        }
        return result;
    }

    for (const row of rows) {
      const parsed = parseGenericSheetRow(row);
      if (parsed && parsed.sku && parsed.title && parsed.sku !== 'N/A' && parsed.title !== 'Untitled') {
        result.push(parsed);
      }
    }

    return result;
  } catch (error) {
    if (strict || error?.response?.status === 429) throw error;
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
  res.set('Cache-Control', 'no-store');
  const session = readNotificationSession(req);
  if (!session) return res.status(401).json({ message: 'Sign-in required.' });
  try {
    const isAdmin = isStaffSession(session);
    const roster = (await getClientRoster())
      .filter((entry) => isAdmin || normalizeClientId(entry.clientId) === normalizeClientId(session.clientId));
    // Never leak password hashes (or legacy plain-text passwords) to the client.
    const publicRoster = roster.filter((entry) => entry.clientId !== 'CL-000').map(({ password, ...rest }) => rest);
    return res.json(publicRoster);
  } catch (error) {
    console.error('Client roster error:', error);
    return res.status(500).json({ message: 'Unable to fetch client roster.' });
  }
});

function brandingAccess(req, res) {
  const session = readNotificationSession(req);
  if (!session) { res.status(401).json({ success: false, error: 'Sign in to manage branding.' }); return null; }
  const clientId = normalizeClientId(req.body?.clientId);
  if (!/^CL-\d{3,}$/.test(clientId) || clientId === 'CL-000'
    || (!isStaffSession(session) && normalizeClientId(session.clientId) !== clientId)) {
    res.status(403).json({ success: false, error: 'Select your own client account to manage branding.' });
    return null;
  }
  return clientId;
}

const brandingRequests = new Map();
app.post('/api/branding/fetch', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const clientId = brandingAccess(req, res);
  if (!clientId) return;
  let input;
  try {
    input = validateBranding({ websiteUrl: req.body?.websiteUrl, logoUrl: '', accentColor: '' });
    if (!input.websiteUrl) throw new Error('Enter a public Client Website URL first.');
  } catch (error) { return res.status(400).json({ success: false, error: error.message }); }
  const username = readNotificationSession(req).username;
  const now = Date.now();
  for (const [user, started] of brandingRequests) if (now - started > 60000) brandingRequests.delete(user);
  if (brandingRequests.has(username)) return res.status(429).json({ success: false, error: 'Wait one minute before fetching branding again. Manual logo and color entry remain available.' });
  brandingRequests.set(username, now);
  try {
    if (!await findCredentialsRow(clientId)) return res.status(404).json({ success: false, error: 'Client profile not found.' });
    const branding = await scrapeBranding(input.websiteUrl);
    return res.json({ success: true, clientId, branding });
  } catch (error) {
    console.warn('Branding fetch failed:', error.message);
    return res.status(422).json({ success: false, error: 'Could not fetch website branding. The site may block public access; enter a logo URL and hex color manually.' });
  }
});

app.put('/api/branding', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const clientId = brandingAccess(req, res);
  if (!clientId) return;
  let branding;
  try { branding = validateBranding(req.body || {}); }
  catch (error) { return res.status(400).json({ success: false, error: error.message }); }
  try {
    const sheet = await getOrCreateSheet('User_Credentials', USER_CREDENTIALS_HEADERS);
    const rows = await withRetry(() => sheet.getRows());
    const row = rows.find(entry => normalizeClientId(entry.get('Client_ID')) === clientId);
    if (!row) return res.status(404).json({ success: false, error: 'Client profile not found.' });
    row.set('Website_URL', branding.websiteUrl);
    row.set('Logo_URL', branding.logoUrl);
    row.set('Accent_Color', branding.accentColor);
    await withRetry(() => row.save({ raw: true }));
    invalidateReadCache(`profile:${clientId}`);
    return res.json({ success: true, clientId, branding });
  } catch (error) {
    console.error('Branding save failed:', error.message);
    return res.status(500).json({ success: false, error: 'Branding save was not confirmed. Refresh the account before retrying.' });
  }
});

app.put('/api/packaging-notes', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const session = readNotificationSession(req);
  if (!session) return res.status(401).json({ success: false, error: 'Sign in to edit packaging notes.' });
  const clientId = normalizeClientId(req.body?.clientId);
  if (!/^CL-\d{3,}$/.test(clientId) || clientId === 'CL-000'
    || (session.role !== 'admin' && (session.role !== 'client' || normalizeClientId(session.clientId) !== clientId))) {
    return res.status(403).json({ success: false, error: 'Only this client or an administrator can edit its packaging notes.' });
  }
  const notes = req.body?.packagingNotes;
  if (typeof notes !== 'string' || notes.length > 5000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(notes)) {
    return res.status(400).json({ success: false, error: 'Packaging notes must be text of 5000 characters or fewer without control characters.' });
  }
  try {
    const sheet = await getOrCreateSheet('User_Credentials', USER_CREDENTIALS_HEADERS);
    const rows = await withRetry(() => sheet.getRows());
    const row = rows.find((entry) => normalizeClientId(entry.get('Client_ID')) === clientId);
    if (!row) return res.status(404).json({ success: false, error: 'Client profile not found.' });
    const previous = String(row.get('Packaging_Notes') || '').trim();
    if (typeof req.body?.previousNotes !== 'string' || req.body.previousNotes !== previous) {
      return res.status(409).json({ success: false, error: 'Packaging notes changed. Close this form and refresh the account before editing again.' });
    }
    row.set('Packaging_Notes', notes.trim());
    await withRetry(() => row.save({ raw: true }));
    invalidateReadCache(`profile:${clientId}`);
    return res.json({ success: true, clientId, packagingNotes: notes.trim() });
  } catch (error) {
    console.error('Packaging notes save failed:', error.message);
    return res.status(500).json({ success: false, error: 'Packaging notes were not confirmed. Refresh the account before retrying.' });
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

function integrationSummary(row) {
  const config = parseStoreConnection(row.get('Store_Integration_JSON'));
  return {
    platform: config?.platform || 'shopify', domain: config?.domain || '',
    updatedAt: config?.updatedAt || '', hasCredentials: Boolean(row.get('Store_Integration_Secret')),
    storageReady: integrationStorageReady(), automationEnabled: false
  };
}

function integrationClient(req) {
  const session = readNotificationSession(req);
  if (!session) return { status: 401, error: 'Sign in again to manage store settings.' };
  const clientId = normalizeClientId(req.method === 'GET' ? req.query.clientId : req.body?.clientId);
  if (!/^CL-\d{3,}$/.test(clientId) || clientId === 'CL-000'
    || (session.role !== 'admin' && (session.role !== 'client' || normalizeClientId(session.clientId) !== clientId))) {
    return { status: 403, error: 'Only this client or an administrator can manage its store connection.' };
  }
  return { session, clientId };
}

app.get('/api/store-connection', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const access = integrationClient(req);
  if (access.error) return res.status(access.status).json({ success: false, error: access.error });
  try {
    const row = await findCredentialsRow(access.clientId);
    if (!row) return res.status(404).json({ success: false, error: 'Client profile not found.' });
    return res.json({ success: true, clientId: access.clientId, connection: integrationSummary(row) });
  } catch (error) {
    console.error('Store connection read failed.');
    return res.status(500).json({ success: false, error: 'Unable to load store settings. Please retry.' });
  }
});

app.put('/api/store-connection', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const access = integrationClient(req);
  if (access.error) return res.status(access.status).json({ success: false, error: access.error });
  try {
    const sheet = await getOrCreateSheet('User_Credentials', USER_CREDENTIALS_HEADERS);
    const rows = await withRetry(() => sheet.getRows());
    const row = rows.find((entry) => normalizeClientId(entry.get('Client_ID')) === access.clientId);
    if (!row) return res.status(404).json({ success: false, error: 'Client profile not found.' });
    if (req.body?.disconnect === true) {
      row.set('Store_Integration_JSON', '');
      row.set('Store_Integration_Secret', '');
    } else {
      let config;
      let credentials;
      try {
        config = validateStoreConnection(req.body || {});
        credentials = readSubmittedCredentials(req.body || {}, config.platform);
      } catch (error) {
        return res.status(400).json({ success: false, error: error.message });
      }
      if (credentials && req.body?.removeCredentials === true) {
        return res.status(400).json({ success: false, error: 'Choose either replacement credentials or Remove saved credentials, not both.' });
      }
      const previous = parseStoreConnection(row.get('Store_Integration_JSON'));
      const savedSecret = String(row.get('Store_Integration_Secret') || '');
      const changed = previous && (previous.platform !== config.platform || previous.domain !== config.domain);
      if (savedSecret && changed && !credentials && req.body?.removeCredentials !== true) {
        return res.status(400).json({ success: false, error: 'Changing the store or platform requires replacement credentials or Remove saved credentials.' });
      }
      let secret = req.body?.removeCredentials === true ? '' : savedSecret;
      if (credentials) {
        if (!integrationStorageReady()) return res.status(503).json({ success: false, error: 'Credential storage is not configured. Save the store domain without tokens, or ask ECL to enable encrypted storage.' });
        secret = encryptStoreCredentials(credentials, access.clientId, config);
      }
      row.set('Store_Integration_JSON', JSON.stringify({ ...config, updatedAt: new Date().toISOString() }));
      row.set('Store_Integration_Secret', secret);
    }
    await withRetry(() => row.save());
    return res.json({ success: true, clientId: access.clientId, connection: integrationSummary(row) });
  } catch (error) {
    console.error('Store connection save failed.');
    return res.status(500).json({ success: false, error: 'Unable to save store settings. Your changes were not confirmed. Please retry.' });
  }
});

app.use('/api/admin', (req, res, next) => {
  const session = readNotificationSession(req);
  if (!session) {
    return res.status(401).json({ success: false, error: 'Admin sign-in required.' });
  }
  if (session.role !== 'admin') return res.status(403).json({ success: false, error: 'Only administrators can access master settings and billing.' });
  req.adminSession = session;
  next();
});

app.use('/api/admin/staff', (req, res, next) => {
  if (req.adminSession.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Only administrators can configure staff accounts.' });
  }
  next();
});

app.get('/api/admin/logins', async (req, res) => {
  if (req.adminSession.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Only administrators can view login history.' });
  }
  try {
    const sheet = await getOrCreateSheet('User_Logins', USER_LOGINS_HEADERS);
    const rows = await withRetry(() => sheet.getRows());
    const entries = rows.slice(-100).reverse().map((row) => ({
      timestamp: String(row.get('Timestamp') || ''),
      username: String(row.get('Username') || ''),
      clientId: String(row.get('ClientID') || ''),
      authType: String(row.get('AuthType') || '')
    }));
    return res.json(entries);
  } catch (error) {
    console.error('Login history error:', error.message);
    return res.status(error?.response?.status === 429 ? 429 : 500).json({ success: false, error: 'Unable to load login history.' });
  }
});

function publicStaffAccount(row) {
  const account = normalizeClientRow(row);
  return {
    clientId: 'CL-000', username: account.username, name: account.clientName, email: account.email,
    role: account.role, activated: Boolean(String(row.get('Password') || '').trim())
  };
}

function staffAccountInput(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Staff account details are required.' };
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (!name || name.length > 100) return { error: 'Enter a staff name of 1-100 characters.' };
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    return { error: 'Enter a valid email address or leave it blank.' };
  }
  if (body.role !== undefined && body.role !== 'staff') return { error: 'Staff accounts cannot be promoted through this form.' };
  if (body.clientId !== undefined && body.clientId !== 'CL-000') return { error: 'Staff accounts must belong to CL-000.' };
  return { name, email };
}

app.get('/api/admin/staff', async (req, res) => {
  try {
    const sheet = await getOrCreateSheet('User_Credentials', USER_CREDENTIALS_HEADERS);
    const rows = await withRetry(() => sheet.getRows());
    const accounts = rows.filter((row) => {
      const account = normalizeClientRow(row);
      return account.clientId === 'CL-000' && ['admin', 'staff'].includes(account.role);
    }).map(publicStaffAccount);
    return res.json(accounts);
  } catch (error) {
    console.error('Staff list error:', error.message);
    return res.status(error?.response?.status === 429 ? 429 : 500).json({ success: false, error: 'Unable to load staff accounts.' });
  }
});

app.post('/api/admin/staff', async (req, res) => {
  try {
    const input = staffAccountInput(req.body);
    if (input.error) return res.status(400).json({ success: false, error: input.error });
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{2,63}$/.test(username)) {
      return res.status(400).json({ success: false, error: 'Username must be 3-64 letters, numbers, dots, underscores, @ signs or hyphens.' });
    }
    const sheet = await getOrCreateSheet('User_Credentials', USER_CREDENTIALS_HEADERS);
    const rows = await withRetry(() => sheet.getRows());
    if (rows.some((row) => normalizeClientRow(row).username.toLowerCase() === username.toLowerCase())) {
      return res.status(409).json({ success: false, error: 'That username is already in use.' });
    }
    if (input.email && rows.some((row) => normalizeClientRow(row).email.toLowerCase() === input.email.toLowerCase())) {
      return res.status(409).json({ success: false, error: 'That email address is already associated with an account.' });
    }
    const activationCode = `${generateCode(4)}-${generateCode(4)}`;
    await withRetry(() => sheet.addRow({
      Client_ID: 'CL-000', Username: username, Password: '', Client_Name: input.name,
      Email: input.email, Role: 'staff', Activation_Code: activationCode, Recovery_Code_Hash: ''
    }));
    return res.status(201).json({ success: true, username, activationCode });
  } catch (error) {
    console.error('Staff registration error:', error.message);
    return res.status(error?.response?.status === 429 ? 429 : 500).json({ success: false, error: 'Unable to register staff account.' });
  }
});

app.put('/api/admin/staff/:username', async (req, res) => {
  try {
    const input = staffAccountInput(req.body);
    if (input.error) return res.status(400).json({ success: false, error: input.error });
    const username = String(req.params.username || '').trim();
    if (req.body?.username !== undefined && req.body.username !== username) {
      return res.status(400).json({ success: false, error: 'Staff usernames cannot be changed.' });
    }
    const sheet = await getOrCreateSheet('User_Credentials', USER_CREDENTIALS_HEADERS);
    const rows = await withRetry(() => sheet.getRows());
    const row = rows.find((entry) => {
      const account = normalizeClientRow(entry);
      return account.username === username && account.clientId === 'CL-000' && account.role === 'staff';
    });
    if (!row) return res.status(404).json({ success: false, error: 'Staff account not found. Administrator accounts are not editable here.' });
    if (input.email && rows.some((entry) => entry !== row && normalizeClientRow(entry).email.toLowerCase() === input.email.toLowerCase())) {
      return res.status(409).json({ success: false, error: 'That email address is already associated with an account.' });
    }
    row.set('Client_Name', input.name);
    row.set('Email', input.email);
    await withRetry(() => row.save());
    return res.json({ success: true, account: publicStaffAccount(row) });
  } catch (error) {
    console.error('Staff update error:', error.message);
    return res.status(error?.response?.status === 429 ? 429 : 500).json({ success: false, error: 'Unable to update staff account.' });
  }
});

app.post('/api/admin/clients/:clientId/reset-password', async (req, res) => {
  try {
    const clientId = normalizeClientId(req.params.clientId);
    if (clientId === 'CL-000') {
      return res.status(400).json({ success: false, error: 'Staff accounts cannot be reset through client account controls.' });
    }
    const credentialsSheet = await getOrCreateSheet('User_Credentials', USER_CREDENTIALS_HEADERS);
    const rows = await withRetry(() => credentialsSheet.getRows());
    const row = rows.find((entry) => normalizeClientId(entry.get('Client_ID')) === clientId);
    if (!row) return res.status(404).json({ success: false, error: `${clientId} was not found.` });
    if (String(row.get('Role') || '').trim().toLowerCase() === 'retired') {
      return res.status(404).json({ success: false, error: `${clientId} is retired.` });
    }

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
    let branding;
    try { branding = validateBranding({ websiteUrl: body.websiteUrl || '', logoUrl: body.logoUrl || '', accentColor: body.accentColor || '' }); }
    catch (error) { return res.status(400).json({ success: false, error: error.message }); }
    if (body.inventoryMode !== undefined && !['inventory', 'custom'].includes(body.inventoryMode)) {
      return res.status(400).json({ success: false, error: 'Choose a valid inventory mode.' });
    }
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
    if (await findCredentialsRow(clientId)) {
      return res.status(409).json({ success: false, error: `${clientId} is reserved and cannot be reused.` });
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
    if (doc.sheetsByTitle[clientId]) {
      return res.status(409).json({ success: false, error: `${clientId} already has an inventory tab and cannot be reused.` });
    }
    const headerValues = ['SKU', String(body.titleFieldLabel || '').trim() || 'Product Title', ...fields.map((field) => field.label), 'Qty', 'Status', 'Notes'];
    await withRetry(() => doc.addSheet({ title: clientId, headerValues }));

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
      Inventory_Mode: body.inventoryMode || 'custom',
      Enable_Add_Item: body.enableAddItem === false ? 'false' : 'true',
      Accent_Color: branding.accentColor,
      Website_URL: branding.websiteUrl,
      Logo_URL: branding.logoUrl,
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

async function archiveInventorySheet(sheet, suffix) {
  const doc = await getDoc();
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17);
  const title = `${sheet.title}_${suffix}_${timestamp}`.slice(0, 100);
  if (doc.sheetsByTitle[title]) return doc.sheetsByTitle[title];
  return withRetry(() => sheet.duplicate({ title }));
}

async function syncClientFieldColumns(sheet, oldFields, orderedFields, titleLabel, legacyClientId = '') {
  const rows = await loadSheetRows(sheet.title, null);
  const removedFields = oldFields.filter((field) => !orderedFields.some((next) => next.key === field.key));
  if (legacyClientId) {
    await archiveInventorySheet(sheet, 'Original');
  } else if (removedFields.length) {
    await archiveInventorySheet(sheet, 'FieldsArchive');
  }

  const layout = toGenericRows({
    rows,
    oldFields,
    newFields: orderedFields,
    titleLabel,
    legacyClientId
  });
  if (layout.headers.length > sheet.columnCount || layout.rows.length + 1 > sheet.rowCount) {
    await withRetry(() => sheet.resize({
      rowCount: Math.max(sheet.rowCount, layout.rows.length + 1),
      columnCount: Math.max(sheet.columnCount, layout.headers.length)
    }));
  }
  await withRetry(() => sheet.clear(`A2:${columnIndexToLetter(Math.max(sheet.columnCount, layout.headers.length))}`));
  await withRetry(() => sheet.setHeaderRow(layout.headers));
  if (layout.rows.length) await withRetry(() => sheet.addRows(layout.rows));
}

app.put('/api/admin/clients/:clientId', async (req, res) => {
  try {
    const clientId = normalizeClientId(req.params.clientId);
    if (clientId === 'CL-000') {
      return res.status(400).json({ success: false, error: 'The admin account has no client settings.' });
    }
    const isBuiltIn = LEGACY_CLIENT_IDS.includes(clientId);

    const credentialsSheet = await getOrCreateSheet('User_Credentials', USER_CREDENTIALS_HEADERS);
    const rows = await withRetry(() => credentialsSheet.getRows());
    const row = rows.find((entry) => normalizeClientId(entry.get('Client_ID')) === clientId);
    if (!row) {
      return res.status(404).json({ success: false, error: `${clientId} was not found.` });
    }
    if (String(row.get('Role') || '').trim().toLowerCase() === 'retired') {
      return res.status(404).json({ success: false, error: `${clientId} is retired.` });
    }

    const body = req.body || {};
    if (body.inventoryMode !== undefined && !['inventory', 'custom'].includes(body.inventoryMode)) {
      return res.status(400).json({ success: false, error: 'Choose a valid inventory mode.' });
    }
    const email = body.email === undefined ? null : String(body.email || '').trim();
    if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
      return res.status(400).json({ success: false, error: 'Enter a valid email address.' });
    }
    const quickEditPin = String(body.quickEditPin || '').trim();
    if (quickEditPin && !isValidQuickEditPin(quickEditPin)) {
      return res.status(400).json({ success: false, error: 'Quick Edit PIN must be 4-32 characters with no spaces.' });
    }
    if (String(body.driveFolderUrl || '').trim() && !normalizeDriveFolderUrl(body.driveFolderUrl)) {
      return res.status(400).json({ success: false, error: 'Drive folder must be a Google Drive folder link or folder ID.' });
    }

    let branding;
    try {
      branding = validateBranding({
        websiteUrl: body.websiteUrl ?? row.get('Website_URL') ?? '',
        logoUrl: body.logoUrl ?? row.get('Logo_URL') ?? '',
        accentColor: body.accentColor ?? row.get('Accent_Color') ?? ''
      });
    } catch (error) { return res.status(400).json({ success: false, error: error.message }); }
    const legacyLayout = isBuiltIn && !parseFieldsJson(row.get('Fields_JSON'));
    const oldFields = legacyLayout
      ? getClientInventoryFields(clientId).fields.filter((field) => !['upc', 'productDescription', 'productName', 'notes'].includes(field.key))
      : parseFieldsJson(row.get('Fields_JSON')) || [];
    const rawFields = Array.isArray(body.fields)
      ? body.fields.map((field) => ({ ...(oldFields.find((existing) => existing.key === field?.key) || {}), ...field }))
      : oldFields;
    const parsedSubmittedFields = splitFieldVisibility(sanitizeFieldDefs(rawFields));
    const submittedFields = parsedSubmittedFields.fields;
    const priorSettings = mapClientSettings(row.get('Client_Settings_JSON'), { fields: oldFields, clientId });
    const fieldVisibility = Array.isArray(body.fields)
      ? parsedSubmittedFields.fieldVisibility
      : priorSettings.fieldVisibility;
    if (isBuiltIn && ['CL-002', 'CL-003'].includes(clientId)) {
      ['quantityReceived', 'quantityShipped'].forEach((key) => {
        const requiredField = oldFields.find((field) => field.key === key);
        if (!requiredField) return;
        const submittedField = submittedFields.find((field) => field.key === key);
        if (submittedField) submittedField.readOnly = Boolean(requiredField.readOnly);
        else submittedFields.push(requiredField);
      });
    }
    const submittedKeys = submittedFields.map((field) => field.key);

    const orderedFields = oldFields
      .filter((field) => submittedKeys.includes(field.key))
      .map((field) => submittedFields.find((updated) => updated.key === field.key) || field)
      .concat(submittedFields.filter((field) => !oldFields.some((old) => old.key === field.key)));
    const settings = settingsFromInput({ ...priorSettings, ...body, fields: [], fieldVisibility }, orderedFields, clientId);

    if (settings.quickEditMode === 'password' && !quickEditPin && !hasQuickEditPin(row)) {
      return res.status(400).json({ success: false, error: 'Set a Quick Edit PIN to use Password Protected mode.' });
    }

    const titleConfig = getCreateFormTitleConfig(clientId);
    const titleLabel = String(body.titleFieldLabel || row.get('Title_Field_Label') || (
      legacyLayout ? (clientId === 'CL-002' ? 'Product Description' : clientId === 'CL-003' ? 'Product Description / Name' : 'Product Title') : titleConfig.label
    )).trim() || 'Product Title';
    const inventorySheet = await getSheetByName(clientId);
    const schemaChanged = oldFields.length !== orderedFields.length || orderedFields.some((field, index) =>
      field.key !== oldFields[index]?.key || field.label !== oldFields[index]?.label
    );
    const titleLabelChanged = Boolean(body.titleFieldLabel) && String(body.titleFieldLabel).trim() !== String(row.get('Title_Field_Label') || '').trim();
    if (legacyLayout || schemaChanged || titleLabelChanged) {
      await syncClientFieldColumns(inventorySheet, oldFields, orderedFields, titleLabel, legacyLayout ? clientId : '');
    }

    row.set('Client_Name', String(body.clientName || row.get('Client_Name') || clientId).trim());
    row.set('Inventory_Mode', body.inventoryMode || String(row.get('Inventory_Mode') || (clientId === 'CL-001' ? 'inventory' : 'custom')));
    row.set('Portal_Title', String(body.portalTitle ?? row.get('Portal_Title') ?? '').trim());
    row.set('Portal_Subtitle', String(body.portalSubtitle ?? row.get('Portal_Subtitle') ?? '').trim());
    row.set('Accent_Color', branding.accentColor);
    row.set('Website_URL', branding.websiteUrl);
    row.set('Logo_URL', branding.logoUrl);
    row.set('Drive_Folder_URL', normalizeDriveFolderUrl(body.driveFolderUrl ?? row.get('Drive_Folder_URL')));
    row.set('Enable_Add_Item', body.enableAddItem === undefined
      ? String(row.get('Enable_Add_Item') || String(clientId !== 'CL-001'))
      : body.enableAddItem === true ? 'true' : 'false');
    row.set('Allow_Chat', body.allowChat === undefined ? String(row.get('Allow_Chat') || 'true') : body.allowChat === true ? 'true' : 'false');
    row.set('Allow_Logs', body.allowLogs === undefined ? String(row.get('Allow_Logs') || 'true') : body.allowLogs === true ? 'true' : 'false');
    row.set('Allow_Update', body.allowUpdate === undefined ? String(row.get('Allow_Update') || 'true') : body.allowUpdate === true ? 'true' : 'false');
    row.set('Read_Only', body.readOnly === undefined
      ? String(row.get('Read_Only') || String(clientId === 'CL-001'))
      : body.readOnly === true ? 'true' : 'false');
    row.set('Require_Pin', body.requirePin === undefined
      ? String(row.get('Require_Pin') || 'false')
      : body.requirePin === true ? 'true' : 'false');
    row.set('Title_Field_Label', titleLabel);
    row.set('Title_Field_Placeholder', String(body.titleFieldPlaceholder ?? row.get('Title_Field_Placeholder') ?? '').trim());
    row.set('Fields_JSON', JSON.stringify(orderedFields));

    row.set('Client_Settings_JSON', JSON.stringify(settings));
    if (email !== null) row.set('Email', email);
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
    if (clientId === 'CL-000') return res.status(400).json({ success: false, error: 'The admin account cannot be deleted here.' });

    const credentialsSheet = await getOrCreateSheet('User_Credentials', USER_CREDENTIALS_HEADERS);
    const rows = await withRetry(() => credentialsSheet.getRows());
    const row = rows.find((entry) => normalizeClientId(entry.get('Client_ID')) === clientId);
    if (!row) return res.status(404).json({ success: false, error: `${clientId} was not found.` });
    if (String(row.get('Username') || '').trim() === req.adminSession.username) {
      return res.status(400).json({ success: false, error: 'You cannot delete the account you are signed in with.' });
    }

    const doc = await getDoc();
    const inventorySheet = doc.sheetsByTitle[clientId];
    if (inventorySheet) await archiveInventorySheet(inventorySheet, 'Retired');
    row.set('Role', 'retired');
    [
      'Username', 'Password', 'Email', 'Edit_PIN', 'Activation_Code', 'Recovery_Code_Hash',
      'Quick_Edit_PIN_Hash', 'Fields_JSON', 'Client_Settings_JSON', 'Store_Integration_JSON', 'Store_Integration_Secret'
    ].forEach((field) => row.set(field, ''));
    await withRetry(() => row.save());
    if (inventorySheet) {
      await withRetry(() => inventorySheet.clear());
      await withRetry(() => inventorySheet.setHeaderRow(['Retired client ID (reserved)']));
    }
    invalidateReadCache('profile:', 'inventory:');

    return res.json({ success: true, archived: Boolean(inventorySheet), reserved: true });
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
    const allMessages = (await loadNotificationRows('Chat_log')).map((row) => ({
      timestamp: row.get('Timestamp') || row.get('timestamp') || '',
      sender: row.get('Sender') || row.get('sender') || 'Unknown',
      message: row.get('Message') || row.get('message') || '',
      clientId: normalizeClientId(row.get('ClientID') || row.get('clientId') || row.get('Client_ID') || ''),
      isStaff: String(row.get('IsStaff') || row.get('isStaff') || '0').trim() === '1',
      fileUrl: isGoogleDriveUrl(row.get('FileUrl') || row.get('fileUrl')) ? String(row.get('FileUrl') || row.get('fileUrl')).trim() : '',
      fileName: row.get('FileName') || row.get('fileName') || ''
    }));
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
  const key = `rows:${sheetName}`;
  return cachedRead(key, sheetName === 'Chat_log' ? CHAT_CACHE_MS : ROWS_CACHE_MS, async () => {
    const sheet = await findSheetByTitle(sheetName);
    // With a recent copy to fall back on, give up quickly instead of making the user wait out retries.
    return sheet ? withRetry(() => sheet.getRows(), lastGoodReads.has(key) ? 1 : 4) : [];
  });
}

app.get('/api/activity', async (req, res) => {
  const session = readNotificationSession(req);
  if (!session) return res.status(401).json({ message: 'Sign in again to view activity.' });
  const clientId = normalizeClientId(isStaffSession(session) ? req.query.clientId || session.clientId : session.clientId);
  try {
    const events = (await loadNotificationRows('Inventory_Events')).map((row) => ({
      timestamp: row.get('Timestamp') || '',
      clientId: normalizeClientId(row.get('ClientID')),
      action: 'Inventory update',
      actorUsername: String(row.get('ActorUsername') || ''),
      description: String(row.get('Description') || '')
    })).filter((event) => event.clientId && (clientId === 'CL-000' || event.clientId === clientId));
    events.sort((a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0));
    return res.json(events);
  } catch (error) {
    console.error('Activity fetch error:', error.message);
    return res.status(error?.response?.status === 429 ? 429 : 500).json({ message: 'Unable to load activity history.' });
  }
});

app.get('/api/notifications', async (req, res) => {
  try {
    const session = readNotificationSession(req);
    if (!session) return res.status(401).json({ message: 'Sign in again to view notifications.' });
    const isStaff = isStaffSession(session);
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
    const isStaff = isStaffSession(session);
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

const catalogSyncRequests = new Map();
app.post('/api/catalog/sync', async (req, res) => {
  const session = readNotificationSession(req);
  if (!session) return res.status(401).json({ success: false, error: 'Sign in again to sync product details.' });
  const clientId = normalizeClientId(req.body?.clientId);
  if (!clientId || clientId === 'CL-000' || (!isStaffSession(session) && normalizeClientId(session.clientId) !== clientId)) {
    return res.status(403).json({ success: false, error: 'Select your own client account to sync products.' });
  }
  const key = session.username;
  const now = Date.now();
  for (const [user, started] of catalogSyncRequests) if (now - started > 60000) catalogSyncRequests.delete(user);
  if (catalogSyncRequests.has(key)) return res.status(429).json({ success: false, error: 'Please wait one minute before fetching another website. Manual entry remains available.' });
  try {
    const profile = await getClientProfile(clientId);
    if (profile.readOnly && !isStaffSession(session)) return res.status(403).json({ success: false, error: 'This account is view-only.' });
    const url = String(req.body?.url || '').trim();
    if (!url || url.length > 2000) return res.status(400).json({ success: false, error: 'Enter a public product page or feed URL (maximum 2000 characters).' });
    catalogSyncRequests.set(key, now);
    let page = await fetchPublicPage(url);
    const feed = catalogFeedUrl(page.body, page.url);
    if (feed) page = await fetchPublicPage(feed);
    return res.json({ success: true, ...parseCatalog(page.body, page.url) });
  } catch (error) {
    console.warn('Product metadata sync failed:', error.message);
    return res.status(422).json({ success: false, error: `${error.message} Manual entry is always available.` });
  }
});

async function prepareCatalogHeaders(sheet, rows, catalog, rowIndex) {
  const last = catalog.headers.reduce((index, value, column) => String(value || '').trim() ? column : index, 0);
  if (Number(sheet.columnCount) <= last) {
    await withRetry(() => sheet.resize({ rowCount: sheet.rowCount, columnCount: last + 1 }));
    await withRetry(() => sheet.loadCells(`A1:${columnIndexToLetter(last + 1)}${Math.max(rowIndex + 1, catalog.headerRowIndex + 1)}`));
  }
  catalog.headers.forEach((value, column) => {
    if (value && value !== rows[catalog.headerRowIndex]?.[column]) sheet.getCell(catalog.headerRowIndex, column).value = value;
  });
}

app.post('/api/inventory/create', async (req, res) => {
  const session = readNotificationSession(req);
  if (!session) return res.status(401).json({ success: false, error: 'Sign in again to add products.' });
  try {
    const { clientId, sku, title, qty, notes, extraFields = {} } = req.body || {};
    const kind = req.body?.kind === 'order' ? 'order' : 'inventory';
    const status = kind === 'order' ? 'Not Shipped' : req.body?.status;
    const targetClientId = String(clientId || 'CL-001').trim() || 'CL-001';
    if (targetClientId === 'CL-000' || (!isStaffSession(session) && normalizeClientId(session.clientId) !== targetClientId)) {
      return res.status(403).json({ success: false, error: 'You can only add products to your own account.' });
    }
    const itemSku = String(sku || '').trim();
    const itemTitle = String(title || '').trim();
    const values = extraFields && typeof extraFields === 'object' ? { ...extraFields } : {};
    const profile = await getClientProfile(targetClientId);
    if (profile.readOnly && !isStaffSession(session)) return res.status(403).json({ success: false, error: 'This account is view-only.' });
    const catalogKeys = catalogFieldKeys(profile);
    try { validateCatalogValues(values, catalogKeys); } catch (error) {
      return res.status(400).json({ success: false, error: error.message });
    }
    // Staff status comes from the signed session, never from what the browser claims.
    const adminAccess = isStaffSession(readNotificationSession(req));

    // Fields the admin switched off for this form are dropped server-side too, not just hidden.
    if (!isStaffSession(readNotificationSession(req))) {
      const { fieldVisibility = {}, fields: profileFields = [] } = profile;
      const shipmentKeys = findShipmentFieldKeys(profileFields);
      Object.keys(values).forEach((key) => {
        if (fieldVisibility[key] && fieldVisibility[key][kind] === false) delete values[key];
        if (shipmentKeys && (key === shipmentKeys.received || key === shipmentKeys.shipped)) delete values[key];
      });
    }

    const sheetName = getSheetNameForClient(targetClientId);
    const sheet = await getSheetByName(sheetName);

    let row = [];
    if (profile.legacy && targetClientId === 'CL-002') {
      row = [
        String(values.upc || itemSku || ''),
        String(itemTitle || values.productDescription || values.description || ''),
        String(values.quantityOrdered ?? qty ?? ''),
        String(adminAccess ? values.quantityReceived ?? '' : ''),
        String(adminAccess ? values.quantityShipped ?? '' : ''),
        String(values.expDate || ''),
        String(values.merchant || ''),
        String(values.asin || ''),
        String(values.fulfillment || ''),
        String(values.transparencyCode || ''),
        String(values.bundled || ''),
        String(values.bundleQty || ''),
        String(values.notes || notes || '')
      ];
    } else if (profile.legacy && targetClientId === 'CL-003') {
      row = [
        String(values.productName || itemTitle || ''),
        String(values.quantityOrdered ?? qty ?? ''),
        String(adminAccess ? values.quantityReceived ?? '' : ''),
        String(adminAccess ? values.quantityShipped ?? '' : ''),
        String(values.merchant || ''),
        String(values.carrier || ''),
        String(values.trackingNumber || ''),
        String(values.notes || notes || '')
      ];
    } else if (!profile.legacy) {
      // Generic clients (created through the admin "Add Client" flow) always use the
      // SKU | Title | ...custom fields... | Qty | Status | Notes column layout.
      const shipmentKeys = findShipmentFieldKeys(profile.fields);
      const baseQuantity = targetClientId === 'CL-003'
        ? Number(values.quantityReceived) || 0
        : targetClientId === 'CL-002'
          ? Number(values.quantityOrdered ?? qty) || 0
          : Number(qty) || 0;
      row = [
        itemSku,
        itemTitle || itemSku || 'Untitled',
        ...profile.fields.map((field) => String(values[field.key] ?? (
          ['CL-002', 'CL-003'].includes(targetClientId) && field.key === 'quantityOrdered' ? qty ?? '' : ''
        ))),
        baseQuantity,
        profile.inventoryMode === 'custom'
          ? fulfillmentStatus('', shipmentKeys ? values[shipmentKeys.received] : 0, shipmentKeys ? values[shipmentKeys.shipped] : 0)
          : shipmentKeys
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

    if (CATALOG_FIELDS.some(({ key }) => key in values || catalogKeys[key] in values)) {
      const rows = await loadSheetRows(sheetName);
      const catalog = catalogColumns(rows, profile, row.length);
      await prepareCatalogHeaders(sheet, rows, catalog, 0);
      await withRetry(() => sheet.saveUpdatedCells());
      await withRetry(() => sheet.loadHeaderRow(catalog.headerRowIndex + 1));
      for (const { key } of CATALOG_FIELDS) {
        row[catalog.columns[key]] = String(values[catalogKeys[key]] ?? values[key] ?? '');
      }
      row = Array.from({ length: row.length }, (_, index) => row[index] ?? '');
    }
    await withRetry(() => sheet.addRow(row, { raw: true }));
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
  const profile = await getClientProfile(clientId);
  if (profile.inventoryMode === 'inventory') return null;
  if (profile.legacy && clientId === 'CL-002') {
    return { title: find('product description', 1), upc: find('upc', 0), asin: find('asin', 7), received: find('quantity received', 3), shipped: find('quantity shipped', 4), status: workflowStatusColumn(rows, 13) };
  }
  if (profile.legacy && clientId === 'CL-003') {
    return { title: find('product description/name', 0), received: find('quantity received', 2), shipped: find('quantity shipped', 3), status: workflowStatusColumn(rows, 8) };
  }
  if (profile.legacy) return null;
  const { fields } = profile;
  const keys = findShipmentFieldKeys(fields);
  if (!keys) return null;
  const indexOf = (key) => 2 + fields.findIndex((field) => field.key === key);
  return { title: 1, received: indexOf(keys.received), shipped: indexOf(keys.shipped), status: 2 + fields.length + 1 };
}

function workflowStatusColumn(rows, minimum) {
  const headers = rows[0] || [];
  const existing = headers.findIndex((value) => String(value || '').trim().toLowerCase() === 'status');
  if (existing >= 0) return existing;
  return Math.max(minimum, headers.reduce((last, value, index) => String(value || '').trim() ? index + 1 : last, 0));
}

async function prepareWorkflowStatusColumn(sheet, rows, column, rowIndex) {
  if (String(rows[0]?.[column] || '').trim().toLowerCase() === 'status') return;
  if (Number(sheet.columnCount) <= column) {
    await withRetry(() => sheet.resize({ rowCount: sheet.rowCount, columnCount: column + 1 }));
    await withRetry(() => sheet.loadCells(`A1:${columnIndexToLetter(column + 1)}${rowIndex + 1}`));
  }
  sheet.getCell(0, column).value = 'Status';
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
    const rowTitle = String(rows[rowIndex]?.[columns.title] || (
      clientId === 'CL-002' ? rows[rowIndex]?.[columns.upc] || rows[rowIndex]?.[columns.asin] : ''
    ) || '').trim();
    // Row numbers shift if someone inserts rows in the sheet, so confirm it is still the same product.
    if (rowIndex < 1 || !rowTitle || rowTitle !== String(req.body?.title || '').trim()) {
      return res.status(409).json({ success: false, error: 'This item moved in the sheet. Refresh and try again.' });
    }
    if ('expectedReceived' in req.body || 'expectedShipped' in req.body) {
      const expectedReceived = req.body.expectedReceived;
      const expectedShipped = req.body.expectedShipped;
      if (![expectedReceived, expectedShipped].every((value) => Number.isSafeInteger(value) && value >= 0)) {
        return res.status(400).json({ success: false, error: 'Expected shipment totals must be non-negative whole numbers.' });
      }
      const currentReceived = Number(rows[rowIndex][columns.received] || 0);
      const currentShipped = Number(rows[rowIndex][columns.shipped] || 0);
      if (currentReceived !== expectedReceived || currentShipped !== expectedShipped) {
        return res.status(409).json({ success: false, error: 'Shipment totals changed. Refresh and verify this item before checking in again.' });
      }
    }

    const profile = await getClientProfile(clientId);
    const stage = getShipmentStage(received, shipped);
    const status = profile.inventoryMode === 'custom'
      ? shipmentStatus(rows[rowIndex][columns.status], rows[rowIndex][columns.received], received, shipped)
      : SHIPMENT_STATUS_TEXT[stage];
    await prepareWorkflowStatusColumn(sheet, rows, columns.status, rowIndex);
    sheet.getCell(rowIndex, columns.received).value = received;
    sheet.getCell(rowIndex, columns.shipped).value = shipped;
    sheet.getCell(rowIndex, columns.status).value = status;
    await withRetry(() => sheet.saveUpdatedCells());
    invalidateReadCache('inventory:');
    await recordInventoryEvent(clientId, `Received ${received}, shipped ${shipped}: ${rowTitle}`, session.username);
    return res.json({ success: true, received, shipped, stage, status });
  } catch (error) {
    console.error('Shipment update error:', error.message);
    return res.status(error?.response?.status === 429 ? 429 : 500).json({ success: false, error: 'Unable to update shipment.' });
  }
});

app.post('/api/inventory/check-in', async (req, res) => {
  const session = readNotificationSession(req);
  if (!isStaffSession(session)) return res.status(403).json({ success: false, error: 'Only ECL staff can check in items.' });
  try {
    const clientId = normalizeClientId(req.body?.clientId);
    const code = String(req.body?.code || '').trim().toUpperCase();
    const itemId = String(req.body?.itemId || '');
    if (!clientId || clientId === 'CL-000' || !code || code.length > 200) {
      return res.status(400).json({ success: false, error: 'Select a client and scan a valid barcode.' });
    }
    const profile = await getClientProfile(clientId);
    if (profile.inventoryMode !== 'custom') return res.status(400).json({ success: false, error: 'Arrival check-in requires an order-fulfillment account.' });
    const items = await loadInventoryForClient(clientId);
    const item = items.find((entry) => entry.id === itemId);
    const keys = ['sku', 'upc', 'trackingNumber', 'tracking', ...profile.fields
      .filter((field) => /sku|upc|tracking/i.test(`${field.key} ${field.label}`)).map((field) => field.key)];
    if (!item || !keys.some((key) => String(item[key] || '').trim().toUpperCase() === code)) {
      return res.status(409).json({ success: false, error: 'This barcode no longer matches the selected item. Scan again.' });
    }
    if (['Shipped out', 'Received & Verified', 'In Prep'].includes(item.status)) {
      return res.status(409).json({ success: false, error: 'This item has already advanced past arrival. Its stage was not changed.' });
    }
    const sheet = await findSheetByTitle(clientId);
    const rows = await loadSheetRows(clientId);
    const layout = await getItemEditColumns(clientId, rows);
    const rowIndex = Number(itemId.match(/-(\d+)$/)?.[1]);
    const title = String(rows[rowIndex]?.[layout.columns[layout.titleKey]] || (
      profile.legacy && clientId === 'CL-002' ? rows[rowIndex]?.[layout.columns.upc] || rows[rowIndex]?.[layout.columns.asin] : ''
    ) || '').trim();
    if (!rowIndex || title !== item.title) return res.status(409).json({ success: false, error: 'This item moved. Refresh and scan again.' });
    if (!keys.some((key) => layout.columns[key] !== undefined && String(rows[rowIndex][layout.columns[key]] || '').trim().toUpperCase() === code)) {
      return res.status(409).json({ success: false, error: 'This barcode changed. Refresh and scan again.' });
    }
    const receivedKey = profile.fields.find((field) => /received/i.test(`${field.key} ${field.label}`))?.key;
    const shippedKey = profile.fields.find((field) => /shipped/i.test(`${field.key} ${field.label}`))?.key;
    const currentStatus = fulfillmentStatus(
      rows[rowIndex][layout.columns.status],
      rows[rowIndex][layout.columns[receivedKey]],
      rows[rowIndex][layout.columns[shippedKey]]
    );
    if (['Shipped out', 'Received & Verified', 'In Prep'].includes(currentStatus)) {
      return res.status(409).json({ success: false, error: 'This item advanced past arrival. Refresh inventory before scanning again.' });
    }
    const headers = rows[0] || [];
    let timestampColumn = headers.findIndex((value) => String(value || '').trim() === 'Check_In_Timestamp');
    const statusColumn = layout.columns.status;
    if (timestampColumn >= 0 && rows[rowIndex][timestampColumn]) {
      return res.json({ success: true, alreadyCheckedIn: true, timestamp: String(rows[rowIndex][timestampColumn]), status: item.status });
    }
    if (timestampColumn < 0) timestampColumn = Math.max(statusColumn + 1, headers.reduce((last, value, index) => String(value || '').trim() ? index + 1 : last, 0));
    if (Number(sheet.columnCount) <= timestampColumn) {
      await withRetry(() => sheet.resize({ rowCount: sheet.rowCount, columnCount: timestampColumn + 1 }));
      await withRetry(() => sheet.loadCells(`A1:${columnIndexToLetter(timestampColumn + 1)}${rowIndex + 1}`));
    }
    const timestamp = new Date().toISOString();
    sheet.getCell(0, statusColumn).value = 'Status';
    sheet.getCell(0, timestampColumn).value = 'Check_In_Timestamp';
    sheet.getCell(rowIndex, statusColumn).value = 'Arrived / Check-In';
    sheet.getCell(rowIndex, timestampColumn).value = timestamp;
    await withRetry(() => sheet.saveUpdatedCells());
    invalidateReadCache('inventory:');
    await recordInventoryEvent(clientId, `Barcode check-in ${item.title} at ${timestamp}`, session.username);
    return res.json({ success: true, timestamp, status: 'Arrived / Check-In' });
  } catch (error) {
    console.error('Barcode check-in error:', error.message);
    return res.status(error?.response?.status === 429 ? 429 : 500).json({ success: false, error: 'Unable to record arrival. Refresh inventory before scanning again.' });
  }
});

// Sheet columns a product's details can be edited in, matching how loadInventoryForClient reads each layout.
// Received/shipped quantities are deliberately absent: only staff change them, through /api/inventory/shipment.
async function getBaseItemEditColumns(clientId, rows) {
  const headers = (rows[0] || []).map((cell) => String(cell || '').trim().toLowerCase());
  const find = (test, fallback) => {
    const index = headers.findIndex((name) => (typeof test === 'function' ? test(name) : name.includes(test)));
    return index >= 0 ? index : fallback;
  };
  const profile = await getClientProfile(clientId);
  if (profile.legacy && clientId === 'CL-002') {
    return {
      locate: 'index',
      titleKey: 'productDescription',
      numeric: new Set(['quantityOrdered', 'bundleQty']),
      columns: {
        upc: find('upc', 0), title: find('product description', 1), productDescription: find('product description', 1), quantityOrdered: find('quantity ordered', 2),
        expDate: find('exp date', 5), merchant: find('merchant', 6), asin: find('asin', 7),
        fulfillment: find((name) => name.includes('fbm') || name.includes('fba'), 8), transparencyCode: find('transparency', 9),
        bundled: find('bundled', 10), bundleQty: find('bundle quantity', 11), notes: find('notes', 12),
        status: workflowStatusColumn(rows, 13)
      }
    };
  }
  if (profile.legacy && clientId === 'CL-003') {
    const exact = (...names) => (name) => names.includes(name);
    return {
      locate: 'index',
      titleKey: 'productName',
      numeric: new Set(['quantityOrdered']),
      columns: {
        productName: find(exact('product description/name'), 0), quantityOrdered: find(exact('quantity ordered'), 1),
        merchant: find(exact('merchant'), 4), carrier: find(exact('carrier'), 5),
        trackingNumber: find(exact('tracking #', 'tracking number'), 6), notes: find(exact('notes'), 7),
        status: workflowStatusColumn(rows, 8)
      }
    };
  }
  if (profile.legacy && clientId === 'CL-001') {
    return { locate: 'sku', titleKey: 'title', numeric: new Set(['qty']), columns: { sku: 1, title: 2, qty: 3, status: 4, notes: 5 } };
  }
  const { fields } = profile;
  const shipmentKeys = findShipmentFieldKeys(fields);
  const columns = { sku: 0, title: 1, notes: 2 + fields.length + 2 };
  if (profile.inventoryMode === 'custom') columns.status = 3 + fields.length;
  fields.forEach((field, index) => {
    if (shipmentKeys && (field.key === shipmentKeys.received || field.key === shipmentKeys.shipped)) return;
    columns[field.key] = 2 + index;
  });
  if (profile.inventoryMode === 'inventory' || (!shipmentKeys && !['CL-002', 'CL-003'].includes(clientId))) {
    columns.qty = 2 + fields.length;
    columns.status = 3 + fields.length;
  }
  return { locate: 'index', titleKey: 'title', numeric: new Set(['qty', ...fields.filter((field) => field.type === 'number').map((field) => field.key)]), columns };
}

async function getItemEditColumns(clientId, rows) {
  const layout = await getBaseItemEditColumns(clientId, rows);
  const profile = await getClientProfile(clientId);
  const catalog = catalogColumns(rows, profile, Math.max(...Object.values(layout.columns)) + 1);
  if (layout.columns.status !== undefined && !catalog.headers[layout.columns.status] && catalog.headerRowIndex === 0) catalog.headers[layout.columns.status] = 'Status';
  Object.assign(layout.columns, catalog.columns);
  layout.numeric.add('bundleQty');
  return { ...layout, catalog };
}

app.put('/api/inventory/item', async (req, res) => {
  const session = readNotificationSession(req);
  if (!session) return res.status(401).json({ success: false, error: 'Sign in again to edit products.' });
  try {
    const staff = isStaffSession(session);
    const clientId = normalizeClientId(req.body?.clientId);
    if (!clientId || clientId === 'CL-000' || (!staff && normalizeClientId(session.clientId) !== clientId)) {
      return res.status(400).json({ success: false, error: 'Invalid product update.' });
    }
    const profile = await getClientProfile(clientId);
    if (!staff && profile.readOnly) return res.status(403).json({ success: false, error: 'This account is view-only.' });

    const values = req.body?.values && typeof req.body.values === 'object' ? req.body.values : {};
    const shipmentKeys = findShipmentFieldKeys(profile.fields || []);
    if (shipmentKeys && (shipmentKeys.received in values || shipmentKeys.shipped in values)) {
      return res.status(403).json({ success: false, error: 'Only ECL staff can change received and shipped quantities.' });
    }
    if ('status' in values && profile.inventoryMode === 'custom' && !staff) {
      return res.status(403).json({ success: false, error: 'Only ECL staff can change fulfillment stages.' });
    }
    if ('qty' in values || ('status' in values && profile.inventoryMode !== 'custom')) {
      if (profile.inventoryMode === 'custom' && (shipmentKeys || ['CL-002', 'CL-003'].includes(clientId))) {
        return res.status(400).json({ success: false, error: 'Quantity and status are managed through the shipment workflow.' });
      }
      if (!staff) {
        const denied = await checkQuickEditAccess(req, session, clientId);
        if (denied) return res.status(403).json({ success: false, ...denied });
      }
    }

    const sheet = await findSheetByTitle(clientId);
    if (!sheet) return res.status(404).json({ success: false, error: 'Inventory sheet not found.' });
    const rows = await loadSheetRows(clientId, LEGACY_CLIENT_IDS.includes(clientId) ? null : 500);
    const layout = await getItemEditColumns(clientId, rows);
    try { validateCatalogValues(values, layout.catalog.keys); } catch (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    const updates = [];
    for (const [key, raw] of Object.entries(values)) {
      if (!(key in layout.columns)) return res.status(400).json({ success: false, error: `"${key}" can't be edited here.` });
      const text = String(raw ?? '').trim();
      const maxLength = key === 'prepInstructions' || key === layout.catalog.keys.prepInstructions ? 5000
        : ['imageUrl', 'productUrl', layout.catalog.keys.imageUrl, layout.catalog.keys.productUrl].includes(key) ? 2000 : 500;
      if (text.length > maxLength) return res.status(400).json({ success: false, error: `This product field must be ${maxLength} characters or fewer.` });
      if ((key === layout.titleKey || key === 'title') && !text) return res.status(400).json({ success: false, error: 'The product name cannot be blank.' });
      if (key === 'qty' && (!text || !Number.isSafeInteger(Number(text)) || Number(text) < 0)) {
        return res.status(400).json({ success: false, error: 'Quantity must be a non-negative whole number.' });
      }
      if (key === 'status' && !(profile.inventoryMode === 'custom' ? FULFILLMENT_STATUSES : STOCK_STATUSES).includes(text)) {
        return res.status(400).json({ success: false, error: 'Choose a valid status for this inventory mode.' });
      }
      if (layout.numeric.has(key) && text && !Number.isFinite(Number(text))) return res.status(400).json({ success: false, error: 'Quantities must be numbers.' });
      updates.push([layout.columns[key], layout.numeric.has(key) && text ? Number(text) : text]);
    }
    if (!updates.length) return res.status(400).json({ success: false, error: 'Nothing to update.' });
    if ('qty' in values && !('status' in values) && profile.inventoryMode !== 'custom') {
      const quantity = Number(values.qty);
      updates.push([layout.columns.status, quantity === 0 ? 'Out of Stock' : quantity <= 5 ? 'Low Stock' : 'In Stock']);
    }

    let rowIndex = -1;
    if (layout.locate === 'sku') {
      const sku = String(req.body?.sku || '').trim();
      rowIndex = sku ? rows.findIndex((row, index) => index > 0 && String(row[layout.columns.sku] || '').trim() === sku) : -1;
    } else {
      const match = String(req.body?.itemId || '').match(/-(\d+)$/);
      rowIndex = match ? Number(match[1]) : -1;
      // Row numbers shift if rows are inserted in the sheet, so confirm it is still the same product.
      const rowTitle = String(rows[rowIndex]?.[layout.columns[layout.titleKey]] || (
        profile.legacy && clientId === 'CL-002' ? rows[rowIndex]?.[layout.columns.upc] || rows[rowIndex]?.[layout.columns.asin] : ''
      ) || '').trim();
      if (rowIndex < 1 || !rowTitle || rowTitle !== String(req.body?.title || '').trim()) rowIndex = -1;
    }
    if (rowIndex < 1) return res.status(409).json({ success: false, error: 'This item moved in the sheet. Refresh and try again.' });

    if ('status' in values && profile.inventoryMode === 'custom') {
      const shipmentColumns = await getShipmentColumns(clientId, rows);
      if (shipmentColumns && Number(rows[rowIndex][shipmentColumns.shipped]) > 0
        && Number(rows[rowIndex][shipmentColumns.shipped]) >= Number(rows[rowIndex][shipmentColumns.received])
        && values.status !== 'Shipped out') {
        return res.status(400).json({ success: false, error: 'This item is fully shipped. Correct the shipment totals before changing its stage.' });
      }
    }
    if (CATALOG_FIELDS.some(({ key }) => key in values || layout.catalog.keys[key] in values)) {
      await prepareCatalogHeaders(sheet, rows, layout.catalog, rowIndex);
    }
    if ('status' in values && profile.legacy && profile.inventoryMode === 'custom') {
      await prepareWorkflowStatusColumn(sheet, rows, layout.columns.status, rowIndex);
    }
    updates.forEach(([column, value]) => { sheet.getCell(rowIndex, column).value = value; });
    await withRetry(() => sheet.saveUpdatedCells());
    invalidateReadCache('inventory:');
    const title = String(values[layout.titleKey] ?? values.title ?? req.body?.title ?? '').trim();
    await recordInventoryEvent(clientId, `Edited details: ${title}`, session.username);
    return res.json({ success: true });
  } catch (error) {
    console.error('Product update error:', error.message);
    return res.status(error?.response?.status === 429 ? 429 : 500).json({ success: false, error: 'Unable to update product.' });
  }
});

app.put('/api/inventory/quantity', async (req, res) => {
  try {
    const session = readNotificationSession(req);
    if (!session) return res.status(401).json({ success: false, error: 'Sign in again to update inventory.' });
    const clientId = normalizeClientId(req.body?.clientId);
    const isStaff = isStaffSession(session);
    const sku = String(req.body?.sku || '').trim();
    const quantity = Number(req.body?.qty);
    if (!clientId || !sku || !Number.isSafeInteger(quantity) || quantity < 0 || (!isStaff && session.clientId !== clientId)) {
      return res.status(400).json({ success: false, error: 'Invalid inventory update.' });
    }
    const profile = await getClientProfile(clientId);
    if (profile.inventoryMode === 'custom' && (clientId === 'CL-002' || findShipmentFieldKeys(profile.fields))) return res.status(400).json({ success: false, error: 'Use the shipment workflow for this client.' });
    if (!isStaff) {
      const denied = await checkQuickEditAccess(req, session, clientId);
      if (denied) return res.status(403).json({ success: false, ...denied });
    }

    const sheet = await findSheetByTitle(clientId);
    if (!sheet) return res.status(404).json({ success: false, error: 'Inventory sheet not found.' });
    const skuColumn = profile.legacy && clientId === 'CL-001' ? 1 : 0;
    const receivedIndex = clientId === 'CL-003' ? profile.fields.findIndex((field) => field.key === 'quantityReceived') : -1;
    const quantityColumn = profile.legacy
      ? clientId === 'CL-001' ? 3 : clientId === 'CL-003' ? 2 : 2 + profile.fields.length
      : receivedIndex >= 0 ? 2 + receivedIndex : 2 + profile.fields.length;
    const statusColumn = profile.legacy && clientId === 'CL-003' ? -1 : profile.legacy ? quantityColumn + 1 : 2 + profile.fields.length + 1;
    const startRow = profile.legacy && clientId === 'CL-001' ? 8 : 1;
    const endRow = sheet.rowCount;
    const lastColumn = Math.max(skuColumn, quantityColumn, statusColumn) + 1;
    await withRetry(() => sheet.loadCells(`A1:${columnIndexToLetter(lastColumn)}${endRow}`));
    let rowIndex = -1;
    for (let index = startRow; index < endRow; index += 1) {
      const cellSku = String(sheet.getCell(index, skuColumn).value || '').trim();
      // Items saved without a SKU are listed under their title, so match on the title column instead.
      const titleMatch = !cellSku && skuColumn === 0 && String(sheet.getCell(index, 1).value || '').trim() === sku;
      if (cellSku === sku || titleMatch) {
        rowIndex = index;
        break;
      }
    }
    if (rowIndex < 0) return res.status(404).json({ success: false, error: 'Item not found.' });
    sheet.getCell(rowIndex, quantityColumn).value = quantity;
    if (statusColumn >= 0 && profile.inventoryMode !== 'custom') sheet.getCell(rowIndex, statusColumn).value = quantity === 0 ? 'Out of Stock' : quantity <= 5 ? 'Low Stock' : 'In Stock';
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

    const clientId = normalizeClientId(user.get('clientId') || user.get('Client_ID') || user.get('ClientID'));
    const clientName = String(user.get('clientName') || user.get('Client_Name') || user.get('ClientName') || clientId || 'Client').trim();
    const role = credentialRole(user.get('role') || user.get('Role'), clientId);
    if (!validSessionRole({ role, clientId })) return invalidCredentials();
    await getOrCreateSheet('User_Credentials', USER_CREDENTIALS_HEADERS);
    if (!String(user.get('Role') || user.get('role') || '').trim()) {
      user.set('Role', role);
      await withRetry(() => user.save());
    }

    await recordUserLogin(String(user.get('Username') || user.get('username') || '').trim(), clientId);
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
    const clientId = normalizeClientId(user.get('Client_ID'));
    const clientName = String(user.get('Client_Name') || clientId).trim();
    const role = credentialRole(user.get('Role'), clientId);
    if (!validSessionRole({ role, clientId })) return invalid();
    const notificationToken = signNotificationSession(safeUsername, clientId, role);
    user.set('Password', await hashSecret(safePassword));
    user.set('Activation_Code', '');
    user.set('Recovery_Code_Hash', await hashSecret(recoveryCode));
    await withRetry(() => user.save());

    await recordUserLogin(safeUsername, clientId);
    return res.json({ success: true, username: safeUsername, clientId, clientName, role, notificationToken, recoveryCode });
  } catch (error) {
    console.error('Account activation error:', error);
    return res.status(500).json({ success: false, error: 'Unable to activate account.' });
  }
});

app.post('/api/account/recover', authRateLimit, async (req, res) => {
  try {
    const { username, recoveryCode, newPassword } = req.body || {};
    const safeUsername = typeof username === 'string' ? username.trim() : '';
    const safePassword = typeof newPassword === 'string' ? newPassword : '';
    const safeCode = typeof recoveryCode === 'string' ? normalizeCode(recoveryCode) : '';

    if (!safeUsername || !safeCode || safePassword.length < 8) {
      return res.status(400).json({ success: false, error: 'Username, recovery or administrator-issued reset code, and an 8+ character new password are required.' });
    }

    const sheet = await getSheetByName('User_Credentials');
    const rows = await withRetry(() => sheet.getRows());
    const user = rows.find((row) => String(row.get('Username') || '').trim() === safeUsername);

    const invalid = () => res.status(400).json({ success: false, error: 'Invalid username or reset code. Use the exact username and the latest recovery or administrator-issued code; each code works only once.' });

    if (!user) return invalid();
    const awaitingActivation = !String(user.get('Password') || '').trim();
    const codeMatches = awaitingActivation
      ? codesMatch(safeCode, user.get('Activation_Code'))
      : await verifySecret(safeCode, user.get('Recovery_Code_Hash'));
    if (!codeMatches) return invalid();

    // Admin resets clear the password and issue an activation code instead of a recovery hash.
    const newRecoveryCode = `${generateCode(4)}-${generateCode(4)}`;
    user.set('Password', await hashSecret(safePassword));
    user.set('Activation_Code', '');
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
  res.set('Cache-Control', 'no-store');
  const session = readNotificationSession(req);
  if (!session) return res.status(401).json({ message: 'Sign in to view inventory.' });
  try {
    const clientId = normalizeClientId(req.query.clientId || session.clientId);
    if (!isStaffSession(session) && clientId !== session.clientId) return res.status(403).json({ message: 'You can only view your own inventory.' });
    if (!/^CL-\d{3,}$/.test(clientId)) return res.status(400).json({ message: 'Choose a valid client account.' });

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

async function inboundAccess(req, res) {
  res.set('Cache-Control', 'no-store');
  const session = readNotificationSession(req);
  if (!session) {
    res.status(401).json({ success: false, error: 'Sign in to view inbound shipments.' });
    return null;
  }
  const clientId = normalizeClientId(req.method === 'GET' ? req.query.clientId || session.clientId : req.body?.clientId);
  if (!/^CL-\d{3,}$/.test(clientId) || clientId === 'CL-000') {
    res.status(400).json({ success: false, error: 'Select a client account.' });
    return null;
  }
  if (!isStaffSession(session) && clientId !== normalizeClientId(session.clientId)) {
    res.status(403).json({ success: false, error: 'You can only manage inbound shipments for your own account.' });
    return null;
  }
  if (!(await findCredentialsRow(clientId))) {
    res.status(404).json({ success: false, error: 'Client profile not found.' });
    return null;
  }
  const profile = await getClientProfile(clientId);
  if (!profile.enableInboundShipments) {
    res.status(403).json({ success: false, error: 'Inbound restock shipments are disabled for this account. Contact an administrator to enable them.' });
    return null;
  }
  return { session, clientId };
}

app.get('/api/inbound-shipments', async (req, res) => {
  try {
    const access = await inboundAccess(req, res);
    if (!access) return;
    const sheet = await findSheetByTitle(INBOUND_SHEET);
    const rows = sheet ? await withRetry(() => sheet.getRows()) : [];
    const shipments = rows.filter((row) => normalizeClientId(row.get('Client_ID')) === access.clientId)
      .map(inboundFromRow).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return res.json({ success: true, clientId: access.clientId, shipments });
  } catch (error) {
    console.error('Inbound shipment read failed:', error.message);
    return res.status(500).json({ success: false, error: 'Unable to load inbound shipments. Please retry.' });
  }
});

app.post('/api/inbound-shipments', async (req, res) => {
  try {
    const access = await inboundAccess(req, res);
    if (!access) return;
    let shipment;
    try { shipment = validateInboundShipment(req.body); }
    catch (error) { return res.status(400).json({ success: false, error: error.message }); }
    const id = req.body?.shipmentId;
    if (typeof id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) {
      return res.status(400).json({ success: false, error: 'Invalid shipment reference. Reopen the form and retry.' });
    }
    const sheet = await getOrCreateSheet(INBOUND_SHEET, INBOUND_HEADERS);
    const rows = await withRetry(() => sheet.getRows());
    const duplicate = rows.find((row) => normalizeClientId(row.get('Client_ID')) === access.clientId
      && (row.get('Shipment_ID') === id || normalizeInboundTracking(row.get('Tracking_Number')) === shipment.trackingNumber));
    if (duplicate) {
      const saved = inboundFromRow(duplicate);
      if (saved.id === id && saved.carrier === shipment.carrier && saved.trackingNumber === shipment.trackingNumber
        && saved.expectedDeliveryDate === shipment.expectedDeliveryDate && JSON.stringify(saved.contents) === JSON.stringify(shipment.contents)) {
        return res.json({ success: true, clientId: access.clientId, shipment: saved, alreadySaved: true });
      }
      return res.status(409).json({ success: false, error: 'This tracking number or shipment reference is already logged. Refresh the inbound list before retrying.' });
    }
    const values = {
      Shipment_ID: id, Client_ID: access.clientId, Carrier: shipment.carrier, Tracking_Number: shipment.trackingNumber,
      Expected_Delivery_Date: shipment.expectedDeliveryDate, Contents_JSON: JSON.stringify(shipment.contents),
      Status: 'In Transit to Warehouse', Created_At: new Date().toISOString(), Created_By: access.session.username,
      Arrived_At: '', Arrived_By: ''
    };
    // A retry after an uncertain append must first re-read by shipment ID, not append a second box.
    await sheet.addRow(values, { raw: true });
    return res.status(201).json({ success: true, clientId: access.clientId, shipment: inboundFromRow({ get: (key) => values[key] }) });
  } catch (error) {
    console.error('Inbound shipment save failed:', error.message);
    return res.status(500).json({ success: false, error: 'Shipment save was not confirmed. Refresh the list or retry the same form before creating another notification.' });
  }
});

app.post('/api/inbound-shipments/check-in', async (req, res) => {
  if (!isStaffSession(readNotificationSession(req))) return res.status(403).json({ success: false, error: 'Only ECL staff can record inbound arrivals.' });
  try {
    const access = await inboundAccess(req, res);
    if (!access) return;
    const code = normalizeInboundTracking(req.body?.code);
    if (!/^[A-Z0-9]{4,100}$/.test(code)) return res.status(400).json({ success: false, error: 'Scan or enter a valid tracking number.' });
    const sheet = await findSheetByTitle(INBOUND_SHEET);
    const rows = sheet ? await withRetry(() => sheet.getRows()) : [];
    const matches = rows.filter((row) => normalizeClientId(row.get('Client_ID')) === access.clientId
      && normalizeInboundTracking(row.get('Tracking_Number')) === code);
    const selected = matches.filter((row) => !req.body?.shipmentId || row.get('Shipment_ID') === req.body.shipmentId);
    if (!selected.length) return res.status(404).json({ success: false, error: 'No matching inbound shipment in this account. Confirm the selected client and tracking number.' });
    if (selected.length > 1) return res.status(409).json({ success: false, error: 'Multiple shipments match this barcode. Use the arrival button on the correct shipment card.' });
    const row = selected[0];
    if (row.get('Arrived_At')) return res.json({ success: true, clientId: access.clientId, shipment: inboundFromRow(row), alreadyCheckedIn: true });
    row.set('Status', 'Arrived at Warehouse');
    row.set('Arrived_At', new Date().toISOString());
    row.set('Arrived_By', access.session.username);
    await withRetry(() => row.save({ raw: true }));
    return res.json({ success: true, clientId: access.clientId, shipment: inboundFromRow(row) });
  } catch (error) {
    console.error('Inbound shipment arrival failed:', error.message);
    return res.status(500).json({ success: false, error: 'Arrival was not confirmed. Refresh the inbound list before retrying. Stock quantities have not been changed.' });
  }
});

const inboundReceivingLocks = new Set();

app.post('/api/inbound-shipments/receive', async (req, res) => {
  if (!isStaffSession(readNotificationSession(req))) return res.status(403).json({ success: false, error: 'Only ECL staff can review received products.' });
  let lockedClient;
  try {
    const access = await inboundAccess(req, res);
    if (!access) return;
    if (inboundReceivingLocks.has(access.clientId)) return res.status(409).json({ success: false, error: 'Another receiving review is saving for this account. Refresh before retrying.' });
    lockedClient = access.clientId;
    inboundReceivingLocks.add(lockedClient);
    const inboundSheet = await getOrCreateSheet(INBOUND_SHEET, INBOUND_HEADERS);
    const inboundRows = await withRetry(() => inboundSheet.getRows());
    const inboundRow = inboundRows.find(row => row.get('Shipment_ID') === req.body?.shipmentId && normalizeClientId(row.get('Client_ID')) === access.clientId);
    if (!inboundRow) return res.status(404).json({ success: false, error: 'Shipment not found in this account.' });
    const shipment = inboundFromRow(inboundRow);
    const index = req.body?.lineIndex;
    if (!shipment.arrivedAt || !Number.isSafeInteger(index) || !shipment.contents[index]) return res.status(400).json({ success: false, error: 'Record arrival and select a valid product line first.' });
    let decision;
    try { decision = validateReceiving(req.body, shipment.contents[index]); }
    catch (error) { return res.status(400).json({ success: false, error: error.message }); }
    let receipt = shipment.receiving[index];
    if (receipt && JSON.stringify(receipt.decision) !== JSON.stringify(decision)) return res.status(409).json({ success: false, error: 'This product already has a receiving decision. Refresh; do not change an unconfirmed save.' });
    if (receipt?.state === 'complete') return res.json({ success: true, clientId: access.clientId, shipment, alreadyReceived: true });
    const profile = await getClientProfile(access.clientId);
    const sheet = await findSheetByTitle(access.clientId);
    if (!sheet) return res.status(404).json({ success: false, error: 'Inventory sheet not found.' });
    const rows = await loadSheetRows(access.clientId);
    const layout = await getItemEditColumns(access.clientId, rows);
    const shipmentColumns = await getShipmentColumns(access.clientId, rows);
    const quantityColumn = shipmentColumns?.received ?? layout.columns.qty;
    if (decision.received && quantityColumn === undefined) return res.status(400).json({ success: false, error: 'This account needs a stock or Quantity Received column before products can be received.' });
    const markerName = 'Inbound_Receiving_Log';
    let markerColumn = layout.catalog.headers.findIndex(value => String(value).trim() === markerName);
    if (markerColumn < 0) {
      markerColumn = layout.catalog.headers.length;
      layout.catalog.headers[markerColumn] = markerName;
    }
    const key = `${shipment.id}:${index}`;
    const logs = rows.map((row, i) => {
      if (i <= layout.catalog.headerRowIndex) return {};
      const log = JSON.parse(String(row[markerColumn] || '{}'));
      if (!log || typeof log !== 'object' || Array.isArray(log)) throw new Error('Invalid inventory receiving log. Contact an administrator.');
      return log;
    });
    // The receipt marker and stock change share one Sheets batch. A retry reads the marker
    // before applying stock again, including when the separate shipment-log save failed.
    const appliedRow = logs.findIndex(log => Object.prototype.hasOwnProperty.call(log, key));
    if (decision.received && appliedRow < 0) {
      let rowIndex = -1;
      if (decision.target !== 'new') {
        const items = await loadInventoryForClient(access.clientId, true);
        const item = items.find(item => item.id === decision.target);
        if (!item || item.title !== req.body?.targetTitle || item.sku !== req.body?.targetSku) return res.status(409).json({ success: false, error: 'The selected product changed. Refresh inventory and review again.' });
        if (layout.locate === 'sku') {
          const matches = rows.map((row, i) => ({ row, i })).filter(({ row, i }) => i > layout.catalog.headerRowIndex && String(row[layout.columns.sku] || '').trim() === item.sku && String(row[layout.columns.title] || '').trim() === item.title);
          if (matches.length === 1) rowIndex = matches[0].i;
        } else rowIndex = Number(item.id.slice(access.clientId.length + 1));
        if (rowIndex <= layout.catalog.headerRowIndex || !rows[rowIndex]) return res.status(409).json({ success: false, error: 'This product moved or has duplicate identifiers. Refresh and verify it.' });
      }
      const current = rowIndex < 0 ? 0 : Number(rows[rowIndex][quantityColumn] || 0);
      if (!Number.isSafeInteger(current) || current < 0 || !Number.isSafeInteger(current + decision.received)) return res.status(409).json({ success: false, error: 'Current quantity is invalid. Correct the sheet before receiving.' });
      if (!receipt) {
        receipt = { state: 'pending', decision, rowIndex, before: current, after: current + decision.received, by: access.session.username, at: new Date().toISOString() };
        shipment.receiving[index] = receipt;
        if (JSON.stringify(shipment.receiving).length > 44000) return res.status(400).json({ success: false, error: 'This shipment receiving log is too large. Shorten product URLs before saving.' });
        inboundRow.set('Receiving_JSON', JSON.stringify(shipment.receiving));
        await inboundRow.save({ raw: true });
      }
      if (receipt.rowIndex !== rowIndex || receipt.before !== current) return res.status(409).json({ success: false, error: 'Inventory changed during this receiving review. Contact an administrator to reconcile the pending receipt.' });
      const log = rowIndex < 0 ? {} : logs[rowIndex];
      log[key] = { ...decision, by: receipt.by, at: receipt.at };
      if (JSON.stringify(log).length > 45000) return res.status(409).json({ success: false, error: 'This product receiving log is full. Contact an administrator to archive it.' });
      await prepareCatalogHeaders(sheet, rows, layout.catalog, Math.max(0, rowIndex));
      if (rowIndex < 0) {
        const row = Array(layout.catalog.headers.length).fill('');
        const sku = decision.sku || `INBOUND-${shipment.id.slice(0, 8)}-${index + 1}`;
        if (profile.legacy && access.clientId === 'CL-001') row[0] = access.clientId;
        if (layout.columns.sku !== undefined) row[layout.columns.sku] = sku;
        if (layout.columns.upc !== undefined) row[layout.columns.upc] = sku;
        row[layout.columns[layout.titleKey]] = decision.productName;
        if (layout.columns.quantityOrdered !== undefined) row[layout.columns.quantityOrdered] = shipment.contents[index].quantity;
        row[quantityColumn] = receipt.after;
        if (!profile.legacy && profile.inventoryMode === 'custom') row[2 + profile.fields.length] = decision.received;
        if (shipmentColumns) row[shipmentColumns.shipped] = 0;
        row[layout.columns.status] = shipmentColumns ? 'Arrived / Check-In' : receipt.after <= 5 ? 'Low Stock' : 'In Stock';
        row[layout.columns.productUrl] = decision.productUrl;
        row[layout.columns.imageUrl] = decision.imageUrl;
        row[markerColumn] = JSON.stringify(log);
        await sheet.saveUpdatedCells();
        await sheet.loadHeaderRow(layout.catalog.headerRowIndex + 1);
        // No blind retry: an uncertain append is recovered by its receipt marker.
        await sheet.addRow(row, { raw: true });
      } else {
        sheet.getCell(rowIndex, quantityColumn).value = receipt.after;
        if (layout.columns.status !== undefined) {
          const shipped = shipmentColumns ? Number(rows[rowIndex][shipmentColumns.shipped] || 0) : 0;
          sheet.getCell(rowIndex, layout.columns.status).value = shipmentColumns
            ? shipmentStatus(rows[rowIndex][layout.columns.status], current, receipt.after, shipped)
            : receipt.after <= 5 ? 'Low Stock' : 'In Stock';
        }
        sheet.getCell(rowIndex, markerColumn).value = JSON.stringify(log);
        if (decision.productUrl) sheet.getCell(rowIndex, layout.columns.productUrl).value = decision.productUrl;
        if (decision.imageUrl) sheet.getCell(rowIndex, layout.columns.imageUrl).value = decision.imageUrl;
        await sheet.saveUpdatedCells();
      }
      invalidateReadCache('inventory:');
    }
    receipt = receipt || { decision, by: access.session.username, at: new Date().toISOString() };
    receipt.state = 'complete';
    shipment.receiving[index] = receipt;
    if (JSON.stringify(shipment.receiving).length > 45000) return res.status(400).json({ success: false, error: 'This shipment receiving log is too large. Shorten product URLs before saving.' });
    inboundRow.set('Receiving_JSON', JSON.stringify(shipment.receiving));
    await inboundRow.save({ raw: true });
    return res.json({ success: true, clientId: access.clientId, shipment: inboundFromRow(inboundRow) });
  } catch (error) {
    console.error('Inbound receiving failed:', error.message);
    return res.status(500).json({ success: false, error: 'Receiving save was not confirmed. Refresh and retry the same decision; do not add this quantity manually. Contact an administrator if a pending receipt conflicts.' });
  } finally {
    if (lockedClient) inboundReceivingLocks.delete(lockedClient);
  }
});

app.get('/api/tracking', async (req, res) => {
  const session = readNotificationSession(req);
  if (!session) return res.status(401).json({ message: 'Sign-in required.' });
  const clientId = normalizeClientId(req.query.clientId || session.clientId);
  if (!isStaffSession(session) && clientId !== normalizeClientId(session.clientId)) {
    return res.status(403).json({ message: 'You can only track items in your own account.' });
  }
  if (!/^CL-\d{3,}$/.test(clientId) || clientId === 'CL-000') {
    return res.status(400).json({ message: 'Select a client account to view tracking.' });
  }
  res.set('Cache-Control', 'no-store');
  try {
    if (!(await findSheetByTitle(clientId))) return res.status(404).json({ message: 'Inventory sheet not found for this account.' });
    const profile = await getClientProfile(clientId);
    const items = await loadInventoryForClient(clientId, true);
    const stages = { 'In Transit to Warehouse': 0, 'Arrived / Check-In': 1, 'Received & Verified': 1, 'In Prep': 2, 'Shipped out': 3 };
    return res.json({
      clientId,
      updatedAt: new Date().toISOString(),
      items: items.map((item) => ({
        id: item.id, sku: item.sku, title: item.title, status: item.status,
        stage: profile.inventoryMode === 'custom' ? stages[item.status] ?? null : null,
        checkInTimestamp: item.checkInTimestamp || '',
        trackingNumbers: item.trackingNumbers || [], prepInstructions: item.prepInstructions || ''
      }))
    });
  } catch (error) {
    console.error('Tracking fetch error:', error.message);
    return res.status(error?.response?.status === 429 ? 429 : 500).json({ message: 'Unable to load ECL tracking. Please retry.' });
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
  if (session.role === 'staff') return res.status(403).json({ message: 'Warehouse staff cannot access billing.' });
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
      const fields = parseFieldsJson(read(row, 'Fields_JSON')) ||
        (LEGACY_CLIENT_IDS.includes(clientId) ? (getClientInventoryFields(clientId).fields || []) : []);
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

const CHAT_HEADERS = ['Timestamp', 'Sender', 'Message', 'ClientID', 'IsStaff', 'FileUrl', 'FileName'];
const CHAT_ARCHIVE_SHEET = 'Chat_Archive';

// Moves chat messages older than the cutoff from Chat_log into Chat_Archive so chat loads stay small.
// Only the run of old messages at the top of Chat_log is moved, so newer rows are never touched.
async function archiveOldChatMessages({ olderThanDays = 30, apply = false, now = new Date() } = {}) {
  const sheet = await findSheetByTitle('Chat_log');
  if (!sheet) return { archived: 0, kept: 0 };
  const rows = await withRetry(() => sheet.getRows());
  const cutoff = now.getTime() - olderThanDays * 24 * 60 * 60 * 1000;
  let count = 0;
  for (const row of rows) {
    const time = Date.parse(row.get('Timestamp'));
    if (!Number.isFinite(time) || time >= cutoff) break;
    count += 1;
  }
  const report = { archived: count, kept: rows.length - count, cutoff: new Date(cutoff).toISOString() };
  if (!apply || !count) return report;
  if (rows[count - 1].rowNumber !== rows[0].rowNumber + count - 1) {
    throw new Error('Chat_log rows are not contiguous; nothing was archived.');
  }

  // Copy first and delete second, so a failure part-way can never lose messages.
  const archive = await getOrCreateSheet(CHAT_ARCHIVE_SHEET, CHAT_HEADERS);
  const copies = rows.slice(0, count).map((row) => CHAT_HEADERS.map((header) => row.get(header) ?? ''));
  for (let index = 0; index < copies.length; index += 500) {
    await withRetry(() => archive.addRows(copies.slice(index, index + 500)));
  }
  const startIndex = rows[0].rowNumber - 1;
  await withRetry(() => sheet._makeSingleUpdateRequest('deleteDimension', {
    range: { sheetId: sheet.sheetId, dimension: 'ROWS', startIndex, endIndex: startIndex + count }
  }));
  invalidateReadCache('rows:Chat_log');
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
  migrateClientSettings,
  archiveOldChatMessages
};
