// Same-origin when Express serves the page (any port); only standalone static previews
// (file:// or Live Server) need to reach the local API server on port 3001.
const API_BASE = (() => {
  const { protocol, hostname, port } = window.location;
  const isLocalHost = hostname === 'localhost' || hostname === '127.0.0.1';
  const isStaticPreview = protocol === 'file:' || (isLocalHost && ['5500', '5501'].includes(port));
  return isStaticPreview ? 'http://localhost:3001' : '';
})();

const API_URL = `${API_BASE}/api/inventory`;

const LOGIN_URL = `${API_BASE}/api/login`;

const CLIENTS_URL = `${API_BASE}/api/clients`;

const CHAT_URL = `${API_BASE}/api/chat`;

const CREATE_ITEM_URL = `${API_BASE}/api/inventory/create`;
const CATALOG_SYNC_URL = `${API_BASE}/api/catalog/sync`;
const STORE_CONNECTION_URL = `${API_BASE}/api/store-connection`;

const CLIENT_PROFILE_URL = `${API_BASE}/api/client-profile`;

const ADMIN_CLIENTS_URL = `${API_BASE}/api/admin/clients`;
const ADMIN_STAFF_URL = `${API_BASE}/api/admin/staff`;
const ADMIN_LOGINS_URL = `${API_BASE}/api/admin/logins`;

const ACTIVATE_ACCOUNT_URL = `${API_BASE}/api/account/activate`;

const RECOVER_ACCOUNT_URL = `${API_BASE}/api/account/recover`;

const NOTIFICATIONS_URL = `${API_BASE}/api/notifications`;

const ACTIVITY_URL = `${API_BASE}/api/activity`;
const TRACKING_URL = `${API_BASE}/api/tracking`;
const INBOUND_URL = `${API_BASE}/api/inbound-shipments`;

const UPDATE_QUANTITY_URL = `${API_BASE}/api/inventory/quantity`;
const QUICK_EDIT_UNLOCK_URL = `${API_BASE}/api/quick-edit/unlock`;
const UPDATE_SHIPMENT_URL = `${API_BASE}/api/inventory/shipment`;
const UPDATE_ITEM_URL = `${API_BASE}/api/inventory/item`;
const BILLING_URL = `${API_BASE}/api/billing/summary`;
const ADMIN_BILLING_URL = `${API_BASE}/api/admin/billing`;

const defaultInventory = [];

