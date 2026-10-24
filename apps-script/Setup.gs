/**
 * Setup Utilities for CashFlow Apps Script (Monthly Tabs + Live Portfolio Edition)
 * Run `initialSetup` once from the Apps Script editor.
 * It will create your CashFlow spreadsheet with:
 * 1. An "Overview" dashboard tab
 * 2. Current month tab (e.g. "2026-09") for monthly expenses & cash flows
 * 3. A dedicated "Portfolio" tab with real-time GOOGLEFINANCE live stock prices
 * 4. A dedicated "Trades" tab for tracking all Buy / Sell transactions
 * 5. Master "Categories", "Trips", and "Settings" tabs
 */

const MONTHLY_HEADERS = [
  'Id', 'Date', 'Type', 'Category', 'SubCategory', 'Description', 
  'Amount', 'Currency', 'TripTag', 'ReceiptUrl', 'Notes'
];
// Note: RECURRING_HEADERS and INSTALLMENTS_HEADERS are globally declared in Code.gs

function initialSetup() {
  const props = PropertiesService.getScriptProperties();
  let ss = null;
  
  // 1. Try to open existing spreadsheet from stored ID
  const storedId = props.getProperty('SPREADSHEET_ID');
  if (storedId) {
    try {
      ss = SpreadsheetApp.openById(storedId);
    } catch (e) {
      console.warn("Could not open stored spreadsheet ID, creating a new one:", e);
    }
  }
  
  // 2. Try to get active spreadsheet (if script is bound to a sheet)
  if (!ss) {
    try {
      ss = SpreadsheetApp.getActiveSpreadsheet();
    } catch (e) {}
  }
  
  // 3. If standalone script without a sheet yet, automatically create one in your Google Drive!
  if (!ss) {
    ss = SpreadsheetApp.create('CashFlow 记账');
    props.setProperty('SPREADSHEET_ID', ss.getId());
    console.log("Created brand new CashFlow spreadsheet in Google Drive!");
  }
  
  props.setProperty('SPREADSHEET_ID', ss.getId());
  console.log("Spreadsheet Name: " + ss.getName());
  console.log("Spreadsheet URL: " + ss.getUrl());
  
  // 1. Setup Annual Overview Tab
  setupOverviewSheet(ss);
  
  // 2. Setup Current Month tab (e.g. 2026-09)
  const currentMonth = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM");
  createMonthSheet(ss, currentMonth);
  
  // 3. Setup Live Portfolio Holdings Tab (with real-time GOOGLEFINANCE)
  setupPortfolioSheet(ss);
  
  // 4. Setup Trades Log Tab (Buy / Sell history)
  setupTradesSheet(ss);
  
  // 5. Setup Master Categories, Trips, Recurring, Installments, Settings tabs
  setupCategoriesSheet(ss);
  setupTripsSheet(ss);
  setupRecurringSheet(ss);
  setupInstallmentsSheet(ss);
  setupSettingsSheet(ss);
  
  // Remove default 'Sheet1' if it exists and other sheets were created
  const sheet1 = ss.getSheetByName('Sheet1');
  if (sheet1 && ss.getSheets().length > 1) {
    if (sheet1.getLastRow() <= 1 && sheet1.getLastColumn() <= 1) {
      try {
        ss.deleteSheet(sheet1);
      } catch (e) {}
    }
  }
  
  console.log("✅ Setup completed successfully!");
  console.log("👉 Open your spreadsheet here: " + ss.getUrl());
}

/**
 * Creates the Live Investment Portfolio tab with real-time GOOGLEFINANCE formulas
 */
