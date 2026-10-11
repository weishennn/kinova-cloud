import { sheetsApi } from './sheets-api';
import { setLastSyncError, SYNC_STATUS_EVENT } from './cache-manager';
import { recordDeletedTombstone, recordSyncConflict } from './data-integrity';
import type { StoredInstallmentPlan } from './installment-helper';
import type { RecurringCommitment } from './recurring-helper';

type PlanStorageKey = 'cashflow_recurring_commitments' | 'cashflow_installment_plans';
type PlanKind = 'recurring' | 'installments';
type PlanRecord = RecurringCommitment | StoredInstallmentPlan;

export interface PlanMutation {
  mutationId: string;
  storageKey: PlanStorageKey;
  entityId: string;
  action: 'upsert' | 'delete';
  /** Only set by an explicit user restore from the recovery card. */
  forceRestore?: boolean;
  changedAt: number;
  baseChangedAt?: number;
  record?: PlanRecord;
  status?: 'pending' | 'failed';
  retryCount?: number;
  lastError?: string;
}

interface VersionedPlanEntry {
  id: string;
  changedAt: number;
  version?: number;
  deleted: boolean;
  record?: PlanRecord;
}

interface PlanEnvelope {
  version: 1;
  entries: VersionedPlanEntry[];
}

const OUTBOX_KEY = 'cashflow_pending_plan_mutations_v2';
const BACKUP_PREFIX = 'cashflow_pre_sync_plan_backup_v2_';
const MIGRATED_DEVICE_PREFIX = 'cashflow_sync_v3_device_checked_';
const PRE_MIGRATION_BACKUP_KEY = 'cashflow_pre_migration_backup_ran_v2';
const PRE_MIGRATION_BACKUP_ERROR_KEY = 'cashflow_pre_migration_backup_error_v1';
const PLAN_VERSIONS_KEY = 'cashflow_plan_versions_v1';
export const PLAN_RECOVERY_UPDATED_EVENT = 'cashflow_plan_recovery_updated';

export const PLAN_CONFIG: Record<PlanStorageKey, {
  kind: PlanKind;
  cloudKey: string;
  label: string;
}> = {
  cashflow_recurring_commitments: {
    kind: 'recurring',
    cloudKey: 'cashflow_sync_v2_recurring_commitments',
    label: 'Recurring Commitments',
  },
  cashflow_installment_plans: {
    kind: 'installments',
    cloudKey: 'cashflow_sync_v2_installment_plans',
    label: 'Installment Plans',
  },
};

export interface PlanMigrationComparison {
  storageKey: PlanStorageKey;
  kind: PlanKind;
  label: string;
  savedAt: string;
  backupRecords: PlanRecord[];
  activeSheetRecords: PlanRecord[];
  phoneOnlyRecords: PlanRecord[];
  differingRecords: Array<{ phoneRecord: PlanRecord; sheetRecord: PlanRecord }>;
}

export function getPreMigrationBackupError(): { failedAt: string; message: string } | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(PRE_MIGRATION_BACKUP_ERROR_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearPreMigrationBackupError(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(PRE_MIGRATION_BACKUP_ERROR_KEY);
}

export function getPendingPlanMutations(): PlanMutation[] {
  return getOutbox();
}

export function discardPendingPlanMutation(mutationId: string): void {
  setOutbox(getOutbox().filter((m) => m.mutationId !== mutationId));
}

function getKnownEntityChangedAt(storageKey: PlanStorageKey, entityId: string): number | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const raw = localStorage.getItem(PLAN_VERSIONS_KEY);
    if (!raw) return undefined;
    const map = JSON.parse(raw) as Record<string, number>;
    const val = map[`${storageKey}:${entityId}`];
    return typeof val === 'number' ? val : undefined;
  } catch {
    return undefined;
  }
}

function updateKnownEnvelopeTimestamps(storageKey: PlanStorageKey, envelope: PlanEnvelope): void {
  if (typeof window === 'undefined') return;
  try {
    const raw = localStorage.getItem(PLAN_VERSIONS_KEY);
    const map: Record<string, number> = raw ? JSON.parse(raw) : {};
    for (const entry of envelope.entries) {
      map[`${storageKey}:${entry.id}`] = entry.changedAt || 0;
    }
    localStorage.setItem(PLAN_VERSIONS_KEY, JSON.stringify(map));
  } catch {}
}

