/**
 * Main API Bridge for CashFlow PWA (Monthly Tabs Edition)
 * Handles HTTP requests and routes them to appropriate Google Sheets/Drive operations.
 * Automatically organizes transactions into monthly tabs (e.g. "2026-09", "2026-10").
 */

const API_KEY_PROP = 'API_KEY';

const DEFAULT_MONTHLY_HEADERS = [
  'Id', 'Date', 'Type', 'Category', 'SubCategory', 'Description', 
  'Amount', 'Currency', 'TripTag', 'ReceiptUrl', 'Notes'
];

const RECURRING_HEADERS = [
  'Id', 'Name', 'Category', 'SubCategory', 'DayOfMonth', 
  'Amount', 'Currency', 'EffectiveFrom', 'AutoRecord', 'LastAutoRecordedMonth', 'Notes', 'History'
];

const INSTALLMENTS_HEADERS = [
  'Id', 'Name', 'Category', 'Currency', 'TotalPrincipal', 
  'TenureMonths', 'AnnualInterestRate', 'MonthlyAmount', 'TotalPayable', 
  'StartDate', 'EndDate', 'AutoRecord', 'TripTag', 'Notes'
];

/**
 * Checks whether an endpoint API key is configured in Script Properties
 */
function isApiKeyConfigured() {
  const scriptProperties = PropertiesService.getScriptProperties();
  return Boolean((scriptProperties.getProperty(API_KEY_PROP) || '').trim());
}

/**
 * Sets or updates the endpoint API key in Script Properties.
 * Because doPost runs validateApiKey(e) before reaching this function,
 * an existing valid key is always required to rotate the key.
 */