function setupPortfolioSheet(ss) {
  let sheet = ss.getSheetByName('Portfolio');
  if (!sheet) {
    sheet = ss.insertSheet('Portfolio');
  }
  
  if (sheet.getLastRow() === 0) {
    const headers = [
      'Ticker', 'Asset Name', 'Type', 'Currency', 'Units Held', 
      'Avg Cost', 'Total Cost', 'Live Price', 'Market Value', 
      'Profit / Loss', 'Return %'
    ];
    
    // Header Row
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    const headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setFontWeight("bold");
    headerRange.setFontColor("#ffffff");
    headerRange.setBackground("#064e3b"); // Deep emerald green
    headerRange.setHorizontalAlignment("center");
    sheet.setFrozenRows(1);
    
    // Column Widths
    sheet.setColumnWidth(1, 130); // Ticker
    sheet.setColumnWidth(2, 180); // Asset Name
    sheet.setColumnWidth(3, 110); // Type
    sheet.setColumnWidth(4, 90);  // Currency
    sheet.setColumnWidth(5, 110); // Units Held
    sheet.setColumnWidth(6, 110); // Avg Cost
    sheet.setColumnWidth(7, 130); // Total Cost
    sheet.setColumnWidth(8, 120); // Live Price
    sheet.setColumnWidth(9, 130); // Market Value
    sheet.setColumnWidth(10, 130); // Profit / Loss
    sheet.setColumnWidth(11, 110); // Return %
    
    // Format Alignments
    sheet.getRange(2, 1, 50, 1).setHorizontalAlignment("center"); // Ticker
    sheet.getRange(2, 4, 50, 1).setHorizontalAlignment("center"); // Currency
    sheet.getRange(2, 5, 50, 1).setHorizontalAlignment("right");  // Units
    sheet.getRange(2, 6, 50, 5).setHorizontalAlignment("right");  // Financial figures
    sheet.getRange(2, 11, 50, 1).setHorizontalAlignment("center"); // Return %
    
    // Number Formats
    sheet.getRange(2, 5, 50, 1).setNumberFormat('#,##0.00'); // Units
    sheet.getRange(2, 6, 50, 4).setNumberFormat('#,##0.00'); // Prices & Values
    sheet.getRange(2, 10, 50, 1).setNumberFormat('+#,##0.00;-#,##0.00;0.00'); // P&L
    sheet.getRange(2, 11, 50, 1).setNumberFormat('+0.00%;-0.00%;0.00%'); // Return %
    
    // Pre-populate formulas for rows 2 to 50 so when you enter a ticker, price updates instantly!
    for (let r = 2; r <= 50; r++) {
      sheet.getRange(`G${r}`).setFormula(`=IF(E${r}>0, E${r}*F${r}, "")`);
      sheet.getRange(`H${r}`).setFormula(`=IF(ISBLANK(A${r}), "", IFERROR(GOOGLEFINANCE(A${r}, "price"), IFERROR(GOOGLEFINANCE("NASDAQ:" & A${r}, "price"), IFERROR(GOOGLEFINANCE("NYSE:" & A${r}, "price"), F${r}))))`);
      sheet.getRange(`I${r}`).setFormula(`=IF(AND(E${r}>0, H${r}>0), E${r}*H${r}, "")`);
      sheet.getRange(`J${r}`).setFormula(`=IF(AND(G${r}>0, I${r}>0), I${r}-G${r}, "")`);
      sheet.getRange(`K${r}`).setFormula(`=IF(AND(G${r}>0, I${r}>0), (I${r}-G${r})/G${r}, "")`);
    }

    // Conditional Formatting: Green for positive P&L, Red for negative
    const pnlRange = sheet.getRange("J2:K25");
    const greenRule = SpreadsheetApp.newConditionalFormatRule()
      .whenNumberGreaterThan(0)
      .setFontColor("#15803d")
      .setBackground("#dcfce7")
      .setRanges([pnlRange])
      .build();
    const redRule = SpreadsheetApp.newConditionalFormatRule()
      .whenNumberLessThan(0)
      .setFontColor("#b91c1c")
      .setBackground("#fee2e2")
      .setRanges([pnlRange])
      .build();
    sheet.setConditionalFormatRules([greenRule, redRule]);
  }
  
  return sheet;
}

/**
 * Creates the Trades History Log tab (Buy / Sell transactions)
 */
