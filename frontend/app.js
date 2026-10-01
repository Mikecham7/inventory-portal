const API_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3001/api/inventory'
  : '/api/inventory';

const LOGIN_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3001/api/login'
  : '/api/login';

const CLIENTS_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3001/api/clients'
  : '/api/clients';

const CHAT_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3001/api/chat'
  : '/api/chat';

const CREATE_ITEM_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3001/api/inventory/create'
  : '/api/inventory/create';

const CLIENT_PROFILE_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3001/api/client-profile'
  : '/api/client-profile';

const ADMIN_CLIENTS_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3001/api/admin/clients'
  : '/api/admin/clients';

const ACTIVATE_ACCOUNT_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3001/api/account/activate'
  : '/api/account/activate';

const RECOVER_ACCOUNT_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3001/api/account/recover'
  : '/api/account/recover';

const NOTIFICATIONS_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3001/api/notifications'
  : '/api/notifications';

const UPDATE_QUANTITY_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3001/api/inventory/quantity'
  : '/api/inventory/quantity';
const QUICK_EDIT_UNLOCK_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3001/api/quick-edit/unlock'
  : '/api/quick-edit/unlock';
const UPDATE_SHIPMENT_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3001/api/inventory/shipment'
  : '/api/inventory/shipment';
const UPDATE_ITEM_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3001/api/inventory/item'
  : '/api/inventory/item';
const BILLING_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3001/api/billing/summary'
  : '/api/billing/summary';
const ADMIN_BILLING_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3001/api/admin/billing'
  : '/api/admin/billing';

const defaultInventory = [];

const CLIENT_INVENTORY_FIELDS = {
  'CL-001': { label: 'Metal Garden Markers', readOnly: true, requirePin: true, fields: [] },
  'CL-002': { label: 'Ecom Elite 2.0', readOnly: false, requirePin: false, fields: [
    { key: 'upc', label: 'UPC', type: 'text' },
    { key: 'productDescription', label: 'Product Description', type: 'textarea' },
    { key: 'quantityOrdered', label: 'Quantity Ordered', type: 'number' },
    { key: 'quantityReceived', label: 'Quantity Received', type: 'number', adminOnly: true },
    { key: 'quantityShipped', label: 'Quantity Shipped', type: 'number', adminOnly: true },
    { key: 'expDate', label: 'Exp Date', type: 'text' },
    { key: 'merchant', label: 'Merchant', type: 'text' },
    { key: 'asin', label: 'ASIN #', type: 'text' },
    { key: 'fulfillment', label: 'FBM / FBA', type: 'select', options: ['', 'FBA', 'FBM'] },
    { key: 'transparencyCode', label: 'Transparency Code (Y/N)', type: 'text' },
    { key: 'bundled', label: 'Bundled? (Y/N)', type: 'text' },
    { key: 'bundleQty', label: 'Bundle Quantity', type: 'number' },
    { key: 'notes', label: 'Notes', type: 'textarea' }
  ] },
  'CL-003': { label: 'CJA Ventures', readOnly: false, requirePin: false, fields: [
    { key: 'productName', label: 'Product Description / Name', type: 'text' },
    { key: 'quantityOrdered', label: 'Quantity Ordered', type: 'number' },
    { key: 'merchant', label: 'Merchant', type: 'text' },
    { key: 'carrier', label: 'Carrier', type: 'select', options: ['', 'UPS', 'USPS', 'FedEx'] },
    { key: 'trackingNumber', label: 'Tracking #', type: 'text' },
    { key: 'quantityReceived', label: 'Quantity Received', type: 'number', adminOnly: true },
    { key: 'quantityShipped', label: 'Quantity Shipped', type: 'number', adminOnly: true },
    { key: 'notes', label: 'Notes', type: 'textarea' }
  ] }
};

function getVisibleClientFields(clientId, isAdmin = false) {
  const config = getClientInventoryFields(clientId);
  return (config.fields || []).filter((field) => !field.adminOnly || Boolean(isAdmin));
}

function getDashboardColumns(clientId) {
  const safeClientId = String(clientId || '').trim().toUpperCase();
  const columns = ['SKU', 'PRODUCT TITLE'];
  if (safeClientId === 'CL-002') columns.push('ASIN #');
  columns.push('QTY', 'STATUS', 'EDIT');
  return columns;
}

function getCreateFormTitleConfig(clientId) {
  const safeClientId = String(clientId || '').trim().toUpperCase();
  if (state.clientProfile && state.clientProfile.clientId === safeClientId) {
    return state.clientProfile.titleField;
  }
  const isCardClient = safeClientId === 'CL-003';

  return {
    visible: !isCardClient,
    label: isCardClient ? 'Product Name' : 'Product Title',
    placeholder: isCardClient ? 'Pokémon - Charizard' : 'Copper Marker'
  };
}

function getClientInventoryFields(clientId) {
  const safeClientId = String(clientId || '').trim().toUpperCase();
  if (state.clientProfile && state.clientProfile.clientId === safeClientId) {
    return {
      label: state.clientProfile.clientName,
      readOnly: state.clientProfile.readOnly,
      requirePin: state.clientProfile.requirePin,
      fields: state.clientProfile.fields || []
    };
  }
  return CLIENT_INVENTORY_FIELDS[safeClientId] || { label: 'Client', readOnly: true, requirePin: true, fields: [] };
}

// Only the loaded profile of this exact client can supply a folder; no profile, email, or folder means no link.
function getChatDriveFolderForClient(clientId) {
  const safeClientId = String(clientId || '').trim().toUpperCase();
  const profile = state.clientProfile;
  if (!profile || profile.clientId !== safeClientId || !profile.driveAccessReady) return '';
  return isGoogleDriveUrl(profile.driveFolderUrl) ? profile.driveFolderUrl : '';
}

function isGoogleDriveUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' && (url.hostname === 'drive.google.com' || url.hostname === 'docs.google.com');
  } catch (error) {
    return false;
  }
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

function getClientFieldPlaceholder(field = {}, items = []) {
  const clientId = state.activeClientId || state.session?.clientId || 'CL-001';
  if (clientId === 'CL-003') {
    const cjaExamples = {
      productName: 'Pokémon - Charizard',
      quantityOrdered: '5',
      quantityReceived: '2',
      quantityShipped: '2',
      merchant: 'Card Shop',
      carrier: 'UPS',
      trackingNumber: '1Z999AA12345678999',
      notes: 'Light scratches, PSA 9'
    };
    const fieldKey = field && field.key;
    if (fieldKey && cjaExamples[fieldKey]) {
      if (field && field.type === 'number') return String(cjaExamples[fieldKey]);
      return `e.g. ${cjaExamples[fieldKey]}`;
    }
  }

  const sample = getInventoryFieldSample(items, field && field.key);
  if (!sample) return field && field.label ? field.label : 'Enter value';
  if (field && field.type === 'number') return String(sample);
  return `e.g. ${sample}`;
}

function normalizeInventoryItem(item, fallbackClientId = '') {
  const qty = Number(item.quantity ?? item.qty ?? item.onHand ?? 0);
  const reorderLevel = Number(item.reorderLevel ?? item.lowStock ?? item.minQty ?? 5);
  const title = item.title || item.itemName || item.product || item.productName || item.description || item.productDescription || 'Untitled';
  const sku = item.sku || item.itemSku || item.code || item.upc || 'N/A';

  return {
    ...item,
    id: String(item.id || `${sku}-${fallbackClientId || 'inventory'}`),
    sku,
    title,
    itemName: title,
    qty: Number.isFinite(qty) ? qty : 0,
    quantity: Number.isFinite(qty) ? qty : 0,
    reorderLevel: Number.isFinite(reorderLevel) ? reorderLevel : 0,
    status: item.status || getStatusText(getItemStatus({ qty, reorderLevel })),
    clientId: item.clientId || fallbackClientId || '',
    asin: item.asin || '',
    upc: item.upc || '',
    merchant: item.merchant || '',
    carrier: item.carrier || '',
    trackingNumber: item.trackingNumber || '',
    productDescription: item.productDescription || item.description || '',
    quantityOrdered: item.quantityOrdered ?? item.ordered ?? '',
    quantityReceived: item.quantityReceived ?? item.received ?? '',
    quantityShipped: item.quantityShipped ?? item.shipped ?? '',
    fulfillment: item.fulfillment || '',
    notes: item.notes || ''
  };
}

const state = {
  items: [],
  filters: { stock: [], stage: [], attr: [] },
  quickEditUnlock: null,
  billing: null,
  pendingMessages: [],
  billingEditId: null,
  historyEditId: null,
  rateCardClientId: null,
  rateServices: [],
  query: '',
  selectedItemId: null,
  auth: false,
  pinUnlocked: false,
  session: null,
  isAdmin: false,
  roster: [],
  activeClientId: null,
  messages: [],
  clientProfile: null,
  newClientFields: [],
  editClientId: '',
  editClientFields: [],
  notifications: { chat: 0, inventory: 0, total: 0, items: [] }
};

let chatRequestId = 0;
let inventoryRequestId = 0;
let notificationRequestId = 0;
let chatSignature = null;
let inventorySignature = null;
let syncGeneration = 0;

// Last-good data per client so switching back renders instantly while a refresh runs.
const clientViewCache = new Map();
const SWITCH_DEBOUNCE_MS = 250;
let switchTimer = null;
let switchSequence = 0;
let viewController = typeof AbortController === 'function' ? new AbortController() : null;

function viewSignal() {
  return viewController ? viewController.signal : undefined;
}

function resetViewRequests() {
  if (!viewController) return;
  viewController.abort();
  viewController = new AbortController();
}

function cacheClientView(clientId, values) {
  if (!clientId) return;
  clientViewCache.set(clientId, { ...(clientViewCache.get(clientId) || {}), ...values });
}
const syncTimers = { chat: null, inventory: null, notifications: null, billing: null };
const syncFailures = { chat: 0, inventory: 0, notifications: 0, billing: 0 };
const syncIntervals = { chat: 12000, inventory: 30000, notifications: 60000, billing: 30000 };
// Every open tab shares the same Google Sheets read allowance, so idle tabs stop polling until used again.
const IDLE_PAUSE_MS = 5 * 60 * 1000;
let lastInteractionAt = Date.now();
let idlePaused = false;

function noteInteraction() {
  lastInteractionAt = Date.now();
  if (!idlePaused) return;
  idlePaused = false;
  startBackgroundSync(true);
}

['pointerdown', 'keydown', 'touchstart', 'wheel'].forEach((eventName) => {
  document.addEventListener(eventName, noteInteraction, { passive: true });
});

function isPageActive(pageId) {
  return Boolean(document.getElementById(pageId)?.classList.contains('active'));
}

function stopBackgroundSync() {
  syncGeneration += 1;
  Object.keys(syncTimers).forEach((kind) => {
    clearTimeout(syncTimers[kind]);
    syncTimers[kind] = null;
  });
}

function scheduleBackgroundSync(kind, delay, generation = syncGeneration) {
  clearTimeout(syncTimers[kind]);
  if (!state.auth || document.hidden) return;
  syncTimers[kind] = setTimeout(async () => {
    if (generation !== syncGeneration || !state.auth || document.hidden) return;
    if (Date.now() - lastInteractionAt > IDLE_PAUSE_MS) {
      idlePaused = true;
      return;
    }
    if (kind === 'chat' && !document.getElementById('page-chat')?.classList.contains('active')) return;
    if (kind === 'billing' && !isPageActive('page-billing')) return;

    const clientId = state.activeClientId;
    let status = 0;
    // A rendering bug in one refresh must never stop future refreshes or sign the user out.
    try {
      status = kind === 'chat' ? await loadChatMessages(clientId)
        : kind === 'billing' ? await loadBillingSummary(clientId)
          : kind === 'inventory' ? await fetchInventory(clientId) : await fetchNotifications(clientId);
    } catch (error) {
      console.error(`Background ${kind} refresh failed:`, error);
    }
    if (status === 401 && kind !== 'inventory') {
      handleExpiredSession();
      return;
    }
    if (generation !== syncGeneration || !state.auth || document.hidden || clientId !== state.activeClientId) return;

    syncFailures[kind] = status === 200 ? 0 : syncFailures[kind] + 1;
    const nextDelay = status === 200 ? syncIntervals[kind]
      : Math.min(120000, (status === 429 ? 30000 : syncIntervals[kind] * 2) * (2 ** Math.min(syncFailures[kind] - 1, 3)));
    scheduleBackgroundSync(kind, nextDelay, generation);
  }, delay);
}

function startBackgroundSync(immediate = false) {
  stopBackgroundSync();
  if (!state.auth || document.hidden) return;
  scheduleBackgroundSync('inventory', immediate ? 0 : syncIntervals.inventory);
  scheduleBackgroundSync('notifications', immediate ? 1500 : syncIntervals.notifications);
  if (document.getElementById('page-chat')?.classList.contains('active')) {
    scheduleBackgroundSync('chat', immediate ? 1000 : syncIntervals.chat);
  }
  if (isPageActive('page-billing')) {
    scheduleBackgroundSync('billing', immediate ? 500 : syncIntervals.billing);
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopBackgroundSync();
  else {
    lastInteractionAt = Date.now();
    idlePaused = false;
    startBackgroundSync(true);
  }
});

function renderNotifications() {
  const anchor = document.getElementById('notificationAnchor');
  const badge = document.getElementById('notificationBadge');
  const list = document.getElementById('notificationList');
  const clear = document.getElementById('notificationClear');
  if (!anchor || !badge || !list) return;
  anchor.style.display = state.auth ? 'block' : 'none';
  const { total, items } = state.notifications;
  badge.style.display = total ? 'block' : 'none';
  badge.textContent = total > 99 ? '99+' : String(total);
  const button = document.getElementById('notificationButton');
  if (button) button.setAttribute('aria-label', `${total} unread notifications`);
  if (clear) clear.style.display = total ? 'block' : 'none';
  list.replaceChildren();
  if (!items.length) {
    list.textContent = 'No unread notifications.';
    return;
  }
  items.forEach((item) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'notification-row';
    const heading = document.createElement('strong');
    heading.textContent = `${item.kind === 'chat' ? 'Chat' : 'Inventory'}${state.isAdmin ? ` · ${item.clientId}` : ''}`;
    const description = document.createElement('span');
    description.textContent = item.description || 'New activity';
    row.append(heading, description);
    row.addEventListener('click', () => openNotification(item));
    list.append(row);
  });
}

function setNotificationsOpen(open) {
  const panel = document.getElementById('notificationPanel');
  if (!panel) return;
  if (open) {
    // Fixed positioning keeps the panel on screen at any header height or width.
    const rect = document.getElementById('notificationButton')?.getBoundingClientRect?.();
    if (rect) panel.style.top = `${Math.round(rect.bottom + 6)}px`;
  }
  panel.style.display = open ? 'block' : 'none';
  document.getElementById('notificationButton')?.setAttribute('aria-expanded', String(open));
}

function toggleNotifications() {
  const panel = document.getElementById('notificationPanel');
  if (!panel) return;
  setNotificationsOpen(panel.style.display === 'none');
}

// Capture phase sees the click before row handlers re-render the list.
document.addEventListener('click', (event) => {
  const panel = document.getElementById('notificationPanel');
  if (!panel || panel.style.display === 'none') return;
  if (!event.target?.closest?.('#notificationAnchor')) setNotificationsOpen(false);
}, true);

document.addEventListener('keydown', (event) => {
  const panel = document.getElementById('notificationPanel');
  if (event.key !== 'Escape' || !panel || panel.style.display === 'none') return;
  setNotificationsOpen(false);
  document.getElementById('notificationButton')?.focus();
});

function togglePasswordVisibility(button) {
  const input = document.getElementById(button.dataset.target);
  if (!input) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  button.setAttribute('aria-pressed', String(show));
  button.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  button.title = show ? 'Hide password' : 'Show password';
}

