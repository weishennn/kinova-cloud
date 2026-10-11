'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { motion } from 'framer-motion';
import {
  AlertCircle, Wallet, Edit2, Check, Inbox, Sparkles,
  Clock, TrendingDown, ShieldAlert, ArrowUpRight, DollarSign, X,
  Calendar, ChevronLeft, ChevronRight
} from 'lucide-react';
import { useTransactions } from '@/hooks/useTransactions';
import { AnimatedNumber } from '@/components/shared/animated-number';
import { CockpitPageHeading } from '@/components/money-cockpit/cockpit-page-heading';
import { getAmountInBaseCurrency } from '@/lib/currency';
import { useAppStore } from '@/stores/app-store';
import { RecurringCommitments } from '@/components/dashboard/recurring-commitments';
import { InstallmentDashboard } from '@/components/dashboard/installment-dashboard';
import {
  getSavedCategoryCaps,
  saveCategoryCaps,
  calculateDailySafeSpend,
  DEFAULT_CATEGORY_CAPS
} from '@/lib/category-budget-helper';
import { saveSettingWithCloudSync, SETTINGS_UPDATED_EVENT } from '@/lib/cloud-settings-sync';

export default function BudgetPage() {
  const { selectedMonth, setSelectedMonth } = useAppStore();
  const { transactions = [] } = useTransactions(selectedMonth ? { period: selectedMonth } : undefined);

  // Active month in YYYY-MM format, e.g. "2026-10"
  const currentMonthStr = useMemo(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }, []);

  // Extract all available years and months from transactions + current year/month
  const { availableYears, monthsByYear, allAvailableMonths } = useMemo(() => {
    const monthSet = new Set<string>();
    monthSet.add(currentMonthStr);

    const [curY] = currentMonthStr.split('-').map(Number);
    for (let m = 1; m <= 12; m++) {
      monthSet.add(`${curY}-${String(m).padStart(2, '0')}`);
    }

    transactions.forEach(t => {
      if (t.date && t.date.length >= 7 && /^\d{4}-\d{2}/.test(t.date)) {
        monthSet.add(t.date.substring(0, 7));
      }
    });

    const sortedMonths = Array.from(monthSet).sort((a, b) => b.localeCompare(a));

    const byYear: Record<string, string[]> = {};
    const yearSet = new Set<string>();

    sortedMonths.forEach(m => {
      const y = m.substring(0, 4);
      yearSet.add(y);
      if (!byYear[y]) byYear[y] = [];
      byYear[y].push(m);
    });

    const sortedYears = Array.from(yearSet).sort((a, b) => b.localeCompare(a));

    return {
      availableYears: sortedYears,
      monthsByYear: byYear,
      allAvailableMonths: sortedMonths
    };
  }, [transactions, currentMonthStr]);

  const handlePrevMonth = () => {
    if (selectedMonth.startsWith('year-')) {
      const y = selectedMonth.replace('year-', '');
      setSelectedMonth(`${y}-12`);
      return;
    }
    if (selectedMonth === 'all') {
      setSelectedMonth(currentMonthStr);
      return;
    }
    const [y, m] = selectedMonth.split('-').map(Number);
    if (!isNaN(y) && !isNaN(m)) {
      const prevDate = new Date(y, m - 2, 1);
      const prevStr = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;
      setSelectedMonth(prevStr);
    }
  };

  const handleNextMonth = () => {
    if (selectedMonth.startsWith('year-')) {
      const y = selectedMonth.replace('year-', '');
      setSelectedMonth(`${y}-01`);
      return;
    }
    if (selectedMonth === 'all') {
      setSelectedMonth(currentMonthStr);
      return;
    }
    const [y, m] = selectedMonth.split('-').map(Number);
    if (!isNaN(y) && !isNaN(m)) {
      const nextDate = new Date(y, m, 1);
      const nextStr = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, '0')}`;
      setSelectedMonth(nextStr);
    }
  };

  const formatMonthLabel = (mStr: string) => {
    if (mStr === 'all') return 'All Time (Accumulated)';
    if (mStr.startsWith('year-')) {
      return `Full Year ${mStr.replace('year-', '')}`;
    }
    const [y, m] = mStr.split('-').map(Number);
    if (isNaN(y) || isNaN(m)) return mStr;
    const d = new Date(y, m - 1, 1);
    return d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
  };

  // Scoped transactions & expenses for selected month or full year
  const monthlyTransactions = useMemo(() => {
    if (selectedMonth === 'all') {
      return transactions.filter(t => t.id !== 'tx_sample' && !!t.date);
    }
    if (selectedMonth.startsWith('year-')) {
      const y = selectedMonth.replace('year-', '');
      return transactions.filter(t => t.id !== 'tx_sample' && !!t.date && t.date.startsWith(y));
    }
    return transactions.filter(t => t.id !== 'tx_sample' && !!t.date && t.date.startsWith(selectedMonth));
  }, [transactions, selectedMonth]);

  const monthlyExpenses = useMemo(() => {
    return monthlyTransactions.filter(t => t.type === 'expense');
  }, [monthlyTransactions]);

  const totalSpent = useMemo(() => {
    return monthlyExpenses.reduce((sum, t) => sum + getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount), 0);
  }, [monthlyExpenses]);

  // Scoped category breakdown for selected month
  const breakdown = useMemo(() => {
    const catMap: Record<string, number> = {};
    monthlyExpenses.forEach(t => {
      const cat = t.category || 'Other';
      catMap[cat] = (catMap[cat] || 0) + getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount);
    });
    return Object.entries(catMap)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  }, [monthlyExpenses]);

  const [monthlyBudget, setMonthlyBudget] = useState(3000);
  const [isEditingBudget, setIsEditingBudget] = useState(false);
  const [budgetValue, setBudgetValue] = useState('3000');

  // Category specific caps
  const [categoryCaps, setCategoryCaps] = useState<Record<string, number>>(DEFAULT_CATEGORY_CAPS);
  const [editingCategory, setEditingCategory] = useState<string | null>(null);
  const [categoryCapInput, setCategoryCapInput] = useState('');

  useEffect(() => {
    const loadBudgetSettings = () => {
      const saved = localStorage.getItem('cashflow_monthly_budget');
      if (saved) {
        const parsed = parseFloat(saved);
        if (!isNaN(parsed) && parsed > 0) {
          setMonthlyBudget(parsed);
          setBudgetValue(saved);
        }
      }
      setCategoryCaps(getSavedCategoryCaps());
    };

    loadBudgetSettings();
    window.addEventListener(SETTINGS_UPDATED_EVENT, loadBudgetSettings);
    return () => window.removeEventListener(SETTINGS_UPDATED_EVENT, loadBudgetSettings);
  }, []);

  const handleSaveBudget = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseFloat(budgetValue);
    if (!isNaN(parsed) && parsed > 0) {
      setMonthlyBudget(parsed);
      saveSettingWithCloudSync('cashflow_monthly_budget', budgetValue);
      setIsEditingBudget(false);
    }
  };

  const handleSaveCategoryCap = (categoryName: string) => {
    const parsed = parseFloat(categoryCapInput);
    if (!isNaN(parsed) && parsed >= 0) {
      const updated = { ...categoryCaps, [categoryName]: parsed };
      setCategoryCaps(updated);
      saveCategoryCaps(updated);
    }
    setEditingCategory(null);
    setCategoryCapInput('');
  };

  const isYearMode = selectedMonth.startsWith('year-');
  const effectiveBudget = isYearMode ? monthlyBudget * 12 : monthlyBudget;
  const progressPercent = effectiveBudget > 0 ? Math.min((totalSpent / effectiveBudget) * 100, 100) : 0;
  const circumference = 2 * Math.PI * 45; // ~282.7
  const strokeDashoffset = circumference - (circumference * progressPercent) / 100;
  const isOverBudget = totalSpent > effectiveBudget;

  // Daily Safe-to-Spend calculations scoped to selected month
  const dailyInfo = useMemo(() => {
    if (selectedMonth === 'all') {
      return {
        totalBudget: effectiveBudget,
        totalSpent,
        remainingBudget: Math.max(0, effectiveBudget - totalSpent),
        dailyAllowance: 0,
        daysRemaining: 0,
        todayDate: 0,
        totalDays: 0,
        isCurrentMonth: false,
        isPastMonth: false,
        isOverBudget,
        overAmount: Math.max(0, totalSpent - effectiveBudget),
        spentPercent: effectiveBudget > 0 ? Number(((totalSpent / effectiveBudget) * 100).toFixed(1)) : 0,
        isAllTime: true,
      };
    }
    return { ...calculateDailySafeSpend(effectiveBudget, totalSpent, selectedMonth), isAllTime: false };
  }, [effectiveBudget, totalSpent, selectedMonth, isOverBudget]);

  return (
    <div className="cockpit-module-page">
      <CockpitPageHeading
        title="Monthly Budget & Limits"
        description="Track spending caps, live daily safe limits, commitments and installments"
        action={!isEditingBudget ? (
          <motion.button
            whileHover={{ scale: 1.04 }}
            whileTap={{ scale: 0.96 }}
            onClick={() => setIsEditingBudget(true)}
            className="cockpit-primary-action"
          >
            <Edit2 className="h-3.5 w-3.5" />
            <span>Set Target Budget</span>
          </motion.button>
        ) : (
          <form onSubmit={handleSaveBudget} className="flex items-center gap-2">
            <input
              type="number"
              value={budgetValue}
              onChange={(e) => setBudgetValue(e.target.value)}
              className="w-32 rounded-xl border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-1.5 text-xs text-slate-950 dark:text-white outline-none focus:border-indigo-500 font-mono"
            />
            <button
              type="submit"
              className="p-2 rounded-xl bg-indigo-500 hover:bg-indigo-600 text-white dark:text-white cursor-pointer"
            >
              <Check className="h-4 w-4" />
            </button>
          </form>
        )}
      />

      {/* Month Selector Bar with Year Optgroups */}
      <div className="bg-white/90 dark:bg-zinc-900/60 p-3.5 sm:p-4 rounded-3xl border border-slate-200 dark:border-white/[0.08] backdrop-blur-xl shadow-lg space-y-3 specular-card">
        {/* Header: Label + Selected Month */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="p-2 rounded-xl bg-indigo-500/15 text-indigo-800 dark:text-indigo-400 border border-indigo-500/20 shrink-0">
              <Calendar className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-semibold text-slate-600 dark:text-zinc-400 uppercase tracking-wider block">Budgeting Period</span>
                {selectedMonth === currentMonthStr && (
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border border-emerald-500/30">
                    Current
                  </span>
                )}
              </div>
              <span className="text-sm sm:text-base font-bold text-slate-950 dark:text-white tracking-tight truncate block">{formatMonthLabel(selectedMonth)}</span>
            </div>
          </div>
          <span className="text-[11px] text-slate-500 dark:text-zinc-400 hidden sm:inline">Filter monthly budget</span>
        </div>

        {/* Navigation Box: Prev / Dropdown / Next - fits neatly INSIDE the card without overflowing */}
        <div className="flex items-center justify-between gap-1.5 rounded-2xl border border-slate-200 dark:border-white/[0.08] bg-white/90 dark:bg-zinc-950/60 p-1 w-full max-w-full overflow-hidden">
          <button
            type="button"
            onClick={handlePrevMonth}
            className="min-w-[40px] min-h-[40px] p-2 rounded-xl bg-white/90 dark:bg-zinc-900/80 hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-700 dark:text-zinc-300 hover:text-slate-950 dark:hover:text-white transition-colors cursor-pointer border border-slate-200 dark:border-white/[0.06] active:scale-95 flex items-center justify-center shrink-0"
            title="Previous Month"
            aria-label="Previous Month"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>

          <select
            value={selectedMonth}
            onChange={(e) => setSelectedMonth(e.target.value)}
            className="min-h-[40px] flex-1 min-w-0 rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white/90 dark:bg-zinc-900/90 px-3 py-1.5 text-xs font-semibold text-slate-950 dark:text-white outline-none focus:border-indigo-500 cursor-pointer transition-colors font-mono text-center truncate"
            aria-label="Select month or year"
          >
            <option value={currentMonthStr} className="bg-white dark:bg-zinc-900 text-slate-950 dark:text-white font-mono font-semibold">
              {formatMonthLabel(currentMonthStr)}
            </option>
            <option value="all" className="bg-white dark:bg-zinc-900 text-slate-950 dark:text-white font-mono">
              All Time (Accumulated)
            </option>
            {availableYears.map(year => (
              <optgroup key={year} label={`── Year ${year} ──`} className="bg-white dark:bg-zinc-950 text-indigo-800 dark:text-indigo-400 font-bold">
                <option value={`year-${year}`} className="bg-white dark:bg-zinc-900 text-slate-950 dark:text-white font-mono font-semibold">
                  Full Year {year} (Annual Target)
                </option>
                {monthsByYear[year]?.map(m => (
                  <option key={m} value={m} className="bg-white dark:bg-zinc-900 text-slate-950 dark:text-white font-mono">
                    {formatMonthLabel(m)}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>

          <button
            type="button"
            onClick={handleNextMonth}
            className="min-w-[40px] min-h-[40px] p-2 rounded-xl bg-white/90 dark:bg-zinc-900/80 hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-700 dark:text-zinc-300 hover:text-slate-950 dark:hover:text-white transition-colors cursor-pointer border border-slate-200 dark:border-white/[0.06] active:scale-95 flex items-center justify-center shrink-0"
            title="Next Month"
            aria-label="Next Month"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Hero Overview Grid: Circular Progress + Daily Safe-to-Spend Limit */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Circular Progress Gauge */}
        <motion.div
          whileHover={{ y: -4, scale: 1.01 }}
          transition={{ type: 'spring' as const, stiffness: 400, damping: 25 }}
          className="rounded-3xl border border-slate-200 dark:border-white/[0.08] bg-card/60 p-6 text-center backdrop-blur-2xl flex flex-col justify-between shadow-xl hover:border-indigo-500/40 transition-colors specular-card"
        >
          <div className="relative mx-auto h-48 w-48">
            <svg className="h-full w-full" viewBox="0 0 100 100">
              <circle cx="50" cy="50" r="45" fill="none" stroke="#27272a" strokeWidth="8" />
              <motion.circle
                cx="50" cy="50" r="45"
                fill="none"
                stroke={isOverBudget ? '#ef4444' : progressPercent > 80 ? '#f59e0b' : '#6366f1'}
                strokeWidth="8"
                strokeDasharray={circumference}
                strokeDashoffset={strokeDashoffset}
                strokeLinecap="round"
                transform="rotate(-90 50 50)"
                initial={{ strokeDashoffset: circumference }}
                animate={{ strokeDashoffset }}
                transition={{ duration: 1.2, ease: "easeOut" }}
                className="drop-shadow-[0_0_8px_rgba(99,102,241,0.3)]"
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-slate-600 dark:text-zinc-400 text-[11px] uppercase tracking-wider font-semibold">Total Spent</span>
              <span className="text-2xl font-black text-slate-950 dark:text-white mt-0.5 font-mono tabular-nums">
                <AnimatedNumber value={totalSpent} animateOnMount />
              </span>
              <span className="text-slate-600 dark:text-zinc-400 text-xs mt-0.5 font-medium font-mono tabular-nums">
                of <AnimatedNumber value={effectiveBudget} animateOnMount />{isYearMode ? ' (Annual)' : ''}
              </span>
            </div>
          </div>

          <div className="mt-4 flex items-center justify-center gap-6 text-xs text-slate-600 dark:text-zinc-400 border-t border-slate-200 dark:border-white/[0.06] pt-4">
            <div>
              <span>Used: </span>
              <strong className={isOverBudget ? 'text-rose-800 dark:text-rose-400 font-mono tabular-nums' : 'text-slate-950 dark:text-white font-mono tabular-nums'}>
                {progressPercent.toFixed(1)}%
              </strong>
            </div>
            <div className="w-px h-4 bg-slate-100 dark:bg-zinc-800" />
            <div>
              <span>Remaining: </span>
              <strong className={isOverBudget ? 'text-rose-800 dark:text-rose-400 font-mono tabular-nums' : 'text-emerald-800 dark:text-emerald-400 font-mono tabular-nums'}>
                <AnimatedNumber value={Math.max(0, effectiveBudget - totalSpent)} animateOnMount />
              </strong>
            </div>
          </div>
        </motion.div>

        {/* Live Daily Safe-to-Spend Limit Card */}
        <motion.div
          whileHover={{ y: -4, scale: 1.01 }}
          transition={{ type: 'spring' as const, stiffness: 400, damping: 25 }}
          className="rounded-3xl border border-emerald-500/25 bg-gradient-to-br from-emerald-950/25 via-slate-100 dark:via-zinc-900/50 to-white dark:to-zinc-950 p-6 backdrop-blur-xl shadow-xl hover:border-emerald-500/40 transition-colors flex flex-col justify-between space-y-4 specular-card"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="p-2 rounded-xl bg-emerald-500/15 text-emerald-800 dark:text-emerald-400 border border-emerald-500/30">
                <Sparkles className="h-5 w-5" />
              </div>
              <div>
                <span className="text-xs font-bold text-slate-950 dark:text-white uppercase tracking-wider block">Daily Safe-to-Spend Limit</span>
                <span className="text-[11px] text-slate-600 dark:text-zinc-400">
                  {dailyInfo.isAllTime ? 'Daily allowance is unavailable for all-time totals' : dailyInfo.isPastMonth ? 'Month concluded' : `${dailyInfo.daysRemaining} days remaining in this month`}
                </span>
              </div>
            </div>

            <span className={`text-[11px] font-bold px-2.5 py-0.5 rounded-full uppercase tracking-wider ${
              dailyInfo.isAllTime
                ? 'bg-zinc-500/15 text-slate-600 dark:text-zinc-400 border border-slate-400 dark:border-zinc-500/30'
                : dailyInfo.isOverBudget
                ? 'bg-rose-500/15 text-rose-800 dark:text-rose-400 border border-rose-500/30'
                : dailyInfo.spentPercent > 80
                ? 'bg-amber-500/15 text-amber-800 dark:text-amber-400 border border-amber-500/30'
                : 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-400 border border-emerald-500/30'
            }`}>
              {dailyInfo.isAllTime ? 'Period Total' : dailyInfo.isOverBudget ? 'Over Budget' : dailyInfo.isPastMonth ? 'Concluded' : dailyInfo.spentPercent > 80 ? 'Caution' : 'On Track'}
            </span>
          </div>

          {/* Big Daily Allowance Display */}
          <div className="py-2">
            <span className="text-[11px] text-slate-600 dark:text-zinc-400 font-semibold uppercase tracking-wider block">
              {dailyInfo.isAllTime ? 'Daily Allowance' : dailyInfo.isPastMonth ? 'Final Daily Average' : 'Safe Daily Spend Allowance'}
            </span>
            <div className={`text-3xl sm:text-4xl font-black font-mono tracking-tight mt-1 ${
              dailyInfo.isAllTime ? 'text-slate-600 dark:text-zinc-400' : dailyInfo.isOverBudget ? 'text-rose-800 dark:text-rose-400' : 'text-emerald-800 dark:text-emerald-400'
            }`}>
              {dailyInfo.isAllTime ? '—' : <AnimatedNumber value={dailyInfo.dailyAllowance} animateOnMount />}
              {!dailyInfo.isAllTime && <span className="text-xs font-normal text-slate-600 dark:text-zinc-400 ml-1">/ day</span>}
            </div>
            <p className="text-xs text-slate-700 dark:text-zinc-300 mt-2 leading-relaxed">
              {dailyInfo.isAllTime
                ? 'Choose a month or year to see a time-based daily allowance.'
                : dailyInfo.isPastMonth
                ? dailyInfo.isOverBudget
                  ? `⚠️ This month concluded over budget by RM ${dailyInfo.overAmount.toFixed(2)} (${dailyInfo.spentPercent}% used).`
                  : `🎉 This month concluded successfully with RM ${dailyInfo.remainingBudget.toFixed(2)} remaining under budget (${dailyInfo.spentPercent}% used).`
                : dailyInfo.isOverBudget
                ? `⚠️ You have exceeded your monthly limit by RM ${dailyInfo.overAmount.toFixed(2)}. Avoid non-essential expenses for the next ${dailyInfo.daysRemaining} days.`
                : dailyInfo.spentPercent > 80
                ? `⚠️ Approaching budget cap (${dailyInfo.spentPercent}% used). Keep daily expenses under RM ${dailyInfo.dailyAllowance.toFixed(2)} to stay within your goal.`
                : `🎉 You are well on track! You can safely spend up to RM ${dailyInfo.dailyAllowance.toFixed(2)} each day until month end.`}
            </p>
          </div>

          <div className="pt-3 border-t border-slate-200 dark:border-zinc-800/80 flex items-center justify-between text-xs text-slate-600 dark:text-zinc-400">
            <span>{dailyInfo.isAllTime ? 'Remaining Period Budget:' : dailyInfo.isPastMonth ? 'Final Unused Cashflow:' : 'Remaining Month Cashflow:'}</span>
            <span className="font-mono font-bold text-slate-950 dark:text-white">
              RM {dailyInfo.remainingBudget.toFixed(2)}
            </span>
          </div>
        </motion.div>
      </div>

      {/* Active Installment & Debt Commitment Dashboard */}
      <InstallmentDashboard />

      {/* Monthly Recurring Commitments */}
      <RecurringCommitments />

      {/* Category Breakdown & Spending Caps */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs uppercase font-semibold text-slate-600 dark:text-zinc-400 tracking-wider">
            Category Spending Caps & Daily Allowances
          </h3>
          <span className="text-[11px] text-slate-500 dark:text-zinc-400">Tap pencil to edit category cap</span>
        </div>

        {breakdown.length === 0 ? (
          <div className="text-center py-10 rounded-2xl border border-slate-200 dark:border-zinc-800/80 bg-white/90 dark:bg-zinc-900/20">
            <p className="text-xs text-slate-500 dark:text-zinc-400">No categorized expenses recorded for {formatMonthLabel(selectedMonth)}</p>
          </div>
        ) : (
          breakdown.map((item) => {
            const cap = categoryCaps[item.name] || DEFAULT_CATEGORY_CAPS[item.name] || 500;
            const percentOfCap = cap > 0 ? (item.value / cap) * 100 : 0;
            const isCatOver = item.value > cap;
            const remainingCat = Math.max(0, cap - item.value);
            const dailyCat = !dailyInfo.isAllTime && dailyInfo.daysRemaining > 0 ? remainingCat / dailyInfo.daysRemaining : 0;

            const isEditingThis = editingCategory === item.name;

            return (
              <div
                key={item.name}
                className={`rounded-2xl border p-4 space-y-2.5 transition-all ${
                  isCatOver
                    ? 'border-rose-500/30 bg-rose-950/15'
                    : percentOfCap > 70
                    ? 'border-amber-500/30 bg-amber-950/15'
                    : 'border-slate-200 dark:border-zinc-800/80 bg-white/90 dark:bg-zinc-900/40'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-slate-950 dark:text-white text-sm">{item.name}</span>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                      isCatOver
                        ? 'bg-rose-500/20 text-rose-800 dark:text-rose-400'
                        : percentOfCap > 70
                        ? 'bg-amber-500/20 text-amber-800 dark:text-amber-400'
                        : 'bg-emerald-500/20 text-emerald-800 dark:text-emerald-400'
                    }`}>
                      {percentOfCap.toFixed(0)}%
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    {!isEditingThis ? (
                      <div className="flex items-center gap-2 text-slate-600 dark:text-zinc-400">
                        <span className="font-mono">
                          <strong className="text-slate-950 dark:text-white font-bold">RM {item.value.toFixed(2)}</strong> / Cap: RM {cap.toFixed(0)}
                        </span>
                        <button
                          onClick={() => {
                            setEditingCategory(item.name);
                            setCategoryCapInput(String(cap));
                          }}
                          className="p-1 rounded-lg text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer transition-colors"
                          title="Set category spending cap"
                        >
                          <Edit2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] text-slate-600 dark:text-zinc-400">Cap: RM</span>
                        <input
                          type="number"
                          value={categoryCapInput}
                          onChange={(e) => setCategoryCapInput(e.target.value)}
                          className="w-20 rounded-lg border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-2 py-1 text-xs text-slate-950 dark:text-white font-mono outline-none focus:border-indigo-500"
                        />
                        <button
                          onClick={() => handleSaveCategoryCap(item.name)}
                          className="p-1 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white dark:text-white cursor-pointer"
                        >
                          <Check className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => setEditingCategory(null)}
                          className="p-1 rounded-lg bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-600 dark:text-zinc-400 cursor-pointer"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Progress Bar */}
                <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-zinc-800">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      isCatOver
                        ? 'bg-rose-500'
                        : percentOfCap > 70
                        ? 'bg-amber-400'
                        : 'bg-indigo-500'
                    }`}
                    style={{ width: `${Math.min(percentOfCap, 100)}%` }}
                  />
                </div>

                {/* Daily Safe Limit for this Category */}
                <div className="flex items-center justify-between text-[11px] text-slate-600 dark:text-zinc-400 pt-0.5">
                  <span>
                    {isCatOver ? (
                      <span className="text-rose-800 dark:text-rose-400 font-semibold">Over cap by RM {(item.value - cap).toFixed(2)}</span>
                    ) : (
                      <span>Remaining: <strong className="text-slate-800 dark:text-zinc-200 font-mono">RM {remainingCat.toFixed(2)}</strong></span>
                    )}
                  </span>
                  <span className="font-mono text-slate-700 dark:text-zinc-300">
                    Daily limit: <strong className={isCatOver ? 'text-rose-800 dark:text-rose-400' : 'text-emerald-800 dark:text-emerald-400'}>RM {dailyCat.toFixed(2)} / day</strong>
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