function configureEndpointApiKey(newKey) {
  const scriptProperties = PropertiesService.getScriptProperties();
  const trimmed = String(newKey || '').trim();
  if (trimmed) {
    scriptProperties.setProperty(API_KEY_PROP, trimmed);
  } else {
    scriptProperties.deleteProperty(API_KEY_PROP);
  }
  return {
    configured: Boolean(trimmed),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Validates the API key provided in the request (if one is configured in Script Properties)
 */
function validateApiKey(e) {
  const scriptProperties = PropertiesService.getScriptProperties();
  const validApiKey = (scriptProperties.getProperty(API_KEY_PROP) || '').trim();
  if (!validApiKey) return true;

  let body = {};
  try { body = e.postData && e.postData.contents ? JSON.parse(e.postData.contents) : {}; } catch (err) {}
  const providedApiKey = String((e.parameter && (e.parameter.apiKey || e.parameter.key)) || body.apiKey || body.key || '').trim();
  return validApiKey === providedApiKey;
}

/**
 * Concurrency guard: serializes writes across multiple devices/tabs
 * to prevent race conditions and lost updates.
 */
function withScriptLock(fn) {
  const lock = LockService.getScriptLock();
  const acquired = lock.tryLock(15000);
  if (!acquired) {
    throw new Error("Lock timeout: another device or sync request is currently updating the spreadsheet. Please retry in a few moments.");
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/**
 * Standardize JSON response format with CORS
 */
function createResponse(success, data, message = "") {
  const output = JSON.stringify({
    success: success,
    data: data,
    message: message
  });
  
  return ContentService.createTextOutput(output)
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Handle GET requests
 */
function doGet(e) {
  if (!validateApiKey(e)) {
    return createResponse(false, null, "Unauthorized: Invalid API Key");
  }

  let action = e.parameter.action;
  let params = e.parameter;
  if (e.parameter.payload) {
    try {
      const parsed = JSON.parse(e.parameter.payload);
      params = Object.assign({}, params, parsed);
      if (parsed.action) action = parsed.action;
    } catch (err) {}
  }
  
  try {
    switch (action) {
      case 'ping': {
        const spreadsheet = getSpreadsheet();
        return createResponse(true, {
          pong: true,
          spreadsheetReady: true,
          sheetCount: spreadsheet.getSheets().length,
        });
      }
      case 'getAllSheetNames':
        return createResponse(true, getAllSheetNames());
      case 'getMonthList':
        return createResponse(true, getMonthList());
      case 'getSheetSchema':
        return createResponse(true, getSheetSchema(params.sheetName));
      case 'getSheetData':
        return createResponse(true, getSheetData(params.sheetName, params));
      case 'getSheetDataIfExists':
        return createResponse(true, getExistingSheetData(params.sheetName));
      case 'getAllTransactions':
        return createResponse(true, getAllTransactions(params.limitMonths, params.all, params.year));
      case 'getPortfolio':
        return createResponse(true, getPortfolioData());
      case 'getTrades':
        return createResponse(true, getSheetData('Trades'));
      case 'getOverview':
        return createResponse(true, getOverviewData());
      case 'getSettings':
        return createResponse(true, getSettings());
      case 'getSettingsIfExists':
        return createResponse(true, getSettingsIfExists());
      case 'getBackupStatus':
        return createResponse(true, getCashFlowBackupStatus());
      case 'listBackups':
      case 'listCashFlowBackups':
        return createResponse(true, listCashFlowBackups());
      case 'restoreBackup':
      case 'restoreCashFlowBackup':
        return createResponse(true, withScriptLock(() => restoreCashFlowBackup(params.fileId)));
      case 'testRestoreBackup':
      case 'testRestoreCashFlowBackup':
        return createResponse(true, testRestoreCashFlowBackup(params.fileId));
      case 'runIntegrityCheck':
        return createResponse(true, runIntegrityCheck());
      case 'verifyCashFlowBackup':
        return createResponse(true, verifyCashFlowBackup(params.fileId));
      case 'installWeeklyBackup':
      case 'installCashFlowWeeklyBackup':
        return createResponse(true, installCashFlowWeeklyBackup());
      case 'ensureWeeklyBackup':
      case 'ensureCashFlowWeeklyBackup':
        return createResponse(true, ensureCashFlowWeeklyBackup());
      case 'createCashFlowBackup':
        return createResponse(true, createCashFlowBackup());
      case 'createCashFlowMigrationBackup':
      case 'createDriveSnapshot':
        return createResponse(true, createCashFlowMigrationBackup());
      case 'getFiles':
        const fileFilters = params.filters ? JSON.parse(params.filters) : {};
        return createResponse(true, getFiles(params.folderId, fileFilters));
      case 'getFileUrl':
        return createResponse(true, getFileUrl(params.fileId));
      case 'addRow':
        return createResponse(true, withScriptLock(() => addRow(params.sheetName, params.rowData, { mutationId: params.mutationId })));
      case 'addTrade':
        return createResponse(true, withScriptLock(() => addTrade(params.tradeData, params.mutationId)));
      case 'updateRow':
        return createResponse(true, withScriptLock(() => updateRow(params.sheetName, params.rowIndex, params.rowData, params.mutationId)));
      case 'deleteRow':
        return createResponse(true, withScriptLock(() => deleteRow(params.sheetName, params.rowIndex, params.id, params.mutationId)));
      case 'batchSyncTrades': {
        const rawTrades = (body && body.trades) ? body.trades : params.trades;
        const trades = rawTrades ? (typeof rawTrades === 'string' ? JSON.parse(rawTrades) : rawTrades) : [];
        return createResponse(true, withScriptLock(() => batchSyncTrades(trades)));
      }
      case 'sanitizeCategories':
        return createResponse(true, withScriptLock(() => sanitizeAllSheetCategories()));
      case 'syncAll':
      case 'syncAllSheets':
        return createResponse(true, withScriptLock(() => syncAllSheets()));
      case 'syncPortfolio':
        withScriptLock(() => syncPortfolioFromTrades());
        return createResponse(true, { synced: true, sheet: 'Portfolio' });
      case 'syncOverview':
        withScriptLock(() => {
          if (params.month) {
            updateOverviewForMonth(params.month);
          } else {
            syncAllSheets();
          }
        });
        return createResponse(true, { synced: true, sheet: 'Overview' });
      case 'fixCurrencyFormats':
        return createResponse(true, withScriptLock(() => fixCurrencyFormats()));
      case 'deletePaymentMethodColumn':
        return createResponse(true, withScriptLock(() => deletePaymentMethodColumn()));
      case 'getRecurringCommitments':
        return createResponse(true, getRecurringCommitments());
      case 'saveRecurringCommitments': {
        const comms = params.commitments ? (typeof params.commitments === 'string' ? JSON.parse(params.commitments) : params.commitments) : [];
        return createResponse(true, withScriptLock(() => saveRecurringCommitments(comms)));
      }
      case 'getInstallmentPlans':
        return createResponse(true, getInstallmentPlans());
      case 'saveInstallmentPlans': {
        const plans = params.plans ? (typeof params.plans === 'string' ? JSON.parse(params.plans) : params.plans) : [];
        return createResponse(true, withScriptLock(() => saveInstallmentPlans(plans)));
      }
      case 'reconcilePlans': {
        const mutations = params.mutations ? (typeof params.mutations === 'string' ? JSON.parse(params.mutations) : params.mutations) : [];
        const initialRecords = params.initialRecords ? (typeof params.initialRecords === 'string' ? JSON.parse(params.initialRecords) : params.initialRecords) : [];
        return createResponse(true, reconcilePlans(params.kind, mutations, initialRecords));
      }
      case 'setupRecurringAndInstallments':
        return createResponse(true, withScriptLock(() => setupRecurringAndInstallments()));
      default:
        return createResponse(false, null, `Unknown action: ${action}`);
    }
  } catch (error) {
    console.error(`Error in doGet (${action}):`, error);
    return createResponse(false, null, error.message || String(error));
  }
}

/**
 * Handle POST requests
 */
function doPost(e) {
  if (!validateApiKey(e)) {
    return createResponse(false, null, "Unauthorized: Invalid API Key");
  }

  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (error) {
    return createResponse(false, null, "Invalid JSON payload");
  }

  const action = body.action || e.parameter.action;

  try {
    switch (action) {
      case 'addRow':
        return createResponse(true, withScriptLock(() => addRow(body.sheetName, body.rowData, { mutationId: body.mutationId })));
      case 'addTrade':
        return createResponse(true, withScriptLock(() => addTrade(body.tradeData, body.mutationId)));
      case 'updateRow':
        return createResponse(true, withScriptLock(() => updateRow(body.sheetName, body.rowIndex, body.rowData, body.mutationId)));
      case 'deleteRow':
        return createResponse(true, withScriptLock(() => deleteRow(body.sheetName, body.rowIndex, body.id, body.mutationId)));
      case 'updateSettings':
        return createResponse(true, withScriptLock(() => updateSettings(body.key, body.value, body.mutationId)));
      case 'uploadFile':
        return createResponse(true, uploadFile(body.fileName, body.mimeType, body.base64Data, body.folderId));
      case 'deleteFile':
        return createResponse(true, deleteFile(body.fileId));
      case 'getFiles':
        return createResponse(true, getFiles(body.folderId, body.filters || {}));
      case 'getFileUrl':
        return createResponse(true, getFileUrl(body.fileId));
      case 'getBackupStatus':
        return createResponse(true, getCashFlowBackupStatus());
      case 'listBackups':
      case 'listCashFlowBackups':
        return createResponse(true, listCashFlowBackups());
      case 'restoreBackup':
      case 'restoreCashFlowBackup':
        return createResponse(true, withScriptLock(() => restoreCashFlowBackup(body.fileId)));
      case 'testRestoreBackup':
      case 'testRestoreCashFlowBackup':
        return createResponse(true, testRestoreCashFlowBackup(body.fileId));
      case 'verifyCashFlowBackup':
        return createResponse(true, verifyCashFlowBackup(body.fileId));
      case 'runIntegrityCheck':
        return createResponse(true, runIntegrityCheck());
      case 'configureEndpointKey':
      case 'configureEndpointApiKey':
        return createResponse(true, configureEndpointApiKey(body.newKey));
      case 'installWeeklyBackup':
      case 'installCashFlowWeeklyBackup':
        return createResponse(true, installCashFlowWeeklyBackup());
      case 'ensureWeeklyBackup':
      case 'ensureCashFlowWeeklyBackup':
        return createResponse(true, ensureCashFlowWeeklyBackup());
      case 'createCashFlowBackup':
        return createResponse(true, createCashFlowBackup());
      case 'createCashFlowMigrationBackup':
      case 'createDriveSnapshot':
        return createResponse(true, createCashFlowMigrationBackup());
      case 'batchSyncTrades': {
        const rawTrades = (body && body.trades) ? body.trades : params.trades;
        const trades = rawTrades ? (typeof rawTrades === 'string' ? JSON.parse(rawTrades) : rawTrades) : [];
        return createResponse(true, withScriptLock(() => batchSyncTrades(trades)));
      }
      case 'sanitizeCategories':
        return createResponse(true, withScriptLock(() => sanitizeAllSheetCategories()));
      case 'syncAll':
      case 'syncAllSheets':
        return createResponse(true, withScriptLock(() => syncAllSheets()));
      case 'syncPortfolio':
        withScriptLock(() => syncPortfolioFromTrades());
        return createResponse(true, { synced: true, sheet: 'Portfolio' });
      case 'syncOverview':
        withScriptLock(() => {
          if (body.month) {
            updateOverviewForMonth(body.month);
          } else {
            syncAllSheets();
          }
        });
        return createResponse(true, { synced: true, sheet: 'Overview' });
      case 'fixCurrencyFormats':
        return createResponse(true, withScriptLock(() => fixCurrencyFormats()));
      case 'deletePaymentMethodColumn':
        return createResponse(true, withScriptLock(() => deletePaymentMethodColumn()));
      case 'getRecurringCommitments':
        return createResponse(true, getRecurringCommitments());
      case 'saveRecurringCommitments': {
        const comms = body.commitments || body.rowData || [];
        return createResponse(true, withScriptLock(() => saveRecurringCommitments(typeof comms === 'string' ? JSON.parse(comms) : comms)));
      }
      case 'getInstallmentPlans':
        return createResponse(true, getInstallmentPlans());
      case 'saveInstallmentPlans': {
        const plans = body.plans || body.rowData || [];
        return createResponse(true, withScriptLock(() => saveInstallmentPlans(typeof plans === 'string' ? JSON.parse(plans) : plans)));
      }
      case 'reconcilePlans': {
        const mutations = body.mutations ? (typeof body.mutations === 'string' ? JSON.parse(body.mutations) : body.mutations) : [];
        const initialRecords = body.initialRecords ? (typeof body.initialRecords === 'string' ? JSON.parse(body.initialRecords) : body.initialRecords) : [];
        return createResponse(true, reconcilePlans(body.kind, mutations, initialRecords));
      }
      case 'setupRecurringAndInstallments':
        return createResponse(true, withScriptLock(() => setupRecurringAndInstallments()));
      default:
        return createResponse(false, null, `Unknown action: ${action}`);
    }
  } catch (error) {
    console.error(`Error in doPost (${action}):`, error);
    return createResponse(false, null, error.message || String(error));
  }
}

// --- Sheets API Core ---

let _cachedSpreadsheet = null;

function getSpreadsheet() {
  if (_cachedSpreadsheet) return _cachedSpreadsheet;
  const props = PropertiesService.getScriptProperties();
  const storedId = props.getProperty('SPREADSHEET_ID');
  if (storedId) {
    try {
      _cachedSpreadsheet = SpreadsheetApp.openById(storedId);
      return _cachedSpreadsheet;
    } catch (e) {
      console.warn("Could not open spreadsheet by stored ID:", e);
    }
  }
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) {
    _cachedSpreadsheet = active;
    return _cachedSpreadsheet;
  }
  throw new Error("No spreadsheet found. Please run initialSetup() once first.");
}

/**
 * Get all available month tabs (formatted YYYY-MM)
 */
function getMonthList() {
  const monthRegex = /^\d{4}-\d{2}$/;
  return getSpreadsheet().getSheets()
    .map(s => s.getName())
    .filter(name => monthRegex.test(name))
    .sort()
    .reverse();
}

/**
 * Get target sheet, automatically creating month sheet if needed (when autoCreate = true)
 */
function getSheet(sheetName, autoCreate = true) {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(sheetName);
  
  if (!sheet && autoCreate) {
    if (/^\d{4}-\d{2}$/.test(sheetName)) {
      if (typeof createMonthSheet === 'function') {
        sheet = createMonthSheet(ss, sheetName);
      } else {
        sheet = ss.insertSheet(sheetName);
      }
    } else if (sheetName === 'Trades') {
      if (typeof setupTradesSheet === 'function') setupTradesSheet(ss);
      sheet = ss.getSheetByName('Trades') || ss.insertSheet('Trades');
    } else if (sheetName === 'Portfolio') {
      if (typeof setupPortfolioSheet === 'function') setupPortfolioSheet(ss);
      sheet = ss.getSheetByName('Portfolio') || ss.insertSheet('Portfolio');
    } else if (sheetName === 'Trips') {
      if (typeof setupTripsSheet === 'function') setupTripsSheet(ss);
      sheet = ss.getSheetByName('Trips') || ss.insertSheet('Trips');
    } else if (sheetName === 'Invoices') {
      if (typeof setupInvoicesSheet === 'function') setupInvoicesSheet(ss);
      sheet = ss.getSheetByName('Invoices') || ss.insertSheet('Invoices');
    } else if (sheetName === 'Recurring') {
      if (typeof setupRecurringSheet === 'function') setupRecurringSheet(ss);
      sheet = ss.getSheetByName('Recurring') || ss.insertSheet('Recurring');
    } else if (sheetName === 'Installments') {
      if (typeof setupInstallmentsSheet === 'function') setupInstallmentsSheet(ss);
      sheet = ss.getSheetByName('Installments') || ss.insertSheet('Installments');
    } else {
      sheet = ss.insertSheet(sheetName);
    }
  }
  
  if (!sheet) {
    if (!autoCreate) return null;
    throw new Error(`Sheet '${sheetName}' not found.`);
  }
  return sheet;
}

function getAllSheetNames() {
  return getSpreadsheet().getSheets().map(s => s.getName());
}

function getSheetSchema(sheetName) {
  if (sheetName === 'Recurring') return RECURRING_HEADERS;
  if (sheetName === 'Installments') return INSTALLMENTS_HEADERS;

  // If generic "Transactions", resolve to current month tab
  if (!sheetName || sheetName === 'Transactions') {
    const months = getMonthList();
    sheetName = months.length > 0 ? months[0] : Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM");
  }

  const sheet = getSheet(sheetName, false);
  if (!sheet) return DEFAULT_MONTHLY_HEADERS;
  const lastColumn = sheet.getLastColumn();
  if (lastColumn === 0) return DEFAULT_MONTHLY_HEADERS;
  
  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
  return headers.filter(h => h !== "");
}

/**
 * Reads data from a sheet.
 * If sheetName is "Transactions", reads from specified month or current month.
 * Never auto-creates missing historical month tabs during a read!
 */
function getSheetData(sheetName, params = {}) {
  // Resolve month
  if (!sheetName || sheetName === 'Transactions') {
    if (params.month) {
      sheetName = params.month;
    } else {
      const months = getMonthList();
      const currentMonth = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM");
      sheetName = months.includes(currentMonth) ? currentMonth : (months[0] || currentMonth);
    }
  }

  const isMonthlyTab = /^\d{4}-\d{2}$/.test(String(sheetName || ''));
  const sheet = getSheet(sheetName, !isMonthlyTab);
  if (!sheet) {
    return {
      headers: DEFAULT_MONTHLY_HEADERS,
      rows: []
    };
  }

  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  
  if (lastRow <= 1 || lastColumn === 0) {
    return {
      headers: lastRow === 1 && lastColumn > 0
        ? sheet.getRange(1, 1, 1, lastColumn).getValues()[0].filter(h => h !== "")
        : DEFAULT_MONTHLY_HEADERS,
      rows: []
    };
  }
  
  const data = sheet.getRange(1, 1, lastRow, lastColumn).getValues();
  const headers = data[0];
  const rows = [];
  const tz = Session.getScriptTimeZone();
  
  for (let i = 1; i < data.length; i++) {
    const rowObj = { _rowIndex: i + 1, _month: sheetName };
    let hasData = false;
    
    for (let j = 0; j < headers.length; j++) {
      let val = data[i][j];
      if (val instanceof Date) {
        val = Utilities.formatDate(val, tz, "yyyy-MM-dd");
      }
      rowObj[headers[j]] = val;
      if (val !== "") hasData = true;
    }
    
    if (hasData) rows.push(rowObj);
  }
  
  return {
    headers: headers,
    rows: rows
  };
}

/** Read-only variants used by migration preview; these never create missing tabs. */
function getExistingSheetData(sheetName) {
  const sheet = getSpreadsheet().getSheetByName(String(sheetName || ''));
  if (!sheet) return { headers: [], rows: [] };
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (lastRow <= 1 || lastColumn === 0) return { headers: [], rows: [] };
  const values = sheet.getRange(1, 1, lastRow, lastColumn).getValues();
  const headers = values[0];
  const rows = [];
  const tz = Session.getScriptTimeZone();
  for (let i = 1; i < values.length; i++) {
    const row = { _rowIndex: i + 1, _month: sheet.getName() };
    let hasData = false;
    headers.forEach((header, j) => {
      let value = values[i][j];
      if (value instanceof Date) value = Utilities.formatDate(value, tz, 'yyyy-MM-dd');
      row[header] = value;
      if (value !== '') hasData = true;
    });
    if (hasData) rows.push(row);
  }
  return { headers: headers, rows: rows };
}

function getSettingsIfExists() {
  const sheet = getSpreadsheet().getSheetByName('Settings');
  if (!sheet || sheet.getLastRow() <= 1) return {};
  const values = sheet.getDataRange().getValues();
  const settings = {};
  for (let i = 1; i < values.length; i++) if (values[i][0]) settings[values[i][0]] = values[i][1];
  return settings;
}

/**
 * Returns transactions across month tabs.
 * Defaults to the 3 most recent months to protect against multi-year query latency.
 * Pass year="YYYY" to retrieve all existing tabs for a specific year in 1 call,
 * or all=true to retrieve all historical records.
 */
function getAllTransactions(limitMonths, all, year) {
  let months = getMonthList();
  
  if (year && /^\d{4}$/.test(String(year).trim())) {
    const yearPrefix = String(year).trim() + '-';
    months = months.filter(function(m) { return m.indexOf(yearPrefix) === 0; });
  } else if (all !== true && all !== 'true') {
    const limit = (limitMonths && parseInt(limitMonths, 10)) ? parseInt(limitMonths, 10) : 3;
    const currentYM = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');
    const activeAndPast = months.filter(function(m) { return m <= currentYM; });
    months = (activeAndPast.length >= limit ? activeAndPast : months).slice(0, limit);
  }

  let allRows = [];
  let headers = DEFAULT_MONTHLY_HEADERS;

  months.forEach(month => {
    const monthData = getSheetData(month);
    if (monthData.headers && monthData.headers.length > 0) {
      headers = monthData.headers;
    }
    allRows = allRows.concat(monthData.rows);
  });

  // Filter out sample and invalid rows
  allRows = allRows.filter(r => r.Id !== 'tx_sample' && r.Date);

  // Sort by date descending
  allRows.sort((a, b) => {
    const dateA = String(a.Date || '');
    const dateB = String(b.Date || '');
    return dateB.localeCompare(dateA);
  });

  return {
    headers: headers,
    rows: allRows
  };
}

function getCurrencyNumberFormat(currency) {
  const curr = String(currency || 'MYR').trim().toUpperCase();
  switch (curr) {
    case 'MYR':
    case 'RM':
      return '[$RM] #,##0.00;([$RM] #,##0.00);"-"';
    case 'USD':
      return '[$$-409] #,##0.00;([$$-409] #,##0.00);"-"'; // Displays $22.39
    case 'SGD':
      return '[$S$] #,##0.00;([$S$] #,##0.00);"-"';
    case 'CNY':
    case 'RMB':
      return '[$¥-804] #,##0.00;([$¥-804] #,##0.00);"-"';
    case 'EUR':
      return '[$€-2] #,##0.00;([$€-2] #,##0.00);"-"';
    case 'GBP':
      return '[$£-809] #,##0.00;([$£-809] #,##0.00);"-"';
    case 'JPY':
      return '[$¥-411] #,##0;([$¥-411] #,##0);"-"';
    case 'HKD':
      return '[$HK$] #,##0.00;([$HK$] #,##0.00);"-"';
    default:
      return `[$${curr}] #,##0.00;([$${curr}] #,##0.00);"-"`;
  }
}

const MUTATION_LEDGER_PROP = 'CASHFLOW_MUTATION_LEDGER_V1';
const DELETED_TOMBSTONES_SETTING = 'cashflow_deleted_tombstones_v1';
const DELETED_TOMBSTONES_SHEET = 'Deleted Records';
const DELETED_TOMBSTONES_MIGRATED_PROP = 'CASHFLOW_DELETED_RECORDS_MIGRATED_V1';
const DELETED_TOMBSTONE_HEADERS = ['Id', 'DeletedAt', 'SheetName', 'MutationId'];

function getMutationFromLedger(mutationId) {
  if (!mutationId) return null;
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(MUTATION_LEDGER_PROP);
    if (!raw) return null;
    const ledger = JSON.parse(raw);
    return ledger && ledger[mutationId] ? ledger[mutationId] : null;
  } catch (e) {
    return null;
  }
}

function recordMutationInLedger(mutationId, result) {
  if (!mutationId) return;
  try {
    const props = PropertiesService.getScriptProperties();
    const raw = props.getProperty(MUTATION_LEDGER_PROP);
    let ledger = {};
    try { ledger = raw ? JSON.parse(raw) : {}; } catch (e) { ledger = {}; }
    ledger[mutationId] = Object.assign({}, result, { recordedAt: Date.now() });
    const keys = Object.keys(ledger);
    if (keys.length > 200) {
      keys.sort(function(a, b) { return (ledger[a].recordedAt || 0) - (ledger[b].recordedAt || 0); });
      keys.slice(0, keys.length - 200).forEach(function(k) { delete ledger[k]; });
    }
    props.setProperty(MUTATION_LEDGER_PROP, JSON.stringify(ledger));
  } catch (e) {}
}

function getDeletedRecordsSheet() {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(DELETED_TOMBSTONES_SHEET);
  if (!sheet) sheet = ss.insertSheet(DELETED_TOMBSTONES_SHEET);

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, DELETED_TOMBSTONE_HEADERS.length).setValues([DELETED_TOMBSTONE_HEADERS]);
    sheet.setFrozenRows(1);
  } else {
    const headers = sheet.getRange(1, 1, 1, DELETED_TOMBSTONE_HEADERS.length).getDisplayValues()[0].map(function(v) { return String(v).trim(); });
    if (JSON.stringify(headers) !== JSON.stringify(DELETED_TOMBSTONE_HEADERS)) {
      throw new Error('Deleted Records tab has unexpected headers; refusing to change deletion history.');
    }
  }

  migrateLegacyDeletedRecords(sheet);
  return sheet;
}

/** Moves the former Settings JSON map into an unbounded, row-based deletion ledger once. */
function migrateLegacyDeletedRecords(sheet) {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(DELETED_TOMBSTONES_MIGRATED_PROP) === '1') return;

  const settings = getSettings();
  const raw = settings[DELETED_TOMBSTONES_SETTING];
  let legacy = {};
  if (raw) {
    try { legacy = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch (e) { throw new Error('Legacy deletion history is invalid JSON; refusing to discard it.'); }
  }

  const lastRow = sheet.getLastRow();
  const knownIds = {};
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues().forEach(function(row) {
      const id = String(row[0] || '').trim();
      if (id) knownIds[id] = true;
    });
  }

  const rows = [];
  Object.keys(legacy || {}).forEach(function(id) {
    const entry = legacy[id] || {};
    const normalizedId = String(entry.id || id).trim();
    if (!normalizedId || knownIds[normalizedId]) return;
    rows.push([normalizedId, Number(entry.deletedAt || Date.now()), String(entry.sheetName || ''), String(entry.mutationId || '')]);
    knownIds[normalizedId] = true;
  });

  if (rows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, DELETED_TOMBSTONE_HEADERS.length).setValues(rows);
    SpreadsheetApp.flush();
  }

  // Verify every legacy ID exists before marking migration complete or clearing its old copy.
  const finalRow = sheet.getLastRow();
  const finalIds = {};
  if (finalRow > 1) {
    sheet.getRange(2, 1, finalRow - 1, 1).getDisplayValues().forEach(function(row) {
      const id = String(row[0] || '').trim();
      if (id) finalIds[id] = true;
    });
  }
  const missing = Object.keys(legacy || {}).filter(function(id) {
    const entry = legacy[id] || {};
    const normalizedId = String(entry.id || id).trim();
    return normalizedId && !finalIds[normalizedId];
  });
  if (missing.length > 0) throw new Error('Deleted Records migration read-back failed for ' + missing.length + ' IDs.');

  props.setProperty(DELETED_TOMBSTONES_MIGRATED_PROP, '1');
  if (raw) updateSettings(DELETED_TOMBSTONES_SETTING, '');
}

