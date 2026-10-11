
/**
 * Cache Manager & Offline Pending Queue for CashFlow
 * 
 * Policy:
 * 1. Rolling 60-day / 3-month window cached on device for normal use.
 * 2. Older history loaded from Google Sheets on demand.
 * 3. Settings and pending offline mutations are STRICTLY PROTECTED from expiry.
 * 4. Zero silent drops: all failed writes are queued and retried when connected.
 */

export interface PendingMutation {
  id: string;
  mutationId?: string;
  type: 'add' | 'update' | 'delete';
  sheetName: string;
  rowIndex?: number;
  rowId?: string;
  rowData?: Record<string, unknown>;
  timestamp: number;
  retryCount: number;
  status?: 'pending' | 'failed';
  lastError?: string;
}

export interface CachedMonthData {
  sheetName: string;
  timestamp: number;
  headers: string[];
  rows: Record<string, unknown>[];
}

export interface PendingSettingMutation {
  mutationId: string;
  key: string;
  value: string;
  changedAt: number;
  retryCount?: number;
  status?: 'pending' | 'failed';
  lastError?: string;
}

export const CACHE_KEYS = {
  PENDING_QUEUE: 'cashflow_pending_queue',
  PENDING_PLAN_QUEUE: 'cashflow_pending_plan_mutations_v2',
  PENDING_SETTINGS_QUEUE: 'cashflow_pending_settings_mutations',
  LAST_SYNCED_AT: 'cashflow_last_synced_at',
  CACHE_TIMESTAMP_PREFIX: 'cashflow_cache_time_',
  MONTH_CACHE_PREFIX: 'cashflow_month_',
} as const;

export const LOCAL_ONLY_ENDPOINT_SENTINEL = '__cashflow_local_only__';

export const SYNC_STATUS_EVENT = 'cashflow_sync_status_changed';

// Keys that must NEVER be expired or pruned from localStorage
export const PROTECTED_STORAGE_KEYS = new Set<string>([
  'cashflow_apps_script_url',
  'cashflow_api_key',
  'cashflow_server_proxy_token',
  'cashflow_use_server_proxy',
  'cashflow_installment_plans',
  'cashflow_recurring_commitments',
  'cashflow_category_caps',
  'cashflow_monthly_budget',
  'cashflow_baseline_income',
  'cashflow_emergency_reserve',
  'cashflow_currency',
  'cashflow_pending_queue',
  // This is the primary database when the app is in local-only mode, not a cache.
  'cashflow_local_store',
  'cashflow_pending_plan_mutations_v2',
  'cashflow_pending_settings_mutations',
  'cashflow_deleted_tombstones_v1',
  'cashflow_sync_conflicts_v1',
  'cashflow_integrity_baseline_v1',
  'cashflow_pre_migration_backup_ran_v2',
  'cashflow_pre_migration_backup_error_v1',
  'cashflow_last_synced_at',
  'cashflow_last_sync_error',
  'cashflow_last_sync_error_at',
  'cashflow_last_backup_check_at',
  'cashflow_cache_heal_v3',
  'cashflow_cache_heal_v4',
  'cashflow_cache_heal_v5',
  'cashflow_cache_heal_v6',
  'cashflow_lhdn_tax_caps',
  'cashflow_lhdn_tax_rate',
  'cashflow_lhdn_tax_profile',
  'cashflow_custom_pin',
  'cashflow_trusted_device',
  'cashflow_banner_dismissed',
  'cashflow_test_mode',
]);

export const CACHE_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
export const SWR_CACHE_PREFIX = 'cashflow_swr_';
export const MAX_SWR_CACHE_ENTRIES = 36;
export const MAX_SWR_CACHE_BYTES = 4 * 1024 * 1024; // 4 MB cap for cached responses

/**
 * Returns the rolling 3-month window in YYYY-MM format:
 * e.g. for Oct 2026 -> ['2026-10', '2026-09', '2026-08']
 */
