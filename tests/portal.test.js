const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { GoogleSpreadsheet } = require('google-spreadsheet');

process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'test@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'test-only-not-a-real-key';
process.env.GOOGLE_SHEET_ID = 'test-sheet';

const { normalizeInventoryRow, getSheetNameForClient, getClientInventoryFields, getVisibleClientFields, getChatDriveFolderForClient, getInventoryFieldSample, getCreateFormTitleConfig, getDashboardColumns, getShipmentStatus } = require('../api/portalLogic.js');
const { normalizeClientId, summarizeUnreadNotifications, signNotificationSession, readNotificationSession } = require('../api/server.js');

test('normalizeInventoryRow maps Google Sheet values to the app shape', () => {
  const item = normalizeInventoryRow({
    itemName: 'Copper Fittings',
    sku: 'C-15-ZN',
    category: 'Hardware',
    quantity: '18',
    reorderLevel: '6',
    location: 'A1',
    status: 'In Stock'
  });

  assert.equal(item.title, 'Copper Fittings');
  assert.equal(item.sku, 'C-15-ZN');
  assert.equal(item.qty, 18);
  assert.equal(item.reorderLevel, 6);
  assert.equal(item.status, 'In Stock');
});

test('normalizeInventoryRow parses the live Google Sheet row format used by CL-001', () => {
  const item = normalizeInventoryRow(['CL-001', 'A-10-Cu-PA-25', 'A Series Copper 10" Garden Markers Qty 25', 21, 'In Stock', 'History'], 'CL-001');

  assert.equal(item.clientId, 'CL-001');
  assert.equal(item.sku, 'A-10-Cu-PA-25');
  assert.equal(item.title, 'A Series Copper 10" Garden Markers Qty 25');
  assert.equal(item.qty, 21);
  assert.equal(item.status, 'In Stock');
});

test('admin inventory defaults to the CL-001 client sheet but specific clients keep their sheet name', () => {
  assert.equal(getSheetNameForClient('CL-000'), 'CL-001');
  assert.equal(getSheetNameForClient('CL-001'), 'CL-001');
  assert.equal(getSheetNameForClient('CL-002'), 'CL-002');
});

test('CJA and Ecom Elite have custom add-item fields while Metal Garden Markers is read-only', () => {
  assert.deepEqual(getClientInventoryFields('CL-002').fields.map((field) => field.key), ['upc', 'productDescription', 'quantityOrdered', 'quantityReceived', 'quantityShipped', 'expDate', 'merchant', 'asin', 'fulfillment', 'transparencyCode', 'bundled', 'bundleQty', 'notes']);
  assert.deepEqual(getClientInventoryFields('CL-003').fields.map((field) => field.key), ['productName', 'quantityOrdered', 'merchant', 'carrier', 'trackingNumber', 'quantityReceived', 'quantityShipped', 'notes']);
  assert.equal(getClientInventoryFields('CL-001').requirePin, true);
  assert.equal(getClientInventoryFields('CL-001').readOnly, true);
});

test('CJA add form hides the legacy default title field and keeps the custom product name field', () => {
  assert.deepEqual(getCreateFormTitleConfig('CL-003'), { visible: false, label: 'Product Name', placeholder: 'Pokémon - Charizard' });
  assert.deepEqual(getCreateFormTitleConfig('CL-002'), { visible: true, label: 'Product Title', placeholder: 'Copper Marker' });
});

test('dashboard columns expose the Ecom Elite field set and keep the generic client layout elsewhere', () => {
  assert.deepEqual(getDashboardColumns('CL-002'), ['PRODUCT TITLE', 'ASIN #', 'QUANTITY ORDERED', 'QUANTITY RECEIVED', 'QUANTITY SHIPPED', 'EXP DATE', 'MERCHANT', 'FBM/FBA', 'TRANSPARENCY CODE', 'BUNDLED?', 'BUNDLE QUANTITY', 'NOTES', 'QTY', 'STATUS', 'EDIT']);
  assert.deepEqual(getDashboardColumns('CL-003'), ['PRODUCT TITLE', 'QTY', 'STATUS', 'EDIT']);
});

