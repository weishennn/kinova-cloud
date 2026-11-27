'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Coins, Layers, TrendingUp } from 'lucide-react';
import {
  INVESTMENT_ROLLUP_EVENT,
  readInvestmentRollup,
  type InvestmentRollupSnapshot,
} from '@/lib/binance-browser-cache';

export function InvestmentsSubnav() {
  const pathname = usePathname();
  const isBinance = pathname.startsWith('/investments/binance');

  const [stocksRollup, setStocksRollup] = useState<InvestmentRollupSnapshot | null>(null);
  const [binanceRollup, setBinanceRollup] = useState<InvestmentRollupSnapshot | null>(null);

  useEffect(() => {
    const refresh = () => {
      setStocksRollup(readInvestmentRollup('stocks'));
      setBinanceRollup(readInvestmentRollup('binance'));
    };
    refresh();
    window.addEventListener(INVESTMENT_ROLLUP_EVENT, refresh);
    return () => window.removeEventListener(INVESTMENT_ROLLUP_EVENT, refresh);
  }, []);

  const hasCombined = Boolean(stocksRollup && binanceRollup);
  const combinedValueMyr = (stocksRollup?.totalValueMyr || 0) + (binanceRollup?.totalValueMyr || 0);
  const combinedUnrealizedMyr = (stocksRollup?.unrealizedPnlMyr || 0) + (binanceRollup?.unrealizedPnlMyr || 0);
  const combinedRealizedMyr = (stocksRollup?.realizedPnlMyr || 0) + (binanceRollup?.realizedPnlMyr || 0);

  return (
    <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 pb-1">
      <nav
        aria-label="Investment accounts"
        className="cockpit-segmented-control inline-flex items-center gap-1 p-1 rounded-2xl border border-slate-200 dark:border-white/[0.08] bg-white/90 dark:bg-zinc-950/80 shadow-sm w-fit"
      >
        <Link
          href="/investments"
          aria-current={!isBinance ? 'page' : undefined}
          className={`flex items-center gap-2 min-h-[38px] px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all ${
            !isBinance
              ? 'cockpit-segmented-pill border text-emerald-800 dark:text-emerald-200'
              : 'text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-white'
          }`}
        >
          <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Stocks & Moomoo</span>
        </Link>
        <Link
          href="/investments/binance"
          aria-current={isBinance ? 'page' : undefined}
          className={`flex items-center gap-2 min-h-[38px] px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all ${
            isBinance
              ? 'cockpit-segmented-pill border text-amber-800 dark:text-amber-300'
              : 'text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-white'
          }`}
        >
          <Coins className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Binance (Crypto)</span>
        </Link>
      </nav>

      {hasCombined && (
        <div
          className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3.5 py-2 rounded-2xl border border-slate-200/80 dark:border-white/[0.08] bg-white/80 dark:bg-zinc-900/50 text-xs shadow-xs"
          title="Read-only combined summary across Stocks & Moomoo and Binance (kept separate from normal Flow cashflow)"
        >
          <span className="inline-flex items-center gap-1.5 font-semibold text-slate-600 dark:text-zinc-400">
            <Layers className="h-3.5 w-3.5 text-emerald-500" aria-hidden="true" />
            <span>Combined Investments:</span>
          </span>
          <span className="font-mono font-bold text-slate-950 dark:text-white">
            RM {combinedValueMyr.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
          <span className={`font-mono font-semibold ${combinedUnrealizedMyr >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'}`}>
            Unrealized {combinedUnrealizedMyr >= 0 ? '+' : '-'}RM {Math.abs(combinedUnrealizedMyr).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
          <span className={`font-mono font-semibold ${combinedRealizedMyr >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'}`}>
            Realized {combinedRealizedMyr >= 0 ? '+' : '-'}RM {Math.abs(combinedRealizedMyr).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        </div>
      )}
    </div>
  );
}
