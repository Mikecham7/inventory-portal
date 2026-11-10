const CATALOG_FIELDS = [
  { key: 'imageUrl', label: 'Product Image URL', aliases: ['imageurl', 'image url', 'product image url', 'image thumbnail', 'image'] },
  { key: 'bundled', label: 'Is Bundled', aliases: ['bundled', 'is bundled', 'isbundled', 'bundled? (y/n)'] },
  { key: 'bundleQty', label: 'Bundle Quantity', aliases: ['bundleqty', 'bundlequantity', 'bundle quantity'] },
  { key: 'prepInstructions', label: 'Special Prep Instructions', aliases: ['prepinstructions', 'special prep instructions'] }
];

function catalogFieldKeys(profile) {
  return Object.fromEntries(CATALOG_FIELDS.map((catalog) => {
    const field = (profile.fields || []).find((entry) => (catalog.key === 'bundled' && entry.key === profile.attributeMap?.bundled)
      || catalog.aliases.includes(String(entry.key).toLowerCase())
      || catalog.aliases.includes(String(entry.label).toLowerCase()));
    return [catalog.key, field?.key || catalog.key];
  }));
}

function catalogColumns(rows, profile, minimum = 0) {
  const headerRowIndex = profile.legacy && profile.clientId === 'CL-001'
    ? Math.max(0, rows.findIndex((row) => row.some((value) => /sku code/i.test(String(value))))) : 0;
  const headers = [...(rows[headerRowIndex] || [])];
  const keys = catalogFieldKeys(profile);
  const columns = {};
  let next = Math.max(minimum, headers.reduce((last, value, index) => String(value || '').trim() ? index + 1 : last, 0));
  for (const field of CATALOG_FIELDS) {
    const configured = !profile.legacy ? (profile.fields || []).findIndex((entry) => entry.key === keys[field.key]) : -1;
    let column = configured >= 0 ? 2 + configured
      : headers.findIndex((value) => field.aliases.includes(String(value || '').trim().toLowerCase()));
    if (column < 0) {
      column = next++;
      headers[column] = field.label;
    }
    columns[field.key] = column;
  }
  return { headers, columns, keys, headerRowIndex };
}

function validateCatalogValues(values, keys) {
  for (const field of CATALOG_FIELDS) {
    const key = keys[field.key];
    if (!(key in values) && !(field.key in values)) continue;
    const value = String(values[key] ?? values[field.key] ?? '').trim();
    if (field.key === 'prepInstructions' && (value.length > 5000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))) {
      throw new Error('Special Prep Instructions must be 5000 characters or fewer without control characters.');
    }
    if (field.key === 'imageUrl' && value) {
      let url;
      try { url = new URL(value); } catch { throw new Error('Product image must be an HTTP or HTTPS URL.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || value.length > 2000) throw new Error('Product image must be an HTTP or HTTPS URL without credentials (maximum 2000 characters).');
    }
    if (field.key === 'bundled' && value && !/^(y|n|yes|no|true|false|1|0)$/i.test(value)) throw new Error('Is Bundled must be Y or N.');
    if (field.key === 'bundleQty' && value && (!Number.isSafeInteger(Number(value)) || Number(value) < 0)) throw new Error('Bundle Quantity must be a non-negative whole number.');
  }
}

module.exports = { CATALOG_FIELDS, catalogFieldKeys, catalogColumns, validateCatalogValues };
