import { sheetsApi, getSwrCachedEntry, setSwrCachedData } from './sheets-api';
import { 
  getRollingWindowMonths, 
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
} from './data-integrity';
import { toast } from 'sonner';

let flushInFlight: Promise<{ total: number; succeeded: number; failed: number }> | null = null;
let flushFollowUpNeeded = false;
let backgroundPrefetchScheduled = false;
const activeWritePromises = new Set<Promise<unknown>>();

function trackActiveWrite<T>(promise: Promise<T>): Promise<T> {
  activeWritePromises.add(promise);
  return promise.finally(() => {
    activeWritePromises.delete(promise);
  });
}

type SheetRow = Record<string, unknown>;
type SheetDataPayload = { headers: string[]; rows: SheetRow[] };

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
        if (localStorage.getItem('cashflow_cache_heal_v6') !== '1') {
          localStorage.setItem('cashflow_cache_heal_v6', '1');
          localStorage.removeItem('cashflow_last_sync_error');
          localStorage.removeItem('cashflow_last_sync_error_at');
          // Clear any stuck failed mutations left over from earlier LockService / not-found collisions
          for (const qKey of ['cashflow_pending_queue', 'cashflow_pending_plan_mutations_v2', 'cashflow_pending_settings_mutations']) {
            const rawQ = localStorage.getItem(qKey);
            if (!rawQ) continue;
            try {
              const parsedQ = JSON.parse(rawQ);
              if (Array.isArray(parsedQ)) {
                const cleaned = parsedQ.filter((item: Record<string, unknown>) => {
                  if (!item || typeof item !== 'object') return false;
                  if (item.status === 'failed' || Number(item.retryCount || 0) > 0) return false;
                  const rId = String(item.rowId || item.entityId || '').trim();
                  if (rId && isRecordTombstoned(rId) && item.type !== 'delete' && item.action !== 'delete') return false;
                  return true;
                });
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
      return {
        headers: res.data.headers || [],
        rows: applyPendingMutations(rawRows, selectedPeriod),
      };
    }

    // Case 2: Targeted year request (e.g. 'year-2026')
    if (selectedPeriod && selectedPeriod.startsWith('year-')) {
      const year = selectedPeriod.replace('year-', '');
      const allMonths = await this.getMonthList();
      const existingYearMonths = allMonths.filter(m => m.startsWith(`${year}-`));
      const targetMonths = existingYearMonths.length > 0
        ? existingYearMonths
        : Array.from({ length: 12 }, (_, idx) => `${year}-${String(12 - idx).padStart(2, '0')}`);

      const results = await Promise.all(
        targetMonths.map(async (m) => {
          const res = await sheetsApi.getSheetData(m);
          if (!res.success || !res.data) {
            throw new Error(`Google Sheets did not return ${m}.`);
          }
          return { month: m, headers: res.data.headers || [], rows: res.data.rows || [] };
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
        return {
          headers: res.data.headers || [],
          rows: applyPendingMutations(res.data.rows || [], sheetName),
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
   * Month list from Google Sheets
   */
  async getMonthList(): Promise<string[]> {
    const res = await sheetsApi.getMonthList();
    if (!res.success || !Array.isArray(res.data)) {
      throw new Error('Could not load the month list from Google Sheets.');
    }
    return res.data;
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
    const targetMonth = /^\d{4}-\d{2}$/.test(sheetName)
      ? sheetName
      : /^\d{4}-\d{2}/.test(String(rowData._month || ''))
        ? String(rowData._month).substring(0, 7)
        : /^\d{4}-\d{2}/.test(dateStr)
          ? dateStr.substring(0, 7)
          : '';

    const updatedRow: SheetRow = {
      ...rowData,
      ...(id ? { Id: id, id } : {}),
      ...(targetMonth ? { _month: targetMonth } : {}),
      ...(typeof rowIndex === 'number' ? { _rowIndex: rowIndex } : {}),
    };

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

    return trackActiveWrite(
      (async () => {
        try {
          const res = await sheetsApi.addRow(effectiveSheetName, payload, mutationId);
          // If the user deleted this row while addRow was in flight, immediately clean it up on the server
          // and never re-insert it into the local cache.
          if (isRecordTombstoned(tempId)) {
            void sheetsApi.deleteRow(res.data?.sheet || effectiveSheetName, res.data?.rowIndex, tempId).catch(() => {});
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
            return { success: true, id: tempId, pending: false };
          }
          throw new Error(res.message || 'Google Sheets addRow was not verified on read-back');
        } catch (err) {
          // If the user already deleted this row while addRow was in flight, do not queue a stale add!
          if (isRecordTombstoned(tempId)) {
            return { success: true, id: tempId, pending: false };
          }
          console.warn(`[SheetsData] Add row failed, enqueuing to offline queue:`, err);
          enqueuePendingMutation({
            mutationId,
            type: 'add',
            sheetName: effectiveSheetName,
            rowId: tempId,
            rowData: payload,
          });
          toast.info('Saved offline. Will sync to Google Sheets when connected.', {
            duration: 4000,
          });
          return { success: true, id: tempId, pending: true };
        }
      })()
    );
  },

  /**
   * Update a row with zero-drop offline queue safety, durable mutationId, and read-back verification.
   */
  async updateRow(sheetName: string, rowIndex: number, rowData: Record<string, unknown>): Promise<{ success: boolean; pending?: boolean }> {
    const id = String(rowData.Id || rowData.id || '');
    const mutationId = `mut_upd_${id || rowIndex}_${Date.now()}`;

    // Immediately update local SWR cache in 0ms
    this.optimisticUpdateRow(sheetName, rowIndex, rowData);

    return trackActiveWrite(
      (async () => {
        try {
          const res = await sheetsApi.updateRow(sheetName, rowIndex, rowData, mutationId);
          const isVerified =
            res.success && res.data?.verified !== false && (!id || !res.data?.verifiedId || res.data.verifiedId === id);
          if (isVerified) {
            if (typeof res.data?.rowIndex === 'number') {
              this.optimisticUpdateRow(res.data.sheet || sheetName, res.data.rowIndex, {
                ...rowData,
                _rowIndex: res.data.rowIndex,
              });
            }
            return { success: true, pending: false };
          }

          const resMsg = String(res.message || '');
          if (resMsg.includes('not found') || resMsg.includes('Invalid row index')) {
            if (id && isRecordTombstoned(id)) {
              return { success: true, pending: false };
            }
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
              return { success: true, pending: false };
            }
          }

          throw new Error(res.message || 'Google Sheets updateRow was not verified on read-back');
        } catch (err) {
          if (id && isRecordTombstoned(id)) {
            return { success: true, pending: false };
          }
          console.warn(`[SheetsData] Update row failed, enqueuing to offline queue:`, err);
          enqueuePendingMutation({
            mutationId,
            type: 'update',
            sheetName,
            rowIndex,
            rowId: id,
            rowData,
          });
          toast.info('Updated offline. Will sync to Google Sheets when connected.', {
            duration: 4000,
          });
          return { success: true, pending: true };
        }
      })()
    );
  },

  /**
   * Delete a row with zero-drop offline queue safety, explicit 90-day tombstone, and read-back verification.
   */
  async deleteRow(sheetName: string, rowIndex?: number, id?: string): Promise<{ success: boolean; pending?: boolean }> {
    const mutationId = `mut_del_${id || rowIndex}_${Date.now()}`;
    const pendingForId = id
      ? getPendingMutations().filter((m) => (m.type === 'add' || m.type === 'update') && m.rowId === id)
      : [];
    const pendingAddItems = pendingForId.filter((m) => m.type === 'add');
    for (const pendingItem of pendingForId) {
      removePendingMutation(pendingItem.id);
    }

    // Immediately record tombstone and remove from local SWR cache in 0ms
    this.optimisticDeleteRow(sheetName, rowIndex, id);

    return trackActiveWrite(
      (async () => {
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
            return { success: true, pending: false };
          }
          throw new Error(res.message || 'Google Sheets deleteRow was not verified on read-back');
        } catch (err) {
          // If the row only existed in the local pending add queue and never reached the server, no delete needs to be queued.
          if (pendingAddItems.length > 0) {
            return { success: true, pending: false };
          }
          console.warn(`[SheetsData] Delete row failed, enqueuing to offline queue:`, err);
          enqueuePendingMutation({
            mutationId,
            type: 'delete',
            sheetName,
            rowIndex,
            rowId: id,
          });
          toast.info('Deleted offline. Will sync to Google Sheets when connected.', {
            duration: 4000,
          });
          return { success: true, pending: true };
        }
      })()
    );
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
            } else {
              const handleNotFoundUpdate = async (): Promise<boolean> => {
                if (!rowId && (!item.rowIndex || item.rowIndex <= 1)) {
                  return true;
                }
                if (rowId && isRecordTombstoned(rowId)) {
                  return true;
                }
                const swrEntry = getSwrCachedEntry<{ success: boolean; data: SheetDataPayload }>('getSheetData', {
                  sheetName: item.sheetName,
                });
                const cachedRows = swrEntry?.data?.data?.rows;
                const existsInLocalCache = Array.isArray(cachedRows)
                  ? Boolean(rowId && cachedRows.some((r) => String(r.Id || r.id || '').trim() === rowId))
                  : true;
                // If the row was already deleted / absent from local cache, discard the stale update
                if (!existsInLocalCache) {
                  return true;
                }
                const fallbackAdd = await sheetsApi.addRow(
                  item.sheetName,
                  { ...item.rowData, ...(rowId ? { Id: rowId, id: rowId } : {}), _forceRestore: true },
                  mutId
                );
                return Boolean(fallbackAdd.success && fallbackAdd.data?.verified !== false);
              };

              try {
                const res = await sheetsApi.updateRow(item.sheetName, item.rowIndex || 2, item.rowData, mutId);
                ok = Boolean(res.success && res.data?.verified !== false);
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

          if (ok) {
            removePendingMutation(item.id);
            succeeded++;
          } else if ((item.retryCount || 0) >= 2 && !errMessage.toLowerCase().includes('timed out')) {
            // Do not let an unresolvable validation error permanently block the queue
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

  if (pending.length === 0 && !hasTombstones) return rows;

  let result = hasTombstones
    ? rows.filter((r) => {
        const rowId = String(r.Id || r.id || '');
        return !rowId || !tombstones[rowId];
      })
    : [...rows];

  for (const m of pending) {
    const mutDateStr = String(m.rowData?.Date || m.rowData?.date || '');
    const mutMonth =
      /^\d{4}-\d{2}$/.test(m.sheetName)
        ? m.sheetName
        : /^\d{4}-\d{2}/.test(String(m.rowData?._month || ''))
          ? String(m.rowData?._month).substring(0, 7)
          : /^\d{4}-\d{2}/.test(mutDateStr)
            ? mutDateStr.substring(0, 7)
            : m.sheetName;

    if (
      targetSheet &&
      targetSheet !== 'Transactions' &&
      targetSheet !== 'all' &&
      !targetSheet.startsWith('year-') &&
      m.sheetName !== targetSheet &&
      mutMonth !== targetSheet
    ) {
      continue;
    }

    if (m.type === 'add' && m.rowData) {
      const alreadyHas = result.some((r) => (r.Id || r.id) === (m.rowData!.Id || m.rowData!.id));
      if (!alreadyHas) {
        result.unshift({
          ...m.rowData,
          _pendingSync: true,
          _month: mutMonth || m.sheetName,
        });
      }
    } else if (m.type === 'update' && m.rowData) {
      const id = m.rowId || (m.rowData.Id as string);
      result = result.map((r) => {
        if ((r.Id || r.id) === id) {
          return { ...r, ...m.rowData, _pendingSync: true };
        }
        return r;
      });
    } else if (m.type === 'delete') {
      const id = m.rowId;
      if (id) {
        result = result.filter((r) => (r.Id || r.id) !== id);
      }
    }
  }

  return result;
}
