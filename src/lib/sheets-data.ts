import { sheetsApi, getSwrCachedEntry, setSwrCachedData, getActiveUserCacheScope } from './sheets-api';
import { 
  getRollingWindowMonths, 
  clearDisposableReadCaches,
  enqueuePendingMutation, 
  getPendingMutations, 
  removePendingMutation, 
  markPendingMutationFailed
} from './cache-manager';
import {
  recordDeletedTombstone,
  getDeletedTombstones,
  clearDeletedTombstone,
  isRecordTombstoned,
  recordSyncConflict,
} from './data-integrity';
import { persistConflictBeforeTombstone, resolveNotFoundUpdatePolicy } from './conflict-policy';
import { applyPendingTransactionUpdate } from './transaction-cache-merge';
import { getPendingMutationDisposition, shouldKeepPendingMutationOnStartup } from './pending-mutation-policy';
import { isLegacyFoodOrGrocery } from './canonical-categories';
import { toast } from 'sonner';

let flushInFlight: Promise<{ total: number; succeeded: number; failed: number }> | null = null;
let flushFollowUpNeeded = false;
let backgroundPrefetchScheduled = false;
const activeWritePromises = new Set<Promise<unknown>>();
const activeWriteTails = new Map<string, Promise<void>>();

function enqueueSerializedSheetOperation<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = activeWriteTails.get(key) || Promise.resolve();
  const promise = previous.then(operation, operation);
  const tail = promise.then(() => undefined, () => undefined);
  activeWriteTails.set(key, tail);
  void tail.finally(() => {
    if (activeWriteTails.get(key) === tail) activeWriteTails.delete(key);
  });
  return promise;
}

function trackActivePromise<T>(promise: Promise<T>): Promise<T> {
  activeWritePromises.add(promise);
  return promise.finally(() => {
    activeWritePromises.delete(promise);
  });
}

export function runSerializedSheetMutation<T>(sheetName: string, operation: () => Promise<T>): Promise<T> {
  const key = `${getActiveUserCacheScope()}::${String(sheetName || 'default')}`;
  return trackActivePromise(enqueueSerializedSheetOperation(key, operation));
}

function trackActiveWrite<T>(sheetName: string, operation: () => Promise<T>): Promise<T> {
  const key = `${getActiveUserCacheScope()}::${String(sheetName || 'default')}`;
  return trackActivePromise(enqueueSerializedSheetOperation(key, operation));
}

type SheetRow = Record<string, unknown>;
type SheetDataPayload = { headers: string[]; rows: SheetRow[] };

function getTradeId(trade: SheetRow): string {
  return String(trade.Id || trade.id || '').trim();
}

function normalizeTradeRow(trade: SheetRow): SheetRow {
  const id = getTradeId(trade);
  const date = String(trade.Date || trade.date || '').trim().slice(0, 10);
  const action = String(trade.Action || trade.action || 'BUY').trim().toUpperCase();
  const ticker = String(trade.Ticker || trade.ticker || '').trim().toUpperCase();
  const quantity = Number(trade.Quantity ?? trade.quantity) || 0;
  const price = Number(trade.Price ?? trade.price) || 0;
  const fees = Math.abs(Number(trade.Fees ?? trade.fees) || 0);
  const netTotal = Number(trade['Net Total'] ?? trade.NetTotal ?? trade.total) ||
    Number((quantity * price + (action === 'SELL' ? -fees : fees)).toFixed(2));
  const currency = String(trade.Currency || trade.currency || 'USD').trim().toUpperCase();
  const name = String(trade['Asset Name'] || trade.AssetName || trade.name || ticker).trim();
  const notes = String(trade.Notes || trade.notes || '');
  return {
    ...trade,
    Id: id,
    Date: date,
    Action: action,
    Ticker: ticker,
    'Asset Name': name,
    Quantity: quantity,
    Price: price,
    Fees: fees,
    'Net Total': netTotal,
    Currency: currency,
    Notes: notes,
  };
}

function buildTradeFlowRow(trade: SheetRow): SheetRow | null {
  const id = getTradeId(trade);
  const date = String(trade.Date || trade.date || '').trim().slice(0, 10);
  const action = String(trade.Action || trade.action || 'BUY').trim().toUpperCase();
  const ticker = String(trade.Ticker || trade.ticker || '').trim().toUpperCase();
  const quantity = Number(trade.Quantity ?? trade.quantity) || 0;
  const price = Number(trade.Price ?? trade.price) || 0;
  const fees = Math.abs(Number(trade.Fees ?? trade.fees) || 0);
  const currency = String(trade.Currency || trade.currency || 'USD').trim().toUpperCase();
  const netTotal = Number(trade['Net Total'] ?? trade.NetTotal ?? trade.total) ||
    Number((quantity * price + (action === 'SELL' ? -fees : fees)).toFixed(2));
  if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !ticker || quantity <= 0 || price <= 0) return null;

  const costInMyr = Number(trade.CostInMyr ?? trade.costInMyr) || 0;
  const rateToMyr = Number(trade.RateToMyr ?? trade.rateToMyr) || 0;
  const originalNotes = String(trade.Notes || trade.notes || '');
  const notes = costInMyr > 0
    ? `Cost: RM ${costInMyr.toFixed(2)}${rateToMyr > 0 ? ` (Rate: ${rateToMyr.toFixed(4)})` : ''}`
    : /^moo_/i.test(id)
      ? `${originalNotes}${originalNotes ? '; ' : ''}Fees: ${fees.toFixed(2)} ${currency}; Net total: ${netTotal.toFixed(2)} ${currency}`
      : originalNotes;
  return {
    Id: `tx_trade_${id.replace(/[^A-Za-z0-9_-]/g, '_')}`,
    Date: date,
    Type: 'Investment',
    Category: 'Stocks & Crypto',
    SubCategory: action,
    Description: `${action} ${quantity} ${ticker} @ ${price} ${currency}`,
    Amount: costInMyr > 0 ? Number(costInMyr.toFixed(2)) : netTotal,
    Currency: costInMyr > 0 ? 'MYR' : currency,
    PaymentMethod: 'Investment Account',
    Notes: notes,
  };
}

function persistTradeCache(rows: SheetRow[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem('cashflow_persistent_trades', JSON.stringify(rows));
  } catch {
    // Local SWR cache and pending queue remain authoritative if the browser quota is full.
  }
}

function getCachedTradeRows(): SheetRow[] {
  const entry = getSwrCachedEntry<{ success: boolean; data: SheetDataPayload }>('getSheetData', { sheetName: 'Trades' });
  const rows = entry?.data?.data?.rows;
  if (Array.isArray(rows)) return rows;
  if (typeof window !== 'undefined') {
    try {
      const stored = localStorage.getItem('cashflow_persistent_trades');
      const parsed: unknown = stored ? JSON.parse(stored) : null;
      if (Array.isArray(parsed)) return parsed as SheetRow[];
    } catch {
      // Ignore malformed stale cache data.
    }
  }
  return [];
}

function getPersistentTradeRow(id: string): SheetRow | undefined {
  if (typeof window === 'undefined' || !id) return undefined;
  try {
    const stored = localStorage.getItem('cashflow_persistent_trades');
    const parsed: unknown = stored ? JSON.parse(stored) : null;
    if (!Array.isArray(parsed)) return undefined;
    return (parsed as SheetRow[]).find((row) => getTradeId(row) === id);
  } catch {
    return undefined;
  }
}

function tradeTicker(trade: SheetRow): string {
  return String(trade.Ticker || trade.ticker || '').trim().toUpperCase();
}

function clearTradeHoldingTombstone(trade: SheetRow): void {
  const ticker = tradeTicker(trade);
  if (!ticker) return;
  clearDeletedTombstone(ticker);
  clearDeletedTombstone(`moo_holding_${ticker.toLowerCase()}_0`);
}

function recordTransactionUpdateConflict(
  clientRow: SheetRow,
  serverRow: SheetRow,
  conflictingFields: string[],
  fallbackSheet: string,
  changedAt = Date.now()
): boolean {
  const id = String(clientRow.Id || clientRow.id || '').trim();
  if (!id) return false;

  const clientRecord = { ...clientRow };
  delete clientRecord._baseData;
  const serverMonth = String(
    serverRow._month || serverRow.Date || serverRow.date || fallbackSheet
  ).slice(0, 7);
  const savedServerRow = {
    ...serverRow,
    Id: id,
    id,
    ...(serverMonth ? { _month: serverMonth } : {}),
  };

  const conflictRecord = {
    entityId: id,
    kind: 'transaction',
    serverChangedAt: Date.now(),
    clientMutationChangedAt: changedAt,
    conflictingFields,
    serverRecord: savedServerRow,
    clientRecord,
    resolution: `Concurrent edits were detected in: ${conflictingFields.join(', ')}. Neither version was overwritten; choose a version in Settings.`,
  } as const;
  let saved = recordSyncConflict(conflictRecord);
  if (!saved) {
    clearDisposableReadCaches();
    saved = recordSyncConflict(conflictRecord);
  }
  if (!saved) {
    toast.error('发现并发修改，但本机存储无法保存冲突副本。原更新已保留在待同步队列中，请先释放本机存储空间。');
    return false;
  }

  // Remove the rejected optimistic value from cached months and put the server
  // version back wherever that month is already cached. Do not create a partial
  // month cache when the month has not been loaded.
  const targetMonth = /^\d{4}-\d{2}/.test(String(savedServerRow._month || ''))
    ? String(savedServerRow._month).slice(0, 7)
    : '';
  const candidates = new Set<string>([
    fallbackSheet,
    ...(targetMonth ? [targetMonth] : []),
    ...getRollingWindowMonths(12),
  ]);
  candidates.forEach((candidate) => {
    const entry = getSwrCachedEntry<{ success: boolean; data: SheetDataPayload }>('getSheetData', {
      sheetName: candidate,
    });
    const rows = entry?.data?.data?.rows;
    if (!Array.isArray(rows)) return;
    const filtered = rows.filter((row) => String(row.Id || row.id || '').trim() !== id);
    if (candidate === targetMonth) {
      filtered.push(savedServerRow);
    }
    if (filtered.length !== rows.length || candidate === targetMonth) {
      setSwrCachedData('getSheetData', { sheetName: candidate }, {
        success: true,
        data: { headers: entry?.data?.data?.headers || [], rows: filtered },
      });
    }
  });

  toast.warning('此记录在其他设备上也有修改。两份版本均已保留，请到设置中的冲突中心选择要使用的版本。');
  return true;
}

