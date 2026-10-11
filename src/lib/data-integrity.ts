/**
 * Data Integrity, Tombstone Retention, Cross-Device Conflict Store,
 * and Independent Offline Backup Export/Import for CashFlow.
 */

export const TOMBSTONE_STORAGE_KEY = 'cashflow_deleted_tombstones_v1';
export const CONFLICT_STORAGE_KEY = 'cashflow_sync_conflicts_v1';
export const INTEGRITY_BASELINE_KEY = 'cashflow_integrity_baseline_v1';
export const TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // Local cache only; Sheet tombstones are permanent.
export const CONFLICT_UPDATED_EVENT = 'cashflow_conflicts_updated';

export interface TombstoneEntry {
  deletedAt: number;
  kind: 'transaction' | 'recurring' | 'installments' | 'trade' | 'trip' | 'invoice';
  sheetName?: string;
}

export interface SyncConflict {
  id: string;
  entityId: string;
  kind: 'recurring' | 'installments' | 'transaction' | 'setting';
  detectedAt: string;
  serverChangedAt: number;
  clientMutationChangedAt: number;
  conflictingFields?: string[];
  serverRecord: Record<string, unknown>;
  clientRecord: Record<string, unknown>;
  resolution: string;
}

export interface IntegrityIssue {
  severity: 'error' | 'warning';
  scope: string;
  type: 'duplicate_id' | 'missing_field' | 'invalid_date' | 'sudden_count_drop' | 'corrupt_json';
  message: string;
}

export interface LocalIntegrityReport {
  healthy: boolean;
  checkedAt: string;
  summary: {
    recurringCount: number;
    installmentCount: number;
    cachedTransactionCount: number;
    duplicateIdCount: number;
    missingFieldCount: number;
    invalidDateCount: number;
    tombstoneCount: number;
    unresolvedConflictCount: number;
  };
  issues: IntegrityIssue[];
}

// --- 1. Local deletion cache (the Sheet keeps the durable, permanent copy) ---

export function getDeletedTombstones(): Record<string, TombstoneEntry> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(TOMBSTONE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, TombstoneEntry>;
    if (!parsed || typeof parsed !== 'object') return {};

    const now = Date.now();
    let pruned = false;
    const active: Record<string, TombstoneEntry> = {};
    for (const [id, entry] of Object.entries(parsed)) {
      if (entry && typeof entry.deletedAt === 'number' && now - entry.deletedAt <= TOMBSTONE_RETENTION_MS) {
        active[id] = entry;
      } else {
        pruned = true;
      }
    }
    if (pruned) localStorage.setItem(TOMBSTONE_STORAGE_KEY, JSON.stringify(active));
    return active;
  } catch {
    return {};
  }
}

export function recordDeletedTombstone(
  id: string,
  kind: TombstoneEntry['kind'],
  sheetName?: string
): void {
  if (typeof window === 'undefined' || !id) return;
  try {
    const map = getDeletedTombstones();
    map[id] = {
      deletedAt: Date.now(),
      kind,
      ...(sheetName ? { sheetName } : {}),
    };
    localStorage.setItem(TOMBSTONE_STORAGE_KEY, JSON.stringify(map));
  } catch (e) {
    console.warn('[DataIntegrity] Failed to record tombstone:', e);
  }
}

export function isRecordTombstoned(id: string): boolean {
  if (!id) return false;
  const map = getDeletedTombstones();
  return Boolean(map[id]);
}

export function clearDeletedTombstone(id: string): void {
  if (typeof window === 'undefined' || !id) return;
  try {
    const map = getDeletedTombstones();
    if (map[id]) {
      delete map[id];
      localStorage.setItem(TOMBSTONE_STORAGE_KEY, JSON.stringify(map));
    }
  } catch (e) {
    console.warn('[DataIntegrity] Failed to clear tombstone:', e);
  }
}

// --- 2. Cross-Device Conflict Store (P1 #11) ---