async function fetchNotifications(clientId = state.activeClientId) {
  if (!state.auth || !state.session?.notificationToken) return 401;
  const requestId = ++notificationRequestId;
  const session = state.session;
  try {
    const response = await fetch(`${NOTIFICATIONS_URL}?clientId=${encodeURIComponent(clientId || session.clientId)}`, {
      headers: { Authorization: `Bearer ${session.notificationToken}`, Accept: 'application/json' },
      signal: viewSignal()
    });
    if (!response.ok) return response.status;
    const summary = await response.json();
    if (requestId === notificationRequestId && state.auth && state.session === session && state.activeClientId === clientId) {
      state.notifications = summary;
      renderNotifications();
    }
    return 200;
  } catch (error) {
    return 0;
  }
}

async function markNotificationsRead(kind, clientId = state.activeClientId) {
  if (!state.session?.notificationToken) return;
  try {
    const response = await fetch(`${NOTIFICATIONS_URL}/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.session.notificationToken}` },
      body: JSON.stringify({ kind, clientId })
    });
    if (!response.ok) throw new Error('Unable to mark notifications read.');
    await fetchNotifications();
  } catch (error) {
    showToast('Unable to mark notifications read', 'error');
  }
}

async function openNotification(item) {
  toggleNotifications();
  if (state.isAdmin && item.clientId !== state.activeClientId) await switchClientView(item.clientId);
  showPage(item.kind === 'chat' ? 'chat' : 'dashboard', false);
  await markNotificationsRead(item.kind, item.clientId);
}

const portalLoginWindow = document.getElementById('portalLoginWindow');
const loginErrorMsg = document.getElementById('loginErrorMsg');
const portalUser = document.getElementById('portalUser');
const portalPass = document.getElementById('portalPass');
const toast = document.getElementById('toast');
const inventoryBody = document.getElementById('inventoryBody');
const searchInput = document.getElementById('searchInput');
const tableSearch = document.getElementById('tableSearch');
const logSearch = document.getElementById('logSearch');
const pageDashboard = document.getElementById('page-dashboard');
const pinOverlay = document.getElementById('pinOverlay');
const pinInput = document.getElementById('pinInput');
const selectedItem = document.getElementById('selectedItem');
const selSku = document.getElementById('selSku');
const selTitle = document.getElementById('selTitle');
const selQty = document.getElementById('selQty');
const selBadge = document.getElementById('selBadge');
const searchResults = document.getElementById('searchResults');
const logTableWrap = document.getElementById('logTableWrap');
const msgBox = document.getElementById('msgBox');
const msgInput = document.getElementById('msgInput');

function showToast(text, variant = 'success') {
  if (!toast) return;
  toast.textContent = text;
  toast.className = `toast show ${variant}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.className = 'toast';
  }, 2200);
}

function setPage(pageId) {
  const typingIndicator = document.getElementById('typingIndicator');
  if (typingIndicator) {
    typingIndicator.style.display = 'none';
  }

  const pages = document.querySelectorAll('.page');
  pages.forEach((page) => {
    const isMatch = page.id === pageId;
    page.classList.toggle('active', isMatch);
    page.style.display = isMatch ? 'block' : 'none';
  });

  const tabs = document.querySelectorAll('.tab');
  tabs.forEach((tab) => tab.classList.remove('active'));

  const tabMap = {
    'page-dashboard': 0,
    'page-update': 1,
    'page-order': 2,
    'page-logs': 3,
    'page-chat': 4,
    'page-billing': 5,
    'page-clients': 6
  };

  const tabIndex = tabMap[pageId];
  if (tabIndex !== undefined && tabs[tabIndex]) {
    tabs[tabIndex].classList.add('active');
  }
  if (state.auth && !document.hidden) {
    if (pageId === 'page-chat') scheduleBackgroundSync('chat', 0);
    else {
      clearTimeout(syncTimers.chat);
      syncTimers.chat = null;
    }
    if (pageId === 'page-billing') scheduleBackgroundSync('billing', syncIntervals.billing);
    else {
      clearTimeout(syncTimers.billing);
      syncTimers.billing = null;
    }
  }
  saveSession();
}

function showPage(pageName, markChatRead = true) {
  const routeMap = {
    dashboard: 'page-dashboard',
    update: 'page-update',
    order: 'page-order',
    logs: 'page-logs',
    chat: 'page-chat',
    billing: 'page-billing',
    clients: 'page-clients'
  };

  const targetPage = routeMap[pageName] || pageName;
  if (targetPage && document.getElementById(targetPage)) {
    setPage(targetPage);
  }
  if (targetPage === 'page-chat' && markChatRead && state.auth && state.notifications.chat) {
    const clientId = state.activeClientId;
    loadChatMessages(clientId).then((status) => {
      if (status === 200 && state.activeClientId === clientId && document.getElementById('page-chat')?.classList.contains('active')) {
        markNotificationsRead('chat', clientId);
      }
    });
  }
  if (targetPage === 'page-billing' && state.auth) {
    loadBillingSummary(state.activeClientId);
  }
  if (targetPage === 'page-clients') {
    renderClientFieldRows();
    populateEditClientSelect();
  }
}

// Clients whose fields include a received and a shipped quantity follow the warehouse shipment workflow.
function getShipmentFieldKeys(clientId) {
  const safeClientId = String(clientId || '').trim().toUpperCase();
  const profile = state.clientProfile && state.clientProfile.clientId === safeClientId ? state.clientProfile : null;
  const fields = (profile ? profile.fields : CLIENT_INVENTORY_FIELDS[safeClientId]?.fields) || [];
  const find = (pattern) => fields.find((field) => pattern.test(`${field.key} ${field.label}`))?.key || null;
  const received = find(/received/i);
  const shipped = find(/shipped/i);
  return received && shipped ? { received, shipped } : null;
}

function getShipmentStage(received, shipped) {
  const receivedCount = toNumber(received);
  const shippedCount = toNumber(shipped);
  if (shippedCount > 0 && shippedCount >= receivedCount) return 'fully';
  if (shippedCount > 0) return 'partial';
  return receivedCount > 0 ? 'not' : 'awaiting';
}

function getShippingStatus(item = {}) {
  const clientId = String(item.clientId || state.activeClientId || state.session?.clientId || 'CL-001').trim().toUpperCase();
  const keys = getShipmentFieldKeys(clientId);
  return keys ? getShipmentStage(item[keys.received], item[keys.shipped]) : null;
}

function getItemStatus(item) {
  const shipping = getShippingStatus(item);
  if (shipping) return shipping;

  const qty = Number(item.qty ?? item.quantity ?? 0);
  if (!Number.isFinite(qty) || qty <= 0) return 'out';
  if (qty <= Number(item.reorderLevel || 0)) return 'low';
  return 'in';
}

function getStatusText(status) {
  if (status === 'fully') return 'Fully Shipped';
  if (status === 'partial') return 'Partially Shipped';
  if (status === 'not') return 'Not Shipped';
  if (status === 'awaiting') return 'Not Received';
  if (status === 'out') return 'Out of Stock';
  if (status === 'low') return 'Low Stock';
  return 'In Stock';
}

function getStatusBadgeClass(status) {
  if (status === 'fully') return 'badge-fully';
  if (status === 'partial') return 'badge-partial';
  if (status === 'not') return 'badge-not';
  if (status === 'awaiting') return 'badge-awaiting';
  if (status === 'out') return 'badge-out';
  if (status === 'low') return 'badge-low';
  return 'badge-in';
}

async function fetchClientProfile(clientId = state.activeClientId || state.session?.clientId || 'CL-001') {
  try {
    const response = await fetch(`${CLIENT_PROFILE_URL}?clientId=${encodeURIComponent(clientId)}`, {
      headers: adminHeaders({ Accept: 'application/json' }),
      signal: viewSignal()
    });
    if (!response.ok) return null;
    const profile = await response.json();
    cacheClientView(clientId, { profile });
    // A slow profile for a previously selected client must not relabel the current table.
    if (state.activeClientId === clientId) state.clientProfile = profile;
    return profile;
  } catch (error) {
    return null;
  }
}

function getFilterConfig(clientId = state.activeClientId || state.session?.clientId || 'CL-001') {
  const safeClientId = String(clientId || '').trim().toUpperCase();
  const shippingClient = Boolean(getShipmentFieldKeys(safeClientId));
  if (shippingClient) {
    return {
      mode: 'shipping',
      options: [
        { key: 'all', label: 'All' },
        { key: 'fully', label: 'Fully Shipped' },
        { key: 'partial', label: 'Partially Shipped' },
        { key: 'not', label: 'Not Shipped' }
      ]
    };
  }

  return {
    mode: 'stock',
    options: [
      { key: 'all', label: 'All' },
      { key: 'in', label: 'In Stock' },
      { key: 'low', label: 'Low Stock' },
      { key: 'out', label: 'Out of Stock' }
    ]
  };
}

const FILTER_GROUPS = [
  { key: 'stock', label: 'Stock Levels', options: [['in', 'In Stock'], ['low', 'Low Stock'], ['out', 'Out of Stock'], ['over', 'Overstock'], ['negative', 'Negative Inventory']] },
  { key: 'stage', label: 'Fulfillment Stages', options: [['awaiting', 'Not Received'], ['not', 'Not Shipped'], ['partial', 'Partially Shipped'], ['fully', 'Fully Shipped'], ['label', 'Ready for Label'], ['exception', 'Exception / Delivery Issue']] },
  { key: 'attr', label: 'Attributes & Time', options: [['bundled', 'Bundled'], ['unbundled', 'Non-Bundled'], ['fragile', 'Fragile'], ['oversized', 'Oversized'], ['aged', 'Aged Orders (>48h)'], ['dead', 'Dead Stock']] }
];
const AGED_ORDER_MS = 48 * 60 * 60 * 1000;
const DEAD_STOCK_MS = 90 * 24 * 60 * 60 * 1000;

function emptyFilters() {
  return { stock: [], stage: [], attr: [] };
}

function toNumber(value) {
  const parsed = Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function isYes(value) {
  return ['y', 'yes', 'true', '1', 'x'].includes(String(value ?? '').trim().toLowerCase());
}

function getStockLevel(item, profile = state.clientProfile) {
  const qty = toNumber(item.qty ?? item.quantity);
  if (qty < 0) return 'negative';
  if (qty === 0) return 'out';
  if (qty <= Number(item.reorderLevel || 0)) return 'low';
  const overstockLevel = Number(profile?.overstockLevel) || 0;
  if (overstockLevel && qty > overstockLevel) return 'over';
  return 'in';
}

// Returns null when a row carries no shipping information at all (plain stock items).
function getFulfillmentStage(item) {
  const text = `${item.status || ''} ${item.notes || ''} ${item.fulfillment || ''}`.toLowerCase();
  if (/exception|delivery issue|lost|damaged|returned to sender/.test(text)) return 'exception';
  if (/ready for label/.test(text)) return 'label';
  const shipping = getShippingStatus(item);
  if (shipping) return shipping;
  if (/fully shipped|delivered/.test(text)) return 'fully';
  if (/partially shipped/.test(text)) return 'partial';
  if (/not shipped/.test(text)) return 'not';
  if (/not received/.test(text)) return 'awaiting';
  return null;
}

function getItemAttributes(item, profile = state.clientProfile, now = Date.now()) {
  const attributes = new Set();
  const map = profile?.attributeMap || {};
  if (map.bundled) attributes.add(isYes(item[map.bundled]) ? 'bundled' : 'unbundled');
  if (map.fragile && isYes(item[map.fragile])) attributes.add('fragile');
  if (map.oversized && isYes(item[map.oversized])) attributes.add('oversized');
  const addedAt = Date.parse(item.addedAt || '');
  if (Number.isFinite(addedAt) && now - addedAt > AGED_ORDER_MS && getFulfillmentStage(item) !== 'fully') attributes.add('aged');
  const lastActivityAt = Date.parse(item.lastActivityAt || '');
  if (Number.isFinite(lastActivityAt) && now - lastActivityAt > DEAD_STOCK_MS && toNumber(item.qty ?? item.quantity) > 0) attributes.add('dead');
  return attributes;
}

function renderFilterControls(resultCount = getFilteredItems().length) {
  const filters = state.filters || emptyFilters();
  const selected = FILTER_GROUPS.flatMap((group) => group.options
    .filter(([key]) => filters[group.key].includes(key))
    .map(([key, label]) => ({ group: group.key, key, label })));

  const host = document.getElementById('filterGroups');
  if (host) {
    const focused = document.activeElement?.dataset?.key ? `${document.activeElement.dataset.group}:${document.activeElement.dataset.key}` : '';
    host.innerHTML = FILTER_GROUPS.map((group) => `
      <div class="filter-section" role="group" aria-label="${group.label}">
        <div class="filter-section-title">${group.label}</div>
        <div class="filter-options">
          ${group.options.map(([key, label]) => `<button class="filter-option" type="button" aria-pressed="${filters[group.key].includes(key)}" data-action="toggle-filter" data-group="${group.key}" data-key="${key}">${label}</button>`).join('')}
        </div>
      </div>
    `).join('');
    // Re-rendering replaces the buttons, so keep keyboard focus on the option that was toggled.
    if (focused) {
      const [groupKey, optionKey] = focused.split(':');
      host.querySelector(`[data-group="${groupKey}"][data-key="${optionKey}"]`)?.focus();
    }
  }

  const chips = document.getElementById('activeFilters');
  if (chips) {
    chips.innerHTML = selected.length
      ? selected.map((entry) => `<button class="active-filter-chip" type="button" data-action="toggle-filter" data-group="${entry.group}" data-key="${entry.key}" aria-label="Remove filter ${entry.label}">${entry.label} <span aria-hidden="true">✕</span></button>`).join('')
        + '<button class="active-filter-clear" type="button" data-action="clear-filters">Clear</button>'
      : '';
  }

  const count = document.getElementById('filterCount');
  if (count) {
    count.hidden = !selected.length;
    count.textContent = String(selected.length);
  }
  document.getElementById('filterToggle')?.classList.toggle('has-filters', selected.length > 0);
  const done = document.getElementById('filterDone');
  if (done) done.textContent = `Show ${resultCount} item${resultCount === 1 ? '' : 's'}`;
}

function setFilterPanelOpen(open) {
  const panel = document.getElementById('filterPanel');
  const toggle = document.getElementById('filterToggle');
  const backdrop = document.getElementById('filterBackdrop');
  if (!panel) return;
  panel.hidden = !open;
  if (backdrop) backdrop.hidden = !open;
  toggle?.setAttribute('aria-expanded', String(open));
  if (open) panel.querySelector('.filter-option')?.focus();
  else toggle?.focus();
}

function toggleFilter(groupKey, optionKey) {
  const group = FILTER_GROUPS.find((entry) => entry.key === groupKey);
  if (!group || !group.options.some(([key]) => key === optionKey)) return;
  const selected = state.filters[groupKey];
  state.filters[groupKey] = selected.includes(optionKey) ? selected.filter((key) => key !== optionKey) : [...selected, optionKey];
  renderTable();
}

function clearFilters() {
  state.filters = emptyFilters();
  renderTable();
}

function updateSummary() {
  const total = state.items.length;
  const clientId = state.activeClientId || state.session?.clientId || 'CL-001';
  const config = getFilterConfig(clientId);
  const totalEl = document.getElementById('s-total');
  const lowEl = document.getElementById('s-low');
  const partialEl = document.getElementById('s-partial');
  const partialCard = document.getElementById('s-partial-card');
  const outEl = document.getElementById('s-out');

  if (totalEl) totalEl.textContent = total;

  if (config.mode === 'shipping') {
    const fully = state.items.filter((item) => getItemStatus(item) === 'fully').length;
    const partial = state.items.filter((item) => getItemStatus(item) === 'partial').length;
    const not = state.items.filter((item) => getItemStatus(item) === 'not').length;

    if (lowEl) {
      lowEl.textContent = fully;
      lowEl.parentElement?.querySelector('.lbl') && (lowEl.parentElement.querySelector('.lbl').textContent = 'FULLY SHIPPED');
    }
    if (partialEl) {
      partialEl.textContent = partial;
      partialEl.parentElement?.querySelector('.lbl') && (partialEl.parentElement.querySelector('.lbl').textContent = 'PARTIALLY SHIPPED');
    }
    if (partialCard) partialCard.style.display = 'block';
    if (outEl) {
      outEl.textContent = not;
      outEl.parentElement?.querySelector('.lbl') && (outEl.parentElement.querySelector('.lbl').textContent = 'NOT SHIPPED');
    }
  } else {
    if (partialCard) partialCard.style.display = 'none';
    const low = state.items.filter((item) => getItemStatus(item) === 'low').length;
    const out = state.items.filter((item) => getItemStatus(item) === 'out').length;

    if (lowEl) lowEl.textContent = low;
    if (outEl) outEl.textContent = out;
    const lowLabel = lowEl?.parentElement?.querySelector('.lbl');
    const outLabel = outEl?.parentElement?.querySelector('.lbl');
    if (lowLabel) lowLabel.textContent = 'LOW STOCK';
    if (outLabel) outLabel.textContent = 'OUT OF STOCK';
  }
}

function getFilteredItems() {
  const query = (state.query || '').trim().toLowerCase();
  const filters = state.filters || emptyFilters();
  const now = Date.now();

  // OR within a group, AND across groups; an empty group doesn't filter.
  return state.items.filter((item) => {
    const text = `${item.sku || ''} ${item.title || ''} ${item.category || ''} ${item.location || ''}`.toLowerCase();
    if (query && !text.includes(query)) return false;
    if (filters.stock.length && !filters.stock.includes(getStockLevel(item))) return false;
    if (filters.stage.length && !filters.stage.includes(getFulfillmentStage(item))) return false;
    if (filters.attr.length) {
      const attributes = getItemAttributes(item, state.clientProfile, now);
      if (!filters.attr.some((key) => attributes.has(key))) return false;
    }
    return true;
  });
}

function syncDashboardColumns() {
  const headerRow = document.getElementById('inventoryHeaderRow');
  const profile = state.clientProfile;

  if (headerRow) {
    const columns = (profile && profile.dashboardColumns && profile.dashboardColumns.length)
      ? profile.dashboardColumns
      : ['PRODUCT TITLE', 'QTY', 'STATUS', 'EDIT'];

    headerRow.innerHTML = columns.map((label) => {
      const centered = ['QTY', 'STATUS', 'EDIT'].includes(label);
      return `<th${centered ? ' class="center"' : ''}>${label}</th>`;
    }).join('');
  }

  scheduleTableScrollUpdate();
}

let tableScrollFrame = null;

function scheduleTableScrollUpdate() {
  if (tableScrollFrame !== null || !document.getElementById('inventoryTableWrap')) return;
  const nextFrame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (callback) => setTimeout(callback, 16);
  tableScrollFrame = nextFrame(() => {
    tableScrollFrame = null;
    updateTableScrollButtons();
  });
}

function updateTableScrollButtons() {
  const tableWrap = document.getElementById('inventoryTableWrap');
  const leftButton = document.getElementById('tableScrollLeft');
  const rightButton = document.getElementById('tableScrollRight');
  if (!tableWrap || !leftButton || !rightButton) return;

  const canScroll = tableWrap.scrollWidth > tableWrap.clientWidth + 2;
  const atStart = tableWrap.scrollLeft <= 2;
  const atEnd = tableWrap.scrollLeft + tableWrap.clientWidth >= tableWrap.scrollWidth - 2;

  leftButton.classList.toggle('visible', canScroll);
  rightButton.classList.toggle('visible', canScroll);
  leftButton.classList.toggle('disabled', atStart);
  rightButton.classList.toggle('disabled', atEnd);
  leftButton.disabled = !canScroll || atStart;
  rightButton.disabled = !canScroll || atEnd;
}

function scrollInventoryTable(direction) {
  const tableWrap = document.getElementById('inventoryTableWrap');
  if (!tableWrap) return;
  const step = Math.max(220, tableWrap.clientWidth * 0.7);
  tableWrap.scrollBy({ left: direction * step, behavior: 'smooth' });
}

function renderTable() {
  const items = getFilteredItems();
  renderFilterControls(items.length);
  if (isPageActive('page-logs')) renderLogs();
  if (!inventoryBody) return;

  syncDashboardColumns();
  const profile = state.clientProfile;
  const fields = (profile && profile.fields) || [];
  const dashboardFieldKeys = (profile && profile.dashboardFieldKeys) || fields.map((field) => field.key);
  const showQty = !(profile && profile.hideQtyColumn);
  const showEdit = !(profile && (profile.readOnly || profile.hideQuickEdit));
  const columnCount = (profile && profile.dashboardColumns && profile.dashboardColumns.length) || (2 + fields.length);

  if (!items.length) {
    inventoryBody.innerHTML = `<tr><td colspan="${columnCount}" class="no-results">No items match your filters.</td></tr>`;
    return;
  }

  inventoryBody.innerHTML = items.map((item) => {
    const status = getItemStatus(item);
    const badgeClass = getStatusBadgeClass(status);

    // Clients whose custom fields aren't broken out into their own dashboard columns
    // (e.g. CL-003's tracking/carrier) still get a quick summary under the title.
    const metaFields = dashboardFieldKeys.length ? [] : fields.slice(0, 2);
    const metaText = metaFields.length
      ? `<div style="font-size:10px;color:#64748b;margin-top:4px;">${metaFields.map((field) => `${field.label}: ${item[field.key] || '—'}`).join(' • ')}</div>`
      : '';

    const fieldCells = dashboardFieldKeys.map((key) => `<td>${item[key] ?? '—'}</td>`).join('');
    const qtyCell = showQty ? `<td class="qty-cell">${item.qty ?? item.quantity ?? 0}</td>` : '';
    const editCell = showEdit ? `
      <td class="center">
        <div class="quick-edit">
          <button class="qe-btn minus" type="button" data-action="adjust" data-direction="-1" data-id="${item.id}">−</button>
          <button class="qe-btn plus" type="button" data-action="adjust" data-direction="1" data-id="${item.id}">＋</button>
        </div>
      </td>
    ` : '';

    return `
      <tr>
        <td class="title-cell">${item.title || '—'}${metaText}</td>
        ${fieldCells}
        ${qtyCell}
        <td><span class="badge ${badgeClass}">${getStatusText(status)}</span></td>
        ${editCell}
      </tr>
    `;
  }).join('');
}

function renderChatMessages() {
  if (!msgBox) return;
  // Messages still being sent are shown right away from local state, then replaced by the saved copy.
  const pending = (state.pendingMessages || []).filter((entry) => entry.clientId === state.activeClientId);
  const messages = [...(Array.isArray(state.messages) ? state.messages : []), ...pending];
  const atBottom = msgBox.scrollHeight - msgBox.scrollTop - msgBox.clientHeight < 60;
  const typingIndicator = document.getElementById('typingIndicator');
  if (typingIndicator) {
    typingIndicator.style.display = 'none';
  }

  if (!messages.length) {
    msgBox.innerHTML = '<div class="no-results" style="padding:20px;">No messages yet.</div>';
    return;
  }

  const isCurrentUserStaff = Boolean(state.session && (String(state.session.role || '').toLowerCase() === 'admin' || String(state.session.clientId || '').toUpperCase() === 'CL-000'));

  msgBox.innerHTML = messages.map((message) => {
    const messageIsStaff = message.isStaff === true;
    const isMine = messageIsStaff === isCurrentUserStaff;
    const senderLabel = escapeHtml(isMine ? 'Me' : (messageIsStaff ? (message.sender || 'Admin') : (message.sender || 'Client')));
    const fileUrl = String(message.fileUrl || '').trim();
    const fileName = String(message.fileName || 'Shared file').trim();
    const fileMarkup = isGoogleDriveUrl(fileUrl)
      ? `<div class="msg-file"><a href="${escapeHtml(fileUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(fileName || 'Open shared file')}</a></div>`
      : '';
    const statusMarkup = message.localId
      ? (message.status === 'failed'
        ? `<span class="msg-status failed">Not sent · <button type="button" class="msg-retry" data-action="chat-retry" data-id="${escapeHtml(message.localId)}">Retry</button></span>`
        : '<span class="msg-status">Sending…</span>')
      : '';
    return `
      <div class="msg-wrap ${isMine ? 'me' : 'them'}${message.localId ? ' pending' : ''}">
        <div class="msg-meta"><span>${senderLabel}</span>${statusMarkup}</div>
        <div class="msg-bubble">${escapeHtml(message.message)}${fileMarkup}</div>
      </div>
    `;
  }).join('');

  if (atBottom) msgBox.scrollTop = msgBox.scrollHeight;
}

