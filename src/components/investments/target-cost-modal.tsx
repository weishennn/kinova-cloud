'use client';

import React, { useMemo, useState } from 'react';
import { Calculator, Check, Copy, Info, Sparkles, Target, TrendingDown } from 'lucide-react';
import { CockpitModal, CockpitModalHeader } from '@/components/money-cockpit/cockpit-modal';
import { calculateTargetCostBuyPrice } from '@/lib/target-cost-calculator';

export interface TargetCostAssetOption {
  symbol: string;
  label: string;
  assetKind: 'Crypto' | 'Stock';
  currentQty: number;
  currentAvgCost: number;
  currentMarketPrice: number;
}

interface TargetCostCalculatorProps {
  assets?: TargetCostAssetOption[];
  initialAsset?: TargetCostAssetOption | null;
  compact?: boolean;
}

function formatPriceSmart(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0.00';
  if (value >= 1000) return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (value >= 1) return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  if (value >= 0.01) return value.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 6 });
  return value.toPrecision(6);
}

function computeDefaultTargetCost(asset: TargetCostAssetOption | null): string {
  if (!asset) return '';
  if (asset.currentAvgCost > 0 && asset.currentMarketPrice > 0 && asset.currentMarketPrice < asset.currentAvgCost) {
    return String(Number(((asset.currentAvgCost + asset.currentMarketPrice) / 2).toFixed(6)));
  }
  if (asset.currentAvgCost > 0) {
    return String(Number((asset.currentAvgCost * 0.92).toFixed(6)));
  }
  if (asset.currentMarketPrice > 0) {
    return String(Number((asset.currentMarketPrice * 0.95).toFixed(6)));
  }
  return '';
}