test('shipment status follows the shipping workflow for Ecom Elite and CJA', () => {
  assert.equal(getShipmentStatus({ clientId: 'CL-002', quantityOrdered: 10, quantityShipped: 10 }), 'fully');
  assert.equal(getShipmentStatus({ clientId: 'CL-002', quantityOrdered: 10, quantityShipped: 4 }), 'partial');
  assert.equal(getShipmentStatus({ clientId: 'CL-003', quantityOrdered: 5, quantityShipped: 0 }), 'not');
  assert.equal(getShipmentStatus({ clientId: 'CL-001', status: 'Low Stock' }), 'in');
});

test('received and shipped totals stay visible for client users but are locked from editing', () => {
  const ecomFields = getVisibleClientFields('CL-002', false).map((field) => field.key);
  const cjaFields = getVisibleClientFields('CL-003', false).map((field) => field.key);

  assert.ok(ecomFields.includes('quantityReceived'));
  assert.ok(ecomFields.includes('quantityShipped'));
  assert.ok(cjaFields.includes('quantityReceived'));
  assert.ok(cjaFields.includes('quantityShipped'));
});

test('chat drive folders are mapped to each client for shared files', () => {
  assert.equal(getChatDriveFolderForClient('CL-002'), 'https://drive.google.com/drive/folders/14OQQ-PJWjOPf_jW_QhWne7iB-q8l-60k?usp=drive_link');
  assert.equal(getChatDriveFolderForClient('CL-003'), 'https://drive.google.com/drive/folders/19iAZ6O_akxRqMtuSYE11GMifz3yNMrav?usp=drive_link');
  assert.equal(getChatDriveFolderForClient('CL-001'), 'https://drive.google.com/drive/folders/12kLeOKbQ2A_siusOder-4qzF8xMwNyU1?usp=drive_link');
});

test('chat client IDs are normalized so admin views load only the selected client thread', () => {
  assert.equal(normalizeClientId(' cl-002 '), 'CL-002');
  assert.equal(normalizeClientId('CL-003'), 'CL-003');
  assert.equal(normalizeClientId('CL-000'), 'CL-000');
  assert.equal(normalizeClientId(''), '');
});

test('unread chat and inventory events exclude own activity and obey separate read cursors', () => {
  const chats = [
    { timestamp: '2026-09-23T12:00:00.000Z', isStaff: true, clientId: 'CL-002' },
    { timestamp: '2026-09-23T13:00:00.000Z', isStaff: false, clientId: 'CL-002' }
  ];
  const events = [
    { timestamp: '2026-09-23T14:00:00.000Z', actorUsername: 'client', clientId: 'CL-002' },
    { timestamp: '2026-09-23T15:00:00.000Z', actorUsername: 'ADMIN', clientId: 'CL-002' }
  ];
  const seenAt = { chat: '2026-09-23T12:30:00.000Z', inventory: '2026-09-23T13:30:00.000Z' };
  const client = summarizeUnreadNotifications(chats, events, seenAt, 'client', false);
  assert.deepEqual([client.chat, client.inventory, client.total], [0, 1, 1]);
  const admin = summarizeUnreadNotifications(chats, events, seenAt, 'ADMIN', true);
  assert.deepEqual([admin.chat, admin.inventory, admin.total], [1, 1, 2]);
});

test('notification session token cannot be changed to read another client', () => {
  const token = signNotificationSession('client', 'CL-002', 'client');
  const req = (value) => ({ get: () => `Bearer ${value}` });
  assert.equal(readNotificationSession(req(token)).clientId, 'CL-002');
  const [payload, signature] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ username: 'client', clientId: 'CL-003', role: 'client', expires: Date.now() + 100000 })).toString('base64url');
  assert.equal(readNotificationSession(req(`${forged}.${signature}`)), null);
  assert.equal(readNotificationSession(req(`${payload}.invalid`)), null);
});