export function getRollingWindowMonths(count: number = 3): string[] {
  const result: string[] = [];
  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth(); // 0-indexed

  for (let i = 0; i < count; i++) {
    const d = new Date(curYear, curMonth - i, 1);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    result.push(`${yyyy}-${mm}`);
  }
  return result;
}

/**
 * Checks if a given month is within the normal rolling cache window.
 */
export function isMonthInRollingWindow(monthStr: string, windowCount: number = 3): boolean {
  if (!/^\d{4}-\d{2}$/.test(monthStr)) return false;
  const windowMonths = getRollingWindowMonths(windowCount);
  return windowMonths.includes(monthStr);
}

/**
 * Scans localStorage and prunes expired cached entries,
 * and enforces a strict entry count + byte size LRU budget on SWR cache keys.
 * NEVER deletes protected settings, connection credentials, plan backups, tombstones,
 * conflicts, or any month cache with unconfirmed pending mutations (P2 #17).
 */
export function pruneExpiredCache(): { prunedKeys: string[] } {
  if (typeof window === 'undefined') return { prunedKeys: [] };

  const prunedKeys: string[] = [];
  const now = Date.now();
  const rollingMonths = new Set(getRollingWindowMonths(12));
  const unsyncedMonths = new Set(
    getPendingMutations()
      .map((m) => m.sheetName)
      .filter((s) => Boolean(s))
  );

  try {
    const keysToCheck: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) keysToCheck.push(key);
    }

    const activeSwrEntries: Array<{ key: string; savedAt: number; bytes: number }> = [];

    keysToCheck.forEach((key) => {
      // 1. NEVER prune protected keys, device migration markers, or plan recovery backups
      if (
        PROTECTED_STORAGE_KEYS.has(key) ||
        key.startsWith('cashflow_pre_sync_plan_backup_v2_') ||
        key.startsWith('cashflow_sync_v3_device_checked_')
      ) {
        return;
      }

      // 2. Check both actual SWR cache keys ('cashflow_swr_...') and legacy 'swr:' keys
      if (key.startsWith(SWR_CACHE_PREFIX) || key.startsWith('swr:')) {
        if (key.startsWith('swr:')) {
          localStorage.removeItem(key);
          prunedKeys.push(key);
          return;
        }

        // Never retain unbounded full-history transaction dumps in SWR cache
        if (key.includes('getAllTransactions') && key.includes('"all":true')) {
          localStorage.removeItem(key);
          prunedKeys.push(key);
          return;
        }

        // Check if this SWR cache belongs to a month with unconfirmed pending edits
        const monthMatch = key.match(/"(?:sheetName|month)":\s*"(\d{4}-\d{2})"/);
        const matchedMonth = monthMatch && monthMatch[1] ? monthMatch[1] : null;
        if (matchedMonth && unsyncedMonths.has(matchedMonth)) {
          // Strictly protect any month with unconfirmed pending edits from expiry or LRU eviction
          return;
        }

        // Check 60-day TTL and collect size metadata for LRU budget enforcement
        try {
          const raw = localStorage.getItem(key);
          if (!raw) return;
          const parsed = JSON.parse(raw);
          const savedAt = typeof parsed?.savedAt === 'number'
            ? parsed.savedAt
            : typeof parsed?.timestamp === 'number'
              ? parsed.timestamp
              : null;

          if (savedAt !== null) {
            if (now - savedAt > CACHE_MAX_AGE_MS) {
              localStorage.removeItem(key);
              prunedKeys.push(key);
              return;
            }
            activeSwrEntries.push({ key, savedAt, bytes: raw.length * 2 });
          } else {
            // Upgrade legacy unwrapped SWR entry with a timestamp so 60-day TTL applies
            const wrapped = JSON.stringify({
              __swrVersion: 1,
              savedAt: now,
              data: parsed,
            });
            localStorage.setItem(key, wrapped);
            activeSwrEntries.push({ key, savedAt: now, bytes: wrapped.length * 2 });
          }
        } catch {
          localStorage.removeItem(key);
          prunedKeys.push(key);
          return;
        }
        return;
      }

      // 3. Check custom month cache keys
      if (key.startsWith(CACHE_KEYS.MONTH_CACHE_PREFIX)) {
        const monthPart = key.replace(CACHE_KEYS.MONTH_CACHE_PREFIX, '');
        if (unsyncedMonths.has(monthPart)) {
          return;
        }
        if (/^\d{4}-\d{2}$/.test(monthPart) && !rollingMonths.has(monthPart)) {
          localStorage.removeItem(key);
          prunedKeys.push(key);
          return;
        }

        // Check 60-day timestamp
        try {
          const raw = localStorage.getItem(key);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed.timestamp && now - parsed.timestamp > CACHE_MAX_AGE_MS) {
              localStorage.removeItem(key);
              prunedKeys.push(key);
              return;
            }
          }
        } catch {
          localStorage.removeItem(key);
          prunedKeys.push(key);
          return;
        }
      }
    });

    // 4. Enforce SWR cache entry count (24) and total byte size cap (2 MB) via LRU (newest savedAt kept)
    activeSwrEntries.sort((a, b) => b.savedAt - a.savedAt);
    let cumulativeBytes = 0;
    activeSwrEntries.forEach((entry, index) => {
      cumulativeBytes += entry.bytes;
      if (index >= MAX_SWR_CACHE_ENTRIES || cumulativeBytes > MAX_SWR_CACHE_BYTES) {
        localStorage.removeItem(entry.key);
        prunedKeys.push(entry.key);
      }
    });

    if (prunedKeys.length > 0) {
      console.log(`[CacheManager] Pruned ${prunedKeys.length} expired/out-of-window/oversized cache items.`);
    }
  } catch (err) {
    console.warn('[CacheManager] Error pruning cache:', err);
  }

  return { prunedKeys };
}