function setupTradesSheet(ss) {
  let sheet = ss.getSheetByName('Trades');
  if (!sheet) {
    sheet = ss.insertSheet('Trades');
  }
  
  if (sheet.getLastRow() === 0) {
    const headers = [
      'Id', 'Date', 'Action', 'Ticker', 'Asset Name', 
      'Quantity', 'Price', 'Fees', 'Net Total', 'Currency', 'Notes'
    ];
    
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    const headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setFontWeight("bold");
    headerRange.setFontColor("#ffffff");
    headerRange.setBackground("#115e59"); // Deep teal
    headerRange.setHorizontalAlignment("center");
    sheet.setFrozenRows(1);
    
    // Column widths
    sheet.setColumnWidth(1, 100); // Id
    sheet.setColumnWidth(2, 110); // Date
    sheet.setColumnWidth(3, 100); // Action (BUY/SELL)
    sheet.setColumnWidth(4, 130); // Ticker
    sheet.setColumnWidth(5, 170); // Name
    sheet.setColumnWidth(6, 100); // Quantity
    sheet.setColumnWidth(7, 100); // Price
    sheet.setColumnWidth(8, 90);  // Fees
    sheet.setColumnWidth(9, 120); // Net Total
    sheet.setColumnWidth(10, 80); // Currency
    sheet.setColumnWidth(11, 180); // Notes
    
    // Format Alignments
    sheet.getRange(2, 2, 50, 1).setHorizontalAlignment("center");
    sheet.getRange(2, 3, 50, 1).setHorizontalAlignment("center");
    sheet.getRange(2, 4, 50, 1).setHorizontalAlignment("center");
    sheet.getRange(2, 6, 50, 4).setHorizontalAlignment("right");
    sheet.getRange(2, 10, 50, 1).setHorizontalAlignment("center");
    
    // Data Validation for Action column
    const actionRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(['BUY', 'SELL', 'DIVIDEND'], true)
      .setAllowInvalid(false)
      .build();
    sheet.getRange(2, 3, 500, 1).setDataValidation(actionRule);
    
    // Number format for Price & Total
    sheet.getRange(2, 6, 500, 1).setNumberFormat('#,##0.00');
    sheet.getRange(2, 7, 500, 3).setNumberFormat('#,##0.00');
    
    }
  
  return sheet;
}

/**
 * Creates and formats a monthly tab with headers, column widths, and currency formatting.
 */
function createMonthSheet(ss, monthName) {
  let sheet = ss.getSheetByName(monthName);
  if (!sheet) {
    sheet = ss.insertSheet(monthName);
  }
  
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, MONTHLY_HEADERS.length).setValues([MONTHLY_HEADERS]);
    
    // Style headers
    const headerRange = sheet.getRange(1, 1, 1, MONTHLY_HEADERS.length);
    headerRange.setFontWeight("bold");
    headerRange.setFontColor("#ffffff");
    headerRange.setBackground("#1e293b"); // Elegant dark slate
    headerRange.setHorizontalAlignment("center");
    sheet.setFrozenRows(1);
    
    // Column widths
    sheet.setColumnWidth(1, 100); // Id
    sheet.setColumnWidth(2, 110); // Date
    sheet.setColumnWidth(3, 110); // Type
    sheet.setColumnWidth(4, 140); // Category
    sheet.setColumnWidth(5, 120); // SubCategory
    sheet.setColumnWidth(6, 220); // Description
    sheet.setColumnWidth(7, 120); // Amount
    sheet.setColumnWidth(8, 80);  // Currency
    sheet.setColumnWidth(9, 110); // TripTag
    sheet.setColumnWidth(10, 150); // ReceiptUrl
    sheet.setColumnWidth(11, 180); // Notes
    
    // Format Amount column as currency RM #,##0.00
    sheet.getRange(2, 7, 500, 1).setNumberFormat('[$RM] #,##0.00;([$RM] #,##0.00);"-"');
    sheet.getRange(2, 7, 500, 1).setHorizontalAlignment("right");
    
    // Center Date, Type, Currency
    sheet.getRange(2, 2, 500, 1).setHorizontalAlignment("center");
    sheet.getRange(2, 3, 500, 1).setHorizontalAlignment("center");
    sheet.getRange(2, 8, 500, 1).setHorizontalAlignment("center");
    
    // Data Validation for Type column
    const typeRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(['Expense', 'Income', 'Investment'], true)
      .setAllowInvalid(false)
      .build();
    sheet.getRange(2, 3, 500, 1).setDataValidation(typeRule);
  }
  
  return sheet;
}

