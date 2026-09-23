const express = require('express');
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { normalizeInventoryRow, getSheetNameForClient, isAdminClient, getChatSenderRole, getClientInventoryFields, getDashboardColumns, getCreateFormTitleConfig, getChatDriveFolderForClient } = require('./portalLogic');

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
  if (!hash) return false;
  return bcrypt.compare(String(value ?? ''), String(hash));
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

    const headersMatch = headers.length === currentHeaders.length
      && headers.every((header, index) => String(currentHeaders[index] || '').trim().toLowerCase() === String(header).trim().toLowerCase());

    if (!headersMatch) {
      await withRetry(() => sheet.setHeaderRow(headers));
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
  'Activation_Code', 'Recovery_Code_Hash'
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
        ...(options ? { options } : {})
      };
    })
    .filter(Boolean);
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
async function getClientProfile(clientId) {
  const safeClientId = normalizeClientId(clientId) || 'CL-001';

  if (LEGACY_CLIENT_IDS.includes(safeClientId) || safeClientId === 'CL-000') {
    const configClientId = safeClientId === 'CL-000' ? 'CL-001' : safeClientId;
    const inventoryConfig = getClientInventoryFields(configClientId);
    const titleConfig = getCreateFormTitleConfig(configClientId);
    return {
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
      // fields, so the generic QTY/EDIT quick-adjust columns would be redundant there.
      hideQtyColumn: configClientId === 'CL-002',
      hideQuickEdit: configClientId === 'CL-002',
      driveFolderUrl: getChatDriveFolderForClient(configClientId),
      titleField: titleConfig,
      fields: inventoryConfig.fields || [],
      dashboardColumns: getDashboardColumns(configClientId),
      dashboardFieldKeys: LEGACY_DASHBOARD_FIELD_KEYS[configClientId] || []
    };
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

  try {
    const sheet = await getSheetByName('User_Credentials');
    const rows = await withRetry(() => sheet.getRows());
    const row = rows.find((entry) => normalizeClientId(entry.get('Client_ID') || entry.get('clientId')) === safeClientId);

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

  profile.dashboardColumns = [
    'PRODUCT TITLE',
    ...profile.fields.map((field) => String(field.label || field.key).toUpperCase()),
    ...(profile.hideQtyColumn ? [] : ['QTY']),
    'STATUS',
    ...(profile.readOnly || profile.hideQuickEdit ? [] : ['EDIT'])
  ];
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

async function listInventoryForClient(targetClientId) {
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
    console.warn(`Inventory sheet ${sheetName} did not load:`, error.message);
    return [];
  }
}

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.get('/api/clients', async (req, res) => {
  try {
    const roster = await getClientRoster();
    // Never leak password hashes (or legacy plain-text passwords) to the client.
    const publicRoster = roster.map(({ password, ...rest }) => rest);
    return res.json(publicRoster);
  } catch (error) {
    console.error('Client roster error:', error);
    return res.status(500).json({ message: 'Unable to fetch client roster.' });
  }
});

app.get('/api/client-profile', async (req, res) => {
  try {
    const clientId = normalizeClientId(req.query.clientId || 'CL-001');
    const profile = await getClientProfile(clientId);
    return res.json(profile);
  } catch (error) {
    console.error('Client profile error:', error);
    return res.status(500).json({ message: 'Unable to fetch client profile.' });
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

    const roster = await getClientRoster();
    if (roster.some((entry) => entry.clientId === clientId)) {
      return res.status(409).json({ success: false, error: `${clientId} already exists.` });
    }
    if (roster.some((entry) => entry.username.toLowerCase() === username.toLowerCase())) {
      return res.status(409).json({ success: false, error: `Username "${username}" is already taken.` });
    }

    const fields = sanitizeFieldDefs(body.fields);
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
      Drive_Folder_URL: String(body.driveFolderUrl || '').trim(),
      Read_Only: body.readOnly === true ? 'true' : 'false',
      Require_Pin: body.requirePin === true ? 'true' : 'false',
      Title_Field_Label: String(body.titleFieldLabel || '').trim(),
      Title_Field_Placeholder: String(body.titleFieldPlaceholder || '').trim(),
      Fields_JSON: JSON.stringify(fields),
      Activation_Code: activationCode,
      Recovery_Code_Hash: ''
    }));

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
    if (LEGACY_CLIENT_IDS.includes(clientId) || clientId === 'CL-000') {
      return res.status(400).json({ success: false, error: "This client's layout is built into the app and can't be edited here." });
    }

    const credentialsSheet = await getOrCreateSheet('User_Credentials', USER_CREDENTIALS_HEADERS);
    const rows = await withRetry(() => credentialsSheet.getRows());
    const row = rows.find((entry) => normalizeClientId(entry.get('Client_ID')) === clientId);
    if (!row) {
      return res.status(404).json({ success: false, error: `${clientId} was not found.` });
    }

    const body = req.body || {};

    // Account-reset-only requests must never fall through to the field/settings sync
    // below (an empty/omitted `fields` array there would wipe out the client's columns).
    if (body.resetAccount === true && body.fields === undefined) {
      const newActivationCode = `${generateCode(4)}-${generateCode(4)}`;
      row.set('Password', '');
      row.set('Recovery_Code_Hash', '');
      row.set('Activation_Code', newActivationCode);
      await withRetry(() => row.save());
      const profile = await getClientProfile(clientId);
      return res.json({ success: true, profile, activationCode: newActivationCode });
    }

    const oldFields = parseFieldsJson(row.get('Fields_JSON')) || [];
    const submittedFields = sanitizeFieldDefs(body.fields);
    const submittedKeys = submittedFields.map((field) => field.key);

    // Keep existing fields in their original column order (renames only change the label);
    // anything brand new is appended at the end. This guarantees the header row we write
    // always lines up with the sheet's actual column order, regardless of what order the
    // fields arrived in from the client.
    const orderedFields = oldFields
      .filter((field) => submittedKeys.includes(field.key))
      .map((field) => submittedFields.find((updated) => updated.key === field.key) || field)
      .concat(submittedFields.filter((field) => !oldFields.some((old) => old.key === field.key)));

    const titleLabel = String(body.titleFieldLabel || row.get('Title_Field_Label') || '').trim() || 'Product Title';
    const inventorySheet = await getSheetByName(clientId);
    await withRetry(() => inventorySheet.loadHeaderRow());
    await syncClientFieldColumns(inventorySheet, oldFields, orderedFields, titleLabel);

    row.set('Client_Name', String(body.clientName || row.get('Client_Name') || clientId).trim());
    row.set('Portal_Title', String(body.portalTitle ?? row.get('Portal_Title') ?? '').trim());
    row.set('Portal_Subtitle', String(body.portalSubtitle ?? row.get('Portal_Subtitle') ?? '').trim());
    row.set('Accent_Color', String(body.accentColor ?? row.get('Accent_Color') ?? '').trim());
    row.set('Drive_Folder_URL', String(body.driveFolderUrl ?? row.get('Drive_Folder_URL') ?? '').trim());
    row.set('Enable_Add_Item', body.enableAddItem === false ? 'false' : 'true');
    row.set('Allow_Chat', body.allowChat === false ? 'false' : 'true');
    row.set('Allow_Logs', body.allowLogs === false ? 'false' : 'true');
    row.set('Allow_Update', body.allowUpdate === false ? 'false' : 'true');
    row.set('Read_Only', body.readOnly === true ? 'true' : 'false');
    row.set('Require_Pin', body.requirePin === true ? 'true' : 'false');
    row.set('Title_Field_Label', titleLabel);
    row.set('Title_Field_Placeholder', String(body.titleFieldPlaceholder ?? row.get('Title_Field_Placeholder') ?? '').trim());
    row.set('Fields_JSON', JSON.stringify(orderedFields));

    // Deactivates the account and issues a fresh activation code — for when a client is
    // locked out and has lost/never received their recovery code.
    let newActivationCode;
    if (body.resetAccount === true) {
      newActivationCode = `${generateCode(4)}-${generateCode(4)}`;
      row.set('Password', '');
      row.set('Recovery_Code_Hash', '');
      row.set('Activation_Code', newActivationCode);
    }

    await withRetry(() => row.save());

    const profile = await getClientProfile(clientId);
    return res.json({ success: true, profile, ...(newActivationCode ? { activationCode: newActivationCode } : {}) });
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

    return res.json({ success: true });
  } catch (error) {
    console.error('Delete client error:', error);
    return res.status(500).json({ success: false, error: 'Unable to delete client.' });
  }
});