async function loadChatMessages(clientId = state.activeClientId || state.session?.clientId || 'CL-001') {
  const requestId = ++chatRequestId;
  const session = state.session;
  try {
    const response = await fetch(`${CHAT_URL}?clientId=${encodeURIComponent(clientId)}`, {
      headers: adminHeaders({ Accept: 'application/json' }),
      signal: viewSignal()
    });

    if (!response.ok) return response.status;

    const payload = await response.json();
    if (Array.isArray(payload)) {
      cacheClientView(clientId, { messages: payload, chatSignature: JSON.stringify(payload) });
    }
    if (requestId === chatRequestId && state.auth && state.session === session && state.activeClientId === clientId && Array.isArray(payload)) {
      const signature = JSON.stringify(payload);
      if (signature !== chatSignature) {
        chatSignature = signature;
        state.messages = payload;
        renderChatMessages();
      }
    }
    return 200;
  } catch (error) {
    return 0;
  }
}

function clearLoginError() {
  if (loginErrorMsg) {
    loginErrorMsg.textContent = '';
    loginErrorMsg.style.display = 'none';
  }
}

function showAuthScreen(screen) {
  const windows = {
    login: document.getElementById('portalLoginWindow'),
    activate: document.getElementById('activateAccountWindow'),
    recover: document.getElementById('recoverAccountWindow')
  };
  Object.entries(windows).forEach(([key, el]) => {
    if (el) el.style.display = key === screen ? 'flex' : 'none';
  });

  ['activateErrorMsg', 'recoverErrorMsg'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) { el.textContent = ''; el.style.display = 'none'; }
  });
}

function showAuthError(elementId, message) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.textContent = message;
  el.style.display = 'block';
}

async function submitActivateAccount() {
  const username = String(document.getElementById('activateUsername')?.value || '').trim();
  const activationCode = String(document.getElementById('activateCode')?.value || '').trim();
  const password = String(document.getElementById('activatePassword')?.value || '');
  const confirmPassword = String(document.getElementById('activatePasswordConfirm')?.value || '');

  if (!username || !activationCode || !password) {
    showAuthError('activateErrorMsg', 'Fill in your username, activation code, and a new password.');
    return;
  }
  if (password.length < 8) {
    showAuthError('activateErrorMsg', 'Password must be at least 8 characters.');
    return;
  }
  if (password !== confirmPassword) {
    showAuthError('activateErrorMsg', 'Passwords do not match.');
    return;
  }

  try {
    const response = await fetch(ACTIVATE_ACCOUNT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, activationCode, password })
    });
    const result = await response.json().catch(() => ({ success: false }));
    if (!response.ok || !result.success) {
      throw new Error(result.error || 'Unable to create account.');
    }

    document.getElementById('activateFormFields').style.display = 'none';
    document.getElementById('activateSuccessPanel').style.display = 'block';
    document.getElementById('activateRecoveryCode').textContent = result.recoveryCode;
    if (portalUser) portalUser.value = username;
  } catch (error) {
    showAuthError('activateErrorMsg', error.message || 'Unable to create account.');
  }
}

function finishActivateAccount() {
  document.getElementById('activateFormFields').style.display = 'block';
  document.getElementById('activateSuccessPanel').style.display = 'none';
  ['activateUsername', 'activateCode', 'activatePassword', 'activatePasswordConfirm'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  showAuthScreen('login');
}

async function submitRecoverAccount() {
  const username = String(document.getElementById('recoverUsername')?.value || '').trim();
  const recoveryCode = String(document.getElementById('recoverCode')?.value || '').trim();
  const newPassword = String(document.getElementById('recoverPassword')?.value || '');
  const confirmPassword = String(document.getElementById('recoverPasswordConfirm')?.value || '');

  if (!username || !recoveryCode || !newPassword) {
    showAuthError('recoverErrorMsg', 'Fill in your username, recovery code, and a new password.');
    return;
  }
  if (newPassword.length < 8) {
    showAuthError('recoverErrorMsg', 'Password must be at least 8 characters.');
    return;
  }
  if (newPassword !== confirmPassword) {
    showAuthError('recoverErrorMsg', 'Passwords do not match.');
    return;
  }

  try {
    const response = await fetch(RECOVER_ACCOUNT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, recoveryCode, newPassword })
    });
    const result = await response.json().catch(() => ({ success: false }));
    if (!response.ok || !result.success) {
      throw new Error(result.error || 'Unable to reset password.');
    }

    document.getElementById('recoverFormFields').style.display = 'none';
    document.getElementById('recoverSuccessPanel').style.display = 'block';
    document.getElementById('recoverRecoveryCode').textContent = result.recoveryCode;
    if (portalUser) portalUser.value = username;
  } catch (error) {
    showAuthError('recoverErrorMsg', error.message || 'Unable to reset password.');
  }
}

