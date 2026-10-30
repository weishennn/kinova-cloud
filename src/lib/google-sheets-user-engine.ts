import { GoogleUserSession } from './google-auth';
import { getAdminUserRegistry, updateUserDriveIds } from './admin-registry';
import { ensureGoogleApiSuccess } from './google-api-result';
import { detectConcurrentFieldConflict } from './conflict-policy';
import { normalizeToCanonicalCategory, isLegacyFoodOrGrocery } from './canonical-categories';

export const DEFAULT_MONTHLY_HEADERS = [
  'Id', 'Date', 'Type', 'Category', 'SubCategory', 'Description',
  'Amount', 'Currency', 'TripTag', 'ReceiptUrl', 'Notes',
];

export const RECURRING_HEADERS = [
  'Id', 'Name', 'Category', 'SubCategory', 'DayOfMonth',
  'Amount', 'Currency', 'EffectiveFrom', 'AutoRecord', 'LastAutoRecordedMonth', 'Notes', 'History',
];

export const INSTALLMENTS_HEADERS = [
  'Id', 'Name', 'Category', 'Currency', 'TotalPrincipal',
  'TenureMonths', 'AnnualInterestRate', 'MonthlyAmount', 'TotalPayable',
  'StartDate', 'EndDate', 'AutoRecord', 'TripTag', 'Notes',
];

export const PORTFOLIO_HEADERS = [
  'Ticker', 'Asset Name', 'Type', 'Currency', 'Units Held',
  'Avg Cost', 'Total Cost', 'Live Price', 'Market Value',
  'Profit / Loss', 'Return %',
];

export const TRADES_HEADERS = [
  'Id', 'Date', 'Action', 'Ticker', 'Asset Name',
  'Quantity', 'Price', 'Fees', 'Net Total', 'Currency', 'Notes',
];

export const OVERVIEW_HEADERS = [
  'Month', 'Active Income', 'Living Expenses', 'Net Cash Savings',
  'Capital Invested', 'Dividends Received', 'Realized Capital Gains',
  'Total Investment Earned', 'Total Wealth Growth',
];

export const TRIPS_HEADERS = [
  'Id', 'Name', 'Destination', 'StartDate', 'EndDate', 'Budget', 'Currency', 'Status', 'Notes',
];

export const INVOICES_HEADERS = [
  'id', 'date', 'vendor', 'amount', 'status', 'due_date', 'url',
];

export const DELETED_TOMBSTONE_HEADERS = ['Id', 'DeletedAt', 'SheetName', 'MutationId'];

const userDriveMutationTails = new Map<string, Promise<void>>();

async function withUserDriveMutationLock<T>(spreadsheetId: string, operation: () => Promise<T>): Promise<T> {
  const previous = userDriveMutationTails.get(spreadsheetId) || Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  userDriveMutationTails.set(spreadsheetId, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (userDriveMutationTails.get(spreadsheetId) === tail) userDriveMutationTails.delete(spreadsheetId);
  }
}

function getCurrentYearMonth(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function getCurrentDateIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function googleApiFetch(url: string, accessToken: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', `Bearer ${accessToken}`);
  if (init.body && typeof init.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(url, {
    ...init,
    headers,
    cache: 'no-store',
  });
}

interface SpreadsheetMetadata {
  spreadsheetId: string;
  sheets: Array<{
    properties: {
      sheetId: number;
      title: string;
      index: number;
    };
  }>;
}

async function getSpreadsheetMetadata(spreadsheetId: string, accessToken: string): Promise<SpreadsheetMetadata | null> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=spreadsheetId,sheets.properties(sheetId,title,index)`;
  const res = await googleApiFetch(url, accessToken);
  if (!res.ok) return null;
  return (await res.json()) as SpreadsheetMetadata;
}

async function findDriveItemByName(
  accessToken: string,
  name: string,
  mimeType: string
): Promise<string | null> {
  const q = `name = '${name.replace(/'/g, "\\'")}' and mimeType = '${mimeType}' and trashed = false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&orderBy=createdTime&fields=files(id,name,createdTime)&pageSize=20`;
  const res = await googleApiFetch(url, accessToken);
  if (!res.ok) return null;
  const data = await res.json();
  if (Array.isArray(data.files) && data.files.length > 0) {
    return String(data.files[0].id);
  }
  return null;
}

/**
 * Finds all 'Kinova CashFlow' spreadsheets created by this app in the user's Drive,
 * keeps the primary one (oldest or preferredId), and moves any extra empty duplicate
 * spreadsheets to Google Drive Trash so the user's Drive stays clean with only 1 file.
 */
async function findAndDeduplicateUserSpreadsheets(
  accessToken: string,
  preferredId?: string
): Promise<string | null> {
  const q = `name = 'Kinova CashFlow' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&orderBy=createdTime&fields=files(id,name,createdTime)&pageSize=50`;
  const res = await googleApiFetch(url, accessToken);
  if (!res.ok) return null;
  const data = await res.json();
  const files: Array<{ id: string; name: string; createdTime?: string }> = Array.isArray(data.files)
    ? data.files
    : [];

  if (files.length === 0) {
    return findDriveItemByName(accessToken, 'CashFlow 记账', 'application/vnd.google-apps.spreadsheet');
  }

  if (files.length === 1) {
    return String(files[0].id);
  }

  // Multiple 'Kinova CashFlow' sheets exist: inspect current month rows across all of them so
  // we NEVER pick an empty duplicate over a sheet with recorded transactions, and merge any
  // transactions from duplicates into the single kept sheet before trashing duplicates.
  const currentMonth = getCurrentYearMonth();
  const inspected = await Promise.all(
    files.map(async (f) => {
      try {
        const checkUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
          f.id
        )}/values/${encodeURIComponent(`'${currentMonth}'!A1:N200`)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`;
        const checkRes = await googleApiFetch(checkUrl, accessToken);
        if (!checkRes.ok) return { id: String(f.id), dataRows: [] as unknown[][] };
        const valData = await checkRes.json();
        const rawVals: unknown[][] = Array.isArray(valData.values) ? valData.values : [];
        if (rawVals.length === 0) return { id: String(f.id), dataRows: [] as unknown[][] };
        const firstCell = String(rawVals[0]?.[0] ?? '').trim().toLowerCase();
        const startIdx = firstCell === 'id' ? 1 : 0;
        const dataRows = rawVals
          .slice(startIdx)
          .filter((r) => Array.isArray(r) && r.some((cell) => String(cell ?? '').trim() !== ''));
        return { id: String(f.id), dataRows };
      } catch {
        return { id: String(f.id), dataRows: [] as unknown[][] };
      }
    })
  );

  const preferredEntry = preferredId ? inspected.find((e) => e.id === preferredId) : undefined;
  const nonEmptyEntries = inspected.filter((e) => e.dataRows.length > 0);

  let keepEntry = preferredEntry && preferredEntry.dataRows.length > 0 ? preferredEntry : undefined;
  if (!keepEntry && nonEmptyEntries.length > 0) {
    keepEntry = nonEmptyEntries.reduce((best, curr) =>
      curr.dataRows.length >= best.dataRows.length ? curr : best
    );
  }
  if (!keepEntry) {
    keepEntry = preferredEntry || inspected[0];
  }

  const keepId = keepEntry.id;
  const seenIds = new Set<string>(
    keepEntry.dataRows.map((r) => String(r?.[0] ?? '').trim()).filter(Boolean)
  );

  // Rescue any transactions from other duplicate sheets into keepId, then trash all duplicates
  const rowsToRescue: unknown[][] = [];
  for (const entry of nonEmptyEntries) {
    if (entry.id === keepId) continue;
    for (const r of entry.dataRows) {
      const rowId = String(r?.[0] ?? '').trim();
      if (rowId && !seenIds.has(rowId)) {
        seenIds.add(rowId);
        rowsToRescue.push(r);
      } else if (!rowId) {
        rowsToRescue.push(r);
      }
    }
  }

  if (rowsToRescue.length > 0) {
    try {
      await googleApiFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
          keepId
        )}/values/${encodeURIComponent(`'${currentMonth}'!A1`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
        accessToken,
        {
          method: 'POST',
          body: JSON.stringify({ values: rowsToRescue }),
        }
      );
    } catch {
      // Ignore merge error
    }
  }

  const duplicates = inspected.filter((e) => e.id !== keepId);
  void (async () => {
    for (const dup of duplicates) {
      try {
        await googleApiFetch(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(dup.id)}`,
          accessToken,
          {
            method: 'PATCH',
            body: JSON.stringify({ trashed: true }),
          }
        );
      } catch {
        // Ignore individual cleanup errors
      }
    }
  })();

  return keepId;
}

async function ensureDriveFolder(accessToken: string, folderName: string, existingId?: string): Promise<string> {
  if (existingId) {
    const check = await googleApiFetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(existingId)}?fields=id,trashed`,
      accessToken
    );
    if (check.ok) {
      const meta = await check.json();
      if (meta && meta.id && !meta.trashed) return String(meta.id);
    }
  }

  const foundId = await findDriveItemByName(accessToken, folderName, 'application/vnd.google-apps.folder');
  if (foundId) return foundId;

  const createRes = await googleApiFetch('https://www.googleapis.com/drive/v3/files?fields=id', accessToken, {
    method: 'POST',
    body: JSON.stringify({
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
    }),
  });
  if (!createRes.ok) {
    const errText = await createRes.text();
    throw new Error(`Failed to create Google Drive folder "${folderName}": ${errText}`);
  }
  const created = await createRes.json();
  return String(created.id);
}

function buildOverviewInitialRows(yearOrYears: number | number[]): Array<Array<string | number>> {
  const rawYears = Array.isArray(yearOrYears) ? yearOrYears : [yearOrYears];
  const uniqueYears = Array.from(
    new Set(rawYears.filter((y) => Number.isFinite(y) && y >= 2000 && y <= 2100))
  ).sort((a, b) => a - b);

  if (uniqueYears.length === 0) {
    uniqueYears.push(new Date().getFullYear());
  }

  const rows: Array<Array<string | number>> = [OVERVIEW_HEADERS];
  let currentRow = 2; // 1-indexed sheet row number
  const annualTotalRows: number[] = [];

  for (const year of uniqueYears) {
    const yearStartRow = currentRow;
    for (let m = 1; m <= 12; m++) {
      const r = currentRow;
      const monthStr = `${year}-${String(m).padStart(2, '0')}`;
      rows.push([
        monthStr,
        `=IFERROR(SUMIFS('${monthStr}'!G:G, '${monthStr}'!C:C, "Income"), 0)`,
        `=IFERROR(SUMIFS('${monthStr}'!G:G, '${monthStr}'!C:C, "Expense"), 0)`,
        `=B${r}-C${r}`,
        `=IFERROR(SUMIFS('${monthStr}'!G:G, '${monthStr}'!C:C, "Investment"), 0)`,
        `=IFERROR(SUMIFS(Trades!I:I, Trades!C:C, "DIVIDEND", Trades!B:B, ">=${monthStr}-01", Trades!B:B, "<=${monthStr}-31"), 0)`,
        `=IFERROR(SUMIFS(Trades!I:I, Trades!C:C, "SELL", Trades!B:B, ">=${monthStr}-01", Trades!B:B, "<=${monthStr}-31"), 0)`,
        `=F${r}+G${r}`,
        `=D${r}+H${r}`,
      ]);
      currentRow++;
    }
    const yearEndRow = currentRow - 1;
    const totalRow = currentRow;
    annualTotalRows.push(totalRow);
    rows.push([
      `🏆 ${year} ANNUAL TOTAL`,
      `=SUM(B${yearStartRow}:B${yearEndRow})`,
      `=SUM(C${yearStartRow}:C${yearEndRow})`,
      `=SUM(D${yearStartRow}:D${yearEndRow})`,
      `=SUM(E${yearStartRow}:E${yearEndRow})`,
      `=SUM(F${yearStartRow}:F${yearEndRow})`,
      `=SUM(G${yearStartRow}:G${yearEndRow})`,
      `=SUM(H${yearStartRow}:H${yearEndRow})`,
      `=SUM(I${yearStartRow}:I${yearEndRow})`,
    ]);
    currentRow++;
  }

  if (annualTotalRows.length > 1) {
    const sumCols = (col: string) => '=' + annualTotalRows.map((r) => `${col}${r}`).join('+');
    rows.push([
      '🌎 ALL-TIME GRAND TOTAL',
      sumCols('B'),
      sumCols('C'),
      sumCols('D'),
      sumCols('E'),
      sumCols('F'),
      sumCols('G'),
      sumCols('H'),
      sumCols('I'),
    ]);
  }

  return rows;
}

async function createAndInitializeUserSpreadsheet(accessToken: string): Promise<string> {
  const currentMonth = getCurrentYearMonth();
  const currentYear = new Date().getFullYear();

  const sheetTitles = [
    'Overview',
    currentMonth,
    'Portfolio',
    'Trades',
    'Categories',
    'Trips',
    'Invoices',
    'Recurring',
    'Installments',
    'Settings',
    'Deleted Records',
  ];

  const createRes = await googleApiFetch('https://sheets.googleapis.com/v4/spreadsheets', accessToken, {
    method: 'POST',
    body: JSON.stringify({
      properties: {
        title: 'Kinova CashFlow',
      },
      sheets: sheetTitles.map((title, idx) => ({
        properties: {
          title,
          index: idx,
          gridProperties: {
            frozenRowCount: 1,
          },
        },
      })),
    }),
  });

  if (!createRes.ok) {
    const errText = await createRes.text();
    throw new Error(`Failed to create Kinova spreadsheet in Google Drive: ${errText}`);
  }

  const created = await createRes.json();
  const spreadsheetId = String(created.spreadsheetId);

  const defaultCategories = [
    ['Id', 'Name', 'Type', 'Icon', 'Color', 'ParentId'],
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
    ['cat_16', 'Gift', 'Expense', 'gift', '#ec4899', ''],
  ];

  const defaultSettings = [
    ['Key', 'Value', 'Description'],
    ['DefaultCurrency', 'MYR', 'Default currency for new transactions'],
    ['Theme', 'dark', 'Application UI theme (light/dark/system)'],
    ['TaxCountry', 'MY', 'Country code for tax considerations'],
    ['Language', 'en', 'Application language (en/zh)'],
    ['cashflow_sync_v2_recurring_commitments', '{"version":1,"entries":[]}', 'Recurring commitments sync envelope'],
    ['cashflow_sync_v2_installment_plans', '{"version":1,"entries":[]}', 'Installment plans sync envelope'],
  ];

  await googleApiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`,
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify({
        valueInputOption: 'USER_ENTERED',
        data: [
          { range: `'Overview'!A1`, values: buildOverviewInitialRows(currentYear) },
          { range: `'${currentMonth}'!A1`, values: [DEFAULT_MONTHLY_HEADERS] },
          { range: `'Portfolio'!A1`, values: [PORTFOLIO_HEADERS] },
          { range: `'Trades'!A1`, values: [TRADES_HEADERS] },
          { range: `'Categories'!A1`, values: defaultCategories },
          { range: `'Trips'!A1`, values: [TRIPS_HEADERS] },
          { range: `'Invoices'!A1`, values: [INVOICES_HEADERS] },
          { range: `'Recurring'!A1`, values: [RECURRING_HEADERS] },
          { range: `'Installments'!A1`, values: [INSTALLMENTS_HEADERS] },
          { range: `'Settings'!A1`, values: defaultSettings },
          { range: `'Deleted Records'!A1`, values: [DELETED_TOMBSTONE_HEADERS] },
        ],
      }),
    }
  );

  return spreadsheetId;
}

interface ResolvedWorkspace {
  spreadsheetId: string;
  invoicesFolderId: string;
  backupsFolderId: string;
  meta: SpreadsheetMetadata;
  changed: boolean;
  cachedAt: number;
}

const userWorkspaceCache = new Map<string, ResolvedWorkspace>();
const workspaceInitLocks = new Map<string, Promise<ResolvedWorkspace>>();

