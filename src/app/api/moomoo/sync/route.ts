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
    let requestBody: JsonRecord = {};
    try {
      requestBody = await req.json() as JsonRecord;
      forceFullSync = requestBody?.fullHistory === true;
    } catch {
      // Empty bodies remain the normal light/full-by-checkpoint sync request.
    }

    const clientState = parseMoomooSyncState(requestBody.syncState);
    const oldState = clientState || parseMoomooSyncState((await getSettings(session))[MOOMOO_SYNC_STATE_KEY]);

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

      const orders = orderPages.flat();
      const positions = await (async () => {
        const result = await callMoomooApi<JsonRecord>(`/api/v1.0/accounts/${encodeURIComponent(accountId)}/positions`, { method: 'GET', config }).catch((e) => ({ success: false as const, error: String(e), data: undefined }));
        if (!result.success) {
          console.warn(`[Moomoo Sync] Positions warning for ${accountId}:`, result.error);
          return [];
        }
        return recordsFromPage(unwrapData(result.data), ['positions', 'position_list', 'list']);
      })();
      return { accountId, currency: getString(account.currency), orders, positions, previousAccountSyncAt };
    }));

    const accounts = accountPayloads.filter((account): account is NonNullable<typeof account> => Boolean(account));
    const fullSync = forceFullSync || accounts.some((account) => !account.previousAccountSyncAt);
    const reconcileFlowHistory = fullSync || oldState?.flowSyncVersion !== 1;
    const cleanupLegacyDeposits = reconcileFlowHistory;
    const clientTrades = Array.isArray(requestBody.existingTrades)
      ? requestBody.existingTrades.filter((row): row is JsonRecord => Boolean(row) && typeof row === 'object')
      : [];
    const rawExistingRows = clientTrades.length > 0
      ? clientTrades
      : fullSync ? await getExistingTrades(session) : [];
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

    const accountsNeedingCashLogs = new Set(
      tradeCandidates.filter(({ order, existingIndex }) => {
        const existing = existingIndex >= 0 ? existingRows[existingIndex] : null;
        const notes = getString(existing?.Notes || existing?.notes);
        const hasConfirmedStoredFee = notes.includes('Fee sync: confirmed') || notes.includes('Fee breakdown:');
        const storedFee = parseAmount(existing?.Fees ?? existing?.fees);
        const hasOrderFee = parseAmount(order.dealt_fee ?? order.fee ?? order.fees ?? order.total_fee ?? order.commission) !== null;
        return !hasOrderFee && !(hasConfirmedStoredFee && storedFee !== null);
      }).map((candidate) => candidate.accountId)
    );
    const accountsWithCashLogs = await Promise.all(accounts
      .filter((account) => accountsNeedingCashLogs.has(account.accountId))
      .map(async (account) => {
        const previousAccountSyncAt = forceFullSync ? undefined : oldState?.accountLastSyncAt[account.accountId];
        const beginMs = getMoomooSyncStartMs(previousAccountSyncAt);
        const cashLogs = await fetchAllPages(
          account.accountId,
          `/api/v1.0/accounts/${encodeURIComponent(account.accountId)}/cash_logs`,
          { begin_time: toMicroseconds(beginMs), end_time: toMicroseconds(Date.now() + 24 * 60 * 60 * 1000) },
          ['cash_logs', 'list'],
          20,
          config
        ).catch((error) => {
          console.warn(`[Moomoo Sync] Cash logs warning for ${account.accountId}:`, error);
          return [];
        });
        return { accountId: account.accountId, cashLogs };
      }));
    const feeByOrderId = new Map<string, number>();
    for (const account of accountsWithCashLogs) {
      for (const [orderId, amount] of cashLogFeeByOrderId(account.cashLogs)) {
        feeByOrderId.set(`${account.accountId}:${orderId}`, amount);
      }
    }

    const normalizedTrades = await mapWithConcurrency(tradeCandidates, 6, async ({ accountId, orderId, order, existingIndex }) => {
      const existing = existingIndex >= 0 ? existingRows[existingIndex] : null;
      const existingNotes = getString(existing?.Notes || existing?.notes);
      const hasPreviouslyConfirmedFees = existingNotes.includes('Fee sync: confirmed') || existingNotes.includes('Fee breakdown:');
      const orderFeeFallback = parseAmount(order.dealt_fee ?? order.fee ?? order.fees ?? order.total_fee ?? order.commission);
      const storedFee = parseAmount(existing?.Fees ?? existing?.fees);
      const canUseStoredFee = hasPreviouslyConfirmedFees && storedFee !== null;
      const exactCashFee = feeByOrderId.get(`${accountId}:${orderId}`);
      let feeInfo: { totalFee: number; currency: string; items: Array<{ type: string; amount: number }> } | null = null;
      let feeReadError = '';
      if (orderFeeFallback === null && !canUseStoredFee && exactCashFee === undefined) {
        try {
          feeInfo = await readMoomooFee(accountId, orderId, config);
        } catch (error) {
          feeReadError = error instanceof Error ? error.message : 'Moomoo fee request failed.';
        }
      }

      const trade = normalizeMoomooOrder(order, accountId, feeInfo || undefined);
      if (!trade) return null;

      if (orderFeeFallback !== null) {
        trade.Fees = Math.abs(orderFeeFallback);
        trade['Net Total'] = calculateMoomooNetTotal(String(trade.Action), Number(trade.Quantity), Number(trade.Price), Number(trade.Fees));
        trade.Notes = canUseStoredFee && storedFee === orderFeeFallback
          ? existingNotes
          : `${trade.Notes}; Fee sync: confirmed (order response)`;
      } else if (canUseStoredFee) {
        trade.Fees = Math.abs(storedFee);
        trade['Net Total'] = calculateMoomooNetTotal(String(trade.Action), Number(trade.Quantity), Number(trade.Price), Number(trade.Fees));
        trade.Notes = existingNotes;
      } else if (!feeInfo) {
        if (exactCashFee !== undefined) {
          trade.Fees = Math.abs(exactCashFee);
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
    const completedAt = new Date().toISOString();
    const accountLastSyncAt = { ...(oldState?.accountLastSyncAt || {}) };
    for (const account of accounts) accountLastSyncAt[account.accountId] = completedAt;
    const newState: MoomooSyncState = {
      version: 2,
      lastSyncAt: completedAt,
      accountLastSyncAt,
      flowSyncVersion: 1,
    };
    const addedTrades = tradesToSync.filter((trade) => {
      const notes = getString(trade.Notes || trade.notes);
      const accountId = notes.match(/\bAccount:\s*([^;\s)]+)/i)?.[1] || '';
      const orderId = notes.match(/\bOrder:\s*([^;\s)]+)/i)?.[1] || '';
      return findMoomooOrderTradeIndex(existingRows, accountId, orderId) < 0;
    }).length;

    const response = NextResponse.json({
      success: true,
      mode: fullSync ? 'full' : 'incremental',
      message: `Moomoo ${fullSync ? 'history' : 'incremental'} activity was fetched and saved on this device before the queued Sheets sync.`,
      syncedTrades: addedTrades,
      updatedTrades: Math.max(0, tradesToSync.length - addedTrades),
      feeDetailsUnavailable: 0,
      moomooTrades: tradesToSync,
      syncOptions: {
        restoreDeletedMoomooTrades: forceFullSync,
        reconcileFlowHistory,
        cleanupLegacyDeposits,
      },
      portfolioSummary: {
        positionsCount: accounts.reduce((sum, account) => sum + account.positions.length, 0),
      },
      syncState: newState,
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
