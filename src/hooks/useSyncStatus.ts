'use client';

import { useState, useEffect, useCallback } from 'react';
import { getSyncStatus, SYNC_STATUS_EVENT } from '@/lib/cache-manager';
import { sheetsData } from '@/lib/sheets-data';
import { syncCloudSettingsWithLocal } from '@/lib/cloud-settings-sync';
import { getApiUrl } from '@/lib/sheets-api';

export function useSyncStatus() {
  const [status, setStatus] = useState(() => getSyncStatus());

  const update = useCallback(() => {
    setStatus(getSyncStatus());
  }, []);

  const flushAllPending = useCallback(async (): Promise<{ succeeded: number; failed: number }> => {
    // Local-only edits already live in their separate local database. Do not
    // replay cloud outboxes into that database when the device comes online.
    if (!getApiUrl()) {
      update();
      return { succeeded: 0, failed: 0 };
    }
    const before = getSyncStatus().pendingCount;
    const txRes = await sheetsData.flushPendingQueue().catch(() => ({ total: 0, succeeded: 0, failed: 1 }));
    const settingsRes = await syncCloudSettingsWithLocal().catch(() => ({ synced: false, restoredFromCloud: false }));
    const after = getSyncStatus().pendingCount;
    update();

    const txSucceeded = txRes.succeeded;
    const txFailed = txRes.failed;
    const settingsCleared = Math.max(0, (before - after) - txSucceeded);
    const settingsFailed = settingsRes.synced ? 0 : after;

    return {
      succeeded: txSucceeded + settingsCleared,
      failed: Math.max(txFailed, settingsFailed, after),
    };
  }, [update]);

  useEffect(() => {
    window.addEventListener(SYNC_STATUS_EVENT, update);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);

    // Auto-flush all pending queues (transactions, recurring/installment plans, settings) when coming back online
    const handleOnline = () => {
      update();
      void flushAllPending().catch(() => {});
    };
    const handleConnectionChanged = () => {
      update();
      if (getApiUrl() && navigator.onLine) {
        void flushAllPending().catch(() => {});
      }
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('cashflow_api_url_changed', handleConnectionChanged);

    // If mounted while online with pending items, flush immediately
    if (getApiUrl() && navigator.onLine && getSyncStatus().pendingCount > 0) {
      void flushAllPending().catch(() => {});
    }

    const interval = setInterval(() => {
      update();
      if (getApiUrl() && navigator.onLine && getSyncStatus().pendingCount > 0) {
        void flushAllPending().catch(() => {});
      }
    }, 30000); // Check every 30s for time formatting & pending outbox drain

    return () => {
      window.removeEventListener(SYNC_STATUS_EVENT, update);
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('cashflow_api_url_changed', handleConnectionChanged);
      clearInterval(interval);
    };
  }, [update, flushAllPending]);

  const formattedLastSync = formatRelativeSyncTime(status.lastSyncedAt);

  return {
    ...status,
    formattedLastSync,
    flushPending: flushAllPending,
  };
}

function formatRelativeSyncTime(timestamp: number | null): string {
  if (!timestamp) return 'Never';
  const diffSec = Math.floor((Date.now() - timestamp) / 1000);
  if (diffSec < 10) return 'Just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