function setupOverviewSheet(ss) {
  let sheet = ss.getSheetByName('Overview');
  if (!sheet) {
    sheet = ss.insertSheet('Overview', 0);
  }
  
  sheet.clear(); // Refresh layout
  
  const headers = [
    'Month', 'Active Income', 'Living Expenses', 'Net Cash Savings', 
    'Capital Invested', 'Dividends Received', 'Realized Capital Gains', 
    'Total Investment Earned', 'Total Wealth Growth'
  ];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  
  const headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setFontWeight("bold");
  headerRange.setFontColor("#ffffff");
  headerRange.setBackground("#0f172a");
  headerRange.setHorizontalAlignment("center");
  sheet.setFrozenRows(1);
  
  // Widths
  sheet.setColumnWidth(1, 130); // Month
  sheet.setColumnWidth(2, 130); // Income
  sheet.setColumnWidth(3, 140); // Expenses
  sheet.setColumnWidth(4, 140); // Net Savings
  sheet.setColumnWidth(5, 140); // Capital Invested
  sheet.setColumnWidth(6, 150); // Dividends
  sheet.setColumnWidth(7, 160); // Realized Gains
  sheet.setColumnWidth(8, 180); // Total Investment Earned
  sheet.setColumnWidth(9, 160); // Total Wealth Growth
  
  // Pre-fill 12 Months for the Year with live dynamic self-updating formulas
  const currentYear = new Date().getFullYear();
  for (let m = 1; m <= 12; m++) {
    const r = m + 1;
    const monthStr = `${currentYear}-${String(m).padStart(2, '0')}`;
    sheet.getRange(`A${r}`).setValue(monthStr);
    sheet.getRange(`B${r}`).setFormula(`=IFERROR(SUMIFS('${monthStr}'!G:G, '${monthStr}'!C:C, "Income"), 0)`);
    sheet.getRange(`C${r}`).setFormula(`=IFERROR(SUMIFS('${monthStr}'!G:G, '${monthStr}'!C:C, "Expense"), 0)`);
    sheet.getRange(`D${r}`).setFormula(`=B${r}-C${r}`);
    sheet.getRange(`E${r}`).setFormula(`=IFERROR(SUMIFS('${monthStr}'!G:G, '${monthStr}'!C:C, "Investment"), 0)`);
    sheet.getRange(`F${r}`).setFormula(`=IFERROR(SUMIFS(Trades!I:I, Trades!C:C, "DIVIDEND", Trades!B:B, ">=${monthStr}-01", Trades!B:B, "<=${monthStr}-31"), 0)`);
    sheet.getRange(`G${r}`).setFormula(`=IFERROR(SUMIFS(Trades!I:I, Trades!C:C, "SELL", Trades!B:B, ">=${monthStr}-01", Trades!B:B, "<=${monthStr}-31"), 0)`);
    sheet.getRange(`H${r}`).setFormula(`=F${r}+G${r}`);
    sheet.getRange(`I${r}`).setFormula(`=D${r}+H${r}`);
  }
  
  // Row 14: Annual Total Row
  sheet.getRange("A14").setValue(`🏆 ${currentYear} ANNUAL TOTAL`);
  sheet.getRange("B14").setFormula(`=SUM(B2:B13)`);
  sheet.getRange("C14").setFormula(`=SUM(C2:C13)`);
  sheet.getRange("D14").setFormula(`=SUM(D2:D13)`);
  sheet.getRange("E14").setFormula(`=SUM(E2:E13)`);
  sheet.getRange("F14").setFormula(`=SUM(F2:F13)`);
  sheet.getRange("G14").setFormula(`=SUM(G2:G13)`);
  sheet.getRange("H14").setFormula(`=SUM(H2:H13)`); // ANNUAL INVESTMENT EARNINGS!
  sheet.getRange("I14").setFormula(`=SUM(I2:I13)`); // ANNUAL TOTAL WEALTH GROWTH!
  
  // Format Annual Row in Bold Gold / Indigo
  const totalRange = sheet.getRange(14, 1, 1, headers.length);
  totalRange.setFontWeight("bold");
  totalRange.setBackground("#fef3c7"); // Soft amber
  totalRange.setFontColor("#78350f");
  
  // Number Formatting: RM #,##0.00
  sheet.getRange(2, 2, 13, 8).setNumberFormat('[$RM] #,##0.00;([$RM] #,##0.00);"-"');
  sheet.getRange(2, 1, 13, 1).setHorizontalAlignment("center");
  sheet.getRange(2, 2, 13, 8).setHorizontalAlignment("right");
  
  // Highlight Total Investment Earned (Column H) in subtle emerald green
  sheet.getRange(2, 8, 12, 1).setBackground("#f0fdf4");
  sheet.getRange(14, 8).setBackground("#dcfce7");
}