const CLIENT_INVENTORY_FIELDS = {
  'CL-001': { label: 'Metal Garden Markers', readOnly: true, requirePin: true, fields: [] },
  'CL-002': { label: 'Ecom Elite 2.0', readOnly: false, requirePin: false, fields: [
    { key: 'upc', label: 'UPC', type: 'text' },
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
  inventoryView: 'active',
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
  activity: { clientId: null, entries: null, loading: false, error: '' },
  tracking: { clientId: null, items: null, query: '', updatedAt: '', loading: false, error: '' },
  notifications: { chat: 0, inventory: 0, total: 0, items: [] }
};

let chatRequestId = 0;
let inventoryRequestId = 0;
let notificationRequestId = 0;
let activityRequestId = 0;
let trackingRequestId = 0;
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
const syncTimers = { chat: null, inventory: null, notifications: null, billing: null, activity: null, tracking: null };
const syncFailures = { chat: 0, inventory: 0, notifications: 0, billing: 0, activity: 0, tracking: 0 };
const syncIntervals = { chat: 12000, inventory: 30000, notifications: 60000, billing: 30000, activity: 30000, tracking: 30000 };
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
    if (kind === 'activity' && !isPageActive('page-logs')) return;
    if (kind === 'tracking' && !isPageActive('page-tracking')) return;

    const clientId = state.activeClientId;
    let status = 0;
    // A rendering bug in one refresh must never stop future refreshes or sign the user out.
    try {
      status = kind === 'chat' ? await loadChatMessages(clientId)
        : kind === 'billing' ? await loadBillingSummary(clientId)
          : kind === 'activity' ? await loadActivity(clientId)
            : kind === 'tracking' ? await loadTracking(clientId)
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
  if (isPageActive('page-logs')) {
    scheduleBackgroundSync('activity', immediate ? 0 : syncIntervals.activity);
  }
  if (isPageActive('page-tracking')) scheduleBackgroundSync('tracking', 0);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopBarcodeCamera();
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
  if (state.auth && !canOpenPortalPage(pageId)) {
    showToast('Your role does not have access to this section.', 'error');
    return;
  }
  if (pageId !== 'page-dashboard') closePackagingDialog();
  if (!['page-dashboard', 'page-tracking'].includes(pageId)) closeInboundDialog();
  if (pageId !== 'page-update') stopBarcodeCamera();
  if (pageId !== 'page-store-settings') resetStoreConnection();
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
  tabs.forEach((tab) => {
    tab.classList.remove('active');
    tab.removeAttribute('aria-current');
  });

  const tabMap = {
    'page-dashboard': 0,
    'page-update': 1,
    'page-order': 2,
    'page-logs': 3,
    'page-chat': 4,
    'page-billing': 5,
    'page-clients': 6,
    'page-tracking': 7,
    'page-store-settings': 8,
    'page-help': 9
  };

  const tabIndex = tabMap[pageId];
  if (tabIndex !== undefined && tabs[tabIndex]) {
    tabs[tabIndex].classList.add('active');
    tabs[tabIndex].setAttribute('aria-current', 'page');
  }
  if (state.auth && !document.hidden) {
    if (pageId === 'page-store-settings') {
      updateStoreSettingsAccess();
      renderBrandingForms();
      renderPackagingInstructions();
      if (canManageStoreConnection()) loadStoreConnection();
    }
    if (['page-dashboard', 'page-tracking'].includes(pageId)) loadInboundShipments();
    if (pageId === 'page-tracking') {
      renderTracking();
      scheduleBackgroundSync('tracking', 0);
    } else {
      clearTimeout(syncTimers.tracking);
      syncTimers.tracking = null;
    }
    if (pageId === 'page-logs') {
      renderLogs();
      scheduleBackgroundSync('activity', 0);
    } else {
      clearTimeout(syncTimers.activity);
      syncTimers.activity = null;
    }
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
    clients: 'page-clients',
    help: 'page-help',
    tracking: 'page-tracking',
    'store-settings': 'page-store-settings'
  };

  const targetPage = routeMap[pageName] || pageName;
  if (state.auth && !canOpenPortalPage(targetPage)) {
    showToast('Your role does not have access to this section.', 'error');
    return;
  }
  if (targetPage === 'page-store-settings' && !canManageBranding()) {
    showToast('Only the account owner or an administrator can manage store settings.', 'error');
    return;
  }
  if (targetPage === 'page-clients' && !canConfigureStaff()) {
    showToast('Administrator access is required for account setup.', 'error');
    return;
  }
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
    loadStaffAccounts();
    loadLoginHistory();
  }
}

// Clients whose fields include a received and a shipped quantity follow the warehouse shipment workflow.
function getShipmentFieldKeys(clientId) {
  const safeClientId = String(clientId || '').trim().toUpperCase();
  const profile = state.clientProfile && state.clientProfile.clientId === safeClientId ? state.clientProfile : null;
  if (profile?.inventoryMode === 'inventory') return null;
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

const FULFILLMENT_STATUSES = {
  transit: 'In Transit to Warehouse', arrived: 'Arrived / Check-In',
  verified: 'Received & Verified', prep: 'In Prep', dispatched: 'Shipped out'
};

function isFulfillmentClient(clientId = state.activeClientId) {
  const profile = state.clientProfile;
  return profile?.clientId === clientId && profile.inventoryMode
    ? profile.inventoryMode === 'custom'
    : ['CL-002', 'CL-003'].includes(clientId);
}

function getFulfillmentStatus(item) {
  const saved = String(item.status || '').trim();
  const shipping = getShippingStatus(item);
  if (shipping === 'fully' || /^(shipped|fully shipped|delivered|shipped out)$/i.test(saved)) return 'dispatched';
  if (/^arrived at warehouse$/i.test(saved)) return 'arrived';
  const match = Object.keys(FULFILLMENT_STATUSES).find((key) => FULFILLMENT_STATUSES[key] === saved);
  if (match) return match;
  return ['not', 'partial'].includes(shipping) ? 'arrived' : 'transit';
}

function getItemStatus(item) {
  if (isFulfillmentClient(item.clientId || state.activeClientId)) return getFulfillmentStatus(item);
  const shipping = getShippingStatus(item);
  if (shipping && state.clientProfile?.inventoryMode !== 'inventory') return shipping;

  const savedStatus = String(item.status || '').trim().toLowerCase();
  if (savedStatus === 'in stock') return 'in';
  if (savedStatus === 'low stock') return 'low';
  if (savedStatus === 'out of stock') return 'out';

  const qty = Number(item.qty ?? item.quantity ?? 0);
  if (!Number.isFinite(qty) || qty <= 0) return 'out';
  if (qty <= Number(item.reorderLevel || 0)) return 'low';
  return 'in';
}

function getStatusText(status) {
  if (FULFILLMENT_STATUSES[status]) return FULFILLMENT_STATUSES[status];
  if (status === 'fully') return 'Fully Shipped';
  if (status === 'partial') return 'Partially Shipped';
  if (status === 'not') return 'Not Shipped';
  if (status === 'awaiting') return 'Not Received';
  if (status === 'out') return 'Out of Stock';
  if (status === 'low') return 'Low Stock';
  return 'In Stock';
}

function getStatusBadgeClass(status) {
  if (status === 'dispatched') return 'badge-fully';
  if (['verified', 'prep'].includes(status)) return 'badge-partial';
  if (status === 'arrived') return 'badge-not';
  if (status === 'transit') return 'badge-awaiting';
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
    if (state.activeClientId === clientId) {
      state.clientProfile = profile;
      renderClientBranding();
      renderBrandingForms();
      renderPackagingInstructions();
    }
    return profile;
  } catch (error) {
    return null;
  }
}

function getFilterConfig(clientId = state.activeClientId || state.session?.clientId || 'CL-001') {
  const safeClientId = String(clientId || '').trim().toUpperCase();
  const shippingClient = isFulfillmentClient(safeClientId) || Boolean(getShipmentFieldKeys(safeClientId));
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

function getFilterGroups() {
  return FILTER_GROUPS.map((group) => group.key === 'stage' && isFulfillmentClient()
    ? { ...group, options: Object.entries(FULFILLMENT_STATUSES) } : group);
}

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
  if (isFulfillmentClient(item.clientId || state.activeClientId)) return getFulfillmentStatus(item);
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
  if (Number.isFinite(addedAt) && now - addedAt > AGED_ORDER_MS && !['fully', 'dispatched'].includes(getFulfillmentStage(item))) attributes.add('aged');
  const lastActivityAt = Date.parse(item.lastActivityAt || '');
  if (Number.isFinite(lastActivityAt) && now - lastActivityAt > DEAD_STOCK_MS && toNumber(item.qty ?? item.quantity) > 0) attributes.add('dead');
  return attributes;
}

const inventoryMarkup = new WeakMap();

function updateInventoryMarkup(element, markup) {
  if (!element || inventoryMarkup.get(element) === markup) return false;
  element.innerHTML = markup;
  inventoryMarkup.set(element, markup);
  return true;
}

function renderFilterControls(resultCount = getFilteredItems().length) {
  const filters = state.filters || emptyFilters();
  const selected = getFilterGroups().flatMap((group) => group.options
    .filter(([key]) => filters[group.key].includes(key))
    .map(([key, label]) => ({ group: group.key, key, label })));

  const host = document.getElementById('filterGroups');
  if (host) {
    const focused = document.activeElement?.dataset?.key ? `${document.activeElement.dataset.group}:${document.activeElement.dataset.key}` : '';
    const changed = updateInventoryMarkup(host, getFilterGroups().map((group) => `
      <div class="filter-section" role="group" aria-label="${group.label}">
        <div class="filter-section-title">${group.label}</div>
        <div class="filter-options">
          ${group.options.map(([key, label]) => `<button class="filter-option" type="button" aria-pressed="${filters[group.key].includes(key)}" data-action="toggle-filter" data-group="${group.key}" data-key="${key}">${label}</button>`).join('')}
        </div>
      </div>
    `).join(''));
    // Re-rendering replaces the buttons, so keep keyboard focus on the option that was toggled.
    if (changed && focused) {
      const [groupKey, optionKey] = focused.split(':');
      host.querySelector(`[data-group="${groupKey}"][data-key="${optionKey}"]`)?.focus();
    }
  }

  const chips = document.getElementById('activeFilters');
  if (chips) {
    updateInventoryMarkup(chips, selected.length
      ? selected.map((entry) => `<button class="active-filter-chip" type="button" data-action="toggle-filter" data-group="${entry.group}" data-key="${entry.key}" aria-label="Remove filter ${entry.label}">${entry.label} <span aria-hidden="true">✕</span></button>`).join('')
        + '<button class="active-filter-clear" type="button" data-action="clear-filters">Clear</button>'
      : '');
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
  const group = getFilterGroups().find((entry) => entry.key === groupKey);
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
  const counts = { fully: 0, partial: 0, not: 0, low: 0, out: 0 };
  for (const item of state.items) {
    const itemStatus = getItemStatus(item);
    const status = isFulfillmentClient(clientId) ? (itemStatus === 'dispatched' ? 'fully' : getShippingStatus(item) || 'not') : itemStatus;
    if (Object.hasOwn(counts, status)) counts[status] += 1;
  }

  if (totalEl) totalEl.textContent = total;

  if (config.mode === 'shipping') {
    const { fully, partial, not } = counts;

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
    const { low, out } = counts;

    if (lowEl) lowEl.textContent = low;
    if (outEl) outEl.textContent = out;
    const lowLabel = lowEl?.parentElement?.querySelector('.lbl');
    const outLabel = outEl?.parentElement?.querySelector('.lbl');
    if (lowLabel) lowLabel.textContent = 'LOW STOCK';
    if (outLabel) outLabel.textContent = 'OUT OF STOCK';
  }
}

function shippedViewEnabled() {
  return state.clientProfile?.clientId === state.activeClientId
    && ![false, 'false', 0, '0'].includes(state.clientProfile.enableShippedTab);
}

function isShippedItem(item) {
  if (isFulfillmentClient(item.clientId || state.activeClientId)) return getFulfillmentStatus(item) === 'dispatched';
  if (/^(shipped|fully shipped|delivered)$/i.test(String(item.status || '').trim())) return true;
  const stage = getShippingStatus(item);
  return stage === 'fully';
}

function syncInventoryViews() {
  const enabled = shippedViewEnabled();
  if (!enabled) state.inventoryView = 'active';
  const host = document.getElementById('inventoryViews');
  if (!host) return;
  host.hidden = !enabled;
  host.querySelectorAll('[data-view]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.view === state.inventoryView));
  });
}

function selectInventoryView(view) {
  if (!shippedViewEnabled() || !['active', 'shipped'].includes(view)) return;
  state.inventoryView = view;
  renderTable();
}

function getFilteredItems() {
  const query = (state.query || '').trim().toLowerCase();
  const filters = state.filters || emptyFilters();
  const now = Date.now();

  // OR within a group, AND across groups; an empty group doesn't filter.
  return state.items.filter((item) => {
    if (shippedViewEnabled() && isShippedItem(item) !== (state.inventoryView === 'shipped')) return false;
    if (query && !`${item.sku || ''} ${item.title || ''} ${item.category || ''} ${item.location || ''}`.toLowerCase().includes(query)) return false;
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

    updateInventoryMarkup(headerRow, columns.map((label) => {
      const centered = ['QTY', 'STATUS', 'EDIT'].includes(label);
      return `<th${centered ? ' class="center"' : ''}>${label}</th>`;
    }).join(''));
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
  syncInventoryViews();
  syncBarcodeCheckIn();
  const items = getFilteredItems();
  renderFilterControls(items.length);
  if (isPageActive('page-logs')) renderLogs();
  if (!inventoryBody) return;

  syncDashboardColumns();
  const profile = state.clientProfile;
  const clientId = profile?.clientId || state.activeClientId || state.session?.clientId;
  const fields = ((profile && profile.fields) || [])
    .filter((field) => clientId !== 'CL-002' || field.key !== 'productDescription');
  const dashboardFieldKeys = (profile && profile.dashboardFieldKeys) || fields.map((field) => field.key);
  const showQty = !(profile && profile.hideQtyColumn);
  const showEdit = !(profile && (profile.readOnly || profile.hideQuickEdit));
  const columnCount = 2 + dashboardFieldKeys.length + Number(showQty) + Number(showEdit);
  const metaFields = dashboardFieldKeys.length ? [] : fields.slice(0, 2);

  if (!items.length) {
    updateInventoryMarkup(inventoryBody, `<tr><td colspan="${columnCount}" class="no-results">No items match your filters.</td></tr>`);
    return;
  }

  updateInventoryMarkup(inventoryBody, items.map((item) => {
    const status = getItemStatus(item);
    const badgeClass = getStatusBadgeClass(status);

    // Clients whose custom fields aren't broken out into their own dashboard columns
    // (e.g. CL-003's tracking/carrier) still get a quick summary under the title.
    const metaText = metaFields.length
      ? `<div class="inventory-meta">${metaFields.map((field) => `${field.label}: ${item[field.key] || '—'}`).join(' • ')}</div>`
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
      <tr data-item-id="${escapeHtml(item.id)}" tabindex="0" aria-label="${escapeHtml(item.title || 'Inventory item')} - double-click or press Enter to view details">
        <td class="title-cell">${item.title || '—'}${metaText}</td>
        ${fieldCells}
        ${qtyCell}
        <td><span class="badge ${badgeClass}">${getStatusText(status)}</span></td>
        ${editCell}
      </tr>
    `;
  }).join(''));
}

let inventorySearchFrame = null;

function scheduleInventorySearch() {
  if (inventorySearchFrame !== null) return;
  const nextFrame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (callback) => setTimeout(callback, 16);
  inventorySearchFrame = nextFrame(() => {
    inventorySearchFrame = null;
    renderTable();
  });
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

  const isCurrentUserStaff = hasWarehouseAccess();

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

let pendingActivatedSession = null;

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

    pendingActivatedSession = result.notificationToken ? result : null;
    document.getElementById('activateFormFields').style.display = 'none';
    document.getElementById('activateSuccessPanel').style.display = 'block';
    document.getElementById('activateRecoveryCode').textContent = result.recoveryCode;
    const continueButton = document.getElementById('activateContinue');
    if (continueButton) continueButton.textContent = pendingActivatedSession ? 'Continue to Your Inventory' : 'Continue to Sign In';
    if (portalUser) portalUser.value = username;
  } catch (error) {
    showAuthError('activateErrorMsg', error.message || 'Unable to create account.');
  }
}

async function finishActivateAccount() {
  const activatedSession = pendingActivatedSession;
  pendingActivatedSession = null;
  document.getElementById('activateFormFields').style.display = 'block';
  document.getElementById('activateSuccessPanel').style.display = 'none';
  ['activateUsername', 'activateCode', 'activatePassword', 'activatePasswordConfirm'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  showAuthScreen('login');
  if (!activatedSession) return;
  try {
    await startSession(activatedSession);
  } catch (error) {
    console.error('Could not open inventory after account activation:', error);
    executePortalLogout('Your account is ready. Please sign in with your new password.');
    if (portalUser) portalUser.value = activatedSession.username || '';
  }
}

let recoverySubmitting = false;

async function submitRecoverAccount() {
  if (recoverySubmitting) return;
  const username = String(document.getElementById('recoverUsername')?.value || '').trim();
  const recoveryCode = String(document.getElementById('recoverCode')?.value || '').trim();
  const newPassword = String(document.getElementById('recoverPassword')?.value || '');
  const confirmPassword = String(document.getElementById('recoverPasswordConfirm')?.value || '');

  if (!username || !recoveryCode || !newPassword) {
    showAuthError('recoverErrorMsg', 'Fill in your username, recovery or administrator-issued reset code, and a new password.');
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

  recoverySubmitting = true;
  const submitButton = document.getElementById('recoverSubmit');
  if (submitButton) submitButton.disabled = true;
  const errorElement = document.getElementById('recoverErrorMsg');
  if (errorElement) {
    errorElement.textContent = '';
    errorElement.style.display = 'none';
  }
  try {
    const response = await fetch(RECOVER_ACCOUNT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, recoveryCode, newPassword })
    });
    let result;
    try {
      result = await response.json();
    } catch (error) {
      throw new Error(response.status === 429
        ? 'Too many attempts. Please wait a few minutes and try again.'
        : 'The reset service returned an unreadable response. Please try again later.');
    }
    if (!response.ok || !result || result.success !== true) {
      throw new Error(result?.error || (response.status === 429
        ? 'Too many attempts. Please wait a few minutes and try again.'
        : 'Unable to reset password. Please try again later.'));
    }
    if (typeof result.recoveryCode !== 'string' || !result.recoveryCode.trim()) {
      throw new Error('The reset response did not include a new recovery code. Contact support before trying again.');
    }

    document.getElementById('recoverFormFields').style.display = 'none';
    document.getElementById('recoverSuccessPanel').style.display = 'block';
    document.getElementById('recoverRecoveryCode').textContent = result.recoveryCode;
    ['recoverCode', 'recoverPassword', 'recoverPasswordConfirm'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    if (portalUser) portalUser.value = username;
  } catch (error) {
    showAuthError('recoverErrorMsg', error instanceof TypeError
      ? 'Unable to reach the reset service. Check your connection and try again.'
      : error.message || 'Unable to reset password.');
  } finally {
    recoverySubmitting = false;
    if (submitButton) submitButton.disabled = false;
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
      headers: adminHeaders({ Accept: 'application/json' }),
      signal: viewSignal()
    });

    if (!response.ok) {
      if (requestId === inventoryRequestId && state.auth && state.session === session && state.activeClientId === targetClientId) {
        if (response.status === 401) handleExpiredSession();
        else showToast('Unable to load inventory. Please refresh and try again.', 'error');
      }
      return response.status;
    }

    const result = await response.json();
    if (Array.isArray(result)) {
      const signature = JSON.stringify(result);
      const current = requestId === inventoryRequestId && state.auth && state.session === session && state.activeClientId === targetClientId;
      const cached = clientViewCache.get(targetClientId);
      const changed = current && signature !== inventorySignature;
      const items = !changed && cached?.itemsSignature === signature
        ? cached.items : result.map((item) => normalizeInventoryItem(item, targetClientId));
      cacheClientView(targetClientId, { items, itemsSignature: signature });
      if (changed) {
        inventorySignature = signature;
        state.items = items;
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

  renderWelcomeBanner(clientLabel || clientId || 'Client');
  renderClientBranding();
  renderBrandingForms();
}

function canManageBranding() {
  return state.auth && state.activeClientId && state.activeClientId !== 'CL-000'
    && (hasWarehouseAccess() || (state.session?.role === 'client' && state.session.clientId === state.activeClientId));
}

function brandTextColor(hex) {
  const values = hex.slice(1).match(/../g).map(value => {
    const channel = parseInt(value, 16) / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  const luminance = values.reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  return luminance > .179 ? '#000000' : '#FFFFFF';
}

function renderClientBranding() {
  const root = document.documentElement;
  if (!root?.style) return;
  const profile = state.auth && state.clientProfile?.clientId === state.activeClientId ? state.clientProfile : null;
  const color = /^#[a-f0-9]{6}$/i.test(profile?.accentColor || '') ? profile.accentColor : '';
  if (color) {
    root.style.setProperty('--client-accent', color);
    root.style.setProperty('--client-accent-text', brandTextColor(color));
  } else {
    root.style.removeProperty('--client-accent');
    root.style.removeProperty('--client-accent-text');
  }
  const logo = document.querySelector('.header-logo');
  if (!logo) return;
  if (!logo.dataset.defaultSrc) {
    logo.dataset.defaultSrc = logo.getAttribute('src');
    logo.dataset.defaultAlt = logo.alt;
  }
  const source = /^https?:\/\//i.test(profile?.logoUrl || '') ? profile.logoUrl : logo.dataset.defaultSrc;
  if (logo.getAttribute('src') !== source) {
    logo.onerror = source === logo.dataset.defaultSrc ? null : () => {
      logo.onerror = null;
      logo.src = logo.dataset.defaultSrc;
      logo.alt = logo.dataset.defaultAlt;
      showToast('Client logo could not load. Check its public image URL in branding settings.', 'error');
    };
    logo.src = source;
  }
  logo.alt = source === logo.dataset.defaultSrc ? logo.dataset.defaultAlt : `${profile.clientName || state.activeClientId} logo`;
}

function renderBrandingForms() {
  const current = canManageBranding() && state.clientProfile?.clientId === state.activeClientId;
  for (const prefix of ['settings']) {
    const panel = document.getElementById(`${prefix}Branding`);
    const host = document.getElementById(`${prefix}BrandingForm`);
    if (!panel || !host) continue;
    panel.hidden = !current;
    if (!current) { host.innerHTML = ''; delete host.dataset.signature; continue; }
    const profile = state.clientProfile;
    const signature = JSON.stringify([state.activeClientId, profile.websiteUrl, profile.logoUrl, profile.accentColor]);
    if (host.dataset.signature === signature) continue;
    host.dataset.signature = signature;
    host.innerHTML = `<form data-branding-form data-client-id="${escapeHtml(state.activeClientId)}">
      <label class="ac-label" for="${prefix}WebsiteUrl">Client Website URL</label>
      <input class="ac-input" id="${prefix}WebsiteUrl" name="websiteUrl" type="text" maxlength="2000" placeholder="https://your-company.com" value="${escapeHtml(profile.websiteUrl || '')}" />
      <button type="button" class="btn-set" data-fetch-branding>Fetch website branding</button>
      <p class="integration-description">Make the portal feel like your business: enter your public website address and choose Fetch website branding to suggest your company logo and brand color. Your saved logo appears in the dashboard header, and your brand color highlights active tabs and buttons. This optional lookup does not connect your store, import products or require API credentials. Review or adjust the suggestions, then choose Save branding to apply them; fetching alone does not change your portal.</p>
      <label class="ac-label" for="${prefix}LogoUrl">Logo image URL (manual override)</label>
      <input class="ac-input" id="${prefix}LogoUrl" name="logoUrl" type="url" maxlength="2000" placeholder="https://your-company.com/logo.png" value="${escapeHtml(profile.logoUrl || '')}" />
      <label class="ac-label" for="${prefix}AccentColor">Accent hex color (manual override)</label>
      <input class="ac-input" id="${prefix}AccentColor" name="accentColor" type="text" maxlength="7" pattern="#([a-fA-F0-9]{3}|[a-fA-F0-9]{6})" placeholder="#2463EB" value="${escapeHtml(profile.accentColor || '')}" />
      <p class="integration-description">Blank logo/color restores ECL defaults. Manual values are preserved when a website has no matching metadata.</p>
      <p class="branding-status" role="status" aria-live="polite"></p>
      <button type="submit" class="btn-set">Save branding</button>
    </form>`;
    const form = host.querySelector('form');
    form?.addEventListener('submit', event => { event.preventDefault(); submitBranding(form, false); });
    form?.querySelector('[data-fetch-branding]')?.addEventListener('click', () => submitBranding(form, true));
  }
}

async function submitBranding(form, fetchWebsite) {
  if (!canManageBranding() || form.dataset.busy === 'true' || form.dataset.clientId !== state.activeClientId) return;
  const clientId = state.activeClientId;
  const session = state.session;
  const status = form.querySelector('.branding-status');
  const input = name => form.elements.namedItem(name);
  const body = { clientId, websiteUrl: input('websiteUrl').value.trim(), logoUrl: input('logoUrl').value.trim(), accentColor: input('accentColor').value.trim() };
  form.dataset.busy = 'true';
  form.querySelectorAll('button, input').forEach(element => { element.disabled = true; });
  status.textContent = fetchWebsite ? 'Fetching public website branding...' : 'Saving branding...';
  try {
    const response = await fetch(`${API_BASE}/api/branding${fetchWebsite ? '/fetch' : ''}`, {
      method: fetchWebsite ? 'POST' : 'PUT', headers: adminHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body), signal: viewSignal()
    });
    const result = await response.json();
    if (session !== state.session || clientId !== state.activeClientId || !form.isConnected) return;
    if (!response.ok || !result.success || result.clientId !== clientId) throw new Error(result.error || 'Branding was not confirmed. Please retry.');
    if (fetchWebsite) {
      if (result.branding.logoUrl) input('logoUrl').value = result.branding.logoUrl;
      if (result.branding.accentColor) input('accentColor').value = result.branding.accentColor;
      status.textContent = [...result.branding.warnings, 'Review or edit the fields, then Save branding to apply.'].join(' ');
    } else {
      Object.assign(state.clientProfile, result.branding, { accentColor: result.branding.accentColor || '#F5C518' });
      cacheClientView(clientId, { profile: state.clientProfile });
      status.textContent = 'Client branding saved.';
      renderClientBranding();
      renderBrandingForms();
      showToast('Client branding saved.', 'success');
    }
  } catch (error) {
    if (session === state.session && clientId === state.activeClientId && form.isConnected && error.name !== 'AbortError') {
      status.textContent = error.message || 'Unable to update branding. Manual entry remains available.';
    }
  } finally {
    form.dataset.busy = 'false';
    form.querySelectorAll('button, input').forEach(element => { element.disabled = false; });
  }
}

function getTimeOfDayGreeting(date = new Date()) {
  const hour = date.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function renderWelcomeBanner(clientLabel) {
  const banner = document.getElementById('welcomeBanner');
  if (!banner) return;
  const set = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  if (!state.session) {
    banner.classList.remove('is-personalized');
    set('welcomeGreeting', 'Welcome');
    set('welcomeTitle', 'Inventory overview');
    set('welcomeSubtitle', 'Stock levels, fulfillment progress, and quick actions in one place.');
    set('welcomeDate', '');
    return;
  }
  const now = new Date();
  const viewingOwnAccount = !state.isAdmin
    || String(state.activeClientId || '').toUpperCase() === String(state.session.clientId || '').toUpperCase();
  banner.classList.add('is-personalized');
  set('welcomeGreeting', getTimeOfDayGreeting(now));
  set('welcomeTitle', state.isAdmin
    ? state.session.role === 'staff' ? 'Welcome back, Team' : 'Welcome back, Admin'
    : `Welcome back, ${clientLabel}`);
  set('welcomeSubtitle', state.isAdmin && !viewingOwnAccount
    ? `You're viewing ${clientLabel}'s inventory, fulfillment progress, and quick actions.`
    : "Here's your inventory overview — stock levels, fulfillment progress, and quick actions in one place.");
  set('welcomeDate', now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }));
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
  const shouldShow = canAddInventoryItems(clientId);
  ['tabOrder'].forEach((id) => {
    const tab = document.getElementById(id);
    if (tab) tab.style.display = shouldShow ? 'block' : 'none';
  });
}

function canAddInventoryItems(clientId = state.activeClientId) {
  if (!state.auth || !clientId || clientId === 'CL-000') return false;
  if (hasWarehouseAccess()) return true;
  const profile = state.clientProfile;
  return state.session?.clientId === clientId && profile?.clientId === clientId
    && Boolean(profile.enableAddItem) && !profile.readOnly;
}

const ITEM_FORMS = {
  inventory: { prefix: 'newProduct', fieldPrefix: 'customField_', fieldsHost: 'customProductFields', submit: 'createProductSubmit', notice: 'createProductReadOnlyNotice' }
};
const CATALOG_FIELDS = [
  { key: 'imageUrl', label: 'Product Image URL', type: 'text', aliases: ['imageurl', 'image url', 'product image url', 'image thumbnail', 'image'] },
  { key: 'bundled', label: 'Is Bundled', type: 'select', options: ['', 'Y', 'N'], aliases: ['bundled', 'is bundled', 'isbundled', 'bundled? (y/n)'] },
  { key: 'bundleQty', label: 'Bundle Quantity', type: 'number', aliases: ['bundleqty', 'bundlequantity', 'bundle quantity'] },
  { key: 'prepInstructions', label: 'Special Prep Instructions', type: 'textarea', aliases: ['prepinstructions', 'special prep instructions'] },
  { key: 'productUrl', label: 'Product Listing URL', type: 'text', aliases: ['producturl', 'product url', 'product listing url'] }
];

function catalogFieldMatches(catalog, field) {
  return (catalog.key === 'bundled' && field.key === state.clientProfile?.attributeMap?.bundled)
    || catalog.aliases.includes(field.key.toLowerCase()) || catalog.aliases.includes(field.label.toLowerCase());
}

function withCatalogFields(fields, configured = fields) {
  const prep = CATALOG_FIELDS.find((field) => field.key === 'prepInstructions');
  return [...fields.map((field) => catalogFieldMatches(prep, field) ? { ...field, type: 'textarea' } : field),
    ...CATALOG_FIELDS.filter((catalog) => !configured.some((field) => catalogFieldMatches(catalog, field)))];
}

let catalogSyncController = null;
let catalogProducts = [];
let catalogSyncGeneration = 0;

function catalogMessage(message, error = false) {
  const host = document.getElementById('catalogSyncMessage');
  if (!host) return;
  host.textContent = message;
  host.classList.toggle('is-error', error);
}

function resetCatalogSync(clearDraft = false) {
  catalogSyncGeneration += 1;
  catalogSyncController?.abort();
  catalogSyncController = null;
  catalogProducts = [];
  for (const id of ['catalogSourceUrl', 'catalogProductSelect']) {
    const input = document.getElementById(id);
    if (input) input.value = '';
  }
  const picker = document.getElementById('catalogProductPicker');
  if (picker) picker.hidden = true;
  const panel = document.getElementById('catalogSyncPanel');
  if (panel) panel.open = false;
  const replace = document.getElementById('catalogReplaceExisting');
  if (replace) replace.checked = false;
  const preview = document.getElementById('catalogImagePreview');
  if (preview) { preview.hidden = true; preview.removeAttribute('src'); }
  const message = document.getElementById('catalogImageMessage');
  if (message) message.textContent = '';
  if (clearDraft) {
    ['newProductSku', 'newProductTitle', 'newProductQty'].forEach((id) => {
      const input = document.getElementById(id);
      if (input) input.value = id === 'newProductQty' ? '0' : '';
    });
  }
  const button = document.getElementById('catalogSyncSubmit');
  if (button) button.disabled = !canAddInventoryItems();
  catalogMessage('');
}

function catalogInput(key) {
  const catalog = CATALOG_FIELDS.find((entry) => entry.key === key);
  const field = getFormFields(state.activeClientId, 'inventory').find((entry) =>
    catalogFieldMatches(catalog, entry));
  return field ? document.getElementById(`customField_${field.key}`) : null;
}

function previewCatalogImage() {
  const preview = document.getElementById('catalogImagePreview');
  if (!preview) return;
  const value = catalogInput('imageUrl')?.value.trim() || '';
  const message = document.getElementById('catalogImageMessage');
  preview.hidden = true;
  preview.removeAttribute('src');
  if (message) message.textContent = '';
  if (!value) return;
  let url;
  try { url = new URL(value); } catch {
    if (message) message.textContent = 'Enter a complete HTTP or HTTPS image URL.';
    return;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    if (message) message.textContent = 'Image preview requires an HTTP or HTTPS URL without credentials.';
    return;
  }
  preview.src = url.href;
  preview.hidden = false;
}

async function syncCatalog(event) {
  event.preventDefault();
  if (!canAddInventoryItems() || catalogSyncController) return;
  const session = state.session;
  const clientId = state.activeClientId;
  const generation = ++catalogSyncGeneration;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  catalogSyncController = controller;
  const button = document.getElementById('catalogSyncSubmit');
  button.disabled = true;
  document.getElementById('catalogProductPicker').hidden = true;
  catalogProducts = [];
  catalogMessage('Fetching public product details. Manual entry remains available.');
  try {
    const response = await fetch(CATALOG_SYNC_URL, {
      method: 'POST', headers: adminHeaders({ 'Content-Type': 'application/json' }), signal: controller.signal,
      body: JSON.stringify({ clientId, url: document.getElementById('catalogSourceUrl').value.trim() })
    });
    const result = await response.json();
    if (generation !== catalogSyncGeneration || session !== state.session || clientId !== state.activeClientId) return;
    if (!response.ok || !result.success || !Array.isArray(result.products) || !result.products.length) throw new Error(result.error || 'No public product details were found.');
    catalogProducts = result.products;
    const select = document.getElementById('catalogProductSelect');
    select.innerHTML = catalogProducts.map((product, index) => `<option value="${index}">${escapeHtml(product.title)}${product.sku ? ` (${escapeHtml(product.sku)})` : ''}</option>`).join('');
    select.value = '0';
    document.getElementById('catalogProductPicker').hidden = false;
    catalogMessage(`${catalogProducts.length} product${catalogProducts.length === 1 ? '' : 's'} found. Select a product to prefill; all fields remain editable.`);
  } catch (error) {
    if (generation === catalogSyncGeneration) catalogMessage(`${error.name === 'AbortError' ? 'Website import timed out.' : error.message} Enter or edit the fields below manually.`, true);
  } finally {
    clearTimeout(timeout);
    if (catalogSyncController === controller) {
      catalogSyncController = null;
      button.disabled = !canAddInventoryItems();
    }
  }
}

function applyCatalogProduct() {
  const product = catalogProducts[Number(document.getElementById('catalogProductSelect').value)];
  if (!product || !canAddInventoryItems()) return;
  const replace = document.getElementById('catalogReplaceExisting').checked;
  let skipped = 0;
  const fill = (input, value) => {
    if (!input || input.disabled || input.readOnly || !value) return;
    if (input.value.trim() && !replace) { skipped += 1; return; }
    if (input.tagName === 'SELECT' && ![...input.options].some((option) => option.value === value)) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      input.appendChild(option);
    }
    input.value = value;
    input.dataset.userTyped = 'true';
  };
  const title = document.getElementById('newProductTitle');
  const productName = document.getElementById('customField_productName');
  if (productName) fill(productName, product.title);
  if (title && document.getElementById('newProductTitleWrap')?.style.display !== 'none') fill(title, product.title);
  fill(document.getElementById('newProductSku'), product.sku);
  const upcField = document.getElementById('customField_upc');
  if (/^\d{8,14}$/.test(product.sku || '')) fill(upcField, product.sku);
  fill(catalogInput('imageUrl'), product.imageUrl);
  fill(catalogInput('productUrl'), product.productUrl);
  fill(catalogInput('bundled'), product.bundled);
  fill(catalogInput('bundleQty'), product.bundleQty);
  previewCatalogImage();
  catalogMessage(`Product details prefilled. Review and edit before saving.${skipped ? ' Existing entries were kept; enable Replace existing details to overwrite them.' : ''}`);
}

// Custom fields for one form, minus any the admin switched off and, for clients, the staff-only received/shipped counts.
function getFormFields(clientId, kind) {
  const profile = state.clientProfile && state.clientProfile.clientId === clientId ? state.clientProfile : null;
  const visibility = (profile && profile.fieldVisibility) || {};
  const shipment = state.isAdmin ? null : getShipmentFieldKeys(clientId);
  return withCatalogFields(getVisibleClientFields(clientId, state.isAdmin)
    .filter((field) => clientId !== 'CL-002' || field.key !== 'productDescription')
    .filter((field) => !visibility[field.key] || visibility[field.key][kind] !== false)
    .filter((field) => !shipment || (field.key !== shipment.received && field.key !== shipment.shipped)), getVisibleClientFields(clientId, state.isAdmin));
}

function syncCreateFormLayout() {
  const clientId = state.activeClientId || state.session?.clientId || 'CL-001';
  const profile = state.clientProfile && state.clientProfile.clientId === clientId ? state.clientProfile : null;
  const titleConfig = profile && !profile.legacy
    ? { ...getCreateFormTitleConfig(clientId), ...profile.titleField, visible: true }
    : getCreateFormTitleConfig(clientId);
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
          <label class="ac-label" for="${fieldId}">${label}</label>
          <select id="${fieldId}" class="ac-input" data-placeholder="${samplePlaceholder}" ${isReadOnlyField ? 'disabled' : ''}>${options}</select>
        </div>
      `;
    }

    if (field.type === 'textarea') {
      return `
        <div class="item-field-wide">
          <label class="ac-label" for="${fieldId}">${label}</label>
          <textarea id="${fieldId}" class="ac-input" placeholder="${samplePlaceholder}" ${isReadOnlyField ? 'readonly' : ''}></textarea>
        </div>
      `;
    }

    return `
      <div>
        <label class="ac-label" for="${fieldId}">${label}</label>
        <input type="${field.type === 'number' ? 'number' : 'text'}" id="${fieldId}" class="ac-input" placeholder="${samplePlaceholder}" ${isReadOnlyField ? 'readonly' : ''} />
      </div>
    `;
  }).join('');
}

function renderProductForm() {
  renderPackagingInstructions();
  const clientId = state.activeClientId || state.session?.clientId || 'CL-001';
  const profile = state.clientProfile && state.clientProfile.clientId === clientId ? state.clientProfile : null;
  const syncButton = document.getElementById('catalogSyncSubmit');
  const canAdd = canAddInventoryItems(clientId);
  if (syncButton) syncButton.disabled = !canAdd;

  syncAddTabVisibility();
  renderInboundShipments();
  if (inboundAvailable() && inboundState.clientId !== clientId
    && (isPageActive('page-dashboard') || isPageActive('page-tracking'))) loadInboundShipments();
  syncCreateFormLayout();

  const skuSample = getInventoryFieldSample(state.items, 'sku');
  const titleSample = getInventoryFieldSample(state.items, 'title');

  Object.entries(ITEM_FORMS).forEach(([kind, form]) => {
    const skuInput = document.getElementById(`${form.prefix}Sku`);
    const titleInput = document.getElementById(`${form.prefix}Title`);
    if (skuInput && !skuInput.dataset.userTyped) skuInput.placeholder = skuSample ? `e.g. ${skuSample}` : 'A-25-Cu-01';
    if (titleInput && !titleInput.dataset.userTyped) titleInput.placeholder = titleSample ? `e.g. ${titleSample}` : 'Copper Marker';

    const host = document.getElementById(form.fieldsHost);
    const fields = getFormFields(clientId, kind);
    if (host) {
      host.innerHTML = renderFieldInputs(fields, form.fieldPrefix);
      host.hidden = !fields.length;
    }

    const notice = document.getElementById(form.notice);
    if (notice) {
      notice.style.display = !canAdd ? 'block' : 'none';
      notice.textContent = !canAdd
        ? 'This client is in view-only mode. Inventory is locked and cannot be added to directly.'
        : '';
    }

    const submitBtn = document.getElementById(form.submit);
    if (submitBtn) {
      submitBtn.disabled = !canAdd;
      submitBtn.textContent = !canAdd ? 'Inventory locked' : 'Add to inventory';
    }
  });
}

function switchClientView(clientId) {
  const nextClientId = String(clientId || '').trim().toUpperCase();
  if (!nextClientId) return Promise.resolve();
  if (!state.auth || (!hasWarehouseAccess() && nextClientId !== state.session?.clientId)) {
    showToast('You can only view your own client account.', 'error');
    return Promise.resolve();
  }

  closeOnboardingTour({ markSeen: false, restorePage: false });
  closePackagingDialog();
  resetInboundShipments();
  closeInventoryItemDialog(true);
  resetStoreConnection();
  resetCatalogSync(true);
  resetBarcodeCheckIn();
  stopBackgroundSync();
  resetViewRequests();
  notificationRequestId += 1;
  activityRequestId += 1;
  inventoryRequestId += 1;
  chatRequestId += 1;

  const cached = clientViewCache.get(nextClientId) || {};
  state.activeClientId = nextClientId;
  updateStoreSettingsAccess();
  if (isPageActive('page-store-settings')) loadStoreConnection();
  resetTracking();
  state.activity = { clientId: null, entries: null, loading: false, error: '' };
  state.filters = emptyFilters();
  state.inventoryView = 'active';
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
        isPageActive('page-logs') ? loadActivity(nextClientId) : null,
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
const RESTORABLE_PAGES = ['page-dashboard', 'page-logs', 'page-chat', 'page-billing', 'page-clients', 'page-help', 'page-tracking', 'page-store-settings'];

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
  if (!String(result.clientId || '').trim() || !['admin', 'staff', 'client'].includes(result.role)
    || (result.role === 'client' && result.clientId === 'CL-000')) {
    executePortalLogout('Your account role is invalid. Contact an administrator.');
    return;
  }
  state.session = result;
  state.auth = true;
  // Existing warehouse controls share this flag; master settings always use canConfigureStaff().
  state.isAdmin = hasWarehouseAccess();
  state.activeClientId = String(result.clientId || '').trim().toUpperCase() || 'CL-001';
  state.roster = [];
  state.pinUnlocked = false;
  lastInteractionAt = Date.now();
  idlePaused = false;

  renderClientHeader();

  if (portalLoginWindow) portalLoginWindow.style.display = 'none';
  setPage('page-dashboard');

  const tabClients = document.getElementById('tabClients');
  if (tabClients) tabClients.style.display = canConfigureStaff() ? 'block' : 'none';
  updateStoreSettingsAccess();
  const staffSection = document.getElementById('staffAccountsSection');
  if (staffSection) staffSection.hidden = !canConfigureStaff();
  const loginHistorySection = document.getElementById('loginHistorySection');
  if (loginHistorySection) loginHistorySection.hidden = !canConfigureStaff();

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
  updateStoreSettingsAccess();
  startBackgroundSync();
  await syncBillingTab();

  const page = saved?.page;
  const billingTab = document.getElementById('tabBilling');
  const allowed = RESTORABLE_PAGES.includes(page)
    && (page !== 'page-clients' || canConfigureStaff())
    && (page !== 'page-store-settings' || canManageBranding())
    && (page !== 'page-billing' || billingTab?.style.display !== 'none');
  if (allowed && page !== 'page-dashboard') showPage(page.replace('page-', ''));
  saveSession();
  maybeStartOnboarding();
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
  closePackagingDialog();
  resetInboundShipments();
  resetStoreConnection();
  resetCatalogSync(true);
  clearStaffAccounts();
  clearLoginHistory();
  closeInventoryItemDialog(true);
  resetBarcodeCheckIn();
  clearSavedSession();
  closeOnboardingTour({ markSeen: false, restorePage: false });
  stopBackgroundSync();
  resetViewRequests();
  clearTimeout(switchTimer);
  switchSequence += 1;
  clientViewCache.clear();
  chatRequestId += 1;
  inventoryRequestId += 1;
  notificationRequestId += 1;
  activityRequestId += 1;
  chatSignature = null;
  inventorySignature = null;
  state.auth = false;
  state.session = null;
  state.isAdmin = false;
  state.roster = [];
  state.activeClientId = null;
  renderClientBranding();
  renderBrandingForms();
  resetTracking();
  state.activity = { clientId: null, entries: null, loading: false, error: '' };
  renderLogs();
  state.selectedItemId = null;
  state.pinUnlocked = false;
  state.quickEditUnlock = null;
  state.filters = emptyFilters();
  state.inventoryView = 'active';
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
  renderWelcomeBanner();
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

  if (hasWarehouseAccess() || (!config.readOnly && !config.requirePin)) {
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
  if (hasWarehouseAccess() || (!config.readOnly && !config.requirePin) || state.pinUnlocked) {
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

// ---- First-time guided tour ----
const ONBOARDING_KEY = 'has_seen_onboarding';
const ONBOARDING_STEPS = [
  {
    title: 'Welcome to your ECL portal',
    body: 'Get started with inventory views, receiving, tracking, and optional product imports. The tour adapts to your account access. Skip now or replay it any time from Help, the last tab on the right.'
  },
  {
    page: 'page-help',
    target: '#faqSearch',
    title: 'Find answers in Help',
    body: 'Search Help for inventory instructions, scanner and tracking guidance, or the Shopify and WooCommerce integration guide. Settings includes packaging notes, appearance and optional store configuration. API integration is still in development and may not work correctly; automatic order sync is not enabled.'
  },
  {
    page: 'page-dashboard',
    target: '#mainTabs',
    title: 'Move between sections',
    body: 'Use the tabs for Dashboard, Updates, Add item when available, Activity, Chat, ECL Tracking, and optional Settings. Help stays at the far right. Some sections depend on your account permissions.'
  },
  {
    page: 'page-dashboard',
    target: '#themeToggle',
    title: 'Choose light or dark mode',
    body: 'Select this button to switch between light mode and dark mode. Your choice is saved in this browser and will be remembered the next time you visit.'
  },
  {
    page: 'page-dashboard',
    target: '#page-dashboard .table-shell',
    title: 'Your inventory at a glance',
    body: 'Search by SKU or product name and use Filters to narrow the list. Double-click an item to open its details; editable fields depend on your permissions. Stock accounts show stock levels, while fulfillment accounts show warehouse and prep stages.'
  },
  {
    page: 'page-dashboard',
    target: '#inboundDashboard',
    available: inboundAvailable,
    title: 'Tell ECL about incoming restocks',
    body: 'Select Notify Restock / Add Inbound Shipment to enter a carrier, tracking number, expected delivery date, product names and quantities. Optionally include SKUs and exact product listing URLs. Staff record arrival, then review inventory matches and received, lost or damaged quantities. Only confirmed usable units are added to inventory.'
  },
  {
    page: 'page-dashboard',
    target: '#inventoryViews [data-view="shipped"]',
    available: shippedViewEnabled,
    title: 'Switch between active and shipped items',
    body: 'Use Active / Non-Shipped and Shipped Items to switch inventory views. The shipped view separates completed shipments from active work without changing your records. This selector appears only when enabled for your account.'
  },
  {
    page: 'page-update',
    target: '.barcode-checkin',
    available: () => barcodeCheckInAllowed() && tourCanOpenItemForms(),
    title: 'Check in a matching item',
    body: 'A unique active match records Arrived / Check-In and a timestamp, with visual confirmation and no quantity changes. Multiple matches require you to select the item. An unmatched barcode opens Add item with the scanned value prefilled; review it before saving. This tour never starts the camera or submits a scan.'
  },
  {
    page: 'page-tracking',
    target: '#trackingSearchForm',
    title: 'Follow shipments in ECL Tracking',
    body: 'Search incoming or outgoing shipments by tracking number, SKU or item name. ECL-branded progress follows sheet updates from In Transit through warehouse arrival, prep and shipping, including scan timestamps. Carrier badges link to UPS, FedEx or USPS details in a new tab; this is not a live carrier-event feed.'
  },
  {
    page: 'page-dashboard',
    target: '#tabOrder',
    available: tourCanAddItems,
    title: 'Add products your way',
    body: 'Choose Add item for manual entry or Sync from Website URL. You can enter product details, quantities, image URLs and bundle information yourself. A store API connection is never required; PIN-protected accounts may need to unlock this page first.'
  },
  {
    page: 'page-order',
    target: '#catalogSyncPanel',
    available: () => tourCanAddItems() && tourCanOpenItemForms(),
    title: 'Import details, then review',
    body: 'Expand Sync from Website URL and fetch a public product page or supported feed. Select one product and apply its details, review or edit the fields, then save. Existing manual entries are kept unless you choose to replace them. If a site cannot be read, continue manually without API keys.'
  },
  {
    page: 'page-logs',
    target: '#logTableWrap',
    title: 'Track every change',
    body: 'The Activity tab records each inventory change with the time, action, who made it, and details. Filter it by any column for quick audits.'
  },
  {
    page: 'page-dashboard',
    target: '.header-right',
    title: 'Your account & password',
    body: 'Your account name and Sign Out live here. To change your password, sign out and choose "Forgot Password?" on the sign-in screen with your recovery code.'
  },
  {
    page: 'page-dashboard',
    target: '#tabHelp',
    title: 'Help is always here',
    body: 'Help is the last navigation tab. Search for step-by-step guides, including optional Shopify/WooCommerce API keys and webhook preparation. API integration in Settings is still in development and may not work correctly. Manual entry and public URL imports remain supported. Replay this tour here whenever you like.'
  }
];
const tourState = { active: false, index: 0, steps: [], returnPage: 'page-dashboard', lastFocus: null, frame: 0, observer: null };

function tourCanAddItems() {
  const profile = state.clientProfile;
  return profile?.clientId === state.activeClientId && Boolean(profile.enableAddItem) && !profile.readOnly;
}

function tourCanOpenItemForms() {
  const config = getClientInventoryFields(state.activeClientId);
  return (!config.readOnly && !config.requirePin) || state.pinUnlocked;
}

// When storage is blocked, treat the tour as seen so it doesn't reappear on every sign-in.
function hasSeenOnboarding() {
  try {
    return localStorage.getItem(ONBOARDING_KEY) === 'true';
  } catch (error) {
    return true;
  }
}

function markOnboardingSeen() {
  try {
    localStorage.setItem(ONBOARDING_KEY, 'true');
  } catch (error) {
    // Ignore storage failures.
  }
}

function maybeStartOnboarding() {
  if (!state.auth || state.isAdmin || hasSeenOnboarding()) return false;
  startOnboardingTour({ returnPage: 'page-dashboard' });
  return true;
}

function startOnboardingTour(options = {}) {
  const overlay = document.getElementById('tourOverlay');
  if (!overlay || !state.auth) return;
  const currentPage = document.querySelector('.page.active')?.id || 'page-dashboard';
  tourState.active = true;
  tourState.index = 0;
  tourState.steps = ONBOARDING_STEPS.filter((step) => !step.available || step.available());
  tourState.returnPage = options.returnPage || currentPage;
  tourState.lastFocus = document.activeElement;
  overlay.hidden = false;
  document.body.classList.add('tour-open');
  window.addEventListener('resize', scheduleTourPosition);
  window.addEventListener('scroll', scheduleTourPosition, { passive: true });
  renderOnboardingStep();
}

function showTourPage(pageId) {
  if (!pageId || document.getElementById(pageId)?.classList.contains('active')) return;
  if (pageId === 'page-logs') goToLogs();
  else if (pageId === 'page-dashboard') goToDashboard();
  else setPage(pageId);
}

function renderOnboardingStep() {
  const step = tourState.steps[tourState.index];
  if (!tourState.active || !step) return;
  const total = tourState.steps.length;
  const isFirst = tourState.index === 0;
  const isLast = tourState.index === total - 1;
  const set = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  set('tourStep', `Step ${tourState.index + 1} of ${total}`);
  set('tourTitle', step.title);
  set('tourBody', step.body);
  const progress = document.getElementById('tourProgress');
  if (progress) {
    progress.innerHTML = tourState.steps.map((_, i) => `<span class="${i === tourState.index ? 'is-active' : i < tourState.index ? 'is-done' : ''}"></span>`).join('');
  }
  const back = document.getElementById('tourBack');
  const next = document.getElementById('tourNext');
  const finish = document.getElementById('tourFinish');
  const skip = document.getElementById('tourSkip');
  if (back) back.hidden = isFirst;
  if (next) next.hidden = isLast;
  if (finish) finish.hidden = !isLast;
  if (skip) skip.hidden = isLast;

  showTourPage(step.page);
  const target = getTourTarget(step);
  if (target) {
    const rect = target.getBoundingClientRect();
    if (rect.height > window.innerHeight * 0.55) {
      window.scrollTo({ top: Math.max(0, window.scrollY + rect.top - 150), behavior: 'auto' });
    } else if (rect.top < 120 || rect.bottom > window.innerHeight - 20) {
      target.scrollIntoView({ block: 'center', behavior: 'auto' });
    }
  } else if (!step.target) {
    window.scrollTo({ top: 0, behavior: 'auto' });
  }
  positionOnboardingTour();
  observeTourTarget(target);
  (isLast ? finish : next)?.focus();
}

// Async content (e.g. the activity log) can resize the highlighted area after the step renders.
function observeTourTarget(target) {
  tourState.observer?.disconnect();
  tourState.observer = null;
  if (!target || typeof ResizeObserver === 'undefined') return;
  tourState.observer = new ResizeObserver(scheduleTourPosition);
  tourState.observer.observe(target);
}

function getTourTarget(step) {
  if (!step?.target) return null;
  const target = document.querySelector(step.target);
  return target && target.getClientRects().length ? target : null;
}

function scheduleTourPosition() {
  if (!tourState.active || tourState.frame) return;
  tourState.frame = requestAnimationFrame(() => {
    tourState.frame = 0;
    positionOnboardingTour();
  });
}

function positionOnboardingTour() {
  const overlay = document.getElementById('tourOverlay');
  const spotlight = document.getElementById('tourSpotlight');
  const card = document.getElementById('tourCard');
  if (!tourState.active || !overlay || !spotlight || !card) return;
  const target = getTourTarget(tourState.steps[tourState.index]);
  card.style.top = '';
  card.style.left = '';
  if (!target) {
    overlay.classList.add('is-centered');
    spotlight.hidden = true;
    return;
  }
  overlay.classList.remove('is-centered');
  spotlight.hidden = false;
  const pad = 6;
  const viewW = window.innerWidth;
  const viewH = window.innerHeight;
  const rect = target.getBoundingClientRect();
  const top = Math.max(rect.top - pad, 4);
  const left = Math.max(rect.left - pad, 4);
  const bottom = Math.min(rect.bottom + pad, viewH - 4);
  const right = Math.min(rect.right + pad, viewW - 4);
  Object.assign(spotlight.style, {
    top: `${top}px`,
    left: `${left}px`,
    width: `${Math.max(right - left, 0)}px`,
    height: `${Math.max(bottom - top, 0)}px`
  });
  // Small screens dock the card to the bottom via CSS.
  if (viewW < 600) return;
  const cardRect = card.getBoundingClientRect();
  const gap = 14;
  let cardTop;
  if (viewH - bottom >= cardRect.height + gap + 8) cardTop = bottom + gap;
  else if (top >= cardRect.height + gap + 8) cardTop = top - cardRect.height - gap;
  else cardTop = viewH - cardRect.height - 16;
  const cardLeft = Math.min(Math.max(left, 16), viewW - cardRect.width - 16);
  card.style.top = `${Math.max(cardTop, 16)}px`;
  card.style.left = `${Math.max(cardLeft, 16)}px`;
}

function moveOnboardingTour(delta) {
  if (!tourState.active) return;
  const nextIndex = tourState.index + delta;
  if (nextIndex < 0 || nextIndex >= tourState.steps.length) return;
  tourState.index = nextIndex;
  renderOnboardingStep();
}

function skipOnboardingTour() {
  closeOnboardingTour({ markSeen: true });
}

function startHelpTour() {
  startOnboardingTour({ returnPage: 'page-help' });
}

function finishOnboardingTour() {
  closeOnboardingTour({ markSeen: true });
  showToast("You're all set! Visit Help any time.", 'success');
}

function closeOnboardingTour({ markSeen = true, restorePage = true } = {}) {
  if (!tourState.active) return;
  tourState.active = false;
  if (tourState.frame) cancelAnimationFrame(tourState.frame);
  tourState.frame = 0;
  tourState.observer?.disconnect();
  tourState.observer = null;
  window.removeEventListener?.('resize', scheduleTourPosition);
  window.removeEventListener?.('scroll', scheduleTourPosition);
  const overlay = document.getElementById('tourOverlay');
  if (overlay) overlay.hidden = true;
  document.body?.classList.remove('tour-open');
  if (markSeen) markOnboardingSeen();
  if (!restorePage) return;
  showTourPage(tourState.returnPage);
  const focusTarget = tourState.returnPage === 'page-help' ? document.getElementById('replayTourBtn') : tourState.lastFocus;
  if (focusTarget && focusTarget.isConnected && focusTarget.getClientRects?.().length) focusTarget.focus();
}

document.addEventListener('keydown', (event) => {
  if (!tourState.active) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    skipOnboardingTour();
  } else if (event.key === 'ArrowRight') {
    moveOnboardingTour(1);
  } else if (event.key === 'ArrowLeft') {
    moveOnboardingTour(-1);
  } else if (event.key === 'Tab') {
    const buttons = [...document.querySelectorAll('#tourCard button')].filter((button) => !button.hidden);
    if (!buttons.length) return;
    const index = buttons.indexOf(document.activeElement);
    const nextIndex = event.shiftKey ? (index <= 0 ? buttons.length - 1 : index - 1) : (index + 1) % buttons.length;
    event.preventDefault();
    buttons[nextIndex].focus();
  }
});

// ---- Help & FAQ ----
function filterFaq() {
  const input = document.getElementById('faqSearch');
  const list = document.getElementById('faqList');
  if (!input || !list) return;
  const terms = String(input.value || '').toLowerCase().split(/\s+/).filter(Boolean);
  const items = [...list.querySelectorAll('.faq-item')];
  let shown = 0;
  items.forEach((item) => {
    const haystack = `${item.textContent} ${item.dataset.keywords || ''}`.toLowerCase();
    const match = terms.every((term) => haystack.includes(term));
    item.hidden = !match;
    if (match) shown += 1;
  });
  const count = document.getElementById('faqCount');
  if (count) {
    count.textContent = terms.length
      ? `${shown} of ${items.length} question${items.length === 1 ? '' : 's'} match`
      : `${items.length} common questions`;
  }
  const empty = document.getElementById('faqEmpty');
  if (empty) empty.hidden = shown > 0;
  if (terms.length && shown === 1) items.find((item) => !item.hidden).open = true;
}

// One answer open at a time keeps the FAQ compact; toggle doesn't bubble, so listen in the capture phase.
document.addEventListener('toggle', (event) => {
  const item = event.target;
  if (!item?.classList?.contains('faq-item') || !item.open) return;
  item.parentElement?.querySelectorAll('.faq-item[open]').forEach((other) => {
    if (other !== item) other.open = false;
  });
}, true);

filterFaq();

let storeConnectionRequestId = 0;
let storeConnectionBusy = false;
let storeConnectionLoaded = false;
let storeConnection = null;

function canManageStoreConnection() {
  return state.auth && state.activeClientId !== 'CL-000'
    && (state.session?.role === 'admin' || (state.session?.role === 'client' && state.session?.clientId === state.activeClientId));
}

function hasWarehouseAccess() {
  return state.auth && ['admin', 'staff'].includes(state.session?.role);
}

function canOpenPortalPage(pageId) {
  if (pageId === 'page-clients') return canConfigureStaff();
  if (pageId === 'page-store-settings') return canManageBranding();
  if (pageId === 'page-billing') return state.session?.role === 'admin'
    || (state.session?.role === 'client' && document.getElementById('tabBilling')?.style.display !== 'none');
  return hasWarehouseAccess() || state.activeClientId === state.session?.clientId;
}

function updateStoreSettingsAccess() {
  const tab = document.getElementById('tabStoreSettings');
  if (tab) tab.style.display = canManageBranding() ? '' : 'none';
  document.querySelectorAll('[data-owner-settings]').forEach(section => {
    section.hidden = !canManageStoreConnection();
  });
}

function storeConnectionMessage(message, error = false) {
  const host = document.getElementById('storeConnectionStatus');
  if (host) {
    host.textContent = message;
    host.classList.toggle('is-error', error);
  }
}

function clearStoreSecrets() {
  ['storeAccessToken', 'storeConsumerKey', 'storeConsumerSecret', 'storeApiToken', 'storeConnectionDetails'].forEach((id) => {
    const input = document.getElementById(id);
    if (input) input.value = '';
  });
}

function resetStoreConnection() {
  storeConnectionRequestId += 1;
  storeConnectionBusy = false;
  storeConnectionLoaded = false;
  storeConnection = null;
  clearStoreSecrets();
  const form = document.getElementById('storeConnectionForm');
  if (form) form.reset();
  const fields = document.getElementById('storeConnectionFields');
  if (fields) fields.disabled = true;
  const status = document.getElementById('storeCredentialStatus');
  if (status) status.textContent = '';
  storeConnectionMessage('');
}

function syncStorePlatform() {
  const platform = document.getElementById('storePlatform');
  if (!platform) return;
  const shopify = platform.value === 'shopify';
  const woo = platform.value === 'woocommerce';
  const generic = !shopify && !woo;
  document.getElementById('shopifyCredentialFields').hidden = !shopify;
  document.getElementById('wooCredentialFields').hidden = !woo;
  document.getElementById('genericCredentialFields').hidden = !generic;
  document.getElementById('storeDomain').placeholder = shopify ? 'your-store.myshopify.com' : 'https://your-store.com';
  document.getElementById('storeAccessToken').disabled = !storeConnection?.storageReady || !shopify;
  ['storeConsumerKey', 'storeConsumerSecret'].forEach((id) => {
    document.getElementById(id).disabled = !storeConnection?.storageReady || !woo;
  });
  ['storeApiToken', 'storeConnectionDetails'].forEach((id) => {
    document.getElementById(id).disabled = !storeConnection?.storageReady || !generic;
  });
}

function renderStoreConnection() {
  const fields = document.getElementById('storeConnectionFields');
  if (!fields) return;
  fields.disabled = !storeConnectionLoaded || storeConnectionBusy;
  document.getElementById('storeConnectionReload').disabled = storeConnectionBusy;
  if (!storeConnection) return;
  document.getElementById('storeStorageWarning').hidden = storeConnection.storageReady;
  document.getElementById('storeCredentialStatus').textContent = storeConnection.hasCredentials
    ? 'Encrypted credentials saved. Their validity has not been tested. Automatic sync is not enabled.'
    : 'No credentials saved. You can save the store address alone, or leave this connection unconfigured.';
  syncStorePlatform();
}

async function loadStoreConnection() {
  if (!canManageStoreConnection()) {
    resetStoreConnection();
    storeConnectionMessage('Only the account owner or an administrator can manage store settings.', true);
    return;
  }
  const clientId = state.activeClientId;
  const session = state.session;
  const requestId = ++storeConnectionRequestId;
  storeConnectionBusy = true;
  storeConnectionLoaded = false;
  clearStoreSecrets();
  renderStoreConnection();
  storeConnectionMessage('Loading optional store settings...');
  try {
    const response = await fetch(`${STORE_CONNECTION_URL}?clientId=${encodeURIComponent(clientId)}`, {
      headers: adminHeaders({ Accept: 'application/json' }), signal: viewSignal()
    });
    const result = await response.json();
    if (requestId !== storeConnectionRequestId || session !== state.session || clientId !== state.activeClientId || !state.auth) return;
    if (!response.ok || !result.success || result.clientId !== clientId) throw new Error(result.error || 'Unable to load store settings.');
    storeConnection = result.connection;
    storeConnectionLoaded = true;
    document.getElementById('storePlatform').value = storeConnection.platform;
    document.getElementById('storeDomain').value = storeConnection.domain;
    document.getElementById('storeRemoveCredentials').checked = false;
    storeConnectionMessage('Configuration only. Manual inventory and URL product imports remain available without a connection.');
  } catch (error) {
    if (requestId === storeConnectionRequestId && error.name !== 'AbortError') {
      storeConnectionMessage(error.message || 'Unable to load settings. Use Reload settings to retry.', true);
    }
  } finally {
    if (requestId === storeConnectionRequestId) {
      storeConnectionBusy = false;
      renderStoreConnection();
    }
  }
}

async function saveStoreConnection(event, disconnect = false) {
  event?.preventDefault();
  if (!canManageStoreConnection() || !storeConnectionLoaded || storeConnectionBusy) return;
  const clientId = state.activeClientId;
  const session = state.session;
  const requestId = ++storeConnectionRequestId;
  const body = disconnect ? { clientId, disconnect: true } : {
    clientId,
    platform: document.getElementById('storePlatform').value,
    domain: document.getElementById('storeDomain').value.trim(),
    removeCredentials: document.getElementById('storeRemoveCredentials').checked
  };
  if (!disconnect && storeConnection?.storageReady && !body.removeCredentials) {
    if (body.platform === 'shopify') body.accessToken = document.getElementById('storeAccessToken').value.trim();
    else if (body.platform === 'woocommerce') {
      body.consumerKey = document.getElementById('storeConsumerKey').value.trim();
      body.consumerSecret = document.getElementById('storeConsumerSecret').value.trim();
    } else {
      body.accessToken = document.getElementById('storeApiToken').value.trim();
      body.connectionDetails = document.getElementById('storeConnectionDetails').value.trim();
    }
  }
  storeConnectionBusy = true;
  renderStoreConnection();
  storeConnectionMessage(disconnect ? 'Removing saved configuration...' : 'Saving optional configuration...');
  try {
    const response = await fetch(STORE_CONNECTION_URL, {
      method: 'PUT', headers: adminHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body), signal: viewSignal()
    });
    const result = await response.json();
    if (requestId !== storeConnectionRequestId || session !== state.session || clientId !== state.activeClientId || !state.auth) return;
    if (!response.ok || !result.success || result.clientId !== clientId) throw new Error(result.error || 'Store settings were not confirmed. Please retry.');
    storeConnection = result.connection;
    document.getElementById('storeDomain').value = storeConnection.domain;
    document.getElementById('storePlatform').value = storeConnection.platform;
    document.getElementById('storeRemoveCredentials').checked = false;
    storeConnectionMessage(disconnect
      ? 'Saved configuration removed. Revoke tokens and remove webhooks separately in your store.'
      : 'Configuration saved, not connected or verified. Automatic order sync is not enabled.');
  } catch (error) {
    if (requestId === storeConnectionRequestId && error.name !== 'AbortError') storeConnectionMessage(error.message || 'Unable to save settings. Please retry.', true);
  } finally {
    // Secrets never survive an attempt in the UI, including a failed save.
    if (requestId === storeConnectionRequestId) {
      clearStoreSecrets();
      storeConnectionBusy = false;
      renderStoreConnection();
    }
  }
}

function openIntegrationGuide() {
  showPage('help');
  const search = document.getElementById('faqSearch');
  if (search) { search.value = ''; filterFaq(); }
  const guide = document.getElementById('integrationGuide');
  if (guide) {
    guide.open = true;
    guide.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
}

let inboundRequest = 0;
let inboundDraftId = null;
let inboundLineId = 0;
let inboundState = { clientId: null, shipments: null, loading: false, busy: false, error: '', message: '' };

function inboundAvailable() {
  return state.auth && state.clientProfile?.clientId === state.activeClientId
    && state.activeClientId !== 'CL-000'
    && ![false, 'false', 0, '0'].includes(state.clientProfile.enableInboundShipments);
}

function closeInboundDialog() {
  document.getElementById('inboundDialog')?.close?.();
  inboundDraftId = null;
  closeReceivingDialog();
}

function resetInboundShipments() {
  inboundRequest += 1;
  closeInboundDialog();
  inboundState = { clientId: null, shipments: null, loading: false, busy: false, error: '', message: '' };
  document.getElementById('inboundForm')?.reset?.();
  renderInboundShipments();
}

function renderInboundShipments() {
  const visible = inboundAvailable();
  if (!visible) closeInboundDialog();
  const current = inboundState.clientId === state.activeClientId;
  const shipments = current ? inboundState.shipments : null;
  const busy = current && inboundState.busy;
  ['inboundDashboard', 'inboundTracking'].forEach((id) => {
    const host = document.getElementById(id);
    if (!host) return;
    host.hidden = !visible;
    if (!visible) { host.innerHTML = ''; return; }
    const markup = `<div class="inbound-heading"><h3>Inbound restock shipments</h3><div class="inbound-actions">
      <button type="button" class="btn-set" data-inbound-action="add"${busy ? ' disabled' : ''}>Notify Restock / Add Inbound Shipment</button>
      <button type="button" class="filter-clear" data-inbound-action="refresh"${busy || (current && inboundState.loading) ? ' disabled' : ''}>Refresh inbound</button></div></div>
      <p class="inbound-hint">Expected boxes and product contents for ${escapeHtml(state.clientProfile?.clientName || getCurrentClientLabel())}. Recording arrival alone does not change stock; warehouse staff confirm usable quantities in the receiving review.</p>
      ${packagingBanner(null)}
      ${state.isAdmin ? `<form class="inbound-scan"><label>Dock scan: tracking number<input name="code" aria-label="Inbound tracking barcode" maxlength="200" autocomplete="off" required${busy ? ' disabled' : ''} placeholder="Scan with USB scanner, then press Enter" /></label><button type="submit" class="btn-set"${busy ? ' disabled' : ''}>Record arrival</button></form>` : ''}
      <p class="inbound-error" role="alert">${current ? escapeHtml(inboundState.error) : ''}</p>
      <p class="inbound-hint" role="status">${current ? escapeHtml(inboundState.message || (inboundState.loading ? 'Loading inbound shipments...' : '')) : ''}</p>
      <div class="inbound-list">${!shipments ? '<p class="inbound-hint">Load inbound shipments with Refresh inbound.</p>' : !shipments.length
        ? '<p class="inbound-hint">No inbound shipments logged yet.</p>'
        : shipments.map((shipment) => `<article class="inbound-card">
          <div class="inbound-heading"><strong>${escapeHtml(shipment.carrier)}</strong><span>${escapeHtml(shipment.status)}</span></div>
          <div class="tracking-number-row">${trackingCarrierMarkup(shipment.trackingNumber)}</div>
          <p>Expected delivery: ${escapeHtml(shipment.expectedDeliveryDate)}</p>
          <ul>${shipment.contents.map((line, index) => `<li>${escapeHtml(inboundProductName(line))} &mdash; ${escapeHtml(String(line.quantity))} expected
            ${shipment.receiving?.[index] ? `<span> &middot; ${escapeHtml(shipment.receiving[index].state)}: ${shipment.receiving[index].decision.received} received, ${shipment.receiving[index].decision.lost} lost, ${shipment.receiving[index].decision.damaged} damaged</span>` : ''}</li>`).join('')}</ul>
          ${shipment.contents.map((line) => state.items.find((item) => line.sku && String(item.sku || '').trim().toUpperCase() === line.sku.toUpperCase()))
            .filter(Boolean).map((item) => packagingBanner(item, false)).join('')}
          <p class="inbound-hint">Notified ${escapeHtml(formatActivityTimestamp(shipment.createdAt))} by ${escapeHtml(shipment.createdBy)}</p>
          ${shipment.arrivedAt ? `<p>Arrived ${escapeHtml(formatActivityTimestamp(shipment.arrivedAt))} &middot; ${escapeHtml(shipment.arrivedBy)}</p>` : state.isAdmin
            ? `<button type="button" class="filter-clear" data-inbound-action="arrive" data-shipment-id="${escapeHtml(shipment.id)}"${busy ? ' disabled' : ''}>Record arrival for this shipment</button>` : ''}
          ${shipment.arrivedAt && state.isAdmin ? `<button type="button" class="filter-clear" data-inbound-action="review" data-shipment-id="${escapeHtml(shipment.id)}"${busy ? ' disabled' : ''}>Review received products</button>` : ''}
        </article>`).join('')}</div>`;
    if (host.innerHTML !== markup) host.innerHTML = markup;
  });
}

async function loadInboundShipments() {
  if (!inboundAvailable() || inboundState.busy || inboundState.loading) return;
  const clientId = state.activeClientId;
  const session = state.session;
  const request = ++inboundRequest;
  if (inboundState.clientId !== clientId) inboundState = { clientId, shipments: null, loading: false, busy: false, error: '', message: '' };
  inboundState.loading = true;
  inboundState.error = '';
  renderInboundShipments();
  try {
    const response = await fetch(`${INBOUND_URL}?clientId=${encodeURIComponent(clientId)}`, { headers: adminHeaders(), signal: viewSignal() });
    const result = await response.json();
    if (request !== inboundRequest || session !== state.session || clientId !== state.activeClientId || !state.auth) return;
    if (!response.ok || !result.success || result.clientId !== clientId || !Array.isArray(result.shipments)) throw new Error(result.error || 'Unable to load inbound shipments.');
    inboundState.shipments = result.shipments;
  } catch (error) {
    if (request === inboundRequest && error.name !== 'AbortError') inboundState.error = error.message || 'Unable to load inbound shipments. Please retry.';
  } finally {
    if (request === inboundRequest) { inboundState.loading = false; renderInboundShipments(); }
  }
}

function addInboundLine() {
  const host = document.getElementById('inboundContents');
  if (!host || host.children.length >= 50) return;
  const id = ++inboundLineId;
  host.insertAdjacentHTML('beforeend', `<div class="inbound-line">
    <label for="inboundName${id}">Product name<input id="inboundName${id}" data-inbound-name list="inboundProductOptions" maxlength="500" required /></label>
    <label for="inboundSku${id}">SKU (optional)<input id="inboundSku${id}" data-inbound-sku maxlength="100" /></label>
    <label for="inboundUrl${id}">Product listing URL (optional)<input id="inboundUrl${id}" data-inbound-url type="url" maxlength="2000" placeholder="https://retailer.com/product" /></label>
    <label for="inboundQty${id}">Expected quantity<input id="inboundQty${id}" data-inbound-quantity type="number" min="1" max="1000000" step="1" required /></label>
    <button type="button" class="filter-clear" data-inbound-remove aria-label="Remove contents line">Remove</button></div>`);
  document.getElementById('inboundAddLine').disabled = host.children.length >= 50;
}

function openInboundDialog() {
  if (!inboundAvailable() || inboundState.busy) return;
  const dialog = document.getElementById('inboundDialog');
  if (!dialog) return;
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    showToast('A secure browser context is required. Open this portal over HTTPS or localhost.', 'error');
    return;
  }
  inboundDraftId = crypto.randomUUID();
  document.getElementById('inboundForm').reset();
  document.getElementById('inboundFields').disabled = false;
  document.getElementById('inboundSave').disabled = false;
  document.getElementById('inboundError').textContent = '';
  document.getElementById('inboundContents').innerHTML = '';
  document.getElementById('inboundProductOptions').innerHTML = state.items.filter((item) => item.title)
    .map((item) => `<option value="${escapeHtml(item.title)}">${escapeHtml(item.sku)}</option>`).join('');
  addInboundLine();
  dialog.showModal();
  document.getElementById('inboundCarrier').focus();
}

async function submitInboundShipment(event) {
  event.preventDefault();
  if (!inboundAvailable() || inboundState.busy || !inboundDraftId) return;
  const contents = [...document.querySelectorAll('#inboundContents .inbound-line')].map((line) => ({
    productName: line.querySelector('[data-inbound-name]').value.trim(),
    sku: line.querySelector('[data-inbound-sku]').value.trim(),
    productUrl: line.querySelector('[data-inbound-url]').value.trim(),
    quantity: Number(line.querySelector('[data-inbound-quantity]').value)
  }));
  if (!contents.length) { document.getElementById('inboundError').textContent = 'Add at least one product line.'; return; }
  await mutateInboundShipment('', {
    shipmentId: inboundDraftId, carrier: document.getElementById('inboundCarrier').value,
    trackingNumber: document.getElementById('inboundTrackingNumber').value.trim(),
    expectedDeliveryDate: document.getElementById('inboundExpectedDate').value, contents
  });
}

async function checkInInboundShipment(code, shipmentId) {
  if (!inboundAvailable() || !state.isAdmin || inboundState.busy) return;
  await mutateInboundShipment('/check-in', { code, ...(shipmentId ? { shipmentId } : {}) });
}

async function mutateInboundShipment(path, body) {
  const clientId = state.activeClientId;
  const session = state.session;
  const request = ++inboundRequest;
  inboundState.clientId = clientId;
  inboundState.loading = false;
  inboundState.busy = true;
  inboundState.error = '';
  inboundState.message = '';
  if (!path) {
    document.getElementById('inboundFields').disabled = true;
    document.getElementById('inboundSave').disabled = true;
    document.getElementById('inboundError').textContent = '';
  }
  renderInboundShipments();
  try {
    const response = await fetch(`${INBOUND_URL}${path}`, {
      method: 'POST', headers: adminHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ clientId, ...body }), signal: viewSignal()
    });
    const result = await response.json();
    if (request !== inboundRequest || session !== state.session || clientId !== state.activeClientId || !state.auth) return;
    if (!response.ok || !result.success || result.clientId !== clientId || !result.shipment) throw new Error(result.error || 'Shipment changes were not confirmed. Refresh before retrying.');
    if (inboundState.shipments) {
      inboundState.shipments = [result.shipment, ...inboundState.shipments.filter((entry) => entry.id !== result.shipment.id)];
    }
    inboundState.message = path ? `${result.alreadyCheckedIn ? 'Already arrived' : 'Arrival recorded'}: ${result.shipment.trackingNumber}. Stock quantities unchanged.` : 'Warehouse notified. Stock quantities unchanged.';
    if (!path) closeInboundDialog();
    else openReceivingDialog(result.shipment);
  } catch (error) {
    if (request === inboundRequest && error.name !== 'AbortError') {
      inboundState.error = error.message || 'Shipment changes were not confirmed. Refresh before retrying.';
      if (!path) document.getElementById('inboundError').textContent = inboundState.error;
    }
  } finally {
    if (request === inboundRequest) {
      inboundState.busy = false;
      if (!path) {
        document.getElementById('inboundFields').disabled = false;
        document.getElementById('inboundSave').disabled = false;
      }
      renderInboundShipments();
      if (!inboundState.shipments && !inboundState.error) loadInboundShipments();
    }
  }
}

let receivingEditor = null;

function inboundProductName(line) {
  return line.productName || state.items.find(item => line.sku && String(item.sku || '').toUpperCase() === line.sku.toUpperCase())?.title || line.sku || 'Product';
}

function safeHttpUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
}

function productSearchLinks(name, productUrl = '') {
  const query = encodeURIComponent(String(name || '').trim());
  const url = safeHttpUrl(productUrl);
  return `<div class="product-search-links">
    ${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Product listing</a>` : ''}
    <a href="https://www.amazon.com/s?k=${query}" target="_blank" rel="noopener noreferrer">Amazon search</a>
    <a href="https://www.ebay.com/sch/i.html?_nkw=${query}" target="_blank" rel="noopener noreferrer">eBay search</a>
    <span>Search results are suggestions, not verified product matches.</span></div>`;
}

function receivingMatches(line, items = state.items) {
  const name = inboundProductName(line).toLowerCase();
  const words = new Set(name.split(/[^a-z0-9]+/).filter(word => word.length > 2));
  return items.map(item => {
    const title = String(item.title || '').toLowerCase();
    const tokens = new Set(title.split(/[^a-z0-9]+/).filter(word => word.length > 2));
    const score = line.sku && String(item.sku || '').toLowerCase() === line.sku.toLowerCase() ? 3
      : title === name ? 2 : [...words].filter(word => tokens.has(word)).length / Math.max(words.size, tokens.size, 1);
    return { item, score };
  }).filter(match => match.score >= .3).sort((a, b) => b.score - a.score).slice(0, 10).map(match => match.item);
}

function closeReceivingDialog() {
  document.getElementById('receivingDialog')?.close?.();
  receivingEditor = null;
}

async function openReceivingDialog(shipment) {
  const dialog = document.getElementById('receivingDialog');
  if (!dialog || !state.isAdmin || !inboundAvailable() || !shipment.arrivedAt) return;
  const clientId = state.activeClientId;
  const session = state.session;
  const editor = { shipment, clientId, session, busy: false, products: new Map() };
  receivingEditor = editor;
  document.getElementById('receivingLines').textContent = 'Loading inventory matches...';
  document.getElementById('receivingMessage').textContent = '';
  dialog.showModal();
  try {
    const status = await fetchInventory(clientId);
    if (receivingEditor !== editor || clientId !== state.activeClientId || session !== state.session) return;
    if (status !== 200) throw new Error('Inventory matches could not load. Close and reopen this review before saving.');
    renderReceivingLines();
  } catch (error) {
    if (receivingEditor === editor) document.getElementById('receivingMessage').textContent = error.message || 'Unable to load inventory matches.';
  }
}

function renderReceivingLines() {
  const editor = receivingEditor;
  if (!editor) return;
  document.getElementById('receivingLines').innerHTML = editor.shipment.contents.map((line, index) => {
    const receipt = editor.shipment.receiving?.[index];
    const decision = receipt?.decision;
    const name = decision?.productName || inboundProductName(line);
    const suggested = receivingMatches(line);
    const matches = [...suggested, ...state.items.filter(item => !suggested.some(match => match.id === item.id))];
    return `<form class="receiving-line" data-receiving-line="${index}">
      <h3>${escapeHtml(name)}</h3>
      <p class="inbound-hint">${line.quantity} expected. Only usable received units will be added to stock. Lost and damaged units stay out of usable inventory.</p>
      <div data-receiving-prep>${packagingBanner(state.items.find(item => item.id === decision?.target), true)}</div>
      <div data-receiving-match></div>
      ${productSearchLinks(name, decision?.productUrl || line.productUrl)}
      ${receipt ? `<p class="inbound-hint">Review ${escapeHtml(receipt.state)} by ${escapeHtml(receipt.by)}: ${decision.received} received, ${decision.lost} lost, ${decision.damaged} damaged.</p>` : ''}
      <fieldset${receipt ? ' disabled' : ''}>
        <label>Inventory action<select name="target"><option value="">Choose an existing product, create a new line, or leave blank if all units are lost/damaged</option><option value="new"${decision?.target === 'new' ? ' selected' : ''}>Create new inventory product</option>
          ${matches.map(item => `<option value="${escapeHtml(item.id)}"${decision?.target === item.id ? ' selected' : ''}>${suggested.some(match => match.id === item.id) ? 'Suggested: ' : ''}${escapeHtml(item.title)} (${escapeHtml(item.sku)})</option>`).join('')}</select></label>
        <div class="inventory-dialog-fields">
          <label>Product name<input name="productName" value="${escapeHtml(name)}" maxlength="500" required /></label>
          <label>SKU (optional for new product)<input name="sku" value="${escapeHtml(decision?.sku || line.sku || '')}" maxlength="100" /></label>
          <label>Usable received<input name="received" type="number" min="0" max="${line.quantity}" value="${decision?.received ?? line.quantity}" required /></label>
          <label>Lost / missing<input name="lost" type="number" min="0" max="${line.quantity}" value="${decision?.lost ?? 0}" required /></label>
          <label>Damaged<input name="damaged" type="number" min="0" max="${line.quantity}" value="${decision?.damaged ?? 0}" required /></label>
          <label>Exact product listing URL<input name="productUrl" type="url" maxlength="2000" value="${escapeHtml(decision?.productUrl || line.productUrl || '')}" /></label>
          <label>Product image URL<input name="imageUrl" type="url" maxlength="2000" value="${escapeHtml(decision?.imageUrl || '')}" /></label>
        </div>
        <button type="button" class="filter-clear" data-receiving-fetch>Fetch product details from listing URL</button>
        <div data-receiving-preview></div>
      </fieldset>
      <p class="inventory-dialog-error" data-receiving-error role="alert"></p>
      ${receipt?.state !== 'complete' ? `<button type="submit" class="btn-set">${receipt ? 'Retry same receiving decision' : 'Confirm received / lost / damaged quantities'}</button>` : ''}
    </form>`;
  }).join('');
}

async function fetchReceivingProduct(form) {
  const editor = receivingEditor;
  if (!editor || editor.busy) return;
  const field = name => form.elements.namedItem(name);
  const error = form.querySelector('[data-receiving-error]');
  const url = safeHttpUrl(field('productUrl').value);
  if (!url) { error.textContent = 'Enter an exact public product listing URL first.'; return; }
  editor.busy = true;
  const button = form.querySelector('[data-receiving-fetch]');
  button.disabled = true;
  error.textContent = '';
  try {
    const response = await fetch(CATALOG_SYNC_URL, {
      method: 'POST', headers: adminHeaders({ 'Content-Type': 'application/json' }), signal: viewSignal(),
      body: JSON.stringify({ clientId: editor.clientId, url })
    });
    const result = await response.json();
    if (receivingEditor !== editor || state.session !== editor.session || state.activeClientId !== editor.clientId) return;
    if (!response.ok || !result.success || !result.products?.length) throw new Error(result.error || 'No product details found. Manual entry remains available.');
    editor.products.set(form.dataset.receivingLine, result.products);
    form.querySelector('[data-receiving-preview]').innerHTML = `<label>Review a product from this URL<select data-receiving-product>${result.products.map((product, index) => `<option value="${index}">${escapeHtml(product.title)} (${escapeHtml(product.sku || 'no SKU')})</option>`).join('')}</select></label><button type="button" class="filter-clear" data-receiving-apply>Use selected product details</button>`;
  } catch (failure) {
    if (receivingEditor === editor) error.textContent = failure.message || 'Unable to fetch product details.';
  } finally {
    editor.busy = false;
    button.disabled = false;
  }
}

async function saveReceivingLine(form) {
  const editor = receivingEditor;
  if (!editor || editor.busy || !state.isAdmin || editor.clientId !== state.activeClientId || editor.session !== state.session || !inboundAvailable()) return;
  const index = Number(form.dataset.receivingLine);
  const decision = editor.shipment.receiving?.[index]?.decision;
  const value = name => form.elements.namedItem(name).value;
  const target = state.items.find(item => item.id === value('target'));
  const body = {
    ...(decision || {
      target: value('target'), productName: value('productName'), sku: value('sku'),
      received: Number(value('received')), lost: Number(value('lost')), damaged: Number(value('damaged')),
      productUrl: value('productUrl'), imageUrl: value('imageUrl')
    }),
    clientId: editor.clientId, shipmentId: editor.shipment.id, lineIndex: index,
    targetTitle: target?.title, targetSku: target?.sku
  };
  const error = form.querySelector('[data-receiving-error]');
  if ([body.received, body.lost, body.damaged].some(qty => !Number.isSafeInteger(qty) || qty < 0)
    || body.received + body.lost + body.damaged !== editor.shipment.contents[index].quantity) {
    error.textContent = 'Received, lost and damaged must total the expected quantity.'; return;
  }
  editor.busy = true;
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  error.textContent = '';
  try {
    const response = await fetch(`${INBOUND_URL}/receive`, {
      method: 'POST', headers: adminHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body), signal: viewSignal()
    });
    const result = await response.json();
    if (receivingEditor !== editor || state.session !== editor.session || state.activeClientId !== editor.clientId) return;
    if (!response.ok || !result.success || result.clientId !== editor.clientId) throw new Error(result.error || 'Receiving was not confirmed. Refresh before retrying.');
    editor.shipment = result.shipment;
    if (inboundState.shipments) inboundState.shipments = inboundState.shipments.map(shipment => shipment.id === result.shipment.id ? result.shipment : shipment);
    renderReceivingLines();
    const status = await fetchInventory(editor.clientId);
    if (receivingEditor !== editor || state.session !== editor.session || state.activeClientId !== editor.clientId) return;
    if (status !== 200) throw new Error('Receiving saved, but inventory could not refresh. Close and reopen this review.');
    renderTable();
    renderInboundShipments();
    renderReceivingLines();
    document.getElementById('receivingMessage').textContent = 'Receiving saved. Only usable received units were added to inventory.';
  } catch (failure) {
    if (receivingEditor === editor) error.textContent = failure.message || 'Receiving save failed. Refresh and retry the same decision.';
  } finally {
    editor.busy = false;
    button.disabled = false;
  }
}

let packagingEditor = null;
let packagingRequest = 0;

function currentPackagingNotes() {
  return state.clientProfile?.clientId === state.activeClientId ? state.clientProfile.packagingNotes || '' : '';
}

function packagingBanner(item, includeGlobal = true) {
  const global = includeGlobal ? currentPackagingNotes() : '';
  const special = item?.prepInstructions || '';
  return `${global ? `<aside class="prep-banner"><h3>Client SOP / Packaging Notes</h3><p>${escapeHtml(global)}</p></aside>` : ''}
    ${special ? `<aside class="prep-banner"><h3>Special Prep Instructions${item?.sku ? `: ${escapeHtml(item.sku)}` : ''}</h3><p>${escapeHtml(special)}</p></aside>` : ''}`;
}

function renderPackagingInstructions() {
  const profile = state.clientProfile;
  const current = state.auth && profile?.clientId === state.activeClientId && state.activeClientId !== 'CL-000';
  for (const id of ['packagingProfile', 'settingsPackagingProfile']) {
    const host = document.getElementById(id);
    if (!host) continue;
    const settings = id === 'settingsPackagingProfile';
    const visible = current && (settings ? canManageStoreConnection() : Boolean(currentPackagingNotes()));
    host.hidden = !visible;
    host.innerHTML = visible ? `<h3>Standard Operating Procedure / Packaging Notes</h3>
      ${settings ? '<p class="integration-description">Tell the ECL warehouse team how to handle and package orders for your business. These client-wide instructions apply to every item, such as including a thank-you card in each box, using branded packaging or following a standard packing checklist. Saved notes appear on your Dashboard and on warehouse receiving, inspection and packing screens. For instructions that apply to just one SKU, use that item\'s Special Prep Instructions instead.</p>' : ''}
      ${packagingBanner(null) || '<p class="inbound-hint">No client-wide packaging notes saved.</p>'}
      ${settings && canManageStoreConnection() ? '<button type="button" class="filter-clear" data-edit-packaging>Edit client packaging notes</button>' : ''}` : '';
  }
  const selected = state.items.find((item) => String(item.id) === String(state.selectedItemId));
  const modal = inventoryItemEditor?.clientId === state.activeClientId ? inventoryItemEditor.item : null;
  for (const [id, item, includeGlobal] of [
    ['warehousePackagingBanner', null, true], ['selectedPackagingBanner', selected, false],
    ['itemPackagingBanner', modal, true]
  ]) {
    const banner = document.getElementById(id);
    if (banner) banner.innerHTML = current ? packagingBanner(item, includeGlobal) : '';
  }
}

function closePackagingDialog() {
  packagingRequest += 1;
  packagingEditor = null;
  document.getElementById('packagingDialog')?.close?.();
  document.getElementById('packagingForm')?.reset?.();
}

function openPackagingDialog() {
  if (!canManageStoreConnection()) return;
  packagingEditor = { clientId: state.activeClientId, previousNotes: currentPackagingNotes(), busy: false };
  document.getElementById('packagingNotesInput').value = packagingEditor.previousNotes;
  document.getElementById('packagingNotesInput').disabled = false;
  document.getElementById('packagingSave').disabled = false;
  document.getElementById('packagingError').textContent = '';
  document.getElementById('packagingDialog').showModal();
  document.getElementById('packagingNotesInput').focus();
}

async function savePackagingNotes(event) {
  event.preventDefault();
  const editor = packagingEditor;
  if (!editor || editor.busy || !canManageStoreConnection() || editor.clientId !== state.activeClientId) return;
  const session = state.session;
  const request = ++packagingRequest;
  editor.busy = true;
  document.getElementById('packagingNotesInput').disabled = true;
  document.getElementById('packagingSave').disabled = true;
  document.getElementById('packagingError').textContent = '';
  try {
    const response = await fetch(`${API_BASE}/api/packaging-notes`, {
      method: 'PUT', headers: adminHeaders({ 'Content-Type': 'application/json' }), signal: viewSignal(),
      body: JSON.stringify({ clientId: editor.clientId, previousNotes: editor.previousNotes, packagingNotes: document.getElementById('packagingNotesInput').value })
    });
    const result = await response.json();
    if (request !== packagingRequest || session !== state.session || editor.clientId !== state.activeClientId || !state.auth) return;
    if (!response.ok || !result.success || result.clientId !== editor.clientId) throw new Error(result.error || 'Packaging notes were not confirmed. Please refresh.');
    state.clientProfile.packagingNotes = result.packagingNotes;
    cacheClientView(editor.clientId, { profile: state.clientProfile });
    closePackagingDialog();
    renderPackagingInstructions();
    renderInboundShipments();
    renderTracking();
    showToast('Packaging notes saved.');
  } catch (error) {
    if (request === packagingRequest && error.name !== 'AbortError') document.getElementById('packagingError').textContent = error.message || 'Unable to save packaging notes.';
  } finally {
    if (request === packagingRequest) {
      editor.busy = false;
      document.getElementById('packagingNotesInput').disabled = false;
      document.getElementById('packagingSave').disabled = false;
    }
  }
}

function normalizeTrackingNumber(value) {
  return String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '');
}

function detectTrackingCarrier(value) {
  const number = normalizeTrackingNumber(value);
  if (/^1Z[A-Z0-9]+$/.test(number)) {
    return { name: 'UPS', key: 'ups', number, url: `https://www.ups.com/track?loc=en_US&tracknum=${encodeURIComponent(number)}` };
  }
  // USPS overlaps FedEx's 20-digit format, so its prefixes take precedence.
  if (/^(?=\d{20,22}$)(?:9|82)\d+$/.test(number)) {
    return { name: 'USPS', key: 'usps', number, url: `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(number)}` };
  }
  if (/^(?:\d{12}|\d{15}|\d{20})$/.test(number)) {
    return { name: 'FedEx', key: 'fedex', number, url: `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(number)}` };
  }
  return null;
}

