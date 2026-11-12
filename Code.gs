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
 *   Col B  (1)  = Product Title (legacy Product Description column, retained in place)
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
 *   Role is resolved by header and must be admin, staff or client. Explicit roles override Client_ID.
 *   Legacy blank roles default to admin for CL-000 and client otherwise; the portal persists this on login.
 *   Express enforces signed-session account scoping; warehouse staff cannot access master settings or billing.
 *   Staff registration and profile edits use the administrator-only portal API.
 *   Client_Settings_JSON.enableShippedTab defaults to true; explicit false keeps all inventory together.
 *   Custom inventory uses fulfillment stages. The portal API appends Status to legacy shipment sheets;
 *   only staff can edit stages. Quantity check-in defaults to Arrived / Check-In; full shipment sets Shipped out.
 *   ECL Tracking reads these sheet stages and Check_In_Timestamp through the authenticated portal API.
 *   Arrived at Warehouse is an alias for Arrived / Check-In. Carrier links do not fetch live carrier events.
 *   Optional public catalog imports run through /api/catalog/sync, then require manual review and save.
 *   Product Image URL, Is Bundled and Bundle Quantity reuse existing columns or append after existing data.
 *   Website access is public-only; authenticated stores and feeds over 2 MB use manual entry instead.
 *   Optional store configuration uses appended Store_Integration_JSON (platform/domain) and
 *   Store_Integration_Secret (AES-256-GCM ciphertext) in User_Credentials via the authenticated API.
 *   Platforms: Shopify, WooCommerce, BigCommerce, Amazon, Wix and custom storefronts.
 *   Optional API tokens and extra connection details are encrypted; configuration does not enable sync.
 *   Website_URL and Logo_URL append client branding metadata; Accent_Color stores its editable hex color.
 *   Branding lookup and account-scoped saves run through the authenticated Express API.
 *   Never place plaintext API tokens or STORE_INTEGRATION_KEY in the sheet or return ciphertext in profiles.
 *   Saving configuration does not enable automatic order sync or provision a webhook receiver.
 *   All clients can use the dedicated Inbound_Shipments sheet via /api/inbound-shipments.
 *   Client_Settings_JSON.enableInboundShipments defaults to true; admins can disable it per account.
 *   Headers: Shipment_ID, Client_ID, Carrier, Tracking_Number, Expected_Delivery_Date, Contents_JSON,
 *   Status, Created_At, Created_By, Arrived_At, Arrived_By. Contents_JSON holds [{sku, quantity}].
 *   Only ECL staff record arrivals by tracking barcode; notices and arrival alone never change inventory quantities.
 *   Express receiving reviews add confirmed usable quantities and log lost/damaged units in Receiving_JSON.
 *   Inventory Inbound_Receiving_Log markers prevent same-receipt stock increments on retry.
 *   Express admin-only deletion requires server ADMIN_DELETION_PIN and a reason, preserves
 *   Inbound_Deletion_Audit, and reverses stock only when receiving snapshots still match.
 *   Packaging_Notes in User_Credentials holds client-wide SOP text (up to 5000 characters).
 *   Special Prep Instructions is per-SKU metadata, appended without moving legacy inventory columns.
 *   The portal shows both instructions at receiving/check-in, item inspection and fulfillment updates.
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

function fulfillmentStatus_(saved, received, shipped) {
  var status = String(saved || "").trim();
  var stages = ["In Transit to Warehouse", "Arrived / Check-In", "Received & Verified", "In Prep", "Shipped out"];
  if ((Number(shipped) > 0 && Number(shipped) >= Number(received)) || /^(shipped|fully shipped|delivered|shipped out)$/i.test(status)) return stages[4];
  if (/^arrived at warehouse$/i.test(status)) return stages[1];
  if (stages.indexOf(status) >= 0) return status === stages[0] && Number(received) > 0 ? stages[1] : status;
  return Number(received) > 0 ? stages[1] : stages[0];
}

