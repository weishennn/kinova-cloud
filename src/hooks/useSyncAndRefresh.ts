'use client';

import { useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { getApiUrl, clearAllSwrCache } from '@/lib/sheets-api';
import { syncAllGoogleSheets } from '@/lib/sync-engine';
import { syncCloudSettingsWithLocal } from '@/lib/cloud-settings-sync';
import { getSyncStatus } from '@/lib/cache-manager';

export function useSyncAndRefresh() {
  const queryClient = useQueryClient();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [justRefreshed, setJustRefreshed] = useState(false);

  const syncAndRefresh = useCallback(async (options?: { silent?: boolean }) => {
    if (isRefreshing) return;
    setIsRefreshing(true);

    try {
      const isCloudConnected = !!getApiUrl();
      if (isCloudConnected) {
        const sheetSync = await syncAllGoogleSheets();
        const settingsSync = await syncCloudSettingsWithLocal();
        if (!sheetSync.success || !settingsSync.synced || getSyncStatus().pendingCount > 0) {
          throw new Error('Some changes are still waiting to sync.');
        }
      } else if (!options?.silent) {
        toast.info('Refreshed local data. Google Sheets is not connected.');
      }

      // Refresh visible queries only after cloud reconciliation has completed.
      await queryClient.invalidateQueries();
      await queryClient.refetchQueries({ type: 'active' }, { throwOnError: false });

      setJustRefreshed(isCloudConnected);
      if (isCloudConnected && !options?.silent) {
        toast.success('Google Sheets sync completed.');
      }
      setTimeout(() => setJustRefreshed(false), 2000);
    } catch (err) {
      console.error('Sync & Refresh error', err);
      await queryClient.refetchQueries({ type: 'active' }, { throwOnError: false });
      if (!options?.silent) {
        toast.error(err instanceof Error ? err.message : 'Sync failed. Your pending changes are still saved on this device.');
      }
    } finally {
      setIsRefreshing(false);
    }
  }, [isRefreshing, queryClient]);

  return {
    isRefreshing,
    justRefreshed,
    syncAndRefresh,
  };
}
