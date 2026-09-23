function normalizeInventoryRow(rawRow = {}, fallbackClientId = '') {
  const source = rawRow && typeof rawRow === 'object' ? rawRow : {};
  const rowValues = Array.isArray(rawRow) ? rawRow : [];

  const maybeStatus = rowValues[4] ?? source.status ?? '';
  const cleanedStatus = String(maybeStatus || '')
    .split(' | ')[0]
    .split(' [')[0]
    .trim();

  const itemName = source.itemName ?? source.title ?? source.productName ?? source.product ?? source.name ?? rowValues[2] ?? rowValues[1] ?? '';
  const sku = source.sku ?? source.itemSku ?? source.code ?? source.productCode ?? rowValues[1] ?? '';
  const category = source.category ?? source.subCategory ?? source.type ?? '';
  const rawQuantity = source.quantity ?? source.qty ?? source.onHand ?? source.stock ?? rowValues[3] ?? 0;
  const normalizedQty = (() => {
    if (rawQuantity === null || rawQuantity === undefined || rawQuantity === '') return 0;
    if (typeof rawQuantity === 'string') {
      const clean = rawQuantity.replace(/[^0-9.-]/g, '');
      const num = Number(clean);
      return Number.isFinite(num) ? num : 0;
    }
    return Number(rawQuantity) || 0;
  })();

  const quantity = Number.isFinite(normalizedQty) ? normalizedQty : 0;
  const reorderLevel = Number(source.reorderLevel ?? source.lowStock ?? source.minQty ?? 5);
  const location = source.location ?? source.storage ?? source.area ?? rowValues[0] ?? 'unknown';
  const status = source.status ?? ((cleanedStatus || (quantity <= reorderLevel ? 'Low Stock' : 'In Stock')));

  return {
    id: String(source.id ?? `${sku || itemName || 'item'}-${String(location || fallbackClientId || 'inventory').trim()}`),
    clientId: String(source.clientId || rowValues[0] || fallbackClientId || '').trim(),
    sku: String(sku || 'N/A').trim(),
    title: String(itemName || source.item || 'Untitled').trim(),
    itemName: String(itemName || source.item || 'Untitled').trim(),
    qty: Number.isFinite(quantity) ? quantity : 0,
    quantity: Number.isFinite(quantity) ? quantity : 0,
    reorderLevel: Number.isFinite(reorderLevel) ? reorderLevel : 0,
    category: String(category || '').trim(),
    location: String(location || '').trim(),
    status: String(status || 'In Stock'),
    lastUpdated: source.lastUpdated || new Date().toISOString()
  };
}

const CLIENT_DRIVE_FOLDERS = {
  'CL-001': 'https://drive.google.com/drive/folders/12kLeOKbQ2A_siusOder-4qzF8xMwNyU1?usp=drive_link',
  'CL-002': 'https://drive.google.com/drive/folders/14OQQ-PJWjOPf_jW_QhWne7iB-q8l-60k?usp=drive_link',
  'CL-003': 'https://drive.google.com/drive/folders/19iAZ6O_akxRqMtuSYE11GMifz3yNMrav?usp=drive_link'
};

const CLIENT_INVENTORY_FIELDS = {
  'CL-001': {
    label: 'Metal Garden Markers',
    readOnly: true,
    requirePin: true,
    fields: []
  },
  'CL-002': {
    label: 'Ecom Elite 2.0',
    readOnly: false,
    requirePin: false,
    fields: [
      { key: 'upc', label: 'UPC', type: 'text' },
      { key: 'productDescription', label: 'Product Description', type: 'textarea' },
      { key: 'quantityOrdered', label: 'Quantity Ordered', type: 'number' },
      { key: 'quantityReceived', label: 'Quantity Received', type: 'number', readOnly: true },
      { key: 'quantityShipped', label: 'Quantity Shipped', type: 'number', readOnly: true },
      { key: 'expDate', label: 'Exp Date', type: 'text' },
      { key: 'merchant', label: 'Merchant', type: 'text' },
      { key: 'asin', label: 'ASIN #', type: 'text' },
      { key: 'fulfillment', label: 'FBM / FBA', type: 'select', options: ['', 'FBA', 'FBM'] },
      { key: 'transparencyCode', label: 'Transparency Code (Y/N)', type: 'text' },
      { key: 'bundled', label: 'Bundled? (Y/N)', type: 'text' },
      { key: 'bundleQty', label: 'Bundle Quantity', type: 'number' },
      { key: 'notes', label: 'Notes', type: 'textarea' }
    ]
  },
  'CL-003': {
    label: 'CJA Ventures',
    readOnly: false,
    requirePin: false,
    fields: [
      { key: 'productName', label: 'Product Description / Name', type: 'text' },
      { key: 'quantityOrdered', label: 'Quantity Ordered', type: 'number' },
      { key: 'merchant', label: 'Merchant', type: 'text' },
      { key: 'carrier', label: 'Carrier', type: 'select', options: ['', 'UPS', 'USPS', 'FedEx'] },
      { key: 'trackingNumber', label: 'Tracking #', type: 'text' },
      { key: 'quantityReceived', label: 'Quantity Received', type: 'number', readOnly: true },
      { key: 'quantityShipped', label: 'Quantity Shipped', type: 'number', readOnly: true },
      { key: 'notes', label: 'Notes', type: 'textarea' }
    ]
  }
};

