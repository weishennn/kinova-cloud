'use client';

import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Trash2, AlertTriangle, Info, X } from 'lucide-react';
import { useConfirmStore } from '@/stores/confirm-dialog-store';
import { useLockBodyScroll } from '@/hooks/useLockBodyScroll';

export function ConfirmDialog() {
  const { isOpen, options, handleConfirm, handleCancel } = useConfirmStore();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useLockBodyScroll(isOpen);

  // Keyboard navigation: Escape to cancel, Enter to confirm
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        handleConfirm();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleConfirm, handleCancel]);

  if (!mounted) return null;

  const isDanger = options.variant === 'danger' || !options.variant;
  const isWarning = options.variant === 'warning';

  const dialogContent = (
    <AnimatePresence>
      {isOpen && (
        <div 
          className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
        >
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={handleCancel}
            className="fixed inset-0 bg-black/80 backdrop-blur-md"
          />

          {/* Dialog Card */}
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-dialog-title"
            initial={{ opacity: 0, scale: 0.92, y: 15 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ type: 'spring', damping: 26, stiffness: 380 }}
            className="relative w-full max-w-sm sm:max-w-md rounded-3xl border border-slate-200 dark:border-white/[0.12] bg-[#0c1019]/95 p-6 shadow-[0_24px_60px_rgba(0,0,0,0.85)] backdrop-blur-2xl specular-card overflow-hidden z-10"
          >
            {/* Close 'X' Button */}
            <button
              onClick={handleCancel}
              className="absolute right-4 top-4 p-2 rounded-full text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-zinc-800/80 transition-colors cursor-pointer"
              aria-label="Close dialog"
            >
              <X className="h-4 w-4" />
            </button>

            {/* Icon & Details */}
            <div className="flex flex-col items-center text-center">
              <div className={`flex h-14 w-14 items-center justify-center rounded-2xl border mb-4 ${
                isDanger
                  ? 'bg-rose-500/15 text-rose-800 dark:text-rose-400 border-rose-500/30 shadow-[0_0_24px_rgba(244,63,94,0.25)]'
                  : isWarning
                  ? 'bg-amber-500/15 text-amber-800 dark:text-amber-400 border-amber-500/30 shadow-[0_0_24px_rgba(245,158,11,0.25)]'
                  : 'bg-indigo-500/15 text-indigo-800 dark:text-indigo-400 border-indigo-500/30 shadow-[0_0_24px_rgba(99,102,241,0.25)]'
              }`}>
                {options.icon === 'alert' || isWarning ? (
                  <AlertTriangle className="h-7 w-7" />
                ) : options.icon === 'info' ? (
                  <Info className="h-7 w-7" />
                ) : (
                  <Trash2 className="h-7 w-7" />
                )}
              </div>

              <h2 id="confirm-dialog-title" className="text-lg sm:text-xl font-bold text-slate-950 dark:text-white tracking-tight">
                {options.title}
              </h2>

              {options.description && (
                <div className="text-sm text-slate-600 dark:text-zinc-400 leading-relaxed mt-2.5 max-w-xs sm:max-w-sm">
                  {options.description}
                </div>
              )}
            </div>

            {/* Buttons Action Bar */}
            <div className="grid grid-cols-2 gap-3 mt-6">
              <button
                type="button"
                onClick={handleCancel}
                className="h-11 px-4 rounded-2xl border border-slate-200 dark:border-white/[0.08] bg-white/90 dark:bg-zinc-900/80 hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-700 dark:text-zinc-300 hover:text-slate-950 dark:hover:text-white font-semibold text-xs sm:text-sm transition-all cursor-pointer touch-manipulation active:scale-[0.96]"
              >
                {options.cancelText || 'Cancel'}
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                autoFocus
                className={`h-11 px-4 rounded-2xl text-slate-950 dark:text-white font-semibold text-xs sm:text-sm shadow-xl transition-all cursor-pointer touch-manipulation active:scale-[0.96] ${
                  isDanger
                    ? 'bg-gradient-to-r from-rose-500 via-rose-600 to-red-600 hover:from-rose-600 hover:to-red-700 shadow-rose-500/25'
                    : isWarning
                    ? 'bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 shadow-amber-500/25'
                    : 'bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 shadow-indigo-500/25'
                }`}
              >
                {options.confirmText || 'Confirm'}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );

  return ReactDOM.createPortal(dialogContent, document.body);
}