function recordDeletedTransactionUpdateConflict(
  rowId: string,
  sheetName: string,
  clientRecord: SheetRow,
  changedAt: number
): boolean {
  const clientSnapshot = { ...clientRecord };
  delete clientSnapshot._baseData;
  const conflict = {
    entityId: rowId,
    kind: 'transaction',
    serverChangedAt: Date.now(),
    clientMutationChangedAt: changedAt,
    serverRecord: {
      status: 'deleted_on_server',
      sheetName,
      message: 'Record was not found on Google Sheets (deleted on another device or session).',
    },
    clientRecord: clientSnapshot,
    resolution: 'Edit was not applied to avoid resurrecting deleted record. Preserved in Conflict Store.',
  } as const;

  // Do not mark the row deleted until its losing client version is durable.
  return persistConflictBeforeTombstone(
    () => recordSyncConflict(conflict),
    clearDisposableReadCaches,
    () => recordDeletedTombstone(rowId, 'transaction', sheetName)
  );
}

interface InFlightOptimisticMutation {
  type: 'add' | 'update';
  sheetName: string;
  rowId: string;
  rowData: SheetRow;
  createdAt: number;
}

const inFlightOptimisticRows = new Map<string, InFlightOptimisticMutation>();
const IN_FLIGHT_RETENTION_MS = 30_000;

export function clearInFlightOptimisticRows(): void {
  inFlightOptimisticRows.clear();
  backgroundPrefetchScheduled = false;
}

export function ensureMonthInLocalMonthList(month: string): void {
  if (!/^\d{4}-\d{2}$/.test(month) || typeof window === 'undefined') return;
  try {
    const entry = getSwrCachedEntry<{ success: boolean; data: string[] }>('getMonthList', {});
    const existing = Array.isArray(entry?.data?.data) ? entry!.data.data : [];
    if (!existing.includes(month)) {
      const next = Array.from(new Set([...existing, month]))
        .filter((m) => /^\d{4}-\d{2}$/.test(m))
        .sort((a, b) => b.localeCompare(a));
      setSwrCachedData('getMonthList', {}, { success: true, data: next });
    }
  } catch {
    // ignore storage errors
  }
}

export function collectLocallyKnownMonths(): string[] {
  const months = new Set<string>();
  const now = Date.now();
  for (const [id, item] of inFlightOptimisticRows.entries()) {
    if (now - item.createdAt > IN_FLIGHT_RETENTION_MS) {
      inFlightOptimisticRows.delete(id);
      continue;
    }
    if (/^\d{4}-\d{2}$/.test(item.sheetName)) {
      months.add(item.sheetName);
    }
  }
  try {
    for (const m of getPendingMutations()) {
      if (m.type === 'delete') continue;
      if (/^\d{4}-\d{2}$/.test(m.sheetName)) {
        months.add(m.sheetName);
      }
      const dateStr = String(m.rowData?.Date || m.rowData?.date || '');
      if (/^\d{4}-\d{2}/.test(dateStr)) {
        months.add(dateStr.substring(0, 7));
      }
    }
  } catch {
    // ignore
  }
  if (typeof window !== 'undefined') {
    try {
      const scope = getActiveUserCacheScope();
      const prefix = `cashflow_swr_${scope}_getSheetData_`;
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(prefix)) continue;
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        const m = typeof parsed?.month === 'string' ? parsed.month : '';
        const rows = parsed?.data?.data?.rows;
        if (/^\d{4}-\d{2}$/.test(m) && Array.isArray(rows) && rows.length > 0) {
          months.add(m);
        }
      }
    } catch {
      // ignore
    }
  }
  return Array.from(months);
}

function scheduleBackgroundWarmRecentMonths(): void {
  if (typeof window === 'undefined' || backgroundPrefetchScheduled) return;
  backgroundPrefetchScheduled = true;

  setTimeout(async () => {
    try {
      const res = await sheetsApi.getAllTransactions({ limitMonths: 12 });
      if (!res?.success || !res?.data) return;
      const headers = res.data.headers || [];
      const rowsByMonth = new Map<string, SheetRow[]>();

      for (const r of (res.data.rows || []) as SheetRow[]) {
        const m = String(r._month || String(r.Date || r.date || '').substring(0, 7));
        if (!/^\d{4}-\d{2}$/.test(m)) continue;
        if (!rowsByMonth.has(m)) rowsByMonth.set(m, []);
        rowsByMonth.get(m)!.push({ ...r, _month: m });
      }

      // Warm all 12 recent calendar months + any month returned by the server
      const recent12 = getRollingWindowMonths(12);
      const monthsToWarm = new Set<string>([...recent12, ...Array.from(rowsByMonth.keys())]);

      monthsToWarm.forEach((monthKey) => {
        const monthRows = rowsByMonth.get(monthKey) || [];
        const existing = getSwrCachedEntry<{ success: boolean; data: SheetDataPayload }>('getSheetData', { sheetName: monthKey });
        const existingCount = existing?.data?.data?.rows?.length || 0;
        if (!existing || (existingCount === 0 && monthRows.length > 0)) {
          setSwrCachedData('getSheetData', { sheetName: monthKey }, {
            success: true,
            data: { headers, rows: monthRows },
          });
        }
      });
    } catch {
      // Non-blocking background cache warm; ignore network errors
    }
  }, 1200);
}

