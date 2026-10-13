'use client';

import React, { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { RecordPaymentModal } from './record-modal';
import { EditInstallmentModal } from './edit-installment-modal';
import { AppHeader } from './app-header';
import { ConfirmDialog } from './confirm-dialog';
import { PullToRefresh } from './pull-to-refresh';
import { useCloudSettingsSync } from '@/hooks/useCloudSettingsSync';
import { FloatingDock } from '@/components/money-cockpit/floating-dock';
import { receiptPriceSearchHref, RECEIPT_PRICE_SEARCH_PATH } from '@/lib/receipt-price-search-route';
import { updateUnifiedRow } from '@/hooks/useSheets';
import { driveApi, getActiveUserCacheScope, sheetsApi } from '@/lib/sheets-api';
import {
  processPendingReceiptUploads,
  RECEIPT_UPLOAD_QUEUE_EVENT,
  receiptUploadQueueStore,
} from '@/lib/receipt-upload-queue';

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const isCockpit = pathname === '/';
  const isReceiptPriceSearchPage = pathname === RECEIPT_PRICE_SEARCH_PATH;

  // Global non-blocking Cloud SOT sync (zero latency, zero data loss)
  useCloudSettingsSync();

  // Register PWA Service Worker so Kinova opens offline (Airplane Mode)
  useEffect(() => {
    if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }, []);

  // Resume queued receipt uploads whenever the app is opened or returns online.
  useEffect(() => {
    let disposed = false;
    let running = false;
    let retryTimer: number | undefined;

    const clearRetryTimer = () => {
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
        retryTimer = undefined;
      }
    };

    const scheduleNextAttempt = async () => {
      clearRetryTimer();
      if (disposed || !navigator.onLine || document.visibilityState === 'hidden') return;
      try {
        const nextAt = await receiptUploadQueueStore.nextWakeAt(getActiveUserCacheScope());
        if (disposed || nextAt === null) return;
        retryTimer = window.setTimeout(() => void drainQueue(), Math.max(500, nextAt - Date.now()));
      } catch (error) {
        console.warn('[ReceiptUploadQueue] Could not schedule the next retry:', error);
      }
    };

    const drainQueue = async () => {
      if (
        disposed ||
        running ||
        localStorage.getItem('cashflow_test_mode') === 'true' ||
        !navigator.onLine ||
        document.visibilityState === 'hidden'
      ) return;
      running = true;
      try {
        const result = await processPendingReceiptUploads({
          store: receiptUploadQueueStore,
          accountScope: getActiveUserCacheScope(),
          isTransactionReady: async (item) => {
            if (getActiveUserCacheScope() !== item.accountScope) return false;
            const response = await sheetsApi.getSheetData(item.sheetName);
            const rows = response.data?.rows || [];
            return Boolean(
              response.success && rows.some((row) => String(row.Id || row.id || '') === item.transactionId)
            );
          },
          uploadFile: async (item) => {
            if (getActiveUserCacheScope() !== item.accountScope) {
              throw new Error('Receipt upload paused because the active account changed.');
            }
            const response = await driveApi.uploadFile(item.fileName, item.mimeType, item.base64);
            const url = response.data?.url || '';
            if (!url) throw new Error('Google Drive did not return a receipt link.');
            return url;
          },
          attachReceipt: (item) => {
            if (getActiveUserCacheScope() !== item.accountScope) {
              throw new Error('Receipt linking paused because the active account changed.');
            }
            return updateUnifiedRow(item.sheetName, item.rowIndex, {
              Id: item.transactionId,
              id: item.transactionId,
              ReceiptUrl: item.uploadedUrl || '',
            });
          },
        });

        if (result.completed > 0) {
          await queryClient.invalidateQueries({ queryKey: ['sheet'] });
          await queryClient.invalidateQueries({ queryKey: ['overview'] });
        }
      } catch (error) {
        console.warn('[ReceiptUploadQueue] Could not process pending receipts:', error);
      } finally {
        running = false;
        await scheduleNextAttempt();
      }
    };

    const handleWake = () => void drainQueue();
    window.addEventListener('online', handleWake);
    window.addEventListener('focus', handleWake);
    window.addEventListener(RECEIPT_UPLOAD_QUEUE_EVENT, handleWake);
    window.addEventListener('cashflow_api_url_changed', handleWake);
    document.addEventListener('visibilitychange', handleWake);
    void drainQueue();

    return () => {
      disposed = true;
      clearRetryTimer();
      window.removeEventListener('online', handleWake);
      window.removeEventListener('focus', handleWake);
      window.removeEventListener(RECEIPT_UPLOAD_QUEUE_EVENT, handleWake);
      window.removeEventListener('cashflow_api_url_changed', handleWake);
      document.removeEventListener('visibilitychange', handleWake);
    };
  }, [queryClient]);

  return (
    <div className="relative flex min-h-screen bg-background text-foreground selection:bg-violet-500/30 overflow-x-clip antialiased money-cockpit-shell">
      {/* Pull-To-Refresh Gesture on mobile */}
      {!isReceiptPriceSearchPage && (
        <PullToRefresh onAskPrice={() => router.push(receiptPriceSearchHref(pathname))} />
      )}

      {/* Main Content Area */}
      <div className={`relative flex-1 flex flex-col min-w-0 ${isReceiptPriceSearchPage ? 'receipt-price-shell' : isCockpit ? 'money-cockpit-content' : 'money-legacy-content pb-28 lg:pb-24'}`}>
        {!isReceiptPriceSearchPage && <AppHeader />}
        <main className={`flex-1 w-full ${isReceiptPriceSearchPage ? 'receipt-price-main' : isCockpit ? 'max-w-none mx-0 p-0 money-cockpit-main' : 'money-legacy-main'}`}>
          {children}
        </main>
      </div>

      {/* Mobile Bottom Navigation (hidden on desktop) */}
      {!isReceiptPriceSearchPage && <FloatingDock />}

      {/* Global Record Payment Modal */}
      <RecordPaymentModal />

      {/* Global Edit Installment Plan Modal */}
      <EditInstallmentModal />

      {/* Global Glassmorphic Confirmation Modal */}
      <ConfirmDialog />
    </div>
  );
}
