const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { GoogleSpreadsheet } = require('google-spreadsheet');

process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'test@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'test-only-not-a-real-key';
process.env.GOOGLE_SHEET_ID = 'test-sheet';

const { normalizeInventoryRow, getSheetNameForClient, getClientInventoryFields, getVisibleClientFields, getChatDriveFolderForClient, getInventoryFieldSample, getCreateFormTitleConfig, getDashboardColumns, getShipmentStatus } = require('../api/portalLogic.js');
const { normalizeClientId, summarizeUnreadNotifications, signNotificationSession, readNotificationSession, cachedRead, invalidateReadCache } = require('../api/server.js');

test('server read cache shares in-flight reads, invalidates by prefix, and never caches failures', async () => {
  let calls = 0;
  const loader = () => Promise.resolve(++calls);
  const [first, second] = await Promise.all([cachedRead('t:x', 1000, loader), cachedRead('t:x', 1000, loader)]);
  assert.deepEqual([first, second, calls], [1, 1, 1]);
  invalidateReadCache('t:');
  assert.equal(await cachedRead('t:x', 1000, loader), 2);
  await assert.rejects(cachedRead('t:fail', 1000, () => Promise.reject(new Error('429'))));
  assert.equal(await cachedRead('t:fail', 1000, () => Promise.resolve('ok')), 'ok');
  invalidateReadCache('t:');
});

test('account endpoints use bcrypt, hashed single-use recovery codes, admin-only resets, a private client list, and login rate limits', async () => {
  const bcrypt = require('bcryptjs');
  const makeRow = (values) => ({ values, get: (key) => values[key] || '', set: (key, value) => { values[key] = value; }, save: async () => {} });
  const admin = makeRow({ Client_ID: 'CL-000', Username: 'ADMIN', Role: 'admin', Password: await bcrypt.hash('AdminPass1', 4) });
  const client = makeRow({ Client_ID: 'CL-001', Username: 'MetalGarden', Password: await bcrypt.hash('ClientPass1', 4), Recovery_Code_Hash: await bcrypt.hash('OLDC-ODE1', 4) });
  const credentials = {
    headerValues: [],
    loadHeaderRow: async () => {},
    setHeaderRow: async (headers) => { credentials.headerValues = headers; },
    getRows: async () => [admin, client]
  };
  const sheets = { User_Credentials: credentials };
  const titleDescriptor = Object.getOwnPropertyDescriptor(GoogleSpreadsheet.prototype, 'sheetsByTitle');
  const indexDescriptor = Object.getOwnPropertyDescriptor(GoogleSpreadsheet.prototype, 'sheetsByIndex');
  const oldLoadInfo = GoogleSpreadsheet.prototype.loadInfo;
  GoogleSpreadsheet.prototype.loadInfo = async () => {};
  Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByTitle', { configurable: true, get: () => sheets });
  Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByIndex', { configurable: true, get: () => Object.values(sheets) });
  const { app } = require('../api/server.js');
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const post = (path, body, token) => fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body || {})
  });
  try {
    assert.equal((await post('/login', { username: 'ADMIN', password: 'wrong-pass' })).status, 401);
    const adminToken = (await (await post('/login', { username: 'ADMIN', password: 'AdminPass1' })).json()).notificationToken;
    const clientToken = (await (await post('/login', { username: 'MetalGarden', password: 'ClientPass1' })).json()).notificationToken;
    assert.ok(adminToken && clientToken);

    assert.equal((await post('/admin/clients/CL-001/reset-password')).status, 401);
    assert.equal((await post('/admin/clients/CL-001/reset-password', {}, clientToken)).status, 401);
    assert.equal((await post('/admin/clients', { clientId: 'CL-999', clientName: 'X', username: 'x' })).status, 401);
    assert.equal((await post('/admin/clients/CL-000/reset-password', {}, adminToken)).status, 400);

    const reset = await (await post('/admin/clients/CL-001/reset-password', {}, adminToken)).json();
    assert.match(reset.activationCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.equal(client.get('Password'), '');
    assert.equal(client.get('Recovery_Code_Hash'), '');
    assert.equal((await post('/login', { username: 'MetalGarden', password: 'ClientPass1' })).status, 403);
    assert.equal((await post('/account/recover', { username: 'MetalGarden', recoveryCode: 'OLDC-ODE1', newPassword: 'Whatever123' })).status, 400);

    assert.equal((await post('/account/activate', { username: 'MetalGarden', activationCode: ['bad'], password: 'NewPass123' })).status, 400);
    assert.equal((await post('/account/activate', { username: 'MetalGarden', activationCode: 'WRON-GCOD', password: 'NewPass123' })).status, 400);
    const activated = await (await post('/account/activate', { username: 'MetalGarden', activationCode: reset.activationCode.toLowerCase(), password: 'NewPass123' })).json();
    assert.ok(activated.success);
    assert.match(client.get('Recovery_Code_Hash'), /^\$2[aby]\$/);
    assert.notEqual(client.get('Recovery_Code_Hash'), activated.recoveryCode);
    assert.equal(client.get('Activation_Code'), '');

    const recovered = await (await post('/account/recover', { username: 'MetalGarden', recoveryCode: activated.recoveryCode.toLowerCase(), newPassword: 'Recovered123' })).json();
    assert.ok(recovered.success);
    assert.equal((await post('/account/recover', { username: 'MetalGarden', recoveryCode: activated.recoveryCode, newPassword: 'Another1234' })).status, 400);
    assert.equal((await post('/login', { username: 'MetalGarden', password: 'Recovered123' })).status, 200);

    const getClients = (token) => fetch(`${base}/clients`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    assert.equal((await getClients()).status, 401);
    assert.equal((await getClients('forged.token')).status, 401);
    const adminRoster = await (await getClients(adminToken)).json();
    assert.deepEqual(adminRoster.map((entry) => entry.clientId), ['CL-000', 'CL-001']);
    assert.ok(adminRoster.every((entry) => !('password' in entry)));
    const ownRoster = await (await getClients(clientToken)).json();
    assert.deepEqual(ownRoster.map((entry) => entry.clientId), ['CL-001']);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      assert.equal((await post('/login', { username: 'MetalGarden', password: `guess-${attempt}` })).status, 401);
    }
    const locked = await post('/login', { username: 'MetalGarden', password: 'Recovered123' });
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get('retry-after')) > 0);
    assert.equal((await post('/account/recover', { username: 'metalgarden', recoveryCode: recovered.recoveryCode, newPassword: 'Another1234' })).status, 429);
    assert.equal((await post('/login', { username: 'ADMIN', password: 'AdminPass1' })).status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    GoogleSpreadsheet.prototype.loadInfo = oldLoadInfo;
    Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByTitle', titleDescriptor);
    Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByIndex', indexDescriptor);
  }
});