function getVisibleClientFields(clientId, isAdmin = false) {
  const config = getClientInventoryFields(clientId);
  return (config.fields || []).filter((field) => !field.adminOnly || Boolean(isAdmin));
}

function getShipmentStatus(item = {}) {
  const clientId = String(item.clientId || '').trim().toUpperCase();
  if (!['CL-002', 'CL-003'].includes(clientId)) {
    const statusText = String(item.status || '').trim().toLowerCase();
    if (statusText.includes('fully shipped')) return 'fully';
    if (statusText.includes('partially shipped')) return 'partial';
    if (statusText.includes('not shipped')) return 'not';
    return 'in';
  }

  const ordered = Number(String(item.quantityOrdered ?? item.ordered ?? item.quantity ?? '').replace(/[^0-9.-]/g, '')) || 0;
  const shipped = Number(String(item.quantityShipped ?? item.shipped ?? '').replace(/[^0-9.-]/g, '')) || 0;

  if (shipped <= 0) return 'not';
  if (ordered > 0 && shipped < ordered) return 'partial';
  return 'fully';
}

function getDashboardColumns(clientId) {
  const safeClientId = String(clientId || '').trim().toUpperCase();
  const columns = ['PRODUCT TITLE'];
  if (safeClientId === 'CL-002') {
    columns.push(
      'ASIN #',
      'QUANTITY ORDERED',
      'QUANTITY RECEIVED',
      'QUANTITY SHIPPED',
      'EXP DATE',
      'MERCHANT',
      'FBM/FBA',
      'TRANSPARENCY CODE',
      'BUNDLED?',
      'BUNDLE QUANTITY',
      'NOTES'
    );
  }
  columns.push('QTY', 'STATUS', 'EDIT');
  return columns;
}

function getCreateFormTitleConfig(clientId) {
  const safeClientId = String(clientId || '').trim().toUpperCase();
  const isCardClient = safeClientId === 'CL-003';

  return {
    visible: !isCardClient,
    label: isCardClient ? 'Product Name' : 'Product Title',
    placeholder: isCardClient ? 'Pokémon - Charizard' : 'Copper Marker'
  };
}

function getClientInventoryFields(clientId) {
  const safeClientId = String(clientId || '').trim().toUpperCase();
  return CLIENT_INVENTORY_FIELDS[safeClientId] || {
    label: 'Client',
    readOnly: true,
    requirePin: true,
    fields: []
  };
}

function getChatDriveFolderForClient(clientId) {
  const safeClientId = String(clientId || '').trim().toUpperCase();
  return CLIENT_DRIVE_FOLDERS[safeClientId] || CLIENT_DRIVE_FOLDERS['CL-001'];
}

const INVENTORY_FIELD_ALIASES = {
  sku: ['sku', 'itemSku', 'code', 'upc'],
  title: ['title', 'itemName', 'productName', 'product', 'name'],
  productName: ['productName', 'itemName', 'title', 'name'],
  productDescription: ['productDescription', 'description', 'title', 'itemName'],
  quantityOrdered: ['quantityOrdered', 'ordered', 'quantity', 'qty'],
  quantityReceived: ['quantityReceived', 'received', 'quantity', 'qty'],
  quantityShipped: ['quantityShipped', 'shipped', 'quantity', 'qty'],
  merchant: ['merchant', 'supplier', 'vendor'],
  asin: ['asin', 'ASIN'],
  upc: ['upc', 'UPC', 'sku'],
  carrier: ['carrier', 'shippingCarrier'],
  trackingNumber: ['trackingNumber', 'tracking', 'tracking #'],
  notes: ['notes', 'comment', 'description'],
  fulfillment: ['fulfillment', 'fbmFba', 'shipping'],
  transparencyCode: ['transparencyCode', 'transparency'],
  bundled: ['bundled', 'bundle'],
  bundleQty: ['bundleQty', 'bundleQuantity']
};

function getInventoryFieldSample(items = [], fieldKey = '') {
  const cleanKey = String(fieldKey || '').trim();
  if (!cleanKey || !Array.isArray(items)) return '';

  const aliases = INVENTORY_FIELD_ALIASES[cleanKey] || [cleanKey];
  for (const item of items) {
    for (const alias of aliases) {
      const value = item && item[alias];
      if (value !== undefined && value !== null && String(value).trim()) {
        return String(value).trim();
      }
    }
  }

  return '';
}

function getClientFieldPlaceholder(items = [], field = {}) {
  const sample = getInventoryFieldSample(items, field && field.key);
  if (!sample) return field && field.label ? field.label : 'Enter value';
  if (field && field.type === 'number') return String(sample);
  return `e.g. ${sample}`;
}

function getSheetNameForClient(clientId) {
  const id = String(clientId || '').trim().toUpperCase();
  if (!id || id === 'CL-000') return 'CL-001';
  return id;
}

function isAdminClient(clientId) {
  return String(clientId || '').trim().toUpperCase() === 'CL-000';
}

function getChatSenderRole(isStaff) {
  return Boolean(isStaff) ? 'staff' : 'client';
}

module.exports = {
  normalizeInventoryRow,
  getSheetNameForClient,
  isAdminClient,
  getChatSenderRole,
  getClientInventoryFields,
  getVisibleClientFields,
  getDashboardColumns,
  getShipmentStatus,
  getCreateFormTitleConfig,
  getChatDriveFolderForClient,
  getInventoryFieldSample,
  getClientFieldPlaceholder
};
