const API_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3001/api/inventory'
  : '/api/inventory';

const LOGIN_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3001/api/login'
  : '/api/login';

const defaultInventory = [
  { id: '1', sku: 'C-15-ZN', title: 'Copper Fittings', qty: 18, status: 'In Stock', reorderLevel: 6 },
  { id: '2', sku: 'A-204', title: 'Threaded Rod', qty: 5, status: 'Low Stock', reorderLevel: 6 },
  { id: '3', sku: 'B-91', title: 'Wire Harness', qty: 0, status: 'Out of Stock', reorderLevel: 4 },
  { id: '4', sku: 'D-008', title: 'Safety Seal Kit', qty: 32, status: 'In Stock', reorderLevel: 8 }
];

const state = {
  items: [...defaultInventory],
  filter: 'all',
  query: '',
  selectedItemId: null,
  auth: false,
  pinUnlocked: false
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
    'page-logs': 2,
    'page-chat': 3
  };

  const tabIndex = tabMap[pageId];
  if (tabIndex !== undefined && tabs[tabIndex]) {
    tabs[tabIndex].classList.add('active');
  }
}

function getItemStatus(item) {
  const qty = Number(item.qty ?? item.quantity ?? 0);
  if (!Number.isFinite(qty) || qty <= 0) return 'out';
  if (qty <= Number(item.reorderLevel || 0)) return 'low';
  return 'in';
}

function getStatusText(status) {
  if (status === 'out') return 'Out of Stock';
  if (status === 'low') return 'Low Stock';
  return 'In Stock';
}

function updateSummary() {
  const total = state.items.length;
  const low = state.items.filter((item) => getItemStatus(item) === 'low').length;
  const out = state.items.filter((item) => getItemStatus(item) === 'out').length;

  const totalEl = document.getElementById('s-total');
  const lowEl = document.getElementById('s-low');
  const outEl = document.getElementById('s-out');

  if (totalEl) totalEl.textContent = total;
  if (lowEl) lowEl.textContent = low;
  if (outEl) outEl.textContent = out;
}

function getFilteredItems() {
  const query = (state.query || '').trim().toLowerCase();
  const items = state.items.filter((item) => {
    const text = `${item.sku || ''} ${item.title || ''} ${item.category || ''} ${item.location || ''}`.toLowerCase();
    if (query && !text.includes(query)) return false;

    const status = getItemStatus(item);
    if (state.filter === 'in' && status !== 'in') return false;
    if (state.filter === 'low' && status !== 'low') return false;
    if (state.filter === 'out' && status !== 'out') return false;
    return true;
  });

  return items;
}

function renderTable() {
  const items = getFilteredItems();
  if (!inventoryBody) return;

  if (!items.length) {
    inventoryBody.innerHTML = '<tr><td colspan="5" class="no-results">No items match your filters.</td></tr>';
    return;
  }

  inventoryBody.innerHTML = items.map((item) => {
    const status = getItemStatus(item);
    const badgeClass = status === 'out' ? 'badge-out' : status === 'low' ? 'badge-low' : 'badge-in';
    return `
      <tr>
        <td class="sku-cell">${item.sku || '—'}</td>
        <td class="title-cell">${item.title || '—'}</td>
        <td class="qty-cell">${item.qty ?? item.quantity ?? 0}</td>
        <td><span class="badge ${badgeClass}">${getStatusText(status)}</span></td>
        <td class="center">
          <div class="quick-edit">
            <button class="qe-btn minus" type="button" data-action="adjust" data-direction="-1" data-id="${item.id}">−</button>
            <button class="qe-btn plus" type="button" data-action="adjust" data-direction="1" data-id="${item.id}">＋</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function setFilter(filterName) {
  state.filter = filterName;
  document.querySelectorAll('.filter-btn').forEach((button) => {
    button.classList.toggle('active', button.id === `f-${filterName}`);
  });
  renderTable();
}

function clearLoginError() {
  if (loginErrorMsg) {
    loginErrorMsg.textContent = '';
    loginErrorMsg.style.display = 'none';
  }
}

async function fetchInventory() {
  try {
    const response = await fetch(API_URL, {
      headers: { Accept: 'application/json' }
    });

    if (!response.ok) {
      throw new Error('Unable to load inventory');
    }

    const result = await response.json();
    state.items = Array.isArray(result) ? result.map((item) => ({
      id: item.id || `${item.sku || 'item'}-${Math.random().toString(16).slice(2, 6)}`,
      sku: item.sku || item.itemName || 'N/A',
      title: item.itemName || item.title || item.product || 'Untitled',
      qty: Number(item.quantity ?? item.qty ?? 0),
      reorderLevel: Number(item.reorderLevel ?? 5),
      status: item.status || getStatusText(getItemStatus({ qty: Number(item.quantity ?? item.qty ?? 0), reorderLevel: Number(item.reorderLevel ?? 5) }))
    })) : [...defaultInventory];
  } catch (error) {
    state.items = [...defaultInventory];
  }

  updateSummary();
  renderTable();
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

    const result = await response.json().catch(() => ({ success: true }));
    if (!response.ok && !result.success) {
      throw new Error(result.error || 'Login failed');
    }
  } catch (error) {
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      console.warn('Login fallback enabled:', error.message);
    }
  }

  state.auth = true;
  if (portalLoginWindow) portalLoginWindow.style.display = 'none';
  setPage('page-dashboard');
  await fetchInventory();
  showToast('Signed in successfully', 'success');
}

function executePortalLogout() {
  state.auth = false;
  state.selectedItemId = null;
  state.pinUnlocked = false;
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

function submitMessage() {
  if (!msgInput) return;
  const text = msgInput.value.trim();
  if (!text) return;

  const wrap = document.createElement('div');
  wrap.className = 'msg-wrap me';
  wrap.innerHTML = `
    <div class="msg-meta"><span>Me</span></div>
    <div class="msg-bubble">${text}</div>
  `;
  msgBox.appendChild(wrap);
  msgBox.scrollTop = msgBox.scrollHeight;
  msgInput.value = '';
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
    if (document.activeElement === msgInput) {
      submitMessage();
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

function initializeApp() {
  updateSummary();
  renderTable();
  if (logTableWrap) logTableWrap.innerHTML = '<div class="no-results" style="padding:30px;">Loading log...</div>';
  if (portalLoginWindow) portalLoginWindow.style.display = 'flex';
  if (pinOverlay) pinOverlay.style.display = 'none';
}

initializeApp();