export function getPlanMigrationComparisons(): PlanMigrationComparison[] {
  if (typeof window === 'undefined') return [];
  const results: PlanMigrationComparison[] = [];

  for (const key of Object.keys(PLAN_CONFIG) as PlanStorageKey[]) {
    const config = PLAN_CONFIG[key];
    const backupKey = `${BACKUP_PREFIX}${key}`;
    const rawBackup = localStorage.getItem(backupKey);
    if (!rawBackup) continue;

    try {
      const parsed = JSON.parse(rawBackup);
      const backupRecords: PlanRecord[] = Array.isArray(parsed?.records) ? parsed.records : [];
      if (backupRecords.length === 0) continue;

      const activeRaw = localStorage.getItem(key);
      const activeRecords = parseList<PlanRecord>(activeRaw || '[]');
      const activeMap = new Map(activeRecords.map((r) => [getEntityId(r), r]));

      const phoneOnlyRecords: PlanRecord[] = [];
      const differingRecords: Array<{ phoneRecord: PlanRecord; sheetRecord: PlanRecord }> = [];

      for (const phoneRec of backupRecords) {
        const id = getEntityId(phoneRec);
        if (!id) continue;
        const sheetRec = activeMap.get(id);
        if (!sheetRec) {
          phoneOnlyRecords.push(phoneRec);
        } else if (JSON.stringify(phoneRec) !== JSON.stringify(sheetRec)) {
          differingRecords.push({ phoneRecord: phoneRec, sheetRecord: sheetRec });
        }
      }

      if (phoneOnlyRecords.length > 0 || differingRecords.length > 0) {
        results.push({
          storageKey: key,
          kind: config.kind,
          label: config.label,
          savedAt: parsed.savedAt || new Date().toISOString(),
          backupRecords,
          activeSheetRecords: activeRecords,
          phoneOnlyRecords,
          differingRecords,
        });
      }
    } catch (e) {
      console.warn(`[PlanRecovery] Could not parse backup for ${key}:`, e);
    }
  }

  return results;
}

export function restorePhonePlansToSheet(
  storageKey: PlanStorageKey,
  mode: 'merge_missing' | 'replace_all' = 'merge_missing'
): void {
  if (typeof window === 'undefined' || !isPlanStorageKey(storageKey)) return;
  const backupKey = `${BACKUP_PREFIX}${storageKey}`;
  const rawBackup = localStorage.getItem(backupKey);
  if (!rawBackup) return;

  try {
    const parsed = JSON.parse(rawBackup);
    const backupRecords: PlanRecord[] = Array.isArray(parsed?.records) ? parsed.records : [];
    const currentRaw = localStorage.getItem(storageKey) || '[]';
    const currentRecords = parseList<PlanRecord>(currentRaw);
    const currentMap = new Map(currentRecords.map((r) => [getEntityId(r), r]));

    let nextRecords: PlanRecord[] = [];

    if (mode === 'merge_missing') {
      nextRecords = [...currentRecords];
      for (const phoneRec of backupRecords) {
        const id = getEntityId(phoneRec);
        if (!id || currentMap.has(id)) continue;
        nextRecords.push(phoneRec);
      }
    } else {
      // replace_all with phone records as primary
      const phoneMap = new Map(backupRecords.map((r) => [getEntityId(r), r]));
      nextRecords = [...backupRecords];
      for (const sheetRec of currentRecords) {
        const id = getEntityId(sheetRec);
        if (!id || phoneMap.has(id)) continue;
        nextRecords.push(sheetRec);
      }
    }

    const nextRaw = JSON.stringify(nextRecords);
    const explicitRestoreIds = new Set(backupRecords.map((record) => getEntityId(record)).filter(Boolean));
    queuePlanListChanges(storageKey, currentRaw, nextRaw, explicitRestoreIds);
    localStorage.setItem(storageKey, nextRaw);
    localStorage.removeItem(backupKey);

    window.dispatchEvent(new CustomEvent(PLAN_RECOVERY_UPDATED_EVENT));
    window.dispatchEvent(new CustomEvent(SYNC_STATUS_EVENT));
  } catch (err) {
    console.error(`[PlanRecovery] Failed to restore plans for ${storageKey}:`, err);
    throw err;
  }
}

