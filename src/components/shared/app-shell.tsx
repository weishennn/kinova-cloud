'use client';

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { motion, useMotionValue, animate } from 'framer-motion';
import { Sparkles } from 'lucide-react';
import { RecordPaymentModal } from './record-modal';
import { EditInstallmentModal } from './edit-installment-modal';
import { AppHeader } from './app-header';
import { ConfirmDialog } from './confirm-dialog';
import { useCloudSettingsSync } from '@/hooks/useCloudSettingsSync';
import { FloatingDock } from '@/components/money-cockpit/floating-dock';
import { RECEIPT_PRICE_SEARCH_PATH } from '@/lib/receipt-price-search-route';
import { ReceiptPriceSearch } from './receipt-price-search';
import { useAppStore } from '@/stores/app-store';
import { updateUnifiedRow } from '@/hooks/useSheets';
import { useSyncAndRefresh } from '@/hooks/useSyncAndRefresh';
import { driveApi, getActiveUserCacheScope, sheetsApi } from '@/lib/sheets-api';
import {
  processPendingReceiptUploads,
  RECEIPT_UPLOAD_QUEUE_EVENT,
  receiptUploadQueueStore,
} from '@/lib/receipt-upload-queue';

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const { syncAndRefresh } = useSyncAndRefresh();
  const isKinovaAIOpen = useAppStore((s) => s.isKinovaAIOpen);
  const setKinovaAIOpen = useAppStore((s) => s.setKinovaAIOpen);

  const isCockpit = pathname === '/';
  const isReceiptPriceSearchPage = pathname === RECEIPT_PRICE_SEARCH_PATH;

  // Spring physics vertical translation for the main dashboard frame
  const y = useMotionValue(0);
  const [pullDistance, setPullDistance] = useState(0);
  const [isPastThreshold, setIsPastThreshold] = useState(false);
  const [isOffscreen, setIsOffscreen] = useState(false);

  const PULL_THRESHOLD = 80;
  const startYRef = useRef<number | null>(null);
  const startXRef = useRef<number | null>(null);
  const isTrackingPullRef = useRef(false);
  const hasVibratedRef = useRef(false);

  const openTouchStartYRef = useRef<number | null>(null);
  const openTouchStartXRef = useRef<number | null>(null);

  // Sync motion value with isKinovaAIOpen state with spring physics
  useEffect(() => {
    if (isReceiptPriceSearchPage) return;

    if (isKinovaAIOpen) {
      void queryClient.invalidateQueries({ queryKey: ['sheet'] });
      const targetHeight = typeof window !== 'undefined' ? window.innerHeight + 80 : 960;
      animate(y, targetHeight, {
        type: 'spring',
        damping: 30,
        stiffness: 340,
        mass: 0.8,
      }).then(() => {
        setIsOffscreen(true);
      });
    } else {
      setIsOffscreen(false);
      animate(y, 0, {
        type: 'spring',
        damping: 30,
        stiffness: 360,
        mass: 0.8,
      });
      setPullDistance(0);
      setIsPastThreshold(false);
    }
  }, [isKinovaAIOpen, isReceiptPriceSearchPage, y, queryClient]);

  // Pull-down gesture listener (active only when at top of page, window.scrollY <= 0)
  useEffect(() => {
    if (isReceiptPriceSearchPage) return;

    const handleTouchStart = (e: TouchEvent) => {
      if (isKinovaAIOpen) return;
      if (
        document.body.classList.contains('modal-open') ||
        (e.target instanceof Element && e.target.closest('[role="dialog"]'))
      ) {
        startYRef.current = null;
        return;
      }
      if (window.scrollY > 2 || document.documentElement.scrollTop > 2) {
        startYRef.current = null;
        return;
      }

      startYRef.current = e.touches[0].clientY;
      startXRef.current = e.touches[0].clientX;
      isTrackingPullRef.current = false;
      hasVibratedRef.current = false;
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (isKinovaAIOpen || startYRef.current === null) return;

      if (window.scrollY > 2 || document.documentElement.scrollTop > 2) {
        if (isTrackingPullRef.current) {
          y.set(0);
          setPullDistance(0);
          setIsPastThreshold(false);
        }
        startYRef.current = null;
        isTrackingPullRef.current = false;
        return;
      }

      const currentY = e.touches[0].clientY;
      const currentX = e.touches[0].clientX;
      const deltaY = currentY - startYRef.current;
      const deltaX = currentX - (startXRef.current ?? currentX);

      // If scrolling up or horizontal motion dominates, abort gesture
      if (deltaY <= 0 || Math.abs(deltaX) > Math.abs(deltaY) * 1.4) {
        if (isTrackingPullRef.current) {
          y.set(0);
          setPullDistance(0);
          setIsPastThreshold(false);
          isTrackingPullRef.current = false;
        }
        return;
      }

      // Engaged in pull down at the top of the page
      isTrackingPullRef.current = true;
      if (e.cancelable) e.preventDefault();

      // Rubber-band resistance formula
      const damped = Math.min(170, Math.pow(deltaY, 0.82) * 1.55);
      y.set(damped);
      setPullDistance(damped);

      if (damped >= PULL_THRESHOLD) {
        if (!hasVibratedRef.current) {
          hasVibratedRef.current = true;
          if (typeof window !== 'undefined' && 'vibrate' in navigator) {
            try { navigator.vibrate(14); } catch (_) {}
          }
        }
        setIsPastThreshold(true);
      } else {
        hasVibratedRef.current = false;
        setIsPastThreshold(false);
      }
    };

    const handleTouchEnd = () => {
      if (isKinovaAIOpen || !isTrackingPullRef.current) {
        startYRef.current = null;
        return;
      }
      isTrackingPullRef.current = false;
      startYRef.current = null;

      const currentY = y.get();
      if (currentY >= PULL_THRESHOLD) {
        setKinovaAIOpen(true);
        void syncAndRefresh();
      } else {
        animate(y, 0, {
          type: 'spring',
          damping: 30,
          stiffness: 400,
        });
        setPullDistance(0);
        setIsPastThreshold(false);
        if (currentY >= 45) {
          void syncAndRefresh();
        }
      }
    };

    window.addEventListener('touchstart', handleTouchStart, { passive: true });
    window.addEventListener('touchmove', handleTouchMove, { passive: false });
    window.addEventListener('touchend', handleTouchEnd, { passive: true });
    window.addEventListener('touchcancel', handleTouchEnd, { passive: true });

    return () => {
      window.removeEventListener('touchstart', handleTouchStart);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', handleTouchEnd);
      window.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [isKinovaAIOpen, isReceiptPriceSearchPage, setKinovaAIOpen, syncAndRefresh, y]);

  // Swipe UP listener when Kinova AI is open to cleanly exit
  useEffect(() => {
    if (!isKinovaAIOpen || isReceiptPriceSearchPage) return;

    const handleSwipeUpStart = (e: TouchEvent) => {
      // Only trigger swipe-up dismiss if gesture initiates in bottom dock/handle zone
      const windowHeight = typeof window !== 'undefined' ? window.innerHeight : 800;
      if (e.touches[0].clientY < windowHeight - 120) {
        openTouchStartYRef.current = null;
        return;
      }
      openTouchStartYRef.current = e.touches[0].clientY;
      openTouchStartXRef.current = e.touches[0].clientX;
    };

    const handleSwipeUpEnd = (e: TouchEvent) => {
      if (openTouchStartYRef.current === null) return;
      const endY = e.changedTouches[0].clientY;
      const endX = e.changedTouches[0].clientX;
      const deltaY = endY - openTouchStartYRef.current;
      const deltaX = endX - (openTouchStartXRef.current ?? endX);

      // User swiped up by > 25px from bottom handle
      if (deltaY < -25 && Math.abs(deltaY) > Math.abs(deltaX) * 1.1) {
        setKinovaAIOpen(false);
      }
      openTouchStartYRef.current = null;
      openTouchStartXRef.current = null;
    };

    window.addEventListener('touchstart', handleSwipeUpStart, { passive: true });
    window.addEventListener('touchend', handleSwipeUpEnd, { passive: true });

    return () => {
      window.removeEventListener('touchstart', handleSwipeUpStart);
      window.removeEventListener('touchend', handleSwipeUpEnd);
    };
  }, [isKinovaAIOpen, isReceiptPriceSearchPage, setKinovaAIOpen]);

  // Lock body scroll when Kinova AI is open so mobile keyboard does not scroll underlying page
  useEffect(() => {
    if (isKinovaAIOpen) {
      const origOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = origOverflow;
      };
    }
  }, [isKinovaAIOpen]);

  // Escape key closes Kinova AI
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isKinovaAIOpen) {
        setKinovaAIOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isKinovaAIOpen, setKinovaAIOpen]);

  // Global non-blocking Cloud SOT sync
  useCloudSettingsSync();

  // Mobile status bar theme color adjustment when Kinova AI is open
  useLayoutEffect(() => {
    if (!isKinovaAIOpen) return;
    const themeColorMetas = Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));
    const previousColors = themeColorMetas.map((meta) => [meta, meta.getAttribute('content')] as const);
    themeColorMetas.forEach((meta) => meta.setAttribute('content', '#0c0d1e'));
    return () => {
      previousColors.forEach(([meta, color]) => {
        if (color === null) meta.removeAttribute('content');
        else meta.setAttribute('content', color);
      });
    };
  }, [isKinovaAIOpen]);

  // Register PWA Service Worker
  useEffect(() => {
    if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }, []);

  // Offline durable receipt upload queue
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
        console.warn('[ReceiptUploadQueue] Could not schedule next retry:', error);
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
    <div className="relative min-h-screen bg-background text-foreground selection:bg-indigo-500/30 overflow-x-clip antialiased money-cockpit-shell">
      {/* Background Layer: Kinova AI & Pull-down Pill (Inspired by Ryt Bank) */}
      {!isReceiptPriceSearchPage && (
        <div
          className="fixed inset-0 z-0 overflow-hidden"
          aria-hidden={!isKinovaAIOpen}
          inert={!isKinovaAIOpen}
        >
          {/* Top dynamic pull-down pill indicator */}
          <div
            className="absolute top-4 sm:top-5 inset-x-0 mx-auto flex items-center justify-center pointer-events-none z-30 transition-opacity duration-150"
            style={{ opacity: pullDistance > 16 && !isKinovaAIOpen ? 1 : 0 }}
          >
            <div className={`px-4 py-2 rounded-full border backdrop-blur-2xl text-xs font-semibold flex items-center gap-2 transition-all duration-200 shadow-2xl ${
              isPastThreshold
                ? 'bg-indigo-600/70 border-indigo-400 text-white shadow-[0_0_25px_rgba(99,102,241,0.6)] scale-105'
                : 'bg-white/10 border-white/20 text-white/90'
            }`}>
              <Sparkles className={`w-3.5 h-3.5 text-indigo-300 ${isPastThreshold ? 'animate-spin' : ''}`} />
              <span>{isPastThreshold ? 'Release for ✨ Kinova AI' : 'Pull down for Kinova AI'}</span>
            </div>
          </div>

          <ReceiptPriceSearch
            returnTo={pathname || '/'}
            isOpen={isKinovaAIOpen}
            onClose={() => setKinovaAIOpen(false)}
          />
        </div>
      )}

      {/* Main Content Area (Slides down with spring physics, becomes invisible when off-screen to avoid mobile keyboard scroll leaks) */}
      <motion.div
        style={{ y }}
        className={`relative z-10 flex min-h-screen flex-1 flex-col min-w-0 bg-[var(--cockpit-bg)] shadow-[0_20px_50px_rgba(0,0,0,0.35)] ${
          isOffscreen ? 'invisible pointer-events-none' : ''
        }`}
        aria-hidden={isKinovaAIOpen}
        inert={isKinovaAIOpen}
      >
        <div className={`relative flex-1 flex flex-col min-w-0 ${isReceiptPriceSearchPage ? 'receipt-price-shell' : isCockpit ? 'money-cockpit-content' : 'money-legacy-content pb-28 lg:pb-24'}`}>
          {!isReceiptPriceSearchPage && <AppHeader />}
          <main className={`flex-1 w-full ${isReceiptPriceSearchPage ? 'receipt-price-main' : isCockpit ? 'max-w-none mx-0 p-0 money-cockpit-main' : 'money-legacy-main'}`}>
            {children}
          </main>
        </div>

        {/* Mobile Bottom Navigation (hidden on desktop) */}
        {!isReceiptPriceSearchPage && <FloatingDock />}
      </motion.div>

      {/* Global Modals */}
      <RecordPaymentModal />
      <EditInstallmentModal />
      <ConfirmDialog />
    </div>
  );
}
