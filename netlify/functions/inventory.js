const { google } = require('googleapis');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SPREADSHEET_RANGE = 'Inventory!A1:H';

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

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
    },
    body: JSON.stringify(payload)
  };
}

exports.handler = async function handler(event, context) {
  if (event.httpMethod === 'OPTIONS') {
    return jsonResponse(200, { ok: true });
  }

  try {
    const method = event.httpMethod || 'GET';
    const path = event.path || '';
    const id = path.split('/').filter(Boolean).pop();

    if (method === 'GET') {
      const items = await listInventory();
      return jsonResponse(200, items);
    }

    if (method === 'POST') {
      const payload = JSON.parse(event.body || '{}');
      const sheets = await getSheetsClient();
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: 'Inventory!A:H',
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: [[
            payload.itemName,
            payload.sku,
            payload.category,
            Number(payload.quantity || 0),
            Number(payload.unitPrice || 0),
            Number(payload.reorderLevel || 0),
            payload.location,
            payload.status || 'In Stock'
          ]]
        }
      });

      return jsonResponse(201, { message: 'Item created successfully.' });
    }

    if (method === 'PUT' && id) {
      const payload = JSON.parse(event.body || '{}');
      const items = await listInventory();
      const index = items.findIndex((item) => String(item.id) === String(id));

      if (index === -1) {
        return jsonResponse(404, { message: 'Item not found.' });
      }

      const updatedItems = [...items];
      updatedItems[index] = { ...updatedItems[index], ...payload };

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

      return jsonResponse(200, { message: 'Item updated successfully.' });
    }

    if (method === 'DELETE' && id) {
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

      return jsonResponse(200, { message: 'Item deleted successfully.' });
    }

    return jsonResponse(405, { message: 'Method not allowed.' });
  } catch (error) {
    console.error('Inventory function error:', error);
    return jsonResponse(500, { message: error.message || 'An unexpected error occurred.' });
  }
};