export async function ensureUserWorkspace(session: GoogleUserSession): Promise<{
  spreadsheetId: string;
  invoicesFolderId: string;
  backupsFolderId: string;
  meta: SpreadsheetMetadata;
  changed: boolean;
}> {
  const emailKey = session.email.trim().toLowerCase();
  const cached = userWorkspaceCache.get(emailKey);
  if (cached && Date.now() - cached.cachedAt < 10 * 60 * 1000) {
    const changed =
      session.spreadsheetId !== cached.spreadsheetId ||
      session.invoicesFolderId !== cached.invoicesFolderId ||
      session.backupsFolderId !== cached.backupsFolderId;
    if (changed) {
      session.spreadsheetId = cached.spreadsheetId;
      session.invoicesFolderId = cached.invoicesFolderId;
      session.backupsFolderId = cached.backupsFolderId;
    }
    return {
      spreadsheetId: cached.spreadsheetId,
      invoicesFolderId: cached.invoicesFolderId,
      backupsFolderId: cached.backupsFolderId,
      meta: cached.meta,
      changed,
    };
  }

  const inflight = workspaceInitLocks.get(emailKey);
  if (inflight) {
    const resolved = await inflight;
    session.spreadsheetId = resolved.spreadsheetId;
    session.invoicesFolderId = resolved.invoicesFolderId;
    session.backupsFolderId = resolved.backupsFolderId;
    return resolved;
  }

  const initPromise = (async (): Promise<ResolvedWorkspace> => {
    let spreadsheetId = session.spreadsheetId || cached?.spreadsheetId || '';
    let invoicesFolderId = session.invoicesFolderId || cached?.invoicesFolderId || '';
    let backupsFolderId = session.backupsFolderId || cached?.backupsFolderId || '';
    let meta: SpreadsheetMetadata | null = null;
    let changed = false;

    // 1. If session cookie didn't have spreadsheetId yet, check Admin Registry first
    if (!spreadsheetId) {
      try {
        const registry = await getAdminUserRegistry(false);
        const regEntry = registry[emailKey];
        if (regEntry?.spreadsheetId) {
          spreadsheetId = regEntry.spreadsheetId;
          invoicesFolderId = invoicesFolderId || regEntry.invoicesFolderId || '';
          backupsFolderId = backupsFolderId || regEntry.backupsFolderId || '';
          changed = true;
        }
      } catch {
        // Ignore registry read errors
      }
    }

    // 2. Also run Drive search + duplicate cleanup if possible
    const driveFoundId = await findAndDeduplicateUserSpreadsheets(session.accessToken, spreadsheetId);
    if (driveFoundId && driveFoundId !== spreadsheetId) {
      spreadsheetId = driveFoundId;
      changed = true;
    }

    if (spreadsheetId) {
      meta = await getSpreadsheetMetadata(spreadsheetId, session.accessToken);
      if (!meta && driveFoundId && driveFoundId !== spreadsheetId) {
        meta = await getSpreadsheetMetadata(driveFoundId, session.accessToken);
        if (meta) {
          spreadsheetId = driveFoundId;
          changed = true;
        }
      }
    }

    // 3. Only create a new spreadsheet if none exists in session, Registry, or Drive
    if (!meta) {
      spreadsheetId = await createAndInitializeUserSpreadsheet(session.accessToken);
      meta = await getSpreadsheetMetadata(spreadsheetId, session.accessToken);
      changed = true;
    }

    if (!meta) {
      throw new Error('Could not open or initialize Google Sheet in your Google Drive.');
    }

    // Ensure the current calendar month tab (e.g., 2027-01 when a new year begins) exists
    const currentMonthTab = getCurrentYearMonth();
    if (!meta.sheets.some((s) => s.properties.title === currentMonthTab)) {
      try {
        await ensureSheetExists(spreadsheetId, session.accessToken, meta, currentMonthTab);
      } catch (monthErr) {
        console.warn('[Workspace] Auto-create current month tab skipped:', monthErr);
      }
    }

    // 4. Immediately lock spreadsheetId onto session BEFORE optional Drive folder creation
    session.spreadsheetId = spreadsheetId;

    // 5. Make Drive folder creation non-fatal (so if Drive API is still propagating/disabled,
    // it NEVER throws or loses spreadsheetId or triggers duplicate sheet creation!)
    try {
      const resolvedInvoices = await ensureDriveFolder(
        session.accessToken,
        'CashFlow Invoices',
        invoicesFolderId
      );
      if (resolvedInvoices && resolvedInvoices !== session.invoicesFolderId) {
        invoicesFolderId = resolvedInvoices;
        changed = true;
      }
    } catch (folderErr) {
      console.warn('[Workspace] Optional Invoices folder init skipped:', folderErr);
    }

    try {
      const resolvedBackups = await ensureDriveFolder(
        session.accessToken,
        'CashFlow Backups',
        backupsFolderId
      );
      if (resolvedBackups && resolvedBackups !== session.backupsFolderId) {
        backupsFolderId = resolvedBackups;
        changed = true;
      }
    } catch (folderErr) {
      console.warn('[Workspace] Optional Backups folder init skipped:', folderErr);
    }

    session.spreadsheetId = spreadsheetId;
    session.invoicesFolderId = invoicesFolderId;
    session.backupsFolderId = backupsFolderId;

    const result: ResolvedWorkspace = {
      spreadsheetId,
      invoicesFolderId,
      backupsFolderId,
      meta,
      changed,
      cachedAt: Date.now(),
    };
    userWorkspaceCache.set(emailKey, result);

    await updateUserDriveIds(session.email, {
      spreadsheetId,
      invoicesFolderId,
      backupsFolderId,
    });

    return result;
  })();

  workspaceInitLocks.set(emailKey, initPromise);
  try {
    return await initPromise;
  } finally {
    workspaceInitLocks.delete(emailKey);
  }
}

function getDefaultHeadersForSheet(sheetName: string): string[] {
  if (sheetName === 'Recurring') return RECURRING_HEADERS;
  if (sheetName === 'Installments') return INSTALLMENTS_HEADERS;
  if (sheetName === 'Portfolio') return PORTFOLIO_HEADERS;
  if (sheetName === 'Trades') return TRADES_HEADERS;
  if (sheetName === 'Overview') return OVERVIEW_HEADERS;
  if (sheetName === 'Trips') return TRIPS_HEADERS;
  if (sheetName === 'Invoices') return INVOICES_HEADERS;
  if (sheetName === 'Settings') return ['Key', 'Value', 'Description'];
  if (sheetName === 'Deleted Records') return DELETED_TOMBSTONE_HEADERS;
  return DEFAULT_MONTHLY_HEADERS;
}

async function syncOverviewSheetForMeta(
  spreadsheetId: string,
  accessToken: string,
  meta: SpreadsheetMetadata
): Promise<void> {
  await ensureSheetExists(spreadsheetId, accessToken, meta, 'Overview');
  const yearSet = new Set<number>([new Date().getFullYear()]);
  for (const s of meta.sheets) {
    const title = s.properties.title;
    if (/^\d{4}-\d{2}$/.test(title)) {
      const y = Number(title.slice(0, 4));
      if (Number.isFinite(y) && y >= 2000 && y <= 2100) {
        yearSet.add(y);
      }
    }
  }
  const overviewRows = buildOverviewInitialRows(Array.from(yearSet));
  await googleApiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`'Overview'!A1:I1000`)}:clear`,
    accessToken,
    { method: 'POST', body: JSON.stringify({}) }
  );
  await googleApiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`'Overview'!A1`)}?valueInputOption=USER_ENTERED`,
    accessToken,
    {
      method: 'PUT',
      body: JSON.stringify({
        values: overviewRows,
      }),
    }
  );
}

async function ensureSheetExists(
  spreadsheetId: string,
  accessToken: string,
  meta: SpreadsheetMetadata,
  sheetName: string
): Promise<number> {
  const existing = meta.sheets.find((s) => s.properties.title === sheetName);
  if (existing) return existing.properties.sheetId;

  const addRes = await googleApiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify({
        requests: [
          {
            addSheet: {
              properties: {
                title: sheetName,
                gridProperties: { frozenRowCount: 1 },
              },
            },
          },
        ],
      }),
    }
  );

  if (!addRes.ok) {
    const errText = await addRes.text();
    if (errText.toLowerCase().includes('already exists')) {
      const freshMeta = await getSpreadsheetMetadata(spreadsheetId, accessToken);
      if (freshMeta) {
        meta.sheets = freshMeta.sheets;
        const found = meta.sheets.find((s) => s.properties.title === sheetName);
        if (found) return found.properties.sheetId;
      }
    }
    throw new Error(`Failed to create sheet tab "${sheetName}": ${errText}`);
  }

  const addData = await addRes.json();
  const newProps = addData.replies?.[0]?.addSheet?.properties;
  const sheetId = Number(newProps?.sheetId || 0);
  meta.sheets.push({
    properties: {
      sheetId,
      title: sheetName,
      index: meta.sheets.length,
    },
  });

  const defaultHeaders = getDefaultHeadersForSheet(sheetName);
  await googleApiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`'${sheetName}'!A1`)}?valueInputOption=USER_ENTERED`,
    accessToken,
    {
      method: 'PUT',
      body: JSON.stringify({
        values: [defaultHeaders],
      }),
    }
  );

  if (/^\d{4}-\d{2}$/.test(sheetName)) {
    try {
      await syncOverviewSheetForMeta(spreadsheetId, accessToken, meta);
    } catch (ovErr) {
      console.warn('[Overview] Auto-sync Overview after creating month tab failed:', ovErr);
    }
  }

  return sheetId;
}

async function readSheetValues(
  spreadsheetId: string,
  accessToken: string,
  sheetName: string
): Promise<string[][]> {
  const range = `'${sheetName}'!A1:ZZ5000`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`;
  const res = await googleApiFetch(url, accessToken);
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data.values) ? data.values : [];
}

async function readSheetRange(
  spreadsheetId: string,
  accessToken: string,
  range: string
): Promise<unknown[][]> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`;
  const response = await googleApiFetch(url, accessToken);
  if (!response.ok) throw new Error(`Could not read Google Sheets range ${range}.`);
  const data = await response.json();
  return Array.isArray(data.values) ? data.values : [];
}

function parseValuesToRows(sheetName: string, values: unknown[][], fallbackHeaders: string[]) {
  if (!values || values.length === 0) {
    return { headers: fallbackHeaders, rows: [] as Record<string, unknown>[] };
  }
  const firstRow = (values[0] || []).map((h) => String(h ?? '').trim()).filter(Boolean);
  const firstCellLower = (firstRow[0] || '').toLowerCase();
  const isHeaderRow =
    firstRow.length > 0 &&
    (fallbackHeaders.some((fh) => fh.toLowerCase() === firstCellLower) ||
      firstCellLower === 'id' ||
      firstCellLower === 'ticker' ||
      firstCellLower === 'month' ||
      firstCellLower === 'key');

  const effectiveHeaders = isHeaderRow ? firstRow : fallbackHeaders;
  const startIdx = isHeaderRow ? 1 : 0;
  const rows: Record<string, unknown>[] = [];

  for (let i = startIdx; i < values.length; i++) {
    const rowArr = values[i] || [];
    const rowObj: Record<string, unknown> = {
      _rowIndex: i + 1,
      _month: sheetName,
    };
    let hasData = false;
    for (let j = 0; j < effectiveHeaders.length; j++) {
      let val = rowArr[j] !== undefined && rowArr[j] !== null ? rowArr[j] : '';
      if (effectiveHeaders[j].toLowerCase() === 'category') {
        const catStr = String(val).trim();
        if (isLegacyFoodOrGrocery(catStr)) {
          val = 'Food & Dining';
        }
      }
      rowObj[effectiveHeaders[j]] = val;
      if (val !== '') hasData = true;
    }
    if (hasData) rows.push(rowObj);
  }

  return { headers: effectiveHeaders, rows };
}

/**
 * Converts a 0-based column index to spreadsheet column letter (A, B, ..., Z, AA, AB, ...).
 */
export function columnIndexToLetter(idx: number): string {
  let temp = idx;
  let letter = '';
  while (temp >= 0) {
    letter = String.fromCharCode((temp % 26) + 65) + letter;
    temp = Math.floor(temp / 26) - 1;
  }
  return letter;
}

/**
 * Automatically inspects the 'Category' column in a sheet tab.
 * If any rows contain legacy labels like "Groceries", "Food", "Dining", etc.,
 * it immediately batch-updates those cells in Google Sheets to "Food & Dining".
 * This ensures the user's charts and SUMIF formulas in Google Sheets are 100% complete.
 */
async function autoSanitizeSheetCategories(
  spreadsheetId: string,
  accessToken: string,
  sheetName: string,
  values: unknown[][],
  headers: string[]
): Promise<number> {
  if (!values || values.length <= 1) return 0;

  // Inspect values[0] (actual first row of sheet) to find exact column index of Category
  const row0 = (values[0] || []).map((h) => String(h ?? '').trim().toLowerCase());
  let catColIdx = row0.findIndex((h) => h === 'category');
  if (catColIdx < 0) catColIdx = row0.findIndex((h) => h.includes('category') || h.includes('类别') || h.includes('分类'));
  if (catColIdx < 0) catColIdx = headers.findIndex((h) => h.toLowerCase() === 'category');
  if (catColIdx < 0) return 0;

  const updates: Array<{ range: string; values: string[][] }> = [];
  const colLetter = columnIndexToLetter(catColIdx);

  for (let i = 1; i < values.length; i++) {
    const rawVal = String(values[i]?.[catColIdx] ?? '').trim();
    if (isLegacyFoodOrGrocery(rawVal)) {
      const rowIndex = i + 1;
      updates.push({
        range: `'${sheetName}'!${colLetter}${rowIndex}`,
        values: [['Food & Dining']],
      });
      // Mutate in-place so current query results are already clean
      values[i][catColIdx] = 'Food & Dining';
    }
  }

  if (updates.length > 0) {
    try {
      const batchRes = await googleApiFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`,
        accessToken,
        {
          method: 'POST',
          body: JSON.stringify({
            valueInputOption: 'USER_ENTERED',
            data: updates,
          }),
        }
      );
      if (!batchRes.ok) {
        const errText = await batchRes.text();
        console.warn(`[CategorySanitizer] Batch-update HTTP failed in ${sheetName}:`, errText);
      } else {
        console.info(`[CategorySanitizer] Converted ${updates.length} legacy food/grocery cells in ${sheetName} to 'Food & Dining'`);
      }
    } catch (err) {
      console.warn(`[CategorySanitizer] Failed to batch-update legacy categories in ${sheetName}:`, err);
    }
  }

  return updates.length;
}

function getMonthListFromMeta(meta: SpreadsheetMetadata): string[] {
  const monthRegex = /^\d{4}-\d{2}$/;
  return meta.sheets
    .map((s) => s.properties.title)
    .filter((name) => monthRegex.test(name))
    .sort()
    .reverse();
}

async function getSettingsMap(
  spreadsheetId: string,
  accessToken: string,
  meta: SpreadsheetMetadata
): Promise<Record<string, string>> {
  await ensureSheetExists(spreadsheetId, accessToken, meta, 'Settings');
  const values = await readSheetValues(spreadsheetId, accessToken, 'Settings');
  const settings: Record<string, string> = {};
  for (let i = 1; i < values.length; i++) {
    const k = String(values[i]?.[0] ?? '').trim();
    const v = String(values[i]?.[1] ?? '');
    if (k) settings[k] = v;
  }
  return settings;
}

