/**
 * ECL Inventory Portal — Code.gs
 *
 * CL-001 sheet column layout (data rows start at row 9):
 *   Col A (0) = Client_ID
 *   Col B (1) = SKU CODE
 *   Col C (2) = PRODUCT TITLE
 *   Col D (3) = QTY ON HAND
 *   Col E (4) = STATUS
 *   Col F (5) = COMMENTS / NOTES  ← history log lives here
 *
 * CL-002 sheet column layout (data rows start at row 2, no header block):
 *   Col A  (0)  = UPC
 *   Col B  (1)  = Product Description
 *   Col C  (2)  = Quantity Ordered
 *   Col D  (3)  = Quantity Received
 *   Col E  (4)  = Quantity Shipped
 *   Col F  (5)  = Exp Date
 *   Col G  (6)  = Merchant
 *   Col H  (7)  = ASIN #
 *   Col I  (8)  = FBM/FBA
 *   Col J  (9)  = Transparency Code
 *   Col K  (10) = Bundled?
 *   Col L  (11) = Bundle Quantity
 *   Col M  (12) = Notes  ← change history is appended here, like CL-001's Comments col
 *
 * User_Credentials sheet layout:
 *   Col A (0) = Client_ID     (CL-001, CL-002, ... CL-000 = admin/staff)
 *   Col B (1) = Username
 *   Col C (2) = Password
 *   Col D (3) = Client_Name
 *   Col E (4) = Email          ← used for Google auto-login
 *   Col F (5) = Edit_PIN       ← per-row PIN for unlocking edits.
 *                                 Leave blank to fall back to the default "646".
 */

var CHAT_DRIVE_FOLDERS = {
  "CL-001": "12kLeOKbQ2A_siusOder-4qzF8xMwNyU1",
  "CL-002": "14OQQ-PJWjOPf_jW_QhWne7iB-q8l-60k",
  "CL-003": "19iAZ6O_akxRqMtuSYE11GMifz3yNMrav"
};

function isValidCL001Sku(val) {
  if (!val) return false;
  var str = val.toString().trim();
  if (str === "") return false;
  if (str === "SKU CODE") return false;
  if (!isNaN(parseFloat(str)) && isFinite(str)) return false;
  if (val instanceof Date) return false;
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(str)) return false;
  if (str.indexOf("Electric City") !== -1) return false;
  if (str.indexOf("TOTAL") !== -1) return false;
  if (str.indexOf("INVENTORY") !== -1) return false;
  if (str.indexOf("CLIENT") !== -1) return false;
  return true;
}

function parseHistoryLog(key, historyStr) {
  if (!historyStr) return [];
  var entries = historyStr.toString().split("|");
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
  if (!notesStr) return { userNote: "", logEntries: [] };
  var parts = notesStr.toString().split("|");
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
  return { userNote: userNoteParts.join(" | "), logEntries: logEntries };
}

function getInventoryData(clientId) {
  try {
    var sheetName = (clientId === "CL-000" || !clientId) ? "CL-001" : clientId;
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
      if (rawQty === "No Data" || rawQty === "" || rawQty === undefined || rawQty === null) {
        cleanQty = "—";
      } else {
        var parsed = parseInt(rawQty);
        cleanQty = isNaN(parsed) ? "—" : parsed;
      }

      var title = row[2] ? row[2].toString().trim() : "";
      if (title === "" || (!isNaN(parseFloat(title)) && isFinite(title)) || title instanceof Date) {
        title = sku;
      }

      var status = row[4] ? row[4].toString().trim() : "";
      status = status.split(" | ")[0].split(" [")[0].trim();
      if (status === "") {
        status = (cleanQty === "—" || cleanQty === 0) ? "Out of Stock"
               : (typeof cleanQty === "number" && cleanQty <= 5) ? "Low Stock"
               : "In Stock";
      }

      cleanedData.push([row[0], sku, title, cleanQty, status]);
    }
    return cleanedData;
  } catch (err) {
    Logger.log("getInventoryData error: " + err.toString());
    throw new Error(err.message);
  }
}

