import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getMoomooConfig, callMoomooApi, type MoomooConfig } from '@/lib/moomoo-client';
import { getValidGoogleSession, setSessionCookie, type GoogleUserSession } from '@/lib/google-auth';
import { executeUserGoogleAction } from '@/lib/google-sheets-user-engine';
import { fetchAdminAppsScript, getAdminAppsScriptEndpoint } from '@/lib/admin-registry';
import {
  findMoomooOrderTradeIndex,
  calculateMoomooNetTotal,
  getMoomooSyncStartMs,
  MOOMOO_SYNC_STATE_KEY,
  normalizeMoomooOrder,
  parseMoomooDate,
  parseMoomooSyncState,
  type MoomooSyncState,
} from '@/lib/moomoo-sync';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Moomoo's response envelopes differ across endpoints; each field is validated before use.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonRecord = Record<string, any>;

function unwrapData(value: unknown): JsonRecord {
  let current = value as JsonRecord;
  if (current?.data && typeof current.data === 'object') current = current.data;
  if (current?.d && typeof current.d === 'object') current = current.d;
  return current || {};
}

function getString(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim();
}

function parseAmount(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const amount = Number(String(value).replace(/[,$\s]/g, ''));
  return Number.isFinite(amount) ? amount : null;
}

function toMicroseconds(milliseconds: number): number {
  return Math.floor(milliseconds * 1000);
}

function recordsFromPage(data: JsonRecord, keys: string[]): JsonRecord[] {
  for (const key of keys) {
    if (Array.isArray(data[key])) return data[key];
  }
  if (Array.isArray(data.d)) return data.d;
  return [];
}

async function fetchAllPages(
  accountId: string,
  endpoint: string,
  params: Record<string, string | number>,
  recordKeys: string[],
  pageSize: number,
  config: MoomooConfig
): Promise<JsonRecord[]> {
  const records: JsonRecord[] = [];
  const seenFlags = new Set<string>();
  let pageFlag = '';

  for (let page = 0; page < 500; page++) {
    const query: Record<string, string | number> = { ...params, page_size: pageSize };
    if (pageFlag) query.page_flag = pageFlag;
    const result = await callMoomooApi<JsonRecord>(endpoint, { method: 'GET', params: query, config });
    if (!result.success) throw new Error(`Moomoo ${endpoint} failed for account ${accountId}: ${result.error || 'API request failed'}`);

    const data = unwrapData(result.data);
    const currentRecords = recordsFromPage(data, recordKeys);
    records.push(...currentRecords);

    const nextFlag = getString(data.page_flag || data.pagination?.page_flag || (result.data as JsonRecord)?.page_flag);
    const completed = data.completed === true || data.pagination?.completed === true || (result.data as JsonRecord)?.completed === true;
    if (completed || !nextFlag) return records;
    if (seenFlags.has(nextFlag)) {
      throw new Error(`Moomoo ${endpoint} returned a repeated page cursor for account ${accountId}.`);
    }
    seenFlags.add(nextFlag);
    pageFlag = nextFlag;
  }

  throw new Error(`Moomoo ${endpoint} exceeded the safe pagination limit for account ${accountId}.`);
}

async function getExistingTrades(session: GoogleUserSession): Promise<Array<Record<string, unknown>>> {
  if (session.isAdmin && getAdminAppsScriptEndpoint()) {
    const response = await fetchAdminAppsScript('GET', 'getTrades') as JsonRecord | null;
    if (!response?.success) throw new Error(response?.message || 'Could not read the Trades sheet.');
    const data = response.data?.data || response.data;
    const rows = data?.rows || (Array.isArray(data) ? data : null);
    if (!Array.isArray(rows)) throw new Error('The Trades sheet returned an invalid response.');
    return rows;
  }

  const { result } = await executeUserGoogleAction(session, 'getTrades', {});
  const data = result as JsonRecord;
  const rows = data?.rows || (Array.isArray(data) ? data : null);
  if (!Array.isArray(rows)) throw new Error('The Trades sheet returned an invalid response.');
  return rows;
}