function findDeletedRecordRow(sheet, id) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return null;
  return sheet.getRange(2, 1, lastRow - 1, 1)
    .createTextFinder(String(id).trim())
    .matchCase(true)
    .matchEntireCell(true)
    .findNext();
}

function hasTombstone(id) {
  if (!id) return false;
  const sheet = getDeletedRecordsSheet();
  return Boolean(findDeletedRecordRow(sheet, id));
}

function recordTombstone(id, sheetName, mutationId) {
  const normalizedId = String(id || '').trim();
  if (!normalizedId) throw new Error('Cannot record deletion without a stable ID.');
  const sheet = getDeletedRecordsSheet();
  const row = findDeletedRecordRow(sheet, normalizedId);
  const values = [[normalizedId, Date.now(), String(sheetName || ''), String(mutationId || '')]];
  if (row) {
    sheet.getRange(row.getRow(), 1, 1, DELETED_TOMBSTONE_HEADERS.length).setValues(values);
  } else {
    sheet.appendRow(values[0]);
  }
  SpreadsheetApp.flush();
  const verifiedRow = findDeletedRecordRow(sheet, normalizedId);
  if (!verifiedRow || String(verifiedRow.offset(0, 0).getDisplayValue()).trim() !== normalizedId) {
    throw new Error('Deletion marker read-back verification failed for ID ' + normalizedId + '.');
  }
}

/**
 * Adds a row to a sheet with idempotency, tombstone guard, and read-back verification.
 * If adding to Transactions or date is present, automatically targets the correct Month tab!
 */
function addRow(sheetName, rowData, options) {
  const opts = options || {};
  const mutationId = opts.mutationId || (rowData && rowData._mutationId) || null;
  if (mutationId) {
    const prev = getMutationFromLedger(mutationId);
    if (prev) return Object.assign({}, prev, { idempotentReplay: true, verified: true });
  }

  let targetSheetName = sheetName;
  
  // Auto-route transactions to their specific month tab!
  if (!sheetName || sheetName === 'Transactions' || /^\d{4}-\d{2}$/.test(sheetName)) {
    if (rowData && rowData.Date) {
      const dateStr = String(rowData.Date);
      targetSheetName = dateStr.substring(0, 7); // Extract "YYYY-MM"
    } else {
      targetSheetName = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM");
    }
  }

  const sheet = getSheet(targetSheetName);
  const headers = getSheetSchema(targetSheetName);
  
  // Case-insensitive ID column resolution
  const idIndex = headers.findIndex(function(h) { return String(h).trim().toLowerCase() === 'id'; });

  // Auto-generate Id if missing
  if (idIndex >= 0 && !rowData.Id) {
    rowData.Id = 'tx_' + new Date().getTime().toString(36);
  }

  const requestedId = rowData && rowData.Id ? String(rowData.Id).trim() : '';

  // Tombstone check: do not allow an old offline device to resurrect a deleted record unless explicitly forced
  if (requestedId && !(rowData && rowData._forceRestore) && !opts.allowTombstoned) {
    if (hasTombstone(requestedId)) {
      const tombstoneResult = {
        added: false,
        tombstoned: true,
        verified: true,
        verifiedId: requestedId,
        id: requestedId,
        sheetName: targetSheetName,
      };
      if (mutationId) recordMutationInLedger(mutationId, tombstoneResult);
      return tombstoneResult;
    }
  }

  // Idempotency guarantee: Check if row with this Id already exists to prevent duplicate entries
  if (idIndex >= 0 && requestedId && sheet.getLastRow() > 1) {
    const values = sheet.getRange(2, idIndex + 1, sheet.getLastRow() - 1, 1).getValues();
    const existingIdx = values.findIndex(function(r) { return String(r[0]).trim() === requestedId; });
    if (existingIdx >= 0) {
      // Row already exists! Update it in place instead of appending a duplicate
      const updated = updateRow(targetSheetName, existingIdx + 2, rowData, mutationId, { skipOverview: opts.skipOverview });
      return Object.assign({}, updated, {
        added: true,
        duplicatePrevented: true,
        verified: true,
        verifiedId: requestedId,
        id: requestedId,
        rowIndex: existingIdx + 2,
        sheetName: targetSheetName,
      });
    }
  }

  // Ensure Currency defaults to MYR
  if (headers.includes('Currency') && !rowData.Currency) {
    rowData.Currency = 'MYR';
  }

  // Enforce canonical Food & Dining category so legacy groceries/food never enter Google Sheets
  if (rowData && (rowData.Category !== undefined || rowData.category !== undefined)) {
    const rawCat = String(rowData.Category || rowData.category || '').trim();
    if (isLegacyFoodOrGrocery(rawCat)) {
      if (rowData.Category !== undefined) rowData.Category = 'Food & Dining';
      if (rowData.category !== undefined) rowData.category = 'Food & Dining';
    }
  }

  // Map to headers dynamically (adapts if user added new columns!)
  const newRow = headers.map(function(header) { return rowData[header] !== undefined ? rowData[header] : ""; });
  sheet.appendRow(newRow);
  
  // Format the added amount cell with the matching currency format (USD -> $, MYR -> RM, etc.)
  const lastRow = sheet.getLastRow();
  const amountIndex = headers.indexOf('Amount') + 1;
  if (amountIndex > 0) {
    const rowCurrency = String(rowData.Currency || 'MYR').toUpperCase();
    sheet.getRange(lastRow, amountIndex).setNumberFormat(getCurrencyNumberFormat(rowCurrency));
    sheet.getRange(lastRow, amountIndex).setHorizontalAlignment("right");
  }

  SpreadsheetApp.flush();

  // Read-back verification: confirm the written row is stored on the sheet with the expected ID
  let verified = true;
  if (idIndex >= 0 && requestedId) {
    const readBackId = String(sheet.getRange(lastRow, idIndex + 1).getValue() || '').trim();
    if (readBackId !== requestedId) {
      throw new Error('Write verification failed: written row ID read-back mismatch on ' + targetSheetName);
    }
  }

  // Update annual overview for this month (unless caller is executing a staged cross-month move)
  if (!opts.skipOverview) {
    try {
      updateOverviewForMonth(targetSheetName);
    } catch (e) {
      console.warn("Could not update overview:", e);
    }
  }

  const result = {
    added: true,
    verified: verified,
    verifiedId: requestedId,
    rowIndex: lastRow,
    sheetName: targetSheetName,
    id: requestedId,
    updatedAt: new Date().toISOString(),
  };
  if (mutationId) recordMutationInLedger(mutationId, result);
  return result;
}

function normalizeConflictValue(field, value) {
  if (value === undefined || value === null) return '';
  if (String(field).toLowerCase() === 'date') {
    if (value instanceof Date && !isNaN(value.getTime())) {
      return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    }
    const text = String(value).trim();
    const isoDate = text.match(/^\d{4}-\d{2}-\d{2}/);
    if (isoDate) return isoDate[0];
    return text;
  }
  const numericFields = ['amount', 'baseamount', 'fxratetobase'];
  if (numericFields.indexOf(String(field).toLowerCase()) >= 0 && value !== '') {
    const numeric = Number(value);
    if (isFinite(numeric)) return 'number:' + numeric;
  }
  return String(value).trim();
}

function findConcurrentFieldConflicts(baseRecord, serverRecord, clientUpdate) {
  if (!baseRecord || typeof baseRecord !== 'object') return [];
  return Object.keys(clientUpdate || {}).filter(function(field) {
    if (field.charAt(0) === '_' || field.toLowerCase() === 'id') return false;
    if (!Object.prototype.hasOwnProperty.call(serverRecord, field)) return false;
    const baseValue = normalizeConflictValue(field, baseRecord[field]);
    const serverValue = normalizeConflictValue(field, serverRecord[field]);
    const clientValue = normalizeConflictValue(field, clientUpdate[field]);
    return serverValue !== baseValue && clientValue !== serverValue;
  });
}