export const sheetsData = {
  /**
   * Synchronous 0ms cache lookup for Transactions so React Query renders immediately
   * without waiting for a network round-trip on startup or tab switch.
   */
  getInitialTransactions(selectedPeriod?: string): { data: SheetDataPayload; savedAt: number } | undefined {
    const rollingMonths = getRollingWindowMonths(3);

    // Self-heal any stale proxy/API key errors or empty rolling month caches from earlier versions
    if (typeof window !== 'undefined') {
      try {
        if (localStorage.getItem('cashflow_cache_heal_v5') !== '1') {
          localStorage.setItem('cashflow_cache_heal_v5', '1');
          localStorage.removeItem('cashflow_api_key');
          localStorage.removeItem('cashflow_last_sync_error');
          localStorage.removeItem('cashflow_last_sync_error_at');
          localStorage.removeItem('cashflow_use_server_proxy');
          localStorage.removeItem('cashflow_swr_getAllTransactions_{"limitMonths":3}');
          localStorage.removeItem('cashflow_swr_getAllTransactions_{}');
          for (const m of rollingMonths) {
            const entry = getSwrCachedEntry<{ success: boolean; data: SheetDataPayload }>('getSheetData', { sheetName: m });
            if (entry && (!entry.data?.data?.rows || entry.data.data.rows.length === 0)) {
              localStorage.removeItem(`cashflow_swr_getSheetData_${JSON.stringify({ sheetName: m })}`);
            }
          }
        }
        if (localStorage.getItem('cashflow_cache_heal_v7') !== '1') {
          localStorage.setItem('cashflow_cache_heal_v7', '1');
          localStorage.removeItem('cashflow_last_sync_error');
          localStorage.removeItem('cashflow_last_sync_error_at');
          localStorage.removeItem('cashflow_pre_migration_backup_error_v1');
          // Clear any stuck failed mutations left over from earlier LockService / not-found collisions
          for (const qKey of ['cashflow_pending_queue', 'cashflow_pending_plan_mutations_v2', 'cashflow_pending_settings_mutations']) {
            const rawQ = localStorage.getItem(qKey);
            if (!rawQ) continue;
            try {
              const parsedQ = JSON.parse(rawQ);
              if (Array.isArray(parsedQ)) {
                const cleaned = parsedQ.filter((item: unknown) =>
                  shouldKeepPendingMutationOnStartup(item, isRecordTombstoned)
                );
                if (cleaned.length === 0) {
                  localStorage.removeItem(qKey);
                } else {
                  localStorage.setItem(qKey, JSON.stringify(cleaned));
                }
              }
            } catch {
              localStorage.removeItem(qKey);
            }
          }
        }
        if (localStorage.getItem('cashflow_cache_heal_v8') !== '1') {
          localStorage.setItem('cashflow_cache_heal_v8', '1');
          localStorage.removeItem('kinova_synced_shortcut_tx_ids');
          const keysToPurge: string[] = [];
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith('cashflow_swr_')) {
              keysToPurge.push(k);
            }
          }
          keysToPurge.forEach((k) => localStorage.removeItem(k));
        }
        if (localStorage.getItem('cashflow_cache_heal_v10') !== '1') {
          localStorage.setItem('cashflow_cache_heal_v10', '1');
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith('cashflow_swr_')) {
              try {
                const raw = localStorage.getItem(k);
                if (raw) {
                  const parsed = JSON.parse(raw);
                  const rows = parsed?.data?.data?.rows || parsed?.data?.rows || (Array.isArray(parsed?.data) ? parsed.data : null) || parsed?.rows;
                  if (Array.isArray(rows)) {
                    let changed = false;
                    rows.forEach((r: any) => {
                      const cat = r?.Category || r?.category;
                      if (cat && isLegacyFoodOrGrocery(String(cat))) {
                        if (r.Category) r.Category = 'Food & Dining';
                        if (r.category) r.category = 'Food & Dining';
                        changed = true;
                      }
                    });
                    if (changed) {
                      localStorage.setItem(k, JSON.stringify(parsed));
                    }
                  }
                }
              } catch {
                // ignore
              }
            }
          }
        }
      } catch {
        // Ignore storage errors
      }
    }

    // 1. Targeted single month
    if (selectedPeriod && /^\d{4}-\d{2}$/.test(selectedPeriod)) {
      const direct = getSwrCachedEntry<{ success: boolean; data: SheetDataPayload }>('getSheetData', { sheetName: selectedPeriod });
      if (direct?.data?.data) {
        const rawRows = (direct.data.data.rows || []).map((r: SheetRow) => ({ ...r, _month: selectedPeriod }));
        return {
          data: {
            headers: direct.data.data.headers || [],
            rows: applyPendingMutations(rawRows, selectedPeriod),
          },
          savedAt: direct.savedAt,
        };
      }
      return undefined;
    }

    // 2. Targeted year
    if (selectedPeriod && selectedPeriod.startsWith('year-')) {
      const year = selectedPeriod.replace('year-', '');
      let headers: string[] = [];
      const yearRows: SheetRow[] = [];
      let oldestSavedAt = Infinity;
      let foundAny = false;

      for (let m = 12; m >= 1; m--) {
        const monthStr = `${year}-${String(m).padStart(2, '0')}`;
        const entry = getSwrCachedEntry<{ success: boolean; data: SheetDataPayload }>('getSheetData', { sheetName: monthStr });
        if (entry?.data?.data?.rows) {
          foundAny = true;
          if (headers.length === 0 && entry.data.data.headers?.length) {
            headers = entry.data.data.headers;
          }
          entry.data.data.rows.forEach((r: SheetRow) => {
            yearRows.push({ ...r, _month: monthStr });
          });
          if (entry.savedAt < oldestSavedAt) oldestSavedAt = entry.savedAt;
        }
      }

      if (foundAny) {
        return {
          data: {
            headers,
            rows: applyPendingMutations(yearRows, selectedPeriod),
          },
          savedAt: oldestSavedAt === Infinity ? Date.now() : oldestSavedAt,
        };
      }
      return undefined;
    }

    if (selectedPeriod === 'all') {
      return undefined;
    }

    // 3. Default Active 3-Month Rolling Window (+ any warmed recent months in cache)
    let headers: string[] = [];
    const combinedRows: SheetRow[] = [];
    let oldestSavedAt = Infinity;
    let foundRollingCount = 0;
    const recent12 = getRollingWindowMonths(12);
    const rollingSet = new Set(rollingMonths);

    for (const m of recent12) {
      const entry = getSwrCachedEntry<{ success: boolean; data: SheetDataPayload }>('getSheetData', { sheetName: m });
      if (entry?.data?.data?.rows) {
        if (rollingSet.has(m)) {
          foundRollingCount++;
          if (entry.savedAt < oldestSavedAt) oldestSavedAt = entry.savedAt;
        }
        if (headers.length === 0 && entry.data.data.headers?.length) {
          headers = entry.data.data.headers;
        }
        entry.data.data.rows.forEach((r: SheetRow) => {
          combinedRows.push({ ...r, _month: m });
        });
      }
    }

    if (foundRollingCount > 0) {
      return {
        data: {
          headers,
          rows: applyPendingMutations(combinedRows, selectedPeriod),
        },
        // If not all 3 rolling months are cached yet, mark savedAt=0 so React Query immediately refreshes in background
        savedAt: foundRollingCount === rollingMonths.length && oldestSavedAt !== Infinity ? oldestSavedAt : 0,
      };
    }

    return undefined;
  },

  /**
   * Adds a trade and its linked monthly Flow row to this device immediately,
   * then sends the same combined addTrade operation used by Trade History.
   */
  async addTrade(tradeData: SheetRow): Promise<{ success: boolean; id: string; pending: boolean }> {
    const trade = normalizeTradeRow(tradeData);
    const id = getTradeId(trade);
    if (!id) throw new Error('A trade needs a stable ID before it can be saved.');
    if (!trade.Date || !trade.Ticker || Number(trade.Quantity) <= 0 || Number(trade.Price) <= 0) {
      throw new Error('Trade date, ticker, quantity, and price are required.');
    }

    const flow = buildTradeFlowRow(trade);
    const month = String(trade.Date).slice(0, 7);
    if (!flow || !/^\d{4}-\d{2}$/.test(month)) throw new Error('Could not build the linked investment Flow entry.');
    clearTradeHoldingTombstone(trade);
    this.optimisticAddRow('Trades', trade);
    this.optimisticAddRow(month, flow);
    persistTradeCache(getCachedTradeRows());

    const mutation = enqueuePendingMutation({
      mutationId: `mut_trade_${id}_${Date.now()}`,
      type: 'add',
      sheetName: 'Trades',
      rowId: id,
      rowData: { ...trade, _queueOperation: 'tradeUpsert' },
    });

    return trackActiveWrite('Trades', async () => {
      try {
        const response = await sheetsApi.addTrade(trade);
        if (!response.success) throw new Error('Google Sheets did not confirm the trade.');
        removePendingMutation(mutation.id);
        return { success: true, id, pending: false };
      } catch (error) {
        markPendingMutationFailed(mutation.id, error instanceof Error ? error.message : String(error));
        toast.info('Trade saved on this phone. It will sync to Google Sheets when connected.');
        return { success: true, id, pending: true };
      }
    });
  },

  /** Locally updates the trade and linked Flow row before queuing one upsert. */
  async updateTrade(rowIndex: number, tradeData: SheetRow): Promise<{ success: boolean; pending: boolean }> {
    const trade = normalizeTradeRow(tradeData);
    const id = getTradeId(trade);
    if (!id) throw new Error('A trade needs a stable ID before it can be updated.');
    const flow = buildTradeFlowRow(trade);
    if (!flow) throw new Error('Could not build the linked investment Flow entry.');

    clearTradeHoldingTombstone(trade);
    this.optimisticAddRow('Trades', trade);
    const month = String(trade.Date).slice(0, 7);
    this.optimisticAddRow(month, flow);
    persistTradeCache(getCachedTradeRows());

    const mutation = enqueuePendingMutation({
      mutationId: `mut_trade_update_${id}_${Date.now()}`,
      type: 'update',
      sheetName: 'Trades',
      rowIndex,
      rowId: id,
      rowData: { ...trade, _queueOperation: 'tradeUpsert' },
    });
    return trackActiveWrite('Trades', async () => {
      try {
        const response = await sheetsApi.addTrade(trade);
        if (!response.success) throw new Error('Google Sheets did not confirm the trade update.');
        removePendingMutation(mutation.id);
        return { success: true, pending: false };
      } catch (error) {
        markPendingMutationFailed(mutation.id, error instanceof Error ? error.message : String(error));
        toast.info('Trade update saved on this phone. It will sync to Google Sheets when connected.');
        return { success: true, pending: true };
      }
    });
  },

  /**
   * Rebuilds Moomoo Flow entries from the already-saved Trade History before
   * the slower broker history request starts. The local Flow rows and durable
   * repair mutation are written before contacting Google Sheets.
   */
  async queueMoomooFlowRepair(
    localTradeRows: SheetRow[]
  ): Promise<{ success: boolean; pending: boolean; result?: Record<string, unknown> }> {
    const flows = localTradeRows
      .filter((trade) => /Moomoo Auto-Sync/i.test(String(trade.Notes || trade.notes || '')))
      .map(normalizeTradeRow)
      .map(buildTradeFlowRow)
      .filter((flow): flow is SheetRow => Boolean(flow) && !isRecordTombstoned(String(flow?.Id || '')));

    const flowRowsByMonth = new Map<string, SheetRow[]>();
    for (const flow of flows) {
      const month = String(flow.Date || '').slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(month)) continue;
      ensureMonthInLocalMonthList(month);
      const rows = flowRowsByMonth.get(month) || [];
      rows.push({ ...flow, _month: month });
      flowRowsByMonth.set(month, rows);
    }

    flowRowsByMonth.forEach((incomingRows, month) => {
      const entry = getSwrCachedEntry<{ success: boolean; data: SheetDataPayload }>('getSheetData', { sheetName: month });
      const rows = new Map<string, SheetRow>();
      for (const row of entry?.data?.data?.rows || []) {
        const id = String(row.Id || row.id || '').trim();
        if (id) rows.set(id, row);
      }
      for (const flow of incomingRows) rows.set(String(flow.Id), flow);
      setSwrCachedData('getSheetData', { sheetName: month }, {
        success: true,
        data: {
          headers: entry?.data?.data?.headers || [
            'Id', 'Date', 'Type', 'Category', 'SubCategory', 'Description',
            'Amount', 'Currency', 'TripTag', 'ReceiptUrl', 'Notes',
          ],
          rows: [...rows.values()],
        },
      });
    });

    const mutationId = `mut_moomoo_flow_repair_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const mutation = enqueuePendingMutation({
      mutationId,
      type: 'add',
      sheetName: 'Trades',
      rowId: mutationId,
      rowData: { _queueOperation: 'moomooFlowReconcile', flows },
    });

    return trackActiveWrite('Trades', async () => {
      try {
        const response = await sheetsApi.syncMoomooFlows();
        if (!response.success) throw new Error(response.message || 'Google Sheets did not confirm the Moomoo Flow repair.');
        removePendingMutation(mutation.id);
        const result = response.data?.result && typeof response.data.result === 'object'
          ? response.data.result as Record<string, unknown>
          : response.data || {};
        return { success: true, pending: false, result };
      } catch (error) {
        markPendingMutationFailed(mutation.id, error instanceof Error ? error.message : String(error));
        toast.info('Existing Moomoo Flow entries are saved on this phone. Google Sheets repair is queued.');
        return { success: true, pending: true };
      }
    });
  },

  /**
   * Stores a Moomoo import and its Flow rows on-device first, then submits one
   * idempotent batch through the existing Sheets sync engine.
   */
  async queueMoomooTradeSync(
    incomingTrades: SheetRow[],
    fullLocalTrades: SheetRow[],
    options: { restoreDeletedMoomooTrades?: boolean; reconcileFlowHistory?: boolean; cleanupLegacyDeposits?: boolean }
  ): Promise<{ success: boolean; pending: boolean; result?: Record<string, unknown> }> {
    const stagedTrades = incomingTrades
      .map(normalizeTradeRow)
      .filter((trade) => {
        const id = getTradeId(trade);
        if (!id || !/^moo_/i.test(id)) return false;
        clearTradeHoldingTombstone(trade);
        if (options.restoreDeletedMoomooTrades) {
          clearDeletedTombstone(id);
          const flowId = buildTradeFlowRow(trade)?.Id;
          if (flowId) clearDeletedTombstone(String(flowId));
        }
        return options.restoreDeletedMoomooTrades || !isRecordTombstoned(id);
      });

    const merged = new Map<string, SheetRow>();
    for (const row of fullLocalTrades) {
      const id = getTradeId(row);
      if (id && !isRecordTombstoned(id)) merged.set(id, row);
    }
    for (const trade of stagedTrades) merged.set(getTradeId(trade), trade);
    const localRows = [...merged.values()];
    const tradeHeaders = ['Id', 'Date', 'Action', 'Ticker', 'Asset Name', 'Quantity', 'Price', 'Fees', 'Net Total', 'Currency', 'Notes'];

    const flowRowsByMonth = new Map<string, SheetRow[]>();
    for (const trade of stagedTrades) {
      const flow = buildTradeFlowRow(trade);
      if (!flow || isRecordTombstoned(String(flow.Id))) continue;
      const month = String(flow.Date).slice(0, 7);
      ensureMonthInLocalMonthList(month);
      const monthRows = flowRowsByMonth.get(month) || [];
      monthRows.push(flow);
      flowRowsByMonth.set(month, monthRows);
    }

    setSwrCachedData('getSheetData', { sheetName: 'Trades' }, {
      success: true,
      data: { headers: tradeHeaders, rows: localRows },
    });
    flowRowsByMonth.forEach((incomingRows, month) => {
      const entry = getSwrCachedEntry<{ success: boolean; data: SheetDataPayload }>('getSheetData', { sheetName: month });
      const rows = new Map<string, SheetRow>();
      for (const row of entry?.data?.data?.rows || []) {
        const id = String(row.Id || row.id || '').trim();
        if (id) rows.set(id, row);
      }
      for (const row of incomingRows) rows.set(String(row.Id), { ...row, _month: month });
      setSwrCachedData('getSheetData', { sheetName: month }, {
        success: true,
        data: {
          headers: entry?.data?.data?.headers || [
            'Id', 'Date', 'Type', 'Category', 'SubCategory', 'Description',
            'Amount', 'Currency', 'TripTag', 'ReceiptUrl', 'Notes',
          ],
          rows: [...rows.values()],
        },
      });
    });
    persistTradeCache(localRows);

    const mutationId = `mut_moomoo_sync_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const mutation = enqueuePendingMutation({
      mutationId,
      type: 'add',
      sheetName: 'Trades',
      rowId: mutationId,
      rowData: {
        _queueOperation: 'moomooSyncBatch',
        trades: stagedTrades,
        restoreDeletedMoomooTrades: options.restoreDeletedMoomooTrades === true,
        reconcileFlowHistory: options.reconcileFlowHistory === true,
        cleanupLegacyDeposits: options.cleanupLegacyDeposits === true,
      },
    });

    return trackActiveWrite('Trades', async () => {
      try {
        const response = await sheetsApi.syncMoomooTrades({
          trades: stagedTrades,
          restoreDeletedMoomooTrades: options.restoreDeletedMoomooTrades === true,
          reconcileFlowHistory: options.reconcileFlowHistory === true,
          cleanupLegacyDeposits: options.cleanupLegacyDeposits === true,
        });
        if (!response.success) throw new Error('Google Sheets did not confirm the Moomoo trade batch.');
        removePendingMutation(mutation.id);
        const result = response.data?.result && typeof response.data.result === 'object'
          ? response.data.result as Record<string, unknown>
          : response.data || {};
        return { success: true, pending: false, result };
      } catch (error) {
        markPendingMutationFailed(mutation.id, error instanceof Error ? error.message : String(error));
        toast.info('Moomoo trades saved on this phone. They will sync to Google Sheets when connected.');
        return { success: true, pending: true };
      }
    });
  },

  /**
   * Synchronous 0ms cache lookup for non-Transaction sheets (Trades, Trips, Invoices, Overview).
   */
  getInitialSheetData(sheetName: string): { data: SheetDataPayload; savedAt: number } | undefined {
    const entry = getSwrCachedEntry<{ success: boolean; data: SheetDataPayload }>('getSheetData', { sheetName });
    if (!entry?.data?.data) return undefined;
    return {
      data: {
        headers: entry.data.data.headers || [],
        rows: applyPendingMutations(entry.data.data.rows || [], sheetName),
      },
      savedAt: entry.savedAt,
    };
  },

  /**
   * Fetches transactions respecting targeted on-demand loading and the rolling 60-day cache policy:
   * 1. If a specific month (e.g. '2026-10') is requested: fetches ONLY that single month sheet.
   * 2. If a specific year (e.g. 'year-2026') is requested: fetches existing month tabs for that year.
   * 3. For normal dashboard / recent use: fetches the exact 3 rolling calendar months by tab name
   *    (immune to empty future tabs like 2026-11 / 2026-12), then warms recent months in background.
   * NEVER downloads 10 years of tabs unless 'all' is explicitly requested.
   */
  async getAllTransactions(selectedPeriod?: string): Promise<{ headers: string[]; rows: SheetRow[] }> {
    const rollingMonths = getRollingWindowMonths(3);

    // Case 1: Targeted single-month request (e.g. '2026-10', '2025-04')
    if (selectedPeriod && /^\d{4}-\d{2}$/.test(selectedPeriod)) {
      const res = await sheetsApi.getSheetData(selectedPeriod);
      if (!res.success || !res.data) {
        throw new Error(`Google Sheets did not return ${selectedPeriod}.`);
      }
      const rawRows = (res.data.rows || []).map((r: SheetRow) => ({ ...r, _month: selectedPeriod }));
      const mergedRows = applyPendingMutations(rawRows, selectedPeriod);
      if (mergedRows.length > rawRows.length) {
        setSwrCachedData('getSheetData', { sheetName: selectedPeriod }, {
          success: true,
          data: {
            headers: res.data.headers || [],
            rows: mergedRows,
          },
        });
      }
      return {
        headers: res.data.headers || [],
        rows: mergedRows,
      };
    }

    // Case 2: Targeted year request (e.g. 'year-2026')
    if (selectedPeriod && selectedPeriod.startsWith('year-')) {
      const year = selectedPeriod.replace('year-', '');
      const allMonths = await this.getMonthList();
      const localMonths = collectLocallyKnownMonths();
      const existingYearMonths = Array.from(new Set([...allMonths, ...localMonths]))
        .filter(m => m.startsWith(`${year}-`))
        .sort((a, b) => b.localeCompare(a));
      const targetMonths = existingYearMonths.length > 0
        ? existingYearMonths
        : Array.from({ length: 12 }, (_, idx) => `${year}-${String(12 - idx).padStart(2, '0')}`);

      const results = await Promise.all(
        targetMonths.map(async (m) => {
          const res = await sheetsApi.getSheetData(m);
          if (!res.success || !res.data) {
            throw new Error(`Google Sheets did not return ${m}.`);
          }
          const monthRows = applyPendingMutations(
            (res.data.rows || []).map((r: SheetRow) => ({ ...r, _month: m })),
            m
          );
          return { month: m, headers: res.data.headers || [], rows: monthRows };
        })
      );

      let headers: string[] = [];
      const combinedRows: SheetRow[] = [];
      for (const r of results) {
        if (headers.length === 0 && r.headers.length > 0) headers = r.headers;
        r.rows.forEach((row: SheetRow) => {
          combinedRows.push({ ...row, _month: r.month });
        });
      }

      return {
        headers,
        rows: applyPendingMutations(combinedRows, selectedPeriod),
      };
    }

    // Case 3: Explicit 'all' requested (full archive)
    if (selectedPeriod === 'all') {
      const res = await sheetsApi.getAllTransactions(true);
      if (!res.success || !res.data) {
        throw new Error('Google Sheets did not return the full transaction history.');
      }
      return {
        headers: res.data.headers || [],
        rows: applyPendingMutations(res.data.rows || [], selectedPeriod),
      };
    }

    // Case 4: Default Active Dashboard — Fetch the exact 3 rolling calendar months by tab name
    // (e.g. ['2026-10', '2026-09', '2026-08']) so future empty tabs (2026-11, 2026-12) never push out September/August.
    const results = await Promise.all(
      rollingMonths.map(async (m) => {
        const res = await sheetsApi.getSheetData(m);
        if (!res.success || !res.data) {
          throw new Error(`Google Sheets did not return ${m}.`);
        }
        return {
          month: m,
          headers: res.data.headers || [],
          rows: res.data.rows || [],
        };
      })
    );

    let headers: string[] = [];
    const combinedRows: SheetRow[] = [];
    const fetchedSet = new Set<string>();
    for (const r of results) {
      fetchedSet.add(r.month);
      if (headers.length === 0 && r.headers.length > 0) {
        headers = r.headers;
      }
      r.rows.forEach((row: SheetRow) => {
        combinedRows.push({ ...row, _month: r.month });
      });
    }

    // Also include any already-warmed months from the 12-month window so yearly trend charts stay complete
    for (const m of getRollingWindowMonths(12)) {
      if (fetchedSet.has(m)) continue;
      const entry = getSwrCachedEntry<{ success: boolean; data: SheetDataPayload }>('getSheetData', { sheetName: m });
      if (entry?.data?.data?.rows) {
        if (headers.length === 0 && entry.data.data.headers?.length) {
          headers = entry.data.data.headers;
        }
        entry.data.data.rows.forEach((row: SheetRow) => {
          combinedRows.push({ ...row, _month: m });
        });
      }
    }

    // Warm recent months in background so switching to earlier months in the year is 0ms instant
    scheduleBackgroundWarmRecentMonths();

    return {
      headers,
      rows: applyPendingMutations(combinedRows, selectedPeriod),
    };
  },

  /**
   * Read data for a specific sheet tab (Trades, Trips, Invoices, Overview, or a Month)
   */
  async getSheetData(sheetName: string): Promise<{ headers: string[]; rows: SheetRow[] }> {
    try {
      const res = await sheetsApi.getSheetData(sheetName);
      if (res.success && res.data) {
        let rawRows = res.data.rows || [];
        // Guard against empty Trades eviction if persistent trades or local cache already has valid trades
        if (sheetName === 'Trades' && rawRows.length === 0) {
          if (typeof window !== 'undefined') {
            try {
              const stored = localStorage.getItem('cashflow_persistent_trades');
              if (stored) {
                const parsed = JSON.parse(stored);
                if (Array.isArray(parsed) && parsed.length > 0) {
                  rawRows = parsed.filter((t: any) => {
                    const tId = String(t.Id || t.id || '');
                    const sym = String(t.Ticker || t.ticker || '').trim().toUpperCase();
                    return !isRecordTombstoned(tId) && !isRecordTombstoned(sym);
                  });
                }
              }
            } catch {
              // ignore
            }
          }
          if (rawRows.length === 0) {
            const cached = this.getInitialSheetData('Trades');
            if (cached?.data?.rows && cached.data.rows.length > 0) {
              rawRows = cached.data.rows.filter((t: any) => {
                const tId = String(t.Id || t.id || '');
                const sym = String(t.Ticker || t.ticker || '').trim().toUpperCase();
                return !isRecordTombstoned(tId) && !isRecordTombstoned(sym);
              });
            }
          }
        }
        // Strict category sanitation: all food and grocery expenses must be Food & Dining
        rawRows.forEach((r) => {
          const cat = r.Category || r.category;
          if (cat && isLegacyFoodOrGrocery(String(cat))) {
            if (r.Category !== undefined) r.Category = 'Food & Dining';
            if (r.category !== undefined) r.category = 'Food & Dining';
            if (r.Category === undefined && r.category === undefined) r.Category = 'Food & Dining';
          }
        });
        const mergedRows = applyPendingMutations(rawRows, sheetName);
        setSwrCachedData('getSheetData', { sheetName }, {
          success: true,
          data: {
            headers: res.data.headers || [],
            rows: mergedRows,
          },
        });
        return {
          headers: res.data.headers || [],
          rows: mergedRows,
        };
      }
    } catch (err) {
      console.warn(`[SheetsData] Failed to fetch sheet ${sheetName}:`, err);
    }

    const cached = this.getInitialSheetData(sheetName);
    if (cached) return cached.data;
    throw new Error(`Could not load ${sheetName} from Google Sheets and no cached copy is available.`);
  },

  /**
   * Month list from Google Sheets merged with any locally recorded/cached months
   */
  async getMonthList(): Promise<string[]> {
    const localMonths = collectLocallyKnownMonths();
    try {
      const res = await sheetsApi.getMonthList();
      if (res.success && Array.isArray(res.data)) {
        const merged = Array.from(new Set([...res.data, ...localMonths]))
          .filter((m) => /^\d{4}-\d{2}$/.test(m))
          .sort((a, b) => b.localeCompare(a));
        setSwrCachedData('getMonthList', {}, { success: true, data: merged });
        return merged;
      }
    } catch (err) {
      if (localMonths.length > 0) {
        return localMonths.sort((a, b) => b.localeCompare(a));
      }
      throw err;
    }
    throw new Error('Could not load the month list from Google Sheets.');
  },

  /**
   * Synchronously updates the localStorage SWR cache in-place (< 1ms) when adding a row,
   * avoiding full-cache wipes and multi-second refetch delays.
   */
  optimisticAddRow(sheetName: string, rowData: SheetRow): SheetRow {
    const tempId = String(rowData.Id || rowData.id || `tx_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`);
    if (tempId) {
      clearDeletedTombstone(tempId);
    }
    const dateStr = String(rowData.Date || rowData.date || '');
    const targetMonth = /^\d{4}-\d{2}$/.test(sheetName)
      ? sheetName
      : /^\d{4}-\d{2}/.test(String(rowData._month || ''))
        ? String(rowData._month).substring(0, 7)
        : /^\d{4}-\d{2}/.test(dateStr)
          ? dateStr.substring(0, 7)
          : '';

    const normalizedRow: SheetRow = {
      ...rowData,
      Id: tempId,
      id: tempId,
      ...(targetMonth ? { _month: targetMonth } : {}),
    };

    const swrSheet = targetMonth || sheetName;
    if (tempId && swrSheet) {
      inFlightOptimisticRows.set(tempId, {
        type: 'add',
        sheetName: swrSheet,
        rowId: tempId,
        rowData: normalizedRow,
        createdAt: Date.now(),
      });
    }
    if (targetMonth) {
      ensureMonthInLocalMonthList(targetMonth);
    }

    if (swrSheet && swrSheet !== 'Transactions') {
      const entry = getSwrCachedEntry<{ success: boolean; data: SheetDataPayload }>('getSheetData', { sheetName: swrSheet });
      const existingRows = entry?.data?.data?.rows || [];
      const headers = entry?.data?.data?.headers || [
        'Id', 'Date', 'Type', 'Category', 'SubCategory', 'Description',
        'Amount', 'Currency', 'BaseAmount', 'BaseCurrency', 'FxRateToBase',
        'TripTag', 'ReceiptUrl', 'Notes',
      ];
      const filtered = existingRows.filter((r: SheetRow) => String(r.Id || r.id || '') !== tempId);
      setSwrCachedData('getSheetData', { sheetName: swrSheet }, {
        success: true,
        data: {
          headers,
          rows: [normalizedRow, ...filtered],
        },
      });
    }

    return normalizedRow;
  },

  /**
   * Synchronously updates the localStorage SWR cache in-place (< 1ms) when updating a row.
   */
  optimisticUpdateRow(sheetName: string, rowIndex: number | undefined, rowData: SheetRow): SheetRow {
    const id = String(rowData.Id || rowData.id || '');
    const dateStr = String(rowData.Date || rowData.date || '');
    const targetMonth = /^\d{4}-\d{2}/.test(dateStr)
      ? dateStr.substring(0, 7)
      : /^\d{4}-\d{2}$/.test(String(rowData._month || ''))
        ? String(rowData._month)
        : /^\d{4}-\d{2}$/.test(sheetName)
          ? sheetName
          : '';

    const updatedRow: SheetRow = {
      ...rowData,
      ...(id ? { Id: id, id } : {}),
      ...(targetMonth ? { _month: targetMonth } : {}),
      ...(typeof rowIndex === 'number' ? { _rowIndex: rowIndex } : {}),
    };

    const swrSheet = targetMonth || sheetName;
    if (id && swrSheet) {
      const existingInFlight = inFlightOptimisticRows.get(id);
      inFlightOptimisticRows.set(id, {
        type: existingInFlight?.type === 'add' ? 'add' : 'update',
        // Keep the source sheet for the server update; rowData/_month carries
        // the destination month when an edit moves a transaction.
        sheetName: sheetName || swrSheet,
        rowId: id,
        rowData: existingInFlight ? { ...existingInFlight.rowData, ...updatedRow } : updatedRow,
        createdAt: Date.now(),
      });
    }
    if (targetMonth) {
      ensureMonthInLocalMonthList(targetMonth);
    }

    const candidateSheets = new Set<string>();
    if (sheetName && sheetName !== 'Transactions') candidateSheets.add(sheetName);
    if (targetMonth) candidateSheets.add(targetMonth);
    getRollingWindowMonths(12).forEach((m) => candidateSheets.add(m));

    candidateSheets.forEach((sName) => {
      const entry = getSwrCachedEntry<{ success: boolean; data: SheetDataPayload }>('getSheetData', { sheetName: sName });
      if (!entry?.data?.data?.rows) return;
      const rows = entry.data.data.rows;
      let changed = false;
      const nextRows = rows.map((r: SheetRow) => {
        const rId = String(r.Id || r.id || '');
        const matchById = Boolean(id && rId === id);
        const matchByIndex = !id && typeof rowIndex === 'number' && sName === (targetMonth || sheetName) && r._rowIndex === rowIndex;
        if (matchById || matchByIndex) {
          changed = true;
          return { ...r, ...updatedRow };
        }
        return r;
      });
      if (changed) {
        setSwrCachedData('getSheetData', { sheetName: sName }, {
          success: true,
          data: {
            headers: entry.data.data.headers || [],
            rows: nextRows,
          },
        });
      }
    });

    return updatedRow;
  },

  /**
   * Synchronously removes a row from the localStorage SWR cache in-place (< 1ms) and records its tombstone.
   */
  optimisticDeleteRow(sheetName: string, rowIndex?: number, id?: string): void {
    if (id) {
      inFlightOptimisticRows.delete(id);
      recordDeletedTombstone(id, 'transaction', sheetName);
    }

    const candidateSheets = new Set<string>();
    if (sheetName && sheetName !== 'Transactions') candidateSheets.add(sheetName);
    getRollingWindowMonths(12).forEach((m) => candidateSheets.add(m));

    candidateSheets.forEach((sName) => {
      const entry = getSwrCachedEntry<{ success: boolean; data: SheetDataPayload }>('getSheetData', { sheetName: sName });
      if (!entry?.data?.data?.rows) return;
      const rows = entry.data.data.rows;
      const nextRows = rows.filter((r: SheetRow) => {
        const rId = String(r.Id || r.id || '');
        if (id && rId) return rId !== id;
        if (!id && typeof rowIndex === 'number' && sName === sheetName) {
          return r._rowIndex !== rowIndex;
        }
        return true;
      });
        if (nextRows.length !== rows.length) {
        setSwrCachedData('getSheetData', { sheetName: sName }, {
          success: true,
          data: {
            headers: entry.data.data.headers || [],
            rows: nextRows,
          },
        });
      }
    });

    if (sheetName === 'Trades') {
      const portEntry = getSwrCachedEntry<Record<string, unknown>[] | { success: boolean; data: Record<string, unknown>[] }>('getPortfolio', {});
      const portRows = Array.isArray(portEntry?.data)
        ? portEntry.data
        : (portEntry?.data && 'data' in portEntry.data && Array.isArray((portEntry.data as any).data))
          ? (portEntry.data as any).data
          : null;
      if (Array.isArray(portRows) && id) {
        let ticker = '';
        if (id.startsWith('moo_holding_')) {
          ticker = id.replace(/^moo_holding_/i, '').split('_')[0].toUpperCase();
        }
        if (ticker) {
          const nextPort = portRows.filter((h: any) => String(h.ticker || h.Ticker || '').trim().toUpperCase() !== ticker);
          setSwrCachedData('getPortfolio', {}, nextPort);
        }
      }
    }
  },

  /**
   * Add a row with zero-drop offline queue safety, durable mutationId, and read-back verification.
   * If offline or Google Sheets times out, queues the mutation so it is NEVER discarded.
   */
  async addRow(sheetName: string, rowData: Record<string, unknown>): Promise<{ success: boolean; id: string; pending?: boolean }> {
    const tempId = String(rowData.Id || rowData.id || `tx_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`);
    const wasPreviouslyTombstoned = isRecordTombstoned(tempId);
    const mutationId = `mut_add_${tempId}_${Date.now()}`;
    const dateStr = String(rowData.Date || rowData.date || '');
    const effectiveSheetName =
      (!sheetName || sheetName === 'Transactions') && /^\d{4}-\d{2}/.test(dateStr)
        ? dateStr.substring(0, 7)
        : sheetName;

    const payload: Record<string, unknown> = {
      ...rowData,
      Id: tempId,
      id: tempId,
      ...(wasPreviouslyTombstoned || rowData._forceRestore ? { _forceRestore: true } : {}),
    };

    // Immediately update local SWR cache so UI and subsequent reads see the new row in 0ms
    this.optimisticAddRow(effectiveSheetName, payload);

    // Persist the outbox entry before the network request starts. If the page is
    // suspended while Apps Script is still responding, startup sync can replay it.
    const pendingMutation = enqueuePendingMutation({
      mutationId,
      type: 'add',
      sheetName: effectiveSheetName,
      rowId: tempId,
      rowData: payload,
    });

    return trackActiveWrite(effectiveSheetName, async () => {
        try {
          const res = await sheetsApi.addRow(effectiveSheetName, payload, mutationId);
          // If the user deleted this row while addRow was in flight, immediately clean it up on the server
          // and never re-insert it into the local cache.
          if (isRecordTombstoned(tempId)) {
            const cleanup = await sheetsApi.deleteRow(
              res.data?.sheet || effectiveSheetName,
              res.data?.rowIndex,
              tempId,
              `mut_del_cleanup_${tempId}_${Date.now()}`
            );
            if (!cleanup.success || cleanup.data?.verified === false) {
              throw new Error(cleanup.message || 'Could not remove a row deleted while its add was in flight.');
            }
            removePendingMutation(pendingMutation.id);
            return { success: true, id: tempId, pending: false };
          }

          const isVerified =
            res.success && res.data?.verified !== false && (!res.data?.verifiedId || res.data.verifiedId === tempId);
          if (isVerified) {
            if (typeof res.data?.rowIndex === 'number') {
              this.optimisticUpdateRow(res.data.sheet || effectiveSheetName, res.data.rowIndex, {
                ...payload,
                _rowIndex: res.data.rowIndex,
              });
            }
            removePendingMutation(pendingMutation.id);
            return { success: true, id: tempId, pending: false };
          }
          throw new Error(res.message || 'Google Sheets addRow was not verified on read-back');
        } catch (err) {
          // If the user already deleted this row while addRow was in flight, do not queue a stale add!
          if (isRecordTombstoned(tempId)) {
            removePendingMutation(pendingMutation.id);
            if (!getPendingMutations().some((item) => item.type === 'delete' && item.rowId === tempId)) {
              enqueuePendingMutation({
                mutationId: `mut_del_cleanup_${tempId}_${Date.now()}`,
                type: 'delete',
                sheetName: effectiveSheetName,
                rowId: tempId,
              });
            }
            return { success: true, id: tempId, pending: true };
          }
          console.warn(`[SheetsData] Add row failed, enqueuing to offline queue:`, err);
          markPendingMutationFailed(pendingMutation.id, err instanceof Error ? err.message : String(err));
          toast.info('Saved offline. Will sync to Google Sheets when connected.', {
            duration: 4000,
          });
          return { success: true, id: tempId, pending: true };
        }
    });
  },

  /**
   * Update a row with zero-drop offline queue safety, durable mutationId, and read-back verification.
   */
  async updateRow(sheetName: string, rowIndex: number, rowData: Record<string, unknown>): Promise<{ success: boolean; pending?: boolean; conflict?: boolean }> {
    const id = String(rowData.Id || rowData.id || '');
    const mutationId = `mut_upd_${id || rowIndex}_${Date.now()}`;
    const cacheRowData = { ...rowData };
    delete cacheRowData._baseData;

    // Immediately update local SWR cache in 0ms
    this.optimisticUpdateRow(sheetName, rowIndex, cacheRowData);

    // Keep the update durable while its cloud request is in flight, not only
    // after a timeout has already been detected.
    const pendingMutation = enqueuePendingMutation({
      mutationId,
      type: 'update',
      sheetName,
      rowIndex,
      rowId: id,
      rowData,
    });

    return trackActiveWrite(sheetName, async () => {
        try {
          const res = await sheetsApi.updateRow(sheetName, rowIndex, rowData, mutationId);
          if (res.data?.conflictDetected) {
            if (!res.data.serverRecord) {
              throw new Error('Server reported a transaction conflict without returning the server record');
            }
            const conflictSaved = recordTransactionUpdateConflict(
              rowData,
              res.data.serverRecord,
              res.data.conflictingFields || [],
              res.data.sheet || sheetName
            );
            if (!conflictSaved) {
              throw new Error('Could not persist both versions of the transaction conflict');
            }
            removePendingMutation(pendingMutation.id);
            return { success: false, pending: false, conflict: true };
          }
          const isVerified =
            res.success && res.data?.verified !== false && (!id || !res.data?.verifiedId || res.data.verifiedId === id);
          if (isVerified) {
            if (typeof res.data?.rowIndex === 'number') {
              this.optimisticUpdateRow(res.data.sheet || sheetName, res.data.rowIndex, {
                ...cacheRowData,
                _rowIndex: res.data.rowIndex,
              });
            }
            removePendingMutation(pendingMutation.id);
            return { success: true, pending: false };
          }

          const resMsg = String(res.message || '');
          if (resMsg.includes('not found') || resMsg.includes('Invalid row index')) {
            const isTombstoned = Boolean(id && isRecordTombstoned(id));
            const isExplicitRestore = Boolean(rowData && rowData._forceRestore);
            const policy = resolveNotFoundUpdatePolicy(id, isTombstoned, isExplicitRestore);

            if (policy.action === 'force_restore') {
              const fallbackPayload = id
                ? { ...rowData, Id: id, id, _forceRestore: true }
                : { ...rowData, _forceRestore: true };
              const fallbackAdd = await sheetsApi.addRow(sheetName, fallbackPayload, mutationId);
              if (fallbackAdd.success && fallbackAdd.data?.verified !== false) {
                if (typeof fallbackAdd.data?.rowIndex === 'number') {
                  this.optimisticUpdateRow(fallbackAdd.data.sheet || sheetName, fallbackAdd.data.rowIndex, {
                    ...rowData,
                    _rowIndex: fallbackAdd.data.rowIndex,
                  });
                }
                removePendingMutation(pendingMutation.id);
                return { success: true, pending: false };
              }
            } else {
              // Policy: discard_and_tombstone - Record was deleted on server by another device
              if (id) {
                const conflictSaved = recordDeletedTransactionUpdateConflict(id, sheetName, rowData, Date.now());
                if (!conflictSaved) {
                  throw new Error('Could not persist deleted-record conflict');
                }
                this.optimisticDeleteRow(sheetName, rowIndex, id);
                toast.warning('此记录已在云端被删除，未重新创建。您的离线修改已转存至冲突中心。');
              }
              removePendingMutation(pendingMutation.id);
              return { success: true, pending: false };
            }
          }

          throw new Error(res.message || 'Google Sheets updateRow was not verified on read-back');
        } catch (err) {
          if (id && isRecordTombstoned(id)) {
            removePendingMutation(pendingMutation.id);
            return { success: true, pending: false };
          }
          console.warn(`[SheetsData] Update row failed, enqueuing to offline queue:`, err);
          markPendingMutationFailed(pendingMutation.id, err instanceof Error ? err.message : String(err));
          toast.info('Updated offline. Will sync to Google Sheets when connected.', {
            duration: 4000,
          });
          return { success: true, pending: true };
        }
    });
  },

  /**
   * Delete a row with zero-drop offline queue safety, explicit 90-day tombstone, and read-back verification.
   */
  async deleteRow(sheetName: string, rowIndex?: number, id?: string): Promise<{ success: boolean; pending?: boolean }> {
    const mutationId = `mut_del_${id || rowIndex}_${Date.now()}`;
    const normalizedId = String(id || '').trim();
    const deletedTrade = sheetName === 'Trades' && normalizedId
      ? getCachedTradeRows().find((row) => getTradeId(row) === normalizedId) ||
        (!isRecordTombstoned(normalizedId) ? getPersistentTradeRow(normalizedId) : undefined)
      : undefined;
    const linkedFlow = deletedTrade ? buildTradeFlowRow(deletedTrade) : null;
    const pendingForId = id
      ? getPendingMutations().filter((m) => (m.type === 'add' || m.type === 'update') && m.rowId === id)
      : [];
    for (const pendingItem of pendingForId) {
      removePendingMutation(pendingItem.id);
    }

    // Immediately record tombstone and remove from local SWR cache in 0ms
    this.optimisticDeleteRow(sheetName, rowIndex, id);
    if (sheetName === 'Trades' && normalizedId) {
      const flowId = linkedFlow
        ? String(linkedFlow.Id)
        : `tx_trade_${normalizedId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
      const cachedMonths = collectLocallyKnownMonths();
      const month = linkedFlow
        ? String(linkedFlow.Date).slice(0, 7)
        : cachedMonths.find((candidate) =>
            getSwrCachedEntry<{ success: boolean; data: SheetDataPayload }>('getSheetData', { sheetName: candidate })
              ?.data?.data?.rows?.some((row) => String(row.Id || row.id || '') === flowId)
          ) || '';
      inFlightOptimisticRows.delete(flowId);
      recordDeletedTombstone(flowId, 'transaction', month || 'Transactions');
      this.optimisticDeleteRow(month || 'Transactions', undefined, flowId);
      for (const cachedMonth of cachedMonths) {
        const entry = getSwrCachedEntry<{ success: boolean; data: SheetDataPayload }>('getSheetData', { sheetName: cachedMonth });
        const rows = entry?.data?.data?.rows;
        if (!Array.isArray(rows)) continue;
        const nextRows = rows.filter((row) => String(row.Id || row.id || '') !== flowId);
        if (nextRows.length !== rows.length) {
          setSwrCachedData('getSheetData', { sheetName: cachedMonth }, {
            success: true,
            data: { headers: entry?.data?.data?.headers || [], rows: nextRows },
          });
        }
      }
      if (deletedTrade) {
        const ticker = tradeTicker(deletedTrade);
        const remainingTickerTrades = getCachedTradeRows().some((trade) =>
          tradeTicker(trade) === ticker && !isRecordTombstoned(getTradeId(trade))
        );
        if (ticker && !remainingTickerTrades) {
          const holdingId = `moo_holding_${ticker.toLowerCase()}_0`;
          recordDeletedTombstone(holdingId, 'trade', 'Portfolio');
          const portfolioEntry = getSwrCachedEntry<Record<string, unknown>[] | { success: boolean; data: Record<string, unknown>[] }>('getPortfolio', {});
          const portfolioRows = Array.isArray(portfolioEntry?.data)
            ? portfolioEntry.data
            : portfolioEntry?.data && 'data' in portfolioEntry.data
              ? portfolioEntry.data.data
              : null;
          if (portfolioRows) {
            setSwrCachedData('getPortfolio', {}, portfolioRows.filter((row) => tradeTicker(row) !== ticker));
          }
        }
      }
      persistTradeCache(getCachedTradeRows());
    }
    const pendingMutation = enqueuePendingMutation({
      mutationId,
      type: 'delete',
      sheetName,
      rowIndex,
      rowId: id,
    });

    return trackActiveWrite(sheetName, async () => {
        try {
          const res = await sheetsApi.deleteRow(sheetName, rowIndex, id, mutationId);
          const msg = String(res.message || '');
          const isAlreadyAbsent =
            Boolean(res.data?.alreadyDeleted) ||
            msg.includes('not found') ||
            msg.includes('No valid ID or rowIndex') ||
            msg.includes('Invalid row index');
          const isVerified = (res.success && res.data?.verified !== false) || isAlreadyAbsent;
          if (isVerified) {
            removePendingMutation(pendingMutation.id);
            return { success: true, pending: false };
          }
          throw new Error(res.message || 'Google Sheets deleteRow was not verified on read-back');
        } catch (err) {
          console.warn(`[SheetsData] Delete row failed, enqueuing to offline queue:`, err);
          markPendingMutationFailed(pendingMutation.id, err instanceof Error ? err.message : String(err));
          toast.info('Deleted offline. Will sync to Google Sheets when connected.', {
            duration: 4000,
          });
          return { success: true, pending: true };
        }
    });
  },

  /**
   * Flushes all pending offline mutations to Google Sheets with a single active sync mutex (P1 #10).
   */
  async flushPendingQueue(): Promise<{ total: number; succeeded: number; failed: number }> {
    if (activeWritePromises.size > 0) {
      await Promise.allSettled(Array.from(activeWritePromises));
    }

    if (flushInFlight) {
      flushFollowUpNeeded = true;
      return flushInFlight;
    }

    const runFlush = async (): Promise<{ total: number; succeeded: number; failed: number }> => {
      if (activeWritePromises.size > 0) {
        await Promise.allSettled(Array.from(activeWritePromises));
      }
      const queue = getPendingMutations();
      if (queue.length === 0) return { total: 0, succeeded: 0, failed: 0 };

      let succeeded = 0;
      let failed = 0;

      for (const item of queue) {
        const mutId = item.mutationId || item.id;
        const rowId = String(item.rowId || item.rowData?.Id || item.rowData?.id || '').trim();
        try {
          let ok = false;
          let errMessage = 'Server did not confirm write verification.';
          if (item.type === 'add') {
            if (!item.rowData) {
              ok = true;
            } else if (item.rowData._queueOperation === 'moomooSyncBatch') {
              const queuedTrades = Array.isArray(item.rowData.trades)
                ? (item.rowData.trades as SheetRow[]).filter((trade) => !isRecordTombstoned(getTradeId(trade)))
                : [];
              const res = await sheetsApi.syncMoomooTrades({
                trades: queuedTrades,
                restoreDeletedMoomooTrades: item.rowData.restoreDeletedMoomooTrades === true,
                reconcileFlowHistory: item.rowData.reconcileFlowHistory === true,
                cleanupLegacyDeposits: item.rowData.cleanupLegacyDeposits === true,
              });
              ok = Boolean(res.success);
              if (!ok && res.message) errMessage = res.message;
            } else if (item.rowData._queueOperation === 'moomooFlowReconcile') {
              const res = await sheetsApi.syncMoomooFlows();
              ok = Boolean(res.success);
              if (!ok && res.message) errMessage = res.message;
            } else if (item.rowData._queueOperation === 'tradeUpsert') {
              const tradeData = { ...item.rowData };
              delete tradeData._queueOperation;
              const res = await sheetsApi.addTrade(tradeData);
              ok = Boolean(res.success);
              if (!ok && res.message) errMessage = res.message;
            } else {
              // Check if this row was subsequently deleted by the user and is not in the local SWR cache
              const swrEntry = getSwrCachedEntry<{ success: boolean; data: SheetDataPayload }>('getSheetData', {
                sheetName: item.sheetName,
              });
              const existsInLocalCache = Boolean(
                rowId &&
                swrEntry?.data?.data?.rows?.some((r) => String(r.Id || r.id || '').trim() === rowId)
              );
              if (rowId && isRecordTombstoned(rowId) && !existsInLocalCache && !item.rowData._forceRestore) {
                ok = true;
              } else {
                if (rowId && existsInLocalCache) {
                  clearDeletedTombstone(rowId);
                }
                const addPayload = rowId
                  ? { ...item.rowData, Id: rowId, id: rowId, _forceRestore: true }
                  : item.rowData;
                const res = await sheetsApi.addRow(item.sheetName, addPayload, mutId);
                ok = Boolean(res.success && res.data?.verified !== false);
                if (!ok && res.message) errMessage = res.message;
              }
            }
          } else if (item.type === 'update') {
            const hasQueuedDelete = Boolean(
              rowId && queue.some((q) => q.type === 'delete' && String(q.rowId || '').trim() === rowId)
            );
            if (!item.rowData || (rowId && (isRecordTombstoned(rowId) || hasQueuedDelete))) {
              ok = true;
            } else if (item.rowData._queueOperation === 'tradeUpsert') {
              const tradeData = { ...item.rowData };
              delete tradeData._queueOperation;
              const res = await sheetsApi.addTrade(tradeData);
              ok = Boolean(res.success);
              if (!ok && res.message) errMessage = res.message;
            } else {
              const handleNotFoundUpdate = async (): Promise<boolean> => {
                if (!rowId && (!item.rowIndex || item.rowIndex <= 1)) {
                  return true;
                }
                const isTombstoned = Boolean(rowId && isRecordTombstoned(rowId));
                const isExplicitRestore = Boolean(item.rowData && item.rowData._forceRestore);
                const policy = resolveNotFoundUpdatePolicy(rowId, isTombstoned, isExplicitRestore);

                if (policy.action === 'force_restore') {
                  const fallbackAdd = await sheetsApi.addRow(
                    item.sheetName,
                    { ...item.rowData, ...(rowId ? { Id: rowId, id: rowId } : {}), _forceRestore: true },
                    mutId
                  );
                  return Boolean(fallbackAdd.success && fallbackAdd.data?.verified !== false);
                }

                // Policy: discard_and_tombstone - Record was deleted on server by another device
                if (rowId) {
                  const conflictSaved = recordDeletedTransactionUpdateConflict(
                    rowId,
                    item.sheetName,
                    item.rowData || {},
                    item.timestamp || Date.now()
                  );
                  if (!conflictSaved) {
                    toast.error('云端记录已删除，但本机存储空间不足，无法保存未同步编辑。该编辑仍保留在同步队列中；请释放存储空间后重试。');
                    return false;
                  }
                  this.optimisticDeleteRow(item.sheetName, item.rowIndex, rowId);
                  toast.warning('一笔离线修改的目标记录已在云端被删除，未复活该记录。原修改已转存至冲突中心。');
                }
                return true;
              };

              try {
                const res = await sheetsApi.updateRow(item.sheetName, item.rowIndex || 2, item.rowData, mutId);
                if (res.data?.conflictDetected && res.data.serverRecord) {
                  const conflictSaved = recordTransactionUpdateConflict(
                    item.rowData,
                    res.data.serverRecord,
                    res.data.conflictingFields || [],
                    res.data.sheet || item.sheetName,
                    item.timestamp || Date.now()
                  );
                  // The mutation is now durably preserved in the Conflict Store;
                  // remove it from the retry queue so it cannot overwrite either version.
                  ok = conflictSaved;
                  if (!ok) errMessage = 'Could not persist both versions of the transaction conflict.';
                } else {
                  ok = Boolean(res.success && res.data?.verified !== false);
                }
                if (!ok) {
                  const resMsg = String(res.message || '');
                  if (resMsg.includes('not found') || resMsg.includes('Invalid row index')) {
                    ok = await handleNotFoundUpdate();
                  } else if (resMsg) {
                    errMessage = resMsg;
                  }
                }
              } catch (updErr: unknown) {
                const updMsg = updErr instanceof Error ? updErr.message : String(updErr);
                if (updMsg.includes('not found') || updMsg.includes('Invalid row index')) {
                  ok = await handleNotFoundUpdate();
                } else {
                  throw updErr;
                }
              }
            }
          } else if (item.type === 'delete') {
            if (!rowId && (!item.rowIndex || item.rowIndex <= 1)) {
              ok = true;
            } else {
              const res = await sheetsApi.deleteRow(item.sheetName, item.rowIndex, rowId || undefined, mutId);
              const msg = String(res.message || '');
              const isAlreadyAbsent =
                Boolean(res.data?.alreadyDeleted) ||
                msg.includes('not found') ||
                msg.includes('No valid ID or rowIndex') ||
                msg.includes('Invalid row index');
              ok = Boolean((res.success && res.data?.verified !== false) || isAlreadyAbsent);
              if (!ok && res.message) errMessage = res.message;
            }
          }

          if (getPendingMutationDisposition(ok) === 'acknowledged') {
            removePendingMutation(item.id);
            succeeded++;
          } else {
            markPendingMutationFailed(item.id, errMessage);
            failed++;
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          if (
            item.type === 'delete' &&
            (msg.includes('not found') || msg.includes('No valid ID or rowIndex') || msg.includes('Invalid row index'))
          ) {
            removePendingMutation(item.id);
            succeeded++;
            continue;
          }
          console.warn(`[SheetsData] Failed to flush mutation ${item.id}:`, msg);
          markPendingMutationFailed(item.id, msg);
          failed++;
        }
      }

      if (succeeded > 0) {
        toast.success(`Synced & verified ${succeeded} pending offline change${succeeded > 1 ? 's' : ''} to Google Sheets! ☁️`);
      }

      if (flushFollowUpNeeded) {
        flushFollowUpNeeded = false;
        const followUp = await runFlush();
        return {
          total: queue.length + followUp.total,
          succeeded: succeeded + followUp.succeeded,
          failed: followUp.failed,
        };
      }

      return { total: queue.length, succeeded, failed };
    };

    flushInFlight = runFlush();
    return flushInFlight.finally(() => {
      flushInFlight = null;
      flushFollowUpNeeded = false;
    });
  },
};

/**
 * Optimistically applies pending mutations and 90-day deletion tombstones on top of raw fetched rows
 * so the user immediately sees pending adds, updates, and deletes in the UI, and deleted records
 * can never be resurrected by stale caches.
 */
function applyPendingMutations(rows: SheetRow[], targetSheet?: string): SheetRow[] {
  const pending = getPendingMutations();
  const tombstones = getDeletedTombstones();
  const hasTombstones = Object.keys(tombstones).length > 0;
  const now = Date.now();

  for (const [id, item] of inFlightOptimisticRows.entries()) {
    if (now - item.createdAt > IN_FLIGHT_RETENTION_MS || (id && tombstones[id])) {
      inFlightOptimisticRows.delete(id);
    }
  }

  if (pending.length === 0 && inFlightOptimisticRows.size === 0 && !hasTombstones) return rows;

  let result = hasTombstones
    ? rows.filter((r) => {
        const rowId = String(r.Id || r.id || '');
        return !rowId || !tombstones[rowId];
      })
    : [...rows];

  const matchesTargetSheet = (sheetName: string, mutMonth: string): boolean => {
    if (!targetSheet || targetSheet === 'Transactions' || targetSheet === 'all') {
      return true;
    }
    if (targetSheet.startsWith('year-')) {
      const yrPrefix = `${targetSheet.slice(5)}-`;
      return sheetName.startsWith(yrPrefix) || mutMonth.startsWith(yrPrefix);
    }
    return sheetName === targetSheet || mutMonth === targetSheet;
  };

  const applyPendingTrade = (rawTrade: SheetRow) => {
    const trade = normalizeTradeRow(rawTrade);
    delete trade._queueOperation;
    const tradeId = getTradeId(trade);
    if (!tradeId || isRecordTombstoned(tradeId)) return;

    // Trade History is its own sheet. Only the linked Flow record belongs in
    // month/year/Transactions reads, otherwise a trade is counted twice.
    if (targetSheet === 'Trades') {
      const existingTradeIndex = result.findIndex((row) => getTradeId(row) === tradeId);
      const pendingTrade = { ...trade, _pendingSync: true };
      if (existingTradeIndex >= 0) result[existingTradeIndex] = { ...result[existingTradeIndex], ...pendingTrade };
      else result.unshift(pendingTrade);
    }

    const flow = buildTradeFlowRow(trade);
    if (!flow || isRecordTombstoned(String(flow.Id))) return;
    const flowMonth = String(flow.Date).slice(0, 7);
    if (!matchesTargetSheet(flowMonth, flowMonth)) return;

    const pendingFlow = { ...flow, _pendingSync: true, _month: flowMonth };
    const existingFlowIndex = result.findIndex((row) => String(row.Id || row.id || '') === String(flow.Id));
    if (existingFlowIndex >= 0) result[existingFlowIndex] = { ...result[existingFlowIndex], ...pendingFlow };
    else result.unshift(pendingFlow);
  };

  const applyPendingFlow = (rawFlow: SheetRow) => {
    const id = String(rawFlow.Id || rawFlow.id || '').trim();
    const month = String(rawFlow.Date || rawFlow.date || '').slice(0, 7);
    if (!id || !month || isRecordTombstoned(id) || !matchesTargetSheet(month, month)) return;
    const flow = { ...rawFlow, _pendingSync: true, _month: month };
    const existingIndex = result.findIndex((row) => String(row.Id || row.id || '') === id);
    if (existingIndex >= 0) result[existingIndex] = { ...result[existingIndex], ...flow };
    else result.unshift(flow);
  };

  for (const [, inflight] of inFlightOptimisticRows.entries()) {
    const mutDateStr = String(inflight.rowData?.Date || inflight.rowData?.date || '');
    const mutMonth =
      /^\d{4}-\d{2}/.test(mutDateStr)
        ? mutDateStr.substring(0, 7)
        : /^\d{4}-\d{2}$/.test(String(inflight.rowData?._month || ''))
          ? String(inflight.rowData?._month).substring(0, 7)
          : inflight.sheetName;

    if (!matchesTargetSheet(inflight.sheetName, mutMonth)) {
      continue;
    }

    if (inflight.type === 'add') {
      const alreadyHas = result.some((r) => String(r.Id || r.id || '') === inflight.rowId);
      if (!alreadyHas) {
        result.unshift({
          ...inflight.rowData,
          _month: mutMonth || inflight.sheetName,
        });
      }
    } else if (inflight.type === 'update') {
      result = applyPendingTransactionUpdate(
        result,
        targetSheet,
        inflight.sheetName,
        inflight.rowId,
        inflight.rowData,
      );
    }
  }

  for (const m of pending) {
    if (m.rowData?._queueOperation === 'moomooSyncBatch') {
      const queuedTrades = Array.isArray(m.rowData.trades) ? m.rowData.trades as SheetRow[] : [];
      queuedTrades.forEach(applyPendingTrade);
      continue;
    }
    if (m.rowData?._queueOperation === 'moomooFlowReconcile') {
      const queuedFlows = Array.isArray(m.rowData.flows) ? m.rowData.flows as SheetRow[] : [];
      queuedFlows.forEach(applyPendingFlow);
      continue;
    }
    if (m.rowData?._queueOperation === 'tradeUpsert') {
      applyPendingTrade(m.rowData);
      continue;
    }
    const mutDateStr = String(m.rowData?.Date || m.rowData?.date || '');
    const mutMonth =
      /^\d{4}-\d{2}/.test(mutDateStr)
        ? mutDateStr.substring(0, 7)
        : /^\d{4}-\d{2}$/.test(String(m.rowData?._month || ''))
          ? String(m.rowData?._month).substring(0, 7)
          : m.sheetName;

    if (!matchesTargetSheet(m.sheetName, mutMonth)) {
      continue;
    }

    if (m.type === 'add' && m.rowData) {
      const alreadyHas = result.some((r) => (r.Id || r.id) === (m.rowData!.Id || m.rowData!.id));
      if (!alreadyHas) {
        const rowData = { ...m.rowData };
        delete rowData._queueOperation;
        result.unshift({
          ...rowData,
          _pendingSync: true,
          _month: mutMonth || m.sheetName,
        });
      }
    } else if (m.type === 'update' && m.rowData) {
      const id = String(m.rowId || m.rowData.Id || m.rowData.id || '');
      result = applyPendingTransactionUpdate(
        result,
        targetSheet,
        m.sheetName,
        id,
        m.rowData,
        true,
      );
    } else if (m.type === 'delete') {
      const id = m.rowId;
      if (id) {
        result = result.filter((r) => (r.Id || r.id) !== id);
      }
    }
  }

  // Strict category sanitation across all pending and merged transactions
  result.forEach((r) => {
    const cat = r.Category || r.category;
    if (cat && isLegacyFoodOrGrocery(String(cat))) {
      if (r.Category !== undefined) r.Category = 'Food & Dining';
      if (r.category !== undefined) r.category = 'Food & Dining';
      if (r.Category === undefined && r.category === undefined) r.Category = 'Food & Dining';
    }
  });

  return result;
}
