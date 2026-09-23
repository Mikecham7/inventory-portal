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

const CLIENT_DRIVE_FOLDERS = {
  'CL-001': 'https://drive.google.com/drive/folders/12kLeOKbQ2A_siusOder-4qzF8xMwNyU1?usp=drive_link',
  'CL-002': 'https://drive.google.com/drive/folders/14OQQ-PJWjOPf_jW_QhWne7iB-q8l-60k?usp=drive_link',
  'CL-003': 'https://drive.google.com/drive/folders/19iAZ6O_akxRqMtuSYE11GMifz3yNMrav?usp=drive_link'
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

function getChatDriveFolderForClient(clientId) {
  const safeClientId = String(clientId || '').trim().toUpperCase();
  if (state.clientProfile && state.clientProfile.clientId === safeClientId && state.clientProfile.driveFolderUrl) {
    return state.clientProfile.driveFolderUrl;
  }
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
  filter: 'all',
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
  editClientFields: []
};

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
    'page-logs': 3,
    'page-chat': 4,
    'page-clients': 5
  };

  const tabIndex = tabMap[pageId];
  if (tabIndex !== undefined && tabs[tabIndex]) {
    tabs[tabIndex].classList.add('active');
  }
}

function showPage(pageName) {
  const routeMap = {
    dashboard: 'page-dashboard',
    update: 'page-update',
    logs: 'page-logs',
    chat: 'page-chat',
    clients: 'page-clients'
  };

  const targetPage = routeMap[pageName] || pageName;
  if (targetPage && document.getElementById(targetPage)) {
    setPage(targetPage);
  }
  if (targetPage === 'page-clients') {
    renderClientFieldRows();
    populateEditClientSelect();
  }
}

function getShippingStatus(item = {}) {
  const clientId = String(item.clientId || state.activeClientId || state.session?.clientId || 'CL-001').trim().toUpperCase();
  if (!['CL-002', 'CL-003'].includes(clientId)) {
    return 'in';
  }

  const ordered = Number(String(item.quantityOrdered ?? item.ordered ?? item.quantity ?? '').replace(/[^0-9.-]/g, '')) || 0;
  const shipped = Number(String(item.quantityShipped ?? item.shipped ?? '').replace(/[^0-9.-]/g, '')) || 0;

  if (shipped <= 0) return 'not';
  if (ordered > 0 && shipped < ordered) return 'partial';
  return 'fully';
}

function getItemStatus(item) {
  const clientId = String(item.clientId || state.activeClientId || state.session?.clientId || 'CL-001').trim().toUpperCase();
  if (clientId === 'CL-002' || clientId === 'CL-003') {
    return getShippingStatus(item);
  }

  const qty = Number(item.qty ?? item.quantity ?? 0);
  if (!Number.isFinite(qty) || qty <= 0) return 'out';
  if (qty <= Number(item.reorderLevel || 0)) return 'low';
  return 'in';
}

function getStatusText(status) {
  if (status === 'fully') return 'Fully Shipped';
  if (status === 'partial') return 'Partially Shipped';
  if (status === 'not') return 'Not Shipped';
  if (status === 'out') return 'Out of Stock';
  if (status === 'low') return 'Low Stock';
  return 'In Stock';
}

function getStatusBadgeClass(status) {
  if (status === 'fully') return 'badge-fully';
  if (status === 'partial') return 'badge-partial';
  if (status === 'not') return 'badge-not';
  if (status === 'out') return 'badge-out';
  if (status === 'low') return 'badge-low';
  return 'badge-in';
}