function webUpdateQty(sku, changeValue, isExact, clientId) {
  try {
    var sheetName = (clientId === "CL-000" || !clientId) ? "CL-001" : clientId;
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
    if (!sheet) return { success: false, message: "Target sheet not found." };

    var lastRow = sheet.getLastRow();
    if (lastRow < 9) return { success: false, message: "No data rows found." };

    var range = sheet.getRange(9, 1, lastRow - 8, 6);
    var values = range.getValues();

    for (var i = 0; i < values.length; i++) {
      var currentSku = values[i][1] ? values[i][1].toString().trim() : "";
      if (currentSku !== sku.toString().trim()) continue;

      var rowNumber = 9 + i;
      var currentQtyRaw = values[i][3];
      var currentQty = (currentQtyRaw === "No Data" || currentQtyRaw === "" || isNaN(parseInt(currentQtyRaw)))
        ? 0 : parseInt(currentQtyRaw);

      var targetQty = isExact ? parseInt(changeValue) : (currentQty + parseInt(changeValue));
      if (targetQty < 0) targetQty = 0;

      var newStatus = targetQty === 0 ? "Out of Stock"
                    : targetQty <= 5  ? "Low Stock"
                    : "In Stock";

      sheet.getRange(rowNumber, 4).setValue(targetQty);
      sheet.getRange(rowNumber, 5).setValue(newStatus);

      var historyCell = sheet.getRange(rowNumber, 6);
      var existing = historyCell.getValue().toString();
      var tz = Session.getScriptTimeZone();
      var timestamp = Utilities.formatDate(new Date(), tz, "MM/dd/yy HH:mm");
      var changeStr = isExact ? "Set to " + targetQty
                     : (parseInt(changeValue) >= 0 ? "+" : "") + changeValue;
      var entry = "[" + timestamp + "] " + changeStr;
      historyCell.setValue(existing ? existing + " | " + entry : entry);

      return { success: true, newQty: targetQty, newStatus: newStatus };
    }

    return { success: false, message: "SKU '" + sku + "' not found." };
  } catch (err) {
    Logger.log("webUpdateQty error: " + err.toString());
    return { success: false, message: "Internal error: " + err.toString() };
  }
}

function getActivityLog(clientId) {
  try {
    var sheetName = (clientId === "CL-000" || !clientId) ? "CL-001" : clientId;

    if (sheetName === "CL-002") {
      throw new Error("getActivityLog() cannot be used for CL-002 — use getCL002ActivityLog() instead.");
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

      var historyStr = row[5] ? row[5].toString() : "";
      if (!historyStr) continue;

      var entries = parseHistoryLog(sku, historyStr);
      entries.forEach(function(e) { e.sku = e.key; e.title = title; });
      allEntries = allEntries.concat(entries);
    }

    allEntries.sort(function(a, b) { return b.timestamp.localeCompare(a.timestamp); });
    return allEntries.slice(0, 100);
  } catch (err) {
    Logger.log("getActivityLog error: " + err.toString());
    return [];
  }
}

