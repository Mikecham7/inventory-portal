const express = require('express');
const path = require('path');
const dotenv = require('dotenv');
const { google } = require('googleapis');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SPREADSHEET_RANGE = 'Inventory!A1:H';

app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

function getAuthClient() {
  const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!serviceAccountEmail || !privateKey || !SHEET_ID) {
    throw new Error('Missing Google Sheets environment variables.');
  }

  return new google.auth.GoogleAuth({
    credentials: {
      client_email: serviceAccountEmail,
      private_key: privateKey
    },
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/script.external_request'
    ]
  });
}

async function getSheetsClient() {
  const auth = await getAuthClient().getClient();
  return google.sheets({ version: 'v4', auth });
}

function normalizeRow(row = []) {
  const [itemName, sku, category, quantity, unitPrice, reorderLevel, location, status] = row;

  return {
    id: `${sku || itemName || 'item'}-${location || 'unknown'}`,
    itemName: itemName || '',
    sku: sku || '',
    category: category || '',
    quantity: Number(quantity || 0),
    unitPrice: Number(unitPrice || 0),
    reorderLevel: Number(reorderLevel || 0),
    location: location || '',
    status: status || 'In Stock'
  };
}

async function listInventory() {
  const sheets = await getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: SPREADSHEET_RANGE
  });

  const rows = response.data.values || [];

  if (!rows.length) {
    return [];
  }

  const [, ...dataRows] = rows;

  return dataRows
    .filter((row) => row.some((cell) => String(cell).trim() !== ''))
    .map(normalizeRow);
}

async function writeInventoryRow(row) {
  const sheets = await getSheetsClient();
  const values = [
    row.itemName,
    row.sku,
    row.category,
    Number(row.quantity || 0),
    Number(row.unitPrice || 0),
    Number(row.reorderLevel || 0),
    row.location,
    row.status || 'In Stock'
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'Inventory!A:H',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [values]
    }
  });
}

app.get('/api/inventory', async (req, res) => {
  try {
    const items = await listInventory();
    res.json(items);
  } catch (error) {
    console.error('Error fetching inventory:', error.message);
    res.status(500).json({ message: 'Unable to fetch inventory items.' });
  }
});

app.post('/api/inventory', async (req, res) => {
  try {
    const item = req.body;
    await writeInventoryRow(item);
    res.status(201).json({ message: 'Item created successfully.' });
  } catch (error) {
    console.error('Error creating inventory item:', error.message);
    res.status(500).json({ message: 'Unable to create item.' });
  }
});

app.put('/api/inventory/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const items = await listInventory();
    const index = items.findIndex((item) => String(item.id) === String(id));

    if (index === -1) {
      return res.status(404).json({ message: 'Item not found.' });
    }

    const updatedItems = [...items];
    updatedItems[index] = { ...updatedItems[index], ...req.body };

    const sheets = await getSheetsClient();
    const rows = updatedItems.map((item) => [
      item.itemName,
      item.sku,
      item.category,
      item.quantity,
      item.unitPrice,
      item.reorderLevel,
      item.location,
      item.status
    ]);

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: 'Inventory!A2:H',
      valueInputOption: 'RAW',
      requestBody: {
        values: rows
      }
    });

    res.json({ message: 'Item updated successfully.' });
  } catch (error) {
    console.error('Error updating inventory item:', error.message);
    res.status(500).json({ message: 'Unable to update item.' });
  }
});

app.delete('/api/inventory/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const items = await listInventory();
    const filtered = items.filter((item) => String(item.id) !== String(id));

    const sheets = await getSheetsClient();
    const rows = filtered.map((item) => [
      item.itemName,
      item.sku,
      item.category,
      item.quantity,
      item.unitPrice,
      item.reorderLevel,
      item.location,
      item.status
    ]);

    await sheets.spreadsheets.values.clear({
      spreadsheetId: SHEET_ID,
      range: 'Inventory!A2:H'
    });

    if (rows.length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: 'Inventory!A2:H',
        valueInputOption: 'RAW',
        requestBody: {
          values: rows
        }
      });
    }

    res.json({ message: 'Item deleted successfully.' });
  } catch (error) {
    console.error('Error deleting inventory item:', error.message);
    res.status(500).json({ message: 'Unable to delete item.' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Inventory API running on http://localhost:${PORT}`);
  });
}

module.exports = app;