function trackingCarrierMarkup(value) {
  const carrier = detectTrackingCarrier(value);
  return `<span class="tracking-number">${escapeHtml(value)}</span>${carrier
    ? `<span class="carrier-badge carrier-${carrier.key}">${carrier.name}</span><a class="tracking-carrier-link" href="${escapeHtml(carrier.url)}" target="_blank" rel="noopener noreferrer">View ${carrier.name} details <span class="sr-only">(opens in a new tab)</span></a>`
    : '<span class="carrier-badge">Carrier unknown</span>'}`;
}

function resetTracking() {
  trackingRequestId += 1;
  state.tracking = { clientId: null, items: null, query: '', updatedAt: '', loading: false, error: '' };
  const input = document.getElementById('trackingSearchInput');
  if (input) input.value = '';
  renderTracking();
}

async function loadTracking(clientId = state.activeClientId) {
  if (!state.auth || !state.session?.notificationToken) return 401;
  loadInboundShipments();
  const requestId = ++trackingRequestId;
  const session = state.session;
  if (state.tracking.clientId !== clientId) {
    state.tracking = { clientId, items: null, query: '', updatedAt: '', loading: false, error: '' };
  }
  state.tracking.loading = true;
  state.tracking.error = '';
  renderTracking();
  const isCurrent = () => requestId === trackingRequestId && state.auth && state.session === session && state.activeClientId === clientId;
  let status = 0;
  try {
    const response = await fetch(`${TRACKING_URL}?clientId=${encodeURIComponent(clientId)}`, {
      headers: adminHeaders({ Accept: 'application/json' }), signal: viewSignal()
    });
    status = response.status;
    if (!response.ok) throw new Error(`Tracking request failed (${status})`);
    const result = await response.json();
    if (result.clientId !== clientId || !Array.isArray(result.items)) throw new Error('Invalid tracking response');
    if (isCurrent()) {
      state.tracking.items = result.items;
      state.tracking.updatedAt = result.updatedAt;
    }
    return 200;
  } catch (error) {
    if (error.name === 'AbortError' || !isCurrent()) return 0;
    console.error('Tracking fetch failed:', error);
    state.tracking.error = status === 401 ? 'Sign in again to view tracking.'
      : 'Unable to refresh ECL tracking. Use Refresh status to retry. Previously loaded progress may be out of date.';
    return status === 200 ? 0 : status;
  } finally {
    if (isCurrent()) {
      state.tracking.loading = false;
      renderTracking();
    }
  }
}