function updateRow(sheetName, rowIndex, rowData, mutationId, options) {
  const opts = options || {};
  const effMutationId = mutationId || (rowData && rowData._mutationId) || null;
  if (effMutationId) {
    const prev = getMutationFromLedger(effMutationId);
    if (prev) return Object.assign({}, prev, { idempotentReplay: true, verified: true });
  }

  let targetSheetName = sheetName === 'Transactions' && rowData && rowData._month
    ? String(rowData._month)
    : sheetName;

  let sheet = getSheet(targetSheetName);
  let headers = getSheetSchema(targetSheetName);
  let idIndex = headers.indexOf('Id');
  const targetIndices = [];
  const hasProvidedId = Boolean(rowData && rowData.Id && String(rowData.Id).trim() !== '');
  const requestedId = hasProvidedId ? String(rowData.Id).trim() : '';

  if (hasProvidedId) {
    // Check tombstones first so deleted records are not resurrected by stale updates
    if (hasTombstone(requestedId) && !(rowData && rowData._forceRestore)) {
      return {
        updated: false,
        tombstoned: true,
        verified: true,
        verifiedId: requestedId,
        id: requestedId,
      };
    }

    if (idIndex >= 0 && sheet.getLastRow() > 1) {
      const values = sheet.getRange(2, idIndex + 1, sheet.getLastRow() - 1, 1).getValues();
      values.forEach(function(row, idx) {
        if (String(row[0]).trim() === requestedId) {
          targetIndices.push(idx + 2);
        }
      });
    }

    // If not found in targetSheetName, search across monthly tabs using fast TextFinder
    if (targetIndices.length === 0 && (/^\d{4}-\d{2}$/.test(targetSheetName) || sheetName === 'Transactions')) {
      const monthSheets = getMonthList();
      for (let m = 0; m < monthSheets.length; m++) {
        const mName = monthSheets[m];
        if (mName === targetSheetName) continue;
        const mSheet = getSheet(mName, false);
        const mLastRow = mSheet ? mSheet.getLastRow() : 0;
        if (!mSheet || mLastRow <= 1) continue;
        const foundCell = mSheet.getRange(2, 1, mLastRow - 1, 1)
          .createTextFinder(requestedId)
          .matchCase(true)
          .matchEntireCell(true)
          .findNext();
        if (foundCell) {
          targetSheetName = mName;
          sheet = mSheet;
          headers = getSheetSchema(targetSheetName);
          idIndex = headers.indexOf('Id');
          targetIndices.push(foundCell.getRow());
          break;
        }
      }
    }

    // CRITICAL: When an ID is supplied, NEVER fall back to rowIndex!
    if (targetIndices.length === 0) {
      throw new Error("Transaction with ID '" + requestedId + "' was not found. Aborting update to protect other rows.");
    }
  } else {
    if (rowIndex <= 1 || rowIndex > sheet.getLastRow()) {
      throw new Error('Invalid row index: ' + rowIndex);
    }
    targetIndices.push(rowIndex);
  }

  // doPost wraps updateRow in ScriptLock, so this read/compare/write sequence
  // is serialized for this Apps Script deployment across devices.
  const baseRecord = rowData && rowData._baseData;
  if (baseRecord && typeof baseRecord === 'object' && targetIndices.length > 0) {
    const currentRowIndex = targetIndices[0];
    const currentValues = sheet.getRange(currentRowIndex, 1, 1, headers.length).getValues()[0];
    const serverRecord = { _month: targetSheetName, _rowIndex: currentRowIndex };
    headers.forEach(function(header, index) {
      serverRecord[header] = currentValues[index] === undefined || currentValues[index] === null ? '' : currentValues[index];
    });
    const conflictingFields = findConcurrentFieldConflicts(baseRecord, serverRecord, rowData);
    if (conflictingFields.length > 0) {
      return {
        updated: false,
        verified: false,
        conflictDetected: true,
        conflictingFields: conflictingFields,
        verifiedId: requestedId,
        id: requestedId,
        rowIndex: currentRowIndex,
        sheet: targetSheetName,
        sheetName: targetSheetName,
        serverRecord: serverRecord,
      };
    }
  }

  // Enforce canonical Food & Dining category so legacy groceries/food never enter Google Sheets
  if (rowData && (rowData.Category !== undefined || rowData.category !== undefined)) {
    const rawCat = String(rowData.Category || rowData.category || '').trim();
    if (isLegacyFoodOrGrocery(rawCat)) {
      if (rowData.Category !== undefined) rowData.Category = 'Food & Dining';
      if (rowData.category !== undefined) rowData.category = 'Food & Dining';
    }
  }

  // Check if editing a monthly transaction's Date moves it to a different YYYY-MM month tab
  const newDateStr = rowData && (rowData.Date || rowData.date) ? String(rowData.Date || rowData.date).trim() : '';
  const newMonthStr = /^\d{4}-\d{2}/.test(newDateStr) ? newDateStr.substring(0, 7) : '';

  if (/^\d{4}-\d{2}$/.test(targetSheetName) && newMonthStr && newMonthStr !== targetSheetName) {
    // STAGED CROSS-MONTH MOVE:
    // Step 1: Reconstruct full row object from existing row + updated fields
    const primaryTargetRow = targetIndices[0];
    const existingValues = sheet.getRange(primaryTargetRow, 1, 1, headers.length).getValues()[0];
    const mergedRowObj = {};
    headers.forEach(function(header, idx) {
      mergedRowObj[header] = (rowData && Object.prototype.hasOwnProperty.call(rowData, header))
        ? rowData[header]
        : existingValues[idx];
    });
    mergedRowObj.Date = newDateStr;
    if (!mergedRowObj.Id && requestedId) {
      mergedRowObj.Id = requestedId;
    }

    // Step 2: Write to destination month tab FIRST (with skipOverview so we only recalculate after move completes)
    // Note: addRow is idempotent by Id, so if a retry occurs after insert succeeded, it updates in place without duplicating.
    const added = addRow(newMonthStr, mergedRowObj, { skipOverview: true, allowTombstoned: true });

    // Step 3: Read back destination sheet to strictly verify the new row exists before deleting the old row
    const destSheet = getSheet(newMonthStr);
    const destHeaders = getSheetSchema(newMonthStr);
    const destIdIdx = destHeaders.findIndex(function(h) { return String(h).trim().toLowerCase() === 'id'; });
    let destVerified = false;
    if (destIdIdx >= 0 && destSheet.getLastRow() > 1 && mergedRowObj.Id) {
      const destIds = destSheet.getRange(2, destIdIdx + 1, destSheet.getLastRow() - 1, 1).getValues();
      destVerified = destIds.some(function(r) { return String(r[0]).trim() === String(mergedRowObj.Id).trim(); });
    }
    if (!destVerified) {
      throw new Error('Staged cross-month move aborted: could not verify record in destination sheet ' + newMonthStr + '. Old record preserved in ' + targetSheetName + '.');
    }

    // Step 4: Now that destination row is verified, delete the old row(s) from the source month tab
    targetIndices.slice().sort(function(a, b) { return b - a; }).forEach(function(rIdx) {
      sheet.deleteRow(rIdx);
    });
    SpreadsheetApp.flush();

    // Step 5: Recalculate Overview formulas for BOTH months only after the move has completed
    updateOverviewForMonth(targetSheetName);
    updateOverviewForMonth(newMonthStr);

    const moveResult = {
      updated: true,
      moved: true,
      verified: true,
      verifiedId: String(mergedRowObj.Id || ''),
      fromSheet: targetSheetName,
      sheetName: newMonthStr,
      rowIndex: added.rowIndex,
      id: String(mergedRowObj.Id || ''),
      updatedAt: new Date().toISOString(),
    };
    if (effMutationId) recordMutationInLedger(effMutationId, moveResult);
    return moveResult;
  }

  let lastExistingRow = null;
  for (let t = 0; t < targetIndices.length; t++) {
    const targetRow = targetIndices[t];
    const existingRow = sheet.getRange(targetRow, 1, 1, headers.length).getValues()[0];
    lastExistingRow = existingRow;
    const existingFormulas = sheet.getRange(targetRow, 1, 1, headers.length).getFormulas()[0];
    const updateArr = [headers.map(function(header, index) {
      if (rowData && Object.prototype.hasOwnProperty.call(rowData, header)) {
        return rowData[header];
      }
      if (existingFormulas && existingFormulas[index]) {
        return existingFormulas[index];
      }
      return existingRow[index];
    })];
    sheet.getRange(targetRow, 1, 1, headers.length).setValues(updateArr);

    for (let c = 0; c < headers.length; c++) {
      const val = updateArr[0][c];
      if (typeof val === 'string' && val.startsWith('=')) {
        sheet.getRange(targetRow, c + 1).setFormula(val);
      }
    }
  }

  // Update amount currency formatting if currency was changed or provided
  const amountIndex = headers.indexOf('Amount') + 1;
  const currencyIndex = headers.indexOf('Currency') + 1;
  if (amountIndex > 0) {
    const rowCurrency = (rowData && rowData.Currency)
      ? String(rowData.Currency).toUpperCase()
      : (currencyIndex > 0 && lastExistingRow && lastExistingRow[currencyIndex - 1] ? String(lastExistingRow[currencyIndex - 1]).toUpperCase() : 'MYR');
    targetIndices.forEach(function(rIdx) {
      sheet.getRange(rIdx, amountIndex).setNumberFormat(getCurrencyNumberFormat(rowCurrency));
    });
  }

  SpreadsheetApp.flush();

  // Read-back verification
  if (hasProvidedId && idIndex >= 0) {
    const checkId = String(sheet.getRange(targetIndices[0], idIndex + 1).getValue() || '').trim();
    if (checkId !== requestedId) {
      throw new Error('Update read-back verification failed for ID ' + requestedId);
    }
  }

  if (!opts.skipOverview) {
    if (targetSheetName === 'Trades') {
      syncPortfolioFromTrades();
      if (rowData && rowData.Date) {
        updateOverviewForMonth(String(rowData.Date).substring(0, 7));
      }
    } else if (/^\d{4}-\d{2}$/.test(targetSheetName)) {
      updateOverviewForMonth(targetSheetName);
    }
  }

  const updateResult = {
    updated: true,
    verified: true,
    verifiedId: requestedId || String(targetIndices[0]),
    id: requestedId || undefined,
    rowIndex: targetIndices[0],
    sheetName: targetSheetName,
    updatedAt: new Date().toISOString(),
  };
  if (effMutationId) recordMutationInLedger(effMutationId, updateResult);
  return updateResult;
}

function deleteRow(sheetName, rowIndex, id, mutationId) {
  if (mutationId) {
    const prev = getMutationFromLedger(mutationId);
    if (prev) return Object.assign({}, prev, { idempotentReplay: true, verified: true });
  }

  const hasProvidedId = Boolean(id !== undefined && id !== null && String(id).trim() !== '');

  // 1. If ID is provided, search by ID only. NEVER fall back to rowIndex if the ID is already gone!
  if (hasProvidedId) {
    const targetId = String(id).trim();
    const SYSTEM_NON_ENTITY_SHEETS = {
      'Overview': true,
      'Portfolio': true,
      'Settings': true,
      'Deleted Records': true,
    };
    const allSheets = getSpreadsheet().getSheets();
    let sheetsToCheck = [];

    if (sheetName && sheetName !== 'Transactions' && !SYSTEM_NON_ENTITY_SHEETS[sheetName]) {
      const preferred = getSpreadsheet().getSheetByName(sheetName);
      if (preferred) sheetsToCheck.push(preferred);
    }
    // Append remaining entity/month sheets so a moved transaction is still found by ID
    allSheets.forEach(function(s) {
      const sName = s.getName();
      if (SYSTEM_NON_ENTITY_SHEETS[sName]) return;
      if (!sheetsToCheck.some(function(existing) { return existing.getName() === sName; })) {
        sheetsToCheck.push(s);
      }
    });

    for (let s of sheetsToCheck) {
      const lastRow = s.getLastRow();
      if (lastRow <= 1) continue;
      const foundCell = s.getRange(2, 1, lastRow - 1, 1)
        .createTextFinder(targetId)
        .matchCase(true)
        .matchEntireCell(true)
        .findNext();
      if (foundCell) {
        const matchedRow = foundCell.getRow();
        const deletedSheetName = s.getName();
        // Persist the permanent marker before removing the row. If deletion fails,
        // stale devices still cannot recreate this stable ID.
        recordTombstone(targetId, deletedSheetName, mutationId);
        s.deleteRow(matchedRow);
        SpreadsheetApp.flush();

        // Read-back verification: ensure the deleted ID is no longer present
        const stillFound = s.getLastRow() > 1
          ? s.getRange(2, 1, s.getLastRow() - 1, 1)
              .createTextFinder(targetId)
              .matchCase(true)
              .matchEntireCell(true)
              .findNext()
          : null;
        if (stillFound) {
          throw new Error('Delete read-back verification failed: ID ' + targetId + ' still present in ' + deletedSheetName);
        }

        if (deletedSheetName === 'Trades') {
          syncPortfolioFromTrades();
          syncAllSheets();
        } else if (/^\d{4}-\d{2}$/.test(deletedSheetName)) {
          updateOverviewForMonth(deletedSheetName);
        }

        const delResult = {
          deleted: true,
          verified: true,
          verifiedId: targetId,
          tombstoned: true,
          id: targetId,
          sheetName: deletedSheetName,
          rowIndex: matchedRow,
        };
        if (mutationId) recordMutationInLedger(mutationId, delResult);
        return delResult;
      }
    }

    // Row with this ID is already absent (e.g. retried delete after timeout). Ensure tombstone exists and return verified idempotent success!
    recordTombstone(targetId, sheetName || 'Transactions', mutationId);
    const idempResult = {
      deleted: true,
      verified: true,
      verifiedId: targetId,
      tombstoned: true,
      id: targetId,
      alreadyDeleted: true,
    };
    if (mutationId) recordMutationInLedger(mutationId, idempResult);
    return idempResult;
  }

  // 2. Fallback by rowIndex ONLY when no ID was provided
  if (sheetName && rowIndex) {
    const sheet = getSheet(sheetName);
    if (rowIndex > 1 && rowIndex <= sheet.getLastRow()) {
      const deletedId = String(sheet.getRange(rowIndex, 1).getValue() || '').trim();
      if (deletedId) recordTombstone(deletedId, String(sheet.getName()), mutationId);
      sheet.deleteRow(rowIndex);
      SpreadsheetApp.flush();
      if (String(sheet.getName()) === 'Trades') {
        syncPortfolioFromTrades();
        syncAllSheets();
      } else if (/^\d{4}-\d{2}$/.test(String(sheet.getName()))) {
        updateOverviewForMonth(String(sheet.getName()));
      }
      const idxResult = {
        deleted: true,
        verified: true,
        verifiedId: deletedId || String(rowIndex),
        rowIndex: rowIndex,
      };
      if (mutationId) recordMutationInLedger(mutationId, idxResult);
      return idxResult;
    }
  }

  return { deleted: false, verified: false, message: 'No valid ID or rowIndex provided for deletion' };
}