app.get('/api/chat', async (req, res) => {
  try {
    const clientId = normalizeClientId(req.query.clientId || 'CL-001');
    const sheet = await getOrCreateSheet('Chat_log', ['Timestamp', 'Sender', 'Message', 'ClientID', 'IsStaff', 'FileUrl', 'FileName']);
    const rows = await withRetry(() => sheet.getRows());
    const history = rows
      .filter((row) => {
        const rowClientId = normalizeClientId(row.get('ClientID') || row.get('clientId') || row.get('Client_ID') || '');
        if (!clientId || clientId === 'CL-000') return true;
        return rowClientId === clientId;
      })
      .map((row) => ({
        timestamp: row.get('Timestamp') || row.get('timestamp') || '',
        sender: row.get('Sender') || row.get('sender') || 'Unknown',
        message: row.get('Message') || row.get('message') || '',
        clientId: normalizeClientId(row.get('ClientID') || row.get('clientId') || row.get('Client_ID') || clientId) || clientId,
        isStaff: String(row.get('IsStaff') || row.get('isStaff') || '0').trim() === '1',
        fileUrl: row.get('FileUrl') || row.get('fileUrl') || '',
        fileName: row.get('FileName') || row.get('fileName') || ''
      }));

    return res.json(history);
  } catch (error) {
    console.error('Chat fetch error:', error);
    return res.status(500).json({ message: 'Unable to fetch chat history.' });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const { clientId, sender, message, isStaff, fileUrl, fileName } = req.body || {};
    const normalizedClientId = normalizeClientId(clientId);
    if (!normalizedClientId || !sender || !message) {
      return res.status(400).json({ success: false, error: 'Client, sender, and message are required.' });
    }

    const sheet = await getOrCreateSheet('Chat_log', ['Timestamp', 'Sender', 'Message', 'ClientID', 'IsStaff', 'FileUrl', 'FileName']);
    const safeFileUrl = String(fileUrl || '').trim();
    const safeFileName = String(fileName || '').trim() || (safeFileUrl ? 'Shared file' : '');
    await withRetry(() => sheet.addRow([new Date().toISOString(), sender, message, normalizedClientId, Boolean(isStaff) ? '1' : '0', safeFileUrl, safeFileName]));

    return res.json({
      success: true,
      role: getChatSenderRole(Boolean(isStaff)),
      message: {
        sender,
        clientId: normalizedClientId,
        message,
        isStaff: Boolean(isStaff),
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
    const { clientId, sku, title, qty, status, notes, extraFields = {}, isAdmin } = req.body || {};
    const targetClientId = String(clientId || 'CL-001').trim() || 'CL-001';
    const itemSku = String(sku || '').trim();
    const itemTitle = String(title || '').trim();
    const values = extraFields && typeof extraFields === 'object' ? extraFields : {};
    const adminAccess = Boolean(isAdmin) || String(req.body?.role || '').toLowerCase() === 'admin';

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
      row = [
        itemSku || itemTitle || 'N/A',
        itemTitle || itemSku || 'Untitled',
        ...profile.fields.map((field) => String(values[field.key] ?? '')),
        Number(qty) || 0,
        String(status || (Number(qty) <= 5 ? 'Low Stock' : 'In Stock')),
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
    return res.json({ success: true, sheet: sheetName, item: row });
  } catch (error) {
    console.error('Inventory create error:', error);
    return res.status(500).json({ success: false, error: 'Unable to create inventory item.' });
  }
});

app.post('/api/login', async (req, res) => {
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
      passwordOk = storedPassword === String(password || '');
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
      role
    });
  } catch (error) {
    console.error('Google Sheets login error:', error);
    const message = error.message && error.message.includes('Missing Google Sheets environment variables')
      ? 'Google Sheets configuration is missing or invalid. Update the .env values for GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, and GOOGLE_SHEET_ID.'
      : 'Server error connecting to database';
    return res.status(500).json({ success: false, error: message });
  }
});

app.post('/api/account/activate', async (req, res) => {
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
    const codeOk = Boolean(storedCode) && storedCode.toUpperCase() === activationCode.trim().toUpperCase();
    if (!codeOk) return invalid();

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

app.post('/api/account/recover', async (req, res) => {
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
    const codeOk = await verifySecret(recoveryCode, user.get('Recovery_Code_Hash'));
    if (!codeOk) return invalid();

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

app.get('/api/inventory', async (req, res) => {
  try {
    const clientId = String(req.query.clientId || '').trim();

    if (clientId && clientId.toUpperCase() === 'CL-000') {
      const roster = await getClientRoster();
      const inventory = [];
      for (const client of roster) {
        const items = await listInventoryForClient(client.clientId || 'CL-001');
        inventory.push(...items);
      }
      return res.json(inventory);
    }

    const targetClientId = clientId || 'CL-001';
    const items = await listInventoryForClient(targetClientId);
    return res.json(items);
  } catch (error) {
    console.error('Error fetching inventory:', error.message);
    const message = error.message && error.message.includes('Missing Google Sheets environment variables')
      ? 'Google Sheets configuration is missing or invalid. Update the .env values for GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, and GOOGLE_SHEET_ID.'
      : 'Unable to fetch inventory items.';
    res.status(500).json({ message });
  }
});

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
  listInventoryForClient
};