export function dismissPlanBackup(storageKey: PlanStorageKey): void {
  if (typeof window === 'undefined' || !isPlanStorageKey(storageKey)) return;
  localStorage.removeItem(`${BACKUP_PREFIX}${storageKey}`);
  window.dispatchEvent(new CustomEvent(PLAN_RECOVERY_UPDATED_EVENT));
}

function isPlanStorageKey(key: string): key is PlanStorageKey {
  return Object.prototype.hasOwnProperty.call(PLAN_CONFIG, key);
}

function parseList<T extends PlanRecord>(raw: unknown): T[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function parseCloudList(raw: unknown, storageKey: PlanStorageKey): PlanRecord[] {
  if (raw === undefined || raw === null || raw === '') return [];
  try {
    const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed)) return parsed as PlanRecord[];
  } catch {
    // Fail closed below so malformed cloud data is never mistaken for an empty list.
  }
  throw new Error(`The Google Sheets ${storageKey} value is invalid; local data was left unchanged.`);
}

function getEntityId(record: Partial<PlanRecord>): string {
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (id) return id;
  return typeof record.name === 'string' ? record.name.trim().toLowerCase() : '';
}

function coalescePlanMutations(mutations: PlanMutation[]): PlanMutation[] {
  if (!Array.isArray(mutations) || mutations.length === 0) return [];
  const latestByEntity = new Map<string, PlanMutation>();
  for (const mutation of mutations) {
    if (!mutation || !mutation.storageKey || !mutation.entityId) continue;
    const compositeKey = `${mutation.storageKey}:${mutation.entityId}`;
    const prior = latestByEntity.get(compositeKey);
    if (
      mutation.action === 'delete' &&
      prior?.action === 'upsert' &&
      prior.baseChangedAt === undefined &&
      mutation.baseChangedAt === undefined
    ) {
      // A local-only plan created and deleted before ever syncing to the cloud cancels out
      latestByEntity.delete(compositeKey);
      continue;
    }
    latestByEntity.set(compositeKey, {
      ...mutation,
      ...(prior?.action === 'delete' && mutation.action === 'upsert' ? { forceRestore: true } : {}),
      baseChangedAt: prior?.baseChangedAt !== undefined ? prior.baseChangedAt : mutation.baseChangedAt,
    });
  }
  return Array.from(latestByEntity.values());
}

function getOutbox(): PlanMutation[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(OUTBOX_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      const coalesced = coalescePlanMutations(parsed as PlanMutation[]);
      if (coalesced.length !== parsed.length) {
        try {
          localStorage.setItem(OUTBOX_KEY, JSON.stringify(coalesced));
        } catch {}
      }
      return coalesced;
    }
    setLastSyncError('Offline plan queue is invalid. Existing queued changes were preserved.');
  } catch {
    setLastSyncError('Offline plan queue could not be read. Existing queued changes were preserved.');
  }
  return [];
}

function setOutbox(mutations: PlanMutation[]): void {
  if (typeof window === 'undefined') return;
  const raw = localStorage.getItem(OUTBOX_KEY);
  if (raw) {
    try {
      if (!Array.isArray(JSON.parse(raw))) throw new Error('invalid plan queue');
    } catch {
      throw new Error('Offline plan queue is unreadable. Existing queued changes were left untouched; do not clear browser data before recovery.');
    }
  }
  const coalesced = coalescePlanMutations(mutations);
  localStorage.setItem(OUTBOX_KEY, JSON.stringify(coalesced));
  window.dispatchEvent(new CustomEvent(SYNC_STATUS_EVENT));
}

function markPlanMutationsFailed(mutationIds: Set<string>, errorMsg: string): void {
  if (mutationIds.size === 0) return;
  const updated = getOutbox().map((m) => {
    if (mutationIds.has(m.mutationId)) {
      return {
        ...m,
        status: 'failed' as const,
        retryCount: (m.retryCount || 0) + 1,
        lastError: errorMsg,
      };
    }
    return m;
  });
  setOutbox(updated);
}