function getCL002ShipmentData() {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("CL-002");
    if (!sheet) throw new Error("CL-002 sheet not found.");

    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];

    var range = sheet.getRange(2, 1, lastRow - 1, 13);
    var values = range.getValues();
    var results = [];

    for (var i = 0; i < values.length; i++) {
      var row = values[i];
      var rowNumber = 2 + i;
      var desc = row[1] ? row[1].toString().trim() : "";
      if (desc === "" || desc === "Product Description") continue;

      var qtyOrdered  = row[2] ? row[2].toString().trim() : "";
      var qtyReceived = row[3] ? row[3].toString().trim() : "";
      var qtyShipped  = row[4] ? row[4].toString().trim() : "";

      var ordered  = (qtyOrdered  !== "" && !isNaN(parseInt(qtyOrdered)))  ? parseInt(qtyOrdered)  : "—";
      var received = (qtyReceived !== "" && !isNaN(parseInt(qtyReceived))) ? parseInt(qtyReceived) : "—";
      var shipped  = (qtyShipped  !== "" && !isNaN(parseInt(qtyShipped)))  ? parseInt(qtyShipped)  : "—";
      var pending  = (typeof received === "number" && typeof shipped === "number")
                   ? Math.max(0, received - shipped) : "—";

      var fulfillment = row[8] ? row[8].toString().trim() : "";
      var rawNotes    = row[12] ? row[12].toString().trim() : "";
      var notesParsed = splitCL002Notes(rawNotes, rowNumber);
      var merchant    = row[6] ? row[6].toString().trim() : "";
      var asin        = row[7] ? row[7].toString().trim() : "";
      var upc         = row[0] ? row[0].toString().trim() : "";
      var transCode   = row[9] ? row[9].toString().trim() : "";
      var bundled     = row[10] ? row[10].toString().trim() : "";
      var bundleQty   = row[11] ? row[11].toString().trim() : "";
      var expDate     = row[5] ? row[5].toString().trim() : "";

      var noteForStatus = notesParsed.userNote.toUpperCase();
      var status = "";
      if (noteForStatus.indexOf("RETURNED") !== -1) {
        status = "Returned";
      } else if (typeof shipped === "number" && typeof received === "number" && shipped >= received && received > 0) {
        status = "Shipped";
      } else if (typeof received === "number" && received > 0) {
        status = "In Prep";
      } else {
        status = "Pending";
      }

      var isActive = (status === "Pending" || status === "In Prep");

      results.push({
        rowNumber:        rowNumber,
        upc:              upc,
        description:      desc,
        merchant:         merchant,
        asin:             asin,
        qtyOrderedRaw:    qtyOrdered,
        ordered:          ordered,
        received:         received,
        shipped:          shipped,
        pending:          pending,
        fulfillment:      fulfillment,
        transparencyCode: transCode,
        bundled:          bundled,
        bundleQty:        bundleQty,
        expDate:          expDate,
        notes:            notesParsed.userNote,
        notesRaw:         rawNotes,
        status:           status,
        isActive:         isActive
      });
    }

    results.sort(function(a, b) { return b.rowNumber - a.rowNumber; });
    return results;
  } catch (err) {
    Logger.log("getCL002ShipmentData error: " + err.toString());
    throw new Error(err.message);
  }
}

function getCL002ActivityLog() {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("CL-002");
    if (!sheet) return [];

    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];

    var range = sheet.getRange(2, 1, lastRow - 1, 13);
    var values = range.getValues();
    var allEntries = [];

    for (var i = 0; i < values.length; i++) {
      var row = values[i];
      var rowNumber = 2 + i;
      var desc = row[1] ? row[1].toString().trim() : "";
      if (desc === "" || desc === "Product Description") continue;

      var rawNotes = row[12] ? row[12].toString().trim() : "";
      if (!rawNotes) continue;

      var parsed = splitCL002Notes(rawNotes, rowNumber);
      parsed.logEntries.forEach(function(e) {
        e.sku = "Row " + e.key;
        e.title = desc;
        allEntries.push(e);
      });
    }

    allEntries.sort(function(a, b) { return b.timestamp.localeCompare(a.timestamp); });
    return allEntries.slice(0, 100);
  } catch (err) {
    Logger.log("getCL002ActivityLog error: " + err.toString());
    return [];
  }
}

function updateCL002Row(rowNumber, fields) {
  try {
    rowNumber = parseInt(rowNumber);
    if (!rowNumber || rowNumber < 2) return { success: false, message: "Invalid row." };

    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("CL-002");
    if (!sheet) return { success: false, message: "CL-002 sheet not found." };
    if (rowNumber > sheet.getLastRow()) return { success: false, message: "Row no longer exists." };

    var colMap = {
      upc: 1, description: 2, qtyOrdered: 3, qtyReceived: 4, qtyShipped: 5,
      expDate: 6, merchant: 7, asin: 8, fulfillment: 9, transparencyCode: 10,
      bundled: 11, bundleQty: 12
    };

    var changedDescriptions = [];
    Object.keys(colMap).forEach(function(key) {
      if (!fields.hasOwnProperty(key)) return;
      var col = colMap[key];
      var newVal = fields[key];
      var cell = sheet.getRange(rowNumber, col);
      var oldVal = cell.getValue();
      if (oldVal.toString().trim() === (newVal === null || newVal === undefined ? "" : newVal.toString().trim())) return;
      cell.setValue(newVal);
      changedDescriptions.push(key + ": '" + oldVal + "' → '" + newVal + "'");
    });

    var notesCell = sheet.getRange(rowNumber, 13);
    var existingRaw = notesCell.getValue().toString();
    var parsedExisting = splitCL002Notes(existingRaw, rowNumber);

    var tz = Session.getScriptTimeZone();
    var timestamp = Utilities.formatDate(new Date(), tz, "MM/dd/yy HH:mm");
    var logLines = [];

    if (fields.hasOwnProperty("notes") && fields.notes.toString().trim() !== parsedExisting.userNote.trim()) {
      logLines.push("[" + timestamp + "] Note updated");
    }
    if (changedDescriptions.length) {
      logLines.push("[" + timestamp + "] Edited " + changedDescriptions.length + " field(s)");
    }

    var newUserNote = fields.hasOwnProperty("notes") ? fields.notes.toString().trim() : parsedExisting.userNote;
    var oldLogLines = existingRaw.split("|").map(function(s){ return s.trim(); }).filter(function(s){
      return /^\[\d{2}\/\d{2}\/\d{2}\s+\d{2}:\d{2}\]/.test(s);
    });
    var allParts = [];
    if (newUserNote) allParts.push(newUserNote);
    allParts = allParts.concat(oldLogLines).concat(logLines);
    notesCell.setValue(allParts.join(" | "));

    return { success: true };
  } catch (err) {
    Logger.log("updateCL002Row error: " + err.toString());
    return { success: false, message: "Internal error: " + err.toString() };
  }
}

