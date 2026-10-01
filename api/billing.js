// Pure billing logic: invoice-style line items built from per-client service rate cards.

const RATE_SHEET = 'Billing_Rate_Cards';
const ENTRY_SHEET = 'Billing_Line_Items';
const BILLING_RATE_HEADERS = ['Client_ID', 'Services_JSON', 'Tax_Rate', 'Client_Visible', 'Updated_At'];
const BILLING_ENTRY_HEADERS = ['Entry_ID', 'Client_ID', 'Date', 'Service_Key', 'Service_Name', 'Description', 'Unit_Price', 'Quantity', 'Flat_Charge', 'Note', 'Entered_By', 'Updated_At'];
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_AMOUNT = 1000000;

function money(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

function isValidDate(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

function slugify(text, index) {
  const key = String(text || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return key || `service-${index + 1}`;
}

function sanitizeServices(raw) {
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
    .map((service, index) => {
      const name = String(service?.name || '').trim().slice(0, 80);
      if (!name) return null;
      const unitPrice = Number(service?.unitPrice);
      const description = String(service?.description || '').trim().slice(0, 200);
      // Same service name can carry different rates (e.g. "Bundling" vs oversized bundling), so the key includes the description.
      let key = String(service?.key || '').trim() || slugify(`${name} ${description}`, index);
      while (seen.has(key)) key = `${key}-${index + 1}`;
      seen.add(key);
      return { key, name, unitPrice: Number.isFinite(unitPrice) && unitPrice >= 0 ? money(unitPrice) : 0, description };
    })
    .filter(Boolean);
}

function sanitizeRateCard(input = {}) {
  const taxRate = Number(input.taxRate);
  return {
    services: sanitizeServices(input.services),
    taxRate: !isBlank(input.taxRate) && Number.isFinite(taxRate) && taxRate >= 0 && taxRate <= 100 ? taxRate : 0,
    clientVisible: input.clientVisible === true || ['true', 'yes', '1'].includes(String(input.clientVisible).trim().toLowerCase())
  };
}

function rateCardFromRow(row) {
  if (!row) return sanitizeRateCard({});
  return sanitizeRateCard({ services: row.get('Services_JSON'), taxRate: row.get('Tax_Rate'), clientVisible: row.get('Client_Visible') });
}

function entryFromRow(row) {
  return {
    id: String(row.get('Entry_ID') || ''),
    date: String(row.get('Date') || ''),
    serviceKey: String(row.get('Service_Key') || ''),
    name: String(row.get('Service_Name') || ''),
    description: String(row.get('Description') || ''),
    unitPrice: money(row.get('Unit_Price')),
    quantity: Number(row.get('Quantity')) || 0,
    flat: String(row.get('Flat_Charge')).trim().toLowerCase() === 'true',
    note: String(row.get('Note') || ''),
    enteredBy: String(row.get('Entered_By') || ''),
    updatedAt: String(row.get('Updated_At') || '')
  };
}

// Validates one day's line item. `existing` lets edits keep a service that was later removed from the rate card.
function sanitizeEntry(input = {}, rateCard = { services: [] }, existing = null) {
  const date = String(input.date ?? existing?.date ?? '').trim();
  if (!isValidDate(date)) return { error: 'Choose a valid date.' };
  const note = String(input.note ?? existing?.note ?? '').trim().slice(0, 200);
  const flat = existing ? existing.flat : input.flatCharge === true;

  if (flat) {
    const name = String(input.name ?? existing?.name ?? '').trim().slice(0, 80);
    const amount = Number(input.unitPrice ?? existing?.unitPrice);
    if (!name) return { error: 'Give the charge a name.' };
    if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > MAX_AMOUNT) return { error: 'Enter a non-zero amount.' };
    return { entry: { date, serviceKey: '', name, description: '', unitPrice: money(amount), quantity: 1, flat: true, note } };
  }

  const serviceKey = String(input.serviceKey ?? existing?.serviceKey ?? '').trim();
  const service = rateCard.services.find((entry) => entry.key === serviceKey)
    || (existing && existing.serviceKey === serviceKey ? { key: serviceKey, name: existing.name, description: existing.description, unitPrice: existing.unitPrice } : null);
  if (!service) return { error: 'Choose a service from the rate card.' };
  const quantity = Number(input.quantity ?? existing?.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > MAX_AMOUNT || money(quantity) !== quantity) {
    return { error: 'Quantity must be a positive number.' };
  }
  const unitPrice = isBlank(input.unitPrice) ? (existing && existing.serviceKey === serviceKey ? existing.unitPrice : service.unitPrice) : Number(input.unitPrice);
  if (!Number.isFinite(unitPrice) || unitPrice < 0 || unitPrice > MAX_AMOUNT) return { error: 'Unit price must be zero or more.' };
  return { entry: { date, serviceKey, name: service.name, description: service.description, unitPrice: money(unitPrice), quantity, flat: false, note } };
}

function currentMonth(now = new Date()) {
  return now.toISOString().slice(0, 7);
}

function monthProgress(month, now = new Date()) {
  const [year, monthIndex] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(year, monthIndex, 0)).getUTCDate();
  const current = currentMonth(now);
  if (month < current) return { daysInMonth, daysElapsed: daysInMonth, fraction: 1 };
  if (month > current) return { daysInMonth, daysElapsed: 0, fraction: 0 };
  const daysElapsed = now.getUTCDate();
  return { daysInMonth, daysElapsed, fraction: daysElapsed / daysInMonth };
}

function buildInvoice(card, entries, month) {
  const monthEntries = entries.filter((entry) => String(entry.date || '').startsWith(`${month}-`));
  const serviceOrder = new Map(card.services.map((service, index) => [service.key, index]));

  // Invoice lines: per-unit services group by service + price; flat charges stay one line each.
  const grouped = new Map();
  const flatLines = [];
  monthEntries.forEach((entry) => {
    if (entry.flat) {
      flatLines.push({ name: entry.name, description: entry.note, flat: true, unitPrice: entry.unitPrice, quantity: 1, amount: money(entry.unitPrice) });
      return;
    }
    const key = `${entry.serviceKey}|${entry.unitPrice}`;
    const line = grouped.get(key) || { serviceKey: entry.serviceKey, name: entry.name, description: entry.description, flat: false, unitPrice: entry.unitPrice, quantity: 0, amount: 0 };
    line.quantity += entry.quantity;
    grouped.set(key, line);
  });
  const serviceLines = [...grouped.values()]
    .map((line) => ({ ...line, quantity: money(line.quantity), amount: money(line.quantity * line.unitPrice) }))
    .sort((a, b) => (serviceOrder.get(a.serviceKey) ?? 999) - (serviceOrder.get(b.serviceKey) ?? 999) || a.unitPrice - b.unitPrice);
  const lines = [...serviceLines, ...flatLines];

  const serviceTotal = money(serviceLines.reduce((sum, line) => sum + line.amount, 0));
  const flatTotal = money(flatLines.reduce((sum, line) => sum + line.amount, 0));
  const subtotal = money(serviceTotal + flatTotal);
  const tax = money(subtotal * card.taxRate / 100);
  return { lines, serviceTotal, subtotal, tax, total: money(subtotal + tax) };
}

const HISTORY_MONTHS = 6;

// Monthly totals before `month`: recorded past invoices win over totals rebuilt from portal entries.
function pastMonthTotals(card, entries, history, month) {
  const totals = new Map();
  const portalMonths = new Set(entries.map((entry) => String(entry.date || '').slice(0, 7)).filter((value) => MONTH_PATTERN.test(value) && value < month));
  portalMonths.forEach((pastMonth) => totals.set(pastMonth, buildInvoice(card, entries, pastMonth).total));
  const invoiced = new Map();
  history.filter((record) => record.month < month).forEach((record) => {
    invoiced.set(record.month, money((invoiced.get(record.month) || 0) + record.amount));
  });
  invoiced.forEach((amount, pastMonth) => totals.set(pastMonth, amount));
  return [...totals.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([pastMonth, total]) => ({ month: pastMonth, total }));
}

function summarizeBilling({ rateCard, entries = [], history = [], month, now = new Date() }) {
  const card = sanitizeRateCard(rateCard);
  const { lines, serviceTotal, subtotal, tax, total } = buildInvoice(card, entries, month);
  const progress = monthProgress(month, now);
  const recentMonths = pastMonthTotals(card, entries, history, month).slice(0, HISTORY_MONTHS);
  const historyAverage = recentMonths.length ? money(recentMonths.reduce((sum, item) => sum + item.total, 0) / recentMonths.length) : null;

  // Remaining days are priced at a blend of the client's usual daily spend and this month's pace,
  // leaning on history early in the month and on actual activity later. One-off charges are not repeated.
  let projected = total;
  let basis = 'final';
  if (progress.fraction === 0) {
    projected = Math.max(total, historyAverage ?? 0);
    basis = historyAverage === null ? 'none' : 'history';
  } else if (progress.fraction < 1) {
    const daysRemaining = progress.daysInMonth - progress.daysElapsed;
    const paceDaily = (serviceTotal * (1 + card.taxRate / 100)) / progress.daysElapsed;
    let daily = 0;
    if (historyAverage !== null) {
      daily = (1 - progress.fraction) * (historyAverage / progress.daysInMonth) + progress.fraction * paceDaily;
      basis = 'history';
    } else if (progress.daysElapsed >= 7) {
      daily = paceDaily;
      basis = 'pace';
    } else {
      basis = 'none';
    }
    projected = money(total + daily * daysRemaining);
  }

  const [year, monthIndex] = month.split('-').map(Number);
  return {
    month,
    period: { start: `${monthIndex}/1/${year}`, end: `${monthIndex}/${progress.daysInMonth}/${year}` },
    rateCard: card,
    lines,
    totals: { subtotal, tax, total, projected },
    estimate: { basis, historyAverage, historyMonths: recentMonths.length },
    progress
  };
}

const HISTORY_SHEET = 'Billing_History';
const BILLING_HISTORY_HEADERS = ['History_ID', 'Client_ID', 'Service_Month', 'Invoice_Date', 'Invoice_Number', 'Description', 'Amount', 'Updated_At'];

function historyFromRow(row) {
  return {
    id: String(row.get('History_ID') || ''),
    month: String(row.get('Service_Month') || '').trim(),
    invoiceDate: String(row.get('Invoice_Date') || '').trim(),
    invoiceNumber: String(row.get('Invoice_Number') || '').trim(),
    description: String(row.get('Description') || '').trim(),
    amount: money(row.get('Amount'))
  };
}

function sanitizeHistory(input = {}, existing = null) {
  const month = String(input.month ?? existing?.month ?? '').trim();
  if (!MONTH_PATTERN.test(month)) return { error: 'Choose the month the services were for.' };
  const amount = Number(input.amount ?? existing?.amount);
  if (isBlank(input.amount ?? existing?.amount) || !Number.isFinite(amount) || amount < 0 || amount > MAX_AMOUNT) return { error: 'Enter the invoice amount.' };
  const invoiceDate = String(input.invoiceDate ?? existing?.invoiceDate ?? '').trim();
  if (invoiceDate && !isValidDate(invoiceDate)) return { error: 'Invoice date is not valid.' };
  return {
    record: {
      month,
      amount: money(amount),
      invoiceDate,
      invoiceNumber: String(input.invoiceNumber ?? existing?.invoiceNumber ?? '').trim().slice(0, 30),
      description: String(input.description ?? existing?.description ?? '').trim().slice(0, 120)
    }
  };
}

module.exports = {
  HISTORY_SHEET,
  BILLING_HISTORY_HEADERS,
  historyFromRow,
  sanitizeHistory,
  RATE_SHEET,
  ENTRY_SHEET,
  BILLING_RATE_HEADERS,
  BILLING_ENTRY_HEADERS,
  MONTH_PATTERN,
  sanitizeRateCard,
  rateCardFromRow,
  entryFromRow,
  sanitizeEntry,
  currentMonth,
  summarizeBilling
};
