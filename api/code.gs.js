const GAS = (() => {
  if (typeof SpreadsheetApp === 'undefined') {
    return {
      __nodeCompat: true,
      getActiveSpreadsheet: () => {
        throw new Error('SpreadsheetApp is unavailable outside Google Apps Script runtime.');
      }
    };
  }

  return globalThis;
})();

var CHAT_DRIVE_FOLDERS = {
  'CL-001': '12kLeOKbQ2A_siusOder-4qzF8xMwNyU1',
  'CL-002': '14OQQ-PJWjOPf_jW_QhWne7iB-q8l-60k',
  'CL-003': '19iAZ6O_akxRqMtuSYE11GMifz3yNMrav'
};

function isValidCL001Sku(val) {
  if (!val) return false;
  var str = val.toString().trim();
  if (str === '') return false;
  if (str === 'SKU CODE') return false;
  if (!isNaN(parseFloat(str)) && isFinite(str)) return false;
  if (val instanceof Date) return false;
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(str)) return false;
  if (str.indexOf('Electric City') !== -1) return false;
  if (str.indexOf('TOTAL') !== -1) return false;
  if (str.indexOf('INVENTORY') !== -1) return false;
  if (str.indexOf('CLIENT') !== -1) return false;
  return true;
}

function parseHistoryLog(key, historyStr) {
  if (!historyStr) return [];
  var entries = historyStr.toString().split('|');
  var results = [];
  entries.forEach(function(entry) {
    entry = entry.trim();
    var match = entry.match(/^\[(\d{2}\/\d{2}\/\d{2}\s+\d{2}:\d{2})\]\s+(.+)$/);
    if (match) {
      results.push({ key: key, timestamp: match[1], change: match[2].trim() });
    }
  });
  return results;
}

function splitCL002Notes(notesStr, rowKey) {
  if (!notesStr) return { userNote: '', logEntries: [] };
  var parts = notesStr.toString().split('|');
  var userNoteParts = [];
  var logEntries = [];
  parts.forEach(function(part) {
    part = part.trim();
    if (!part) return;
    var match = part.match(/^\[(\d{2}\/\d{2}\/\d{2}\s+\d{2}:\d{2})\]\s+(.+)$/);
    if (match) {
      logEntries.push({ key: rowKey, timestamp: match[1], change: match[2].trim() });
    } else {
      userNoteParts.push(part);
    }
  });
  return { userNote: userNoteParts.join(' | '), logEntries: logEntries };
}

function getInventoryData(clientId) {
  try {
    var sheetName = (clientId === 'CL-000' || !clientId) ? 'CL-001' : clientId;
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
    if (!sheet) throw new Error("Inventory sheet '" + sheetName + "' could not be found.");

    var lastRow = sheet.getLastRow();
    if (lastRow < 9) return [];

    var dataRange = sheet.getRange(9, 1, lastRow - 8, 6);
    var values = dataRange.getValues();
    var cleanedData = [];

    for (var i = 0; i < values.length; i++) {
      var row = values[i];
      if (!isValidCL001Sku(row[1])) continue;

      var sku = row[1].toString().trim();
      var rawQty = row[3];
      var cleanQty;
      if (rawQty === 'No Data' || rawQty === '' || rawQty === undefined || rawQty === null) {
        cleanQty = '—';
      } else {
        var parsed = parseInt(rawQty);
        cleanQty = isNaN(parsed) ? '—' : parsed;
      }

      var title = row[2] ? row[2].toString().trim() : '';
      if (title === '' || (!isNaN(parseFloat(title)) && isFinite(title)) || title instanceof Date) {
        title = sku;
      }

      var status = row[4] ? row[4].toString().trim() : '';
      status = status.split(' | ')[0].split(' [')[0].trim();
      if (status === '') {
        status = (cleanQty === '—' || cleanQty === 0) ? 'Out of Stock'
               : (typeof cleanQty === 'number' && cleanQty <= 5) ? 'Low Stock'
               : 'In Stock';
      }

      cleanedData.push([row[0], sku, title, cleanQty, status]);
    }

    return cleanedData;
  } catch (err) {
    Logger.log('getInventoryData error: ' + err.toString());
    throw new Error(err.message);
  }
}