function finishRecoverAccount() {
  document.getElementById('recoverFormFields').style.display = 'block';
  document.getElementById('recoverSuccessPanel').style.display = 'none';
  ['recoverUsername', 'recoverCode', 'recoverPassword', 'recoverPasswordConfirm'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  showAuthScreen('login');
}

async function fetchInventory(clientId = state.activeClientId || state.session?.clientId || 'CL-001') {
  const targetClientId = String(clientId || '').trim() || 'CL-001';
  const inventoryUrl = `${API_URL}?clientId=${encodeURIComponent(targetClientId)}`;
  const requestId = ++inventoryRequestId;
  const session = state.session;

  try {
    const response = await fetch(inventoryUrl, {
      headers: { Accept: 'application/json' },
      signal: viewSignal()
    });

    if (!response.ok) return response.status;

    const result = await response.json();
    if (Array.isArray(result)) {
      cacheClientView(targetClientId, {
        items: result.map((item) => normalizeInventoryItem(item, targetClientId)),
        itemsSignature: JSON.stringify(result)
      });
    }
    if (requestId === inventoryRequestId && state.auth && state.session === session && state.activeClientId === targetClientId && Array.isArray(result)) {
      const signature = JSON.stringify(result);
      if (signature !== inventorySignature) {
        inventorySignature = signature;
        state.items = result.map((item) => normalizeInventoryItem(item, targetClientId));
        updateSummary();
        renderTable();
      }
    }
    return 200;
  } catch (error) {
    return 0;
  }
}

async function fetchClientRoster() {
  try {
    const response = await fetch(CLIENTS_URL, {
      headers: adminHeaders({ Accept: 'application/json' })
    });

    if (!response.ok) {
      throw new Error('Unable to load client roster');
    }

    const roster = await response.json();
    state.roster = Array.isArray(roster) ? roster : [];
    renderAdminSwitcher();
    return state.roster;
  } catch (error) {
    state.roster = [];
    renderAdminSwitcher();
    return [];
  }
}

function renderAdminSwitcher() {
  const switcher = document.getElementById('adminSwitcher');
  const buttonHost = document.getElementById('adminSwitcherBtns');
  if (!switcher || !buttonHost) return;

  if (!state.isAdmin || !state.roster.length) {
    switcher.classList.remove('show');
    buttonHost.innerHTML = '';
    return;
  }

  buttonHost.innerHTML = state.roster.map((client) => `
    <button
      class="admin-switcher-btn ${state.activeClientId === client.clientId ? 'active' : ''}"
      type="button"
      data-client-id="${client.clientId}"
      onclick="switchClientView('${client.clientId}', '${(client.clientName || client.clientId || 'Client').replace(/'/g, "\\'")}')"
    >
      ${client.clientName || client.clientId}
    </button>
  `).join('');

  switcher.classList.add('show');
}

function getCurrentClientLabel() {
  const clientId = state.activeClientId || state.session?.clientId || 'CL-001';
  if (state.roster && state.roster.length) {
    const match = state.roster.find((entry) => String(entry.clientId || '').toUpperCase() === String(clientId || '').toUpperCase());
    if (match && match.clientName) return match.clientName;
  }
  if (state.session?.clientName && (!state.isAdmin || String(state.session.clientId || '').toUpperCase() === String(clientId || '').toUpperCase())) {
    return state.session.clientName;
  }
  return getClientInventoryFields(clientId).label || 'Client';
}

function renderClientHeader() {
  const header = document.getElementById('activeClientHeader');
  const identity = document.getElementById('displayIdentity');
  const clientLabel = getCurrentClientLabel();
  const clientId = state.activeClientId || state.session?.clientId || 'CL-001';

  if (header) {
    header.textContent = `CLIENT: ${String(clientLabel || clientId || 'CLIENT').toUpperCase()}`;
  }

  if (identity) {
    const role = state.session?.role || (state.isAdmin ? 'admin' : 'client');
    identity.textContent = `${clientLabel || clientId || 'Client'} (${role})`;
  }
}

function renderDriveFolderLink() {
  const link = document.getElementById('driveFolderLink');
  if (!link) return;
  const clientId = state.activeClientId || state.session?.clientId || '';
  const folderUrl = getChatDriveFolderForClient(clientId);
  if (folderUrl) {
    link.href = folderUrl;
    link.removeAttribute('aria-disabled');
    link.classList.remove('drive-link-disabled');
    link.textContent = `Open ${getClientInventoryFields(clientId).label || 'Client'} Drive Folder`;
    return;
  }
  link.removeAttribute('href');
  link.setAttribute('aria-disabled', 'true');
  link.classList.add('drive-link-disabled');
  const profile = state.clientProfile && state.clientProfile.clientId === clientId ? state.clientProfile : null;
  link.textContent = !profile ? 'Drive folder unavailable'
    : !profile.driveFolderUrl ? 'No Drive folder on file for this account'
      : 'Drive folder needs an email on file for this account';
}

function syncAddTabVisibility() {
  const clientId = state.activeClientId || state.session?.clientId || 'CL-001';
  const config = getClientInventoryFields(clientId);
  const shouldShow = Boolean(config && !config.readOnly && !config.requirePin);
  ['tabOrder'].forEach((id) => {
    const tab = document.getElementById(id);
    if (tab) tab.style.display = shouldShow ? 'block' : 'none';
  });
}

const ITEM_FORMS = {
  inventory: { prefix: 'newProduct', fieldPrefix: 'customField_', fieldsHost: 'customProductFields', submit: 'createProductSubmit', notice: 'createProductReadOnlyNotice' }
};

// Custom fields for one form, minus any the admin switched off and, for clients, the staff-only received/shipped counts.
function getFormFields(clientId, kind) {
  const profile = state.clientProfile && state.clientProfile.clientId === clientId ? state.clientProfile : null;
  const visibility = (profile && profile.fieldVisibility) || {};
  const shipment = state.isAdmin ? null : getShipmentFieldKeys(clientId);
  return getVisibleClientFields(clientId, state.isAdmin)
    .filter((field) => !visibility[field.key] || visibility[field.key][kind] !== false)
    .filter((field) => !shipment || (field.key !== shipment.received && field.key !== shipment.shipped));
}

function syncCreateFormLayout() {
  const clientId = state.activeClientId || state.session?.clientId || 'CL-001';
  const titleConfig = getCreateFormTitleConfig(clientId);
  const isCardClient = clientId === 'CL-003';

  Object.values(ITEM_FORMS).forEach(({ prefix }) => {
    const skuWrap = document.getElementById(`${prefix}SkuWrap`);
    const skuInput = document.getElementById(`${prefix}Sku`);
    const titleWrap = document.getElementById(`${prefix}TitleWrap`);
    const titleLabel = document.getElementById(`${prefix}TitleLabel`);
    const titleInput = document.getElementById(`${prefix}Title`);

    if (skuWrap) skuWrap.style.display = isCardClient ? 'none' : 'block';
    if (skuInput) skuInput.disabled = isCardClient;
    if (titleWrap) titleWrap.style.display = titleConfig.visible ? 'block' : 'none';
    if (titleLabel) titleLabel.textContent = titleConfig.label;
    if (titleInput) {
      titleInput.placeholder = titleConfig.placeholder;
      if (!titleConfig.visible) titleInput.value = '';
    }
  });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function renderFieldInputs(fields, idPrefix) {
  const labelStyle = 'display:block;font-size:11px;font-weight:700;color:#475569;margin-bottom:6px;';
  const commonStyle = 'width:100%;padding:10px 12px;border:1px solid #dfe7f1;border-radius:8px;';
  return fields.map((field) => {
    const fieldId = escapeHtml(`${idPrefix}${field.key}`);
    const label = escapeHtml(field.label);
    const isReadOnlyField = Boolean(field.readOnly) && !state.isAdmin;
    const samplePlaceholder = escapeHtml(getClientFieldPlaceholder(field, state.items));

    if (field.type === 'select') {
      const options = (field.options || []).map((option) => {
        const value = escapeHtml(option || '');
        return `<option value="${value}">${value || '—'}</option>`;
      }).join('');
      return `
        <div>
          <label style="${labelStyle}">${label}</label>
          <select id="${fieldId}" style="${commonStyle}" data-placeholder="${samplePlaceholder}" ${isReadOnlyField ? 'disabled' : ''}>${options}</select>
        </div>
      `;
    }

    if (field.type === 'textarea') {
      return `
        <div style="grid-column:1 / -1;">
          <label style="${labelStyle}">${label}</label>
          <textarea id="${fieldId}" placeholder="${samplePlaceholder}" style="${commonStyle};min-height:84px;resize:vertical;" ${isReadOnlyField ? 'readonly' : ''}></textarea>
        </div>
      `;
    }

    return `
      <div>
        <label style="${labelStyle}">${label}</label>
        <input type="${field.type === 'number' ? 'number' : 'text'}" id="${fieldId}" placeholder="${samplePlaceholder}" style="${commonStyle}" ${isReadOnlyField ? 'readonly' : ''} />
      </div>
    `;
  }).join('');
}

function renderProductForm() {
  const clientId = state.activeClientId || state.session?.clientId || 'CL-001';
  const config = getClientInventoryFields(clientId);

  syncAddTabVisibility();
  syncCreateFormLayout();

  const skuSample = getInventoryFieldSample(state.items, 'sku');
  const titleSample = getInventoryFieldSample(state.items, 'title');

  Object.entries(ITEM_FORMS).forEach(([kind, form]) => {
    const skuInput = document.getElementById(`${form.prefix}Sku`);
    const titleInput = document.getElementById(`${form.prefix}Title`);
    if (skuInput && !skuInput.dataset.userTyped) skuInput.placeholder = skuSample ? `e.g. ${skuSample}` : 'A-25-Cu-01';
    if (titleInput && !titleInput.dataset.userTyped) titleInput.placeholder = titleSample ? `e.g. ${titleSample}` : 'Copper Marker';

    const host = document.getElementById(form.fieldsHost);
    if (host) host.innerHTML = renderFieldInputs(getFormFields(clientId, kind), form.fieldPrefix);

    const notice = document.getElementById(form.notice);
    if (notice) {
      notice.style.display = config.readOnly ? 'block' : 'none';
      notice.textContent = config.readOnly
        ? 'This client is in view-only mode. Inventory is locked and cannot be added to directly.'
        : '';
    }

    const submitBtn = document.getElementById(form.submit);
    if (submitBtn) {
      submitBtn.disabled = Boolean(config.readOnly);
      submitBtn.textContent = config.readOnly ? 'Locked' : 'Add';
      submitBtn.style.opacity = config.readOnly ? '0.6' : '1';
    }
  });
}

function switchClientView(clientId) {
  const nextClientId = String(clientId || '').trim().toUpperCase();
  if (!nextClientId) return Promise.resolve();

  stopBackgroundSync();
  resetViewRequests();
  notificationRequestId += 1;
  inventoryRequestId += 1;
  chatRequestId += 1;

  const cached = clientViewCache.get(nextClientId) || {};
  state.activeClientId = nextClientId;
  state.filters = emptyFilters();
  state.quickEditUnlock = null;
  state.billing = null;
  state.billingEditId = null;
  state.historyEditId = null;
  state.rateCardClientId = null;
  // A product picked on the Update page belongs to the previous client; never adjust it under the new one.
  state.selectedItemId = null;
  if (selectedItem) selectedItem.style.display = 'none';
  if (searchInput) searchInput.value = '';
  if (searchResults) {
    searchResults.style.display = 'none';
    searchResults.innerHTML = '';
  }
  state.query = '';
  state.clientProfile = cached.profile || null;
  state.items = cached.items || [];
  state.messages = cached.messages || [];
  inventorySignature = cached.itemsSignature || null;
  chatSignature = cached.chatSignature || null;
  state.notifications = { chat: 0, inventory: 0, total: 0, items: [] };
  if (tableSearch) tableSearch.value = '';

  renderNotifications();
  renderClientHeader();
  renderAdminSwitcher();
  renderDriveFolderLink();
  renderProductForm();
  updateSummary();
  renderTable();
  renderChatMessages();
  renderBilling();

  clearTimeout(switchTimer);
  const sequence = ++switchSequence;
  saveSession();
  // Rapid clicks through several clients only hit Google Sheets for the one the admin lands on.
  return new Promise((resolve) => {
    switchTimer = setTimeout(async () => {
      if (sequence !== switchSequence) return resolve();
      const chatOpen = document.getElementById('page-chat')?.classList.contains('active');
      await Promise.all([
        fetchClientProfile(nextClientId).then(() => {
          if (sequence !== switchSequence) return;
          renderDriveFolderLink();
          renderProductForm();
          renderTable();
        }),
        fetchInventory(nextClientId),
        chatOpen ? loadChatMessages(nextClientId) : null,
        isPageActive('page-billing') ? loadBillingSummary(nextClientId) : null
      ]);
      if (sequence !== switchSequence) return resolve();
      fetchNotifications(nextClientId);
      startBackgroundSync();
      resolve();
    }, SWITCH_DEBOUNCE_MS);
  });
}

async function executePortalAuth() {
  const username = (portalUser?.value || '').trim();
  const password = (portalPass?.value || '').trim();

  if (!username || !password) {
    if (loginErrorMsg) {
      loginErrorMsg.textContent = 'Please enter your username and password.';
      loginErrorMsg.style.display = 'block';
    }
    return;
  }

  clearLoginError();

  try {
    const response = await fetch(LOGIN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const result = await response.json().catch(() => ({ success: false, error: 'Login failed' }));
    if (!response.ok || !result.success) {
      throw new Error(result.error || 'Login failed');
    }

    await startSession(result);
    showToast('Signed in successfully', 'success');
  } catch (error) {
    if (loginErrorMsg) {
      loginErrorMsg.textContent = error.message || 'Unable to sign in.';
      loginErrorMsg.style.display = 'block';
    }
  }
}

const SAVED_SESSION_KEY = 'eclPortalSession';
const RESTORABLE_PAGES = ['page-dashboard', 'page-logs', 'page-chat', 'page-billing', 'page-clients'];

function readTokenExpiry(token) {
  try {
    const payload = String(token || '').split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
    return Number(JSON.parse(atob(payload)).expires) || 0;
  } catch (error) {
    return 0;
  }
}

// Storage can be unavailable (private mode, blocked cookies); the portal still works, it just won't remember the sign-in.
function saveSession() {
  if (!state.auth || !state.session) return;
  try {
    const page = document.querySelector('.page.active')?.id || 'page-dashboard';
    localStorage.setItem(SAVED_SESSION_KEY, JSON.stringify({ session: state.session, activeClientId: state.activeClientId, page }));
  } catch (error) {
    // Ignore storage failures.
  }
}

function loadSavedSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVED_SESSION_KEY) || 'null');
    if (saved?.session?.notificationToken && readTokenExpiry(saved.session.notificationToken) > Date.now()) return saved;
  } catch (error) {
    // Fall through and clear anything unreadable.
  }
  clearSavedSession();
  return null;
}

function clearSavedSession() {
  try {
    localStorage.removeItem(SAVED_SESSION_KEY);
  } catch (error) {
    // Ignore storage failures.
  }
}

function handleExpiredSession() {
  if (!state.auth) return;
  executePortalLogout('Your session expired. Please sign in again.');
}

async function startSession(result, saved = null) {
  state.session = result;
  state.auth = true;
  state.isAdmin = String(result.role || '').toLowerCase() === 'admin' || String(result.clientId || '').toUpperCase() === 'CL-000';
  state.activeClientId = String(result.clientId || '').trim().toUpperCase() || 'CL-001';
  state.roster = [];
  state.pinUnlocked = false;
  lastInteractionAt = Date.now();
  idlePaused = false;

  renderClientHeader();

  if (portalLoginWindow) portalLoginWindow.style.display = 'none';
  setPage('page-dashboard');

  const tabClients = document.getElementById('tabClients');
  if (tabClients) tabClients.style.display = state.isAdmin ? 'block' : 'none';

  if (state.isAdmin) {
    const roster = await fetchClientRoster();
    if (roster.length) {
      const preferred = roster.find((client) => String(client.clientId || '').toUpperCase() === saved?.activeClientId) || roster[0];
      state.activeClientId = String(preferred.clientId || '').trim().toUpperCase();
      renderClientHeader();
    }
  }

  const firstClientId = state.activeClientId;
  const [, , notificationStatus] = await Promise.all([
    fetchClientProfile(firstClientId),
    fetchInventory(firstClientId),
    fetchNotifications(firstClientId)
  ]);
  if (notificationStatus === 401) {
    handleExpiredSession();
    return;
  }
  renderDriveFolderLink();
  renderProductForm();
  renderTable();
  startBackgroundSync();
  await syncBillingTab();

  const page = saved?.page;
  const billingTab = document.getElementById('tabBilling');
  const allowed = RESTORABLE_PAGES.includes(page)
    && (page !== 'page-clients' || state.isAdmin)
    && (page !== 'page-billing' || billingTab?.style.display !== 'none');
  if (allowed && page !== 'page-dashboard') showPage(page.replace('page-', ''));
  saveSession();
}

async function restoreSavedSession() {
  const saved = loadSavedSession();
  if (!saved) return;
  try {
    await startSession(saved.session, saved);
  } catch (error) {
    console.error('Could not restore session:', error);
  }
}

function executePortalLogout(message = '') {
  clearSavedSession();
  stopBackgroundSync();
  resetViewRequests();
  clearTimeout(switchTimer);
  switchSequence += 1;
  clientViewCache.clear();
  chatRequestId += 1;
  inventoryRequestId += 1;
  notificationRequestId += 1;
  chatSignature = null;
  inventorySignature = null;
  state.auth = false;
  state.session = null;
  state.isAdmin = false;
  state.roster = [];
  state.activeClientId = null;
  state.selectedItemId = null;
  state.pinUnlocked = false;
  state.quickEditUnlock = null;
  state.filters = emptyFilters();
  state.pendingMessages = [];
  state.billing = null;
  state.billingEditId = null;
  state.historyEditId = null;
  state.rateCardClientId = null;
  syncBillingTab();
  renderBilling();
  state.messages = [];
  state.notifications = { chat: 0, inventory: 0, total: 0, items: [] };
  document.getElementById('notificationPanel') && (document.getElementById('notificationPanel').style.display = 'none');
  ['filterPanel', 'filterBackdrop'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  });
  renderNotifications();
  state.items = [];
  state.clientProfile = null;
  renderChatMessages();
  renderAdminSwitcher();
  renderDriveFolderLink();
  renderProductForm();
  const tabClients = document.getElementById('tabClients');
  if (tabClients) tabClients.style.display = 'none';
  const header = document.getElementById('activeClientHeader');
  if (header) header.textContent = 'CLIENT: —';
  if (document.getElementById('displayIdentity')) {
    document.getElementById('displayIdentity').textContent = '—';
  }
  if (portalLoginWindow) portalLoginWindow.style.display = 'flex';
  clearLoginError();
  if (portalUser) portalUser.value = '';
  if (portalPass) portalPass.value = '';
  document.querySelectorAll('[data-action="toggle-password"][aria-pressed="true"]').forEach(togglePasswordVisibility);
  setPage('page-dashboard');
  updateSummary();
  renderTable();
  if (message && loginErrorMsg) {
    loginErrorMsg.textContent = message;
    loginErrorMsg.style.display = 'block';
  }
  showToast(message || 'Signed out', message ? 'error' : 'success');
}