async function syncTradesToLedger(
  session: GoogleUserSession,
  trades: Array<Record<string, unknown>>,
  fullSync: boolean
): Promise<{ added: number; updated: number; rows?: Array<Record<string, unknown>>; changes: Array<Record<string, unknown>>; removedIds: string[] }> {
  const action = fullSync ? 'batchSyncTrades' : 'syncMoomooTrades';
  if (session.isAdmin && getAdminAppsScriptEndpoint()) {
    const response = await fetchAdminAppsScript('POST', action, { trades }) as JsonRecord | null;
    if (!response?.success) throw new Error(response?.message || 'Could not write Moomoo trades to Google Sheets.');
    const data = response.data?.result || response.data;
    if (!data || (fullSync && !Array.isArray(data.rows))) throw new Error('Google Sheets did not confirm the Moomoo trade write.');
    return {
      added: Number(data.added) || 0,
      updated: Number(data.updated) || 0,
      rows: Array.isArray(data.rows) ? data.rows : undefined,
      changes: Array.isArray(data.changes) ? data.changes : trades,
      removedIds: Array.isArray(data.removedIds) ? data.removedIds.map(String) : [],
    };
  }

  const { result } = await executeUserGoogleAction(session, action, { trades });
  const data = result as JsonRecord;
  if (!data || (fullSync && !Array.isArray(data.rows))) throw new Error('Google Sheets did not confirm the Moomoo trade write.');
  return {
    added: Number(data.added) || 0,
    updated: Number(data.updated) || 0,
    rows: Array.isArray(data.rows) ? data.rows : undefined,
    changes: Array.isArray(data.changes) ? data.changes : trades,
    removedIds: Array.isArray(data.removedIds) ? data.removedIds.map(String) : [],
  };
}

async function getSettings(session: GoogleUserSession): Promise<Record<string, unknown>> {
  if (session.isAdmin && getAdminAppsScriptEndpoint()) {
    const response = await fetchAdminAppsScript('GET', 'getSettings') as JsonRecord | null;
    if (!response?.success) throw new Error(response?.message || 'Could not read sync status from Google Sheets.');
    const data = response.data?.data || response.data;
    return data && typeof data === 'object' ? data : {};
  }
  const { result } = await executeUserGoogleAction(session, 'getSettings', {});
  return result && typeof result === 'object' ? result as Record<string, unknown> : {};
}

async function saveSyncState(session: GoogleUserSession, state: MoomooSyncState): Promise<void> {
  const value = JSON.stringify(state);
  if (session.isAdmin && getAdminAppsScriptEndpoint()) {
    const response = await fetchAdminAppsScript('POST', 'updateSettings', {
      key: MOOMOO_SYNC_STATE_KEY,
      value,
    }) as JsonRecord | null;
    if (!response?.success) throw new Error(response?.message || 'Could not save Moomoo sync status to Google Sheets.');
    return;
  }
  await executeUserGoogleAction(session, 'updateSettings', { key: MOOMOO_SYNC_STATE_KEY, value });
}