function addCL002Row(fields) {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("CL-002");
    if (!sheet) return { success: false, message: "CL-002 sheet not found." };

    var tz = Session.getScriptTimeZone();
    var timestamp = Utilities.formatDate(new Date(), tz, "MM/dd/yy HH:mm");
    var noteParts = [];
    if (fields.notes && fields.notes.toString().trim()) noteParts.push(fields.notes.toString().trim());
    noteParts.push("[" + timestamp + "] Created");

    var newRow = [
      fields.upc || "",
      fields.description || "",
      fields.qtyOrdered || "",
      fields.qtyReceived || "",
      fields.qtyShipped || "",
      fields.expDate || "",
      fields.merchant || "",
      fields.asin || "",
      fields.fulfillment || "",
      fields.transparencyCode || "",
      fields.bundled || "",
      fields.bundleQty || "",
      noteParts.join(" | ")
    ];

    sheet.appendRow(newRow);
    return { success: true, rowNumber: sheet.getLastRow() };
  } catch (err) {
    Logger.log("addCL002Row error: " + err.toString());
    return { success: false, message: "Internal error: " + err.toString() };
  }
}

function getCL003HeaderMap(sheet) {
  var header = sheet.getRange(1, 1, 1, Math.max(8, sheet.getLastColumn())).getValues()[0];
  var map = {};
  var findIndex = function(names) {
    for (var i = 0; i < header.length; i++) {
      var value = header[i] ? header[i].toString().trim().toLowerCase() : "";
      for (var j = 0; j < names.length; j++) {
        if (value === names[j].toLowerCase()) return i;
      }
    }
    return -1;
  };

  var productIndex = findIndex(["Product Description/Name", "Product Description", "Product Name", "Description"]);
  var qtyOrderedIndex = findIndex(["Quantity Ordered", "Qty Ordered"]);
  var qtyReceivedIndex = findIndex(["Quantity Received", "Qty Received"]);
  var qtyShippedIndex = findIndex(["Quantity Shipped", "Qty Shipped"]);
  var merchantIndex = findIndex(["Merchant", "Merchent"]);
  var carrierIndex = findIndex(["Carrier"]);
  var trackingIndex = findIndex(["Tracking #", "Tracking Number", "Tracking#"]);
  var notesIndex = findIndex(["Notes"]);

  map.productName = productIndex !== -1 ? productIndex : 0;
  map.quantityOrdered = qtyOrderedIndex !== -1 ? qtyOrderedIndex : 1;
  map.quantityReceived = qtyReceivedIndex !== -1 ? qtyReceivedIndex : 2;
  map.quantityShipped = qtyShippedIndex !== -1 ? qtyShippedIndex : 3;
  map.merchant = merchantIndex !== -1 ? merchantIndex : 4;
  map.carrier = carrierIndex !== -1 ? carrierIndex : 5;
  map.trackingNumber = trackingIndex !== -1 ? trackingIndex : 6;
  map.notes = notesIndex !== -1 ? notesIndex : 7;
  return map;
}