async function fetchClientProfile(clientId = state.activeClientId || state.session?.clientId || 'CL-001') {
  try {
    const response = await fetch(`${CLIENT_PROFILE_URL}?clientId=${encodeURIComponent(clientId)}`, {
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) {
      state.clientProfile = null;
      return null;
    }
    state.clientProfile = await response.json();
    return state.clientProfile;
  } catch (error) {
    state.clientProfile = null;
    return null;
  }
}

function getFilterConfig(clientId = state.activeClientId || state.session?.clientId || 'CL-001') {
  const safeClientId = String(clientId || '').trim().toUpperCase();
  const shippingClient = safeClientId === 'CL-002' || safeClientId === 'CL-003';
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

function syncFilterButtons() {
  const clientId = state.activeClientId || state.session?.clientId || 'CL-001';
  const config = getFilterConfig(clientId);
  const buttons = Array.from(document.querySelectorAll('.filter-btn'));

  buttons.forEach((button, index) => {
    const option = config.options[index];
    if (!option) return;
    button.id = option.key === 'all' ? 'f-all' : `f-${option.key}`;
    button.dataset.filter = option.key;
    button.textContent = option.label;
    button.onclick = () => setFilter(option.key);
    button.classList.toggle('active', state.filter === option.key);
  });
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
  const clientId = state.activeClientId || state.session?.clientId || 'CL-001';
  const config = getFilterConfig(clientId);

  const items = state.items.filter((item) => {
    const text = `${item.sku || ''} ${item.title || ''} ${item.category || ''} ${item.location || ''}`.toLowerCase();
    if (query && !text.includes(query)) return false;

    const status = getItemStatus(item);
    if (state.filter === 'all') return true;
    if (config.mode === 'shipping') {
      if (state.filter === 'fully' && status !== 'fully') return false;
      if (state.filter === 'partial' && status !== 'partial') return false;
      if (state.filter === 'not' && status !== 'not') return false;
      return true;
    }

    if (state.filter === 'in' && status !== 'in') return false;
    if (state.filter === 'low' && status !== 'low') return false;
    if (state.filter === 'out' && status !== 'out') return false;
    return true;
  });

  return items;
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

  const tableWrap = document.getElementById('inventoryTableWrap');
  const leftButton = document.getElementById('tableScrollLeft');
  const rightButton = document.getElementById('tableScrollRight');

  if (tableWrap && leftButton && rightButton) {
    const canScroll = tableWrap.scrollWidth > tableWrap.clientWidth + 2;
    const step = Math.max(220, tableWrap.clientWidth * 0.7);

    leftButton.classList.toggle('visible', canScroll);
    rightButton.classList.toggle('visible', canScroll);
    leftButton.classList.toggle('disabled', tableWrap.scrollLeft <= 2);
    rightButton.classList.toggle('disabled', tableWrap.scrollLeft + tableWrap.clientWidth >= tableWrap.scrollWidth - 2);

    leftButton.disabled = !canScroll || tableWrap.scrollLeft <= 2;
    rightButton.disabled = !canScroll || tableWrap.scrollLeft + tableWrap.clientWidth >= tableWrap.scrollWidth - 2;

    leftButton.onclick = () => tableWrap.scrollBy({ left: -step, behavior: 'smooth' });
    rightButton.onclick = () => tableWrap.scrollBy({ left: step, behavior: 'smooth' });
  }
}

function renderTable() {
  syncFilterButtons();
  const items = getFilteredItems();
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
  const messages = Array.isArray(state.messages) ? state.messages : [];
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
    const senderLabel = isMine ? 'Me' : (messageIsStaff ? (message.sender || 'Admin') : (message.sender || 'Client'));
    const fileUrl = String(message.fileUrl || '').trim();
    const fileName = String(message.fileName || (fileUrl ? 'Shared file' : '')).trim();
    const fileMarkup = fileUrl
      ? `<div class="msg-file"><a href="${fileUrl}" target="_blank" rel="noreferrer">${fileName || 'Open shared file'}</a></div>`
      : '';
    return `
      <div class="msg-wrap ${isMine ? 'me' : 'them'}">
        <div class="msg-meta"><span>${senderLabel}</span></div>
        <div class="msg-bubble">${String(message.message || '').replace(/</g, '&lt;')}${fileMarkup}</div>
      </div>
    `;
  }).join('');

  msgBox.scrollTop = msgBox.scrollHeight;
}