function renderTracking() {
  const host = document.getElementById('trackingResults');
  if (!host) return;
  const tracking = state.tracking;
  const current = state.auth && tracking.clientId === state.activeClientId;
  const items = current ? tracking.items : null;
  const query = current ? tracking.query.trim() : '';
  const normalized = normalizeTrackingNumber(query);
  const matches = (items || []).filter((item) => !query
    || item.trackingNumbers.some((entry) => normalizeTrackingNumber(entry.number) === normalized)
    || normalizeTrackingNumber(item.sku) === normalized
    || String(item.title || '').toLowerCase().includes(query.toLowerCase()));
  const errorHost = document.getElementById('trackingError');
  if (errorHost) {
    errorHost.hidden = !current || !tracking.error;
    errorHost.textContent = current ? tracking.error : '';
  }
  const refresh = document.getElementById('trackingRefresh');
  if (refresh) refresh.disabled = !state.auth || (current && tracking.loading);
  const summary = document.getElementById('trackingSummary');
  if (summary) summary.textContent = current && tracking.loading ? 'Refreshing ECL progress...'
    : items ? `${matches.length} item${matches.length === 1 ? '' : 's'} in ${state.activeClientId}. Last refreshed ${formatActivityTimestamp(tracking.updatedAt)}.`
      : 'Select an account to view its ECL shipment progress.';
  const preview = document.getElementById('trackingCarrierPreview');
  if (preview) preview.innerHTML = detectTrackingCarrier(query)
    ? `<p>Detected carrier (format only)</p><div class="tracking-number-row">${trackingCarrierMarkup(query)}</div>` : '';
  host.setAttribute('aria-busy', String(Boolean(current && tracking.loading)));
  const labels = ['In Transit', 'Arrived at Warehouse', 'In Prep', 'Shipped'];
  const markup = (current ? packagingBanner(null) : '') + (!items
    ? '<p class="tracking-empty">Tracking records will appear here after loading.</p>'
    : !matches.length
      ? `<p class="tracking-empty">${query ? 'No matching records in this account. A detected carrier link does not confirm an ECL shipment or its status.' : 'No inventory records in this account yet.'}</p>`
      : matches.map((item) => {
        const stage = Number.isInteger(item.stage) && item.stage >= 0 && item.stage < labels.length ? item.stage : null;
        const progression = stage === null
          ? '<p class="tracking-stock-note">Stock-managed item. Warehouse fulfillment progression is not available.</p>'
          : `<ol class="tracking-progress" aria-label="ECL warehouse progress">${labels.map((label, index) =>
            `<li class="${index < stage ? 'is-complete' : index === stage ? 'is-current' : ''}"${index === stage ? ' aria-current="step"' : ''}><span class="tracking-step-dot" aria-hidden="true">${index + 1}</span><span>${label}</span>${index === stage ? '<span class="sr-only"> (current stage)</span>' : ''}</li>`
          ).join('')}</ol>`;
        return `<article class="tracking-card"><div class="tracking-card-heading"><div><h3>${escapeHtml(item.title)}</h3><p>SKU: ${escapeHtml(item.sku || 'Not set')}</p></div><span class="tracking-sheet-status">${escapeHtml(item.status)}</span></div>
          ${packagingBanner(item, false)}
          ${progression}
          ${item.checkInTimestamp ? `<p class="tracking-checkin">Warehouse check-in: ${escapeHtml(formatActivityTimestamp(item.checkInTimestamp))}</p>` : ''}
          <div class="tracking-numbers">${item.trackingNumbers.length ? item.trackingNumbers.map((entry) =>
            `<div><p class="tracking-number-label">${escapeHtml(entry.label)}</p><div class="tracking-number-row">${trackingCarrierMarkup(entry.number)}</div></div>`
          ).join('') : '<p>No tracking number saved on this inventory record.</p>'}</div></article>`;
      }).join(''));
  if (host.innerHTML !== markup) host.innerHTML = markup;
}