function readCL003Cell(row, columnIndex) {
  if (!row || columnIndex === undefined || columnIndex === null || columnIndex < 0 || columnIndex >= row.length) return "";
  return row[columnIndex] === undefined || row[columnIndex] === null ? "" : row[columnIndex].toString().trim();
}

function ensureCL003Sheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("CL-003");
  if (!sheet) {
    sheet = ss.insertSheet("CL-003");
  }

  var required = [
    "Product Description/Name",
    "Quantity Ordered",
    "Quantity Received",
    "Quantity Shipped",
    "Merchant",
    "Carrier",
    "Tracking #",
    "Notes"
  ];

  var header = sheet.getRange(1, 1, 1, Math.max(required.length, sheet.getLastColumn())).getValues()[0];
  var needsHeader = !header[0] || String(header[0]).trim() !== required[0];
  if (needsHeader) {
    sheet.getRange(1, 1, 1, required.length).setValues([required]);
  }
  return sheet;
}

function getCL003InventoryData() {
  try {
    var sheet = ensureCL003Sheet();
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];

    var values = sheet.getRange(2, 1, lastRow - 1, Math.max(8, sheet.getLastColumn())).getValues();
    var rows = [];
    var map = getCL003HeaderMap(sheet);

    for (var i = 0; i < values.length; i++) {
      var row = values[i];
      var productName = readCL003Cell(row, map.productName);
      var quantityOrdered = readCL003Cell(row, map.quantityOrdered);
      var quantityReceived = readCL003Cell(row, map.quantityReceived);
      var quantityShipped = readCL003Cell(row, map.quantityShipped);
      var merchant = readCL003Cell(row, map.merchant);
      var carrier = readCL003Cell(row, map.carrier);
      var trackingNumber = readCL003Cell(row, map.trackingNumber);
      var notes = readCL003Cell(row, map.notes);

      if (!productName && !quantityOrdered && !quantityReceived && !quantityShipped && !merchant && !carrier && !trackingNumber && !notes) {
        continue;
      }

      rows.push({
        rowNumber: 2 + i,
        productName: productName,
        quantityOrdered: quantityOrdered,
        quantityReceived: quantityReceived,
        quantityShipped: quantityShipped,
        merchant: merchant,
        carrier: carrier,
        trackingNumber: trackingNumber,
        notes: notes
      });
    }
    return rows;
  } catch (err) {
    Logger.log("getCL003InventoryData error: " + err.toString());
    return [];
  }
}

function addCL003Item(fields) {
  try {
    var sheet = ensureCL003Sheet();
    var row = [
      fields.productName || "",
      fields.quantityOrdered || "",
      fields.quantityReceived || "",
      fields.quantityShipped || "",
      fields.merchant || "",
      fields.carrier || "",
      fields.trackingNumber || "",
      fields.notes || ""
    ];
    sheet.appendRow(row);
    return { success: true, rowNumber: sheet.getLastRow() };
  } catch (err) {
    Logger.log("addCL003Item error: " + err.toString());
    return { success: false, message: err.toString() };
  }
}

function updateCL003Row(rowNumber, fields) {
  try {
    var sheet = ensureCL003Sheet();
    if (!rowNumber || rowNumber < 2) return { success: false, message: "Invalid row." };
    if (rowNumber > sheet.getLastRow()) return { success: false, message: "Row no longer exists." };

    var map = getCL003HeaderMap(sheet);
    var writes = [
      { key: "productName", value: fields.productName, column: map.productName + 1 },
      { key: "quantityOrdered", value: fields.quantityOrdered, column: map.quantityOrdered + 1 },
      { key: "quantityReceived", value: fields.quantityReceived, column: map.quantityReceived + 1 },
      { key: "quantityShipped", value: fields.quantityShipped, column: map.quantityShipped + 1 },
      { key: "merchant", value: fields.merchant, column: map.merchant + 1 },
      { key: "carrier", value: fields.carrier, column: map.carrier + 1 },
      { key: "trackingNumber", value: fields.trackingNumber, column: map.trackingNumber + 1 },
      { key: "notes", value: fields.notes, column: map.notes + 1 }
    ];

    writes.forEach(function(w) {
      if (w.value === undefined) return;
      sheet.getRange(rowNumber, w.column).setValue(w.value || "");
    });

    return { success: true };
  } catch (err) {
    Logger.log("updateCL003Row error: " + err.toString());
    return { success: false, message: err.toString() };
  }
}