function openPinPrompt(cb, mode = 'page') {
  state.pendingPinAction = cb;
  state.pinMode = mode;
  const quickEdit = mode === 'quick-edit';
  const title = document.getElementById('pinTitle');
  const message = document.getElementById('pinMessage');
  if (title) title.textContent = quickEdit ? 'Quick Edit Locked' : 'Protected Action';
  if (message) message.textContent = quickEdit ? "Enter this account's Quick Edit PIN to change quantities." : 'Enter your 3-digit PIN to continue';
  if (pinOverlay) pinOverlay.style.display = 'flex';
  if (pinInput) {
    pinInput.maxLength = quickEdit ? 32 : 3;
    pinInput.inputMode = quickEdit ? 'text' : 'numeric';
    pinInput.placeholder = quickEdit ? 'PIN' : '•••';
    pinInput.value = '';
    pinInput.focus();
  }
}

function closePinPrompt() {
  if (pinOverlay) pinOverlay.style.display = 'none';
  state.pendingPinAction = null;
  state.pinMode = 'page';
}

function quickEditHeaders(clientId) {
  const unlock = state.quickEditUnlock;
  return unlock && unlock.clientId === clientId && unlock.expiresAt > Date.now() ? { 'X-Quick-Edit-Token': unlock.token } : {};
}

async function unlockQuickEdit(pin) {
  if (state.pinBusy || !pin) return;
  state.pinBusy = true;
  const clientId = state.activeClientId;
  try {
    const response = await fetch(QUICK_EDIT_UNLOCK_URL, {
      method: 'POST',
      headers: adminHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ clientId, pin })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.success) throw new Error(result.error || 'Incorrect PIN');
    state.quickEditUnlock = { clientId, token: result.token, expiresAt: result.expiresAt };
    const action = state.pendingPinAction;
    closePinPrompt();
    showToast('Quick Edit unlocked', 'success');
    if (typeof action === 'function' && clientId === state.activeClientId) action();
  } catch (error) {
    showToast(error.message || 'Incorrect PIN', 'error');
    if (pinInput) {
      pinInput.value = '';
      pinInput.focus();
    }
  } finally {
    state.pinBusy = false;
  }
}

function verifyPinPrompt() {
  const value = (pinInput?.value || '').trim();
  if (state.pinMode === 'quick-edit') {
    unlockQuickEdit(value);
    return;
  }
  if (value === '646') {
    state.pinUnlocked = true;
    closePinPrompt();
    showToast('Access granted', 'success');
    if (typeof state.pendingPinAction === 'function') {
      const action = state.pendingPinAction;
      state.pendingPinAction = null;
      action();
    }
    return;
  }

  showToast('Incorrect PIN', 'error');
  if (pinInput) {
    pinInput.value = '';
    pinInput.focus();
  }
}

function requestUpdatePage() {
  const clientId = state.activeClientId || state.session?.clientId || 'CL-001';
  const config = getClientInventoryFields(clientId);

  if (!config.readOnly && !config.requirePin) {
    setPage('page-update');
    return;
  }

  if (state.pinUnlocked) {
    setPage('page-update');
    return;
  }

  openPinPrompt(() => setPage('page-update'));
}

function goToAddOrder() {
  const clientId = state.activeClientId || state.session?.clientId || 'CL-001';
  const config = getClientInventoryFields(clientId);
  if ((!config.readOnly && !config.requirePin) || state.pinUnlocked) {
    setPage('page-order');
    return;
  }
  openPinPrompt(() => setPage('page-order'));
}

function goToDashboard() {
  setPage('page-dashboard');
  updateSummary();
  renderTable();
}

function goToLogs() {
  setPage('page-logs');
  renderLogs();
}

// Re-run from renderTable so the log always reflects the client currently selected.
function renderLogs() {
  if (!logTableWrap) return;
  const value = (document.getElementById('logSearch')?.value || '').trim().toLowerCase();
  const rows = getFilteredItems().filter((item) => !value || `${item.sku} ${item.title}`.toLowerCase().includes(value));
  logTableWrap.innerHTML = rows.length
    ? rows.map((item) => `
        <div class="log-entry">
          <span class="log-ts">${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          <span class="log-sku">${escapeHtml(item.sku || 'N/A')}</span>
          <span class="log-desc">${escapeHtml(item.title || 'Inventory update')}</span>
          <span class="log-change ${getItemStatus(item) === 'out' ? 'rem' : 'add'}">${getStatusText(getItemStatus(item))}</span>
        </div>
      `).join('')
    : `<div class="no-results" style="padding:30px;">${value ? 'No matching log entries.' : 'No activity to display.'}</div>`;
}

function insertEmoji(emoji) {
  if (!msgInput) return;
  const start = msgInput.selectionStart || 0;
  const end = msgInput.selectionEnd || 0;
  const text = msgInput.value;
  msgInput.value = `${text.slice(0, start)}${emoji}${text.slice(end)}`;
  msgInput.focus();
  msgInput.setSelectionRange(start + emoji.length, start + emoji.length);
}

async function submitMessage() {
  if (!msgInput) return;
  const text = msgInput.value.trim();
  if (!text) return;

  const fileInput = document.getElementById('chatFileUrl');
  const rawFileUrl = (fileInput?.value || '').trim();
  const fileUrl = rawFileUrl || '';
  if (fileUrl && !isGoogleDriveUrl(fileUrl)) {
    showToast('Shared files must be Google Drive links', 'error');
    return;
  }
  const fileName = fileUrl ? (fileUrl.split('/').pop() || 'Shared file') : '';

  const isStaff = Boolean(state.session && (String(state.session.role || '').toLowerCase() === 'admin' || String(state.session.clientId || '').toUpperCase() === 'CL-000'));
  const entry = {
    localId: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    status: 'sending',
    clientId: state.activeClientId || state.session?.clientId || 'CL-001',
    sender: state.session?.clientName || state.session?.clientId || 'User',
    message: text,
    isStaff,
    fileUrl,
    fileName
  };

  // Show the message and clear the box immediately; saving to the sheet happens in the background.
  state.pendingMessages.push(entry);
  msgInput.value = '';
  if (fileInput) fileInput.value = '';
  renderChatMessages();
  msgBox.scrollTop = msgBox.scrollHeight;
  sendPendingMessage(entry);
}

async function sendPendingMessage(entry) {
  entry.status = 'sending';
  renderChatMessages();
  const session = state.session;
  try {
    const response = await fetch(CHAT_URL, {
      method: 'POST',
      headers: adminHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        clientId: entry.clientId, sender: entry.sender, message: entry.message, isStaff: entry.isStaff, fileUrl: entry.fileUrl, fileName: entry.fileName
      })
    });
    const result = await response.json().catch(() => ({ success: response.ok }));
    if (!response.ok || !result.success) throw new Error(result.error || 'Message failed to send');
  } catch (error) {
    if (state.session !== session) return;
    entry.status = 'failed';
    renderChatMessages();
    showToast(error.message || 'Message failed to send', 'error');
    return;
  }

  if (state.session !== session) return;
  chatSignature = null;
  const refreshed = entry.clientId === state.activeClientId ? await loadChatMessages(entry.clientId) : 0;
  if (refreshed !== 200 && entry.clientId === state.activeClientId) {
    state.messages.push({ sender: entry.sender, message: entry.message, clientId: entry.clientId, isStaff: entry.isStaff, fileUrl: entry.fileUrl, fileName: entry.fileName });
  }
  state.pendingMessages = state.pendingMessages.filter((item) => item !== entry);
  renderChatMessages();
}

function retryPendingMessage(localId) {
  const entry = state.pendingMessages.find((item) => item.localId === localId);
  if (entry && entry.status === 'failed') sendPendingMessage(entry);
}

function filterSearch() {
  const input = document.getElementById('searchInput');
  const query = (input?.value || '').trim().toLowerCase();
  if (!searchResults) return;

  if (!query) {
    searchResults.style.display = 'none';
    searchResults.innerHTML = '';
    return;
  }

  const matches = state.items.filter((item) => {
    const haystack = `${item.sku || ''} ${item.title || ''} ${item.category || ''}`.toLowerCase();
    return haystack.includes(query);
  });

  if (!matches.length) {
    searchResults.innerHTML = '<div class="sri"><div class="st">No matching item found.</div></div>';
    searchResults.style.display = 'block';
    return;
  }

  searchResults.innerHTML = matches.slice(0, 6).map((item) => `
    <div class="sri" data-id="${escapeHtml(item.id)}" data-action="select-item">
      <div class="sc">${escapeHtml(item.sku || 'N/A')}</div>
      <div class="st">${escapeHtml(item.title || 'Inventory item')}</div>
    </div>
  `).join('');
  searchResults.style.display = 'block';
}

function selectItem(id) {
  const item = state.items.find((entry) => String(entry.id) === String(id));
  if (!item) return;

  state.selectedItemId = String(id);
  const status = getItemStatus(item);
  const statusText = getStatusText(status);
  if (selectedItem) selectedItem.style.display = 'block';
  if (selSku) selSku.textContent = item.sku || 'N/A';
  if (selTitle) selTitle.textContent = item.title || 'Inventory item';
  if (selQty) selQty.textContent = item.qty ?? item.quantity ?? 0;
  if (selBadge) {
    selBadge.className = `badge ${getStatusBadgeClass(status)}`;
    selBadge.textContent = statusText;
  }
  if (searchResults) {
    searchResults.style.display = 'none';
  }

  renderItemDetails(item);
  const keys = getShipmentFieldKeys(item.clientId || state.activeClientId);
  const shipmentEditor = document.getElementById('shipmentEditor');
  const stockEditor = document.getElementById('stockEditor');
  if (shipmentEditor) shipmentEditor.hidden = !keys;
  if (stockEditor) stockEditor.hidden = Boolean(keys);
  if (!keys) return;

  const current = document.getElementById('shipCurrent');
  if (current) {
    current.className = `badge ${getStatusBadgeClass(status)}`;
    current.textContent = statusText;
  }
  const received = document.getElementById('shipReceived');
  const shipped = document.getElementById('shipShipped');
  if (received) received.value = toNumber(item[keys.received]);
  if (shipped) shipped.value = toNumber(item[keys.shipped]);
  // Received and shipped counts are recorded by ECL staff, so clients only see them.
  [received, shipped].forEach((input) => { if (input) input.disabled = !state.isAdmin; });
  const save = document.getElementById('shipSave');
  if (save) save.hidden = !state.isAdmin;
  const hint = document.getElementById('shipmentHint');
  if (hint) {
    hint.textContent = state.isAdmin
      ? 'Enter how many have arrived at the warehouse, then how many have shipped out.'
      : 'Your ECL team updates these as items arrive at the warehouse and ship out.';
  }
  previewShipment();
}

// The product columns anyone on the account may edit. Received/shipped quantities are excluded here
// because only ECL staff change them, in the Received & Shipped section.
function getEditableItemFields(clientId) {
  const safeClientId = String(clientId || '').trim().toUpperCase();
  const profile = state.clientProfile && state.clientProfile.clientId === safeClientId ? state.clientProfile : null;
  const fields = (profile ? profile.fields : CLIENT_INVENTORY_FIELDS[safeClientId]?.fields) || [];
  const shipment = getShipmentFieldKeys(safeClientId);
  const custom = fields.filter((field) => !shipment || (field.key !== shipment.received && field.key !== shipment.shipped));
  if (safeClientId === 'CL-002' || safeClientId === 'CL-003') return custom;
  const base = [
    { key: 'sku', label: 'SKU (optional)', type: 'text' },
    { key: 'title', label: profile?.titleField?.label || 'Product Title', type: 'text' }
  ];
  return safeClientId === 'CL-001' ? base : [...base, ...custom];
}

function itemFieldValue(item, key) {
  if (key === 'sku') return item.rawSku ?? item.sku ?? '';
  return item[key] ?? '';
}

function renderItemDetails(item) {
  const section = document.getElementById('detailsEditor');
  const host = document.getElementById('detailFields');
  if (!section || !host) return;
  const clientId = item.clientId || state.activeClientId;
  const viewOnly = !state.isAdmin && Boolean(state.clientProfile?.readOnly);
  const fields = getEditableItemFields(clientId);
  section.hidden = viewOnly || !fields.length;
  if (section.hidden) return;
  host.innerHTML = fields.map((field) => {
    const id = escapeHtml(`detail_${field.key}`);
    const value = escapeHtml(itemFieldValue(item, field.key));
    const label = `<label class="ac-label" for="${id}">${escapeHtml(field.label)}</label>`;
    const common = `id="${id}" class="ac-input detail-input" data-key="${escapeHtml(field.key)}"`;
    if (field.type === 'select') {
      const current = String(itemFieldValue(item, field.key));
      // Keep a sheet value that isn't one of the listed options, so saving other fields doesn't overwrite it.
      const choices = (field.options || []).map((option) => String(option || ''));
      if (!choices.includes(current)) choices.unshift(current);
      const options = choices.map((option) => {
        const text = escapeHtml(option);
        return `<option value="${text}" ${option === current ? 'selected' : ''}>${text || '—'}</option>`;
      }).join('');
      return `<div>${label}<select ${common}>${options}</select></div>`;
    }
    if (field.type === 'textarea') return `<div class="detail-wide">${label}<textarea ${common} rows="3">${value}</textarea></div>`;
    // A number box can't hold sheet text like "10 units"; it would show blank and saving would erase it.
    const raw = String(itemFieldValue(item, field.key)).trim();
    const numeric = field.type === 'number' && (raw === '' || Number.isFinite(Number(raw)));
    return `<div>${label}<input type="${numeric ? 'number' : 'text'}" ${common} value="${value}" /></div>`;
  }).join('');
}

async function saveItemDetails() {
  const item = state.items.find((entry) => String(entry.id) === String(state.selectedItemId));
  if (!item) {
    showToast('Select an item first', 'error');
    return;
  }
  const clientId = state.activeClientId;
  const values = {};
  document.querySelectorAll('#detailFields .detail-input').forEach((input) => {
    const key = input.dataset.key;
    if (String(input.value).trim() !== String(itemFieldValue(item, key)).trim()) values[key] = input.value;
  });
  if (!Object.keys(values).length) {
    showToast('No changes to save', 'error');
    return;
  }
  try {
    const response = await fetch(UPDATE_ITEM_URL, {
      method: 'PUT',
      headers: adminHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ clientId, itemId: item.id, title: item.title, sku: item.sku, values })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.success) throw new Error(result.error || 'Unable to update product.');
    showToast('Product updated', 'success');
    inventorySignature = null;
    await fetchInventory(clientId);
    if (clientId !== state.activeClientId) return;
    if (state.items.some((entry) => String(entry.id) === String(item.id))) selectItem(item.id);
  } catch (error) {
    showToast(error.message || 'Unable to update product', 'error');
  }
}

function previewShipment() {
  const preview = document.getElementById('shipPreview');
  if (!preview) return;
  const received = toNumber(document.getElementById('shipReceived')?.value);
  const shipped = toNumber(document.getElementById('shipShipped')?.value);
  const stage = getShipmentStage(received, shipped);
  preview.className = `badge ${getStatusBadgeClass(stage)}`;
  preview.textContent = shipped > received ? 'Shipped is more than received' : getStatusText(stage);
}

