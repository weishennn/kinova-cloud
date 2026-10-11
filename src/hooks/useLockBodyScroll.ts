'use client';

import { useEffect } from 'react';

/**
 * Universal Mobile & Desktop Body Scroll Lock Hook
 * When locked is true, completely freezes the background page (html + body)
 * so that touch dragging, wheel, and keyboard scrolling on mobile never scrolls
 * the background underneath any open modal.
 */
let lockCount = 0;
let originalBodyOverflow = '';
let originalHtmlOverflow = '';
let touchMoveHandler: ((e: TouchEvent) => void) | null = null;

export function useLockBodyScroll(locked: boolean = true) {
  useEffect(() => {
    if (!locked || typeof document === 'undefined') return;

    if (lockCount === 0) {
      originalBodyOverflow = document.body.style.overflow;
      originalHtmlOverflow = document.documentElement.style.overflow;

      document.body.style.overflow = 'hidden';
      document.documentElement.style.overflow = 'hidden';
      document.body.classList.add('modal-open');

      touchMoveHandler = (e: TouchEvent) => {
        const target = e.target as HTMLElement | null;
        // Allow scrolling inside dialog cards or designated scroll containers
        if (!target?.closest?.('[role="dialog"]') && !target?.closest?.('.overflow-y-auto')) {
          if (e.cancelable) {
            e.preventDefault();
          }
        }
      };
      document.addEventListener('touchmove', touchMoveHandler, { passive: false });
    }
    lockCount++;

    return () => {
      lockCount--;
      if (lockCount <= 0) {
        lockCount = 0;
        document.body.style.overflow = originalBodyOverflow;
        document.documentElement.style.overflow = originalHtmlOverflow;
        document.body.classList.remove('modal-open');

        if (touchMoveHandler) {
          document.removeEventListener('touchmove', touchMoveHandler);
          touchMoveHandler = null;
        }
      }
    };
  }, [locked]);
}