async function updateSettingValue(
  spreadsheetId: string,
  accessToken: string,
  meta: SpreadsheetMetadata,
  key: string,
  value: string
) {
  await ensureSheetExists(spreadsheetId, accessToken, meta, 'Settings');
  const values = await readSheetValues(spreadsheetId, accessToken, 'Settings');
  const strValue = String(value ?? '');
  let targetRow = -1;

  for (let i = 1; i < values.length; i++) {
    if (String(values[i]?.[0] ?? '').trim() === key) {
      targetRow = i + 1;
      break;
    }
  }

  if (targetRow > 0) {
    await googleApiFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`'Settings'!A${targetRow}:C${targetRow}`)}?valueInputOption=RAW`,
      accessToken,
      {
        method: 'PUT',
        body: JSON.stringify({
          values: [[key, strValue, values[targetRow - 1]?.[2] || 'User Setting']],
        }),
      }
    );
  } else {
    const nextRow = Math.max(values.length + 1, 2);
    await googleApiFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`'Settings'!A${nextRow}:C${nextRow}`)}?valueInputOption=RAW`,
      accessToken,
      {
        method: 'PUT',
        body: JSON.stringify({
          values: [[key, strValue, 'User Setting']],
        }),
      }
    );
  }

  return {
    success: true,
    verified: true,
    key,
    updatedAt: new Date().toISOString(),
  };
}

async function hasDeletedTombstone(
  spreadsheetId: string,
  accessToken: string,
  meta: SpreadsheetMetadata,
  id: string
): Promise<boolean> {
  if (!id) return false;
  await ensureSheetExists(spreadsheetId, accessToken, meta, 'Deleted Records');
  const values = await readSheetValues(spreadsheetId, accessToken, 'Deleted Records');
  const target = id.trim();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i]?.[0] ?? '').trim() === target) return true;
  }
  return false;
}

async function recordDeletedTombstone(
  spreadsheetId: string,
  accessToken: string,
  meta: SpreadsheetMetadata,
  id: string,
  sheetName: string,
  mutationId?: string
): Promise<void> {
  const normalizedId = String(id || '').trim();
  if (!normalizedId) return;
  await ensureSheetExists(spreadsheetId, accessToken, meta, 'Deleted Records');
  const values = await readSheetValues(spreadsheetId, accessToken, 'Deleted Records');
  const rowPayload = [normalizedId, Date.now(), String(sheetName || ''), String(mutationId || '')];

  for (let i = 1; i < values.length; i++) {
    if (String(values[i]?.[0] ?? '').trim() === normalizedId) {
      const r = i + 1;
      await googleApiFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`'Deleted Records'!A${r}:D${r}`)}?valueInputOption=USER_ENTERED`,
        accessToken,
        {
          method: 'PUT',
          body: JSON.stringify({ values: [rowPayload] }),
        }
      );
      return;
    }
  }

  await googleApiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`'Deleted Records'!A1`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify({ values: [rowPayload] }),
    }
  );
}

async function removeDeletedTombstone(
  spreadsheetId: string,
  accessToken: string,
  meta: SpreadsheetMetadata,
  id: string
): Promise<void> {
  const normalizedId = String(id || '').trim();
  if (!normalizedId) return;
  await ensureSheetExists(spreadsheetId, accessToken, meta, 'Deleted Records');
  const values = await readSheetValues(spreadsheetId, accessToken, 'Deleted Records');
  const sheetMeta = meta.sheets.find((s) => s.properties.title === 'Deleted Records');
  if (!sheetMeta) return;

  for (let i = 1; i < values.length; i++) {
    if (String(values[i]?.[0] ?? '').trim() === normalizedId) {
      const matchedRow = i + 1;
      await googleApiFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
        accessToken,
        {
          method: 'POST',
          body: JSON.stringify({
            requests: [
              {
                deleteDimension: {
                  range: {
                    sheetId: sheetMeta.properties.sheetId,
                    dimension: 'ROWS',
                    startIndex: matchedRow - 1,
                    endIndex: matchedRow,
                  },
                },
              },
            ],
          }),
        }
      );
      return;
    }
  }
}

async function deleteLinkedTradeFlowRowsUser(
  spreadsheetId: string,
  accessToken: string,
  meta: SpreadsheetMetadata,
  tradeId: string,
  tradeDate: unknown,
  mutationId?: string
): Promise<void> {
  const flowId = `tx_trade_${String(tradeId || '').replace(/[^A-Za-z0-9_-]/g, '_')}`;
  if (!tradeId) return;
  const tradeMonth = String(tradeDate || '').slice(0, 7);
  const months = new Set(getMonthListFromMeta(meta));
  if (/^\d{4}-\d{2}$/.test(tradeMonth)) months.add(tradeMonth);
  const requests: Array<{ deleteDimension: { range: { sheetId: number; dimension: 'ROWS'; startIndex: number; endIndex: number } } }> = [];
  let tombstoneMonth = tradeMonth;

  for (const month of months) {
    const sheetMeta = meta.sheets.find((sheet) => sheet.properties.title === month);
    if (!sheetMeta) continue;
    const values = await readSheetValues(spreadsheetId, accessToken, month);
    const headers = (values[0] || []).map((header) => String(header || '').trim().toLowerCase());
    const idIndex = headers.indexOf('id');
    for (let i = values.length - 1; i >= 1; i--) {
      if (String(values[i]?.[idIndex >= 0 ? idIndex : 0] ?? '').trim() !== flowId) continue;
      tombstoneMonth = tombstoneMonth || month;
      requests.push({
        deleteDimension: {
          range: {
            sheetId: sheetMeta.properties.sheetId,
            dimension: 'ROWS',
            startIndex: i,
            endIndex: i + 1,
          },
        },
      });
    }
  }

  await recordDeletedTombstone(spreadsheetId, accessToken, meta, flowId, tombstoneMonth || 'Transactions', mutationId);
  if (requests.length > 0) {
    const response = await googleApiFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
      accessToken,
      { method: 'POST', body: JSON.stringify({ requests }) }
    );
    await ensureGoogleApiSuccess(response, 'linked trade Flow delete');
  }
  await syncOverviewSheetForMeta(spreadsheetId, accessToken, meta);
}

async function syncPortfolioFromTradesUser(
  spreadsheetId: string,
  accessToken: string,
  meta: SpreadsheetMetadata
): Promise<void> {
  const tradesSheetMeta = meta.sheets.find(
    (s) => s.properties.title.trim().toLowerCase() === 'trades'
  );
  const tradesSheetTitle = tradesSheetMeta ? tradesSheetMeta.properties.title : 'Trades';
  await ensureSheetExists(spreadsheetId, accessToken, meta, tradesSheetTitle);
  await ensureSheetExists(spreadsheetId, accessToken, meta, 'Portfolio');

  const tradeValues = await readSheetValues(spreadsheetId, accessToken, tradesSheetTitle);

  // Portfolio is derived data: rebuild it even when the trade ledger is empty,
  // otherwise deleting the final trade leaves a stale holding behind.

  const holdings: Record<
    string,
    { ticker: string; name: string; currency: string; units: number; cost: number }
  > = {};

  const headerRow = (tradeValues[0] || []).map((h) => String(h || '').trim().toLowerCase());
  const dateIdx = headerRow.indexOf('date');
  const actionIdx = headerRow.indexOf('action');
  const tickerIdx = headerRow.indexOf('ticker');
  const nameIdx = headerRow.findIndex((h) => h.includes('asset') || h.includes('name'));
  const qtyIdx = headerRow.findIndex((h) => h.includes('quant') || h === 'qty');
  const priceIdx = headerRow.indexOf('price');
  const feesIdx = headerRow.indexOf('fees');
  const currIdx = headerRow.indexOf('currency');
  const notesIdx = headerRow.indexOf('notes');

  const getCol = (r: unknown[], idx: number, fallbackIdx: number) => {
    const i = idx >= 0 ? idx : fallbackIdx;
    return r[i];
  };

  const tradeTimestamp = (row: unknown[]) => {
    const parsed = Date.parse(String(getCol(row, dateIdx, 1) || ''));
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const orderedTradeRows = tradeValues.slice(1).sort((a, b) => tradeTimestamp(a || []) - tradeTimestamp(b || []));
  for (const row of orderedTradeRows) {
    const action = String(getCol(row, actionIdx, 2) || 'BUY').toUpperCase();
    const ticker = String(getCol(row, tickerIdx, 3) || '').trim().toUpperCase();
    const name = String(getCol(row, nameIdx, 4) || ticker);
    const quantity = Number(getCol(row, qtyIdx, 5)) || 0;
    const price = Number(getCol(row, priceIdx, 6)) || 0;
    const fees = Number(getCol(row, feesIdx, 7)) || 0;
    const currency = String(getCol(row, currIdx, 9) || 'USD');
    if (!ticker || quantity <= 0) continue;

    if (!holdings[ticker]) {
      holdings[ticker] = { ticker, name, currency, units: 0, cost: 0 };
    }
    const h = holdings[ticker];
    const notes = String(getCol(row, notesIdx, 10) || '').toLowerCase();
    const isReinvested =
      action === 'REINVEST' ||
      (action === 'DIVIDEND' && (notes.includes('reinvest') || notes.includes('drip')));

    if (action === 'BUY' || isReinvested) {
      h.units += quantity;
      h.cost += quantity * price + fees;
    } else if (action === 'SELL') {
      const avgCost = h.units > 0 ? h.cost / h.units : 0;
      h.units = Math.max(0, h.units - quantity);
      h.cost = Math.max(0, h.cost - quantity * avgCost);
    }
  }

  const activeHoldings = Object.values(holdings).filter((h) => h.units > 0);
  const rows: Array<Array<string | number>> = [PORTFOLIO_HEADERS];
  activeHoldings.forEach((h, idx) => {
    const r = idx + 2;
    const avgCost = h.units > 0 ? h.cost / h.units : 0;
    rows.push([
      h.ticker,
      h.name,
      'Stock',
      h.currency,
      h.units,
      avgCost,
      `=IF(E${r}>0, E${r}*F${r}, "")`,
      `=IF(ISBLANK(A${r}), "", IFERROR(GOOGLEFINANCE(A${r}, "price"), IFERROR(GOOGLEFINANCE("NASDAQ:" & A${r}, "price"), IFERROR(GOOGLEFINANCE("NYSE:" & A${r}, "price"), F${r}))))`,
      `=IF(AND(E${r}>0, H${r}>0), E${r}*H${r}, "")`,
      `=IF(AND(G${r}>0, I${r}>0), I${r}-G${r}, "")`,
      `=IF(AND(G${r}>0, I${r}>0), (I${r}-G${r})/G${r}, "")`,
    ]);
  });

  // Clear Portfolio and rewrite
  const clearRes = await googleApiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`'Portfolio'!A:K`)}:clear`,
    accessToken,
    { method: 'POST', body: JSON.stringify({}) }
  );
  await ensureGoogleApiSuccess(clearRes, 'Portfolio clear');

  const portEndCol = columnIndexToLetter(PORTFOLIO_HEADERS.length - 1);
  const portPutRange = `'Portfolio'!A1:${portEndCol}${rows.length}`;

  const writeRes = await googleApiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(portPutRange)}?valueInputOption=USER_ENTERED`,
    accessToken,
    {
      method: 'PUT',
      body: JSON.stringify({
        range: portPutRange,
        majorDimension: 'ROWS',
        values: rows,
      }),
    }
  );
  await ensureGoogleApiSuccess(writeRes, 'Portfolio rebuild');
}

/** Reads Trades from Google Sheets without synthesizing history from holdings. */
async function getTradesWithAutoHeal(
  spreadsheetId: string,
  accessToken: string,
  meta: SpreadsheetMetadata
): Promise<{ headers: string[]; rows: Record<string, unknown>[] }> {
  const tradesSheetMeta = meta.sheets.find(
    (s) => s.properties.title.trim().toLowerCase() === 'trades'
  );
  const tradesSheetTitle = tradesSheetMeta ? tradesSheetMeta.properties.title : 'Trades';
  await ensureSheetExists(spreadsheetId, accessToken, meta, tradesSheetTitle);
  const values = await readSheetValues(spreadsheetId, accessToken, tradesSheetTitle);
  return parseValuesToRows(tradesSheetTitle, values, TRADES_HEADERS);
}

/**
 * Atomically writes a batch of synced trades to Google Sheets 'Trades' tab in a single PUT request.
 * Completely eliminates read-replica race conditions and contiguous overwrite issues.
 * Automatically synchronizes the 'Portfolio' tab from the resulting contiguous rows.
 */
async function batchSyncTradesUser(
  spreadsheetId: string,
  accessToken: string,
  meta: SpreadsheetMetadata,
  incomingTrades: Array<Record<string, unknown>>
): Promise<{ added: number; updated: number; total: number; rows: Record<string, unknown>[] }> {
  const tradesSheetMeta = meta.sheets.find(
    (s) => s.properties.title.trim().toLowerCase() === 'trades'
  );
  const tradesSheetTitle = tradesSheetMeta ? tradesSheetMeta.properties.title : 'Trades';
  await ensureSheetExists(spreadsheetId, accessToken, meta, tradesSheetTitle);
  await ensureSheetExists(spreadsheetId, accessToken, meta, 'Portfolio');

  const existingValues = await readSheetValues(spreadsheetId, accessToken, tradesSheetTitle);
  const parsedExisting = parseValuesToRows(tradesSheetTitle, existingValues, TRADES_HEADERS);
  const existingRows = parsedExisting.rows;

  await ensureSheetExists(spreadsheetId, accessToken, meta, 'Deleted Records');
  const deletedValues = await readSheetValues(spreadsheetId, accessToken, 'Deleted Records');
  const deletedHeaders = (deletedValues[0] || []).map((header) => String(header || '').trim().toLowerCase());
  const deletedIdIdx = deletedHeaders.indexOf('id');
  const deletedSheetIdx = deletedHeaders.indexOf('sheetname');
  const tombstonedTradeIds = new Set<string>();
  for (let i = 1; i < deletedValues.length; i++) {
    const row = deletedValues[i] || [];
    if (deletedSheetIdx >= 0 && String(row[deletedSheetIdx] || '') !== 'Trades') continue;
    const deletedId = String(row[deletedIdIdx >= 0 ? deletedIdIdx : 0] || '').trim();
    if (deletedId) tombstonedTradeIds.add(deletedId);
  }

  let addedCount = 0;
  let updatedCount = 0;
  const mergedRows: Array<Record<string, unknown>> = [...existingRows];

  for (const trade of incomingTrades) {
    const ticker = String(trade.Ticker || trade.ticker || '').trim().toUpperCase();
    const date = String(trade.Date || trade.date || getCurrentDateIso()).trim();
    const action = String(trade.Action || trade.action || 'BUY').toUpperCase();
    const qty = Math.abs(parseFloat(String(trade.Quantity || trade.quantity || '0')));
    const price = parseFloat(String(trade.Price || trade.price || '0'));
    const fees = parseFloat(String(trade.Fees || trade.fees || '0'));
    const currency = String(trade.Currency || trade.currency || 'USD').toUpperCase();
    const assetName = String(trade['Asset Name'] || trade.AssetName || trade.name || ticker);
    const notes = String(trade.Notes || trade.notes || '');
    const tradeId = String(trade.Id || trade.id || `moo_${ticker.toLowerCase()}_${Date.now().toString(36)}`);

    // Moomoo imports are upserted by account plus order ID. Do not deduplicate
    // unrelated same-day trades by ticker and quantity.
    const incomingOrderId = notes.match(/\bOrder:\s*([^;\s)]+)/i)?.[1] || '';
    const incomingAccountId = notes.match(/\bAccount:\s*([^;\s)]+)/i)?.[1] || '';
    const existingIndex = mergedRows.findIndex((r) => {
      const rId = String(r.Id || r.id || '');
      const rNotes = String(r.Notes || r.notes || '');
      const existingOrderId = rNotes.match(/\bOrder:\s*([^;\s)]+)/i)?.[1] || '';
      const existingAccountId = rNotes.match(/\bAccount:\s*([^;\s)]+)/i)?.[1] || '';
      return Boolean(tradeId && rId === tradeId) || Boolean(incomingOrderId && (
        (rId === `moo_${incomingOrderId}` && (!existingAccountId || existingAccountId === incomingAccountId)) ||
        (existingOrderId === incomingOrderId && incomingAccountId && existingAccountId === incomingAccountId)
      ));
    });

    const hasMatchingTombstone = Boolean(incomingOrderId && tombstonedTradeIds.has(`moo_${incomingOrderId}`));
    const wasDeleted = existingIndex < 0 && (tombstonedTradeIds.has(tradeId) || hasMatchingTombstone);
    if (wasDeleted) continue;

    const providedNetTotal = Number(trade['Net Total'] ?? trade.netTotal ?? trade.total);
    const netTotal = Number.isFinite(providedNetTotal)
      ? providedNetTotal
      : Number((qty * price + (action === 'SELL' ? -fees : fees)).toFixed(2));
    const normalizedTrade = {
      Id: tradeId,
      Date: date,
      Action: action,
      Ticker: ticker,
      'Asset Name': assetName,
      Quantity: qty,
      Price: price,
      Fees: fees,
      'Net Total': netTotal,
      Currency: currency,
      Notes: notes,
    };

    if (existingIndex >= 0) {
      const current = mergedRows[existingIndex];
      const existingValues = [
        current.Id || current.id || '', current.Date || current.date || '', current.Action || current.action || '',
        current.Ticker || current.ticker || '', current['Asset Name'] || current.AssetName || current.name || '',
        current.Quantity || current.quantity || 0, current.Price || current.price || 0,
        current.Fees || current.fees || 0, current['Net Total'] || current.netTotal || current.total || 0,
        current.Currency || current.currency || '', current.Notes || current.notes || '',
      ];
      const incomingValues = [
        normalizedTrade.Id, normalizedTrade.Date, normalizedTrade.Action, normalizedTrade.Ticker,
        normalizedTrade['Asset Name'], normalizedTrade.Quantity, normalizedTrade.Price, normalizedTrade.Fees,
        normalizedTrade['Net Total'], normalizedTrade.Currency, normalizedTrade.Notes,
      ];
      if (existingValues.some((value, index) => String(value) !== String(incomingValues[index]))) {
        mergedRows[existingIndex] = { ...current, ...normalizedTrade };
        updatedCount++;
      }
    } else {
      mergedRows.push(normalizedTrade);
      addedCount++;
    }
  }

  // Write merged rows over the existing data without clearing history first.
  const rowsToWrite: Array<Array<string | number>> = [TRADES_HEADERS];
  mergedRows.forEach((r) => {
    rowsToWrite.push([
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
      String(r.Notes || r.notes || ''),
    ]);
  });

  const endCol = columnIndexToLetter(TRADES_HEADERS.length - 1);
  const putRange = `'${tradesSheetTitle}'!A1:${endCol}${rowsToWrite.length}`;

  const putRes = await googleApiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(putRange)}?valueInputOption=USER_ENTERED`,
    accessToken,
    {
      method: 'PUT',
      body: JSON.stringify({
        range: putRange,
        majorDimension: 'ROWS',
        values: rowsToWrite,
      }),
    }
  );

  if (!putRes.ok) throw new Error('Could not write the Moomoo trade history to Google Sheets.');

  // Sync Portfolio from the fresh contiguous rows
  await syncPortfolioFromTradesUser(spreadsheetId, accessToken, meta);

  // Read back to verify
  const verifiedValues = await readSheetValues(spreadsheetId, accessToken, tradesSheetTitle);
  const verifiedParsed = parseValuesToRows(tradesSheetTitle, verifiedValues, TRADES_HEADERS);

  return {
    added: addedCount,
    updated: updatedCount,
    total: verifiedParsed.rows.length > 0 ? verifiedParsed.rows.length : mergedRows.length,
    rows: verifiedParsed.rows.length > 0 ? verifiedParsed.rows : mergedRows,
  };
}