async function saveShipment() {
  const item = state.items.find((entry) => String(entry.id) === String(state.selectedItemId));
  if (!item) {
    showToast('Select an item first', 'error');
    return;
  }
  const clientId = state.activeClientId;
  const received = Number(document.getElementById('shipReceived')?.value || 0);
  const shipped = Number(document.getElementById('shipShipped')?.value || 0);
  try {
    const response = await fetch(UPDATE_SHIPMENT_URL, {
      method: 'PUT',
      headers: adminHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ clientId, itemId: item.id, title: item.title, received, shipped })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.success) throw new Error(result.error || 'Unable to update shipment.');
    if (clientId !== state.activeClientId) return;
    const keys = getShipmentFieldKeys(clientId);
    if (keys) {
      item[keys.received] = String(received);
      item[keys.shipped] = String(shipped);
    }
    item.status = result.status;
    inventorySignature = null;
    updateSummary();
    renderTable();
    selectItem(item.id);
    showToast(`Saved — ${result.status}`, 'success');
    await fetchInventory(clientId);
  } catch (error) {
    showToast(error.message || 'Unable to update shipment', 'error');
  }
}

async function saveQuantity(item, quantity) {
  const clientId = state.activeClientId;
  try {
    const response = await fetch(UPDATE_QUANTITY_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.session?.notificationToken || ''}`, ...quickEditHeaders(clientId) },
      body: JSON.stringify({ clientId, sku: item.sku, qty: quantity })
    });
    const result = await response.json();
    if (result.code === 'QUICK_EDIT_PIN_REQUIRED') {
      state.quickEditUnlock = null;
      openPinPrompt(() => saveQuantity(item, quantity), 'quick-edit');
      return;
    }
    if (!response.ok || !result.success) throw new Error(result.error || 'Unable to update inventory.');
    if (clientId !== state.activeClientId || !state.auth) return;
    item.qty = quantity;
    item.status = getStatusText(getItemStatus(item));
    inventorySignature = null;
    updateSummary();
    renderTable();
    selectItem(item.id);
    showToast(`Inventory updated to ${quantity}`, 'success');
    await fetchInventory(clientId);
  } catch (error) {
    showToast(error.message || 'Unable to update inventory', 'error');
  }
}

async function adjustQty(delta) {
  if (!state.selectedItemId) {
    showToast('Select an item first', 'error');
    return;
  }

  const item = state.items.find((entry) => String(entry.id) === String(state.selectedItemId));
  if (!item) return;

  const amount = Number(document.getElementById('adjustAmt')?.value || 1);
  const nextQty = Math.max(0, Number(item.qty ?? item.quantity ?? 0) + (amount * delta));
  await saveQuantity(item, nextQty);
}

async function setExactQty() {
  if (!state.selectedItemId) {
    showToast('Select an item first', 'error');
    return;
  }

  const val = Number(document.getElementById('setQtyVal')?.value ?? 0);
  const item = state.items.find((entry) => String(entry.id) === String(state.selectedItemId));
  if (!item) return;

  await saveQuantity(item, Math.max(0, val));
}

async function createProduct() {
  const form = ITEM_FORMS.inventory;
  const clientId = state.activeClientId || state.session?.clientId || 'CL-001';
  const config = getClientInventoryFields(clientId);
  const isCardClient = clientId === 'CL-003';

  if (config.readOnly) {
    showToast('This client is in read-only mode', 'error');
    return;
  }

  const skuInput = document.getElementById(`${form.prefix}Sku`);
  const sku = (skuInput && !isCardClient) ? skuInput.value.trim() : '';
  const titleInput = document.getElementById(`${form.prefix}Title`);
  const productNameInput = document.getElementById(`${form.fieldPrefix}productName`);
  const title = (titleInput?.value?.trim() || productNameInput?.value?.trim() || '');
  const qty = Number(document.getElementById(`${form.prefix}Qty`)?.value ?? 0);
  const extraFields = {};
  const allowedFields = getFormFields(clientId, 'inventory');

  allowedFields.forEach((field) => {
    if ((field.key === 'quantityReceived' || field.key === 'quantityShipped') && !state.isAdmin) return;
    const value = document.getElementById(`${form.fieldPrefix}${field.key}`)?.value?.trim() || '';
    if (value) extraFields[field.key] = value;
  });

  if (!title) {
    showToast(isCardClient ? 'Card name / product is required' : 'A product name is required', 'error');
    return;
  }

  try {
    const response = await fetch(CREATE_ITEM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.session?.notificationToken || ''}` },
      body: JSON.stringify({ clientId, sku, title, qty, status: qty <= 5 ? 'Low Stock' : 'In Stock', extraFields, isAdmin: state.isAdmin, role: state.session?.role || (state.isAdmin ? 'admin' : 'client') })
    });

    const result = await response.json().catch(() => ({ success: false, error: 'Create failed' }));
    if (!response.ok || !result.success) {
      throw new Error(result.error || 'Create failed');
    }

    ['Sku', 'Title'].forEach((suffix) => {
      const input = document.getElementById(`${form.prefix}${suffix}`);
      if (input) input.value = '';
    });
    const qtyInput = document.getElementById(`${form.prefix}Qty`);
    if (qtyInput) qtyInput.value = '0';
    config.fields.forEach((field) => {
      const input = document.getElementById(`${form.fieldPrefix}${field.key}`);
      if (input) input.value = '';
    });
    await fetchInventory(clientId);
    showToast('Item added successfully', 'success');
  } catch (error) {
    showToast(error.message || 'Unable to add product', 'error');
  }
}

function filterLogs() {
  renderLogs();
}

window.addEventListener('resize', scheduleTableScrollUpdate);

const tableWrap = document.getElementById('inventoryTableWrap');
if (tableWrap) {
  tableWrap.addEventListener('scroll', scheduleTableScrollUpdate, { passive: true });
}
document.getElementById('tableScrollLeft')?.addEventListener('click', () => scrollInventoryTable(-1));
document.getElementById('tableScrollRight')?.addEventListener('click', () => scrollInventoryTable(1));

document.addEventListener('click', (event) => {
  const element = event.target.closest('[data-action]');
  if (!element) return;

  const action = element.dataset.action;

  if (action === 'select-item') {
    selectItem(element.dataset.id);
  }

  if (action === 'toggle-filter') {
    toggleFilter(element.dataset.group, element.dataset.key);
  }

  if (action === 'clear-filters') {
    clearFilters();
  }

  if (action === 'toggle-filter-panel') {
    setFilterPanelOpen(document.getElementById('filterPanel')?.hidden !== false);
  }

  if (action === 'close-filter-panel') {
    setFilterPanelOpen(false);
  }

  if (action === 'billing-edit') startBillingEdit(element.dataset.id);
  if (action === 'toggle-password') togglePasswordVisibility(element);
  if (action === 'chat-retry') retryPendingMessage(element.dataset.id);
  if (action === 'billing-cancel') cancelBillingEdit();
  if (action === 'billing-save') saveBillingEdit(element.dataset.id);
  if (action === 'billing-delete') deleteBillingEntry(element.dataset.id);
  if (action === 'history-edit') {
    state.historyEditId = element.dataset.id;
    renderBillingHistory({ force: true });
  }
  if (action === 'history-cancel') {
    state.historyEditId = null;
    renderBillingHistory({ force: true });
  }
  if (action === 'history-save') saveBillingHistoryEdit(element.dataset.id);
  if (action === 'history-delete') deleteBillingHistory(element.dataset.id);

  if (action === 'adjust') {
    const direction = Number(element.dataset.direction || 1);
    const itemId = element.dataset.id;
    const item = state.items.find((entry) => String(entry.id) === String(itemId));
    if (!item) return;
    state.selectedItemId = String(itemId);
    selectItem(itemId);
    adjustQty(direction);
  }
});

document.addEventListener('input', (event) => {
  const target = event.target;
  if (target === tableSearch) {
    state.query = tableSearch.value;
    renderTable();
  }
  if (target === searchInput) {
    filterSearch();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.getElementById('filterPanel')?.hidden === false) {
    setFilterPanelOpen(false);
  }
  if (event.key === 'Enter') {
    if (document.activeElement === portalUser || document.activeElement === portalPass) {
      executePortalAuth();
    }
    if (document.activeElement === pinInput) {
      verifyPinPrompt();
    }
  }
});

// Capture phase runs before option clicks re-render the panel, so the target is still attached.
document.addEventListener('click', (event) => {
  const panel = document.getElementById('filterPanel');
  if (panel && panel.hidden === false && !event.target.closest('.filter-bar')) setFilterPanelOpen(false);
}, true);

document.getElementById('portalUser')?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') executePortalAuth();
});

document.getElementById('portalPass')?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') executePortalAuth();
});

document.getElementById('pinInput')?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') verifyPinPrompt();
});

document.getElementById('msgInput')?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') submitMessage();
});

function addClientFieldRow() {
  state.newClientFields.push({ label: '', type: 'text', options: '', showInInventory: true, showInOrder: true });
  renderClientFieldRows();
}

function removeClientFieldRow(index) {
  state.newClientFields.splice(index, 1);
  renderClientFieldRows();
}

function updateClientFieldRow(index, key, value) {
  if (!state.newClientFields[index]) return;
  state.newClientFields[index][key] = value;
}

function fieldRowHtml(field, index, handlers, locked = false) {
  const lock = locked ? 'disabled' : '';
  const typeOption = (value, label) => `<option value="${value}" ${field.type === value ? 'selected' : ''}>${label}</option>`;
  return `
    <div class="ac-field-row">
      <input type="text" placeholder="Field label (e.g. UPC)" aria-label="Field label" value="${escapeHtml(field.label || '')}" ${lock} oninput="${handlers.update}(${index}, 'label', this.value)" />
      <select aria-label="Field type" ${lock} onchange="${handlers.update}(${index}, 'type', this.value); ${handlers.render}()">
        ${typeOption('text', 'Text')}${typeOption('number', 'Number')}${typeOption('textarea', 'Long text')}${typeOption('select', 'Dropdown')}
      </select>
      <input type="text" placeholder="Dropdown options, comma separated" aria-label="Dropdown options" value="${escapeHtml(field.options || '')}" ${lock} style="${field.type === 'select' ? '' : 'visibility:hidden;'}" oninput="${handlers.update}(${index}, 'options', this.value)" />
      ${locked ? '<span></span>' : `<button type="button" class="ac-field-remove" aria-label="Remove field" onclick="${handlers.remove}(${index})">✕</button>`}
      <div class="ac-field-toggles">
        <label class="ac-check"><input type="checkbox" ${field.showInInventory !== false ? 'checked' : ''} onchange="${handlers.update}(${index}, 'showInInventory', this.checked)" /> Show on Add New form</label>
      </div>
    </div>
  `;
}

function syncQuickEditPinField(prefix) {
  const mode = document.getElementById(`${prefix}QuickEditMode`)?.value;
  const wrap = document.getElementById(`${prefix}QuickEditPinWrap`);
  if (wrap) wrap.style.display = mode === 'password' ? 'block' : 'none';
}

function readClientSettingsForm(prefix) {
  const overstock = Number(document.getElementById(`${prefix}OverstockLevel`)?.value || 0);
  const mode = document.getElementById(`${prefix}QuickEditMode`)?.value || 'enabled';
  return {
    quickEditMode: mode,
    quickEditPin: mode === 'password' ? String(document.getElementById(`${prefix}QuickEditPin`)?.value || '').trim() : '',
    overstockLevel: overstock > 0 ? overstock : null
  };
}

function renderClientFieldRows() {
  const host = document.getElementById('acFieldsList');
  if (!host) return;

  if (!state.newClientFields.length) {
    host.innerHTML = '<div class="no-results" style="padding:12px;">No custom fields yet — click "+ Add Field" to add one (e.g. UPC, Merchant, Carrier).</div>';
    return;
  }

  const handlers = { update: 'updateClientFieldRow', remove: 'removeClientFieldRow', render: 'renderClientFieldRows' };
  host.innerHTML = state.newClientFields.map((field, index) => fieldRowHtml(field, index, handlers)).join('');
}

function showAddClientMessage(text, type) {
  const el = document.getElementById('addClientMsg');
  if (!el) return;
  el.style.display = 'block';
  el.style.background = type === 'error' ? '#fef2f2' : '#f0fdf4';
  el.style.color = type === 'error' ? '#b91c1c' : '#166534';
  el.textContent = text;
}

async function submitNewClient() {
  const clientId = String(document.getElementById('acClientId')?.value || '').trim().toUpperCase();
  const clientName = String(document.getElementById('acClientName')?.value || '').trim();
  const username = String(document.getElementById('acUsername')?.value || '').trim();

  if (!clientId || !clientName || !username) {
    showAddClientMessage('Client ID, client name, and username are required.', 'error');
    return;
  }

  const fields = state.newClientFields
    .filter((field) => field.label.trim())
    .map((field) => ({
      label: field.label.trim(),
      type: field.type,
      showInInventory: field.showInInventory !== false,
      showInOrder: field.showInOrder !== false,
      ...(field.type === 'select' ? { options: field.options.split(',').map((opt) => opt.trim()).filter(Boolean) } : {})
    }));

  const payload = {
    clientId,
    clientName,
    username,
    ...readClientSettingsForm('ac'),
    email: document.getElementById('acEmail')?.value || '',
    driveFolderUrl: document.getElementById('acDriveFolderUrl')?.value || '',
    portalTitle: document.getElementById('acPortalTitle')?.value || '',
    accentColor: document.getElementById('acAccentColor')?.value || '',
    enableAddItem: Boolean(document.getElementById('acEnableAddItem')?.checked),
    allowChat: Boolean(document.getElementById('acAllowChat')?.checked),
    allowLogs: Boolean(document.getElementById('acAllowLogs')?.checked),
    allowUpdate: Boolean(document.getElementById('acAllowUpdate')?.checked),
    readOnly: Boolean(document.getElementById('acReadOnly')?.checked),
    fields
  };

  try {
    const response = await fetch(ADMIN_CLIENTS_URL, {
      method: 'POST',
      headers: adminHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload)
    });
    const result = await response.json().catch(() => ({ success: false }));
    if (!response.ok || !result.success) {
      throw new Error(result.error || 'Unable to create client.');
    }

    showAddClientMessage(`${clientId} created. Give the client this login info — Username: "${result.username}", Activation Code: "${result.activationCode}". They'll use "Create Account" on the sign-in screen to set their own password.`, 'success');
    state.newClientFields = [];
    renderClientFieldRows();
    ['acClientId', 'acClientName', 'acUsername', 'acEmail', 'acDriveFolderUrl', 'acPortalTitle', 'acAccentColor', 'acQuickEditPin', 'acOverstockLevel'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    const acMode = document.getElementById('acQuickEditMode');
    if (acMode) acMode.value = 'enabled';
    syncQuickEditPinField('ac');
    await fetchClientRoster();
    populateEditClientSelect();
  } catch (error) {
    showAddClientMessage(error.message || 'Unable to create client.', 'error');
  }
}

function adminHeaders(extra = {}) {
  return { ...extra, Authorization: `Bearer ${state.session?.notificationToken || ''}` };
}

function populateEditClientSelect() {
  populateResetPasswordSelect();
  const select = document.getElementById('ecClientSelect');
  if (!select) return;
  const editable = state.roster.filter((client) => String(client.clientId || '').toUpperCase() !== 'CL-000');

  select.innerHTML = '<option value="">— Choose a client —</option>' + editable.map((client) => {
    const id = String(client.clientId || '').toUpperCase();
    return `<option value="${id}">${client.clientName || id} (${id})</option>`;
  }).join('');

  if (state.editClientId && editable.some((client) => String(client.clientId).toUpperCase() === state.editClientId)) {
    select.value = state.editClientId;
  }
}