export function getSyncConflicts(): SyncConflict[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(CONFLICT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function recordSyncConflict(
  conflict: Omit<SyncConflict, 'id' | 'detectedAt'>
): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const list = getSyncConflicts();
    // Deduplicate by entityId + clientMutationChangedAt
    const exists = list.some(
      (c) =>
        c.entityId === conflict.entityId &&
        c.kind === conflict.kind &&
        c.clientMutationChangedAt === conflict.clientMutationChangedAt
    );
    if (exists) return true;

    const entry: SyncConflict = {
      ...conflict,
      id: `conflict_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      detectedAt: new Date().toISOString(),
    };
    list.unshift(entry);
    localStorage.setItem(CONFLICT_STORAGE_KEY, JSON.stringify(list.slice(0, 50)));
    if (!getSyncConflicts().some((saved) => saved.id === entry.id)) return false;
    window.dispatchEvent(new CustomEvent(CONFLICT_UPDATED_EVENT));
    return true;
  } catch (e) {
    console.warn('[DataIntegrity] Failed to record sync conflict:', e);
    return false;
  }
}

export function dismissSyncConflict(conflictId: string): void {
  if (typeof window === 'undefined') return;
  try {
    const list = getSyncConflicts().filter((c) => c.id !== conflictId);
    localStorage.setItem(CONFLICT_STORAGE_KEY, JSON.stringify(list));
    window.dispatchEvent(new CustomEvent(CONFLICT_UPDATED_EVENT));
  } catch {}
}

// --- 3. Client-Side Data Integrity Validator (P2 #16) ---

export function validateLocalIntegrity(): LocalIntegrityReport {
  const issues: IntegrityIssue[] = [];
  let duplicateIdCount = 0;
  let missingFieldCount = 0;
  let invalidDateCount = 0;
  let recurringCount = 0;
  let installmentCount = 0;
  let cachedTransactionCount = 0;

  if (typeof window !== 'undefined') {
    // 1. Validate Recurring Commitments
    try {
      const rawRec = localStorage.getItem('cashflow_recurring_commitments');
      if (rawRec) {
        const list = JSON.parse(rawRec);
        if (!Array.isArray(list)) {
          issues.push({
            severity: 'error',
            scope: 'Recurring Commitments',
            type: 'corrupt_json',
            message: 'Recurring commitments storage is not a valid array.',
          });
        } else {
          recurringCount = list.length;
          const seenRecIds = new Set<string>();
          list.forEach((item: Record<string, unknown>, idx: number) => {
            const id = String(item.id || '').trim();
            const name = String(item.name || '').trim();
            const amount = Number(item.amount);
            if (!id || !name || isNaN(amount)) {
              missingFieldCount++;
              issues.push({
                severity: 'warning',
                scope: 'Recurring Commitments',
                type: 'missing_field',
                message: `Recurring item #${idx + 1} (${name || 'Unnamed'}) is missing id, name, or valid amount.`,
              });
            }
            if (id) {
              if (seenRecIds.has(id)) {
                duplicateIdCount++;
                issues.push({
                  severity: 'error',
                  scope: 'Recurring Commitments',
                  type: 'duplicate_id',
                  message: `Duplicate Recurring ID "${id}" (${name}).`,
                });
              }
              seenRecIds.add(id);
            }
            if (item.effectiveFrom && !/^\d{4}-\d{2}(-\d{2})?$/.test(String(item.effectiveFrom))) {
              invalidDateCount++;
              issues.push({
                severity: 'warning',
                scope: 'Recurring Commitments',
                type: 'invalid_date',
                message: `Recurring item "${name}" has invalid effectiveFrom "${String(item.effectiveFrom)}".`,
              });
            }
          });
        }
      }
    } catch {
      issues.push({
        severity: 'error',
        scope: 'Recurring Commitments',
        type: 'corrupt_json',
        message: 'Could not parse cashflow_recurring_commitments JSON.',
      });
    }

    // 2. Validate Installment Plans
    try {
      const rawInst = localStorage.getItem('cashflow_installment_plans');
      if (rawInst) {
        const list = JSON.parse(rawInst);
        if (!Array.isArray(list)) {
          issues.push({
            severity: 'error',
            scope: 'Installment Plans',
            type: 'corrupt_json',
            message: 'Installment plans storage is not a valid array.',
          });
        } else {
          installmentCount = list.length;
          const seenInstIds = new Set<string>();
          list.forEach((item: Record<string, unknown>, idx: number) => {
            const id = String(item.id || '').trim();
            const name = String(item.name || '').trim();
            const tenure = Number(item.tenureMonths);
            if (!id || !name || isNaN(tenure) || tenure <= 0) {
              missingFieldCount++;
              issues.push({
                severity: 'warning',
                scope: 'Installment Plans',
                type: 'missing_field',
                message: `Installment plan #${idx + 1} (${name || 'Unnamed'}) is missing id, name, or valid tenureMonths.`,
              });
            }
            if (id) {
              if (seenInstIds.has(id)) {
                duplicateIdCount++;
                issues.push({
                  severity: 'error',
                  scope: 'Installment Plans',
                  type: 'duplicate_id',
                  message: `Duplicate Installment ID "${id}" (${name}).`,
                });
              }
              seenInstIds.add(id);
            }
            if (item.startDate && !/^\d{4}-\d{2}(-\d{2})?$/.test(String(item.startDate))) {
              invalidDateCount++;
              issues.push({
                severity: 'warning',
                scope: 'Installment Plans',
                type: 'invalid_date',
                message: `Installment plan "${name}" has invalid startDate "${String(item.startDate)}".`,
              });
            }
          });
        }
      }
    } catch {
      issues.push({
        severity: 'error',
        scope: 'Installment Plans',
        type: 'corrupt_json',
        message: 'Could not parse cashflow_installment_plans JSON.',
      });
    }

    // 3. Validate Cached SWR Monthly Transactions
    const seenTxIds = new Map<string, string>();
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith('cashflow_swr_getSheetData_')) continue;
      try {
        const raw = localStorage.getItem(k);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        const rows = parsed?.data?.data?.rows || parsed?.data?.rows || [];
        const monthLabel = parsed?.month || k;
        if (!Array.isArray(rows)) continue;
        rows.forEach((r: Record<string, unknown>, idx: number) => {
          cachedTransactionCount++;
          const txId = String(r.Id || r.id || '').trim();
          const txDate = String(r.Date || r.date || '').trim();
          if (txId) {
            const prevMonth = seenTxIds.get(txId);
            if (prevMonth && prevMonth !== monthLabel) {
              duplicateIdCount++;
              issues.push({
                severity: 'error',
                scope: String(monthLabel),
                type: 'duplicate_id',
                message: `Duplicate Transaction ID "${txId}" found across cached months (${prevMonth} and ${monthLabel}).`,
              });
            }
            seenTxIds.set(txId, String(monthLabel));
          }
          if (txDate && !/^\d{4}-\d{2}-\d{2}/.test(txDate)) {
            invalidDateCount++;
            issues.push({
              severity: 'warning',
              scope: String(monthLabel),
              type: 'invalid_date',
              message: `Cached transaction row #${idx + 1} in ${monthLabel} has invalid date "${txDate}".`,
            });
          }
        });
      } catch {}
    }

    // 4. Sudden count change detection against baseline
    try {
      const rawBase = localStorage.getItem(INTEGRITY_BASELINE_KEY);
      if (rawBase) {
        const base = JSON.parse(rawBase);
        if (typeof base.recurringCount === 'number' && base.recurringCount >= 3 && recurringCount === 0) {
          issues.push({
            severity: 'warning',
            scope: 'Recurring Commitments',
            type: 'sudden_count_drop',
            message: `Sudden count drop detected: Recurring commitments dropped from ${base.recurringCount} to 0.`,
          });
        }
        if (typeof base.installmentCount === 'number' && base.installmentCount >= 3 && installmentCount === 0) {
          issues.push({
            severity: 'warning',
            scope: 'Installment Plans',
            type: 'sudden_count_drop',
            message: `Sudden count drop detected: Installment plans dropped from ${base.installmentCount} to 0.`,
          });
        }
      }
      if (recurringCount > 0 || installmentCount > 0) {
        localStorage.setItem(
          INTEGRITY_BASELINE_KEY,
          JSON.stringify({
            recurringCount: Math.max(recurringCount, 0),
            installmentCount: Math.max(installmentCount, 0),
            updatedAt: new Date().toISOString(),
          })
        );
      }
    } catch {}
  }

  const tombstoneCount = Object.keys(getDeletedTombstones()).length;
  const unresolvedConflictCount = getSyncConflicts().length;

  return {
    healthy: issues.filter((i) => i.severity === 'error').length === 0,
    checkedAt: new Date().toISOString(),
    summary: {
      recurringCount,
      installmentCount,
      cachedTransactionCount,
      duplicateIdCount,
      missingFieldCount,
      invalidDateCount,
      tombstoneCount,
      unresolvedConflictCount,
    },
    issues,
  };
}

