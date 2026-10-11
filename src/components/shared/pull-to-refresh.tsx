'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { RefreshCw, ArrowDown, Check } from 'lucide-react';
import { useSyncAndRefresh } from '@/hooks/useSyncAndRefresh';

interface PullToRefreshProps {
  onRefresh?: () => Promise<void>;
  children?: React.ReactNode;
}

export function PullToRefresh({ onRefresh, children }: PullToRefreshProps) {
  const { isRefreshing: isHookRefreshing, syncAndRefresh } = useSyncAndRefresh();
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);

  const startYRef = useRef<number | null>(null);
  const isDraggingRef = useRef(false);
  const hasVibratedRef = useRef(false);

  const THRESHOLD = 52; // Trigger distance in pixels

  const handleTouchStart = useCallback((e: TouchEvent) => {
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
    hasVibratedRef.current = false;
  }, [isRefreshing]);

  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (!isDraggingRef.current || startYRef.current === null || isRefreshing) return;

    // Check again to ensure we haven't scrolled down
    if (window.scrollY > 5 || document.documentElement.scrollTop > 5) {
      isDraggingRef.current = false;
      setPullDistance(0);
      return;
    }

    const currentY = e.touches[0].clientY;
    const diff = currentY - startYRef.current;

    if (diff <= 0) {
      setPullDistance(0);
      return;
    }

    // Apply smooth rubber-band resistance curve
    const dampedDistance = Math.min(75, Math.pow(diff, 0.82) * 1.5);
    setPullDistance(dampedDistance);

    // Haptic feedback once when crossing the threshold
    if (dampedDistance >= THRESHOLD && !hasVibratedRef.current) {
      hasVibratedRef.current = true;
      if (typeof window !== 'undefined' && 'vibrate' in navigator) {
        try {
          navigator.vibrate(12);
        } catch (_) {
          // Ignore vibration failures if not permitted
        }
      }
    } else if (dampedDistance < THRESHOLD) {
      hasVibratedRef.current = false;
    }
  }, [isRefreshing]);

  const handleTouchEnd = useCallback(async () => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;

    if (pullDistance >= THRESHOLD && !isRefreshing) {
      setIsRefreshing(true);
      setPullDistance(THRESHOLD);

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
  }, [pullDistance, isRefreshing, onRefresh, syncAndRefresh]);

  useEffect(() => {
    window.addEventListener('touchstart', handleTouchStart, { passive: true });
    window.addEventListener('touchmove', handleTouchMove, { passive: true });
    window.addEventListener('touchend', handleTouchEnd, { passive: true });
    window.addEventListener('touchcancel', handleTouchEnd, { passive: true });

    return () => {
      window.removeEventListener('touchstart', handleTouchStart);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', handleTouchEnd);
      window.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [handleTouchStart, handleTouchMove, handleTouchEnd]);

  const isVisible = pullDistance > 0 || isRefreshing || showSuccess;
  const progress = Math.min(1, pullDistance / THRESHOLD);

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
                  <span className={`text-[11px] ${progress >= 1 ? 'text-indigo-800 dark:text-indigo-300 font-bold' : 'text-slate-600 dark:text-zinc-400'}`}>
                    {progress >= 1 ? 'Release to sync' : 'Pull to refresh'}
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
