'use client';

import React, { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import {
  AlertCircle, Wallet, Edit2, Check, Inbox, Sparkles,
  Clock, TrendingDown, TrendingUp, ShieldAlert, ArrowUpRight, DollarSign, X,
  RotateCcw,
  ShieldCheck, Utensils, Info, CheckCircle2, Sliders, Lock, Unlock
} from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { addUnifiedRow, applyOptimisticAddToQueryCache } from '@/hooks/useSheets';
import { useTransactions } from '@/hooks/useTransactions';
import { AnimatedNumber } from '@/components/shared/animated-number';
import { CockpitPageHeading } from '@/components/money-cockpit/cockpit-page-heading';
import { PeriodBar } from '@/components/shared/period-bar';
import { getAmountInBaseCurrency } from '@/lib/currency';
import { buildPeriodCatalog, formatPeriodDisplay } from '@/lib/period-helper';
import { useAppStore } from '@/stores/app-store';
import { RecurringCommitments } from '@/components/dashboard/recurring-commitments';
import { InstallmentDashboard } from '@/components/dashboard/installment-dashboard';
import {
  getSavedCategoryCaps,
  getLockedCategoryCaps,
  saveLockedCategoryCaps,
  getAllBudgetCategoryRows,
  type BudgetCategoryRowItem,
  getTripEnvelopeSummaries,
  type TripBudgetEnvelope,
  type TripEnvelopeStatus,
  saveCategoryCaps,
  calculateDailySafeSpend,
  getMonthDaysInfo,
  isTripQuarantinedExpense,
  countActiveBudgetMonths,
  resolveCategoryCapValue,
  DEFAULT_CATEGORY_CAPS,
  generateIntelligentCategoryCaps,
  getPaydayCycleIntelligence,
  predictMonthlySavingsAndInvestments,
  fitCapsToLivingBudget,
  getCategoryRealtimeBudgetStatus,
  applySmartCategoryRebalance,
  rebalanceCategoryCapsForSpending,
  getUnifiedIncomeAllocation,
  saveUnifiedIncomeAllocation,
  type IntelligentBudgetPlan,
  type IntelligentCapSuggestion,
  type MonthlySavingsPrediction,
  type CategoryRebalanceSuggestion,
} from '@/lib/category-budget-helper';
import { CANONICAL_EXPENSE_CATEGORIES, normalizeToCanonicalCategory } from '@/lib/canonical-categories';
import { LAYOUT_TOKENS } from '@/lib/design-tokens';
import { saveSettingWithCloudSync, SETTINGS_UPDATED_EVENT } from '@/lib/cloud-settings-sync';
import { useMonthList } from '@/hooks/useSheets';

export default function BudgetPage() {
  const queryClient = useQueryClient();
  const { selectedMonth, setSelectedMonth } = useAppStore();
  const { data: sheetMonths = [] } = useMonthList();
  const { transactions = [] } = useTransactions(selectedMonth ? { period: selectedMonth } : undefined);
  const { transactions: allTransactions = [] } = useTransactions({ period: 'all' });

  const { currentMonth: currentMonthStr, months: allAvailableMonths } = useMemo(
    () => buildPeriodCatalog(sheetMonths, selectedMonth, transactions),
    [sheetMonths, selectedMonth, transactions]
  );

  const formatMonthLabel = (mStr: string) => formatPeriodDisplay(mStr);

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
    return monthlyTransactions.filter(t => String(t.type || '').toLowerCase() === 'expense');
  }, [monthlyTransactions]);

  const monthlyLivingExpenses = useMemo(() => {
    return monthlyExpenses.filter(t => !isTripQuarantinedExpense(t));
  }, [monthlyExpenses]);

  const tripQuarantinedSpent = useMemo(() => {
    return monthlyExpenses
      .filter(t => isTripQuarantinedExpense(t))
      .reduce((sum, t) => sum + getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount), 0);
  }, [monthlyExpenses]);

  const totalSpent = useMemo(() => {
    return monthlyLivingExpenses.reduce((sum, t) => sum + getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount), 0);
  }, [monthlyLivingExpenses]);

  // Scoped canonical category breakdown for selected month (excluding quarantined trip expenses)
  const breakdown = useMemo(() => {
    const catMap: Record<string, number> = {};
    monthlyLivingExpenses.forEach(t => {
      const cat = normalizeToCanonicalCategory(t.category || 'Other', 'Expense', t.description);
      catMap[cat] = (catMap[cat] || 0) + getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount);
    });
    return Object.entries(catMap)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  }, [monthlyLivingExpenses]);

  const [monthlyBudget, setMonthlyBudget] = useState(3000);
  const [isEditingBudget, setIsEditingBudget] = useState(false);
  const [budgetValue, setBudgetValue] = useState('3000');

  // Category specific caps
  const [categoryCaps, setCategoryCaps] = useState<Record<string, number>>(DEFAULT_CATEGORY_CAPS);
  const [editingCategory, setEditingCategory] = useState<string | null>(null);
  const [categoryCapInput, setCategoryCapInput] = useState('');

  // Locked category caps
  const [lockedCategories, setLockedCategories] = useState<Record<string, boolean>>({});

  // Canonical and custom category rows for selected month (CRITICAL FIX A: never hides unspent categories!)
  const budgetCategoryRows = useMemo(() => {
    const txs = allTransactions.length > 0 ? allTransactions : transactions;
    return getAllBudgetCategoryRows(txs, {
      caps: categoryCaps,
      lockedCaps: lockedCategories,
      targetMonth: selectedMonth,
    });
  }, [allTransactions, transactions, categoryCaps, lockedCategories, selectedMonth]);

  const toggleLockCategory = (categoryName: string) => {
    setLockedCategories((prev) => {
      const canonical = normalizeToCanonicalCategory(categoryName, 'Expense');
      const next = { ...prev, [canonical]: !prev[canonical] };
      saveLockedCategoryCaps(next);
      toast.info(next[canonical] ? `Locked cap for ${canonical}` : `Unlocked cap for ${canonical}`);
      return next;
    });
  };

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
      setLockedCategories(getLockedCategoryCaps());
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
      const canonical = normalizeToCanonicalCategory(categoryName, 'Expense');
      const updated = { ...categoryCaps, [canonical]: parsed };
      setCategoryCaps(updated);
      saveCategoryCaps(updated);
    }
    setEditingCategory(null);
    setCategoryCapInput('');
  };

  const fullLedgerTransactions = useMemo(
    () => (allTransactions.length > 0 ? allTransactions : transactions),
    [allTransactions, transactions]
  );

  const isYearMode = selectedMonth.startsWith('year-');
  const isAllTimeMode = selectedMonth === 'all';
  const allTimeActiveMonths = useMemo(
    () => countActiveBudgetMonths(fullLedgerTransactions),
    [fullLedgerTransactions]
  );
  const effectiveBudget = isYearMode
    ? monthlyBudget * 12
    : isAllTimeMode
    ? monthlyBudget * allTimeActiveMonths
    : monthlyBudget;
  const progressPercent = effectiveBudget > 0 ? Math.min((totalSpent / effectiveBudget) * 100, 100) : 0;
  const circumference = 2 * Math.PI * 45; // ~282.7
  const strokeDashoffset = circumference - (circumference * progressPercent) / 100;
  const isOverBudget = totalSpent > effectiveBudget;

  // AI Dynamic Category Caps calculation
  const intelligentPlan = useMemo(() => {
    return generateIntelligentCategoryCaps(
      fullLedgerTransactions,
      { configuredCaps: categoryCaps, lockedCaps: lockedCategories }
    );
  }, [fullLedgerTransactions, categoryCaps, lockedCategories]);

  // Real-time Month-End Savings & Investments Prediction based on daily spend
  const savingsPrediction = useMemo(() => {
    return predictMonthlySavingsAndInvestments(fullLedgerTransactions, {
      selectedMonth: isYearMode || isAllTimeMode ? currentMonthStr : selectedMonth,
      baselineIncome: intelligentPlan.baselineIncome,
      savingsTargetPct: intelligentPlan.savingsTargetPct,
      investmentTargetPct: intelligentPlan.investmentTargetPct,
    });
  }, [fullLedgerTransactions, selectedMonth, isYearMode, isAllTimeMode, currentMonthStr, intelligentPlan]);

  const heroDaysInfo = useMemo(
    () => (isAllTimeMode ? null : getMonthDaysInfo(selectedMonth)),
    [isAllTimeMode, selectedMonth]
  );

  const heroUnpaidReserve =
    isAllTimeMode || isYearMode || heroDaysInfo?.isPastMonth
      ? 0
      : savingsPrediction?.unpaidCommittedReserve || 0;

  // Daily Safe-to-Spend calculations scoped to selected month
  const dailyInfo = useMemo(() => {
    if (isAllTimeMode) {
      return {
        totalBudget: effectiveBudget,
        totalSpent,
        remainingBudget: Math.max(0, effectiveBudget - totalSpent),
        safeRemainingBudget: Math.max(0, effectiveBudget - totalSpent),
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
    return {
      ...calculateDailySafeSpend(effectiveBudget, totalSpent, selectedMonth, undefined, {
        unpaidReserve: heroUnpaidReserve,
      }),
      isAllTime: false,
    };
  }, [isAllTimeMode, effectiveBudget, totalSpent, selectedMonth, isOverBudget, heroUnpaidReserve]);

  // Trip Budget Envelopes (Pillar 2.1)
  const tripSummaries = useMemo(() => {
    return getTripEnvelopeSummaries(fullLedgerTransactions);
  }, [fullLedgerTransactions]);

  // Payday Cycle & Savings Shield intelligence
  const paydayInfo = useMemo(() => {
    const curMonthTxs = fullLedgerTransactions.filter(
      (t) => t.date && t.date.startsWith(currentMonthStr)
    );
    return getPaydayCycleIntelligence(curMonthTxs);
  }, [fullLedgerTransactions, currentMonthStr]);

  // Food & Dining burn rate & daily allowance (aligned with Food & Dining category row)
  const foodInfo = useMemo(() => {
    const foodRow = budgetCategoryRows.find((r) => r.category === 'Food & Dining');
    const foodCap = foodRow ? foodRow.cap : resolveCategoryCapValue('Food & Dining', categoryCaps, DEFAULT_CATEGORY_CAPS['Food & Dining'] || 1200);
    const foodSpent = foodRow
      ? foodRow.spent
      : monthlyLivingExpenses
          .filter((t) => normalizeToCanonicalCategory(t.category || 'Other', 'Expense', t.description) === 'Food & Dining')
          .reduce((sum, t) => sum + getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount), 0);
    const foodReserve = foodRow ? foodRow.unpaidBillReserve : 0;
    const remainingFood = foodRow
      ? Math.max(0, foodRow.unreservedRemaining)
      : Math.max(0, foodCap - foodSpent - foodReserve);
    const isOver = foodRow ? foodRow.isOverCap : foodSpent + foodReserve > foodCap;

    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const todayFoodTxs = fullLedgerTransactions.filter(
      (t) =>
        String(t.type || '').toLowerCase() === 'expense' &&
        t.date === todayStr &&
        !isTripQuarantinedExpense(t) &&
        normalizeToCanonicalCategory(t.category || 'Other', 'Expense', t.description) === 'Food & Dining'
    );
    const todayFoodSpent = todayFoodTxs.reduce(
      (sum, t) => sum + getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount),
      0
    );

    const daysRemaining = dailyInfo.daysRemaining;
    const safeDailyFoodAllowance = foodRow ? foodRow.dailyAllowance : daysRemaining > 0 ? remainingFood / daysRemaining : 0;
    const percentUsed = foodRow ? foodRow.spentPercent : foodCap > 0 ? (foodSpent / foodCap) * 100 : 0;
    const isTodayOverDaily = todayFoodSpent > safeDailyFoodAllowance && safeDailyFoodAllowance > 0;

    return {
      foodCap,
      foodSpent,
      foodReserve,
      remainingFood,
      isOver,
      todayFoodSpent,
      daysRemaining,
      safeDailyFoodAllowance,
      percentUsed,
      isTodayOverDaily,
    };
  }, [budgetCategoryRows, categoryCaps, monthlyLivingExpenses, fullLedgerTransactions, dailyInfo.daysRemaining]);

  // Cap Sum strictly lower than or equal to Income - Savings (over canonical expense categories only)
  const configuredCapsSum = useMemo(() => {
    return CANONICAL_EXPENSE_CATEGORIES.reduce(
      (sum, cat) => sum + resolveCategoryCapValue(cat, categoryCaps, 0),
      0
    );
  }, [categoryCaps]);

  const maxLivingBudget = intelligentPlan.targetLivingBudget;
  const isCapsSumExceeded = configuredCapsSum > maxLivingBudget;

  const handleAutoFitCaps = () => {
    const fitted = fitCapsToLivingBudget(categoryCaps, maxLivingBudget, lockedCategories, fullLedgerTransactions);
    setCategoryCaps(fitted);
    saveCategoryCaps(fitted);
    toast.success(`Caps scaled down to RM ${maxLivingBudget.toLocaleString()} to strictly protect your savings target!`);
  };

  // Cross-category smart rebalance suggestion if any category exceeds cap or touches reserved bills
  const topRebalanceSuggestion = useMemo<CategoryRebalanceSuggestion | null>(() => {
    for (const row of budgetCategoryRows) {
      if (row.isOverCap || row.unreservedRemaining < 0) {
        const status = getCategoryRealtimeBudgetStatus(row.category, fullLedgerTransactions, categoryCaps, 0, {
          targetMonth: selectedMonth,
          lockedCaps: lockedCategories,
          maxLivingBudget,
        });
        if (status.rebalanceSuggestion?.canAutoRebalance) {
          return status.rebalanceSuggestion;
        }
      }
    }
    return null;
  }, [budgetCategoryRows, fullLedgerTransactions, categoryCaps, selectedMonth, lockedCategories, maxLivingBudget]);

  const [isAutoTuneOpen, setIsAutoTuneOpen] = useState(false);
  const [customCapsDraft, setCustomCapsDraft] = useState<Record<string, number>>({});

  const draftSum = useMemo(() => {
    return Object.values(customCapsDraft).reduce((sum, v) => sum + (Number(v) || 0), 0);
  }, [customCapsDraft]);

  const isDraftSumExceeded = draftSum > maxLivingBudget;

  const handleAutoFitDraft = () => {
    const fitted = fitCapsToLivingBudget(customCapsDraft, maxLivingBudget, lockedCategories, fullLedgerTransactions);
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
    const txs = allTransactions.length > 0 ? allTransactions : transactions;
    const safeCaps = fitCapsToLivingBudget(customCapsDraft, maxLivingBudget, lockedCategories, txs);
    setCategoryCaps(safeCaps);
    saveCategoryCaps(safeCaps);
    toast.success('AI Smart Category Caps applied and saved to cloud sync!');
    setIsAutoTuneOpen(false);
  };

  const handleZeroUnusedCategories = () => {
    const updated = { ...categoryCaps };
    let zeroedCount = 0;
    if (intelligentPlan?.suggestions) {
      intelligentPlan.suggestions.forEach((s) => {
        if (s.historicalAvg === 0 && (s.committedFloor || 0) === 0 && !lockedCategories[s.category]) {
          if (updated[s.category] !== 0) {
            updated[s.category] = 0;
            zeroedCount++;
          }
        }
      });
    }
    setCategoryCaps(updated);
    saveCategoryCaps(updated);
    toast.success(`Zeroed out ${zeroedCount} unused categories (RM 0). Discretionary pool maximized!`);
  };

  const handleSyncMonthlyBudgetToCapsSum = () => {
    if (configuredCapsSum > 0) {
      setMonthlyBudget(configuredCapsSum);
      setBudgetValue(String(configuredCapsSum));
      saveSettingWithCloudSync('cashflow_monthly_budget', String(configuredCapsSum));
      toast.success(`Monthly budget synced to sum of category caps: RM ${configuredCapsSum.toLocaleString()}`);
    }
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
              className="w-32 rounded-xl border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-1.5 text-xs text-slate-950 dark:text-white outline-none focus:border-emerald-500 font-mono"
            />
            <button
              type="submit"
              className="p-2 rounded-xl bg-[#0D6E52] hover:bg-[#0A5740] dark:bg-emerald-600 dark:hover:bg-emerald-500 text-white dark:text-white cursor-pointer"
            >
              <Check className="h-4 w-4" />
            </button>
          </form>
        )}
      />

      {/* Unified Period Selector */}
      <div className="bg-white/90 dark:bg-zinc-900/60 p-3.5 sm:p-4 rounded-3xl border border-slate-200 dark:border-white/[0.08] backdrop-blur-xl shadow-lg specular-card">
        <PeriodBar
          selectedMonth={selectedMonth}
          onSelectMonth={setSelectedMonth}
          sheetMonths={sheetMonths}
          transactions={transactions}
          selectId="budget-period-select"
          selectAriaLabel="Select month or year for budget"
        />
      </div>

      {/* Hero Overview Grid: Circular Progress + Daily Safe-to-Spend Limit */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Circular Progress Gauge */}
        <motion.div
          whileHover={{ y: -4, scale: 1.01 }}
          transition={{ type: 'spring' as const, stiffness: 400, damping: 25 }}
          className="rounded-3xl border border-black/[0.08] dark:border-white/[0.08] bg-card p-6 text-center  flex flex-col justify-between shadow-[0_1px_2px_rgba(17,20,24,0.03)] hover:border-emerald-500/40 transition-colors specular-card"
        >
          <div className="relative mx-auto h-48 w-48">
            <svg className="h-full w-full" viewBox="0 0 100 100">
              <circle cx="50" cy="50" r="45" fill="none" strokeWidth="8" className="stroke-slate-200 dark:stroke-zinc-800" />
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
                of <AnimatedNumber value={effectiveBudget} animateOnMount />
                {isYearMode ? ' (Annual)' : isAllTimeMode ? ` (${allTimeActiveMonths} mos)` : ''}
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

          {/* Multi-segment Monthly Budget Allocation Bar */}
          <div className="mt-4 pt-3 border-t border-slate-200 dark:border-white/[0.06] space-y-2">
            <div className="flex items-center justify-between text-[11px] text-slate-600 dark:text-zinc-400">
              <span className="font-medium">Budget Protection Breakdown</span>
              <span className="font-mono text-slate-900 dark:text-white font-semibold">
                RM{'\u00A0'}{effectiveBudget.toLocaleString()}
              </span>
            </div>
            <div className="h-2.5 w-full rounded-full bg-slate-200 dark:bg-zinc-800 overflow-hidden flex">
              {/* Segment 1: Spent So Far */}
              <div
                className="h-full bg-[#0D6E52] dark:bg-emerald-500 transition-all duration-500"
                style={{ width: `${Math.min(100, (totalSpent / (effectiveBudget || 1)) * 100)}%` }}
                title={`Spent So Far: RM ${totalSpent.toFixed(2)}`}
              />
              {/* Segment 2: Unpaid Committed Bills Reserve (Hatched / Amber) */}
              {heroUnpaidReserve > 0 && (
                <div
                  className="h-full bg-amber-500/80 bg-[repeating-linear-gradient(45deg,transparent,transparent_4px,rgba(0,0,0,0.15)_4px,rgba(0,0,0,0.15)_8px)] transition-all duration-500"
                  style={{ width: `${Math.min(Math.max(0, 100 - (totalSpent / (effectiveBudget || 1)) * 100), (heroUnpaidReserve / (effectiveBudget || 1)) * 100)}%` }}
                  title={`Upcoming Bills Reserve: RM ${heroUnpaidReserve.toFixed(2)}`}
                />
              )}
              {/* Segment 3: Safe Discretionary */}
              <div
                className="h-full bg-emerald-500/40"
                style={{ width: `${Math.max(0, 100 - ((totalSpent + heroUnpaidReserve) / (effectiveBudget || 1)) * 100)}%` }}
                title={`Safe Discretionary Left: RM ${Math.max(0, effectiveBudget - totalSpent - heroUnpaidReserve).toFixed(2)}`}
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-slate-500 dark:text-zinc-400">
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-[#0D6E52] dark:bg-emerald-500" />
                <span>Spent: <strong>RM{'\u00A0'}{totalSpent.toFixed(0)}</strong></span>
              </span>
              {heroUnpaidReserve > 0 && (
                <span className="flex items-center gap-1 text-amber-700 dark:text-amber-400 font-medium">
                  <span className="h-2 w-2 rounded-full bg-amber-500" />
                  <span>Bills Reserved: <strong>RM{'\u00A0'}{heroUnpaidReserve.toFixed(0)}</strong></span>
                </span>
              )}
              <span className="flex items-center gap-1 text-emerald-700 dark:text-emerald-400 font-medium">
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                <span>Safe to Spend: <strong>RM {Math.max(0, effectiveBudget - totalSpent - heroUnpaidReserve).toFixed(0)}</strong></span>
              </span>
            </div>
            {tripQuarantinedSpent > 0 && (
              <div className="text-[10px] text-slate-500 dark:text-zinc-400 text-left">
                ✈️ Trip spend <span className="font-mono font-semibold">RM{'\u00A0'}{tripQuarantinedSpent.toFixed(0)}</span> quarantined in Trip Envelopes (excluded above)
              </div>
            )}
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
                  {dailyInfo.isAllTime
                    ? 'Daily allowance is unavailable for all-time totals'
                    : dailyInfo.isPastMonth
                    ? isYearMode
                      ? 'Year concluded'
                      : 'Month concluded'
                    : `${dailyInfo.daysRemaining} days remaining in this ${isYearMode ? 'year' : 'month'}`}
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
                  ? `⚠️ This ${isYearMode ? 'year' : 'month'} concluded over budget by RM\u00A0${dailyInfo.overAmount.toFixed(2)} (${dailyInfo.spentPercent}% used).`
                  : `🎉 This ${isYearMode ? 'year' : 'month'} concluded successfully with RM\u00A0${dailyInfo.remainingBudget.toFixed(2)} remaining under budget (${dailyInfo.spentPercent}% used).`
                : dailyInfo.isOverBudget
                ? `⚠️ You have exceeded your ${isYearMode ? 'annual' : 'monthly'} limit by RM\u00A0${dailyInfo.overAmount.toFixed(2)}. Avoid non-essential expenses for the next ${dailyInfo.daysRemaining} days.`
                : heroUnpaidReserve > 0 && dailyInfo.safeRemainingBudget <= 0
                ? `📌 RM\u00A0${heroUnpaidReserve.toFixed(2)} is reserved for upcoming unpaid commitments/installments, leaving RM\u00A00.00 in free discretionary allowance.`
                : dailyInfo.spentPercent > 80
                ? `⚠️ Approaching budget cap (${dailyInfo.spentPercent}% used). Keep daily expenses under RM\u00A0${dailyInfo.dailyAllowance.toFixed(2)} to stay within your goal.`
                : `🎉 You are well on track! You can safely spend up to RM\u00A0${dailyInfo.dailyAllowance.toFixed(2)} each day until ${isYearMode ? 'year' : 'month'} end.`}
            </p>
          </div>

          <div className="pt-3 border-t border-slate-200 dark:border-zinc-800/80 flex items-center justify-between text-xs text-slate-600 dark:text-zinc-400">
            <span>
              {dailyInfo.isAllTime
                ? 'Remaining Period Budget:'
                : dailyInfo.isPastMonth
                ? 'Final Unused Cashflow:'
                : heroUnpaidReserve > 0
                ? 'Safe After Bills:'
                : isYearMode
                ? 'Remaining Year Cashflow:'
                : 'Remaining Month Cashflow:'}
            </span>
            <span className="font-mono font-bold text-slate-950 dark:text-white whitespace-nowrap tabular-nums">
              RM{'\u00A0'}{(heroUnpaidReserve > 0 && !dailyInfo.isAllTime && !dailyInfo.isPastMonth
                ? dailyInfo.safeRemainingBudget
                : dailyInfo.remainingBudget).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>
        </motion.div>
      </div>

      {/* Month-End Savings & Investment Predictor Card */}
      <motion.div
        whileHover={{ y: -2 }}
        transition={{ type: 'spring' as const, stiffness: 400, damping: 25 }}
        className="rounded-3xl border border-emerald-500/25 bg-emerald-500/[0.04] p-5 sm:p-6 backdrop-blur-xl shadow-xl specular-card space-y-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2.5 rounded-2xl -emerald-/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30">
              <TrendingUp className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-bold text-slate-950 dark:text-white uppercase tracking-wider block">
                  {isYearMode || isAllTimeMode
                    ? `Month-End Savings & Investment Predictor (${formatMonthLabel(currentMonthStr)})`
                    : 'Month-End Savings & Investment Predictor'}
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
                Daily living burn: <strong className="font-mono text-slate-900 dark:text-white">RM{'\u00A0'}{savingsPrediction.currentDailySpend.toFixed(2)}/day</strong>
                {savingsPrediction.lumpSumSpent > 0 && (
                  <span className="text-emerald-700 dark:text-emerald-300 font-medium">
                    {' '}· Lump sums: <strong className="font-mono">RM{'\u00A0'}{savingsPrediction.lumpSumSpent.toFixed(2)}</strong> (absorbed flexibly)
                  </span>
                )}
                {' '}· Total: RM{'\u00A0'}{savingsPrediction.spentSoFar.toFixed(2)} ({savingsPrediction.daysPassed}d passed, {savingsPrediction.daysRemaining}d left)
              </span>
            </div>
          </div>

          <div className="text-right text-xs">
            <span className="text-slate-500 dark:text-zinc-400 block text-[11px]">Monthly Baseline Income</span>
            <span className="font-mono font-bold text-slate-900 dark:text-white">
              RM{'\u00A0'}{savingsPrediction.baselineIncome.toLocaleString()}
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
              RM{'\u00A0'}{savingsPrediction.predictedSavingsAmount.toLocaleString()}
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[10px] text-slate-500 dark:text-zinc-400">
                <span>Target: {savingsPrediction.savingsTargetPct}% (RM{'\u00A0'}{savingsPrediction.targetSavingsAmount.toLocaleString()})</span>
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
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full -emerald-/15 text-emerald-700 dark:text-emerald-300">
                {savingsPrediction.predictedInvestmentPct}% of Income
              </span>
            </div>
            <div className="text-2xl font-black font-mono text-emerald-800 dark:text-emerald-400">
              RM{'\u00A0'}{savingsPrediction.predictedInvestmentAmount.toLocaleString()}
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[10px] text-slate-500 dark:text-zinc-400">
                <span>Target: {savingsPrediction.investmentTargetPct}% (RM{'\u00A0'}{savingsPrediction.targetInvestmentAmount.toLocaleString()})</span>
                <span>{((savingsPrediction.predictedInvestmentAmount / (savingsPrediction.targetInvestmentAmount || 1)) * 100).toFixed(0)}%</span>
              </div>
              <div className="h-1.5 w-full bg-slate-200 dark:bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-[#0D6E52] dark:bg-emerald-500 rounded-full transition-all duration-500"
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
                Limit: RM{'\u00A0'}{savingsPrediction.targetLivingBudget.toLocaleString()}
              </span>
            </div>
            <div className={`text-2xl font-black font-mono ${
              savingsPrediction.projectedTotalSpend > savingsPrediction.targetLivingBudget
                ? 'text-rose-800 dark:text-rose-400'
                : 'text-slate-900 dark:text-white'
            }`}>
              RM{'\u00A0'}{savingsPrediction.projectedTotalSpend.toLocaleString()}
            </div>
            <div className="text-[10px] text-slate-500 dark:text-zinc-400">
              Living Budget: Income RM{'\u00A0'}{savingsPrediction.baselineIncome.toLocaleString()} - Target Savings RM{'\u00A0'}{(savingsPrediction.targetSavingsAmount + savingsPrediction.targetInvestmentAmount).toLocaleString()}
            </div>
            <div className="text-[10px] font-mono text-slate-600 dark:text-zinc-300">
              Safe Daily Pace: <strong className="text-emerald-700 dark:text-emerald-400">RM{'\u00A0'}{savingsPrediction.safeDailyLivingAllowance.toFixed(2)}/day</strong> ({savingsPrediction.daysRemaining}d left)
            </div>
            {savingsPrediction.lumpSumSpent > 0 && (
              <div className="text-[10px] text-amber-800 dark:text-amber-300">
                RM{'\u00A0'}{savingsPrediction.lumpSumSpent.toFixed(2)} lump sum absorbed into month without distorting daily living pace.
              </div>
            )}
          </div>
        </div>

        {/* Actionable Prediction Insight Banner */}
        <div className="p-3.5 rounded-xl bg-emerald-500/[0.08] border border-emerald-500/20 text-xs text-foreground flex items-start gap-2.5 leading-relaxed">
          <Sparkles className="h-4 w-4 text-emerald-700 dark:text-emerald-400 shrink-0 mt-0.5" />
          <span>{savingsPrediction.insightMessage}</span>
        </div>
      </motion.div>

      {/* Payday Cycle & Savings Shield Card */}
      <motion.div
        whileHover={{ y: -2 }}
        transition={{ type: 'spring' as const, stiffness: 400, damping: 25 }}
        className="rounded-[22px] border border-black/[0.08] dark:border-white/[0.08] bg-card p-5 sm:p-6 shadow-[0_1px_2px_rgba(17,20,24,0.03)] space-y-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2.5 rounded-xl bg-emerald-500/12 text-emerald-700 dark:text-emerald-400 border border-emerald-500/25">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-foreground uppercase tracking-wider block">
                  Payday Cycle & Savings Shield
                </span>
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${
                  paydayInfo.cyclePhase === 'living_phase'
                    ? 'bg-amber-500/12 text-amber-800 dark:text-amber-300 border border-amber-500/25'
                    : 'bg-emerald-500/12 text-emerald-800 dark:text-emerald-300 border border-emerald-500/25'
                }`}>
                  {paydayInfo.cyclePhase === 'living_phase' ? 'Living Phase' : 'Payday Settlement'}
                </span>
              </div>
              <span className="text-[11px] text-muted-foreground">
                {paydayInfo.headline}
              </span>
            </div>
          </div>

          <div className="text-right text-xs">
            <span className="text-muted-foreground block text-[11px]">Salary Cycle Anchor</span>
            <span className="font-mono font-bold text-foreground">
              {paydayInfo.paydayDay}th of month (Last Week)
            </span>
          </div>
        </div>

        {/* 2 Envelopes Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
          {/* Envelope 1: Pre-quarantined Savings Target */}
          <div className="p-4 rounded-2xl bg-black/[0.02] dark:bg-white/[0.025] border border-black/[0.07] dark:border-white/[0.07] space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-amber-800 dark:text-amber-300 flex items-center gap-1.5">
                <ShieldAlert className="h-3.5 w-3.5 text-amber-700 dark:text-amber-400" />
                Pre-Quarantined Savings Target
              </span>
              <span className="font-mono font-bold text-foreground">
                RM{'\u00A0'}{paydayInfo.preQuarantinedSavings.toLocaleString()}
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              Shielded from Day 1 ({paydayInfo.savingsTargetPct + paydayInfo.investmentTargetPct}% of RM{'\u00A0'}{paydayInfo.baselineIncome.toLocaleString()} income). You will never suffer an artificial early surplus or end-of-month budget cliff.
            </p>
            <div className="space-y-1 pt-1">
              <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                <span>Transfers fulfilled this month:</span>
                <span className="font-mono font-bold text-foreground">
                  RM{'\u00A0'}{paydayInfo.actualSavedThisMonth.toLocaleString()} ({paydayInfo.savingsProgressPct}%)
                </span>
              </div>
              <div className="h-1.5 w-full bg-black/[0.08] dark:bg-white/[0.08] rounded-full overflow-hidden">
                <div
                  className="h-full bg-[#B8862D] dark:bg-amber-400 rounded-full transition-all duration-500"
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
                RM{'\u00A0'}{paydayInfo.targetLivingBudget.toLocaleString()} / mo
              </span>
            </div>
            <p className="text-[11px] text-slate-600 dark:text-zinc-400 leading-relaxed">
              Steady living allowance regardless of salary bank-in date:
            </p>
            <div className="flex items-baseline gap-2 pt-0.5">
              <span className="text-2xl font-black font-mono text-emerald-800 dark:text-emerald-400">
                RM{'\u00A0'}{paydayInfo.dailyLivingAllowance.toFixed(2)}
              </span>
              <span className="text-xs text-slate-500 dark:text-zinc-400 font-mono">
                / day ({paydayInfo.daysRemainingInMonth} days left in cycle)
              </span>
            </div>
          </div>
        </div>

        {/* Intelligence Detail Banner */}
        <div className="p-3 rounded-xl -emerald-/10 border border-emerald-500/20 text-xs text-emerald-950 dark:text-emerald-200 flex items-start gap-2 leading-relaxed">
          <Info className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
          <span>{paydayInfo.detail}</span>
        </div>

        {paydayInfo.envelopePlan?.shouldPrompt && (
          <div className="p-4 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 text-xs text-emerald-950 dark:text-emerald-200 space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-bold flex items-center gap-1.5 text-sm text-emerald-900 dark:text-emerald-200">
                <Sparkles className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                <span>{paydayInfo.envelopePlan.headline}</span>
              </span>
              <button
                type="button"
                onClick={async () => {
                  const transfers = paydayInfo.envelopePlan?.proposedTransfers || [];
                  const todayStr = currentMonthStr + '-28';
                  for (const tr of transfers) {
                    const tempId = tr.id || `tx_env_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
                    const rowData = {
                      Id: tempId,
                      id: tempId,
                      Date: tr.date || todayStr,
                      date: tr.date || todayStr,
                      Type: 'investment',
                      type: 'investment',
                      Category: tr.category,
                      category: tr.category,
                      SubCategory: tr.subCategory,
                      subCategory: tr.subCategory,
                      Description: tr.description,
                      description: tr.description,
                      Amount: tr.amount,
                      amount: tr.amount,
                      Currency: 'MYR',
                      currency: 'MYR',
                      TripTag: '',
                      tripTag: '',
                      ReceiptUrl: '',
                      receiptUrl: '',
                      Notes: tr.notes,
                      notes: tr.notes,
                      _month: currentMonthStr,
                      _rowIndex: 2,
                    };
                    applyOptimisticAddToQueryCache(queryClient, currentMonthStr, rowData);
                    void addUnifiedRow(currentMonthStr, rowData);
                  }
                  queryClient.invalidateQueries({ queryKey: ['sheet'] });
                  queryClient.invalidateQueries({ queryKey: ['overview'] });
                  queryClient.invalidateQueries({ queryKey: ['budget'] });
                  toast.success('✨ 1-Tap Payday Envelope transfers recorded successfully!');
                }}
                className="px-3.5 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs shadow-md transition-all cursor-pointer inline-flex items-center gap-1.5"
              >
                <Check className="h-3.5 w-3.5" />
                <span>1-Tap Allocate Envelopes</span>
              </button>
            </div>
            <p className="text-[11px] text-emerald-800 dark:text-emerald-300 leading-relaxed">
              {paydayInfo.envelopePlan.summaryText}
            </p>
          </div>
        )}

        {/* Pillar 2.1: Trip Budget Envelopes */}
        {tripSummaries.length > 0 && (
          <div className="pt-3 border-t border-slate-200 dark:border-zinc-800/80 space-y-2">
            <div className="flex items-center justify-between text-xs font-bold text-slate-800 dark:text-zinc-200">
              <span className="flex items-center gap-1.5">
                <span>✈️ Active Trip Budget Envelopes</span>
              </span>
              <span className="text-[11px] text-slate-500 dark:text-zinc-400 font-normal">
                Quarantined from domestic daily allowance
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {tripSummaries.map((ts) => (
                <div
                  key={ts.tripTag}
                  className="p-3 rounded-2xl bg-white/80 dark:bg-zinc-900/60 border border-slate-200 dark:border-zinc-800/80 space-y-1.5"
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-bold text-slate-900 dark:text-white">{ts.tripTag}</span>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase ${
                      ts.isOverBudget
                        ? 'bg-rose-500/15 text-rose-700 dark:text-rose-400'
                        : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                    }`}>
                      {ts.isOverBudget ? 'Over Budget' : `${ts.spentPercent}% Used`}
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between text-xs font-mono">
                    <span className="text-slate-500 dark:text-zinc-400">
                      Spent: {ts.currency} {ts.spentNative.toLocaleString()}
                    </span>
                    <span className="font-bold text-slate-900 dark:text-white">
                      Cap: {ts.currency} {ts.budgetAmount.toLocaleString()}
                    </span>
                  </div>
                  <div className="h-1.5 w-full bg-slate-100 dark:bg-zinc-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        ts.isOverBudget ? 'bg-rose-500' : 'bg-[#0D6E52] dark:bg-emerald-500'
                      }`}
                      style={{ width: `${Math.min(100, ts.spentPercent)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
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
              RM {foodInfo.foodCap.toFixed(0)} / {isYearMode ? 'yr' : isAllTimeMode ? `${allTimeActiveMonths}m` : 'mo'}
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
              RM{'\u00A0'}{foodInfo.remainingFood.toFixed(2)}
            </div>
            <span className="text-[10px] text-slate-500 dark:text-zinc-400 block">
              RM{'\u00A0'}{foodInfo.foodSpent.toFixed(2)} used ({foodInfo.percentUsed.toFixed(0)}%)
              {foodInfo.foodReserve > 0 ? ` + RM ${foodInfo.foodReserve.toFixed(0)} reserved` : ''}
            </span>
          </div>

          <div className="p-3.5 rounded-2xl bg-white/90 dark:bg-zinc-900/60 border border-slate-200 dark:border-white/[0.08] space-y-1">
            <span className="text-[11px] font-semibold text-slate-500 dark:text-zinc-400 block uppercase">
              Safe Daily Food Pace
            </span>
            <div className="text-xl font-black font-mono text-emerald-800 dark:text-emerald-400">
              RM{'\u00A0'}{foodInfo.safeDailyFoodAllowance.toFixed(2)}
              <span className="text-xs font-normal text-slate-500 dark:text-zinc-400 ml-1">/ day</span>
            </div>
            <span className="text-[10px] text-slate-500 dark:text-zinc-400 block">
              {isAllTimeMode
                ? 'Daily pace N/A for all-time totals'
                : `${foodInfo.daysRemaining} days remaining in ${isYearMode ? 'year' : 'month'}`}
            </span>
          </div>

          <div className="p-3.5 rounded-2xl bg-white/90 dark:bg-zinc-900/60 border border-slate-200 dark:border-white/[0.08] space-y-1">
            <span className="text-[11px] font-semibold text-slate-500 dark:text-zinc-400 block uppercase">
              Today's Food Spent
            </span>
            <div className={`text-xl font-black font-mono ${
              foodInfo.isTodayOverDaily ? 'text-amber-800 dark:text-amber-400' : 'text-slate-900 dark:text-white'
            }`}>
              RM{'\u00A0'}{foodInfo.todayFoodSpent.toFixed(2)}
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
                Cap Sum: RM{'\u00A0'}{configuredCapsSum.toLocaleString()} / Max Living: RM{'\u00A0'}{maxLivingBudget.toLocaleString()}
              </span>
            </div>
            <span className="text-[11px] text-slate-500 dark:text-zinc-400 block mt-0.5">
              Strict constraint: Cap sum must be lower than or equal to Income (RM{'\u00A0'}{intelligentPlan.baselineIncome.toLocaleString()}) - Savings (RM{'\u00A0'}{intelligentPlan.targetSavingsAmount.toLocaleString()})
            </span>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={handleZeroUnusedCategories}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-slate-700 dark:text-zinc-300 font-semibold text-xs border border-slate-200 dark:border-zinc-700 cursor-pointer transition-all active:scale-95"
              title="Set categories with RM 0 historical spend and 0 commitments to RM 0"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>Zero Unused (RM 0)</span>
            </button>
            {monthlyBudget !== configuredCapsSum && configuredCapsSum > 0 && (
              <button
                type="button"
                onClick={handleSyncMonthlyBudgetToCapsSum}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-teal-500/10 hover:bg-teal-500/20 text-teal-700 dark:text-teal-300 font-semibold text-xs border border-teal-500/30 cursor-pointer transition-all active:scale-95"
                title="Sync total monthly budget with sum of category caps"
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                <span>Sync Total Budget (RM{'\u00A0'}{configuredCapsSum.toLocaleString()})</span>
              </button>
            )}
            {isCapsSumExceeded && (
              <button
                type="button"
                onClick={handleAutoFitCaps}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs shadow-sm cursor-pointer transition-all active:scale-95"
              >
                <span>Auto-Fit Caps to RM{'\u00A0'}{maxLivingBudget.toLocaleString()}</span>
              </button>
            )}
            <motion.button
              whileHover={{ scale: 1.04 }}
              whileTap={{ scale: 0.96 }}
              type="button"
              onClick={() => setIsAutoTuneOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#0D6E52] hover:bg-[#0A5740] dark:bg-emerald-600 dark:hover:bg-emerald-500 text-white font-semibold text-xs shadow-sm cursor-pointer"
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
                <strong>Cap Sum Alert:</strong> Total category caps (<strong>RM{'\u00A0'}{configuredCapsSum.toLocaleString()}</strong>) exceed your Living Budget (<strong>RM{'\u00A0'}{maxLivingBudget.toLocaleString()}</strong> = Income RM{'\u00A0'}{intelligentPlan.baselineIncome.toLocaleString()} - Savings RM{'\u00A0'}{intelligentPlan.targetSavingsAmount.toLocaleString()}). To preserve your {intelligentPlan.savingsTargetPct + intelligentPlan.investmentTargetPct}% savings target, reduce caps by RM{'\u00A0'}{(configuredCapsSum - maxLivingBudget).toLocaleString()}.
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

        {/* Top 1-Tap Smart Rebalancing Banner */}
        {topRebalanceSuggestion && (
          <div className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-950 dark:text-amber-200 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-sm">
            <div className="flex items-start gap-2.5">
              <Sparkles className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
              <span className="leading-relaxed font-medium">
                {topRebalanceSuggestion.summaryText}
              </span>
            </div>
            <button
              type="button"
              onClick={() => {
                saveCategoryCaps(topRebalanceSuggestion.updatedCaps);
                setCategoryCaps(topRebalanceSuggestion.updatedCaps);
                toast.success(`✨ Rebalanced caps! Total spend remains within RM ${maxLivingBudget.toLocaleString()}`);
              }}
              className="px-3.5 py-1.5 rounded-xl bg-amber-500 hover:bg-amber-600 active:scale-95 text-white font-bold text-xs shadow-md shadow-amber-500/20 cursor-pointer transition-all shrink-0 flex items-center gap-1.5"
            >
              <Sparkles className="h-3.5 w-3.5" />
              <span>✨ Auto-Balance Caps</span>
            </button>
          </div>
        )}

        {budgetCategoryRows.length === 0 ? (
          <div className="text-center py-10 rounded-2xl border border-slate-200 dark:border-zinc-800/80 bg-white/90 dark:bg-zinc-900/20">
            <p className="text-xs text-slate-500 dark:text-zinc-400">No category caps configured</p>
          </div>
        ) : (
          budgetCategoryRows.map((row) => {
            const isEditingThis = editingCategory === row.category;
            const suggestion = intelligentPlan?.suggestions?.find((s) => s.category === row.category);

            return (
              <div
                key={row.category}
                className={`rounded-2xl border p-4 space-y-2.5 transition-all ${
                  row.isOverCap
                    ? 'border-rose-500/30 bg-rose-500/10 dark:bg-rose-950/15'
                    : row.spentPercent > 70
                    ? 'border-amber-500/30 bg-amber-500/10 dark:bg-amber-950/15'
                    : 'border-slate-200 dark:border-zinc-800/80 bg-white/90 dark:bg-zinc-900/40'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div className="flex items-center gap-2 flex-wrap min-w-0">
                    <Link
                      href={`/transactions?category=${encodeURIComponent(row.category)}`}
                      className="font-bold text-foreground text-sm hover:text-emerald-700 dark:hover:text-emerald-300 transition-colors inline-flex items-center gap-1"
                      title={`View ${row.category} transactions`}
                    >
                      <span>{row.category}</span>
                      <ArrowUpRight className="h-3.5 w-3.5 opacity-60 shrink-0" />
                    </Link>
                    {suggestion && (
                      <span className={`text-[9px] font-semibold px-2 py-0.5 rounded-full border ${
                        suggestion.nature === 'fixed'
                          ? 'bg-amber-500/10 text-amber-800 dark:text-amber-300 border-amber-500/25'
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
                      row.isOverCap
                        ? 'bg-rose-500/20 text-rose-800 dark:text-rose-400'
                        : row.spentPercent > 70
                        ? 'bg-amber-500/20 text-amber-800 dark:text-amber-400'
                        : 'bg-emerald-500/20 text-emerald-800 dark:text-emerald-400'
                    }`}>
                      {row.spentPercent.toFixed(0)}%
                    </span>
                    {(row.isLocked || lockedCategories[row.category]) && (
                      <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-md bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30 flex items-center gap-1">
                        <Lock className="h-2.5 w-2.5" />
                        <span>Locked</span>
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    {!isEditingThis ? (
                      <div className="flex items-center gap-2 text-slate-600 dark:text-zinc-400">
                        <span className="font-mono whitespace-nowrap tabular-nums">
                          <strong className="text-slate-950 dark:text-white font-bold">RM{'\u00A0'}{row.spent.toFixed(2)}</strong> / Cap: RM{'\u00A0'}{row.cap.toFixed(0)}
                        </span>
                        <button
                          type="button"
                          onClick={() => toggleLockCategory(row.category)}
                          className={`p-1 rounded-lg cursor-pointer transition-colors ${
                            lockedCategories[row.category] || row.isLocked
                              ? 'text-amber-500 bg-amber-500/15'
                              : 'text-slate-400 hover:text-slate-600 dark:hover:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800'
                          }`}
                          title={lockedCategories[row.category] || row.isLocked ? 'Category cap locked from auto-fit' : 'Lock category cap to protect from auto-fit changes'}
                        >
                          {lockedCategories[row.category] || row.isLocked ? (
                            <Lock className="h-3.5 w-3.5" />
                          ) : (
                            <Unlock className="h-3.5 w-3.5" />
                          )}
                        </button>
                        <button
                          onClick={() => {
                            setEditingCategory(row.category);
                            setCategoryCapInput(String(row.cap));
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
                          className="w-20 rounded-lg border border-black/[0.12] dark:border-white/[0.15] bg-background px-2 py-1 text-xs text-foreground font-mono outline-none focus:border-emerald-600"
                        />
                        <button
                          onClick={() => handleSaveCategoryCap(row.category)}
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

                {/* 3-Segment Progress Bar */}
                <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-zinc-800 flex">
                  {/* Segment 1: Spent so far */}
                  <div
                    className={`h-full transition-all duration-500 ${
                      row.isOverCap
                        ? 'bg-rose-500'
                        : row.spentPercent > 70
                        ? 'bg-amber-400'
                        : 'bg-[#0D6E52] dark:bg-emerald-500'
                    }`}
                    style={{ width: `${Math.min(row.spentPercent, 100)}%` }}
                    title={`Spent: RM ${row.spent.toFixed(2)}`}
                  />
                  {/* Segment 2: Reserved upcoming bills */}
                  {row.unpaidBillReserve > 0 && row.cap > 0 && (
                    <div
                      className="h-full bg-amber-400/80 -amber-/80 transition-all duration-500 border-l border-white/20"
                      style={{
                        width: `${Math.min(row.reservePercent, Math.max(0, 100 - row.spentPercent))}%`,
                        backgroundImage: 'repeating-linear-gradient(45deg, transparent, transparent 3px, rgba(0,0,0,0.15) 3px, rgba(0,0,0,0.15) 6px)',
                      }}
                      title={`Reserved for unpaid bills: RM ${row.unpaidBillReserve.toFixed(2)}`}
                    />
                  )}
                </div>

                {/* Per-Category Bill Reserve Breakdown */}
                {row.unpaidBillReserve > 0 && (
                  <div className="text-[10px] text-amber-900 dark:text-amber-200 bg-amber-500/10 border border-amber-500/20 rounded-xl px-2.5 py-1.5 flex flex-wrap items-center justify-between gap-1">
                    <span className="flex items-center gap-1 font-medium">
                      📌 Bill Reserve: RM{'\u00A0'}{row.unpaidBillReserve.toFixed(2)} reserved for upcoming bills
                      {row.unpaidBills && row.unpaidBills.length > 0 && (
                        <span className="opacity-80">
                          ({row.unpaidBills.map((b) => `${b.name} RM ${b.amount.toFixed(0)}`).join(', ')})
                        </span>
                      )}
                    </span>
                    <span>
                      Free Unreserved: <strong className="font-mono">RM{'\u00A0'}{row.unreservedRemaining.toFixed(2)}</strong>
                    </span>
                  </div>
                )}

                {/* Food & Dining Extra Burn Rate Row */}
                {row.category === 'Food & Dining' && dailyInfo.isCurrentMonth && (
                  <div className="text-[11px] text-amber-900 dark:text-amber-200 bg-amber-500/10 border border-amber-500/20 rounded-xl px-2.5 py-1.5 flex flex-wrap items-center justify-between gap-1">
                    <span className="flex items-center gap-1.5 font-medium">
                      <Utensils className="h-3 w-3" />
                      Today's Food Spent: <strong className="font-mono">RM {foodInfo.todayFoodSpent.toFixed(2)}</strong>
                    </span>
                    <span>
                      Safe Daily Food Allowance: <strong className="font-mono">RM{'\u00A0'}{foodInfo.safeDailyFoodAllowance.toFixed(2)} / day</strong>
                    </span>
                  </div>
                )}

                {/* Daily Safe Limit only for Food & Dining; Capped Monthly Bucket for all others */}
                <div className="flex items-center justify-between text-[11px] text-slate-600 dark:text-zinc-400 pt-0.5">
                  <span>
                    {row.isOverCap ? (
                      <span className="text-rose-800 dark:text-rose-400 font-semibold">
                        Over cap by RM {Math.max(0, row.spent + row.unpaidBillReserve - row.cap).toFixed(2)}
                      </span>
                    ) : (
                      <span>
                        Remaining: <strong className="text-slate-800 dark:text-zinc-200 font-mono">RM{'\u00A0'}{row.unreservedRemaining.toFixed(2)}</strong>
                      </span>
                    )}
                  </span>
                  {row.isDailyCategory ? (
                    <span className="font-mono text-slate-700 dark:text-zinc-300">
                      Daily pace: <strong className={row.isOverCap ? 'text-rose-800 dark:text-rose-400' : 'text-emerald-800 dark:text-emerald-400'}>RM{'\u00A0'}{row.dailyAllowance.toFixed(2)} / day</strong>
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
                <div className="p-2.5 rounded-xl bg-emerald-500/12 text-emerald-700 dark:text-emerald-400 border border-emerald-500/25">
                  <Sparkles className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-foreground">
                    AI Intelligent Category Caps
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    Dynamically derived from your spending history & target savings
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsAutoTuneOpen(false)}
                className="p-2 rounded-xl text-muted-foreground hover:text-foreground hover:bg-black/[0.05] dark:hover:bg-white/[0.06] transition-colors cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Income & Savings Shield Math Summary */}
            <div className="p-4 rounded-xl bg-emerald-500/[0.08] border border-emerald-500/20 space-y-2 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2 font-semibold">
                <span className="text-emerald-800 dark:text-emerald-300">
                  Income Allocation Shield:
                </span>
                <span className="font-mono text-foreground">
                  RM{'\u00A0'}{intelligentPlan.baselineIncome.toLocaleString()} Income - RM{'\u00A0'}{intelligentPlan.targetSavingsAmount.toLocaleString()} Savings ({intelligentPlan.savingsTargetPct + intelligentPlan.investmentTargetPct}%) = <strong className="text-emerald-700 dark:text-emerald-300">RM{'\u00A0'}{intelligentPlan.targetLivingBudget.toLocaleString()} Living Pool</strong>
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                {intelligentPlan.summaryInsight}
              </p>
            </div>

            {/* Suggestions list */}
            <div className="space-y-3">
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center justify-between">
                <span>Category Breakdown & AI Reasoning</span>
                <span>Editable Suggested Cap (RM)</span>
              </div>

              <div className="space-y-2 max-h-[48vh] overflow-y-auto pr-1">
                {intelligentPlan.suggestions.map((s) => {
                  const currentVal = customCapsDraft[s.category] ?? s.suggestedCap;
                  const natureBadgeClass =
                    s.nature === 'fixed'
                      ? 'bg-amber-500/12 text-amber-800 dark:text-amber-300 border-amber-500/25'
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
                            Historical monthly avg: RM{'\u00A0'}{s.historicalAvg.toFixed(2)}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => toggleLockCategory(s.category)}
                          className={`p-1 rounded-lg cursor-pointer transition-colors ${
                            lockedCategories[s.category]
                              ? 'text-amber-500 bg-amber-500/15'
                              : 'text-slate-400 hover:text-slate-600 dark:hover:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800'
                          }`}
                          title={lockedCategories[s.category] ? 'Category cap is locked' : 'Lock category cap'}
                        >
                          {lockedCategories[s.category] ? (
                            <Lock className="h-3.5 w-3.5" />
                          ) : (
                            <Unlock className="h-3.5 w-3.5" />
                          )}
                        </button>
                        <span className="font-mono text-xs text-slate-500 dark:text-zinc-400">RM</span>
                        <input
                          type="number"
                          value={currentVal}
                          onChange={(e) => {
                            const val = parseFloat(e.target.value) || 0;
                            setCustomCapsDraft((prev) => ({ ...prev, [s.category]: val }));
                          }}
                          className="w-24 rounded-xl border border-black/[0.12] dark:border-white/[0.15] bg-background px-2.5 py-1.5 text-xs text-foreground font-mono text-right font-bold outline-none focus:border-emerald-600"
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
                    RM{'\u00A0'}{draftSum.toLocaleString()}
                  </span>
                  <span className="text-[11px] text-slate-500 dark:text-zinc-400">
                    / Living limit: RM{'\u00A0'}{maxLivingBudget.toLocaleString()} (Income - Savings)
                  </span>
                </div>
                {isDraftSumExceeded ? (
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-[11px] text-rose-600 dark:text-rose-400 font-semibold">
                      ⚠️ Exceeds limit by RM{'\u00A0'}{(draftSum - maxLivingBudget).toLocaleString()}
                    </span>
                    <button
                      type="button"
                      onClick={handleAutoFitDraft}
                      className="px-2 py-0.5 rounded-lg bg-rose-500/15 text-rose-700 dark:text-rose-300 border border-rose-500/30 text-[10px] font-bold hover:bg-rose-500/25 transition-all cursor-pointer"
                    >
                      Auto-Fit to RM{'\u00A0'}{maxLivingBudget.toLocaleString()}
                    </button>
                  </div>
                ) : (
                  <span className="text-[10px] text-emerald-600 dark:text-emerald-400 block mt-0.5">
                    ✨ Strictly within your RM{'\u00A0'}{maxLivingBudget.toLocaleString()} living pool. Full savings protected!
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
                  className="px-5 py-2 rounded-xl bg-[#0D6E52] hover:bg-[#0A5740] dark:bg-emerald-600 dark:hover:bg-emerald-500 text-white font-bold text-xs shadow-sm cursor-pointer active:scale-95 transition-all flex items-center gap-1.5"
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
