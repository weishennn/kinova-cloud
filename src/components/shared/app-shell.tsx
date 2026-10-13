'use client';

import React, { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { RecordPaymentModal } from './record-modal';
import { EditInstallmentModal } from './edit-installment-modal';
import { AppHeader } from './app-header';
import { ConfirmDialog } from './confirm-dialog';
import { PullToRefresh } from './pull-to-refresh';
import { useCloudSettingsSync } from '@/hooks/useCloudSettingsSync';
import { FloatingDock } from '@/components/money-cockpit/floating-dock';
import { receiptPriceSearchHref, RECEIPT_PRICE_SEARCH_PATH } from '@/lib/receipt-price-search-route';

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
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
