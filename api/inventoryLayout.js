const LEGACY_FIELD_HEADERS = {
  'CL-002': {
    upc: ['upc'],
    productDescription: ['product description'],
    quantityOrdered: ['quantity ordered'],
    quantityReceived: ['quantity received'],
    quantityShipped: ['quantity shipped'],
    expDate: ['exp date'],
    merchant: ['merchant'],
    asin: ['asin'],
    fulfillment: ['fbm', 'fba'],
    transparencyCode: ['transparency'],
    bundled: ['bundled'],
    bundleQty: ['bundle quantity'],
    notes: ['notes']
  },
  'CL-003': {
    productName: ['product description/name'],
    quantityOrdered: ['quantity ordered'],
    quantityReceived: ['quantity received'],
    quantityShipped: ['quantity shipped'],
    merchant: ['merchant'],
    carrier: ['carrier'],
    trackingNumber: ['tracking #', 'tracking number'],
    notes: ['notes']
  }
};

function normalizedHeaders(row = []) {
  return row.map((cell) => String(cell || '').trim().toLowerCase());
}

function findHeaderIndex(headers, aliases, fallback = -1) {
  const index = headers.findIndex((header) => aliases.some((alias) => header.includes(alias)));
  return index >= 0 ? index : fallback;
}

function uniqueArchiveLabel(label, existing) {
  const base = `Archived: ${label}`;
  let candidate = base;
  let suffix = 2;
  while (existing.has(candidate.toLowerCase())) candidate = `${base} (${suffix++})`;
  existing.add(candidate.toLowerCase());
  return candidate;
}