async function loadClientForEdit(clientId) {
  const form = document.getElementById('editClientForm');
  state.editClientId = String(clientId || '').trim().toUpperCase();

  if (!state.editClientId) {
    if (form) form.style.display = 'none';
    return;
  }

  const profile = await fetchClientProfileForEdit(state.editClientId);
  if (!profile) {
    showEditClientMessage('Unable to load that client.', 'error');
    return;
  }

  if (form) form.style.display = 'block';
  const isLegacy = Boolean(profile.legacy);
  state.editClientLegacy = isLegacy;
  [['ecGenericSettings', !isLegacy], ['ecAddFieldBtn', !isLegacy], ['ecDeleteBtn', !isLegacy], ['ecLegacyNote', isLegacy]].forEach(([id, show]) => {
    const el = document.getElementById(id);
    if (el) el.style.display = show ? '' : 'none';
  });
  document.getElementById('ecClientName').value = profile.clientName || '';
  const rosterEntry = state.roster.find((client) => String(client.clientId || '').toUpperCase() === state.editClientId);
  document.getElementById('ecEmail').value = rosterEntry?.email || '';
  document.getElementById('ecDriveFolderUrl').value = profile.driveFolderUrl || '';
  document.getElementById('ecPortalTitle').value = profile.portalTitle || '';
  document.getElementById('ecAccentColor').value = profile.accentColor || '';
  document.getElementById('ecEnableAddItem').checked = Boolean(profile.enableAddItem);
  document.getElementById('ecAllowChat').checked = Boolean(profile.allowChat);
  document.getElementById('ecAllowLogs').checked = Boolean(profile.allowLogs);
  document.getElementById('ecAllowUpdate').checked = Boolean(profile.allowUpdate);
  document.getElementById('ecReadOnly').checked = Boolean(profile.readOnly);

  const modeSelect = document.getElementById('ecQuickEditMode');
  if (modeSelect) {
    modeSelect.value = profile.quickEditMode || 'enabled';
    modeSelect.disabled = state.editClientId === 'CL-002';
    modeSelect.title = modeSelect.disabled ? 'This client updates quantities through its shipment columns.' : '';
  }
  const pinInputField = document.getElementById('ecQuickEditPin');
  if (pinInputField) {
    pinInputField.value = '';
    pinInputField.placeholder = profile.quickEditPinSet ? 'PIN is set — leave blank to keep it' : '4-32 characters';
  }
  syncQuickEditPinField('ec');
  const overstockInput = document.getElementById('ecOverstockLevel');
  if (overstockInput) overstockInput.value = profile.overstockLevel || '';

  const attributeMap = profile.attributeMap || {};
  [['ecAttrBundled', 'bundled'], ['ecAttrFragile', 'fragile'], ['ecAttrOversized', 'oversized']].forEach(([id, attribute]) => {
    const select = document.getElementById(id);
    if (!select) return;
    select.replaceChildren(new Option('— None —', ''));
    (profile.fields || []).forEach((field) => select.append(new Option(field.label || field.key, field.key)));
    select.value = attributeMap[attribute] || '';
  });

  const visibility = profile.fieldVisibility || {};
  state.editClientFields = (profile.fields || []).map((field) => ({
    key: field.key,
    label: field.label,
    type: field.type,
    options: (field.options || []).join(', '),
    showInInventory: visibility[field.key]?.inventory !== false,
    showInOrder: visibility[field.key]?.order !== false
  }));
  renderEditClientFieldRows();
}