async function loadChatMessages(clientId = state.activeClientId || state.session?.clientId || 'CL-001') {
  try {
    const response = await fetch(`${CHAT_URL}?clientId=${encodeURIComponent(clientId)}`, {
      headers: { Accept: 'application/json' }
    });

    if (!response.ok) {
      state.messages = [];
      renderChatMessages();
      return;
    }

    const payload = await response.json();
    state.messages = Array.isArray(payload) ? payload : [];
    renderChatMessages();
  } catch (error) {
    state.messages = [];
    renderChatMessages();
  }
}

function setFilter(filterName) {
  const clientId = state.activeClientId || state.session?.clientId || 'CL-001';
  const config = getFilterConfig(clientId);
  const allowed = new Set(config.options.map((option) => option.key));
  const nextFilter = allowed.has(String(filterName || '')) ? String(filterName) : 'all';
  state.filter = nextFilter;
  syncFilterButtons();
  renderTable();
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

  try {
    const response = await fetch(inventoryUrl, {
      headers: { Accept: 'application/json' }
    });

    if (!response.ok) {
      throw new Error('Unable to load inventory');
    }

    const result = await response.json();
    state.items = Array.isArray(result) ? result.map((item) => normalizeInventoryItem(item, targetClientId)) : [];
  } catch (error) {
    state.items = [];
  }

  updateSummary();
  renderTable();
}

