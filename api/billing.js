// Pure billing math and rate-card mapping; sheet access lives in server.js.

const BILLING_RATE_HEADERS = ['Client_ID', 'Base_Fee', 'Order_Labor_Rate', 'Packaging_Multiplier', 'Minimum_Charge', 'Materials_JSON', 'Client_Visible', 'Updated_At'];
const BILLING_ENTRY_HEADERS = ['Timestamp', 'Client_ID', 'Month', 'Type', 'Item_Key', 'Quantity', 'Note', 'Entered_By'];
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

function money(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function nonNegative(value, fallback = 0) {
  if (value === null || value === undefined || String(value).trim() === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function slugify(label, index) {
  const key = String(label || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return key || `material-${index + 1}`;
}

function sanitizeMaterials(raw) {
  let list = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw);
    } catch (error) {
      list = [];
    }
  }
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list
    .map((material, index) => {
      const label = String(material?.label || '').trim().slice(0, 60);
      if (!label) return null;
      let key = String(material?.key || '').trim() || slugify(label, index);
      while (seen.has(key)) key = `${key}-${index + 1}`;
      seen.add(key);
      return { key, label, unitCost: money(nonNegative(material?.unitCost)) };
    })
    .filter(Boolean);
}

function sanitizeRateCard(input = {}) {
  return {
    baseFee: money(nonNegative(input.baseFee)),
    orderLaborRate: money(nonNegative(input.orderLaborRate)),
    packagingMultiplier: nonNegative(input.packagingMultiplier, 1),
    minimumCharge: money(nonNegative(input.minimumCharge)),
    materials: sanitizeMaterials(input.materials),
    clientVisible: input.clientVisible === true || ['true', 'yes', '1'].includes(String(input.clientVisible).trim().toLowerCase())
  };
}

function rateCardFromRow(row) {
  if (!row) return sanitizeRateCard({});
  return sanitizeRateCard({
    baseFee: row.get('Base_Fee'),
    orderLaborRate: row.get('Order_Labor_Rate'),
    packagingMultiplier: String(row.get('Packaging_Multiplier') ?? '').trim() === '' ? 1 : row.get('Packaging_Multiplier'),
    minimumCharge: row.get('Minimum_Charge'),
    materials: row.get('Materials_JSON'),
    clientVisible: row.get('Client_Visible')
  });
}

function currentMonth(now = new Date()) {
  return now.toISOString().slice(0, 7);
}

// Fraction of the month elapsed (UTC): 1 for past months, 0 for future months.
function monthProgress(month, now = new Date()) {
  const [year, monthIndex] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(year, monthIndex, 0)).getUTCDate();
  const current = currentMonth(now);
  if (month < current) return { daysInMonth, daysElapsed: daysInMonth, fraction: 1 };
  if (month > current) return { daysInMonth, daysElapsed: 0, fraction: 0 };
  const daysElapsed = now.getUTCDate();
  return { daysInMonth, daysElapsed, fraction: daysElapsed / daysInMonth };
}

function summarizeBilling({ rateCard, entries = [], month, now = new Date() }) {
  const card = sanitizeRateCard(rateCard);
  const monthEntries = entries.filter((entry) => entry.month === month);
  const orders = monthEntries.filter((entry) => entry.type === 'orders').reduce((sum, entry) => sum + entry.quantity, 0);
  const laborTotal = money(orders * card.orderLaborRate);

  const materialLines = card.materials.map((material) => {
    const quantity = monthEntries
      .filter((entry) => entry.type === 'material' && entry.itemKey === material.key)
      .reduce((sum, entry) => sum + entry.quantity, 0);
    return { key: material.key, label: material.label, quantity, unitCost: material.unitCost, total: money(quantity * material.unitCost * card.packagingMultiplier) };
  });
  const materialsTotal = money(materialLines.reduce((sum, line) => sum + line.total, 0));
  const usageTotal = money(laborTotal + materialsTotal);
  const monthToDate = money(Math.max(card.baseFee + usageTotal, card.minimumCharge));

  const progress = monthProgress(month, now);
  const projectedUsage = progress.fraction > 0 ? money(usageTotal / progress.fraction) : 0;
  const projectedTotal = money(Math.max(card.baseFee + projectedUsage, card.minimumCharge));

  return {
    month,
    rateCard: card,
    orders,
    lines: [
      { label: 'Monthly base fee', detail: '', total: card.baseFee },
      { label: 'Fulfillment labor', detail: `${orders} orders × $${card.orderLaborRate.toFixed(2)}`, total: laborTotal },
      ...materialLines.map((line) => ({
        label: line.label,
        detail: `${line.quantity} × $${line.unitCost.toFixed(2)}${card.packagingMultiplier !== 1 ? ` × ${card.packagingMultiplier}` : ''}`,
        total: line.total
      }))
    ],
    totals: {
      usage: usageTotal,
      minimumAdjustment: money(Math.max(0, card.minimumCharge - (card.baseFee + usageTotal))),
      monthToDate,
      projected: projectedTotal
    },
    progress
  };
}

module.exports = {
  BILLING_RATE_HEADERS,
  BILLING_ENTRY_HEADERS,
  MONTH_PATTERN,
  sanitizeRateCard,
  rateCardFromRow,
  currentMonth,
  summarizeBilling
};