/** Record only user-authored list changes. A cache read or refresh never creates mutations. */
export function queuePlanListChanges(
  key: string,
  previousRaw: string | null,
  nextRaw: string,
  explicitRestoreIds: Set<string> = new Set()
): void {
  if (typeof window === 'undefined' || !isPlanStorageKey(key)) return;

  const previous = parseList<PlanRecord>(previousRaw || '[]');
  const next = parseList<PlanRecord>(nextRaw);
  const previousById = new Map(previous.map((record) => [getEntityId(record), record]));
  const nextById = new Map(next.map((record) => [getEntityId(record), record]));
  const existing = getOutbox();
  const mutations: PlanMutation[] = [];
  let sequence = 0;

  for (const [entityId, record] of nextById) {
    if (!entityId) continue;
    const before = previousById.get(entityId);
    if (before && JSON.stringify(before) === JSON.stringify(record)) continue;
    mutations.push({
      mutationId: `${Date.now()}-${sequence++}-${Math.random().toString(36).slice(2)}`,
      storageKey: key,
      entityId,
      action: 'upsert',
      ...(explicitRestoreIds.has(entityId) ? { forceRestore: true } : {}),
      changedAt: Date.now() + sequence,
      baseChangedAt: getKnownEntityChangedAt(key, entityId),
      record,
      status: 'pending',
      retryCount: 0,
    });
  }

  for (const [entityId] of previousById) {
    if (!entityId || nextById.has(entityId)) continue;
    // Keep a local deletion marker while the durable Sheet envelope receives its permanent tombstone.
    recordDeletedTombstone(
      entityId,
      key === 'cashflow_recurring_commitments' ? 'recurring' : 'installments'
    );
    mutations.push({
      mutationId: `${Date.now()}-${sequence++}-${Math.random().toString(36).slice(2)}`,
      storageKey: key,
      entityId,
      action: 'delete',
      changedAt: Date.now() + sequence,
      baseChangedAt: getKnownEntityChangedAt(key, entityId),
      status: 'pending',
      retryCount: 0,
    });
  }

  if (mutations.length === 0) return;

  setOutbox(coalescePlanMutations([...existing, ...mutations]));
}

function parseEnvelope(raw: unknown): PlanEnvelope | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PlanEnvelope>;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return null;
    return parsed as PlanEnvelope;
  } catch {
    return null;
  }
}

function createEnvelope(records: PlanRecord[]): PlanEnvelope {
  const entries: VersionedPlanEntry[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const id = getEntityId(record);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    entries.push({ id, changedAt: 0, version: 1, deleted: false, record });
  }
  return { version: 1, entries };
}

function mergeMutations(envelope: PlanEnvelope, mutations: PlanMutation[]): PlanEnvelope {
  const entries = new Map(envelope.entries.map((entry) => [entry.id, entry]));
  for (const mutation of mutations) {
    const current = entries.get(mutation.entityId);
    if (current?.deleted && mutation.action === 'upsert' && !mutation.forceRestore) {
      recordSyncConflict({
        entityId: mutation.entityId,
        kind: PLAN_CONFIG[mutation.storageKey].kind,
        serverChangedAt: current.changedAt,
        clientMutationChangedAt: mutation.changedAt,
        serverRecord: { _deleted: true },
        clientRecord: (mutation.record || {}) as Record<string, unknown>,
        resolution: 'server_tombstone_preserved',
      });
      continue;
    }
    if (current && current.changedAt > mutation.changedAt) continue;
    const nextVersion = current && typeof current.version === 'number' ? current.version + 1 : 1;
    entries.set(mutation.entityId, {
      id: mutation.entityId,
      changedAt: mutation.changedAt,
      version: nextVersion,
      deleted: mutation.action === 'delete',
      ...(mutation.action === 'upsert' && mutation.record ? { record: mutation.record } : {}),
    });
  }
  return { version: 1, entries: Array.from(entries.values()) };
}

function getActiveRecords<T extends PlanRecord>(envelope: PlanEnvelope): T[] {
  return envelope.entries
    .filter((entry) => !entry.deleted && entry.record)
    .map((entry) => entry.record as T);
}

function assertSuccess(result: { success?: boolean; data?: unknown }, operation: string): void {
  const verified =
    result?.data && typeof result.data === 'object' && !Array.isArray(result.data)
      ? (result.data as { verified?: boolean }).verified
      : undefined;
  if (!result?.success || verified === false) {
    throw new Error(`${operation} was not confirmed and verified by Google Sheets.`);
  }
}