function getInventoryData(clientId) {
  try {
    var sheetName = (clientId === "CL-000" || !clientId) ? "CL-001" : clientId;
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
    if (!sheet) throw new Error("Inventory sheet '" + sheetName + "' could not be found.");

    if (getClientProfile(sheetName).inventoryMode === "custom") {
      var grid = sheet.getDataRange().getValues();
      var headers = grid[0].map(function(value) { return String(value || "").trim().toLowerCase(); });
      var titleIndex = headers.findIndex(function(value) { return /product.*(title|description|name)/.test(value); });
      if (titleIndex < 0) titleIndex = 1;
      var qtyIndex = headers.indexOf("qty");
      if (qtyIndex < 0) qtyIndex = headers.indexOf("quantity ordered");
      return grid.slice(1).filter(function(row) { return row[titleIndex]; }).map(function(row) {
        return [sheetName, row[0], row[titleIndex], Number(row[qtyIndex]) || 0,
          fulfillmentStatus_(row[headers.indexOf("status")], row[headers.indexOf("quantity received")], row[headers.indexOf("quantity shipped")])];
      });
    }

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

    var width = Math.max(13, sheet.getLastColumn());
    var statusHeaders = sheet.getRange(1, 1, 1, width).getValues()[0].map(function(value) { return String(value || "").trim().toLowerCase(); });
    var range = sheet.getRange(2, 1, lastRow - 1, width);
    var values = range.getValues();
    var results = [];

    for (var i = 0; i < values.length; i++) {
      var row = values[i];
      var rowNumber = 2 + i;
      var desc = getCL002DisplayTitle(row);
      if (!desc) continue;

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

      var status = fulfillmentStatus_(row[statusHeaders.indexOf("status")], received, shipped);
      var isActive = status !== "Shipped out";

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
        imageUrl:         String(row[statusHeaders.indexOf("product image url")] || ""),
        prepInstructions: String(row[statusHeaders.indexOf("special prep instructions")] || ""),
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

function getCL002DisplayTitle(row) {
  var description = String(row[1] == null ? "" : row[1]).trim();
  if (description === "Product Description") return "";
  return description || String(row[0] == null ? "" : row[0]).trim() || String(row[7] == null ? "" : row[7]).trim();
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
      var desc = getCL002DisplayTitle(row);
      if (!desc) continue;

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
    fields = Object.assign({}, fields);
    validateCatalogDetails_(fields);
    if (!fields.hasOwnProperty("description")) {
      if (fields.hasOwnProperty("title")) fields.description = fields.title;
      else if (fields.hasOwnProperty("productDescription")) fields.description = fields.productDescription;
    }
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
    if (fields.hasOwnProperty("imageUrl")) {
      var image = validateProductImageUrl_(fields.imageUrl);
      var imageColumn = ensureProductImageColumn_(sheet);
      fields.imageUrl = image;
      colMap.imageUrl = imageColumn;
    }
    if (fields.hasOwnProperty("prepInstructions")) {
      fields.prepInstructions = validatePrepInstructions_(fields.prepInstructions);
      colMap.prepInstructions = ensurePrepInstructionsColumn_(sheet);
    }

    var changedDescriptions = [];
    Object.keys(colMap).forEach(function(key) {
      if (!fields.hasOwnProperty(key)) return;
      var col = colMap[key];
      var newVal = fields[key];
      var cell = sheet.getRange(rowNumber, col);
      var oldVal = cell.getValue();
      if (oldVal.toString().trim() === (newVal === null || newVal === undefined ? "" : newVal.toString().trim())) return;
      cell.setValue(key === "prepInstructions" && String(newVal).charAt(0) === "=" ? "'" + newVal : newVal);
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
    validateCatalogDetails_(fields);
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("CL-002");
    if (!sheet) return { success: false, message: "CL-002 sheet not found." };

    var tz = Session.getScriptTimeZone();
    var timestamp = Utilities.formatDate(new Date(), tz, "MM/dd/yy HH:mm");
    var noteParts = [];
    if (fields.notes && fields.notes.toString().trim()) noteParts.push(fields.notes.toString().trim());
    noteParts.push("[" + timestamp + "] Created");

    var newRow = [
      fields.upc || "",
      fields.title || fields.description || fields.productDescription || "",
      fields.qtyOrdered || "",
      fields.qtyReceived || "",
      fields.qtyShipped || "",
      fields.expDate || "",
      fields.merchant || "",
      fields.asin || "",
      fields.fulfillment || "",
      fields.transparencyCode || "",
      fields.bundled || "",
      fields.bundleQty == null ? "" : fields.bundleQty,
      noteParts.join(" | ")
    ];
    if (fields.hasOwnProperty("imageUrl")) {
      var image = validateProductImageUrl_(fields.imageUrl);
      var imageColumn = ensureProductImageColumn_(sheet);
      while (newRow.length < imageColumn) newRow.push("");
      newRow[imageColumn - 1] = image;
    }

    if (fields.hasOwnProperty("prepInstructions")) {
      var prep = validatePrepInstructions_(fields.prepInstructions);
      var prepColumn = ensurePrepInstructionsColumn_(sheet);
      while (newRow.length < prepColumn) newRow.push("");
      newRow[prepColumn - 1] = prep.charAt(0) === "=" ? "'" + prep : prep;
    }
    sheet.appendRow(newRow);
    return { success: true, rowNumber: sheet.getLastRow() };
  } catch (err) {
    Logger.log("addCL002Row error: " + err.toString());
    return { success: false, message: "Internal error: " + err.toString() };
  }
}

function validateProductImageUrl_(value) {
  var image = String(value == null ? "" : value).trim();
  if (image && (image.length > 2000 || !/^https?:\/\/[^\/\s@]+(?:\/[^\s]*)?$/i.test(image))) throw new Error("Enter a public HTTP or HTTPS product image URL without credentials.");
  return image;
}

function validateCatalogDetails_(fields) {
  if (fields.hasOwnProperty("prepInstructions")) validatePrepInstructions_(fields.prepInstructions);
  if (fields.hasOwnProperty("imageUrl")) validateProductImageUrl_(fields.imageUrl);
  if (fields.hasOwnProperty("bundled") && String(fields.bundled || "").trim() && !/^(y|n|yes|no|true|false|1|0)$/i.test(String(fields.bundled).trim())) throw new Error("Is Bundled must be Y or N.");
  if (fields.hasOwnProperty("bundleQty") && String(fields.bundleQty == null ? "" : fields.bundleQty).trim()) {
    var quantity = Number(fields.bundleQty);
    if (!isFinite(quantity) || quantity < 0 || Math.floor(quantity) !== quantity || quantity > 9007199254740991) throw new Error("Bundle Quantity must be a non-negative whole number.");
  }
}

function validatePrepInstructions_(value) {
  var text = String(value == null ? "" : value).trim();
  if (text.length > 5000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new Error("Special Prep Instructions must be 5000 characters or fewer without control characters.");
  return text;
}

function ensurePrepInstructionsColumn_(sheet) {
  var width = Math.max(13, sheet.getLastColumn());
  var headers = sheet.getRange(1, 1, 1, width).getValues()[0];
  var index = headers.map(function(value) { return String(value || "").trim().toLowerCase(); }).indexOf("special prep instructions");
  if (index >= 0) return index + 1;
  var column = width + 1;
  if (column > sheet.getMaxColumns()) sheet.insertColumnsAfter(sheet.getMaxColumns(), column - sheet.getMaxColumns());
  sheet.getRange(1, column).setValue("Special Prep Instructions");
  return column;
}

function ensureProductImageColumn_(sheet) {
  var width = Math.max(13, sheet.getLastColumn());
  var headers = sheet.getRange(1, 1, 1, width).getValues()[0];
  var index = headers.map(function(value) { return String(value || "").trim().toLowerCase(); }).indexOf("product image url");
  if (index >= 0) return index + 1;
  var column = width + 1;
  if (column > sheet.getMaxColumns()) sheet.insertColumnsAfter(sheet.getMaxColumns(), column - sheet.getMaxColumns());
  sheet.getRange(1, column).setValue("Product Image URL");
  return column;
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

function getCredentialRole(headers, row) {
  var roleIndex = headers.map(function(header) { return String(header).trim().toLowerCase(); }).indexOf("role");
  var role = roleIndex >= 0 ? String(row[roleIndex] || "").trim().toLowerCase() : "";
  role = role || (String(row[0] || "").trim() === "CL-000" ? "admin" : "client");
  return String(row[0] || "").trim() && ["admin", "staff", "client"].indexOf(role) >= 0
    && !(role === "client" && String(row[0] || "").trim() === "CL-000") ? role : "";
}

function persistCredentialRole_(sheet, rowIndex, role) {
  var lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    var data = sheet.getDataRange().getValues();
    var roleIndex = data[0].map(function(header) { return String(header).trim().toLowerCase(); }).indexOf("role");
    if (roleIndex < 0) {
      roleIndex = data[0].length;
      if (sheet.getMaxColumns() <= roleIndex) {
        sheet.insertColumnsAfter(sheet.getMaxColumns(), roleIndex + 1 - sheet.getMaxColumns());
      }
      sheet.getRange(1, roleIndex + 1).setValue("Role");
    }
    if (!String(data[rowIndex][roleIndex] || "").trim()) {
      sheet.getRange(rowIndex + 1, roleIndex + 1).setValue(role);
    }
  } finally {
    lock.releaseLock();
  }
}

function recordUserLogin_(username, clientId, authType) {
  var lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("User_Logins");
    if (!sheet) {
      sheet = ss.insertSheet("User_Logins");
      sheet.appendRow(["Timestamp", "Username", "ClientID", "AuthType"]);
    } else if (sheet.getLastRow() === 0) {
      sheet.appendRow(["Timestamp", "Username", "ClientID", "AuthType"]);
    }
    sheet.appendRow([new Date().toISOString(), username, clientId, authType]);
  } finally {
    lock.releaseLock();
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
      var role = getCredentialRole(data[0], data[i]);
      if (!role) continue;
      if (rowUser === username.trim() && rowPass === password.trim()) {
        var clientId = data[i][0].toString().trim();
        var clientProfile = getClientProfile(clientId);
        persistCredentialRole_(sheet, i, role);
        recordUserLogin_(rowUser, clientId, "Credentials");
        return {
          success:    true,
          clientId:   clientId,
          clientName: data[i][3].toString().trim(),
          role:       role,
          enableShippedTab: clientProfile.enableShippedTab,
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
    allowUpdate: true,
    enableShippedTab: true,
    enableInboundShipments: true,
    packagingNotes: "",
    websiteUrl: "",
    logoUrl: ""
  };

  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("User_Credentials");
    if (!sheet) return defaults;
    var data = sheet.getDataRange().getValues();
    var headers = data[0].map(function(header) { return String(header).trim().toLowerCase(); });
    var getSetting = function(row, header, legacyIndex) {
      var index = headers.indexOf(header.toLowerCase());
      if (index < 0 && headers.indexOf("role") < 0) index = legacyIndex;
      return index >= 0 ? row[index] : "";
    };
    for (var i = 1; i < data.length; i++) {
      var cid = data[i][0] ? data[i][0].toString().trim() : "";
      if (cid !== (clientId || "")) continue;

      defaults.clientId = cid;
      var websiteIndex = headers.indexOf("website_url");
      var logoIndex = headers.indexOf("logo_url");
      defaults.websiteUrl = websiteIndex >= 0 ? String(data[i][websiteIndex] || "").trim() : "";
      defaults.logoUrl = logoIndex >= 0 ? String(data[i][logoIndex] || "").trim() : "";
      var packagingIndex = headers.indexOf("packaging_notes");
      defaults.packagingNotes = packagingIndex >= 0 ? String(data[i][packagingIndex] || "").trim() : "";
      defaults.clientName = data[i][3] ? data[i][3].toString().trim() : cid;
      var settingsIndex = headers.indexOf("client_settings_json");
      var settings = {};
      if (settingsIndex >= 0 && data[i][settingsIndex]) {
        try {
          settings = JSON.parse(String(data[i][settingsIndex])) || {};
        } catch (settingsError) {
          Logger.log("Invalid client settings for " + cid + ": " + settingsError.toString());
        }
      }
      defaults.enableShippedTab = [false, "false", 0, "0"].indexOf(settings.enableShippedTab) < 0;
      defaults.enableInboundShipments = [false, "false", 0, "0"].indexOf(settings.enableInboundShipments) < 0;
      defaults.portalTitle = String(getSetting(data[i], "Portal_Title", 6) || "").trim() || defaults.portalTitle;
      defaults.portalSubtitle = String(getSetting(data[i], "Portal_Subtitle", 7) || "").trim() || defaults.portalSubtitle;
      defaults.inventoryMode = String(getSetting(data[i], "Inventory_Mode", 8) || "").trim() || defaults.inventoryMode;
      var enableAddItem = getSetting(data[i], "Enable_Add_Item", 9);
      defaults.enableAddItem = (enableAddItem !== undefined && enableAddItem !== "")
        ? /^(true|yes|1)$/i.test(String(enableAddItem))
        : defaults.enableAddItem;
      defaults.accentColor = String(getSetting(data[i], "Accent_Color", 10) || "").trim() || defaults.accentColor;
      ["allowChat", "allowLogs", "allowUpdate"].forEach(function(key, index) {
        var header = ["Allow_Chat", "Allow_Logs", "Allow_Update"][index];
        var value = getSetting(data[i], header, 11 + index);
        if (value !== undefined && value !== "") defaults[key] = String(value).toLowerCase() !== "false";
      });
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
      if (!cid || cid === "CL-000" || !getCredentialRole(data[0], data[i]) || seen[cid]) continue;
      seen[cid] = true;
      var profile = getClientProfile(cid);
      roster.push({
        clientId:   cid,
        clientName: data[i][3] ? data[i][3].toString().trim() : cid,
        enableShippedTab: profile.enableShippedTab,
        profile:    profile
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
      var role = getCredentialRole(data[0], data[i]);
      if (!role) continue;
      if (rowEmail && rowEmail === email.toLowerCase()) {
        var clientId = data[i][0].toString().trim();
        var clientProfile = getClientProfile(clientId);
        persistCredentialRole_(sheet, i, role);
        recordUserLogin_(String(data[i][1] || "").trim(), clientId, "Auto-Login");
        return {
          success:    true,
          attempted:  true,
          enableShippedTab: clientProfile.enableShippedTab,
          clientId:   clientId,
          clientName: data[i][3].toString().trim(),
          role:       role,
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

function onEdit(e) {
  if (!e || !e.range || !e.source) return;
  var sheet = e.range.getSheet();
  var clientId = sheet.getName();
  if (!/^CL-\d{3,}$/.test(clientId) || clientId === "CL-000") return;
  var rowNumber = e.range.getRow();
  if (rowNumber < (clientId === "CL-001" ? 9 : 2)) return;

  var sku = sheet.getRange(rowNumber, clientId === "CL-001" ? 2 : 1).getDisplayValue().trim();
  if (!sku) return;
  var log = e.source.getSheetByName("Inventory_Events");
  if (!log) {
    log = e.source.insertSheet("Inventory_Events");
    log.appendRow(["Timestamp", "ClientID", "Description", "ActorUsername"]);
  }
  var email = Session.getActiveUser().getEmail() || "";
  log.appendRow([new Date(), clientId, "Edited " + sku + " (" + e.range.getA1Notation() + ")", email]);
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