test('rapid admin client switching loads only the final client and ignores late responses', async () => {
  const timers = [];
  const requests = [];
  const ok = (data) => ({ ok: true, status: 200, json: async () => data });
  const context = vm.createContext({
    document: { hidden: false, getElementById: () => null, querySelectorAll: () => [], addEventListener() {} },
    window: { location: { hostname: 'localhost' }, addEventListener() {} },
    AbortController,
    fetch: (url, options = {}) => new Promise((resolve, reject) => {
      requests.push({ url, signal: options.signal, resolve });
      options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }),
    setTimeout: (callback, delay) => timers.push({ callback, delay }),
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8'), context);
  vm.runInContext("state.auth = true; state.isAdmin = true; state.session = { clientId: 'CL-000', role: 'admin', notificationToken: 't' }; state.activeClientId = 'CL-001'; fetchInventory('CL-001');", context);
  const inFlight = requests.shift();
  const readView = () => JSON.parse(vm.runInContext('JSON.stringify({ active: state.activeClientId, profile: state.clientProfile && state.clientProfile.clientId, items: state.items.map((item) => item.title) })', context));

  ['CL-002', 'CL-003', 'CL-004'].forEach((id) => context.switchClientView(id));
  assert.equal(inFlight.signal.aborted, true);
  assert.equal(requests.length, 0);
  const pending = timers.filter((timer) => timer.delay === 250 && !timer.cleared);
  assert.equal(pending.length, 1);

  const switching = pending[0].callback();
  assert.ok(requests.length >= 2);
  assert.ok(requests.every((request) => request.url.includes('CL-004')));

  const leaked = context.fetchClientProfile('CL-002');
  requests.find((request) => request.url.includes('CL-002')).resolve(ok({ clientId: 'CL-002', dashboardColumns: ['WRONG'] }));
  await leaked;
  for (const request of requests.filter((entry) => entry.url.includes('CL-004'))) {
    request.resolve(ok(request.url.includes('client-profile')
      ? { clientId: 'CL-004', fields: [] }
      : [{ id: 'a', sku: 'S4', title: 'Client four item', qty: 3 }]));
  }
  await switching;
  assert.deepEqual(readView(), { active: 'CL-004', profile: 'CL-004', items: ['Client four item'] });

  context.switchClientView('CL-002');
  context.switchClientView('CL-004');
  assert.deepEqual(readView(), { active: 'CL-004', profile: 'CL-004', items: ['Client four item'] });
});

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

test('shipment status follows received then shipped quantities for Ecom Elite and CJA', () => {
  assert.equal(getShipmentStatus({ clientId: 'CL-002', quantityOrdered: 10, quantityReceived: '', quantityShipped: '' }), 'awaiting');
  assert.equal(getShipmentStatus({ clientId: 'CL-002', quantityOrdered: 10, quantityReceived: 8, quantityShipped: 0 }), 'not');
  assert.equal(getShipmentStatus({ clientId: 'CL-002', quantityOrdered: 10, quantityReceived: 8, quantityShipped: 4 }), 'partial');
  assert.equal(getShipmentStatus({ clientId: 'CL-003', quantityOrdered: 10, quantityReceived: 8, quantityShipped: 8 }), 'fully');
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
  assert.equal(getChatDriveFolderForClient('CL-000'), '');
  assert.equal(getChatDriveFolderForClient('CL-099'), '');
  const { normalizeDriveFolderUrl } = require('../api/portalLogic.js');
  assert.equal(normalizeDriveFolderUrl('1AbCdEfGhIjKlMn_-'), 'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMn_-');
  assert.equal(normalizeDriveFolderUrl('https://drive.google.com/drive/u/0/folders/abc'), 'https://drive.google.com/drive/u/0/folders/abc');
  assert.equal(normalizeDriveFolderUrl('javascript:alert(1)'), '');
  assert.equal(normalizeDriveFolderUrl('https://evil.example/drive/folders/abc'), '');
  assert.equal(normalizeDriveFolderUrl('https://drive.google.com/file/d/abc/view'), '');
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
  GoogleSpreadsheet.prototype.loadInfo = async () => {};
  Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByTitle', { configurable: true, get: () => sheets });
  Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByIndex', { configurable: true, get: () => Object.values(sheets) });
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

test('legacy client settings map onto the new schema with safe defaults', () => {
  const { mapClientSettings, planClientSettingsMigration } = require('../api/clientSchema.js');
  const cl002Fields = [{ key: 'bundled', label: 'Bundled? (Y/N)' }, { key: 'notes', label: 'Notes' }];
  assert.deepEqual(mapClientSettings('', { fields: cl002Fields, clientId: 'CL-002' }), {
    fieldVisibility: { bundled: { inventory: true, order: true }, notes: { inventory: true, order: true } },
    quickEditMode: 'disabled',
    attributeMap: { bundled: 'bundled', fragile: null, oversized: null },
    overstockLevel: 100
  });
  assert.equal(mapClientSettings('{not json', { clientId: 'CL-004' }).quickEditMode, 'enabled');

  const explicit = mapClientSettings({
    quickEditMode: 'bogus',
    overstockLevel: -5,
    attributeMap: { bundled: null, fragile: 'ghost' },
    fieldVisibility: { notes: { order: false }, ghost: { order: false } }
  }, { fields: [{ key: 'notes', label: 'Notes' }, { key: 'bundle', label: 'Bundle' }], clientId: 'CL-004' });
  assert.deepEqual(explicit.attributeMap, { bundled: null, fragile: null, oversized: null });
  assert.deepEqual(explicit.fieldVisibility, { notes: { inventory: true, order: false }, bundle: { inventory: true, order: true } });
  assert.equal(explicit.quickEditMode, 'enabled');
  assert.equal(explicit.overstockLevel, 100);

  const fresh = planClientSettingsMigration({ clientId: 'CL-003', settingsCell: '', pinHashCell: '', editPinCell: '2468', fields: [] });
  assert.equal(JSON.parse(fresh.settingsJson).quickEditMode, 'enabled');
  assert.equal(fresh.hashLegacyPin, true);
  const done = planClientSettingsMigration({ clientId: 'CL-003', settingsCell: '{"quickEditMode":"password"}', pinHashCell: '$2b$10$x', editPinCell: '2468', fields: [] });
  assert.deepEqual([done.settingsJson, done.hashLegacyPin], [null, false]);
});

test('field toggles, quick-edit PIN protection, and legacy settings edits are enforced by the API', async () => {
  const bcrypt = require('bcryptjs');
  const { invalidateReadCache: clearCache, attachActivityDates } = require('../api/server.js');
  clearCache('');
  const makeRow = (values) => ({ values, get: (key) => values[key] ?? '', set: (key, value) => { values[key] = value; }, save: async () => {} });
  const credentialRows = [
    makeRow({ Client_ID: 'CL-002', Username: 'EcomElite' }),
    makeRow({ Client_ID: 'CL-003', Username: 'CJA', Edit_PIN: '2468' }),
    makeRow({
      Client_ID: 'CL-004', Username: 'Acme',
      Fields_JSON: JSON.stringify([{ key: 'fragile', label: 'Fragile', type: 'text' }, { key: 'carrier', label: 'Carrier', type: 'text' }]),
      Client_Settings_JSON: JSON.stringify({ quickEditMode: 'password', fieldVisibility: { carrier: { order: false } } }),
      Quick_Edit_PIN_Hash: await bcrypt.hash('9876', 4)
    })
  ];
  const now = Date.now();
  const eventRows = [
    { Timestamp: new Date(now - 3 * 86400000).toISOString(), ClientID: 'CL-004', Description: 'Added order Widget' },
    { Timestamp: new Date(now - 100 * 86400000).toISOString(), ClientID: 'CL-004', Description: 'Added Old Thing' }
  ].map(makeRow);
  const added = [];
  const cells = new Map([['1:0', { value: 'SKU-9' }], ['1:4', { value: 1 }], ['1:5', { value: '' }]]);
  const sheets = {
    User_Credentials: {
      headerValues: [],
      loadHeaderRow: async () => {},
      setHeaderRow: async (headers) => { sheets.User_Credentials.headerValues = headers; },
      getRows: async () => credentialRows
    },
    Inventory_Events: { headerValues: ['Timestamp', 'ClientID', 'Description', 'ActorUsername'], loadHeaderRow: async () => {}, getRows: async () => eventRows, addRow: async () => {} },
    'CL-004': {
      rowCount: 2,
      addRow: async (row) => added.push(row),
      loadCells: async () => {},
      getCell: (row, col) => cells.get(`${row}:${col}`) || { value: '' },
      saveUpdatedCells: async () => {}
    }
  };
  const titleDescriptor = Object.getOwnPropertyDescriptor(GoogleSpreadsheet.prototype, 'sheetsByTitle');
  const indexDescriptor = Object.getOwnPropertyDescriptor(GoogleSpreadsheet.prototype, 'sheetsByIndex');
  const oldLoadInfo = GoogleSpreadsheet.prototype.loadInfo;
  GoogleSpreadsheet.prototype.loadInfo = async () => {};
  Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByTitle', { configurable: true, get: () => sheets });
  Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByIndex', { configurable: true, get: () => Object.values(sheets) });
  const { app } = require('../api/server.js');
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = (method, path, body, token, extra = {}) => fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
    body: body ? JSON.stringify(body) : undefined
  });
  const adminToken = signNotificationSession('ADMIN', 'CL-000', 'admin');
  const acmeToken = signNotificationSession('Acme', 'CL-004', 'client');
  const cjaToken = signNotificationSession('CJA', 'CL-003', 'client');
  try {
    const profile = await (await call('GET', '/client-profile?clientId=CL-004', null, acmeToken)).json();
    assert.equal(profile.quickEditMode, 'password');
    assert.equal(profile.quickEditPinSet, true);
    assert.equal(profile.attributeMap.fragile, 'fragile');
    assert.ok(!JSON.stringify(profile).includes('$2'));

    const item = { clientId: 'CL-004', sku: 'X', title: 'Widget', qty: 3, extraFields: { fragile: 'Y', carrier: 'UPS' } };
    assert.equal((await call('POST', '/inventory/create', { ...item, kind: 'order', sku: 'ORD-1' }, acmeToken)).status, 200);
    assert.equal((await call('POST', '/inventory/create', { ...item, sku: 'INV-1', status: 'Low Stock' }, acmeToken)).status, 200);
    assert.deepEqual(added, [['ORD-1', 'Widget', 'Y', '', 3, 'Not Shipped', ''], ['INV-1', 'Widget', 'Y', 'UPS', 3, 'Low Stock', '']]);

    const quantity = { clientId: 'CL-004', sku: 'SKU-9', qty: 4 };
    const locked = await call('PUT', '/inventory/quantity', quantity, acmeToken);
    assert.equal(locked.status, 403);
    assert.equal((await locked.json()).code, 'QUICK_EDIT_PIN_REQUIRED');
    assert.equal((await call('POST', '/quick-edit/unlock', { clientId: 'CL-004', pin: '0000' }, acmeToken)).status, 401);
    assert.equal((await call('POST', '/quick-edit/unlock', { clientId: 'CL-003', pin: '2468' }, acmeToken)).status, 400);
    const unlock = await (await call('POST', '/quick-edit/unlock', { clientId: 'CL-004', pin: '9876' }, acmeToken)).json();
    assert.ok(unlock.success);
    assert.equal((await call('GET', '/clients', null, unlock.token)).status, 401);
    assert.equal((await call('PUT', '/inventory/quantity', quantity, cjaToken, { 'X-Quick-Edit-Token': unlock.token })).status, 400);
    assert.equal((await call('PUT', '/inventory/quantity', quantity, acmeToken, { 'X-Quick-Edit-Token': unlock.token })).status, 200);
    assert.equal(cells.get('1:4').value, 4);
    assert.equal((await call('PUT', '/inventory/quantity', { ...quantity, qty: 5 }, adminToken)).status, 200);

    assert.equal((await call('PUT', '/admin/clients/CL-002', { quickEditMode: 'password' }, adminToken)).status, 400);
    const cl002 = await (await call('PUT', '/admin/clients/CL-002', {
      quickEditMode: 'enabled',
      attributeMap: { bundled: null },
      fields: [{ key: 'bundled', showInInventory: true, showInOrder: false }]
    }, adminToken)).json();
    assert.ok(cl002.success);
    assert.equal(cl002.profile.fieldVisibility.bundled.order, false);
    assert.equal(cl002.profile.attributeMap.bundled, null);
    assert.equal(cl002.profile.quickEditMode, 'disabled');
    assert.equal(credentialRows[0].values.Fields_JSON, undefined);

    assert.equal((await call('PUT', '/admin/clients/CL-003', { quickEditMode: 'password' }, adminToken)).status, 200);
    assert.equal((await (await call('PUT', '/inventory/quantity', { clientId: 'CL-003', sku: 'A', qty: 1 }, cjaToken, { 'X-Quick-Edit-Token': unlock.token })).json()).code, 'QUICK_EDIT_PIN_REQUIRED');
    assert.ok((await (await call('POST', '/quick-edit/unlock', { clientId: 'CL-003', pin: '2468' }, cjaToken)).json()).success);
    assert.match(credentialRows[1].values.Quick_Edit_PIN_Hash, /^\$2[aby]\$/);
    assert.equal(credentialRows[1].values.Edit_PIN, '2468');

    const dated = await attachActivityDates([
      { clientId: 'CL-004', sku: 'ORD-1', title: 'Widget' },
      { clientId: 'CL-004', sku: 'OLD-1', title: 'Old Thing' },
      { clientId: 'CL-004', sku: 'NEW-1', title: 'Untracked' }
    ]);
    assert.equal(Date.parse(dated[0].addedAt), Date.parse(eventRows[0].values.Timestamp));
    assert.ok(dated[1].lastActivityAt);
    assert.deepEqual([dated[2].addedAt, dated[2].lastActivityAt], [null, null]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    GoogleSpreadsheet.prototype.loadInfo = oldLoadInfo;
    Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByTitle', titleDescriptor);
    Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByIndex', indexDescriptor);
  }
});

test('drive folders and chat files stay inside the signed-in client account', async () => {
  const { invalidateReadCache: clearCache } = require('../api/server.js');
  clearCache('');
  const makeRow = (values) => ({ values, get: (key) => values[key] ?? '', set: (key, value) => { values[key] = value; }, save: async () => {} });
  const chatHeaders = ['Timestamp', 'Sender', 'Message', 'ClientID', 'IsStaff', 'FileUrl', 'FileName'];
  const chatRows = [
    { Timestamp: '2026-09-30T10:00:00.000Z', Sender: 'ADMIN', Message: 'For Acme', ClientID: 'CL-004', IsStaff: '1', FileUrl: 'https://drive.google.com/file/d/acme/view', FileName: 'acme.png' },
    { Timestamp: '2026-09-30T10:01:00.000Z', Sender: 'ADMIN', Message: 'For Beta', ClientID: 'CL-005', IsStaff: '1', FileUrl: 'https://drive.google.com/file/d/beta/view', FileName: 'beta.png' },
    { Timestamp: '2026-09-30T10:02:00.000Z', Sender: 'X', Message: 'Bad link', ClientID: 'CL-004', IsStaff: '0', FileUrl: 'javascript:alert(1)', FileName: 'x' }
  ].map(makeRow);
  const sheets = {
    User_Credentials: {
      headerValues: [],
      loadHeaderRow: async () => {},
      setHeaderRow: async (headers) => { sheets.User_Credentials.headerValues = headers; },
      getRows: async () => [
        makeRow({ Client_ID: 'CL-004', Username: 'Acme', Email: 'acme@example.com', Drive_Folder_URL: 'AcmeFolderId_123' }),
        makeRow({ Client_ID: 'CL-005', Username: 'Beta', Email: '', Drive_Folder_URL: 'https://drive.google.com/drive/folders/BetaFolder' }),
        makeRow({ Client_ID: 'CL-006', Username: 'Gamma', Email: 'g@example.com', Drive_Folder_URL: '' })
      ]
    },
    Chat_log: { headerValues: chatHeaders, loadHeaderRow: async () => {}, getRows: async () => chatRows, addRow: async (row) => chatRows.push(makeRow(Object.fromEntries(chatHeaders.map((key, index) => [key, row[index]])))) }
  };
  const titleDescriptor = Object.getOwnPropertyDescriptor(GoogleSpreadsheet.prototype, 'sheetsByTitle');
  const indexDescriptor = Object.getOwnPropertyDescriptor(GoogleSpreadsheet.prototype, 'sheetsByIndex');
  const oldLoadInfo = GoogleSpreadsheet.prototype.loadInfo;
  GoogleSpreadsheet.prototype.loadInfo = async () => {};
  Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByTitle', { configurable: true, get: () => sheets });
  Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByIndex', { configurable: true, get: () => Object.values(sheets) });
  const { app } = require('../api/server.js');
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = (method, path, body, token) => fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const acme = signNotificationSession('Acme', 'CL-004', 'client');
  const beta = signNotificationSession('Beta', 'CL-005', 'client');
  const admin = signNotificationSession('ADMIN', 'CL-000', 'admin');
  try {
    assert.equal((await call('GET', '/client-profile?clientId=CL-004')).status, 401);
    assert.equal((await call('GET', '/client-profile?clientId=CL-005', null, acme)).status, 403);
    const acmeProfile = await (await call('GET', '/client-profile', null, acme)).json();
    assert.equal(acmeProfile.driveFolderUrl, 'https://drive.google.com/drive/folders/AcmeFolderId_123');
    assert.equal(acmeProfile.driveAccessReady, true);
    assert.ok(!('email' in acmeProfile));
    const betaProfile = await (await call('GET', '/client-profile?clientId=CL-005', null, admin)).json();
    assert.deepEqual([betaProfile.hasEmail, betaProfile.driveAccessReady], [false, false]);
    const gammaProfile = await (await call('GET', '/client-profile?clientId=CL-006', null, admin)).json();
    assert.deepEqual([gammaProfile.driveFolderUrl, gammaProfile.driveAccessReady], ['', false]);
    const adminProfile = await (await call('GET', '/client-profile?clientId=CL-000', null, admin)).json();
    assert.equal(adminProfile.driveFolderUrl, '');

    assert.equal((await call('GET', '/chat?clientId=CL-004')).status, 401);
    const acmeChat = await (await call('GET', '/chat?clientId=CL-000', null, acme)).json();
    assert.deepEqual(acmeChat.map((message) => message.message), ['For Acme', 'Bad link']);
    assert.deepEqual(acmeChat.map((message) => message.fileUrl), ['https://drive.google.com/file/d/acme/view', '']);
    const betaChat = await (await call('GET', '/chat?clientId=CL-004', null, beta)).json();
    assert.deepEqual(betaChat.map((message) => message.message), ['For Beta']);
    assert.equal((await (await call('GET', '/chat?clientId=CL-005', null, admin)).json()).length, 1);

    assert.equal((await call('POST', '/chat', { clientId: 'CL-004', sender: 'Beta', message: 'hi' })).status, 401);
    assert.equal((await call('POST', '/chat', { clientId: 'CL-004', sender: 'Beta', message: 'hi', fileUrl: 'https://evil.example/x.png' }, beta)).status, 400);
    const sent = await (await call('POST', '/chat', { clientId: 'CL-004', sender: 'Beta', message: 'sneaky', isStaff: true }, beta)).json();
    assert.deepEqual([sent.message.clientId, sent.message.isStaff], ['CL-005', false]);
    assert.equal(chatRows.at(-1).get('ClientID'), 'CL-005');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    GoogleSpreadsheet.prototype.loadInfo = oldLoadInfo;
    Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByTitle', titleDescriptor);
    Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByIndex', indexDescriptor);
  }
});

test('staff update received then shipped quantities and the status follows the warehouse workflow', async () => {
  const { invalidateReadCache: clearCache } = require('../api/server.js');
  clearCache('');
  const makeRow = (values) => ({ values, get: (key) => values[key] ?? '', set: (key, value) => { values[key] = value; }, save: async () => {} });
  const grid = [
    ['SKU', 'Product Title', 'Quantity Received', 'Quantity Shipped', 'Qty', 'Status', 'Notes'],
    ['A-1', 'Widget', '', '', 5, 'Not Received', '']
  ];
  const cell = (row, col) => {
    grid[row] = grid[row] || [];
    return {
      get value() { return grid[row][col] ?? ''; },
      set value(next) { grid[row][col] = next; }
    };
  };
  const sheets = {
    User_Credentials: {
      headerValues: [], loadHeaderRow: async () => {}, setHeaderRow: async () => {},
      getRows: async () => [makeRow({ Client_ID: 'CL-004', Username: 'Acme', Fields_JSON: JSON.stringify([{ key: 'quantityReceived', label: 'Quantity Received', type: 'number' }, { key: 'quantityShipped', label: 'Quantity Shipped', type: 'number' }]) })]
    },
    Inventory_Events: { headerValues: ['Timestamp', 'ClientID', 'Description', 'ActorUsername'], loadHeaderRow: async () => {}, getRows: async () => [], addRow: async () => {} },
    'CL-004': { title: 'CL-004', rowCount: 2, columnCount: 7, loadCells: async () => {}, getCell: cell, saveUpdatedCells: async () => {} }
  };
  const titleDescriptor = Object.getOwnPropertyDescriptor(GoogleSpreadsheet.prototype, 'sheetsByTitle');
  const indexDescriptor = Object.getOwnPropertyDescriptor(GoogleSpreadsheet.prototype, 'sheetsByIndex');
  const oldLoadInfo = GoogleSpreadsheet.prototype.loadInfo;
  GoogleSpreadsheet.prototype.loadInfo = async () => {};
  Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByTitle', { configurable: true, get: () => sheets });
  Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByIndex', { configurable: true, get: () => Object.values(sheets) });
  const { app } = require('../api/server.js');
  const server = app.listen(0);
  const update = (body, token) => fetch(`http://127.0.0.1:${server.address().port}/api/inventory/shipment`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ clientId: 'CL-004', itemId: 'CL-004-1', title: 'Widget', ...body })
  });
  const admin = signNotificationSession('ADMIN', 'CL-000', 'admin');
  try {
    assert.equal((await update({ received: 10, shipped: 0 }, signNotificationSession('Acme', 'CL-004', 'client'))).status, 401);
    assert.equal((await update({ received: 3, shipped: 5 }, admin)).status, 400);
    assert.equal((await update({ received: 10, shipped: 0, title: 'Other' }, admin)).status, 409);

    const steps = [[10, 0, 'Not Shipped'], [10, 4, 'Partially Shipped'], [10, 10, 'Fully Shipped']];
    for (const [received, shipped, status] of steps) {
      const result = await (await update({ received, shipped }, admin)).json();
      assert.equal(result.status, status);
      assert.deepEqual([grid[1][2], grid[1][3], grid[1][5]], [received, shipped, status]);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    GoogleSpreadsheet.prototype.loadInfo = oldLoadInfo;
    Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByTitle', titleDescriptor);
    Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByIndex', indexDescriptor);
  }
});

test('billing builds invoice lines that match real client invoices', () => {
  const { summarizeBilling, sanitizeRateCard, sanitizeEntry } = require('../api/billing.js');
  const entry = (date, serviceKey, quantity, unitPrice, extra = {}) => ({ date, serviceKey, quantity, unitPrice, flat: false, ...extra });

  const cardA = sanitizeRateCard({ services: [
    { name: 'FBM Account And Shipping Management', unitPrice: 0.75 },
    { name: 'FBA Fullfillment (Per Unit)', unitPrice: 1.15 },
    { name: 'FBM Fullfillment (Per Unit)', unitPrice: 3 },
    { name: 'Poly Bag', unitPrice: 0.3 }
  ] });
  const [mgmt, fba, fbm, poly] = cardA.services.map((service) => service.key);
  const named = (key) => cardA.services.find((service) => service.key === key).name;
  const invoiceA = summarizeBilling({
    rateCard: cardA,
    month: '2026-08',
    now: new Date('2026-09-02T00:00:00Z'),
    entries: [
      entry('2026-08-01', mgmt, 15, 0.75), entry('2026-08-20', mgmt, 16, 0.75),
      entry('2026-08-03', fba, 35, 1.15), entry('2026-08-04', fbm, 2, 3),
      entry('2026-08-05', poly, 20, 0.3), entry('2026-08-25', poly, 9, 0.3),
      entry('2026-07-31', fba, 999, 1.15)
    ].map((item) => ({ ...item, name: named(item.serviceKey) }))
  });
  assert.deepEqual(invoiceA.lines.map((line) => [line.name, line.unitPrice, line.quantity, line.amount]), [
    ['FBM Account And Shipping Management', 0.75, 31, 23.25],
    ['FBA Fullfillment (Per Unit)', 1.15, 35, 40.25],
    ['FBM Fullfillment (Per Unit)', 3, 2, 6],
    ['Poly Bag', 0.3, 29, 8.7]
  ]);
  assert.deepEqual(invoiceA.totals, { subtotal: 78.2, tax: 0, total: 78.2, projected: 78.2 });
  assert.deepEqual(invoiceA.period, { start: '8/1/2026', end: '8/31/2026' });

  const cardB = sanitizeRateCard({ services: [
    { name: 'Order Processing & Shipping Fulfillment', unitPrice: 3 },
    { name: 'Inventory Restocking', unitPrice: 0.35 },
    { name: 'Bundling', unitPrice: 0.3 },
    { name: 'Bundling', unitPrice: 1.25, description: 'Oversized Bundle' },
    { name: 'Poly Mailer', unitPrice: 0.6 },
    { name: 'Box', unitPrice: 1.25 },
    { name: 'Bagging', unitPrice: 0.3, description: 'Bagging is the combined cost of the material used for the bag and the labor required to place the product inside it.' }
  ] });
  assert.equal(new Set(cardB.services.map((service) => service.key)).size, 7);
  const counts = [36, 322, 21, 9, 13, 5, 9];
  const entriesB = cardB.services.map((service, index) => {
    const { entry: valid } = sanitizeEntry({ date: '2026-08-15', serviceKey: service.key, quantity: counts[index] }, cardB);
    return valid;
  });
  entriesB.push(sanitizeEntry({ date: '2026-08-20', flatCharge: true, name: 'Shipping External', unitPrice: 12.42, note: 'Shipping cost for order #109333' }, cardB).entry);
  const invoiceB = summarizeBilling({ rateCard: cardB, entries: entriesB, month: '2026-08', now: new Date('2026-09-02T00:00:00Z') });
  assert.deepEqual(invoiceB.lines.map((line) => line.amount), [108, 112.7, 6.3, 11.25, 7.8, 6.25, 2.7, 12.42]);
  assert.equal(invoiceB.lines[3].description, 'Oversized Bundle');
  assert.deepEqual(invoiceB.lines.at(-1), { name: 'Shipping External', description: 'Shipping cost for order #109333', flat: true, unitPrice: 12.42, quantity: 1, amount: 12.42 });
  // The source invoice printed a $266.07 subtotal, but its own line items add up to $267.42.
  assert.equal(invoiceB.totals.total, 267.42);

  // Mid-month, per-unit work is projected forward but one-off charges are not.
  const midMonth = summarizeBilling({ rateCard: { ...cardB, taxRate: 10 }, entries: entriesB.map((item) => ({ ...item, date: item.date.replace('2026-08', '2026-09') })), month: '2026-09', now: new Date('2026-09-15T12:00:00Z') });
  assert.equal(midMonth.totals.subtotal, 267.42);
  assert.equal(midMonth.totals.tax, 26.74);
  assert.equal(midMonth.totals.projected, Math.round((255 * 2 + 12.42) * 1.1 * 100) / 100);

  assert.equal(sanitizeEntry({ date: '2026-02-30', serviceKey: mgmt, quantity: 1 }, cardA).error, 'Choose a valid date.');
  assert.equal(sanitizeEntry({ date: '2026-08-01', serviceKey: 'ghost', quantity: 1 }, cardA).error, 'Choose a service from the rate card.');
  assert.equal(sanitizeEntry({ date: '2026-08-01', serviceKey: mgmt, quantity: 0 }, cardA).error, 'Quantity must be a positive number.');
  assert.equal(sanitizeEntry({ date: '2026-08-01', serviceKey: mgmt, quantity: 2, unitPrice: '0.80' }, cardA).entry.unitPrice, 0.8);

  // Ecom Elite's real past invoices (by service month); only the latest 6 months count.
  const history = [['2025-09', 106.8], ['2026-03', 316.95], ['2026-04', 61], ['2026-05', 91.9], ['2026-06', 87], ['2026-07', 185.25], ['2026-08', 78.2]]
    .map(([month, amount]) => ({ month, amount }));
  const dayOne = [{ ...entry('2026-10-01', fba, 10, 1.5), name: 'FBA Fullfillment (Per Unit)' }];
  const early = summarizeBilling({ rateCard: cardA, entries: dayOne, history, month: '2026-10', now: new Date('2026-10-01T12:00:00Z') });
  const average = Math.round((316.95 + 61 + 91.9 + 87 + 185.25 + 78.2) / 6 * 100) / 100;
  assert.deepEqual(early.estimate, { basis: 'history', historyAverage: average, historyMonths: 6 });
  const expected = 15 + ((30 / 31) * (average / 31) + (1 / 31) * 15) * 30;
  assert.equal(early.totals.projected, Math.round(expected * 100) / 100);
  assert.ok(early.totals.projected < 200, `day-one estimate ${early.totals.projected} should stay near the usual monthly bill`);

  const noHistoryDayOne = summarizeBilling({ rateCard: cardA, entries: dayOne, month: '2026-10', now: new Date('2026-10-01T12:00:00Z') });
  assert.deepEqual([noHistoryDayOne.estimate.basis, noHistoryDayOne.totals.projected], ['none', 15]);
  const noHistoryLater = summarizeBilling({ rateCard: cardA, entries: dayOne, month: '2026-10', now: new Date('2026-10-10T12:00:00Z') });
  assert.deepEqual([noHistoryLater.estimate.basis, noHistoryLater.totals.projected], ['pace', Math.round((15 + 1.5 * 21) * 100) / 100]);
  const pastMonth = summarizeBilling({ rateCard: cardA, entries: dayOne, history, month: '2026-10', now: new Date('2026-11-02T00:00:00Z') });
  assert.deepEqual([pastMonth.estimate.basis, pastMonth.totals.projected], ['final', 15]);
});

test('billing API keeps rate cards and daily entries admin-only, editable, deletable, and respects client visibility', async () => {
  const { invalidateReadCache: clearCache } = require('../api/server.js');
  const { currentMonth } = require('../api/billing.js');
  clearCache('');
  const rateRows = [];
  const entryRows = [];
  const historyRows = [];
  const makeRow = (values, list) => {
    const row = { values, get: (key) => values[key] ?? '', set: (key, value) => { values[key] = value; }, save: async () => {}, delete: async () => { list.splice(list.indexOf(row), 1); } };
    return row;
  };
  const sheets = {
    Billing_Rate_Cards: { headerValues: [], loadHeaderRow: async () => {}, setHeaderRow: async (h) => { sheets.Billing_Rate_Cards.headerValues = h; }, getRows: async () => rateRows, addRow: async (row) => rateRows.push(makeRow(row, rateRows)) },
    Billing_Line_Items: { headerValues: [], loadHeaderRow: async () => {}, setHeaderRow: async (h) => { sheets.Billing_Line_Items.headerValues = h; }, getRows: async () => entryRows, addRow: async (row) => entryRows.push(makeRow(row, entryRows)) },
    Billing_History: { headerValues: [], loadHeaderRow: async () => {}, setHeaderRow: async (h) => { sheets.Billing_History.headerValues = h; }, getRows: async () => historyRows, addRow: async (row) => historyRows.push(makeRow(row, historyRows)) }
  };
  const titleDescriptor = Object.getOwnPropertyDescriptor(GoogleSpreadsheet.prototype, 'sheetsByTitle');
  const indexDescriptor = Object.getOwnPropertyDescriptor(GoogleSpreadsheet.prototype, 'sheetsByIndex');
  const oldLoadInfo = GoogleSpreadsheet.prototype.loadInfo;
  GoogleSpreadsheet.prototype.loadInfo = async () => {};
  Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByTitle', { configurable: true, get: () => sheets });
  Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByIndex', { configurable: true, get: () => Object.values(sheets) });
  const { app } = require('../api/server.js');
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = (method, path, body, token) => fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const admin = signNotificationSession('ADMIN', 'CL-000', 'admin');
  const acme = signNotificationSession('Acme', 'CL-004', 'client');
  try {
    assert.equal((await call('GET', '/billing/summary?clientId=CL-004')).status, 401);
    assert.equal((await call('GET', '/billing/summary', null, acme)).status, 403);
    assert.equal((await call('PUT', '/admin/billing/rates/CL-004', { services: [] }, acme)).status, 401);

    const saved = await (await call('PUT', '/admin/billing/rates/CL-004', {
      clientVisible: true,
      services: [{ name: 'FBA Fullfillment (Per Unit)', unitPrice: 1.15 }, { name: 'Poly Bag', unitPrice: 0.3 }]
    }, admin)).json();
    assert.ok(saved.success);
    assert.equal(rateRows[0].get('Client_ID'), 'CL-004');
    const [fbaKey, polyKey] = saved.rateCard.services.map((service) => service.key);
    const today = `${currentMonth()}-01`;

    assert.equal((await call('POST', '/admin/billing/entries', { clientId: 'CL-004', date: today, serviceKey: 'ghost', quantity: 1 }, admin)).status, 400);
    assert.equal((await call('POST', '/admin/billing/entries', { clientId: 'CL-004', date: today, serviceKey: fbaKey, quantity: 10 }, acme)).status, 401);
    const first = await (await call('POST', '/admin/billing/entries', { clientId: 'CL-004', date: today, serviceKey: fbaKey, quantity: 10 }, admin)).json();
    await call('POST', '/admin/billing/entries', { clientId: 'CL-004', date: today, serviceKey: polyKey, quantity: 4 }, admin);
    const shipping = await (await call('POST', '/admin/billing/entries', { clientId: 'CL-004', date: today, flatCharge: true, name: 'Shipping External', unitPrice: 12.42, note: 'order #1' }, admin)).json();
    assert.equal(entryRows.length, 3);
    assert.equal(entryRows[0].get('Entered_By'), 'ADMIN');
    assert.ok(first.entry.id);

    let adminView = await (await call('GET', '/billing/summary?clientId=CL-004', null, admin)).json();
    assert.equal(adminView.month, currentMonth());
    assert.equal(adminView.totals.total, 25.12);
    assert.equal(adminView.entries.length, 3);

    assert.equal((await call('PUT', `/admin/billing/entries/${first.entry.id}`, { quantity: 20 }, acme)).status, 401);
    assert.equal((await call('PUT', `/admin/billing/entries/${first.entry.id}`, { quantity: -1 }, admin)).status, 400);
    assert.equal((await call('PUT', `/admin/billing/entries/${first.entry.id}`, { quantity: 20, note: 'recount' }, admin)).status, 200);
    assert.equal(entryRows[0].get('Quantity'), 20);
    assert.equal((await call('DELETE', `/admin/billing/entries/${shipping.entry.id}`, null, admin)).status, 200);
    assert.equal((await call('DELETE', `/admin/billing/entries/${shipping.entry.id}`, null, admin)).status, 404);

    adminView = await (await call('GET', '/billing/summary?clientId=CL-004', null, admin)).json();
    assert.equal(adminView.totals.total, 24.2);

    const clientView = await (await call('GET', '/billing/summary?clientId=CL-005', null, acme)).json();
    assert.equal(clientView.clientId, 'CL-004');
    assert.equal(clientView.totals.total, 24.2);
    assert.equal(clientView.entries, undefined);

    assert.equal((await call('POST', '/admin/billing/history', { clientId: 'CL-004', month: '2026-08', amount: 78.2 }, acme)).status, 401);
    assert.equal((await call('POST', '/admin/billing/history', { clientId: 'CL-004', month: 'August', amount: 78.2 }, admin)).status, 400);
    const past = await (await call('POST', '/admin/billing/history', { clientId: 'CL-004', month: '2020-08', amount: 78.2, invoiceNumber: '000061', invoiceDate: '2020-09-03' }, admin)).json();
    assert.ok(past.success);
    assert.equal(historyRows[0].get('Invoice_Number'), '000061');
    assert.equal((await call('PUT', `/admin/billing/history/${past.record.id}`, { amount: 80 }, admin)).status, 200);
    adminView = await (await call('GET', '/billing/summary?clientId=CL-004', null, admin)).json();
    assert.deepEqual(adminView.history.map((record) => [record.month, record.amount]), [['2020-08', 80]]);
    assert.equal(adminView.estimate.historyMonths, 1);
    assert.equal((await call('DELETE', `/admin/billing/history/${past.record.id}`, null, admin)).status, 200);
    assert.equal(historyRows.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    GoogleSpreadsheet.prototype.loadInfo = oldLoadInfo;
    Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByTitle', titleDescriptor);
    Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByIndex', indexDescriptor);
  }
});

test('dashboard filters combine stock, fulfillment, and attribute selections', () => {
  const context = vm.createContext({
    document: { hidden: false, getElementById: () => null, querySelectorAll: () => [], addEventListener() {} },
    window: { location: { hostname: 'localhost' }, addEventListener() {} },
    AbortController,
    URL,
    setTimeout,
    clearTimeout
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8'), context);
  const day = 86400000;
  const now = Date.now();
  context.__items = [
    { id: 'a', title: 'In', qty: 20, reorderLevel: 5, fragile: 'Y', bundled: 'N' },
    { id: 'b', title: 'Low', qty: 3, reorderLevel: 5, bundled: 'yes' },
    { id: 'c', title: 'Out', qty: 0, reorderLevel: 5, status: 'Exception - delivery issue' },
    { id: 'd', title: 'Over', qty: 500, reorderLevel: 5, lastActivityAt: new Date(now - 120 * day).toISOString() },
    { id: 'e', title: 'Negative', qty: -2, reorderLevel: 5 },
    { id: 'f', title: 'Partial order', qty: 4, reorderLevel: 0, quantityReceived: '10', quantityShipped: '4', addedAt: new Date(now - 3 * day).toISOString() },
    { id: 'g', title: 'Shipped order', qty: 4, reorderLevel: 0, quantityReceived: '4', quantityShipped: '4', addedAt: new Date(now - 3 * day).toISOString() },
    { id: 'h', title: 'Label', qty: 1, reorderLevel: 0, status: 'Ready for Label' }
  ];
  vm.runInContext("state.items = __items; state.activeClientId = 'CL-004'; state.clientProfile = { clientId: 'CL-004', overstockLevel: 100, fields: [{ key: 'quantityReceived', label: 'Quantity Received' }, { key: 'quantityShipped', label: 'Quantity Shipped' }], attributeMap: { bundled: 'bundled', fragile: 'fragile', oversized: null } };", context);
  const pick = (filters) => {
    context.__filters = filters;
    return vm.runInContext("state.filters = Object.assign(emptyFilters(), __filters); getFilteredItems().map((item) => item.id).join(',')", context);
  };

  assert.equal(pick({}), 'a,b,c,d,e,f,g,h');
  assert.equal(pick({ stock: ['out', 'negative'] }), 'c,e');
  assert.equal(pick({ stock: ['over'] }), 'd');
  assert.equal(pick({ stage: ['partial', 'exception', 'label'] }), 'c,f,h');
  assert.equal(pick({ stage: ['fully'] }), 'g');
  assert.equal(pick({ stage: ['awaiting'] }), 'a,b,d,e');
  assert.equal(pick({ attr: ['bundled'] }), 'b');
  assert.equal(pick({ attr: ['unbundled', 'fragile'] }), 'a,c,d,e,f,g,h');
  assert.equal(pick({ attr: ['aged'] }), 'f');
  assert.equal(pick({ attr: ['dead'] }), 'd');
  assert.equal(pick({ stock: ['low', 'in'], attr: ['bundled', 'fragile'] }), 'a,b');

  const folderFor = (profile, clientId) => {
    context.__profile = profile;
    return vm.runInContext(`state.clientProfile = __profile; getChatDriveFolderForClient('${clientId}')`, context);
  };
  const folder = 'https://drive.google.com/drive/folders/abc';
  assert.equal(folderFor({ clientId: 'CL-004', driveFolderUrl: folder, driveAccessReady: true }, 'CL-004'), folder);
  assert.equal(folderFor({ clientId: 'CL-004', driveFolderUrl: folder, driveAccessReady: true }, 'CL-005'), '');
  assert.equal(folderFor({ clientId: 'CL-004', driveFolderUrl: folder, driveAccessReady: false }, 'CL-004'), '');
  assert.equal(folderFor(null, 'CL-001'), '');
});
