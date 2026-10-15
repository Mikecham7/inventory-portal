const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { GoogleSpreadsheet } = require('google-spreadsheet');

process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'test@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'test-only-not-a-real-key';
process.env.GOOGLE_SHEET_ID = 'test-sheet';

const { normalizeInventoryRow, getSheetNameForClient, getClientInventoryFields, getVisibleClientFields, getChatDriveFolderForClient, getInventoryFieldSample, getCreateFormTitleConfig, getDashboardColumns, getShipmentStatus } = require('../api/portalLogic.js');
const { toGenericRows } = require('../api/inventoryLayout.js');
const { normalizeClientId, summarizeUnreadNotifications, signNotificationSession, readNotificationSession, cachedRead, invalidateReadCache } = require('../api/server.js');

test('legacy inventory conversion preserves shipment values and archives removed field values', () => {
  const oldFields = [
    { key: 'quantityOrdered', label: 'Quantity Ordered', type: 'number' },
    { key: 'quantityReceived', label: 'Quantity Received', type: 'number' },
    { key: 'quantityShipped', label: 'Quantity Shipped', type: 'number' },
    { key: 'merchant', label: 'Merchant', type: 'text' },
    { key: 'expDate', label: 'Exp Date', type: 'text' }
  ];
  const rows = [
    ['UPC', 'Product Description', 'Quantity Ordered', 'Quantity Received', 'Quantity Shipped', 'Exp Date', 'Merchant', 'Notes'],
    ['00123', 'Copper Marker', 10, 8, 3, '2027-01', 'Shop', 'Handle carefully']
  ];
  const converted = toGenericRows({
    rows,
    oldFields,
    newFields: oldFields.filter((field) => field.key !== 'expDate'),
    titleLabel: 'Product Description',
    legacyClientId: 'CL-002'
  });

  assert.deepEqual(converted.headers, [
    'SKU', 'Product Description', 'Quantity Ordered', 'Quantity Received', 'Quantity Shipped',
    'Merchant', 'Qty', 'Status', 'Notes', 'Archived: Exp Date'
  ]);
  assert.deepEqual(converted.rows, [[
    '00123', 'Copper Marker', 10, 8, 3, 'Shop', 10, '', 'Handle carefully', '2027-01'
  ]]);
});

test('generic inventory layout changes archive removed values and preserve existing archives', () => {
  const converted = toGenericRows({
    rows: [
      ['SKU', 'Product Title', 'Carrier', 'Qty', 'Status', 'Notes', 'Archived: Old Field'],
      ['A-1', 'Widget', 'UPS', 4, 'In Stock', 'Note', 'original value']
    ],
    oldFields: [{ key: 'carrier', label: 'Carrier', type: 'text' }],
    newFields: [],
    titleLabel: 'Product Title'
  });

  assert.deepEqual(converted.headers, ['SKU', 'Product Title', 'Qty', 'Status', 'Notes', 'Archived: Old Field', 'Archived: Carrier']);
  assert.deepEqual(converted.rows, [['A-1', 'Widget', 4, 'In Stock', 'Note', 'original value', 'UPS']]);
});

test('CL-001 preamble and CL-003 shipment columns convert to the standard row shape', () => {
  const cl001 = toGenericRows({
    rows: [
      ['Metal Garden Markers inventory'],
      ['Client ID', 'SKU Code', 'Product Title', 'Qty', 'Status', 'Notes'],
      ['CL-001', 'MG-1', 'Garden marker', 12, 'In Stock', 'Green'],
      ['', '', '', '', '', '']
    ],
    oldFields: [],
    newFields: [],
    legacyClientId: 'CL-001'
  });
  assert.deepEqual(cl001.rows, [['MG-1', 'Garden marker', 12, 'In Stock', 'Green']]);

  const oldFields = [
    { key: 'quantityOrdered', label: 'Quantity Ordered' },
    { key: 'merchant', label: 'Merchant' },
    { key: 'carrier', label: 'Carrier' },
    { key: 'trackingNumber', label: 'Tracking #' },
    { key: 'quantityReceived', label: 'Quantity Received' },
    { key: 'quantityShipped', label: 'Quantity Shipped' }
  ];
  const cl003 = toGenericRows({
    rows: [
      ['Product Description/Name', 'Quantity Ordered', 'Quantity Received', 'Quantity Shipped', 'Merchant', 'Carrier', 'Tracking #', 'Notes'],
      ['Charizard', 5, 4, 2, 'Store', 'UPS', 'TRACK-1', 'Sleeved']
    ],
    oldFields,
    newFields: oldFields.filter((field) => field.key !== 'carrier'),
    titleLabel: 'Product Description / Name',
    legacyClientId: 'CL-003'
  });
  assert.deepEqual(cl003.rows, [[
    'Charizard', 'Charizard', 5, 'Store', 'TRACK-1', 4, 2, 4, '', 'Sleeved', 'UPS'
  ]]);
  assert.deepEqual(cl003.headers.slice(-1), ['Archived: Carrier']);
});

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

  // When Google rate-limits, the last good copy is served instead of an error; other failures still surface.
  const rateLimited = Object.assign(new Error('quota'), { response: { status: 429 } });
  assert.equal(await cachedRead('t:stale', 0, () => Promise.resolve('fresh')), 'fresh');
  assert.equal(await cachedRead('t:stale', 0, () => Promise.reject(rateLimited)), 'fresh');
  await assert.rejects(cachedRead('t:stale', 0, () => Promise.reject(new Error('boom'))));
  await assert.rejects(cachedRead('t:never-loaded', 0, () => Promise.reject(rateLimited)));
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
    assert.equal(activated.username, 'MetalGarden');
    assert.equal(activated.clientId, 'CL-001');
    assert.ok(activated.notificationToken);
    const activatedSession = readNotificationSession({ get: () => `Bearer ${activated.notificationToken}` });
    assert.equal(activatedSession.username, 'MetalGarden');
    assert.equal(activatedSession.clientId, 'CL-001');
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