function searchTracking(event) {
  event.preventDefault();
  if (!state.auth) return;
  state.tracking.query = document.getElementById('trackingSearchInput').value;
  renderTracking();
}

async function loadActivity(clientId = state.activeClientId) {
  if (!state.auth || !state.session?.notificationToken) return 401;
  const requestId = ++activityRequestId;
  const session = state.session;
  if (state.activity.clientId !== clientId) {
    state.activity = { clientId, entries: null, loading: false, error: '' };
  }
  state.activity.loading = true;
  state.activity.error = '';
  renderLogs();
  const isCurrent = () => requestId === activityRequestId && state.auth && state.session === session && state.activeClientId === clientId;
  let status = 0;
  try {
    const response = await fetch(`${ACTIVITY_URL}?clientId=${encodeURIComponent(clientId || session.clientId)}`, {
      headers: { Authorization: `Bearer ${session.notificationToken}`, Accept: 'application/json' },
      signal: viewSignal()
    });
    status = response.status;
    if (!response.ok) throw new Error(`Activity request failed (${status})`);
    const entries = await response.json();
    if (!Array.isArray(entries)) throw new Error('Invalid activity response');
    if (isCurrent()) state.activity.entries = entries;
    return 200;
  } catch (error) {
    if (error.name === 'AbortError' || !isCurrent()) return 0;
    console.error('Activity fetch failed:', error);
    state.activity.error = status === 401 ? 'Sign in again to view activity history.' : 'Unable to load activity history. Please retry.';
    return status === 200 ? 0 : status;
  } finally {
    if (isCurrent()) {
      state.activity.loading = false;
      renderLogs();
    }
  }
}

