const express = require('express');
const serverless = require('serverless-http');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const app = express();
app.use(express.json());

const requiredHeaders = [
  'itemName',
  'sku',
  'category',
  'quantity',
  'unitPrice',
  'reorderLevel',
  'location',
  'status'
];

function getServiceAccountAuth() {
  const privateKey = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !privateKey || !process.env.GOOGLE_SHEET_ID) {
    throw new Error('Missing Google environment variables.');
  }

  return new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
}

async function getSheet() {
  const auth = getServiceAccountAuth();
  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
  await doc.loadInfo();
  return doc.sheetsByIndex[0];
}

function normalizeRow(row) {
  const itemName = row.get('itemName') || '';
  const sku = row.get('sku') || '';
  const location = row.get('location') || 'unknown';

  return {
    id: `${(sku || itemName || 'item').toString().trim()}-${location.toString().trim()}`,
    itemName,
    sku,
    category: row.get('category') || '',
    quantity: Number(row.get('quantity') || 0),
    unitPrice: Number(row.get('unitPrice') || 0),
    reorderLevel: Number(row.get('reorderLevel') || 0),
    location,
    status: row.get('status') || 'In Stock',
    lastUpdated: row.get('lastUpdated') || new Date().toISOString()
  };
}

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};

  try {
    const sheet = await getSheet();
    const rows = await sheet.getRows();
    const user = rows.find((row) => row.get('username') === username && row.get('password') === password);

    if (user) {
      return res.json({
        success: true,
        message: 'Login successful',
        role: user.get('role') || 'user'
      });
    }

    return res.status(401).json({
      success: false,
      error: 'Invalid username or password'
    });
  } catch (error) {
    console.error('Google Sheets Error:', error);
    return res.status(500).json({
      success: false,
      error: 'Server error connecting to database'
    });
  }
});

app.get('/api/inventory', async (req, res) => {
  try {
    const sheet = await getSheet();
    const rows = await sheet.getRows();
    const inventory = rows.map(normalizeRow);
    return res.json(inventory);
  } catch (error) {
    console.error('Inventory read error:', error);
    return res.status(500).json({ message: 'Unable to fetch inventory.' });
  }
});

app.post('/api/inventory', async (req, res) => {
  try {
    const payload = req.body || {};
    const sheet = await getSheet();
    const rowData = {
      itemName: payload.itemName || '',
      sku: payload.sku || '',
      category: payload.category || '',
      quantity: Number(payload.quantity || 0),
      unitPrice: Number(payload.unitPrice || 0),
      reorderLevel: Number(payload.reorderLevel || 0),
      location: payload.location || '',
      status: payload.status || 'In Stock',
      lastUpdated: payload.lastUpdated || new Date().toISOString()
    };

    await sheet.addRow(rowData);
    return res.status(201).json({ success: true, message: 'Item created successfully.' });
  } catch (error) {
    console.error('Inventory create error:', error);
    return res.status(500).json({ message: 'Unable to create item.' });
  }
});

app.put('/api/inventory/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const payload = req.body || {};
    const sheet = await getSheet();
    const rows = await sheet.getRows();
    const rowToUpdate = rows.find((row) => String(normalizeRow(row).id) === String(id));

    if (!rowToUpdate) {
      return res.status(404).json({ message: 'Item not found.' });
    }

    rowToUpdate.itemName = payload.itemName ?? rowToUpdate.get('itemName');
    rowToUpdate.sku = payload.sku ?? rowToUpdate.get('sku');
    rowToUpdate.category = payload.category ?? rowToUpdate.get('category');
    rowToUpdate.quantity = payload.quantity ?? rowToUpdate.get('quantity');
    rowToUpdate.unitPrice = payload.unitPrice ?? rowToUpdate.get('unitPrice');
    rowToUpdate.reorderLevel = payload.reorderLevel ?? rowToUpdate.get('reorderLevel');
    rowToUpdate.location = payload.location ?? rowToUpdate.get('location');
    rowToUpdate.status = payload.status ?? rowToUpdate.get('status');
    rowToUpdate.lastUpdated = payload.lastUpdated || new Date().toISOString();

    await rowToUpdate.save();
    return res.json({ success: true, message: 'Item updated successfully.' });
  } catch (error) {
    console.error('Inventory update error:', error);
    return res.status(500).json({ message: 'Unable to update item.' });
  }
});

app.delete('/api/inventory/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const sheet = await getSheet();
    const rows = await sheet.getRows();
    const rowToDelete = rows.find((row) => String(normalizeRow(row).id) === String(id));

    if (!rowToDelete) {
      return res.status(404).json({ message: 'Item not found.' });
    }

    await rowToDelete.delete();
    return res.json({ success: true, message: 'Item deleted successfully.' });
  } catch (error) {
    console.error('Inventory delete error:', error);
    return res.status(500).json({ message: 'Unable to delete item.' });
  }
});

module.exports.handler = serverless(app);
