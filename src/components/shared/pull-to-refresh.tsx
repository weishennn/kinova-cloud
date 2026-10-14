'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { RefreshCw, ArrowDown, Check } from 'lucide-react';
import { useSyncAndRefresh } from '@/hooks/useSyncAndRefresh';

interface PullToRefreshProps {
  onRefresh?: () => Promise<void>;
  onAskPrice?: () => void;
  onAskPriceProgress?: (distance: number, dragging: boolean) => void;
  isAskPriceOpen?: boolean;
  onCloseAskPrice?: () => void;
  children?: React.ReactNode;
}

export function PullToRefresh({
  onRefresh,
  onAskPrice,
  onAskPriceProgress,
  isAskPriceOpen = false,
  onCloseAskPrice,
  children,
}: PullToRefreshProps) {
  const { isRefreshing: isHookRefreshing, syncAndRefresh } = useSyncAndRefresh();
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);

  const startYRef = useRef<number | null>(null);
  const isDraggingRef = useRef(false);
  const isDismissDraggingRef = useRef(false);
  const pullDistanceRef = useRef(0);
  const dismissDistanceRef = useRef(0);
  const dismissTargetRef = useRef<HTMLElement | null>(null);
  const hasVibratedRef = useRef(false);

  const REFRESH_THRESHOLD = 52;
  const ASK_PRICE_THRESHOLD = 106;

  const handleTouchStart = useCallback((e: TouchEvent) => {
    if (isAskPriceOpen) {
      const target = e.target instanceof Element ? e.target : null;
      const header = target?.closest<HTMLElement>('.receipt-price-page-nav');
      if (!header || target?.closest('a,button,input,textarea,select,[role="button"]')) return;

      startYRef.current = e.touches[0].clientY;
      isDismissDraggingRef.current = true;
      dismissDistanceRef.current = 0;
      dismissTargetRef.current = header.closest<HTMLElement>('.receipt-price-reveal');
      dismissTargetRef.current?.setAttribute('data-dismissing', 'true');
      return;
    }

    if (
      document.body.classList.contains('modal-open') ||
      (e.target instanceof Element && e.target.closest('[role="dialog"]'))
    ) {
      startYRef.current = null;
      isDraggingRef.current = false;
      return;
    }
    // Only engage pull-to-refresh when user is at the very top of the page
    if (window.scrollY > 5 || document.documentElement.scrollTop > 5 || isRefreshing) {
      startYRef.current = null;
      isDraggingRef.current = false;
      return;
    }

    startYRef.current = e.touches[0].clientY;
    isDraggingRef.current = true;
    pullDistanceRef.current = 0;
    onAskPriceProgress?.(0, true);
    hasVibratedRef.current = false;
  }, [isAskPriceOpen, isRefreshing, onAskPriceProgress]);

  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (isDismissDraggingRef.current && startYRef.current !== null) {
      const upwardDistance = startYRef.current - e.touches[0].clientY;
      dismissDistanceRef.current = Math.min(160, Math.max(0, upwardDistance * 0.82));
      dismissTargetRef.current?.style.setProperty('--receipt-price-dismiss-offset', `${dismissDistanceRef.current}px`);
      return;
    }

    if (!isDraggingRef.current || startYRef.current === null || isRefreshing) return;

    // Check again to ensure we haven't scrolled down
    if (window.scrollY > 5 || document.documentElement.scrollTop > 5) {
      isDraggingRef.current = false;
      pullDistanceRef.current = 0;
      setPullDistance(0);
      onAskPriceProgress?.(0, false);
      return;
    }

    const currentY = e.touches[0].clientY;
    const diff = currentY - startYRef.current;

    if (diff <= 0) {
      pullDistanceRef.current = 0;
      setPullDistance(0);
      onAskPriceProgress?.(0, true);
      return;
    }

    // Apply smooth rubber-band resistance curve
    const dampedDistance = Math.min(124, Math.pow(diff, 0.85) * 2);
    pullDistanceRef.current = dampedDistance;
    setPullDistance(dampedDistance);
    onAskPriceProgress?.(dampedDistance, true);

    // Haptic feedback once when crossing the threshold
    if (dampedDistance >= REFRESH_THRESHOLD && !hasVibratedRef.current) {
      hasVibratedRef.current = true;
      if (typeof window !== 'undefined' && 'vibrate' in navigator) {
        try {
          navigator.vibrate(12);
        } catch {
          // Ignore vibration failures if not permitted
        }
      }
    } else if (dampedDistance < REFRESH_THRESHOLD) {
      hasVibratedRef.current = false;
    }
  }, [isRefreshing, onAskPriceProgress]);

  const handleTouchEnd = useCallback(async () => {
    if (isDismissDraggingRef.current) {
      isDismissDraggingRef.current = false;
      startYRef.current = null;
      const dismissTarget = dismissTargetRef.current;
      dismissTarget?.removeAttribute('data-dismissing');
      if (dismissDistanceRef.current >= 86) {
        onCloseAskPrice?.();
        window.setTimeout(() => {
          dismissTarget?.style.setProperty('--receipt-price-dismiss-offset', '0px');
        }, 360);
      } else {
        dismissTarget?.style.setProperty('--receipt-price-dismiss-offset', '0px');
      }
      dismissTargetRef.current = null;
      dismissDistanceRef.current = 0;
      return;
    }

    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    startYRef.current = null;
    const finalPullDistance = pullDistanceRef.current;
    pullDistanceRef.current = 0;

    if (finalPullDistance >= ASK_PRICE_THRESHOLD && !isRefreshing && onAskPrice) {
      onAskPriceProgress?.(finalPullDistance, false);
      setPullDistance(0);
      onAskPrice();
      return;
    }

    onAskPriceProgress?.(0, false);
    if (finalPullDistance >= REFRESH_THRESHOLD && !isRefreshing) {
      setIsRefreshing(true);
      setPullDistance(REFRESH_THRESHOLD);

      try {
        if (onRefresh) {
          await onRefresh();
        } else {
          await syncAndRefresh();
        }
        setShowSuccess(true);
        setTimeout(() => {
          setShowSuccess(false);
          setIsRefreshing(false);
          setPullDistance(0);
        }, 500);
      } catch (err) {
        console.warn('Pull-to-refresh error:', err);
        setIsRefreshing(false);
        setPullDistance(0);
      }
    } else {
      setPullDistance(0);
    }
  }, [isRefreshing, onRefresh, onAskPrice, onAskPriceProgress, onCloseAskPrice, syncAndRefresh]);

  const handleTouchCancel = useCallback(() => {
    if (isDismissDraggingRef.current) {
      isDismissDraggingRef.current = false;
      startYRef.current = null;
      dismissTargetRef.current?.removeAttribute('data-dismissing');
      dismissTargetRef.current?.style.setProperty('--receipt-price-dismiss-offset', '0px');
      dismissTargetRef.current = null;
      dismissDistanceRef.current = 0;
      return;
    }

    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    startYRef.current = null;
    pullDistanceRef.current = 0;
    setPullDistance(0);
    onAskPriceProgress?.(0, false);
  }, [onAskPriceProgress]);

  useEffect(() => {
    window.addEventListener('touchstart', handleTouchStart, { passive: true });
    window.addEventListener('touchmove', handleTouchMove, { passive: true });
    window.addEventListener('touchend', handleTouchEnd, { passive: true });
    window.addEventListener('touchcancel', handleTouchCancel, { passive: true });

    return () => {
      window.removeEventListener('touchstart', handleTouchStart);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', handleTouchEnd);
      window.removeEventListener('touchcancel', handleTouchCancel);
    };
  }, [handleTouchStart, handleTouchMove, handleTouchEnd, handleTouchCancel]);

  const isVisible = pullDistance > 0 || isRefreshing || showSuccess;
  const progress = Math.min(1, pullDistance / REFRESH_THRESHOLD);

  return (
    <>
      {/* Floating Pull-to-Refresh Pill Indicator */}
      <AnimatePresence>
        {isVisible && (
          <motion.div
            initial={{ opacity: 0, y: -20, scale: 0.8 }}
            animate={{ 
              opacity: 1, 
              y: isRefreshing || showSuccess ? 16 : Math.max(0, pullDistance * 0.7 - 10), 
              scale: 1 
            }}
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
              ) : isRefreshing || isHookRefreshing ? (
                <>
                  <RefreshCw className="h-3.5 w-3.5 text-indigo-800 dark:text-indigo-400 animate-spin" />
                  <span className="text-slate-800 dark:text-zinc-200 font-medium text-[11px]">Syncing...</span>
                </>
              ) : (
                <>
                  <div 
                    className="flex items-center justify-center transition-transform duration-150"
                    style={{ transform: `rotate(${progress >= 1 ? 180 : progress * 180}deg)` }}
                  >
                    <ArrowDown className={`h-3.5 w-3.5 ${progress >= 1 ? 'text-indigo-800 dark:text-indigo-400' : 'text-slate-600 dark:text-zinc-400'}`} />
                  </div>
                  <span className={`text-[11px] ${pullDistance >= ASK_PRICE_THRESHOLD ? 'text-indigo-800 dark:text-indigo-300 font-bold' : 'text-slate-600 dark:text-zinc-400'}`}>
                    {pullDistance >= ASK_PRICE_THRESHOLD
                      ? 'Release to find a price'
                      : pullDistance >= REFRESH_THRESHOLD
                        ? 'Release to sync · pull farther to ask'
                        : 'Pull to sync · farther to ask'}
                  </span>
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
