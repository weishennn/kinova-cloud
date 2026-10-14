'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { RefreshCw, Check } from 'lucide-react';
import { useSyncAndRefresh } from '@/hooks/useSyncAndRefresh';

interface PullToRefreshProps {
  onRefresh?: () => Promise<void>;
  onAskPrice?: () => void;
  onAskPriceProgress?: (distance: number, dragging: boolean) => void;
  onAskPriceDismissProgress?: (distance: number, dragging: boolean, closing: boolean) => void;
  isAskPriceOpen?: boolean;
  children?: React.ReactNode;
}

export function PullToRefresh({
  onRefresh,
  onAskPrice,
  onAskPriceProgress,
  onAskPriceDismissProgress,
  isAskPriceOpen = false,
  children,
}: PullToRefreshProps) {
  const { syncAndRefresh } = useSyncAndRefresh();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);

  const startYRef = useRef<number | null>(null);
  const lastYRef = useRef<number | null>(null);
  const lastMoveAtRef = useRef(0);
  const gestureVelocityRef = useRef(0);
  const isDraggingRef = useRef(false);
  const isDismissDraggingRef = useRef(false);
  const pullDistanceRef = useRef(0);
  const dismissDistanceRef = useRef(0);
  const dismissTargetRef = useRef<HTMLElement | null>(null);
  const hasVibratedRef = useRef(false);

  const REFRESH_THRESHOLD = 52;

  const handleTouchStart = useCallback((e: TouchEvent) => {
    const target = e.target instanceof Element ? e.target : null;
    const interactiveTarget = target?.closest('a,button,input,textarea,select,[role="button"],[contenteditable="true"],[data-pull-to-refresh-ignore]');
    const y = e.touches[0].clientY;
    const now = performance.now();

    if (isAskPriceOpen) {
      const header = target?.closest<HTMLElement>('.receipt-price-page-nav');
      const welcome = target?.closest<HTMLElement>('.receipt-price-welcome');
      const canDismissFromWelcome = Boolean(
        welcome &&
        !document.querySelector('.receipt-price-conversation') &&
        !interactiveTarget
      );
      if ((!header || interactiveTarget) && !canDismissFromWelcome) return;

      startYRef.current = y;
      lastYRef.current = y;
      lastMoveAtRef.current = now;
      gestureVelocityRef.current = 0;
      isDismissDraggingRef.current = true;
      dismissDistanceRef.current = 0;
      dismissTargetRef.current = (header || welcome)?.closest<HTMLElement>('.receipt-price-reveal') || null;
      dismissTargetRef.current?.setAttribute('data-dismissing', 'true');
      onAskPriceDismissProgress?.(0, true, false);
      return;
    }

    if (
      document.body.classList.contains('modal-open') ||
      interactiveTarget ||
      target?.closest('[role="dialog"]') ||
      window.scrollY > 5 ||
      document.documentElement.scrollTop > 5 ||
      isRefreshing
    ) {
      startYRef.current = null;
      isDraggingRef.current = false;
      return;
    }

    startYRef.current = y;
    lastYRef.current = y;
    lastMoveAtRef.current = now;
    gestureVelocityRef.current = 0;
    isDraggingRef.current = true;
    pullDistanceRef.current = 0;
    hasVibratedRef.current = false;
    onAskPriceProgress?.(0, true);
  }, [isAskPriceOpen, isRefreshing, onAskPriceProgress, onAskPriceDismissProgress]);

  const handleTouchMove = useCallback((e: TouchEvent) => {
    const currentY = e.touches[0].clientY;
    const now = performance.now();
    const elapsed = Math.max(1, now - lastMoveAtRef.current);
    const previousY = lastYRef.current ?? currentY;
    gestureVelocityRef.current = (currentY - previousY) / elapsed;
    lastYRef.current = currentY;
    lastMoveAtRef.current = now;

    if (isDismissDraggingRef.current && startYRef.current !== null) {
      if (currentY < previousY && e.cancelable) e.preventDefault();
      const upwardDistance = Math.max(0, startYRef.current - currentY);
      const viewportHeight = Math.max(1, window.innerHeight);
      const freeTravel = viewportHeight * 0.68;
      dismissDistanceRef.current = Math.min(
        viewportHeight * 0.9,
        upwardDistance <= freeTravel ? upwardDistance : freeTravel + (upwardDistance - freeTravel) * 0.38,
      );
      dismissTargetRef.current?.style.setProperty('--receipt-price-dismiss-offset', `${dismissDistanceRef.current}px`);
      onAskPriceDismissProgress?.(dismissDistanceRef.current, true, false);
      return;
    }

    if (!isDraggingRef.current || startYRef.current === null || isRefreshing) return;

    if (window.scrollY > 5 || document.documentElement.scrollTop > 5) {
      isDraggingRef.current = false;
      startYRef.current = null;
      pullDistanceRef.current = 0;
      onAskPriceProgress?.(0, false);
      return;
    }

    const diff = currentY - startYRef.current;
    if (diff <= 0) {
      pullDistanceRef.current = 0;
      onAskPriceProgress?.(0, true);
      return;
    }

    // Keep the page moving with the finger across most of the viewport.
    const viewportHeight = Math.max(1, window.innerHeight);
    const freeTravel = viewportHeight * 0.68;
    const followDistance = Math.min(
      viewportHeight * 0.9,
      diff <= freeTravel ? diff : freeTravel + (diff - freeTravel) * 0.38,
    );
    pullDistanceRef.current = followDistance;
    onAskPriceProgress?.(followDistance, true);

    if (followDistance >= REFRESH_THRESHOLD && !hasVibratedRef.current) {
      hasVibratedRef.current = true;
      if ('vibrate' in navigator) {
        try {
          navigator.vibrate(12);
        } catch {
          // Ignore vibration failures if not permitted.
        }
      }
    } else if (followDistance < REFRESH_THRESHOLD) {
      hasVibratedRef.current = false;
    }
  }, [isRefreshing, onAskPriceProgress, onAskPriceDismissProgress]);

  const handleTouchEnd = useCallback(async () => {
    if (isDismissDraggingRef.current) {
      isDismissDraggingRef.current = false;
      startYRef.current = null;
      lastYRef.current = null;
      const dismissTarget = dismissTargetRef.current;
      dismissTarget?.removeAttribute('data-dismissing');
      const dismissThreshold = Math.max(56, window.innerHeight * 0.1);
      const quickUpwardFlick = gestureVelocityRef.current <= -0.42 && dismissDistanceRef.current >= 18;

      if (dismissDistanceRef.current >= dismissThreshold || quickUpwardFlick) {
        const closeDistance = window.innerHeight;
        dismissTarget?.style.setProperty('--receipt-price-dismiss-offset', `${closeDistance}px`);
        onAskPriceDismissProgress?.(closeDistance, false, true);
      } else {
        dismissTarget?.style.setProperty('--receipt-price-dismiss-offset', '0px');
        onAskPriceDismissProgress?.(0, false, false);
      }

      dismissTargetRef.current = null;
      dismissDistanceRef.current = 0;
      return;
    }

    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    startYRef.current = null;
    lastYRef.current = null;

    const finalPullDistance = pullDistanceRef.current;
    pullDistanceRef.current = 0;
    const viewportHeight = Math.max(1, window.innerHeight);
    const askPriceThreshold = Math.min(176, Math.max(96, viewportHeight * 0.18));
    const quickDownwardFlick = gestureVelocityRef.current >= 0.72 && finalPullDistance >= 42;

    if ((finalPullDistance >= askPriceThreshold || quickDownwardFlick) && !isRefreshing && onAskPrice) {
      onAskPriceProgress?.(finalPullDistance, false);
      onAskPrice();
      return;
    }

    onAskPriceProgress?.(0, false);
    if (finalPullDistance < REFRESH_THRESHOLD || isRefreshing) return;

    setIsRefreshing(true);
    try {
      if (onRefresh) await onRefresh();
      else await syncAndRefresh();
      setShowSuccess(true);
      window.setTimeout(() => {
        setShowSuccess(false);
        setIsRefreshing(false);
      }, 500);
    } catch (error) {
      console.warn('Pull-to-refresh error:', error);
      setIsRefreshing(false);
    }
  }, [isRefreshing, onRefresh, onAskPrice, onAskPriceProgress, onAskPriceDismissProgress, syncAndRefresh]);

  const handleTouchCancel = useCallback(() => {
    if (isDismissDraggingRef.current) {
      isDismissDraggingRef.current = false;
      startYRef.current = null;
      lastYRef.current = null;
      dismissTargetRef.current?.removeAttribute('data-dismissing');
      dismissTargetRef.current?.style.setProperty('--receipt-price-dismiss-offset', '0px');
      onAskPriceDismissProgress?.(0, false, false);
      dismissTargetRef.current = null;
      dismissDistanceRef.current = 0;
      return;
    }

    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    startYRef.current = null;
    lastYRef.current = null;
    pullDistanceRef.current = 0;
    onAskPriceProgress?.(0, false);
  }, [onAskPriceProgress, onAskPriceDismissProgress]);

  useEffect(() => {
    window.addEventListener('touchstart', handleTouchStart, { passive: true });
    window.addEventListener('touchmove', handleTouchMove, { passive: false });
    window.addEventListener('touchend', handleTouchEnd, { passive: true });
    window.addEventListener('touchcancel', handleTouchCancel, { passive: true });

    return () => {
      window.removeEventListener('touchstart', handleTouchStart);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', handleTouchEnd);
      window.removeEventListener('touchcancel', handleTouchCancel);
    };
  }, [handleTouchStart, handleTouchMove, handleTouchEnd, handleTouchCancel]);

  const isVisible = isRefreshing || showSuccess;

  return (
    <>
      <AnimatePresence>
        {isVisible && (
          <motion.div
            initial={{ opacity: 0, y: -20, scale: 0.8 }}
            animate={{ opacity: 1, y: 16, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.8 }}
            transition={{ type: 'spring', stiffness: 450, damping: 30 }}
            className="fixed top-14 sm:top-16 inset-x-0 mx-auto z-40 flex items-center justify-center pointer-events-none select-none"
          >
            <div className="flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-white/90 dark:bg-zinc-950/90 border border-slate-200 dark:border-white/[0.15] backdrop-blur-2xl shadow-[0_8px_30px_rgba(0,0,0,0.7)] text-xs font-semibold">
              {showSuccess ? (
                <>
                  <div className="flex items-center justify-center h-4 w-4 rounded-full bg-emerald-500/20 text-emerald-800 dark:text-emerald-400">
                    <Check className="h-3 w-3" />
                  </div>
                  <span className="text-emerald-800 dark:text-emerald-300 font-mono text-[11px]">Synced ⚡</span>
                </>
              ) : (
                <>
                  <RefreshCw className="h-3.5 w-3.5 text-indigo-800 dark:text-indigo-400 animate-spin" />
                  <span className="text-slate-800 dark:text-zinc-200 font-medium text-[11px]">Syncing...</span>
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {children}
    </>
  );
}