async function fetchClientRoster() {
  try {
    const response = await fetch(CLIENTS_URL, {
      headers: { Accept: 'application/json' }
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
  const clientId = state.activeClientId || state.session?.clientId || 'CL-001';
  const folderUrl = getChatDriveFolderForClient(clientId);
  link.href = folderUrl;
  link.textContent = `Open ${getClientInventoryFields(clientId).label || 'Client'} Drive Folder`;
}

function syncAddTabVisibility() {
  const addTab = document.getElementById('tabAdd');
  if (!addTab) return;

  const clientId = state.activeClientId || state.session?.clientId || 'CL-001';
  const config = getClientInventoryFields(clientId);
  const shouldShow = Boolean(config && !config.readOnly && !config.requirePin);
  addTab.style.display = shouldShow ? 'block' : 'none';
}

function syncCreateFormLayout() {
  const skuWrap = document.getElementById('newProductSkuWrap');
  const skuInput = document.getElementById('newProductSku');
  const titleWrap = document.getElementById('newProductTitleWrap');
  const titleLabel = document.getElementById('newProductTitleLabel');
  const titleInput = document.getElementById('newProductTitle');
  const clientId = state.activeClientId || state.session?.clientId || 'CL-001';
  const titleConfig = getCreateFormTitleConfig(clientId);
  const isCardClient = clientId === 'CL-003';

  if (skuWrap) skuWrap.style.display = isCardClient ? 'none' : 'block';
  if (skuInput) skuInput.disabled = isCardClient;
  if (titleWrap) titleWrap.style.display = titleConfig.visible ? 'block' : 'none';
  if (titleLabel) titleLabel.textContent = titleConfig.label;
  if (titleInput) {
    titleInput.placeholder = titleConfig.placeholder;
    if (!titleConfig.visible) titleInput.value = '';
  }
}

function renderProductForm() {
  const host = document.getElementById('customProductFields');
  const notice = document.getElementById('createProductReadOnlyNotice');
  const submitBtn = document.getElementById('createProductSubmit');
  const clientId = state.activeClientId || state.session?.clientId || 'CL-001';
  const config = getClientInventoryFields(clientId);
  const visibleFields = getVisibleClientFields(clientId, state.isAdmin);

  syncAddTabVisibility();
  syncCreateFormLayout();

  const productSkuInput = document.getElementById('newProductSku');
  const productTitleInput = document.getElementById('newProductTitle');
  const skuSample = getInventoryFieldSample(state.items, 'sku');
  const titleSample = getInventoryFieldSample(state.items, 'title');

  if (productSkuInput && !productSkuInput.dataset.userTyped) {
    productSkuInput.placeholder = skuSample ? `e.g. ${skuSample}` : 'A-25-Cu-01';
  }

  if (productTitleInput && !productTitleInput.dataset.userTyped) {
    productTitleInput.placeholder = titleSample ? `e.g. ${titleSample}` : 'Copper Marker';
  }

  if (host) {
    host.innerHTML = visibleFields.map((field) => {
      const fieldId = `customField_${field.key}`;
      const commonStyle = 'width:100%;padding:10px 12px;border:1px solid #dfe7f1;border-radius:8px;';
      const isTextarea = field.type === 'textarea';
      const isSelect = field.type === 'select';
      const isReadOnlyField = Boolean(field.readOnly) && !state.isAdmin;
      const samplePlaceholder = getClientFieldPlaceholder(field, state.items);

      if (isSelect) {
        const options = (field.options || []).map((option) => {
          const value = String(option || '');
          const label = value ? value : '—';
          return `<option value="${value}">${label}</option>`;
        }).join('');

        return `
          <div>
            <label style="display:block;font-size:11px;font-weight:700;color:#475569;margin-bottom:6px;">${field.label}</label>
            <select id="${fieldId}" style="${commonStyle}" data-placeholder="${samplePlaceholder}" ${isReadOnlyField ? 'disabled' : ''}>
              ${options}
            </select>
          </div>
        `;
      }

      if (isTextarea) {
        return `
          <div style="grid-column:1 / -1;">
            <label style="display:block;font-size:11px;font-weight:700;color:#475569;margin-bottom:6px;">${field.label}</label>
            <textarea id="${fieldId}" placeholder="${samplePlaceholder}" style="${commonStyle};min-height:84px;resize:vertical;" ${isReadOnlyField ? 'readonly' : ''}></textarea>
          </div>
        `;
      }

      return `
        <div>
          <label style="display:block;font-size:11px;font-weight:700;color:#475569;margin-bottom:6px;">${field.label}</label>
          <input type="${field.type === 'number' ? 'number' : 'text'}" id="${fieldId}" placeholder="${samplePlaceholder}" style="${commonStyle}" ${isReadOnlyField ? 'readonly' : ''} />
        </div>
      `;
    }).join('');
  }

  if (notice) {
    notice.style.display = config.readOnly ? 'block' : 'none';
    notice.textContent = config.readOnly
      ? 'This client is in view-only mode. Inventory is locked and cannot be added to directly.'
      : '';
  }

  if (submitBtn) {
    submitBtn.disabled = Boolean(config.readOnly);
    submitBtn.textContent = config.readOnly ? 'Locked' : 'Add';
    submitBtn.style.opacity = config.readOnly ? '0.6' : '1';
  }
}

async function switchClientView(clientId, clientName) {
  state.activeClientId = String(clientId || '').trim().toUpperCase();
  state.filter = 'all';
  state.query = '';
  if (tableSearch) tableSearch.value = '';

  renderClientHeader();
  await fetchClientProfile(state.activeClientId);

  renderAdminSwitcher();
  renderDriveFolderLink();
  renderProductForm();
  renderTable();
  await fetchInventory(state.activeClientId);
  await loadChatMessages(state.activeClientId);
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

    state.session = result;
    state.auth = true;
    state.isAdmin = String(result.role || '').toLowerCase() === 'admin' || String(result.clientId || '').toUpperCase() === 'CL-000';
    state.activeClientId = String(result.clientId || '').trim().toUpperCase() || 'CL-001';
    state.roster = [];
    state.pinUnlocked = false;

    renderClientHeader();

    if (portalLoginWindow) portalLoginWindow.style.display = 'none';
    setPage('page-dashboard');

    const tabClients = document.getElementById('tabClients');
    if (tabClients) tabClients.style.display = state.isAdmin ? 'block' : 'none';

    if (state.isAdmin) {
      const roster = await fetchClientRoster();
      if (roster.length) {
        const first = roster[0];
        state.activeClientId = String(first.clientId || '').trim().toUpperCase();
        if (document.getElementById('activeClientHeader')) {
          document.getElementById('activeClientHeader').textContent = `CLIENT: ${String(first.clientName || first.clientId || 'CLIENT').toUpperCase()}`;
        }
        await fetchInventory(state.activeClientId);
      } else {
        await fetchInventory(state.activeClientId);
      }
    } else {
      await fetchInventory(state.activeClientId);
    }

    await fetchClientProfile(state.activeClientId);
    renderDriveFolderLink();
    renderProductForm();
    renderTable();
    await loadChatMessages(state.activeClientId);
    showToast('Signed in successfully', 'success');
  } catch (error) {
    if (loginErrorMsg) {
      loginErrorMsg.textContent = error.message || 'Unable to sign in.';
      loginErrorMsg.style.display = 'block';
    }
  }
}

function executePortalLogout() {
  state.auth = false;
  state.session = null;
  state.isAdmin = false;
  state.roster = [];
  state.activeClientId = null;
  state.selectedItemId = null;
  state.pinUnlocked = false;
  state.messages = [];
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
  setPage('page-dashboard');
  showToast('Signed out', 'success');
}

function openPinPrompt(cb) {
  state.pendingPinAction = cb;
  if (pinOverlay) pinOverlay.style.display = 'flex';
  if (pinInput) {
    pinInput.value = '';
    pinInput.focus();
  }
}

function closePinPrompt() {
  if (pinOverlay) pinOverlay.style.display = 'none';
  state.pendingPinAction = null;
}

function verifyPinPrompt() {
  const value = (pinInput?.value || '').trim();
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

function goToAddItem() {
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

function goToDashboard() {
  setPage('page-dashboard');
  updateSummary();
  renderTable();
}

function goToLogs() {
  setPage('page-logs');
  if (logTableWrap) {
    const rows = getFilteredItems();
    logTableWrap.innerHTML = rows.length
      ? rows.map((item) => `
          <div class="log-entry">
            <span class="log-ts">${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            <span class="log-sku">${item.sku || 'N/A'}</span>
            <span class="log-desc">${item.title || 'Inventory update'}</span>
            <span class="log-change ${getItemStatus(item) === 'out' ? 'rem' : 'add'}">${getStatusText(getItemStatus(item))}</span>
          </div>
        `).join('')
      : '<div class="no-results" style="padding:30px;">No activity to display.</div>';
  }
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
  const fileName = fileUrl ? (fileUrl.split('/').pop() || 'Shared file') : '';

  const isStaff = Boolean(state.session && (String(state.session.role || '').toLowerCase() === 'admin' || String(state.session.clientId || '').toUpperCase() === 'CL-000'));
  const payload = {
    clientId: state.activeClientId || state.session?.clientId || 'CL-001',
    sender: state.session?.clientName || state.session?.clientId || 'User',
    message: text,
    isStaff,
    fileUrl,
    fileName
  };

  try {
    const response = await fetch(CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const result = await response.json().catch(() => ({ success: true }));
    if (!response.ok || !result.success) {
      throw new Error(result.error || 'Message failed to send');
    }

    state.messages.push({
      sender: payload.sender,
      message: text,
      clientId: payload.clientId,
      isStaff,
      fileUrl,
      fileName
    });
    renderChatMessages();
    msgInput.value = '';
    if (fileInput) fileInput.value = '';
  } catch (error) {
    showToast('Message failed to send', 'error');
  }
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
    <div class="sri" data-id="${item.id}" data-action="select-item">
      <div class="sc">${item.sku || 'N/A'}</div>
      <div class="st">${item.title || 'Inventory item'}</div>
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
    selBadge.className = `badge ${status === 'out' ? 'badge-out' : status === 'low' ? 'badge-low' : 'badge-in'}`;
    selBadge.textContent = statusText;
  }
  if (searchResults) {
    searchResults.style.display = 'none';
  }
}

function adjustQty(delta) {
  if (!state.selectedItemId) {
    showToast('Select an item first', 'error');
    return;
  }

  const item = state.items.find((entry) => String(entry.id) === String(state.selectedItemId));
  if (!item) return;

  const amount = Number(document.getElementById('adjustAmt')?.value || 1);
  const nextQty = Math.max(0, Number(item.qty ?? item.quantity ?? 0) + (amount * delta));
  item.qty = nextQty;
  item.status = getStatusText(getItemStatus(item));
  updateSummary();
  renderTable();
  selectItem(item.id);
  showToast(`Inventory updated to ${nextQty}`, 'success');
}

function setExactQty() {
  if (!state.selectedItemId) {
    showToast('Select an item first', 'error');
    return;
  }

  const val = Number(document.getElementById('setQtyVal')?.value ?? 0);
  const item = state.items.find((entry) => String(entry.id) === String(state.selectedItemId));
  if (!item) return;

  item.qty = Math.max(0, val);
  item.status = getStatusText(getItemStatus(item));
  updateSummary();
  renderTable();
  selectItem(item.id);
  showToast(`Set quantity to ${item.qty}`, 'success');
}

async function createProduct() {
  const clientId = state.activeClientId || state.session?.clientId || 'CL-001';
  const config = getClientInventoryFields(clientId);
  const isCardClient = clientId === 'CL-003';

  if (config.readOnly) {
    showToast('This client is in read-only mode', 'error');
    return;
  }

  const skuInput = document.getElementById('newProductSku');
  const sku = (skuInput && !isCardClient) ? skuInput.value.trim() : '';
  const titleInput = document.getElementById('newProductTitle');
  const productNameInput = document.getElementById('customField_productName');
  const title = (titleInput?.value?.trim() || productNameInput?.value?.trim() || '');
  const qty = Number(document.getElementById('newProductQty')?.value ?? 0);
  const extraFields = {};
  const allowedFields = getVisibleClientFields(clientId, state.isAdmin);

  allowedFields.forEach((field) => {
    if ((field.key === 'quantityReceived' || field.key === 'quantityShipped') && !state.isAdmin) return;
    const value = document.getElementById(`customField_${field.key}`)?.value?.trim() || '';
    if (value) extraFields[field.key] = value;
  });

  if ((!isCardClient && !sku) || !title) {
    showToast(isCardClient ? 'Card name / product is required' : 'SKU and product title are required', 'error');
    return;
  }

  try {
    const response = await fetch(CREATE_ITEM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, sku: sku || title, title, qty, status: qty <= 5 ? 'Low Stock' : 'In Stock', extraFields, isAdmin: state.isAdmin, role: state.session?.role || (state.isAdmin ? 'admin' : 'client') })
    });

    const result = await response.json().catch(() => ({ success: false, error: 'Create failed' }));
    if (!response.ok || !result.success) {
      throw new Error(result.error || 'Create failed');
    }

    if (document.getElementById('newProductSku')) document.getElementById('newProductSku').value = '';
    document.getElementById('newProductTitle').value = '';
    document.getElementById('newProductQty').value = '0';
    config.fields.forEach((field) => {
      const input = document.getElementById(`customField_${field.key}`);
      if (input) input.value = '';
    });
    await fetchInventory(clientId);
    showToast('Product added successfully', 'success');
  } catch (error) {
    showToast(error.message || 'Unable to add product', 'error');
  }
}

function filterLogs() {
  if (!logTableWrap) return;
  const value = (document.getElementById('logSearch')?.value || '').trim().toLowerCase();
  const rows = getFilteredItems().filter((item) => `${item.sku} ${item.title}`.toLowerCase().includes(value));
  logTableWrap.innerHTML = rows.length
    ? rows.map((item) => `
        <div class="log-entry">
          <span class="log-ts">Now</span>
          <span class="log-sku">${item.sku || 'N/A'}</span>
          <span class="log-desc">${item.title || 'Inventory changed'}</span>
          <span class="log-change ${getItemStatus(item) === 'out' ? 'rem' : 'add'}">${getStatusText(getItemStatus(item))}</span>
        </div>
      `).join('')
    : '<div class="no-results" style="padding:30px;">No matching log entries.</div>';
}

window.addEventListener('resize', () => {
  syncDashboardColumns();
});

const tableWrap = document.getElementById('inventoryTableWrap');
if (tableWrap) {
  tableWrap.addEventListener('scroll', () => {
    syncDashboardColumns();
  });
}

document.addEventListener('click', (event) => {
  const element = event.target.closest('[data-action]');
  if (!element) return;

  const action = element.dataset.action;

  if (action === 'select-item') {
    selectItem(element.dataset.id);
  }

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
  if (event.key === 'Enter') {
    if (document.activeElement === portalUser || document.activeElement === portalPass) {
      executePortalAuth();
    }
    if (document.activeElement === pinInput) {
      verifyPinPrompt();
    }
  }
});

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
  state.newClientFields.push({ label: '', type: 'text', options: '' });
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

function renderClientFieldRows() {
  const host = document.getElementById('acFieldsList');
  if (!host) return;

  if (!state.newClientFields.length) {
    host.innerHTML = '<div class="no-results" style="padding:12px;">No custom fields yet — click "+ Add Field" to add one (e.g. UPC, Merchant, Carrier).</div>';
    return;
  }

  host.innerHTML = state.newClientFields.map((field, index) => `
    <div class="ac-field-row">
      <input type="text" placeholder="Field label (e.g. UPC)" value="${field.label.replace(/"/g, '&quot;')}" oninput="updateClientFieldRow(${index}, 'label', this.value)" />
      <select onchange="updateClientFieldRow(${index}, 'type', this.value)">
        <option value="text" ${field.type === 'text' ? 'selected' : ''}>Text</option>
        <option value="number" ${field.type === 'number' ? 'selected' : ''}>Number</option>
        <option value="textarea" ${field.type === 'textarea' ? 'selected' : ''}>Long text</option>
        <option value="select" ${field.type === 'select' ? 'selected' : ''}>Dropdown</option>
      </select>
      <input type="text" placeholder="Dropdown options, comma separated" value="${(field.options || '').replace(/"/g, '&quot;')}" style="${field.type === 'select' ? '' : 'visibility:hidden;'}" oninput="updateClientFieldRow(${index}, 'options', this.value)" />
      <button type="button" class="ac-field-remove" onclick="removeClientFieldRow(${index})">✕</button>
    </div>
  `).join('');
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
      ...(field.type === 'select' ? { options: field.options.split(',').map((opt) => opt.trim()).filter(Boolean) } : {})
    }));

  const payload = {
    clientId,
    clientName,
    username,
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await response.json().catch(() => ({ success: false }));
    if (!response.ok || !result.success) {
      throw new Error(result.error || 'Unable to create client.');
    }

    showAddClientMessage(`${clientId} created. Give the client this login info — Username: "${result.username}", Activation Code: "${result.activationCode}". They'll use "Create Account" on the sign-in screen to set their own password.`, 'success');
    state.newClientFields = [];
    renderClientFieldRows();
    ['acClientId', 'acClientName', 'acUsername', 'acEmail', 'acDriveFolderUrl', 'acPortalTitle', 'acAccentColor'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    await fetchClientRoster();
    populateEditClientSelect();
  } catch (error) {
    showAddClientMessage(error.message || 'Unable to create client.', 'error');
  }
}