function formatActivityTimestamp(timestamp) {
  const date = new Date(timestamp);
  return timestamp && Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Not recorded';
}

function renderLogs() {
  if (!logTableWrap) return;
  const activity = state.activity;
  const value = (logSearch?.value || '').trim().toLowerCase();
  const entries = activity.clientId === state.activeClientId ? activity.entries || [] : [];
  const rows = entries.filter((entry) => !value || [
    entry.timestamp, formatActivityTimestamp(entry.timestamp), entry.action, entry.actorUsername, entry.description, entry.clientId
  ].join(' ').toLowerCase().includes(value));
  logTableWrap.setAttribute('aria-busy', String(activity.loading));
  const notice = activity.error
    ? `<div class="activity-notice" role="alert">${escapeHtml(activity.error)} <button type="button" class="btn-set" onclick="loadActivity()">Retry</button>${entries.length ? ' Showing previously loaded activity.' : ''}</div>`
    : '';
  const emptyMessage = activity.error ? 'Activity history is unavailable.'
    : activity.loading || activity.entries === null ? 'Loading activity history...'
      : value ? 'No matching log entries.' : 'No activity to display.';
  logTableWrap.innerHTML = `${notice}
    <table class="activity-table">
      <caption class="activity-caption">Recorded inventory activity, newest first. Times are shown in your local time zone.</caption>
      <thead><tr>
        <th scope="col">Timestamp</th>
        <th scope="col">Action</th>
        <th scope="col">User</th>
        <th scope="col">Details</th>
      </tr></thead>
      <tbody>${rows.length ? rows.map((entry) => `
        <tr>
          <td>${escapeHtml(formatActivityTimestamp(entry.timestamp))}</td>
          <td>${escapeHtml(entry.action)}</td>
          <td>${escapeHtml(entry.actorUsername || 'Not recorded')}</td>
          <td>${state.isAdmin ? `<span class="activity-client">${escapeHtml(entry.clientId)}</span>` : ''}${escapeHtml(entry.description || 'No details recorded')}</td>
        </tr>`).join('') : `<tr><td colspan="4" class="no-results" role="status">${emptyMessage}</td></tr>`}</tbody>
    </table>`;
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

  const isStaff = hasWarehouseAccess();
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

let barcodeCheckIn = null;
let barcodeScanBusy = false;
let barcodeCamera = null;
let barcodeCameraStarting = false;
let barcodeCameraGeneration = 0;
let barcodeDecodeBusy = false;
let barcodeCameraStopping = null;
let barcodeAudio = null;

function isBarcodeCameraRunning(camera) {
  const status = camera.getState();
  return status === Html5QrcodeScannerState.SCANNING || status === Html5QrcodeScannerState.PAUSED;
}

function stopBarcodeTracks() {
  const reader = document.getElementById('barcodeCameraReader');
  reader?.querySelectorAll('video').forEach((video) => {
    video.srcObject?.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
  });
}

async function releaseBarcodeCamera(camera) {
  try {
    if (isBarcodeCameraRunning(camera)) await camera.stop();
  } catch (error) {
    setBarcodeScanMessage(`Camera cleanup error: ${error.message || error}. Camera tracks have been stopped.`, true);
  } finally {
    stopBarcodeTracks();
    try {
      camera.clear();
    } catch (error) {
      setBarcodeScanMessage(`Unable to clear scanner: ${error.message || error}. Camera tracks have been stopped.`, true);
    }
    document.getElementById('barcodeCameraReader')?.replaceChildren();
    if (barcodeCamera === camera) barcodeCamera = null;
  }
}

function stopBarcodeCamera() {
  barcodeCameraGeneration += 1;
  const panel = document.getElementById('barcodeCameraPanel');
  if (panel) panel.hidden = true;
  stopBarcodeTracks();
  if (barcodeAudio) {
    barcodeAudio.close().catch((error) => console.warn('Scanner audio cleanup failed:', error));
    barcodeAudio = null;
  }
  if (!barcodeCamera || barcodeCameraStarting) return Promise.resolve();
  if (!barcodeCameraStopping) {
    barcodeCameraStopping = releaseBarcodeCamera(barcodeCamera).finally(() => { barcodeCameraStopping = null; });
  }
  return barcodeCameraStopping;
}

async function startBarcodeCamera() {
  if (!barcodeCheckInAllowed() || barcodeCamera || barcodeCameraStarting || barcodeCameraStopping) return;
  resetBarcodeCheckIn();
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    setBarcodeScanMessage('Camera scanning requires HTTPS (or localhost) and camera permission. You can still use the USB scan field.', true);
    return;
  }
  if (typeof Html5Qrcode !== 'function') {
    setBarcodeScanMessage('Camera scanner could not load. Refresh the page or use the USB scan field.', true);
    return;
  }
  const generation = ++barcodeCameraGeneration;
  const session = state.session;
  const clientId = state.activeClientId;
  const panel = document.getElementById('barcodeCameraPanel');
  panel.hidden = false;
  barcodeCameraStarting = true;
  let camera;
  try {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (Audio) {
      try {
        barcodeAudio = new Audio();
        barcodeAudio.resume().catch((error) => console.warn('Scanner audio unavailable:', error));
      } catch (error) {
        console.warn('Scanner audio unavailable:', error);
      }
    }
    camera = new Html5Qrcode('barcodeCameraReader');
    barcodeCamera = camera;
    const startedAt = Date.now();
    let decodingHintShown = false;
    await camera.start({ facingMode: 'environment' }, { fps: 10 }, async (code) => {
      if (barcodeDecodeBusy || barcodeScanBusy || barcodeCheckIn || barcodeCameraGeneration !== generation
        || state.session !== session || state.activeClientId !== clientId || !barcodeCheckInAllowed()) return;
      if (typeof code !== 'string' || !code.trim()) {
        setBarcodeScanMessage('Barcode could not be read. Center one barcode in the target and try again.', true);
        return;
      }
      barcodeDecodeBusy = true;
      document.getElementById('barcodeScanInput').value = code;
      barcodeScanFeedback(true);
      setBarcodeScanMessage('Barcode captured. Looking up item...');
      const stopping = stopBarcodeCamera();
      const stoppedGeneration = barcodeCameraGeneration;
      try {
        await stopping;
        if (barcodeCameraGeneration !== stoppedGeneration || state.session !== session
          || state.activeClientId !== clientId || !barcodeCheckInAllowed()) return;
        await scanBarcode({ preventDefault() {} });
      } catch (error) {
        setBarcodeScanMessage(`Barcode lookup failed: ${error.message || error}. Try again or use the USB scan field.`, true);
      } finally {
        barcodeDecodeBusy = false;
      }
    }, () => {
      // A missed frame is normal while the user is positioning a barcode.
      if (!decodingHintShown && Date.now() - startedAt > 5000 && generation === barcodeCameraGeneration && !barcodeDecodeBusy) {
        decodingHintShown = true;
        setBarcodeScanMessage('No barcode decoded yet. Center one barcode in the target, improve lighting and hold steady.');
      }
    });
    if (generation === barcodeCameraGeneration) setBarcodeScanMessage('Camera ready. Center one barcode in the target.');
  } catch (error) {
    if (generation === barcodeCameraGeneration) {
      setBarcodeScanMessage(`Camera unavailable: ${error.message || error}. Allow camera access or use the USB scan field.`, true);
    }
  } finally {
    barcodeCameraStarting = false;
    if (!camera || generation !== barcodeCameraGeneration || !isBarcodeCameraRunning(camera)) await stopBarcodeCamera();
  }
}

function barcodeScanFeedback(withAudio = false) {
  if (withAudio && barcodeAudio) {
    const audio = barcodeAudio;
    barcodeAudio = null;
    try {
      const tone = audio.createOscillator();
      const gain = audio.createGain();
      tone.frequency.value = 880;
      gain.gain.value = 0.08;
      tone.connect(gain);
      gain.connect(audio.destination);
      tone.onended = () => audio.close().catch((error) => console.warn('Scanner audio cleanup failed:', error));
      tone.start();
      tone.stop(audio.currentTime + 0.12);
    } catch (error) {
      console.warn('Scanner audio feedback failed:', error);
      audio.close().catch((closeError) => console.warn('Scanner audio cleanup failed:', closeError));
    }
  }
  const host = document.getElementById('barcodeScanMessage');
  if (host) {
    host.classList.add('scan-success');
    setTimeout(() => host.classList.remove('scan-success'), 1500);
  }
}

function barcodeCheckInAllowed() {
  return state.auth && state.isAdmin && isFulfillmentClient();
}

function setBarcodeScanMessage(message, isError = false) {
  const host = document.getElementById('barcodeScanMessage');
  if (!host) return;
  host.textContent = message;
  host.classList.toggle('is-error', isError);
}

function syncBarcodeCheckIn() {
  const allowed = barcodeCheckInAllowed();
  ['barcodeScanInput', 'barcodeScanSubmit', 'barcodeConfirmSubmit', 'barcodeScanMatch', 'barcodeCameraStart'].forEach((id) => {
    const input = document.getElementById(id);
    if (input) input.disabled = !allowed || barcodeScanBusy;
  });
  if (!allowed) {
    stopBarcodeCamera();
    const form = document.getElementById('barcodeConfirmForm');
    if (form) form.hidden = true;
    setBarcodeScanMessage(state.isAdmin
      ? 'Select an order-fulfillment account to check in items.'
      : 'Only ECL staff can record warehouse arrivals.');
  }
}

function resetBarcodeCheckIn() {
  stopBarcodeCamera();
  barcodeCheckIn = null;
  const form = document.getElementById('barcodeConfirmForm');
  if (form) form.hidden = true;
  const input = document.getElementById('barcodeScanInput');
  if (input) input.value = '';
  setBarcodeScanMessage('');
  const instructions = document.getElementById('scanPackagingBanner');
  if (instructions) instructions.innerHTML = '';
}

function normalizeBarcode(value) {
  return String(value ?? '').trim().toUpperCase();
}

function findBarcodeMatches(items, code, clientId, fields = []) {
  const normalized = normalizeBarcode(code);
  if (!normalized) return [];
  const customKeys = fields.filter((field) => /sku|upc|tracking/i.test(`${field.key} ${field.label}`)).map((field) => field.key);
  const keys = [...new Set(['sku', 'upc', 'trackingNumber', 'tracking', ...customKeys])];
  return items.filter((item) => (!item.clientId || item.clientId === clientId) && !isShippedItem(item)
    && keys.some((key) => normalizeBarcode(item[key]) === normalized));
}

function previewBarcodeCheckIn() {
  const editor = barcodeCheckIn;
  if (!editor) return;
  const id = document.getElementById('barcodeScanMatch').value;
  const item = editor.items.find((entry) => String(entry.id) === id);
  const instructions = document.getElementById('scanPackagingBanner');
  if (instructions) instructions.innerHTML = packagingBanner(item);
  const host = document.getElementById('barcodeScanPreview');
  if (!item) {
    host.textContent = 'More than one item matches. Choose the item being received.';
    return;
  }
  host.textContent = `${item.title || item.sku}: record Arrived / Check-In and a timestamp. Quantities remain unchanged.`;
}

async function scanBarcode(event) {
  event.preventDefault();
  if (barcodeScanBusy) return;
  if (!barcodeCheckInAllowed()) {
    syncBarcodeCheckIn();
    return;
  }
  const input = document.getElementById('barcodeScanInput');
  const scannedValue = input.value;
  const code = normalizeBarcode(input.value);
  resetBarcodeCheckIn();
  input.value = scannedValue;
  if (!code) {
    setBarcodeScanMessage('Scan or enter a UPC, SKU or tracking number first.', true);
    input.focus();
    return;
  }
  const clientId = state.activeClientId;
  const session = state.session;
  barcodeScanBusy = true;
  syncBarcodeCheckIn();
  setBarcodeScanMessage('Looking up barcode...');
  try {
    const status = await fetchInventory(clientId);
    if (session !== state.session || clientId !== state.activeClientId) return;
    if (status !== 200) throw new Error('Unable to refresh inventory. Try scanning again.');
    const matches = findBarcodeMatches(state.items, code, clientId, state.clientProfile?.fields);
    if (!matches.length) {
      renderProductForm();
      const fields = getFormFields(clientId, 'inventory');
      const field = fields.find((entry) => /upc/i.test(`${entry.key} ${entry.label}`)) || fields.find((entry) => /tracking/i.test(`${entry.key} ${entry.label}`));
      const target = document.getElementById(field ? `customField_${field.key}` : 'newProductSku');
      if (!target || document.getElementById('createProductSubmit')?.disabled) throw new Error('No matching active record. This account cannot add inventory.');
      target.value = code;
      target.dataset.userTyped = 'true';
      showPage('order');
      target.focus();
      showToast('No active match. Barcode filled in Add Item; review the other fields before saving.', 'success');
      return;
    }
    barcodeCheckIn = { clientId, session, code, items: matches.map((item) => ({ ...item })) };
    if (matches.length === 1) {
      await recordBarcodeArrival(barcodeCheckIn, matches[0]);
      return;
    }
    const select = document.getElementById('barcodeScanMatch');
    select.innerHTML = (matches.length > 1 ? '<option value="">Choose an item to check in</option>' : '') + matches.map((item) =>
      `<option value="${escapeHtml(item.id)}">${escapeHtml(item.title || 'Inventory item')} — ${escapeHtml(item.upc || item.sku || item.id)} (${escapeHtml(item.id)})</option>`
    ).join('');
    document.getElementById('barcodeConfirmForm').hidden = false;
    setBarcodeScanMessage(`${matches.length} items matched. Choose the item before checking in.`);
    previewBarcodeCheckIn();
  } catch (error) {
    if (session === state.session && clientId === state.activeClientId) setBarcodeScanMessage(error.message || 'Unable to look up barcode.', true);
  } finally {
    barcodeScanBusy = false;
    syncBarcodeCheckIn();
  }
}

async function confirmBarcodeCheckIn(event) {
  event.preventDefault();
  const editor = barcodeCheckIn;
  if (barcodeScanBusy || !editor) return;
  if (!barcodeCheckInAllowed() || editor.session !== state.session || editor.clientId !== state.activeClientId) {
    resetBarcodeCheckIn();
    syncBarcodeCheckIn();
    return;
  }
  const item = editor.items.find((entry) => String(entry.id) === document.getElementById('barcodeScanMatch').value);
  if (!item) {
    setBarcodeScanMessage('Choose which matching item to check in.', true);
    return;
  }
  barcodeScanBusy = true;
  syncBarcodeCheckIn();
  try {
    await recordBarcodeArrival(editor, item);
  } finally {
    barcodeScanBusy = false;
    syncBarcodeCheckIn();
  }
}