// --- 4. Independent Dated Offline JSON Backup Export & Import (P2 #14) ---

export interface IndependentOfflineBackup {
  schemaVersion: 1;
  exportedAt: string;
  app: 'Kinova' | 'CashFlow';
  counts: {
    recurringCommitments: number;
    installmentPlans: number;
    cachedMonths: number;
    pendingTransactions: number;
    pendingPlanMutations: number;
    pendingSettings: number;
    tombstones: number;
  };
  data: {
    settings: Record<string, string | null>;
    recurringCommitments: unknown[];
    installmentPlans: unknown[];
    pendingQueue: unknown[];
    pendingPlanQueue: unknown[];
    pendingSettingsQueue: unknown[];
    deletedTombstones: Record<string, TombstoneEntry>;
    syncConflicts: SyncConflict[];
    cachedMonthSnapshots: Record<string, unknown>;
  };
}

export function buildIndependentBackupPayload(): IndependentOfflineBackup {
  if (typeof window === 'undefined') {
    throw new Error('Offline backup export must be run in the browser.');
  }

  const parseSafeArray = (key: string): unknown[] => {
    try {
      const raw = localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  const recurringCommitments = parseSafeArray('cashflow_recurring_commitments');
  const installmentPlans = parseSafeArray('cashflow_installment_plans');
  const pendingQueue = parseSafeArray('cashflow_pending_queue');
  const pendingPlanQueue = parseSafeArray('cashflow_pending_plan_mutations_v2');
  const pendingSettingsQueue = parseSafeArray('cashflow_pending_settings_mutations');
  const deletedTombstones = getDeletedTombstones();
  const syncConflicts = getSyncConflicts();

  const cachedMonthSnapshots: Record<string, unknown> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k) continue;
    if (k.startsWith('cashflow_swr_getSheetData_') || k.startsWith('cashflow_month_')) {
      try {
        const raw = localStorage.getItem(k);
        if (raw) cachedMonthSnapshots[k] = JSON.parse(raw);
      } catch {}
    }
  }

  const settingsKeys = [
    'cashflow_currency',
    'cashflow_category_caps',
    'cashflow_monthly_budget',
    'cashflow_baseline_income',
    'cashflow_emergency_reserve',
  ];
  const settings: Record<string, string | null> = {};
  for (const sk of settingsKeys) {
    settings[sk] = localStorage.getItem(sk);
  }

  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    app: 'Kinova',
    counts: {
      recurringCommitments: recurringCommitments.length,
      installmentPlans: installmentPlans.length,
      cachedMonths: Object.keys(cachedMonthSnapshots).length,
      pendingTransactions: pendingQueue.length,
      pendingPlanMutations: pendingPlanQueue.length,
      pendingSettings: pendingSettingsQueue.length,
      tombstones: Object.keys(deletedTombstones).length,
    },
    data: {
      settings,
      recurringCommitments,
      installmentPlans,
      pendingQueue,
      pendingPlanQueue,
      pendingSettingsQueue,
      deletedTombstones,
      syncConflicts,
      cachedMonthSnapshots,
    },
  };
}