function validateLogin(username, password) {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("User_Credentials");
    if (!sheet) return { success: false, message: "Security registry not found." };

    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      var rowUser = data[i][1] ? data[i][1].toString().trim() : "";
      var rowPass = data[i][2] ? data[i][2].toString().trim() : "";
      if (rowUser === username.trim() && rowPass === password.trim()) {
        var clientId = data[i][0].toString().trim();
        var clientProfile = getClientProfile(clientId);
        return {
          success:    true,
          clientId:   clientId,
          clientName: data[i][3].toString().trim(),
          editPin:    data[i][5] ? data[i][5].toString().trim() : "",
          profile:    clientProfile
        };
      }
    }
    return { success: false, message: "Invalid username or password." };
  } catch (e) {
    Logger.log("validateLogin error: " + e.toString());
    return { success: false, message: e.toString() };
  }
}

function getClientProfile(clientId) {
  var defaults = {
    clientId: clientId || "CL-000",
    clientName: clientId || "Client",
    portalTitle: "ECL Inventory Portal",
    portalSubtitle: "Professional Prep & Fulfillment Services",
    inventoryMode: (clientId === "CL-002" || clientId === "CL-003") ? "custom" : "inventory",
    enableAddItem: (clientId === "CL-002" || clientId === "CL-003"),
    accentColor: "#F5C518",
    allowChat: true,
    allowLogs: true,
    allowUpdate: true
  };

  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("User_Credentials");
    if (!sheet) return defaults;
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      var cid = data[i][0] ? data[i][0].toString().trim() : "";
      if (cid !== (clientId || "")) continue;

      defaults.clientId = cid;
      defaults.clientName = data[i][3] ? data[i][3].toString().trim() : cid;
      defaults.portalTitle = (data[i][6] && data[i][6].toString().trim()) || defaults.portalTitle;
      defaults.portalSubtitle = (data[i][7] && data[i][7].toString().trim()) || defaults.portalSubtitle;
      defaults.inventoryMode = (data[i][8] && data[i][8].toString().trim()) || defaults.inventoryMode;
      defaults.enableAddItem = (data[i][9] !== undefined && data[i][9] !== "")
        ? String(data[i][9]).toLowerCase() === "true" || String(data[i][9]).toLowerCase() === "yes" || String(data[i][9]).toLowerCase() === "1"
        : defaults.enableAddItem;
      defaults.accentColor = (data[i][10] && data[i][10].toString().trim()) || defaults.accentColor;
      defaults.allowChat = (data[i][11] === undefined || data[i][11] === "") ? defaults.allowChat : String(data[i][11]).toLowerCase() !== "false";
      defaults.allowLogs = (data[i][12] === undefined || data[i][12] === "") ? defaults.allowLogs : String(data[i][12]).toLowerCase() !== "false";
      defaults.allowUpdate = (data[i][13] === undefined || data[i][13] === "") ? defaults.allowUpdate : String(data[i][13]).toLowerCase() !== "false";
      break;
    }
    return defaults;
  } catch (e) {
    Logger.log("getClientProfile error: " + e.toString());
    return defaults;
  }
}

function getClientRoster() {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("User_Credentials");
    if (!sheet) return [];
    var data = sheet.getDataRange().getValues();
    var roster = [];
    var seen = {};
    for (var i = 1; i < data.length; i++) {
      var cid = data[i][0] ? data[i][0].toString().trim() : "";
      if (!cid || cid === "CL-000" || seen[cid]) continue;
      seen[cid] = true;
      roster.push({
        clientId:   cid,
        clientName: data[i][3] ? data[i][3].toString().trim() : cid,
        profile:    getClientProfile(cid)
      });
    }
    return roster;
  } catch (e) {
    Logger.log("getClientRoster error: " + e.toString());
    return [];
  }
}

function getEditPin(clientId) {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("User_Credentials");
    if (!sheet) return "646";
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      var cid = data[i][0] ? data[i][0].toString().trim() : "";
      if (cid === clientId) {
        var pin = data[i][5] ? data[i][5].toString().trim() : "";
        return pin || "646";
      }
    }
    return "646";
  } catch (e) {
    return "646";
  }
}