function setupCategoriesSheet(ss) {
  let sheet = ss.getSheetByName('Categories');
  if (!sheet) sheet = ss.insertSheet('Categories');
  
  if (sheet.getLastRow() === 0) {
    const headers = ['Id', 'Name', 'Type', 'Icon', 'Color', 'ParentId'];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold").setFontColor("#ffffff").setBackground("#334155");
    sheet.setFrozenRows(1);
    
    const defaultCategories = [
      ['cat_1', 'Food & Dining', 'Expense', 'utensils', '#ef4444', ''],
      ['cat_2', 'Transport', 'Expense', 'car', '#f97316', ''],
      ['cat_3', 'Shopping', 'Expense', 'shopping-bag', '#f59e0b', ''],
      ['cat_4', 'Entertainment', 'Expense', 'film', '#8b5cf6', ''],
      ['cat_5', 'Housing & Bills', 'Expense', 'home', '#3b82f6', ''],
      ['cat_6', 'Health', 'Expense', 'heart', '#ec4899', ''],
      ['cat_7', 'Education', 'Expense', 'book', '#14b8a6', ''],
      ['cat_8', 'Salary', 'Income', 'briefcase', '#10b981', ''],
      ['cat_9', 'Freelance', 'Income', 'laptop', '#059669', ''],
      ['cat_10', 'Investment Return', 'Income', 'trending-up', '#047857', ''],
      ['cat_11', 'Stocks & Crypto', 'Investment', 'line-chart', '#6366f1', ''],
      ['cat_12', 'Gift & Bonus', 'Income', 'gift', '#a855f7', ''],
      ['cat_13', 'Parents', 'Expense', 'heart', '#ec4899', ''],
      ['cat_14', 'Other', 'Expense', 'more-horizontal', '#6b7280', ''],
      ['cat_15', 'Sport', 'Expense', 'activity', '#0ea5e9', ''],
      ['cat_16', 'Gift', 'Expense', 'gift', '#ec4899', '']
    ];
    sheet.getRange(2, 1, defaultCategories.length, defaultCategories[0].length).setValues(defaultCategories);
  }
}

function setupTripsSheet(ss) {
  let sheet = ss.getSheetByName('Trips');
  if (!sheet) sheet = ss.insertSheet('Trips');
  
  if (sheet.getLastRow() === 0) {
    const headers = ['Id', 'Name', 'Destination', 'StartDate', 'EndDate', 'Budget', 'Currency', 'Status', 'Notes'];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold").setFontColor("#ffffff").setBackground("#334155");
    sheet.setFrozenRows(1);
  }
}