const LEGACY_CLIENT_IDS = ['CL-001', 'CL-002', 'CL-003', 'CL-000'];

function populateEditClientSelect() {
  const select = document.getElementById('ecClientSelect');
  if (!select) return;
  const editable = state.roster.filter((client) => !LEGACY_CLIENT_IDS.includes(String(client.clientId || '').toUpperCase()));

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
  document.getElementById('ecClientName').value = profile.clientName || '';
  document.getElementById('ecDriveFolderUrl').value = profile.driveFolderUrl || '';
  document.getElementById('ecPortalTitle').value = profile.portalTitle || '';
  document.getElementById('ecAccentColor').value = profile.accentColor || '';
  document.getElementById('ecEnableAddItem').checked = Boolean(profile.enableAddItem);
  document.getElementById('ecAllowChat').checked = Boolean(profile.allowChat);
  document.getElementById('ecAllowLogs').checked = Boolean(profile.allowLogs);
  document.getElementById('ecAllowUpdate').checked = Boolean(profile.allowUpdate);
  document.getElementById('ecReadOnly').checked = Boolean(profile.readOnly);

  state.editClientFields = (profile.fields || []).map((field) => ({
    key: field.key,
    label: field.label,
    type: field.type,
    options: (field.options || []).join(', ')
  }));
  renderEditClientFieldRows();
}

