'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { motion } from 'framer-motion';
import {
  AlertCircle, Wallet, Edit2, Check, Inbox, Sparkles,
  Clock, TrendingDown, TrendingUp, ShieldAlert, ArrowUpRight, DollarSign, X,
  Calendar, ChevronLeft, ChevronRight, RotateCcw,
  ShieldCheck, Utensils, Info, CheckCircle2, Sliders
} from 'lucide-react';
import { toast } from 'sonner';
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
  DEFAULT_CATEGORY_CAPS,
  generateIntelligentCategoryCaps,
  getPaydayCycleIntelligence,
  predictMonthlySavingsAndInvestments,
  fitCapsToLivingBudget,
  type IntelligentBudgetPlan,
  type IntelligentCapSuggestion,
  type MonthlySavingsPrediction,
} from '@/lib/category-budget-helper';
import { saveSettingWithCloudSync, SETTINGS_UPDATED_EVENT } from '@/lib/cloud-settings-sync';
import { useMonthList } from '@/hooks/useSheets';

export default function BudgetPage() {
  const { selectedMonth, setSelectedMonth } = useAppStore();
  const { data: sheetMonths = [] } = useMonthList();
  const { transactions = [] } = useTransactions(selectedMonth ? { period: selectedMonth } : undefined);
  const { transactions: allTransactions = [] } = useTransactions({ period: 'all' });

  // Active month in YYYY-MM format, e.g. "2026-10"
  const currentMonthStr = useMemo(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }, []);

  const currentMonthShort = useMemo(() => {
    const [y, m] = currentMonthStr.split('-').map(Number);
    if (!isNaN(y) && !isNaN(m)) {
      return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'short' });
    }
    return 'Current';
  }, [currentMonthStr]);

  // Extract all available years and months from transactions + current year/month
  const { availableYears, monthsByYear, allAvailableMonths } = useMemo(() => {
    const [curY] = currentMonthStr.split('-').map(Number);
    const curYStr = String(curY);
    const activeYears = new Set<number>([curY, curY - 1, curY + 1]);

    sheetMonths.forEach(m => {
      if (/^\d{4}-\d{2}$/.test(m)) activeYears.add(Number(m.substring(0, 4)));
    });

    transactions.forEach(t => {
      if (t.date && t.date.length >= 7 && /^\d{4}-\d{2}/.test(t.date)) {
        activeYears.add(Number(t.date.substring(0, 4)));
      }
    });

    if (selectedMonth?.startsWith('year-')) {
      const selY = Number(selectedMonth.slice(5));
      if (Number.isFinite(selY) && selY >= 2000 && selY <= 2100) activeYears.add(selY);
    } else if (selectedMonth && /^\d{4}-\d{2}$/.test(selectedMonth)) {
      const selY = Number(selectedMonth.slice(0, 4));
      if (Number.isFinite(selY) && selY >= 2000 && selY <= 2100) activeYears.add(selY);
    }

    const monthSet = new Set<string>([currentMonthStr]);
    activeYears.forEach(yr => {
      for (let m = 1; m <= 12; m++) {
        monthSet.add(`${yr}-${String(m).padStart(2, '0')}`);
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

    const sortedYears = Array.from(yearSet).sort((a, b) => {
      if (a === curYStr) return -1;
      if (b === curYStr) return 1;
      return b.localeCompare(a);
    });

    return {
      availableYears: sortedYears,
      monthsByYear: byYear,
      allAvailableMonths: sortedMonths
    };
  }, [transactions, sheetMonths, currentMonthStr, selectedMonth]);

  const handlePrevMonth = () => {
    if (selectedMonth.startsWith('year-')) {
      const y = selectedMonth.replace('year-', '');
      setSelectedMonth(`${y}-12`);
      return;
    }
    if (selectedMonth === 'all') {
      const [y, m] = currentMonthStr.split('-').map(Number);
      const prevDate = new Date(y, m - 2, 1);
      const prevStr = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;
      setSelectedMonth(prevStr);
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

  // AI Dynamic Category Caps calculation
  const intelligentPlan = useMemo(() => {
    return generateIntelligentCategoryCaps(
      allTransactions.length > 0 ? allTransactions : transactions,
      { configuredCaps: categoryCaps }
    );
  }, [allTransactions, transactions, categoryCaps]);

  // Payday Cycle & Savings Shield intelligence
  const paydayInfo = useMemo(() => {
    const curMonthTxs = (allTransactions.length > 0 ? allTransactions : transactions).filter(
      (t) => t.date && t.date.startsWith(currentMonthStr)
    );
    return getPaydayCycleIntelligence(curMonthTxs);
  }, [allTransactions, transactions, currentMonthStr]);

  // Food & Dining burn rate & daily allowance
  const foodInfo = useMemo(() => {
    const foodCap = categoryCaps['Food & Dining'] || DEFAULT_CATEGORY_CAPS['Food & Dining'] || 1200;
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    const foodTxs = monthlyExpenses.filter((t) => t.category === 'Food & Dining');
    const foodSpent = foodTxs.reduce(
      (sum, t) => sum + getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount),
      0
    );
    const remainingFood = Math.max(0, foodCap - foodSpent);
    const isOver = foodSpent > foodCap;

    const todayFoodTxs = (allTransactions.length > 0 ? allTransactions : transactions).filter(
      (t) => t.type === 'expense' && t.category === 'Food & Dining' && t.date === todayStr
    );
    const todayFoodSpent = todayFoodTxs.reduce(
      (sum, t) => sum + getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount),
      0
    );

    const daysRemaining = dailyInfo.daysRemaining;
    const safeDailyFoodAllowance = daysRemaining > 0 ? remainingFood / daysRemaining : 0;
    const percentUsed = foodCap > 0 ? (foodSpent / foodCap) * 100 : 0;
    const isTodayOverDaily = todayFoodSpent > safeDailyFoodAllowance && safeDailyFoodAllowance > 0;

    return {
      foodCap,
      foodSpent,
      remainingFood,
      isOver,
      todayFoodSpent,
      daysRemaining,
      safeDailyFoodAllowance,
      percentUsed,
      isTodayOverDaily,
    };
  }, [categoryCaps, monthlyExpenses, allTransactions, transactions, dailyInfo.daysRemaining]);

  // Real-time Month-End Savings & Investments Prediction based on daily spend
  const savingsPrediction = useMemo(() => {
    return predictMonthlySavingsAndInvestments(monthlyTransactions, {
      selectedMonth,
      baselineIncome: intelligentPlan.baselineIncome,
      savingsTargetPct: intelligentPlan.savingsTargetPct,
      investmentTargetPct: intelligentPlan.investmentTargetPct,
    });
  }, [monthlyTransactions, selectedMonth, intelligentPlan]);

  // Cap Sum strictly lower than or equal to Income - Savings
  const configuredCapsSum = useMemo(() => {
    return Object.values(categoryCaps).reduce((sum, v) => sum + (Number(v) || 0), 0);
  }, [categoryCaps]);

  const maxLivingBudget = intelligentPlan.targetLivingBudget;
  const isCapsSumExceeded = configuredCapsSum > maxLivingBudget;

  const handleAutoFitCaps = () => {
    const fitted = fitCapsToLivingBudget(categoryCaps, maxLivingBudget);
    setCategoryCaps(fitted);
    saveCategoryCaps(fitted);
    toast.success(`Caps scaled down to RM ${maxLivingBudget.toLocaleString()} to strictly protect your savings target!`);
  };

  const [isAutoTuneOpen, setIsAutoTuneOpen] = useState(false);
  const [customCapsDraft, setCustomCapsDraft] = useState<Record<string, number>>({});

  const draftSum = useMemo(() => {
    return Object.values(customCapsDraft).reduce((sum, v) => sum + (Number(v) || 0), 0);
  }, [customCapsDraft]);

  const isDraftSumExceeded = draftSum > maxLivingBudget;

  const handleAutoFitDraft = () => {
    const fitted = fitCapsToLivingBudget(customCapsDraft, maxLivingBudget);
    setCustomCapsDraft(fitted);
    toast.info(`Adjusted caps to RM ${maxLivingBudget.toLocaleString()} (Income - Savings target)`);
  };

  useEffect(() => {
    if (isAutoTuneOpen && intelligentPlan?.suggestions) {
      const draft: Record<string, number> = {};
      intelligentPlan.suggestions.forEach((s) => {
        draft[s.category] = s.suggestedCap;
      });
      setCustomCapsDraft(draft);
    }
  }, [isAutoTuneOpen, intelligentPlan]);

  const handleApplySmartCaps = () => {
    const safeCaps = fitCapsToLivingBudget(customCapsDraft, maxLivingBudget);
    setCategoryCaps(safeCaps);
    saveCategoryCaps(safeCaps);
    toast.success('AI Smart Category Caps applied and saved to cloud sync!');
    setIsAutoTuneOpen(false);
  };

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
        <div className="flex items-center justify-between gap-2 min-h-[44px]">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="p-2 rounded-xl bg-indigo-500/15 text-indigo-700 dark:text-indigo-400 border border-indigo-500/20 shrink-0">
              <Calendar className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-semibold text-slate-600 dark:text-zinc-400 uppercase tracking-wider block">Budgeting Period</span>
                {selectedMonth === currentMonthStr && (
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border border-indigo-500/25">
                    Current
                  </span>
                )}
              </div>
              <span className="text-sm sm:text-base font-bold text-slate-950 dark:text-white tracking-tight truncate block">{formatMonthLabel(selectedMonth)}</span>
            </div>
          </div>
          {selectedMonth !== currentMonthStr ? (
            <button
              type="button"
              onClick={() => setSelectedMonth(currentMonthStr)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-indigo-500/10 hover:bg-indigo-500/20 active:scale-95 text-indigo-700 dark:text-indigo-300 border border-indigo-500/25 text-xs font-semibold transition-all cursor-pointer shadow-xs shrink-0"
              title={`Jump back to current month (${formatMonthLabel(currentMonthStr)})`}
              aria-label={`Jump back to current month (${formatMonthLabel(currentMonthStr)})`}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>{currentMonthShort} (Current)</span>
            </button>
          ) : (
            <span className="text-[11px] text-slate-500 dark:text-zinc-400 hidden sm:inline">Filter monthly budget</span>
          )}
        </div>

        {/* Navigation Box: Stepper (Prev/Next) + Dropdown */}
        <div className="flex items-center gap-1.5 rounded-2xl border border-slate-200 dark:border-white/[0.08] bg-white/90 dark:bg-zinc-950/60 p-1 w-full max-w-full overflow-hidden">
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={handlePrevMonth}
              className="min-w-[40px] min-h-[40px] p-2 rounded-xl bg-white/90 dark:bg-zinc-900/80 hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-700 dark:text-zinc-300 hover:text-slate-950 dark:hover:text-white transition-colors cursor-pointer border border-slate-200 dark:border-white/[0.06] active:scale-95 flex items-center justify-center shrink-0"
              title="Previous Month"
              aria-label="Previous Month"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>

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

          <select
            value={selectedMonth}
            onChange={(e) => setSelectedMonth(e.target.value)}
            className="min-h-[40px] flex-1 min-w-0 rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white/90 dark:bg-zinc-900/90 px-3 py-1.5 text-xs font-semibold text-slate-950 dark:text-white outline-none focus:border-indigo-500 cursor-pointer transition-colors font-mono text-center truncate"
            aria-label="Select month or year"
          >
            {availableYears.map(year => {
              const curYStr = currentMonthStr.substring(0, 4);
              const yLabel =
                year === curYStr
                  ? `── ${year} (Current Year) ──`
                  : Number(year) === Number(curYStr) - 1
                  ? `── ${year} (Last Year) ──`
                  : Number(year) === Number(curYStr) + 1
                  ? `── ${year} (Next Year) ──`
                  : `── Year ${year} ──`;
              return (
                <optgroup key={year} label={yLabel} className="bg-white dark:bg-zinc-950 text-indigo-800 dark:text-indigo-400 font-bold">
                  <option value={`year-${year}`} className="bg-white dark:bg-zinc-900 text-slate-950 dark:text-white font-mono font-semibold">
                    Full Year {year} (Annual Target)
                  </option>
                  {monthsByYear[year]?.map(m => (
                    <option key={m} value={m} className="bg-white dark:bg-zinc-900 text-slate-950 dark:text-white font-mono">
                      {m === currentMonthStr ? `${formatMonthLabel(m)} (Current)` : formatMonthLabel(m)}
                    </option>
                  ))}
                </optgroup>
              );
            })}
            <option value="all" className="bg-white dark:bg-zinc-900 text-slate-950 dark:text-white font-mono">
              All Time (Accumulated)
            </option>
          </select>
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

      {/* Month-End Savings & Investment Predictor Card */}
      <motion.div
        whileHover={{ y: -2 }}
        transition={{ type: 'spring' as const, stiffness: 400, damping: 25 }}
        className="rounded-3xl border border-indigo-500/25 bg-gradient-to-br from-indigo-950/25 via-slate-50 dark:via-zinc-900/40 to-white dark:to-zinc-950 p-5 sm:p-6 backdrop-blur-xl shadow-xl specular-card space-y-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2.5 rounded-2xl bg-indigo-500/15 text-indigo-700 dark:text-indigo-400 border border-indigo-500/30">
              <TrendingUp className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-bold text-slate-950 dark:text-white uppercase tracking-wider block">
                  Month-End Savings & Investment Predictor
                </span>
                <span
                  className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider border ${
                    savingsPrediction.pacingStatus === 'ahead_of_target'
                      ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border-emerald-500/30'
                      : savingsPrediction.pacingStatus === 'on_track'
                      ? 'bg-blue-500/15 text-blue-800 dark:text-blue-300 border-blue-500/30'
                      : savingsPrediction.pacingStatus === 'risk_of_under_saving'
                      ? 'bg-amber-500/15 text-amber-800 dark:text-amber-300 border-amber-500/30'
                      : 'bg-rose-500/15 text-rose-800 dark:text-rose-300 border-rose-500/30'
                  }`}
                >
                  {savingsPrediction.pacingStatus === 'ahead_of_target'
                    ? 'Ahead of Goal'
                    : savingsPrediction.pacingStatus === 'on_track'
                    ? 'On Track'
                    : savingsPrediction.pacingStatus === 'risk_of_under_saving'
                    ? 'Under-Saving Risk'
                    : 'In Deficit'}
                </span>
              </div>
              <span className="text-[11px] text-slate-600 dark:text-zinc-400">
                Daily living burn: <strong className="font-mono text-slate-900 dark:text-white">RM {savingsPrediction.currentDailySpend.toFixed(2)}/day</strong>
                {savingsPrediction.lumpSumSpent > 0 && (
                  <span className="text-indigo-700 dark:text-indigo-300 font-medium">
                    {' '}· Lump sums: <strong className="font-mono">RM {savingsPrediction.lumpSumSpent.toFixed(2)}</strong> (absorbed flexibly)
                  </span>
                )}
                {' '}· Total: RM {savingsPrediction.spentSoFar.toFixed(2)} ({savingsPrediction.daysPassed}d passed, {savingsPrediction.daysRemaining}d left)
              </span>
            </div>
          </div>

          <div className="text-right text-xs">
            <span className="text-slate-500 dark:text-zinc-400 block text-[11px]">Monthly Baseline Income</span>
            <span className="font-mono font-bold text-slate-900 dark:text-white">
              RM {savingsPrediction.baselineIncome.toLocaleString()}
            </span>
          </div>
        </div>

        {/* 3 Metric Pillars Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {/* Pillar 1: Predicted Savings */}
          <div className="p-4 rounded-2xl bg-white/90 dark:bg-zinc-900/60 border border-slate-200 dark:border-white/[0.08] space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-slate-600 dark:text-zinc-400 uppercase text-[11px]">
                Predicted Savings
              </span>
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
                {savingsPrediction.predictedSavingsPct}% of Income
              </span>
            </div>
            <div className="text-2xl font-black font-mono text-emerald-800 dark:text-emerald-400">
              RM {savingsPrediction.predictedSavingsAmount.toLocaleString()}
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[10px] text-slate-500 dark:text-zinc-400">
                <span>Target: {savingsPrediction.savingsTargetPct}% (RM {savingsPrediction.targetSavingsAmount.toLocaleString()})</span>
                <span>{((savingsPrediction.predictedSavingsAmount / (savingsPrediction.targetSavingsAmount || 1)) * 100).toFixed(0)}%</span>
              </div>
              <div className="h-1.5 w-full bg-slate-200 dark:bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-500 rounded-full transition-all duration-500"
                  style={{ width: `${Math.min(100, (savingsPrediction.predictedSavingsAmount / (savingsPrediction.targetSavingsAmount || 1)) * 100)}%` }}
                />
              </div>
            </div>
          </div>

          {/* Pillar 2: Predicted Investments */}
          <div className="p-4 rounded-2xl bg-white/90 dark:bg-zinc-900/60 border border-slate-200 dark:border-white/[0.08] space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-slate-600 dark:text-zinc-400 uppercase text-[11px]">
                Predicted Investments
              </span>
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-indigo-500/15 text-indigo-700 dark:text-indigo-300">
                {savingsPrediction.predictedInvestmentPct}% of Income
              </span>
            </div>
            <div className="text-2xl font-black font-mono text-indigo-800 dark:text-indigo-400">
              RM {savingsPrediction.predictedInvestmentAmount.toLocaleString()}
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[10px] text-slate-500 dark:text-zinc-400">
                <span>Target: {savingsPrediction.investmentTargetPct}% (RM {savingsPrediction.targetInvestmentAmount.toLocaleString()})</span>
                <span>{((savingsPrediction.predictedInvestmentAmount / (savingsPrediction.targetInvestmentAmount || 1)) * 100).toFixed(0)}%</span>
              </div>
              <div className="h-1.5 w-full bg-slate-200 dark:bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-indigo-500 rounded-full transition-all duration-500"
                  style={{ width: `${Math.min(100, (savingsPrediction.predictedInvestmentAmount / (savingsPrediction.targetInvestmentAmount || 1)) * 100)}%` }}
                />
              </div>
            </div>
          </div>

          {/* Pillar 3: Projected Living Spend */}
          <div className="p-4 rounded-2xl bg-white/90 dark:bg-zinc-900/60 border border-slate-200 dark:border-white/[0.08] space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-slate-600 dark:text-zinc-400 uppercase text-[11px]">
                Projected Living Spend
              </span>
              <span className="text-[10px] font-mono text-slate-500 dark:text-zinc-400">
                Limit: RM {savingsPrediction.targetLivingBudget.toLocaleString()}
              </span>
            </div>
            <div className={`text-2xl font-black font-mono ${
              savingsPrediction.projectedTotalSpend > savingsPrediction.targetLivingBudget
                ? 'text-rose-800 dark:text-rose-400'
                : 'text-slate-900 dark:text-white'
            }`}>
              RM {savingsPrediction.projectedTotalSpend.toLocaleString()}
            </div>
            <div className="text-[10px] text-slate-500 dark:text-zinc-400">
              Living Budget: Income RM {savingsPrediction.baselineIncome.toLocaleString()} - Target Savings RM {(savingsPrediction.targetSavingsAmount + savingsPrediction.targetInvestmentAmount).toLocaleString()}
            </div>
            <div className="text-[10px] font-mono text-slate-600 dark:text-zinc-300">
              Safe Daily Pace: <strong className="text-emerald-700 dark:text-emerald-400">RM {savingsPrediction.safeDailyLivingAllowance.toFixed(2)}/day</strong> ({savingsPrediction.daysRemaining}d left)
            </div>
            {savingsPrediction.lumpSumSpent > 0 && (
              <div className="text-[10px] text-indigo-700 dark:text-indigo-300">
                ✨ RM {savingsPrediction.lumpSumSpent.toFixed(2)} lump sum absorbed into month without distorting daily living pace.
              </div>
            )}
          </div>
        </div>

        {/* Actionable Prediction Insight Banner */}
        <div className="p-3.5 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 text-xs text-indigo-950 dark:text-indigo-200 flex items-start gap-2.5 leading-relaxed">
          <Sparkles className="h-4 w-4 text-indigo-600 dark:text-indigo-400 shrink-0 mt-0.5" />
          <span>{savingsPrediction.insightMessage}</span>
        </div>
      </motion.div>

      {/* Payday Cycle & Savings Shield Card */}
      <motion.div
        whileHover={{ y: -2 }}
        transition={{ type: 'spring' as const, stiffness: 400, damping: 25 }}
        className="rounded-3xl border border-indigo-500/25 bg-gradient-to-br from-indigo-950/20 via-slate-50 dark:via-zinc-900/40 to-white dark:to-zinc-950 p-5 sm:p-6 backdrop-blur-xl shadow-xl specular-card space-y-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2.5 rounded-2xl bg-indigo-500/15 text-indigo-700 dark:text-indigo-400 border border-indigo-500/30">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-slate-950 dark:text-white uppercase tracking-wider block">
                  Payday Cycle & Savings Shield
                </span>
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${
                  paydayInfo.cyclePhase === 'living_phase'
                    ? 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border border-indigo-500/30'
                    : 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border border-emerald-500/30'
                }`}>
                  {paydayInfo.cyclePhase === 'living_phase' ? 'Living Phase' : 'Payday Settlement'}
                </span>
              </div>
              <span className="text-[11px] text-slate-600 dark:text-zinc-400">
                {paydayInfo.headline}
              </span>
            </div>
          </div>

          <div className="text-right text-xs">
            <span className="text-slate-500 dark:text-zinc-400 block text-[11px]">Salary Cycle Anchor</span>
            <span className="font-mono font-bold text-slate-900 dark:text-white">
              {paydayInfo.paydayDay}th of month (Last Week)
            </span>
          </div>
        </div>

        {/* 2 Envelopes Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
          {/* Envelope 1: Pre-quarantined Savings Target */}
          <div className="p-4 rounded-2xl bg-white/90 dark:bg-zinc-900/60 border border-indigo-500/20 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-indigo-900 dark:text-indigo-300 flex items-center gap-1.5">
                <ShieldAlert className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" />
                Pre-Quarantined Savings Target
              </span>
              <span className="font-mono font-bold text-slate-900 dark:text-white">
                RM {paydayInfo.preQuarantinedSavings.toLocaleString()}
              </span>
            </div>
            <p className="text-[11px] text-slate-600 dark:text-zinc-400 leading-relaxed">
              Shielded from Day 1 ({paydayInfo.savingsTargetPct + paydayInfo.investmentTargetPct}% of RM {paydayInfo.baselineIncome.toLocaleString()} income). You will never suffer an artificial early surplus or end-of-month budget cliff.
            </p>
            <div className="space-y-1 pt-1">
              <div className="flex items-center justify-between text-[10px] text-slate-500 dark:text-zinc-400">
                <span>Transfers fulfilled this month:</span>
                <span className="font-mono font-bold text-slate-900 dark:text-white">
                  RM {paydayInfo.actualSavedThisMonth.toLocaleString()} ({paydayInfo.savingsProgressPct}%)
                </span>
              </div>
              <div className="h-1.5 w-full bg-slate-200 dark:bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-indigo-500 rounded-full transition-all duration-500"
                  style={{ width: `${paydayInfo.savingsProgressPct}%` }}
                />
              </div>
            </div>
          </div>

          {/* Envelope 2: Protected Living Allowance */}
          <div className="p-4 rounded-2xl bg-white/90 dark:bg-zinc-900/60 border border-emerald-500/20 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-emerald-900 dark:text-emerald-300 flex items-center gap-1.5">
                <Wallet className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                Protected Living Budget
              </span>
              <span className="font-mono font-bold text-slate-900 dark:text-white">
                RM {paydayInfo.targetLivingBudget.toLocaleString()} / mo
              </span>
            </div>
            <p className="text-[11px] text-slate-600 dark:text-zinc-400 leading-relaxed">
              Steady living allowance regardless of salary bank-in date:
            </p>
            <div className="flex items-baseline gap-2 pt-0.5">
              <span className="text-2xl font-black font-mono text-emerald-800 dark:text-emerald-400">
                RM {paydayInfo.dailyLivingAllowance.toFixed(2)}
              </span>
              <span className="text-xs text-slate-500 dark:text-zinc-400 font-mono">
                / day ({paydayInfo.daysRemainingInMonth} days left in cycle)
              </span>
            </div>
          </div>
        </div>

        {/* Intelligence Detail Banner */}
        <div className="p-3 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-xs text-indigo-950 dark:text-indigo-200 flex items-start gap-2 leading-relaxed">
          <Info className="h-4 w-4 text-indigo-600 dark:text-indigo-400 shrink-0 mt-0.5" />
          <span>{paydayInfo.detail}</span>
        </div>
      </motion.div>

      {/* Food & Dining Daily Pace Spotlight Card */}
      <motion.div
        whileHover={{ y: -2 }}
        transition={{ type: 'spring' as const, stiffness: 400, damping: 25 }}
        className="rounded-3xl border border-amber-500/25 bg-gradient-to-br from-amber-950/20 via-slate-50 dark:via-zinc-900/40 to-white dark:to-zinc-950 p-5 sm:p-6 backdrop-blur-xl shadow-xl specular-card space-y-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2.5 rounded-2xl bg-amber-500/15 text-amber-800 dark:text-amber-400 border border-amber-500/30">
              <Utensils className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-slate-950 dark:text-white uppercase tracking-wider block">
                  Food & Dining Burn Rate & Daily Pace
                </span>
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${
                  foodInfo.isOver
                    ? 'bg-rose-500/15 text-rose-800 dark:text-rose-400 border border-rose-500/30'
                    : foodInfo.percentUsed > 80
                    ? 'bg-amber-500/15 text-amber-800 dark:text-amber-400 border border-amber-500/30'
                    : 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-400 border border-emerald-500/30'
                }`}>
                  {foodInfo.isOver ? 'Over Cap' : foodInfo.percentUsed > 80 ? 'Approaching Cap' : 'On Track'}
                </span>
              </div>
              <span className="text-[11px] text-slate-600 dark:text-zinc-400">
                Pacing control for your most frequent variable daily expense
              </span>
            </div>
          </div>

          <div className="text-right text-xs">
            <span className="text-slate-500 dark:text-zinc-400 block text-[11px]">Category Cap</span>
            <span className="font-mono font-bold text-slate-900 dark:text-white">
              RM {foodInfo.foodCap.toFixed(0)} / mo
            </span>
          </div>
        </div>

        {/* 3 Metrics Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="p-3.5 rounded-2xl bg-white/90 dark:bg-zinc-900/60 border border-slate-200 dark:border-white/[0.08] space-y-1">
            <span className="text-[11px] font-semibold text-slate-500 dark:text-zinc-400 block uppercase">
              Remaining Food Budget
            </span>
            <div className="text-xl font-black font-mono text-slate-900 dark:text-white">
              RM {foodInfo.remainingFood.toFixed(2)}
            </div>
            <span className="text-[10px] text-slate-500 dark:text-zinc-400 block">
              RM {foodInfo.foodSpent.toFixed(2)} used ({foodInfo.percentUsed.toFixed(0)}%)
            </span>
          </div>

          <div className="p-3.5 rounded-2xl bg-white/90 dark:bg-zinc-900/60 border border-slate-200 dark:border-white/[0.08] space-y-1">
            <span className="text-[11px] font-semibold text-slate-500 dark:text-zinc-400 block uppercase">
              Safe Daily Food Pace
            </span>
            <div className="text-xl font-black font-mono text-emerald-800 dark:text-emerald-400">
              RM {foodInfo.safeDailyFoodAllowance.toFixed(2)}
              <span className="text-xs font-normal text-slate-500 dark:text-zinc-400 ml-1">/ day</span>
            </div>
            <span className="text-[10px] text-slate-500 dark:text-zinc-400 block">
              {foodInfo.daysRemaining} days remaining in month
            </span>
          </div>

          <div className="p-3.5 rounded-2xl bg-white/90 dark:bg-zinc-900/60 border border-slate-200 dark:border-white/[0.08] space-y-1">
            <span className="text-[11px] font-semibold text-slate-500 dark:text-zinc-400 block uppercase">
              Today's Food Spent
            </span>
            <div className={`text-xl font-black font-mono ${
              foodInfo.isTodayOverDaily ? 'text-amber-800 dark:text-amber-400' : 'text-slate-900 dark:text-white'
            }`}>
              RM {foodInfo.todayFoodSpent.toFixed(2)}
            </div>
            <span className="text-[10px] text-slate-500 dark:text-zinc-400 block">
              {foodInfo.isTodayOverDaily
                ? `Exceeds daily pace by RM ${(foodInfo.todayFoodSpent - foodInfo.safeDailyFoodAllowance).toFixed(2)}`
                : 'Within safe daily pace'}
            </span>
          </div>
        </div>

        {/* Food Progress Bar */}
        <div className="space-y-1.5">
          <div className="h-2 w-full bg-slate-200 dark:bg-zinc-800 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                foodInfo.isOver
                  ? 'bg-rose-500'
                  : foodInfo.percentUsed > 80
                  ? 'bg-amber-400'
                  : 'bg-emerald-500'
              }`}
              style={{ width: `${Math.min(100, foodInfo.percentUsed)}%` }}
            />
          </div>
        </div>
      </motion.div>

      {/* Active Installment & Debt Commitment Dashboard */}
      <InstallmentDashboard />

      {/* Monthly Recurring Commitments */}
      <RecurringCommitments />

      {/* Category Breakdown & Spending Caps */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-xs uppercase font-semibold text-slate-600 dark:text-zinc-400 tracking-wider">
                Category Spending Caps & Daily Allowances
              </h3>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                isCapsSumExceeded
                  ? 'bg-rose-500/15 text-rose-800 dark:text-rose-300 border-rose-500/30'
                  : 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border-emerald-500/30'
              }`}>
                Cap Sum: RM {configuredCapsSum.toLocaleString()} / Max Living: RM {maxLivingBudget.toLocaleString()}
              </span>
            </div>
            <span className="text-[11px] text-slate-500 dark:text-zinc-400 block mt-0.5">
              Strict constraint: Cap sum must be lower than or equal to Income (RM {intelligentPlan.baselineIncome.toLocaleString()}) - Savings (RM {intelligentPlan.targetSavingsAmount.toLocaleString()})
            </span>
          </div>
          <div className="flex items-center gap-2">
            {isCapsSumExceeded && (
              <button
                type="button"
                onClick={handleAutoFitCaps}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs shadow-sm cursor-pointer transition-all active:scale-95"
              >
                <span>Auto-Fit Caps to RM {maxLivingBudget.toLocaleString()}</span>
              </button>
            )}
            <motion.button
              whileHover={{ scale: 1.04 }}
              whileTap={{ scale: 0.96 }}
              type="button"
              onClick={() => setIsAutoTuneOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white font-semibold text-xs shadow-md shadow-indigo-500/20 cursor-pointer"
            >
              <Sparkles className="h-3.5 w-3.5" />
              <span>AI Auto-Tune Caps</span>
            </motion.button>
          </div>
        </div>

        {/* Warning banner when cap sum exceeds living budget */}
        {isCapsSumExceeded && (
          <div className="p-3.5 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-950 dark:text-rose-200 flex flex-wrap items-center justify-between gap-2.5">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-rose-600 dark:text-rose-400 shrink-0" />
              <span>
                <strong>Cap Sum Alert:</strong> Total category caps (<strong>RM {configuredCapsSum.toLocaleString()}</strong>) exceed your Living Budget (<strong>RM {maxLivingBudget.toLocaleString()}</strong> = Income RM {intelligentPlan.baselineIncome.toLocaleString()} - Savings RM {intelligentPlan.targetSavingsAmount.toLocaleString()}). To preserve your {intelligentPlan.savingsTargetPct + intelligentPlan.investmentTargetPct}% savings target, reduce caps by RM {(configuredCapsSum - maxLivingBudget).toLocaleString()}.
              </span>
            </div>
            <button
              type="button"
              onClick={handleAutoFitCaps}
              className="px-3 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs shadow-sm cursor-pointer transition-all active:scale-95 shrink-0"
            >
              Auto-Fit Caps
            </button>
          </div>
        )}

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
            const suggestion = intelligentPlan?.suggestions?.find((s) => s.category === item.name);

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
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-slate-950 dark:text-white text-sm">{item.name}</span>
                    {suggestion && (
                      <span className={`text-[9px] font-semibold px-2 py-0.5 rounded-full border ${
                        suggestion.nature === 'fixed'
                          ? 'bg-purple-500/10 text-purple-700 dark:text-purple-300 border-purple-500/25'
                          : suggestion.nature === 'quasi-fixed'
                          ? 'bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/25'
                          : suggestion.nature === 'trend'
                          ? 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-300 border-cyan-500/25'
                          : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/25'
                      }`}>
                        {suggestion.natureLabel}
                      </span>
                    )}
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

                {/* Food & Dining Extra Burn Rate Row */}
                {item.name === 'Food & Dining' && dailyInfo.isCurrentMonth && (
                  <div className="text-[11px] text-amber-900 dark:text-amber-200 bg-amber-500/10 border border-amber-500/20 rounded-xl px-2.5 py-1.5 flex flex-wrap items-center justify-between gap-1">
                    <span className="flex items-center gap-1.5 font-medium">
                      <Utensils className="h-3 w-3" />
                      Today's Food Spent: <strong className="font-mono">RM {foodInfo.todayFoodSpent.toFixed(2)}</strong>
                    </span>
                    <span>
                      Safe Daily Food Allowance: <strong className="font-mono">RM {foodInfo.safeDailyFoodAllowance.toFixed(2)} / day</strong>
                    </span>
                  </div>
                )}

                {/* Daily Safe Limit only for Food & Dining; Capped Monthly Bucket for all others */}
                <div className="flex items-center justify-between text-[11px] text-slate-600 dark:text-zinc-400 pt-0.5">
                  <span>
                    {isCatOver ? (
                      <span className="text-rose-800 dark:text-rose-400 font-semibold">Over cap by RM {(item.value - cap).toFixed(2)}</span>
                    ) : (
                      <span>Remaining: <strong className="text-slate-800 dark:text-zinc-200 font-mono">RM {remainingCat.toFixed(2)}</strong></span>
                    )}
                  </span>
                  {item.name === 'Food & Dining' ? (
                    <span className="font-mono text-slate-700 dark:text-zinc-300">
                      Daily pace: <strong className={isCatOver ? 'text-rose-800 dark:text-rose-400' : 'text-emerald-800 dark:text-emerald-400'}>RM {dailyCat.toFixed(2)} / day</strong>
                    </span>
                  ) : (
                    <span className="text-[10px] text-slate-500 dark:text-zinc-400 font-medium">
                      Monthly Capped Bucket (spend once, use whole month)
                    </span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* AI Auto-Tune Caps Modal */}
      {isAutoTuneOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-3xl border border-slate-200 dark:border-white/[0.1] bg-white dark:bg-zinc-900 p-6 shadow-2xl space-y-5"
          >
            {/* Header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="p-2.5 rounded-2xl bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 border border-indigo-500/25">
                  <Sparkles className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-900 dark:text-white">
                    AI Intelligent Category Caps
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-zinc-400">
                    Dynamically derived from your spending history & target savings
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsAutoTuneOpen(false)}
                className="p-2 rounded-xl text-slate-400 hover:text-slate-600 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Income & Savings Shield Math Summary */}
            <div className="p-4 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 space-y-2 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2 font-semibold">
                <span className="text-indigo-900 dark:text-indigo-300">
                  Income Allocation Shield:
                </span>
                <span className="font-mono text-slate-900 dark:text-white">
                  RM {intelligentPlan.baselineIncome.toLocaleString()} Income - RM {intelligentPlan.targetSavingsAmount.toLocaleString()} Savings ({intelligentPlan.savingsTargetPct + intelligentPlan.investmentTargetPct}%) = <strong className="text-emerald-700 dark:text-emerald-300">RM {intelligentPlan.targetLivingBudget.toLocaleString()} Living Pool</strong>
                </span>
              </div>
              <p className="text-[11px] text-slate-600 dark:text-zinc-400 leading-relaxed">
                {intelligentPlan.summaryInsight}
              </p>
            </div>

            {/* Suggestions list */}
            <div className="space-y-3">
              <div className="text-xs font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-wider flex items-center justify-between">
                <span>Category Breakdown & AI Reasoning</span>
                <span>Editable Suggested Cap (RM)</span>
              </div>

              <div className="space-y-2 max-h-[48vh] overflow-y-auto pr-1">
                {intelligentPlan.suggestions.map((s) => {
                  const currentVal = customCapsDraft[s.category] ?? s.suggestedCap;
                  const natureBadgeClass =
                    s.nature === 'fixed'
                      ? 'bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/25'
                      : s.nature === 'quasi-fixed'
                      ? 'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/25'
                      : s.nature === 'trend'
                      ? 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border-cyan-500/25'
                      : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/25';

                  return (
                    <div
                      key={s.category}
                      className="p-3 rounded-2xl border border-slate-200 dark:border-white/[0.06] bg-slate-50/70 dark:bg-zinc-800/40 flex flex-wrap items-center justify-between gap-3 text-xs"
                    >
                      <div className="space-y-1 min-w-[200px] flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-slate-900 dark:text-white text-sm">
                            {s.category}
                          </span>
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${natureBadgeClass}`}>
                            {s.natureLabel}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-500 dark:text-zinc-400 leading-tight">
                          {s.reasoning}
                        </p>
                        {s.historicalAvg > 0 && (
                          <span className="text-[10px] text-slate-400 dark:text-zinc-500 block">
                            Historical monthly avg: RM {s.historicalAvg.toFixed(2)}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="font-mono text-xs text-slate-500 dark:text-zinc-400">RM</span>
                        <input
                          type="number"
                          value={currentVal}
                          onChange={(e) => {
                            const val = parseFloat(e.target.value) || 0;
                            setCustomCapsDraft((prev) => ({ ...prev, [s.category]: val }));
                          }}
                          className="w-24 rounded-xl border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-2.5 py-1.5 text-xs text-slate-900 dark:text-white font-mono text-right font-bold outline-none focus:border-indigo-500"
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Total check & Action buttons */}
            <div className="pt-3 border-t border-slate-200 dark:border-zinc-800 flex flex-wrap items-center justify-between gap-3">
              <div className="text-xs">
                <span className="text-slate-500 dark:text-zinc-400 block">Total Configured Caps:</span>
                <div className="flex items-center gap-2">
                  <span className={`font-mono font-bold text-sm ${isDraftSumExceeded ? 'text-rose-600 dark:text-rose-400' : 'text-slate-900 dark:text-white'}`}>
                    RM {draftSum.toLocaleString()}
                  </span>
                  <span className="text-[11px] text-slate-500 dark:text-zinc-400">
                    / Living limit: RM {maxLivingBudget.toLocaleString()} (Income - Savings)
                  </span>
                </div>
                {isDraftSumExceeded ? (
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-[11px] text-rose-600 dark:text-rose-400 font-semibold">
                      ⚠️ Exceeds limit by RM {(draftSum - maxLivingBudget).toLocaleString()}
                    </span>
                    <button
                      type="button"
                      onClick={handleAutoFitDraft}
                      className="px-2 py-0.5 rounded-lg bg-rose-500/15 text-rose-700 dark:text-rose-300 border border-rose-500/30 text-[10px] font-bold hover:bg-rose-500/25 transition-all cursor-pointer"
                    >
                      Auto-Fit to RM {maxLivingBudget.toLocaleString()}
                    </button>
                  </div>
                ) : (
                  <span className="text-[10px] text-emerald-600 dark:text-emerald-400 block mt-0.5">
                    ✨ Strictly within your RM {maxLivingBudget.toLocaleString()} living pool. Full savings protected!
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsAutoTuneOpen(false)}
                  className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleApplySmartCaps}
                  className="px-5 py-2 rounded-xl bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white font-bold text-xs shadow-lg shadow-indigo-500/25 cursor-pointer active:scale-95 transition-all flex items-center gap-1.5"
                >
                  <Check className="h-4 w-4" />
                  <span>Apply All AI Smart Caps</span>
                </button>
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
}
