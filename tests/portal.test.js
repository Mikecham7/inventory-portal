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

function makeLoginAuditSheet() {
  const entries = [];
  return {
    entries, headerValues: ['Timestamp', 'Username', 'ClientID', 'AuthType'],
    loadHeaderRow: async () => {},
    addRow: async (values) => entries.push({ ...values }),
    getRows: async () => entries.map((values) => ({ get: (key) => values[key] || '' }))
  };
}

test('branding parser selects high-resolution logos and public theme/CSS colors without executing scripts', async () => {
  const {parseBranding,scrapeBranding,validateBranding,hexColor}=require('../api/branding');
  const base='https://brand.example/store';
  const html=`<meta name="theme-color" content="#abc"><meta property="og:image" content="/social.jpg">
    <link rel="apple-touch-icon" sizes="180x180" href="/touch.png">
    <img alt="Company logo" src="/logo-small.png" srcset="/logo-600.png 600w, /logo-1200.png 1200w">
    <style>:root{--brand-primary:#112233}</style><script>throw new Error('never execute')</script>`;
  const parsed=parseBranding(html,base);
  assert.equal(parsed.logoUrl,'https://brand.example/logo-1200.png');
  assert.equal(parsed.accentColor,'#AABBCC');
  assert.equal(parseBranding('<link rel="apple-touch-icon" href="/touch.png"><meta property="og:image" content="/social.jpg">',base).logoUrl,'https://brand.example/touch.png');
  assert.equal(parseBranding('<meta property="og:image" content="/social.jpg">',base).logoUrl,'https://brand.example/social.jpg');
  assert.equal(parseBranding('<style>:root {--primary-color:rgb(24, 50, 90)}</style>',base).accentColor,'#18325A');
  assert.equal(parseBranding('<header style="background-color:#fa0"></header>',base).accentColor,'#FFAA00');
  assert.equal(parseBranding('<script>window.context = JSON.parse("{\\"themeSettings\\":{\\"button--primary-backgroundColor\\":\\"#68773C\\"}}");</script>',base).accentColor,'#68773C','BigCommerce escaped theme settings supply the primary button color');
  assert.equal(parseBranding('<style>:root{--color-primary:#123abc}</style>',base).accentColor,'#123ABC');
  const cdn=await scrapeBranding(base,async url=>({url,body:url===base
    ? '<link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Test"><link data-stencil-stylesheet rel="stylesheet" href="https://cdn.example/theme.css">'
    : ':root{--brand-color:#68773C}'}));
  assert.equal(cdn.accentColor,'#68773C','public CDN stylesheets can supply brand colors');
  assert.equal(parseBranding('<img alt="logo" src="javascript:alert(1)"><meta name="theme-color" content="expression(bad)">',base).logoUrl,'');
  assert.equal(hexColor('rgb(256,0,0)'),'');
  assert.deepEqual(validateBranding({websiteUrl:'brand.example',logoUrl:'https://cdn.example/logo.png?w=1200',accentColor:'#a0b'}),{
    websiteUrl:'https://brand.example/',logoUrl:'https://cdn.example/logo.png?w=1200',accentColor:'#AA00BB'
  });
  for(const key of ['websiteUrl','logoUrl']){
    for(const url of ['http://127.0.0.1/logo','javascript:alert(1)','https://user:pass@brand.example','http://localhost']){
      assert.throws(()=>validateBranding({websiteUrl:'',logoUrl:'',accentColor:'',[key]:url}));
    }
  }
  assert.throws(()=>validateBranding({websiteUrl:'',logoUrl:'',accentColor:'red'}),/hex/);
  const calls=[];
  const fetched=await scrapeBranding(base,async url=>{
    calls.push(url);
    return {url,body:url===base
      ? '<meta property="og:image" content="/social.jpg"><link rel="stylesheet" href="/main.css"><link rel="stylesheet" href="https://other.example/style.css"><link rel="stylesheet" href="/second.css"><link rel="stylesheet" href="/third.css">'
      : ':root { --brand-color: #2463eb; }'};
  });
  assert.equal(fetched.accentColor,'#2463EB');
  assert.deepEqual(calls,[base,'https://brand.example/main.css']);
  const missing=await scrapeBranding(base,async url=>({url,body:'<p>No branding metadata</p>'}));
  assert.equal(missing.logoUrl,'');
  assert.equal(missing.accentColor,'');
  assert.equal(missing.warnings.length,2,'missing metadata is explicit, never a guessed success');
  const blockedCss=await scrapeBranding(base,async url=>{
    if(url!==base)throw new Error('blocked');
    return {url,body:'<link rel="stylesheet" href="/style.css">'};
  });
  assert.match(blockedCss.warnings.join(' '),/stylesheet could not be inspected/);
});

test('branding API isolates clients, permits warehouse branding edits, persists legacy profiles and reports fetch failures', async () => {
  invalidateReadCache('');
  const values=[
    {Client_ID:'CL-001',Username:'Owner',Accent_Color:'#F5C518'},
    {Client_ID:'CL-004',Username:'Other',Fields_JSON:'[]',Inventory_Mode:'inventory'}
  ];
  let failSave=false;
  const rows=values.map(entry=>({get:key=>entry[key]??'',set:(key,value)=>{entry[key]=value;},save:async options=>{assert.equal(options.raw,true);if(failSave)throw new Error('test unavailable');}}));
  const sheet={headerValues:['Client_ID','Username'],loadHeaderRow:async()=>{},setHeaderRow:async headers=>{sheet.headerValues=headers;},getRows:async()=>rows};
  const sheets={User_Credentials:sheet,'CL-001':{title:'CL-001'},'CL-004':{title:'CL-004'}};
  const titleDescriptor=Object.getOwnPropertyDescriptor(GoogleSpreadsheet.prototype,'sheetsByTitle');
  const indexDescriptor=Object.getOwnPropertyDescriptor(GoogleSpreadsheet.prototype,'sheetsByIndex');
  const oldLoadInfo=GoogleSpreadsheet.prototype.loadInfo;
  const dns=require('node:dns').promises;
  const https=require('node:https');
  const oldLookup=dns.lookup;
  const oldRequest=https.request;
  GoogleSpreadsheet.prototype.loadInfo=async()=>{};
  Object.defineProperty(GoogleSpreadsheet.prototype,'sheetsByTitle',{configurable:true,get:()=>sheets});
  Object.defineProperty(GoogleSpreadsheet.prototype,'sheetsByIndex',{configurable:true,get:()=>Object.values(sheets)});
  const server=require('../api/server.js').app.listen(0);
  const base=`http://127.0.0.1:${server.address().port}/api`;
  const owner=signNotificationSession('Brand owner','CL-001','client');
  const other=signNotificationSession('Brand other','CL-004','client');
  const staff=signNotificationSession('Brand staff','CL-000','staff');
  const admin=signNotificationSession('Brand admin','CL-000','admin');
  const branding={websiteUrl:'https://brand.example/',logoUrl:'https://brand.example/logo.png',accentColor:'#2463EB'};
  const call=(path,body={},token=owner)=>fetch(`${base}${path}`,{method:path.endsWith('/fetch')?'POST':'PUT',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({clientId:'CL-001',...body})});
  try{
    assert.equal((await call('/branding',branding,'')).status,401);
    assert.equal((await call('/branding',branding,other)).status,403);
    assert.equal((await call('/branding/fetch',{websiteUrl:branding.websiteUrl},other)).status,403);
    assert.equal((await call('/branding',{...branding,clientId:'CL-000'},admin)).status,403);
    assert.equal((await call('/branding',{...branding,accentColor:'bad'})).status,400);
    assert.equal((await call('/branding',{...branding,logoUrl:'javascript:alert(1)'})).status,400);
    for(const token of [owner,staff,admin]){
      const saved=await call('/branding',branding,token);
      assert.equal(saved.status,200);
      assert.deepEqual((await saved.json()).branding,branding);
    }
    assert.deepEqual(sheet.headerValues.slice(0,2),['Client_ID','Username']);
    assert.ok(sheet.headerValues.includes('Website_URL')&&sheet.headerValues.includes('Logo_URL'));
    const profile=await(await fetch(`${base}/client-profile?clientId=CL-001`,{headers:{Authorization:`Bearer ${owner}`}})).json();
    assert.equal(profile.legacy,true);
    assert.equal(profile.websiteUrl,branding.websiteUrl);
    assert.equal(profile.logoUrl,branding.logoUrl);
    assert.equal(profile.accentColor,branding.accentColor,'legacy profiles use saved colors too');
    assert.equal(values[1].Logo_URL,undefined,'foreign client unchanged');
    const {EventEmitter}=require('node:events');
    const {PassThrough}=require('node:stream');
    dns.lookup=async()=>[{address:'8.8.8.8',family:4}];
    https.request=(url,options,callback)=>{
      const request=new EventEmitter();
      request.destroy=error=>{if(error)request.emit('error',error);request.emit('close');};
      request.end=()=>process.nextTick(()=>{
        const response=new PassThrough();response.statusCode=200;response.headers={};
        response.on('close',()=>request.emit('close'));callback(response);
        response.end('<meta name="theme-color" content="#abc"><img alt="logo" src="/brand-logo.png">');
      });
      return request;
    };
    const fetched=await call('/branding/fetch',{websiteUrl:'https://brand-public.example/'});
    assert.equal(fetched.status,200);
    assert.equal((await fetched.json()).branding.accentColor,'#AABBCC');
    assert.equal(values[0].Logo_URL,branding.logoUrl,'fetch only suggests, never writes sheet values');
    assert.equal((await call('/branding/fetch',{websiteUrl:'https://brand-public.example/'})).status,429);
    dns.lookup=async()=>[{address:'127.0.0.1',family:4}];
    const failed=await call('/branding/fetch',{websiteUrl:'https://private-resolved.example/'},staff);
    assert.equal(failed.status,422);
    assert.match((await failed.json()).error,/enter a logo URL and hex color manually/);
    failSave=true;
    assert.equal((await call('/branding',branding)).status,500);
  }finally{
    dns.lookup=oldLookup;https.request=oldRequest;
    await new Promise(resolve=>server.close(resolve));
    GoogleSpreadsheet.prototype.loadInfo=oldLoadInfo;
    Object.defineProperty(GoogleSpreadsheet.prototype,'sheetsByTitle',titleDescriptor);
    Object.defineProperty(GoogleSpreadsheet.prototype,'sheetsByIndex',indexDescriptor);
    invalidateReadCache('');
  }
});

test('public catalog parser reads JSON-LD, Open Graph, JSON feeds and RSS without executing page content', () => {
  const {parseCatalog,catalogFeedUrl} = require('../api/catalogSync');
  const base = 'https://store.example/products/widget';
  const ld = parseCatalog(`<script type="application/ld+json">{"@graph":[
    {"@type":"Organization","name":"Not a product","image":"https://example.com/logo.png"},
    {"@type":"Product","name":"Widget & Kit","sku":"KIT-1","image":[{"url":"/widget.png"}],"isBundled":true,"bundleQuantity":3}
    ]}</script><script>throw new Error('never run');</script>`,base);
  assert.deepEqual(ld.products,[{title:'Widget & Kit',sku:'KIT-1',imageUrl:'https://store.example/widget.png',bundled:'Y',bundleQty:'3'}]);
  const og = parseCatalog('<meta property="og:title" content="Copper &amp; Steel"><meta property="og:image" content="//images.example/item.png"><meta property="product:retailer_item_id" content="00123">',base);
  assert.equal(og.products[0].title,'Copper & Steel');
  assert.equal(og.products[0].imageUrl,'https://images.example/item.png');
  assert.equal(og.products[0].sku,'00123');
  const feed = parseCatalog(JSON.stringify({products:[
    {title:'One',variants:[{sku:'SKU-1'}],images:[{src:'/one.jpg'}]},
    {title:'Two',sku:'SKU-2',image:'javascript:alert(1)'},
    {title:'Title only'}
  ]}),base);
  assert.equal(feed.products.length,3);
  assert.equal(feed.products[0].sku,'SKU-1');
  assert.equal(feed.products[1].imageUrl,'');
  assert.equal(feed.products[2].title,'Title only');
  const rss = parseCatalog('<rss xmlns:g="http://base.google.com/ns/1.0"><channel><item><g:title>RSS product</g:title><g:mpn>RSS-1</g:mpn><g:image_link>https://images.example/rss.jpg</g:image_link></item></channel></rss>',base);
  assert.equal(rss.products[0].sku,'RSS-1');
  assert.equal(rss.products[0].imageUrl,'https://images.example/rss.jpg');
  assert.equal(parseCatalog(JSON.stringify({products:Array.from({length:80},(_,i)=>({title:`Item ${i}`}))}),base).products.length,50);
  assert.throws(()=>parseCatalog('{"products":',base),/not valid JSON/);
  assert.throws(()=>parseCatalog('<html><title>Login required</title></html>',base),/No public product metadata/);
  assert.throws(()=>parseCatalog('<script type="application/ld+json">invalid</script>',base),/No public product metadata/);
  assert.equal(catalogFeedUrl('<script src="https://cdn.shopify.com/store.js"></script>','https://shop.example/'),'https://shop.example/products.json?limit=50');
  assert.equal(catalogFeedUrl('<link rel="alternate" type="application/json" href="/products.json">','https://shop.example/'),'https://shop.example/products.json');
  assert.equal(catalogFeedUrl('<link rel="alternate" type="application/json" href="/products.json">',base),'','a product page should not switch to a store-wide feed');
  assert.throws(()=>catalogFeedUrl('<link rel="alternate" type="application/json" href="http://127.0.0.1/feed">','https://shop.example/'),/public HTTP/);
});

test('public catalog fetch pins public DNS, rechecks redirects, limits size and rejects private networks', async () => {
  const {fetchPublicPage,publicUrl,publicAddress} = require('../api/catalogSync');
  const {EventEmitter} = require('node:events');
  const {PassThrough} = require('node:stream');
  for (const value of ['127.0.0.1','10.1.2.3','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','::1','::ffff:127.0.0.1','fe80::1','fc00::1','0.0.0.0']) assert.equal(publicAddress(value),false,value);
  assert.equal(publicAddress('8.8.8.8'),true);
  for (const value of ['http://127.1/','http://2130706433/','http://[::1]/','http://localhost/','http://a.localhost/','file:///etc/passwd','https://user:password@example.com/','https://example.com:8443/']) assert.throws(()=>publicUrl(value),/public HTTP/);
  const requests = [];
  let replies = [{status:200,body:'<meta property="og:title" content="A">'}];
  const lookup = async()=>[{address:'8.8.8.8',family:4}];
  const request = (url,options,callback)=>{
    requests.push({url:url.href,options});
    options.lookup(url.hostname,{},(error,address,family)=>{
      assert.equal(error,null);assert.equal(address,'8.8.8.8');assert.equal(family,4);
    });
    const req = new EventEmitter();
    req.destroy = (error)=>{if(error) req.emit('error',error);req.emit('close');};
    req.end = ()=>process.nextTick(()=>{
      const reply = replies.shift();
      const response = new PassThrough();
      response.statusCode=reply.status;
      response.headers=reply.headers||{};
      response.on('close',()=>req.emit('close'));
      callback(response);
      if (!response.destroyed) response.end(reply.body||'');
    });
    return req;
  };
  const page = await fetchPublicPage('https://store.example/item',{lookup,request});
  assert.match(page.body,/og:title/);
  assert.equal(requests[0].options.agent,false);
  assert.equal(requests[0].options.headers['Accept-Encoding'],'identity');
  await assert.rejects(fetchPublicPage('https://private.example/',{lookup:async()=>[{address:'10.0.0.1',family:4}],request}),/not a public website/);
  await assert.rejects(fetchPublicPage('https://mixed.example/',{lookup:async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}],request}),/not a public website/);
  replies=[{status:302,headers:{location:'http://169.254.169.254/latest/'}}];
  await assert.rejects(fetchPublicPage('https://store.example/',{lookup,request}),/public HTTP/);
  replies=[{status:302,headers:{location:'https://private.example/'}}];
  await assert.rejects(fetchPublicPage('https://store.example/',{lookup:async host=>[{address:host==='private.example'?'192.168.1.1':'8.8.8.8',family:4}],request}),/not a public website/);
  replies=[{status:302,headers:{location:'/products.json'}},{status:200,body:'{"products":[]}'}];
  assert.equal((await fetchPublicPage('https://store.example/',{lookup,request})).url,'https://store.example/products.json');
  replies=[{status:403}];
  await assert.rejects(fetchPublicPage('https://store.example/',{lookup,request}),/HTTP 403/);
  replies=[{status:200,body:'x'.repeat(2*1024*1024+1)}];
  await assert.rejects(fetchPublicPage('https://store.example/',{lookup,request}),/too large/);
  replies=Array.from({length:4},()=>({status:302,headers:{location:'/again'}}));
  await assert.rejects(fetchPublicPage('https://store.example/',{lookup,request}),/too many times/);
});

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

test('check-in timestamps survive legacy and modern inventory layout changes', () => {
  const timestamp = '2026-10-15T12:30:00.000Z';
  const converted = toGenericRows({
    rows: [
      ['UPC', 'Product Description', 'Quantity Ordered', 'Check_In_Timestamp'],
      ['00123', 'Widget', 10, timestamp]
    ],
    oldFields: [], newFields: [], legacyClientId: 'CL-002'
  });
  assert.equal(converted.headers.at(-1), 'Check_In_Timestamp');
  assert.equal(converted.rows[0].at(-1), timestamp);
  const changed = toGenericRows({
    rows: [converted.headers, ...converted.rows], oldFields: [],
    newFields: [{key:'merchant',label:'Merchant',type:'text'}]
  });
  assert.equal(changed.headers.at(-1), 'Check_In_Timestamp');
  assert.equal(changed.rows[0].at(-1), timestamp);
});

