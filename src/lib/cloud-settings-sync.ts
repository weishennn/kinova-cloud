import { sheetsApi, getApiUrl } from './sheets-api';
import { queuePlanListChanges, syncPlanListsWithCloud } from './plan-sync';
import {
  getPendingSettingMutations,
  enqueuePendingSettingMutation,
  removePendingSettingMutations,
  markPendingSettingMutationFailed,
} from './cache-manager';

export const CLOUD_SYNC_KEYS = {
  INSTALLMENTS: 'cashflow_installment_plans',
  RECURRING: 'cashflow_recurring_commitments',
  CATEGORY_CAPS: 'cashflow_category_caps',
  LHDN_TAX_CAPS: 'cashflow_lhdn_tax_caps',
  LHDN_TAX_RATE: 'cashflow_lhdn_tax_rate',
  LHDN_TAX_PROFILE: 'cashflow_lhdn_tax_profile',
  MONTHLY_BUDGET: 'cashflow_monthly_budget',
  BASELINE_INCOME: 'cashflow_baseline_income',
  EMERGENCY_RESERVE: 'cashflow_emergency_reserve',
  CURRENCY: 'cashflow_currency',
  CUSTOM_PIN: 'cashflow_custom_pin',
} as const;

export const SETTINGS_UPDATED_EVENT = 'cashflow_cloud_settings_synced';

/**
 * Saves a setting immediately to localStorage (0ms latency for the UI),
 * queues a durable offline outbox mutation, and asynchronously pushes the change
 * to Google Sheets Settings in the background.
 */