// --- Pending Offline Mutation Queue ---

export function coalescePendingMutations(list: PendingMutation[]): PendingMutation[] {
  if (!Array.isArray(list) || list.length === 0) return [];

  const byEntity = new Map<string, PendingMutation>();
  const anonymous: PendingMutation[] = [];

  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const entityId = String(m.rowId || m.rowData?.Id || m.rowData?.id || '').trim();
    if (!entityId) {
      if (m.type === 'delete' && (!m.rowIndex || m.rowIndex <= 1)) {
        continue;
      }
      anonymous.push(m);
      continue;
    }

    const normalized: PendingMutation = {
      ...m,
      rowId: entityId,
    };
    const prior = byEntity.get(entityId);

    if (normalized.type === 'add') {
      const wasDeleted = prior?.type === 'delete' || Boolean(prior?.rowData?._forceRestore);
      byEntity.set(entityId, {
        ...normalized,
        rowData: normalized.rowData
          ? {
              ...normalized.rowData,
              Id: entityId,
              id: entityId,
              ...(wasDeleted ? { _forceRestore: true } : {}),
            }
          : normalized.rowData,
      });
    } else if (normalized.type === 'update') {
      if (prior?.type === 'add') {
        byEntity.set(entityId, {
          ...prior,
          sheetName: normalized.sheetName || prior.sheetName,
          rowData: {
            ...(prior.rowData || {}),
            ...(normalized.rowData || {}),
            Id: entityId,
            id: entityId,
          },
          timestamp: normalized.timestamp || prior.timestamp,
        });
      } else if (prior?.type === 'update') {
        byEntity.set(entityId, {
          ...prior,
          sheetName: normalized.sheetName || prior.sheetName,
          rowIndex: normalized.rowIndex ?? prior.rowIndex,
          rowData: {
            ...(prior.rowData || {}),
            ...(normalized.rowData || {}),
            Id: entityId,
            id: entityId,
          },
          timestamp: normalized.timestamp || prior.timestamp,
        });
      } else if (!prior) {
        byEntity.set(entityId, normalized);
      }
    } else if (normalized.type === 'delete') {
      if (prior?.type === 'add') {
        // An unpushed add followed by a delete for the same rowId cancels out!
        byEntity.delete(entityId);
      } else {
        byEntity.set(entityId, normalized);
      }
    }
  }

  return [...Array.from(byEntity.values()), ...anonymous];
}