function toGenericRows({ rows, oldFields, newFields, titleLabel = 'Product Title', legacyClientId = '' }) {
  const hasLegacyLayout = Boolean(legacyClientId);
  const sourceHeaderRow = hasLegacyLayout ? rows[0] || [] : [];
  const sourceHeaders = normalizedHeaders(sourceHeaderRow);
  let dataStart = 1;
  let skuIndex = 0;
  let titleIndex = 1;
  let qtyIndex = 2 + oldFields.length;
  let statusIndex = qtyIndex + 1;
  let notesIndex = statusIndex + 1;
  let legacyIndexes = {};

  if (hasLegacyLayout && legacyClientId === 'CL-001') {
    const headerIndex = rows.findIndex((row) => normalizedHeaders(row).some((header) => header.includes('sku code')));
    if (headerIndex < 0) throw new Error('Could not find the SKU Code header in the CL-001 inventory tab.');
    dataStart = headerIndex + 1;
    const legacyHeaders = normalizedHeaders(rows[headerIndex]);
    skuIndex = findHeaderIndex(legacyHeaders, ['sku code'], 1);
    titleIndex = findHeaderIndex(legacyHeaders, ['product title'], 2);
    qtyIndex = findHeaderIndex(legacyHeaders, ['qty', 'quantity'], 3);
    statusIndex = findHeaderIndex(legacyHeaders, ['status'], 4);
    notesIndex = findHeaderIndex(legacyHeaders, ['notes'], 5);
  } else if (hasLegacyLayout) {
    const map = LEGACY_FIELD_HEADERS[legacyClientId];
    if (!map) throw new Error(`Unsupported legacy inventory layout: ${legacyClientId}.`);
    legacyIndexes = Object.fromEntries(Object.entries(map).map(([key, aliases]) => [
      key,
      findHeaderIndex(sourceHeaders, aliases)
    ]));
    if (legacyClientId === 'CL-002') {
      skuIndex = legacyIndexes.upc;
      titleIndex = legacyIndexes.productDescription;
      qtyIndex = legacyIndexes.quantityOrdered;
      statusIndex = -1;
      notesIndex = legacyIndexes.notes;
    } else {
      skuIndex = legacyIndexes.productName;
      titleIndex = legacyIndexes.productName;
      qtyIndex = legacyIndexes.quantityReceived;
      statusIndex = -1;
      notesIndex = legacyIndexes.notes;
    }
  }

  const oldIndexes = new Map(oldFields.map((field, index) => [field.key, 2 + index]));
  const fieldIndexes = hasLegacyLayout ? legacyIndexes : Object.fromEntries(oldIndexes);
  const retainedKeys = new Set(newFields.map((field) => field.key));
  const archiveLabels = new Set();
  const archivedFields = [];

  if (hasLegacyLayout && legacyClientId !== 'CL-001') {
    oldFields.forEach((field) => {
      if (['upc', 'productDescription', 'productName', 'notes'].includes(field.key)) return;
      if (!retainedKeys.has(field.key)) archivedFields.push({ key: field.key, label: field.label });
    });
  } else if (!hasLegacyLayout) {
    oldFields.forEach((field) => {
      if (!retainedKeys.has(field.key)) archivedFields.push({ key: field.key, label: field.label });
    });
  }

  const existingArchiveColumns = [];
  if (!hasLegacyLayout) {
    for (let index = notesIndex + 1; index < (rows[0] || []).length; index += 1) {
      const label = String(rows[0][index] || '').trim();
      if (/^Archived:/i.test(label)) {
        existingArchiveColumns.push({ index, label });
        archiveLabels.add(label.toLowerCase());
      } else if (label) {
        existingArchiveColumns.push({ index, label: uniqueArchiveLabel(label, archiveLabels) });
      }
    }
  }

  const archivedColumns = [
    ...existingArchiveColumns.map((column) => ({ ...column, key: null })),
    ...archivedFields.map((field) => ({
      key: field.key,
      index: fieldIndexes[field.key] ?? -1,
      label: uniqueArchiveLabel(field.label || field.key, archiveLabels)
    }))
  ];
  const outputHeaders = [
    'SKU',
    titleLabel || 'Product Title',
    ...newFields.map((field) => field.label),
    'Qty',
    'Status',
    'Notes',
    ...archivedColumns.map((column) => column.label)
  ];

  const outputRows = [];
  for (let index = dataStart; index < rows.length; index += 1) {
    const source = rows[index] || [];
    const sku = source[skuIndex] ?? '';
    const title = source[titleIndex] ?? '';
    if (hasLegacyLayout && legacyClientId === 'CL-001') {
      const titleText = String(title || '').trim();
      const skuText = String(sku || '').trim();
      const rowText = source.map((cell) => String(cell || '')).join(' ').toLowerCase();
      const titleLower = titleText.toLowerCase();
      const clientId = String(source[0] || '').trim();
      if ((!skuText && !titleText) || (!skuText && !titleLower.includes('inventory') && !titleLower.includes('client')) ||
          (/^\d+$/.test(skuText) && !titleLower.includes('inventory') && !titleLower.includes('client')) ||
          rowText.includes('last inventory date') || rowText.includes('inventory summary') ||
          rowText.includes('total skus tracked') || rowText.includes('client:') || rowText.includes('fulfilled by:') ||
          rowText.includes('electric city logistics') || skuText.toLowerCase().includes('sku code') ||
          titleLower.includes('product title') ||
          (clientId && !['CL-000', 'CL-001', 'CL-002', 'CL-003'].includes(clientId) && !clientId.toUpperCase().startsWith('CL-'))) continue;
    } else if (hasLegacyLayout && !String(title || '').trim()) {
      continue;
    }

    const values = new Map();
    newFields.forEach((field) => {
      const sourceIndex = hasLegacyLayout ? fieldIndexes[field.key] : oldIndexes.get(field.key);
      values.set(field.key, sourceIndex === undefined || sourceIndex < 0 ? '' : source[sourceIndex] ?? '');
    });
    const quantity = qtyIndex >= 0 ? source[qtyIndex] ?? '' : '';
    const status = statusIndex >= 0 ? source[statusIndex] ?? '' : '';
    const notes = notesIndex >= 0 ? source[notesIndex] ?? '' : '';
    outputRows.push([
      sku,
      title,
      ...newFields.map((field) => values.get(field.key)),
      quantity,
      status,
      notes,
      ...archivedColumns.map((column) => column.index >= 0 ? source[column.index] ?? '' : '')
    ]);
  }
  while (outputRows.length && outputRows[outputRows.length - 1].every((cell) => cell === '' || cell === null || cell === undefined)) {
    outputRows.pop();
  }
  return { headers: outputHeaders, rows: outputRows };
}

module.exports = { toGenericRows };
