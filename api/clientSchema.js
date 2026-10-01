// Maps stored (possibly legacy or partially filled) client settings onto the current schema.
// Pure functions only — no sheet access — so they are safe to run on any row shape.

const QUICK_EDIT_MODES = ['enabled', 'password', 'disabled'];
const ATTRIBUTE_KEYS = ['bundled', 'fragile', 'oversized'];
const ATTRIBUTE_PATTERNS = { bundled: /bundl/i, fragile: /fragil/i, oversized: /over-?siz/i };
const DEFAULT_OVERSTOCK_LEVEL = 100;
const QUICK_EDIT_PIN_PATTERN = /^\S{4,32}$/;

function parseJsonObject(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(String(raw || ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    return null;
  }
}

function legacyQuickEditDefault(clientId) {
  return String(clientId || '').trim().toUpperCase() === 'CL-002' ? 'disabled' : 'enabled';
}

function guessAttributeField(fields, attribute) {
  const match = fields.find((field) => ATTRIBUTE_PATTERNS[attribute].test(`${field.key} ${field.label}`));
  return match ? match.key : null;
}

function mapClientSettings(raw, { fields = [], clientId = '' } = {}) {
  const stored = parseJsonObject(raw) || {};
  const safeFields = Array.isArray(fields) ? fields.filter((field) => field && field.key) : [];
  const fieldKeys = new Set(safeFields.map((field) => field.key));

  const storedVisibility = parseJsonObject(stored.fieldVisibility) || {};
  const fieldVisibility = {};
  safeFields.forEach((field) => {
    const entry = parseJsonObject(storedVisibility[field.key]) || {};
    fieldVisibility[field.key] = { inventory: entry.inventory !== false, order: entry.order !== false };
  });

  const storedMap = parseJsonObject(stored.attributeMap) || {};
  const attributeMap = {};
  ATTRIBUTE_KEYS.forEach((attribute) => {
    // An explicit null means the admin chose "none"; a missing key falls back to a name match.
    attributeMap[attribute] = Object.prototype.hasOwnProperty.call(storedMap, attribute)
      ? (fieldKeys.has(storedMap[attribute]) ? storedMap[attribute] : null)
      : guessAttributeField(safeFields, attribute);
  });

  const overstockLevel = Number(stored.overstockLevel);
  return {
    fieldVisibility,
    quickEditMode: QUICK_EDIT_MODES.includes(stored.quickEditMode) ? stored.quickEditMode : legacyQuickEditDefault(clientId),
    attributeMap,
    overstockLevel: Number.isFinite(overstockLevel) && overstockLevel > 0 ? Math.floor(overstockLevel) : DEFAULT_OVERSTOCK_LEVEL
  };
}

// Builds the stored settings object from an admin form submission. Per-field toggles may arrive
// either keyed by field key (fieldVisibility) or on each field definition (showInInventory/showInOrder).
function settingsFromInput(body = {}, fields = [], clientId = '') {
  const fieldVisibility = { ...(parseJsonObject(body.fieldVisibility) || {}) };
  (Array.isArray(body.fields) ? body.fields : []).forEach((field) => {
    if (!field || !field.key) return;
    fieldVisibility[field.key] = { inventory: field.showInInventory !== false, order: field.showInOrder !== false };
  });
  return mapClientSettings({ ...body, fieldVisibility }, { fields, clientId });
}

function isValidQuickEditPin(pin) {
  return QUICK_EDIT_PIN_PATTERN.test(String(pin ?? ''));
}

// Decides what a migration run should fill in for one credentials row. Only empty cells are ever
// written, so existing values and formulas in the sheet are left alone.
function planClientSettingsMigration({ clientId, settingsCell, pinHashCell, editPinCell, fields }) {
  const hasSettings = Boolean(String(settingsCell ?? '').trim());
  const hasPinHash = Boolean(String(pinHashCell ?? '').trim());
  const legacyPin = String(editPinCell ?? '').trim();
  return {
    clientId,
    settingsJson: hasSettings ? null : JSON.stringify(mapClientSettings(null, { fields, clientId })),
    hashLegacyPin: !hasPinHash && isValidQuickEditPin(legacyPin)
  };
}

module.exports = {
  QUICK_EDIT_MODES,
  ATTRIBUTE_KEYS,
  DEFAULT_OVERSTOCK_LEVEL,
  mapClientSettings,
  settingsFromInput,
  isValidQuickEditPin,
  legacyQuickEditDefault,
  planClientSettingsMigration
};