test('catalog metadata survives schema migrations and reuses configured field mappings', () => {
  const {catalogColumns,catalogFieldKeys}=require('../api/catalogFields');
  const rows=[
    ['SKU','Product Title','Qty','Status','Notes','Check_In_Timestamp','Product Image URL','Is Bundled','Bundle Quantity','Special Prep Instructions'],
    ['A','Widget',4,'In Stock','Note','timestamp','https://images.example/a.png','Y',3,'Wrap in bubble wrap']
  ];
  const converted=toGenericRows({rows,oldFields:[],newFields:[{key:'merchant',label:'Merchant',type:'text'}]});
  for(const label of ['Product Image URL','Is Bundled','Bundle Quantity'])assert.ok(converted.headers.includes(label));
  assert.equal(converted.rows[0][converted.headers.indexOf('Product Image URL')],'https://images.example/a.png');
  assert.equal(converted.rows[0][converted.headers.indexOf('Special Prep Instructions')],'Wrap in bubble wrap');
  const mappedPrep=toGenericRows({rows,oldFields:[],newFields:[{key:'wrap',label:'Special Prep Instructions',type:'textarea'}]});
  assert.equal(mappedPrep.headers.filter(label=>label==='Special Prep Instructions').length,1);
  assert.equal(mappedPrep.rows[0][2],'Wrap in bubble wrap');
  const removedPrep=toGenericRows({rows:[mappedPrep.headers,...mappedPrep.rows],oldFields:[{key:'wrap',label:'Special Prep Instructions',type:'textarea'}],newFields:[]});
  assert.equal(removedPrep.rows[0][removedPrep.headers.indexOf('Special Prep Instructions')],'Wrap in bubble wrap');
  const configured=toGenericRows({rows,oldFields:[],newFields:[{key:'photo',label:'Product Image URL',type:'text'},{key:'bundled',label:'Is Bundled',type:'text'}]});
  assert.equal(configured.headers.filter(label=>label==='Product Image URL').length,1,'mapping an appended image into custom fields never duplicates headers');
  assert.equal(configured.rows[0][2],'https://images.example/a.png');
  assert.equal(configured.rows[0][3],'Y');
  const removed=toGenericRows({rows:[configured.headers,...configured.rows],oldFields:[{key:'photo',label:'Product Image URL',type:'text'},{key:'bundled',label:'Is Bundled',type:'text'}],newFields:[]});
  assert.equal(removed.rows[0][removed.headers.indexOf('Product Image URL')],'https://images.example/a.png','removing custom image configuration preserves universal catalog metadata');
  assert.equal(removed.rows[0][removed.headers.indexOf('Is Bundled')],'Y');
  const profile={clientId:'CL-004',fields:[{key:'photo',label:'Product Image URL'},{key:'isBundled',label:'Is Bundled'},{key:'packSize',label:'Bundle Quantity'}]};
  assert.deepEqual(catalogFieldKeys(profile),{imageUrl:'photo',bundled:'isBundled',bundleQty:'packSize',prepInstructions:'prepInstructions'});
  assert.equal(catalogFieldKeys({fields:[{key:'packFlag',label:'Multi pack'}],attributeMap:{bundled:'packFlag'}}).bundled,'packFlag');
  const mapping=catalogColumns([['SKU','Title','Product Image URL','Is Bundled','Bundle Quantity','Qty','Status','Notes']],profile);
  assert.deepEqual(mapping.columns,{imageUrl:2,bundled:3,bundleQty:4,prepInstructions:8});
  const legacy=toGenericRows({
    rows:[['Product Description/Name','Quantity Ordered','Quantity Received','Quantity Shipped','Merchant','Carrier','Tracking #','Notes','Product Image URL','Is Bundled','Bundle Quantity'],
      ['Card',2,1,0,'Shop','UPS','TRACK','','https://images.example/card.png','Y',2]],
    oldFields:[],newFields:[],legacyClientId:'CL-003'
  });
  assert.equal(legacy.rows[0][legacy.headers.indexOf('Product Image URL')],'https://images.example/card.png');
  assert.equal(legacy.rows[0][legacy.headers.indexOf('Is Bundled')],'Y');
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

test('role permissions depend on explicit roles, never the CL-000 account shortcut', () => {
  const {credentialRole,validSessionRole,warehouseAccess}=require('../api/permissions');
  assert.equal(credentialRole(' STAFF ','CL-004'),'staff');
  assert.equal(credentialRole('','CL-000'),'admin','legacy administrators retain login compatibility');
  assert.equal(credentialRole('','CL-001'),'client');
  assert.equal(warehouseAccess({clientId:'CL-000',role:'client'}),false);
  assert.equal(warehouseAccess({clientId:'CL-004',role:'staff'}),true);
  assert.equal(warehouseAccess({clientId:'CL-001',role:'client'}),false);
  for(const role of ['retired','unknown','',undefined])assert.equal(validSessionRole({role,clientId:'CL-001'}),false);
});

test('role API matrix denies staff master settings and billing, scopes client reads, and keeps warehouse access across accounts', async () => {
  invalidateReadCache('');
  const grids={
    'CL-004':[['SKU','Product Title','Qty','Status','Notes'],['OWN-SKU','Own product',4,'In Stock','']],
    'CL-005':[['SKU','Product Title','Qty','Status','Notes'],['OTHER-SKU','Other product',8,'In Stock','']]
  };
  const credentials=[
    {Client_ID:'CL-004',Username:'Owner',Role:'client',Fields_JSON:'[]',Inventory_Mode:'inventory'},
    {Client_ID:'CL-005',Username:'Other',Role:'client',Fields_JSON:'[]',Inventory_Mode:'inventory'}
  ];
  const sheets={
    User_Credentials:{getRows:async()=>credentials.map(values=>({get:key=>values[key]??''}))},
    Inventory_Events:{getRows:async()=>[]}
  };
  for(const [title,grid]of Object.entries(grids))sheets[title]={
    title,headerValues:grid[0],loadCells:async()=>{},getCell:(r,c)=>({value:grid[r]?.[c]??''}),rowCount:grid.length,columnCount:grid[0].length
  };
  const titleDescriptor=Object.getOwnPropertyDescriptor(GoogleSpreadsheet.prototype,'sheetsByTitle');
  const indexDescriptor=Object.getOwnPropertyDescriptor(GoogleSpreadsheet.prototype,'sheetsByIndex');
  const oldLoadInfo=GoogleSpreadsheet.prototype.loadInfo;
  GoogleSpreadsheet.prototype.loadInfo=async()=>{};
  Object.defineProperty(GoogleSpreadsheet.prototype,'sheetsByTitle',{configurable:true,get:()=>sheets});
  Object.defineProperty(GoogleSpreadsheet.prototype,'sheetsByIndex',{configurable:true,get:()=>Object.values(sheets)});
  const server=require('../api/server.js').app.listen(0);
  const base=`http://127.0.0.1:${server.address().port}/api`;
  const client=signNotificationSession('Owner','CL-004','client');
  const staff=signNotificationSession('Warehouse','CL-000','staff');
  const otherStaff=signNotificationSession('WarehouseOther','CL-005','staff');
  const admin=signNotificationSession('Admin','CL-000','admin');
  const call=(path,token=client,method='GET',body)=>fetch(`${base}${path}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  try{
    assert.equal((await call('/inventory','')).status,401);
    for(const role of ['retired','bad','client']){
      const token=signNotificationSession('Invalid','CL-000',role);
      assert.equal((await call('/inventory?clientId=CL-005',token)).status,401);
    }
    let response=await call('/inventory');
    assert.equal(response.status,200);
    let items=await response.json();
    assert.deepEqual(items.map(item=>item.sku),['OWN-SKU']);
    for(const path of ['/inventory?clientId=CL-005','/inventory?clientId=CL-000','/client-profile?clientId=CL-005','/tracking?clientId=CL-005','/inbound-shipments?clientId=CL-005']){
      assert.equal((await call(path)).status,403,path);
    }
    for(const token of [staff,otherStaff,admin]){
      for(const path of ['/inventory?clientId=CL-005','/client-profile?clientId=CL-005','/activity?clientId=CL-005','/tracking?clientId=CL-005','/inbound-shipments?clientId=CL-005']){
        assert.equal((await call(path,token)).status,200,path);
      }
      const all=await(await call('/inventory?clientId=CL-000',token)).json();
      assert.equal(all.length,2,'warehouse roles can access all operational inventory');
    }
    for(const token of [staff,otherStaff,client]){
      for(const [path,method,body] of [
        ['/admin/clients','POST',{}],['/admin/clients/CL-005','PUT',{}],
        ['/admin/clients/CL-005','DELETE'],['/admin/clients/CL-005/reset-password','POST',{}],
        ['/admin/staff','GET'],['/admin/staff','POST',{}],['/admin/staff/Warehouse','PUT',{}],['/admin/logins','GET'],
        ['/admin/billing/rates/CL-005','PUT',{}],['/admin/billing/entries','POST',{}],
        ['/admin/billing/entries/id','PUT',{}],['/admin/billing/entries/id','DELETE'],
        ['/admin/billing/history','POST',{}],['/admin/billing/history/id','PUT',{}],['/admin/billing/history/id','DELETE']
      ])assert.equal((await call(path,token,method,body)).status,403,`${method} ${path}`);
    }
    for(const token of [staff,otherStaff]){
      assert.equal((await call('/billing/summary?clientId=CL-005',token)).status,403);
      assert.equal((await call('/store-connection?clientId=CL-005',token)).status,403);
      assert.equal((await call('/store-connection',token,'PUT',{clientId:'CL-005'})).status,403);
      assert.equal((await call('/packaging-notes',token,'PUT',{clientId:'CL-005'})).status,403);
    }
    const roster=await(await call('/clients')).json();
    assert.deepEqual(roster.map(entry=>entry.clientId),['CL-004']);
    assert.equal((await call('/store-connection?clientId=CL-005',admin)).status,200);
    assert.equal((await call('/store-connection?clientId=CL-004',client)).status,200);
  }finally{
    await new Promise(resolve=>server.close(resolve));
    GoogleSpreadsheet.prototype.loadInfo=oldLoadInfo;
    Object.defineProperty(GoogleSpreadsheet.prototype,'sheetsByTitle',titleDescriptor);
    Object.defineProperty(GoogleSpreadsheet.prototype,'sheetsByIndex',indexDescriptor);
    invalidateReadCache('');
  }
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
  const sheets = { User_Credentials: credentials, User_Logins: makeLoginAuditSheet() };
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
    assert.equal(sheets.User_Logins.entries.length, 0);
    const adminToken = (await (await post('/login', { username: 'ADMIN', password: 'AdminPass1' })).json()).notificationToken;
    const clientToken = (await (await post('/login', { username: 'MetalGarden', password: 'ClientPass1' })).json()).notificationToken;
    assert.ok(adminToken && clientToken);
    assert.deepEqual(sheets.User_Logins.entries.map(({ Username, ClientID, AuthType }) => [Username, ClientID, AuthType]),
      [['ADMIN', 'CL-000', 'Credentials'], ['MetalGarden', 'CL-001', 'Credentials']]);
    assert.ok(sheets.User_Logins.entries.every((entry) => new Date(entry.Timestamp).toISOString() === entry.Timestamp));

    assert.equal((await post('/admin/clients/CL-001/reset-password')).status, 401);
    assert.equal((await post('/admin/clients/CL-001/reset-password', {}, clientToken)).status, 403);
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
    assert.equal(sheets.User_Logins.entries.length, 3, 'activation grants a session and records one sign-in');
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
    assert.deepEqual(adminRoster.map((entry) => entry.clientId), ['CL-001']);
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
    assert.equal(sheets.User_Logins.entries.length, 5, 'failed, unactivated and rate-limited logins are not recorded');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    GoogleSpreadsheet.prototype.loadInfo = oldLoadInfo;
    Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByTitle', titleDescriptor);
    Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByIndex', indexDescriptor);
  }
});

test('login audit creates its sheet, exposes only recent audit fields to administrators and surfaces failures', async () => {
  const bcrypt = require('bcryptjs');
  const values = { Username: 'AuditUser', Client_ID: 'CL-005', Password: await bcrypt.hash('AuditPass123', 4) };
  const sheets = { User_Credentials: {
    headerValues:Object.keys(values),loadHeaderRow:async()=>{},
    setHeaderRow:async(headers)=>{sheets.User_Credentials.headerValues=headers;},
    getRows: async () => [{ get: (key) => values[key] || '',set:(key,value)=>{values[key]=value;},save:async()=>{} }]
  } };
  const titleDescriptor = Object.getOwnPropertyDescriptor(GoogleSpreadsheet.prototype, 'sheetsByTitle');
  const indexDescriptor = Object.getOwnPropertyDescriptor(GoogleSpreadsheet.prototype, 'sheetsByIndex');
  const oldLoadInfo = GoogleSpreadsheet.prototype.loadInfo;
  const oldAddSheet = GoogleSpreadsheet.prototype.addSheet;
  GoogleSpreadsheet.prototype.loadInfo = async () => {};
  GoogleSpreadsheet.prototype.addSheet = async ({ title, headerValues }) => {
    assert.equal(title, 'User_Logins');
    assert.deepEqual(headerValues, ['Timestamp', 'Username', 'ClientID', 'AuthType']);
    sheets[title] = makeLoginAuditSheet();
    return sheets[title];
  };
  Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByTitle', { configurable: true, get: () => sheets });
  Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByIndex', { configurable: true, get: () => Object.values(sheets) });
  const server = require('../api/server.js').app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const get = (token) => fetch(`${base}/admin/logins`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const admin = signNotificationSession('AuditAdmin', 'CL-000', 'admin');
  try {
    assert.equal((await get()).status, 401);
    assert.equal((await get('invalid.token')).status, 401);
    assert.equal((await get(signNotificationSession('Staff', 'CL-000', 'staff'))).status, 403);
    assert.equal((await get(signNotificationSession('Client', 'CL-005', 'client'))).status, 403);
    assert.equal(sheets.User_Logins, undefined, 'unauthorized viewers do not create or read audit sheets');
    const login = await fetch(`${base}/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'AuditUser', password: 'AuditPass123' })
    });
    assert.equal(login.status, 200, 'first sign-in creates the audit sheet');
    assert.equal(sheets.User_Logins.entries.length, 1);
    assert.equal(values.Role,'client','legacy client Role is backfilled on authenticated login');
    assert.deepEqual(sheets.User_Credentials.headerValues.slice(0,3),['Username','Client_ID','Password'],'header migration appends rather than reorders');
    for(const role of ['retired','unsupported']){
      values.Role=role;
      const denied=await fetch(`${base}/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'AuditUser',password:'AuditPass123'})});
      assert.equal(denied.status,401);
      assert.equal((await denied.json()).notificationToken,undefined);
    }
    values.Role='client';
    values.Client_ID='CL-000';
    const invalidClient=await fetch(`${base}/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'AuditUser',password:'AuditPass123'})});
    assert.equal(invalidClient.status,401,'CL-000 never upgrades an explicit client role');
    values.Client_ID='CL-005';
    assert.equal(sheets.User_Logins.entries.length,1,'invalid roles never start sessions or append successful logins');
    assert.equal((await (await get(admin)).json())[0].username, 'AuditUser');
    for (let i = 0; i < 105; i += 1) {
      await sheets.User_Logins.addRow({
        Timestamp: new Date(1700000000000 + i * 1000).toISOString(),
        Username: `User-${i}`, ClientID: 'CL-005', AuthType: i % 2 ? 'Credentials' : 'Auto-Login', Password: 'not-exposed'
      });
    }
    const entries = await (await get(admin)).json();
    assert.equal(entries.length, 100);
    assert.equal(entries[0].username, 'User-104');
    assert.equal(entries.at(-1).username, 'User-5');
    assert.deepEqual(Object.keys(entries[0]).sort(), ['authType','clientId','timestamp','username']);
    assert.ok(entries.some((entry) => entry.authType === 'Auto-Login'));
    sheets.User_Logins.getRows = async () => { throw new Error('Audit read unavailable'); };
    assert.equal((await get(admin)).status, 500);
    sheets.User_Logins.addRow = async () => { throw new Error('Audit write unavailable'); };
    const response = await fetch(`${base}/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'AuditUser', password: 'AuditPass123' })
    });
    assert.equal(response.status, 500);
    assert.equal((await response.json()).notificationToken, undefined, 'no successful unaudited session');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    GoogleSpreadsheet.prototype.loadInfo = oldLoadInfo;
    GoogleSpreadsheet.prototype.addSheet = oldAddSheet;
    Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByTitle', titleDescriptor);
    Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByIndex', indexDescriptor);
  }
});

test('only admins register, list and edit CL-000 staff without exposing secrets or changing client accounts', async () => {
  invalidateReadCache('');
  const rows = [];
  const makeRow = (values) => ({
    values, get: (key) => values[key] ?? '', set: (key, value) => { values[key] = value; }, save: async () => {}
  });
  rows.push(
    makeRow({ Client_ID:'CL-000', Username:'Owner', Client_Name:'Portal owner', Email:'owner@example.com', Password:'owner-secret' }),
    makeRow({ Client_ID:'CL-000', Username:'Warehouse', Client_Name:'Warehouse staff', Email:'warehouse@example.com', Role:'staff', Password:'staff-secret', Recovery_Code_Hash:'private-hash', Activation_Code:'private-code' }),
    makeRow({ Client_ID:'CL-001', Username:'Customer', Client_Name:'Customer', Role:'client', Email:'customer@example.com' })
  );
  const legacyHeaders = ['Client_ID','Username','Password','Client_Name','Email','Edit_PIN','Portal_Title','Portal_Subtitle'];
  const sheet = {
    headerValues: [...legacyHeaders], loadHeaderRow: async () => {},
    setHeaderRow: async (headers) => { sheet.headerValues = headers; },
    getRows: async () => rows, addRow: async (values) => rows.push(makeRow({ ...values }))
  };
  const sheets = { User_Credentials: sheet, User_Logins: makeLoginAuditSheet() };
  const titleDescriptor = Object.getOwnPropertyDescriptor(GoogleSpreadsheet.prototype, 'sheetsByTitle');
  const indexDescriptor = Object.getOwnPropertyDescriptor(GoogleSpreadsheet.prototype, 'sheetsByIndex');
  const oldLoadInfo = GoogleSpreadsheet.prototype.loadInfo;
  GoogleSpreadsheet.prototype.loadInfo = async () => {};
  Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByTitle', { configurable: true, get: () => sheets });
  Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByIndex', { configurable: true, get: () => Object.values(sheets) });
  const server = require('../api/server.js').app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const admin = signNotificationSession('Owner', 'CL-000', 'admin');
  const staff = signNotificationSession('Warehouse', 'CL-000', 'staff');
  const client = signNotificationSession('Customer', 'CL-001', 'client');
  const call = (method, path, body, token) => fetch(`${base}${path}`, {
    method, headers: { 'Content-Type':'application/json', ...(token ? { Authorization:`Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const newAccount = { username:'WarehouseNew', name:'New staff', email:'new.staff@example.com' };
  try {
    for (const [method, path, body] of [
      ['GET', '/admin/staff', undefined], ['POST', '/admin/staff', newAccount],
      ['PUT', '/admin/staff/Warehouse', { name:'Changed', email:'' }]
    ]) {
      assert.equal((await call(method, path, body)).status, 401);
      assert.equal((await call(method, path, body, client)).status, 403);
      assert.equal((await call(method, path, body, staff)).status, 403);
    }
    const listed = await (await call('GET', '/admin/staff', undefined, admin)).json();
    assert.deepEqual(sheet.headerValues.slice(0, legacyHeaders.length), legacyHeaders, 'existing credential columns are never reordered');
    assert.ok(sheet.headerValues.includes('Role'));
    assert.deepEqual(listed.map((entry) => [entry.username, entry.role]), [['Owner','admin'],['Warehouse','staff']]);
    assert.ok(listed.every((entry) => Object.keys(entry).sort().join(',') === 'activated,clientId,email,name,role,username'));
    assert.ok(!JSON.stringify(listed).includes('secret'));
    assert.equal((await call('POST', '/admin/staff', { ...newAccount, username:'warehouse' }, admin)).status, 409);
    assert.equal((await call('POST', '/admin/staff', { ...newAccount, username:'Customer' }, admin)).status, 409);
    assert.equal((await call('POST', '/admin/staff', { ...newAccount, email:'OWNER@example.com' }, admin)).status, 409);
    assert.equal((await call('POST', '/admin/staff', { ...newAccount, role:'admin' }, admin)).status, 400);
    assert.equal((await call('POST', '/admin/staff', { ...newAccount, clientId:'CL-001' }, admin)).status, 400);
    assert.equal((await call('POST', '/admin/staff', { ...newAccount, name:'' }, admin)).status, 400);
    assert.equal((await call('POST', '/admin/staff', { ...newAccount, email:'invalid' }, admin)).status, 400);
    assert.equal((await call('POST', '/admin/staff', [], admin)).status, 400);
    assert.equal(rows.length, 3);
    const registeredResponse = await call('POST', '/admin/staff', newAccount, admin);
    assert.equal(registeredResponse.status, 201);
    const registered = await registeredResponse.json();
    assert.ok(registered.activationCode);
    assert.deepEqual(Object.keys(sheets), ['User_Credentials', 'User_Logins'], 'staff registration creates no inventory sheet');
    const created = rows.at(-1);
    assert.equal(created.get('Client_ID'), 'CL-000');
    assert.equal(created.get('Role'), 'staff');
    assert.equal(created.get('Password'), '');
    assert.equal((await call('PUT', '/admin/staff/Owner', { name:'Cannot edit owner' }, admin)).status, 404);
    assert.equal((await call('PUT', '/admin/staff/Customer', { name:'Cannot edit client' }, admin)).status, 404);
    assert.equal((await call('PUT', '/admin/staff/Warehouse', { name:'Changed', role:'admin' }, admin)).status, 400);
    assert.equal((await call('PUT', '/admin/staff/Warehouse', { name:'Changed', username:'Renamed' }, admin)).status, 400);
    assert.equal((await call('PUT', '/admin/staff/Warehouse', { name:'Changed', email:'customer@example.com' }, admin)).status, 409);
    const changed = await (await call('PUT', '/admin/staff/Warehouse', { name:'Warehouse lead', email:'lead@example.com' }, admin)).json();
    assert.equal(changed.account.name, 'Warehouse lead');
    assert.equal(rows[1].get('Role'), 'staff');
    assert.equal(rows[1].get('Password'), 'staff-secret');
    assert.equal(rows[1].get('Recovery_Code_Hash'), 'private-hash');
    assert.equal(rows[1].get('Activation_Code'), 'private-code');
    assert.equal((await call('POST', '/admin/clients/CL-000/reset-password', {}, staff)).status, 403);
    const activated = await (await call('POST', '/account/activate', {
      username:registered.username, activationCode:registered.activationCode, password:'NewStaffPass123'
    })).json();
    assert.equal(activated.success, true);
    assert.equal(activated.role, 'staff');
    assert.equal(activated.clientId, 'CL-000');
    assert.ok(created.get('Password').startsWith('$2'));
    assert.equal(created.get('Activation_Code'), '');
    assert.equal((await call('GET', '/admin/staff', undefined, activated.notificationToken)).status, 403);
    const loggedIn = await (await call('POST', '/login', { username:'WarehouseNew', password:'NewStaffPass123' })).json();
    assert.equal(loggedIn.role, 'staff');
    assert.equal((await call('PUT', '/inventory/shipment', {}, loggedIn.notificationToken)).status, 400, 'staff retains warehouse endpoint access');
    const roster = await (await call('GET', '/clients', undefined, staff)).json();
    assert.deepEqual(roster.map((entry) => entry.clientId), ['CL-001']);
    const after = await (await call('GET', '/admin/staff', undefined, admin)).json();
    assert.equal(after.find((entry) => entry.username === 'WarehouseNew').activated, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    GoogleSpreadsheet.prototype.loadInfo = oldLoadInfo;
    Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByTitle', titleDescriptor);
    Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByIndex', indexDescriptor);
    invalidateReadCache('');
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
  const sheets = { User_Credentials: sheet, User_Logins: makeLoginAuditSheet() };
  Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByTitle', { configurable: true, get: () => sheets });
  Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByIndex', { configurable: true, get: () => Object.values(sheets) });
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
  assert.deepEqual(getClientInventoryFields('CL-002').fields.map((field) => field.key), ['upc', 'quantityOrdered', 'quantityReceived', 'quantityShipped', 'expDate', 'merchant', 'asin', 'fulfillment', 'transparencyCode', 'bundled', 'bundleQty', 'notes']);
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

test('fulfillment stages preserve prep work while check-in and shipment totals advance defaults', () => {
  const { FULFILLMENT_STATUSES, fulfillmentStatus, shipmentStatus } = require('../api/inventoryStatus');
  assert.deepEqual(FULFILLMENT_STATUSES, ['In Transit to Warehouse','Arrived / Check-In','Received & Verified','In Prep','Shipped out']);
  assert.equal(fulfillmentStatus('Pending'), 'In Transit to Warehouse');
  assert.equal(fulfillmentStatus('Arrived at Warehouse', 0, 0), 'Arrived / Check-In');
  assert.equal(fulfillmentStatus('Not Shipped', 5), 'Arrived / Check-In');
  assert.equal(fulfillmentStatus('In Prep', 10, 2), 'In Prep');
  assert.equal(fulfillmentStatus('Received & Verified', 10, 2), 'Received & Verified');
  assert.equal(fulfillmentStatus('In Prep', 10, 10), 'Shipped out');
  assert.equal(shipmentStatus('', 0, 5, 0), 'Arrived / Check-In');
  assert.equal(shipmentStatus('In Prep', 5, 6, 2), 'In Prep');
  assert.equal(shipmentStatus('Shipped out', 5, 6, 2), 'Arrived / Check-In');
  const context = vm.createContext({
    document: { getElementById: () => null, querySelectorAll: () => [], addEventListener() {} },
    window: { location: { hostname: 'localhost' }, addEventListener() {} },
    setTimeout: () => 0, clearTimeout() {}, console
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8'), context);
  vm.runInContext("state.activeClientId='CL-004';state.clientProfile={clientId:'CL-004',inventoryMode:'custom',fields:[]}", context);
  context.statuses = FULFILLMENT_STATUSES;
  assert.deepEqual(Array.from(vm.runInContext('statuses.map(status=>getStatusText(getItemStatus({status})))', context)), FULFILLMENT_STATUSES);
  assert.equal(vm.runInContext("getFulfillmentStatus({status:'Arrived at Warehouse',quantityReceived:0})",context),'arrived');
  assert.deepEqual(Array.from(vm.runInContext("getFilterGroups().find(group=>group.key==='stage').options.map(entry=>entry[1])", context)), FULFILLMENT_STATUSES);
  vm.runInContext("state.clientProfile.inventoryMode='inventory'", context);
  assert.deepEqual(Array.from(vm.runInContext("['In Stock','Low Stock','Out of Stock'].map(status=>getStatusText(getItemStatus({status})))", context)), ['In Stock','Low Stock','Out of Stock']);
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

test('CL-002 Apps Script preserves sheet positions and accepts rows without descriptions', () => {
  const rows = [
    ['UPC', 'Product Description', 'Quantity Ordered'],
    ['00123', 'Legacy title', 10, 8, 3, '2027-01', 'Shop', 'ASIN-1', 'FBA', 'Y', 'N', 1, 'Original note'],
    ['00999', '', 5, 0, 0, '', 'Store', 'ASIN-2', '', '', '', '', ''],
    ['', '', '', '', '', '', '', 'ASIN-ONLY', '', '', '', '', ''],
    Array(13).fill('')
  ];
  const sheet = {
    getLastRow: () => rows.length,
    getLastColumn: () => Math.max(...rows.map((row) => row.length)),
    appendRow: (row) => rows.push(row),
    getRange: (row, column, count, width) => ({
      getValues: () => rows.slice(row - 1, row - 1 + count).map((cells) => cells.slice(column - 1, column - 1 + width)),
      getValue: () => rows[row - 1][column - 1] ?? '',
      setValue: (value) => { rows[row - 1][column - 1] = value; }
    })
  };
  const context = vm.createContext({
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => sheet }) },
    Session: { getScriptTimeZone: () => 'UTC' },
    Utilities: { formatDate: () => '11/09/26 12:00' },
    Logger: { log: (message) => assert.fail(message) }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../Code.gs'), 'utf8'), context);
  assert.deepEqual(Array.from(context.getCL002ShipmentData(), (item) => item.description), ['ASIN-ONLY', '00999', 'Legacy title']);
  rows[0][13] = 'Status';
  rows[1][13] = 'In Prep';
  assert.equal(context.getCL002ShipmentData().find((item) => item.upc === '00123').status, 'In Prep');
  assert.equal(context.getCL002ShipmentData().find((item) => item.upc === '00999').status, 'In Transit to Warehouse');
  const original = rows[1].slice(0, 12);
  assert.equal(context.updateCL002Row(2, { merchant: 'New merchant' }).success, true);
  assert.deepEqual(rows[1].slice(0, 12), original.map((value, i) => i === 6 ? 'New merchant' : value));
  assert.equal(context.updateCL002Row(2, { productDescription: 'Legacy alias' }).success, true);
  assert.equal(rows[1][1], 'Legacy alias');
  assert.equal(context.updateCL002Row(2, { title: 'Primary title' }).success, true);
  assert.equal(rows[1][1], 'Primary title');
  for (const fields of [
    { upc: 'NEW-UPC', qtyOrdered: 7, merchant: 'Merchant', asin: 'NEW-ASIN' },
    { title: 'New title', productDescription: 'Duplicate', qtyOrdered: 4 },
    { description: 'Old description', qtyOrdered: 3 },
    { productDescription: 'Old alias', qtyOrdered: 2 }
  ]) {
    assert.equal(context.addCL002Row(fields).success, true);
    const added = rows.at(-1);
    assert.equal(added.length, 13);
    assert.equal(added[1], fields.title || fields.description || fields.productDescription || '');
    assert.equal(added[2], fields.qtyOrdered);
    assert.equal(added[6], fields.merchant || '');
    assert.equal(added[7], fields.asin || '');
    assert.match(added[12], /Created/);
  }
  assert.ok(context.getCL002ShipmentData().some((item) => item.upc === 'NEW-UPC'));
});

test('Apps Script CL-002 image saves append safely and preserve bundle and workflow columns', () => {
  const grid=[
    ['UPC','Product Description','Quantity Ordered','Quantity Received','Quantity Shipped','Exp Date','Merchant','ASIN','FBM/FBA','Transparency Code','Bundled','Bundle Quantity','Notes','Status','Check_In_Timestamp'],
    ['00123','Widget',10,8,2,'','','','','','Y',3,'Keep notes','In Prep','timestamp']
  ];
  let maxColumns=15;
  const sheet={
    getLastRow:()=>grid.length,getLastColumn:()=>grid[0].length,getMaxColumns:()=>maxColumns,
    insertColumnsAfter:(_column,count)=>{maxColumns+=count;},
    getRange:(row,column,height=1,width=1)=>({
      getValue:()=>grid[row-1]?.[column-1]??'',
      getValues:()=>Array.from({length:height},(_,i)=>Array.from({length:width},(_,j)=>grid[row-1+i]?.[column-1+j]??'')),
      setValue:value=>{grid[row-1]=grid[row-1]||[];grid[row-1][column-1]=value;}
    }),appendRow:row=>grid.push([...row])
  };
  const context=vm.createContext({
    SpreadsheetApp:{getActiveSpreadsheet:()=>({getSheetByName:()=>sheet})},
    Session:{getScriptTimeZone:()=> 'UTC'},Utilities:{formatDate:()=> '11/10/26 12:00'},Logger:{log(){}}
  });
  vm.runInContext(fs.readFileSync(require.resolve('../Code.gs'),'utf8'),context);
  assert.equal(context.updateCL002Row(2,{imageUrl:'https://images.example/widget.png',bundled:'N',bundleQty:2}).success,true);
  assert.equal(grid[0][15],'Product Image URL');
  assert.equal(grid[1][15],'https://images.example/widget.png');
  assert.deepEqual(grid[1].slice(13,15),['In Prep','timestamp']);
  assert.deepEqual(grid[1].slice(10,12),['N',2]);
  assert.equal(context.addCL002Row({title:'Added',imageUrl:'https://images.example/new.png',bundled:'Y',bundleQty:4}).success,true);
  assert.equal(grid[2][15],'https://images.example/new.png');
  assert.equal(grid[2][10],'Y');
  assert.equal(grid[2][11],4);
  assert.equal(context.getCL002ShipmentData().find(item=>item.description==='Added').imageUrl,'https://images.example/new.png');
  assert.equal(context.addCL002Row({title:'Bad',imageUrl:'javascript:alert(1)'}).success,false);
  assert.equal(grid.length,3);
  assert.equal(context.updateCL002Row(2,{prepInstructions:'Wrap in bubble wrap\nKeep dry'}).success,true);
  assert.equal(grid[0][16],'Special Prep Instructions');
  assert.equal(grid[1][16],'Wrap in bubble wrap\nKeep dry');
  assert.deepEqual(grid[1].slice(13,15),['In Prep','timestamp']);
  assert.equal(context.addCL002Row({title:'Prep item',prepInstructions:'Thank-you card'}).success,true);
  assert.equal(context.getCL002ShipmentData().find(item=>item.description==='Prep item').prepInstructions,'Thank-you card');
  assert.equal(context.updateCL002Row(2,{prepInstructions:'a'.repeat(5001)}).success,false);
});

test('Apps Script custom inventory reads fulfillment status without stock-level inference', () => {
  const grid = [
    ['UPC','Product Description','Quantity Ordered','Quantity Received','Quantity Shipped','Status'],
    ['ABC','Widget',10,5,0,'Received & Verified'],
    ['DEF','Other',10,10,10,'In Prep']
  ];
  const context = vm.createContext({
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => ({ getDataRange: () => ({ getValues: () => grid }) }) }) },
    Logger: { log: (message) => assert.fail(message) }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../Code.gs'), 'utf8'), context);
  context.getClientProfile = () => ({ inventoryMode:'custom' });
  assert.equal(context.fulfillmentStatus_('Arrived at Warehouse',0,0),'Arrived / Check-In');
  const items = context.getInventoryData('CL-002');
  assert.equal(items[0][4], 'Received & Verified');
  assert.equal(items[1][4], 'Shipped out');
  const converted = toGenericRows({
    rows:grid,oldFields:[],newFields:[],legacyClientId:'CL-002'
  });
  assert.equal(converted.rows[0][3], 'Received & Verified', 'migration preserves appended legacy status');
});

test('Apps Script credentials retain explicit staff roles and resolve settings by header', () => {
  const headers = ['Client_ID','Username','Password','Client_Name','Email','Edit_PIN','Role','Portal_Title','Portal_Subtitle','Inventory_Mode','Enable_Add_Item','Accent_Color','Allow_Chat','Allow_Logs','Allow_Update'];
  let grid = [
    headers,
    ['CL-000','Owner','test-pass','Owner','owner@example.com','','admin','Warehouse portal','Operations','inventory','false','#123456','true','true','true'],
    ['CL-000','Warehouse','staff-pass','Warehouse staff','warehouse@example.com','','staff'],
    ['CL-001','Customer','client-pass','Customer','','','client'],
    ['CL-000','Retired','retired-pass','Retired staff','retired@example.com','','retired']
  ];
  let email = 'warehouse@example.com';
  const audit = [];
  let auditSheet;
  const auditErrors = [];
  const context = vm.createContext({
    SpreadsheetApp: { getActiveSpreadsheet: () => ({
      getSheetByName: (name) => name === 'User_Logins' ? auditSheet : {
        getDataRange: () => ({ getValues: () => grid }),
        getMaxColumns:()=>30,
        getRange:(row,column)=>({setValue:(value)=>{grid[row-1][column-1]=value;}})
      },
      insertSheet: (name) => {
        assert.equal(name, 'User_Logins');
        auditSheet = { appendRow: (row) => audit.push(Array.from(row)), getLastRow: () => audit.length };
        return auditSheet;
      }
    }) },
    LockService: { getDocumentLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Session: { getActiveUser: () => ({ getEmail: () => email }) },
    Logger: { log: (message) => auditErrors.push(message) }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../Code.gs'), 'utf8'), context);
  const staffLogin = context.validateLogin('Warehouse', 'staff-pass');
  assert.equal(staffLogin.role, 'staff');
  assert.equal(staffLogin.enableShippedTab, true);
  assert.equal(staffLogin.profile.enableShippedTab, true);
  assert.equal(context.validateLogin('Owner', 'test-pass').role, 'admin');
  assert.equal(context.validateLogin('Customer', 'client-pass').role, 'client');
  assert.equal(context.validateLogin('Retired', 'retired-pass').success, false);
  grid.push(['CL-000','WrongClient','wrong-pass','Wrong client','','','client']);
  grid.push(['CL-004','UnknownRole','wrong-pass','Unknown role','','','superuser']);
  assert.equal(context.validateLogin('WrongClient','wrong-pass').success,false);
  assert.equal(context.validateLogin('UnknownRole','wrong-pass').success,false);
  const autoLogin = context.tryAutoLogin();
  assert.equal(autoLogin.role, 'staff');
  assert.equal(autoLogin.enableShippedTab, true);
  assert.equal(autoLogin.profile.enableShippedTab, true);
  assert.equal(context.getClientRoster()[0].enableShippedTab, true);
  assert.equal(context.getClientRoster()[0].profile.enableShippedTab, true);
  email = 'retired@example.com';
  assert.equal(context.tryAutoLogin().success, false);
  const profile = context.getClientProfile('CL-000');
  assert.equal(profile.portalTitle, 'Warehouse portal');
  assert.equal(profile.portalSubtitle, 'Operations');
  assert.equal(profile.inventoryMode, 'inventory');
  assert.equal(profile.enableAddItem, false);
  assert.equal(profile.allowUpdate, true);
  assert.equal(profile.enableShippedTab, true);
  headers.push('Client_Settings_JSON');
  grid[1][headers.length - 1] = '{"enableShippedTab":true}';
  assert.equal(context.getClientProfile('CL-000').enableShippedTab, true);
  grid[1][headers.length - 1] = '{"enableShippedTab":false}';
  assert.equal(context.getClientProfile('CL-000').enableShippedTab, false);
  grid[1][headers.length - 1] = '{bad-json';
  assert.equal(context.getClientProfile('CL-000').enableShippedTab, true);
  assert.equal(context.getClientProfile('CL-000').portalTitle, 'Warehouse portal', 'invalid settings cannot truncate the profile');
  assert.equal(auditErrors.length, 2);
  assert.match(auditErrors[0], /Invalid client settings/);
  auditErrors.length = 0;
  grid = [
    ['Client_ID','Username','Password','Client_Name','Email','Edit_PIN','Portal_Title','Portal_Subtitle'],
    ['CL-000','LegacyOwner','test-pass','Legacy owner','','','Legacy portal','Legacy subtitle']
  ];
  assert.equal(context.validateLogin('LegacyOwner', 'test-pass').role, 'admin');
  assert.equal(grid[0].at(-1),'Role');
  assert.equal(grid[1].at(-1),'admin');
  assert.equal(grid[0][6],'Portal_Title','Role migration never relabels legacy settings');
  assert.equal(context.getClientProfile('CL-000').portalTitle, 'Legacy portal');
  assert.deepEqual(audit[0], ['Timestamp', 'Username', 'ClientID', 'AuthType']);
  assert.deepEqual(audit.slice(1).map((row) => row.slice(1)), [
    ['Warehouse','CL-000','Credentials'], ['Owner','CL-000','Credentials'],
    ['Customer','CL-001','Credentials'], ['Warehouse','CL-000','Auto-Login'],
    ['LegacyOwner','CL-000','Credentials']
  ]);
  assert.ok(audit.slice(1).every((row) => new Date(row[0]).toISOString() === row[0]));
  assert.deepEqual(auditErrors, []);
  auditSheet.appendRow = () => { throw new Error('Audit unavailable'); };
  assert.equal(context.validateLogin('LegacyOwner', 'test-pass').success, false);
  assert.match(auditErrors[0], /Audit unavailable/);
  email = 'owner@example.com';
  grid = [headers, ['CL-000','Owner','test-pass','Owner',email,'','admin']];
  assert.equal(context.tryAutoLogin().success, false);
  assert.match(auditErrors[1], /Audit unavailable/);
});

test('shipped dashboard views partition inventory, compose filters and reset for disabled clients', () => {
  const buttons = ['active', 'shipped'].map((view) => ({
    dataset: { view }, setAttribute(key, value) { this[key] = value; }
  }));
  const host = { hidden: true, querySelectorAll: () => buttons };
  const context = vm.createContext({
    document: {
      getElementById: (id) => id === 'inventoryViews' ? host : null,
      querySelectorAll: () => [], addEventListener() {}
    },
    window: { location: { hostname: 'localhost' }, addEventListener() {} },
    setTimeout: () => 0, clearTimeout() {}, console
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8'), context);
  vm.runInContext(`state.activeClientId='CL-004';state.clientProfile={clientId:'CL-004',enableShippedTab:true,fields:[]};
    state.items=[
      {sku:'A',status:'Pending',qty:5},
      {sku:'B',status:'Shipped',qty:0},
      {sku:'C',status:'Partially Shipped',qty:3},
      {sku:'D',status:'Not Shipped',qty:2},
      {sku:'E',status:'Delivered',qty:0},
      {sku:'F',status:'Fully Shipped',qty:0}
    ];renderTable();`, context);
  const skus = () => Array.from(vm.runInContext('getFilteredItems().map(item=>item.sku)', context));
  assert.equal(host.hidden, false);
  assert.equal(buttons[0]['aria-pressed'], 'true');
  assert.deepEqual(skus(), ['A','C','D']);
  vm.runInContext("selectInventoryView('shipped')", context);
  assert.deepEqual(skus(), ['B','E','F']);
  assert.equal(buttons[1]['aria-pressed'], 'true');
  vm.runInContext("state.query='B'", context);
  assert.deepEqual(skus(), ['B']);
  vm.runInContext("state.query='';state.filters.stock=['out']", context);
  assert.deepEqual(skus(), ['B','E','F']);
  vm.runInContext("state.clientProfile.enableShippedTab=false;state.filters=emptyFilters();renderTable()", context);
  assert.equal(host.hidden, true);
  assert.equal(vm.runInContext('state.inventoryView', context), 'active');
  assert.equal(skus().length, 6);
  vm.runInContext("delete state.clientProfile.enableShippedTab;renderTable()", context);
  assert.equal(host.hidden, false, 'legacy profiles enable the view without a stored value');
  assert.deepEqual(skus(), ['A','C','D']);
  vm.runInContext("state.clientProfile.inventoryMode='custom';state.clientProfile.enableShippedTab=false;renderTable()", context);
  assert.equal(host.hidden, true, 'explicit off wins even for custom inventory');
  vm.runInContext("selectInventoryView('shipped')", context);
  assert.equal(vm.runInContext('state.inventoryView', context), 'active');
  vm.runInContext(`state.clientProfile.enableShippedTab=true;
    state.clientProfile.fields=[{key:'received',label:'Quantity Received'},{key:'shipped',label:'Quantity Shipped'}];
    state.items=[
      {sku:'waiting',received:0,shipped:0},{sku:'partial',received:10,shipped:2},
      {sku:'done',received:10,shipped:10},{sku:'received',received:10,shipped:0},
      {sku:'legacy-shipped',status:'Shipped'}
    ];renderTable();`, context);
  assert.deepEqual(skus(), ['waiting','partial','received']);
  vm.runInContext("selectInventoryView('shipped')", context);
  assert.deepEqual(skus(), ['done','legacy-shipped']);
  vm.runInContext("state.activeClientId='CL-005';renderTable()", context);
  assert.equal(host.hidden, true, 'stale profiles cannot enable tabs on another client');
  assert.equal(skus().length, 5);
});

test('saving the shipped-view toggle updates the active dashboard immediately without another profile read', async () => {
  const host = { hidden: true, querySelectorAll: () => [] };
  const checkbox = { checked: true };
  const inboundCheckbox = { checked: true };
  const requests = [];
  const context = vm.createContext({
    document: {
      getElementById: (id) => id === 'inventoryViews' ? host : id === 'ecEnableShippedTab' ? checkbox : id === 'ecEnableInboundShipments' ? inboundCheckbox : null,
      querySelectorAll: () => [], addEventListener() {}
    },
    window: { location: { hostname: 'localhost' }, addEventListener() {} },
    setTimeout: () => 0, clearTimeout() {}, console,
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      return { ok: true, json: async () => ({ success: true, profile: { clientId: 'CL-004', enableShippedTab: body.enableShippedTab } }) };
    }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8'), context);
  vm.runInContext(`state.auth=true;state.isAdmin=true;state.session={role:'admin',clientId:'CL-000'};
    state.activeClientId='CL-004';state.editClientId='CL-004';state.editClientFields=[];
    state.clientProfile={clientId:'CL-004',enableShippedTab:false};
    showEditClientMessage=()=>{};renderProductForm=()=>{};saveSession=()=>{};
    loadClientForEdit=async()=>{};
    fetchClientRoster=async()=>{if(state.clientProfile.enableShippedTab!==document.getElementById('ecEnableShippedTab').checked)throw Error('Dashboard update was delayed');};
    fetchClientProfile=async()=>{throw Error('Unexpected extra profile fetch');};`, context);
  await vm.runInContext('submitClientEdit()', context);
  assert.equal(requests[0].enableShippedTab, true);
  assert.equal(requests[0].enableInboundShipments, true);
  assert.equal(host.hidden, false);
  vm.runInContext("state.inventoryView='shipped'", context);
  checkbox.checked = false;
  inboundCheckbox.checked = false;
  await vm.runInContext('submitClientEdit()', context);
  assert.equal(requests[1].enableShippedTab, false);
  assert.equal(requests[1].enableInboundShipments, false);
  assert.equal(host.hidden, true);
  assert.equal(vm.runInContext('state.inventoryView', context), 'active');
});

test('legacy client settings map onto the new schema with safe defaults', () => {
  const { mapClientSettings, planClientSettingsMigration } = require('../api/clientSchema.js');
  const cl002Fields = [{ key: 'bundled', label: 'Bundled? (Y/N)' }, { key: 'notes', label: 'Notes' }];
  assert.deepEqual(mapClientSettings('', { fields: cl002Fields, clientId: 'CL-002' }), {
    fieldVisibility: { bundled: { inventory: true, order: true }, notes: { inventory: true, order: true } },
    quickEditMode: 'disabled',
    enableShippedTab: true,
    enableInboundShipments: true,
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
  assert.equal(mapClientSettings('{"enableShippedTab":true}').enableShippedTab, true);
  assert.equal(mapClientSettings('{"enableShippedTab":"false"}').enableShippedTab, false);
  assert.equal(mapClientSettings('{"enableShippedTab":false}').enableShippedTab, false);
  assert.equal(mapClientSettings('{}').enableShippedTab, true);
  for (const disabled of [false, 'false', 0, '0']) {
    assert.equal(mapClientSettings({ enableInboundShipments: disabled }).enableInboundShipments, false);
  }
  assert.equal(mapClientSettings('{}').enableInboundShipments, true);

  const fresh = planClientSettingsMigration({ clientId: 'CL-003', settingsCell: '', pinHashCell: '', editPinCell: '2468', fields: [] });
  assert.equal(JSON.parse(fresh.settingsJson).quickEditMode, 'enabled');
  assert.equal(JSON.parse(fresh.settingsJson).enableShippedTab, true);
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
    clear: async (range) => { legacyCl002Rows.splice(range ? 1 : 0); },
    setHeaderRow: async (headers) => { legacyCl002Rows[0] = [...headers]; },
    addRows: async (rows) => { legacyCl002Rows.push(...rows.map((row) => [...row])); },
    addRow: async (row) => { legacyCl002Rows.push([...row]); },
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
    const ecomToken = signNotificationSession('EcomElite', 'CL-002', 'client');
    const ecomProfile = await (await call('GET', '/client-profile?clientId=CL-002', null, ecomToken)).json();
    assert.ok(!ecomProfile.fields.some((field) => field.key === 'productDescription'));
    assert.equal(ecomProfile.dashboardColumns.length, ecomProfile.dashboardFieldKeys.length + 2);
    for (const [title, extraFields, token] of [
      ['Primary title', { upc: 'NEW-UPC', quantityOrdered: 7, quantityReceived: 99, quantityShipped: 99, merchant: 'Merchant', asin: 'NEW-ASIN', notes: 'Note' }, ecomToken],
      ['', { upc: 'LEGACY-UPC', productDescription: 'Legacy title', quantityOrdered: 4, quantityReceived: 2, quantityShipped: 1 }, adminToken],
      ['', { upc: 'NO-DESCRIPTION', quantityOrdered: 2 }, ecomToken]
    ]) {
      const response = await call('POST', '/inventory/create', { clientId: 'CL-002', title, extraFields }, token);
      assert.equal(response.status, 200);
      const row = legacyCl002Rows.at(-1);
      assert.equal(row.length, 13);
      assert.equal(row[1], title || extraFields.productDescription || '');
      assert.equal(row[2], String(extraFields.quantityOrdered));
      assert.equal(row[3], token === adminToken ? '2' : '');
      assert.equal(row[4], token === adminToken ? '1' : '');
      assert.equal(row[6], extraFields.merchant || '');
      assert.equal(row[7], extraFields.asin || '');
      assert.equal(row[12], extraFields.notes || '');
    }
    const ecomItems = await (await call('GET', '/inventory?clientId=CL-002', null, ecomToken)).json();
    assert.ok(ecomItems.some((item) => item.title === 'NO-DESCRIPTION'));
    assert.ok(ecomItems.some((item) => item.title === 'Legacy title'));
    const descriptionless = ecomItems.find((item) => item.title === 'NO-DESCRIPTION');
    const scanCheckIn = await call('PUT', '/inventory/shipment', {
      clientId:'CL-002', itemId:descriptionless.id, title:descriptionless.title,
      received:1, shipped:0, expectedReceived:0, expectedShipped:0
    }, adminToken);
    assert.equal(scanCheckIn.status, 200);
    assert.equal(legacyCl002Rows.at(-1)[3], 1);
    assert.equal(legacyCl002Rows.at(-1)[4], 0);
    const legacyItemUpdate = (values, token) => call('PUT', '/inventory/item', {
      clientId:'CL-002', itemId:descriptionless.id, title:descriptionless.title, values
    }, token);
    assert.equal((await legacyItemUpdate({status:'In Prep'}, ecomToken)).status, 403);
    assert.equal((await legacyItemUpdate({status:'In Stock'}, adminToken)).status, 400);
    assert.equal((await legacyItemUpdate({status:'Received & Verified'}, adminToken)).status, 200);
    const statusColumn = legacyCl002Rows[0].indexOf('Status');
    assert.equal(statusColumn, 13, 'legacy columns are preserved and Status is appended');
    assert.equal(legacyCl002Rows.at(-1)[statusColumn], 'Received & Verified');
    const legacyRefreshed = await (await call('GET', '/inventory?clientId=CL-002', null, adminToken)).json();
    assert.equal(legacyRefreshed.find((entry) => entry.id === descriptionless.id).status, 'Received & Verified');

    const profile = await (await call('GET', '/client-profile?clientId=CL-004', null, acmeToken)).json();
    assert.equal(profile.quickEditMode, 'password');
    assert.equal(profile.quickEditPinSet, true);
    assert.equal(profile.attributeMap.fragile, 'fragile');
    assert.ok(!JSON.stringify(profile).includes('$2'));

    const item = { clientId: 'CL-004', sku: 'X', title: 'Widget', qty: 3, extraFields: { fragile: 'Y', carrier: 'UPS' } };
    assert.equal((await call('POST', '/inventory/create', { ...item, kind: 'order', sku: 'ORD-1' }, acmeToken)).status, 200);
    assert.equal((await call('POST', '/inventory/create', { ...item, sku: 'INV-1', status: 'Low Stock' }, acmeToken)).status, 200);
    assert.deepEqual(added, [['ORD-1', 'Widget', 'Y', '', 3, 'In Transit to Warehouse', ''], ['INV-1', 'Widget', 'Y', 'UPS', 3, 'In Transit to Warehouse', '']]);

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
      enableShippedTab: true,
      enableInboundShipments: false,
      attributeMap: { bundled: null },
      fields: [{ key: 'bundled', showInInventory: true, showInOrder: false }]
    }, adminToken)).json();
    assert.ok(cl002.success);
    assert.equal(cl002.profile.enableInboundShipments, false);
    assert.equal(JSON.parse(credentialRows[0].values.Client_Settings_JSON).enableInboundShipments, false);
    assert.equal(cl002.profile.enableShippedTab, true);
    assert.equal(JSON.parse(credentialRows[0].values.Client_Settings_JSON).enableShippedTab, true);
    const refreshedProfile = await (await call('GET', '/client-profile?clientId=CL-002', null, ecomToken)).json();
    assert.equal(refreshedProfile.enableShippedTab, true);
    assert.equal(refreshedProfile.enableInboundShipments, false);
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

    const retired = await (await call('DELETE', '/admin/clients/CL-002', null, adminToken)).json();
    assert.equal(retired.success, true);
    assert.equal(retired.archived, true);
    assert.equal(retired.reserved, true);
    assert.equal(credentialRows[0].values.Role, 'retired');
    assert.equal(credentialRows[0].values.Username, '');
    assert.equal(credentialRows[0].values.Fields_JSON, '');
    assert.deepEqual(legacyCl002Rows, [['Retired client ID (reserved)']]);
    assert.ok(Object.values(sheets).some((sheet) => sheet?.title?.startsWith('CL-002_Retired_')));
    const activeClients = await (await call('GET', '/clients', null, adminToken)).json();
    assert.ok(!activeClients.some((client) => client.clientId === 'CL-002'));
    assert.equal((await call('POST', '/admin/clients', {
      clientId: 'CL-002', clientName: 'Replacement', username: 'Replacement'
    }, adminToken)).status, 409);
    assert.equal((await call('POST', '/admin/clients/CL-002/reset-password', {}, adminToken)).status, 404);
    assert.equal((await call('PUT', '/admin/clients/CL-002', {}, adminToken)).status, 404);

    assert.equal((await call('PUT', '/admin/clients/CL-003', { quickEditMode: 'password' }, adminToken)).status, 200);
    assert.equal((await call('PUT', '/inventory/quantity', { clientId: 'CL-003', sku: 'A', qty: 1 }, cjaToken, { 'X-Quick-Edit-Token': unlock.token })).status, 400, 'shipment quantities cannot be changed through stock quick edit');
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
  const legacyGrid = [
    ['UPC', 'Product Description', 'Quantity Ordered', 'Quantity Received', 'Quantity Shipped', 'Exp Date', 'Merchant', 'ASIN', 'FBM/FBA', 'Transparency', 'Bundled', 'Bundle Quantity', 'Notes', 'Archived: Old'],
    ['001234567890', 'Legacy widget', 10, 8, 2, '', '', '', '', '', '', '', 'Keep notes', 'Keep archive']
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
    'CL-004': { title: 'CL-004', rowCount: 2, columnCount: 7, resize: async ({columnCount}) => { sheets['CL-004'].columnCount = columnCount; }, loadCells: async () => {}, getCell: cell, saveUpdatedCells: async () => {} }
  };
  sheets['CL-002'] = {
    title: 'CL-002', rowCount: 2, columnCount: 14, loadCells: async () => {},
    resize: async ({columnCount}) => { sheets['CL-002'].columnCount = columnCount; },
    getCell: (row, column) => ({
      get value() { return legacyGrid[row]?.[column] ?? ''; },
      set value(value) { legacyGrid[row][column] = value; }
    }),
    saveUpdatedCells: async () => {}
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

    const steps = [[10, 0, 'Arrived / Check-In'], [10, 4, 'Arrived / Check-In'], [10, 10, 'Shipped out']];
    for (const [received, shipped, status] of steps) {
      const result = await (await update({ received, shipped }, admin)).json();
      assert.equal(result.status, status);
      assert.deepEqual([grid[1][2], grid[1][3], grid[1][5]], [received, shipped, status]);
    }
    assert.equal((await update({ received: 11, shipped: 10, expectedReceived: 9, expectedShipped: 10 }, admin)).status, 409);
    assert.deepEqual(grid[1].slice(2, 4), [10, 10]);
    assert.equal((await update({ received: 11, shipped: 10, expectedReceived: 10 }, admin)).status, 400);
    assert.equal((await update({ received: 11, shipped: 10, expectedReceived: 10, expectedShipped: 10 }, signNotificationSession('Acme', 'CL-004', 'client'))).status, 401);
    assert.equal((await update({ received: 11, shipped: 10, expectedReceived: 10, expectedShipped: 10 }, admin)).status, 200);
    assert.deepEqual(grid[1].slice(2, 4), [11, 10]);

    const editItem = (body, token) => fetch(`http://127.0.0.1:${server.address().port}/api/inventory/item`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ clientId: 'CL-004', itemId: 'CL-004-1', title: 'Widget', ...body })
    });
    const client = signNotificationSession('Acme', 'CL-004', 'client');
    const scan = (code, token = admin, body = {}) => fetch(`http://127.0.0.1:${server.address().port}/api/inventory/check-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ clientId: 'CL-004', itemId: 'CL-004-1', code, ...body })
    });
    assert.equal((await scan('A-1', client)).status, 403);
    assert.equal((await scan('wrong-code')).status, 409);
    assert.equal((await scan('A-1', admin, {clientId:'CL-005'})).status, 409);
    assert.equal((await editItem({ values: { status: 'In Transit to Warehouse' } }, admin)).status, 200);
    const totals = grid[1].slice(2, 4);
    const arrival = await (await scan('a-1')).json();
    assert.equal(arrival.success, true);
    assert.equal(arrival.status, 'Arrived / Check-In');
    assert.ok(Number.isFinite(Date.parse(arrival.timestamp)));
    assert.equal(grid[0][7], 'Check_In_Timestamp');
    assert.equal(grid[1][7], arrival.timestamp);
    assert.deepEqual(grid[1].slice(2, 4), totals);
    const repeat = await (await scan('A-1')).json();
    assert.equal(repeat.alreadyCheckedIn, true);
    assert.equal(repeat.timestamp, arrival.timestamp);
    const legacyArrival = await (await scan('001234567890', admin, {clientId:'CL-002',itemId:'CL-002-1'})).json();
    assert.equal(legacyArrival.success, true);
    assert.deepEqual(legacyGrid[1].slice(0, 14), ['001234567890', 'Legacy widget', 10, 8, 2, '', '', '', '', '', '', '', 'Keep notes', 'Keep archive']);
    assert.equal(legacyGrid[0][14], 'Status');
    assert.equal(legacyGrid[1][14], 'Arrived / Check-In');
    assert.equal(legacyGrid[0][15], 'Check_In_Timestamp');
    assert.equal(legacyGrid[1][15], legacyArrival.timestamp);
    for (const status of ['Received & Verified','In Prep']) {
      assert.equal((await editItem({ values: { status } }, admin)).status, 200);
      assert.equal(grid[1][5], status);
      assert.equal((await scan('A-1')).status, 409, 'a repeated scan never regresses a later prep stage');
      const saved = await (await update({received:12,shipped:10},admin)).json();
      assert.equal(saved.status, status, 'quantity updates retain verified/prep stages');
    }
    assert.equal((await editItem({ values: { status: 'In Prep' } }, client)).status, 403);
    assert.equal((await editItem({ values: { status: 'In Stock' } }, admin)).status, 400);
    assert.equal((await update({received:12,shipped:12},admin)).status, 200);
    assert.equal((await scan('A-1')).status, 409, 'shipped items cannot be checked in');
    assert.equal((await editItem({ values: { status: 'In Prep' } }, admin)).status, 400);
    assert.equal((await update({received:11,shipped:10},admin)).status, 200);
    assert.equal((await editItem({ values: { title: 'Widget Pro' } }, signNotificationSession('Other', 'CL-005', 'client'))).status, 400);
    assert.equal((await editItem({ values: { quantityReceived: 99 } }, client)).status, 403);
    assert.equal((await editItem({ values: { qty: 99, notes: 'Do not write' } }, admin)).status, 400);
    assert.equal((await editItem({ values: { status: 'In Stock' } }, client)).status, 403);
    assert.equal(grid[1][6], '');
    assert.equal((await editItem({ values: { title: '' } }, client)).status, 400);
    assert.equal((await editItem({ values: { title: 'Widget Pro' }, title: 'Someone else' }, client)).status, 409);
    assert.equal((await editItem({ values: { sku: '', title: 'Widget Pro' } }, client)).status, 200);
    assert.deepEqual([grid[1][0], grid[1][1], grid[1][2]], ['', 'Widget Pro', 11]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    GoogleSpreadsheet.prototype.loadInfo = oldLoadInfo;
    Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByTitle', titleDescriptor);
    Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByIndex', indexDescriptor);
  }
});

test('store credentials use authenticated encryption bound to the client and store', () => {
  const {encryptStoreCredentials,decryptStoreCredentials,integrationStorageReady,validateStoreConnection,readSubmittedCredentials} = require('../api/storeIntegration');
  const oldKey = process.env.STORE_INTEGRATION_KEY;
  const config = {platform:'shopify',domain:'https://test-store.myshopify.com'};
  const credentials = {accessToken:'synthetic-test-token-not-real'};
  try {
    delete process.env.STORE_INTEGRATION_KEY;
    assert.equal(integrationStorageReady(),false);
    assert.throws(()=>encryptStoreCredentials(credentials,'CL-004',config),/storage is unavailable/);
    process.env.STORE_INTEGRATION_KEY = 'ab'.repeat(32);
    assert.equal(integrationStorageReady(),true);
    const first = encryptStoreCredentials(credentials,'CL-004',config);
    const second = encryptStoreCredentials(credentials,'CL-004',config);
    assert.notEqual(first,second,'every save has a fresh nonce');
    assert.ok(!first.includes(credentials.accessToken));
    assert.deepEqual(decryptStoreCredentials(first,'CL-004',config),credentials);
    assert.throws(()=>decryptStoreCredentials(first,'CL-005',config));
    assert.throws(()=>decryptStoreCredentials(first,'CL-004',{...config,domain:'https://other-store.myshopify.com'}));
    const tampered = JSON.parse(first);
    tampered.data = Buffer.from('tampered').toString('base64');
    assert.throws(()=>decryptStoreCredentials(JSON.stringify(tampered),'CL-004',config));
    process.env.STORE_INTEGRATION_KEY='cd'.repeat(32);
    assert.throws(()=>decryptStoreCredentials(first,'CL-004',config));
    assert.deepEqual(validateStoreConnection({platform:'shopify',domain:'test-store.myshopify.com/'}),config);
    assert.equal(validateStoreConnection({platform:'woocommerce',domain:'https://shop.example/wordpress/'}).domain,'https://shop.example/wordpress');
    for (const domain of ['https://localhost','https://127.0.0.1','http://shop.example','https://user:pass@shop.example','https://shop.example?secret=1','https://shop.example/#secret']) {
      assert.throws(()=>validateStoreConnection({platform:'woocommerce',domain}));
    }
    assert.throws(()=>validateStoreConnection({platform:'shopify',domain:'shop.example'}),/myshopify/);
    assert.throws(()=>readSubmittedCredentials({consumerKey:'ck_ab'},'woocommerce'),/all required/);
    assert.throws(()=>readSubmittedCredentials({consumerKey:'wrong',consumerSecret:'wrong'},'woocommerce'),/ck_/);
    assert.throws(()=>readSubmittedCredentials({accessToken:123},'shopify'),/text values/);
    assert.equal(readSubmittedCredentials({},'shopify'),null);
    for (const platform of ['bigcommerce','amazon','wix','custom']) {
      assert.equal(validateStoreConnection({platform,domain:'https://shop.example/storefront'}).platform,platform);
      assert.equal(readSubmittedCredentials({},platform),null);
      assert.deepEqual(readSubmittedCredentials({connectionDetails:'Seller: TEST\nMarketplace: TEST'},platform),{connectionDetails:'Seller: TEST\nMarketplace: TEST'});
      assert.deepEqual(readSubmittedCredentials({accessToken:'test-token'},platform),{accessToken:'test-token'});
      assert.throws(()=>readSubmittedCredentials({connectionDetails:123},platform),/text values/);
      assert.throws(()=>readSubmittedCredentials({connectionDetails:'a'.repeat(5001)},platform),/5000/);
      assert.throws(()=>readSubmittedCredentials({accessToken:'line\nbreak'},platform),/single-line/);
    }
    assert.throws(()=>validateStoreConnection({platform:'unsupported',domain:'https://shop.example'}),/supported store platform/);
  } finally {
    if (oldKey === undefined) delete process.env.STORE_INTEGRATION_KEY;
    else process.env.STORE_INTEGRATION_KEY = oldKey;
  }
});

test('store connection API isolates clients, encrypts tokens and never returns secrets in profiles', async () => {
  invalidateReadCache('');
  const {decryptStoreCredentials}=require('../api/storeIntegration');
  const entries = [
    {Client_ID:'CL-004',Username:'Owner',Inventory_Mode:'inventory',Fields_JSON:'[]'},
    {Client_ID:'CL-005',Username:'Other',Inventory_Mode:'inventory',Fields_JSON:'[]'}
  ];
  let failSave = false;
  const rows = entries.map(values=>({
    get:key=>values[key]??'',set:(key,value)=>{values[key]=value;},save:async()=>{if(failSave)throw new Error('test save unavailable');}
  }));
  const sheets={
    User_Credentials:{headerValues:['Client_ID','Username','Password'],loadHeaderRow:async()=>{},setHeaderRow:async(headers)=>{sheets.User_Credentials.headerValues=headers;},getRows:async()=>rows},
    'CL-004':{title:'CL-004'},'CL-005':{title:'CL-005'}
  };
  const titleDescriptor=Object.getOwnPropertyDescriptor(GoogleSpreadsheet.prototype,'sheetsByTitle');
  const indexDescriptor=Object.getOwnPropertyDescriptor(GoogleSpreadsheet.prototype,'sheetsByIndex');
  const oldLoadInfo=GoogleSpreadsheet.prototype.loadInfo;
  const oldKey=process.env.STORE_INTEGRATION_KEY;
  GoogleSpreadsheet.prototype.loadInfo=async()=>{};
  Object.defineProperty(GoogleSpreadsheet.prototype,'sheetsByTitle',{configurable:true,get:()=>sheets});
  Object.defineProperty(GoogleSpreadsheet.prototype,'sheetsByIndex',{configurable:true,get:()=>Object.values(sheets)});
  const server=require('../api/server.js').app.listen(0);
  const base=`http://127.0.0.1:${server.address().port}/api`;
  const client=signNotificationSession('Owner','CL-004','client');
  const admin=signNotificationSession('Admin','CL-000','admin');
  const staff=signNotificationSession('Staff','CL-000','staff');
  const get=(token=client,clientId='CL-004')=>fetch(`${base}/store-connection?clientId=${clientId}`,{headers:{Authorization:`Bearer ${token}`}});
  const save=(body,token=client)=>fetch(`${base}/store-connection`,{
    method:'PUT',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({clientId:'CL-004',platform:'shopify',domain:'test-store.myshopify.com',...body})
  });
  try {
    delete process.env.STORE_INTEGRATION_KEY;
    assert.equal((await get('')).status,401);
    assert.equal((await get(client,'CL-005')).status,403);
    assert.equal((await get(staff)).status,403);
    assert.equal((await save({},staff)).status,403);
    assert.equal((await get(admin,'CL-000')).status,403);
    assert.equal((await get(admin,'CL-999')).status,404);
    let response=await get();
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal((await response.json()).connection.storageReady,false);
    assert.equal((await save({})).status,200,'domain-only config needs no encryption key');
    assert.ok(sheets.User_Credentials.headerValues.includes('Store_Integration_Secret'),'missing headers are appended without shifting existing columns');
    assert.deepEqual(sheets.User_Credentials.headerValues.slice(0,3),['Client_ID','Username','Password']);
    const secret='synthetic-api-test-token';
    assert.equal((await save({accessToken:secret})).status,503);
    assert.equal(entries[0].Store_Integration_Secret,'');
    process.env.STORE_INTEGRATION_KEY='ab'.repeat(32);
    response=await save({accessToken:secret});
    assert.equal(response.status,200);
    let data=await response.json();
    assert.equal(data.connection.hasCredentials,true);
    assert.equal(data.connection.automationEnabled,false);
    assert.ok(!JSON.stringify(data).includes(secret));
    const cipher=entries[0].Store_Integration_Secret;
    assert.ok(!cipher.includes(secret));
    assert.deepEqual(decryptStoreCredentials(cipher,'CL-004',JSON.parse(entries[0].Store_Integration_JSON)),{accessToken:secret});
    assert.equal((await save({})).status,200);
    assert.equal(entries[0].Store_Integration_Secret,cipher,'blank token preserves saved credentials');
    assert.equal((await save({accessToken:secret,removeCredentials:true})).status,400);
    assert.equal((await save({accessToken:'synthetic-rotated-token'})).status,200);
    assert.notEqual(entries[0].Store_Integration_Secret,cipher);
    const rotatedCipher=entries[0].Store_Integration_Secret;
    assert.equal((await save({domain:'changed-store.myshopify.com'})).status,400);
    assert.equal(entries[0].Store_Integration_Secret,rotatedCipher);
    assert.equal((await save({domain:'changed-store.myshopify.com',removeCredentials:true})).status,200);
    assert.equal(entries[0].Store_Integration_Secret,'');
    assert.equal((await save({platform:'woocommerce',domain:'https://shop.example',consumerKey:'ck_ab12',consumerSecret:'cs_cd34'})).status,200);
    for (const path of ['/store-connection?clientId=CL-004','/client-profile?clientId=CL-004','/clients']) {
      const result=await(await fetch(`${base}${path}`,{headers:{Authorization:`Bearer ${path==='/clients'?admin:client}`}})).json();
      const text=JSON.stringify(result);
      assert.ok(!text.includes('ck_ab12')&&!text.includes('cs_cd34')&&!text.includes('Store_Integration_Secret')&&!text.includes('"iv"'));
    }
    assert.equal((await save({clientId:'CL-005',platform:'woocommerce',domain:'https://other.example'},admin)).status,200);
    for (const platform of ['bigcommerce','amazon','wix','custom']) {
      assert.equal((await save({platform,domain:'https://store.example/public-store',removeCredentials:true})).status,200,'new platforms support domain-only saves');
      const details=`Synthetic ${platform} identifier\nTest connection notes`;
      response=await save({platform,domain:'https://store.example/public-store',accessToken:'synthetic-new-token',connectionDetails:details});
      assert.equal(response.status,200);
      const summary=await response.json();
      assert.equal(summary.connection.platform,platform);
      assert.equal(summary.connection.hasCredentials,true);
      assert.equal(summary.connection.automationEnabled,false);
      assert.ok(!JSON.stringify(summary).includes(details));
      const savedConfig=JSON.parse(entries[0].Store_Integration_JSON);
      assert.deepEqual(decryptStoreCredentials(entries[0].Store_Integration_Secret,'CL-004',savedConfig),{accessToken:'synthetic-new-token',connectionDetails:details});
      const before=entries[0].Store_Integration_Secret;
      assert.equal((await save({platform,domain:savedConfig.domain})).status,200);
      assert.equal(entries[0].Store_Integration_Secret,before,'blank details preserve credentials');
      assert.equal((await save({platform,domain:'https://changed.example'})).status,400);
      assert.equal((await save({platform:platform==='custom'?'amazon':'custom',domain:savedConfig.domain})).status,400,'platform changes cannot silently reuse credentials');
      const reloaded=await(await get()).json();
      assert.equal(reloaded.connection.platform,platform);
      assert.equal(reloaded.connection.domain,savedConfig.domain);
      assert.ok(!JSON.stringify(reloaded).includes('synthetic-new-token'));
      delete process.env.STORE_INTEGRATION_KEY;
      assert.equal((await save({platform,domain:savedConfig.domain,connectionDetails:'new details'})).status,503);
      process.env.STORE_INTEGRATION_KEY='ab'.repeat(32);
    }
    delete process.env.STORE_INTEGRATION_KEY;
    assert.equal((await save({disconnect:true})).status,200);
    data=await(await get()).json();
    assert.equal(data.connection.hasCredentials,false);
    assert.equal(data.connection.domain,'');
    assert.equal(entries[0].Store_Integration_JSON,'');
    assert.equal(entries[0].Store_Integration_Secret,'');
    failSave=true;
    assert.equal((await save({})).status,500);
  } finally {
    if(oldKey===undefined)delete process.env.STORE_INTEGRATION_KEY;else process.env.STORE_INTEGRATION_KEY=oldKey;
    await new Promise(resolve=>server.close(resolve));
    GoogleSpreadsheet.prototype.loadInfo=oldLoadInfo;
    Object.defineProperty(GoogleSpreadsheet.prototype,'sheetsByTitle',titleDescriptor);
    Object.defineProperty(GoogleSpreadsheet.prototype,'sheetsByIndex',indexDescriptor);
    invalidateReadCache('');
  }
});

test('client-wide packaging notes allow owners and admins, preserve profile settings and reject stale edits', async () => {
  invalidateReadCache('');
  const values=[
    {Client_ID:'CL-001',Username:'Owner',Packaging_Notes:'Include thank-you card'},
    {Client_ID:'CL-004',Username:'Other',Fields_JSON:'[]',Inventory_Mode:'inventory',Packaging_Notes:'Other client rules'}
  ];
  let saveError=false;
  const rows=values.map(entry=>({get:key=>entry[key]??'',set:(key,value)=>{entry[key]=value;},save:async options=>{assert.equal(options.raw,true);if(saveError)throw new Error('test save unavailable');}}));
  const sheet={headerValues:['Client_ID','Username'],loadHeaderRow:async()=>{},setHeaderRow:async headers=>{sheet.headerValues=headers;},getRows:async()=>rows};
  const sheets={User_Credentials:sheet,'CL-001':{title:'CL-001'},'CL-004':{title:'CL-004'}};
  const titleDescriptor=Object.getOwnPropertyDescriptor(GoogleSpreadsheet.prototype,'sheetsByTitle');
  const indexDescriptor=Object.getOwnPropertyDescriptor(GoogleSpreadsheet.prototype,'sheetsByIndex');
  const oldLoadInfo=GoogleSpreadsheet.prototype.loadInfo;
  GoogleSpreadsheet.prototype.loadInfo=async()=>{};
  Object.defineProperty(GoogleSpreadsheet.prototype,'sheetsByTitle',{configurable:true,get:()=>sheets});
  Object.defineProperty(GoogleSpreadsheet.prototype,'sheetsByIndex',{configurable:true,get:()=>Object.values(sheets)});
  const server=require('../api/server.js').app.listen(0);
  const base=`http://127.0.0.1:${server.address().port}/api`;
  const client=signNotificationSession('Owner','CL-001','client');
  const admin=signNotificationSession('Admin','CL-000','admin');
  const staff=signNotificationSession('Dock','CL-000','staff');
  const put=(body,token=client)=>fetch(`${base}/packaging-notes`,{method:'PUT',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({clientId:'CL-001',previousNotes:'Include thank-you card',packagingNotes:'Wrap every box\nInclude card',...body})});
  const profile=()=>fetch(`${base}/client-profile?clientId=CL-001`,{headers:{Authorization:`Bearer ${client}`}}).then(response=>response.json());
  try{
    assert.equal((await profile()).packagingNotes,'Include thank-you card');
    assert.equal((await put({},'')).status,401);
    assert.equal((await put({},staff)).status,403);
    assert.equal((await put({clientId:'CL-004'})).status,403);
    assert.equal((await put({clientId:'CL-999'},admin)).status,404);
    assert.equal((await put({packagingNotes:'a'.repeat(5001)})).status,400);
    assert.equal((await put({packagingNotes:{text:'invalid'}})).status,400);
    assert.equal((await put({packagingNotes:'bad\u0000text'})).status,400);
    assert.equal((await put({previousNotes:'outdated'})).status,409);
    let response=await put({});
    assert.equal(response.status,200,'read-only inventory owners may maintain their own SOP');
    assert.equal((await response.json()).packagingNotes,'Wrap every box\nInclude card');
    assert.ok(sheet.headerValues.includes('Packaging_Notes'));
    assert.deepEqual(sheet.headerValues.slice(0,2),['Client_ID','Username']);
    assert.equal(values[1].Packaging_Notes,'Other client rules');
    assert.equal((await profile()).packagingNotes,'Wrap every box\nInclude card','profile cache invalidated after save');
    assert.equal((await profile()).readOnly,true);
    assert.equal((await put({})).status,409,'stale browser cannot overwrite new rules');
    assert.equal((await put({previousNotes:'Wrap every box\nInclude card',packagingNotes:'=literal text'},admin)).status,200);
    assert.equal(values[0].Packaging_Notes,'=literal text');
    assert.equal((await put({previousNotes:'=literal text',packagingNotes:''})).status,200);
    assert.equal((await profile()).packagingNotes,'');
    saveError=true;
    assert.equal((await put({previousNotes:'',packagingNotes:'new'})).status,500);
  }finally{
    await new Promise(resolve=>server.close(resolve));
    GoogleSpreadsheet.prototype.loadInfo=oldLoadInfo;
    Object.defineProperty(GoogleSpreadsheet.prototype,'sheetsByTitle',titleDescriptor);
    Object.defineProperty(GoogleSpreadsheet.prototype,'sheetsByIndex',indexDescriptor);
    invalidateReadCache('');
  }
});

test('prep instruction metadata validates length and preserves configured field mappings', () => {
  const {catalogColumns,catalogFieldKeys,validateCatalogValues}=require('../api/catalogFields');
  const profile={clientId:'CL-004',fields:[{key:'wrap',label:'Special Prep Instructions',type:'textarea'}]};
  assert.equal(catalogFieldKeys(profile).prepInstructions,'wrap');
  assert.equal(catalogColumns([['SKU','Title','Special Prep Instructions','Qty','Status','Notes']],profile).columns.prepInstructions,2);
  assert.doesNotThrow(()=>validateCatalogValues({wrap:'a'.repeat(5000)},catalogFieldKeys(profile)));
  assert.throws(()=>validateCatalogValues({wrap:'a'.repeat(5001)},catalogFieldKeys(profile)),/5000/);
  assert.throws(()=>validateCatalogValues({prepInstructions:'bad\u0000text'},catalogFieldKeys(profile)),/control/);
});

test('inbound shipments validate tracking, calendar dates and expected SKU quantities', () => {
  const {validateInboundShipment,normalizeInboundTracking,inboundFromRow}=require('../api/inboundShipments');
  const valid={carrier:'UPS',trackingNumber:' 1z-000 1234 ',expectedDeliveryDate:'2026-11-20',contents:[{sku:'00123',quantity:12}]};
  assert.equal(validateInboundShipment(valid).trackingNumber,'1Z0001234');
  assert.equal(normalizeInboundTracking('000 123-456'),'000123456');
  assert.equal(validateInboundShipment(valid).contents[0].sku,'00123');
  for(const changes of [
    {carrier:'Unknown'},{trackingNumber:'abc'},{trackingNumber:'<script>'},
    {expectedDeliveryDate:'2026-02-30'},{expectedDeliveryDate:'2026-13-01'},{expectedDeliveryDate:''},
    {contents:[]},{contents:Array.from({length:51},(_,i)=>({sku:String(i),quantity:1}))},
    {contents:[{sku:'A',quantity:0}]},{contents:[{sku:'A',quantity:1.5}]},{contents:[{sku:'A',quantity:'2'}]},
    {contents:[{sku:'A',quantity:1000001}]},{contents:[{sku:'',quantity:1}]},
    {contents:[{sku:'A',quantity:1},{sku:'a',quantity:2}]}
  ]) assert.throws(()=>validateInboundShipment({...valid,...changes}));
  const values={Shipment_ID:'test',Client_ID:'CL-001',Carrier:'UPS',Tracking_Number:'1Z0001234',Expected_Delivery_Date:'2026-11-20',Contents_JSON:JSON.stringify(valid.contents),Status:'In Transit to Warehouse',Arrived_At:'2026-11-20T12:00:00.000Z'};
  assert.equal(inboundFromRow({get:key=>values[key]}).status,'Arrived at Warehouse');
});

test('inbound restock API supports all enabled client modes, enforces account toggles and records staff arrivals without inventory writes', async () => {
  invalidateReadCache('');
  const {INBOUND_HEADERS}=require('../api/inboundShipments');
  const creds=[
    {Client_ID:'CL-001',Username:'StockOwner'},
    {Client_ID:'CL-002',Username:'OrderOwner'},
    {Client_ID:'CL-004',Username:'OtherStock',Inventory_Mode:'inventory',Fields_JSON:'[]'}
  ];
  let saveError=false;
  const inboundValues=[];
  const makeRow=values=>({
    get:key=>values[key]??'',set:(key,value)=>{values[key]=value;},
    save:async options=>{assert.equal(options.raw,true);if(saveError)throw new Error('test arrival unavailable');}
  });
  let readsFail=false;
  const inboundSheet={
    headerValues:['Shipment_ID','Client_ID'],loadHeaderRow:async()=>{},
    setHeaderRow:async headers=>{inboundSheet.headerValues=headers;},
    getRows:async()=>{if(readsFail)throw new Error('test inbound unavailable');return inboundValues.map(makeRow);},
    addRow:async(values,options)=>{assert.equal(options.raw,true);inboundValues.push({...values});}
  };
  const sheets={
    User_Credentials:{getRows:async()=>creds.map(makeRow)},
    'CL-001':{title:'CL-001'},'CL-002':{title:'CL-002'},'CL-004':{title:'CL-004'}
  };
  const titleDescriptor=Object.getOwnPropertyDescriptor(GoogleSpreadsheet.prototype,'sheetsByTitle');
  const indexDescriptor=Object.getOwnPropertyDescriptor(GoogleSpreadsheet.prototype,'sheetsByIndex');
  const oldLoadInfo=GoogleSpreadsheet.prototype.loadInfo;
  GoogleSpreadsheet.prototype.loadInfo=async()=>{};
  Object.defineProperty(GoogleSpreadsheet.prototype,'sheetsByTitle',{configurable:true,get:()=>sheets});
  Object.defineProperty(GoogleSpreadsheet.prototype,'sheetsByIndex',{configurable:true,get:()=>Object.values(sheets)});
  const server=require('../api/server.js').app.listen(0);
  const base=`http://127.0.0.1:${server.address().port}/api/inbound-shipments`;
  const client=signNotificationSession('StockOwner','CL-001','client');
  const staff=signNotificationSession('DockStaff','CL-000','staff');
  const fulfillment=signNotificationSession('OrderOwner','CL-002','client');
  const get=(token=client,clientId='CL-001')=>fetch(`${base}?clientId=${clientId}`,{headers:{Authorization:`Bearer ${token}`}});
  const shipment={clientId:'CL-001',shipmentId:'00000000-0000-4000-8000-000000000001',carrier:'UPS',trackingNumber:'1Z000123456',expectedDeliveryDate:'2026-11-20',contents:[{sku:'00123',quantity:12},{sku:'OTHER',quantity:3}]};
  const post=(body,token=client,path='')=>fetch(`${base}${path}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
  try{
    assert.equal((await get('')).status,401);
    assert.equal((await get(client,'CL-004')).status,403);
    assert.equal((await post({...shipment,clientId:'CL-004'})).status,403);
    assert.equal((await get(fulfillment,'CL-002')).status,200);
    creds[1].Client_Settings_JSON = '{"enableInboundShipments":false}';
    invalidateReadCache('');
    assert.equal((await get(fulfillment,'CL-002')).status,403);
    assert.equal((await get(staff,'CL-002')).status,403);
    assert.equal((await post({...shipment,clientId:'CL-002'},fulfillment)).status,403);
    assert.equal((await post({clientId:'CL-002',code:'123'},staff,'/check-in')).status,403);
    creds[1].Client_Settings_JSON = '{"enableInboundShipments":true}';
    invalidateReadCache('');
    assert.equal((await get(fulfillment,'CL-002')).status,200);
    assert.equal((await get(staff,'CL-999')).status,404);
    let response=await get();
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.deepEqual((await response.json()).shipments,[],'reading an empty log does not create a sheet');
    sheets.Inbound_Shipments=inboundSheet;
    response=await post(shipment);
    assert.equal(response.status,201,'read-only CL-001 clients can notify restocks without editing inventory');
    assert.deepEqual(inboundSheet.headerValues,INBOUND_HEADERS);
    let result=await response.json();
    assert.equal(result.shipment.status,'In Transit to Warehouse');
    assert.equal(result.shipment.contents[0].sku,'00123');
    assert.equal(result.shipment.createdBy,'StockOwner');
    assert.equal((await post(shipment)).status,200,'same-form retry returns existing record');
    assert.equal(inboundValues.length,1);
    assert.equal((await post({...shipment,shipmentId:'00000000-0000-4000-8000-000000000002'})).status,409);
    assert.equal((await post({...shipment,contents:[]})).status,400);
    assert.equal((await post({...shipment,shipmentId:'invalid'})).status,400);
    assert.equal((await post({...shipment,clientId:'CL-004',shipmentId:'00000000-0000-4000-8000-000000000003'},staff)).status,201);
    assert.equal((await(await get()).json()).shipments.length,1,'other clients never leak into list');
    const scan={clientId:'CL-001',code:'1z-000123456'};
    assert.equal((await post(scan,client,'/check-in')).status,403);
    assert.equal((await post({...scan,code:'999999'},staff,'/check-in')).status,404);
    assert.equal((await post({...scan,shipmentId:'moved'},staff,'/check-in')).status,404);
    response=await post(scan,staff,'/check-in');
    assert.equal(response.status,200);
    result=await response.json();
    assert.equal(result.shipment.status,'Arrived at Warehouse');
    assert.equal(result.shipment.arrivedBy,'DockStaff');
    assert.ok(Date.parse(result.shipment.arrivedAt));
    const timestamp=result.shipment.arrivedAt;
    result=await(await post(scan,staff,'/check-in')).json();
    assert.equal(result.alreadyCheckedIn,true);
    assert.equal(result.shipment.arrivedAt,timestamp);
    assert.deepEqual(JSON.parse(inboundValues[0].Contents_JSON),shipment.contents);
    assert.equal(inboundValues[1].Arrived_At,'','same barcode in another client stays untouched');
    inboundValues.push({...inboundValues[0],Shipment_ID:'legacy-duplicate',Arrived_At:''});
    assert.equal((await post(scan,staff,'/check-in')).status,409,'ambiguous scans require explicit selection');
    assert.equal((await post({...scan,shipmentId:shipment.shipmentId},staff,'/check-in')).status,200);
    saveError=true;
    assert.equal((await post({...scan,shipmentId:'legacy-duplicate'},staff,'/check-in')).status,500);
    saveError=false;
    const fulfillmentShipment={...shipment,clientId:'CL-002',shipmentId:'00000000-0000-4000-8000-000000000004'};
    assert.equal((await post(fulfillmentShipment,fulfillment)).status,201,'fulfillment clients can create inbound shipments');
    assert.equal((await post({clientId:'CL-002',code:shipment.trackingNumber},staff,'/check-in')).status,200,'staff can receive fulfillment-client inbound boxes');
    readsFail=true;
    assert.equal((await get()).status,500);
    assert.equal((await post({...shipment,trackingNumber:'123456789012'})).status,500);
  }finally{
    await new Promise(resolve=>server.close(resolve));
    GoogleSpreadsheet.prototype.loadInfo=oldLoadInfo;
    Object.defineProperty(GoogleSpreadsheet.prototype,'sheetsByTitle',titleDescriptor);
    Object.defineProperty(GoogleSpreadsheet.prototype,'sheetsByIndex',indexDescriptor);
    invalidateReadCache('');
  }
});

test('tracking is client-scoped, reads scan timestamps and sheet stages, and reports read failures', async () => {
  invalidateReadCache('');
  const fields = [
    {key:'incomingTracking',label:'Incoming Tracking Number',type:'text'},
    {key:'outgoingTracking',label:'Outgoing Tracking Number',type:'text'},
    {key:'quantityReceived',label:'Quantity Received',type:'number'},
    {key:'quantityShipped',label:'Quantity Shipped',type:'number'}
  ];
  const grid = [
    ['SKU','Product Title',...fields.map((field) => field.label),'Qty','Status','Notes','Check_In_Timestamp'],
    ['SKU-1','Widget','1Z999AA10123456784','123456789012',0,0,10,'In Transit to Warehouse','Private notes','']
  ];
  const makeSheet = (title, rows) => ({
    title, rowCount: rows.length, columnCount: rows[0].length, loadCells: async () => {},
    getCell: (row, column) => ({
      get value() { return rows[row]?.[column] ?? ''; },
      set value(value) { rows[row][column] = value; }
    }),
    saveUpdatedCells: async () => {}
  });
  const credentialRows = [
    {Client_ID:'CL-004',Inventory_Mode:'custom',Fields_JSON:JSON.stringify(fields)},
    {Client_ID:'CL-005',Inventory_Mode:'inventory',Fields_JSON:'[]'}
  ].map((values) => ({get: (key) => values[key] ?? ''}));
  const sheets = {
    User_Credentials: {headerValues:[],loadHeaderRow:async()=>{},setHeaderRow:async()=>{},getRows:async()=>credentialRows},
    Inventory_Events: {headerValues:['Timestamp','ClientID','Description','ActorUsername'],loadHeaderRow:async()=>{},getRows:async()=>[],addRow:async()=>{}},
    'CL-004':makeSheet('CL-004',grid),
    'CL-005':makeSheet('CL-005',[['SKU','Product Title','Qty','Status','Notes'],['STOCK','Stock widget',10,'In Stock','']]),
    'CL-003':makeSheet('CL-003',[
      ['Product Description/Name','Quantity Ordered','Quantity Received','Quantity Shipped','Merchant','Carrier','Tracking #','Notes','Status','Check_In_Timestamp'],
      ['Legacy card',2,0,0,'Shop','USPS','9400111899223856928499','','Arrived / Check-In','2026-11-10T09:00:00.000Z']
    ])
  };
  const titleDescriptor = Object.getOwnPropertyDescriptor(GoogleSpreadsheet.prototype, 'sheetsByTitle');
  const indexDescriptor = Object.getOwnPropertyDescriptor(GoogleSpreadsheet.prototype, 'sheetsByIndex');
  const oldLoadInfo = GoogleSpreadsheet.prototype.loadInfo;
  GoogleSpreadsheet.prototype.loadInfo = async () => {};
  Object.defineProperty(GoogleSpreadsheet.prototype,'sheetsByTitle',{configurable:true,get:()=>sheets});
  Object.defineProperty(GoogleSpreadsheet.prototype,'sheetsByIndex',{configurable:true,get:()=>Object.values(sheets)});
  const server = require('../api/server.js').app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = signNotificationSession('Client','CL-004','client');
  const staff = signNotificationSession('Staff','CL-000','staff');
  const get = (clientId, token = client) => fetch(`${base}/api/tracking?clientId=${clientId}`, {headers:token ? {Authorization:`Bearer ${token}`} : {}});
  try {
    assert.equal((await get('CL-004', '')).status,401);
    assert.equal((await get('CL-005')).status,403);
    assert.equal((await get('CL-000',staff)).status,400);
    assert.equal((await get('CL-999',staff)).status,404);
    let response = await get('CL-004');
    assert.equal(response.status,200);
    assert.equal(response.headers.get('cache-control'),'no-store');
    let data = await response.json();
    assert.equal(data.clientId,'CL-004');
    assert.ok(Number.isFinite(Date.parse(data.updatedAt)));
    assert.equal(data.items[0].stage,0);
    assert.equal(data.items[0].notes,undefined,'tracking never exposes unrelated item notes');
    assert.deepEqual(data.items[0].trackingNumbers,[
      {label:'Incoming Tracking Number',number:'1Z999AA10123456784'},
      {label:'Outgoing Tracking Number',number:'123456789012'}
    ]);
    const scan = await fetch(`${base}/api/inventory/check-in`,{
      method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${staff}`},
      body:JSON.stringify({clientId:'CL-004',itemId:'CL-004-1',code:'1Z999AA10123456784'})
    });
    const saved = await scan.json();
    assert.equal(saved.success,true);
    data = await (await get('CL-004')).json();
    assert.equal(data.items[0].stage,1,'status-only physical scans advance tracking without received units');
    assert.equal(data.items[0].checkInTimestamp,saved.timestamp);
    assert.deepEqual(grid[1].slice(4,6),[0,0]);
    for (const [status,stage] of [['Arrived at Warehouse',1],['Received & Verified',1],['In Prep',2],['Shipped out',3]]) {
      grid[1][7] = status;
      data = await (await get('CL-004',staff)).json();
      assert.equal(data.items[0].stage,stage);
      assert.equal(data.items[0].status,status === 'Arrived at Warehouse' ? 'Arrived / Check-In' : status);
    }
    const legacy = await (await get('CL-003',staff)).json();
    assert.equal(legacy.items[0].stage,1);
    assert.equal(legacy.items[0].checkInTimestamp,'2026-11-10T09:00:00.000Z');
    assert.equal(legacy.items[0].trackingNumbers[0].number,'9400111899223856928499');
    const stock = await (await get('CL-005',staff)).json();
    assert.equal(stock.items[0].stage,null,'stock status never invents fulfillment progress');
    sheets['CL-004'].loadCells = async () => { throw new Error('Sheet unavailable'); };
    response = await get('CL-004');
    assert.equal(response.status,500);
    assert.match((await response.json()).message,/Unable to load/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    GoogleSpreadsheet.prototype.loadInfo = oldLoadInfo;
    Object.defineProperty(GoogleSpreadsheet.prototype,'sheetsByTitle',titleDescriptor);
    Object.defineProperty(GoogleSpreadsheet.prototype,'sheetsByIndex',indexDescriptor);
    invalidateReadCache('');
  }
});

test('catalog sync and manual product saves keep images and bundles in modern and legacy sheet columns', async () => {
  invalidateReadCache('');
  const credentials = [
    {Client_ID:'CL-004',Inventory_Mode:'inventory',Fields_JSON:''},
    {Client_ID:'CL-005',Inventory_Mode:'inventory',Fields_JSON:'[]',Read_Only:'true'}
  ].map(values=>({get:key=>values[key]??''}));
  const grids = {
    'CL-001':[['Client ID','SKU Code','Product Title','Qty','Status','Notes'],['CL-001','MGM-OLD','Existing marker',5,'In Stock','Keep notes']],
    'CL-004':[['SKU','Product Title','Qty','Status','Notes','Check_In_Timestamp','Archived: Old'],['SKU-OLD','Existing',5,'In Stock','Keep notes','2026-01-01','Keep archive']],
    'CL-002':[['UPC','Product Description','Quantity Ordered','Quantity Received','Quantity Shipped','Exp Date','Merchant','ASIN','FBM/FBA','Transparency Code','Bundled','Bundle Quantity','Notes','Status','Check_In_Timestamp'],['00123','Legacy existing',10,8,2,'','','','','','N',0,'Keep','In Prep','2026-01-01']],
    'CL-003':[['Product Description/Name','Quantity Ordered','Quantity Received','Quantity Shipped','Merchant','Carrier','Tracking #','Notes'],['Legacy card',2,1,0,'Shop','UPS','TRACK-1','Sleeved']]
  };
  const sheets = {
    User_Credentials:{headerValues:[],loadHeaderRow:async()=>{},setHeaderRow:async()=>{},getRows:async()=>credentials},
    Inventory_Events:{headerValues:['Timestamp','ClientID','Description','ActorUsername'],loadHeaderRow:async()=>{},getRows:async()=>[],addRow:async()=>{}}
  };
  for (const [title,grid] of Object.entries(grids)) sheets[title]={
    title,rowCount:25,columnCount:grid[0].length,get headerValues(){return grid[0];},loadCells:async()=>{},loadHeaderRow:async()=>{},
    resize:async({columnCount})=>{sheets[title].columnCount=columnCount;},
    getCell:(row,column)=>({
      get value(){return grid[row]?.[column]??'';},
      set value(value){grid[row]=grid[row]||[];grid[row][column]=value;}
    }),
    saveUpdatedCells:async()=>{},
    addRow:async(row,options)=>{assert.equal(options.raw,true);grid.push([...row]);}
  };
  const titleDescriptor = Object.getOwnPropertyDescriptor(GoogleSpreadsheet.prototype,'sheetsByTitle');
  const indexDescriptor = Object.getOwnPropertyDescriptor(GoogleSpreadsheet.prototype,'sheetsByIndex');
  const oldLoadInfo=GoogleSpreadsheet.prototype.loadInfo;
  GoogleSpreadsheet.prototype.loadInfo=async()=>{};
  Object.defineProperty(GoogleSpreadsheet.prototype,'sheetsByTitle',{configurable:true,get:()=>sheets});
  Object.defineProperty(GoogleSpreadsheet.prototype,'sheetsByIndex',{configurable:true,get:()=>Object.values(sheets)});
  const server=require('../api/server.js').app.listen(0);
  const base=`http://127.0.0.1:${server.address().port}/api`;
  const staff=signNotificationSession('Catalog staff','CL-000','staff');
  const client=signNotificationSession('Catalog client','CL-004','client');
  const call=(path,body,token=client,method='POST')=>fetch(`${base}${path}`,{
    method,headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify(body)
  });
  const dns = require('node:dns').promises;
  const https = require('node:https');
  const oldLookup=dns.lookup;
  const oldRequest=https.request;
  try {
    assert.equal((await call('/catalog/sync',{clientId:'CL-004',url:'https://example.com'},'')).status,401);
    assert.equal((await call('/catalog/sync',{clientId:'CL-002',url:'https://example.com'})).status,403);
    const readOnlyClient=signNotificationSession('View-only client','CL-005','client');
    assert.equal((await call('/catalog/sync',{clientId:'CL-005',url:'https://example.com'},readOnlyClient)).status,403);
    assert.equal((await call('/inventory/create',{clientId:'CL-005',title:'Blocked',sku:'BLOCK',qty:1},readOnlyClient)).status,403);
    const {EventEmitter}=require('node:events');
    const {PassThrough}=require('node:stream');
    dns.lookup=async(host,options)=>host==='catalog-public.example'?[{address:'8.8.8.8',family:4}]:oldLookup(host,options);
    https.request=(url,options,callback)=>{
      if(url.hostname!=='catalog-public.example')return oldRequest(url,options,callback);
      const req=new EventEmitter();
      req.destroy=(error)=>{if(error)req.emit('error',error);req.emit('close');};
      req.end=()=>process.nextTick(()=>{
        const response=new PassThrough();
        response.statusCode=200;response.headers={};
        response.on('close',()=>req.emit('close'));
        callback(response);
        response.end(JSON.stringify({products:[{title:'Imported widget',sku:'CAT-1',image:'https://images.example/widget.png',bundled:true,bundleQty:3}]}));
      });
      return req;
    };
    const synced=await call('/catalog/sync',{clientId:'CL-004',url:'https://catalog-public.example/products.json'});
    assert.equal(synced.status,200);
    const product=(await synced.json()).products[0];
    assert.equal(product.imageUrl,'https://images.example/widget.png');
    assert.equal(product.bundled,'Y');
    const mgmClient=signNotificationSession('MGM client','CL-001','client');
    const marker={clientId:'CL-001',title:'New marker',sku:'MGM-NEW',qty:10};
    assert.equal((await call('/inventory/create',marker,mgmClient)).status,403,'MGM client remains view-only');
    for (const [index,token] of [staff,signNotificationSession('Catalog admin','CL-000','admin')].entries()) {
      const created=await call('/inventory/create',{...marker,sku:`MGM-NEW-${index}`},token);
      assert.equal(created.status,200,JSON.stringify(await created.json()));
    }
    assert.equal(grids['CL-001'].length,4,'warehouse roles can append MGM inventory without modifying old rows');
    assert.deepEqual(grids['CL-001'][1],['CL-001','MGM-OLD','Existing marker',5,'In Stock','Keep notes']);
    assert.equal(grids['CL-004'].length,2,'sync only reads metadata, never inserts inventory');
    assert.equal((await call('/catalog/sync',{clientId:'CL-004',url:'https://catalog-public.example/products.json'})).status,429);
    for (const clientId of ['CL-004','CL-002','CL-003']) {
      const token=clientId==='CL-004'?client:staff;
      const original=grids[clientId][1].slice();
      const body={clientId,title:'Review title',sku:'CAT-1',qty:10,extraFields:{imageUrl:product.imageUrl,bundled:'Y',bundleQty:'3',productName:'Review title',merchant:'Shop',prepInstructions:'Wrap in bubble wrap'}};
      const created=await call('/inventory/create',body,token);
      assert.equal(created.status,200,JSON.stringify(await created.json()));
      const [headers,,row]=grids[clientId];
      assert.deepEqual(grids[clientId][1],original,'existing inventory data never shifts');
      assert.equal(row[headers.indexOf('Product Image URL')],product.imageUrl);
      const bundledColumn=headers.indexOf(clientId==='CL-002'?'Bundled':'Is Bundled');
      assert.equal(row[bundledColumn],'Y');
      assert.equal(row[headers.indexOf('Bundle Quantity')],'3');
      assert.equal(row[headers.indexOf('Special Prep Instructions')],'Wrap in bubble wrap');
      if(clientId==='CL-003')assert.deepEqual(row.slice(0,8),['Review title','10','','','Shop','','','']);
      const edited=await call('/inventory/item',{clientId,itemId:`${clientId}-2`,title:'Review title',sku:'CAT-1',values:{imageUrl:'https://images.example/edited.jpg',bundled:'N',bundleQty:'0',prepInstructions:'Keep dry\n'+'a'.repeat(700)}},token,'PUT');
      assert.equal(edited.status,200,JSON.stringify(await edited.json()));
      assert.equal(row[headers.indexOf('Product Image URL')],'https://images.example/edited.jpg');
      assert.equal(row[bundledColumn],'N');
      assert.equal(row[headers.indexOf('Bundle Quantity')],0);
      const inventory=await(await fetch(`${base}/inventory?clientId=${clientId}`,{headers:{Authorization:`Bearer ${token}`}})).json();
      const item=inventory.find(item=>item.title==='Review title');
      assert.equal(item.imageUrl,'https://images.example/edited.jpg');
      assert.equal(item.bundled,'N');
      assert.equal(item.bundleQty,'0');
      assert.equal(item.prepInstructions,'Keep dry\n'+'a'.repeat(700));
    }
    for (const extraFields of [{imageUrl:'javascript:alert(1)'},{imageUrl:'https://user:pass@example.com/image.png'},{bundled:'maybe'},{bundleQty:'1.5'},{bundleQty:'-1'}]) {
      assert.equal((await call('/inventory/create',{clientId:'CL-004',title:'Bad',extraFields})).status,400);
      assert.equal((await call('/inventory/item',{clientId:'CL-004',itemId:'CL-004-2',title:'Review title',values:extraFields},client,'PUT')).status,400);
    }
    assert.equal((await call('/inventory/create',{clientId:'CL-002',title:'Cross-account'})).status,403);
    assert.equal((await call('/inventory/create',{clientId:'CL-005',title:'Read-only'},readOnlyClient)).status,403);
    invalidateReadCache('profile:');
    const detected=await(await fetch(`${base}/client-profile?clientId=CL-004`,{headers:{Authorization:`Bearer ${client}`}})).json();
    assert.deepEqual(detected.fields,[],'appended catalog columns never become custom fields that shift quantity/status offsets');
  } finally {
    dns.lookup=oldLookup;https.request=oldRequest;
    await new Promise(resolve=>server.close(resolve));
    GoogleSpreadsheet.prototype.loadInfo=oldLoadInfo;
    Object.defineProperty(GoogleSpreadsheet.prototype,'sheetsByTitle',titleDescriptor);
    Object.defineProperty(GoogleSpreadsheet.prototype,'sheetsByIndex',indexDescriptor);
    invalidateReadCache('');
  }
});

test('item detail edits atomically save stock, SKU and notes while enforcing account restrictions', async () => {
  invalidateReadCache('');
  const bcrypt = require('bcryptjs');
  const grid = [['SKU', 'Product Title', 'Qty', 'Status', 'Notes'], ['A-1', 'Widget', 10, 'In Stock', 'Original']];
  const legacyGrid = [[], [], [], [], [], [], [], ['Client ID', 'SKU Code', 'Product Title', 'Qty', 'Status', 'Comments'], ['CL-001', 'LEG-1', 'Legacy widget', 8, 'In Stock', 'History']];
  const credentials = [
    { Client_ID: 'CL-004', Inventory_Mode: 'inventory', Fields_JSON: '[]', Client_Settings_JSON: '{"quickEditMode":"password"}', Quick_Edit_PIN_Hash: await bcrypt.hash('9876', 4) },
    { Client_ID: 'CL-001', Read_Only: 'true' }
  ].map((values) => ({ get: (key) => values[key] ?? '', values }));
  const makeSheet = (rows) => ({
    rowCount: rows.length, columnCount: 6, loadCells: async () => {},
    getCell: (row, column) => ({
      get value() { return rows[row]?.[column] ?? ''; },
      set value(value) { rows[row][column] = value; }
    }),
    saveUpdatedCells: async () => {}
  });
  const sheets = {
    User_Credentials: { headerValues: [], loadHeaderRow: async () => {}, setHeaderRow: async () => {}, getRows: async () => credentials },
    Inventory_Events: { headerValues: ['Timestamp', 'ClientID', 'Description', 'ActorUsername'], loadHeaderRow: async () => {}, getRows: async () => [], addRow: async () => {} },
    'CL-004': makeSheet(grid), 'CL-001': makeSheet(legacyGrid)
  };
  const titleDescriptor = Object.getOwnPropertyDescriptor(GoogleSpreadsheet.prototype, 'sheetsByTitle');
  const indexDescriptor = Object.getOwnPropertyDescriptor(GoogleSpreadsheet.prototype, 'sheetsByIndex');
  const oldLoadInfo = GoogleSpreadsheet.prototype.loadInfo;
  GoogleSpreadsheet.prototype.loadInfo = async () => {};
  Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByTitle', { configurable: true, get: () => sheets });
  Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByIndex', { configurable: true, get: () => Object.values(sheets) });
  const server = require('../api/server.js').app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const client = signNotificationSession('Acme', 'CL-004', 'client');
  const admin = signNotificationSession('ADMIN', 'CL-000', 'admin');
  const put = (values, token = client, extra = {}) => fetch(`${base}/inventory/item`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(extra.unlock ? { 'X-Quick-Edit-Token': extra.unlock } : {}) },
    body: JSON.stringify({ clientId: 'CL-004', itemId: 'CL-004-1', title: 'Widget', sku: 'A-1', ...extra, values })
  });
  try {
    const locked = await put({ qty: 6, notes: 'Do not write yet' });
    assert.equal(locked.status, 403);
    assert.equal((await locked.json()).code, 'QUICK_EDIT_PIN_REQUIRED');
    assert.deepEqual(grid[1], ['A-1', 'Widget', 10, 'In Stock', 'Original']);
    const unlock = await (await fetch(`${base}/quick-edit/unlock`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${client}` },
      body: JSON.stringify({ clientId: 'CL-004', pin: '9876' })
    })).json();
    assert.ok(unlock.token);
    for (const qty of [-1, 1.5, '', 'not-a-number']) {
      assert.equal((await put({ notes: 'Invalid', qty }, admin)).status, 400);
      assert.equal(grid[1][4], 'Original');
    }
    assert.equal((await put({ notes: 'Invalid', status: 'Anything' }, admin)).status, 400);
    assert.equal((await put({ notes: 'x'.repeat(501) }, admin)).status, 400);
    assert.equal(grid[1][4], 'Original');
    assert.equal((await put({ qty: 6 }, client, { title: 'Moved', unlock: unlock.token })).status, 409);
    assert.equal((await put({ sku: 'A-2', qty: 6, status: 'Low Stock', notes: 'Handle carefully' }, client, { unlock: unlock.token })).status, 200);
    assert.deepEqual(grid[1], ['A-2', 'Widget', 6, 'Low Stock', 'Handle carefully']);
    assert.equal((await put({ qty: 0 }, admin)).status, 200);
    assert.deepEqual(grid[1].slice(2, 4), [0, 'Out of Stock']);
    credentials[0].values.Client_Settings_JSON = '{"quickEditMode":"disabled"}';
    invalidateReadCache('profile:');
    assert.equal((await put({ status: 'In Stock' })).status, 403);
    assert.equal((await put({ notes: 'Details are still editable' })).status, 200);
    assert.equal((await put({ notes: 'Forbidden' }, signNotificationSession('Other', 'CL-005', 'client'))).status, 400);
    assert.equal((await put({ notes: 'Forbidden' }, signNotificationSession('Client', 'CL-001', 'client'), { clientId: 'CL-001', sku: 'LEG-1' })).status, 403);
    assert.equal((await put({ qty: 9, notes: 'Updated legacy notes', status: 'In Stock' }, admin, { clientId: 'CL-001', sku: 'LEG-1', title: 'Legacy widget' })).status, 200);
    assert.deepEqual(legacyGrid[8].slice(3), [9, 'In Stock', 'Updated legacy notes']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    GoogleSpreadsheet.prototype.loadInfo = oldLoadInfo;
    Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByTitle', titleDescriptor);
    Object.defineProperty(GoogleSpreadsheet.prototype, 'sheetsByIndex', indexDescriptor);
    invalidateReadCache('');
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
    assert.equal((await call('PUT', '/admin/billing/rates/CL-004', { services: [] }, acme)).status, 403);

    const saved = await (await call('PUT', '/admin/billing/rates/CL-004', {
      clientVisible: true,
      services: [{ name: 'FBA Fullfillment (Per Unit)', unitPrice: 1.15 }, { name: 'Poly Bag', unitPrice: 0.3 }]
    }, admin)).json();
    assert.ok(saved.success);
    assert.equal(rateRows[0].get('Client_ID'), 'CL-004');
    const [fbaKey, polyKey] = saved.rateCard.services.map((service) => service.key);
    const today = `${currentMonth()}-01`;

    assert.equal((await call('POST', '/admin/billing/entries', { clientId: 'CL-004', date: today, serviceKey: 'ghost', quantity: 1 }, admin)).status, 400);
    assert.equal((await call('POST', '/admin/billing/entries', { clientId: 'CL-004', date: today, serviceKey: fbaKey, quantity: 10 }, acme)).status, 403);
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

    assert.equal((await call('PUT', `/admin/billing/entries/${first.entry.id}`, { quantity: 20 }, acme)).status, 403);
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

    assert.equal((await call('POST', '/admin/billing/history', { clientId: 'CL-004', month: '2026-08', amount: 78.2 }, acme)).status, 403);
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
    querySelector: () => null, querySelectorAll: () => [], focus() {}, replaceChildren() {}, append() {}, reset() {}
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

test('CL-002 forms omit duplicate descriptions even when a migrated profile retains the column', () => {
  const context = vm.createContext({
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {}
    },
    window: { location: { hostname: 'localhost' }, addEventListener() {} },
    setTimeout: () => 0,
    clearTimeout() {},
    console
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8'), context);
  for (const isAdmin of [false, true]) {
    vm.runInContext(`state.isAdmin = ${isAdmin}; state.activeClientId = 'CL-002';`, context);
    assert.ok(!vm.runInContext("getFormFields('CL-002', 'inventory').some(field => field.key === 'productDescription')", context));
    vm.runInContext(`state.clientProfile = {
      clientId: 'CL-002',
      fields: [...CLIENT_INVENTORY_FIELDS['CL-002'].fields, {key:'productDescription', label:'Product Description', type:'textarea'}]
    }`, context);
    assert.ok(!vm.runInContext("getFormFields('CL-002', 'inventory').some(field => field.key === 'productDescription')", context));
    assert.ok(!vm.runInContext("getEditableItemFields('CL-002').some(field => field.key === 'productDescription')", context));
    assert.ok(vm.runInContext("getEditableItemFields('CL-002').some(field => field.key === 'title')", context));
    vm.runInContext('state.clientProfile = null', context);
  }
});

test('add-item fields use one clean card with labelled inputs and universal catalog fields', () => {
  const html = fs.readFileSync(require.resolve('../frontend/index.html'), 'utf8');
  const page = html.split('<div id="page-order"')[1].split('<div id="page-logs"')[0];
  assert.doesNotMatch(page, /<aside|item-entry-guide|item-section-number|Item essentials|Account details|item-field-hint|A BETTER HANDOFF/);
  assert.equal((page.match(/class="update-card/g) || []).length, 1);
  assert.match(page, /id="customProductFields" hidden/);
  const elements = {
    tabOrder: {style:{}},
    customProductFields: { innerHTML: '', addEventListener() {} },
    createProductSubmit: {},
    createProductReadOnlyNotice: { style: {} }
  };
  const context = vm.createContext({
    document: {
      getElementById: (id) => elements[id] || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {}
    },
    window: { location: { hostname: 'localhost' }, addEventListener() {} },
    setTimeout: () => 0,
    clearTimeout() {},
    console
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8'), context);
  vm.runInContext(`state.auth = true; state.session = {clientId:'CL-004',role:'client'}; state.activeClientId = 'CL-004'; state.clientProfile = {
    clientId:'CL-004', fields:[], enableAddItem:true,
    titleField:{visible:true,label:'Product Title'}
  }; renderProductForm()`, context);
  assert.equal(elements.customProductFields.hidden, false);
  for (const key of ['imageUrl','bundled','bundleQty']) assert.match(elements.customProductFields.innerHTML,new RegExp(`id="customField_${key}"`));
  assert.equal(elements.createProductSubmit.textContent, 'Add to inventory');
  vm.runInContext(`state.clientProfile.fields = [
    {key:'reference',label:'Reference & code',type:'text'},
    {key:'units',label:'Units',type:'number'},
    {key:'notes',label:'Notes',type:'textarea'},
    {key:'carrier',label:'Carrier',type:'select',options:['UPS']}
  ]; renderProductForm()`, context);
  assert.equal(elements.customProductFields.hidden, false);
  for (const key of ['reference', 'units', 'notes', 'carrier']) {
    assert.ok(elements.customProductFields.innerHTML.includes(`for="customField_${key}"`));
    assert.ok(elements.customProductFields.innerHTML.includes(`id="customField_${key}"`));
  }
  assert.match(elements.customProductFields.innerHTML, /Reference &amp; code/);
  assert.doesNotMatch(elements.customProductFields.innerHTML, /style=/);
  vm.runInContext('state.clientProfile.readOnly = true; renderProductForm()', context);
  assert.equal(elements.createProductSubmit.disabled, true);
  assert.equal(elements.createProductSubmit.textContent, 'Inventory locked');
  assert.equal(elements.createProductReadOnlyNotice.style.display, 'block');
  for (const role of ['admin','staff']) {
    vm.runInContext(`state.session={clientId:'CL-000',role:'${role}'};state.isAdmin=true;state.activeClientId='CL-001';
      state.clientProfile={clientId:'CL-001',readOnly:true,enableAddItem:false,fields:[],titleField:{visible:true,label:'Product Title'}};renderProductForm()`,context);
    assert.equal(elements.tabOrder.style.display,'block',`${role} sees Add Item for MGM`);
    assert.equal(elements.createProductSubmit.disabled,false);
    assert.equal(elements.createProductReadOnlyNotice.style.display,'none');
    assert.equal(context.canAddInventoryItems(),true);
  }
  vm.runInContext("state.session={clientId:'CL-001',role:'client'};state.isAdmin=false;renderProductForm()",context);
  assert.equal(elements.tabOrder.style.display,'none','view-only clients still cannot add inventory');
  assert.equal(elements.createProductSubmit.disabled,true);
});

test('inventory row dialog supports delegated opening, safe snapshots, permissions and retryable saves', async () => {
  const listeners = {};
  const makeElement = (id) => ({
    id, innerHTML: '', textContent: '', hidden: false, value: '', style: {}, dataset: {},
    addEventListener(type, fn) { listeners[`${id}:${type}`] = fn; },
    focus() {}, showModal() { this.open = true; }, close() { this.open = false; }
  });
  const elements = Object.fromEntries([
    'inventoryBody', 'inventoryItemDialog', 'inventoryItemForm', 'inventoryItemFields', 'inventoryItemTitle',
    'inventoryItemHint', 'inventoryItemError', 'inventoryItemPinWrap', 'inventoryItemPin', 'inventoryItemSave', 'inventoryItemClose'
  ].map((id) => [id, makeElement(id)]));
  let inputs = [];
  let requests = [];
  let fail = true;
  let needsPin = false;
  const context = vm.createContext({
    document: {
      getElementById: (id) => elements[id] || null,
      querySelector: () => null,
      querySelectorAll: (selector) => selector === '#inventoryItemFields .detail-input' ? inputs : [],
      addEventListener() {}
    },
    window: { location: { hostname: 'localhost' }, addEventListener() {} },
    setTimeout: () => 0, clearTimeout() {}, console,
    fetch: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body), headers: options.headers });
      if (url === '/api/quick-edit/unlock') {
        needsPin = false;
        return { ok: true, json: async () => ({ success: true, token: 'unlocked', expiresAt: Date.now() + 60000 }) };
      }
      if (needsPin) return { ok: false, json: async () => ({ code: 'QUICK_EDIT_PIN_REQUIRED', error: 'Enter the account PIN.' }) };
      return fail
        ? { ok: false, json: async () => ({ error: 'Sheet unavailable' }) }
        : { ok: true, json: async () => ({ success: true }) };
    }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8'), context);
  vm.runInContext(`state.activeClientId = 'CL-004'; state.session = {notificationToken:'signed'};
    state.clientProfile = {clientId:'CL-004', fields:[], quickEditMode:'enabled'};
    state.items = [{id:'CL-004-1', clientId:'CL-004', sku:'A-1', title:'Widget <test>', qty:10, status:'In Stock', notes:'Original'}];
    fetchInventory = async () => {}; renderTable();`, context);
  assert.equal(vm.runInContext("getItemStatus({qty:10,status:'Low Stock',clientId:'CL-004'})", context), 'low');
  assert.equal(vm.runInContext("getItemStatus({qty:0,status:'',clientId:'CL-004'})", context), 'out');
  assert.match(elements.inventoryBody.innerHTML, /data-item-id="CL-004-1" tabindex="0"/);
  const row = { dataset: { itemId: 'CL-004-1' } };
  listeners['inventoryBody:dblclick']({ target: { closest: (selector) => selector === 'tr[data-item-id]' ? row : null } });
  assert.equal(elements.inventoryItemDialog.open, true);
  assert.equal(elements.inventoryItemTitle.textContent, 'Widget <test>');
  assert.match(elements.inventoryItemFields.innerHTML, /value="A-1"/);
  assert.match(elements.inventoryItemFields.innerHTML, /Widget &lt;test&gt;/);
  assert.match(elements.inventoryItemFields.innerHTML, />Original<\/textarea>/);
  inputs = [
    { dataset: { key: 'qty' }, value: '12' },
    { dataset: { key: 'notes' }, value: 'Changed note' },
    { dataset: { key: 'sku' }, value: 'A-1' }
  ];
  vm.runInContext('state.items[0].notes = "Polling update"', context);
  await listeners['inventoryItemForm:submit']({ preventDefault() {} });
  assert.equal(elements.inventoryItemDialog.open, true);
  assert.equal(elements.inventoryItemError.textContent, 'Sheet unavailable');
  assert.deepEqual(requests[0].body.values, { qty: '12', notes: 'Changed note' });
  assert.equal(requests[0].body.title, 'Widget <test>');
  fail = false;
  await listeners['inventoryItemForm:submit']({ preventDefault() {} });
  assert.equal(elements.inventoryItemDialog.open, false);
  assert.equal(requests[1].url, '/api/inventory/item');
  vm.runInContext("state.clientProfile.readOnly = true; openInventoryItemDialog('CL-004-1')", context);
  assert.equal(elements.inventoryItemSave.hidden, true);
  assert.match(elements.inventoryItemFields.innerHTML, /data-key="qty" disabled/);
  const previous = requests.length;
  await listeners['inventoryItemForm:submit']({ preventDefault() {} });
  assert.equal(requests.length, previous);
  vm.runInContext("closeInventoryItemDialog(); state.clientProfile.readOnly = false;", context);
  listeners['inventoryBody:keydown']({ key: 'Enter', target: { matches: () => true, dataset: row.dataset }, preventDefault() {} });
  assert.equal(elements.inventoryItemDialog.open, true);
  needsPin = true;
  await listeners['inventoryItemForm:submit']({ preventDefault() {} });
  assert.equal(elements.inventoryItemPinWrap.hidden, false);
  assert.equal(elements.inventoryItemDialog.open, true);
  elements.inventoryItemPin.value = '9876';
  await listeners['inventoryItemForm:submit']({ preventDefault() {} });
  assert.equal(requests.at(-2).url, '/api/quick-edit/unlock');
  assert.equal(requests.at(-1).headers['X-Quick-Edit-Token'], 'unlocked');
  assert.equal(elements.inventoryItemDialog.open, false);
  vm.runInContext("openInventoryItemDialog('CL-004-1')", context);
  listeners['inventoryItemDialog:cancel']({ preventDefault() {} });
  assert.equal(elements.inventoryItemDialog.open, false);
  listeners['inventoryBody:dblclick']({ target: { closest: () => ({}) } });
  assert.equal(elements.inventoryItemDialog.open, false, 'quick-edit controls do not open the dialog');
  vm.runInContext(`state.activeClientId = 'CL-002'; state.clientProfile = {clientId:'CL-002',legacy:true,fields:CLIENT_INVENTORY_FIELDS['CL-002'].fields};
    state.items = [{id:'CL-002-1',clientId:'CL-002',title:'Shipment',upc:'00123',qty:10,quantityReceived:8,quantityShipped:3}];
    openInventoryItemDialog('CL-002-1')`, context);
  assert.match(elements.inventoryItemFields.innerHTML, /data-key="qty" disabled/);
  assert.match(elements.inventoryItemFields.innerHTML, /data-key="status" disabled/);
  assert.match(elements.inventoryItemFields.innerHTML, /Arrived \/ Check-In/);
  assert.doesNotMatch(elements.inventoryItemFields.innerHTML, /data-key="productDescription"/);
  assert.match(elements.inventoryItemFields.innerHTML, /data-key="title"/);
});

test('packaging notes are edited in Settings and displayed read-only on Dashboard only after saving notes', async () => {
  const ids=['packagingProfile','settingsPackagingProfile','warehousePackagingBanner','selectedPackagingBanner','itemPackagingBanner','packagingDialog','packagingForm','packagingNotesInput','packagingSave','packagingError','scanPackagingBanner'];
  const elements=Object.fromEntries(ids.map(id=>[id,{
    value:'',hidden:false,innerHTML:'',textContent:'',disabled:false,style:{},open:false,
    addEventListener(){},reset(){},focus(){},showModal(){this.open=true;},close(){this.open=false;}
  }]));
  const context=vm.createContext({
    document:{getElementById:id=>elements[id]||null,querySelectorAll:()=>[],addEventListener(){}},
    window:{location:{hostname:'localhost'},addEventListener(){}},URL,AbortController,setTimeout,clearTimeout
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/app.js'),'utf8'),context);
  vm.runInContext(`state.auth=true;state.activeClientId='CL-001';state.session={clientId:'CL-001',role:'client',notificationToken:'signed'};
    state.clientProfile={clientId:'CL-001',inventoryMode:'inventory',readOnly:true,packagingNotes:'Include <card>\\nAll boxes'};
    state.items=[{id:'one',sku:'SKU-1',prepInstructions:'Wrap <carefully>'}];state.selectedItemId='one';renderPackagingInstructions();`,context);
  assert.match(elements.packagingProfile.innerHTML,/Include &lt;card&gt;/);
  assert.doesNotMatch(elements.packagingProfile.innerHTML,/Edit client packaging notes|data-edit-packaging/);
  assert.match(elements.settingsPackagingProfile.innerHTML,/data-edit-packaging/);
  assert.match(elements.settingsPackagingProfile.innerHTML,/Include &lt;card&gt;/);
  assert.match(elements.warehousePackagingBanner.innerHTML,/Include &lt;card&gt;/);
  assert.match(elements.selectedPackagingBanner.innerHTML,/Wrap &lt;carefully&gt;/);
  assert.match(context.packagingBanner({sku:'SKU-1',prepInstructions:'Bubble wrap'}),/Include &lt;card&gt;[\s\S]*Bubble wrap/);
  context.openPackagingDialog();
  assert.equal(elements.packagingDialog.open,true);
  assert.equal(elements.packagingNotesInput.value,'Include <card>\nAll boxes');
  elements.packagingNotesInput.value='New SOP';
  context.fetch=async()=>({ok:false,json:async()=>({success:false,error:'Save failed'})});
  await context.savePackagingNotes({preventDefault(){}});
  assert.equal(elements.packagingNotesInput.value,'New SOP');
  assert.equal(elements.packagingSave.disabled,false);
  assert.match(elements.packagingError.textContent,/Save failed/);
  context.fetch=async(url,options)=>{
    assert.equal(url,'/api/packaging-notes');
    assert.deepEqual(JSON.parse(options.body),{clientId:'CL-001',previousNotes:'Include <card>\nAll boxes',packagingNotes:'New SOP'});
    return {ok:true,json:async()=>({success:true,clientId:'CL-001',packagingNotes:'New SOP'})};
  };
  await context.savePackagingNotes({preventDefault(){}});
  assert.equal(elements.packagingDialog.open,false);
  assert.match(elements.packagingProfile.innerHTML,/New SOP/);
  context.openPackagingDialog();
  let finish;
  context.fetch=()=>new Promise(resolve=>{finish=resolve;});
  const pending=context.savePackagingNotes({preventDefault(){}});
  vm.runInContext("closePackagingDialog();state.activeClientId='CL-002';state.clientProfile={clientId:'CL-002',packagingNotes:'Other SOP'}",context);
  finish({ok:true,json:async()=>({success:true,clientId:'CL-001',packagingNotes:'Late SOP'})});
  await pending;
  assert.equal(vm.runInContext('state.clientProfile.packagingNotes',context),'Other SOP');
  vm.runInContext("state.session={clientId:'CL-000',role:'staff'};renderPackagingInstructions()",context);
  assert.doesNotMatch(elements.packagingProfile.innerHTML,/Edit client packaging notes/);
  assert.match(elements.packagingProfile.innerHTML,/Other SOP/);
  vm.runInContext("state.session={clientId:'CL-002',role:'client'};state.clientProfile.packagingNotes='';renderPackagingInstructions()",context);
  assert.equal(elements.packagingProfile.hidden,true,'empty dashboard notes are hidden');
  assert.equal(elements.packagingProfile.innerHTML,'');
  assert.equal(elements.settingsPackagingProfile.hidden,false,'Settings always provides the note editor for owners');
  assert.match(elements.settingsPackagingProfile.innerHTML,/data-edit-packaging/);
  const html=fs.readFileSync(require.resolve('../frontend/index.html'),'utf8');
  assert.doesNotMatch(html,/id="dashboardBranding"/,'branding controls live only in Settings');
});

test('inbound UI supports read-only notifications, staff scans, safe rendering and stale-response cleanup', async () => {
  const ids=['inboundDashboard','inboundTracking','inboundForm','inboundDialog','inboundFields','inboundSave','inboundError','inboundContents','inboundCarrier','inboundTrackingNumber','inboundExpectedDate'];
  const elements=Object.fromEntries(ids.map(id=>[id,{
    value:'',hidden:false,innerHTML:'',textContent:'',disabled:false,style:{},
    classList:{contains:()=>false},addEventListener(){},reset(){},close(){this.open=false;}
  }]));
  const skuInput={value:'<SKU>'},qtyInput={value:'12'};
  const line={querySelector:selector=>selector==='[data-inbound-sku]'?skuInput:qtyInput};
  const context=vm.createContext({
    document:{getElementById:id=>elements[id]||null,querySelectorAll:selector=>selector==='#inboundContents .inbound-line'?[line]:[],addEventListener(){}},
    window:{location:{hostname:'localhost'},addEventListener(){}},URL,AbortController,setTimeout,clearTimeout
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/app.js'),'utf8'),context);
  vm.runInContext(`state.auth=true;state.activeClientId='CL-001';state.session={clientId:'CL-001',role:'client',notificationToken:'signed'};
    state.clientProfile={clientId:'CL-001',inventoryMode:'inventory',readOnly:true,enableAddItem:false};`,context);
  const shipment={id:'00000000-0000-4000-8000-000000000001',clientId:'CL-001',carrier:'UPS',trackingNumber:'1Z001234',expectedDeliveryDate:'2026-11-20',contents:[{sku:'<SKU>',quantity:12}],createdAt:'2026-11-10T12:00:00Z',createdBy:'<Owner>',status:'In Transit to Warehouse',arrivedAt:'',arrivedBy:''};
  context.fetch=async()=>({ok:true,json:async()=>({success:true,clientId:'CL-001',shipments:[shipment]})});
  await context.loadInboundShipments();
  assert.equal(elements.inboundDashboard.hidden,false);
  assert.match(elements.inboundDashboard.innerHTML,/Notify Restock/);
  assert.match(elements.inboundDashboard.innerHTML,/&lt;SKU&gt;/);
  assert.match(elements.inboundDashboard.innerHTML,/&lt;Owner&gt;/);
  assert.doesNotMatch(elements.inboundDashboard.innerHTML,/Dock scan/);
  assert.match(elements.inboundTracking.innerHTML,/1Z001234/);
  let calls=0;
  context.fetch=async()=>{calls++;};
  await context.checkInInboundShipment('1Z001234');
  assert.equal(calls,0,'clients cannot invoke staff scans');
  vm.runInContext("inboundDraftId='00000000-0000-4000-8000-000000000001'",context);
  elements.inboundCarrier.value='UPS';
  elements.inboundTrackingNumber.value='1Z001234';
  elements.inboundExpectedDate.value='2026-11-20';
  context.fetch=async()=>({ok:false,json:async()=>({success:false,error:'Save not confirmed'})});
  await context.submitInboundShipment({preventDefault(){}});
  assert.equal(elements.inboundFields.disabled,false);
  assert.equal(elements.inboundTrackingNumber.value,'1Z001234');
  assert.match(elements.inboundError.textContent,/Save not confirmed/);
  assert.equal(vm.runInContext('inboundDraftId',context),shipment.id,'uncertain save retains retry identity');
  let submitted;
  context.fetch=async(url,options)=>{
    assert.equal(url,'/api/inbound-shipments');
    submitted=JSON.parse(options.body);
    return {ok:true,json:async()=>({success:true,clientId:'CL-001',shipment})};
  };
  await context.submitInboundShipment({preventDefault(){}});
  assert.deepEqual(submitted.contents,[{sku:'<SKU>',quantity:12}]);
  assert.equal(submitted.shipmentId,shipment.id);
  assert.equal(vm.runInContext('inboundDraftId',context),null);
  assert.equal(vm.runInContext('inboundState.shipments.length',context),1);
  vm.runInContext("state.isAdmin=true;state.session={clientId:'CL-000',role:'staff'};renderInboundShipments()",context);
  assert.match(elements.inboundDashboard.innerHTML,/Dock scan/);
  context.fetch=async(url,options)=>{
    assert.equal(url,'/api/inbound-shipments/check-in');
    submitted=JSON.parse(options.body);
    return {ok:true,json:async()=>({success:true,clientId:'CL-001',shipment:{...shipment,status:'Arrived at Warehouse',arrivedAt:'2026-11-20T12:00:00Z',arrivedBy:'DockStaff'}})};
  };
  await context.checkInInboundShipment('1Z001234',shipment.id);
  assert.equal(submitted.code,'1Z001234');
  assert.match(elements.inboundDashboard.innerHTML,/Stock quantities unchanged/);
  assert.match(elements.inboundDashboard.innerHTML,/Arrived at Warehouse/);
  assert.doesNotMatch(elements.inboundDashboard.innerHTML,/data-inbound-action="arrive"/);
  let finish;
  context.fetch=()=>new Promise(resolve=>{finish=resolve;});
  const pending=context.loadInboundShipments();
  vm.runInContext("state.activeClientId='CL-002';state.clientProfile={clientId:'CL-002',inventoryMode:'custom'};resetInboundShipments()",context);
  finish({ok:true,json:async()=>({success:true,clientId:'CL-001',shipments:[shipment]})});
  await pending;
  assert.equal(elements.inboundDashboard.hidden,false,'fulfillment accounts also support inbound restocks');
  assert.match(elements.inboundDashboard.innerHTML,/Notify Restock/);
  assert.doesNotMatch(elements.inboundDashboard.innerHTML,/1Z001234/,'previous account shipments are not retained');
  assert.equal(vm.runInContext('inboundState.shipments',context),null);
  vm.runInContext("state.clientProfile.enableInboundShipments=false;renderInboundShipments()",context);
  assert.equal(elements.inboundDashboard.hidden,true);
  assert.equal(elements.inboundTracking.hidden,true);
  assert.equal(elements.inboundDashboard.innerHTML,'');
  assert.equal(elements.inboundDialog.open,false);
  context.fetch=async()=>{throw new Error('Disabled inbound must not fetch');};
  await context.loadInboundShipments();
  vm.runInContext("state.clientProfile.enableInboundShipments=true;renderInboundShipments()",context);
  assert.equal(elements.inboundDashboard.hidden,false);
  assert.equal(elements.inboundTracking.hidden,false);
});

test('optional store settings keep secrets out of state, clear inputs and discard stale account responses', async () => {
  const ids=['storeConnectionStatus','storeConnectionForm','storeConnectionFields','storeCredentialStatus','storePlatform','storeDomain','storeAccessToken','storeConsumerKey','storeConsumerSecret','storeApiToken','storeConnectionDetails','genericCredentialFields','storeRemoveCredentials','storeConnectionReload','storeStorageWarning','shopifyCredentialFields','wooCredentialFields','tabStoreSettings'];
  const elements=Object.fromEntries(ids.map(id=>[id,{
    value:'',textContent:'',hidden:false,disabled:false,checked:false,style:{},
    classList:{toggle(){}},addEventListener(){},reset(){}
  }]));
  const context=vm.createContext({
    document:{getElementById:id=>elements[id]||null,querySelectorAll:()=>[],addEventListener(){}},
    window:{location:{hostname:'localhost'},addEventListener(){}},URL,AbortController,setTimeout,clearTimeout
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/app.js'),'utf8'),context);
  vm.runInContext("state.auth=true;state.activeClientId='CL-004';state.session={clientId:'CL-004',role:'client',notificationToken:'signed'}",context);
  const config={platform:'shopify',domain:'https://shop.myshopify.com',storageReady:true,hasCredentials:true,automationEnabled:false};
  context.fetch=async()=>({ok:true,json:async()=>({success:true,clientId:'CL-004',connection:config})});
  await context.loadStoreConnection();
  assert.equal(elements.storeConnectionFields.disabled,false);
  assert.equal(elements.storeDomain.value,config.domain);
  assert.equal(elements.storeAccessToken.value,'');
  assert.match(elements.storeCredentialStatus.textContent,/not been tested/);
  elements.storeAccessToken.value='synthetic-ui-token';
  let saved;
  context.fetch=async(url,options)=>{
    assert.equal(url,'/api/store-connection');
    saved=JSON.parse(options.body);
    return {ok:true,json:async()=>({success:true,clientId:'CL-004',connection:config})};
  };
  await context.saveStoreConnection({preventDefault(){}});
  assert.equal(saved.accessToken,'synthetic-ui-token');
  assert.equal(elements.storeAccessToken.value,'');
  assert.ok(!vm.runInContext('JSON.stringify(state)',context).includes('synthetic-ui-token'));
  elements.storeAccessToken.value='synthetic-failed-token';
  context.fetch=async()=>({ok:false,json:async()=>({success:false,error:'Storage unavailable'})});
  await context.saveStoreConnection({preventDefault(){}});
  assert.equal(elements.storeAccessToken.value,'');
  assert.match(elements.storeConnectionStatus.textContent,/Storage unavailable/);
  assert.equal(elements.storeConnectionFields.disabled,false);
  elements.storePlatform.value='woocommerce';
  context.syncStorePlatform();
  assert.equal(elements.wooCredentialFields.hidden,false);
  assert.equal(elements.shopifyCredentialFields.hidden,true);
  assert.equal(elements.storeConsumerSecret.disabled,false);
  for (const platform of ['bigcommerce','amazon','wix','custom']) {
    elements.storePlatform.value=platform;
    context.syncStorePlatform();
    assert.equal(elements.genericCredentialFields.hidden,false);
    assert.equal(elements.wooCredentialFields.hidden,true);
    assert.equal(elements.shopifyCredentialFields.hidden,true);
    assert.equal(elements.storeApiToken.disabled,false);
    assert.equal(elements.storeConnectionDetails.disabled,false);
    assert.equal(elements.storeAccessToken.disabled,true);
    assert.equal(elements.storeConsumerSecret.disabled,true);
    elements.storeApiToken.value='synthetic-generic-token';
    elements.storeConnectionDetails.value='Synthetic store ID\nSynthetic marketplace ID';
    context.fetch=async(url,options)=>{
      saved=JSON.parse(options.body);
      return {ok:true,json:async()=>({success:true,clientId:'CL-004',connection:{...config,platform}})};
    };
    await context.saveStoreConnection({preventDefault(){}});
    assert.equal(saved.platform,platform);
    assert.equal(saved.accessToken,'synthetic-generic-token');
    assert.equal(saved.connectionDetails,'Synthetic store ID\nSynthetic marketplace ID');
    assert.equal(saved.consumerKey,undefined);
    assert.equal(elements.storeApiToken.value,'');
    assert.equal(elements.storeConnectionDetails.value,'');
    assert.ok(!vm.runInContext('JSON.stringify(state)',context).includes('synthetic-generic-token'));
  }
  let finish;
  context.fetch=()=>new Promise(resolve=>{finish=resolve;});
  const pending=context.loadStoreConnection();
  vm.runInContext("state.activeClientId='CL-005';resetStoreConnection()",context);
  finish({ok:true,json:async()=>({success:true,clientId:'CL-004',connection:config})});
  await pending;
  assert.equal(elements.storeConnectionFields.disabled,true);
  assert.equal(elements.storeConnectionStatus.textContent,'');
  vm.runInContext("state.session={clientId:'CL-000',role:'staff'};updateStoreSettingsAccess()",context);
  assert.equal(elements.tabStoreSettings.style.display,'','staff can access branding-only Settings');
  await context.loadStoreConnection();
  assert.match(elements.storeConnectionStatus.textContent,/account owner or an administrator/);
  vm.runInContext("state.session={clientId:'CL-000',role:'admin'};updateStoreSettingsAccess()",context);
  assert.equal(elements.tabStoreSettings.style.display,'');
  context.fetch=async()=>({ok:true,json:async()=>({success:true,clientId:'CL-005',connection:{...config,storageReady:false}})});
  await context.loadStoreConnection();
  assert.equal(elements.storeStorageWarning.hidden,false);
  assert.equal(elements.storeAccessToken.disabled,true);
  elements.storeDomain.value='https://shop.myshopify.com';
  context.fetch=async(url,options)=>{
    saved=JSON.parse(options.body);
    return {ok:true,json:async()=>({success:true,clientId:'CL-005',connection:{...config,storageReady:false}})};
  };
  await context.saveStoreConnection({preventDefault(){}});
  assert.ok(!('accessToken' in saved)&&!('consumerSecret' in saved));
  const html=fs.readFileSync(require.resolve('../frontend/index.html'),'utf8');
  assert.match(html,/API integration is completely optional/);
  assert.match(html,/currently has no order webhook receiver/);
  assert.match(html,/client credentials grant/);
  assert.match(html,/WooCommerce.*REST API/);
});

test('catalog UI preserves manual edits, imports only on review, and ignores stale account fetches', async () => {
  const ids=['catalogSyncForm','catalogSourceUrl','catalogSyncSubmit','catalogSyncMessage','catalogProductPicker','catalogProductSelect','catalogReplaceExisting','catalogSyncPanel','catalogImagePreview','catalogImageMessage','newProductTitle','newProductTitleWrap','newProductSku','newProductQty','customField_imageUrl','customField_bundled','customField_bundleQty','createProductSubmit'];
  const elements=Object.fromEntries(ids.map(id=>[id,{
    value:'',hidden:true,disabled:false,readOnly:false,checked:false,style:{},dataset:{},tagName:'INPUT',
    classList:{toggle(){}},addEventListener(){},removeAttribute(key){delete this[key];},focus(){}
  }]));
  elements.newProductQty.value='5';
  elements.catalogSourceUrl.value='https://store.example/products.json';
  const context=vm.createContext({
    document:{getElementById:id=>elements[id]||null,querySelectorAll:()=>[],addEventListener(){}},
    window:{location:{hostname:'localhost'},addEventListener(){}},URL,AbortController,setTimeout,clearTimeout
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/app.js'),'utf8'),context);
  vm.runInContext("state.auth=true;state.activeClientId='CL-004';state.session={clientId:'CL-004',role:'client',notificationToken:'signed'};state.clientProfile={clientId:'CL-004',fields:[],readOnly:false,enableAddItem:true};fetchInventory=async()=>200;showToast=()=>{};",context);
  let calls=0;
  const product={title:'Imported <product>',sku:'CAT-1',imageUrl:'https://images.example/item.png',bundled:'Y',bundleQty:'3'};
  context.fetch=async(url,options)=>{
    calls+=1;
    assert.equal(url,'/api/catalog/sync');
    assert.equal(options.headers.Authorization,'Bearer signed');
    assert.deepEqual(JSON.parse(options.body),{clientId:'CL-004',url:'https://store.example/products.json'});
    return {ok:true,status:200,json:async()=>({success:true,products:[product,{...product,title:'Second'}]})};
  };
  const event={preventDefault(){}};
  elements.newProductTitle.value='Manual title';
  await context.syncCatalog(event);
  assert.equal(calls,1);
  assert.equal(elements.newProductTitle.value,'Manual title','fetching metadata never changes manual values');
  assert.equal(elements.catalogProductPicker.hidden,false);
  assert.match(elements.catalogProductSelect.innerHTML,/Imported &lt;product&gt;/);
  context.applyCatalogProduct();
  assert.equal(elements.newProductTitle.value,'Manual title','review preserves manual entries unless overwrite is explicitly selected');
  assert.equal(elements.newProductSku.value,'CAT-1');
  assert.equal(elements.customField_imageUrl.value,product.imageUrl);
  assert.equal(elements.customField_bundled.value,'Y');
  assert.equal(elements.customField_bundleQty.value,'3');
  assert.equal(elements.catalogImagePreview.src,product.imageUrl);
  assert.match(elements.catalogSyncMessage.textContent,/Existing entries were kept/);
  elements.catalogReplaceExisting.checked=true;
  context.applyCatalogProduct();
  assert.equal(elements.newProductTitle.value,product.title);
  elements.newProductTitle.value='Manually edited after import';
  let saved;
  context.fetch=async(url,options)=>{
    assert.equal(url,'/api/inventory/create');
    saved=JSON.parse(options.body);
    return {ok:true,json:async()=>({success:true})};
  };
  await context.createProduct();
  assert.equal(saved.title,'Manually edited after import');
  assert.equal(saved.extraFields.imageUrl,product.imageUrl);
  assert.equal(saved.extraFields.bundled,'Y');
  assert.equal(saved.extraFields.bundleQty,'3');
  assert.equal(elements.catalogImagePreview.hidden,true);
  elements.newProductTitle.value='Keep this draft';
  context.fetch=async()=>({ok:false,status:422,json:async()=>({success:false,error:'Metadata unavailable'})});
  await context.syncCatalog(event);
  assert.equal(elements.newProductTitle.value,'Keep this draft');
  assert.match(elements.catalogSyncMessage.textContent,/manually/);
  assert.equal(elements.catalogSyncSubmit.disabled,false);
  let finish;
  context.fetch=()=>new Promise(resolve=>{finish=resolve;});
  const pending=context.syncCatalog(event);
  vm.runInContext("state.activeClientId='CL-005';resetCatalogSync();",context);
  finish({ok:true,status:200,json:async()=>({success:true,products:[product]})});
  await pending;
  assert.equal(elements.catalogProductPicker.hidden,true);
  assert.equal(elements.catalogSourceUrl.value,'');
  assert.equal(elements.catalogImagePreview.hidden,true);
  assert.equal(elements.catalogSyncMessage.textContent,'');
});

test('tracking carrier detection handles USPS/FedEx overlap, formatting and invalid inputs safely', () => {
  const context = vm.createContext({
    document:{getElementById:()=>null,querySelectorAll:()=>[],addEventListener(){}},
    window:{location:{hostname:'localhost'},addEventListener(){}},AbortController,setTimeout,clearTimeout
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/app.js'),'utf8'),context);
  for (const [value,name] of [
    [' 1z999aa10123456784 ', 'UPS'],
    ['123456789012','FedEx'],['123456789012345','FedEx'],['12345678901234567890','FedEx'],
    ['9400111899223856928499','USPS'],['94001118992238569284','USPS'],['940011189922385692849','USPS'],
    ['82001118992238569284','USPS'],['820011189922385692849','USPS'],['8200111899223856928499','USPS'],
    ['9400 1118 9922 3856 9284 99','USPS'],['1234-5678-9012','FedEx']
  ]) {
    const detected = context.detectTrackingCarrier(value);
    assert.equal(detected.name,name,value);
    const url = new URL(detected.url);
    assert.equal(url.protocol,'https:');
    assert.ok(['www.ups.com','www.fedex.com','tools.usps.com'].includes(url.hostname));
    assert.ok([...url.searchParams.values()].includes(context.normalizeTrackingNumber(value)));
  }
  for (const value of ['', '1Z', '12345678901', '1234567890123', '1234567890123456', '123456789012345678901', '9'.repeat(19), '9'.repeat(23), '83'+'1'.repeat(19), 'javascript:alert(1)', '<img src=x onerror=alert(1)>']) {
    assert.equal(context.detectTrackingCarrier(value),null,value);
  }
  assert.equal(context.normalizeTrackingNumber('000012345678'),'000012345678');
  const unsafe = context.trackingCarrierMarkup('<script>alert(1)</script>');
  assert.doesNotMatch(unsafe,/<script>|href=/);
  assert.match(unsafe,/&lt;script&gt;/);
  assert.match(context.trackingCarrierMarkup('123456789012'),/target="_blank" rel="noopener noreferrer"/);
});

test('tracking renders sheet progression, filters independently and clears stale account responses', async () => {
  const elements = Object.fromEntries(['trackingResults','trackingSummary','trackingError','trackingRefresh','trackingCarrierPreview','trackingSearchInput'].map((id)=>[id,{
    innerHTML:'',textContent:'',value:'',hidden:false,disabled:false,addEventListener(){},setAttribute(key,value){this[key]=value;}
  }]));
  const context = vm.createContext({
    document:{getElementById:(id)=>elements[id]||null,querySelectorAll:()=>[],addEventListener(){}},
    window:{location:{hostname:'localhost'},addEventListener(){}},AbortController,setTimeout,clearTimeout
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/app.js'),'utf8'),context);
  vm.runInContext("state.auth=true;state.session={clientId:'CL-004',notificationToken:'signed'};state.activeClientId='CL-004';state.filters.stock=['out'];",context);
  const items = [
    {id:'a',sku:'SKU-1',title:'Widget <script>',status:'Arrived / Check-In',stage:1,checkInTimestamp:'2026-11-10T09:00:00Z',trackingNumbers:[{label:'Incoming <tracking>',number:'1Z999AA10123456784'}]},
    {id:'b',sku:'SKU-2',title:'Another item',status:'In Prep',stage:2,checkInTimestamp:'',trackingNumbers:[{label:'Tracking #',number:'9400111899223856928499'}]},
    {id:'c',sku:'STOCK',title:'Stock item',status:'In Stock',stage:null,checkInTimestamp:'',trackingNumbers:[]}
  ];
  context.fetch = async (url,options)=>{
    assert.match(url,/clientId=CL-004/);
    assert.equal(options.headers.Authorization,'Bearer signed');
    return {ok:true,status:200,json:async()=>({clientId:'CL-004',updatedAt:'2026-11-10T09:00:00Z',items})};
  };
  assert.equal(await context.loadTracking(),200);
  const host = elements.trackingResults;
  assert.equal((host.innerHTML.match(/class="tracking-card"/g)||[]).length,3);
  assert.match(host.innerHTML,/Widget &lt;script&gt;/);
  assert.doesNotMatch(host.innerHTML,/<script>/);
  assert.match(host.innerHTML,/Incoming &lt;tracking&gt;/);
  assert.match(host.innerHTML,/aria-current="step"><span class="tracking-step-dot" aria-hidden="true">2/);
  assert.match(host.innerHTML,/Arrived at Warehouse/);
  assert.match(host.innerHTML,/Warehouse check-in/);
  assert.match(host.innerHTML,/Warehouse fulfillment progression is not available/);
  assert.match(host.innerHTML,/tools.usps.com/);
  const event = {preventDefault(){}};
  elements.trackingSearchInput.value = ' 1z999aa10123456784 ';
  context.searchTracking(event);
  assert.equal((host.innerHTML.match(/class="tracking-card"/g)||[]).length,1);
  assert.match(elements.trackingCarrierPreview.innerHTML,/UPS/);
  elements.trackingSearchInput.value = 'SKU-2';
  context.searchTracking(event);
  assert.match(host.innerHTML,/Another item/);
  assert.doesNotMatch(host.innerHTML,/Widget/);
  elements.trackingSearchInput.value = '123456789012';
  context.searchTracking(event);
  assert.match(host.innerHTML,/No matching records in this account/);
  assert.doesNotMatch(host.innerHTML,/tracking-progress/);
  assert.match(elements.trackingCarrierPreview.innerHTML,/FedEx/);
  elements.trackingSearchInput.value = '';
  context.searchTracking(event);
  items[0].stage=3;items[0].status='Shipped out';
  await context.loadTracking();
  assert.match(host.innerHTML,/aria-current="step"><span class="tracking-step-dot" aria-hidden="true">4/);
  context.fetch = async()=>({ok:false,status:429});
  assert.equal(await context.loadTracking(),429);
  assert.equal(elements.trackingError.hidden,false);
  assert.match(elements.trackingError.textContent,/Previously loaded progress may be out of date/);
  assert.match(host.innerHTML,/Widget/,'a refresh failure keeps last-good data with an explicit stale warning');
  let finish;
  context.fetch = ()=>new Promise(resolve=>{finish=resolve;});
  const pending = context.loadTracking();
  vm.runInContext("state.activeClientId='CL-005';resetTracking();",context);
  finish({ok:true,status:200,json:async()=>({clientId:'CL-004',items,updatedAt:''})});
  await pending;
  assert.doesNotMatch(host.innerHTML,/Widget|Another item|1Z999/);
  assert.equal(elements.trackingSearchInput.value,'');
  assert.equal(elements.trackingCarrierPreview.innerHTML,'');
  vm.runInContext("state.auth=false;resetTracking();",context);
  assert.equal(await context.loadTracking(),401);
});

test('camera scanning reports errors, suppresses duplicate decodes, and releases cancelled camera starts', async () => {
  const elements = Object.fromEntries(['barcodeCameraPanel', 'barcodeScanInput', 'barcodeScanMessage'].map((id) => [id, {
    hidden: true, value: '', textContent: '', classList: { toggle() {}, add() {}, remove() {} }
  }]));
  let trackStopCount = 0;
  const video = { srcObject: null };
  elements.barcodeCameraReader = {
    querySelectorAll: () => [video],
    replaceChildren() { this.cleared = true; }
  };
  const attachStream = () => {
    video.srcObject = { getTracks: () => [{ stop() { trackStopCount += 1; } }] };
  };
  const listeners = {};
  let decode;
  let finishStart;
  let stopCount = 0;
  let clearCount = 0;
  let beepCount = 0;
  let audioCloseCount = 0;
  class Audio {
    currentTime = 0;
    destination = {};
    async resume() {}
    async close() { audioCloseCount += 1; }
    createGain() { return { gain: {}, connect() {} }; }
    createOscillator() {
      return { frequency: {}, connect() {}, start() { beepCount += 1; }, stop() { this.onended(); } };
    }
  }
  class Camera {
    isScanning = false;
    getState() { return this.reportedState ?? (this.isScanning ? 2 : 1); }
    start(_device, _options, callback) {
      decode = callback;
      return new Promise((resolve) => { finishStart = () => { this.isScanning = true; resolve(); }; });
    }
    async stop() { this.isScanning = false; stopCount += 1; }
    clear() { clearCount += 1; }
  }
  const context = vm.createContext({
    document: { getElementById: (id) => elements[id] || null, querySelectorAll: () => [], addEventListener(name, callback) { (listeners[name] ||= []).push(callback); } },
    window: { AudioContext: Audio, location: { hostname: 'localhost' }, isSecureContext: true, addEventListener(name, callback) { (listeners[name] ||= []).push(callback); } },
    navigator: { mediaDevices: { getUserMedia() {} } },
    Html5Qrcode: Camera, Html5QrcodeScannerState: { SCANNING: 2, PAUSED: 3 }, AbortController, setTimeout, clearTimeout
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8'), context);
  vm.runInContext("state.auth=true;state.isAdmin=true;state.activeClientId='CL-002';state.session={role:'admin'};scanBarcode=async()=>{scanCount+=1;};", context);
  context.scanCount = 0;
  const cancelled = context.startBarcodeCamera();
  attachStream();
  await context.stopBarcodeCamera();
  assert.equal(trackStopCount, 1, 'tracks stop immediately even while camera start is pending');
  assert.equal(video.srcObject, null);
  assert.equal(elements.barcodeCameraPanel.hidden, true, 'cancel hides pending camera immediately');
  attachStream();
  finishStart();
  await cancelled;
  assert.equal(stopCount, 1);
  assert.equal(clearCount, 1);
  assert.equal(trackStopCount, 2, 'late startup streams are stopped as well');
  assert.equal(elements.barcodeCameraReader.cleared, true);
  assert.equal(elements.barcodeCameraPanel.hidden, true);
  const started = context.startBarcodeCamera();
  finishStart();
  await started;
  attachStream();
  await decode('');
  assert.equal(context.scanCount, 0);
  assert.match(elements.barcodeScanMessage.textContent, /could not be read/);
  await Promise.all([decode('012345678901'), decode('012345678901')]);
  assert.equal(context.scanCount, 1);
  assert.equal(beepCount, 1, 'a successful decode gives one immediate audio confirmation');
  assert.equal(audioCloseCount, 2, 'cancelled and successful audio contexts are released');
  assert.equal(elements.barcodeScanInput.value, '012345678901');
  assert.equal(stopCount, 2);
  assert.equal(trackStopCount, 3);
  assert.equal(elements.barcodeCameraPanel.hidden, true);
  for (const reason of ['escape', 'pagehide', 'visibilitychange', 'navigation', 'account-change']) {
    const opening = context.startBarcodeCamera();
    finishStart();
    await opening;
    attachStream();
    const previous = trackStopCount;
    if (reason === 'escape') listeners.keydown.forEach(callback => callback({ key: 'Escape' }));
    if (reason === 'pagehide') listeners.pagehide.forEach(callback => callback());
    if (reason === 'visibilitychange') {
      context.document.hidden = true;
      listeners.visibilitychange.forEach(callback => callback());
      context.document.hidden = false;
    }
    if (reason === 'navigation') context.setPage('page-dashboard');
    if (reason === 'account-change') context.resetBarcodeCheckIn();
    assert.equal(trackStopCount, previous + 1, `${reason} immediately stops camera tracks`);
    await context.stopBarcodeCamera();
    assert.equal(elements.barcodeCameraPanel.hidden, true);
    assert.equal(vm.runInContext('barcodeCamera', context), null);
  }
  const failingLookup = context.startBarcodeCamera();
  finishStart();
  await failingLookup;
  vm.runInContext("scanBarcode=async()=>{throw new Error('lookup unavailable');};", context);
  await decode('00mixed-Case');
  assert.equal(elements.barcodeScanInput.value, '00mixed-Case', 'decoded text and leading zeros are preserved exactly');
  assert.match(elements.barcodeScanMessage.textContent, /lookup unavailable/);
  assert.equal(vm.runInContext('barcodeDecodeBusy', context), false, 'failed lookup allows another scan');
  let finishStop;
  context.Html5Qrcode = class extends Camera {
    stop() {
      return new Promise(resolve => { finishStop = () => { this.isScanning = false; resolve(); }; });
    }
  };
  const leavingDuringDecode = context.startBarcodeCamera();
  finishStart();
  await leavingDuringDecode;
  vm.runInContext('scanBarcode=async()=>{scanCount+=1;};', context);
  const staleDecode = decode('stale-code');
  const previousScans = context.scanCount;
  context.resetBarcodeCheckIn();
  finishStop();
  await staleDecode;
  assert.equal(context.scanCount, previousScans, 'navigation during shutdown cannot submit a stale decode');
  context.Html5Qrcode = class extends Camera {
    async start() { this.reportedState = 2; }
  };
  await context.startBarcodeCamera();
  assert.equal(elements.barcodeCameraPanel.hidden, false, 'running state remains active before the first video frame');
  const stopsBeforeFirstFrame = stopCount;
  await context.stopBarcodeCamera();
  assert.equal(stopCount, stopsBeforeFirstFrame + 1, 'running state is stopped even before isScanning becomes true');
  context.Html5Qrcode = class extends Camera {
    async stop() { throw new Error('device disconnected'); }
    clear() { throw new Error('reader disconnected'); }
  };
  const failingCleanup = context.startBarcodeCamera();
  finishStart();
  await failingCleanup;
  attachStream();
  await context.stopBarcodeCamera();
  assert.equal(video.srcObject, null);
  assert.equal(vm.runInContext('barcodeCamera', context), null);
  assert.match(elements.barcodeScanMessage.textContent, /Unable to clear scanner/);
  context.Html5Qrcode = class extends Camera {
    async start() { throw new Error('Permission denied'); }
  };
  await context.startBarcodeCamera();
  assert.match(elements.barcodeScanMessage.textContent, /Permission denied/);
  assert.equal(elements.barcodeCameraPanel.hidden, true);
  context.window.isSecureContext = false;
  await context.startBarcodeCamera();
  assert.match(elements.barcodeScanMessage.textContent, /HTTPS/);
});

test('camera viewfinder has a responsive non-interactive targeting overlay and close instructions', () => {
  const html = fs.readFileSync(require.resolve('../frontend/index.html'), 'utf8');
  const css = fs.readFileSync(require.resolve('../frontend/styles.css'), 'utf8');
  assert.match(html, /class="barcode-viewfinder"[\s\S]*?id="barcodeCameraReader"[\s\S]*?class="barcode-target" aria-hidden="true"/);
  assert.match(html, /id="barcodeCameraStop">Close camera/);
  assert.match(css, /\.barcode-target \{[^}]*width: 80%;[^}]*pointer-events: none;/);
  assert.match(css, /\.barcode-target span \{[^}]*height: 2px;[^}]*box-shadow:/);
});

test('barcode check-in matches active UPC/SKU/tracking, verifies ambiguous items and records arrival without quantities', async () => {
  const listeners = {};
  const elements = Object.fromEntries([
    'barcodeScanForm', 'barcodeScanInput', 'barcodeScanSubmit', 'barcodeConfirmForm', 'barcodeScanMatch',
    'barcodeConfirmSubmit', 'barcodeScanPreview', 'barcodeScanMessage', 'newProductSku', 'customField_shipmentCode', 'createProductSubmit'
  ].map((id) => [id, {
    value: '', dataset: {}, hidden: false, disabled: false, innerHTML: '', textContent: '', classList: { toggle() {}, add() {}, remove() {} },
    focus() { this.focused = true; }, addEventListener(type, fn) { listeners[`${id}:${type}`] = fn; }
  }]));
  let requests = [];
  let fail = false;
  const context = vm.createContext({
    document: {
      getElementById: (id) => elements[id] || null, querySelector: () => null,
      querySelectorAll: () => [], addEventListener() {}
    },
    window: { location: { hostname: 'localhost' }, addEventListener() {} },
    setTimeout: () => 0, clearTimeout() {}, console,
    fetch: async (url, options) => {
      requests.push({ url, method: options.method, body: JSON.parse(options.body) });
      return fail
        ? { ok: false, json: async () => ({ error: 'Shipment totals changed.' }) }
        : { ok: true, json: async () => ({ success: true }) };
    }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8'), context);
  vm.runInContext(`state.auth = true; state.isAdmin = true; state.activeClientId = 'CL-004';
    state.session = {clientId:'CL-000'};
    state.clientProfile = {clientId:'CL-004', inventoryMode:'custom', fields:[
      {key:'quantityReceived',label:'Quantity Received'}, {key:'quantityShipped',label:'Quantity Shipped'},
      {key:'shipmentCode',label:'Tracking Number'}
    ]};
    state.items = [
      {id:'CL-004-1', clientId:'CL-004', title:'Widget <one>',upc:'00123',trackingNumber:'TRACK-1',quantityReceived:8,quantityShipped:3},
      {id:'CL-004-2', clientId:'CL-004', title:'Widget two',sku:'SKU-2',upc:'00123',shipmentCode:'CUSTOM-2',quantityReceived:4,quantityShipped:0},
      {id:'CL-004-3', clientId:'CL-004', title:'Shipped widget',upc:'00123',status:'Shipped out',quantityReceived:4,quantityShipped:4},
      {id:'CL-005-1', clientId:'CL-005', title:'Other account',upc:'00123',quantityReceived:99,quantityShipped:0}
    ]; fetchInventory = async () => 200;renderProductForm=()=>{};showPage=()=>{};showToast=()=>{};`, context);
  const matchingIds = (code) => Array.from(vm.runInContext(`findBarcodeMatches(state.items, ${JSON.stringify(code)}, 'CL-004', state.clientProfile.fields).map(item => item.id)`, context));
  assert.deepEqual(matchingIds('  track-1\r\n'), ['CL-004-1']);
  assert.deepEqual(matchingIds('00123'), ['CL-004-1', 'CL-004-2']);
  assert.deepEqual(matchingIds('123'), []);
  assert.deepEqual(matchingIds('TRACK'), []);
  assert.deepEqual(matchingIds('custom-2'), ['CL-004-2']);
  assert.deepEqual(matchingIds('sku-2'), ['CL-004-2']);
  assert.deepEqual(matchingIds(''), []);
  const event = { preventDefault() {} };
  elements.barcodeScanInput.value = '00123';
  await listeners['barcodeScanForm:submit'](event);
  assert.equal(elements.barcodeConfirmForm.hidden, false);
  assert.match(elements.barcodeScanMatch.innerHTML, /Choose an item/);
  assert.match(elements.barcodeScanMatch.innerHTML, /Widget &lt;one&gt;/);
  await listeners['barcodeConfirmForm:submit'](event);
  assert.equal(requests.length, 0);
  assert.match(elements.barcodeScanMessage.textContent, /Choose/);
  elements.barcodeScanMatch.value = 'CL-004-1';
  listeners['barcodeScanMatch:change']();
  assert.match(elements.barcodeScanPreview.textContent, /Quantities remain unchanged/);
  const first = listeners['barcodeConfirmForm:submit'](event);
  const duplicate = listeners['barcodeConfirmForm:submit'](event);
  await Promise.all([first, duplicate]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/inventory/check-in');
  assert.equal(requests[0].method, 'POST');
  assert.deepEqual(requests[0].body, {
    clientId:'CL-004', itemId:'CL-004-1', title:'Widget <one>',
    code:'00123'
  });
  assert.equal(elements.barcodeConfirmForm.hidden, true);
  assert.equal(elements.barcodeScanInput.disabled, false);
  assert.equal(elements.barcodeScanInput.focused, true);
  assert.match(elements.barcodeScanMessage.textContent, /Arrival recorded/);
  elements.barcodeScanInput.value = 'NO-MATCH';
  elements.createProductSubmit.disabled = false;
  await listeners['barcodeScanForm:submit'](event);
  assert.equal(elements.customField_shipmentCode.value, 'NO-MATCH', elements.barcodeScanMessage.textContent);
  assert.equal(elements.barcodeConfirmForm.hidden, true);
  fail = true;
  elements.barcodeScanInput.value = 'TRACK-1';
  await listeners['barcodeScanForm:submit'](event);
  assert.match(elements.barcodeScanMessage.textContent, /Shipment totals changed/);
  assert.equal(elements.barcodeConfirmForm.hidden, true);
  await listeners['barcodeConfirmForm:submit'](event);
  assert.equal(requests.length, 2, 'a failed/uncertain write cannot be retried without rescanning');
  vm.runInContext('state.isAdmin = false; syncBarcodeCheckIn()', context);
  assert.equal(elements.barcodeScanInput.disabled, true);
  await listeners['barcodeScanForm:submit'](event);
  assert.equal(requests.length, 2);
  vm.runInContext("state.isAdmin = true; fetchInventory = async () => 429", context);
  elements.barcodeScanInput.value = 'TRACK-1';
  await listeners['barcodeScanForm:submit'](event);
  assert.match(elements.barcodeScanMessage.textContent, /Unable to refresh/);
  assert.equal(elements.barcodeConfirmForm.hidden, true);
  vm.runInContext("fetchInventory = async () => {state.activeClientId = 'CL-005'; resetBarcodeCheckIn(); return 200;}", context);
  elements.barcodeScanInput.value = 'TRACK-1';
  await listeners['barcodeScanForm:submit'](event);
  assert.equal(elements.barcodeConfirmForm.hidden, true);
});

test('staff settings UI is administrator-only, escapes account data and preserves failed form edits', async () => {
  const listeners = {};
  const elements = Object.fromEntries([
    'staffAccountsSection', 'staffAccountsList', 'staffAccountForm', 'staffAccountFormTitle',
    'staffAccountUsername','staffAccountName','staffAccountEmail','staffAccountSave','staffAccountCancel',
    'staffAccountMessage','staffAccountsRefresh'
  ].map((id) => [id, {
    hidden:false, textContent:'', innerHTML:'', value:'', disabled:false, readOnly:false, classList:{toggle(){}},
    addEventListener(type, fn) { listeners[`${id}:${type}`] = fn; }, focus(){},
    replaceChildren(){this.innerHTML='';},
    reset() { for (const key of ['staffAccountUsername','staffAccountName','staffAccountEmail']) elements[key].value=''; }
  }]));
  const requests = [];
  let fail = false;
  const accounts = [
    {clientId:'CL-000',username:'Owner',name:'Owner',role:'admin',email:'',activated:true},
    {clientId:'CL-000',username:'Warehouse',name:'Staff <name>',role:'staff',email:'staff@example.com',activated:true}
  ];
  const context = vm.createContext({
    document: {
      getElementById: (id) => elements[id] || null, querySelector: () => null,
      querySelectorAll: () => [], addEventListener() {}
    },
    window: {location:{hostname:'localhost'},addEventListener(){}},
    setTimeout: () => 0, clearTimeout(){}, console,
    fetch: async (url, options) => {
      requests.push({url,method:options.method || 'GET',body:options.body && JSON.parse(options.body)});
      if (fail) return {ok:false,json:async()=>({error:'Sheet unavailable'})};
      return {ok:true,json:async()=>options.method === 'POST'
        ? {success:true,username:'NewStaff',activationCode:'ABCD-EFGH'}
        : options.method === 'PUT' ? {success:true} : accounts};
    }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/app.js'),'utf8'),context);
  vm.runInContext("state.auth=true;state.isAdmin=true;state.session={clientId:'CL-000',role:'staff'}",context);
  assert.equal(vm.runInContext('canConfigureStaff()',context),false);
  await vm.runInContext('loadStaffAccounts()',context);
  await listeners['staffAccountForm:submit']({preventDefault(){}});
  assert.equal(requests.length,0);
  vm.runInContext("state.session={clientId:'CL-000',role:'admin'}",context);
  await vm.runInContext('loadStaffAccounts()',context);
  assert.match(elements.staffAccountsList.innerHTML,/Staff &lt;name&gt;/);
  assert.match(elements.staffAccountsList.innerHTML,/data-username="Warehouse"/);
  assert.doesNotMatch(elements.staffAccountsList.innerHTML,/data-username="Owner"/);
  vm.runInContext("editStaffAccount('Warehouse')",context);
  assert.equal(elements.staffAccountUsername.value,'Warehouse');
  assert.equal(elements.staffAccountUsername.readOnly,true);
  elements.staffAccountName.value='Changed staff';
  fail=true;
  await listeners['staffAccountForm:submit']({preventDefault(){}});
  assert.equal(elements.staffAccountName.value,'Changed staff');
  assert.equal(elements.staffAccountMessage.textContent,'Sheet unavailable');
  assert.equal(elements.staffAccountSave.disabled,false);
  fail=false;
  await listeners['staffAccountForm:submit']({preventDefault(){}});
  const put=requests.find((entry)=>entry.method==='PUT');
  assert.equal(put.url,'/api/admin/staff/Warehouse');
  assert.deepEqual(put.body,{name:'Changed staff',email:'staff@example.com'});
  assert.equal(elements.staffAccountUsername.readOnly,false);
  elements.staffAccountUsername.value='NewStaff';
  elements.staffAccountName.value='New staff';
  elements.staffAccountEmail.value='';
  await listeners['staffAccountForm:submit']({preventDefault(){}});
  assert.match(elements.staffAccountMessage.textContent,/Activation code: ABCD-EFGH/);
  assert.deepEqual(requests.find((entry)=>entry.method==='POST').body,{name:'New staff',email:'',username:'NewStaff'});
  vm.runInContext('clearStaffAccounts()',context);
  assert.equal(elements.staffAccountsSection.hidden,true);
  assert.equal(elements.staffAccountsList.innerHTML,'');
  assert.equal(elements.staffAccountMessage.textContent,'');
});

test('login history UI gates staff access, escapes audit values, handles errors and discards stale responses', async () => {
  const elements = Object.fromEntries(['loginHistorySection','loginHistoryRows','loginHistoryMessage'].map((id) =>
    [id, { hidden: false, innerHTML: '', textContent: '', addEventListener() {} }]));
  let requests = 0;
  let mode = 'success';
  let resolvePending;
  const context = vm.createContext({
    document: { getElementById: (id) => elements[id] || null, querySelectorAll: () => [], addEventListener() {} },
    window: { location: { hostname: 'localhost' }, addEventListener() {} },
    setTimeout: () => 0, clearTimeout() {}, console,
    fetch: async (url, options) => {
      requests += 1;
      assert.equal(url, '/api/admin/logins');
      assert.ok(options.headers.Authorization);
      if (mode === 'pending') return new Promise((resolve) => { resolvePending = resolve; });
      if (mode === 'error') return { ok: false, json: async () => ({ error: 'Audit unavailable' }) };
      return { ok: true, json: async () => mode === 'empty' ? [] : [{
        timestamp: '2026-11-10T07:00:00.000Z', username: '<script>bad</script>', clientId: 'CL-005', authType: 'Auto-Login'
      }] };
    }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8'), context);
  vm.runInContext("state.auth=true;state.session={clientId:'CL-000',role:'staff'}", context);
  await vm.runInContext('loadLoginHistory()', context);
  assert.equal(requests, 0);
  vm.runInContext("state.session={clientId:'CL-000',role:'admin',notificationToken:'test-token'}", context);
  await vm.runInContext('loadLoginHistory()', context);
  assert.match(elements.loginHistoryRows.innerHTML, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.match(elements.loginHistoryRows.innerHTML, /Auto-Login/);
  assert.doesNotMatch(elements.loginHistoryRows.innerHTML, /<script>/);
  mode = 'error';
  await vm.runInContext('loadLoginHistory()', context);
  assert.equal(elements.loginHistoryMessage.textContent, 'Audit unavailable');
  assert.equal(elements.loginHistoryRows.innerHTML, '');
  mode = 'empty';
  await vm.runInContext('loadLoginHistory()', context);
  assert.equal(elements.loginHistoryMessage.textContent, 'No sign-ins recorded yet.');
  mode = 'pending';
  const pending = vm.runInContext('loadLoginHistory()', context);
  vm.runInContext('clearLoginHistory();state.session=null;state.auth=false;', context);
  resolvePending({ ok: true, json: async () => [{ username: 'Late entry' }] });
  await pending;
  assert.equal(elements.loginHistoryRows.innerHTML, '');
  assert.equal(elements.loginHistoryMessage.textContent, '');
  assert.equal(elements.loginHistorySection.hidden, true);
});

test('chat Drive attachment area uses theme colors without inline background overrides', () => {
  const html = fs.readFileSync(require.resolve('../frontend/index.html'), 'utf8');
  const css = fs.readFileSync(require.resolve('../frontend/styles.css'), 'utf8');
  assert.match(html, /<div class="chat-file-row">/);
  assert.doesNotMatch(html.match(/<input[^>]*id="chatFileUrl"[^>]*>/)[0], /style=/);
  assert.match(html, /id="chatFileUrl" aria-label="Google Drive file URL \(optional\)"/);
  const row = css.match(/\.chat-file-row \{([^}]+)\}/)[1];
  assert.match(row, /background: var\(--surface-head\)/);
  assert.match(row, /color: var\(--text, var\(--navy\)\)/);
  assert.match(row, /border-top: 1px solid var\(--surface-border\)/);
  assert.match(row, /padding: 10px 12px/);
  const input = css.match(/#chatFileUrl \{([^}]+)\}/)[1];
  assert.match(input, /background: var\(--surface\)/);
  assert.match(input, /min-width: 0/);
  assert.match(css, /#chatFileUrl::placeholder \{ color: var\(--muted-text\)/);
  assert.match(css, /\.chat-drive-hint \{[^}]*color: var\(--muted-text\)/);
});

test('client branding uses contrasting accents and resets the header when switching accounts or signing out', () => {
  const properties={};
  const logo={dataset:{},alt:'ECL Logo',source:'https://ecl.example/logo.png',getAttribute(){return this.source;},set src(value){this.source=value;}};
  const context=vm.createContext({
    document:{
      documentElement:{style:{setProperty:(key,value)=>{properties[key]=value;},removeProperty:key=>{delete properties[key];}}},
      getElementById:()=>null,querySelector:selector=>selector==='.header-logo'?logo:null,querySelectorAll:()=>[],addEventListener(){}
    },
    window:{location:{hostname:'localhost'},addEventListener(){}},setTimeout:()=>0,clearTimeout(){}
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/app.js'),'utf8'),context);
  vm.runInContext("state.auth=true;state.activeClientId='CL-001';state.session={clientId:'CL-000',role:'staff'};state.clientProfile={clientId:'CL-001',clientName:'Test Company',accentColor:'#FFFFFF',logoUrl:'https://brand.example/logo.png'};renderClientBranding()",context);
  assert.equal(logo.source,'https://brand.example/logo.png');
  assert.equal(logo.alt,'Test Company logo');
  assert.equal(properties['--client-accent-text'],'#000000');
  assert.equal(context.brandTextColor('#000000'),'#FFFFFF');
  assert.equal(context.brandTextColor('#2463EB'),'#FFFFFF');
  assert.equal(context.canManageBranding(),true,'warehouse staff can edit the selected client branding');
  vm.runInContext("state.session={clientId:'CL-004',role:'client'}",context);
  assert.equal(context.canManageBranding(),false,'clients cannot manage another account branding');
  vm.runInContext("state.activeClientId='CL-004';renderClientBranding()",context);
  assert.equal(properties['--client-accent'],undefined);
  assert.equal(logo.source,'https://ecl.example/logo.png','previous client logo is never shown under another account');
  vm.runInContext("state.activeClientId='CL-001';state.auth=false;renderClientBranding()",context);
  assert.equal(properties['--client-accent-text'],undefined);
});

test('branding form keeps manual values after partial or failed fetches and discards late account responses', async () => {
  const inputs=Object.fromEntries(['websiteUrl','logoUrl','accentColor'].map(name=>[name,{value:'',disabled:false}]));
  Object.assign(inputs.websiteUrl,{value:'https://brand.example/'});
  Object.assign(inputs.logoUrl,{value:'https://brand.example/manual.png'});
  Object.assign(inputs.accentColor,{value:'#2463EB'});
  const status={textContent:''};
  const form={
    dataset:{clientId:'CL-004'},isConnected:true,elements:{namedItem:name=>inputs[name]},
    querySelector:()=>status,querySelectorAll:()=>Object.values(inputs)
  };
  const context=vm.createContext({
    document:{getElementById:()=>null,querySelectorAll:()=>[],addEventListener(){}},
    window:{location:{hostname:'localhost'},addEventListener(){}},AbortController,setTimeout:()=>0,clearTimeout(){}
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/app.js'),'utf8'),context);
  vm.runInContext("state.auth=true;state.activeClientId='CL-004';state.session={clientId:'CL-004',role:'client',notificationToken:'synthetic'};state.clientProfile={clientId:'CL-004',logoUrl:'',accentColor:'#F5C518'};showToast=()=>{};",context);
  let saved;
  context.fetch=async(url,options)=>{
    assert.equal(url,'/api/branding/fetch');
    assert.equal(options.headers.Authorization,'Bearer synthetic');
    return {ok:true,json:async()=>({success:true,clientId:'CL-004',branding:{logoUrl:'',accentColor:'',warnings:['No metadata found.']}})};
  };
  await context.submitBranding(form,true);
  assert.equal(inputs.logoUrl.value,'https://brand.example/manual.png');
  assert.equal(inputs.accentColor.value,'#2463EB');
  assert.match(status.textContent,/No metadata found/);
  assert.equal(vm.runInContext('state.clientProfile.logoUrl',context),'','fetch never changes saved profile');
  context.fetch=async()=>({ok:false,json:async()=>({success:false,error:'Site blocked; use manual entry.'})});
  await context.submitBranding(form,true);
  assert.match(status.textContent,/Site blocked/);
  assert.equal(inputs.accentColor.disabled,false);
  context.fetch=async(url,options)=>{
    assert.equal(url,'/api/branding');
    saved=JSON.parse(options.body);
    return {ok:true,json:async()=>({success:true,clientId:'CL-004',branding:{websiteUrl:saved.websiteUrl,logoUrl:saved.logoUrl,accentColor:saved.accentColor}})};
  };
  await context.submitBranding(form,false);
  assert.equal(saved.logoUrl,'https://brand.example/manual.png');
  assert.equal(vm.runInContext('state.clientProfile.accentColor',context),'#2463EB');
  let finish;
  context.fetch=()=>new Promise(resolve=>{finish=resolve;});
  const pending=context.submitBranding(form,true);
  vm.runInContext("state.activeClientId='CL-005';state.clientProfile={clientId:'CL-005',logoUrl:'https://other.example/logo.png'}",context);
  finish({ok:true,json:async()=>({success:true,clientId:'CL-004',branding:{logoUrl:'https://brand.example/stale.png',accentColor:'#123456',warnings:[]}})});
  await pending;
  assert.equal(inputs.logoUrl.value,'https://brand.example/manual.png');
  assert.equal(vm.runInContext('state.clientProfile.logoUrl',context),'https://other.example/logo.png');
});

test('dark notification panels, popup messages and alert states use light text on opaque contrasting surfaces', () => {
  const css = fs.readFileSync(require.resolve('../frontend/styles.css'), 'utf8');
  assert.match(css, /html\[data-theme="dark"\] \.notification-panel \{ background: var\(--surface\); color: var\(--text\); \}/);
  assert.match(css, /html\[data-theme="dark"\] \.notification-row,[\s\S]*?\.notification-heading button \{ color: var\(--text\); \}/);
  assert.match(css, /html\[data-theme="dark"\] \.toast \{[^}]*background: var\(--surface-head\);[^}]*color: var\(--text\)/);
  assert.match(css, /--feedback-error-bg: var\(--red-bg\)/);
  assert.match(css, /--feedback-success-bg: var\(--green-bg\)/);
  assert.match(css, /--feedback-error-text: var\(--text\)/);
  assert.match(css, /--feedback-success-text: var\(--text\)/);
  assert.match(css, /\.recovery-code-box p \{ color: var\(--text\); \}/);
  assert.match(css, /\.login-error \{ background: var\(--red-bg\); color: var\(--text\)/);
  const alertRule = css.slice(css.indexOf('html[data-theme="dark"] :is(.content, .inventory-item-dialog) :is('));
  for (const selector of [
    '.integration-notice', '.item-entry-notice', '.prep-banner', '.ac-note', '.activity-notice',
    '.tracking-error', '.inventory-dialog-error', '.barcode-scan-message', '.inbound-error',
    '.branding-status', '.staff-account-message', '#storeConnectionStatus',
    '#catalogSyncMessage', '#catalogImageMessage', '#loginHistoryMessage'
  ]) assert.ok(alertRule.split(') {')[0].includes(selector), `${selector} has an explicit dark text override`);
  assert.match(alertRule, /\):not\(:empty\) \{\s*background: var\(--surface-head\);/);
  const darkVariables = css.split('html[data-theme="dark"] {')[1].split('}')[0];
  const color = name => darkVariables.match(new RegExp(`--${name}: (#[a-f0-9]{6})`, 'i'))[1];
  const luminance = hex => hex.slice(1).match(/../g).map(value => {
    const channel = parseInt(value, 16) / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  }).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
  const text = luminance(color('text'));
  for (const name of ['surface', 'surface-head', 'red-bg', 'green-bg', 'blue-bg', 'yellow-bg']) {
    const background = luminance(color(name));
    const contrast = (Math.max(text, background) + .05) / (Math.min(text, background) + .05);
    assert.ok(contrast >= 4.5, `${name} text contrast ${contrast.toFixed(2)} meets WCAG AA`);
  }
});

test('dashboard summary counts and labels use readable dark colors while preserving severity colors', () => {
  const css = fs.readFileSync(require.resolve('../frontend/styles.css'), 'utf8');
  assert.match(css, /html\[data-theme="dark"\] \.summary-card \.num,\s*html\[data-theme="dark"\] \.summary-card \.lbl \{ color: var\(--text\); \}/);
  assert.match(css, /html\[data-theme="dark"\] \.summary-card\.warn \.num \{ color: var\(--yellow-fg\); \}/);
  assert.match(css, /html\[data-theme="dark"\] \.summary-card\.danger \.num \{ color: var\(--red-fg\); \}/);
});

test('settings headings and protected-action controls use readable theme colors', () => {
  const css = fs.readFileSync(require.resolve('../frontend/styles.css'), 'utf8');
  assert.match(css, /\.update-card h3 \{[^}]*color: var\(--text, var\(--mid\)\)/);
  assert.match(css, /\.pin-btn\.cancel \{[^}]*background: var\(--gray-bg\); color: var\(--gray-fg\); border: 1px solid var\(--border\)/);
  assert.match(css, /\.pin-btn:focus-visible \{[^}]*outline: 2px solid var\(--yellow\)/);
  for (const [selector, declaration] of [
    ['.pin-box', 'background: var(--surface)'],
    ['.pin-box h3', 'color: var(--text)'],
    ['.pin-box p', 'color: var(--muted-text)'],
    ['.pin-box input', 'color: var(--text)'],
    ['.pin-box input::placeholder', 'color: var(--muted-text)']
  ]) {
    assert.ok(css.includes(`html[data-theme="dark"] ${selector} {`) && css.split(`html[data-theme="dark"] ${selector} {`)[1].split('}')[0].includes(declaration), selector);
  }
});

test('inventory cells share opaque theme-aware row backgrounds, including the sticky column', () => {
  const css = fs.readFileSync(require.resolve('../frontend/styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (selector) => {
    const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    return blocks.filter(([, selectors]) => selectors.trim() === selector).map(([, , body]) => body).join('\n');
  };

  assert.match(rule(':root'), /--surface:\s*#fff;/);
  assert.match(rule('html[data-theme="dark"]'), /--surface:\s*#1b2734;/);
  assert.match(rule('.table-shell .table-wrap'), /background:\s*var\(--surface\);/);
  assert.match(rule('.table-shell table'), /background:\s*var\(--surface\);/);
  assert.match(rule('.table-shell tbody tr'), /--inventory-row-background:\s*var\(--surface\);/);
  assert.match(rule('.table-shell tbody tr'), /background:\s*var\(--inventory-row-background\);/);
  assert.match(rule('.table-shell tbody tr:nth-child(even)'), /--inventory-row-background:\s*var\(--gray\);/);
  assert.match(rule('.table-shell tbody tr:hover'), /--inventory-row-background:\s*var\(--light\);/);
  assert.match(rule('.table-shell tbody td'), /background:\s*var\(--inventory-row-background\);/);
  assert.doesNotMatch(rule('.table-shell tbody td:first-child'), /background/);
  assert.equal(rule('.table-shell tbody tr:nth-child(even) td:first-child'), '');
  assert.equal(rule('.table-shell tbody tr:hover td:first-child'), '');
  assert.match(rule('.inventory-meta'), /color:\s*var\(--muted-text\);/);
  const app = fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8');
  assert.match(app, /<div class="inventory-meta">/);
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
    fetch: async (url,options) => {
      assert.equal(options.headers.Authorization, 'Bearer signed-inventory-session');
      assert.match(url, /\/api\/inventory\?clientId=CL-001$/);
      return { ok: true, status: 200, json: async () => payload };
    }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8'), context);
  vm.runInContext("state.auth = true; state.session = {notificationToken:'signed-inventory-session'}; state.activeClientId = 'CL-001'; let normalizedCount = 0; const originalNormalize = normalizeInventoryItem; normalizeInventoryItem = (...args) => { normalizedCount += 1; return originalNormalize(...args); };", context);
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

test('role route protection blocks direct navigation, cross-client switching and staff billing requests', async () => {
  const elements=Object.fromEntries(['tabStoreSettings','tabBilling','toast','page-clients','page-store-settings','page-billing'].map(id=>[id,{
    id,style:{},textContent:'',classList:{contains:()=>false},addEventListener(){}
  }]));
  let fetches=0;
  const context=vm.createContext({
    document:{hidden:false,getElementById:id=>elements[id]||null,querySelectorAll:()=>[],addEventListener(){}},
    window:{location:{hostname:'localhost'},addEventListener(){}},
    AbortController,setTimeout:()=>0,clearTimeout(){},fetch:async()=>{fetches++;throw new Error('Unauthorized UI must not fetch');}
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/app.js'),'utf8'),context);
  vm.runInContext("state.auth=true;state.activeClientId='CL-004';state.session={clientId:'CL-000',role:'staff'};state.isAdmin=true;updateStoreSettingsAccess()",context);
  assert.equal(elements.tabStoreSettings.style.display,'');
  assert.equal(context.canOpenPortalPage('page-store-settings'),true,'staff retain branding editing without master settings');
  for(const name of ['page-clients','page-billing']){
    assert.equal(context.canOpenPortalPage(name),false);
    context.setPage(name);
    assert.match(elements.toast.textContent,/does not have access/);
  }
  await context.syncBillingTab();
  assert.equal(elements.tabBilling.style.display,'none');
  assert.equal(await context.loadBillingSummary(),403);
  assert.equal(fetches,0);
  for(const name of ['page-dashboard','page-update','page-logs','page-tracking'])assert.equal(context.canOpenPortalPage(name),true);
  vm.runInContext("state.session={clientId:'CL-004',role:'client'};state.isAdmin=false;updateStoreSettingsAccess()",context);
  assert.equal(elements.tabStoreSettings.style.display,'');
  assert.equal(context.canOpenPortalPage('page-clients'),false);
  assert.equal(context.canOpenPortalPage('page-billing'),false,'unshared billing cannot be opened through a direct route');
  context.showPage('billing');
  assert.equal(fetches,0);
  await context.switchClientView('CL-005');
  assert.equal(vm.runInContext('state.activeClientId',context),'CL-004');
  assert.equal(fetches,0);
  vm.runInContext("state.session={clientId:'CL-000',role:'admin'};state.isAdmin=true",context);
  for(const name of ['page-clients','page-store-settings','page-billing','page-update'])assert.equal(context.canOpenPortalPage(name),true);
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
  const html = fs.readFileSync(require.resolve('../frontend/index.html'), 'utf8');
  const navigation = html.match(/<nav class="tabs"[\s\S]*?<\/nav>/)[0];
  const buttons = [...navigation.matchAll(/<button\b[^>]*>[^<]*<\/button>/g)].map((match) => match[0]);
  assert.equal(buttons.length, 10);
  assert.match(buttons[7], /id="tabTracking"/);
  assert.match(buttons[8], /id="tabStoreSettings"/);
  assert.match(buttons.at(-1), /id="tabHelp".*onclick="showPage\('help'\)"/);
  const settingsPage = html.slice(html.indexOf('<div id="page-store-settings"'), html.indexOf('<div id="page-help"'));
  assert.match(settingsPage, /API integration may not work correctly/);
  assert.match(settingsPage, /Still in development \/ Beta/);
  assert.match(settingsPage, /id="settingsPackagingProfile"/);
  assert.match(settingsPage, /data-action="toggle-theme"/);
  assert.doesNotMatch(settingsPage, /<div hidden>/);
  assert.match(settingsPage, /id="storeConnectionFields" disabled/);
  const tabs = buttons.map(makeTab);
  const helpPage = { id: 'page-help', style: {}, classList: { toggle() {} } };
  const outer = { open: false, parentElement: null };
  const inner = { open: false, parentElement: { closest: () => outer } };
  const messages = Object.fromEntries(['addClientMsg', 'editClientMsg', 'resetPasswordMsg'].map((id) => [
    id, { style: {}, textContent: '', closest: () => inner }
  ]));
  const context = vm.createContext({
    document: { hidden: false, getElementById: (id) => id === 'page-help' ? helpPage : messages[id] || null, querySelectorAll: (selector) => selector === '.tab' ? tabs : selector === '.page' ? [helpPage] : [], addEventListener() {} },
    window: { location: { hostname: 'localhost' }, addEventListener() {} },
    AbortController, setTimeout, clearTimeout
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8'), context);
  context.setPage('page-clients');
  assert.equal(tabs[6].attrs['aria-current'], 'page');
  context.setPage('page-billing');
  assert.equal(tabs[5].attrs['aria-current'], 'page');
  assert.equal(tabs[6].attrs['aria-current'], undefined);
  context.setPage('page-tracking');
  assert.equal(tabs[7].attrs['aria-current'], 'page');
  context.setPage('page-store-settings');
  assert.equal(tabs[8].attrs['aria-current'], 'page');
  context.showPage('help');
  assert.equal(helpPage.style.display, 'block');
  assert.equal(tabs[9].attrs['aria-current'], 'page');
  assert.equal(tabs[8].attrs['aria-current'], undefined);
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
    assert.equal(messages[id].style.background, 'var(--feedback-success-bg, #f0fdf4)');
    assert.equal(messages[id].style.color, 'var(--feedback-success-text, #166534)');
    context[functionName]('Operation failed', 'error');
    assert.equal(messages[id].style.background, 'var(--feedback-error-bg, #fef2f2)');
    assert.equal(messages[id].style.color, 'var(--feedback-error-text, #b91c1c)');
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
  vm.runInContext("state.items = __items; state.activeClientId = 'CL-004'; state.clientProfile = { clientId: 'CL-004', enableShippedTab: false, overstockLevel: 100, fields: [{ key: 'quantityReceived', label: 'Quantity Received' }, { key: 'quantityShipped', label: 'Quantity Shipped' }], attributeMap: { bundled: 'bundled', fragile: 'fragile', oversized: null } };", context);
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

  vm.runInContext("state.session.role = 'staff'; renderWelcomeBanner();", context);
  assert.equal(elements.welcomeTitle.textContent, 'Welcome back, Team');

  vm.runInContext('state.session = null; renderWelcomeBanner();', context);
  assert.equal(elements.welcomeTitle.textContent, 'Inventory overview');
  assert.equal(elements.welcomeDate.textContent, '');
  assert.equal(elements.welcomeBanner.classList.contains('is-personalized'), false);
  assert.equal(vm.runInContext('getTimeOfDayGreeting(new Date(2026, 0, 1, 9))', context), 'Good morning');
  assert.equal(vm.runInContext('getTimeOfDayGreeting(new Date(2026, 0, 1, 14))', context), 'Good afternoon');
  assert.equal(vm.runInContext('getTimeOfDayGreeting(new Date(2026, 0, 1, 20))', context), 'Good evening');
});

test('first-time tour launches once for clients, navigates with back/next, and saves the seen flag on skip or finish', () => {
  assert.doesNotMatch(fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8'), /title: 'Receiving with camera or USB scanners'/);
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
  let activePage = 'page-dashboard';
  const ids = ['tourOverlay', 'tourSpotlight', 'tourCard', 'tourStep', 'tourTitle', 'tourBody', 'tourProgress', 'tourSkip', 'tourBack', 'tourNext', 'tourFinish', 'replayTourBtn', 'toast'];
  const elements = Object.fromEntries(ids.map((id) => [id, makeEl()]));
  elements.tourOverlay.hidden = true;
  const storage = new Map();
  const keydown = [];
  const context = vm.createContext({
    document: {
      hidden: false, body: makeEl(), activeElement: null,
      getElementById: (id) => elements[id] || null,
      querySelector: (selector) => (selector === '.page.active' ? { id: activePage } : makeEl()),
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
  context.__setPage = (page) => { activePage = page; };
  vm.runInContext('showTourPage = (page) => { if (page) { __visit(page); __setPage(page); } };', context);
  const total = vm.runInContext('ONBOARDING_STEPS.filter((step) => !step.available || step.available()).length', context);
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
  assert.ok(visited.includes('page-help'), 'tour introduces the Help tab');
  assert.equal(storage.has('has_seen_onboarding'), false, 'flag is not set until the tour ends');

  vm.runInContext('finishOnboardingTour()', context);
  assert.equal(elements.tourOverlay.hidden, true);
  assert.equal(storage.get('has_seen_onboarding'), 'true');
  assert.equal(visited.at(-1), 'page-dashboard');
  assert.equal(vm.runInContext('maybeStartOnboarding()', context), false, 'does not relaunch once seen');

  activePage = 'page-help';
  vm.runInContext('startHelpTour()', context);
  assert.equal(vm.runInContext('tourState.returnPage', context), 'page-help');
  assert.equal(activePage, 'page-help', 'Help tour begins without switching to the dashboard');
  vm.runInContext('moveOnboardingTour(1)', context);
  assert.equal(elements.tourTitle.textContent, 'Find answers in Help');
  assert.equal(activePage, 'page-help');
  vm.runInContext('skipOnboardingTour()', context);
  assert.equal(activePage, 'page-help', 'dismissing the Help tour returns to Help');

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

  vm.runInContext(`state.activeClientId='CL-002';
    state.clientProfile={clientId:'CL-002',inventoryMode:'custom',enableShippedTab:true,enableAddItem:true,readOnly:false,requirePin:false};
    startOnboardingTour();`, context);
  const clientSteps = vm.runInContext('tourState.steps.map(step=>step.target)', context);
  assert.ok(clientSteps.includes('#inventoryViews [data-view="shipped"]'));
  assert.ok(clientSteps.includes('#catalogSyncPanel'));
  assert.ok(clientSteps.includes('#trackingSearchForm'));
  assert.ok(!clientSteps.includes('#tabUpdate'), 'the requested receiving overview is removed from Getting Started');
  assert.ok(!clientSteps.includes('.barcode-checkin'), 'clients never enter staff check-in controls');
  assert.match(vm.runInContext("tourState.steps.find(step=>step.target==='#catalogSyncPanel').body", context), /continue manually without API keys/);
  assert.ok(clientSteps.includes('#inboundDashboard'), 'enabled fulfillment clients also get the inbound walkthrough');
  assert.equal(vm.runInContext('tourState.steps.length', context), total + 4);
  vm.runInContext(`closeOnboardingTour({markSeen:false,restorePage:false});state.isAdmin=true;startHelpTour();`, context);
  assert.ok(vm.runInContext("tourState.steps.some(step=>step.target==='.barcode-checkin')", context));
  assert.match(vm.runInContext("tourState.steps.find(step=>step.target==='.barcode-checkin').body", context), /no quantity changes/);
  assert.match(vm.runInContext("tourState.steps.find(step=>step.target==='#trackingSearchForm').body", context), /not a live carrier-event feed/);
  vm.runInContext(`closeOnboardingTour({markSeen:false,restorePage:false});
    state.clientProfile.enableShippedTab=false;state.clientProfile.readOnly=true;startHelpTour();`, context);
  assert.ok(!vm.runInContext("tourState.steps.some(step=>step.target?.includes('data-view')||step.target==='#tabOrder'||step.target==='#catalogSyncPanel'||step.target==='.barcode-checkin')", context));
  vm.runInContext('closeOnboardingTour({markSeen:false,restorePage:false});', context);
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