function setupSettingsSheet(ss) {
  let sheet = ss.getSheetByName('Settings');
  if (!sheet) sheet = ss.insertSheet('Settings');
  
  if (sheet.getLastRow() === 0) {
    const headers = ['Key', 'Value', 'Description'];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold").setFontColor("#ffffff").setBackground("#334155");
    sheet.setFrozenRows(1);
    
    const defaultSettings = [
      ['DefaultCurrency', 'MYR', 'Default currency for new transactions'],
      ['Theme', 'dark', 'Application UI theme (light/dark/system)'],
      ['TaxCountry', 'MY', 'Country code for tax considerations'],
      ['Language', 'en', 'Application language (en/zh)']
    ];
    sheet.getRange(2, 1, defaultSettings.length, defaultSettings[0].length).setValues(defaultSettings);
  }
}

function setupRecurringSheet(ss) {
  let sheet = ss.getSheetByName('Recurring');
  if (!sheet) sheet = ss.insertSheet('Recurring');
  
  const headers = RECURRING_HEADERS;
  const currentHeaders = sheet.getLastColumn() > 0 ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0] : [];
  const needsHeaderReset = sheet.getLastRow() <= 1 || currentHeaders[1] !== 'Name';
  
  if (needsHeaderReset) {
    sheet.clear();
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    const headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setFontWeight("bold");
    headerRange.setFontColor("#ffffff");
    headerRange.setBackground("#1e3a8a"); // Rich navy blue
    headerRange.setHorizontalAlignment("center");
    sheet.setFrozenRows(1);
    
    // Column widths
    sheet.setColumnWidth(1, 110); // Id
    sheet.setColumnWidth(2, 160); // Name
    sheet.setColumnWidth(3, 130); // Category
    sheet.setColumnWidth(4, 130); // SubCategory
    sheet.setColumnWidth(5, 100); // DayOfMonth
    sheet.setColumnWidth(6, 110); // Amount
    sheet.setColumnWidth(7, 80);  // Currency
    sheet.setColumnWidth(8, 110); // EffectiveFrom
    sheet.setColumnWidth(9, 100); // AutoRecord
    sheet.setColumnWidth(10, 140); // LastAutoRecordedMonth
    sheet.setColumnWidth(11, 180); // Notes
    sheet.setColumnWidth(12, 220); // History
  }
  return sheet;
}

function setupInstallmentsSheet(ss) {
  let sheet = ss.getSheetByName('Installments');
  if (!sheet) sheet = ss.insertSheet('Installments');
  
  const headers = INSTALLMENTS_HEADERS;
  const currentHeaders = sheet.getLastColumn() > 0 ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0] : [];
  const needsHeaderReset = sheet.getLastRow() <= 1 || currentHeaders[1] !== 'Name';
  
  if (needsHeaderReset) {
    sheet.clear();
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    const headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setFontWeight("bold");
    headerRange.setFontColor("#ffffff");
    headerRange.setBackground("#4338ca"); // Rich indigo
    headerRange.setHorizontalAlignment("center");
    sheet.setFrozenRows(1);
    
    // Column widths
    sheet.setColumnWidth(1, 110); // Id
    sheet.setColumnWidth(2, 160); // Name
    sheet.setColumnWidth(3, 130); // Category
    sheet.setColumnWidth(4, 80);  // Currency
    sheet.setColumnWidth(5, 120); // TotalPrincipal
    sheet.setColumnWidth(6, 100); // TenureMonths
    sheet.setColumnWidth(7, 120); // AnnualInterestRate
    sheet.setColumnWidth(8, 120); // MonthlyAmount
    sheet.setColumnWidth(9, 120); // TotalPayable
    sheet.setColumnWidth(10, 110); // StartDate
    sheet.setColumnWidth(11, 100); // EndDate
    sheet.setColumnWidth(12, 100); // AutoRecord
    sheet.setColumnWidth(13, 110); // TripTag
    sheet.setColumnWidth(14, 180); // Notes
  }
  return sheet;
}

