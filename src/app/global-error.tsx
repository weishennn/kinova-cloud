'use client';

import React from 'react';
import { AlertCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import { clearDisposableReadCaches } from '@/lib/cache-manager';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const handleRepairAndReload = () => {
    try {
      clearDisposableReadCaches();
    } catch {}
    reset();
  };

  return (
    <html lang="en">
      <body className="min-h-screen bg-[#090B0D] text-[#F4F4F1] flex items-center justify-center p-4">
        <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#111418] p-6 text-center shadow-2xl space-y-4">
          <div className="mx-auto w-12 h-12 rounded-2xl bg-rose-500/10 border border-rose-500/25 flex items-center justify-center text-rose-400">
            <AlertCircle className="w-6 h-6" />
          </div>

          <div className="space-y-1.5">
            <h2 className="text-base font-bold">Application Error</h2>
            <p className="text-xs text-zinc-400 leading-relaxed">
              {error?.message || 'An unexpected error occurred. Your saved ledger data and offline queue remain safe.'}
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-2.5">
            <button
              type="button"
              onClick={() => reset()}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-semibold active:scale-95 transition-all cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Reload Application</span>
            </button>
            <button
              type="button"
              onClick={handleRepairAndReload}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-zinc-200 border border-white/10 text-xs font-semibold active:scale-95 transition-all cursor-pointer"
            >
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
              <span>Repair Cache</span>
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
