import { NextRequest, NextResponse } from 'next/server';
import { getMoomooConfig, callMoomooApi, type MoomooConfig } from '@/lib/moomoo-client';
import { getValidGoogleSession, setSessionCookie, type GoogleUserSession } from '@/lib/google-auth';
import { executeUserGoogleAction } from '@/lib/google-sheets-user-engine';
import { fetchAdminAppsScript, getAdminAppsScriptEndpoint } from '@/lib/admin-registry';
import {
  findMoomooOrderTradeIndex,
  calculateMoomooNetTotal,
  getMoomooSyncStartMs,
  getMoomooTradingMarkets,
  MOOMOO_SYNC_STATE_KEY,
  normalizeMoomooOrder,
  parseMoomooSyncState,
  selectMoomooAuthorizedAccounts,
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
  restoreDeletedMoomooTrades = false,
  reconcileFlowHistory = false,
  cleanupLegacyDeposits = false
): Promise<{ added: number; updated: number; rows?: Array<Record<string, unknown>>; changes: Array<Record<string, unknown>>; removedIds: string[]; restoredTombstones: number; flowAdded: number; flowUpdated: number; duplicateFlowRowsRemoved: number; removedDepositRows: number }> {
  // The deployed Apps Script may lag the repository and not recognize
  // batchSyncTrades. Moomoo's purpose-built upsert supports both first and
  // incremental imports, while the full sheet is read immediately afterward.
  const action = 'syncMoomooTrades';
  if (session.isAdmin && getAdminAppsScriptEndpoint()) {
    const response = await fetchAdminAppsScript('POST', action, {
      trades,
      restoreDeletedMoomooTrades,
      reconcileFlowHistory,
      cleanupLegacyDeposits,
    }) as JsonRecord | null;
    if (!response?.success) {
      const message = response?.message || 'Could not write Moomoo trades to Google Sheets.';
      if (/unknown action/i.test(message)) {
        throw new Error('The deployed Google Apps Script does not recognize syncMoomooTrades. Deploy the latest apps-script/Code.gs and retry.');
      }
      throw new Error(message);
    }
    const data = response.data?.result || response.data;
    if (!data) throw new Error('Google Sheets did not confirm the Moomoo trade write.');
    if (typeof data.flowAdded !== 'number' || typeof data.removedDepositRows !== 'number') {
      throw new Error('The deployed Google Apps Script is outdated and cannot link Moomoo trades to monthly Flow. Deploy the latest apps-script/Code.gs, then sync again.');
    }
    return {
      added: Number(data.added) || 0,
      updated: Number(data.updated) || 0,
      rows: Array.isArray(data.rows) ? data.rows : undefined,
      changes: Array.isArray(data.changes) ? data.changes : trades,
      removedIds: Array.isArray(data.removedIds) ? data.removedIds.map(String) : [],
      restoredTombstones: Number(data.restoredTombstones) || 0,
      flowAdded: Number(data.flowAdded) || 0,
      flowUpdated: Number(data.flowUpdated) || 0,
      duplicateFlowRowsRemoved: Number(data.duplicateFlowRowsRemoved) || 0,
      removedDepositRows: Number(data.removedDepositRows) || 0,
    };
  }

  const { result } = await executeUserGoogleAction(session, action, {
    trades,
    restoreDeletedMoomooTrades,
    reconcileFlowHistory,
    cleanupLegacyDeposits,
  });
  const data = result as JsonRecord;
  if (!data) throw new Error('Google Sheets did not confirm the Moomoo trade write.');
  if (typeof data.flowAdded !== 'number' || typeof data.removedDepositRows !== 'number') {
    throw new Error('The Google Sheets sync engine did not confirm the Moomoo Flow reconciliation. Please retry the sync.');
  }
  return {
    added: Number(data.added) || 0,
    updated: Number(data.updated) || 0,
    rows: Array.isArray(data.rows) ? data.rows : undefined,
    changes: Array.isArray(data.changes) ? data.changes : trades,
    removedIds: Array.isArray(data.removedIds) ? data.removedIds.map(String) : [],
    restoredTombstones: Number(data.restoredTombstones) || 0,
    flowAdded: Number(data.flowAdded) || 0,
    flowUpdated: Number(data.flowUpdated) || 0,
    duplicateFlowRowsRemoved: Number(data.duplicateFlowRowsRemoved) || 0,
    removedDepositRows: Number(data.removedDepositRows) || 0,
  };
}