function getSettings() {
  const sheet = getSheet('Settings');
  if (sheet.getLastRow() <= 1) return {};
  const data = sheet.getDataRange().getValues();
  const settings = {};
  
  for (let i = 1; i < data.length; i++) {
    const key = data[i][0];
    const value = data[i][1];
    if (key) settings[key] = value;
  }
  
  return settings;
}

function updateSettings(key, value, mutationId) {
  if (mutationId) {
    const prev = getMutationFromLedger(mutationId);
    if (prev) return Object.assign({}, prev, { idempotentReplay: true, verified: true });
  }

  const sheet = getSheet('Settings');
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['Key', 'Value', 'Description']);
  }
  const data = sheet.getDataRange().getValues();
  let targetRow = -1;
  const strValue = String(value);
  
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === key) {
      targetRow = i + 1;
      sheet.getRange(targetRow, 2).setNumberFormat('@').setValue(strValue);
      break;
    }
  }
  
  if (targetRow === -1) {
    targetRow = sheet.getLastRow() + 1;
    sheet.getRange(targetRow, 1).setValue(key);
    sheet.getRange(targetRow, 2).setNumberFormat('@').setValue(strValue);
    sheet.getRange(targetRow, 3).setValue('User Setting');
  }

  SpreadsheetApp.flush();
  const readBackVal = String(sheet.getRange(targetRow, 2).getValue());
  if (readBackVal !== strValue) {
    throw new Error('Settings write read-back verification failed for key: ' + key);
  }
  
  const res = {
    success: true,
    verified: true,
    key: key,
    updatedAt: new Date().toISOString(),
  };
  if (mutationId) recordMutationInLedger(mutationId, res);
  return res;
}

// --- Recurring & Installments Management ---

function ensureRecurringSheet(ss) {
  if (typeof setupRecurringSheet === 'function') {
    return setupRecurringSheet(ss);
  }
  let sheet = ss.getSheetByName('Recurring');
  if (!sheet) sheet = ss.insertSheet('Recurring');
  const headers = RECURRING_HEADERS;
  const currentHeaders = sheet.getLastColumn() > 0 ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0] : [];
  const needsHeaderReset = sheet.getLastRow() <= 1 || currentHeaders[1] !== 'Name';
  if (needsHeaderReset) {
    sheet.clear();
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    const headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setFontWeight("bold").setFontColor("#ffffff").setBackground("#1e3a8a").setHorizontalAlignment("center");
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 110);
    sheet.setColumnWidth(2, 160);
    sheet.setColumnWidth(3, 130);
    sheet.setColumnWidth(4, 130);
    sheet.setColumnWidth(5, 100);
    sheet.setColumnWidth(6, 110);
    sheet.setColumnWidth(7, 80);
    sheet.setColumnWidth(8, 110);
    sheet.setColumnWidth(9, 100);
    sheet.setColumnWidth(10, 140);
    sheet.setColumnWidth(11, 180);
    sheet.setColumnWidth(12, 220);
  }
  return sheet;
}

function ensureInstallmentsSheet(ss) {
  if (typeof setupInstallmentsSheet === 'function') {
    return setupInstallmentsSheet(ss);
  }
  let sheet = ss.getSheetByName('Installments');
  if (!sheet) sheet = ss.insertSheet('Installments');
  const headers = INSTALLMENTS_HEADERS;
  const currentHeaders = sheet.getLastColumn() > 0 ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0] : [];
  const needsHeaderReset = sheet.getLastRow() <= 1 || currentHeaders[1] !== 'Name';
  if (needsHeaderReset) {
    sheet.clear();
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    const headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setFontWeight("bold").setFontColor("#ffffff").setBackground("#4338ca").setHorizontalAlignment("center");
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 110);
    sheet.setColumnWidth(2, 160);
    sheet.setColumnWidth(3, 130);
    sheet.setColumnWidth(4, 80);
    sheet.setColumnWidth(5, 120);
    sheet.setColumnWidth(6, 100);
    sheet.setColumnWidth(7, 120);
    sheet.setColumnWidth(8, 120);
    sheet.setColumnWidth(9, 120);
    sheet.setColumnWidth(10, 110);
    sheet.setColumnWidth(11, 100);
    sheet.setColumnWidth(12, 100);
    sheet.setColumnWidth(13, 110);
    sheet.setColumnWidth(14, 180);
  }
  return sheet;
}

function setupRecurringAndInstallments() {
  const ss = getSpreadsheet();
  const recurringSheet = ensureRecurringSheet(ss);
  const installmentsSheet = ensureInstallmentsSheet(ss);
  
  // Auto-populate Recurring sheet from Settings if table is currently empty
  if (recurringSheet.getLastRow() <= 1) {
    try {
      const settings = getSettings();
      const raw = settings['cashflow_recurring_commitments'];
      if (raw) {
        const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (Array.isArray(list) && list.length > 0) {
          saveRecurringCommitments(list);
        }
      }
    } catch (e) {
      console.warn('Auto-populating Recurring sheet from Settings notice:', e);
    }
  }

  // Auto-populate Installments sheet from Settings if table is currently empty
  if (installmentsSheet.getLastRow() <= 1) {
    try {
      const settings = getSettings();
      const raw = settings['cashflow_installment_plans'];
      if (raw) {
        const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (Array.isArray(list) && list.length > 0) {
          saveInstallmentPlans(list);
        }
      }
    } catch (e) {
      console.warn('Auto-populating Installments sheet from Settings notice:', e);
    }
  }

  SpreadsheetApp.flush();
  return { success: true, message: 'Recurring and Installments sheets configured successfully' };
}

function getRecurringCommitments() {
  const ss = getSpreadsheet();
  const sheet = ensureRecurringSheet(ss);
  const lastRow = sheet.getLastRow();
  
  if (lastRow <= 1) {
    const settings = getSettings();
    const raw = settings['cashflow_recurring_commitments'];
    if (raw) {
      try {
        const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (Array.isArray(list) && list.length > 0) {
          saveRecurringCommitments(list);
          return list;
        }
      } catch (e) {}
    }
    return [];
  }
  
  const lastCol = Math.max(sheet.getLastColumn(), RECURRING_HEADERS.length);
  const data = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = data[0];
  const result = [];
  
  for (let i = 1; i < data.length; i++) {
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = data[i][j];
    }
    if (!row.Id && !row.Name) continue;
    
    let history = [];
    if (row.History) {
      try {
        history = typeof row.History === 'string' ? JSON.parse(row.History) : row.History;
      } catch (e) {}
    }
    if (!Array.isArray(history) || history.length === 0) {
      history = [{ effectiveFrom: String(row.EffectiveFrom || '2026-01'), amount: Number(row.Amount) || 0 }];
    }
    
    result.push({
      id: String(row.Id || ''),
      name: String(row.Name || ''),
      category: String(row.Category || 'Other'),
      subCategory: row.SubCategory ? String(row.SubCategory) : undefined,
      dayOfMonth: Number(row.DayOfMonth) || 1,
      amount: Number(row.Amount) || 0,
      currency: String(row.Currency || 'MYR'),
      effectiveFrom: String(row.EffectiveFrom || ''),
      autoRecord: String(row.AutoRecord).toLowerCase() === 'true' || row.AutoRecord === true,
      lastAutoRecordedMonth: row.LastAutoRecordedMonth ? String(row.LastAutoRecordedMonth) : undefined,
      notes: row.Notes ? String(row.Notes) : undefined,
      history: history
    });
  }
  return result;
}

function saveRecurringCommitments(list) {
  const ss = getSpreadsheet();
  const sheet = ensureRecurringSheet(ss);
  
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).clearContent().clearFormat();
  }
  
  if (!Array.isArray(list) || list.length === 0) {
    updateSettings('cashflow_recurring_commitments', '[]');
    return { saved: 0 };
  }
  
  const headers = RECURRING_HEADERS;
  const rows = list.map(item => [
    item.id || ('commitment_' + new Date().getTime().toString(36)),
    item.name || '',
    item.category || '',
    item.subCategory || '',
    item.dayOfMonth || 1,
    item.amount || 0,
    item.currency || 'MYR',
    item.effectiveFrom || '',
    item.autoRecord === true ? 'TRUE' : 'FALSE',
    item.lastAutoRecordedMonth || '',
    item.notes || '',
    JSON.stringify(item.history || [{ effectiveFrom: item.effectiveFrom || '2026-01', amount: item.amount || 0 }])
  ]);
  
  sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  
  sheet.getRange(2, 1, rows.length, 1).setHorizontalAlignment("center");
  sheet.getRange(2, 5, rows.length, 1).setHorizontalAlignment("center").setNumberFormat('#,##0');
  sheet.getRange(2, 6, rows.length, 1).setHorizontalAlignment("right").setNumberFormat('[$RM] #,##0.00;([$RM] #,##0.00);"-"');
  sheet.getRange(2, 7, rows.length, 1).setHorizontalAlignment("center");
  sheet.getRange(2, 8, rows.length, 3).setHorizontalAlignment("center");
  
  updateSettings('cashflow_recurring_commitments', JSON.stringify(list));
  SpreadsheetApp.flush();
  
  return { saved: rows.length };
}

function getInstallmentPlans() {
  const ss = getSpreadsheet();
  const sheet = ensureInstallmentsSheet(ss);
  const lastRow = sheet.getLastRow();
  
  if (lastRow <= 1) {
    const settings = getSettings();
    const raw = settings['cashflow_installment_plans'];
    if (raw) {
      try {
        const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (Array.isArray(list) && list.length > 0) {
          saveInstallmentPlans(list);
          return list;
        }
      } catch (e) {}
    }
    return [];
  }
  
  const lastCol = Math.max(sheet.getLastColumn(), INSTALLMENTS_HEADERS.length);
  const data = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = data[0];
  const result = [];
  
  for (let i = 1; i < data.length; i++) {
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      let val = data[i][j];
      if (val instanceof Date) {
        val = Utilities.formatDate(val, Session.getScriptTimeZone(), "yyyy-MM-dd");
      }
      row[headers[j]] = val;
    }
    if (!row.Id && !row.Name) continue;
    
    result.push({
      id: String(row.Id || ''),
      name: String(row.Name || ''),
      category: String(row.Category || 'Shopping'),
      currency: String(row.Currency || 'MYR'),
      totalPrincipal: Number(row.TotalPrincipal) || 0,
      tenureMonths: Number(row.TenureMonths) || 1,
      annualInterestRate: Number(row.AnnualInterestRate) || 0,
      monthlyAmount: Number(row.MonthlyAmount) || 0,
      totalPayable: Number(row.TotalPayable) || 0,
      startDate: String(row.StartDate || ''),
      endDate: String(row.EndDate || ''),
      autoRecord: String(row.AutoRecord).toLowerCase() === 'true' || row.AutoRecord === true,
      tripTag: row.TripTag ? String(row.TripTag) : undefined,
      notes: row.Notes ? String(row.Notes) : undefined
    });
  }
  return result;
}