export function getPendingMutations(): PendingMutation[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(CACHE_KEYS.PENDING_QUEUE);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const coalesced = coalescePendingMutations(parsed);
      if (coalesced.length !== parsed.length) {
        try {
          localStorage.setItem(CACHE_KEYS.PENDING_QUEUE, JSON.stringify(coalesced));
        } catch {}
      }
      return coalesced;
    }
    noteUnreadableQueue('Offline transaction queue is invalid. Existing queued changes were preserved.');
  } catch {
    noteUnreadableQueue('Offline transaction queue could not be read. Existing queued changes were preserved.');
  }
  return [];
}

function assertQueueReadable(key: string, label: string): void {
  if (typeof window === 'undefined') return;
  const raw = localStorage.getItem(key);
  if (!raw) return;
  try {
    if (Array.isArray(JSON.parse(raw))) return;
  } catch {
    // Keep malformed queue bytes intact; refuse any write that would replace them.
  }
  throw new Error(`${label} queue is unreadable. Existing queued changes were left untouched; do not clear browser data before recovery.`);
}

function noteUnreadableQueue(message: string): void {
  try {
    // This status is read by getSyncStatus immediately after queue parsing.
    // Do not dispatch from here: getSyncStatus itself reads the queues.
    localStorage.setItem('cashflow_last_sync_error', message);
    localStorage.setItem('cashflow_last_sync_error_at', String(Date.now()));
  } catch {}
}

export function savePendingMutations(list: PendingMutation[]): void {
  if (typeof window === 'undefined') return;
  try {
    assertQueueReadable(CACHE_KEYS.PENDING_QUEUE, 'Offline transaction');
    const coalesced = coalescePendingMutations(list);
    localStorage.setItem(CACHE_KEYS.PENDING_QUEUE, JSON.stringify(coalesced));
    dispatchSyncStatus();
  } catch (err) {
    console.error('[CacheManager] Failed to persist pending mutations:', err);
    if (err instanceof Error && err.message.includes('queue is unreadable')) throw err;
    throw new Error('This device could not save the offline change. Free storage space and try again while connected.');
  }
}

/*
 * Queue reads may return an empty list for display when corrupted, but queue
 * writes must first validate the existing bytes so they can never erase the
 * only copy of unconfirmed edits.
 */
export function assertPendingQueuesReadable(): void {
  assertQueueReadable(CACHE_KEYS.PENDING_QUEUE, 'Offline transaction');
  assertQueueReadable(CACHE_KEYS.PENDING_SETTINGS_QUEUE, 'Offline settings');
  assertQueueReadable(CACHE_KEYS.PENDING_PLAN_QUEUE, 'Offline plan');
}

export function getPendingSettingMutations(): PendingSettingMutation[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(CACHE_KEYS.PENDING_SETTINGS_QUEUE);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    noteUnreadableQueue('Offline settings queue is invalid. Existing queued changes were preserved.');
  } catch {
    noteUnreadableQueue('Offline settings queue could not be read. Existing queued changes were preserved.');
  }
  return [];
}