let planSyncInFlight: Promise<{ restoredFromCloud: boolean; pendingCount: number }> | null = null;
let planSyncFollowUpSettings: Record<string, string> | null = null;

/**
 * Sync plans using explicit local mutations and server-side atomic locks.
 * Enforces a single active sync mutex (P1 #10), confirmed pre-migration backup (P0 #4),
 * read-back verification (P0 #6), conflict capture (P1 #11), and ID/count migration validation (P1 #12).
 */
export async function syncPlanListsWithCloud(
  cloudSettings: Record<string, string>
): Promise<{ restoredFromCloud: boolean; pendingCount: number }> {
  if (planSyncInFlight) {
    planSyncFollowUpSettings = cloudSettings;
    return planSyncInFlight;
  }

  const runWithFollowUp = async (): Promise<{ restoredFromCloud: boolean; pendingCount: number }> => {
    const first = await runPlanListsSyncWithCloud(cloudSettings);
    if (planSyncFollowUpSettings || getOutbox().some((m) => m.status !== 'failed')) {
      const nextSettings = planSyncFollowUpSettings || cloudSettings;
      planSyncFollowUpSettings = null;
      const second = await runPlanListsSyncWithCloud(nextSettings);
      return {
        restoredFromCloud: first.restoredFromCloud || second.restoredFromCloud,
        pendingCount: second.pendingCount,
      };
    }
    return first;
  };

  const currentRun = runWithFollowUp();
  planSyncInFlight = currentRun;
  return currentRun.finally(() => {
    if (planSyncInFlight === currentRun) {
      planSyncInFlight = null;
      planSyncFollowUpSettings = null;
    }
  });
}