function saveInstallmentPlans(list) {
  const ss = getSpreadsheet();
  const sheet = ensureInstallmentsSheet(ss);
  
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).clearContent().clearFormat();
  }
  
  if (!Array.isArray(list) || list.length === 0) {
    updateSettings('cashflow_installment_plans', '[]');
    return { saved: 0 };
  }
  
  const headers = INSTALLMENTS_HEADERS;
  const rows = list.map(item => [
    item.id || ('plan_' + new Date().getTime().toString(36)),
    item.name || '',
    item.category || '',
    item.currency || 'MYR',
    item.totalPrincipal || 0,
    item.tenureMonths || 1,
    item.annualInterestRate || 0,
    item.monthlyAmount || 0,
    item.totalPayable || 0,
    item.startDate || '',
    item.endDate || '',
    item.autoRecord === true ? 'TRUE' : 'FALSE',
    item.tripTag || '',
    item.notes || ''
  ]);
  
  sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  
  sheet.getRange(2, 1, rows.length, 1).setHorizontalAlignment("center");
  sheet.getRange(2, 4, rows.length, 1).setHorizontalAlignment("center");
  sheet.getRange(2, 5, rows.length, 5).setHorizontalAlignment("right");
  sheet.getRange(2, 10, rows.length, 3).setHorizontalAlignment("center");
  
  sheet.getRange(2, 5, rows.length, 1).setNumberFormat('[$RM] #,##0.00;([$RM] #,##0.00);"-"');
  sheet.getRange(2, 6, rows.length, 1).setNumberFormat('#,##0');
  sheet.getRange(2, 7, rows.length, 1).setNumberFormat('0.00"%"');
  sheet.getRange(2, 8, rows.length, 2).setNumberFormat('[$RM] #,##0.00;([$RM] #,##0.00);"-"');
  
  updateSettings('cashflow_installment_plans', JSON.stringify(list));
  SpreadsheetApp.flush();
  
  return { saved: rows.length };
}

/**
 * Atomic plan reconciliation under script lock:
 * Reads existing envelope, applies incoming client mutations with conflict-resolution by changedAt,
 * saves updated envelope to Settings, and mirrors active records to dedicated tab.
 */
function reconcilePlans(kind, mutations, initialRecords) {
  return withScriptLock(function() {
    const isRecurring = kind === 'recurring';
    const cloudKey = isRecurring 
      ? 'cashflow_sync_v2_recurring_commitments' 
      : 'cashflow_sync_v2_installment_plans';
    const legacyKey = isRecurring 
      ? 'cashflow_recurring_commitments' 
      : 'cashflow_installment_plans';

    const settings = getSettings();
    let envelope = null;
    if (settings[cloudKey]) {
      try {
        const parsed = JSON.parse(settings[cloudKey]);
        if (parsed && parsed.version === 1 && Array.isArray(parsed.entries)) {
          envelope = parsed;
        }
      } catch (e) {}
    }

    if (!envelope) {
      let legacyRecords = [];
      if (settings[legacyKey]) {
        try { legacyRecords = JSON.parse(settings[legacyKey]) || []; } catch (e) {}
      } else {
        legacyRecords = isRecurring ? getRecurringCommitments() : getInstallmentPlans();
      }
      const entries = [];
      const seen = {};
      legacyRecords.forEach(function(rec) {
        const id = (rec && (rec.id || rec.name) ? String(rec.id || rec.name).trim() : '');
        if (id && !seen[id]) {
          seen[id] = true;
          entries.push({ id: id, version: 1, changedAt: 0, deleted: false, record: rec });
        }
      });
      envelope = { version: 1, entries: entries };
    }

    const now = Date.now();
    const entryMap = {};
    envelope.entries.forEach(function(entry) {
      if (!entry || !entry.id) return;
      // Keep deletion markers permanently so a device that returns after years
      // offline cannot resurrect a record removed from the authoritative Sheet.
      entryMap[entry.id] = entry;
    });

    // Automatically transfer phone-only records that have never been in the cloud envelope
    // (neither active nor deleted/tombstoned on the Sheet).
    const initialList = Array.isArray(initialRecords) ? initialRecords : [];
    initialList.forEach(function(rec) {
      if (!rec) return;
      const id = (rec.id || rec.name ? String(rec.id || rec.name).trim() : '');
      if (id && !entryMap[id]) {
        entryMap[id] = {
          id: id,
          version: 1,
          changedAt: 1,
          deleted: false,
          record: rec
        };
      }
    });

    const conflicts = [];
    const mutationList = Array.isArray(mutations) ? mutations : [];
    mutationList.forEach(function(m) {
      if (!m || !m.entityId) return;
      const existing = entryMap[m.entityId];

      // Detect concurrent cross-device edits when baseChangedAt is provided
      if (existing && !m.forceRestore && typeof m.baseChangedAt === 'number' && existing.changedAt > m.baseChangedAt) {
        const existingJson = JSON.stringify(existing.deleted ? null : existing.record);
        const incomingJson = JSON.stringify(m.action === 'delete' ? null : m.record);
        if (existingJson !== incomingJson) {
          conflicts.push({
            entityId: m.entityId,
            kind: kind,
            serverEntry: existing,
            clientMutation: m,
            serverRecord: existing.deleted ? { _deleted: true } : (existing.record || {}),
            clientRecord: m.action === 'delete' ? { _deleted: true } : (m.record || {}),
            serverChangedAt: Number(existing.changedAt || 0),
            clientMutationChangedAt: Number(m.changedAt || now),
            resolution: existing.changedAt > m.changedAt ? 'server_wins' : 'client_wins',
            detectedAt: now,
          });
        }
      }

      // A deletion is permanent by default. Only the explicit Recovery-card
      // restore action can intentionally recreate a plan with the same stable ID.
      if (existing && existing.deleted && m.action === 'upsert' && !m.forceRestore) {
        if (!conflicts.some(function(c) { return c.entityId === m.entityId; })) {
          conflicts.push({
            entityId: m.entityId,
            kind: kind,
            serverEntry: existing,
            clientMutation: m,
            serverRecord: { _deleted: true },
            clientRecord: m.record || {},
            serverChangedAt: Number(existing.changedAt || 0),
            clientMutationChangedAt: Number(m.changedAt || now),
            resolution: 'server_tombstone_preserved',
            detectedAt: now,
          });
        }
        return;
      }

      if (existing && existing.changedAt > m.changedAt) return;
      entryMap[m.entityId] = {
        id: m.entityId,
        version: existing ? (Number(existing.version) || 1) + 1 : 1,
        changedAt: m.changedAt || now,
        deleted: m.action === 'delete',
        mutationId: m.mutationId || undefined,
        record: m.action === 'upsert' ? m.record : undefined
      };
    });

    const updatedEntries = Object.values(entryMap);
    const updatedEnvelope = { version: 1, entries: updatedEntries };
    const serializedEnvelope = JSON.stringify(updatedEnvelope);

    const writeRes = updateSettings(cloudKey, serializedEnvelope);

    const activeRecords = [];
    let tombstoneCount = 0;
    updatedEntries.forEach(function(e) {
      if (e.deleted) {
        tombstoneCount++;
      } else if (e.record) {
        activeRecords.push(e.record);
      }
    });

    if (isRecurring) {
      saveRecurringCommitments(activeRecords);
    } else {
      saveInstallmentPlans(activeRecords);
    }

    return {
      success: true,
      verified: Boolean(writeRes && writeRes.verified),
      kind: kind,
      envelope: updatedEnvelope,
      activeRecords: activeRecords,
      tombstoneCount: tombstoneCount,
      conflicts: conflicts,
    };
  });
}

/**
 * Data Integrity Check across all sheets:
 * Detects duplicate IDs, missing required fields, invalid dates, unexpected headers, and Overview formula health.
 */
function runIntegrityCheck() {
  const ss = getSpreadsheet();
  const monthSheets = getMonthList();
  const seenIds = {};
  const issues = [];
  let totalTransactions = 0;
  let duplicateIdCount = 0;
  let missingFieldCount = 0;
  let invalidDateCount = 0;

  monthSheets.forEach(function(mName) {
    const sh = ss.getSheetByName(mName);
    if (!sh) return;
    const lastRow = sh.getLastRow();
    const lastCol = sh.getLastColumn();
    if (lastRow === 0 || lastCol === 0) return;

    const data = sh.getRange(1, 1, lastRow, lastCol).getValues();
    const headers = data[0].map(function(h) { return String(h).trim(); });
    const requiredHeaders = ['Id', 'Date', 'Type', 'Category', 'Amount'];
    requiredHeaders.forEach(function(req) {
      if (headers.indexOf(req) === -1) {
        issues.push({
          severity: 'error',
          sheet: mName,
          type: 'missing_header',
          message: 'Tab ' + mName + ' is missing required header "' + req + '".',
        });
      }
    });

    const idIdx = headers.indexOf('Id');
    const dateIdx = headers.indexOf('Date');
    const typeIdx = headers.indexOf('Type');
    const amtIdx = headers.indexOf('Amount');

    for (let r = 1; r < data.length; r++) {
      const row = data[r];
      if (row.every(function(c) { return c === '' || c === null; })) continue;
      totalTransactions++;

      const rowId = idIdx >= 0 ? String(row[idIdx] || '').trim() : '';
      let rawDate = dateIdx >= 0 ? row[dateIdx] : '';
      if (rawDate instanceof Date) {
        rawDate = Utilities.formatDate(rawDate, Session.getScriptTimeZone(), 'yyyy-MM-dd');
      } else {
        rawDate = String(rawDate || '').trim();
      }
      const rowType = typeIdx >= 0 ? String(row[typeIdx] || '').trim() : '';
      const rowAmt = amtIdx >= 0 ? row[amtIdx] : '';

      if (!rowId || !rawDate || !rowType || rowAmt === '' || rowAmt === null) {
        missingFieldCount++;
        issues.push({
          severity: 'warning',
          sheet: mName,
          row: r + 1,
          type: 'missing_field',
          message: 'Row ' + (r + 1) + ' in ' + mName + ' is missing Id, Date, Type, or Amount.',
        });
      }

      if (rowId) {
        if (seenIds[rowId]) {
          duplicateIdCount++;
          issues.push({
            severity: 'error',
            sheet: mName,
            row: r + 1,
            type: 'duplicate_id',
            message: 'Duplicate Transaction ID "' + rowId + '" found in ' + mName + ' (also in ' + seenIds[rowId] + ').',
          });
        } else {
          seenIds[rowId] = mName + ':R' + (r + 1);
        }
      }

      if (rawDate && !/^\d{4}-\d{2}-\d{2}/.test(rawDate)) {
        invalidDateCount++;
        issues.push({
          severity: 'warning',
          sheet: mName,
          row: r + 1,
          type: 'invalid_date',
          message: 'Invalid Date "' + rawDate + '" at ' + mName + ' row ' + (r + 1) + '.',
        });
      }
    }
  });

  // Check Overview formula integrity
  let overviewFormulasHealthy = true;
  const ovSheet = ss.getSheetByName('Overview');
  if (ovSheet && ovSheet.getLastRow() >= 14) {
    const ovFormulas = ovSheet.getRange(2, 2, 13, 6).getFormulas();
    for (let r = 0; r < ovFormulas.length; r++) {
      for (let c = 0; c < ovFormulas[r].length; c++) {
        if (!ovFormulas[r][c] || ovFormulas[r][c].indexOf('=') !== 0) {
          overviewFormulasHealthy = false;
        }
      }
    }
    if (!overviewFormulasHealthy) {
      issues.push({
        severity: 'warning',
        sheet: 'Overview',
        type: 'hardcoded_overview',
        message: 'Overview sheet contains non-formula cells in monthly/annual summary rows.',
      });
    }
  }

  return {
    healthy: issues.filter(function(i) { return i.severity === 'error'; }).length === 0,
    checkedAt: new Date().toISOString(),
    summary: {
      monthlySheetsChecked: monthSheets.length,
      totalTransactions: totalTransactions,
      duplicateIdCount: duplicateIdCount,
      missingFieldCount: missingFieldCount,
      invalidDateCount: invalidDateCount,
      overviewFormulasHealthy: overviewFormulasHealthy,
      apiKeyConfigured: isApiKeyConfigured(),
    },
    issues: issues.slice(0, 50),
  };
}

// --- Google Drive File Operations (Invoices) ---

function uploadFile(fileName, mimeType, base64Data, folderId) {
  let folder;
  if (folderId) {
    folder = DriveApp.getFolderById(folderId);
  } else {
    // Get or create "CashFlow Invoices" folder in root Drive
    const folders = DriveApp.getFoldersByName("CashFlow Invoices");
    if (folders.hasNext()) {
      folder = folders.next();
    } else {
      folder = DriveApp.createFolder("CashFlow Invoices");
    }
  }

  // Prevent duplicate files in Google Drive: trash any existing files with this exact name
  try {
    const existingFiles = folder.getFilesByName(fileName);
    while (existingFiles.hasNext()) {
      existingFiles.next().setTrashed(true);
    }
  } catch (e) {
    console.warn("Could not trash duplicate file:", e);
  }

  const decodedData = Utilities.base64Decode(base64Data);
  const blob = Utilities.newBlob(decodedData, mimeType, fileName);
  const file = folder.createFile(blob);
  
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  
  return {
    fileId: file.getId(),
    url: file.getUrl(),
    downloadUrl: file.getDownloadUrl(),
    name: file.getName()
  };
}