export function downloadIndependentBackupJson(): { filename: string; counts: IndependentOfflineBackup['counts'] } {
  const payload = buildIndependentBackupPayload();
  const dateStr = payload.exportedAt.slice(0, 10);
  const filename = `Kinova_Independent_Backup_${dateStr}.json`;
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return { filename, counts: payload.counts };
}

export function validateAndImportIndependentBackupJson(rawJson: string): {
  restoredRecurring: number;
  restoredInstallments: number;
  restoredSettings: number;
  exportedAt: string;
} {
  if (typeof window === 'undefined') {
    throw new Error('Offline backup import must be run in the browser.');
  }

  let parsed: Partial<IndependentOfflineBackup>;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error('Selected file is not valid JSON.');
  }

  if ((parsed.app !== 'Kinova' && parsed.app !== 'CashFlow') || parsed.schemaVersion !== 1 || !parsed.data) {
    throw new Error('Invalid backup file format: expected a Kinova schemaVersion 1 backup.');
  }

  const { recurringCommitments, installmentPlans, settings, deletedTombstones } = parsed.data;
  if (!Array.isArray(recurringCommitments) || !Array.isArray(installmentPlans)) {
    throw new Error('Backup file is missing recurringCommitments or installmentPlans arrays.');
  }

  // Restore tombstones first
  if (deletedTombstones && typeof deletedTombstones === 'object') {
    const mergedTombstones = { ...getDeletedTombstones(), ...deletedTombstones };
    localStorage.setItem(TOMBSTONE_STORAGE_KEY, JSON.stringify(mergedTombstones));
  }

  // Restore scalar settings
  let restoredSettings = 0;
  if (settings && typeof settings === 'object') {
    for (const [k, v] of Object.entries(settings)) {
      if (typeof v === 'string' && v.length > 0) {
        localStorage.setItem(k, v);
        restoredSettings++;
      }
    }
  }

  // Save recurring & installment plans
  localStorage.setItem('cashflow_recurring_commitments', JSON.stringify(recurringCommitments));
  localStorage.setItem('cashflow_installment_plans', JSON.stringify(installmentPlans));

  return {
    restoredRecurring: recurringCommitments.length,
    restoredInstallments: installmentPlans.length,
    restoredSettings,
    exportedAt: parsed.exportedAt || new Date().toISOString(),
  };
}