async function rebuildPortfolio(session: GoogleUserSession): Promise<void> {
  if (session.isAdmin && getAdminAppsScriptEndpoint()) {
    const response = await fetchAdminAppsScript('POST', 'syncPortfolio') as JsonRecord | null;
    if (!response?.success) throw new Error(response?.message || 'Could not rebuild Portfolio from trade history.');
    return;
  }
  await executeUserGoogleAction(session, 'syncPortfolio', {});
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
  if (!result.success) throw new Error(result.error || 'Moomoo did not return order fee details.');
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

    let forceFullSync = false;
    try {
      const requestBody = await req.json() as JsonRecord;
      forceFullSync = requestBody?.fullHistory === true;
    } catch {
      // Empty bodies remain the normal light/full-by-checkpoint sync request.
    }

    const settings = await getSettings(session);
    const oldState = parseMoomooSyncState(settings[MOOMOO_SYNC_STATE_KEY]);

    const accountsResult = await callMoomooApi<JsonRecord>('/api/v1.0/accounts/authorized_trd_accs', { method: 'GET', config });
    if (!accountsResult.success) throw new Error(accountsResult.error || 'Could not read authorized Moomoo accounts.');
    const accountData = unwrapData(accountsResult.data);
    const authorizedAccounts = recordsFromPage(accountData, ['accounts', 'list']);
    if (authorizedAccounts.length === 0) throw new Error('No authorized Moomoo trading accounts were returned.');

    const selectedAccounts = selectMoomooAuthorizedAccounts(authorizedAccounts, config.accountId);
    if (selectedAccounts.length === 0) {
      throw new Error('No authorized Moomoo trading accounts have a usable account_id.');
    }

    const accountPayloads = await Promise.all(selectedAccounts.map(async (account) => {
      const accountId = getString(account.account_id);
      const markets = getMoomooTradingMarkets(account);
      if (markets.length === 0) {
        throw new Error(`Moomoo account ${accountId} did not return any supported enable_market values; refusing to mark an empty sync as complete.`);
      }
      const previousAccountSyncAt = forceFullSync ? undefined : oldState?.accountLastSyncAt[accountId];
      const beginMs = getMoomooSyncStartMs(previousAccountSyncAt);
      const endMs = Date.now() + 24 * 60 * 60 * 1000;
      const start = toMicroseconds(beginMs);
      const end = toMicroseconds(endMs);

      // Historical orders are queried one trading market at a time. Moomoo
      // expects `start`/`end` here; `begin_time`/`end_time` are cash-log fields.
      const orderPages = await Promise.all(markets.map((market) => fetchAllPages(
        accountId,
        `/api/v1.0/accounts/${encodeURIComponent(accountId)}/orders_history`,
        { trd_market: market, start, end },
        ['orders', 'list'],
        100,
        config
      )));

      const cashLogParams = {
        begin_time: start,
        end_time: end,
      };

      const orders = orderPages.flat();
      const [cashLogs, positions] = await Promise.all([
        fetchAllPages(accountId, `/api/v1.0/accounts/${encodeURIComponent(accountId)}/cash_logs`, cashLogParams, ['cash_logs', 'list'], 20, config).catch((e) => {
          console.warn(`[Moomoo Sync] Cash logs warning for ${accountId}:`, e);
          return [];
        }),
        (async () => {
          const result = await callMoomooApi<JsonRecord>(`/api/v1.0/accounts/${encodeURIComponent(accountId)}/positions`, { method: 'GET', config }).catch((e) => ({ success: false as const, error: String(e), data: undefined }));
          if (!result.success) {
            console.warn(`[Moomoo Sync] Positions warning for ${accountId}:`, result.error);
            return [];
          }
          return recordsFromPage(unwrapData(result.data), ['positions', 'position_list', 'list']);
        })(),
      ]);
      return { accountId, currency: getString(account.currency), orders, cashLogs, positions, previousAccountSyncAt };
    }));

    const accounts = accountPayloads.filter((account): account is NonNullable<typeof account> => Boolean(account));
    const fullSync = forceFullSync || accounts.some((account) => !account.previousAccountSyncAt);
    const reconcileFlowHistory = fullSync || oldState?.flowSyncVersion !== 1;
    const cleanupLegacyDeposits = reconcileFlowHistory;
    const rawExistingRows = fullSync ? await getExistingTrades(session) : [];
    const existingRows = [...rawExistingRows];
    const feeLookupErrors: Array<{ orderId: string; message: string }> = [];
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
      const hasPreviouslyConfirmedFees = existingNotes.includes('Fee sync: confirmed') || existingNotes.includes('Fee breakdown:');
      let feeInfo: { totalFee: number; currency: string; items: Array<{ type: string; amount: number }> } | null = null;
      let feeReadError = '';
      try {
        feeInfo = await readMoomooFee(accountId, orderId, config);
      } catch (error) {
        feeReadError = error instanceof Error ? error.message : 'Moomoo fee request failed.';
      }

      const orderFeeFallback = parseAmount(order.dealt_fee ?? order.fee ?? order.fees ?? order.total_fee ?? order.commission);
      const storedFee = parseAmount(existing?.Fees ?? existing?.fees);
      const canUseStoredFee = hasPreviouslyConfirmedFees && storedFee !== null;

      const trade = normalizeMoomooOrder(order, accountId, feeInfo || undefined);
      if (!trade) return null;

      if (!feeInfo && orderFeeFallback !== null) {
        trade.Fees = Math.abs(orderFeeFallback);
        trade['Net Total'] = calculateMoomooNetTotal(String(trade.Action), Number(trade.Quantity), Number(trade.Price), Number(trade.Fees));
        trade.Notes = `${trade.Notes}; Fee sync: confirmed (order response)`;
      } else if (!feeInfo && canUseStoredFee) {
        trade.Fees = Math.abs(storedFee);
        trade['Net Total'] = calculateMoomooNetTotal(String(trade.Action), Number(trade.Quantity), Number(trade.Price), Number(trade.Fees));
        trade.Notes = existingNotes;
      } else if (!feeInfo) {
        const exactCashFee = feeByOrderId.get(`${accountId}:${orderId}`);
        if (exactCashFee !== undefined) {
          trade.Fees = exactCashFee;
          trade['Net Total'] = calculateMoomooNetTotal(String(trade.Action), Number(trade.Quantity), Number(trade.Price), exactCashFee);
          trade.Notes = `${trade.Notes}; Fee sync: confirmed (cash log)`;
        } else {
          feeLookupErrors.push({ orderId, message: feeReadError || 'Moomoo returned no total fee or fee items.' });
        }
      }
      return trade;
    });

    const tradesToSync = normalizedTrades.filter((trade): trade is Record<string, unknown> => Boolean(trade));
    if (feeLookupErrors.length > 0) {
      const first = feeLookupErrors[0];
      const details = feeLookupErrors.length > 1 ? ` (${feeLookupErrors.length - 1} more order(s) also missing fees)` : '';
      throw new Error(
        `Moomoo fee details are missing for ${feeLookupErrors.length} executed order(s). No trades or deposits were written. Check that the API key has trade-read permission, then retry. First order ${first.orderId}: ${first.message}${details}`
      );
    }
    const ledgerResult = tradesToSync.length > 0
      ? await syncTradesToLedger(session, tradesToSync, forceFullSync, reconcileFlowHistory, cleanupLegacyDeposits)
      : await syncTradesToLedger(session, [], forceFullSync, reconcileFlowHistory, cleanupLegacyDeposits);
    if (tradesToSync.length === 0) await rebuildPortfolio(session);

    let fullTradesAfterSync: Array<Record<string, unknown>> | undefined;
    if (forceFullSync) {
      fullTradesAfterSync = await getExistingTrades(session);
      const missingRestoredTrades = tradesToSync.filter((trade) => {
        const notes = getString(trade.Notes || trade.notes);
        const accountId = notes.match(/\bAccount:\s*([^;\s)]+)/i)?.[1] || '';
        const orderId = notes.match(/\bOrder:\s*([^;\s)]+)/i)?.[1] || '';
        return !accountId || !orderId || findMoomooOrderTradeIndex(fullTradesAfterSync!, accountId, orderId) < 0;
      });
      if (missingRestoredTrades.length > 0) {
        throw new Error(
          `Full Moomoo sync found ${missingRestoredTrades.length} executed order(s) that Google Sheets did not restore. Deploy the latest Sheets sync code, then retry the full re-sync.`
        );
      }
    }

    const [freshTrades, freshPortfolio] = await Promise.all([
      fullSync ? (fullTradesAfterSync ?? getExistingTrades(session)) : Promise.resolve(undefined),
      getPortfolioRows(session),
    ]);

    const completedAt = new Date().toISOString();
    const accountLastSyncAt = { ...(oldState?.accountLastSyncAt || {}) };
    for (const account of accounts) accountLastSyncAt[account.accountId] = completedAt;
    const newState: MoomooSyncState = {
      version: 2,
      lastSyncAt: completedAt,
      accountLastSyncAt,
      flowSyncVersion: 1,
    };
    await saveSyncState(session, newState);

    const response = NextResponse.json({
      success: true,
      mode: fullSync ? 'full' : 'incremental',
      message: `Moomoo ${fullSync ? 'history' : 'incremental'} sync completed. Added ${ledgerResult.added} trades, updated ${ledgerResult.updated} trades, and linked the trade ledger to monthly Flow.`,
      syncedTrades: ledgerResult.added,
      updatedTrades: ledgerResult.updated,
      flowAdded: ledgerResult.flowAdded,
      flowUpdated: ledgerResult.flowUpdated,
      duplicateFlowRowsRemoved: ledgerResult.duplicateFlowRowsRemoved,
      removedMoomooDepositRows: ledgerResult.removedDepositRows,
      feeDetailsUnavailable: 0,
      restoredMoomooTombstones: ledgerResult.restoredTombstones,
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