async function recordBarcodeArrival(editor, item) {
  const instructions = document.getElementById('scanPackagingBanner');
  if (instructions) instructions.innerHTML = packagingBanner(item);
  setBarcodeScanMessage('Recording arrival...');
  try {
    const response = await fetch(`${API_BASE}/api/inventory/check-in`, {
      method: 'POST', headers: adminHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        clientId: editor.clientId, itemId: item.id, title: item.title,
        code: editor.code
      })
    });
    const result = await response.json();
    if (barcodeCheckIn !== editor) return;
    if (!response.ok || !result.success) throw new Error(result.error || 'Unable to record check-in.');
    resetBarcodeCheckIn();
    inventorySignature = null;
    const status = await fetchInventory(editor.clientId);
    if (editor.session !== state.session || editor.clientId !== state.activeClientId) return;
    if (instructions) instructions.innerHTML = packagingBanner(state.items.find((entry) => entry.id === item.id) || item);
    setBarcodeScanMessage(status === 200
      ? `${result.alreadyCheckedIn ? 'Already checked in' : 'Arrival recorded'}: ${item.title}. Quantities unchanged. Ready for the next scan.`
      : 'Check-in saved, but inventory could not refresh. Refresh before scanning again.', status !== 200);
    if (status === 200) barcodeScanFeedback();
  } catch (error) {
    if (barcodeCheckIn === editor) {
      resetBarcodeCheckIn();
      setBarcodeScanMessage(`${error.message || 'Unable to record check-in.'} Refresh and verify arrival before scanning again.`, true);
    }
  } finally {
    if (!barcodeCheckIn && editor.session === state.session && editor.clientId === state.activeClientId) {
      document.getElementById('barcodeScanInput').focus();
    }
  }
}

function selectItem(id) {
  const item = state.items.find((entry) => String(entry.id) === String(id));
  if (!item) return;

  state.selectedItemId = String(id);
  renderPackagingInstructions();
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
  const custom = fields
    .filter((field) => safeClientId !== 'CL-002' || field.key !== 'productDescription')
    .filter((field) => !shipment || (field.key !== shipment.received && field.key !== shipment.shipped));
  if ((safeClientId === 'CL-002' || safeClientId === 'CL-003') && profile && !profile.legacy) {
    const base = safeClientId === 'CL-002'
      ? [
        { key: 'sku', label: 'UPC', type: 'text' },
        { key: 'title', label: profile.titleField?.label || 'Product Title', type: 'text' }
      ]
      : [{ key: 'title', label: profile.titleField?.label || 'Product Description / Name', type: 'text' }];
    return withCatalogFields([...base, ...custom, { key: 'notes', label: 'Notes', type: 'textarea' }]);
  }
  if (safeClientId === 'CL-002' || safeClientId === 'CL-003') return withCatalogFields(custom);
  const base = [
    { key: 'sku', label: 'SKU (optional)', type: 'text' },
    { key: 'title', label: profile?.titleField?.label || 'Product Title', type: 'text' }
  ];
  return withCatalogFields(safeClientId === 'CL-001' ? base : [...base, ...custom]);
}

function itemFieldValue(item, key) {
  if (key === 'sku') return item.rawSku ?? item.sku ?? '';
  if (key === 'status' && isFulfillmentClient(item.clientId || state.activeClientId)) return getStatusText(getItemStatus(item));
  return item[key] ?? '';
}

function renderItemDetails(item) {
  const section = document.getElementById('detailsEditor');
  const host = document.getElementById('detailFields');
  if (!section || !host) return;
  const clientId = item.clientId || state.activeClientId;
  const viewOnly = !state.isAdmin && Boolean(state.clientProfile?.readOnly);
  const fields = getEditableItemFields(clientId);
  if (isFulfillmentClient(clientId)) {
    fields.push({ key: 'status', label: 'Fulfillment stage', type: 'select', options: Object.values(FULFILLMENT_STATUSES), readOnly: !state.isAdmin });
  }
  section.hidden = viewOnly || !fields.length;
  if (section.hidden) return;
  host.innerHTML = renderItemDetailFields(item, fields, 'detail_');
}

function renderItemDetailFields(item, fields, prefix, viewOnly = false) {
  return fields.map((field) => {
    const id = escapeHtml(`${prefix}${field.key}`);
    const value = escapeHtml(itemFieldValue(item, field.key));
    const label = `<label class="ac-label" for="${id}">${escapeHtml(field.label)}</label>`;
    const prep = CATALOG_FIELDS.find((entry) => entry.key === 'prepInstructions');
    const common = `id="${id}" class="ac-input detail-input" data-key="${escapeHtml(field.key)}"${catalogFieldMatches(prep, field) ? ' maxlength="5000"' : ''}${viewOnly || field.readOnly ? ' disabled' : ''}`;
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
    return `<div>${label}<input type="${numeric ? 'number' : 'text'}" ${common}${field.key === 'qty' ? ' min="0" step="1"' : ''} value="${value}" /></div>`;
  }).join('');
}

let inventoryItemEditor = null;

function openInventoryItemDialog(itemId) {
  const dialog = document.getElementById('inventoryItemDialog');
  const item = state.items.find((entry) => String(entry.id) === String(itemId));
  if (!dialog || !item) {
    showToast('This item is no longer available. Refresh inventory and try again.', 'error');
    return;
  }
  if (dialog.open) return;
  const clientId = item.clientId || state.activeClientId;
  const profile = state.clientProfile;
  const viewOnly = !state.isAdmin && Boolean(profile?.readOnly);
  const shipment = isFulfillmentClient(clientId) && (Boolean(getShipmentFieldKeys(clientId)) || ['CL-002', 'CL-003'].includes(clientId));
  const stockLocked = shipment || (!state.isAdmin && profile?.quickEditMode === 'disabled');
  const fulfillment = isFulfillmentClient(clientId);
  const fields = getEditableItemFields(clientId).map((field) => ({ ...field }));
  if (clientId === 'CL-002' && profile?.legacy) fields.unshift({ key: 'title', label: 'Product Title', type: 'text' });
  if (!fields.some((field) => ['sku', 'upc'].includes(field.key))) {
    fields.unshift({ key: 'sku', label: 'SKU', type: 'text', readOnly: true });
  }
  fields.push(
    { key: 'qty', label: shipment ? 'Quantity (shipment-managed)' : 'Quantity', type: 'number', readOnly: stockLocked },
    { key: 'status', label: fulfillment ? 'Fulfillment stage' : 'Status', type: 'select', options: fulfillment ? Object.values(FULFILLMENT_STATUSES) : ['In Stock', 'Low Stock', 'Out of Stock'], readOnly: fulfillment ? !state.isAdmin : stockLocked }
  );
  if (!fields.some((field) => field.key === 'notes')) fields.push({ key: 'notes', label: 'Notes / Comments', type: 'textarea' });
  const uniqueFields = fields.filter((field, index) => fields.findIndex((other) => other.key === field.key) === index);
  const snapshot = { ...item, status: getStatusText(getItemStatus(item)) };
  inventoryItemEditor = { item: snapshot, clientId, viewOnly, busy: false };
  renderPackagingInstructions();
  document.getElementById('inventoryItemTitle').textContent = item.title || 'Item details';
  document.getElementById('inventoryItemHint').textContent = viewOnly
    ? 'This account is view-only. Contact your ECL team to request changes.'
    : shipment
      ? 'Edit product details here. Received and shipped quantities are managed in Updates.'
      : 'Update product details, stock levels, and notes for this item.';
  document.getElementById('inventoryItemFields').innerHTML = renderItemDetailFields(snapshot, uniqueFields, 'modalItem_', viewOnly);
  const productLinks = document.getElementById('inventoryProductLinks');
  if (productLinks) productLinks.innerHTML = productSearchLinks(item.title, item.productUrl);
  document.getElementById('inventoryItemFields').inert = false;
  document.getElementById('inventoryItemError').textContent = '';
  document.getElementById('inventoryItemPinWrap').hidden = true;
  document.getElementById('inventoryItemPin').value = '';
  document.getElementById('inventoryItemSave').hidden = viewOnly;
  document.getElementById('inventoryItemSave').disabled = false;
  document.getElementById('inventoryItemSave').textContent = 'Save changes';
  dialog.showModal();
}

function closeInventoryItemDialog(force = false) {
  if (inventoryItemEditor?.busy && !force) return;
  document.getElementById('inventoryItemDialog')?.close?.();
  inventoryItemEditor = null;
}

async function saveInventoryItemDialog(event) {
  event.preventDefault();
  const editor = inventoryItemEditor;
  if (!editor || editor.busy || editor.viewOnly) return;
  const errorHost = document.getElementById('inventoryItemError');
  const submit = document.getElementById('inventoryItemSave');
  errorHost.textContent = '';
  const values = {};
  document.querySelectorAll('#inventoryItemFields .detail-input').forEach((input) => {
    if (!input.disabled && String(input.value).trim() !== String(itemFieldValue(editor.item, input.dataset.key)).trim()) {
      values[input.dataset.key] = input.value;
    }
  });
  if (!Object.keys(values).length) {
    errorHost.textContent = 'No changes to save.';
    return;
  }
  const pinWrap = document.getElementById('inventoryItemPinWrap');
  const headers = adminHeaders({ 'Content-Type': 'application/json' });
  editor.busy = true;
  submit.disabled = true;
  submit.textContent = 'Saving...';
  document.getElementById('inventoryItemFields').inert = true;
  try {
    if (!pinWrap.hidden) {
      const pin = document.getElementById('inventoryItemPin').value.trim();
      if (!pin) throw new Error('Enter your Quick Edit PIN to save stock changes.');
      const unlockResponse = await fetch(QUICK_EDIT_UNLOCK_URL, {
        method: 'POST', headers, body: JSON.stringify({ clientId: editor.clientId, pin })
      });
      const unlock = await unlockResponse.json();
      if (!unlockResponse.ok || !unlock.success) throw new Error(unlock.error || 'Unable to unlock stock changes.');
      if (inventoryItemEditor !== editor) return;
      state.quickEditUnlock = { clientId: editor.clientId, token: unlock.token, expiresAt: unlock.expiresAt };
      document.getElementById('inventoryItemPin').value = '';
    }
    const response = await fetch(UPDATE_ITEM_URL, {
      method: 'PUT',
      headers: { ...headers, ...quickEditHeaders(editor.clientId) },
      body: JSON.stringify({ clientId: editor.clientId, itemId: editor.item.id, sku: editor.item.sku, title: editor.item.title, values })
    });
    const result = await response.json();
    if (inventoryItemEditor !== editor) return;
    if (result.code === 'QUICK_EDIT_PIN_REQUIRED') {
      state.quickEditUnlock = null;
      pinWrap.hidden = false;
      document.getElementById('inventoryItemPin').focus();
    }
    if (!response.ok || !result.success) throw new Error(result.error || 'Unable to save item changes.');
    closeInventoryItemDialog(true);
    showToast('Item updated successfully', 'success');
    inventorySignature = null;
    if (editor.clientId === state.activeClientId) await fetchInventory(editor.clientId);
  } catch (error) {
    if (inventoryItemEditor === editor) errorHost.textContent = error.message || 'Unable to save item changes.';
  } finally {
    editor.busy = false;
    if (inventoryItemEditor === editor) {
      submit.disabled = false;
      submit.textContent = 'Save changes';
      document.getElementById('inventoryItemFields').inert = false;
    }
  }
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
  const item = state.items.find((entry) => String(entry.id) === String(state.selectedItemId));
  const keys = getShipmentFieldKeys();
  const nextStatus = item && keys
    ? (shipped > 0 && shipped >= received ? 'Shipped out'
      : toNumber(item[keys.received]) === 0 && received > 0 ? 'Arrived / Check-In'
        : getStatusText(getFulfillmentStatus({ ...item,
          status: /^(shipped|fully shipped|delivered|shipped out)$/i.test(String(item.status || '').trim()) ? '' : item.status,
          [keys.received]: received, [keys.shipped]: shipped })))
    : '';
  const stage = isFulfillmentClient() && nextStatus
    ? Object.keys(FULFILLMENT_STATUSES).find((key) => FULFILLMENT_STATUSES[key] === nextStatus)
    : getShipmentStage(received, shipped);
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
    if (!isFulfillmentClient(clientId)) item.status = getStatusText(getItemStatus({ ...item, status: '' }));
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

let productCreateBusy = false;
async function createProduct() {
  if (productCreateBusy) return;
  const form = ITEM_FORMS.inventory;
  const clientId = state.activeClientId || state.session?.clientId || 'CL-001';
  const isCardClient = clientId === 'CL-003';

  if (!canAddInventoryItems(clientId)) {
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

  const session = state.session;
  const button = document.getElementById(form.submit);
  productCreateBusy = true;
  if (button) button.disabled = true;
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
    if (!state.auth || state.session !== session || state.activeClientId !== clientId) return;

    ['Sku', 'Title'].forEach((suffix) => {
      const input = document.getElementById(`${form.prefix}${suffix}`);
      if (input) input.value = '';
    });
    const qtyInput = document.getElementById(`${form.prefix}Qty`);
    if (qtyInput) qtyInput.value = '0';
    allowedFields.forEach((field) => {
      const input = document.getElementById(`${form.fieldPrefix}${field.key}`);
      if (input) input.value = '';
    });
    resetCatalogSync();
    await fetchInventory(clientId);
    showToast('Item added successfully', 'success');
  } catch (error) {
    showToast(error.message || 'Unable to add product', 'error');
  } finally {
    productCreateBusy = false;
    if (button) button.disabled = !canAddInventoryItems();
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
inventoryBody?.addEventListener?.('dblclick', (event) => {
  if (event.target.closest('button, a, input, select, textarea')) return;
  const row = event.target.closest('tr[data-item-id]');
  if (row) openInventoryItemDialog(row.dataset.itemId);
});
inventoryBody?.addEventListener?.('keydown', (event) => {
  if (event.key !== 'Enter' || !event.target.matches('tr[data-item-id]')) return;
  event.preventDefault();
  openInventoryItemDialog(event.target.dataset.itemId);
});
document.getElementById('inventoryItemForm')?.addEventListener('submit', saveInventoryItemDialog);
document.getElementById('barcodeScanForm')?.addEventListener('submit', scanBarcode);
document.getElementById('trackingSearchForm')?.addEventListener('submit', searchTracking);
document.getElementById('catalogSyncForm')?.addEventListener('submit', syncCatalog);
['packagingProfile', 'settingsPackagingProfile'].forEach((id) => {
  document.getElementById(id)?.addEventListener('click', (event) => {
    if (event.target.closest('[data-edit-packaging]')) openPackagingDialog();
  });
});
document.getElementById('packagingForm')?.addEventListener('submit', savePackagingNotes);
document.getElementById('packagingClose')?.addEventListener('click', closePackagingDialog);
document.getElementById('packagingDialog')?.addEventListener('cancel', closePackagingDialog);
document.getElementById('inboundForm')?.addEventListener('submit', submitInboundShipment);
document.getElementById('inboundClose')?.addEventListener('click', closeInboundDialog);
document.getElementById('inboundDialog')?.addEventListener('cancel', () => { inboundDraftId = null; });
document.getElementById('inboundAddLine')?.addEventListener('click', addInboundLine);
document.getElementById('inboundContents')?.addEventListener('click', (event) => {
  if (!event.target.closest('[data-inbound-remove]')) return;
  event.target.closest('.inbound-line')?.remove();
  document.getElementById('inboundAddLine').disabled = false;
});
['inboundDashboard', 'inboundTracking'].forEach((id) => {
  document.getElementById(id)?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-inbound-action]');
    if (!button) return;
    if (button.dataset.inboundAction === 'add') openInboundDialog();
    else if (button.dataset.inboundAction === 'refresh') loadInboundShipments();
    else if (button.dataset.inboundAction === 'arrive') {
      const shipment = inboundState.shipments?.find((entry) => entry.id === button.dataset.shipmentId);
      if (shipment) checkInInboundShipment(shipment.trackingNumber, shipment.id);
    }
    else if (button.dataset.inboundAction === 'review') {
      const shipment = inboundState.shipments?.find(entry => entry.id === button.dataset.shipmentId);
      if (shipment) openReceivingDialog(shipment);
    }
  });
  document.getElementById(id)?.addEventListener('submit', (event) => {
    if (!event.target.matches('.inbound-scan')) return;
    event.preventDefault();
    checkInInboundShipment(new FormData(event.target).get('code'));
  });
});
document.getElementById('receivingClose')?.addEventListener('click', closeReceivingDialog);
  document.getElementById('receivingDialog')?.addEventListener('cancel', closeReceivingDialog);
  document.getElementById('receivingLines')?.addEventListener('submit', event => {
    event.preventDefault();
    const form = event.target.closest('[data-receiving-line]');
    if (form) saveReceivingLine(form);
  });
  document.getElementById('receivingLines')?.addEventListener('click', event => {
    const form = event.target.closest('[data-receiving-line]');
    if (!form) return;
    if (event.target.closest('[data-receiving-fetch]')) fetchReceivingProduct(form);
    if (event.target.closest('[data-receiving-apply]')) {
      const product = receivingEditor?.products.get(form.dataset.receivingLine)?.[Number(form.querySelector('[data-receiving-product]')?.value)];
      if (!product || receivingEditor.busy) return;
      for (const [key, value] of Object.entries({ productName: product.title, sku: product.sku, imageUrl: product.imageUrl, productUrl: product.productUrl })) {
        if (value) form.elements.namedItem(key).value = value;
      }
    }
  });
  document.getElementById('receivingLines')?.addEventListener('change', event => {
    if (event.target.name !== 'target') return;
    const form = event.target.closest('[data-receiving-line]');
    if (!form || !receivingEditor || receivingEditor.busy) return;
    const item = state.items.find(item => item.id === event.target.value);
    form.querySelector('[data-receiving-prep]').innerHTML = packagingBanner(item, true);
    const image = safeHttpUrl(item?.imageUrl);
    form.querySelector('[data-receiving-match]').innerHTML = item
      ? `<p class="inbound-hint">Selected inventory product: ${escapeHtml(item.title)} (${escapeHtml(item.sku)}). Current displayed quantity: ${escapeHtml(String(item.qty))}.</p>
        ${image ? `<img class="receiving-product-image" src="${escapeHtml(image)}" alt="${escapeHtml(item.title)}" referrerpolicy="no-referrer" />` : ''}
        ${productSearchLinks(item.title, item.productUrl)}` : '';
  });
  document.getElementById('receivingLines')?.addEventListener('error', event => {
    if (!event.target.matches('.receiving-product-image')) return;
    event.target.hidden = true;
    const form = event.target.closest('[data-receiving-line]');
    if (form) form.querySelector('[data-receiving-error]').textContent = 'Product image could not load. Verify the product name and listing URL instead.';
  }, true);
  document.getElementById('storeConnectionForm')?.addEventListener('submit', saveStoreConnection);