export function TargetCostCalculatorCard({
  assets = [],
  initialAsset = null,
  compact = false,
}: TargetCostCalculatorProps) {
  const defaultAsset = initialAsset ?? assets[0] ?? null;
  const [selectedSymbol, setSelectedSymbol] = useState<string>(defaultAsset?.symbol || '__CUSTOM__');
  const [currentQtyStr, setCurrentQtyStr] = useState<string>(defaultAsset ? String(defaultAsset.currentQty) : '');
  const [currentAvgStr, setCurrentAvgStr] = useState<string>(defaultAsset ? String(Number(defaultAsset.currentAvgCost.toFixed(6))) : '');
  const [marketPriceStr, setMarketPriceStr] = useState<string>(defaultAsset ? String(Number(defaultAsset.currentMarketPrice.toFixed(6))) : '');
  const [targetCostStr, setTargetCostStr] = useState<string>(() => computeDefaultTargetCost(defaultAsset));
  const [investUsdStr, setInvestUsdStr] = useState<string>('500');
  const [feeRatePctStr, setFeeRatePctStr] = useState<string>(
    defaultAsset?.assetKind === 'Stock' ? '0' : '0.1'
  );
  const [copied, setCopied] = useState(false);

  const applyAsset = (asset: TargetCostAssetOption | null) => {
    if (!asset) {
      setSelectedSymbol('__CUSTOM__');
      return;
    }
    setSelectedSymbol(asset.symbol);
    setCurrentQtyStr(asset.currentQty > 0 ? String(asset.currentQty) : '0');
    setCurrentAvgStr(asset.currentAvgCost > 0 ? String(Number(asset.currentAvgCost.toFixed(6))) : '0');
    setMarketPriceStr(asset.currentMarketPrice > 0 ? String(Number(asset.currentMarketPrice.toFixed(6))) : '0');
    setFeeRatePctStr(asset.assetKind === 'Stock' ? '0' : '0.1');
    setTargetCostStr(computeDefaultTargetCost(asset));
  };

  const currentQty = Number(currentQtyStr) || 0;
  const currentAvgCost = Number(currentAvgStr) || 0;
  const currentMarketPrice = Number(marketPriceStr) || 0;
  const targetAvgCost = Number(targetCostStr) || 0;
  const investAmountUsd = Number(investUsdStr) || 0;
  const feeRatePct = Number(feeRatePctStr) || 0;

  const result = useMemo(
    () =>
      calculateTargetCostBuyPrice({
        currentQty,
        currentAvgCost,
        currentMarketPrice,
        targetAvgCost,
        investAmountUsd,
        feeRatePct,
      }),
    [currentQty, currentAvgCost, currentMarketPrice, targetAvgCost, investAmountUsd, feeRatePct]
  );

  const handleCopyLimitPrice = () => {
    if (!result.requiredLimitPrice) return;
    navigator.clipboard?.writeText(String(Number(result.requiredLimitPrice.toFixed(6)))).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }).catch(() => undefined);
  };

  const applyTargetDiscount = (pct: number) => {
    const base = currentAvgCost > 0 ? currentAvgCost : currentMarketPrice;
    if (base <= 0) return;
    setTargetCostStr(String(Number((base * (1 - pct / 100)).toFixed(6))));
  };

  return (
    <div className={compact ? 'space-y-4' : 'p-5 sm:p-6 rounded-3xl border border-slate-200 dark:border-white/[0.08] bg-white/90 dark:bg-zinc-900/40 space-y-5'}>
      {!compact && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base sm:text-lg font-bold text-slate-950 dark:text-white flex items-center gap-2">
              <Target className="h-5 w-5 text-amber-500" />
              <span>Target Cost Price → Limit / Market Buy Calculator</span>
            </h2>
            <p className="text-xs text-slate-600 dark:text-zinc-400 mt-0.5">
              Set your desired average cost price and USD budget to calculate the exact buy price needed.
            </p>
          </div>
        </div>
      )}

      {/* Asset Selector */}
      {assets.length > 0 && (
        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-zinc-400 mb-1.5">
            Select Holding (or Custom)
          </label>
          <select
            value={selectedSymbol}
            onChange={(e) => {
              const sym = e.target.value;
              if (sym === '__CUSTOM__') {
                setSelectedSymbol('__CUSTOM__');
                return;
              }
              const found = assets.find((a) => a.symbol === sym) || null;
              applyAsset(found);
            }}
            className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm font-medium text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
          >
            {assets.map((a) => (
              <option key={a.symbol} value={a.symbol}>
                {a.label} ({a.assetKind}) — Qty {a.currentQty.toLocaleString('en-US', { maximumFractionDigits: 6 })} @ Avg ${formatPriceSmart(a.currentAvgCost)}
              </option>
            ))}
            <option value="__CUSTOM__">Custom Asset (Manual Input)</option>
          </select>
        </div>
      )}

      {/* Current Position Inputs */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label className="block text-[11px] font-semibold text-slate-600 dark:text-zinc-400 mb-1">
            Current Units Held
          </label>
          <input
            type="number"
            step="any"
            min="0"
            value={currentQtyStr}
            onChange={(e) => setCurrentQtyStr(e.target.value)}
            placeholder="0.00"
            className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 font-mono text-sm text-slate-950 dark:text-white"
          />
        </div>
        <div>
          <label className="block text-[11px] font-semibold text-slate-600 dark:text-zinc-400 mb-1">
            Current Avg Cost (USD)
          </label>
          <input
            type="number"
            step="any"
            min="0"
            value={currentAvgStr}
            onChange={(e) => setCurrentAvgStr(e.target.value)}
            placeholder="0.00"
            className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 font-mono text-sm text-slate-950 dark:text-white"
          />
        </div>
        <div>
          <label className="block text-[11px] font-semibold text-slate-600 dark:text-zinc-400 mb-1">
            Current Market Price (USD)
          </label>
          <input
            type="number"
            step="any"
            min="0"
            value={marketPriceStr}
            onChange={(e) => setMarketPriceStr(e.target.value)}
            placeholder="0.00"
            className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 font-mono text-sm text-slate-950 dark:text-white"
          />
        </div>
      </div>

      {/* Target & Budget Inputs */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
        <div>
          <label className="block text-[11px] font-semibold text-emerald-700 dark:text-emerald-300 mb-1">
            Target Avg Cost Price (USD)
          </label>
          <input
            type="number"
            step="any"
            min="0"
            value={targetCostStr}
            onChange={(e) => setTargetCostStr(e.target.value)}
            placeholder="e.g. 85000"
            className="w-full px-3 py-2 rounded-xl border-2 border-emerald-500/40 bg-white dark:bg-zinc-950 font-mono text-sm font-semibold text-slate-950 dark:text-white focus:border-emerald-500 focus:outline-none"
          />
          <div className="flex flex-wrap gap-1 mt-1.5">
            {[5, 10, 15, 20].map((pct) => (
              <button
                key={pct}
                type="button"
                onClick={() => applyTargetDiscount(pct)}
                className="px-2 py-0.5 rounded-md text-[10px] font-semibold bg-slate-100 dark:bg-zinc-800 -emerald-/15 text-slate-700 dark:text-zinc-300 cursor-pointer"
              >
                -{pct}%
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-[11px] font-semibold text-emerald-700 dark:text-emerald-300 mb-1">
            USD Amount to Invest
          </label>
          <input
            type="number"
            step="any"
            min="0"
            value={investUsdStr}
            onChange={(e) => setInvestUsdStr(e.target.value)}
            placeholder="500"
            className="w-full px-3 py-2 rounded-xl border-2 border-emerald-500/40 bg-white dark:bg-zinc-950 font-mono text-sm font-semibold text-slate-950 dark:text-white focus:border-emerald-500 focus:outline-none"
          />
          <div className="flex flex-wrap gap-1 mt-1.5">
            {[100, 500, 1000, 2500].map((amt) => (
              <button
                key={amt}
                type="button"
                onClick={() => setInvestUsdStr(String(amt))}
                className="px-2 py-0.5 rounded-md text-[10px] font-semibold bg-slate-100 dark:bg-zinc-800 hover:bg-emerald-500/15 text-slate-700 dark:text-zinc-300 cursor-pointer font-mono"
              >
                ${amt}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-[11px] font-semibold text-slate-600 dark:text-zinc-400 mb-1">
            Trading Fee %
          </label>
          <input
            type="number"
            step="0.005"
            min="0"
            max="5"
            value={feeRatePctStr}
            onChange={(e) => setFeeRatePctStr(e.target.value)}
            className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 font-mono text-sm text-slate-950 dark:text-white"
          />
          <div className="flex flex-wrap gap-1 mt-1.5">
            {[
              { label: '0.1% Spot', val: '0.1' },
              { label: '0.075% BNB', val: '0.075' },
              { label: '0%', val: '0' },
            ].map((f) => (
              <button
                key={f.label}
                type="button"
                onClick={() => setFeeRatePctStr(f.val)}
                className="px-2 py-0.5 rounded-md text-[10px] font-semibold bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-700 dark:text-zinc-300 cursor-pointer"
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Results Panel */}
      {result.status === 'invalid' && (
        <div className="p-4 rounded-2xl border border-dashed border-slate-300 dark:border-zinc-700 text-xs text-slate-500 dark:text-zinc-400 flex items-center gap-2">
          <Calculator className="h-4 w-4 shrink-0" />
          <span>{result.reason}</span>
        </div>
      )}

      {result.status === 'unreachable' && (
        <div className="p-4 rounded-2xl border border-amber-500/35 bg-amber-500/10 text-xs text-amber-900 dark:text-amber-200 space-y-1.5">
          <div className="font-bold flex items-center gap-1.5">
            <Info className="h-4 w-4 shrink-0" />
            <span>Target Cost Cannot Be Reached With ${investAmountUsd.toFixed(2)}</span>
          </div>
          <p>{result.reason}</p>
          {result.minBudgetAtMarketUsd !== null && result.minBudgetAtMarketUsd > 0 && (
            <p className="font-mono font-semibold">
              Minimum USD needed at current market price (${formatPriceSmart(currentMarketPrice)}): ${result.minBudgetAtMarketUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
          )}
        </div>
      )}

      {result.requiredLimitPrice !== null && (
        <div className="p-4 sm:p-5 rounded-2xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 via-white/90 dark:via-zinc-900/80 to-amber-500/5 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-300 flex items-center gap-1.5">
                {result.status === 'market_achieves_target' ? (
                  <>
                    <Sparkles className="h-3.5 w-3.5 text-emerald-500" />
                    <span>Market Buy Already Achieves Your Target Cost</span>
                  </>
                ) : (
                  <>
                    <TrendingDown className="h-3.5 w-3.5 text-amber-500" />
                    <span>Required Limit Buy Price</span>
                  </>
                )}
              </div>
              <div className="mt-1 flex items-baseline gap-2.5 flex-wrap">
                <span className="text-2xl sm:text-3xl font-black font-mono text-slate-950 dark:text-white">
                  ${formatPriceSmart(result.requiredLimitPrice)}
                </span>
                {result.pctDiffFromMarket !== null && (
                  <span
                    className={`px-2 py-0.5 rounded-full text-xs font-mono font-bold ${
                      result.pctDiffFromMarket <= 0
                        ? 'bg-amber-500/15 text-amber-800 dark:text-amber-300'
                        : 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300'
                    }`}
                  >
                    {result.pctDiffFromMarket >= 0 ? '+' : ''}
                    {result.pctDiffFromMarket.toFixed(2)}% vs market
                  </span>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={handleCopyLimitPrice}
              className="px-3 py-1.5 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:bg-slate-50 dark:hover:bg-zinc-800 text-xs font-semibold text-slate-700 dark:text-zinc-200 inline-flex items-center gap-1.5 cursor-pointer"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
              <span>{copied ? 'Copied' : 'Copy Price'}</span>
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3 border-t border-slate-200/70 dark:border-white/[0.08] text-xs">
            <div>
              <span className="text-slate-500 dark:text-zinc-400 block text-[10px] uppercase">Units to Buy</span>
              <span className="font-mono font-bold text-slate-900 dark:text-white">
                {result.unitsToBuy?.toLocaleString('en-US', { maximumFractionDigits: 6 })}
              </span>
            </div>
            <div>
              <span className="text-slate-500 dark:text-zinc-400 block text-[10px] uppercase">New Total Units</span>
              <span className="font-mono font-bold text-slate-900 dark:text-white">
                {result.resultingTotalUnits?.toLocaleString('en-US', { maximumFractionDigits: 6 })}
              </span>
            </div>
            <div>
              <span className="text-slate-500 dark:text-zinc-400 block text-[10px] uppercase">New Total Cost</span>
              <span className="font-mono font-bold text-slate-900 dark:text-white">
                ${result.resultingTotalCostUsd?.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
            <div>
              <span className="text-slate-500 dark:text-zinc-400 block text-[10px] uppercase">Verified Avg Cost</span>
              <span className="font-mono font-bold text-emerald-700 dark:text-emerald-400">
                ${formatPriceSmart(result.resultingAvgCost || 0)}
              </span>
            </div>
          </div>

          {result.marketBuyPreview && (
            <div className="p-3 rounded-xl bg-white/80 dark:bg-zinc-950/60 border border-slate-200/70 dark:border-zinc-800 text-xs flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div className="text-slate-600 dark:text-zinc-300">
                <strong>If bought at Market (${formatPriceSmart(currentMarketPrice)})</strong> with ${investAmountUsd.toFixed(2)}:
                {' '}your new avg cost would be{' '}
                <span className="font-mono font-bold text-slate-950 dark:text-white">
                  ${formatPriceSmart(result.marketBuyPreview.resultingAvgCost)}
                </span>
              </div>
              {result.minBudgetAtMarketUsd !== null && result.minBudgetAtMarketUsd > 0 && !result.marketBuyPreview.achievesOrBeatsTarget && (
                <div className="font-mono text-[11px] font-semibold text-emerald-700 dark:text-emerald-300 shrink-0">
                  Need ${result.minBudgetAtMarketUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} at market
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface TargetCostModalProps {
  isOpen: boolean;
  onClose: () => void;
  assets: TargetCostAssetOption[];
  initialAsset: TargetCostAssetOption | null;
}

export function TargetCostModal({
  isOpen,
  onClose,
  assets,
  initialAsset,
}: TargetCostModalProps) {
  return (
    <CockpitModal
      id="target-cost-calculator-dialog"
      isOpen={isOpen}
      onClose={onClose}
      labelledBy="target-cost-calculator-title"
      describedBy="target-cost-calculator-description"
      size="wide"
      className="space-y-4"
    >
      <CockpitModalHeader
        title="Target Cost Price Calculator"
        titleId="target-cost-calculator-title"
        description="Calculate the exact limit or market buy price to hit your desired average cost."
        descriptionId="target-cost-calculator-description"
        icon={<Target size={20} />}
        onClose={onClose}
        closeLabel="Close calculator"
      />
      <TargetCostCalculatorCard
        key={`${initialAsset?.symbol || 'custom'}_${isOpen ? 'open' : 'closed'}`}
        assets={assets}
        initialAsset={initialAsset}
        compact
      />
    </CockpitModal>
  );
}