// Fetches a profile without touching state.clientProfile, which drives the live dashboard.
async function fetchClientProfileForEdit(clientId) {
  try {
    const response = await fetch(`${CLIENT_PROFILE_URL}?clientId=${encodeURIComponent(clientId)}`, {
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    return null;
  }
}

function addEditClientFieldRow() {
  state.editClientFields.push({ key: '', label: '', type: 'text', options: '' });
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

  host.innerHTML = state.editClientFields.map((field, index) => `
    <div class="ac-field-row">
      <input type="text" placeholder="Field label" value="${(field.label || '').replace(/"/g, '&quot;')}" oninput="updateEditClientFieldRow(${index}, 'label', this.value)" />
      <select onchange="updateEditClientFieldRow(${index}, 'type', this.value)">
        <option value="text" ${field.type === 'text' ? 'selected' : ''}>Text</option>
        <option value="number" ${field.type === 'number' ? 'selected' : ''}>Number</option>
        <option value="textarea" ${field.type === 'textarea' ? 'selected' : ''}>Long text</option>
        <option value="select" ${field.type === 'select' ? 'selected' : ''}>Dropdown</option>
      </select>
      <input type="text" placeholder="Dropdown options, comma separated" value="${(field.options || '').replace(/"/g, '&quot;')}" style="${field.type === 'select' ? '' : 'visibility:hidden;'}" oninput="updateEditClientFieldRow(${index}, 'options', this.value)" />
      <button type="button" class="ac-field-remove" onclick="removeEditClientFieldRow(${index})">✕</button>
    </div>
  `).join('');
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
      ...(field.type === 'select' ? { options: field.options.split(',').map((opt) => opt.trim()).filter(Boolean) } : {})
    }));

  const payload = {
    clientName: document.getElementById('ecClientName')?.value || '',
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
      headers: { 'Content-Type': 'application/json' },
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
    const response = await fetch(`${ADMIN_CLIENTS_URL}/${encodeURIComponent(state.editClientId)}`, { method: 'DELETE' });
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

async function resetClientAccountPrompt() {
  if (!state.editClientId) return;
  if (!window.confirm(`Reset ${state.editClientId}'s account? They'll be logged out everywhere and need a new activation code to sign back in.`)) return;

  try {
    const response = await fetch(`${ADMIN_CLIENTS_URL}/${encodeURIComponent(state.editClientId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resetAccount: true })
    });
    const result = await response.json().catch(() => ({ success: false }));
    if (!response.ok || !result.success) {
      throw new Error(result.error || 'Unable to reset account.');
    }

    showEditClientMessage(`Account reset. New activation code for this client: "${result.activationCode}"`, 'success');
  } catch (error) {
    showEditClientMessage(error.message || 'Unable to reset account.', 'error');
  }
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
  if (portalLoginWindow) portalLoginWindow.style.display = 'flex';
  if (pinOverlay) pinOverlay.style.display = 'none';
}

initializeApp();