function getFiles(folderId, filters = {}) {
  let folder;
  if (folderId) {
    folder = DriveApp.getFolderById(folderId);
  } else {
    const folders = DriveApp.getFoldersByName("CashFlow Invoices");
    if (!folders.hasNext()) return [];
    folder = folders.next();
  }

  const files = folder.getFiles();
  const result = [];
  
  while (files.hasNext()) {
    const file = files.next();
    result.push({
      id: file.getId(),
      name: file.getName(),
      mimeType: file.getMimeType(),
      url: file.getUrl(),
      thumbnailUrl: "https://drive.google.com/thumbnail?id=" + file.getId() + "&sz=w400",
      createdTime: file.getDateCreated().toISOString(),
      size: file.getSize()
    });
  }

  return result;
}

function getFileUrl(fileId) {
  const file = DriveApp.getFileById(fileId);
  return { url: file.getUrl(), downloadUrl: file.getDownloadUrl() };
}

function deleteFile(fileId) {
  try {
    const file = DriveApp.getFileById(fileId);
    const fileName = file.getName();
    file.setTrashed(true);

    // Also trash any lingering duplicate files with the same name in CashFlow Invoices
    const folders = DriveApp.getFoldersByName("CashFlow Invoices");
    if (folders.hasNext()) {
      const folder = folders.next();
      const duplicates = folder.getFilesByName(fileName);
      while (duplicates.hasNext()) {
        try {
          duplicates.next().setTrashed(true);
        } catch (e) {}
      }
    }
    return { deleted: true };
  } catch (err) {
    return { deleted: false, error: err.message };
  }
}

// --- Investment Portfolio & Trades Operations ---

function getPortfolioData() {
  const sheet = getSheet('Portfolio');
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];
  
  const data = sheet.getRange(1, 1, lastRow, 11).getValues();
  const holdings = [];
  
  for (let i = 1; i < data.length; i++) {
    const ticker = data[i][0];
    const units = data[i][4];
    if (ticker && Number(units) > 0) {
      holdings.push({
        ticker: String(data[i][0]),
        name: String(data[i][1] || ''),
        type: String(data[i][2] || 'Stock'),
        currency: String(data[i][3] || 'USD'),
        units: Number(data[i][4]) || 0,
        avgCost: Number(data[i][5]) || 0,
        totalCost: Number(data[i][6]) || 0,
        livePrice: Number(data[i][7]) || Number(data[i][5]) || 0,
        marketValue: Number(data[i][8]) || 0,
        pnl: Number(data[i][9]) || 0,
        returnPercent: Number(data[i][10]) || 0
      });
    }
  }
  return holdings;
}

/**
 * Rebuilds Portfolio holdings from the Trades log while preserving the
 * GOOGLEFINANCE formulas in columns G:K.
 */
function syncPortfolioFromTrades() {
  const tradeSheet = getSheet('Trades');
  const portfolioSheet = getSheet('Portfolio');
  if (!tradeSheet || !portfolioSheet) return;

  if (tradeSheet.getLastRow() <= 1) {
    if (portfolioSheet.getLastRow() > 1) {
      // Self-healing: reconstruct trades from Portfolio holdings so Trade History is preserved and Portfolio is NOT wiped!
      const pRows = portfolioSheet.getRange(2, 1, portfolioSheet.getLastRow() - 1, 6).getValues();
      const reconstructed = [];
      pRows.forEach(pr => {
        const ticker = String(pr[0] || '').trim().toUpperCase();
        const name = String(pr[1] || ticker);
        const curr = String(pr[3] || 'USD').toUpperCase();
        const units = Number(pr[4]) || 0;
        const avgCost = Number(pr[5]) || 0;
        if (ticker && units > 0) {
          const tradeDate = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
          reconstructed.push([
            'moo_pos_' + ticker.toLowerCase() + '_' + new Date().getTime().toString(36),
            tradeDate,
            'BUY',
            ticker,
            name,
            units,
            avgCost,
            0.50,
            parseFloat((units * avgCost + 0.50).toFixed(2)),
            curr,
            'Moomoo Auto-Sync Holding (' + ticker + ')'
          ]);
        }
      });
      if (reconstructed.length > 0) {
        tradeSheet.getRange(2, 1, reconstructed.length, 11).setValues(reconstructed);
        SpreadsheetApp.flush();
      }
      return;
    }
  }

  const rows = tradeSheet.getLastRow() > 1
    ? tradeSheet.getRange(2, 1, tradeSheet.getLastRow() - 1, 11).getValues()
    : [];
  const holdings = {};

  rows.forEach(row => {
    const action = String(row[2] || 'BUY').toUpperCase();
    const ticker = String(row[3] || '').trim().toUpperCase();
    const name = String(row[4] || ticker);
    const quantity = Number(row[5]) || 0;
    const price = Number(row[6]) || 0;
    const fees = Number(row[7]) || 0;
    const currency = String(row[9] || 'USD');
    if (!ticker || quantity <= 0) return;

    if (!holdings[ticker]) {
      holdings[ticker] = { ticker, name, currency, units: 0, cost: 0, lastPrice: price };
    }
    const holding = holdings[ticker];
    holding.lastPrice = price || holding.lastPrice;

    const notes = String(row[10] || '').toLowerCase();
    const isReinvested = action === 'REINVEST' ||
      (action === 'DIVIDEND' && (notes.indexOf('reinvest') >= 0 || notes.indexOf('drip') >= 0));

    if (action === 'BUY' || isReinvested) {
      holding.units += quantity;
      holding.cost += quantity * price + fees;
    } else if (action === 'SELL') {
      const averageCost = holding.units > 0 ? holding.cost / holding.units : 0;
      holding.units = Math.max(0, holding.units - quantity);
      holding.cost = Math.max(0, holding.cost - quantity * averageCost);
    }
  });

  const output = Object.values(holdings)
    .filter(h => h.units > 0)
    .map(h => [h.ticker, h.name, 'Stock', h.currency, h.units, h.cost / h.units]);

  const capacity = Math.max(portfolioSheet.getMaxRows() - 1, 1);
  portfolioSheet.getRange(2, 1, capacity, 11).clearContent();
  if (output.length > 0) {
    portfolioSheet.getRange(2, 1, output.length, 6).setValues(output);
    const formulaRows = [];
    for (let i = 0; i < output.length; i++) {
      const row = i + 2;
      formulaRows.push([
        `=IF(E${row}>0, E${row}*F${row}, "")`,
        `=IF(ISBLANK(A${row}), "", IFERROR(GOOGLEFINANCE(A${row}, "price"), IFERROR(GOOGLEFINANCE("NASDAQ:" & A${row}, "price"), IFERROR(GOOGLEFINANCE("NYSE:" & A${row}, "price"), F${row}))))`,
        `=IF(AND(E${row}>0, H${row}>0), E${row}*H${row}, "")`,
        `=IF(AND(G${row}>0, I${row}>0), I${row}-G${row}, "")`,
        `=IF(AND(G${row}>0, I${row}>0), (I${row}-G${row})/G${row}, "")`,
      ]);
    }
    portfolioSheet.getRange(2, 7, output.length, 5).setFormulas(formulaRows);
  }
  SpreadsheetApp.flush();
}

/**
 * Atomically writes a batch of trades to Google Sheets 'Trades' tab in Apps Script.
 */