export function enqueuePendingSettingMutation(key: string, value: string): PendingSettingMutation {
  const item: PendingSettingMutation = {
    mutationId: `setting_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    key,
    value,
    changedAt: Date.now(),
    retryCount: 0,
    status: 'pending',
  };
  if (typeof window === 'undefined') return item;
  try {
    assertQueueReadable(CACHE_KEYS.PENDING_SETTINGS_QUEUE, 'Offline settings');
    const current = getPendingSettingMutations().filter((m) => m.key !== key);
    current.push(item);
    localStorage.setItem(CACHE_KEYS.PENDING_SETTINGS_QUEUE, JSON.stringify(current));
    dispatchSyncStatus();
  } catch (err) {
    console.warn('[CacheManager] Failed to queue setting mutation:', err);
    if (err instanceof Error && err.message.includes('queue is unreadable')) throw err;
    throw new Error('This device could not save the setting for offline sync. Free storage space and try again while connected.');
  }
  return item;
}

export function markPendingSettingMutationFailed(key: string, errorMsg: string): void {
  if (typeof window === 'undefined') return;
  try {
    assertQueueReadable(CACHE_KEYS.PENDING_SETTINGS_QUEUE, 'Offline settings');
    const current = getPendingSettingMutations().map((m) => {
      if (m.key === key) {
        return {
          ...m,
          retryCount: (m.retryCount || 0) + 1,
          status: 'failed' as const,
          lastError: errorMsg,
        };
      }
      return m;
    });
    localStorage.setItem(CACHE_KEYS.PENDING_SETTINGS_QUEUE, JSON.stringify(current));
    dispatchSyncStatus();
  } catch (err) {
    console.error('[CacheManager] Failed to update pending setting status:', err);
  }
}

/**
 * Removes pending setting mutations ONLY if their mutationId/changedAt has not been superseded
 * by a newer edit while the sync was in flight (P1 #10).
 */
export function removePendingSettingMutations(
  keys: string[],
  acknowledgedSnapshots?: Map<string, { mutationId?: string; changedAt?: number }>
): void {
  if (typeof window === 'undefined' || keys.length === 0) return;
  try {
    assertQueueReadable(CACHE_KEYS.PENDING_SETTINGS_QUEUE, 'Offline settings');
    const keySet = new Set(keys);
    const current = getPendingSettingMutations().filter((m) => {
      if (!keySet.has(m.key)) return true;
      if (acknowledgedSnapshots && acknowledgedSnapshots.has(m.key)) {
        const snap = acknowledgedSnapshots.get(m.key)!;
        if (snap.mutationId && m.mutationId && snap.mutationId !== m.mutationId) {
          return true; // Newer edit arrived during sync; keep in queue!
        }
        if (typeof snap.changedAt === 'number' && m.changedAt > snap.changedAt) {
          return true; // Newer edit arrived during sync; keep in queue!
        }
      }
      return false;
    });
    localStorage.setItem(CACHE_KEYS.PENDING_SETTINGS_QUEUE, JSON.stringify(current));
    dispatchSyncStatus();
  } catch (err) {
    console.error('[CacheManager] Failed to remove pending settings:', err);
  }
}

export function enqueuePendingMutation(
  mutation: Omit<PendingMutation, 'id' | 'timestamp' | 'retryCount'>
): PendingMutation {
  const generatedId = `pending_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const item: PendingMutation = {
    ...mutation,
    id: generatedId,
    mutationId: mutation.mutationId || generatedId,
    timestamp: Date.now(),
    retryCount: 0,
    status: 'pending',
  };

  const current = getPendingMutations();
  current.push(item);
  savePendingMutations(current);
  return item;
}

export function markPendingMutationFailed(id: string, errorMsg: string): void {
  const current = getPendingMutations().map((m) => {
    if (m.id === id) {
      return {
        ...m,
        retryCount: (m.retryCount || 0) + 1,
        status: 'failed' as const,
        lastError: errorMsg,
      };
    }
    return m;
  });
  savePendingMutations(current);
}

export function removePendingMutation(id: string): void {
  const current = getPendingMutations();
  const filtered = current.filter((m) => m.id !== id);
  savePendingMutations(filtered);
}

// --- Pending Scalar Settings Outbox ---


/**
 * P0 #3: Reconcile or clear local pending queues and cached plan/settings state
 * after a backup snapshot is restored on the server, preventing stale phone state
 * from overwriting the freshly restored Sheet.
 */
export function reconcileLocalStateAfterRestore(options: { retainPendingEdits: boolean }): {
  clearedTransactions: number;
  clearedPlans: number;
  clearedSettings: number;
  retainedCount: number;
} {
  if (typeof window === 'undefined') {
    return { clearedTransactions: 0, clearedPlans: 0, clearedSettings: 0, retainedCount: 0 };
  }

  // Never clear queued edits if a queue cannot be parsed. The caller can
  // recover/export it first; the restored Sheet remains intact meanwhile.
  assertPendingQueuesReadable();

  const pendingTx = getPendingMutations();
  const pendingSettings = getPendingSettingMutations();
  let pendingPlansCount = 0;
  try {
    const rawPlans = localStorage.getItem(CACHE_KEYS.PENDING_PLAN_QUEUE);
    const parsedPlans = rawPlans ? JSON.parse(rawPlans) : [];
    pendingPlansCount = Array.isArray(parsedPlans) ? parsedPlans.length : 0;
  } catch {}

  // Clear cached server responses and local plan/setting mirrors so the next
  // sync reads the restored Sheet. Preserve the local-only database: it can
  // contain offline records that were never mirrored to the Sheet.
  const keysToClear: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k) continue;
    if (
      k.startsWith(SWR_CACHE_PREFIX) ||
      k.startsWith('swr:') ||
      k.startsWith(CACHE_KEYS.MONTH_CACHE_PREFIX) ||
      k.startsWith('cashflow_pre_sync_plan_backup_v2_')
    ) {
      keysToClear.push(k);
    }
  }
  keysToClear.forEach((k) => localStorage.removeItem(k));
  localStorage.removeItem('cashflow_recurring_commitments');
  localStorage.removeItem('cashflow_installment_plans');
  localStorage.removeItem('cashflow_category_caps');
  localStorage.removeItem('cashflow_monthly_budget');
  localStorage.removeItem('cashflow_baseline_income');
  localStorage.removeItem('cashflow_emergency_reserve');

  // Mark this device as already migration-checked so it does NOT treat the cleared/restored state as an initial phone-to-sheet migration
  localStorage.setItem('cashflow_sync_v3_device_checked_cashflow_recurring_commitments', '1');
  localStorage.setItem('cashflow_sync_v3_device_checked_cashflow_installment_plans', '1');

  if (!options.retainPendingEdits) {
    localStorage.removeItem(CACHE_KEYS.PENDING_QUEUE);
    localStorage.removeItem(CACHE_KEYS.PENDING_PLAN_QUEUE);
    localStorage.removeItem(CACHE_KEYS.PENDING_SETTINGS_QUEUE);
    dispatchSyncStatus();
    return {
      clearedTransactions: pendingTx.length,
      clearedPlans: pendingPlansCount,
      clearedSettings: pendingSettings.length,
      retainedCount: 0,
    };
  }

  dispatchSyncStatus();
  return {
    clearedTransactions: 0,
    clearedPlans: 0,
    clearedSettings: 0,
    retainedCount: pendingTx.length + pendingPlansCount + pendingSettings.length,
  };
}

