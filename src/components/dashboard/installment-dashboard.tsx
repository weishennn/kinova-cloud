'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { CreditCard, TrendingDown, Sparkles, ChevronRight } from 'lucide-react';
import { useTransactions } from '@/hooks/useTransactions';
import { useAppStore } from '@/stores/app-store';
import {
  GroupedInstallmentPlan,
  getSavedInstallmentPlans,
} from '@/lib/installment-helper';
import { getLocalDateString, parseLocalDate } from '@/lib/date-helper';
import { SETTINGS_UPDATED_EVENT } from '@/lib/cloud-settings-sync';
import { convertCurrency, getAmountInBaseCurrency, getCachedRatesToMyr } from '@/lib/currency';
import { isTripQuarantinedExpense } from '@/lib/category-budget-helper';

export type { GroupedInstallmentPlan };

export function InstallmentDashboard() {
  const { setEditInstallmentPlan } = useAppStore();
  // Load full transaction history so multi-year installments count all historical payments accurately.
  const { transactions = [], isLoading } = useTransactions({ period: 'all' });
  const [syncTick, setSyncTick] = useState(0);

  useEffect(() => {
    const handleSync = () => setSyncTick((t) => t + 1);
    window.addEventListener(SETTINGS_UPDATED_EVENT, handleSync);
    return () => window.removeEventListener(SETTINGS_UPDATED_EVENT, handleSync);
  }, []);

  const ratesToMyr = useMemo(() => getCachedRatesToMyr(), [syncTick, transactions]);
  const currentMonthStr = getLocalDateString().slice(0, 7);

  const plans = useMemo(() => {
    const map = new Map<string, GroupedInstallmentPlan>();
    const planKeyByTxPrefix = new Map<string, string>();
    const savedPlans = getSavedInstallmentPlans();

    // 1. Initialize from saved persistent plans
    savedPlans.forEach((sp) => {
      const key = sp.name.toLowerCase();
      map.set(key, {
        id: sp.id,
        name: sp.name,
        category: sp.category || 'Shopping',
        currency: sp.currency || 'MYR',
        monthlyAmount: sp.monthlyAmount,
        totalTenure: sp.tenureMonths,
        latestPaidIndex: 0,
        totalPaid: 0,
        totalPayable: sp.totalPayable,
        remainingBalance: sp.totalPayable,
        startDate: sp.startDate,
        endDate: sp.endDate,
        nextDueDate: sp.startDate,
        status: 'active',
        transactions: [],
        annualInterestRate: sp.annualInterestRate,
        tripTag: sp.tripTag,
        remainingMonths: sp.remainingMonths,
      });
      if (sp.id) {
        const sanitizedId = String(sp.id).replace(/[^A-Za-z0-9_-]/g, '_');
        planKeyByTxPrefix.set(`tx_inst_${sp.id}_`, key);
        planKeyByTxPrefix.set(`tx_inst_${sanitizedId}_`, key);
      }
    });

    // 2. Aggregate transactions matching installment patterns
    transactions.forEach((tx) => {
      if (String(tx.type || '').toLowerCase() !== 'expense') return;
      const txId = String(tx.id || '');
      const desc = tx.description || '';
      const notes = tx.notes || '';

      let matchedPrefixKey: string | undefined;
      for (const [prefix, pKey] of planKeyByTxPrefix.entries()) {
        if (txId.startsWith(prefix)) {
          matchedPrefixKey = pKey;
          break;
        }
      }

      const isInst = Boolean(matchedPrefixKey) || desc.includes('(Installment') || notes.includes('[Installment Plan');
      if (!isInst) return;

      // Extract e.g. "MacBook Pro (Installment 1/12)"
      const match = desc.match(/^(.*?)\s*\(Installment\s*(\d+)\/(\d+)\)/i) ||
                    notes.match(/\[Installment Plan\s*(\d+)\/(\d+)\]/i);
      const idIdxMatch = matchedPrefixKey ? txId.match(/_(\d+)$/) : null;

      let planName = matchedPrefixKey ? (map.get(matchedPrefixKey)?.name || 'Installment Plan') : 'Installment Plan';
      let instIndex = idIdxMatch ? (parseInt(idIdxMatch[1], 10) || 1) : 1;
      let totalTenure = matchedPrefixKey ? (map.get(matchedPrefixKey)?.totalTenure || 12) : 12;

      if (match) {
        if (match[3]) {
          planName = matchedPrefixKey ? planName : (match[1] || tx.category || 'Installment Plan').trim();
          instIndex = parseInt(match[2], 10) || instIndex;
          totalTenure = parseInt(match[3], 10) || totalTenure;
        } else if (match[2]) {
          instIndex = parseInt(match[1], 10) || instIndex;
          totalTenure = parseInt(match[2], 10) || totalTenure;
          if (!matchedPrefixKey) {
            planName = (desc.replace(/\s*\(Installment.*\)/i, '') || tx.category).trim();
          }
        }
      }

      // Check if notes has total amount: e.g. "Total: MYR 3600.00"
      const totalMatch = notes.match(/Total:\s*([A-Za-z$]+)?\s*([\d.]+)/i);
      const parsedTotal = totalMatch && totalMatch[2] ? parseFloat(totalMatch[2]) : 0;

      // Check if notes has interest rate: e.g. "3.5% p.a. Interest"
      const rateMatch = notes.match(/([\d.]+)%\s*p\.a\.\s*Interest/i);
      const annualInterestRate = rateMatch ? parseFloat(rateMatch[1]) : 0;

      const key = matchedPrefixKey || planName.toLowerCase();
      if (!map.has(key)) {
        map.set(key, {
          name: planName,
          category: tx.category || 'Shopping',
          currency: tx.currency || 'MYR',
          monthlyAmount: tx.amount,
          totalTenure: totalTenure,
          latestPaidIndex: instIndex,
          totalPaid: 0,
          totalPayable: parsedTotal > 0 ? parsedTotal : tx.amount * totalTenure,
          remainingBalance: 0,
          startDate: tx.date,
          endDate: tx.date,
          status: 'active',
          transactions: [],
          annualInterestRate,
          tripTag: tx.tripTag,
        });
      }

      const p = map.get(key)!;
      if (!p.transactions.some((existing) => existing.id && tx.id && existing.id === tx.id)) {
        p.transactions.push(tx);
      }
      if (!p.tripTag && tx.tripTag) {
        p.tripTag = tx.tripTag;
      }
      if (instIndex > p.latestPaidIndex) {
        p.latestPaidIndex = instIndex;
      }
      if (tx.date && (!p.startDate || tx.date < p.startDate)) p.startDate = tx.date;
      if (annualInterestRate && !p.annualInterestRate) p.annualInterestRate = annualInterestRate;
    });

    const list = Array.from(map.values()).map((p) => {
      // Calculate end date based on startDate + tenure if not all future months loaded
      if (p.startDate && p.totalTenure > 0) {
        try {
          const d = parseLocalDate(p.startDate);
          d.setMonth(d.getMonth() + (p.totalTenure - 1));
          const yyyy = d.getFullYear();
          const mm = String(d.getMonth() + 1).padStart(2, '0');
          p.endDate = `${yyyy}-${mm}`;
        } catch {}
      }

      const paidIndices = new Set<number>();
      p.transactions.forEach((tx) => {
        const match = tx.description.match(/\(Installment\s*(\d+)\//i) || tx.notes?.match(/\[Installment Plan\s*(\d+)\//i);
        const idMatch = String(tx.id || '').match(/^tx_inst_.*_(\d+)$/);
        const index = match ? Number(match[1]) : idMatch ? Number(idMatch[1]) : 0;
        if (index > 0) paidIndices.add(index);
      });
      const paidCount = Math.max(paidIndices.size, p.transactions.length);
      if (paidIndices.size > 0) {
        p.latestPaidIndex = Math.max(p.latestPaidIndex, Math.max(...paidIndices));
      } else {
        p.latestPaidIndex = Math.max(p.latestPaidIndex, paidCount);
      }
      const planCurr = p.currency || 'MYR';
      p.totalPaid = p.transactions.reduce(
        (sum, tx) => sum + convertCurrency(Number(tx.amount) || 0, tx.currency || 'MYR', planCurr, ratesToMyr),
        0
      );
      p.remainingBalance = Math.max(0, p.totalPayable - p.totalPaid);
      const isZeroRemaining = typeof p.remainingMonths === 'number' && p.remainingMonths <= 0;
      const isPaidByTenure = paidCount >= p.totalTenure && p.totalTenure > 0;
      const isPaidByBalance = p.totalPayable > 0 && p.remainingBalance <= 0.01 && p.transactions.length > 0;
      p.status = isZeroRemaining || isPaidByTenure || isPaidByBalance ? 'completed' : 'active';
      return p;
    });

    return list.sort((a, b) => (a.status === 'active' ? -1 : 1));
  }, [transactions, syncTick, ratesToMyr]);

  // Aggregate metrics in accounting base currency (MYR)
  const activePlans = plans.filter((p) => p.status === 'active');
  const activeLivingThisMonthPlans = activePlans.filter((p) => {
    if (p.tripTag && isTripQuarantinedExpense({ tripTag: p.tripTag })) return false;
    if (p.startDate && p.startDate.slice(0, 7) > currentMonthStr) return false;
    if (p.endDate && p.endDate.slice(0, 7) < currentMonthStr) return false;
    return true;
  });
  const totalMonthlyCommitment = activeLivingThisMonthPlans.reduce(
    (sum, p) => sum + getAmountInBaseCurrency(p.monthlyAmount, p.currency || 'MYR', undefined, ratesToMyr),
    0
  );
  const totalRemainingDebt = activePlans.reduce(
    (sum, p) => sum + getAmountInBaseCurrency(p.remainingBalance, p.currency || 'MYR', undefined, ratesToMyr),
    0
  );
  const totalInitialDebt = activePlans.reduce(
    (sum, p) => sum + getAmountInBaseCurrency(p.totalPayable, p.currency || 'MYR', undefined, ratesToMyr),
    0
  );
  const overallProgress = totalInitialDebt > 0 ? Math.round(((totalInitialDebt - totalRemainingDebt) / totalInitialDebt) * 100) : 0;

  // Furthest end date
  const furthestEndDate = useMemo(() => {
    if (activePlans.length === 0) return 'Fully Debt-Free!';
    const sorted = [...activePlans].sort((a, b) => b.endDate.localeCompare(a.endDate));
    return sorted[0].endDate;
  }, [activePlans]);

  if (plans.length === 0 && !isLoading) {
    return null; // No installments recorded yet
  }

  return (
    <div className="rounded-3xl border border-slate-200 dark:border-white/[0.08] bg-card/60 p-5 sm:p-6 backdrop-blur-2xl shadow-xl space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="p-2.5 rounded-2xl bg-purple-500/15 border border-purple-500/30 text-violet-800 dark:text-purple-400 shadow-sm shrink-0">
            <CreditCard className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-base sm:text-lg font-bold text-slate-950 dark:text-white tracking-tight">
              Active Installment & Debt Commitment
            </h2>
            <p className="text-xs text-slate-600 dark:text-zinc-400">
              Track ongoing 0% EPP & monthly installment commitments
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="px-3 py-1 rounded-full text-xs font-semibold bg-purple-500/10 border border-purple-500/25 text-violet-800 dark:text-purple-300">
            {activePlans.length} Active {activePlans.length === 1 ? 'Plan' : 'Plans'}
          </span>
        </div>
      </div>

      {/* Hero Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {/* Monthly Commitment */}
        <div className="rounded-2xl border border-slate-200 dark:border-white/[0.08] bg-white/90 dark:bg-zinc-900/50 p-4 space-y-1 shadow-sm">
          <span className="text-[11px] font-semibold text-slate-600 dark:text-zinc-400 uppercase tracking-wider block">
            Monthly Commitment
          </span>
          <div className="text-xl sm:text-2xl font-black font-mono tabular-nums text-violet-800 dark:text-purple-400">
            RM {totalMonthlyCommitment.toFixed(2)}
            <span className="text-xs text-slate-600 dark:text-zinc-400 font-normal ml-1">/ month</span>
          </div>
          <p className="text-[11px] text-slate-600 dark:text-zinc-400">Auto-deducted from living cashflow</p>
        </div>

        {/* Total Remaining Debt */}
        <div className="rounded-2xl border border-slate-200 dark:border-white/[0.08] bg-white/90 dark:bg-zinc-900/50 p-4 space-y-1 shadow-sm">
          <span className="text-[11px] font-semibold text-slate-600 dark:text-zinc-400 uppercase tracking-wider block">
            Remaining Debt Balance
          </span>
          <div className="text-xl sm:text-2xl font-black font-mono tabular-nums text-slate-950 dark:text-white">
            RM {totalRemainingDebt.toFixed(2)}
          </div>
          <p className="text-[11px] text-emerald-800 dark:text-emerald-400 flex items-center gap-1 font-medium">
            <TrendingDown className="h-3 w-3" /> {overallProgress}% already paid off
          </p>
        </div>

        {/* Debt-Free Target Date */}
        <div className="rounded-2xl border border-slate-200 dark:border-white/[0.08] bg-white/90 dark:bg-zinc-900/50 p-4 space-y-1 shadow-sm">
          <span className="text-[11px] font-semibold text-slate-600 dark:text-zinc-400 uppercase tracking-wider block">
            Debt-Free Target
          </span>
          <div className="text-xl sm:text-2xl font-black font-mono tabular-nums text-emerald-800 dark:text-emerald-400">
            {furthestEndDate}
          </div>
          <p className="text-[11px] text-slate-600 dark:text-zinc-400 flex items-center gap-1">
            <Sparkles className="h-3 w-3 text-violet-800 dark:text-purple-400" />
            {activePlans.length > 0 ? 'Projected debt-free milestone' : 'All installments cleared!'}
          </p>
        </div>
      </div>

      {/* Individual Plan Cards List */}
      <div className="space-y-3 pt-1">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-slate-700 dark:text-zinc-300 uppercase tracking-wider block">
            Ongoing Installment Plans
          </span>
          <span className="text-[11px] text-slate-600 dark:text-zinc-400 hidden sm:inline">
            Tap any plan to edit or reschedule
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {plans.map((p) => {
            const percent = p.totalTenure > 0 ? Math.min(100, Math.round((p.latestPaidIndex / p.totalTenure) * 100)) : 100;
            const isCompleted = p.status === 'completed';

            return (
              <div
                key={p.id || p.name}
                role="button"
                tabIndex={0}
                onClick={() => setEditInstallmentPlan(p)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setEditInstallmentPlan(p);
                  }
                }}
                className="rounded-2xl border border-slate-200 dark:border-white/[0.08] bg-white/90 dark:bg-zinc-900/60 p-4 space-y-3 hover:border-purple-500/40 hover:bg-white/90 dark:hover:bg-zinc-900/90 hover:shadow-lg hover:shadow-purple-950/20 cursor-pointer transition-all active:scale-[0.99] group focus:outline-none focus:ring-2 focus:ring-purple-500/40"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-sm text-slate-950 dark:text-white group-hover:text-violet-800 dark:group-hover:text-purple-300 transition-colors">
                      {p.name}
                    </span>
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400">
                      {p.category}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`text-[10px] font-bold px-2.5 py-0.5 rounded-full uppercase tracking-wider ${
                        isCompleted
                          ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-400 border border-emerald-500/30'
                          : 'bg-purple-500/15 text-violet-800 dark:text-purple-300 border border-purple-500/30'
                      }`}
                    >
                      {isCompleted ? 'Paid Off' : `Month ${p.latestPaidIndex}/${p.totalTenure}`}
                    </span>
                    <ChevronRight className="h-4 w-4 text-slate-600 dark:text-zinc-300 group-hover:text-violet-800 dark:group-hover:text-purple-400 group-hover:translate-x-0.5 transition-all" />
                  </div>
                </div>

                {/* Progress Bar */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-600 dark:text-zinc-400">
                      Progress: <strong className="text-slate-950 dark:text-white">{p.latestPaidIndex} of {p.totalTenure} months</strong>
                    </span>
                    <span className="font-mono font-bold text-violet-800 dark:text-purple-300">{percent}%</span>
                  </div>
                  <div className="h-2 w-full rounded-full bg-slate-100 dark:bg-zinc-800 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${
                        isCompleted
                          ? 'bg-emerald-400'
                          : 'bg-gradient-to-r from-purple-500 to-indigo-500'
                      }`}
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                </div>

                {/* Numbers Row */}
                <div className="flex items-center justify-between pt-1 border-t border-slate-200 dark:border-zinc-800/60 text-xs">
                  <div>
                    <span className="text-slate-500 dark:text-zinc-400 block text-[10px]">Monthly</span>
                    <span className="font-mono font-bold text-violet-800 dark:text-purple-400">
                      {p.currency} {p.monthlyAmount.toFixed(2)}/mo
                    </span>
                  </div>
                  <div className="text-right">
                    <span className="text-slate-500 dark:text-zinc-400 block text-[10px]">Remaining</span>
                    <span className="font-mono font-bold text-slate-950 dark:text-white">
                      {p.currency} {p.remainingBalance.toFixed(2)}
                    </span>
                  </div>
                  <div className="text-right">
                    <span className="text-slate-500 dark:text-zinc-400 block text-[10px]">Ends</span>
                    <span className="font-mono font-semibold text-slate-700 dark:text-zinc-300">
                      {p.endDate}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