async function readMoomooFee(
  accountId: string,
  orderId: string,
  config: MoomooConfig
): Promise<{ totalFee: number; currency: string; items: Array<{ type: string; amount: number }> } | null> {
  const result = await callMoomooApi<JsonRecord>(
    `/api/v1.0/accounts/${encodeURIComponent(accountId)}/orders/${encodeURIComponent(orderId)}/fees`,
    { method: 'GET', config }
  );
  if (!result.success) return null;
  const data = unwrapData(result.data);
  const entries = Array.isArray(data.fees) ? data.fees : [];
  const items = entries
    .map((fee: JsonRecord) => ({ type: getString(fee.type || fee.name), amount: parseAmount(fee.amount) }))
    .filter((fee: { type: string; amount: number | null }): fee is { type: string; amount: number } => Boolean(fee.type) && fee.amount !== null);
  const total = parseAmount(data.total_fee ?? data.totalFee);
  if (total === null && items.length === 0) return null;
  return {
    totalFee: Math.abs(total ?? items.reduce((sum: number, fee: { amount: number }) => sum + fee.amount, 0)),
    currency: getString(data.currency),
    items,
  };
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function cashLogFeeByOrderId(logs: JsonRecord[]): Map<string, number> {
  const fees = new Map<string, number>();
  for (const log of logs) {
    const name = getString(log.transaction_name || log.transaction_type);
    if (!/fee|commission|charge|佣金|费用|收费/i.test(name)) continue;
    const orderId = getString(log.order_id || log.orderId);
    const amount = parseAmount(log.cash_change);
    if (!orderId || amount === null) continue;
    fees.set(orderId, (fees.get(orderId) || 0) + Math.abs(amount));
  }
  return fees;
}

async function getMonthRows(session: GoogleUserSession, month: string): Promise<Array<Record<string, unknown>>> {
  if (session.isAdmin && getAdminAppsScriptEndpoint()) {
    const response = await fetchAdminAppsScript('GET', 'getSheetDataIfExists', { sheetName: month }) as JsonRecord | null;
    if (!response?.success) throw new Error(`Could not read ${month} from Google Sheets.`);
    const data = response.data?.data || response.data;
    return Array.isArray(data?.rows) ? data.rows : [];
  }
  const { result } = await executeUserGoogleAction(session, 'getSheetDataIfExists', { sheetName: month });
  const data = result as JsonRecord;
  if (!Array.isArray(data?.rows)) throw new Error(`Could not read ${month} from Google Sheets.`);
  return data.rows;
}

async function addDepositRow(session: GoogleUserSession, month: string, rowData: Record<string, unknown>): Promise<void> {
  if (session.isAdmin && getAdminAppsScriptEndpoint()) {
    const response = await fetchAdminAppsScript('POST', 'addRow', { sheetName: month, rowData }) as JsonRecord | null;
    if (!response?.success) throw new Error('Could not write a Moomoo deposit to Google Sheets.');
    return;
  }
  await executeUserGoogleAction(session, 'addRow', { sheetName: month, rowData });
}

async function getPortfolioRows(session: GoogleUserSession): Promise<Array<Record<string, unknown>>> {
  if (session.isAdmin && getAdminAppsScriptEndpoint()) {
    const response = await fetchAdminAppsScript('GET', 'getPortfolio') as JsonRecord | null;
    if (!response?.success) throw new Error('Could not read the Portfolio sheet after syncing.');
    const data = response.data?.data || response.data;
    return Array.isArray(data?.rows) ? data.rows : Array.isArray(data) ? data : [];
  }
  const { result } = await executeUserGoogleAction(session, 'getPortfolio', {});
  return Array.isArray(result) ? result as Array<Record<string, unknown>> : [];
}

function getSyncTimestamp(settings: Record<string, unknown>): string | null {
  const state = parseMoomooSyncState(settings[MOOMOO_SYNC_STATE_KEY]);
  if (!state) return null;
  const accountTimes = Object.values(state.accountLastSyncAt).filter((timestamp) => Number.isFinite(Date.parse(timestamp)));
  return accountTimes.sort((a, b) => Date.parse(b) - Date.parse(a))[0] || state.lastSyncAt || null;
}

export async function GET(req: NextRequest) {
  try {
    const { session, refreshed } = await getValidGoogleSession(req);
    if (!session) return NextResponse.json({ success: false, error: 'Unauthorized.' }, { status: 401 });
    const settings = await getSettings(session);
    const response = NextResponse.json({
      success: true,
      configured: Boolean(getMoomooConfig()),
      lastSyncAt: getSyncTimestamp(settings),
    });
    if (refreshed) setSessionCookie(response, session);
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not read Moomoo sync status.';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { session, refreshed } = await getValidGoogleSession(req);
    if (!session) {
      return NextResponse.json({ success: false, error: 'Unauthorized. Please log in to your account first.' }, { status: 401 });
    }

    const config = getMoomooConfig();
    if (!config) {
      return NextResponse.json({
        success: false,
        error: 'Moomoo API credentials are not configured. Please add MOOMOO_API_KEY and MOOMOO_SECRET_KEY.',
      }, { status: 400 });
    }

    const settings = await getSettings(session);
    const oldState = parseMoomooSyncState(settings[MOOMOO_SYNC_STATE_KEY]);

    const accountsResult = await callMoomooApi<JsonRecord>('/api/v1.0/accounts/authorized_trd_accs', { method: 'GET', config });
    if (!accountsResult.success) throw new Error(accountsResult.error || 'Could not read authorized Moomoo accounts.');
    const accountData = unwrapData(accountsResult.data);
    const authorizedAccounts = recordsFromPage(accountData, ['accounts', 'list']);
    if (authorizedAccounts.length === 0) throw new Error('No authorized Moomoo trading accounts were returned.');

    const configuredAccountId = getString(config.accountId);
    const selectedAccounts = configuredAccountId
      ? authorizedAccounts.filter((account) => getString(account.account_id || account.acc_id) === configuredAccountId)
      : authorizedAccounts;
    if (selectedAccounts.length === 0) {
      throw new Error(`Configured Moomoo account ${configuredAccountId} is not authorized for this API key.`);
    }

    const accountPayloads = await Promise.all(selectedAccounts.map(async (account) => {
      const accountId = getString(account.account_id || account.acc_id);
      if (!accountId) return null;
      const previousAccountSyncAt = oldState?.accountLastSyncAt[accountId];
      const beginMs = getMoomooSyncStartMs(previousAccountSyncAt);
      const endMs = Date.now() + 24 * 60 * 60 * 1000;
      const timeParams = {
        begin_time: toMicroseconds(beginMs),
        end_time: toMicroseconds(endMs),
      };

      const [orders, cashLogs, positions] = await Promise.all([
        fetchAllPages(accountId, `/api/v1.0/accounts/${encodeURIComponent(accountId)}/orders_history`, timeParams, ['orders', 'list'], 100, config),
        fetchAllPages(accountId, `/api/v1.0/accounts/${encodeURIComponent(accountId)}/cash_logs`, timeParams, ['cash_logs', 'list'], 20, config),
        (async () => {
          const result = await callMoomooApi<JsonRecord>(`/api/v1.0/accounts/${encodeURIComponent(accountId)}/positions`, { method: 'GET', config });
          if (!result.success) throw new Error(`Moomoo positions failed for account ${accountId}: ${result.error || 'API request failed'}`);
          return recordsFromPage(unwrapData(result.data), ['positions', 'position_list', 'list']);
        })(),
      ]);
      return { accountId, currency: getString(account.currency), orders, cashLogs, positions, previousAccountSyncAt };
    }));

    const accounts = accountPayloads.filter((account): account is NonNullable<typeof account> => Boolean(account));
    const fullSync = accounts.some((account) => !account.previousAccountSyncAt);
    const rawExistingRows = fullSync ? await getExistingTrades(session) : [];
    const existingRows = [...rawExistingRows];
    const feeLookupCount = { failed: 0 };
    const tradeCandidates: Array<{ accountId: string; orderId: string; order: JsonRecord; existingIndex: number }> = [];
    const seenOrders = new Set<string>();
    for (const account of accounts) {
      for (const order of account.orders) {
        const orderId = getString(order.order_id || order.orderId);
        if (!orderId) continue;
        const uniqueKey = `${account.accountId}:${orderId}`;
        if (seenOrders.has(uniqueKey)) continue;
        seenOrders.add(uniqueKey);
        const quantity = parseAmount(order.dealt_qty ?? order.dealtQty ?? order.filled_qty ?? order.filledQty) || 0;
        if (quantity <= 0) continue;
        const existingIndex = findMoomooOrderTradeIndex(existingRows, account.accountId, orderId);
        tradeCandidates.push({ accountId: account.accountId, orderId, order, existingIndex });
      }
    }

    const feeByOrderId = new Map<string, number>();
    for (const account of accounts) {
      for (const [orderId, amount] of cashLogFeeByOrderId(account.cashLogs)) {
        feeByOrderId.set(`${account.accountId}:${orderId}`, amount);
      }
    }

    const normalizedTrades = await mapWithConcurrency(tradeCandidates, 6, async ({ accountId, orderId, order, existingIndex }) => {
      const existing = existingIndex >= 0 ? existingRows[existingIndex] : null;
      const existingNotes = getString(existing?.Notes || existing?.notes);
      const hasPreviouslyItemizedFees = existingNotes.includes('Fee breakdown:');
      const feeInfo = hasPreviouslyItemizedFees
        ? { totalFee: existing?.Fees ?? existing?.fees ?? 0, currency: existing?.Currency || existing?.currency, items: [] }
        : await readMoomooFee(accountId, orderId, config).catch(() => null);

      const trade = normalizeMoomooOrder(order, accountId, feeInfo || undefined);
      if (!trade) return null;

      if (!feeInfo && !hasPreviouslyItemizedFees) {
        const exactCashFee = feeByOrderId.get(`${accountId}:${orderId}`);
        if (exactCashFee !== undefined) {
          trade.Fees = exactCashFee;
          trade['Net Total'] = calculateMoomooNetTotal(String(trade.Action), Number(trade.Quantity), Number(trade.Price), exactCashFee);
        } else if (parseAmount(order.dealt_fee ?? order.fee ?? order.fees ?? order.total_fee ?? order.commission) === null) {
          feeLookupCount.failed++;
          trade.Notes = `${trade.Notes}; Fee details unavailable`;
        }
      }
      if (existing && hasPreviouslyItemizedFees) trade.Notes = existingNotes;
      return trade;
    });

    const tradesToSync = normalizedTrades.filter((trade): trade is Record<string, unknown> => Boolean(trade));
    const ledgerResult = tradesToSync.length > 0
      ? await syncTradesToLedger(session, tradesToSync, fullSync)
      : { added: 0, updated: 0, rows: rawExistingRows, changes: [], removedIds: [] };

    const monthCache = new Map<string, Array<Record<string, unknown>>>();
    let syncedDeposits = 0;
    let skippedDeposits = 0;
    for (const account of accounts) {
      for (const log of account.cashLogs) {
        if (!/bank transfer deposits?/i.test(getString(log.transaction_name || log.transaction_type))) continue;
        const date = parseMoomooDate(log.created_time || log.create_time || log.time);
        const amount = parseAmount(log.cash_change);
        if (!date || amount === null || amount <= 0) continue;
        const month = date.substring(0, 7);
        if (!monthCache.has(month)) monthCache.set(month, await getMonthRows(session, month));
        const rows = monthCache.get(month)!;
        const sourceId = getString(log.log_id || log.cash_log_id || log.transaction_id || log.id);
        const fallbackKey = `${account.accountId}|${date}|${amount.toFixed(2)}|${getString(log.currency).toUpperCase()}|${getString(log.transaction_name)}`;
        const digest = createHash('sha256').update(sourceId || fallbackKey).digest('hex').slice(0, 18);
        const depositId = `moo_dep_${account.accountId}_${digest}`;
        const alreadyLogged = rows.some((row) => {
          if (getString(row.Id || row.id) === depositId) return true;
          const description = getString(row.Description || row.description).toLowerCase();
          const rowDate = parseMoomooDate(row.Date || row.date);
          const rowAmount = Math.abs(parseAmount(row.Amount || row.amount) || 0);
          return (description.includes('moomoo') || description.includes('deposit')) && rowDate === date && Math.abs(rowAmount - amount) < 0.01;
        });
        if (alreadyLogged) {
          skippedDeposits++;
          continue;
        }

        const rowData = {
          Id: depositId,
          Date: date,
          Type: 'Income',
          Category: 'Investment Deposit',
          SubCategory: 'Moomoo Deposit',
          Description: 'Moomoo Bank Transfer Deposit',
          Amount: amount,
          Currency: getString(log.currency || account.currency || 'MYR').toUpperCase(),
          Notes: `Auto-synced from Moomoo Cloud API (Account: ${account.accountId})`,
        };
        await addDepositRow(session, month, rowData);
        rows.push(rowData);
        syncedDeposits++;
      }
    }

    const [freshTrades, freshPortfolio] = await Promise.all([
      fullSync ? getExistingTrades(session) : Promise.resolve(undefined),
      getPortfolioRows(session),
    ]);

    const completedAt = new Date().toISOString();
    const accountLastSyncAt = { ...(oldState?.accountLastSyncAt || {}) };
    for (const account of accounts) accountLastSyncAt[account.accountId] = completedAt;
    const newState: MoomooSyncState = {
      version: 1,
      lastSyncAt: completedAt,
      accountLastSyncAt,
    };
    await saveSyncState(session, newState);

    const response = NextResponse.json({
      success: true,
      mode: fullSync ? 'full' : 'incremental',
      message: `Moomoo ${fullSync ? 'history' : 'incremental'} sync completed. Added ${ledgerResult.added} trades, updated ${ledgerResult.updated} trades and synced ${syncedDeposits} cash deposits.`,
      syncedTrades: ledgerResult.added,
      updatedTrades: ledgerResult.updated,
      feeDetailsUnavailable: feeLookupCount.failed,
      syncedDeposits,
      skippedDeposits,
      ...(freshTrades ? { trades: freshTrades } : { tradeChanges: ledgerResult.changes, removedTradeIds: ledgerResult.removedIds }),
      portfolio: freshPortfolio,
      portfolioSummary: {
        positionsCount: accounts.reduce((sum, account) => sum + account.positions.length, 0),
      },
      lastSyncAt: completedAt,
      timestamp: completedAt,
    });
    if (refreshed) setSessionCookie(response, session);
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Moomoo sync failed.';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
