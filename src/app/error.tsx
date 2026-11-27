'use client';

import React, { useEffect, useState } from 'react';
import { AlertCircle, RefreshCw, Home, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { clearDisposableReadCaches } from '@/lib/cache-manager';

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [repaired, setRepaired] = useState(false);

  useEffect(() => {
    console.error('[Cashflow App Error Caught]:', error);
  }, [error]);

  const handleRepairAndRetry = () => {
    try {
      clearDisposableReadCaches();
      setRepaired(true);
    } catch {
      // ignore storage errors
    }
    reset();
  };

  return (
    <div className="min-h-[65vh] flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border border-[var(--cockpit-line-strong)] bg-[var(--cockpit-surface)] p-6 text-center shadow-2xl space-y-5">
        <div className="mx-auto w-12 h-12 rounded-2xl bg-rose-500/10 border border-rose-500/25 flex items-center justify-center text-rose-500">
          <AlertCircle className="w-6 h-6" />
        </div>

        <div className="space-y-1.5">
          <h2 className="text-base font-bold text-[var(--cockpit-text)]">View hit an unexpected state</h2>
          <p className="text-xs text-[var(--cockpit-muted)] leading-relaxed">
            {error?.message || 'A client-side error occurred while rendering this view. Your saved ledger data and pending edits are untouched.'}
          </p>
        </div>

        {repaired && (
          <div className="inline-flex items-center gap-1.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-3 py-1 rounded-full">
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>Disposable read cache cleared safely</span>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-center gap-2.5 pt-1">
          <button
            type="button"
            onClick={() => reset()}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-semibold shadow-sm active:scale-95 transition-all cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Try Again</span>
          </button>

          <button
            type="button"
            onClick={handleRepairAndRetry}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-[var(--cockpit-surface-soft)] hover:bg-[var(--cockpit-line)] text-[var(--cockpit-text)] text-xs font-semibold border border-[var(--cockpit-line)] active:scale-95 transition-all cursor-pointer"
          >
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
            <span>Repair Cache & Retry</span>
          </button>

          <Link
            href="/"
            onClick={() => {
              try { reset(); } catch {}
            }}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-[var(--cockpit-surface-soft)] hover:bg-[var(--cockpit-line)] text-[var(--cockpit-muted)] hover:text-[var(--cockpit-text)] text-xs font-semibold border border-[var(--cockpit-line)] active:scale-95 transition-all"
          >
            <Home className="w-3.5 h-3.5" />
            <span>Overview</span>
          </Link>
        </div>
      </div>
    </div>
  );
}