function webUpdateQty(sku, changeValue, isExact, clientId) {
  try {
    var sheetName = (clientId === 'CL-000' || !clientId) ? 'CL-001' : clientId;
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
    if (!sheet) return { success: false, message: 'Target sheet not found.' };

    var lastRow = sheet.getLastRow();
    if (lastRow < 9) return { success: false, message: 'No data rows found.' };

    var range = sheet.getRange(9, 1, lastRow - 8, 6);
    var values = range.getValues();

    for (var i = 0; i < values.length; i++) {
      var currentSku = values[i][1] ? values[i][1].toString().trim() : '';
      if (currentSku !== sku.toString().trim()) continue;

      var rowNumber = 9 + i;
      var currentQtyRaw = values[i][3];
      var currentQty = (currentQtyRaw === 'No Data' || currentQtyRaw === '' || isNaN(parseInt(currentQtyRaw))) ? 0 : parseInt(currentQtyRaw);
      var targetQty = isExact ? parseInt(changeValue) : (currentQty + parseInt(changeValue));
      if (targetQty < 0) targetQty = 0;

      var newStatus = targetQty === 0 ? 'Out of Stock' : targetQty <= 5 ? 'Low Stock' : 'In Stock';
      sheet.getRange(rowNumber, 4).setValue(targetQty);
      sheet.getRange(rowNumber, 5).setValue(newStatus);

      var historyCell = sheet.getRange(rowNumber, 6);
      var existing = historyCell.getValue().toString();
      var tz = Session.getScriptTimeZone();
      var timestamp = Utilities.formatDate(new Date(), tz, 'MM/dd/yy HH:mm');
      var changeStr = isExact ? 'Set to ' + targetQty : (parseInt(changeValue) >= 0 ? '+' : '') + changeValue;
      var entry = '[' + timestamp + '] ' + changeStr;
      historyCell.setValue(existing ? existing + ' | ' + entry : entry);

      return { success: true, newQty: targetQty, newStatus: newStatus };
    }

    return { success: false, message: "SKU '" + sku + "' not found." };
  } catch (err) {
    Logger.log('webUpdateQty error: ' + err.toString());
    return { success: false, message: 'Internal error: ' + err.toString() };
  }
}

function getActivityLog(clientId) {
  try {
    var sheetName = (clientId === 'CL-000' || !clientId) ? 'CL-001' : clientId;
    if (sheetName === 'CL-002') {
      throw new Error('getActivityLog() cannot be used for CL-002 — use getCL002ActivityLog() instead.');
    }

    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
    if (!sheet) return [];

    var lastRow = sheet.getLastRow();
    if (lastRow < 9) return [];

    var range = sheet.getRange(9, 1, lastRow - 8, 6);
    var values = range.getValues();
    var allEntries = [];

    for (var i = 0; i < values.length; i++) {
      var row = values[i];
      if (!isValidCL001Sku(row[1])) continue;

      var sku = row[1].toString().trim();
      var title = row[2] ? row[2].toString().trim() : sku;
      if (!isNaN(parseFloat(title)) && isFinite(title)) title = sku;

      var historyStr = row[5] ? row[5].toString() : '';
      if (!historyStr) continue;

      var entries = parseHistoryLog(sku, historyStr);
      entries.forEach(function(e) { e.sku = e.key; e.title = title; });
      allEntries = allEntries.concat(entries);
    }

    allEntries.sort(function(a, b) { return b.timestamp.localeCompare(a.timestamp); });
    return allEntries.slice(0, 100);
  } catch (err) {
    Logger.log('getActivityLog error: ' + err.toString());
    return [];
  }
}

module.exports = {
  isValidCL001Sku,
  parseHistoryLog,
  splitCL002Notes,
  getInventoryData,
  webUpdateQty,
  getActivityLog,
  CHAT_DRIVE_FOLDERS,
  getCL002ShipmentData: function() { return []; },
  getCL002ActivityLog: function() { return []; },
  updateCL002Row: function() { return { success: false, message: 'Requires Apps Script runtime.' }; },
  addCL002Row: function() { return { success: false, message: 'Requires Apps Script runtime.' }; },
  getCL003InventoryData: function() { return []; },
  addCL003Item: function() { return { success: false, message: 'Requires Apps Script runtime.' }; },
  updateCL003Row: function() { return { success: false, message: 'Requires Apps Script runtime.' }; },
  validateLogin: function() { return { success: false, message: 'Requires Apps Script runtime.' }; },
  getClientProfile: function() { return {}; },
  getClientRoster: function() { return []; },
  getEditPin: function() { return '646'; },
  tryAutoLogin: function() { return { success: false, attempted: true, message: 'Requires Apps Script runtime.' }; },
  ensureChatSheet: function() { return null; },
  getChatHistory: function() { return []; },
  sendMessage: function() { return { success: false, message: 'Requires Apps Script runtime.' }; },
  getClientDriveFolder: function() { return null; },
  sendChatFile: function() { return { success: false, message: 'Requires Apps Script runtime.' }; },
  getChatClientList: function() { return []; },
  markStaffViewing: function() { return { success: false }; },
  isStaffViewing: function() { return { active: false }; },
  markTyping: function() { return { success: false }; },
  isAnyoneTyping: function() { return { typing: false }; },
  getUnreadCount: function() { return { count: 0 }; },
  doGet: function() { return null; }
};