test('client password reset accepts the latest admin-issued code and rotates it into a single-use recovery code', async () => {
  const bcrypt = require('bcryptjs');
  const values = {
    Client_ID: 'CL-RESET', Username: 'ResetClient', Password: await bcrypt.hash('OriginalPass1', 4),
    Recovery_Code_Hash: await bcrypt.hash('OLD1-CODE', 4), Activation_Code: ''
  };
  const row = { get: (key) => values[key] || '', set: (key, value) => { values[key] = value; }, save: async () => {} };
  const sheet = {
    headerValues: [], loadHeaderRow: async () => {}, setHeaderRow: async () => {}, getRows: async () => [row]
  };
  const titleDescriptor = Object.getOwnPropertyDescriptor(GoogleSpreadsheet.prototype, 'sheetsByTitle');
  const indexDescriptor = Object.getOwnPropertyDescriptor(GoogleSpreadsheet.prototype, 'sheetsByIndex');
  const oldLoadInfo = GoogleSpreadsheet.prototype.loadInfo;
  GoogleSpreadsheet.prototype.loadInfo = async () => {};
  Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByTitle', { configurable: true, get: () => ({ User_Credentials: sheet }) });
  Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByIndex', { configurable: true, get: () => [sheet] });
  const server = require('../api/server.js').app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const post = (path, body, token) => fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-nf-client-connection-ip': 'reset-flow-test', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  });
  try {
    const adminToken = signNotificationSession('ResetAdmin', 'CL-000', 'admin');
    const reset = async () => {
      const response = await post('/admin/clients/CL-RESET/reset-password', {}, adminToken);
      assert.equal(response.status, 200);
      return response.json();
    };
    const obsolete = await reset();
    const latest = await reset();
    const payload = { username: 'ResetClient', recoveryCode: latest.activationCode, newPassword: 'NewClientPass1' };
    assert.equal((await post('/account/recover', { ...payload, recoveryCode: 'OLD1-CODE' })).status, 400);
    assert.equal((await post('/account/recover', { ...payload, recoveryCode: obsolete.activationCode })).status, 400);
    assert.equal((await post('/account/recover', { ...payload, recoveryCode: [latest.activationCode] })).status, 400);
    assert.equal((await post('/account/recover', { ...payload, newPassword: { length: 10 } })).status, 400);

    const elements = Object.fromEntries([
      'portalUser', 'recoverUsername', 'recoverCode', 'recoverPassword', 'recoverPasswordConfirm',
      'recoverErrorMsg', 'recoverSubmit', 'recoverFormFields', 'recoverSuccessPanel', 'recoverRecoveryCode'
    ].map((id) => [id, { value: '', textContent: '', style: {}, disabled: false, addEventListener() {} }]));
    elements.recoverUsername.value = ' ResetClient ';
    elements.recoverCode.value = ` ${latest.activationCode.toLowerCase()} `;
    elements.recoverPassword.value = elements.recoverPasswordConfirm.value = 'NewClientPass1';
    const requests = [];
    const context = vm.createContext({
      document: { hidden: false, getElementById: (id) => elements[id] || null, querySelectorAll: () => [], addEventListener() {} },
      window: { location: { protocol: 'http:', hostname: 'localhost', port: '5500' }, addEventListener() {} },
      AbortController, setTimeout, clearTimeout,
      fetch: async (url, options) => {
        requests.push({ url, body: JSON.parse(options.body) });
        assert.equal(elements.recoverSubmit.disabled, true);
        return post('/account/recover', JSON.parse(options.body));
      }
    });
    vm.runInContext(fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8'), context);
    await context.submitRecoverAccount();
    assert.equal(requests[0].url, 'http://localhost:3001/api/account/recover');
    assert.deepEqual(requests[0].body, { ...payload, recoveryCode: latest.activationCode.toLowerCase() });
    assert.equal(elements.recoverSuccessPanel.style.display, 'block');
    assert.equal(elements.recoverSubmit.disabled, false);
    assert.equal(elements.recoverErrorMsg.textContent, '');
    assert.equal(elements.portalUser.value, 'ResetClient');
    assert.equal(elements.recoverPassword.value, '');
    assert.equal(elements.recoverCode.value, '');
    const recoveryCode = elements.recoverRecoveryCode.textContent;
    assert.match(recoveryCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.equal(values.Activation_Code, '');
    assert.equal(await bcrypt.compare('NewClientPass1', values.Password), true);
    assert.equal(await bcrypt.compare(recoveryCode, values.Recovery_Code_Hash), true);
    assert.equal((await post('/account/recover', payload)).status, 400, 'admin code cannot be reused');
    assert.equal((await post('/account/activate', { username: payload.username, activationCode: latest.activationCode, password: 'AnotherPass1' })).status, 400);
    const recovered = await post('/account/recover', { ...payload, recoveryCode: recoveryCode.toLowerCase(), newPassword: 'RecoveredPass1' });
    assert.equal(recovered.status, 200);
    assert.equal(await bcrypt.compare('RecoveredPass1', values.Password), true);
    assert.equal((await post('/account/recover', { ...payload, recoveryCode })).status, 400, 'old recovery code cannot be reused');
    const login = await post('/login', { username: 'ResetClient', password: 'RecoveredPass1' });
    assert.equal(login.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    GoogleSpreadsheet.prototype.loadInfo = oldLoadInfo;
    Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByTitle', titleDescriptor);
    Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByIndex', indexDescriptor);
  }
});

test('client reset reports validation, server, rate-limit and network failures without duplicate submissions', async () => {
  const elements = Object.fromEntries([
    'recoverUsername', 'recoverCode', 'recoverPassword', 'recoverPasswordConfirm', 'recoverErrorMsg',
    'recoverSubmit', 'recoverFormFields', 'recoverSuccessPanel', 'recoverRecoveryCode'
  ].map((id) => [id, { value: '', textContent: '', style: {}, disabled: false }]));
  elements.recoverUsername.value = 'Client';
  elements.recoverCode.value = 'CODE-1234';
  elements.recoverPassword.value = 'NewPassword1';
  elements.recoverPasswordConfirm.value = 'Mismatch1';
  let calls = 0;
  const context = vm.createContext({
    document: { hidden: false, getElementById: (id) => elements[id] || null, querySelectorAll: () => [], addEventListener() {} },
    window: { location: { hostname: 'localhost' }, addEventListener() {} },
    AbortController, setTimeout, clearTimeout, TypeError,
    fetch: async () => { calls += 1; throw new TypeError('Failed to fetch'); }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8'), context);
  await context.submitRecoverAccount();
  assert.equal(calls, 0);
  assert.equal(elements.recoverErrorMsg.textContent, 'Passwords do not match.');
  elements.recoverPasswordConfirm.value = 'NewPassword1';
  await context.submitRecoverAccount();
  assert.match(elements.recoverErrorMsg.textContent, /Check your connection/);
  assert.equal(elements.recoverSubmit.disabled, false);
  for (const [status, body, message] of [
    [400, { success: false, error: 'Invalid username or reset code.' }, /Invalid username or reset code/],
    [429, null, /Too many attempts/],
    [503, null, /unreadable response/],
    [200, { success: true }, /did not include a new recovery code/]
  ]) {
    context.fetch = async () => ({
      ok: status === 200, status, json: async () => { if (!body) throw new SyntaxError('Not JSON'); return body; }
    });
    await context.submitRecoverAccount();
    assert.match(elements.recoverErrorMsg.textContent, message);
    assert.notEqual(elements.recoverSuccessPanel.style.display, 'block');
    assert.equal(elements.recoverSubmit.disabled, false);
  }
  let finish;
  calls = 0;
  context.fetch = () => { calls += 1; return new Promise((resolve) => { finish = resolve; }); };
  const pending = context.submitRecoverAccount();
  await context.submitRecoverAccount();
  assert.equal(calls, 1);
  finish({ ok: true, status: 200, json: async () => ({ success: true, recoveryCode: 'NEW1-CODE' }) });
  await pending;
  assert.equal(elements.recoverSuccessPanel.style.display, 'block');
  assert.equal(elements.recoverErrorMsg.style.display, 'none');
  assert.equal(elements.recoverSubmit.disabled, false);
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

  const firstChat = fire(12000);
  assert.match(pending[0].url, /api\/chat\?clientId=CL-001/);
  respond(pending.shift(), 200, [{ sender: 'Staff', isStaff: true, message: 'New chat' }]);
  await firstChat;
  assert.match(msgBox.innerHTML, /New chat/);

  const firstInventory = fire(30000);
  respond(pending.shift(), 200, [{ id: 'sku-1', title: 'New item', qty: 5 }]);
  await firstInventory;
  assert.match(inventoryBody.innerHTML, /New item/);

  const unchangedChat = fire(12000);
  msgBox.scrollTop = 42;
  respond(pending.shift(), 200, [{ sender: 'Staff', isStaff: true, message: 'New chat' }]);
  await unchangedChat;
  assert.equal(msgBox.scrollTop, 42);

  const failedChat = fire(12000);
  respond(pending.shift(), 429);
  await failedChat;
  assert.match(msgBox.innerHTML, /New chat/);
  assert.ok([...timers.values()].some(({ delay }) => delay >= 30000));

  const oldInventory = fire(30000);
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

  vm.runInContext('lastInteractionAt = Date.now() - 6 * 60 * 1000;', context);
  const requestsBeforeIdle = pending.length;
  await fire(0);
  assert.equal(pending.length, requestsBeforeIdle, 'an idle tab must not poll Google Sheets');
  assert.equal(timers.size, 1);
  listeners.pointerdown();
  assert.ok([...timers.values()].some(({ delay }) => delay === 0), 'activity resumes syncing right away');

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
  const legacyCl002Rows = [
    ['UPC', 'Product Description', 'Quantity Ordered', 'Quantity Received', 'Quantity Shipped', 'Exp Date', 'Merchant', 'ASIN #', 'FBM / FBA', 'Transparency Code (Y/N)', 'Bundled? (Y/N)', 'Bundle Quantity', 'Notes'],
    ['00123', 'Copper Marker', 10, 8, 3, '2027-01', 'Shop', 'ASIN-1', 'FBA', 'Y', 'N', 1, 'Handle carefully']
  ];
  const legacyCl003Rows = [
    ['Product Description/Name', 'Quantity Ordered', 'Quantity Received', 'Quantity Shipped', 'Merchant', 'Carrier', 'Tracking #', 'Notes'],
    ['Charizard', 5, 4, 2, 'Store', 'UPS', 'TRACK-1', 'Sleeved']
  ];
  const cl002Sheet = {
    title: 'CL-002',
    sheetId: 2,
    get rowCount() { return Math.max(legacyCl002Rows.length, 25); },
    get columnCount() { return 26; },
    loadCells: async () => {},
    getCell: (row, column) => ({
      get value() { return legacyCl002Rows[row]?.[column] ?? ''; },
      set value(value) {
        if (!legacyCl002Rows[row]) legacyCl002Rows[row] = [];
        legacyCl002Rows[row][column] = value;
      }
    }),
    duplicate: async ({ title }) => {
      const archive = { title, rows: legacyCl002Rows.map((row) => [...row]) };
      sheets[title] = archive;
      return archive;
    },
    clear: async () => { legacyCl002Rows.splice(1); },
    setHeaderRow: async (headers) => { legacyCl002Rows[0] = [...headers]; },
    addRows: async (rows) => { legacyCl002Rows.push(...rows.map((row) => [...row])); },
    resize: async () => {},
    saveUpdatedCells: async () => {}
  };
  const cl003Sheet = {
    title: 'CL-003',
    sheetId: 3,
    get rowCount() { return Math.max(legacyCl003Rows.length, 25); },
    get columnCount() { return 26; },
    loadCells: async () => {},
    getCell: (row, column) => ({
      get value() { return legacyCl003Rows[row]?.[column] ?? ''; },
      set value(value) {
        if (!legacyCl003Rows[row]) legacyCl003Rows[row] = [];
        legacyCl003Rows[row][column] = value;
      }
    }),
    duplicate: async ({ title }) => {
      const archive = { title, rows: legacyCl003Rows.map((row) => [...row]) };
      sheets[title] = archive;
      return archive;
    },
    clear: async () => { legacyCl003Rows.splice(1); },
    setHeaderRow: async (headers) => { legacyCl003Rows[0] = [...headers]; },
    addRows: async (rows) => { legacyCl003Rows.push(...rows.map((row) => [...row])); },
    resize: async () => {},
    saveUpdatedCells: async () => {}
  };
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
    },
    'CL-002': cl002Sheet,
    'CL-003': cl003Sheet
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
    const migratedFields = JSON.parse(credentialRows[0].values.Fields_JSON);
    assert.deepEqual(migratedFields.map((field) => field.key), ['quantityReceived', 'quantityShipped', 'bundled']);
    assert.ok(Object.values(sheets).some((sheet) => sheet?.title?.startsWith('CL-002_Original_')));
    assert.ok(legacyCl002Rows[0].includes('Archived: Exp Date'));
    assert.equal(legacyCl002Rows[1][legacyCl002Rows[0].indexOf('Archived: Exp Date')], '2027-01');
    assert.ok(!cl002.profile.dashboardColumns.includes('QTY'));
    assert.equal(cl002.profile.dashboardColumns.at(-1), 'STATUS');
    assert.equal(cl002.profile.legacy, undefined);

    const convertedInventory = await (await call('GET', '/inventory?clientId=CL-002', null, adminToken)).json();
    assert.equal(convertedInventory[0].title, 'Copper Marker');
    assert.equal(convertedInventory[0].quantityReceived, '8');
    const shipmentUpdate = await call('PUT', '/inventory/shipment', {
      clientId: 'CL-002', itemId: 'CL-002-1', title: 'Copper Marker', received: 9, shipped: 4
    }, adminToken);
    assert.equal(shipmentUpdate.status, 200);
    assert.equal(legacyCl002Rows[1][legacyCl002Rows[0].indexOf('Quantity Received')], 9);
    assert.equal(legacyCl002Rows[1][legacyCl002Rows[0].indexOf('Quantity Shipped')], 4);

    assert.equal((await call('PUT', '/admin/clients/CL-002', { email: 'not-an-email' }, adminToken)).status, 400);
    const withEmail = await (await call('PUT', '/admin/clients/CL-002', { email: 'ecom@example.com' }, adminToken)).json();
    assert.equal(credentialRows[0].values.Email, 'ecom@example.com');
    assert.equal(withEmail.profile.hasEmail, true);

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

    const editItem = (body, token) => fetch(`http://127.0.0.1:${server.address().port}/api/inventory/item`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ clientId: 'CL-004', itemId: 'CL-004-1', title: 'Widget', ...body })
    });
    const client = signNotificationSession('Acme', 'CL-004', 'client');
    assert.equal((await editItem({ values: { title: 'Widget Pro' } }, signNotificationSession('Other', 'CL-005', 'client'))).status, 400);
    assert.equal((await editItem({ values: { quantityReceived: 99 } }, client)).status, 403);
    assert.equal((await editItem({ values: { title: '' } }, client)).status, 400);
    assert.equal((await editItem({ values: { title: 'Widget Pro' }, title: 'Someone else' }, client)).status, 409);
    assert.equal((await editItem({ values: { sku: '', title: 'Widget Pro' } }, client)).status, 200);
    assert.deepEqual([grid[1][0], grid[1][1], grid[1][2]], ['', 'Widget Pro', 10]);
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

test('a saved session survives a page refresh, and expired or rejected sessions return to sign-in', async () => {
  const makeElement = () => ({
    style: {}, dataset: {}, hidden: false, innerHTML: '', textContent: '', value: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, getAttribute: () => null, addEventListener() {},
    querySelector: () => null, querySelectorAll: () => [], focus() {}, replaceChildren() {}, append() {}
  });

  const token = (expires) => `${Buffer.from(JSON.stringify({ username: 'EcomElite', clientId: 'CL-002', role: 'client', expires })).toString('base64url')}.sig`;
  const boot = (savedSession, notificationStatus = 200) => {
    const elements = {};
    const storage = new Map(savedSession ? [['eclPortalSession', JSON.stringify(savedSession)]] : []);
    const context = vm.createContext({
      document: {
        hidden: false,
        getElementById: (id) => { elements[id] = elements[id] || makeElement(); return elements[id]; },
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener() {}
      },
      window: { location: { hostname: 'localhost' }, addEventListener() {} },
      localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
      atob: (value) => Buffer.from(value, 'base64').toString('binary'),
      AbortController,
      URL,
      console: { error() {}, log() {} },
      setTimeout: () => 0,
      clearTimeout() {},
      fetch: async (url) => {
        const status = url.includes('/notifications') ? notificationStatus : url.includes('/billing') ? 403 : 200;
        const body = url.includes('/notifications') ? { chat: 0, inventory: 0, total: 0, items: [] } : url.includes('/client-profile') ? { clientId: 'CL-002', fields: [] } : [];
        return { ok: status === 200, status, json: async () => body };
      }
    });
    vm.runInContext(fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8'), context);
    return { context, elements, storage };
  };
  const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
  const session = { success: true, clientId: 'CL-002', clientName: 'Ecom Elite 2.0', role: 'client' };

  const restored = boot({ session: { ...session, notificationToken: token(Date.now() + 3600000) }, page: 'page-chat' });
  assert.equal(restored.elements.portalLoginWindow.style.display, 'none');
  await settle();
  assert.equal(vm.runInContext('state.auth', restored.context), true);
  assert.equal(vm.runInContext('state.activeClientId', restored.context), 'CL-002');
  assert.ok(restored.storage.has('eclPortalSession'));
  vm.runInContext('executePortalLogout()', restored.context);
  assert.equal(restored.storage.has('eclPortalSession'), false);

  const expired = boot({ session: { ...session, notificationToken: token(Date.now() - 1000) } });
  await settle();
  assert.equal(vm.runInContext('state.auth', expired.context), false);
  assert.equal(expired.elements.portalLoginWindow.style.display, 'flex');
  assert.equal(expired.storage.has('eclPortalSession'), false);

  const rejected = boot({ session: { ...session, notificationToken: token(Date.now() + 3600000) } }, 401);
  await settle();
  assert.equal(vm.runInContext('state.auth', rejected.context), false);
  assert.equal(rejected.elements.portalLoginWindow.style.display, 'flex');
  assert.match(rejected.elements.loginErrorMsg.textContent, /session expired/);
  assert.equal(rejected.storage.has('eclPortalSession'), false);
});

test('theme preference is restored and the mode toggle persists changes', () => {
  const themeButton = {
    dataset: { action: 'toggle-theme' },
    textContent: '',
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; }
  };
  const listeners = [];
  const preferences = new Map([['eclPortalTheme', 'dark']]);
  const root = { dataset: { theme: 'light' } };
  const context = vm.createContext({
    document: {
      documentElement: root,
      getElementById: (id) => id === 'themeToggle' ? themeButton : null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: (type, listener) => listeners.push([type, listener])
    },
    window: { location: { hostname: 'localhost' }, addEventListener() {} },
    localStorage: {
      getItem: (key) => preferences.get(key) || null,
      setItem: (key, value) => preferences.set(key, value)
    },
    setTimeout: () => 0,
    clearTimeout() {},
    console
  });

  vm.runInContext(fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8'), context);
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(themeButton.textContent, '☀ Light mode');
  assert.equal(themeButton.attributes['aria-pressed'], 'true');

  const toggleHandler = listeners.find(([type, listener]) => type === 'click' && String(listener).includes("action === 'toggle-theme'"));
  assert.ok(toggleHandler, 'the theme control is wired to the delegated click handler');
  toggleHandler[1]({ target: { closest: () => themeButton } });
  assert.equal(root.dataset.theme, 'light');
  assert.equal(preferences.get('eclPortalTheme'), 'light');
  assert.equal(themeButton.textContent, '☾ Dark mode');
  assert.equal(themeButton.attributes['aria-pressed'], 'false');
});

test('newly activated accounts continue into their own client session after saving the recovery code', async () => {
  const makeElement = () => ({
    style: {}, dataset: {}, hidden: false, innerHTML: '', textContent: '', value: '',
    attributes: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute() {}, getAttribute: () => null, addEventListener() {},
    querySelector: () => null, querySelectorAll: () => [], focus() {}, replaceChildren() {}, append() {}
  });
  const elements = Object.fromEntries([
    'portalUser', 'portalPass', 'portalLoginWindow', 'activateAccountWindow', 'recoverAccountWindow',
    'activateUsername', 'activateCode', 'activatePassword', 'activatePasswordConfirm',
    'activateErrorMsg', 'activateFormFields', 'activateSuccessPanel', 'activateRecoveryCode', 'activateContinue'
  ].map((id) => [id, makeElement()]));
  elements.activateUsername.value = 'CJAClient';
  elements.activateCode.value = 'SETU-PCOD';
  elements.activatePassword.value = 'ClientPass123';
  elements.activatePasswordConfirm.value = 'ClientPass123';
  const context = vm.createContext({
    document: {
      documentElement: { dataset: { theme: 'light' } },
      hidden: false,
      getElementById: (id) => elements[id] || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {}
    },
    window: { location: { hostname: 'localhost' }, addEventListener() {} },
    setTimeout: () => 0,
    clearTimeout() {},
    console,
    fetch: async () => ({
      ok: true,
      json: async () => ({
        success: true,
        username: 'CJAClient',
        clientId: 'CL-003',
        clientName: 'CJA Ventures',
        role: 'client',
        notificationToken: 'signed-client-session',
        recoveryCode: 'SAFE-CODE'
      })
    })
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8'), context);
  let startedSession = null;
  context.startSession = async (session) => { startedSession = session; };

  await context.submitActivateAccount();
  assert.equal(elements.activateSuccessPanel.style.display, 'block');
  assert.equal(elements.activateRecoveryCode.textContent, 'SAFE-CODE');
  assert.equal(elements.activateContinue.textContent, 'Continue to Your Inventory');
  await context.finishActivateAccount();

  assert.equal(startedSession.clientId, 'CL-003');
  assert.equal(startedSession.notificationToken, 'signed-client-session');
  assert.equal(elements.activateAccountWindow.style.display, 'none');
});

test('chat messages appear instantly, show failures with retry, and never block the input', async () => {
  const msgBox = { innerHTML: '', scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
  const msgInput = { value: '', addEventListener() {} };
  const requests = [];
  const context = vm.createContext({
    document: {
      hidden: false,
      getElementById: (id) => ({ msgBox, msgInput }[id] || null),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {}
    },
    window: { location: { hostname: 'localhost' }, addEventListener() {} },
    AbortController,
    URL,
    setTimeout: () => 0,
    clearTimeout() {},
    fetch: (url, options = {}) => new Promise((resolve) => requests.push({ url, options, resolve }))
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8'), context);
  vm.runInContext("state.auth = true; state.session = { clientId: 'CL-002', clientName: 'Ecom', role: 'client', notificationToken: 't' }; state.activeClientId = 'CL-002'; state.messages = [];", context);
  const respond = (status, body) => requests.shift().resolve({ ok: status === 200, status, json: async () => body });
  const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

  msgInput.value = 'Hello there';
  vm.runInContext('submitMessage()', context);
  assert.equal(msgInput.value, '', 'the box clears before the server answers');
  assert.match(msgBox.innerHTML, /Hello there/);
  assert.match(msgBox.innerHTML, /Sending/);
  assert.equal(requests[0].options.method, 'POST');

  respond(500, { success: false, error: 'Unable to send message.' });
  await settle();
  assert.match(msgBox.innerHTML, /Not sent/);
  const localId = vm.runInContext('state.pendingMessages[0].localId', context);

  vm.runInContext(`retryPendingMessage('${localId}')`, context);
  assert.match(msgBox.innerHTML, /Sending/);
  respond(200, { success: true });
  await settle();
  assert.match(requests[0].url, /api\/chat\?clientId=CL-002/);
  respond(200, [{ sender: 'Ecom', message: 'Hello there', clientId: 'CL-002', isStaff: false }]);
  await settle();
  assert.equal(vm.runInContext('state.pendingMessages.length', context), 0);
  assert.equal((msgBox.innerHTML.match(/Hello there/g) || []).length, 1);
  assert.doesNotMatch(msgBox.innerHTML, /Sending|Not sent/);
});

test('old chat messages are archived to Chat_Archive and removed from Chat_log in one block', async () => {
  const { archiveOldChatMessages, invalidateReadCache: clearCache } = require('../api/server.js');
  clearCache('');
  const now = new Date('2026-10-01T12:00:00Z');
  const daysAgo = (days) => new Date(now.getTime() - days * 86400000).toISOString();
  const makeRow = (values, rowNumber) => ({ rowNumber, get: (key) => values[key] ?? '' });
  const chatRows = [
    { Timestamp: daysAgo(60), Sender: 'A', Message: 'old 1', ClientID: 'CL-002', IsStaff: '0' },
    { Timestamp: daysAgo(45), Sender: 'B', Message: 'old 2', ClientID: 'CL-002', IsStaff: '1' },
    { Timestamp: daysAgo(31), Sender: 'A', Message: 'old 3', ClientID: 'CL-003', IsStaff: '0' },
    { Timestamp: daysAgo(5), Sender: 'A', Message: 'recent', ClientID: 'CL-002', IsStaff: '0' },
    { Timestamp: daysAgo(40), Sender: 'C', Message: 'out of order', ClientID: 'CL-002', IsStaff: '0' }
  ].map((values, index) => makeRow(values, index + 2));
  const deletes = [];
  const archived = [];
  const sheets = {
    Chat_log: { sheetId: 7, getRows: async () => chatRows, _makeSingleUpdateRequest: async (type, body) => deletes.push([type, body]) },
    Chat_Archive: { headerValues: [], loadHeaderRow: async () => {}, setHeaderRow: async () => {}, addRows: async (rows) => archived.push(...rows) }
  };
  const titleDescriptor = Object.getOwnPropertyDescriptor(GoogleSpreadsheet.prototype, 'sheetsByTitle');
  const indexDescriptor = Object.getOwnPropertyDescriptor(GoogleSpreadsheet.prototype, 'sheetsByIndex');
  const oldLoadInfo = GoogleSpreadsheet.prototype.loadInfo;
  GoogleSpreadsheet.prototype.loadInfo = async () => {};
  Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByTitle', { configurable: true, get: () => sheets });
  Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByIndex', { configurable: true, get: () => Object.values(sheets) });
  try {
    const dryRun = await archiveOldChatMessages({ now });
    assert.deepEqual([dryRun.archived, dryRun.kept], [3, 2]);
    assert.equal(archived.length + deletes.length, 0);

    const result = await archiveOldChatMessages({ now, apply: true });
    assert.equal(result.archived, 3);
    assert.deepEqual(archived.map((row) => row[2]), ['old 1', 'old 2', 'old 3']);
    assert.deepEqual(deletes, [['deleteDimension', { range: { sheetId: 7, dimension: 'ROWS', startIndex: 1, endIndex: 4 } }]]);
  } finally {
    GoogleSpreadsheet.prototype.loadInfo = oldLoadInfo;
    Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByTitle', titleDescriptor);
    Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByIndex', indexDescriptor);
  }
});

test('activity history is authenticated, client-scoped, newest first, and includes own and previously read events', async () => {
  const values = [
    ...Array.from({ length: 12 }, (_, index) => ({
      Timestamp: new Date(Date.UTC(2026, 8, index + 1)).toISOString(),
      ClientID: 'CL-002', Description: `Updated item ${index}`, ActorUsername: 'EcomElite'
    })),
    { Timestamp: '2026-10-01T12:00:00Z', ClientID: 'CL-003', Description: 'Other client', ActorUsername: 'ADMIN' },
    { Timestamp: '', ClientID: 'CL-002', Description: 'Legacy event', ActorUsername: '' }
  ];
  let fail = false;
  const sheet = { getRows: async () => {
    if (fail) throw new Error('Sheet unavailable');
    return values.map((value) => ({ get: (key) => value[key] || '' }));
  } };
  const titleDescriptor = Object.getOwnPropertyDescriptor(GoogleSpreadsheet.prototype, 'sheetsByTitle');
  const indexDescriptor = Object.getOwnPropertyDescriptor(GoogleSpreadsheet.prototype, 'sheetsByIndex');
  const oldLoadInfo = GoogleSpreadsheet.prototype.loadInfo;
  GoogleSpreadsheet.prototype.loadInfo = async () => {};
  Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByTitle', { configurable: true, get: () => ({ Inventory_Events: sheet }) });
  Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByIndex', { configurable: true, get: () => [sheet] });
  invalidateReadCache('rows:Inventory_Events');
  const server = require('../api/server.js').app.listen(0);
  const url = `http://127.0.0.1:${server.address().port}/api/activity`;
  const get = (clientId, token) => fetch(`${url}?clientId=${clientId}`, { headers: { Authorization: `Bearer ${token}` } });
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await get('CL-002', 'invalid')).status, 401);
    const clientToken = signNotificationSession('EcomElite', 'CL-002', 'client');
    const response = await get('CL-003', clientToken);
    assert.equal(response.status, 200);
    const history = await response.json();
    assert.equal(history.length, 13, 'history is not truncated to the unread-notification limit');
    assert.ok(history.every((entry) => entry.clientId === 'CL-002'));
    assert.equal(history[0].description, 'Updated item 11');
    assert.equal(history.at(-1).description, 'Legacy event');
    assert.deepEqual(Object.keys(history[0]), ['timestamp', 'clientId', 'action', 'actorUsername', 'description']);
    assert.equal(history[0].actorUsername, 'EcomElite', 'own events remain visible');
    const adminToken = signNotificationSession('ADMIN', 'CL-000', 'admin');
    assert.equal((await (await get('CL-003', adminToken)).json()).length, 1);
    assert.equal((await (await get('CL-000', adminToken)).json()).length, 14);
    fail = true;
    invalidateReadCache('rows:Inventory_Events');
    assert.equal((await get('CL-002', clientToken)).status, 500);
    fail = false;
    values.length = 0;
    invalidateReadCache('rows:Inventory_Events');
    assert.deepEqual(await (await get('CL-002', clientToken)).json(), []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    GoogleSpreadsheet.prototype.loadInfo = oldLoadInfo;
    Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByTitle', titleDescriptor);
    Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByIndex', indexDescriptor);
    invalidateReadCache('rows:Inventory_Events');
  }
});

test('activity table uses recorded data, escapes content, and searches all audit columns independently of inventory filters', async () => {
  const host = { innerHTML: '', setAttribute(name, value) { this[name] = value; } };
  const search = { value: '' };
  const context = vm.createContext({
    document: { hidden: false, getElementById: (id) => ({ logTableWrap: host, logSearch: search })[id] || null, querySelectorAll: () => [], addEventListener() {} },
    window: { location: { hostname: 'localhost' }, addEventListener() {} },
    AbortController, setTimeout, clearTimeout,
    console: { error() {} }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8'), context);
  const entries = [
    { timestamp: '2026-09-12T12:30:00Z', clientId: 'CL-002', action: 'Inventory update', actorUsername: '<staff>', description: 'Added <script>alert(1)</script>\nLong details' },
    { timestamp: '', clientId: 'CL-002', action: 'Inventory update', actorUsername: '', description: 'Legacy adjustment' }
  ];
  context.__entries = entries;
  vm.runInContext("state.auth = true; state.activeClientId = 'CL-002'; state.session = { notificationToken: 'signed' }; state.activity = { clientId: 'CL-002', entries: __entries, loading: false, error: '' }; state.query = 'unrelated dashboard filter'; renderLogs();", context);
  assert.match(host.innerHTML, /<table class="activity-table">/);
  assert.equal((host.innerHTML.match(/scope="col"/g) || []).length, 4);
  assert.match(host.innerHTML, /&lt;script&gt;/);
  assert.doesNotMatch(host.innerHTML, /<script>/);
  assert.match(host.innerHTML, /&lt;staff&gt;/);
  assert.match(host.innerHTML, /Not recorded/);
  assert.match(host.innerHTML, /Long details/);
  const recordedTime = vm.runInContext("formatActivityTimestamp('2026-09-12T12:30:00Z')", context);
  assert.ok(host.innerHTML.includes(recordedTime));
  assert.equal(vm.runInContext("formatActivityTimestamp('bad-date')", context), 'Not recorded');
  for (const query of ['staff', '2026-09-12', 'inventory update', 'long details', 'cl-002', recordedTime.toLowerCase()]) {
    search.value = query;
    context.renderLogs();
    assert.match(host.innerHTML, /Long details/, `search matches ${query}`);
  }
  search.value = 'missing';
  context.renderLogs();
  assert.match(host.innerHTML, /No matching log entries/);
  search.value = '';
  context.fetch = async () => ({ ok: false, status: 500 });
  assert.equal(await context.loadActivity('CL-002'), 500);
  assert.match(host.innerHTML, /role="alert"/);
  assert.match(host.innerHTML, /Retry/);
  assert.match(host.innerHTML, /Showing previously loaded activity/);
  assert.equal(host['aria-busy'], 'false');
  context.fetch = async () => ({ ok: true, status: 200, json: async () => [] });
  assert.equal(await context.loadActivity('CL-002'), 200);
  assert.match(host.innerHTML, /No activity to display/);
  assert.doesNotMatch(host.innerHTML, /role="alert"/);

  let finish;
  context.fetch = () => new Promise((resolve) => { finish = resolve; });
  const pending = context.loadActivity('CL-002');
  assert.match(host.innerHTML, /Loading activity history|<table/);
  assert.equal(host['aria-busy'], 'true');
  vm.runInContext("state.activeClientId = 'CL-003'; state.activity = { clientId: null, entries: null, loading: false, error: '' }; renderLogs();", context);
  finish({ ok: true, status: 200, json: async () => entries });
  await pending;
  assert.doesNotMatch(host.innerHTML, /Long details/);
  assert.equal(vm.runInContext('state.activity.entries', context), null, 'late responses cannot leak previous client activity');
});

test('inventory rendering avoids unchanged DOM writes and coalesces search events without stale results', () => {
  const elements = {};
  for (const id of ['inventoryBody', 'inventoryHeaderRow', 'filterGroups', 'activeFilters']) {
    let markup = '';
    elements[id] = {
      writes: 0,
      get innerHTML() { return markup; },
      set innerHTML(value) { markup = value; this.writes += 1; }
    };
  }
  elements.tableSearch = { value: '' };
  const listeners = {};
  const frames = [];
  const context = vm.createContext({
    document: { hidden: false, getElementById: (id) => elements[id] || null, querySelectorAll: () => [], addEventListener: (event, listener) => { listeners[event] = listener; } },
    window: { location: { hostname: 'localhost' }, addEventListener() {} },
    requestAnimationFrame: (callback) => { frames.push(callback); return frames.length; },
    AbortController, setTimeout, clearTimeout
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8'), context);
  vm.runInContext("state.activeClientId = 'CL-001'; state.items = [{ id: 'a', title: 'Copper marker', sku: 'C', qty: 10 }, { id: 'b', title: 'Steel marker', sku: 'S', qty: 0 }]; renderTable();", context);
  const writes = Object.fromEntries(Object.entries(elements).map(([id, element]) => [id, element.writes]));
  context.renderTable();
  for (const id of ['inventoryBody', 'inventoryHeaderRow', 'filterGroups', 'activeFilters']) {
    assert.equal(elements[id].writes, writes[id], `${id} is untouched when markup is unchanged`);
  }
  for (const value of ['C', 'Co', 'Copper']) {
    elements.tableSearch.value = value;
    listeners.input({ target: elements.tableSearch });
  }
  assert.equal(frames.length, 1, 'three input events schedule only one table render');
  assert.equal(elements.inventoryBody.writes, writes.inventoryBody);
  frames.shift()();
  assert.match(elements.inventoryBody.innerHTML, /Copper marker/);
  assert.doesNotMatch(elements.inventoryBody.innerHTML, /Steel marker/);
  assert.equal(elements.inventoryBody.writes, writes.inventoryBody + 1);
  assert.equal(elements.filterGroups.writes, writes.filterGroups, 'search keeps filter button nodes intact');
  assert.equal(elements.inventoryHeaderRow.writes, writes.inventoryHeaderRow);
  vm.runInContext("state.items[0].qty = 0; renderTable();", context);
  assert.match(elements.inventoryBody.innerHTML, /Out of Stock/);
  assert.equal(elements.inventoryBody.writes, writes.inventoryBody + 2, 'in-place quantity updates remain visible');
  vm.runInContext("state.clientProfile = { clientId: 'CL-001', dashboardColumns: ['CUSTOM TITLE', 'STATUS'], hideQtyColumn: true, hideQuickEdit: true }; renderTable();", context);
  assert.match(elements.inventoryHeaderRow.innerHTML, /CUSTOM TITLE/);
  assert.doesNotMatch(elements.inventoryBody.innerHTML, /qty-cell|data-action="adjust"/);
  vm.runInContext("state.query = ''; state.filters.stock = ['out']; renderTable();", context);
  assert.match(elements.activeFilters.innerHTML, /Out of Stock/);
  vm.runInContext("state.activeClientId = 'CL-003'; state.items = []; renderTable();", context);
  assert.doesNotMatch(elements.inventoryBody.innerHTML, /Copper marker/);
  assert.match(elements.inventoryBody.innerHTML, /No items match/);
});

test('inventory polling normalizes changed rows once, reuses unchanged rows, and honors forced refreshes', async () => {
  let payload = [{ id: 'a', title: 'Original', qty: 5 }, { id: 'b', title: 'Other', qty: 0 }];
  const context = vm.createContext({
    document: { hidden: false, getElementById: () => null, querySelectorAll: () => [], addEventListener() {} },
    window: { location: { hostname: 'localhost' }, addEventListener() {} },
    AbortController, setTimeout, clearTimeout,
    fetch: async () => ({ ok: true, status: 200, json: async () => payload })
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8'), context);
  vm.runInContext("state.auth = true; state.session = {}; state.activeClientId = 'CL-001'; let normalizedCount = 0; const originalNormalize = normalizeInventoryItem; normalizeInventoryItem = (...args) => { normalizedCount += 1; return originalNormalize(...args); };", context);
  await context.fetchInventory('CL-001');
  assert.equal(vm.runInContext('normalizedCount', context), 2, 'changed inventory is normalized once, not once per consumer');
  assert.equal(vm.runInContext("state.items === clientViewCache.get('CL-001').items", context), true);
  const first = vm.runInContext('state.items', context);
  await context.fetchInventory('CL-001');
  assert.equal(vm.runInContext('normalizedCount', context), 2, 'unchanged polls perform no normalization');
  assert.equal(vm.runInContext('state.items', context), first);
  vm.runInContext("state.items[0].qty = 99; inventorySignature = null;", context);
  await context.fetchInventory('CL-001');
  assert.equal(vm.runInContext('state.items[0].qty', context), 5, 'forced refresh restores authoritative server data');
  assert.equal(vm.runInContext('normalizedCount', context), 4);
  payload = [{ id: 'a', title: 'Changed', qty: 2 }];
  await context.fetchInventory('CL-001');
  assert.equal(vm.runInContext('state.items[0].title', context), 'Changed');
  assert.equal(vm.runInContext('normalizedCount', context), 5);
});

test('inventory summary evaluates each row once for stock and shipment modes', () => {
  const elements = Object.fromEntries(['s-total', 's-low', 's-partial', 's-out', 's-partial-card'].map((id) => [id, { textContent: '', style: {} }]));
  const context = vm.createContext({
    document: { hidden: false, getElementById: (id) => elements[id] || null, querySelectorAll: () => [], addEventListener() {} },
    window: { location: { hostname: 'localhost' }, addEventListener() {} },
    AbortController, setTimeout, clearTimeout
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8'), context);
  vm.runInContext("let statusCalls = 0; const originalStatus = getItemStatus; getItemStatus = (item) => { statusCalls += 1; return originalStatus(item); }; state.activeClientId = 'CL-001'; state.items = [{ qty: 0 }, { qty: 2, reorderLevel: 5 }, { qty: 10 }]; updateSummary();", context);
  assert.equal(vm.runInContext('statusCalls', context), 3);
  assert.deepEqual(['s-total', 's-low', 's-out'].map((id) => elements[id].textContent), [3, 1, 1]);
  vm.runInContext("statusCalls = 0; state.activeClientId = 'CL-002'; state.items = [{ quantityReceived: 10, quantityShipped: 10 }, { quantityReceived: 10, quantityShipped: 5 }, { quantityReceived: 10, quantityShipped: 0 }, { quantityReceived: 0, quantityShipped: 0 }]; updateSummary();", context);
  assert.equal(vm.runInContext('statusCalls', context), 4);
  assert.deepEqual(['s-total', 's-low', 's-partial', 's-out'].map((id) => elements[id].textContent), [4, 1, 1, 1]);
  assert.equal(elements['s-partial-card'].style.display, 'block');
});

test('portal navigation identifies the current page and client responses expand collapsed sections', () => {
  const makeTab = () => {
    const attrs = {};
    const classes = new Set();
    return {
      attrs, classes,
      classList: { add: (value) => classes.add(value), remove: (value) => classes.delete(value) },
      setAttribute: (name, value) => { attrs[name] = value; },
      removeAttribute: (name) => { delete attrs[name]; }
    };
  };
  const tabs = Array.from({ length: 7 }, makeTab);
  const outer = { open: false, parentElement: null };
  const inner = { open: false, parentElement: { closest: () => outer } };
  const messages = Object.fromEntries(['addClientMsg', 'editClientMsg', 'resetPasswordMsg'].map((id) => [
    id, { style: {}, textContent: '', closest: () => inner }
  ]));
  const context = vm.createContext({
    document: { hidden: false, getElementById: (id) => messages[id] || null, querySelectorAll: (selector) => selector === '.tab' ? tabs : [], addEventListener() {} },
    window: { location: { hostname: 'localhost' }, addEventListener() {} },
    AbortController, setTimeout, clearTimeout
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8'), context);
  context.setPage('page-clients');
  assert.equal(tabs[6].attrs['aria-current'], 'page');
  context.setPage('page-billing');
  assert.equal(tabs[5].attrs['aria-current'], 'page');
  assert.equal(tabs[6].attrs['aria-current'], undefined);
  assert.equal(tabs.filter((tab) => tab.classes.has('active')).length, 1);
  for (const [functionName, id] of [
    ['showAddClientMessage', 'addClientMsg'], ['showEditClientMessage', 'editClientMsg'], ['showResetPasswordMessage', 'resetPasswordMsg']
  ]) {
    inner.open = outer.open = false;
    context[functionName]('Operation complete', 'success');
    assert.equal(inner.open, true);
    assert.equal(outer.open, true);
    assert.equal(messages[id].textContent, 'Operation complete');
    assert.equal(messages[id].style.display, 'block');
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

test('API requests stay same-origin when Express serves the portal on any local port', () => {
  const urlsFor = (location) => {
    const context = vm.createContext({
      document: { hidden: false, getElementById: () => null, querySelectorAll: () => [], addEventListener() {} },
      window: { location, addEventListener() {} },
      AbortController, setTimeout, clearTimeout, fetch: async () => ({ ok: true, json: async () => ({}) })
    });
    vm.runInContext(fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8'), context);
    return JSON.parse(vm.runInContext('JSON.stringify([LOGIN_URL, API_URL])', context));
  };
  assert.deepEqual(urlsFor({ protocol: 'http:', hostname: 'localhost', port: '3015' }), ['/api/login', '/api/inventory']);
  assert.deepEqual(urlsFor({ protocol: 'http:', hostname: 'localhost', port: '3001' }), ['/api/login', '/api/inventory']);
  assert.deepEqual(urlsFor({ protocol: 'https:', hostname: 'portal.example.com', port: '' }), ['/api/login', '/api/inventory']);
  assert.deepEqual(urlsFor({ protocol: 'http:', hostname: '127.0.0.1', port: '5500' }), ['http://localhost:3001/api/login', 'http://localhost:3001/api/inventory']);
  assert.deepEqual(urlsFor({ protocol: 'file:', hostname: '', port: '' }), ['http://localhost:3001/api/login', 'http://localhost:3001/api/inventory']);
});

test('dashboard welcome banner greets the signed-in client and resets on sign-out', () => {
  const ids = ['welcomeBanner', 'welcomeGreeting', 'welcomeTitle', 'welcomeSubtitle', 'welcomeDate', 'activeClientHeader'];
  const elements = Object.fromEntries(ids.map((id) => {
    const classes = new Set();
    return [id, { textContent: '', style: {}, addEventListener() {}, classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) } }];
  }));
  const context = vm.createContext({
    document: { hidden: false, getElementById: (id) => elements[id] || null, querySelectorAll: () => [], addEventListener() {} },
    window: { location: { protocol: 'http:', hostname: 'localhost', port: '3001' }, addEventListener() {} },
    AbortController, setTimeout, clearTimeout, fetch: async () => ({ ok: true, json: async () => ({}) })
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8'), context);

  vm.runInContext("state.session = { clientId: 'CL-004', clientName: 'Ecom Elite 2.0', role: 'client' }; state.isAdmin = false; state.activeClientId = 'CL-004'; renderClientHeader();", context);
  assert.equal(elements.welcomeTitle.textContent, 'Welcome back, Ecom Elite 2.0');
  assert.match(elements.welcomeGreeting.textContent, /^Good (morning|afternoon|evening)$/);
  assert.notEqual(elements.welcomeDate.textContent, '');
  assert.equal(elements.welcomeBanner.classList.contains('is-personalized'), true);

  vm.runInContext("state.session = { clientId: 'CL-000', clientName: 'Admin', role: 'admin' }; state.isAdmin = true; state.activeClientId = 'CL-004'; state.roster = [{ clientId: 'CL-004', clientName: 'Ecom Elite 2.0' }]; renderClientHeader();", context);
  assert.equal(elements.welcomeTitle.textContent, 'Welcome back, Admin');
  assert.match(elements.welcomeSubtitle.textContent, /viewing Ecom Elite 2\.0's inventory/);

  vm.runInContext('state.session = null; renderWelcomeBanner();', context);
  assert.equal(elements.welcomeTitle.textContent, 'Inventory overview');
  assert.equal(elements.welcomeDate.textContent, '');
  assert.equal(elements.welcomeBanner.classList.contains('is-personalized'), false);
  assert.equal(vm.runInContext('getTimeOfDayGreeting(new Date(2026, 0, 1, 9))', context), 'Good morning');
  assert.equal(vm.runInContext('getTimeOfDayGreeting(new Date(2026, 0, 1, 14))', context), 'Good afternoon');
  assert.equal(vm.runInContext('getTimeOfDayGreeting(new Date(2026, 0, 1, 20))', context), 'Good evening');
});

test('first-time tour launches once for clients, navigates with back/next, and saves the seen flag on skip or finish', () => {
  const makeEl = (extra = {}) => {
    const classes = new Set();
    return {
      textContent: '', innerHTML: '', hidden: false, style: {}, isConnected: true,
      addEventListener() {}, focus() { focused = this; }, getClientRects: () => [1],
      getBoundingClientRect: () => ({ top: 200, bottom: 260, left: 40, right: 400, width: 360, height: 60 }),
      scrollIntoView() {},
      classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
      ...extra
    };
  };
  let focused = null;
  const ids = ['tourOverlay', 'tourSpotlight', 'tourCard', 'tourStep', 'tourTitle', 'tourBody', 'tourProgress', 'tourSkip', 'tourBack', 'tourNext', 'tourFinish', 'replayTourBtn', 'toast'];
  const elements = Object.fromEntries(ids.map((id) => [id, makeEl()]));
  elements.tourOverlay.hidden = true;
  const storage = new Map();
  const keydown = [];
  const context = vm.createContext({
    document: {
      hidden: false, body: makeEl(), activeElement: null,
      getElementById: (id) => elements[id] || null,
      querySelector: (selector) => (selector === '.page.active' ? { id: 'page-dashboard' } : makeEl()),
      querySelectorAll: (selector) => (selector === '#tourCard button' ? [elements.tourSkip, elements.tourBack, elements.tourNext, elements.tourFinish] : []),
      addEventListener: (event, listener) => { if (event === 'keydown') keydown.push(listener); }
    },
    window: { location: { protocol: 'http:', hostname: 'localhost', port: '3001' }, innerWidth: 1200, innerHeight: 800, scrollY: 0, addEventListener() {}, removeEventListener() {}, scrollTo() {} },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key) },
    requestAnimationFrame: (fn) => { fn(); return 1; }, cancelAnimationFrame() {},
    AbortController, setTimeout, clearTimeout, fetch: async () => ({ ok: true, json: async () => ({}) })
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8'), context);
  const visited = [];
  context.__visit = (page) => visited.push(page);
  vm.runInContext('showTourPage = (page) => { if (page) __visit(page); };', context);
  const total = vm.runInContext('ONBOARDING_STEPS.length', context);
  const themeStep = vm.runInContext("ONBOARDING_STEPS.find((step) => step.target === '#themeToggle')", context);
  assert.equal(themeStep.title, 'Choose light or dark mode');
  assert.match(themeStep.body, /remembered the next time you visit/);

  vm.runInContext('state.auth = true; state.isAdmin = true;', context);
  assert.equal(vm.runInContext('maybeStartOnboarding()', context), false, 'admins are not auto-toured');

  vm.runInContext('state.isAdmin = false;', context);
  assert.equal(vm.runInContext('maybeStartOnboarding()', context), true);
  assert.equal(elements.tourOverlay.hidden, false);
  assert.equal(elements.tourStep.textContent, `Step 1 of ${total}`);
  assert.equal(elements.tourBack.hidden, true);
  assert.equal(elements.tourFinish.hidden, true);
  assert.equal(elements.tourOverlay.classList.contains('is-centered'), true, 'welcome step is centered');

  vm.runInContext('moveOnboardingTour(1)', context);
  assert.equal(elements.tourStep.textContent, `Step 2 of ${total}`);
  assert.equal(elements.tourBack.hidden, false);
  assert.equal(elements.tourSpotlight.hidden, false);
  assert.equal(elements.tourSpotlight.style.top, '194px');
  vm.runInContext(`moveOnboardingTour(${vm.runInContext("ONBOARDING_STEPS.findIndex((step) => step.target === '#themeToggle') - 1", context)})`, context);
  assert.equal(elements.tourTitle.textContent, 'Choose light or dark mode');
  assert.match(elements.tourBody.textContent, /remembered the next time you visit/);
  vm.runInContext('moveOnboardingTour(-1)', context);
  vm.runInContext('moveOnboardingTour(-1); moveOnboardingTour(-1);', context);
  assert.equal(elements.tourStep.textContent, `Step 1 of ${total}`, 'back stops at the first step');

  keydown.forEach((listener) => listener({ key: 'ArrowRight', preventDefault() {} }));
  assert.equal(elements.tourStep.textContent, `Step 2 of ${total}`);
  for (let i = 0; i < total + 2; i += 1) vm.runInContext('moveOnboardingTour(1)', context);
  assert.equal(elements.tourStep.textContent, `Step ${total} of ${total}`);
  assert.equal(elements.tourFinish.hidden, false);
  assert.equal(elements.tourNext.hidden, true);
  assert.equal(elements.tourSkip.hidden, true);
  assert.ok(visited.includes('page-logs'), 'tour visits the activity log');
  assert.equal(storage.has('has_seen_onboarding'), false, 'flag is not set until the tour ends');

  vm.runInContext('finishOnboardingTour()', context);
  assert.equal(elements.tourOverlay.hidden, true);
  assert.equal(storage.get('has_seen_onboarding'), 'true');
  assert.equal(visited.at(-1), 'page-dashboard');
  assert.equal(vm.runInContext('maybeStartOnboarding()', context), false, 'does not relaunch once seen');

  vm.runInContext('startOnboardingTour()', context);
  assert.equal(elements.tourOverlay.hidden, false, 'replay works even after the flag is set');
  keydown.forEach((listener) => listener({ key: 'Escape', preventDefault() {} }));
  assert.equal(elements.tourOverlay.hidden, true, 'Escape skips');

  storage.clear();
  vm.runInContext('maybeStartOnboarding(); skipOnboardingTour();', context);
  assert.equal(storage.get('has_seen_onboarding'), 'true', 'skip saves the flag');

  storage.clear();
  vm.runInContext('maybeStartOnboarding(); closeOnboardingTour({ markSeen: false, restorePage: false });', context);
  assert.equal(storage.has('has_seen_onboarding'), false, 'signing out mid-tour does not mark it seen');
});

test('help FAQ search filters by question, answer, and keywords and keeps one answer open at a time', () => {
  const makeItem = (text, keywords) => ({ textContent: text, dataset: { keywords }, hidden: false, open: false, classList: { contains: (c) => c === 'faq-item' } });
  const items = [
    makeItem('How do I add a new inventory item? Open the Add item tab.', 'new item create sku'),
    makeItem('How do I reset my password? Use Forgot Password.', 'password reset forgot recovery code'),
    makeItem('Where is the activity log? Open Activity.', 'audit history')
  ];
  const list = { querySelectorAll: () => items };
  items.forEach((item) => { item.parentElement = { querySelectorAll: () => items.filter((other) => other.open) }; });
  const elements = { faqSearch: { value: '' }, faqList: list, faqCount: { textContent: '' }, faqEmpty: { hidden: true } };
  const listeners = {};
  const context = vm.createContext({
    document: { hidden: false, getElementById: (id) => elements[id] || null, querySelectorAll: () => [], addEventListener: (event, listener) => { listeners[event] = listener; } },
    window: { location: { protocol: 'http:', hostname: 'localhost', port: '3001' }, addEventListener() {} },
    AbortController, setTimeout, clearTimeout, fetch: async () => ({ ok: true, json: async () => ({}) })
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8'), context);
  assert.equal(elements.faqCount.textContent, '3 common questions');

  elements.faqSearch.value = 'recovery';
  vm.runInContext('filterFaq()', context);
  assert.deepEqual(items.map((item) => item.hidden), [true, false, true]);
  assert.equal(items[1].open, true, 'a single match opens automatically');
  assert.equal(elements.faqCount.textContent, '1 of 3 questions match');

  elements.faqSearch.value = 'AUDIT activity';
  vm.runInContext('filterFaq()', context);
  assert.deepEqual(items.map((item) => item.hidden), [true, true, false]);

  elements.faqSearch.value = 'zebra';
  vm.runInContext('filterFaq()', context);
  assert.equal(items.every((item) => item.hidden), true);
  assert.equal(elements.faqEmpty.hidden, false);

  elements.faqSearch.value = '';
  vm.runInContext('filterFaq()', context);
  assert.equal(items.every((item) => !item.hidden), true);
  assert.equal(elements.faqEmpty.hidden, true);

  items.forEach((item) => { item.open = false; });
  items[0].open = true;
  listeners.toggle({ target: items[0] });
  items[2].open = true;
  listeners.toggle({ target: items[2] });
  assert.deepEqual(items.map((item) => item.open), [false, false, true]);
});
