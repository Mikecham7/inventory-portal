const INBOUND_SHEET = 'Inbound_Shipments';
const INBOUND_HEADERS = [
  'Shipment_ID', 'Client_ID', 'Carrier', 'Tracking_Number', 'Expected_Delivery_Date',
  'Contents_JSON', 'Status', 'Created_At', 'Created_By', 'Arrived_At', 'Arrived_By', 'Receiving_JSON'
];
const INBOUND_CARRIERS = ['UPS', 'FedEx', 'USPS', 'DHL', 'Other'];

function normalizeInboundTracking(value) {
  return String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '');
}

function validateInboundShipment(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Shipment details are required.');
  if (!INBOUND_CARRIERS.includes(input.carrier)) throw new Error('Choose a carrier.');
  if (typeof input.trackingNumber !== 'string' || input.trackingNumber.length > 200) throw new Error('Enter a tracking number (maximum 200 characters).');
  const trackingNumber = normalizeInboundTracking(input.trackingNumber);
  if (!/^[A-Z0-9]{4,100}$/.test(trackingNumber)) throw new Error('Enter a tracking number with 4-100 letters or digits.');
  const date = input.expectedDeliveryDate;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))
    || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new Error('Enter a valid expected delivery date.');
  }
  if (!Array.isArray(input.contents) || !input.contents.length || input.contents.length > 50) throw new Error('Add between 1 and 50 product lines.');
  const seen = new Set();
  const contents = input.contents.map((line) => {
    const sku = typeof line?.sku === 'string' ? line.sku.trim() : '';
    const productName = typeof line?.productName === 'string' ? line.productName.trim() : '';
    if ((!sku && !productName) || sku.length > 100 || productName.length > 500 || /[\u0000-\u001f]/.test(sku + productName)) throw new Error('Every contents line needs a product name (maximum 500 characters). SKU is optional.');
    const identity = sku ? `sku:${sku.toUpperCase()}` : `name:${productName.toUpperCase()}`;
    if (seen.has(identity)) throw new Error('Combine duplicate products into one contents line.');
    seen.add(identity);
    const productUrl = validateProductUrl(line?.productUrl);
    const quantity = line.quantity;
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000000) throw new Error('Expected quantities must be whole numbers from 1 to 1,000,000.');
    return { sku, quantity, ...(productName ? { productName } : {}), ...(productUrl ? { productUrl } : {}) };
  });
  return { carrier: input.carrier, trackingNumber, expectedDeliveryDate: date, contents };
}

function inboundFromRow(row) {
  const contents = JSON.parse(String(row.get('Contents_JSON') || '[]'));
  const valid = validateInboundShipment({
    carrier: row.get('Carrier'), trackingNumber: row.get('Tracking_Number'),
    expectedDeliveryDate: row.get('Expected_Delivery_Date'), contents
  });
  const arrivedAt = String(row.get('Arrived_At') || '');
  const receiving = JSON.parse(String(row.get('Receiving_JSON') || '{}'));
  if (!receiving || typeof receiving !== 'object' || Array.isArray(receiving)) throw new Error('Invalid receiving log. Contact an administrator.');
  return {
    id: String(row.get('Shipment_ID') || ''), clientId: String(row.get('Client_ID') || ''),
    ...valid, status: arrivedAt ? 'Arrived at Warehouse' : 'In Transit to Warehouse',
    createdAt: String(row.get('Created_At') || ''), createdBy: String(row.get('Created_By') || ''),
    arrivedAt, arrivedBy: String(row.get('Arrived_By') || ''), receiving
  };
}

function validateProductUrl(raw) {
  if (raw == null || raw === '') return '';
  if (typeof raw !== 'string' || raw.length > 2000) throw new Error('Product URL must be a public HTTP or HTTPS address (maximum 2000 characters).');
  let url;
  try { url = new URL(raw); } catch { throw new Error('Enter a valid product URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Product URL must use HTTP or HTTPS without credentials.');
  return url.href;
}

function validateReceiving(input, line) {
  const quantities = ['received', 'lost', 'damaged'].map(key => input[key]);
  if (!quantities.every(value => Number.isSafeInteger(value) && value >= 0)
    || quantities.reduce((sum, value) => sum + value, 0) !== line.quantity) {
    throw new Error('Received, lost and damaged must be whole numbers totaling the expected quantity.');
  }
  const title = typeof input.productName === 'string' ? input.productName.trim() : '';
  const sku = typeof input.sku === 'string' ? input.sku.trim() : '';
  if (!title || title.length > 500 || sku.length > 100 || /[\u0000-\u001f]/.test(title + sku)) throw new Error('Enter a product name and an optional SKU.');
  if (input.received > 0 && input.target !== 'new' && (typeof input.target !== 'string' || !input.target)) throw new Error('Select an existing product or create a new inventory line.');
  return {
    received: input.received, lost: input.lost, damaged: input.damaged,
    target: input.received ? input.target : '', productName: title, sku,
    productUrl: validateProductUrl(input.productUrl),
    imageUrl: validateProductUrl(input.imageUrl)
  };
}

module.exports = { INBOUND_SHEET, INBOUND_HEADERS, normalizeInboundTracking, validateInboundShipment, inboundFromRow, validateProductUrl, validateReceiving };