async function runPlanListsSyncWithCloud(
  cloudSettings: Record<string, string>
): Promise<{ restoredFromCloud: boolean; pendingCount: number }> {
  const allPending = getOutbox();
  let restoredFromCloud = false;

  for (const key of Object.keys(PLAN_CONFIG) as PlanStorageKey[]) {
    const config = PLAN_CONFIG[key];
    const pending = allPending.filter((mutation) => mutation.storageKey === key);
    const localRaw = localStorage.getItem(key);
    const localRecords = parseList<PlanRecord>(localRaw || '[]');
    const versionedRaw = cloudSettings[config.cloudKey];
    let envelope = parseEnvelope(versionedRaw);

    if (versionedRaw && !envelope) {
      throw new Error(`The saved ${config.kind} sync record is invalid; local data was left unchanged.`);
    }

    let isMigration = false;
    if (!envelope) {
      // P0 #4: Don't migrate plans unless the pre-migration backup is confirmed and verified by the server.
      if (typeof window !== 'undefined' && !localStorage.getItem(PRE_MIGRATION_BACKUP_KEY)) {
        const snapRes = await sheetsApi.createDriveSnapshot();
        const isConfirmed =
          snapRes?.success &&
          snapRes.data?.created &&
          snapRes.data?.verified !== false &&
          Boolean(snapRes.data?.fileId);

        if (!isConfirmed) {
          const errMsg =
            snapRes?.message ||
            'Pre-migration Google Drive backup could not be created and verified. Plan migration was stopped to protect your records.';
          localStorage.setItem(
            PRE_MIGRATION_BACKUP_ERROR_KEY,
            JSON.stringify({ failedAt: new Date().toISOString(), message: errMsg })
          );
          throw new Error(errMsg);
        }

        localStorage.setItem(PRE_MIGRATION_BACKUP_KEY, '1');
        clearPreMigrationBackupError();
      }

      // The old Settings JSON is authoritative when present, including an intentional [].
      const legacyRaw = cloudSettings[key];
      let legacyRecords = legacyRaw !== undefined
        ? parseCloudList(legacyRaw, key)
        : [];

      // Older versions sometimes populated only the dedicated tab. Read it only when
      // there is no legacy Settings key.
      if (legacyRaw === undefined) {
        const legacyResult = config.kind === 'recurring'
          ? await sheetsApi.getRecurringCommitments(true)
          : await sheetsApi.getInstallmentPlans(true);
        assertSuccess(legacyResult, `Read ${config.kind} plans`);
        legacyRecords = Array.isArray(legacyResult.data) ? legacyResult.data : [];
      }

      // If the cloud was completely empty but the phone had plans, transfer phone plans to envelope!
      if (legacyRecords.length === 0 && localRecords.length > 0 && legacyRaw === undefined) {
        envelope = createEnvelope(localRecords);
      } else {
        envelope = createEnvelope(legacyRecords);
      }
      isMigration = true;
    }

    // Safety capture & automatic phone-only plan transfer:
    // On first run on this device, save a reviewable backup if local records differ from Sheet,
    // and automatically queue any phone-only records that have never existed in the cloud envelope
    // (neither active nor deleted/tombstoned on the Sheet).
    const deviceChecked = typeof window !== 'undefined' && localStorage.getItem(`${MIGRATED_DEVICE_PREFIX}${key}`);
    const candidatePhoneRecords: PlanRecord[] = [...localRecords];

    if (!deviceChecked && typeof window !== 'undefined') {
      const backupKey = `${BACKUP_PREFIX}${key}`;
      const existingBackupRaw = localStorage.getItem(backupKey);
      if (existingBackupRaw) {
        try {
          const parsedBackup = JSON.parse(existingBackupRaw);
          if (Array.isArray(parsedBackup?.records)) {
            for (const rec of parsedBackup.records) {
              candidatePhoneRecords.push(rec);
            }
          }
        } catch {}
      }

      const activeCloud = getActiveRecords<PlanRecord>(envelope);
      if (localRecords.length > 0 && JSON.stringify(localRecords) !== JSON.stringify(activeCloud)) {
        if (!existingBackupRaw) {
          localStorage.setItem(backupKey, JSON.stringify({
            savedAt: new Date().toISOString(),
            raw: localRaw,
            records: localRecords,
          }));
        }
      }

      // Any phone record whose ID is completely unknown to the cloud envelope (not active and not tombstoned)
      // is automatically promoted into the durable outbox so it transfers to Google Sheets without manual steps.
      const cloudKnownIds = new Set(envelope.entries.map((entry) => String(entry.id || '').toLowerCase()));
      const pendingById = new Set(pending.map((m) => String(m.entityId || '').toLowerCase()));
      const autoTransferMutations: PlanMutation[] = [];
      let seq = 0;

      for (const phoneRec of candidatePhoneRecords) {
        const entityId = getEntityId(phoneRec);
        const entityIdLower = entityId.toLowerCase();
        if (!entityId || cloudKnownIds.has(entityIdLower) || pendingById.has(entityIdLower)) continue;
        pendingById.add(entityIdLower);
        autoTransferMutations.push({
          mutationId: `auto_migrate_${Date.now()}-${seq++}-${Math.random().toString(36).slice(2)}`,
          storageKey: key,
          entityId,
          action: 'upsert',
          changedAt: 1 + seq,
          record: phoneRec,
          status: 'pending',
          retryCount: 0,
        });
      }

      if (autoTransferMutations.length > 0) {
        pending.push(...autoTransferMutations);
        setOutbox([...getOutbox(), ...autoTransferMutations]);
      }
    }

    // Snapshot the exact mutations sent in this sync pass so concurrent edits arriving during sync are NOT dequeued (P1 #10)
    const sentSnapshot = new Map<string, number>();
    for (const m of pending) {
      sentSnapshot.set(m.mutationId, m.changedAt);
    }

    // Attempt atomic server-side reconciliation under Apps Script LockService
    let reconciled = false;
    let mergedEnvelope = envelope;
    let activeRecords: PlanRecord[] = [];

    if (isMigration || pending.length > 0) {
      try {
        const atomicRes = await sheetsApi.reconcilePlans(
          config.kind,
          pending,
          !deviceChecked ? candidatePhoneRecords : undefined
        );
        if (atomicRes.success && atomicRes.data?.envelope && atomicRes.data?.verified !== false) {
          mergedEnvelope = atomicRes.data.envelope as PlanEnvelope;
          activeRecords = (atomicRes.data.activeRecords || []) as PlanRecord[];
          reconciled = true;

          // P1 #11: Record any cross-device concurrent edit conflicts so losing versions are preserved
          if (Array.isArray(atomicRes.data.conflicts) && atomicRes.data.conflicts.length > 0) {
            for (const c of atomicRes.data.conflicts) {
              if (c.serverRecord && c.clientRecord) {
                recordSyncConflict({
                  entityId: String(c.entityId),
                  kind: config.kind,
                  serverChangedAt: Number(c.serverChangedAt || 0),
                  clientMutationChangedAt: Number(c.clientMutationChangedAt || 0),
                  serverRecord: c.serverRecord as Record<string, unknown>,
                  clientRecord: c.clientRecord as Record<string, unknown>,
                  resolution: String(c.resolution || 'client_applied'),
                });
              }
            }
          }
        }
      } catch (atomicErr) {
        console.warn(`[PlanSync] Atomic reconcile fallback for ${config.kind}:`, atomicErr);
      }
    } else {
      activeRecords = getActiveRecords<PlanRecord>(envelope);
    }

    if (!reconciled && (isMigration || pending.length > 0)) {
      try {
        const merged = mergeMutations(envelope, pending);
        const changed = JSON.stringify(merged) !== JSON.stringify(envelope);

        if (isMigration || changed) {
          const saveResult = await sheetsApi.updateSettings(config.cloudKey, JSON.stringify(merged));
          assertSuccess(saveResult, `Save ${config.kind} sync state`);
        }

        activeRecords = getActiveRecords<PlanRecord>(merged);
        mergedEnvelope = merged;

        if (isMigration || changed || pending.length > 0) {
          const mirrorResult = config.kind === 'recurring'
            ? await sheetsApi.saveRecurringCommitments(activeRecords as RecurringCommitment[])
            : await sheetsApi.saveInstallmentPlans(activeRecords as StoredInstallmentPlan[]);
          assertSuccess(mirrorResult, `Update ${config.kind} tab`);
        }
        reconciled = true;
      } catch (fallbackErr: unknown) {
        const msg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        markPlanMutationsFailed(new Set(pending.map((m) => m.mutationId)), msg);
        throw fallbackErr;
      }
    }

    // P1 #12: Validate plan migration by IDs and counts before marking migration complete
    const mergedEntryIdsLower = new Set(mergedEnvelope.entries.map((e) => String(e.id || '').toLowerCase()));
    const expectedIds = new Set<string>();
    envelope.entries.forEach((e) => {
      if (e.id) expectedIds.add(String(e.id).toLowerCase());
    });
    if (!deviceChecked) {
      candidatePhoneRecords.forEach((r) => {
        const id = getEntityId(r);
        if (id) expectedIds.add(id.toLowerCase());
      });
    }
    let allIdsAccountedFor = true;
    for (const id of expectedIds) {
      if (!mergedEntryIdsLower.has(id)) {
        allIdsAccountedFor = false;
        break;
      }
    }
    const expectedActiveCount = mergedEnvelope.entries.filter((e) => !e.deleted && e.record).length;
    const countsValid = activeRecords.length === expectedActiveCount;

    if (!allIdsAccountedFor || !countsValid) {
      const validationMsg = `Plan migration validation failed for ${config.label}: expected ${expectedActiveCount} active records (${expectedIds.size} total known IDs), got ${activeRecords.length}. Local migration state preserved for retry.`;
      markPlanMutationsFailed(new Set(pending.map((m) => m.mutationId)), validationMsg);
      throw new Error(validationMsg);
    }

    if (!deviceChecked && typeof window !== 'undefined') {
      localStorage.setItem(`${MIGRATED_DEVICE_PREFIX}${key}`, '1');
    }

    updateKnownEnvelopeTimestamps(key, mergedEnvelope);
    localStorage.setItem(key, JSON.stringify(activeRecords));
    if (JSON.stringify(localRecords) !== JSON.stringify(activeRecords)) {
      restoredFromCloud = true;
    }

    // P1 #10: Only dequeue mutations whose mutationId AND changedAt match the snapshot sent
    if (sentSnapshot.size > 0) {
      setOutbox(
        getOutbox().filter((mutation) => {
          const sentChangedAt = sentSnapshot.get(mutation.mutationId);
          if (sentChangedAt === undefined) return true; // Newly added during sync; keep!
          return mutation.changedAt > sentChangedAt; // Keep if modified again during sync!
        })
      );
    }
  }

  return { restoredFromCloud, pendingCount: getOutbox().length };
}