// --- Last Synced & Connection Status ---

export function setLastSyncedAt(timestamp: number = Date.now(), requestStartedAt: number = timestamp): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(CACHE_KEYS.LAST_SYNCED_AT, String(timestamp));
    const errorAt = Number(localStorage.getItem('cashflow_last_sync_error_at') || 0);
    // Parallel reads from one refresh must not let a late success hide a
    // sibling request's later failure. Only a request started after that
    // failure is allowed to clear the warning.
    if (!errorAt || errorAt < requestStartedAt) {
      localStorage.removeItem('cashflow_last_sync_error');
      localStorage.removeItem('cashflow_last_sync_error_at');
    }
    dispatchSyncStatus();
  } catch {}
}

export function setLastSyncError(message: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem('cashflow_last_sync_error', message.slice(0, 240));
    localStorage.setItem('cashflow_last_sync_error_at', String(Date.now()));
    dispatchSyncStatus();
  } catch {}
}

export function getLastSyncedAt(): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const val = localStorage.getItem(CACHE_KEYS.LAST_SYNCED_AT);
    return val ? parseInt(val, 10) : null;
  } catch {
    return null;
  }
}

export function getSyncStatus(): {
  isOnline: boolean;
  hasCloudEndpoint: boolean;
  isConnected: boolean;
  pendingCount: number;
  failedCount: number;
  conflictCount: number;
  lastSyncedAt: number | null;
  lastSyncError: string | null;
} {
  const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
  // sheets-api has a built-in endpoint unless the user explicitly switches to
  // local-only mode. A configured endpoint still needs a recent good response.
  let hasUrl = true;
  if (typeof window !== 'undefined') {
    try {
      if (localStorage.getItem('cashflow_cache_heal_v7') !== '1') {
        localStorage.setItem('cashflow_cache_heal_v7', '1');
        localStorage.removeItem('cashflow_last_sync_error');
        localStorage.removeItem('cashflow_last_sync_error_at');
        localStorage.removeItem('cashflow_pre_migration_backup_error_v1');
        for (const qKey of [
          CACHE_KEYS.PENDING_QUEUE,
          CACHE_KEYS.PENDING_PLAN_QUEUE,
          CACHE_KEYS.PENDING_SETTINGS_QUEUE,
        ]) {
          const rawQ = localStorage.getItem(qKey);
          if (!rawQ) continue;
          try {
            const parsedQ = JSON.parse(rawQ);
            if (Array.isArray(parsedQ)) {
              const cleaned = parsedQ.filter((item: Record<string, unknown>) => {
                if (!item || typeof item !== 'object') return false;
                if (item.status === 'failed' || Number(item.retryCount || 0) > 0) return false;
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
      hasUrl = localStorage.getItem('cashflow_apps_script_url') !== LOCAL_ONLY_ENDPOINT_SENTINEL;
    } catch {}
  }
  const pending = getPendingMutations();
  const pendingSettings = getPendingSettingMutations();
  let pendingPlans = 0;
  let failedPlans = 0;
  let conflictCount = 0;
  if (typeof window !== 'undefined') {
    try {
      const rawPlans = localStorage.getItem(CACHE_KEYS.PENDING_PLAN_QUEUE);
      const parsedPlans: unknown = rawPlans ? JSON.parse(rawPlans) : [];
      if (Array.isArray(parsedPlans)) {
        pendingPlans = parsedPlans.length;
        failedPlans = parsedPlans.filter((p: unknown) =>
          typeof p === 'object' && p !== null && 'status' in p && p.status === 'failed'
        ).length;
      }
    } catch {}
    try {
      const rawConflicts = localStorage.getItem('cashflow_sync_conflicts_v1');
      const parsedConflicts: unknown = rawConflicts ? JSON.parse(rawConflicts) : [];
      conflictCount = Array.isArray(parsedConflicts) ? parsedConflicts.length : 0;
    } catch {}
  }

  const failedTx = pending.filter((m) => m.status === 'failed').length;
  const failedSettings = pendingSettings.filter((m) => m.status === 'failed').length;
  const lastSync = getLastSyncedAt();
  let lastSyncError: string | null = null;
  if (typeof window !== 'undefined') {
    try {
      const rawErr = localStorage.getItem('cashflow_last_sync_error');
      if (
        rawErr &&
        (rawErr.includes('Server proxy is not configured') ||
          rawErr.includes('invalid server proxy token') ||
          rawErr.includes('Waiting for the new endpoint') ||
          rawErr.includes('Invalid API Key') ||
          rawErr.includes('Unknown action'))
      ) {
        localStorage.removeItem('cashflow_last_sync_error');
        localStorage.removeItem('cashflow_last_sync_error_at');
        localStorage.removeItem('cashflow_api_key');
      } else {
        lastSyncError = rawErr;
      }
    } catch {}
  }

  return {
    isOnline,
    hasCloudEndpoint: hasUrl,
    isConnected: isOnline && hasUrl && !lastSyncError,
    pendingCount: pending.length + pendingPlans + pendingSettings.length,
    failedCount: failedTx + failedPlans + failedSettings,
    conflictCount,
    lastSyncedAt: lastSync,
    lastSyncError,
  };
}

function dispatchSyncStatus(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(SYNC_STATUS_EVENT, { detail: getSyncStatus() }));
}