export function saveSettingWithCloudSync(
  key: string,
  value: string,
  options: { forceRestoreIds?: string[] } = {}
): void {
  if (typeof window === 'undefined') return;

  const previousValue = localStorage.getItem(key);
  const isPlanKey = key === CLOUD_SYNC_KEYS.RECURRING || key === CLOUD_SYNC_KEYS.INSTALLMENTS;
  const apiUrl = getApiUrl();
  const hasCloud = Boolean(apiUrl && apiUrl.startsWith('http'));
  const isOnline = typeof navigator !== 'undefined' ? navigator.onLine !== false : true;

  if (isPlanKey) {
    queuePlanListChanges(key, previousValue, value, new Set(options.forceRestoreIds || []));
  } else if (previousValue !== value && hasCloud) {
    // Enqueue immediately before the network write completes so any concurrent
    // syncCloudSettingsWithLocal() sees this local edit as authoritative and never overwrites it!
    enqueuePendingSettingMutation(key, value);
  }

  // 1. Instant local write (0ms UI latency)
  try {
    localStorage.setItem(key, value);
  } catch (err) {
    console.error(`[CloudSync] Local write error for ${key}:`, err);
  }

  // 2. Fire local notification for any listening components
  window.dispatchEvent(new CustomEvent(SETTINGS_UPDATED_EVENT, { detail: { key, value } }));

  // 3. Asynchronous background sync to Google Sheets Source of Truth
  if (!hasCloud || !isOnline) return;

  if (isPlanKey) {
    // The durable outbox distinguishes an intentional edit/delete from stale cache.
    void syncCloudSettingsWithLocal().catch((err) => {
      console.warn('[CloudSync] Plan change is queued for retry:', err);
    });
    return;
  }

  if (previousValue === value) return;

  const mutationId = `setting_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  sheetsApi.updateSettings(key, value, mutationId)
    .then((res) => {
      if (res.success && res.data?.verified !== false) {
        removePendingSettingMutations([key]);
      } else {
        enqueuePendingSettingMutation(key, value);
        markPendingSettingMutationFailed(key, res.message || 'Setting write was not verified by server.');
      }
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      enqueuePendingSettingMutation(key, value);
      markPendingSettingMutationFailed(key, msg);
      console.warn(`[CloudSync] Background sync queued for retry (${key}):`, msg);
    });
}

/**
 * Reconcile plan and setting changes through explicit durable outboxes.
 * A local value without a queued user edit is a cache and updates from newer cloud values.
 */
type SettingsSyncResult = {
  synced: boolean;
  restoredFromCloud: boolean;
  error?: string;
};

let settingsSyncInFlight: Promise<SettingsSyncResult> | null = null;
let settingsSyncFollowUpNeeded = false;

export function syncCloudSettingsWithLocal(): Promise<SettingsSyncResult> {
  if (typeof window === 'undefined') return Promise.resolve({ synced: false, restoredFromCloud: false });
  if (settingsSyncInFlight) {
    settingsSyncFollowUpNeeded = true;
    return settingsSyncInFlight;
  }

  const runWithFollowUp = async (): Promise<SettingsSyncResult> => {
    const first = await runCloudSettingsSync();
    if (settingsSyncFollowUpNeeded) {
      settingsSyncFollowUpNeeded = false;
      const second = await runCloudSettingsSync();
      return {
        synced: first.synced && second.synced,
        restoredFromCloud: first.restoredFromCloud || second.restoredFromCloud,
        error: second.error || first.error,
      };
    }
    return first;
  };

  const currentSync = runWithFollowUp();
  settingsSyncInFlight = currentSync;
  return currentSync.finally(() => {
    if (settingsSyncInFlight === currentSync) {
      settingsSyncInFlight = null;
      settingsSyncFollowUpNeeded = false;
    }
  });
}

async function runCloudSettingsSync(): Promise<SettingsSyncResult> {
  if (typeof window === 'undefined') return { synced: false, restoredFromCloud: false };

  const apiUrl = getApiUrl();
  if (!apiUrl || !apiUrl.startsWith('http')) return { synced: false, restoredFromCloud: false };

  try {
    const settingsRes = await sheetsApi.getSettings(true);
    if (!settingsRes.success || !settingsRes.data) {
      throw new Error('Google Sheets did not return settings; local plan data was left unchanged.');
    }
    const cloudSettings = settingsRes.data;
    let restoredFromCloud = false;
    try {
      const plansRes = await syncPlanListsWithCloud(cloudSettings);
      restoredFromCloud = plansRes.restoredFromCloud;
    } catch (planErr) {
      console.warn('[CloudSync] Plan sync warning (continuing settings flush):', planErr);
    }
    const pendingCloudUpdates: Record<string, { value: string; mutationId?: string; changedAt?: number }> = {};

    // Load durable pending scalar/JSON setting mutations and snapshot their timestamps (P1 #10)
    const queuedMutations = getPendingSettingMutations();
    const queuedByKey = new Map<string, { value: string; mutationId?: string; changedAt?: number }>();
    for (const m of queuedMutations) {
      const snap = { value: m.value, mutationId: m.mutationId, changedAt: m.changedAt };
      queuedByKey.set(m.key, snap);
      pendingCloudUpdates[m.key] = snap;
    }

    // Reconcile all non-plan settings (Category Caps + Scalar Configurations)
    const managedSettingKeys = [
      CLOUD_SYNC_KEYS.CATEGORY_CAPS,
      CLOUD_SYNC_KEYS.LHDN_TAX_CAPS,
      CLOUD_SYNC_KEYS.LHDN_TAX_RATE,
      CLOUD_SYNC_KEYS.LHDN_TAX_PROFILE,
      CLOUD_SYNC_KEYS.MONTHLY_BUDGET,
      CLOUD_SYNC_KEYS.BASELINE_INCOME,
      CLOUD_SYNC_KEYS.EMERGENCY_RESERVE,
      CLOUD_SYNC_KEYS.CURRENCY,
      CLOUD_SYNC_KEYS.CUSTOM_PIN,
    ] as const;

    managedSettingKeys.forEach((key) => {
      if (queuedByKey.has(key)) {
        // Device has an explicit unpushed offline edit; push it to cloud
        return;
      }
      const localVal = localStorage.getItem(key);
      const rawCloudVal = cloudSettings[key];
      let cloudVal = rawCloudVal !== undefined && rawCloudVal !== null && String(rawCloudVal) !== ''
        ? String(rawCloudVal)
        : '';
      if (key === CLOUD_SYNC_KEYS.CUSTOM_PIN && cloudVal && /^\d{1,4}$/.test(cloudVal.trim())) {
        cloudVal = cloudVal.trim().padStart(4, '0');
      }
      if (cloudVal && !localVal) {
        localStorage.setItem(key, cloudVal);
        window.dispatchEvent(new CustomEvent(SETTINGS_UPDATED_EVENT, { detail: { key, value: cloudVal } }));
        restoredFromCloud = true;
      } else if (localVal && !cloudVal) {
        // Never push an unqueued local setting to a cloud account that doesn't have it;
        // explicit user changes are already tracked in queuedByKey.
        localStorage.removeItem(key);
        window.dispatchEvent(new CustomEvent(SETTINGS_UPDATED_EVENT, { detail: { key, value: '' } }));
        restoredFromCloud = true;
      } else if (cloudVal && localVal && cloudVal !== localVal) {
        // No pending local edit on this device -> cloud value from another device is newer
        localStorage.setItem(key, cloudVal);
        window.dispatchEvent(new CustomEvent(SETTINGS_UPDATED_EVENT, { detail: { key, value: cloudVal } }));
        restoredFromCloud = true;
      }
    });

    // Wait for queued setting writes sequentially to avoid Apps Script LockService contention
    const acknowledgedSnapshots = new Map<string, { mutationId?: string; changedAt?: number }>();
    const updateEntries = Object.entries(pendingCloudUpdates);
    let firstError: unknown = null;
    for (const [k, item] of updateEntries) {
      try {
        const result = await sheetsApi.updateSettings(k, item.value, item.mutationId);
        if (!result.success || result.data?.verified === false) {
          const errMsg = result.message || `Google Sheets rejected or could not verify the ${k} update.`;
          markPendingSettingMutationFailed(k, errMsg);
          if (!firstError) firstError = new Error(errMsg);
          continue;
        }
        acknowledgedSnapshots.set(k, { mutationId: item.mutationId, changedAt: item.changedAt });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        markPendingSettingMutationFailed(k, msg);
        if (!firstError) firstError = err;
      }
    }

    if (acknowledgedSnapshots.size > 0) {
      removePendingSettingMutations(Array.from(acknowledgedSnapshots.keys()), acknowledgedSnapshots);
    }

    if (firstError) {
      throw firstError;
    }

    // Notify UI if data was restored from cloud
    if (restoredFromCloud) {
      window.dispatchEvent(new CustomEvent(SETTINGS_UPDATED_EVENT, { detail: { restored: true } }));
    }

    return { synced: true, restoredFromCloud };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[CloudSync] Sync error:', msg);
    return { synced: false, restoredFromCloud: false, error: msg };
  }
}