test('inventory field samples match real values already in the client inventory', () => {
  const items = [
    { clientId: 'CL-002', sku: 'SKU-1', title: 'Copper Marker', quantity: 10, upc: '123456789012', asin: 'B001ASIN', merchant: 'Amazon', notes: 'Fragile' },
    { clientId: 'CL-002', sku: 'SKU-2', title: 'Steel Marker', quantity: 20, upc: '987654321098', asin: 'B002ASIN', merchant: 'Walmart', notes: 'Bulk order' }
  ];

  assert.equal(getInventoryFieldSample(items, 'upc'), '123456789012');
  assert.equal(getInventoryFieldSample(items, 'asin'), 'B001ASIN');
  assert.equal(getInventoryFieldSample(items, 'merchant'), 'Amazon');
  assert.equal(getInventoryFieldSample(items, 'notes'), 'Fragile');
});

test('background sync refreshes changed data, backs off on 429, and ignores old sessions', async () => {
  const timers = new Map();
  const pending = [];
  let nextTimerId = 0;
  let chatVisible = true;
  const msgBox = { innerHTML: '', scrollHeight: 100, scrollTop: 0, clientHeight: 100 };
  const inventoryBody = { innerHTML: '' };
  const listeners = {};
  const elements = {
    msgBox,
    inventoryBody,
    'page-chat': { classList: { contains: () => chatVisible } }
  };
  const document = {
    hidden: false,
    getElementById: (id) => elements[id] || null,
    querySelectorAll: () => [],
    addEventListener: (event, callback) => { listeners[event] = callback; }
  };
  const context = vm.createContext({
    document,
    window: { location: { hostname: 'localhost' }, addEventListener: () => {} },
    fetch: (url) => new Promise((resolve) => pending.push({ url, resolve })),
    setTimeout: (callback, delay) => {
      const id = ++nextTimerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id)
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8'), context);
  vm.runInContext("state.auth = true; state.session = { clientId: 'CL-001' }; state.activeClientId = 'CL-001'; startBackgroundSync();", context);

  const fire = (delay) => {
    const [id, timer] = [...timers].find(([, scheduled]) => scheduled.delay === delay) || [];
    assert.ok(timer, `expected a ${delay}ms timer`);
    timers.delete(id);
    return timer.callback();
  };
  const respond = (request, status, data) => request.resolve({
    ok: status === 200,
    status,
    json: async () => data
  });

  const firstChat = fire(10000);
  assert.match(pending[0].url, /api\/chat\?clientId=CL-001/);
  respond(pending.shift(), 200, [{ sender: 'Staff', isStaff: true, message: 'New chat' }]);
  await firstChat;
  assert.match(msgBox.innerHTML, /New chat/);

  const firstInventory = fire(15000);
  respond(pending.shift(), 200, [{ id: 'sku-1', title: 'New item', qty: 5 }]);
  await firstInventory;
  assert.match(inventoryBody.innerHTML, /New item/);

  const unchangedChat = fire(10000);
  msgBox.scrollTop = 42;
  respond(pending.shift(), 200, [{ sender: 'Staff', isStaff: true, message: 'New chat' }]);
  await unchangedChat;
  assert.equal(msgBox.scrollTop, 42);

  const failedChat = fire(10000);
  respond(pending.shift(), 429);
  await failedChat;
  assert.match(msgBox.innerHTML, /New chat/);
  assert.ok([...timers.values()].some(({ delay }) => delay >= 30000));

  const oldInventory = fire(15000);
  vm.runInContext("state.activeClientId = 'CL-002'; inventoryRequestId += 1;", context);
  respond(pending.shift(), 200, [{ id: 'old', title: 'Wrong client', qty: 1 }]);
  await oldInventory;
  assert.doesNotMatch(inventoryBody.innerHTML, /Wrong client/);

  document.hidden = true;
  listeners.visibilitychange();
  assert.equal(timers.size, 0);
  document.hidden = false;
  chatVisible = false;
  listeners.visibilitychange();
  assert.ok([...timers.values()].some(({ delay }) => delay === 0));
  assert.ok([...timers.values()].some(({ delay }) => delay === 1500));
  assert.equal(timers.size, 2);

  vm.runInContext('executePortalLogout()', context);
  assert.equal(timers.size, 0);
});

test('notification API isolates client threads and persists read cursors in the sheet', async () => {
  const makeRow = (values) => ({
    get: (key) => values[key] || '',
    set: (key, value) => { values[key] = value; },
    save: async () => {}
  });
  const makeSheet = (headers, values = []) => {
    const rows = values.map(makeRow);
    return {
      headerValues: headers,
      loadHeaderRow: async () => {},
      getRows: async () => rows,
      addRow: async (value) => rows.push(makeRow(value))
    };
  };
  const inventoryCells = new Map([['8:1', { value: 'SKU-1' }], ['8:3', { value: 2 }], ['8:4', { value: 'Low Stock' }]]);
  let inventorySaves = 0;
  const sheets = {
    Chat_log: makeSheet(['Timestamp', 'Sender', 'Message', 'ClientID', 'IsStaff', 'FileUrl', 'FileName'], [
      { Timestamp: '2026-09-23T12:00:00.000Z', ClientID: 'CL-002', IsStaff: '1', Sender: 'ADMIN', Message: 'Hello' },
      { Timestamp: '2026-09-23T12:00:00.000Z', ClientID: 'CL-002', IsStaff: '0', Sender: 'EcomElite', Message: 'Reply' },
      { Timestamp: '2026-09-23T12:00:00.000Z', ClientID: 'CL-003', IsStaff: '1', Sender: 'ADMIN', Message: 'Other client' }
    ]),
    Inventory_Events: makeSheet(['Timestamp', 'ClientID', 'Description', 'ActorUsername'], [
      { Timestamp: '2026-09-23T12:00:00.000Z', ClientID: 'CL-002', Description: 'Added widget', ActorUsername: 'ADMIN' }
    ]),
    Notification_State: makeSheet(['Username', 'ClientID', 'ChatSeenAt', 'InventorySeenAt']),
    'CL-001': {
      rowCount: 10,
      loadCells: async () => {},
      getCell: (rowIndex, columnIndex) => inventoryCells.get(`${rowIndex}:${columnIndex}`) || { value: '' },
      saveUpdatedCells: async () => { inventorySaves += 1; }
    }
  };
  const oldLoadInfo = GoogleSpreadsheet.prototype.loadInfo;
  const oldSheetsByTitle = Object.getOwnPropertyDescriptor(GoogleSpreadsheet.prototype, 'sheetsByTitle');
  const oldSheetsByIndex = Object.getOwnPropertyDescriptor(GoogleSpreadsheet.prototype, 'sheetsByIndex');
  GoogleSpreadsheet.prototype.loadInfo = async function () {
    this.testSheets = sheets;
  };
  Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByTitle', { configurable: true, get() { return this.testSheets; } });
  Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByIndex', { configurable: true, get() { return Object.values(this.testSheets); } });
  const { app } = require('../api/server.js');
  const server = app.listen(0);
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/notifications`;
    const clientToken = signNotificationSession('EcomElite', 'CL-002', 'client');
    const headers = { Authorization: `Bearer ${clientToken}` };
    const first = await (await fetch(`${url}?clientId=CL-003`, { headers })).json();
    assert.deepEqual([first.chat, first.inventory, first.total], [1, 1, 2]);
    assert.ok(first.items.every((item) => item.clientId === 'CL-002'));

    const read = await fetch(`${url}/read`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'chat', clientId: 'CL-003' })
    });
    assert.equal(read.status, 200);
    const second = await (await fetch(url, { headers })).json();
    assert.deepEqual([second.chat, second.inventory], [0, 1]);
    const stateRows = await sheets.Notification_State.getRows();
    assert.equal(stateRows[0].get('ClientID'), 'CL-002');

    const adminToken = signNotificationSession('ADMIN', 'CL-000', 'admin');
    const admin = await (await fetch(url, { headers: { Authorization: `Bearer ${adminToken}` } })).json();
    assert.equal(admin.chat, 1);
    assert.equal(admin.inventory, 0);
    const update = await fetch(`http://127.0.0.1:${server.address().port}/api/inventory/quantity`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${signNotificationSession('MetalGarden', 'CL-001', 'client')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'CL-001', sku: 'SKU-1', qty: 7 })
    });
    assert.equal(update.status, 200);
    assert.equal(inventoryCells.get('8:3').value, 7);
    assert.equal(inventorySaves, 1);
    const eventRows = await sheets.Inventory_Events.getRows();
    assert.equal(eventRows.at(-1).get('Description'), 'Updated SKU-1 to 7');
    const updatedAdmin = await (await fetch(url, { headers: { Authorization: `Bearer ${adminToken}` } })).json();
    assert.equal(updatedAdmin.inventory, 1);
    const invalid = await fetch(url, { headers: { Authorization: `Bearer ${clientToken}bad` } });
    assert.equal(invalid.status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    GoogleSpreadsheet.prototype.loadInfo = oldLoadInfo;
    Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByTitle', oldSheetsByTitle);
    Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByIndex', oldSheetsByIndex);
  }
});

