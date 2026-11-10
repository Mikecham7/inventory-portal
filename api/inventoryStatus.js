const FULFILLMENT_STATUSES = [
  'In Transit to Warehouse', 'Arrived / Check-In', 'Received & Verified', 'In Prep', 'Shipped out'
];
const STOCK_STATUSES = ['In Stock', 'Low Stock', 'Out of Stock'];

function fulfillmentStatus(status, received = 0, shipped = 0) {
  const saved = String(status || '').trim();
  if (Number(shipped) > 0 && Number(shipped) >= Number(received)) return 'Shipped out';
  if (/^(shipped|fully shipped|delivered|shipped out)$/i.test(saved)) return 'Shipped out';
  if (/^arrived at warehouse$/i.test(saved)) return FULFILLMENT_STATUSES[1];
  if (FULFILLMENT_STATUSES.includes(saved)) return saved;
  return Number(received) > 0 ? FULFILLMENT_STATUSES[1] : FULFILLMENT_STATUSES[0];
}

function shipmentStatus(status, previousReceived, received, shipped) {
  if (Number(shipped) > 0 && Number(shipped) >= Number(received)) return 'Shipped out';
  if (Number(previousReceived) === 0 && Number(received) > 0) return 'Arrived / Check-In';
  return fulfillmentStatus(/^(shipped|fully shipped|delivered|shipped out)$/i.test(String(status || '').trim()) ? '' : status, received, shipped);
}

module.exports = { FULFILLMENT_STATUSES, STOCK_STATUSES, fulfillmentStatus, shipmentStatus };