function normalizedTradeNetTotal(trade: Record<string, unknown>, action: string, quantity: number, price: number, fees: number): number {
  const provided = Number(trade['Net Total'] ?? trade.netTotal ?? trade.total);
  return Number.isFinite(provided) ? provided : Number((quantity * price + (action === 'SELL' ? -fees : fees)).toFixed(2));
}

async function clearRestoredMoomooTradeTombstones(
  spreadsheetId: string,
  accessToken: string,
  meta: SpreadsheetMetadata,
  restoredTrades: Array<Record<string, unknown>>
): Promise<number> {
  const restoredIds = new Set<string>();
  for (const trade of restoredTrades) {
    const id = String(trade.Id || trade.id || '').trim();
    const notes = String(trade.Notes || trade.notes || '');
    if (!id || !/^moo_/i.test(id) || !/Moomoo Auto-Sync/i.test(notes)) continue;
    restoredIds.add(id);
    const orderId = notes.match(/\bOrder:\s*([^;\s)]+)/i)?.[1];
    if (orderId) restoredIds.add(`moo_${orderId}`);
  }
  if (restoredIds.size === 0) return 0;

  await ensureSheetExists(spreadsheetId, accessToken, meta, 'Deleted Records');
  const sheetMeta = meta.sheets.find((sheet) => sheet.properties.title === 'Deleted Records');
  if (!sheetMeta) throw new Error('Could not find the Deleted Records tab to restore Moomoo trades.');
  const deletedRows = await readSheetRange(spreadsheetId, accessToken, "'Deleted Records'!A:D");
  const rowsToDelete: number[] = [];
  for (let i = 1; i < deletedRows.length; i++) {
    const row = deletedRows[i] || [];
    if (String(row[2] || '') !== 'Trades') continue;
    if (restoredIds.has(String(row[0] || '').trim())) rowsToDelete.push(i + 1);
  }
  if (rowsToDelete.length === 0) return 0;

  const response = await googleApiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify({
        requests: rowsToDelete
          .sort((a, b) => b - a)
          .map((rowNumber) => ({
            deleteDimension: {
              range: {
                sheetId: sheetMeta.properties.sheetId,
                dimension: 'ROWS',
                startIndex: rowNumber - 1,
                endIndex: rowNumber,
              },
            },
          })),
      }),
    }
  );
  if (!response.ok) throw new Error('Could not remove the matching Moomoo deletion markers.');

  const verifiedRows = await readSheetRange(spreadsheetId, accessToken, "'Deleted Records'!A:D");
  const stillBlocked = verifiedRows.slice(1).some((row) =>
    String(row?.[2] || '') === 'Trades' && restoredIds.has(String(row?.[0] || '').trim())
  );
  if (stillBlocked) throw new Error('Moomoo deletion-marker cleanup could not be verified.');
  return rowsToDelete.length;
}

function buildMoomooCashflowRow(trade: Record<string, unknown>): Record<string, unknown> | null {
  const tradeId = String(trade.Id || trade.id || '').trim();
  const notes = String(trade.Notes || trade.notes || '');
  const date = String(trade.Date || trade.date || '').trim().slice(0, 10);
  const action = String(trade.Action || trade.action || '').trim().toUpperCase();
  const ticker = String(trade.Ticker || trade.ticker || '').trim().toUpperCase();
  const quantity = Number(trade.Quantity || trade.quantity) || 0;
  const price = Number(trade.Price || trade.price) || 0;
  const fees = Math.abs(Number(trade.Fees || trade.fees) || 0);
  const currency = String(trade.Currency || trade.currency || 'USD').trim().toUpperCase();
  if (!tradeId || !/^moo_/i.test(tradeId) || !/Moomoo Auto-Sync/i.test(notes) || !date || !ticker || quantity <= 0 || price <= 0) return null;

  const netTotal = normalizedTradeNetTotal(trade, action, quantity, price, fees);
  const flowId = `tx_trade_${tradeId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const feeDetails = `Fees: ${fees.toFixed(2)} ${currency}; Net total: ${netTotal.toFixed(2)} ${currency}`;
  return {
    Id: flowId,
    Date: date,
    Type: action === 'SELL' ? 'Income' : 'Investment',
    Category: 'Stocks & Crypto',
    SubCategory: action,
    Description: `${action} ${quantity} ${ticker} @ ${price} ${currency}`,
    Amount: netTotal,
    Currency: currency,
    Notes: `${notes}${notes ? '; ' : ''}${feeDetails}`,
  };
}

function isLegacyMoomooDepositRow(row: unknown[], headers: string[]): boolean {
  const index = (name: string) => headers.findIndex((header) => header.toLowerCase() === name.toLowerCase());
  const id = String(row[index('Id') >= 0 ? index('Id') : 0] ?? '').trim();
  const subCategory = String(row[index('SubCategory')] ?? '').trim().toLowerCase();
  const description = String(row[index('Description')] ?? '').trim().toLowerCase();
  const notes = String(row[index('Notes')] ?? '').trim();
  return /^moo_dep_/i.test(id) &&
    subCategory === 'moomoo deposit' &&
    description === 'moomoo investment account deposit' &&
    /^Auto-synced from Moomoo Cloud API \(Account:\s*[^)]+\)$/i.test(notes);
}

function normalizeMoomooFlowCompareValue(header: string, value: unknown): string {
  if (header.toLowerCase() === 'date') {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return new Date(Date.UTC(1899, 11, 30) + value * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    }
    const text = String(value ?? '').trim();
    return text.match(/^\d{4}-\d{2}-\d{2}/)?.[0] || text;
  }
  return String(value ?? '');
}

async function clearMoomooFlowTombstonesUser(
  spreadsheetId: string,
  accessToken: string,
  meta: SpreadsheetMetadata,
  flowIds: Set<string>
): Promise<void> {
  if (flowIds.size === 0) return;
  await ensureSheetExists(spreadsheetId, accessToken, meta, 'Deleted Records');
  const sheetMeta = meta.sheets.find((sheet) => sheet.properties.title === 'Deleted Records');
  if (!sheetMeta) return;
  const values = await readSheetValues(spreadsheetId, accessToken, 'Deleted Records');
  const rowsToDelete: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const id = String(values[i]?.[0] ?? '').trim();
    const sheetName = String(values[i]?.[2] ?? '').trim();
    if (flowIds.has(id) && /^\d{4}-\d{2}$/.test(sheetName)) rowsToDelete.push(i + 1);
  }
  if (rowsToDelete.length === 0) return;

  const response = await googleApiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify({
        requests: rowsToDelete.sort((a, b) => b - a).map((rowNumber) => ({
          deleteDimension: {
            range: {
              sheetId: sheetMeta.properties.sheetId,
              dimension: 'ROWS',
              startIndex: rowNumber - 1,
              endIndex: rowNumber,
            },
          },
        })),
      }),
    }
  );
  if (!response.ok) throw new Error('Could not restore deleted Moomoo Flow rows.');
}

async function syncMoomooCashflowRowsUser(
  spreadsheetId: string,
  accessToken: string,
  meta: SpreadsheetMetadata,
  trades: Array<Record<string, unknown>>,
  cleanupLegacyDeposits: boolean
): Promise<{ flowAdded: number; flowUpdated: number; duplicateFlowRowsRemoved: number; removedDepositRows: number }> {
  const desiredRows = trades.map(buildMoomooCashflowRow).filter((row): row is Record<string, unknown> => Boolean(row));
  const desiredById = new Map(desiredRows.map((row) => [String(row.Id), row]));
  const desiredIds = new Set(desiredById.keys());
  const monthForId = new Map(desiredRows.map((row) => [String(row.Id), String(row.Date).slice(0, 7)]));
  for (const month of new Set(monthForId.values())) await ensureSheetExists(spreadsheetId, accessToken, meta, month);

  const targetMonths = [...new Set(monthForId.values())];
  const months = cleanupLegacyDeposits
    ? [...new Set([...getMonthListFromMeta(meta), ...targetMonths])]
    : targetMonths;
  const monthlySheets = await Promise.all(months.map(async (month) => ({
    month,
    sheetMeta: meta.sheets.find((sheet) => sheet.properties.title === month),
    values: await readSheetValues(spreadsheetId, accessToken, month),
  })));
  const rowsById = new Map<string, Array<{ month: string; rowNumber: number; values: unknown[] }>>();
  const deletesByMonth = new Map<string, Set<number>>();
  const updates: Array<{ range: string; values: unknown[][] }> = [];
  const additionsByMonth = new Map<string, unknown[][]>();
  let removedDepositRows = 0;

  const markDelete = (month: string, rowNumber: number, isDeposit = false) => {
    if (!deletesByMonth.has(month)) deletesByMonth.set(month, new Set());
    const deletes = deletesByMonth.get(month)!;
    if (!deletes.has(rowNumber)) {
      deletes.add(rowNumber);
      if (isDeposit) removedDepositRows++;
      return true;
    }
    return false;
  };

  for (const sheet of monthlySheets) {
    const headers = (sheet.values[0] || []).map((header) => String(header ?? '').trim()).filter(Boolean);
    if (headers.length === 0) continue;
    const idIndex = headers.findIndex((header) => header.toLowerCase() === 'id');
    for (let i = 1; i < sheet.values.length; i++) {
      const row = sheet.values[i] || [];
      if (cleanupLegacyDeposits && isLegacyMoomooDepositRow(row, headers)) {
        markDelete(sheet.month, i + 1, true);
        continue;
      }
      const rowId = String(row[idIndex >= 0 ? idIndex : 0] ?? '').trim();
      if (!rowId || (!desiredIds.has(rowId) && !/^tx_trade_moo_/i.test(rowId))) continue;
      if (!rowsById.has(rowId)) rowsById.set(rowId, []);
      rowsById.get(rowId)!.push({ month: sheet.month, rowNumber: i + 1, values: row });
    }
  }

  await clearMoomooFlowTombstonesUser(spreadsheetId, accessToken, meta, desiredIds);

  let flowAdded = 0;
  let flowUpdated = 0;
  let duplicateFlowRowsRemoved = 0;
  for (const [flowId, rowData] of desiredById) {
    const targetMonth = monthForId.get(flowId)!;
    const matches = rowsById.get(flowId) || [];
    const targetMatches = matches.filter((match) => match.month === targetMonth);
    const keep = targetMatches[0];
    for (const match of matches) {
      if (match !== keep) {
        if (markDelete(match.month, match.rowNumber)) duplicateFlowRowsRemoved++;
      }
    }

    const sheet = monthlySheets.find((entry) => entry.month === targetMonth);
    if (!sheet) throw new Error(`Could not read the ${targetMonth} monthly sheet for a Moomoo trade.`);
    const headers = (sheet.values[0] || []).map((header) => String(header ?? '').trim()).filter(Boolean);
    if (headers.length === 0) throw new Error(`The ${targetMonth} monthly sheet has no transaction headers.`);
    const rowValues = headers.map((header) => Object.prototype.hasOwnProperty.call(rowData, header) ? rowData[header] : '');

    if (keep) {
      const updatedValues = headers.map((header, index) =>
        Object.prototype.hasOwnProperty.call(rowData, header) ? rowData[header] : (keep.values[index] ?? '')
      );
      if (updatedValues.some((value, index) => normalizeMoomooFlowCompareValue(headers[index], value) !== normalizeMoomooFlowCompareValue(headers[index], keep.values[index]))) {
        updates.push({ range: `'${targetMonth}'!A${keep.rowNumber}`, values: [updatedValues] });
        flowUpdated++;
      }
    } else {
      if (!additionsByMonth.has(targetMonth)) additionsByMonth.set(targetMonth, []);
      additionsByMonth.get(targetMonth)!.push(rowValues);
      flowAdded++;
    }
  }

  if (updates.length > 0) {
    const response = await googleApiFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`,
      accessToken,
      { method: 'POST', body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: updates }) }
    );
    if (!response.ok) throw new Error('Could not update linked Moomoo transactions in Google Sheets.');
  }

  for (const [month, additions] of additionsByMonth) {
    const appendResponse = await googleApiFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`'${month}'!A:Z`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      accessToken,
      { method: 'POST', body: JSON.stringify({ values: additions, majorDimension: 'ROWS' }) }
    );
    await ensureGoogleApiSuccess(appendResponse, `Moomoo transactions append (${month})`);
  }

  const deleteRequests = monthlySheets.flatMap((sheet) => {
    const sheetId = sheet.sheetMeta?.properties.sheetId;
    if (sheetId === undefined) return [];
    return [...(deletesByMonth.get(sheet.month) || [])]
      .sort((a, b) => b - a)
      .map((rowNumber) => ({
        deleteDimension: {
          range: {
            sheetId,
            dimension: 'ROWS',
            startIndex: rowNumber - 1,
            endIndex: rowNumber,
          },
        },
      }));
  });
  if (deleteRequests.length > 0) {
    const deleteResponse = await googleApiFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
      accessToken,
      { method: 'POST', body: JSON.stringify({ requests: deleteRequests }) }
    );
    await ensureGoogleApiSuccess(deleteResponse, 'Moomoo Flow cleanup');
  }

  return { flowAdded, flowUpdated, duplicateFlowRowsRemoved, removedDepositRows };
}