function tryAutoLogin() {
  try {
    var email = Session.getActiveUser().getEmail();
    if (!email) return { success: false, attempted: true, message: "No Google session detected." };

    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("User_Credentials");
    if (!sheet) return { success: false, attempted: true, message: "Security registry not found." };

    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      var rowEmail = data[i][4] ? data[i][4].toString().trim().toLowerCase() : "";
      if (rowEmail && rowEmail === email.toLowerCase()) {
        var clientId = data[i][0].toString().trim();
        var clientProfile = getClientProfile(clientId);
        return {
          success:    true,
          attempted:  true,
          clientId:   clientId,
          clientName: data[i][3].toString().trim(),
          editPin:    data[i][5] ? data[i][5].toString().trim() : "",
          profile:    clientProfile
        };
      }
    }
    return { success: false, attempted: true, message: "Your Google account (" + email + ") isn't linked to a client yet." };
  } catch (e) {
    Logger.log("tryAutoLogin error: " + e.toString());
    return { success: false, attempted: true, message: e.toString() };
  }
}

function ensureChatSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Chat_log");
  if (!sheet) {
    sheet = ss.insertSheet("Chat_log");
  }

  var requiredCols = 7;
  var maxCols = sheet.getMaxColumns();
  if (maxCols < requiredCols) {
    sheet.insertColumnsAfter(maxCols, requiredCols - maxCols);
  }

  var header = sheet.getRange(1, 1, 1, requiredCols).getValues()[0];
  if (!header[0] || String(header[0]).trim() !== "Timestamp") {
    sheet.getRange(1, 1, 1, requiredCols).setValues([
      ["Timestamp", "Sender", "Message", "ClientID", "IsStaff", "FileUrl", "FileName"]
    ]);
  }

  return sheet;
}

function getChatHistory(clientId) {
  try {
    var sheet = ensureChatSheet();
    var values = sheet.getDataRange().getValues();
    var history = [];
    var tz = Session.getScriptTimeZone();

    for (var i = 1; i < values.length; i++) {
      if (!values[i][0]) continue;

      var rowClientId = values[i][3] ? values[i][3].toString().trim() : "";
      var isStaffMsg  = values[i][4] ? values[i][4].toString().trim() === "1" : false;
      var fileUrl     = values[i][5] ? values[i][5].toString().trim() : "";
      var fileName    = values[i][6] ? values[i][6].toString().trim() : "";

      if (clientId !== "CL-000" && rowClientId !== clientId) continue;

      var stamp = Utilities.formatDate(new Date(values[i][0]), tz, "MM/dd/yy HH:mm");
      history.push({
        timestamp: stamp,
        sender:    values[i][1] ? values[i][1].toString() : "",
        message:   values[i][2] ? values[i][2].toString() : "",
        clientId:  rowClientId,
        isStaff:   isStaffMsg,
        fileUrl:   fileUrl,
        fileName:  fileName
      });
    }
    return history;
  } catch (e) {
    Logger.log("getChatHistory error: " + e.toString());
    return [];
  }
}

function sendMessage(sender, message, clientId, isStaffFlag) {
  try {
    var sheet = ensureChatSheet();
    sheet.appendRow([new Date(), sender, message, clientId, isStaffFlag ? "1" : "", "", ""]);
    return { success: true };
  } catch (e) {
    Logger.log("sendMessage error: " + e.toString());
    return { success: false, message: e.toString() };
  }
}

function getClientDriveFolder(clientId) {
  var folderId = CHAT_DRIVE_FOLDERS[clientId];
  if (!folderId) {
    throw new Error("No Drive folder configured for " + clientId + ".");
  }

  try {
    var folder = DriveApp.getFolderById(folderId);
    return folder;
  } catch (e) {
    var msg = e && e.message ? e.message : String(e);
    throw new Error("Drive access denied for " + clientId + ". Share the folder with the signed-in Google account and reauthorize the app. Error: " + msg);
  }
}