document.getElementById('storeConnectionReload')?.addEventListener('click', loadStoreConnection);
document.getElementById('storePlatform')?.addEventListener('change', () => { clearStoreSecrets(); syncStorePlatform(); });
document.getElementById('storeRemoveCredentials')?.addEventListener('change', clearStoreSecrets);
document.getElementById('storeDisconnect')?.addEventListener('click', () => saveStoreConnection(null, true));
window.addEventListener('pagehide', clearStoreSecrets);
document.getElementById('catalogApplyProduct')?.addEventListener('click', applyCatalogProduct);
document.getElementById('catalogManualEntry')?.addEventListener('click', () => {
  resetCatalogSync();
  const button = document.getElementById('catalogSyncSubmit');
  if (button) button.disabled = !canAddInventoryItems();
  document.getElementById('newProductTitle')?.focus();
});
document.getElementById('customProductFields')?.addEventListener('input', (event) => {
  if (event.target === catalogInput('imageUrl')) previewCatalogImage();
});
document.getElementById('catalogImagePreview')?.addEventListener('error', () => {
  document.getElementById('catalogImagePreview').hidden = true;
  document.getElementById('catalogImageMessage').textContent = 'Image preview could not load. Edit the image URL or leave it blank; manual entry is still available.';
});
document.getElementById('trackingShowAll')?.addEventListener('click', () => {
  document.getElementById('trackingSearchInput').value = '';
  state.tracking.query = '';
  renderTracking();
});
document.getElementById('trackingRefresh')?.addEventListener('click', async () => {
  if (await loadTracking() === 401) handleExpiredSession();
});
document.getElementById('barcodeConfirmForm')?.addEventListener('submit', confirmBarcodeCheckIn);
document.getElementById('barcodeScanMatch')?.addEventListener('change', previewBarcodeCheckIn);
document.getElementById('barcodeCameraStart')?.addEventListener('click', startBarcodeCamera);
document.getElementById('barcodeCameraStop')?.addEventListener('click', stopBarcodeCamera);
window.addEventListener('pagehide', stopBarcodeCamera);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.getElementById('barcodeCameraPanel')?.hidden === false) {
    stopBarcodeCamera();
    document.getElementById('barcodeCameraStart')?.focus();
  }
});
document.getElementById('staffAccountForm')?.addEventListener('submit', saveStaffAccount);
document.getElementById('staffAccountsRefresh')?.addEventListener('click', loadStaffAccounts);
document.getElementById('loginHistoryRefresh')?.addEventListener('click', loadLoginHistory);
document.getElementById('staffAccountCancel')?.addEventListener('click', () => {
  if (!staffAccountBusy) {
    resetStaffAccountForm();
    staffAccountMessage('');
  }
});
document.getElementById('inventoryItemClose')?.addEventListener('click', () => closeInventoryItemDialog());
document.getElementById('inventoryItemDialog')?.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeInventoryItemDialog();
});
document.getElementById('inventoryItemDialog')?.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  closeInventoryItemDialog();
});
document.getElementById('tableScrollLeft')?.addEventListener('click', () => scrollInventoryTable(-1));
document.getElementById('tableScrollRight')?.addEventListener('click', () => scrollInventoryTable(1));

document.addEventListener('click', (event) => {
  const element = event.target.closest('[data-action]');
  if (!element) return;

  const action = element.dataset.action;
  if (action === 'inventory-view') selectInventoryView(element.dataset.view);
  if (action === 'edit-staff-account') editStaffAccount(element.dataset.username);

  if (action === 'select-item') {
    selectItem(element.dataset.id);
  }

  if (action === 'toggle-filter') {
    toggleFilter(element.dataset.group, element.dataset.key);
  }

  if (action === 'clear-filters') {
    clearFilters();
  }

  if (action === 'toggle-theme') toggleTheme();
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
    scheduleInventorySearch();
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
    inventoryMode: document.getElementById(`${prefix}InventoryMode`)?.value || undefined,
    enableShippedTab: Boolean(document.getElementById(`${prefix}EnableShippedTab`)?.checked),
    enableInboundShipments: document.getElementById(`${prefix}EnableInboundShipments`)?.checked !== false,
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

function revealContainingSections(element) {
  for (let section = element.closest('details'); section; section = section.parentElement?.closest('details')) {
    section.open = true;
  }
}

function showAddClientMessage(text, type) {
  const el = document.getElementById('addClientMsg');
  if (!el) return;
  revealContainingSections(el);
  el.style.display = 'block';
  el.style.background = type === 'error' ? 'var(--feedback-error-bg, #fef2f2)' : 'var(--feedback-success-bg, #f0fdf4)';
  el.style.color = type === 'error' ? 'var(--feedback-error-text, #b91c1c)' : 'var(--feedback-success-text, #166534)';
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
    websiteUrl: document.getElementById('acWebsiteUrl')?.value || '',
    logoUrl: document.getElementById('acLogoUrl')?.value || '',
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
    const shippedTab = document.getElementById('acEnableShippedTab');
    if (shippedTab) shippedTab.checked = true;
    const inventoryMode = document.getElementById('acInventoryMode');
    if (inventoryMode) inventoryMode.value = 'custom';
    ['acClientId', 'acClientName', 'acUsername', 'acEmail', 'acDriveFolderUrl', 'acPortalTitle', 'acAccentColor', 'acWebsiteUrl', 'acLogoUrl', 'acQuickEditPin', 'acOverstockLevel'].forEach((id) => {
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

let loginHistoryRequest = 0;

function clearLoginHistory() {
  loginHistoryRequest += 1;
  const section = document.getElementById('loginHistorySection');
  if (section) section.hidden = true;
  const rows = document.getElementById('loginHistoryRows');
  if (rows) rows.innerHTML = '';
  const message = document.getElementById('loginHistoryMessage');
  if (message) message.textContent = '';
}

async function loadLoginHistory() {
  if (!canConfigureStaff()) return;
  const rows = document.getElementById('loginHistoryRows');
  const message = document.getElementById('loginHistoryMessage');
  if (!rows || !message) return;
  const session = state.session;
  const request = ++loginHistoryRequest;
  rows.innerHTML = '';
  message.textContent = 'Loading login activity...';
  try {
    const response = await fetch(ADMIN_LOGINS_URL, { headers: adminHeaders({ Accept: 'application/json' }) });
    const entries = await response.json();
    if (session !== state.session || request !== loginHistoryRequest || !canConfigureStaff()) return;
    if (!response.ok || !Array.isArray(entries)) throw new Error(entries.error || 'Unable to load login history.');
    rows.innerHTML = entries.map((entry) => {
      const date = new Date(entry.timestamp);
      const timestamp = Number.isNaN(date.getTime()) ? entry.timestamp : date.toLocaleString();
      return `<tr><td>${escapeHtml(timestamp)}</td><td>${escapeHtml(entry.username)}</td><td>${escapeHtml(entry.clientId)}</td><td>${escapeHtml(entry.authType)}</td></tr>`;
    }).join('');
    message.textContent = entries.length ? `Showing ${entries.length} recent sign-ins.` : 'No sign-ins recorded yet.';
  } catch (error) {
    if (session === state.session && request === loginHistoryRequest) {
      message.textContent = error.message || 'Unable to load login history. Use Refresh login activity to retry.';
    }
  }
}

let staffAccounts = [];
let staffAccountEditing = null;
let staffAccountBusy = false;
let staffAccountsRequest = 0;

function canConfigureStaff() {
  return state.auth && state.session?.role === 'admin';
}

function staffAccountMessage(message, isError = false) {
  const host = document.getElementById('staffAccountMessage');
  if (!host) return;
  host.textContent = message;
  host.classList.toggle('is-error', isError);
}

function resetStaffAccountForm() {
  staffAccountEditing = null;
  const form = document.getElementById('staffAccountForm');
  if (form) form.reset?.();
  const username = document.getElementById('staffAccountUsername');
  if (username) username.readOnly = false;
  const title = document.getElementById('staffAccountFormTitle');
  if (title) title.textContent = 'Register staff account';
  const save = document.getElementById('staffAccountSave');
  if (save) save.textContent = 'Register staff';
  const cancel = document.getElementById('staffAccountCancel');
  if (cancel) cancel.hidden = true;
}

function clearStaffAccounts() {
  staffAccountsRequest += 1;
  staffAccounts = [];
  resetStaffAccountForm();
  const section = document.getElementById('staffAccountsSection');
  if (section) section.hidden = true;
  const list = document.getElementById('staffAccountsList');
  if (list) list.replaceChildren?.();
  staffAccountMessage('');
}

function renderStaffAccounts() {
  const host = document.getElementById('staffAccountsList');
  if (!host || !canConfigureStaff()) return;
  host.innerHTML = staffAccounts.length ? staffAccounts.map((account) => `
    <div class="staff-account-row">
      <div><strong>${escapeHtml(account.name)}</strong><p>${escapeHtml(account.username)} · ${account.role === 'admin' ? 'Administrator' : 'Staff'} · ${account.activated ? 'Active' : 'Awaiting activation'}</p>${account.email ? `<p>${escapeHtml(account.email)}</p>` : ''}</div>
      ${account.role === 'staff' ? `<button type="button" class="filter-clear" data-action="edit-staff-account" data-username="${escapeHtml(account.username)}"${staffAccountBusy ? ' disabled' : ''}>Edit</button>` : ''}
    </div>`).join('') : '<p class="billing-hint">No staff accounts found.</p>';
}

async function loadStaffAccounts() {
  if (!canConfigureStaff()) return;
  const host = document.getElementById('staffAccountsList');
  if (!host) return;
  const session = state.session;
  const request = ++staffAccountsRequest;
  host.textContent = 'Loading staff accounts...';
  try {
    const response = await fetch(ADMIN_STAFF_URL, { headers: adminHeaders({ Accept: 'application/json' }) });
    const result = await response.json();
    if (state.session !== session || request !== staffAccountsRequest || !canConfigureStaff()) return;
    if (!response.ok || !Array.isArray(result)) throw new Error(result.error || 'Unable to load staff accounts.');
    staffAccounts = result;
    renderStaffAccounts();
  } catch (error) {
    if (state.session === session && request === staffAccountsRequest) {
      staffAccounts = [];
      host.textContent = error.message || 'Unable to load staff accounts. Use Refresh accounts to retry.';
    }
  }
}

function editStaffAccount(username) {
  if (!canConfigureStaff() || staffAccountBusy) return;
  const account = staffAccounts.find((entry) => entry.username === username && entry.role === 'staff');
  if (!account) {
    staffAccountMessage('Staff account is no longer available. Refresh accounts and try again.', true);
    return;
  }
  staffAccountEditing = account.username;
  document.getElementById('staffAccountUsername').value = account.username;
  document.getElementById('staffAccountUsername').readOnly = true;
  document.getElementById('staffAccountName').value = account.name;
  document.getElementById('staffAccountEmail').value = account.email;
  document.getElementById('staffAccountFormTitle').textContent = 'Edit staff profile';
  document.getElementById('staffAccountSave').textContent = 'Save staff profile';
  document.getElementById('staffAccountCancel').hidden = false;
  staffAccountMessage('');
  document.getElementById('staffAccountName').focus();
}

async function saveStaffAccount(event) {
  event.preventDefault();
  if (!canConfigureStaff() || staffAccountBusy) return;
  const session = state.session;
  const editing = staffAccountEditing;
  const username = document.getElementById('staffAccountUsername').value.trim();
  const body = {
    name: document.getElementById('staffAccountName').value.trim(),
    email: document.getElementById('staffAccountEmail').value.trim(),
    ...(editing ? {} : { username })
  };
  staffAccountBusy = true;
  const form = document.getElementById('staffAccountForm');
  form.inert = true;
  document.getElementById('staffAccountSave').disabled = true;
  renderStaffAccounts();
  staffAccountMessage(editing ? 'Saving staff profile...' : 'Registering staff account...');
  try {
    const response = await fetch(editing ? `${ADMIN_STAFF_URL}/${encodeURIComponent(editing)}` : ADMIN_STAFF_URL, {
      method: editing ? 'PUT' : 'POST',
      headers: adminHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body)
    });
    const result = await response.json();
    if (state.session !== session || !canConfigureStaff()) return;
    if (!response.ok || !result.success) throw new Error(result.error || 'Unable to save staff account.');
    resetStaffAccountForm();
    staffAccountMessage(editing
      ? 'Staff profile saved.'
      : `Staff account registered.\nUsername: ${result.username}\nActivation code: ${result.activationCode}\nShare these details securely. The staff member selects Create Account and sets their own password.`);
    await loadStaffAccounts();
  } catch (error) {
    if (state.session === session) staffAccountMessage(error.message || 'Unable to save staff account.', true);
  } finally {
    staffAccountBusy = false;
    form.inert = false;
    document.getElementById('staffAccountSave').disabled = false;
    renderStaffAccounts();
  }
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
  state.editClientLegacy = false;
  [['ecGenericSettings', true], ['ecAddFieldBtn', true], ['ecDeleteBtn', true], ['ecLegacyNote', isLegacy]].forEach(([id, show]) => {
    const el = document.getElementById(id);
    if (el) el.style.display = show ? '' : 'none';
  });
  document.getElementById('ecClientName').value = profile.clientName || '';
  const rosterEntry = state.roster.find((client) => String(client.clientId || '').toUpperCase() === state.editClientId);
  document.getElementById('ecEmail').value = rosterEntry?.email || '';
  document.getElementById('ecDriveFolderUrl').value = profile.driveFolderUrl || '';
  document.getElementById('ecPortalTitle').value = profile.portalTitle || '';
  document.getElementById('ecAccentColor').value = profile.accentColor || '';
  if (document.getElementById('ecWebsiteUrl')) document.getElementById('ecWebsiteUrl').value = profile.websiteUrl || '';
  if (document.getElementById('ecLogoUrl')) document.getElementById('ecLogoUrl').value = profile.logoUrl || '';
  document.getElementById('ecEnableAddItem').checked = Boolean(profile.enableAddItem);
  document.getElementById('ecAllowChat').checked = Boolean(profile.allowChat);
  document.getElementById('ecAllowLogs').checked = Boolean(profile.allowLogs);
  document.getElementById('ecAllowUpdate').checked = Boolean(profile.allowUpdate);
  document.getElementById('ecReadOnly').checked = Boolean(profile.readOnly);

  const modeSelect = document.getElementById('ecQuickEditMode');
  const inventoryMode = document.getElementById('ecInventoryMode');
  if (inventoryMode) inventoryMode.value = profile.inventoryMode === 'custom' ? 'custom' : 'inventory';
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
  const shippedTab = document.getElementById('ecEnableShippedTab');
  if (shippedTab) shippedTab.checked = ![false, 'false', 0, '0'].includes(profile.enableShippedTab);
  const inboundToggle = document.getElementById('ecEnableInboundShipments');
  if (inboundToggle) inboundToggle.checked = ![false, 'false', 0, '0'].includes(profile.enableInboundShipments);

  const attributeMap = profile.attributeMap || {};
  [['ecAttrBundled', 'bundled'], ['ecAttrFragile', 'fragile'], ['ecAttrOversized', 'oversized']].forEach(([id, attribute]) => {
    const select = document.getElementById(id);
    if (!select) return;
    select.replaceChildren(new Option('— None —', ''));
    (profile.fields || []).forEach((field) => select.append(new Option(field.label || field.key, field.key)));
    select.value = attributeMap[attribute] || '';
  });

  const visibility = profile.fieldVisibility || {};
  const legacyCoreKeys = new Set(['upc', 'productDescription', 'productName', 'notes']);
  const fixedShipmentKeys = new Set(['quantityReceived', 'quantityShipped']);
  state.editClientFields = (profile.fields || []).filter((field) => !isLegacy || !legacyCoreKeys.has(field.key)).map((field) => ({
    key: field.key,
    label: field.label,
    type: field.type,
    options: (field.options || []).join(', '),
    fixed: fixedShipmentKeys.has(field.key) && ['CL-002', 'CL-003'].includes(state.editClientId),
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
  host.innerHTML = state.editClientFields.map((field, index) => fieldRowHtml(field, index, handlers, field.fixed)).join('');
}

function showEditClientMessage(text, type) {
  const el = document.getElementById('editClientMsg');
  if (!el) return;
  revealContainingSections(el);
  el.style.display = 'block';
  el.style.background = type === 'error' ? 'var(--feedback-error-bg, #fef2f2)' : 'var(--feedback-success-bg, #f0fdf4)';
  el.style.color = type === 'error' ? 'var(--feedback-error-text, #b91c1c)' : 'var(--feedback-success-text, #166534)';
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
    websiteUrl: document.getElementById('ecWebsiteUrl')?.value || '',
    logoUrl: document.getElementById('ecLogoUrl')?.value || '',
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
    cacheClientView(state.editClientId, { profile: result.profile });
    if (state.activeClientId === state.editClientId) {
      state.clientProfile = result.profile;
      renderClientHeader();
      renderProductForm();
      renderTable();
    }
    await fetchClientRoster();
    if (state.activeClientId === state.editClientId) {
      saveSession();
    }
    await loadClientForEdit(state.editClientId);
  } catch (error) {
    showEditClientMessage(error.message || 'Unable to save changes.', 'error');
  }
}

async function deleteClientPrompt() {
  if (!state.editClientId) return;
  const deletedClientId = state.editClientId;
  const confirmation = `Remove ${state.editClientId}? Their login will be disabled, the inventory tab will be archived, and this client ID will be permanently reserved. New clients must use a different ID.`;
  if (!window.confirm(confirmation)) return;

  try {
    const response = await fetch(`${ADMIN_CLIENTS_URL}/${encodeURIComponent(state.editClientId)}`, { method: 'DELETE', headers: adminHeaders() });
    const result = await response.json().catch(() => ({ success: false }));
    if (!response.ok || !result.success) {
      throw new Error(result.error || 'Unable to delete client.');
    }

    showToast(
      result.archived
        ? `${state.editClientId} removed; inventory archived and ID reserved.`
        : `${state.editClientId} removed and ID reserved.`,
      'success'
    );
    state.editClientId = '';
    document.getElementById('editClientForm').style.display = 'none';
    await fetchClientRoster();
    populateEditClientSelect();
    if (state.activeClientId === deletedClientId) await switchClientView('CL-000');
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
  revealContainingSections(el);
  el.style.display = 'block';
  el.style.background = type === 'error' ? 'var(--feedback-error-bg, #fef2f2)' : 'var(--feedback-success-bg, #f0fdf4)';
  el.style.color = type === 'error' ? 'var(--feedback-error-text, #b91c1c)' : 'var(--feedback-success-text, #166534)';
  el.textContent = text;
}

async function resetClientPasswordPrompt() {
  const clientId = document.getElementById('rpClientSelect')?.value;
  if (!clientId) {
    showResetPasswordMessage('Choose a client first.', 'error');
    return;
  }
  if (!window.confirm(`Issue an account setup code for ${clientId}? Their current password and recovery code stop working immediately.`)) return;

  try {
    const response = await fetch(`${ADMIN_CLIENTS_URL}/${encodeURIComponent(clientId)}/reset-password`, {
      method: 'POST',
      headers: adminHeaders()
    });
    const result = await response.json().catch(() => ({ success: false }));
    if (!response.ok || !result.success) {
      throw new Error(result.error || 'Unable to reset password.');
    }
    showResetPasswordMessage(`Setup code for ${result.username}: ${result.activationCode}. Send this one-time code with the exact username. They should choose "Create Account" to set their password and then continue to their inventory.`, 'success');
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
  if (state.session?.role === 'staff') {
    state.billing = null;
    renderBilling('Warehouse staff cannot access billing.');
    return 403;
  }
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
    if (canConfigureStaff() && state.rateCardClientId !== clientId) {
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
    if (el) el.hidden = !(canConfigureStaff() && summary);
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
    ${summary.configured ? '' : `<div class="ac-note">No rate card saved yet${canConfigureStaff() ? ' — add this client\'s services below.' : '.'}</div>`}
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
  if (!state.auth || state.session?.role === 'staff') {
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
  initializeTheme();
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

const THEME_PREFERENCE_KEY = 'eclPortalTheme';

function applyTheme(theme) {
  const isDark = theme === 'dark';
  const root = document.documentElement;
  if (!root) return;
  root.dataset.theme = isDark ? 'dark' : 'light';
  const toggle = document.getElementById('themeToggle');
  if (!toggle) return;
  const nextTheme = isDark ? 'light' : 'dark';
  toggle.textContent = isDark ? '☀ Light mode' : '☾ Dark mode';
  toggle.setAttribute('aria-label', `Switch to ${nextTheme} mode`);
  toggle.setAttribute('title', `Switch to ${nextTheme} mode`);
  toggle.setAttribute('aria-pressed', String(isDark));
}

function initializeTheme() {
  let theme = 'light';
  if (typeof localStorage !== 'undefined') {
    try {
      const savedTheme = localStorage.getItem(THEME_PREFERENCE_KEY);
      if (savedTheme === 'dark' || savedTheme === 'light') theme = savedTheme;
    } catch (error) {
      console.error('Unable to load theme preference:', error);
      showToast('Your theme preference could not be loaded.', 'error');
    }
  }
  applyTheme(theme);
}

function toggleTheme() {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(theme);
  try {
    localStorage.setItem(THEME_PREFERENCE_KEY, theme);
  } catch (error) {
    console.error('Unable to save theme preference:', error);
    showToast('Theme changed, but your choice could not be saved.', 'error');
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