// Fetches a profile without touching state.clientProfile, which drives the live dashboard.
async function fetchClientProfileForEdit(clientId) {
  try {
    const response = await fetch(`${CLIENT_PROFILE_URL}?clientId=${encodeURIComponent(clientId)}`, {
      headers: adminHeaders({ Accept: 'application/json' })
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    return null;
  }
}

function addEditClientFieldRow() {
  state.editClientFields.push({ key: '', label: '', type: 'text', options: '', showInInventory: true, showInOrder: true });
  renderEditClientFieldRows();
}

function removeEditClientFieldRow(index) {
  state.editClientFields.splice(index, 1);
  renderEditClientFieldRows();
}

function updateEditClientFieldRow(index, key, value) {
  if (!state.editClientFields[index]) return;
  state.editClientFields[index][key] = value;
}

function renderEditClientFieldRows() {
  const host = document.getElementById('ecFieldsList');
  if (!host) return;

  if (!state.editClientFields.length) {
    host.innerHTML = '<div class="no-results" style="padding:12px;">No custom fields yet — click "+ Add Field" to add one.</div>';
    return;
  }

  const handlers = { update: 'updateEditClientFieldRow', remove: 'removeEditClientFieldRow', render: 'renderEditClientFieldRows' };
  host.innerHTML = state.editClientFields.map((field, index) => fieldRowHtml(field, index, handlers, state.editClientLegacy)).join('');
}

function showEditClientMessage(text, type) {
  const el = document.getElementById('editClientMsg');
  if (!el) return;
  el.style.display = 'block';
  el.style.background = type === 'error' ? '#fef2f2' : '#f0fdf4';
  el.style.color = type === 'error' ? '#b91c1c' : '#166534';
  el.textContent = text;
}

async function submitClientEdit() {
  if (!state.editClientId) return;

  const fields = state.editClientFields
    .filter((field) => field.label.trim())
    .map((field) => ({
      key: field.key || undefined,
      label: field.label.trim(),
      type: field.type,
      showInInventory: field.showInInventory !== false,
      showInOrder: field.showInOrder !== false,
      ...(field.type === 'select' ? { options: field.options.split(',').map((opt) => opt.trim()).filter(Boolean) } : {})
    }));

  const attributeValue = (id) => document.getElementById(id)?.value || null;
  const payload = {
    ...readClientSettingsForm('ec'),
    attributeMap: {
      bundled: attributeValue('ecAttrBundled'),
      fragile: attributeValue('ecAttrFragile'),
      oversized: attributeValue('ecAttrOversized')
    },
    clientName: document.getElementById('ecClientName')?.value || '',
    email: document.getElementById('ecEmail')?.value || '',
    driveFolderUrl: document.getElementById('ecDriveFolderUrl')?.value || '',
    portalTitle: document.getElementById('ecPortalTitle')?.value || '',
    accentColor: document.getElementById('ecAccentColor')?.value || '',
    enableAddItem: Boolean(document.getElementById('ecEnableAddItem')?.checked),
    allowChat: Boolean(document.getElementById('ecAllowChat')?.checked),
    allowLogs: Boolean(document.getElementById('ecAllowLogs')?.checked),
    allowUpdate: Boolean(document.getElementById('ecAllowUpdate')?.checked),
    readOnly: Boolean(document.getElementById('ecReadOnly')?.checked),
    fields
  };

  try {
    const response = await fetch(`${ADMIN_CLIENTS_URL}/${encodeURIComponent(state.editClientId)}`, {
      method: 'PUT',
      headers: adminHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload)
    });
    const result = await response.json().catch(() => ({ success: false }));
    if (!response.ok || !result.success) {
      throw new Error(result.error || 'Unable to save changes.');
    }

    showEditClientMessage('Changes saved.', 'success');
    await fetchClientRoster();
    if (state.activeClientId === state.editClientId) {
      await fetchClientProfile(state.activeClientId);
      renderProductForm();
      renderTable();
    }
    await loadClientForEdit(state.editClientId);
  } catch (error) {
    showEditClientMessage(error.message || 'Unable to save changes.', 'error');
  }
}

async function deleteClientPrompt() {
  if (!state.editClientId) return;
  if (!window.confirm(`Delete ${state.editClientId}? This removes their login and inventory sheet permanently.`)) return;

  try {
    const response = await fetch(`${ADMIN_CLIENTS_URL}/${encodeURIComponent(state.editClientId)}`, { method: 'DELETE', headers: adminHeaders() });
    const result = await response.json().catch(() => ({ success: false }));
    if (!response.ok || !result.success) {
      throw new Error(result.error || 'Unable to delete client.');
    }

    showEditClientMessage(`${state.editClientId} deleted.`, 'success');
    state.editClientId = '';
    document.getElementById('editClientForm').style.display = 'none';
    await fetchClientRoster();
    populateEditClientSelect();
  } catch (error) {
    showEditClientMessage(error.message || 'Unable to delete client.', 'error');
  }
}

function populateResetPasswordSelect() {
  const select = document.getElementById('rpClientSelect');
  if (!select) return;
  const ownUsername = String(state.session?.username || '').trim();
  const ownClientId = String(state.session?.clientId || '').toUpperCase();
  const resettable = state.roster.filter((client) =>
    String(client.clientId || '').toUpperCase() !== ownClientId && client.username !== ownUsername);
  select.replaceChildren(new Option('— Choose a client —', ''));
  resettable.forEach((client) => {
    const id = String(client.clientId || '').toUpperCase();
    select.append(new Option(`${client.clientName || id} (${id}) — ${client.username || 'no username'}`, id));
  });
}

function showResetPasswordMessage(text, type) {
  const el = document.getElementById('resetPasswordMsg');
  if (!el) return;
  el.style.display = 'block';
  el.style.background = type === 'error' ? '#fef2f2' : '#f0fdf4';
  el.style.color = type === 'error' ? '#b91c1c' : '#166534';
  el.textContent = text;
}

async function resetClientPasswordPrompt() {
  const clientId = document.getElementById('rpClientSelect')?.value;
  if (!clientId) {
    showResetPasswordMessage('Choose a client first.', 'error');
    return;
  }
  if (!window.confirm(`Reset the password for ${clientId}? Their current password and recovery code stop working immediately.`)) return;

  try {
    const response = await fetch(`${ADMIN_CLIENTS_URL}/${encodeURIComponent(clientId)}/reset-password`, {
      method: 'POST',
      headers: adminHeaders()
    });
    const result = await response.json().catch(() => ({ success: false }));
    if (!response.ok || !result.success) {
      throw new Error(result.error || 'Unable to reset password.');
    }
    showResetPasswordMessage(`Password reset for ${result.username}. Send them this one-time activation code: ${result.activationCode}. They'll use "Create Account" on the sign-in screen to choose a new password.`, 'success');
  } catch (error) {
    showResetPasswordMessage(error.message || 'Unable to reset password.', 'error');
  }
}

function formatMoney(value) {
  return `$${(Number(value) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function getBillingMonth() {
  const input = document.getElementById('billingMonth');
  const fallback = new Date().toISOString().slice(0, 7);
  if (input && !input.value) input.value = fallback;
  return (input && input.value) || fallback;
}

async function loadBillingSummary(clientId = state.activeClientId) {
  if (!state.auth) return 401;
  const month = getBillingMonth();
  const dateInput = document.getElementById('billingDate');
  if (dateInput && !dateInput.value.startsWith(month)) {
    const today = new Date().toISOString().slice(0, 10);
    dateInput.value = today.startsWith(month) ? today : `${month}-01`;
  }
  if (state.isAdmin && (!clientId || clientId === 'CL-000')) {
    state.billing = null;
    renderBilling('Choose a client in the switcher above to see their bill.');
    return 200;
  }
  try {
    const response = await fetch(`${BILLING_URL}?clientId=${encodeURIComponent(clientId)}&month=${encodeURIComponent(month)}`, {
      headers: adminHeaders({ Accept: 'application/json' }),
      signal: viewSignal()
    });
    if (clientId !== state.activeClientId || month !== getBillingMonth()) return response.status;
    if (!response.ok) {
      state.billing = null;
      renderBilling(response.status === 403 ? 'Billing is not shared for this account.' : 'Unable to load billing right now.');
      return response.status;
    }
    state.billing = await response.json();
    renderBilling();
    // Only refill the rate-card form when the client changes so polling never wipes unsaved edits.
    if (state.isAdmin && state.rateCardClientId !== clientId) {
      state.rateCardClientId = clientId;
      fillRateCardForm(state.billing.rateCard);
    }
    return 200;
  } catch (error) {
    return 0;
  }
}

function renderBilling(message = '') {
  const summary = state.billing;
  const messageEl = document.getElementById('billingMsg');
  if (messageEl) {
    messageEl.hidden = !message;
    messageEl.textContent = message;
  }
  ['billingAdminEntry', 'billingAdminRates', 'billingAdminHistory'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.hidden = !(state.isAdmin && summary);
  });
  const host = document.getElementById('billingSummary');
  if (!host) return;
  if (!summary) {
    host.innerHTML = '';
    return;
  }

  const { totals, lines, progress, period, rateCard, estimate = {} } = summary;
  const finalMonth = progress.fraction >= 1;
  const estimateNote = finalMonth ? ''
    : estimate.basis === 'history' ? `Based on the ${estimate.historyMonths}-month average of ${formatMoney(estimate.historyAverage)}, adjusted for this month's activity`
      : estimate.basis === 'pace' ? "Based on this month's pace so far"
        : 'Not enough history yet — showing what has been billed so far';
  const lineRows = lines.length ? lines.map((line) => `
    <tr>
      <td>
        <div class="billing-line-name">${escapeHtml(line.name)}</div>
        ${line.flat ? '' : `<div class="billing-line-rate">(${formatMoney(line.unitPrice)} ea.) × ${line.quantity}</div>`}
        ${line.description ? `<div class="billing-line-desc">${escapeHtml(line.description)}</div>` : ''}
      </td>
      <td class="num">${formatMoney(line.amount)}</td>
    </tr>
  `).join('') : '<tr><td colspan="2" class="billing-empty">Nothing billed for this month yet.</td></tr>';

  host.innerHTML = `
    ${summary.configured ? '' : `<div class="ac-note">No rate card saved yet${state.isAdmin ? ' — add this client\'s services below.' : '.'}</div>`}
    <div class="billing-totals">
      <div class="billing-total primary"><span>${finalMonth ? 'Month total' : 'Estimated end of month'}</span><strong>${formatMoney(finalMonth ? totals.total : totals.projected)}</strong>${estimateNote ? `<small>${escapeHtml(estimateNote)}</small>` : ''}</div>
      <div class="billing-total"><span>Billed so far</span><strong>${formatMoney(totals.total)}</strong></div>
    </div>
    <div class="billing-progress" role="progressbar" aria-label="Month progress" aria-valuemin="0" aria-valuemax="${progress.daysInMonth}" aria-valuenow="${progress.daysElapsed}">
      <div style="width:${Math.round(progress.fraction * 100)}%"></div>
    </div>
    <div class="billing-progress-label">Day ${progress.daysElapsed} of ${progress.daysInMonth}</div>
    <div class="billing-invoice">
      <div class="billing-invoice-head">Services ${escapeHtml(period.start)} – ${escapeHtml(period.end)}</div>
      <table class="billing-lines">
        <tbody>${lineRows}</tbody>
        <tfoot>
          <tr><td>Subtotal</td><td class="num">${formatMoney(totals.subtotal)}</td></tr>
          <tr><td>Tax${rateCard.taxRate ? ` (${rateCard.taxRate}%)` : ''}</td><td class="num">${formatMoney(totals.tax)}</td></tr>
          <tr class="billing-sum"><td>Total</td><td class="num">${formatMoney(totals.total)}</td></tr>
        </tfoot>
      </table>
    </div>
    <p class="billing-updated">Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · refreshes automatically</p>
  `;

  renderBillingServiceOptions();
  renderBillingEntries();
  renderBillingHistory();
}

function formatServiceMonth(month) {
  const [year, monthIndex] = String(month).split('-').map(Number);
  return year && monthIndex ? new Date(year, monthIndex - 1, 1).toLocaleDateString([], { month: 'short', year: 'numeric' }) : month;
}

function renderBillingHistory({ force = false } = {}) {
  const host = document.getElementById('billingHistory');
  if (!host || (state.historyEditId && !force)) return;
  const history = state.billing?.history || [];
  if (!history.length) {
    host.innerHTML = '<div class="no-results" style="padding:12px;">No past invoices yet.</div>';
    return;
  }
  host.innerHTML = history.map((record) => {
    const id = escapeHtml(record.id);
    if (record.id === state.historyEditId) {
      return `
        <div class="billing-entry editing">
          <div class="billing-edit-grid">
            <label>Services for month<input type="month" class="ac-input he-month" value="${escapeHtml(record.month)}" /></label>
            <label>Amount ($)<input type="number" class="ac-input he-amount" min="0" step="0.01" value="${escapeHtml(record.amount)}" /></label>
            <label>Invoice #<input type="text" class="ac-input he-number" maxlength="30" value="${escapeHtml(record.invoiceNumber)}" /></label>
            <label>Invoice date<input type="date" class="ac-input he-date" value="${escapeHtml(record.invoiceDate)}" /></label>
            <label class="billing-edit-note">Description<input type="text" class="ac-input he-description" maxlength="120" value="${escapeHtml(record.description)}" /></label>
          </div>
          <div class="billing-entry-actions">
            <button type="button" class="btn-set" data-action="history-save" data-id="${id}">Save</button>
            <button type="button" class="billing-link" data-action="history-cancel">Cancel</button>
          </div>
        </div>
      `;
    }
    const meta = [record.invoiceNumber && `#${record.invoiceNumber}`, record.invoiceDate && `sent ${record.invoiceDate}`, record.description].filter(Boolean).join(' · ');
    return `
      <div class="billing-entry">
        <div class="billing-entry-main">
          <strong>${escapeHtml(formatServiceMonth(record.month))}</strong>
          ${meta ? `<div class="billing-entry-meta">${escapeHtml(meta)}</div>` : ''}
        </div>
        <div class="billing-entry-amount">${formatMoney(record.amount)}</div>
        <div class="billing-entry-actions">
          <button type="button" class="billing-link" data-action="history-edit" data-id="${id}">Edit</button>
          <button type="button" class="billing-link danger" data-action="history-delete" data-id="${id}">Delete</button>
        </div>
      </div>
    `;
  }).join('');
}

async function sendBillingHistory(method, path, body) {
  const response = await fetch(`${ADMIN_BILLING_URL}/history${path}`, {
    method,
    headers: adminHeaders({ 'Content-Type': 'application/json' }),
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.success) throw new Error(result.error || 'Unable to save past invoice.');
  return result;
}

async function submitBillingHistory() {
  const value = (id) => document.getElementById(id)?.value ?? '';
  try {
    await sendBillingHistory('POST', '', {
      clientId: state.activeClientId,
      month: value('histMonth'),
      amount: value('histAmount'),
      invoiceNumber: value('histNumber'),
      invoiceDate: value('histDate'),
      description: value('histDescription')
    });
    ['histMonth', 'histAmount', 'histNumber', 'histDate', 'histDescription'].forEach((id) => {
      const input = document.getElementById(id);
      if (input) input.value = '';
    });
    showToast('Past invoice added', 'success');
    await loadBillingSummary(state.activeClientId);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function saveBillingHistoryEdit(id) {
  const form = document.querySelector('#billingHistory .billing-entry.editing');
  if (!form) return;
  const read = (selector) => form.querySelector(selector)?.value ?? '';
  try {
    await sendBillingHistory('PUT', `/${encodeURIComponent(id)}`, {
      month: read('.he-month'), amount: read('.he-amount'), invoiceNumber: read('.he-number'), invoiceDate: read('.he-date'), description: read('.he-description')
    });
    state.historyEditId = null;
    showToast('Past invoice updated', 'success');
    await loadBillingSummary(state.activeClientId);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function deleteBillingHistory(id) {
  const record = (state.billing?.history || []).find((item) => item.id === id);
  if (!record || !window.confirm(`Delete the ${formatServiceMonth(record.month)} invoice for ${formatMoney(record.amount)}?`)) return;
  try {
    await sendBillingHistory('DELETE', `/${encodeURIComponent(id)}`);
    if (state.historyEditId === id) state.historyEditId = null;
    showToast('Past invoice deleted', 'success');
    await loadBillingSummary(state.activeClientId);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function renderBillingServiceOptions() {
  const select = document.getElementById('billingService');
  if (!select || !state.billing) return;
  const services = state.billing.rateCard.services || [];
  const signature = JSON.stringify(services);
  if (select.dataset.signature === signature) return;
  const previous = select.value;
  select.dataset.signature = signature;
  select.replaceChildren(
    ...services.map((service) => new Option(`${service.name}${service.description ? ` – ${service.description}` : ''} (${formatMoney(service.unitPrice)} ea.)`, service.key)),
    new Option('Other charge (flat amount, e.g. shipping)', '__flat')
  );
  select.value = [...select.options].some((option) => option.value === previous) ? previous : select.options[0].value;
  onBillingServiceChange();
}

function onBillingServiceChange() {
  const select = document.getElementById('billingService');
  const flat = select?.value === '__flat';
  const service = (state.billing?.rateCard.services || []).find((entry) => entry.key === select?.value);
  const flatWrap = document.getElementById('billingFlatNameWrap');
  const qtyWrap = document.getElementById('billingQtyWrap');
  const priceLabel = document.getElementById('billingPriceLabel');
  const price = document.getElementById('billingPrice');
  if (flatWrap) flatWrap.hidden = !flat;
  if (qtyWrap) qtyWrap.hidden = flat;
  if (priceLabel) priceLabel.textContent = flat ? 'Amount ($)' : 'Price each ($)';
  if (price) price.value = service ? service.unitPrice : '';
}

function onBillingMonthChange() {
  state.billingEditId = null;
  state.historyEditId = null;
  const month = getBillingMonth();
  const date = document.getElementById('billingDate');
  const today = new Date().toISOString().slice(0, 10);
  if (date) date.value = today.startsWith(month) ? today : `${month}-01`;
  loadBillingSummary();
}

function billingEntryAmount(entry) {
  return Math.round(entry.quantity * entry.unitPrice * 100) / 100;
}

function formatBillingDay(date) {
  const [year, month, day] = String(date).split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

// While an entry is being edited, polling must not re-render the list and wipe the inputs.
function renderBillingEntries({ force = false } = {}) {
  const host = document.getElementById('billingEntries');
  if (!host || (state.billingEditId && !force)) return;
  const entries = state.billing?.entries || [];
  if (!entries.length) {
    host.innerHTML = '<div class="no-results" style="padding:12px;">No entries for this month yet.</div>';
    return;
  }
  const days = new Map();
  entries.forEach((entry) => {
    if (!days.has(entry.date)) days.set(entry.date, []);
    days.get(entry.date).push(entry);
  });
  host.innerHTML = [...days.entries()].map(([date, items]) => `
    <div class="billing-day">
      <div class="billing-day-head"><span>${escapeHtml(formatBillingDay(date))}</span><span>${formatMoney(items.reduce((sum, entry) => sum + billingEntryAmount(entry), 0))}</span></div>
      ${items.map((entry) => (entry.id === state.billingEditId ? billingEditHtml(entry) : billingEntryHtml(entry))).join('')}
    </div>
  `).join('');
}

function billingEntryHtml(entry) {
  const id = escapeHtml(entry.id);
  return `
    <div class="billing-entry">
      <div class="billing-entry-main">
        <strong>${escapeHtml(entry.name)}</strong>${entry.description ? ` <span class="billing-entry-desc">${escapeHtml(entry.description)}</span>` : ''}
        <div class="billing-entry-meta">${entry.flat ? 'Flat charge' : `${entry.quantity} × ${formatMoney(entry.unitPrice)}`}${entry.note ? ` · ${escapeHtml(entry.note)}` : ''}</div>
      </div>
      <div class="billing-entry-amount">${formatMoney(billingEntryAmount(entry))}</div>
      <div class="billing-entry-actions">
        <button type="button" class="billing-link" data-action="billing-edit" data-id="${id}">Edit</button>
        <button type="button" class="billing-link danger" data-action="billing-delete" data-id="${id}">Delete</button>
      </div>
    </div>
  `;
}

function billingEditHtml(entry) {
  const id = escapeHtml(entry.id);
  return `
    <div class="billing-entry editing">
      <div class="billing-edit-grid">
        <label>Date<input type="date" class="ac-input be-date" value="${escapeHtml(entry.date)}" /></label>
        ${entry.flat
          ? `<label>Charge name<input type="text" class="ac-input be-name" maxlength="80" value="${escapeHtml(entry.name)}" /></label>`
          : `<label>Service<input type="text" class="ac-input" value="${escapeHtml(entry.name)}" disabled /></label>
             <label>Quantity<input type="number" class="ac-input be-qty" min="0" step="1" value="${escapeHtml(entry.quantity)}" /></label>`}
        <label>${entry.flat ? 'Amount ($)' : 'Price each ($)'}<input type="number" class="ac-input be-price" step="0.01" value="${escapeHtml(entry.unitPrice)}" /></label>
        <label class="billing-edit-note">Note<input type="text" class="ac-input be-note" maxlength="200" value="${escapeHtml(entry.note)}" /></label>
      </div>
      <div class="billing-entry-actions">
        <button type="button" class="btn-set" data-action="billing-save" data-id="${id}">Save</button>
        <button type="button" class="billing-link" data-action="billing-cancel">Cancel</button>
      </div>
    </div>
  `;
}

function startBillingEdit(id) {
  state.billingEditId = id;
  renderBillingEntries({ force: true });
  document.querySelector('#billingEntries .billing-entry.editing input:not([disabled])')?.focus();
}

function cancelBillingEdit() {
  state.billingEditId = null;
  renderBillingEntries({ force: true });
}

async function saveBillingEdit(id) {
  const form = document.querySelector('#billingEntries .billing-entry.editing');
  if (!form) return;
  const read = (selector) => form.querySelector(selector)?.value;
  const body = { date: read('.be-date'), unitPrice: read('.be-price'), note: read('.be-note') };
  if (form.querySelector('.be-name')) body.name = read('.be-name');
  if (form.querySelector('.be-qty')) body.quantity = read('.be-qty');
  try {
    const response = await fetch(`${ADMIN_BILLING_URL}/entries/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: adminHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.success) throw new Error(result.error || 'Unable to save entry.');
    state.billingEditId = null;
    showToast('Entry updated', 'success');
    await loadBillingSummary(state.activeClientId);
  } catch (error) {
    showToast(error.message || 'Unable to save entry', 'error');
  }
}

async function deleteBillingEntry(id) {
  const entry = (state.billing?.entries || []).find((item) => item.id === id);
  if (!entry || !window.confirm(`Delete "${entry.name}" (${formatMoney(billingEntryAmount(entry))}) from ${formatBillingDay(entry.date)}?`)) return;
  try {
    const response = await fetch(`${ADMIN_BILLING_URL}/entries/${encodeURIComponent(id)}`, { method: 'DELETE', headers: adminHeaders() });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.success) throw new Error(result.error || 'Unable to delete entry.');
    if (state.billingEditId === id) state.billingEditId = null;
    showToast('Entry deleted', 'success');
    await loadBillingSummary(state.activeClientId);
  } catch (error) {
    showToast(error.message || 'Unable to delete entry', 'error');
  }
}

async function submitBillingEntry() {
  const clientId = state.activeClientId;
  const value = (id) => document.getElementById(id)?.value ?? '';
  const serviceKey = value('billingService');
  const flat = serviceKey === '__flat';
  const payload = {
    clientId,
    date: value('billingDate'),
    note: value('billingNote'),
    unitPrice: value('billingPrice'),
    ...(flat ? { flatCharge: true, name: value('billingFlatName') } : { serviceKey, quantity: value('billingQty') })
  };
  try {
    const response = await fetch(`${ADMIN_BILLING_URL}/entries`, {
      method: 'POST',
      headers: adminHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.success) throw new Error(result.error || 'Unable to save entry.');
    ['billingQty', 'billingNote', 'billingFlatName'].forEach((id) => {
      const input = document.getElementById(id);
      if (input) input.value = '';
    });
    if (flat) document.getElementById('billingPrice').value = '';
    showToast('Entry added', 'success');
    await loadBillingSummary(clientId);
  } catch (error) {
    showToast(error.message || 'Unable to save entry', 'error');
  }
}

function fillRateCardForm(card = {}) {
  const tax = document.getElementById('rcTaxRate');
  if (tax) tax.value = card.taxRate || '';
  const visible = document.getElementById('rcClientVisible');
  if (visible) visible.checked = Boolean(card.clientVisible);
  state.rateServices = (card.services || []).map((service) => ({ ...service }));
  renderRateServices();
}

function renderRateServices() {
  const host = document.getElementById('rcServices');
  if (!host) return;
  host.innerHTML = state.rateServices.length ? state.rateServices.map((service, index) => `
    <div class="rc-service-row">
      <input type="text" class="ac-input" aria-label="Service name" maxlength="80" placeholder="e.g. FBA Fulfillment (Per Unit)" value="${escapeHtml(service.name)}" oninput="state.rateServices[${index}].name = this.value" />
      <input type="number" class="ac-input" aria-label="Price each" min="0" step="0.01" placeholder="0.00" value="${escapeHtml(service.unitPrice ?? '')}" oninput="state.rateServices[${index}].unitPrice = this.value" />
      <input type="text" class="ac-input" aria-label="Description" maxlength="200" placeholder="e.g. Oversized Bundle" value="${escapeHtml(service.description || '')}" oninput="state.rateServices[${index}].description = this.value" />
      <button type="button" class="ac-field-remove" aria-label="Remove service" onclick="state.rateServices.splice(${index}, 1); renderRateServices()">✕</button>
    </div>
  `).join('') : '<div class="no-results" style="padding:10px;">No services yet — add the services on this client\'s invoice.</div>';
}

function addRateService() {
  state.rateServices.push({ name: '', unitPrice: '', description: '' });
  renderRateServices();
}

async function saveRateCard() {
  const clientId = state.activeClientId;
  try {
    const response = await fetch(`${ADMIN_BILLING_URL}/rates/${encodeURIComponent(clientId)}`, {
      method: 'PUT',
      headers: adminHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        services: state.rateServices,
        taxRate: document.getElementById('rcTaxRate')?.value || 0,
        clientVisible: Boolean(document.getElementById('rcClientVisible')?.checked)
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.success) throw new Error(result.error || 'Unable to save rate card.');
    showToast('Rate card saved', 'success');
    state.rateCardClientId = null;
    await loadBillingSummary(clientId);
  } catch (error) {
    showToast(error.message || 'Unable to save rate card', 'error');
  }
}

async function syncBillingTab() {
  const tab = document.getElementById('tabBilling');
  if (!tab) return;
  if (!state.auth) {
    tab.style.display = 'none';
    return;
  }
  if (state.isAdmin) {
    tab.style.display = 'block';
    return;
  }
  const status = await loadBillingSummary(state.activeClientId);
  tab.style.display = status === 200 ? 'block' : 'none';
}

function initializeApp() {
  const typingIndicator = document.getElementById('typingIndicator');
  if (typingIndicator) {
    typingIndicator.style.display = 'none';
  }
  renderDriveFolderLink();
  renderProductForm();
  updateSummary();
  renderTable();
  if (logTableWrap) logTableWrap.innerHTML = '<div class="no-results" style="padding:30px;">Loading log...</div>';
  if (pinOverlay) pinOverlay.style.display = 'none';
  const saved = loadSavedSession();
  // Keep the login screen hidden while a saved session is restored so a refresh doesn't flash it.
  if (portalLoginWindow) portalLoginWindow.style.display = saved ? 'none' : 'flex';
  if (saved) {
    restoreSavedSession().finally(() => {
      if (!state.auth && portalLoginWindow) portalLoginWindow.style.display = 'flex';
    });
  }
}

// Last-resort safety net: an unexpected error is logged and reported, but the page and sign-in stay intact.
window.addEventListener('error', (event) => {
  console.error('Unexpected error:', event.error || event.message);
  showToast('Something went wrong. Your data is safe — try that again.', 'error');
});
window.addEventListener('unhandledrejection', (event) => {
  if (event.reason?.name === 'AbortError') return;
  console.error('Unhandled request error:', event.reason);
  event.preventDefault();
  showToast('A request failed. Retrying automatically.', 'error');
});

try {
  initializeApp();
} catch (error) {
  console.error('Portal failed to start:', error);
  if (portalLoginWindow) portalLoginWindow.style.display = 'flex';
}