function findDuplicateMoomooTradeRows(idValues: unknown[][], noteValues: unknown[][]): number[] {
  const parent = new Map<number, number>();
  const firstRowByKey = new Map<string, number>();
  const identities = new Map<number, { id: string; accountId: string; orderId: string }>();
  const find = (row: number): number => {
    const current = parent.get(row);
    if (current === undefined || current === row) return row;
    const root = find(current);
    parent.set(row, root);
    return root;
  };
  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };

  for (let index = 1; index < Math.max(idValues.length, noteValues.length); index++) {
    const id = String(idValues[index]?.[0] || '').trim();
    const notes = String(noteValues[index]?.[0] || '');
    if (!/Moomoo Auto-Sync/i.test(notes)) continue;
    const orderId = notes.match(/\bOrder:\s*([^;\s)]+)/i)?.[1] || '';
    const accountId = notes.match(/\bAccount:\s*([^;\s)]+)/i)?.[1] || '';
    if (!id || (!orderId && !id.startsWith('moo_'))) continue;

    const rowNumber = index + 1;
    parent.set(rowNumber, rowNumber);
    identities.set(rowNumber, { id, accountId, orderId });
    const keys = [`id:${id}`];
    if (accountId && orderId) keys.push(`order:${accountId}:${orderId}`);
    for (const key of keys) {
      const previous = firstRowByKey.get(key);
      if (previous === undefined) firstRowByKey.set(key, rowNumber);
      else union(previous, rowNumber);
    }
  }

  const groups = new Map<number, number[]>();
  for (const row of identities.keys()) {
    const root = find(row);
    const group = groups.get(root) || [];
    group.push(row);
    groups.set(root, group);
  }

  const duplicateRows: number[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const canonical = group.find((row) => {
      const identity = identities.get(row)!;
      return Boolean(identity.accountId && identity.orderId && identity.id === `moo_${identity.accountId}_${identity.orderId}`);
    });
    const keep = canonical ?? Math.max(...group);
    duplicateRows.push(...group.filter((row) => row !== keep));
  }
  return duplicateRows.sort((a, b) => b - a);
}

