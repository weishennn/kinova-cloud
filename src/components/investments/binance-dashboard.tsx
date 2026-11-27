'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { motion } from 'framer-motion';
import {
  Activity,
  AlertCircle,
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  Calculator,
  Coins,
  DollarSign,
  Edit2,
  History,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Target,
  TrendingDown,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import { toast } from 'sonner';
import { AnimatedNumber } from '@/components/shared/animated-number';
import { ThemeChartTooltip } from '@/components/shared/theme-chart-tooltip';
import { CockpitPageHeading } from '@/components/money-cockpit/cockpit-page-heading';
import { CockpitModal, CockpitModalHeader } from '@/components/money-cockpit/cockpit-modal';
import { confirmAction } from '@/stores/confirm-dialog-store';
import {
  TargetCostCalculatorCard,
  TargetCostModal,
  type TargetCostAssetOption,
} from '@/components/investments/target-cost-modal';
import { getBinanceSnapshotKey, saveInvestmentRollup } from '@/lib/binance-browser-cache';
import type {
  BinanceAnalyticsReport,
  BinanceFundingEvent,
  BinanceHoldingSummary,
  BinanceTradeExecution,
} from '@/lib/binance-sync';

const PieChart = dynamic(() => import('recharts').then((m) => m.PieChart), { ssr: false });
const Pie = dynamic(() => import('recharts').then((m) => m.Pie), { ssr: false });
const Cell = dynamic(() => import('recharts').then((m) => m.Cell), { ssr: false });
const ResponsiveContainer = dynamic(() => import('recharts').then((m) => m.ResponsiveContainer), { ssr: false });
const Tooltip = dynamic(() => import('recharts').then((m) => m.Tooltip), { ssr: false });

const ASSET_COLORS = [
  '#f59e0b',
  '#3b82f6',
  '#10b981',
  '#8b5cf6',
  '#ec4899',
  '#06b6d4',
  '#f97316',
  '#6366f1',
];

interface BinanceApiPayload {
  success: boolean;
  configured?: boolean;
  proxyEnabled?: boolean;
  keyType?: string;
  usdToMyr?: number;
  lastSyncAt?: string | null;
  hasSyncedHistory?: boolean;
  analytics?: BinanceAnalyticsReport;
  ledger?: {
    trades: BinanceTradeExecution[];
    fundingEvents: BinanceFundingEvent[];
    costBasisOverrides: Record<string, number>;
    customSymbols: string[];
  };
  warnings?: string[];
  diagnostics?: {
    wallets?: string[];
    spotCount?: number;
    fundingCount?: number;
    equityTradesCount?: number;
  };
  error?: string;
}

function fmtUsd(val: number, decimals = 2): string {
  const safe = Number.isFinite(val) ? val : 0;
  return `$${safe.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

function fmtPrice(val: number): string {
  if (!Number.isFinite(val) || val <= 0) return '$0.00';
  if (val >= 1000) return `$${val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (val >= 1) return `$${val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
  if (val >= 0.01) return `$${val.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 6 })}`;
  return `$${val.toPrecision(5)}`;
}

function fmtQty(val: number): string {
  if (!Number.isFinite(val) || Math.abs(val) < 1e-10) return '0';
  if (val >= 1000) return val.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (val >= 1) return val.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return val.toLocaleString('en-US', { maximumFractionDigits: 8 });
}

function fmtSignedMoney(val: number, curr: 'USD' | 'MYR'): string {
  const safe = Number.isFinite(val) ? val : 0;
  const sign = safe >= 0 ? '+' : '-';
  const abs = Math.abs(safe).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return curr === 'MYR' ? `${sign}RM ${abs}` : `${sign}$${abs}`;
}

export function BinanceDashboard() {
  const [payload, setPayload] = useState<BinanceApiPayload | null>(null);
  const [httpStatus, setHttpStatus] = useState<number>(200);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);

  const [displayCurrency, setDisplayCurrency] = useState<'USD' | 'MYR'>('USD');
  const [costBasisMethod, setCostBasisMethod] = useState<'fifo' | 'weighted'>('fifo');
  const [activeTab, setActiveTab] = useState<'holdings' | 'funding' | 'trades' | 'calculator'>('holdings');
  const [holdingFilter, setHoldingFilter] = useState<'active' | 'crypto' | 'stocks' | 'spot' | 'funding' | 'closed' | 'all'>('active');
  const [fundingFilter, setFundingFilter] = useState<'all' | 'in' | 'out' | 'neutral'>('all');
  const [tradeSourceFilter, setTradeSourceFilter] = useState<'all' | 'spot' | 'equity' | 'convert' | 'dust'>('all');
  const [hideDust, setHideDust] = useState<boolean>(true);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [lookbackDays, setLookbackDays] = useState<number>(365);

  const [selectedHolding, setSelectedHolding] = useState<BinanceHoldingSummary | null>(null);
  const [calcModalAsset, setCalcModalAsset] = useState<TargetCostAssetOption | null>(null);
  const [isCalcModalOpen, setIsCalcModalOpen] = useState<boolean>(false);

  const [editingFundingEvent, setEditingFundingEvent] = useState<BinanceFundingEvent | null>(null);
  const [overrideUsdInput, setOverrideUsdInput] = useState<string>('');
  const [isSavingOverride, setIsSavingOverride] = useState<boolean>(false);

  const [extraSymbolInput, setExtraSymbolInput] = useState<string>('');
  const [isAddingSymbol, setIsAddingSymbol] = useState<boolean>(false);

  const persistSnapshot = useCallback((data: BinanceApiPayload) => {
    if (typeof window === 'undefined' || !data?.success || !data.analytics) return;
    try {
      localStorage.setItem(getBinanceSnapshotKey(), JSON.stringify(data));
      const usdToMyr = data.usdToMyr || 4.2;
      const t = data.analytics.totals;
      const unrealizedUsd = costBasisMethod === 'fifo' ? t.unrealizedPnlFifoUsd : t.unrealizedPnlWeightedUsd;
      const realizedUsd = costBasisMethod === 'fifo' ? t.realizedPnlFifoUsd : t.realizedPnlWeightedUsd;
      saveInvestmentRollup({
        source: 'binance',
        totalValueUsd: t.totalValueUsd,
        totalValueMyr: t.totalValueMyr,
        unrealizedPnlUsd: unrealizedUsd,
        unrealizedPnlMyr: unrealizedUsd * usdToMyr,
        realizedPnlUsd: realizedUsd,
        realizedPnlMyr: realizedUsd * usdToMyr,
        updatedAt: new Date().toISOString(),
      });
    } catch {
      // ignore storage errors
    }
  }, [costBasisMethod]);

  const fetchPortfolio = useCallback(async (fresh = false, silent = false) => {
    if (!silent) setIsLoading(true);
    try {
      const res = await fetch(`/api/binance/portfolio${fresh ? '?fresh=1' : ''}`, { cache: 'no-store' });
      setHttpStatus(res.status);
      const data = (await res.json()) as BinanceApiPayload;
      if (!silent || (res.ok && data.success && data.analytics)) {
        setPayload(data);
      }
      if (res.ok && data.success && data.analytics) {
        persistSnapshot(data);
      }
    } catch (err) {
      if (!silent) {
        setPayload({
          success: false,
          error: err instanceof Error ? err.message : 'Network error loading Binance portfolio.',
        });
      }
    } finally {
      if (!silent) setIsLoading(false);
    }
  }, [persistSnapshot]);

  useEffect(() => {
    let active = true;
    const init = async () => {
      if (typeof window !== 'undefined') {
        try {
          const cached = localStorage.getItem(getBinanceSnapshotKey());
          if (cached) {
            const parsed = JSON.parse(cached) as BinanceApiPayload;
            if (active && parsed?.success && parsed.analytics) {
              await Promise.resolve();
              if (active) {
                setPayload(parsed);
                setIsLoading(false);
              }
            }
          }
        } catch {
          // ignore bad cache
        }
      }
      if (active) await fetchPortfolio(false);
    };
    void init();
    return () => {
      active = false;
    };
  }, [fetchPortfolio]);

  useEffect(() => {
    if (payload?.success && payload.analytics) {
      persistSnapshot(payload);
    }
  }, [costBasisMethod, payload, persistSnapshot]);

  // Keep live market prices synced with Binance & Yahoo Finance while tab is visible
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        void fetchPortfolio(true, true);
      }
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [fetchPortfolio]);

  const handleSyncBinance = async (fullHistory = false) => {
    if (fullHistory) {
      const ok = await confirmAction({
        title: `Run full Binance history sync (${Math.round(lookbackDays / 365)}Y)?`,
        description:
          'This fetches Spot + Funding balances, Spot trades, Convert swaps, P2P C2C orders, Fiat orders, and Crypto deposits/withdrawals, saving them to your isolated Binance ledger without touching Flow or Stocks.',
        confirmText: 'Full Re-Sync',
        cancelText: 'Cancel',
        variant: 'warning',
        icon: 'alert',
      });
      if (!ok) return;
    }

    setIsSyncing(true);
    try {
      const res = await fetch('/api/binance/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullHistory, lookbackDays }),
      });
      setHttpStatus(res.status);
      const data = (await res.json()) as BinanceApiPayload & {
        newTradesImported?: number;
        newFundingEventsImported?: number;
      };
      if (!res.ok || !data.success) {
        toast.error(data.error || 'Binance sync failed.');
        return;
      }
      setPayload((prev) => ({ ...prev, ...data, configured: true }));
      persistSnapshot(data);

      const tradesAdded = Number(data.newTradesImported || 0);
      const fundingAdded = Number(data.newFundingEventsImported || 0);
      toast.success(
        tradesAdded + fundingAdded > 0
          ? `Binance synced: +${tradesAdded} trades, +${fundingAdded} funding records.`
          : 'Binance is up to date.'
      );
      if (Array.isArray(data.warnings) && data.warnings.length > 0) {
        toast.warning(`Partial sync notice: ${data.warnings[0]}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Network error syncing Binance.');
    } finally {
      setIsSyncing(false);
    }
  };

  const handleSaveOverride = async () => {
    if (!editingFundingEvent) return;
    setIsSavingOverride(true);
    try {
      const val = overrideUsdInput.trim() === '' ? null : Number(overrideUsdInput);
      const res = await fetch('/api/binance/portfolio', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          costBasisOverrides: { [editingFundingEvent.id]: val },
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        toast.error(data.error || 'Could not save cost basis override.');
        return;
      }
      toast.success('Updated deposit cost basis.');
      setEditingFundingEvent(null);
      await fetchPortfolio(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save override.');
    } finally {
      setIsSavingOverride(false);
    }
  };

  const handleAddExtraSymbol = async (e: React.FormEvent) => {
    e.preventDefault();
    const sym = extraSymbolInput.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,16}$/.test(sym)) {
      toast.error('Enter a valid Binance trading pair like BTCUSDT or SOLUSDT.');
      return;
    }
    setIsAddingSymbol(true);
    try {
      const current = payload?.ledger?.customSymbols || [];
      const res = await fetch('/api/binance/portfolio', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customSymbols: [...new Set([...current, sym])] }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        toast.error(data.error || 'Could not add pair.');
        return;
      }
      setExtraSymbolInput('');
      toast.success(`Added ${sym}. Syncing trades...`);
      await handleSyncBinance(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add symbol.');
    } finally {
      setIsAddingSymbol(false);
    }
  };

  const usdToMyr = payload?.usdToMyr || 4.2;
  const analytics = payload?.analytics;
  const holdings = useMemo(() => analytics?.holdings || [], [analytics]);
  const fundingEvents = useMemo(() => payload?.ledger?.fundingEvents || [], [payload]);
  const trades = useMemo(() => payload?.ledger?.trades || [], [payload]);
  const costBasisOverrides = payload?.ledger?.costBasisOverrides || {};
  const tradeRealizedMap = analytics?.tradeRealizedMap || {};

  const toDisplay = useCallback(
    (usdVal: number) => (displayCurrency === 'MYR' ? usdVal * usdToMyr : usdVal),
    [displayCurrency, usdToMyr]
  );

  const calculatorOptions = useMemo<TargetCostAssetOption[]>(() => {
    return holdings
      .filter((h) => !h.isStablecoin && (h.totalQty > 0 || h.livePriceUsd > 0))
      .map((h) => ({
        symbol: h.asset,
        label: h.asset,
        assetKind: h.assetKind || 'Crypto',
        currentQty: h.totalQty,
        currentAvgCost: costBasisMethod === 'fifo' ? h.avgCostFifoUsd : h.avgCostWeightedUsd,
        currentMarketPrice: h.livePriceUsd,
      }));
  }, [holdings, costBasisMethod]);

  const closedCount = useMemo(() => holdings.filter((h) => h.status === 'closed').length, [holdings]);

  const filteredHoldings = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return holdings.filter((h) => {
      if (hideDust && h.status !== 'closed' && h.livePriceUsd > 0 && h.marketValueUsd < 1) return false;
      if (holdingFilter === 'active' && h.totalQty <= 1e-8) return false;
      if (holdingFilter === 'crypto' && (h.assetKind === 'Stock' || h.totalQty <= 1e-8)) return false;
      if (holdingFilter === 'stocks' && (h.assetKind !== 'Stock' || h.totalQty <= 1e-8)) return false;
      if (holdingFilter === 'spot' && h.spotQty <= 1e-8) return false;
      if (holdingFilter === 'funding' && h.fundingQty <= 1e-8) return false;
      if (holdingFilter === 'closed' && h.status !== 'closed') return false;
      if (q && !h.asset.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [holdings, hideDust, holdingFilter, searchQuery]);

  const filteredFunding = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return fundingEvents.filter((ev) => {
      if (fundingFilter !== 'all' && ev.direction !== fundingFilter) return false;
      if (q && !ev.asset.toLowerCase().includes(q) && !(ev.note || '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [fundingEvents, fundingFilter, searchQuery]);

  const filteredTrades = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return trades.filter((tr) => {
      if (tradeSourceFilter !== 'all' && tr.source !== tradeSourceFilter) return false;
      if (q && !tr.baseAsset.toLowerCase().includes(q) && !tr.symbol.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [trades, tradeSourceFilter, searchQuery]);

  const allocationData = useMemo(() => {
    const active = holdings.filter((h) => h.marketValueUsd >= 1);
    const top = active.slice(0, 7);
    const otherVal = active.slice(7).reduce((sum, h) => sum + h.marketValueUsd, 0);
    const items = top.map((h, i) => ({
      name: h.asset,
      value: Number(toDisplay(h.marketValueUsd).toFixed(2)),
      usd: h.marketValueUsd,
      color: ASSET_COLORS[i % ASSET_COLORS.length],
    }));
    if (otherVal > 0) {
      items.push({
        name: 'Others',
        value: Number(toDisplay(otherVal).toFixed(2)),
        usd: otherVal,
        color: '#64748b',
      });
    }
    return items;
  }, [holdings, toDisplay]);

  // Auth / Config states
  if (!isLoading && (httpStatus === 401 || httpStatus === 403)) {
    return (
      <div className="cockpit-module-page">
        <CockpitPageHeading
          title="Binance Portfolio"
          description="Isolated Spot & Funding crypto dashboard"
        />
        <div className="p-6 sm:p-8 rounded-3xl border border-amber-500/30 bg-white/90 dark:bg-zinc-900/50 space-y-3">
          <div className="flex items-center gap-2.5 text-amber-800 dark:text-amber-300 font-bold text-base">
            <ShieldCheck className="h-5 w-5" />
            <span>{httpStatus === 401 ? 'Sign in required' : 'Owner-Only Access'}</span>
          </div>
          <p className="text-sm text-slate-600 dark:text-zinc-300">
            {payload?.error || 'Sign in with the workspace owner Google account to view the Binance dashboard.'}
          </p>
        </div>
      </div>
    );
  }

  if (!isLoading && payload?.configured === false) {
    return (
      <div className="cockpit-module-page">
        <CockpitPageHeading
          title="Binance Portfolio"
          description="Connect a Read-Only Binance API key via Vercel + Fixie static proxy"
        />
        <div className="p-6 sm:p-8 rounded-3xl border border-amber-500/30 bg-white/95 dark:bg-zinc-900/60 space-y-5">
          <div className="flex items-center gap-3">
            <div className="h-11 w-11 rounded-2xl bg-amber-500/15 text-amber-700 dark:text-amber-300 flex items-center justify-center">
              <KeyRound className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-950 dark:text-white">Binance API Key Not Configured Yet</h2>
              <p className="text-xs text-slate-600 dark:text-zinc-400">
                Follow these steps to connect safely (Read-Only, zero Flow/cashflow impact):
              </p>
            </div>
          </div>
          <ol className="list-decimal pl-5 space-y-2 text-xs sm:text-sm text-slate-700 dark:text-zinc-300">
            <li>Generate an <strong>Ed25519</strong> key pair (or HMAC key) and create a Binance API key with <strong>Enable Reading</strong> only.</li>
            <li>In Binance API Management, choose <strong>Restrict access to trusted IPs only</strong> and enter your <strong>Fixie static outbound IPs</strong> (provision Fixie in a non-US region like Singapore or EU).</li>
            <li>Add <code className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 font-mono">BINANCE_API_KEY</code>, <code className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 font-mono">BINANCE_PRIVATE_KEY</code>, and <code className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 font-mono">FIXIE_URL</code> to your Vercel Environment Variables (and <code className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 font-mono">.env.local</code> for local dev).</li>
          </ol>
          <button
            type="button"
            onClick={() => void fetchPortfolio(true)}
            className="cockpit-secondary-action"
          >
            <RefreshCw className="h-4 w-4" />
            <span>Recheck Connection</span>
          </button>
        </div>
      </div>
    );
  }

  const totals = analytics?.totals;
  const fundingSummary = analytics?.fundingSummary;
  const unrealizedUsd = totals
    ? (costBasisMethod === 'fifo' ? totals.unrealizedPnlFifoUsd : totals.unrealizedPnlWeightedUsd)
    : 0;
  const unrealizedPct = totals
    ? (costBasisMethod === 'fifo' ? totals.unrealizedPctFifo : totals.unrealizedPctWeighted)
    : 0;
  const realizedUsd = totals
    ? (costBasisMethod === 'fifo' ? totals.realizedPnlFifoUsd : totals.realizedPnlWeightedUsd)
    : 0;
  const moneyPrefix = displayCurrency === 'MYR' ? 'RM ' : '$';

  return (
    <div className="cockpit-module-page">
      <CockpitPageHeading
        title="Binance Portfolio"
        description="Spot & Funding holdings, Net Funded In, Realized/Unrealized PnL & Limit Buy Simulator (isolated from Flow)"
        action={(
          <div className="flex flex-col items-start sm:items-end gap-2 w-full sm:w-auto">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={isSyncing}
                onClick={() => handleSyncBinance(false)}
                className="min-h-[40px] px-3.5 py-2 rounded-xl bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 active:scale-[0.97] text-white text-xs font-semibold shadow-lg shadow-amber-500/20 flex items-center gap-1.5 transition-all cursor-pointer disabled:opacity-50"
              >
                {isSyncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                <span>{isSyncing ? 'Syncing...' : 'Sync Binance'}</span>
              </button>

              <div className="inline-flex items-center rounded-xl border border-amber-500/35 bg-white/90 dark:bg-zinc-900/80 overflow-hidden">
                <select
                  aria-label="Full sync history lookback"
                  value={lookbackDays}
                  onChange={(e) => setLookbackDays(Number(e.target.value))}
                  className="px-2 py-2 text-[11px] font-semibold bg-transparent text-slate-700 dark:text-zinc-300 border-r border-amber-500/20 focus:outline-none"
                >
                  <option value={365}>1Y</option>
                  <option value={730}>2Y</option>
                  <option value={1095}>3Y</option>
                </select>
                <button
                  type="button"
                  disabled={isSyncing}
                  onClick={() => handleSyncBinance(true)}
                  className="px-3 py-2 text-xs font-semibold text-amber-800 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/30 cursor-pointer disabled:opacity-50"
                >
                  Full Re-Sync
                </button>
              </div>

              <button
                type="button"
                onClick={() => {
                  setCalcModalAsset(calculatorOptions[0] || null);
                  setIsCalcModalOpen(true);
                }}
                className="min-h-[40px] px-3.5 py-2 rounded-xl bg-[#0D6E52] hover:bg-[#0A5740] dark:bg-emerald-600 dark:hover:bg-emerald-500 text-white text-xs font-semibold shadow-lg flex items-center gap-1.5 cursor-pointer"
              >
                <Target className="h-3.5 w-3.5" />
                <span>Target Price</span>
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[10px] text-slate-500 dark:text-zinc-400">
              <span>
                {payload?.lastSyncAt
                  ? `Last full sync ${new Intl.DateTimeFormat('en-MY', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kuala_Lumpur' }).format(new Date(payload.lastSyncAt))}`
                  : 'Run Sync Binance to import P2P, deposits & trade PnL'}
              </span>
              {payload?.proxyEnabled && (
                <span className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 font-semibold">
                  Fixie Proxy
                </span>
              )}
              {payload?.keyType && (
                <span className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 font-mono uppercase">
                  {payload.keyType}
                </span>
              )}
            </div>
          </div>
        )}
      />

      {/* API / History Prompt Banners */}
      {payload?.error && (
        <div className="p-4 rounded-2xl border border-rose-500/35 bg-rose-500/10 text-rose-900 dark:text-rose-200 text-xs flex items-start gap-2.5">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{payload.error}</span>
        </div>
      )}

      {Array.isArray(payload?.warnings) && payload.warnings.length > 0 && (
        <div className="p-3.5 rounded-2xl border border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200 text-xs space-y-1">
          {payload.warnings.slice(0, 4).map((w, idx) => (
            <div key={idx} className="flex items-start gap-2">
              <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>{w}</span>
            </div>
          ))}
        </div>
      )}

      {!isLoading && payload?.configured && !payload?.hasSyncedHistory && (
        <div className="p-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 text-amber-950 dark:text-amber-200 text-xs flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <Sparkles className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <strong className="block">Live Spot & Funding balances loaded!</strong>
              <span>Click <strong>Sync Binance</strong> to import your P2P/Fiat/On-chain funding history and Spot trades so Net Funded In and Realized/Unrealized PnL populate automatically.</span>
            </div>
          </div>
          <button
            type="button"
            disabled={isSyncing}
            onClick={() => handleSyncBinance(false)}
            className="px-3.5 py-1.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-semibold cursor-pointer"
          >
            Sync History Now
          </button>
        </div>
      )}

      {/* Display Controls Row */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold text-slate-500 dark:text-zinc-400">Currency:</span>
            <div className="inline-flex rounded-xl bg-slate-100 dark:bg-zinc-800/80 p-0.5 border border-slate-200 dark:border-zinc-700/60 text-xs">
              {(['USD', 'MYR'] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setDisplayCurrency(c)}
                  className={`px-2.5 py-1 rounded-lg font-semibold cursor-pointer ${
                    displayCurrency === c
                      ? 'bg-white dark:bg-zinc-900 text-amber-700 dark:text-amber-300 shadow-xs'
                      : 'text-slate-600 dark:text-zinc-400'
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold text-slate-500 dark:text-zinc-400">Cost Basis:</span>
            <div className="inline-flex rounded-xl bg-slate-100 dark:bg-zinc-800/80 p-0.5 border border-slate-200 dark:border-zinc-700/60 text-xs">
              {(['fifo', 'weighted'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setCostBasisMethod(m)}
                  className={`px-2.5 py-1 rounded-lg font-semibold cursor-pointer ${
                    costBasisMethod === m
                      ? 'bg-white dark:bg-zinc-900 text-emerald-600 dark:text-emerald-400 shadow-xs'
                      : 'text-slate-600 dark:text-zinc-400'
                  }`}
                >
                  {m === 'fifo' ? 'FIFO' : 'Weighted Avg'}
                </button>
              ))}
            </div>
          </div>
        </div>

        <span className="text-[11px] font-mono text-slate-500 dark:text-zinc-400">
          FX: 1 USD = RM {usdToMyr.toFixed(4)}
        </span>
      </div>

      {/* 5 KPI Command Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3.5">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="p-4 sm:p-5 rounded-3xl border border-amber-500/30 bg-white/90 dark:bg-zinc-900/50 shadow-lg"
        >
          <div className="flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-wider text-slate-600 dark:text-zinc-400 font-semibold">Total Binance</span>
            <div className="h-8 w-8 rounded-xl bg-amber-500/10 text-amber-700 dark:text-amber-400 flex items-center justify-center border border-amber-500/20">
              <Coins className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-2.5 text-xl sm:text-2xl font-black font-mono text-slate-950 dark:text-white">
            <AnimatedNumber value={toDisplay(totals?.totalValueUsd || 0)} prefix={moneyPrefix} animateOnMount />
          </div>
          <p className="text-[11px] text-slate-500 dark:text-zinc-400 mt-1 font-mono truncate">
            Spot {fmtUsd(totals?.spotValueUsd || 0, 0)} · Funding {fmtUsd(totals?.fundingValueUsd || 0, 0)}
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="p-4 sm:p-5 rounded-3xl border border-slate-200 dark:border-zinc-800/80 bg-white/90 dark:bg-zinc-900/50 shadow-lg"
        >
          <div className="flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-wider text-slate-600 dark:text-zinc-400 font-semibold">Net Funded In</span>
            <div className="h-8 w-8 rounded-xl bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 flex items-center justify-center border border-emerald-500/20">
              <Wallet className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-2.5 text-xl sm:text-2xl font-black font-mono text-slate-950 dark:text-white">
            <AnimatedNumber
              value={displayCurrency === 'MYR' ? (fundingSummary?.netFundedMyr || 0) : (fundingSummary?.netFundedUsd || 0)}
              prefix={moneyPrefix}
              animateOnMount
            />
          </div>
          <p className="text-[11px] text-slate-500 dark:text-zinc-400 mt-1 font-mono truncate">
            In {fmtUsd(fundingSummary?.totalDepositedUsd || 0, 0)} · Out {fmtUsd(fundingSummary?.totalWithdrawnUsd || 0, 0)}
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="p-4 sm:p-5 rounded-3xl border border-slate-200 dark:border-zinc-800/80 bg-white/90 dark:bg-zinc-900/50 shadow-lg"
        >
          <div className="flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-wider text-slate-600 dark:text-zinc-400 font-semibold">Unrealized PnL</span>
            <div className={`h-8 w-8 rounded-xl flex items-center justify-center border ${
              unrealizedUsd >= 0
                ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20'
                : 'bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/20'
            }`}>
              {unrealizedUsd >= 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
            </div>
          </div>
          <div className={`mt-2.5 text-xl sm:text-2xl font-black font-mono ${
            unrealizedUsd >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'
          }`}>
            <AnimatedNumber value={toDisplay(unrealizedUsd)} prefix={moneyPrefix} showPlus animateOnMount />
          </div>
          <p className="text-[11px] text-slate-500 dark:text-zinc-400 mt-1 font-mono truncate">
            {unrealizedPct >= 0 ? '+' : ''}{unrealizedPct.toFixed(2)}% on tracked cost
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="p-4 sm:p-5 rounded-3xl border border-slate-200 dark:border-zinc-800/80 bg-white/90 dark:bg-zinc-900/50 shadow-lg"
        >
          <div className="flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-wider text-slate-600 dark:text-zinc-400 font-semibold">Realized PnL</span>
            <div className={`h-8 w-8 rounded-xl flex items-center justify-center border ${
              realizedUsd >= 0
                ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20'
                : 'bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/20'
            }`}>
              <Activity className="h-4 w-4" />
            </div>
          </div>
          <div className={`mt-2.5 text-xl sm:text-2xl font-black font-mono ${
            realizedUsd >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'
          }`}>
            <AnimatedNumber value={toDisplay(realizedUsd)} prefix={moneyPrefix} showPlus animateOnMount />
          </div>
          <p className="text-[11px] text-slate-500 dark:text-zinc-400 mt-1 font-mono truncate">
            Fees paid: {fmtUsd(totals?.totalFeesUsd || 0)}
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="col-span-2 sm:col-span-1 p-4 sm:p-5 rounded-3xl border border-slate-200 dark:border-zinc-800/80 bg-white/90 dark:bg-zinc-900/50 shadow-lg"
        >
          <div className="flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-wider text-slate-600 dark:text-zinc-400 font-semibold">True Net Return</span>
            <div className="h-8 w-8 rounded-xl bg-amber-500/10 text-amber-700 dark:text-amber-400 flex items-center justify-center border border-amber-500/20">
              <DollarSign className="h-4 w-4" />
            </div>
          </div>
          <div className={`mt-2.5 text-xl sm:text-2xl font-black font-mono ${
            (totals?.trueNetReturnUsd || 0) >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'
          }`}>
            <AnimatedNumber
              value={displayCurrency === 'MYR' ? (totals?.trueNetReturnMyr || 0) : (totals?.trueNetReturnUsd || 0)}
              prefix={moneyPrefix}
              showPlus
              animateOnMount
            />
          </div>
          <p className="text-[11px] text-slate-500 dark:text-zinc-400 mt-1 font-mono truncate">
            {(totals?.trueNetReturnPct || 0) >= 0 ? '+' : ''}{(totals?.trueNetReturnPct || 0).toFixed(2)}% vs Net Funded
          </p>
        </motion.div>
      </div>

      {/* Allocation & Wallet Distribution */}
      {allocationData.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="p-5 rounded-3xl border border-slate-200 dark:border-white/[0.08] bg-white/90 dark:bg-zinc-900/40 flex flex-col items-center justify-center">
            <h3 className="text-xs uppercase font-semibold tracking-wider text-slate-600 dark:text-zinc-400 mb-2">
              Crypto Allocation
            </h3>
            <div className="h-44 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={allocationData}
                    cx="50%"
                    cy="50%"
                    innerRadius={45}
                    outerRadius={66}
                    paddingAngle={4}
                    dataKey="value"
                    stroke="none"
                  >
                    {allocationData.map((entry, idx) => (
                      <Cell key={`cell-${idx}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip content={<ThemeChartTooltip currencyPrefix={moneyPrefix} />} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="md:col-span-2 p-5 rounded-3xl border border-slate-200 dark:border-white/[0.08] bg-white/90 dark:bg-zinc-900/40 flex flex-col justify-center gap-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs uppercase font-semibold tracking-wider text-slate-600 dark:text-zinc-400">
                Top Holdings & Wallet Split
              </h3>
              <span className="text-[11px] font-mono text-slate-500 dark:text-zinc-400">
                Stablecoins: {fmtUsd(totals?.stablecoinValueUsd || 0)}
              </span>
            </div>
            <div className="space-y-2.5">
              {allocationData.map((item) => {
                const pct = (totals?.totalValueUsd || 0) > 0 ? (item.usd / (totals?.totalValueUsd || 1)) * 100 : 0;
                return (
                  <div key={item.name} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color }} />
                        <span className="font-semibold text-slate-800 dark:text-zinc-200">{item.name}</span>
                      </div>
                      <span className="font-mono text-slate-600 dark:text-zinc-400">
                        {moneyPrefix}{item.value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ({pct.toFixed(1)}%)
                      </span>
                    </div>
                    <div className="h-1.5 w-full bg-slate-100 dark:bg-zinc-800 rounded-full overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: item.color }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Workspace Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 dark:border-white/[0.08] pb-3.5">
        <div className="cockpit-segmented-control relative flex flex-wrap items-center gap-1 p-1 rounded-2xl bg-white/90 dark:bg-zinc-950/80 border border-slate-200 dark:border-white/[0.08] shadow-xs">
          {[
            { id: 'holdings' as const, label: `Holdings (${holdings.length})` },
            { id: 'funding' as const, label: `Funded In (${fundingEvents.length})` },
            { id: 'trades' as const, label: `Trades & Convert (${trades.length})` },
            { id: 'calculator' as const, label: 'Target Price Simulator' },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`relative z-10 min-h-[38px] px-3.5 py-1.5 rounded-xl text-xs sm:text-sm font-semibold transition-colors cursor-pointer ${
                activeTab === tab.id
                  ? 'cockpit-segmented-pill border text-emerald-800 dark:text-emerald-200'
                  : 'text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab !== 'calculator' && (
          <div className="relative w-full sm:w-56">
            <Search className="h-3.5 w-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search coin or symbol..."
              className="w-full pl-8 pr-3 py-2 rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-xs text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
            />
          </div>
        )}
      </div>

      {/* TAB 1: HOLDINGS */}
      {activeTab === 'holdings' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-1 p-1 rounded-2xl bg-white/90 dark:bg-zinc-950/80 border border-slate-200 dark:border-white/[0.08] text-xs">
              {[
                { id: 'active' as const, label: 'Active' },
                { id: 'crypto' as const, label: 'Crypto' },
                { id: 'stocks' as const, label: 'Stocks' },
                { id: 'spot' as const, label: 'Spot' },
                { id: 'funding' as const, label: 'Funding' },
                { id: 'closed' as const, label: closedCount > 0 ? `Closed (${closedCount})` : 'Closed' },
                { id: 'all' as const, label: 'All' },
              ].map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setHoldingFilter(f.id)}
                  className={`px-3 py-1.5 rounded-xl font-semibold cursor-pointer ${
                    holdingFilter === f.id
                      ? 'bg-[#0D6E52] dark:bg-emerald-600 text-white'
                      : 'text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>

            <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-zinc-400 cursor-pointer">
              <input
                type="checkbox"
                checked={hideDust}
                onChange={(e) => setHideDust(e.target.checked)}
                className="rounded border-slate-300"
              />
              <span>Hide dust (&lt;$1)</span>
            </label>
          </div>

          {filteredHoldings.length === 0 ? (
            <div className="py-14 text-center rounded-3xl border border-dashed border-slate-200 dark:border-zinc-800 bg-white/80 dark:bg-zinc-900/20 p-6">
              <Coins className="h-8 w-8 text-amber-500 mx-auto mb-2" />
              <p className="text-sm font-semibold text-slate-900 dark:text-white">No matching Binance holdings</p>
              <p className="text-xs text-slate-500 dark:text-zinc-400 mt-1">
                Try toggling dust visibility or running Sync Binance.
              </p>
              {payload?.diagnostics?.wallets && payload.diagnostics.wallets.length > 0 && (
                <p className="text-[11px] font-mono text-slate-400 dark:text-zinc-500 mt-2">
                  Wallets detected: {payload.diagnostics.wallets.join(', ')} · Equity trades: {payload.diagnostics.equityTradesCount ?? 0}
                </p>
              )}
            </div>
          ) : (
            <>
              {/* Mobile Cards */}
              <div className="md:hidden space-y-3">
                {filteredHoldings.map((h) => {
                  const avgCost = costBasisMethod === 'fifo' ? h.avgCostFifoUsd : h.avgCostWeightedUsd;
                  const unrlUsd = costBasisMethod === 'fifo' ? h.unrealizedPnlFifoUsd : h.unrealizedPnlWeightedUsd;
                  const realUsd = costBasisMethod === 'fifo' ? h.realizedPnlFifoUsd : h.realizedPnlWeightedUsd;
                  return (
                    <div
                      key={h.asset}
                      onClick={() => setSelectedHolding(h)}
                      className="p-4 rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/40 space-y-3 cursor-pointer"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-bold text-base text-slate-950 dark:text-white">{h.asset}</span>
                            {h.assetKind === 'Stock' && <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/15 text-emerald-800 dark:text-emerald-300">Stock</span>}
                            {h.spotQty > 0 && <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-500/15 text-amber-800 dark:text-amber-300">Spot</span>}
                            {h.fundingQty > 0 && <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-500/15 text-blue-800 dark:text-blue-300">Funding</span>}
                            {h.equityQty > 0 && <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-500/15 text-amber-800 dark:text-amber-300">Equity</span>}
                            {h.status === 'closed' && <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-zinc-200 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300">Closed</span>}
                          </div>
                          <div className="text-xs font-mono text-slate-500 dark:text-zinc-400 mt-0.5">
                            {fmtQty(h.totalQty)} · {fmtPrice(h.livePriceUsd)} ({h.change24hPct >= 0 ? '+' : ''}{h.change24hPct.toFixed(2)}%)
                          </div>
                        </div>
                        <div className="text-right font-mono">
                          <div className="font-bold text-slate-950 dark:text-white">
                            {displayCurrency === 'MYR' ? `RM ${h.marketValueMyr.toFixed(2)}` : fmtUsd(h.marketValueUsd)}
                          </div>
                          {!h.isStablecoin && (
                            <div className={`text-xs font-semibold ${unrlUsd >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'}`}>
                              {fmtSignedMoney(toDisplay(unrlUsd), displayCurrency)}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="grid grid-cols-3 gap-2 pt-2 border-t border-slate-200 dark:border-zinc-800 text-xs font-mono">
                        <div>
                          <span className="block text-[10px] text-slate-500 uppercase font-sans">Avg Cost</span>
                          <span>{avgCost > 0 ? fmtPrice(avgCost) : '—'}</span>
                        </div>
                        <div>
                          <span className="block text-[10px] text-slate-500 uppercase font-sans">Realized</span>
                          <span className={realUsd >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'}>
                            {h.isStablecoin ? '—' : fmtSignedMoney(toDisplay(realUsd), displayCurrency)}
                          </span>
                        </div>
                        <div className="text-right">
                          {!h.isStablecoin && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setCalcModalAsset({
                                  symbol: h.asset,
                                  label: h.asset,
                                  assetKind: h.assetKind || 'Crypto',
                                  currentQty: h.totalQty,
                                  currentAvgCost: avgCost,
                                  currentMarketPrice: h.livePriceUsd,
                                });
                                setIsCalcModalOpen(true);
                              }}
                              className="px-2.5 py-1 rounded-lg bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 font-sans font-semibold text-[11px]"
                            >
                              Target Price
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Desktop Table */}
              <div className="hidden md:block overflow-x-auto rounded-3xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/30">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-zinc-800 text-xs uppercase tracking-wider text-slate-600 dark:text-zinc-400">
                      <th className="p-4">Asset</th>
                      <th className="p-4">Wallets</th>
                      <th className="p-4 text-right">Units</th>
                      <th className="p-4 text-right">Avg Cost</th>
                      <th className="p-4 text-right">Live Price</th>
                      <th className="p-4 text-right">Value ({displayCurrency})</th>
                      <th className="p-4 text-right">Unrealized PnL</th>
                      <th className="p-4 text-right">Realized PnL</th>
                      <th className="p-4 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200/70 dark:divide-zinc-800/60">
                    {filteredHoldings.map((h) => {
                      const avgCost = costBasisMethod === 'fifo' ? h.avgCostFifoUsd : h.avgCostWeightedUsd;
                      const unrlUsd = costBasisMethod === 'fifo' ? h.unrealizedPnlFifoUsd : h.unrealizedPnlWeightedUsd;
                      const unrlPct = costBasisMethod === 'fifo' ? h.unrealizedPctFifo : h.unrealizedPctWeighted;
                      const realUsd = costBasisMethod === 'fifo' ? h.realizedPnlFifoUsd : h.realizedPnlWeightedUsd;
                      return (
                        <tr
                          key={h.asset}
                          onClick={() => setSelectedHolding(h)}
                          className="hover:bg-slate-100/70 dark:hover:bg-zinc-800/40 cursor-pointer transition-colors"
                        >
                          <td className="p-4">
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-slate-950 dark:text-white">{h.asset}</span>
                              {h.assetKind === 'Stock' && (
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">Stock</span>
                              )}
                              {h.isStablecoin && (
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">Cash</span>
                              )}
                              {h.untrackedQty > 1e-6 && (
                                <span
                                  title={`${fmtQty(h.untrackedQty)} ${h.asset} came from deposits/transfers without Spot trade history.`}
                                  className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-500/15 text-amber-800 dark:text-amber-300"
                                >
                                  Deposit
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="p-4">
                            <div className="flex flex-wrap gap-1">
                              {h.spotQty > 1e-8 && (
                                <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-amber-500/15 text-amber-800 dark:text-amber-300">
                                  Spot: {fmtQty(h.spotQty)}
                                </span>
                              )}
                              {h.fundingQty > 1e-8 && (
                                <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-blue-500/15 text-blue-800 dark:text-blue-300">
                                  Funding: {fmtQty(h.fundingQty)}
                                </span>
                              )}
                              {h.equityQty > 1e-8 && (
                                <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-amber-500/15 text-amber-800 dark:text-amber-300">
                                  Equity: {fmtQty(h.equityQty)}
                                </span>
                              )}
                              {h.status === 'closed' && (
                                <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-zinc-200 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300">
                                  Closed
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="p-4 text-right font-mono text-slate-800 dark:text-zinc-200">
                            {fmtQty(h.totalQty)}
                          </td>
                          <td className="p-4 text-right font-mono text-slate-600 dark:text-zinc-400">
                            {!h.isStablecoin && avgCost > 0 ? fmtPrice(avgCost) : '—'}
                          </td>
                          <td className="p-4 text-right font-mono">
                            <div className="text-slate-950 dark:text-white font-semibold">{fmtPrice(h.livePriceUsd)}</div>
                            <div className={`text-[11px] ${h.change24hPct >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'}`}>
                              {h.change24hPct >= 0 ? '+' : ''}{h.change24hPct.toFixed(2)}%
                            </div>
                          </td>
                          <td className="p-4 text-right font-mono">
                            <div className="font-bold text-slate-950 dark:text-white">
                              {displayCurrency === 'MYR' ? `RM ${h.marketValueMyr.toFixed(2)}` : fmtUsd(h.marketValueUsd)}
                            </div>
                            <div className="text-[11px] text-slate-500 dark:text-zinc-400">
                              {displayCurrency === 'MYR' ? fmtUsd(h.marketValueUsd) : `RM ${h.marketValueMyr.toFixed(2)}`}
                            </div>
                          </td>
                          <td className="p-4 text-right font-mono">
                            {!h.isStablecoin && h.totalQty > 1e-8 ? (
                              <>
                                <div className={`font-bold ${unrlUsd >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'}`}>
                                  {fmtSignedMoney(toDisplay(unrlUsd), displayCurrency)}
                                </div>
                                <div className={`text-[11px] ${unrlUsd >= 0 ? 'text-emerald-600 dark:text-emerald-500' : 'text-rose-600 dark:text-rose-500'}`}>
                                  {unrlPct >= 0 ? '+' : ''}{unrlPct.toFixed(2)}%
                                </div>
                              </>
                            ) : (
                              <span className="text-slate-400">—</span>
                            )}
                          </td>
                          <td className="p-4 text-right font-mono">
                            {!h.isStablecoin ? (
                              <span className={`font-bold ${
                                realUsd > 0 ? 'text-emerald-700 dark:text-emerald-400' : realUsd < 0 ? 'text-rose-700 dark:text-rose-400' : 'text-slate-500'
                              }`}>
                                {realUsd !== 0 ? fmtSignedMoney(toDisplay(realUsd), displayCurrency) : `${moneyPrefix}0.00`}
                              </span>
                            ) : (
                              <span className="text-slate-400">—</span>
                            )}
                          </td>
                          <td className="p-4 text-right">
                            {!h.isStablecoin && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setCalcModalAsset({
                                    symbol: h.asset,
                                    label: h.asset,
                                    assetKind: h.assetKind || 'Crypto',
                                    currentQty: h.totalQty,
                                    currentAvgCost: avgCost,
                                    currentMarketPrice: h.livePriceUsd,
                                  });
                                  setIsCalcModalOpen(true);
                                }}
                                className="px-2.5 py-1.5 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 text-xs font-semibold inline-flex items-center gap-1 cursor-pointer"
                              >
                                <Calculator className="h-3.5 w-3.5" />
                                <span>Target</span>
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* TAB 2: FUNDED IN & TRANSFERS */}
      {activeTab === 'funding' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="p-4 rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/40">
              <span className="text-[11px] uppercase text-slate-500 font-semibold">P2P Buys</span>
              <div className="text-lg font-bold font-mono text-emerald-700 dark:text-emerald-400 mt-1">
                {fmtUsd(fundingSummary?.p2pBuyUsd || 0)}
              </div>
            </div>
            <div className="p-4 rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/40">
              <span className="text-[11px] uppercase text-slate-500 font-semibold">Fiat Deposits</span>
              <div className="text-lg font-bold font-mono text-emerald-700 dark:text-emerald-400 mt-1">
                {fmtUsd(fundingSummary?.fiatDepositUsd || 0)}
              </div>
            </div>
            <div className="p-4 rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/40">
              <span className="text-[11px] uppercase text-slate-500 font-semibold">On-Chain Deposits</span>
              <div className="text-lg font-bold font-mono text-emerald-700 dark:text-emerald-400 mt-1">
                {fmtUsd(fundingSummary?.cryptoDepositUsd || 0)}
              </div>
            </div>
            <div className="p-4 rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/40">
              <span className="text-[11px] uppercase text-slate-500 font-semibold">Total Withdrawn</span>
              <div className="text-lg font-bold font-mono text-rose-700 dark:text-rose-400 mt-1">
                {fmtUsd(fundingSummary?.totalWithdrawnUsd || 0)}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-1 p-1 rounded-2xl bg-white/90 dark:bg-zinc-950/80 border border-slate-200 dark:border-white/[0.08] text-xs w-fit">
            {[
              { id: 'all' as const, label: 'All Events' },
              { id: 'in' as const, label: 'Funded In' },
              { id: 'out' as const, label: 'Withdrawn' },
              { id: 'neutral' as const, label: 'Spot ↔ Funding' },
            ].map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFundingFilter(f.id)}
                className={`px-3 py-1.5 rounded-xl font-semibold cursor-pointer ${
                  fundingFilter === f.id ? 'bg-[#0D6E52] dark:bg-emerald-600 text-white' : 'text-slate-600 dark:text-zinc-400'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div className="rounded-3xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/30 divide-y divide-slate-200/70 dark:divide-zinc-800/60">
            {filteredFunding.length === 0 ? (
              <div className="p-10 text-center text-xs text-slate-500 dark:text-zinc-400">
                No funding events found. Run <strong>Sync Binance</strong> to import P2P, Fiat, Deposit & Transfer records.
              </div>
            ) : (
              filteredFunding.map((ev) => {
                const override = costBasisOverrides[ev.id];
                const effectiveUsd = Number.isFinite(override) ? override : ev.usdValue;
                return (
                  <div key={ev.id} className="p-4 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className={`h-9 w-9 rounded-xl flex items-center justify-center shrink-0 ${
                        ev.direction === 'in'
                          ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                          : ev.direction === 'out'
                            ? 'bg-rose-500/10 text-rose-700 dark:text-rose-400'
                            : 'bg-blue-500/10 text-blue-700 dark:text-blue-400'
                      }`}>
                        {ev.direction === 'in' ? <ArrowDownLeft className="h-4 w-4" /> : ev.direction === 'out' ? <ArrowUpRight className="h-4 w-4" /> : <ArrowLeftRight className="h-4 w-4" />}
                      </div>
                      <div className="min-w-0">
                        <div className="font-semibold text-sm text-slate-950 dark:text-white truncate">
                          {ev.note || ev.kind}
                        </div>
                        <div className="text-xs text-slate-500 dark:text-zinc-400 font-mono">
                          {ev.date} · {fmtQty(ev.amount)} {ev.asset}
                          {ev.fiatAmount && ev.fiatCurrency ? ` · Paid ${ev.fiatCurrency} ${ev.fiatAmount.toFixed(2)}` : ''}
                          {Number.isFinite(override) && ' · Custom Cost Basis'}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      <div className="text-right font-mono">
                        <div className={`font-bold text-sm ${
                          ev.direction === 'in'
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : ev.direction === 'out'
                              ? 'text-rose-700 dark:text-rose-400'
                              : 'text-slate-600 dark:text-zinc-300'
                        }`}>
                          {ev.direction === 'neutral' ? 'Neutral ' : ev.direction === 'in' ? '+' : '-'}
                          {displayCurrency === 'MYR'
                            ? `RM ${(effectiveUsd * usdToMyr).toFixed(2)}`
                            : fmtUsd(effectiveUsd)}
                        </div>
                      </div>
                      {ev.kind === 'crypto_deposit' && (
                        <button
                          type="button"
                          onClick={() => {
                            setEditingFundingEvent(ev);
                            setOverrideUsdInput(String(Number(effectiveUsd.toFixed(2))));
                          }}
                          title="Override historical USD cost basis for this on-chain deposit"
                          className="p-2 rounded-xl border border-slate-200 dark:border-zinc-700 hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-600 dark:text-zinc-300 cursor-pointer"
                        >
                          <Edit2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* TAB 3: TRADES & CONVERT HISTORY */}
      {activeTab === 'trades' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-1 p-1 rounded-2xl bg-white/90 dark:bg-zinc-950/80 border border-slate-200 dark:border-white/[0.08] text-xs">
              {[
                { id: 'all' as const, label: 'All' },
                { id: 'spot' as const, label: 'Spot' },
                { id: 'equity' as const, label: 'Stocks' },
                { id: 'convert' as const, label: 'Convert' },
                { id: 'dust' as const, label: 'Dust' },
              ].map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setTradeSourceFilter(s.id)}
                  className={`px-3 py-1.5 rounded-xl font-semibold cursor-pointer ${
                    tradeSourceFilter === s.id ? 'bg-[#0D6E52] dark:bg-emerald-600 text-white' : 'text-slate-600 dark:text-zinc-400'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>

            <form onSubmit={handleAddExtraSymbol} className="flex items-center gap-2">
              <input
                type="text"
                value={extraSymbolInput}
                onChange={(e) => setExtraSymbolInput(e.target.value)}
                placeholder="Track closed pair (e.g. DOGEUSDT)"
                className="px-3 py-1.5 rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-xs font-mono text-slate-900 dark:text-white"
              />
              <button
                type="submit"
                disabled={isAddingSymbol || isSyncing}
                className="px-3 py-1.5 rounded-xl bg-slate-900 dark:bg-white text-white dark:text-slate-950 text-xs font-semibold inline-flex items-center gap-1 cursor-pointer disabled:opacity-50"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Add Pair</span>
              </button>
            </form>
          </div>

          <div className="rounded-3xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/30 divide-y divide-slate-200/70 dark:divide-zinc-800/60">
            {filteredTrades.length === 0 ? (
              <div className="p-10 text-center text-xs text-slate-500 dark:text-zinc-400">
                No Binance trades recorded yet. Click <strong>Sync Binance</strong> above.
              </div>
            ) : (
              filteredTrades.slice(0, 200).map((tr) => {
                const realized = tradeRealizedMap[tr.id];
                const realizedVal = realized
                  ? (costBasisMethod === 'fifo' ? realized.realizedFifoUsd : realized.realizedWeightedUsd)
                  : null;
                return (
                  <div key={tr.id} className="p-4 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                          tr.side === 'BUY'
                            ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                            : 'bg-rose-500/15 text-rose-700 dark:text-rose-400'
                        }`}>
                          {tr.side}
                        </span>
                        <span className="font-bold text-sm text-slate-950 dark:text-white">{tr.symbol}</span>
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400 uppercase">
                          {tr.source}
                        </span>
                      </div>
                      <div className="text-xs font-mono text-slate-500 dark:text-zinc-400 mt-0.5">
                        {tr.date} · {fmtQty(tr.quantity)} {tr.baseAsset} @ {fmtPrice(tr.priceUsd)} · Fee {fmtUsd(tr.feeUsd, 4)}
                      </div>
                    </div>

                    <div className="text-right font-mono">
                      <div className="font-bold text-sm text-slate-950 dark:text-white">
                        {displayCurrency === 'MYR' ? `RM ${(tr.totalUsd * usdToMyr).toFixed(2)}` : fmtUsd(tr.totalUsd)}
                      </div>
                      {realizedVal !== null && (
                        <div className={`text-xs font-semibold ${realizedVal >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'}`}>
                          Realized: {fmtSignedMoney(toDisplay(realizedVal), displayCurrency)}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* TAB 4: EMBEDDED TARGET COST SIMULATOR */}
      {activeTab === 'calculator' && (
        <TargetCostCalculatorCard assets={calculatorOptions} />
      )}

      {/* Holding Detail Modal */}
      {selectedHolding && (
        <CockpitModal
          id="binance-holding-details-dialog"
          isOpen={Boolean(selectedHolding)}
          onClose={() => setSelectedHolding(null)}
          labelledBy="binance-holding-details-title"
          size="standard"
          className="space-y-4"
        >
          <CockpitModalHeader
            title={selectedHolding.asset}
            titleId="binance-holding-details-title"
            description={selectedHolding.isStablecoin ? 'Stablecoin / Quote Reserve' : 'Spot & Funding Position'}
            icon={<Coins size={20} />}
            onClose={() => setSelectedHolding(null)}
            closeLabel="Close details"
          />

          <div className="text-center py-2 font-mono">
            <div className="text-3xl font-black text-slate-950 dark:text-white">
              {displayCurrency === 'MYR'
                ? `RM ${selectedHolding.marketValueMyr.toFixed(2)}`
                : fmtUsd(selectedHolding.marketValueUsd)}
            </div>
            <div className="text-xs text-slate-500 dark:text-zinc-400 mt-1">
              {fmtQty(selectedHolding.totalQty)} {selectedHolding.asset} @ {fmtPrice(selectedHolding.livePriceUsd)}
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 p-4 space-y-2.5 text-xs font-mono">
            <div className="flex justify-between">
              <span className="text-slate-500 font-sans">Spot Wallet</span>
              <span className="font-semibold">{fmtQty(selectedHolding.spotQty)} {selectedHolding.asset}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500 font-sans">Funding Wallet</span>
              <span className="font-semibold">{fmtQty(selectedHolding.fundingQty)} {selectedHolding.asset}</span>
            </div>
            {!selectedHolding.isStablecoin && (
              <>
                <div className="flex justify-between pt-2 border-t border-slate-200 dark:border-zinc-800">
                  <span className="text-slate-500 font-sans">Avg Cost ({costBasisMethod.toUpperCase()})</span>
                  <span className="font-semibold">
                    {fmtPrice(costBasisMethod === 'fifo' ? selectedHolding.avgCostFifoUsd : selectedHolding.avgCostWeightedUsd)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500 font-sans">Unrealized PnL</span>
                  <span className={`font-bold ${
                    (costBasisMethod === 'fifo' ? selectedHolding.unrealizedPnlFifoUsd : selectedHolding.unrealizedPnlWeightedUsd) >= 0
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : 'text-rose-700 dark:text-rose-400'
                  }`}>
                    {fmtSignedMoney(
                      toDisplay(costBasisMethod === 'fifo' ? selectedHolding.unrealizedPnlFifoUsd : selectedHolding.unrealizedPnlWeightedUsd),
                      displayCurrency
                    )}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500 font-sans">Realized PnL</span>
                  <span className={`font-bold ${
                    (costBasisMethod === 'fifo' ? selectedHolding.realizedPnlFifoUsd : selectedHolding.realizedPnlWeightedUsd) >= 0
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : 'text-rose-700 dark:text-rose-400'
                  }`}>
                    {fmtSignedMoney(
                      toDisplay(costBasisMethod === 'fifo' ? selectedHolding.realizedPnlFifoUsd : selectedHolding.realizedPnlWeightedUsd),
                      displayCurrency
                    )}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500 font-sans">Fees Paid</span>
                  <span>{fmtUsd(selectedHolding.totalFeesUsd)}</span>
                </div>
              </>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            {!selectedHolding.isStablecoin && (
              <button
                type="button"
                onClick={() => {
                  const h = selectedHolding;
                  setSelectedHolding(null);
                  setCalcModalAsset({
                    symbol: h.asset,
                    label: h.asset,
                    assetKind: h.assetKind || 'Crypto',
                    currentQty: h.totalQty,
                    currentAvgCost: costBasisMethod === 'fifo' ? h.avgCostFifoUsd : h.avgCostWeightedUsd,
                    currentMarketPrice: h.livePriceUsd,
                  });
                  setIsCalcModalOpen(true);
                }}
                className="py-2.5 px-4 rounded-2xl bg-[#0D6E52] hover:bg-[#0A5740] dark:bg-emerald-600 dark:hover:bg-emerald-500 text-white text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <Target className="h-4 w-4" />
                <span>Target Price</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setSearchQuery(selectedHolding.asset);
                setSelectedHolding(null);
                setActiveTab('trades');
              }}
              className="py-2.5 px-4 rounded-2xl border border-slate-200 dark:border-zinc-800 text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <History className="h-4 w-4" />
              <span>View Trades</span>
            </button>
          </div>
        </CockpitModal>
      )}

      {/* Deposit Cost Basis Override Modal */}
      {editingFundingEvent && (
        <CockpitModal
          id="binance-deposit-override-dialog"
          isOpen={Boolean(editingFundingEvent)}
          onClose={() => setEditingFundingEvent(null)}
          labelledBy="binance-deposit-override-title"
          size="compact"
          className="space-y-4"
        >
          <CockpitModalHeader
            title="Set Deposit Cost (USD)"
            titleId="binance-deposit-override-title"
            description={`${fmtQty(editingFundingEvent.amount)} ${editingFundingEvent.asset} on ${editingFundingEvent.date}`}
            icon={<DollarSign size={18} />}
            onClose={() => setEditingFundingEvent(null)}
            closeLabel="Close"
          />
          <div>
            <label className="block text-xs font-semibold text-slate-600 dark:text-zinc-400 mb-1">
              Original Funded Cost in USD (leave blank to reset to market value)
            </label>
            <input
              type="number"
              step="any"
              min="0"
              value={overrideUsdInput}
              onChange={(e) => setOverrideUsdInput(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 font-mono text-sm"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditingFundingEvent(null)}
              className="px-4 py-2 rounded-xl border border-slate-200 dark:border-zinc-700 text-xs font-semibold cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={isSavingOverride}
              onClick={handleSaveOverride}
              className="px-4 py-2 rounded-xl bg-[#0D6E52] dark:bg-emerald-600 text-white text-xs font-semibold cursor-pointer disabled:opacity-50"
            >
              {isSavingOverride ? 'Saving...' : 'Save Cost'}
            </button>
          </div>
        </CockpitModal>
      )}

      {/* Target Cost Calculator Modal */}
      <TargetCostModal
        isOpen={isCalcModalOpen}
        onClose={() => setIsCalcModalOpen(false)}
        assets={calculatorOptions}
        initialAsset={calcModalAsset}
      />
    </div>
  );
}