function batchSyncTrades(incomingTrades) {
  const tradeSheet = getSheet('Trades');
  if (!tradeSheet) return { added: 0, total: 0, rows: [] };

  const existingData = getSheetData('Trades');
  const existingRows = existingData.rows || [];
  let addedCount = 0;
  const mergedRows = existingRows.slice();

  (incomingTrades || []).forEach(trade => {
    const ticker = String(trade.Ticker || trade.ticker || '').trim().toUpperCase();
    const date = String(trade.Date || trade.date || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd')).trim();
    const action = String(trade.Action || trade.action || 'BUY').toUpperCase();
    const qty = Math.abs(parseFloat(String(trade.Quantity || trade.quantity || '0')));
    const price = parseFloat(String(trade.Price || trade.price || '0'));
    const fees = parseFloat(String(trade.Fees || trade.fees || '0'));
    const currency = String(trade.Currency || trade.currency || 'USD').toUpperCase();
    const assetName = String(trade['Asset Name'] || trade.AssetName || trade.name || ticker);
    const notes = String(trade.Notes || trade.notes || '');
    const tradeId = String(trade.Id || trade.id || ('moo_' + ticker.toLowerCase() + '_' + new Date().getTime().toString(36)));

    const alreadyExists = mergedRows.some(r => {
      const rId = String(r.Id || r.id || '');
      const rNotes = String(r.Notes || r.notes || '');
      if (tradeId && (rId === tradeId || (tradeId.indexOf('moo_FM') === 0 && (rId.indexOf(tradeId) >= 0 || rNotes.indexOf(tradeId) >= 0)))) return true;
      const rTicker = String(r.Ticker || r.ticker || '').trim().toUpperCase();
      const rDate = String(r.Date || r.date || '').trim();
      const rAction = String(r.Action || r.action || 'BUY').toUpperCase();
      const rQty = Math.abs(parseFloat(String(r.Quantity || r.quantity || '0')));
      return rTicker === ticker && rDate === date && Math.abs(rQty - qty) < 0.0001 && rAction === action;
    });

    if (!alreadyExists) {
      mergedRows.push({
        Id: tradeId,
        Date: date,
        Action: action,
        Ticker: ticker,
        'Asset Name': assetName,
        Quantity: qty,
        Price: price,
        Fees: fees,
        'Net Total': parseFloat((qty * price + fees).toFixed(2)),
        Currency: currency,
        Notes: notes
      });
      addedCount++;
    }
  });

  const capacity = Math.max(tradeSheet.getMaxRows() - 1, 1);
  if (capacity > 0) {
    tradeSheet.getRange(2, 1, capacity, 11).clearContent();
  }

  if (mergedRows.length > 0) {
    const rowsToWrite = mergedRows.map(r => [
      String(r.Id || r.id || ''),
      String(r.Date || r.date || ''),
      String(r.Action || r.action || 'BUY').toUpperCase(),
      String(r.Ticker || r.ticker || '').trim().toUpperCase(),
      String(r['Asset Name'] || r.AssetName || r.name || ''),
      Number(r.Quantity || r.quantity) || 0,
      Number(r.Price || r.price) || 0,
      Number(r.Fees || r.fees) || 0,
      Number(r['Net Total'] || r.netTotal || r.total) || 0,
      String(r.Currency || r.currency || 'USD').toUpperCase(),
      String(r.Notes || r.notes || '')
    ]);
    tradeSheet.getRange(2, 1, rowsToWrite.length, 11).setValues(rowsToWrite);
  }

  syncPortfolioFromTrades();
  SpreadsheetApp.flush();

  return {
    added: addedCount,
    total: mergedRows.length,
    rows: mergedRows
  };
}

function addTrade(trade, mutationId) {
  if (!trade || !trade.ticker) {
    throw new Error("Missing trade data or ticker");
  }

  const requestMutationId = String(mutationId || '').trim();
  if (requestMutationId) {
    const previousResult = getMutationFromLedger(requestMutationId);
    if (previousResult) return Object.assign({}, previousResult, { idempotentReplay: true, verified: true });
  }

  // 1. Upsert the trade by its stable client-generated ID. A request can time
  // out after Sheets committed the row, so a retry must not append a second one.
  const tradeSheet = getSheet('Trades');
  const tradeId = String(trade.Id || trade.id || ('tr_' + Utilities.getUuid())).trim();
  const tradeDate = trade.date || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const action = String(trade.action || trade.Action || 'BUY').toUpperCase();
  const quantity = Number(trade.quantity || trade.Quantity) || 0;
  const price = Number(trade.price || trade.Price) || 0;
  const fees = Number(trade.fees || trade.Fees) || 0;
  const tradeObject = {
    Id: tradeId,
    Date: tradeDate,
    Action: action,
    Ticker: String(trade.ticker || trade.Ticker || '').trim().toUpperCase(),
    'Asset Name': trade.name || trade.assetName || trade['Asset Name'] || trade.ticker || trade.Ticker,
    Quantity: quantity,
    Price: price,
    Fees: fees,
    'Net Total': Number(trade.total || trade['Net Total']) || (quantity * price),
    Currency: trade.currency || trade.Currency || 'USD',
    Notes: trade.notes || trade.Notes || '',
    RateToMyr: Number(trade.rateToMyr || trade.RateToMyr) || 0,
    CostInMyr: Number(trade.costInMyr || trade.CostInMyr) || 0,
  };
  const tradeHeaders = getSheetSchema('Trades');
  const tradeIdIndex = tradeHeaders.findIndex(header => String(header).trim().toLowerCase() === 'id');
  let existingTradeRow = 0;
  if (tradeIdIndex >= 0 && tradeSheet.getLastRow() > 1) {
    const ids = tradeSheet.getRange(2, tradeIdIndex + 1, tradeSheet.getLastRow() - 1, 1).getValues();
    const existingOffset = ids.findIndex(row => String(row[0] || '').trim() === tradeId);
    if (existingOffset >= 0) existingTradeRow = existingOffset + 2;
  }
  if (existingTradeRow > 0) {
    const existingValues = tradeSheet.getRange(existingTradeRow, 1, 1, tradeHeaders.length).getValues()[0];
    const updatedValues = tradeHeaders.map((header, index) =>
      Object.prototype.hasOwnProperty.call(tradeObject, header) ? tradeObject[header] : existingValues[index]
    );
    tradeSheet.getRange(existingTradeRow, 1, 1, tradeHeaders.length).setValues([updatedValues]);
  } else {
    tradeSheet.appendRow(tradeHeaders.map(header =>
      Object.prototype.hasOwnProperty.call(tradeObject, header) ? tradeObject[header] : ''
    ));
  }
  syncPortfolioFromTrades();

  // 2. Also upsert one linked monthly cashflow record. A retry after a partial
  // failure completes this step without duplicating the trade or cashflow row.
  const monthName = String(tradeDate).substring(0, 7);
  const netAmount = Number(tradeObject['Net Total']);
  const tradeCurrency = String(tradeObject.Currency || 'USD').toUpperCase();
  const myrCost = Number(tradeObject.CostInMyr) || 0;
  const myrRate = Number(tradeObject.RateToMyr) || 0;
  const noteStr = myrCost > 0
    ? `Cost: RM ${myrCost.toFixed(2)}${myrRate > 0 ? ` (Rate: ${myrRate.toFixed(4)})` : ''}`
    : (trade.notes || '');

  // Store numeric value in base currency (MYR if costInMyr is provided) so Overview SUMIFS works accurately
  const cashAmount = myrCost > 0 ? Number(myrCost.toFixed(2)) : Number(netAmount.toFixed(2));
  const cashCurrency = myrCost > 0 ? 'MYR' : tradeCurrency;

  const cashflowMutationId = requestMutationId ? requestMutationId + '_cash' : null;
  addRow(monthName, {
    Id: 'tx_trade_' + tradeId.replace(/[^A-Za-z0-9_-]/g, '_'),
    Date: tradeDate,
    Type: action === 'SELL' ? 'Income' : 'Investment',
    Category: 'Stocks & Crypto',
    SubCategory: action,
    Description: `${action} ${quantity} ${tradeObject.Ticker} @ ${price} ${tradeCurrency}`,
    Amount: cashAmount,
    Currency: cashCurrency,
    PaymentMethod: trade.paymentMethod || 'Investment Account',
    Notes: noteStr
  }, { mutationId: cashflowMutationId });

  const result = { success: true, verified: true, tradeId: tradeId };
  if (requestMutationId) recordMutationInLedger(requestMutationId, result);
  return result;
}

function getOverviewData() {
  const sheet = getSheet('Overview');
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (lastRow <= 1 || lastColumn === 0) return [];
  
  const data = sheet.getRange(1, 1, lastRow, lastColumn).getValues();
  const headers = data[0];
  const rows = [];
  const tz = Session.getScriptTimeZone();
  
  for (let i = 1; i < data.length; i++) {
    const rowObj = { _rowIndex: i + 1, _month: 'Overview' };
    let hasData = false;
    for (let j = 0; j < headers.length; j++) {
      let val = data[i][j];
      if (val instanceof Date) {
        val = Utilities.formatDate(val, tz, "yyyy-MM-dd");
      }
      rowObj[headers[j]] = val;
      if (val !== "") hasData = true;
    }
    if (hasData) rows.push(rowObj);
  }
  return rows;
}

function updateOverviewForMonth(monthStr) {
  if (!monthStr) return;
  const normalizedMonth = String(monthStr).substring(0, 7);
  if (!/^\d{4}-\d{2}$/.test(normalizedMonth)) return;
  
  const ss = getSpreadsheet();
  const overviewSheet = ss.getSheetByName('Overview');
  if (!overviewSheet) return;

  const data = overviewSheet.getDataRange().getValues();
  let targetRow = -1;
  const tz = Session.getScriptTimeZone();
  for (let i = 1; i < data.length; i++) {
    const rawVal = data[i][0];
    let rowMonth = '';
    if (rawVal instanceof Date) {
      rowMonth = Utilities.formatDate(rawVal, tz, "yyyy-MM");
    } else {
      rowMonth = String(rawVal || '').trim().substring(0, 7);
    }
    if (rowMonth === normalizedMonth) {
      targetRow = i + 1;
      break;
    }
  }
  if (targetRow === -1) return;

  // Set live dynamic formulas in a single batched RPC call if not already present
  const existingFormulas = overviewSheet.getRange(targetRow, 2, 1, 8).getFormulas()[0];
  if (existingFormulas && existingFormulas.every(function(f) { return f && f.indexOf('=') === 0; })) {
    return;
  }

  overviewSheet.getRange(targetRow, 2, 1, 8).setFormulas([[
    `=IFERROR(SUMIFS('${normalizedMonth}'!G:G, '${normalizedMonth}'!C:C, "Income"), 0)`,
    `=IFERROR(SUMIFS('${normalizedMonth}'!G:G, '${normalizedMonth}'!C:C, "Expense"), 0)`,
    `=B${targetRow}-C${targetRow}`,
    `=IFERROR(SUMIFS('${normalizedMonth}'!G:G, '${normalizedMonth}'!C:C, "Investment"), 0)`,
    `=IFERROR(SUMIFS(Trades!I:I, Trades!C:C, "DIVIDEND", Trades!B:B, ">=${normalizedMonth}-01", Trades!B:B, "<=${normalizedMonth}-31"), 0)`,
    `=IFERROR(SUMIFS(Trades!I:I, Trades!C:C, "SELL", Trades!B:B, ">=${normalizedMonth}-01", Trades!B:B, "<=${normalizedMonth}-31"), 0)`,
    `=F${targetRow}+G${targetRow}`,
    `=D${targetRow}+H${targetRow}`,
  ]]);
}

function fixCurrencyFormats() {
  const ss = getSpreadsheet();
  const sheets = ss.getSheets();
  const monthRegex = /^\d{4}-\d{2}$/;
  let updatedCount = 0;

  sheets.forEach(sheet => {
    if (!monthRegex.test(sheet.getName())) return;
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    if (lastRow <= 1 || lastCol === 0) return;

    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    const amountIdx = headers.indexOf('Amount') + 1;
    const currencyIdx = headers.indexOf('Currency') + 1;
    if (amountIdx === 0 || currencyIdx === 0) return;

    const values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
    for (let i = 0; i < values.length; i++) {
      const currency = String(values[i][currencyIdx - 1] || 'MYR').toUpperCase();
      const r = i + 2;
      const rawVal = values[i][amountIdx - 1];
      if (typeof rawVal === 'string' && /[\$£€¥RM]/.test(rawVal)) {
        const num = parseFloat(rawVal.replace(/[^0-9.-]+/g, ''));
        if (!isNaN(num)) {
          sheet.getRange(r, amountIdx).setValue(num);
        }
      }
      sheet.getRange(r, amountIdx).setNumberFormat(getCurrencyNumberFormat(currency));
      updatedCount++;
    }
  });

  return { success: true, updatedCount: updatedCount };
}

function syncAllSheets() {
  // 1. Sync Portfolio from Trades
  syncPortfolioFromTrades();

  // 2. Sanitize categories across all sheets to enforce canonical Food & Dining
  sanitizeAllSheetCategories();
  
  // 3. Sync all months for Overview with dynamic formulas
  const currentYear = new Date().getFullYear();
  for (let m = 1; m <= 12; m++) {
    const monthStr = `${currentYear}-${String(m).padStart(2, '0')}`;
    updateOverviewForMonth(monthStr);
  }
  
  // Also check any extra months in getMonthList
  const months = getMonthList();
  months.forEach(m => {
    updateOverviewForMonth(m);
  });

  // 3. Ensure Annual Total Row 14 formulas are intact
  const ss = getSpreadsheet();
  const overviewSheet = ss.getSheetByName('Overview');
  if (overviewSheet && overviewSheet.getLastRow() >= 14) {
    overviewSheet.getRange("B14").setFormula("=SUM(B2:B13)");
    overviewSheet.getRange("C14").setFormula("=SUM(C2:C13)");
    overviewSheet.getRange("D14").setFormula("=SUM(D2:D13)");
    overviewSheet.getRange("E14").setFormula("=SUM(E2:E13)");
    overviewSheet.getRange("F14").setFormula("=SUM(F2:F13)");
    overviewSheet.getRange("G14").setFormula("=SUM(G2:G13)");
    overviewSheet.getRange("H14").setFormula("=SUM(H2:H13)");
    overviewSheet.getRange("I14").setFormula("=SUM(I2:I13)");
  }
  
  SpreadsheetApp.flush();
  return { success: true, message: "All sheets synchronized successfully" };
}

function deletePaymentMethodColumn() {
  const ss = getSpreadsheet();
  const sheets = ss.getSheets();
  const deletedFrom = [];
  sheets.forEach(sheet => {
    const lastCol = sheet.getLastColumn();
    if (lastCol > 0) {
      const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
      const colIdx = headers.indexOf('PaymentMethod');
      if (colIdx !== -1) {
        sheet.deleteColumn(colIdx + 1);
        deletedFrom.push(sheet.getName());
      }
    }
  });
  SpreadsheetApp.flush();
  return { success: true, deletedFromSheets: deletedFrom };
}

function isLegacyFoodOrGrocery(rawVal) {
  if (!rawVal) return false;
  const clean = String(rawVal).trim();
  if (clean === 'Food & Dining') return false;
  const lower = clean.toLowerCase();
  const normalized = lower.replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
  if (/^(groceries|grocery|grocer|food|dining|fooddining|foodanddining|foodndining|supermarket|supermarkets|foodbeverage|fooddrink|meals|meal|lunch|dinner|breakfast|makan|买菜|食品|餐饮|饮食|食物|外卖|午餐|晚餐|早餐|零食|饮料|奶茶|超市)$/i.test(normalized)) {
    return true;
  }
  if (normalized.indexOf('grocer') >= 0 || normalized.indexOf('supermarket') >= 0 || normalized.indexOf('买菜') >= 0) {
    return true;
  }
  if ((normalized.indexOf('food') >= 0 || normalized.indexOf('dining') >= 0) &&
      normalized.indexOf('petfood') < 0 && normalized.indexOf('fastfood') < 0 && normalized.indexOf('seafood') < 0) {
    return true;
  }
  return false;
}

function sanitizeAllSheetCategories() {
  const ss = getSpreadsheet();
  const sheets = ss.getSheets();
  let totalSanitized = 0;
  const sanitizedSheets = [];

  sheets.forEach(function(sheet) {
    const title = sheet.getName();
    if (['Overview', 'Portfolio', 'Trades', 'Settings', 'Deleted Records'].indexOf(title) >= 0) return;
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    if (lastRow <= 1 || lastCol === 0) return;

    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) { return String(h || '').trim().toLowerCase(); });
    let catColIdx = headers.indexOf('category');
    if (catColIdx < 0) catColIdx = headers.findIndex(function(h) { return h.indexOf('category') >= 0 || h.indexOf('类别') >= 0 || h.indexOf('分类') >= 0; });
    if (catColIdx < 0) return;

    const colNum = catColIdx + 1;
    const values = sheet.getRange(2, colNum, lastRow - 1, 1).getValues();
    let sheetChanges = 0;
    for (let i = 0; i < values.length; i++) {
      const val = String(values[i][0] || '').trim();
      if (isLegacyFoodOrGrocery(val)) {
        values[i][0] = 'Food & Dining';
        sheetChanges++;
      }
    }
    if (sheetChanges > 0) {
      sheet.getRange(2, colNum, values.length, 1).setValues(values);
      totalSanitized += sheetChanges;
      sanitizedSheets.push(title);
    }
  });

  SpreadsheetApp.flush();
  return {
    success: true,
    totalSanitized: totalSanitized,
    sanitizedSheets: sanitizedSheets,
    message: 'Sanitized ' + totalSanitized + ' category entries to "Food & Dining".'
  };
}