function sendChatFile(sender, clientId, isStaffFlag, fileName, mimeType, base64Data, caption) {
  try {
    var folder = getClientDriveFolder(clientId);
    var bytes  = Utilities.base64Decode(base64Data);
    var blob   = Utilities.newBlob(bytes, mimeType, fileName);
    var file   = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    var fileUrl  = file.getUrl();
    var sheet    = ensureChatSheet();

    var messageText = caption && caption.trim() ? caption.trim() : "📎 Sent a file";
    sheet.appendRow([new Date(), sender, messageText, clientId, isStaffFlag ? "1" : "", fileUrl, fileName]);

    return { success: true, fileUrl: fileUrl };
  } catch (e) {
    Logger.log("sendChatFile error: " + e.toString());
    return { success: false, message: e && e.message ? e.message : String(e) };
  }
}

function getChatClientList() {
  try {
    return getClientRoster();
  } catch (e) {
    return [];
  }
}

function markStaffViewing(clientId) {
  try {
    PropertiesService.getScriptProperties().setProperty(
      "staff_viewing_" + clientId, new Date().getTime().toString()
    );
    return { success: true };
  } catch (e) {
    return { success: false };
  }
}

function isStaffViewing(clientId) {
  try {
    var val = PropertiesService.getScriptProperties().getProperty("staff_viewing_" + clientId);
    if (!val) return { active: false };
    var elapsed = new Date().getTime() - parseInt(val);
    return { active: elapsed < 12000 };
  } catch (e) {
    return { active: false };
  }
}

function markTyping(threadClientId, whoKey) {
  try {
    PropertiesService.getScriptProperties().setProperty(
      "typing_" + threadClientId + "_" + whoKey, new Date().getTime().toString()
    );
    return { success: true };
  } catch (e) {
    return { success: false };
  }
}

function isAnyoneTyping(threadClientId, excludeWhoKey) {
  try {
    var props  = PropertiesService.getScriptProperties().getProperties();
    var prefix = "typing_" + threadClientId + "_";
    var now    = new Date().getTime();
    for (var key in props) {
      if (key.indexOf(prefix) !== 0) continue;
      var whoKey = key.substring(prefix.length);
      if (whoKey === excludeWhoKey) continue;
      var elapsed = now - parseInt(props[key]);
      if (elapsed < 4000) return { typing: true };
    }
    return { typing: false };
  } catch (e) {
    return { typing: false };
  }
}

function getUnreadCount(clientId, isStaffViewer, lastSeenEpochMs) {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Chat_log");
    if (!sheet) return { count: 0 };
    var values = sheet.getDataRange().getValues();
    var count  = 0;
    for (var i = 1; i < values.length; i++) {
      if (!values[i][0]) continue;
      var rowClientId = values[i][3] ? values[i][3].toString().trim() : "";
      if (rowClientId !== clientId) continue;
      var rowIsStaff = values[i][4] ? values[i][4].toString().trim() === "1" : false;
      if (isStaffViewer && rowIsStaff) continue;
      if (!isStaffViewer && !rowIsStaff) continue;
      var ts = new Date(values[i][0]).getTime();
      if (ts > (lastSeenEpochMs || 0)) count++;
    }
    return { count: count };
  } catch (e) {
    return { count: 0 };
  }
}

function doGet() {
  var htmlOutput;
  try {
    htmlOutput = HtmlService.createHtmlOutputFromFile('index');
  } catch (e) {
    try {
      htmlOutput = HtmlService.createHtmlOutputFromFile('Index');
    } catch (err) {
      throw new Error("Could not find an HTML file named 'index' or 'Index'.");
    }
  }
  return htmlOutput
    .setTitle('ECL Inventory Portal')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

if (typeof module !== 'undefined') {
  module.exports = {
    isValidCL001Sku,
    parseHistoryLog,
    splitCL002Notes,
    getInventoryData,
    webUpdateQty,
    getActivityLog,
    getCL002ShipmentData,
    getCL002ActivityLog,
    updateCL002Row,
    addCL002Row,
    getCL003HeaderMap,
    readCL003Cell,
    ensureCL003Sheet,
    getCL003InventoryData,
    addCL003Item,
    updateCL003Row,
    validateLogin,
    getClientProfile,
    getClientRoster,
    getEditPin,
    tryAutoLogin,
    ensureChatSheet,
    getChatHistory,
    sendMessage,
    getClientDriveFolder,
    sendChatFile,
    getChatClientList,
    markStaffViewing,
    isStaffViewing,
    markTyping,
    isAnyoneTyping,
    getUnreadCount,
    doGet
  };
}
