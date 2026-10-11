'use client';

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { syncCloudSettingsWithLocal, SETTINGS_UPDATED_EVENT } from '@/lib/cloud-settings-sync';
import { pruneExpiredCache } from '@/lib/cache-manager';
import { sheetsData } from '@/lib/sheets-data';
import { getApiUrl, sheetsApi } from '@/lib/sheets-api';

/**
 * Global hook that automatically reconciles device localStorage with Google Sheets Settings SOT.
 * Guarantees:
 * 1. Zero latency on initial render (from local rolling cache).
 * 2. Prunes out-of-window cached history (> 60 days / outside 3-month window) to keep device light.
 * 3. Flushes any pending offline mutations so no changes are ever silently discarded.
 * 4. Installs the weekly backup trigger in idle time, without delaying startup.
 */
export function useCloudSettingsSync() {
  const queryClient = useQueryClient();
  const hasSyncedRef = useRef(false);

  useEffect(() => {
    // Prevent double execution in React StrictMode
    if (hasSyncedRef.current) return;
    hasSyncedRef.current = true;

    // Run cache maintenance and cloud reconciliation in idle time
    const scheduleSync = typeof window.requestIdleCallback === 'function'
      ? window.requestIdleCallback
      : (cb: () => void) => setTimeout(cb, 1000);

    scheduleSync(async () => {
      // 1. Prune expired cache outside 60-day / 3-month rolling window (keeps settings & pending safe)
      pruneExpiredCache();

      // 2. Flush any pending offline changes to Google Sheets
      await sheetsData.flushPendingQueue().catch(() => {});

      // 3. Reconcile settings and plans with Google Sheets SOT
      const res = await syncCloudSettingsWithLocal();
      if (res.restoredFromCloud) {
        queryClient.invalidateQueries({ queryKey: ['settings'] });
      }

      // Backups protect records independently of the device cache. Install or
      // verify the weekly Drive trigger in idle time, at most once per day.
      const apiUrl = getApiUrl();
      const lastBackupCheck = Number(localStorage.getItem('cashflow_last_backup_check_at') || 0);
      const ONE_DAY_MS = 24 * 60 * 60 * 1000;
      if (apiUrl.startsWith('http') && Date.now() - lastBackupCheck > ONE_DAY_MS) {
        try {
          const backupRes = await sheetsApi.ensureWeeklyBackup();
          if (backupRes.success && backupRes.data?.triggerInstalled) {
            localStorage.setItem('cashflow_last_backup_check_at', String(Date.now()));
          } else {
            console.warn('[CloudSync] Weekly Drive backup trigger could not be verified:', backupRes.message);
          }
        } catch (err) {
          console.warn('[CloudSync] Weekly Drive backup trigger check failed:', err);
        }
      }

    });

    const handleSettingChanged = () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    };

    window.addEventListener(SETTINGS_UPDATED_EVENT, handleSettingChanged);
    return () => {
      window.removeEventListener(SETTINGS_UPDATED_EVENT, handleSettingChanged);
    };
  }, [queryClient]);
}