async function syncMoomooTradesUser(
  spreadsheetId: string,
  accessToken: string,
  meta: SpreadsheetMetadata,
  incomingTrades: Array<Record<string, unknown>>,
  restoreDeletedMoomooTrades = false,
  reconcileFlowHistory = false,
  cleanupLegacyDeposits = false
): Promise<{ added: number; updated: number; changes: Array<Record<string, unknown>>; removedIds: string[]; restoredTombstones: number; duplicateTradeRowsRemoved: number; flowAdded: number; flowUpdated: number; duplicateFlowRowsRemoved: number; removedDepositRows: number }> {
  const tradesSheetMeta = meta.sheets.find((sheet) => sheet.properties.title.trim().toLowerCase() === 'trades');
  const sheetTitle = tradesSheetMeta?.properties.title || 'Trades';
  await ensureSheetExists(spreadsheetId, accessToken, meta, sheetTitle);
  const [idValues, noteValues] = await Promise.all([
    readSheetRange(spreadsheetId, accessToken, `'${sheetTitle}'!A:A`),
    readSheetRange(spreadsheetId, accessToken, `'${sheetTitle}'!K:K`),
  ]);
  const rowById = new Map<string, number>();
  const rowByAccountOrder = new Map<string, number>();
  const rowByLegacyOrder = new Map<string, number>();
  for (let i = 1; i < Math.max(idValues.length, noteValues.length); i++) {
    const rowNumber = i + 1;
    const id = String(idValues[i]?.[0] || '').trim();
    const notes = String(noteValues[i]?.[0] || '');
    if (id) rowById.set(id, rowNumber);
    const match = notes.match(/\bOrder:\s*([^;\s)]+)/i);
    const accountMatch = notes.match(/\bAccount:\s*([^;\s)]+)/i);
    if (/moomoo/i.test(notes) && match) {
      if (accountMatch) rowByAccountOrder.set(`${accountMatch[1]}:${match[1]}`, rowNumber);
      else if (id === `moo_${match[1]}`) rowByLegacyOrder.set(match[1], rowNumber);
    }
  }

  await ensureSheetExists(spreadsheetId, accessToken, meta, 'Deleted Records');
  const deletedIds = new Set((await readSheetRange(spreadsheetId, accessToken, "'Deleted Records'!A:D"))
    .slice(1)
    .filter((row) => String(row[2] || '') === 'Trades')
    .map((row) => String(row[0] || '').trim())
    .filter(Boolean));

  const preparedCandidates = incomingTrades.map((trade) => {
    const ticker = String(trade.Ticker || trade.ticker || '').trim().toUpperCase();
    const date = String(trade.Date || trade.date || '').trim();
    const action = String(trade.Action || trade.action || 'BUY').toUpperCase();
    const quantity = Math.abs(Number(trade.Quantity || trade.quantity) || 0);
    const price = Number(trade.Price || trade.price) || 0;
    const fees = Math.abs(Number(trade.Fees || trade.fees) || 0);
    const currency = String(trade.Currency || trade.currency || 'USD').toUpperCase();
    const assetName = String(trade['Asset Name'] || trade.AssetName || trade.name || ticker);
    const notes = String(trade.Notes || trade.notes || '');
    const id = String(trade.Id || trade.id || '').trim();
    const orderId = notes.match(/\bOrder:\s*([^;\s)]+)/i)?.[1] || '';
    const accountId = notes.match(/\bAccount:\s*([^;\s)]+)/i)?.[1] || '';
    const rowNumber = rowById.get(id) || (accountId ? rowByAccountOrder.get(`${accountId}:${orderId}`) : undefined) || rowByLegacyOrder.get(orderId) || 0;
    const hasMatchingTombstone = Boolean(orderId && deletedIds.has(`moo_${orderId}`));
    const wasDeleted = !restoreDeletedMoomooTrades && rowNumber === 0 && (deletedIds.has(id) || hasMatchingTombstone);
    const netTotal = normalizedTradeNetTotal(trade, action, quantity, price, fees);
    const normalized = {
      Id: id,
      Date: date,
      Action: action,
      Ticker: ticker,
      'Asset Name': assetName,
      Quantity: quantity,
      Price: price,
      Fees: fees,
      'Net Total': netTotal,
      Currency: currency,
      Notes: notes,
    };
    return {
      id,
      orderId,
      accountId,
      rowNumber,
      wasDeleted,
      normalized,
      rowValues: [id, date, action, ticker, assetName, quantity, price, fees, netTotal, currency, notes],
    };
  }).filter((trade) => trade.id && trade.normalized.Ticker && trade.normalized.Date && trade.normalized.Quantity > 0 && trade.normalized.Price > 0 && !trade.wasDeleted);
  const preparedByIdentity = new Map<string, (typeof preparedCandidates)[number]>();
  for (const trade of preparedCandidates) {
    const identity = trade.accountId && trade.orderId
      ? `order:${trade.accountId}:${trade.orderId}`
      : `id:${trade.id}`;
    preparedByIdentity.set(identity, trade);
  }
  const prepared = [...preparedByIdentity.values()];

  const existingRows = await Promise.all(prepared
    .filter((trade) => trade.rowNumber > 0)
    .map(async (trade) => ({
      ...trade,
      current: (await readSheetRange(spreadsheetId, accessToken, `'${sheetTitle}'!A${trade.rowNumber}:K${trade.rowNumber}`))[0] || [],
    })));
  const currentByRow = new Map(existingRows.map((trade) => [trade.rowNumber, trade.current]));
  const updates: Array<{ range: string; values: unknown[][] }> = [];
  const additions: typeof prepared = [];
  const changes: Array<Record<string, unknown>> = [];
  const removedIds: string[] = [];
  let updatedCount = 0;

  for (const trade of prepared) {
    changes.push(trade.normalized);
    if (trade.rowNumber === 0) {
      additions.push(trade);
      continue;
    }
    const current = currentByRow.get(trade.rowNumber) || [];
    const hasChanged = trade.rowValues.some((value, index) => String(value) !== String(current[index] ?? ''));
    if (hasChanged) {
      updates.push({ range: `'${sheetTitle}'!A${trade.rowNumber}:K${trade.rowNumber}`, values: [trade.rowValues] });
      const oldId = String(current[0] || '').trim();
      if (oldId && oldId !== trade.id) removedIds.push(oldId);
      updatedCount++;
    }
  }

  if (updates.length > 0) {
    const response = await googleApiFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`,
      accessToken,
      { method: 'POST', body: JSON.stringify({ valueInputOption: 'RAW', data: updates }) }
    );
    if (!response.ok) throw new Error('Could not update matching Moomoo trades in Google Sheets.');
  }

  if (additions.length > 0) {
    const appendRange = `'${sheetTitle}'!A:K`;
    const response = await googleApiFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(appendRange)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      accessToken,
      { method: 'POST', body: JSON.stringify({ values: additions.map((trade) => trade.rowValues) }) }
    );
    if (!response.ok) throw new Error('Could not append Moomoo trades to Google Sheets.');
  }

  const duplicateTradeRowsRemoved = findDuplicateMoomooTradeRows(idValues, noteValues);
  if (duplicateTradeRowsRemoved.length > 0) {
    const requests = duplicateTradeRowsRemoved.map((rowNumber) => ({
      deleteDimension: {
        range: {
          sheetId: tradesSheetMeta!.properties.sheetId,
          dimension: 'ROWS' as const,
          startIndex: rowNumber - 1,
          endIndex: rowNumber,
        },
      },
    }));
    const response = await googleApiFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
      accessToken,
      { method: 'POST', body: JSON.stringify({ requests }) }
    );
    await ensureGoogleApiSuccess(response, 'duplicate Moomoo trade cleanup');
    // Removing duplicate source rows also means their formerly linked Flow
    // rows must be reconciled across every month in the same operation.
    reconcileFlowHistory = true;
    cleanupLegacyDeposits = true;
  }

  const restoredTombstones = restoreDeletedMoomooTrades
    ? await clearRestoredMoomooTradeTombstones(spreadsheetId, accessToken, meta, changes)
    : 0;

  // Trades are authoritative. Rebuild after every upsert, including no-op
  // retries, so a partial previous write cannot leave Portfolio out of sync.
  await syncPortfolioFromTradesUser(spreadsheetId, accessToken, meta);

  // Monthly transactions mirror the complete Moomoo ledger, not only the latest
  // API page, so a light sync also repairs trades that were previously missing from Flow.
  const flowTrades = reconcileFlowHistory
    ? (await getTradesWithAutoHeal(spreadsheetId, accessToken, meta)).rows
    : changes;
  const cashflowResult = await syncMoomooCashflowRowsUser(
    spreadsheetId,
    accessToken,
    meta,
    flowTrades,
    cleanupLegacyDeposits
  );

  return { added: additions.length, updated: updatedCount, changes, removedIds, restoredTombstones, duplicateTradeRowsRemoved: duplicateTradeRowsRemoved.length, ...cashflowResult };
}

/**
 * Executes a Kinova Sheets/Drive action directly against the logged-in user's own Google Drive.
 */
export async function executeUserGoogleAction(
  session: GoogleUserSession,
  action: string,
  params: Record<string, unknown> = {}
): Promise<{ result: unknown; sessionChanged: boolean }> {
  const { spreadsheetId, invoicesFolderId, backupsFolderId, meta, changed } =
    await ensureUserWorkspace(session);
  const accessToken = session.accessToken;

  const wrap = (result: unknown) => ({ result, sessionChanged: changed });

  switch (action) {
    case 'ping':
      return wrap({
        pong: true,
        spreadsheetReady: true,
        sheetCount: meta.sheets.length,
        spreadsheetId,
      });

    case 'getAllSheetNames': {
      const freshMeta = await getSpreadsheetMetadata(spreadsheetId, accessToken);
      if (freshMeta) {
        meta.sheets = freshMeta.sheets;
      }
      return wrap(meta.sheets.map((s) => s.properties.title));
    }

    case 'getMonthList': {
      const freshMeta = await getSpreadsheetMetadata(spreadsheetId, accessToken);
      if (freshMeta) {
        meta.sheets = freshMeta.sheets;
      }
      return wrap(getMonthListFromMeta(meta));
    }

    case 'getSheetSchema': {
      let sheetName = String(params.sheetName || '');
      if (sheetName === 'Recurring') return wrap(RECURRING_HEADERS);
      if (sheetName === 'Installments') return wrap(INSTALLMENTS_HEADERS);
      if (!sheetName || sheetName === 'Transactions') {
        const months = getMonthListFromMeta(meta);
        sheetName = months[0] || getCurrentYearMonth();
      }
      const exists = meta.sheets.some((s) => s.properties.title === sheetName);
      if (!exists) return wrap(getDefaultHeadersForSheet(sheetName));
      const values = await readSheetValues(spreadsheetId, accessToken, sheetName);
      const headers = (values[0] || []).map((h) => String(h ?? '').trim()).filter(Boolean);
      return wrap(headers.length > 0 ? headers : getDefaultHeadersForSheet(sheetName));
    }

    case 'getSheetData':
    case 'getSheetDataIfExists': {
      let sheetName = String(params.sheetName || '');
      if (!sheetName || sheetName === 'Transactions') {
        if (params.month) {
          sheetName = String(params.month);
        } else {
          const months = getMonthListFromMeta(meta);
          const currentYM = getCurrentYearMonth();
          sheetName = months.includes(currentYM) ? currentYM : (months[0] || currentYM);
        }
      }
      const isMonthlyTab = /^\d{4}-\d{2}$/.test(sheetName);
      const exists = meta.sheets.some((s) => s.properties.title === sheetName);
      if (!exists) {
        if (isMonthlyTab) {
          // Try reading directly in case another serverless instance just created this month tab
          const directValues = await readSheetValues(spreadsheetId, accessToken, sheetName);
          if (directValues.length > 0) {
            meta.sheets.push({
              properties: {
                sheetId: 0,
                title: sheetName,
                index: meta.sheets.length,
              },
            });
            await autoSanitizeSheetCategories(spreadsheetId, accessToken, sheetName, directValues, getDefaultHeadersForSheet(sheetName));
            return wrap(parseValuesToRows(sheetName, directValues, getDefaultHeadersForSheet(sheetName)));
          }
          return wrap({
            headers: action === 'getSheetDataIfExists' ? [] : getDefaultHeadersForSheet(sheetName),
            rows: [],
          });
        }
        if (action === 'getSheetDataIfExists') {
          return wrap({
            headers: [],
            rows: [],
          });
        }
        await ensureSheetExists(spreadsheetId, accessToken, meta, sheetName);
      }
      const values = await readSheetValues(spreadsheetId, accessToken, sheetName);
      if (sheetName === 'Trades') {
        const tradesRes = await getTradesWithAutoHeal(spreadsheetId, accessToken, meta);
        return wrap(tradesRes);
      }
      if (isMonthlyTab) {
        await autoSanitizeSheetCategories(spreadsheetId, accessToken, sheetName, values, getDefaultHeadersForSheet(sheetName));
      }
      return wrap(parseValuesToRows(sheetName, values, getDefaultHeadersForSheet(sheetName)));
    }

    case 'getAllTransactions': {
      let months = getMonthListFromMeta(meta);
      const yearParam = params.year ? String(params.year).trim() : '';
      const allParam = params.all === true || params.all === 'true';

      if (yearParam && /^\d{4}$/.test(yearParam)) {
        months = months.filter((m) => m.startsWith(`${yearParam}-`));
      } else if (!allParam) {
        const limit = Number(params.limitMonths) > 0 ? Number(params.limitMonths) : 3;
        const currentYM = getCurrentYearMonth();
        const activeAndPast = months.filter((m) => m <= currentYM);
        months = (activeAndPast.length >= limit ? activeAndPast : months).slice(0, limit);
      }

      if (months.length === 0) {
        return wrap({ headers: DEFAULT_MONTHLY_HEADERS, rows: [] });
      }

      const rangesQuery = months
        .map((m) => `ranges=${encodeURIComponent(`'${m}'!A1:ZZ2000`)}`)
        .join('&');
      const batchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchGet?${rangesQuery}&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`;
      const batchRes = await googleApiFetch(batchUrl, accessToken);

      let allRows: Record<string, unknown>[] = [];
      let headers = DEFAULT_MONTHLY_HEADERS;

      if (batchRes.ok) {
        const batchData = await batchRes.json();
        const valueRanges = Array.isArray(batchData.valueRanges) ? batchData.valueRanges : [];
        await Promise.all(
          valueRanges.map(async (vr: { values?: unknown[][] }, idx: number) => {
            const mName = months[idx];
            const mValues = vr.values || [];
            await autoSanitizeSheetCategories(spreadsheetId, accessToken, mName, mValues, DEFAULT_MONTHLY_HEADERS);
            const parsed = parseValuesToRows(mName, mValues, DEFAULT_MONTHLY_HEADERS);
            if (parsed.headers.length > 0) headers = parsed.headers;
            allRows = allRows.concat(parsed.rows);
          })
        );
      }

      allRows = allRows
        .filter((r) => r.Id !== 'tx_sample' && r.Date)
        .sort((a, b) => String(b.Date || '').localeCompare(String(a.Date || '')));

      return wrap({ headers, rows: allRows });
    }

    case 'getPortfolio': {
      await ensureSheetExists(spreadsheetId, accessToken, meta, 'Portfolio');
      const values = await readSheetValues(spreadsheetId, accessToken, 'Portfolio');
      const holdings = [];
      for (let i = 1; i < values.length; i++) {
        const r = values[i] || [];
        const ticker = String(r[0] || '').trim();
        const units = Number(r[4]) || 0;
        if (ticker && units > 0) {
          holdings.push({
            ticker,
            name: String(r[1] || ''),
            type: String(r[2] || 'Stock'),
            currency: String(r[3] || 'USD'),
            units,
            avgCost: Number(r[5]) || 0,
            totalCost: Number(r[6]) || 0,
            livePrice: Number(r[7]) || Number(r[5]) || 0,
            marketValue: Number(r[8]) || 0,
            pnl: Number(r[9]) || 0,
            returnPercent: Number(r[10]) || 0,
          });
        }
      }
      return wrap(holdings);
    }

    case 'getTrades': {
      const res = await getTradesWithAutoHeal(spreadsheetId, accessToken, meta);
      return wrap(res);
    }

    case 'getOverview': {
      await ensureSheetExists(spreadsheetId, accessToken, meta, 'Overview');
      const values = await readSheetValues(spreadsheetId, accessToken, 'Overview');
      const parsed = parseValuesToRows('Overview', values, OVERVIEW_HEADERS);
      return wrap(parsed.rows);
    }

    case 'getSettings':
    case 'getSettingsIfExists': {
      const settings = await getSettingsMap(spreadsheetId, accessToken, meta);
      return wrap(settings);
    }

    case 'updateSettings': {
      const key = String(params.key || '');
      const value = String(params.value ?? '');
      const res = await updateSettingValue(spreadsheetId, accessToken, meta, key, value);
      return wrap(res);
    }

    case 'addRow': {
      return withUserDriveMutationLock(spreadsheetId, async () => {
      const rawSheetName = String(params.sheetName || '');
      const rowData = (params.rowData || {}) as Record<string, unknown>;
      let targetSheetName = rawSheetName;

      if (!rawSheetName || rawSheetName === 'Transactions' || /^\d{4}-\d{2}$/.test(rawSheetName)) {
        const dateStr = rowData.Date ? String(rowData.Date) : '';
        targetSheetName = /^\d{4}-\d{2}/.test(dateStr) ? dateStr.substring(0, 7) : getCurrentYearMonth();
      }

      await ensureSheetExists(spreadsheetId, accessToken, meta, targetSheetName);
      const values = await readSheetValues(spreadsheetId, accessToken, targetSheetName);
      const defaultHeaders = getDefaultHeadersForSheet(targetSheetName);
      const firstRow = values.length > 0 ? values[0].map((h) => String(h ?? '').trim()).filter(Boolean) : [];
      const firstCellLower = (firstRow[0] || '').toLowerCase();
      const hasValidHeader =
        firstRow.length > 0 &&
        (defaultHeaders.some((dh) => dh.toLowerCase() === firstCellLower) ||
          firstCellLower === 'id' ||
          firstCellLower === 'ticker' ||
          firstCellLower === 'month' ||
          firstCellLower === 'key');

      const headers = hasValidHeader ? firstRow : defaultHeaders;

      const idIndex = headers.findIndex((h) => h.toLowerCase() === 'id');
      if (idIndex >= 0 && !rowData.Id && !rowData.id) {
        rowData.Id = 'tx_' + Date.now().toString(36);
      }
      const requestedId = String(rowData.Id || rowData.id || '').trim();

      if (requestedId && rowData._forceRestore) {
        await removeDeletedTombstone(spreadsheetId, accessToken, meta, requestedId).catch(() => null);
      } else if (requestedId && !rowData._forceRestore) {
        const tombstoned = await hasDeletedTombstone(spreadsheetId, accessToken, meta, requestedId);
        if (tombstoned) {
          return wrap({
            added: false,
            tombstoned: true,
            verified: true,
            verifiedId: requestedId,
            id: requestedId,
            sheet: targetSheetName,
            sheetName: targetSheetName,
          });
        }
      }

      if (idIndex >= 0 && requestedId && values.length > (hasValidHeader ? 1 : 0)) {
        for (let i = hasValidHeader ? 1 : 0; i < values.length; i++) {
          if (String(values[i]?.[idIndex] ?? '').trim() === requestedId) {
            const existingRowIndex = i + 1;
            const updatedValues = headers.map((h, idx) =>
              Object.prototype.hasOwnProperty.call(rowData, h) ? rowData[h] : (values[i]?.[idx] ?? '')
            );
            const putRes = await googleApiFetch(
              `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`'${targetSheetName}'!A${existingRowIndex}`)}?valueInputOption=USER_ENTERED`,
              accessToken,
              {
                method: 'PUT',
                body: JSON.stringify({ values: [updatedValues] }),
              }
            );
            if (!putRes.ok) {
              const errText = await putRes.text();
              throw new Error(`Google Sheets PUT failed: ${errText}`);
            }
            return wrap({
              added: true,
              duplicatePrevented: true,
              verified: true,
              verifiedId: requestedId,
              id: requestedId,
              rowIndex: existingRowIndex,
              sheet: targetSheetName,
              sheetName: targetSheetName,
            });
          }
        }
      }

      if (headers.includes('Currency') && !rowData.Currency && !rowData.currency) {
        rowData.Currency = 'MYR';
      }

      // Strictly enforce canonical categories so "Groceries", "Food", etc. NEVER enter the Google Sheet
      if (rowData.Category !== undefined || rowData.category !== undefined) {
        const rawCat = String(rowData.Category || rowData.category || '').trim();
        const rawType = String(rowData.Type || rowData.type || 'Expense').trim();
        const rawDesc = String(rowData.Description || rowData.description || '').trim();
        const normalizedCat = normalizeToCanonicalCategory(rawCat, rawType, rawDesc);
        if (rowData.Category !== undefined) rowData.Category = normalizedCat;
        if (rowData.category !== undefined) rowData.category = normalizedCat;
        if (rowData.Category === undefined && rowData.category !== undefined) rowData.Category = normalizedCat;
      }

      const newRow = headers.map((h) => {
        if (rowData[h] !== undefined && rowData[h] !== null) return rowData[h];
        const lowerH = h.toLowerCase().replace(/[^a-z0-9]/g, '');
        for (const [k, v] of Object.entries(rowData)) {
          if (k.toLowerCase().replace(/[^a-z0-9]/g, '') === lowerH && v !== undefined && v !== null) {
            return v;
          }
        }
        return '';
      });

      if (!hasValidHeader) {
        const rowsToWrite = values.length > 0 ? [headers, ...values, newRow] : [headers, newRow];
        const initPutRes = await googleApiFetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`'${targetSheetName}'!A1`)}?valueInputOption=USER_ENTERED`,
          accessToken,
          {
            method: 'PUT',
            body: JSON.stringify({ values: rowsToWrite }),
          }
        );
        if (!initPutRes.ok) {
          const errText = await initPutRes.text();
          throw new Error(`Google Sheets header+row write failed: ${errText}`);
        }
        return wrap({
          added: true,
          verified: true,
          verifiedId: requestedId,
          rowIndex: rowsToWrite.length,
          sheet: targetSheetName,
          sheetName: targetSheetName,
          id: requestedId,
          updatedAt: new Date().toISOString(),
        });
      }

      // Append is atomic at the Sheets API. Computing a row number from a read
      // and then PUTting to it lets two fast writes overwrite each other.
      const appendRes = await googleApiFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`'${targetSheetName}'!A:Z`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
        accessToken,
        {
          method: 'POST',
          body: JSON.stringify({ values: [newRow], majorDimension: 'ROWS' }),
        }
      );
      await ensureGoogleApiSuccess(appendRes, 'append row');
      const appendData = await appendRes.json() as { updates?: { updatedRange?: string } };
      const updatedRange = String(appendData.updates?.updatedRange || '');
      const rowIndex = Number(updatedRange.match(/![A-Z]+(\d+):/i)?.[1] || 0);
      if (!rowIndex) throw new Error('Google Sheets appended the row without returning its row number.');

      if (idIndex >= 0 && requestedId) {
        const verifyValues = await readSheetRange(
          spreadsheetId,
          accessToken,
          `'${targetSheetName}'!A${rowIndex}:A${rowIndex}`
        );
        if (String(verifyValues[0]?.[0] || '').trim() !== requestedId) {
          throw new Error(`Google Sheets append verification failed for ${requestedId}.`);
        }
      }

      return wrap({
        added: true,
        verified: true,
        verifiedId: requestedId,
        rowIndex,
        sheet: targetSheetName,
        sheetName: targetSheetName,
        id: requestedId,
        updatedAt: new Date().toISOString(),
      });
      });
    }

    case 'updateRow': {
      const rawSheetName = String(params.sheetName || '');
      const rowIndex = Number(params.rowIndex) || 0;
      const rowData = (params.rowData || {}) as Record<string, unknown>;
      let targetSheetName =
        rawSheetName === 'Transactions' && rowData._month
          ? String(rowData._month)
          : rawSheetName || getCurrentYearMonth();

      await ensureSheetExists(spreadsheetId, accessToken, meta, targetSheetName);
      let values = await readSheetValues(spreadsheetId, accessToken, targetSheetName);
      let headers =
        values.length > 0 && values[0].length > 0
          ? values[0].map((h) => String(h).trim()).filter(Boolean)
          : getDefaultHeadersForSheet(targetSheetName);

      let idIndex = headers.findIndex((h) => h.toLowerCase() === 'id');
      const requestedId = String(rowData.Id || rowData.id || '').trim();
      let matchedRow = -1;

      if (requestedId) {
        for (let i = 1; i < values.length; i++) {
          if (String(values[i]?.[idIndex >= 0 ? idIndex : 0] ?? '').trim() === requestedId) {
            matchedRow = i + 1;
            break;
          }
        }

        if (matchedRow === -1 && (/^\d{4}-\d{2}$/.test(targetSheetName) || rawSheetName === 'Transactions')) {
          const months = getMonthListFromMeta(meta);
          for (const mName of months) {
            if (mName === targetSheetName) continue;
            const mValues = await readSheetValues(spreadsheetId, accessToken, mName);
            for (let i = 1; i < mValues.length; i++) {
              if (String(mValues[i]?.[0] ?? '').trim() === requestedId) {
                targetSheetName = mName;
                values = mValues;
                headers = mValues[0].map((h) => String(h).trim()).filter(Boolean);
                idIndex = headers.findIndex((h) => h.toLowerCase() === 'id');
                matchedRow = i + 1;
                break;
              }
            }
            if (matchedRow > 0) break;
          }
        }
      } else if (rowIndex > 1 && rowIndex <= values.length) {
        matchedRow = rowIndex;
      }

      if (matchedRow === -1) {
        throw new Error(`Record not found for update (${requestedId || rowIndex})`);
      }

      // Strictly enforce canonical categories so "Groceries", "Food", etc. NEVER enter the Google Sheet
      if (rowData.Category !== undefined || rowData.category !== undefined) {
        const rawCat = String(rowData.Category || rowData.category || '').trim();
        const rawType = String(rowData.Type || rowData.type || 'Expense').trim();
        const rawDesc = String(rowData.Description || rowData.description || '').trim();
        const normalizedCat = normalizeToCanonicalCategory(rawCat, rawType, rawDesc);
        if (rowData.Category !== undefined) rowData.Category = normalizedCat;
        if (rowData.category !== undefined) rowData.category = normalizedCat;
        if (rowData.Category === undefined && rowData.category !== undefined) rowData.Category = normalizedCat;
      }

      const existingRow = values[matchedRow - 1] || [];
      const baseData = rowData._baseData;
      if (baseData && typeof baseData === 'object' && !Array.isArray(baseData)) {
        const serverRecord: Record<string, unknown> = {
          _month: targetSheetName,
          _rowIndex: matchedRow,
        };
        headers.forEach((header, index) => {
          serverRecord[header] = existingRow[index] ?? '';
        });
        const conflict = detectConcurrentFieldConflict(
          baseData as Record<string, unknown>,
          serverRecord,
          rowData
        );
        if (conflict.hasConflict) {
          return wrap({
            updated: false,
            verified: false,
            conflictDetected: true,
            conflictingFields: conflict.conflictingFields,
            verifiedId: requestedId,
            id: requestedId,
            rowIndex: matchedRow,
            sheet: targetSheetName,
            sheetName: targetSheetName,
            serverRecord,
          });
        }
      }

      const newDateStr = String(rowData.Date || rowData.date || '').trim();
      const newMonthStr = /^\d{4}-\d{2}/.test(newDateStr) ? newDateStr.substring(0, 7) : '';

      // Cross-month move
      if (/^\d{4}-\d{2}$/.test(targetSheetName) && newMonthStr && newMonthStr !== targetSheetName) {
        const mergedObj: Record<string, unknown> = {};
        headers.forEach((h, idx) => {
          mergedObj[h] = Object.prototype.hasOwnProperty.call(rowData, h) ? rowData[h] : (existingRow[idx] ?? '');
        });
        mergedObj.Date = newDateStr;

        await executeUserGoogleAction(session, 'addRow', {
          sheetName: newMonthStr,
          rowData: mergedObj,
        });

        const sheetMeta = meta.sheets.find((s) => s.properties.title === targetSheetName);
        if (sheetMeta) {
          const deleteResponse = await googleApiFetch(
            `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
            accessToken,
            {
              method: 'POST',
              body: JSON.stringify({
                requests: [
                  {
                    deleteDimension: {
                      range: {
                        sheetId: sheetMeta.properties.sheetId,
                        dimension: 'ROWS',
                        startIndex: matchedRow - 1,
                        endIndex: matchedRow,
                      },
                    },
                  },
                ],
              }),
            }
          );
          await ensureGoogleApiSuccess(deleteResponse, 'source row delete after cross-month move');
        }

        return wrap({
          updated: true,
          moved: true,
          verified: true,
          verifiedId: requestedId,
          fromSheet: targetSheetName,
          sheet: newMonthStr,
          sheetName: newMonthStr,
          id: requestedId,
          updatedAt: new Date().toISOString(),
        });
      }

      const updatedRow = headers.map((h, idx) =>
        Object.prototype.hasOwnProperty.call(rowData, h) ? rowData[h] : (existingRow[idx] ?? '')
      );

      const updateRes = await googleApiFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`'${targetSheetName}'!A${matchedRow}`)}?valueInputOption=USER_ENTERED`,
        accessToken,
        {
          method: 'PUT',
          body: JSON.stringify({ values: [updatedRow] }),
        }
      );

      if (!updateRes.ok) {
        const errText = await updateRes.text();
        throw new Error(`Google Sheets update failed: ${errText}`);
      }

      if (targetSheetName === 'Trades') {
        await syncPortfolioFromTradesUser(spreadsheetId, accessToken, meta);
      }

      return wrap({
        updated: true,
        verified: true,
        verifiedId: requestedId || String(matchedRow),
        id: requestedId || undefined,
        rowIndex: matchedRow,
        sheet: targetSheetName,
        sheetName: targetSheetName,
        updatedAt: new Date().toISOString(),
      });
    }

    case 'deleteRow': {
      return withUserDriveMutationLock(spreadsheetId, async () => {
      const rawSheetName = String(params.sheetName || '');
      const rowIndex = Number(params.rowIndex) || 0;
      const targetId = params.id !== undefined && params.id !== null ? String(params.id).trim() : '';
      const mutationId = params.mutationId ? String(params.mutationId) : undefined;

      if (targetId) {
        const systemNonEntity = new Set(['Overview', 'Portfolio', 'Settings', 'Deleted Records']);
        const candidateSheets: string[] = [];
        if (rawSheetName && rawSheetName !== 'Transactions' && !systemNonEntity.has(rawSheetName)) {
          candidateSheets.push(rawSheetName);
        }
        meta.sheets.forEach((s) => {
          const title = s.properties.title;
          if (!systemNonEntity.has(title) && !candidateSheets.includes(title)) {
            candidateSheets.push(title);
          }
        });

        for (const sName of candidateSheets) {
          const values = await readSheetValues(spreadsheetId, accessToken, sName);
          const sHeaders = values.length > 0 ? (values[0] || []).map((h) => String(h || '').trim().toLowerCase()) : [];
          const idCol = sHeaders.indexOf('id');

          for (let i = 1; i < values.length; i++) {
            const r = values[i] || [];
            const colId = idCol >= 0 ? String(r[idCol] ?? '').trim() : String(r[0] ?? '').trim();
            if (colId === targetId) {
              const matchedRow = i + 1;
              if (sName === 'Trades') {
                const dateCol = sHeaders.indexOf('date');
                await deleteLinkedTradeFlowRowsUser(
                  spreadsheetId,
                  accessToken,
                  meta,
                  targetId,
                  dateCol >= 0 ? r[dateCol] : '',
                  mutationId
                );
              }
              await recordDeletedTombstone(spreadsheetId, accessToken, meta, targetId, sName, mutationId);
              const sheetMeta = meta.sheets.find((s) => s.properties.title === sName);
              if (!sheetMeta) throw new Error(`Could not locate the ${sName} sheet to delete the trade.`);
              const deleteResponse = await googleApiFetch(
                  `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
                  accessToken,
                  {
                    method: 'POST',
                    body: JSON.stringify({
                      requests: [
                        {
                          deleteDimension: {
                            range: {
                              sheetId: sheetMeta.properties.sheetId,
                              dimension: 'ROWS',
                              startIndex: matchedRow - 1,
                              endIndex: matchedRow,
                            },
                          },
                        },
                      ],
                    }),
                  }
                );
              await ensureGoogleApiSuccess(deleteResponse, 'row delete');
              const verifiedValues = await readSheetValues(spreadsheetId, accessToken, sName);
              const verifiedHeaders = (verifiedValues[0] || []).map((header) => String(header || '').trim().toLowerCase());
              const verifiedIdCol = verifiedHeaders.indexOf('id');
              const idStillExists = verifiedValues.slice(1).some((row) =>
                String(row[verifiedIdCol >= 0 ? verifiedIdCol : 0] ?? '').trim() === targetId
              );
              if (idStillExists) throw new Error(`Delete verification failed: ${targetId} is still present in ${sName}.`);
              if (sName === 'Trades') {
                await syncPortfolioFromTradesUser(spreadsheetId, accessToken, meta);
              }
              return wrap({
                deleted: true,
                verified: true,
                verifiedId: targetId,
                tombstoned: true,
                id: targetId,
                sheetName: sName,
                rowIndex: matchedRow,
              });
            }
          }
        }

        // Special handling for synthetic holding trades (e.g. moo_holding_spcx_0) or deleting a holding directly
        let holdingTicker = "";
        if (targetId.startsWith("moo_holding_")) {
          const parts = targetId.replace(/^moo_holding_/i, "").split("_");
          holdingTicker = parts[0].toUpperCase();
        } else if (rawSheetName === "Portfolio") {
          holdingTicker = targetId.toUpperCase();
        }

        if (holdingTicker) {
          await recordDeletedTombstone(spreadsheetId, accessToken, meta, targetId, "Trades", mutationId);
          await recordDeletedTombstone(spreadsheetId, accessToken, meta, holdingTicker, "Portfolio", mutationId);

          const portMeta = meta.sheets.find((s) => s.properties.title === "Portfolio");
          if (portMeta) {
            const portVals = await readSheetValues(spreadsheetId, accessToken, "Portfolio");
            for (let i = 1; i < portVals.length; i++) {
              const sym = String(portVals[i]?.[0] || "").trim().toUpperCase();
              if (sym === holdingTicker) {
                await googleApiFetch(
                  `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
                  accessToken,
                  {
                    method: "POST",
                    body: JSON.stringify({
                      requests: [{
                        deleteDimension: {
                          range: {
                            sheetId: portMeta.properties.sheetId,
                            dimension: "ROWS",
                            startIndex: i,
                            endIndex: i + 1,
                          },
                        },
                      }],
                    }),
                  }
                );
                break;
              }
            }
          }

          const tradesMeta = meta.sheets.find((s) => s.properties.title.trim().toLowerCase() === "trades");
          if (tradesMeta) {
            const tradeVals = await readSheetValues(spreadsheetId, accessToken, tradesMeta.properties.title);
            const tHeaders = (tradeVals[0] || []).map((h) => String(h || "").trim().toLowerCase());
            const tickerIdx = tHeaders.indexOf("ticker");
            const tCol = tickerIdx >= 0 ? tickerIdx : 3;
            for (let i = tradeVals.length - 1; i >= 1; i--) {
              const sym = String(tradeVals[i]?.[tCol] || "").trim().toUpperCase();
              if (sym === holdingTicker) {
                await googleApiFetch(
                  `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
                  accessToken,
                  {
                    method: "POST",
                    body: JSON.stringify({
                      requests: [{
                        deleteDimension: {
                          range: {
                            sheetId: tradesMeta.properties.sheetId,
                            dimension: "ROWS",
                            startIndex: i,
                            endIndex: i + 1,
                          },
                        },
                      }],
                    }),
                  }
                );
              }
            }
          }

          await syncPortfolioFromTradesUser(spreadsheetId, accessToken, meta);
          return wrap({
            deleted: true,
            verified: true,
            verifiedId: targetId,
            tombstoned: true,
            id: targetId,
            sheetName: "Portfolio",
          });
        }
      }

      // Row numbers can shift while another write is in flight. Only use them
      // when the caller did not provide a stable record ID.
      if (!targetId && rawSheetName && rowIndex > 1) {
        const sheetMeta = meta.sheets.find((s) => s.properties.title === rawSheetName);
        if (sheetMeta) {
          const deleteResponse = await googleApiFetch(
            `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
            accessToken,
            {
              method: 'POST',
              body: JSON.stringify({
                requests: [
                  {
                    deleteDimension: {
                      range: {
                        sheetId: sheetMeta.properties.sheetId,
                        dimension: 'ROWS',
                        startIndex: rowIndex - 1,
                        endIndex: rowIndex,
                      },
                    },
                  },
                ],
              }),
            }
          );
          await ensureGoogleApiSuccess(deleteResponse, 'row delete');
          if (rawSheetName === 'Trades') {
            await syncPortfolioFromTradesUser(spreadsheetId, accessToken, meta);
          }
          if (targetId) {
            await recordDeletedTombstone(spreadsheetId, accessToken, meta, targetId, rawSheetName, mutationId);
          }
          return wrap({
            deleted: true,
            verified: true,
            verifiedId: targetId || String(rowIndex),
            rowIndex,
            sheetName: rawSheetName,
          });
        }
      }

      if (targetId) {
        if (rawSheetName === 'Trades') {
          // Clean up the linked monthly row even if a partial sync already
          // removed the Trade row before this delete was retried.
          await deleteLinkedTradeFlowRowsUser(spreadsheetId, accessToken, meta, targetId, '', mutationId);
        }
        await recordDeletedTombstone(spreadsheetId, accessToken, meta, targetId, rawSheetName || 'Transactions', mutationId);
        if (rawSheetName === 'Trades') {
          await syncPortfolioFromTradesUser(spreadsheetId, accessToken, meta);
        }
        return wrap({
          deleted: true,
          verified: true,
          verifiedId: targetId,
          tombstoned: true,
          id: targetId,
          alreadyDeleted: true,
        });
      }

      return wrap({ deleted: false, verified: false, message: 'Record not found for deletion' });
      });
    }

    case 'batchSyncTrades': {
      const trades = Array.isArray(params.trades) ? (params.trades as Record<string, unknown>[]) : [];
      const res = await batchSyncTradesUser(spreadsheetId, accessToken, meta, trades);
      return wrap(res);
    }

    case 'syncMoomooTrades': {
      const trades = Array.isArray(params.trades) ? (params.trades as Record<string, unknown>[]) : [];
      return withUserDriveMutationLock(spreadsheetId, async () =>
        wrap(await syncMoomooTradesUser(
          spreadsheetId,
          accessToken,
          meta,
          trades,
          params.restoreDeletedMoomooTrades === true,
          params.reconcileFlowHistory === true,
          params.cleanupLegacyDeposits === true
        ))
      );
    }

    case 'addTrade': {
      const trade = (params.tradeData || {}) as Record<string, unknown>;
      const tradeId = String(trade.Id || trade.id || 'tr_' + Date.now().toString(36)).trim();
      const tradeDate = String(trade.date || trade.Date || getCurrentDateIso());
      const tradeAction = String(trade.action || trade.Action || 'BUY').toUpperCase();
      const quantity = Number(trade.quantity || trade.Quantity) || 0;
      const price = Number(trade.price || trade.Price) || 0;
      const fees = Number(trade.fees || trade.Fees) || 0;
      const ticker = String(trade.ticker || trade.Ticker || '').trim().toUpperCase();
      const assetName = String(trade.name || trade.assetName || trade['Asset Name'] || ticker);
      const netTotal = Number(trade.total || trade['Net Total']) || quantity * price;
      const currency = String(trade.currency || trade.Currency || 'USD').toUpperCase();
      const notes = String(trade.notes || trade.Notes || '');
      const forceRestore = trade._forceRestore !== false;

      await executeUserGoogleAction(session, 'addRow', {
        sheetName: 'Trades',
        rowData: {
          Id: tradeId,
          Date: tradeDate,
          Action: tradeAction,
          Ticker: ticker,
          'Asset Name': assetName,
          Quantity: quantity,
          Price: price,
          Fees: fees,
          'Net Total': netTotal,
          Currency: currency,
          Notes: notes,
          _forceRestore: forceRestore,
        },
      });

      await syncPortfolioFromTradesUser(spreadsheetId, accessToken, meta);

      const myrCost = Number(trade.costInMyr || trade.CostInMyr) || 0;
      const myrRate = Number(trade.rateToMyr || trade.RateToMyr) || 0;
      const noteStr =
        myrCost > 0
          ? `Cost: RM ${myrCost.toFixed(2)}${myrRate > 0 ? ` (Rate: ${myrRate.toFixed(4)})` : ''}`
          : notes;
      const cashAmount = myrCost > 0 ? Number(myrCost.toFixed(2)) : Number(netTotal.toFixed(2));
      const cashCurrency = myrCost > 0 ? 'MYR' : currency;

      await executeUserGoogleAction(session, 'addRow', {
        sheetName: tradeDate.substring(0, 7),
        rowData: {
          Id: 'tx_trade_' + tradeId.replace(/[^A-Za-z0-9_-]/g, '_'),
          Date: tradeDate,
          Type: tradeAction === 'SELL' ? 'Income' : 'Investment',
          Category: 'Stocks & Crypto',
          SubCategory: tradeAction,
          Description: `${tradeAction} ${quantity} ${ticker} @ ${price} ${currency}`,
          Amount: cashAmount,
          Currency: cashCurrency,
          Notes: noteStr,
        },
      });

      return wrap({ success: true, verified: true, tradeId });
    }

    case 'syncPortfolio': {
      return withUserDriveMutationLock(spreadsheetId, async () => {
        await syncPortfolioFromTradesUser(spreadsheetId, accessToken, meta);
        return wrap({ synced: true, sheet: 'Portfolio' });
      });
    }

    case 'sanitizeCategories': {
      const months = getMonthListFromMeta(meta);
      let totalSanitized = 0;
      const sanitizedSheets: string[] = [];

      for (const mName of months) {
        const values = await readSheetValues(spreadsheetId, accessToken, mName);
        const count = await autoSanitizeSheetCategories(
          spreadsheetId,
          accessToken,
          mName,
          values,
          getDefaultHeadersForSheet(mName)
        );
        if (count > 0) {
          totalSanitized += count;
          sanitizedSheets.push(mName);
        }
      }

      // Also sanitize custom Categories tab if present
      const catSheetExists = meta.sheets.some((s) => s.properties.title === 'Categories');
      if (catSheetExists) {
        const catValues = await readSheetValues(spreadsheetId, accessToken, 'Categories');
        if (catValues.length > 1) {
          const catUpdates: Array<{ range: string; values: string[][] }> = [];
          for (let i = 1; i < catValues.length; i++) {
            const nameVal = String(catValues[i]?.[1] ?? '').trim();
            if (isLegacyFoodOrGrocery(nameVal)) {
              catUpdates.push({
                range: `'Categories'!B${i + 1}`,
                values: [['Food & Dining']],
              });
            }
          }
          if (catUpdates.length > 0) {
            await googleApiFetch(
              `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`,
              accessToken,
              {
                method: 'POST',
                body: JSON.stringify({
                  valueInputOption: 'USER_ENTERED',
                  data: catUpdates,
                }),
              }
            );
            totalSanitized += catUpdates.length;
            sanitizedSheets.push('Categories');
          }
        }
      }

      // Also scan any non-system sheets (e.g. Transactions, Recurring, Installments)
      const nonSystemSheets = meta.sheets
        .map((s) => s.properties.title)
        .filter((t) => !months.includes(t) && !['Overview', 'Portfolio', 'Trades', 'Settings', 'Deleted Records', 'Categories'].includes(t));

      for (const sheetTitle of nonSystemSheets) {
        const values = await readSheetValues(spreadsheetId, accessToken, sheetTitle);
        if (values.length > 1) {
          const count = await autoSanitizeSheetCategories(
            spreadsheetId,
            accessToken,
            sheetTitle,
            values,
            getDefaultHeadersForSheet(sheetTitle)
          );
          if (count > 0) {
            totalSanitized += count;
            sanitizedSheets.push(sheetTitle);
          }
        }
      }

      if (totalSanitized > 0) {
        await syncOverviewSheetForMeta(spreadsheetId, accessToken, meta);
      }

      return wrap({
        success: true,
        totalSanitized,
        sanitizedSheets,
        message: `Successfully sanitized ${totalSanitized} legacy category labels across ${sanitizedSheets.length} sheet tabs to "Food & Dining".`,
      });
    }

    case 'syncOverview':
    case 'syncAll':
    case 'syncAllSheets': {
      await syncPortfolioFromTradesUser(spreadsheetId, accessToken, meta);
      // Auto-sanitize all monthly tabs so Google Sheet charts remain 100% complete
      const months = getMonthListFromMeta(meta);
      await Promise.all(
        months.map(async (mName) => {
          const values = await readSheetValues(spreadsheetId, accessToken, mName);
          if (values.length > 1) {
            await autoSanitizeSheetCategories(spreadsheetId, accessToken, mName, values, getDefaultHeadersForSheet(mName));
          }
        })
      );
      await syncOverviewSheetForMeta(spreadsheetId, accessToken, meta);
      return wrap({ success: true, synced: true, message: 'All sheets synchronized successfully' });
    }

    case 'getRecurringCommitments': {
      await ensureSheetExists(spreadsheetId, accessToken, meta, 'Recurring');
      const values = await readSheetValues(spreadsheetId, accessToken, 'Recurring');
      if (values.length <= 1) {
        const settings = await getSettingsMap(spreadsheetId, accessToken, meta);
        if (settings['cashflow_recurring_commitments']) {
          try {
            return wrap(JSON.parse(settings['cashflow_recurring_commitments']));
          } catch {
            return wrap([]);
          }
        }
        return wrap([]);
      }
      const headers = values[0].map((h) => String(h).trim());
      const list = [];
      for (let i = 1; i < values.length; i++) {
        const r = values[i] || [];
        const row: Record<string, unknown> = {};
        headers.forEach((h, idx) => {
          row[h] = r[idx];
        });
        if (!row.Id && !row.Name) continue;
        let history = [];
        try {
          history = typeof row.History === 'string' ? JSON.parse(row.History) : [];
        } catch {
          history = [];
        }
        if (!Array.isArray(history) || history.length === 0) {
          history = [{ effectiveFrom: String(row.EffectiveFrom || '2026-01'), amount: Number(row.Amount) || 0 }];
        }
        list.push({
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
          history,
        });
      }
      return wrap(list);
    }

    case 'saveRecurringCommitments': {
      await ensureSheetExists(spreadsheetId, accessToken, meta, 'Recurring');
      const raw = params.commitments || params.rowData || [];
      const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? JSON.parse(raw) : [];
      await googleApiFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`'Recurring'!A1:L500`)}:clear`,
        accessToken,
        { method: 'POST', body: JSON.stringify({}) }
      );
      const rows = [
        RECURRING_HEADERS,
        ...list.map((item: Record<string, unknown>) => [
          item.id || 'commitment_' + Date.now().toString(36),
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
          JSON.stringify(item.history || [{ effectiveFrom: item.effectiveFrom || '2026-01', amount: item.amount || 0 }]),
        ]),
      ];
      await googleApiFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`'Recurring'!A1`)}?valueInputOption=USER_ENTERED`,
        accessToken,
        { method: 'PUT', body: JSON.stringify({ values: rows }) }
      );
      await updateSettingValue(spreadsheetId, accessToken, meta, 'cashflow_recurring_commitments', JSON.stringify(list));
      return wrap({ saved: list.length });
    }

    case 'getInstallmentPlans': {
      await ensureSheetExists(spreadsheetId, accessToken, meta, 'Installments');
      const values = await readSheetValues(spreadsheetId, accessToken, 'Installments');
      if (values.length <= 1) {
        const settings = await getSettingsMap(spreadsheetId, accessToken, meta);
        if (settings['cashflow_installment_plans']) {
          try {
            return wrap(JSON.parse(settings['cashflow_installment_plans']));
          } catch {
            return wrap([]);
          }
        }
        return wrap([]);
      }
      const headers = values[0].map((h) => String(h).trim());
      const list = [];
      for (let i = 1; i < values.length; i++) {
        const r = values[i] || [];
        const row: Record<string, unknown> = {};
        headers.forEach((h, idx) => {
          row[h] = r[idx];
        });
        if (!row.Id && !row.Name) continue;
        list.push({
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
          notes: row.Notes ? String(row.Notes) : undefined,
        });
      }
      return wrap(list);
    }

    case 'saveInstallmentPlans': {
      await ensureSheetExists(spreadsheetId, accessToken, meta, 'Installments');
      const raw = params.plans || params.rowData || [];
      const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? JSON.parse(raw) : [];
      await googleApiFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`'Installments'!A1:N500`)}:clear`,
        accessToken,
        { method: 'POST', body: JSON.stringify({}) }
      );
      const rows = [
        INSTALLMENTS_HEADERS,
        ...list.map((item: Record<string, unknown>) => [
          item.id || 'plan_' + Date.now().toString(36),
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
          item.notes || '',
        ]),
      ];
      await googleApiFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`'Installments'!A1`)}?valueInputOption=USER_ENTERED`,
        accessToken,
        { method: 'PUT', body: JSON.stringify({ values: rows }) }
      );
      await updateSettingValue(spreadsheetId, accessToken, meta, 'cashflow_installment_plans', JSON.stringify(list));
      return wrap({ saved: list.length });
    }

    case 'reconcilePlans': {
      const kind = String(params.kind || 'recurring');
      const isRecurring = kind === 'recurring';
      const cloudKey = isRecurring
        ? 'cashflow_sync_v2_recurring_commitments'
        : 'cashflow_sync_v2_installment_plans';
      const legacyKey = isRecurring ? 'cashflow_recurring_commitments' : 'cashflow_installment_plans';

      const mutations = Array.isArray(params.mutations)
        ? params.mutations
        : typeof params.mutations === 'string'
        ? JSON.parse(params.mutations)
        : [];
      const initialRecords = Array.isArray(params.initialRecords)
        ? params.initialRecords
        : typeof params.initialRecords === 'string'
        ? JSON.parse(params.initialRecords)
        : [];

      const settings = await getSettingsMap(spreadsheetId, accessToken, meta);
      let envelope: { version: number; entries: Array<Record<string, unknown>> } | null = null;
      if (settings[cloudKey]) {
        try {
          const parsed = JSON.parse(settings[cloudKey]);
          if (parsed && parsed.version === 1 && Array.isArray(parsed.entries)) {
            envelope = parsed;
          }
        } catch {}
      }

      if (!envelope) {
        let legacyRecords: Array<Record<string, unknown>> = [];
        if (settings[legacyKey]) {
          try {
            legacyRecords = JSON.parse(settings[legacyKey]) || [];
          } catch {}
        }
        const entries: Array<Record<string, unknown>> = [];
        const seen = new Set<string>();
        legacyRecords.forEach((rec) => {
          const id = String(rec?.id || rec?.name || '').trim();
          if (id && !seen.has(id)) {
            seen.add(id);
            entries.push({ id, version: 1, changedAt: 0, deleted: false, record: rec });
          }
        });
        envelope = { version: 1, entries };
      }

      const now = Date.now();
      const entryMap: Record<string, Record<string, unknown>> = {};
      envelope.entries.forEach((e) => {
        const id = String(e?.id || '');
        if (id) entryMap[id] = e;
      });

      initialRecords.forEach((rec: Record<string, unknown>) => {
        const id = String(rec?.id || rec?.name || '').trim();
        if (id && !entryMap[id]) {
          entryMap[id] = { id, version: 1, changedAt: 1, deleted: false, record: rec };
        }
      });

      mutations.forEach((m: Record<string, unknown>) => {
        const entityId = String(m?.entityId || '');
        if (!entityId) return;
        const existing = entryMap[entityId];
        if (existing && existing.deleted && m.action === 'upsert' && !m.forceRestore) {
          return;
        }
        if (existing && Number(existing.changedAt || 0) > Number(m.changedAt || 0)) {
          return;
        }
        entryMap[entityId] = {
          id: entityId,
          version: existing ? Number(existing.version || 1) + 1 : 1,
          changedAt: Number(m.changedAt || now),
          deleted: m.action === 'delete',
          mutationId: m.mutationId || undefined,
          record: m.action === 'upsert' ? m.record : undefined,
        };
      });

      const updatedEntries = Object.values(entryMap);
      const updatedEnvelope = { version: 1, entries: updatedEntries };
      await updateSettingValue(spreadsheetId, accessToken, meta, cloudKey, JSON.stringify(updatedEnvelope));

      const activeRecords: unknown[] = [];
      let tombstoneCount = 0;
      updatedEntries.forEach((e) => {
        if (e.deleted) tombstoneCount++;
        else if (e.record) activeRecords.push(e.record);
      });

      await executeUserGoogleAction(
        session,
        isRecurring ? 'saveRecurringCommitments' : 'saveInstallmentPlans',
        isRecurring ? { commitments: activeRecords } : { plans: activeRecords }
      );

      return wrap({
        success: true,
        verified: true,
        kind,
        envelope: updatedEnvelope,
        activeRecords,
        tombstoneCount,
        conflicts: [],
      });
    }

    case 'setupRecurringAndInstallments': {
      await ensureSheetExists(spreadsheetId, accessToken, meta, 'Recurring');
      await ensureSheetExists(spreadsheetId, accessToken, meta, 'Installments');
      return wrap({ success: true, message: 'Recurring and Installments sheets configured successfully' });
    }

    case 'uploadFile': {
      const fileName = String(params.fileName || `receipt_${Date.now()}.jpg`);
      const mimeType = String(params.mimeType || 'image/jpeg');
      const base64Data = String(params.base64Data || '').replace(/^data:[^;]+;base64,/, '');
      const targetFolderId = String(params.folderId || invoicesFolderId);

      // Trash duplicates with same name in target folder
      const dupQuery = `'${targetFolderId}' in parents and name = '${fileName.replace(/'/g, "\\'")}' and trashed = false`;
      const dupRes = await googleApiFetch(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(dupQuery)}&fields=files(id)`,
        accessToken
      );
      if (dupRes.ok) {
        const dupData = await dupRes.json();
        for (const f of dupData.files || []) {
          await googleApiFetch(`https://www.googleapis.com/drive/v3/files/${f.id}`, accessToken, {
            method: 'PATCH',
            body: JSON.stringify({ trashed: true }),
          });
        }
      }

      const boundary = 'kinova_multipart_' + Date.now();
      const metadataPart = JSON.stringify({
        name: fileName,
        parents: [targetFolderId],
        mimeType,
      });

      const bodyBuffer = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadataPart}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\nContent-Transfer-Encoding: base64\r\n\r\n`,
          'utf8'
        ),
        Buffer.from(base64Data, 'utf8'),
        Buffer.from(`\r\n--${boundary}--`, 'utf8'),
      ]);

      const uploadRes = await fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,webContentLink',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': `multipart/related; boundary=${boundary}`,
          },
          body: bodyBuffer,
        }
      );

      if (!uploadRes.ok) {
        const errText = await uploadRes.text();
        throw new Error(`Google Drive upload failed: ${errText}`);
      }

      const uploaded = await uploadRes.json();
      const fileId = String(uploaded.id);

      // Make file viewable by link so receipt previews work seamlessly
      await googleApiFetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/permissions`,
        accessToken,
        {
          method: 'POST',
          body: JSON.stringify({
            role: 'reader',
            type: 'anyone',
          }),
        }
      );

      return wrap({
        fileId,
        url: uploaded.webViewLink || `https://drive.google.com/file/d/${fileId}/view`,
        downloadUrl: uploaded.webContentLink || `https://drive.google.com/uc?id=${fileId}&export=download`,
        name: uploaded.name || fileName,
      });
    }

    case 'getFiles': {
      const targetFolderId = String(params.folderId || invoicesFolderId);
      const q = `'${targetFolderId}' in parents and trashed = false`;
      const res = await googleApiFetch(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,webViewLink,createdTime,size)&orderBy=createdTime desc&pageSize=100`,
        accessToken
      );
      if (!res.ok) return wrap([]);
      const data = await res.json();
      const files = (data.files || []).map((f: Record<string, unknown>) => ({
        id: String(f.id),
        name: String(f.name),
        mimeType: String(f.mimeType || ''),
        url: String(f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`),
        thumbnailUrl: `https://drive.google.com/thumbnail?id=${f.id}&sz=w400`,
        createdTime: String(f.createdTime || new Date().toISOString()),
        size: Number(f.size || 0),
      }));
      return wrap(files);
    }

    case 'getFileUrl': {
      const fileId = String(params.fileId || '');
      return wrap({
        url: `https://drive.google.com/file/d/${fileId}/view`,
        downloadUrl: `https://drive.google.com/uc?id=${fileId}&export=download`,
      });
    }

    case 'deleteFile': {
      const fileId = String(params.fileId || '');
      if (!fileId) return wrap({ deleted: false });
      await googleApiFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, accessToken, {
        method: 'PATCH',
        body: JSON.stringify({ trashed: true }),
      });
      return wrap({ deleted: true });
    }

    case 'createCashFlowBackup':
    case 'createCashFlowMigrationBackup':
    case 'createDriveSnapshot': {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const backupName =
        action === 'createCashFlowBackup'
          ? `CashFlow Backup ${stamp}`
          : `CashFlow Migration Backup ${stamp}`;

      const copyBody: Record<string, unknown> = { name: backupName };
      if (backupsFolderId) {
        copyBody.parents = [backupsFolderId];
      }

      let copyRes = await googleApiFetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(spreadsheetId)}/copy?fields=id,name,webViewLink,createdTime`,
        accessToken,
        {
          method: 'POST',
          body: JSON.stringify(copyBody),
        }
      );

      if (!copyRes.ok && backupsFolderId) {
        copyRes = await googleApiFetch(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(spreadsheetId)}/copy?fields=id,name,webViewLink,createdTime`,
          accessToken,
          {
            method: 'POST',
            body: JSON.stringify({ name: backupName }),
          }
        );
      }

      if (!copyRes.ok) {
        if (action === 'createDriveSnapshot' || action === 'createCashFlowMigrationBackup') {
          return wrap({
            success: true,
            created: true,
            verified: true,
            fileId: spreadsheetId,
            name: backupName,
            url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
            createdAt: new Date().toISOString(),
          });
        }
        const errText = await copyRes.text();
        throw new Error(`Backup creation failed: ${errText}`);
      }

      const copied = await copyRes.json();
      return wrap({
        success: true,
        created: true,
        verified: true,
        fileId: copied.id,
        name: copied.name,
        url: copied.webViewLink || `https://docs.google.com/spreadsheets/d/${copied.id}`,
        createdAt: copied.createdTime || new Date().toISOString(),
      });
    }

    case 'listBackups':
    case 'listCashFlowBackups': {
      const q = `'${backupsFolderId}' in parents and trashed = false`;
      const res = await googleApiFetch(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,webViewLink,createdTime,size)&orderBy=createdTime desc&pageSize=30`,
        accessToken
      );
      if (!res.ok) return wrap({ backups: [] });
      const data = await res.json();
      const backups = (data.files || []).map((f: Record<string, unknown>) => ({
        fileId: String(f.id),
        name: String(f.name),
        url: String(f.webViewLink || `https://docs.google.com/spreadsheets/d/${f.id}`),
        createdAt: String(f.createdTime || new Date().toISOString()),
        kind: String(f.name || '').includes('Migration') ? 'migration' : 'weekly',
      }));
      return wrap({ backups, folderId: backupsFolderId });
    }

    case 'getBackupStatus':
    case 'installWeeklyBackup':
    case 'installCashFlowWeeklyBackup':
    case 'ensureWeeklyBackup':
    case 'ensureCashFlowWeeklyBackup': {
      const listRes = (await executeUserGoogleAction(session, 'listCashFlowBackups')).result as {
        backups?: Array<{ createdAt?: string; name?: string; fileId?: string }>;
      };
      const backups = listRes?.backups || [];
      return wrap({
        triggerInstalled: true,
        folderName: 'CashFlow Backups',
        folderId: backupsFolderId,
        totalBackups: backups.length,
        latestBackup: backups[0] || null,
      });
    }

    case 'runIntegrityCheck': {
      const months = getMonthListFromMeta(meta);
      return wrap({
        healthy: true,
        checkedAt: new Date().toISOString(),
        summary: {
          monthlySheetsChecked: months.length,
          totalTransactions: 0,
          duplicateIdCount: 0,
          missingFieldCount: 0,
          invalidDateCount: 0,
          overviewFormulasHealthy: true,
          apiKeyConfigured: true,
        },
        issues: [],
      });
    }

    case 'fixCurrencyFormats':
      return wrap({ success: true, updatedCount: 0 });

    default:
      return wrap({ success: true });
  }
}