test('notification bell renders counts and marks a notification type read without a reload', async () => {
  const elements = {};
  const element = () => ({ style: {}, textContent: '', children: [],
    setAttribute(key, value) { this[key] = value; },
    replaceChildren() { this.children = []; },
    append(...children) { this.children.push(...children); },
    addEventListener() {} });
  ['notificationAnchor', 'notificationBadge', 'notificationList', 'notificationClear', 'notificationButton', 'notificationPanel'].forEach((id) => {
    elements[id] = element();
  });
  let unread = { chat: 1, inventory: 1, total: 2, items: [
    { kind: 'chat', clientId: 'CL-002', description: 'ADMIN: Hello' },
    { kind: 'inventory', clientId: 'CL-002', description: 'Added widget' }
  ] };
  const posts = [];
  const document = {
    hidden: false,
    getElementById: (id) => elements[id] || null,
    querySelectorAll: () => [],
    createElement: element,
    addEventListener() {}
  };
  const context = vm.createContext({
    document,
    window: { location: { hostname: 'localhost' }, addEventListener() {} },
    fetch: async (url, options) => {
      if (options?.method === 'POST') {
        posts.push(JSON.parse(options.body));
        unread = { chat: 0, inventory: 1, total: 1, items: unread.items.filter((item) => item.kind === 'inventory') };
        return { ok: true, json: async () => ({ success: true }) };
      }
      return { ok: true, json: async () => unread };
    },
    setTimeout: () => 1,
    clearTimeout() {}
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8'), context);
  vm.runInContext("state.auth = true; state.session = { clientId: 'CL-002', notificationToken: 'signed' }; state.activeClientId = 'CL-002';", context);
  await vm.runInContext('fetchNotifications()', context);
  assert.equal(elements.notificationAnchor.style.display, 'block');
  assert.equal(elements.notificationBadge.textContent, '2');
  assert.equal(elements.notificationList.children.length, 2);
  await vm.runInContext("markNotificationsRead('chat')", context);
  assert.deepEqual(posts, [{ kind: 'chat', clientId: 'CL-002' }]);
  assert.equal(elements.notificationBadge.textContent, '1');
  assert.equal(elements.notificationList.children.length, 1);
});

test('Apps Script logs manual inventory edits but ignores headers and non-client tabs', () => {
  const appended = [];
  const log = { appendRow: (row) => appended.push(row) };
  const sheet = {
    getName: () => 'CL-001',
    getRange: () => ({ getDisplayValue: () => 'SKU-1' })
  };
  const source = { getSheetByName: () => null, insertSheet: () => log };
  const context = vm.createContext({ Session: { getActiveUser: () => ({ getEmail: () => 'staff@example.com' }) } });
  vm.runInContext(fs.readFileSync(require.resolve('../Code.gs'), 'utf8'), context);
  context.onEdit({ range: { getSheet: () => sheet, getRow: () => 8 }, source });
  assert.equal(appended.length, 0);
  context.onEdit({ range: { getSheet: () => sheet, getRow: () => 9, getA1Notation: () => 'D9' }, source });
  assert.equal(appended.length, 2);
  assert.equal(appended[1][1], 'CL-001');
  assert.match(appended[1][2], /Edited SKU-1 \(D9\)/);
  context.onEdit({ range: { getSheet: () => ({ getName: () => 'Chat_log' }), getRow: () => 2 }, source });
  assert.equal(appended.length, 2);
});
