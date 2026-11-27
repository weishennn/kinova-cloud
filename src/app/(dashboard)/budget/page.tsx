'use client';

import React, { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import {
  AlertCircle,
  Wallet,
  Edit2,
  Check,
  Sparkles,
  TrendingUp,
  ArrowUpRight,
  X,
  RotateCcw,
  ShieldCheck,
  Utensils,
  Info,
  CheckCircle2,
  Lock,
  Unlock,
  Plane,
  CalendarClock,
  SlidersHorizontal,
  Layers,
} from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { addUnifiedRow, applyOptimisticAddToQueryCache, useMonthList } from '@/hooks/useSheets';
import { useTransactions } from '@/hooks/useTransactions';
import { useLockBodyScroll } from '@/hooks/useLockBodyScroll';
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
  getTripEnvelopeSummaries,
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
  type CategoryRebalanceSuggestion,
} from '@/lib/category-budget-helper';
import { CANONICAL_EXPENSE_CATEGORIES, normalizeToCanonicalCategory } from '@/lib/canonical-categories';
import { saveSettingWithCloudSync, SETTINGS_UPDATED_EVENT } from '@/lib/cloud-settings-sync';

type BudgetWorkspaceTab = 'caps' | 'forecast' | 'commitments';

export default function BudgetPage() {
  const queryClient = useQueryClient();
  const { selectedMonth, setSelectedMonth } = useAppStore();
  const { data: sheetMonths = [] } = useMonthList();
  const { transactions = [] } = useTransactions(selectedMonth ? { period: selectedMonth } : undefined);
  const { transactions: allTransactions = [] } = useTransactions({ period: 'all' });

  const [activeWorkspace, setActiveWorkspace] = useState<BudgetWorkspaceTab>('caps');

  const { currentMonth: currentMonthStr } = useMemo(
    () => buildPeriodCatalog(sheetMonths, selectedMonth, transactions),
    [sheetMonths, selectedMonth, transactions]
  );

  const formatMonthLabel = (mStr: string) => formatPeriodDisplay(mStr);

  // Scoped transactions & expenses for selected month or full year
  const monthlyTransactions = useMemo(() => {
    if (selectedMonth === 'all') {
      return transactions.filter((t) => t.id !== 'tx_sample' && !!t.date);
    }
    if (selectedMonth.startsWith('year-')) {
      const y = selectedMonth.replace('year-', '');
      return transactions.filter((t) => t.id !== 'tx_sample' && !!t.date && t.date.startsWith(y));
    }
    return transactions.filter(
      (t) => t.id !== 'tx_sample' && !!t.date && t.date.startsWith(selectedMonth)
    );
  }, [transactions, selectedMonth]);

  const monthlyExpenses = useMemo(() => {
    return monthlyTransactions.filter((t) => String(t.type || '').toLowerCase() === 'expense');
  }, [monthlyTransactions]);

  const monthlyLivingExpenses = useMemo(() => {
    return monthlyExpenses.filter((t) => !isTripQuarantinedExpense(t));
  }, [monthlyExpenses]);

  const tripQuarantinedSpent = useMemo(() => {
    return monthlyExpenses
      .filter((t) => isTripQuarantinedExpense(t))
      .reduce((sum, t) => sum + getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount), 0);
  }, [monthlyExpenses]);

  const totalSpent = useMemo(() => {
    return monthlyLivingExpenses.reduce(
      (sum, t) => sum + getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount),
      0
    );
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

  // Auto-Tune modal
  const [isAutoTuneOpen, setIsAutoTuneOpen] = useState(false);
  const [customCapsDraft, setCustomCapsDraft] = useState<Record<string, number>>({});

  useLockBodyScroll(isAutoTuneOpen);

  useEffect(() => {
    if (!isAutoTuneOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsAutoTuneOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isAutoTuneOpen]);

  const fullLedgerTransactions = useMemo(
    () => (allTransactions.length > 0 ? allTransactions : transactions),
    [allTransactions, transactions]
  );

  // Canonical and custom category rows for selected month
  const budgetCategoryRows = useMemo(() => {
    return getAllBudgetCategoryRows(fullLedgerTransactions, {
      caps: categoryCaps,
      lockedCaps: lockedCategories,
      targetMonth: selectedMonth,
    });
  }, [fullLedgerTransactions, categoryCaps, lockedCategories, selectedMonth]);

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
      toast.success(`Target monthly budget set to RM ${parsed.toLocaleString()}`);
    }
  };

  const handleSaveCategoryCap = (categoryName: string) => {
    const parsed = parseFloat(categoryCapInput);
    if (!isNaN(parsed) && parsed >= 0) {
      const canonical = normalizeToCanonicalCategory(categoryName, 'Expense');
      const updated = { ...categoryCaps, [canonical]: parsed };
      setCategoryCaps(updated);
      saveCategoryCaps(updated);
      toast.success(`Updated ${canonical} cap to RM ${parsed.toLocaleString()}`);
    }
    setEditingCategory(null);
    setCategoryCapInput('');
  };

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
  const ringRadius = 44;
  const circumference = 2 * Math.PI * ringRadius;
  const strokeDashoffset = circumference - (circumference * progressPercent) / 100;
  const isOverBudget = totalSpent > effectiveBudget;

  // AI Dynamic Category Caps calculation
  const intelligentPlan = useMemo(() => {
    return generateIntelligentCategoryCaps(fullLedgerTransactions, {
      configuredCaps: categoryCaps,
      lockedCaps: lockedCategories,
    });
  }, [fullLedgerTransactions, categoryCaps, lockedCategories]);

  // Real-time Month-End Savings & Investments Prediction
  const savingsPrediction = useMemo(() => {
    return predictMonthlySavingsAndInvestments(fullLedgerTransactions, {
      selectedMonth: isYearMode || isAllTimeMode ? currentMonthStr : selectedMonth,
      baselineIncome: intelligentPlan.baselineIncome,
      savingsTargetPct: intelligentPlan.savingsTargetPct,
      investmentTargetPct: intelligentPlan.investmentTargetPct,
    });
  }, [
    fullLedgerTransactions,
    selectedMonth,
    isYearMode,
    isAllTimeMode,
    currentMonthStr,
    intelligentPlan,
  ]);

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

  // Trip Budget Envelopes
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

  // Food & Dining burn rate & daily allowance
  const foodInfo = useMemo(() => {
    const foodRow = budgetCategoryRows.find((r) => r.category === 'Food & Dining');
    const foodCap = foodRow
      ? foodRow.cap
      : resolveCategoryCapValue('Food & Dining', categoryCaps, DEFAULT_CATEGORY_CAPS['Food & Dining'] || 1200);
    const foodSpent = foodRow
      ? foodRow.spent
      : monthlyLivingExpenses
          .filter(
            (t) =>
              normalizeToCanonicalCategory(t.category || 'Other', 'Expense', t.description) ===
              'Food & Dining'
          )
          .reduce((sum, t) => sum + getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount), 0);
    const foodReserve = foodRow ? foodRow.unpaidBillReserve : 0;
    const remainingFood = foodRow
      ? Math.max(0, foodRow.unreservedRemaining)
      : Math.max(0, foodCap - foodSpent - foodReserve);
    const isOver = foodRow ? foodRow.isOverCap : foodSpent + foodReserve > foodCap;

    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
      now.getDate()
    ).padStart(2, '0')}`;
    const todayFoodTxs = fullLedgerTransactions.filter(
      (t) =>
        String(t.type || '').toLowerCase() === 'expense' &&
        t.date === todayStr &&
        !isTripQuarantinedExpense(t) &&
        normalizeToCanonicalCategory(t.category || 'Other', 'Expense', t.description) ===
          'Food & Dining'
    );
    const todayFoodSpent = todayFoodTxs.reduce(
      (sum, t) => sum + getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount),
      0
    );

    const daysRemaining = dailyInfo.daysRemaining;
    const safeDailyFoodAllowance = foodRow
      ? foodRow.dailyAllowance
      : daysRemaining > 0
      ? remainingFood / daysRemaining
      : 0;
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

  const configuredCapsSum = useMemo(() => {
    return CANONICAL_EXPENSE_CATEGORIES.reduce(
      (sum, cat) => sum + resolveCategoryCapValue(cat, categoryCaps, 0),
      0
    );
  }, [categoryCaps]);

  const maxLivingBudget = intelligentPlan.targetLivingBudget;
  const isCapsSumExceeded = configuredCapsSum > maxLivingBudget;

  const handleAutoFitCaps = () => {
    const fitted = fitCapsToLivingBudget(
      categoryCaps,
      maxLivingBudget,
      lockedCategories,
      fullLedgerTransactions
    );
    setCategoryCaps(fitted);
    saveCategoryCaps(fitted);
    toast.success(`Caps fitted to RM ${maxLivingBudget.toLocaleString()} to protect your savings target.`);
  };

  // Cross-category smart rebalance suggestion
  const topRebalanceSuggestion = useMemo<CategoryRebalanceSuggestion | null>(() => {
    for (const row of budgetCategoryRows) {
      if (row.isOverCap || row.unreservedRemaining < 0) {
        const status = getCategoryRealtimeBudgetStatus(
          row.category,
          fullLedgerTransactions,
          categoryCaps,
          0,
          {
            targetMonth: selectedMonth,
            lockedCaps: lockedCategories,
            maxLivingBudget,
          }
        );
        if (status.rebalanceSuggestion?.canAutoRebalance) {
          return status.rebalanceSuggestion;
        }
      }
    }
    return null;
  }, [
    budgetCategoryRows,
    fullLedgerTransactions,
    categoryCaps,
    selectedMonth,
    lockedCategories,
    maxLivingBudget,
  ]);

  const draftSum = useMemo(() => {
    return Object.values(customCapsDraft).reduce((sum, v) => sum + (Number(v) || 0), 0);
  }, [customCapsDraft]);

  const isDraftSumExceeded = draftSum > maxLivingBudget;

  const handleAutoFitDraft = () => {
    const fitted = fitCapsToLivingBudget(
      customCapsDraft,
      maxLivingBudget,
      lockedCategories,
      fullLedgerTransactions
    );
    setCustomCapsDraft(fitted);
    toast.info(`Adjusted draft caps to RM ${maxLivingBudget.toLocaleString()} (Income - Savings)`);
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
    const safeCaps = fitCapsToLivingBudget(
      customCapsDraft,
      maxLivingBudget,
      lockedCategories,
      fullLedgerTransactions
    );
    setCategoryCaps(safeCaps);
    saveCategoryCaps(safeCaps);
    toast.success('AI Smart Category Caps applied and synced.');
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
    toast.success(`Zeroed ${zeroedCount} unused categories to RM 0.`);
  };

  const handleSyncMonthlyBudgetToCapsSum = () => {
    if (configuredCapsSum > 0) {
      setMonthlyBudget(configuredCapsSum);
      setBudgetValue(String(configuredCapsSum));
      saveSettingWithCloudSync('cashflow_monthly_budget', String(configuredCapsSum));
      toast.success(`Monthly budget synced to RM ${configuredCapsSum.toLocaleString()}`);
    }
  };

  const handleAllocatePaydayEnvelopes = async () => {
    const transfers = paydayInfo.envelopePlan?.proposedTransfers || [];
    const todayStr = `${currentMonthStr}-28`;
    for (const tr of transfers) {
      const tempId =
        tr.id || `tx_env_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
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
    toast.success('Payday envelope transfers recorded.');
  };

  const spentSegmentPct = Math.min(100, (totalSpent / (effectiveBudget || 1)) * 100);
  const reserveSegmentPct = Math.min(
    Math.max(0, 100 - spentSegmentPct),
    (heroUnpaidReserve / (effectiveBudget || 1)) * 100
  );
  const freeSegmentPct = Math.max(0, 100 - spentSegmentPct - reserveSegmentPct);

  const heroStatusBadge = dailyInfo.isAllTime
    ? { label: 'Period Total', cls: 'bg-white/10 text-zinc-200 border-white/15' }
    : dailyInfo.isOverBudget
    ? { label: 'Over Limit', cls: 'bg-rose-500/20 text-rose-200 border-rose-400/30' }
    : dailyInfo.isPastMonth
    ? { label: 'Concluded', cls: 'bg-white/10 text-zinc-200 border-white/15' }
    : dailyInfo.spentPercent > 80
    ? { label: 'Watch Pace', cls: 'bg-amber-500/20 text-amber-200 border-amber-400/30' }
    : { label: 'Healthy Pace', cls: 'bg-emerald-500/20 text-emerald-200 border-emerald-400/30' };

  const heroRemainingDisplay =
    heroUnpaidReserve > 0 && !dailyInfo.isAllTime && !dailyInfo.isPastMonth
      ? dailyInfo.safeRemainingBudget
      : dailyInfo.remainingBudget;

  const overCapCount = budgetCategoryRows.filter((r) => r.isOverCap).length;

  return (
    <div className="cockpit-module-page space-y-6 sm:space-y-8 pb-10">
      <CockpitPageHeading
        title="Budget & Cashflow Limits"
        description="Safe daily spend, protected savings envelopes, and intelligent category caps"
        action={
          !isEditingBudget ? (
            <button
              type="button"
              onClick={() => setIsEditingBudget(true)}
              className="cockpit-primary-action active:scale-[0.98] transition-transform"
            >
              <Edit2 className="h-3.5 w-3.5" />
              <span>Set Budget</span>
            </button>
          ) : (
            <form onSubmit={handleSaveBudget} className="flex items-center gap-2">
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs font-mono text-muted-foreground">
                  RM
                </span>
                <input
                  type="number"
                  value={budgetValue}
                  onChange={(e) => setBudgetValue(e.target.value)}
                  autoFocus
                  className="w-32 sm:w-36 rounded-xl border border-black/[0.12] dark:border-white/[0.15] bg-card pl-9 pr-3 py-2 text-xs font-mono font-semibold text-foreground outline-none focus:border-emerald-600"
                />
              </div>
              <button
                type="submit"
                className="h-9 w-9 rounded-xl bg-[#0D6E52] hover:bg-[#0A5740] dark:bg-emerald-600 dark:hover:bg-emerald-500 text-white flex items-center justify-center cursor-pointer active:scale-95 transition-all"
                aria-label="Save monthly budget"
              >
                <Check className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setIsEditingBudget(false)}
                className="h-9 w-9 rounded-xl border border-black/[0.08] dark:border-white/[0.1] bg-card text-muted-foreground hover:text-foreground flex items-center justify-center cursor-pointer"
                aria-label="Cancel budget edit"
              >
                <X className="h-4 w-4" />
              </button>
            </form>
          )
        }
      />

      {/* Period Selector Strip */}
      <div className="rounded-2xl border border-black/[0.07] dark:border-white/[0.08] bg-card px-4 py-3">
        <PeriodBar
          selectedMonth={selectedMonth}
          onSelectMonth={setSelectedMonth}
          sheetMonths={sheetMonths}
          transactions={transactions}
          selectId="budget-period-select"
          selectAriaLabel="Select month or year for budget"
        />
      </div>

      {/* Signature Hero Canvas — Obsidian & Jade Command Center */}
      <section
        aria-label="Budget overview and daily safe spend"
        className="atelier-hero relative overflow-hidden rounded-[28px] bg-gradient-to-br from-[#0B1210] via-[#101D18] to-[#080C0A] border border-emerald-500/20 text-[#F5F4EF] p-5 sm:p-8 shadow-[0_20px_50px_-24px_rgba(4,24,18,0.65)]"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-24 -right-24 h-72 w-72 rounded-full bg-emerald-500/15 blur-3xl"
        />

        <div className="relative z-10 grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
          {/* Left: Safe-to-Spend Focal Telemetry */}
          <div className="lg:col-span-7 space-y-6 min-w-0">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-300/90">
                <Sparkles className="h-3.5 w-3.5 shrink-0" />
                <span>
                  {dailyInfo.isAllTime
                    ? 'All-Time Budget Standing'
                    : dailyInfo.isPastMonth
                    ? 'Period Concluded'
                    : 'Safe Daily Spend Allowance'}
                </span>
              </div>
              <span
                className={`text-[11px] font-semibold px-3 py-1 rounded-full border ${heroStatusBadge.cls}`}
              >
                {heroStatusBadge.label}
              </span>
            </div>

            <div>
              <div className="flex items-baseline gap-2.5 flex-wrap">
                <span
                  className={`text-3xl sm:text-5xl font-bold font-mono tabular-nums tracking-tight ${
                    dailyInfo.isAllTime
                      ? 'text-zinc-300'
                      : dailyInfo.isOverBudget
                      ? 'text-rose-400'
                      : 'text-white'
                  }`}
                >
                  {dailyInfo.isAllTime ? (
                    '—'
                  ) : (
                    <AnimatedNumber value={dailyInfo.dailyAllowance} animateOnMount />
                  )}
                </span>
                {!dailyInfo.isAllTime && (
                  <span className="text-sm font-mono text-[#9AA6A1]">
                    / day · {dailyInfo.daysRemaining}d left
                  </span>
                )}
              </div>

              <p className="mt-2.5 text-xs sm:text-sm text-[#B7C2BD] leading-relaxed max-w-xl">
                {dailyInfo.isAllTime
                  ? 'Pick a specific month or year above to calculate your time-based daily safe allowance.'
                  : dailyInfo.isPastMonth
                  ? dailyInfo.isOverBudget
                    ? `Concluded over limit by RM\u00A0${dailyInfo.overAmount.toFixed(2)} (${dailyInfo.spentPercent}% used).`
                    : `Finished under budget with RM\u00A0${dailyInfo.remainingBudget.toFixed(2)} remaining (${dailyInfo.spentPercent}% used).`
                  : dailyInfo.isOverBudget
                  ? `Exceeded ${isYearMode ? 'annual' : 'monthly'} cap by RM\u00A0${dailyInfo.overAmount.toFixed(2)}. Pause discretionary spending for the next ${dailyInfo.daysRemaining} days.`
                  : heroUnpaidReserve > 0 && dailyInfo.safeRemainingBudget <= 0
                  ? `RM\u00A0${heroUnpaidReserve.toFixed(2)} is locked for upcoming bills & installments, leaving RM\u00A00.00 in free discretionary spend.`
                  : `Stay within RM\u00A0${dailyInfo.dailyAllowance.toFixed(2)} per day to close ${formatMonthLabel(selectedMonth)} cleanly on target.`}
              </p>
            </div>

            {/* Integrated 3-Segment Protection Meter */}
            <div className="space-y-2.5 pt-1">
              <div className="h-2.5 w-full rounded-full bg-white/[0.08] overflow-hidden flex">
                <div
                  className={`h-full transition-all duration-700 ${
                    isOverBudget ? 'bg-rose-500' : 'bg-emerald-400'
                  }`}
                  style={{ width: `${spentSegmentPct}%` }}
                  title={`Spent: RM ${totalSpent.toFixed(2)}`}
                />
                {heroUnpaidReserve > 0 && (
                  <div
                    className="h-full bg-amber-400/90 transition-all duration-700"
                    style={{
                      width: `${reserveSegmentPct}%`,
                      backgroundImage:
                        'repeating-linear-gradient(45deg,transparent,transparent 4px,rgba(0,0,0,0.22) 4px,rgba(0,0,0,0.22) 8px)',
                    }}
                    title={`Bills Reserved: RM ${heroUnpaidReserve.toFixed(2)}`}
                  />
                )}
                <div
                  className="h-full bg-emerald-400/20 transition-all duration-700"
                  style={{ width: `${freeSegmentPct}%` }}
                  title={`Safe Discretionary: RM ${Math.max(0, effectiveBudget - totalSpent - heroUnpaidReserve).toFixed(2)}`}
                />
              </div>

              <div className="grid grid-cols-3 gap-2 sm:gap-3 text-xs font-mono tabular-nums pt-1">
                <div className="min-w-0">
                  <span className="text-[10px] uppercase tracking-wider text-[#8C9B95] block">
                    Spent
                  </span>
                  <span className="text-xs sm:text-sm font-semibold text-white truncate block">
                    RM{'\u00A0'}{totalSpent.toLocaleString('en-MY', { maximumFractionDigits: 0 })}
                  </span>
                </div>
                <div className="min-w-0">
                  <span className="text-[10px] uppercase tracking-wider text-[#8C9B95] block truncate">
                    {heroUnpaidReserve > 0 ? 'Reserved' : 'Limit'}
                  </span>
                  <span
                    className={`text-xs sm:text-sm font-semibold truncate block ${
                      heroUnpaidReserve > 0 ? 'text-amber-300' : 'text-[#D6DFDB]'
                    }`}
                  >
                    RM{'\u00A0'}
                    {(heroUnpaidReserve > 0 ? heroUnpaidReserve : effectiveBudget).toLocaleString(
                      'en-MY',
                      { maximumFractionDigits: 0 }
                    )}
                  </span>
                </div>
                <div className="text-right min-w-0">
                  <span className="text-[10px] uppercase tracking-wider text-[#8C9B95] block truncate">
                    {heroUnpaidReserve > 0 && !dailyInfo.isAllTime && !dailyInfo.isPastMonth
                      ? 'Safe Free'
                      : 'Remaining'}
                  </span>
                  <span
                    className={`text-xs sm:text-sm font-semibold truncate block ${
                      isOverBudget ? 'text-rose-400' : 'text-emerald-300'
                    }`}
                  >
                    RM{'\u00A0'}
                    {heroRemainingDisplay.toLocaleString('en-MY', {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </span>
                </div>
              </div>

              {tripQuarantinedSpent > 0 && (
                <div className="inline-flex items-center gap-1.5 text-[11px] text-[#9AA6A1] pt-1">
                  <Plane className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                  <span>
                    RM{'\u00A0'}{tripQuarantinedSpent.toFixed(0)} in travel spend is quarantined inside Trip Envelopes.
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Right: Precision Ring Gauge */}
          <div className="lg:col-span-5 flex flex-col items-center justify-center lg:border-l lg:border-white/[0.08] lg:pl-8">
            <div className="relative h-44 w-44 sm:h-52 sm:w-52">
              <svg className="h-full w-full" viewBox="0 0 100 100">
                <defs>
                  <linearGradient id="budgetRingJade" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor={isOverBudget ? '#fb7185' : progressPercent > 80 ? '#fbbf24' : '#34d399'} />
                    <stop offset="100%" stopColor={isOverBudget ? '#e11d48' : progressPercent > 80 ? '#f59e0b' : '#0d9488'} />
                  </linearGradient>
                </defs>
                <circle
                  cx="50"
                  cy="50"
                  r={ringRadius}
                  fill="none"
                  strokeWidth="6.5"
                  stroke="rgba(255,255,255,0.08)"
                />
                <motion.circle
                  cx="50"
                  cy="50"
                  r={ringRadius}
                  fill="none"
                  stroke="url(#budgetRingJade)"
                  strokeWidth="6.5"
                  strokeDasharray={circumference}
                  strokeLinecap="round"
                  transform="rotate(-90 50 50)"
                  initial={{ strokeDashoffset: circumference }}
                  animate={{ strokeDashoffset }}
                  transition={{ duration: 1.0, ease: [0.22, 1, 0.36, 1] }}
                />
              </svg>

              <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-4">
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8C9B95]">
                  {progressPercent.toFixed(0)}% Used
                </span>
                <span className="mt-1 text-xl sm:text-2xl font-bold font-mono tabular-nums text-white tracking-tight">
                  <AnimatedNumber value={totalSpent} animateOnMount />
                </span>
                <span className="mt-0.5 text-[11px] font-mono tabular-nums text-[#9AA6A1]">
                  of RM{'\u00A0'}{effectiveBudget.toLocaleString()}
                  {isYearMode ? ' /yr' : isAllTimeMode ? ` (${allTimeActiveMonths}m)` : ''}
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Actionable Smart Alerts */}
      {(isCapsSumExceeded || topRebalanceSuggestion || paydayInfo.envelopePlan?.shouldPrompt) && (
        <div className="space-y-3">
          {paydayInfo.envelopePlan?.shouldPrompt && (
            <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/[0.07] p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-start gap-3">
                <div className="h-9 w-9 rounded-xl bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 flex items-center justify-center shrink-0">
                  <Sparkles className="h-4 w-4" />
                </div>
                <div className="space-y-0.5">
                  <p className="text-xs font-semibold text-foreground">
                    {paydayInfo.envelopePlan.headline}
                  </p>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {paydayInfo.envelopePlan.summaryText}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={handleAllocatePaydayEnvelopes}
                className="shrink-0 inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl bg-[#0D6E52] hover:bg-[#0A5740] dark:bg-emerald-600 dark:hover:bg-emerald-500 text-white text-xs font-semibold cursor-pointer active:scale-[0.98] transition-all"
              >
                <Check className="h-3.5 w-3.5" />
                <span>Allocate Envelopes</span>
              </button>
            </div>
          )}

          {isCapsSumExceeded && (
            <div className="rounded-2xl border border-rose-500/30 bg-rose-500/[0.06] p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-start gap-3">
                <AlertCircle className="h-4 w-4 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
                <p className="text-xs text-foreground leading-relaxed">
                  Category caps total <strong className="font-mono">RM{'\u00A0'}{configuredCapsSum.toLocaleString()}</strong>, exceeding your living pool of <strong className="font-mono">RM{'\u00A0'}{maxLivingBudget.toLocaleString()}</strong> by <strong className="font-mono text-rose-600 dark:text-rose-400">RM{'\u00A0'}{(configuredCapsSum - maxLivingBudget).toLocaleString()}</strong>.
                </p>
              </div>
              <button
                type="button"
                onClick={handleAutoFitCaps}
                className="shrink-0 px-3.5 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold cursor-pointer active:scale-[0.98] transition-all"
              >
                Auto-Fit to RM{'\u00A0'}{maxLivingBudget.toLocaleString()}
              </button>
            </div>
          )}

          {topRebalanceSuggestion && (
            <div className="rounded-2xl border border-amber-500/30 bg-amber-500/[0.07] p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-start gap-3">
                <Sparkles className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                <p className="text-xs text-foreground leading-relaxed">
                  {topRebalanceSuggestion.summaryText}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  saveCategoryCaps(topRebalanceSuggestion.updatedCaps);
                  setCategoryCaps(topRebalanceSuggestion.updatedCaps);
                  toast.success(
                    `Caps rebalanced within RM ${maxLivingBudget.toLocaleString()}.`
                  );
                }}
                className="shrink-0 inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold cursor-pointer active:scale-[0.98] transition-all"
              >
                <Sparkles className="h-3.5 w-3.5" />
                <span>Auto-Balance Caps</span>
              </button>
            </div>
          )}
        </div>
      )}

      {/* Smooth Segmented Workspace Switcher */}
      <div className="flex items-center justify-between gap-3 border-b border-black/[0.07] dark:border-white/[0.08] pb-3.5 overflow-x-auto no-scrollbar">
        <div
          role="tablist"
          aria-label="Budget workspaces"
          className="relative inline-flex items-center gap-1 rounded-2xl bg-black/[0.04] dark:bg-white/[0.05] p-1 border border-black/[0.06] dark:border-white/[0.08]"
        >
          {(
            [
              {
                id: 'caps',
                label: 'Daily & Caps',
                icon: Layers,
                badge: overCapCount > 0 ? `${overCapCount} over` : undefined,
                badgeTone: 'rose',
              },
              {
                id: 'forecast',
                label: 'Forecast & Shield',
                icon: ShieldCheck,
                badge: `${savingsPrediction.predictedSavingsPct}% save`,
                badgeTone: 'emerald',
              },
              {
                id: 'commitments',
                label: 'Commitments & Debt',
                icon: CalendarClock,
                badge: undefined,
                badgeTone: 'neutral',
              },
            ] as const
          ).map((tab) => {
            const Icon = tab.icon;
            const isActive = activeWorkspace === tab.id;
            return (
              <button
                key={tab.id}
                role="tab"
                type="button"
                aria-selected={isActive}
                onClick={() => setActiveWorkspace(tab.id)}
                className={`relative z-10 inline-flex items-center gap-2 min-h-[38px] px-3.5 sm:px-4 py-1.5 rounded-xl text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap touch-manipulation ${
                  isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {isActive && (
                  <motion.div
                    layoutId="budget-workspace-pill"
                    className="absolute inset-0 rounded-xl bg-white dark:bg-zinc-900 shadow-sm border border-black/[0.06] dark:border-white/[0.1] pointer-events-none"
                    transition={{ type: 'spring', stiffness: 460, damping: 34 }}
                  />
                )}
                <Icon className="relative z-10 h-3.5 w-3.5 shrink-0" />
                <span className="relative z-10">{tab.label}</span>
                {tab.badge && (
                  <span
                    className={`relative z-10 text-[10px] font-mono px-1.5 py-0.5 rounded-full ${
                      tab.badgeTone === 'rose'
                        ? 'bg-rose-500/15 text-rose-700 dark:text-rose-400'
                        : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                    }`}
                  >
                    {tab.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Workspace Panels */}
      <AnimatePresence mode="wait">
        {activeWorkspace === 'caps' && (
          <motion.div
            key="workspace-caps"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            className="space-y-6"
          >
            {/* Food & Dining Daily Pulse */}
            <section className="rounded-3xl border border-black/[0.07] dark:border-white/[0.08] bg-card p-5 sm:p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="h-10 w-10 rounded-2xl bg-amber-500/12 text-amber-700 dark:text-amber-400 flex items-center justify-center shrink-0">
                    <Utensils className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="text-sm font-semibold text-foreground">
                        Food & Dining Daily Pace
                      </h2>
                      <span
                        className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                          foodInfo.isOver
                            ? 'bg-rose-500/15 text-rose-700 dark:text-rose-400'
                            : foodInfo.percentUsed > 80
                            ? 'bg-amber-500/15 text-amber-800 dark:text-amber-400'
                            : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                        }`}
                      >
                        {foodInfo.isOver
                          ? 'Over Cap'
                          : foodInfo.percentUsed > 80
                          ? 'Approaching Cap'
                          : 'On Track'}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Cap RM{'\u00A0'}{foodInfo.foodCap.toFixed(0)} /{' '}
                      {isYearMode ? 'yr' : isAllTimeMode ? `${allTimeActiveMonths}m` : 'mo'}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2.5 sm:gap-7 text-xs font-mono tabular-nums w-full sm:w-auto pt-2 sm:pt-0 border-t sm:border-t-0 border-black/[0.06] dark:border-white/[0.06]">
                  <div className="min-w-0">
                    <span className="text-[10px] font-sans uppercase tracking-wider text-muted-foreground block">
                      Remaining
                    </span>
                    <span className="text-xs sm:text-base font-bold text-foreground truncate block">
                      RM{'\u00A0'}{foodInfo.remainingFood.toFixed(0)}
                    </span>
                  </div>
                  <div className="min-w-0">
                    <span className="text-[10px] font-sans uppercase tracking-wider text-muted-foreground block">
                      Safe / Day
                    </span>
                    <span className="text-xs sm:text-base font-bold text-emerald-700 dark:text-emerald-400 truncate block">
                      RM{'\u00A0'}{foodInfo.safeDailyFoodAllowance.toFixed(2)}
                    </span>
                  </div>
                  <div className="text-right min-w-0">
                    <span className="text-[10px] font-sans uppercase tracking-wider text-muted-foreground block">
                      Today
                    </span>
                    <span
                      className={`text-xs sm:text-base font-bold truncate block ${
                        foodInfo.isTodayOverDaily
                          ? 'text-amber-700 dark:text-amber-400'
                          : 'text-foreground'
                      }`}
                    >
                      RM{'\u00A0'}{foodInfo.todayFoodSpent.toFixed(2)}
                    </span>
                  </div>
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="h-1.5 w-full rounded-full bg-black/[0.06] dark:bg-white/[0.08] overflow-hidden">
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
                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground font-mono">
                  <span>
                    RM{'\u00A0'}{foodInfo.foodSpent.toFixed(2)} used ({foodInfo.percentUsed.toFixed(0)}%)
                    {foodInfo.foodReserve > 0 ? ` · RM ${foodInfo.foodReserve.toFixed(0)} reserved` : ''}
                  </span>
                  <span>
                    {foodInfo.isTodayOverDaily
                      ? `+RM ${(foodInfo.todayFoodSpent - foodInfo.safeDailyFoodAllowance).toFixed(2)} over today's pace`
                      : 'Within today’s safe pace'}
                  </span>
                </div>
              </div>
            </section>

            {/* Unified Category Envelopes Ledger */}
            <section className="rounded-3xl border border-black/[0.07] dark:border-white/[0.08] bg-card overflow-hidden">
              <div className="p-5 sm:p-6 border-b border-black/[0.07] dark:border-white/[0.08] flex flex-wrap items-center justify-between gap-4">
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <h2 className="text-sm sm:text-base font-semibold text-foreground">
                      Category Envelopes
                    </h2>
                    <span
                      className={`text-[11px] font-mono font-semibold px-2.5 py-0.5 rounded-full ${
                        isCapsSumExceeded
                          ? 'bg-rose-500/15 text-rose-700 dark:text-rose-400'
                          : 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400'
                      }`}
                    >
                      RM{'\u00A0'}{configuredCapsSum.toLocaleString()} / RM{'\u00A0'}
                      {maxLivingBudget.toLocaleString()} living pool
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Income RM{'\u00A0'}{intelligentPlan.baselineIncome.toLocaleString()} − Savings RM
                    {'\u00A0'}{intelligentPlan.targetSavingsAmount.toLocaleString()}
                  </p>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    type="button"
                    onClick={handleZeroUnusedCategories}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-black/[0.08] dark:border-white/[0.1] bg-background hover:bg-black/[0.03] dark:hover:bg-white/[0.05] text-xs font-medium text-foreground cursor-pointer transition-colors"
                    title="Set categories with RM 0 historical spend and 0 commitments to RM 0"
                  >
                    <RotateCcw className="h-3.5 w-3.5 text-muted-foreground" />
                    <span>Zero Unused</span>
                  </button>

                  {monthlyBudget !== configuredCapsSum && configuredCapsSum > 0 && (
                    <button
                      type="button"
                      onClick={handleSyncMonthlyBudgetToCapsSum}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.08] hover:bg-emerald-500/[0.14] text-emerald-800 dark:text-emerald-300 text-xs font-semibold cursor-pointer transition-colors"
                      title="Sync total monthly budget with sum of category caps"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      <span>Sync Total</span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => setIsAutoTuneOpen(true)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#0D6E52] hover:bg-[#0A5740] dark:bg-emerald-600 dark:hover:bg-emerald-500 text-white text-xs font-semibold cursor-pointer active:scale-[0.98] transition-all"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    <span>AI Auto-Tune</span>
                  </button>
                </div>
              </div>

              {budgetCategoryRows.length === 0 ? (
                <div className="py-12 text-center text-xs text-muted-foreground">
                  No category caps configured yet.
                </div>
              ) : (
                <div className="divide-y divide-black/[0.06] dark:divide-white/[0.06]">
                  {budgetCategoryRows.map((row) => {
                    const isEditingThis = editingCategory === row.category;
                    const isLocked = Boolean(row.isLocked || lockedCategories[row.category]);
                    const suggestion = intelligentPlan?.suggestions?.find(
                      (s) => s.category === row.category
                    );

                    return (
                      <div
                        key={row.category}
                        className={`px-5 sm:px-6 py-4 space-y-2.5 transition-colors ${
                          row.isOverCap
                            ? 'bg-rose-500/[0.04]'
                            : 'hover:bg-black/[0.015] dark:hover:bg-white/[0.02]'
                        }`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2 flex-wrap min-w-0">
                            <Link
                              href={`/transactions?category=${encodeURIComponent(row.category)}`}
                              className="text-sm font-semibold text-foreground hover:text-emerald-700 dark:hover:text-emerald-400 transition-colors inline-flex items-center gap-1"
                            >
                              <span>{row.category}</span>
                              <ArrowUpRight className="h-3.5 w-3.5 opacity-45 shrink-0" />
                            </Link>

                            {suggestion && (
                              <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-black/[0.04] dark:bg-white/[0.06] text-muted-foreground">
                                {suggestion.natureLabel}
                              </span>
                            )}

                            <span
                              className={`text-[10px] font-mono font-semibold px-2 py-0.5 rounded-full ${
                                row.isOverCap
                                  ? 'bg-rose-500/15 text-rose-700 dark:text-rose-400'
                                  : row.spentPercent > 75
                                  ? 'bg-amber-500/15 text-amber-800 dark:text-amber-400'
                                  : 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400'
                              }`}
                            >
                              {row.spentPercent.toFixed(0)}%
                            </span>

                            {isLocked && (
                              <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-amber-500/12 text-amber-800 dark:text-amber-300">
                                <Lock className="h-2.5 w-2.5" />
                                Locked
                              </span>
                            )}
                          </div>

                          <div className="flex items-center gap-2">
                            {!isEditingThis ? (
                              <>
                                <span className="text-xs font-mono tabular-nums text-muted-foreground">
                                  <strong className="text-foreground font-semibold">
                                    RM{'\u00A0'}{row.spent.toFixed(2)}
                                  </strong>{' '}
                                  / RM{'\u00A0'}{row.cap.toFixed(0)}
                                </span>

                                <button
                                  type="button"
                                  onClick={() => toggleLockCategory(row.category)}
                                  className={`h-7 w-7 rounded-lg flex items-center justify-center transition-colors cursor-pointer ${
                                    isLocked
                                      ? 'text-amber-600 dark:text-amber-400 bg-amber-500/15'
                                      : 'text-muted-foreground hover:text-foreground hover:bg-black/[0.05] dark:hover:bg-white/[0.07]'
                                  }`}
                                  title={
                                    isLocked
                                      ? 'Unlock cap for auto-fit'
                                      : 'Lock cap to protect from auto-fit'
                                  }
                                >
                                  {isLocked ? (
                                    <Lock className="h-3.5 w-3.5" />
                                  ) : (
                                    <Unlock className="h-3.5 w-3.5" />
                                  )}
                                </button>

                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingCategory(row.category);
                                    setCategoryCapInput(String(row.cap));
                                  }}
                                  className="h-7 w-7 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-black/[0.05] dark:hover:bg-white/[0.07] transition-colors cursor-pointer"
                                  title="Edit category cap"
                                >
                                  <Edit2 className="h-3.5 w-3.5" />
                                </button>
                              </>
                            ) : (
                              <div className="flex items-center gap-1.5">
                                <span className="text-[11px] font-mono text-muted-foreground">RM</span>
                                <input
                                  type="number"
                                  value={categoryCapInput}
                                  onChange={(e) => setCategoryCapInput(e.target.value)}
                                  autoFocus
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleSaveCategoryCap(row.category);
                                    if (e.key === 'Escape') setEditingCategory(null);
                                  }}
                                  className="w-20 rounded-lg border border-black/[0.14] dark:border-white/[0.18] bg-background px-2 py-1 text-xs font-mono text-foreground outline-none focus:border-emerald-600"
                                />
                                <button
                                  type="button"
                                  onClick={() => handleSaveCategoryCap(row.category)}
                                  className="h-7 w-7 rounded-lg bg-[#0D6E52] dark:bg-emerald-600 text-white flex items-center justify-center cursor-pointer"
                                  aria-label="Save cap"
                                >
                                  <Check className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditingCategory(null)}
                                  className="h-7 w-7 rounded-lg bg-black/[0.05] dark:bg-white/[0.07] text-muted-foreground flex items-center justify-center cursor-pointer"
                                  aria-label="Cancel cap edit"
                                >
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            )}
                          </div>
                        </div>

                        {/* 2-Segment Fluid Meter */}
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.08] flex">
                          <div
                            className={`h-full transition-all duration-500 ${
                              row.isOverCap
                                ? 'bg-rose-500'
                                : row.spentPercent > 75
                                ? 'bg-amber-400'
                                : 'bg-[#0D6E52] dark:bg-emerald-500'
                            }`}
                            style={{ width: `${Math.min(row.spentPercent, 100)}%` }}
                          />
                          {row.unpaidBillReserve > 0 && row.cap > 0 && (
                            <div
                              className="h-full bg-amber-400/85 border-l border-white/25 transition-all duration-500"
                              style={{
                                width: `${Math.min(
                                  row.reservePercent,
                                  Math.max(0, 100 - row.spentPercent)
                                )}%`,
                                backgroundImage:
                                  'repeating-linear-gradient(45deg,transparent,transparent 3px,rgba(0,0,0,0.18) 3px,rgba(0,0,0,0.18) 6px)',
                              }}
                              title={`Reserved for upcoming bills: RM ${row.unpaidBillReserve.toFixed(2)}`}
                            />
                          )}
                        </div>

                        {row.unpaidBillReserve > 0 && (
                          <div className="rounded-xl bg-amber-500/[0.08] px-3 py-1.5 text-[11px] text-amber-900 dark:text-amber-200 flex flex-wrap items-center justify-between gap-2">
                            <span>
                              Reserved <strong className="font-mono">RM{'\u00A0'}{row.unpaidBillReserve.toFixed(2)}</strong>
                              {row.unpaidBills && row.unpaidBills.length > 0 && (
                                <span className="opacity-75">
                                  {' '}({row.unpaidBills.map((b) => `${b.name} RM ${b.amount.toFixed(0)}`).join(', ')})
                                </span>
                              )}
                            </span>
                            <span className="font-mono">
                              Free: <strong>RM{'\u00A0'}{row.unreservedRemaining.toFixed(2)}</strong>
                            </span>
                          </div>
                        )}

                        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                          <span>
                            {row.isOverCap ? (
                              <span className="text-rose-700 dark:text-rose-400 font-semibold font-mono">
                                Over cap by RM{'\u00A0'}
                                {Math.max(0, row.spent + row.unpaidBillReserve - row.cap).toFixed(2)}
                              </span>
                            ) : (
                              <span>
                                Left:{' '}
                                <strong className="text-foreground font-mono">
                                  RM{'\u00A0'}{row.unreservedRemaining.toFixed(2)}
                                </strong>
                              </span>
                            )}
                          </span>

                          {row.isDailyCategory ? (
                            <span className="font-mono">
                              Pace:{' '}
                              <strong
                                className={
                                  row.isOverCap
                                    ? 'text-rose-700 dark:text-rose-400'
                                    : 'text-emerald-700 dark:text-emerald-400'
                                }
                              >
                                RM{'\u00A0'}{row.dailyAllowance.toFixed(2)}/day
                              </strong>
                            </span>
                          ) : (
                            <span className="text-[11px]">Monthly bucket</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </motion.div>
        )}

        {activeWorkspace === 'forecast' && (
          <motion.div
            key="workspace-forecast"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            className="space-y-6"
          >
            {/* Month-End Savings & Investment Predictor */}
            <section className="rounded-3xl border border-black/[0.07] dark:border-white/[0.08] bg-card overflow-hidden">
              <div className="p-5 sm:p-6 border-b border-black/[0.07] dark:border-white/[0.08] flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="h-10 w-10 rounded-2xl bg-emerald-500/12 text-emerald-700 dark:text-emerald-400 flex items-center justify-center shrink-0">
                    <TrendingUp className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="text-sm sm:text-base font-semibold text-foreground">
                        Month-End Savings & Investment Forecast
                        {isYearMode || isAllTimeMode ? ` (${formatMonthLabel(currentMonthStr)})` : ''}
                      </h2>
                      <span
                        className={`text-[10px] font-semibold px-2.5 py-0.5 rounded-full ${
                          savingsPrediction.pacingStatus === 'ahead_of_target'
                            ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                            : savingsPrediction.pacingStatus === 'on_track'
                            ? 'bg-blue-500/15 text-blue-700 dark:text-blue-300'
                            : savingsPrediction.pacingStatus === 'risk_of_under_saving'
                            ? 'bg-amber-500/15 text-amber-800 dark:text-amber-300'
                            : 'bg-rose-500/15 text-rose-700 dark:text-rose-400'
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
                    <p className="text-xs text-muted-foreground mt-0.5 font-mono">
                      Living burn RM{'\u00A0'}{savingsPrediction.currentDailySpend.toFixed(2)}/day
                      {savingsPrediction.lumpSumSpent > 0
                        ? ` · Lump sum RM ${savingsPrediction.lumpSumSpent.toFixed(0)}`
                        : ''}
                      {' '}· {savingsPrediction.daysPassed}d passed, {savingsPrediction.daysRemaining}d left
                    </p>
                  </div>
                </div>

                <div className="text-left sm:text-right">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground block">
                    Baseline Income
                  </span>
                  <span className="font-mono text-sm font-bold text-foreground">
                    RM{'\u00A0'}{savingsPrediction.baselineIncome.toLocaleString()}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-black/[0.06] dark:divide-white/[0.06]">
                <div className="p-5 sm:p-6 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Predicted Savings
                    </span>
                    <span className="text-[11px] font-mono font-semibold text-emerald-700 dark:text-emerald-400">
                      {savingsPrediction.predictedSavingsPct}%
                    </span>
                  </div>
                  <div className="text-2xl sm:text-3xl font-bold font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
                    RM{'\u00A0'}{savingsPrediction.predictedSavingsAmount.toLocaleString()}
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-[11px] text-muted-foreground font-mono">
                      <span>
                        Goal {savingsPrediction.savingsTargetPct}% (RM{'\u00A0'}
                        {savingsPrediction.targetSavingsAmount.toLocaleString()})
                      </span>
                      <span>
                        {(
                          (savingsPrediction.predictedSavingsAmount /
                            (savingsPrediction.targetSavingsAmount || 1)) *
                          100
                        ).toFixed(0)}
                        %
                      </span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-black/[0.06] dark:bg-white/[0.08] overflow-hidden">
                      <div
                        className="h-full rounded-full bg-emerald-500 transition-all duration-500"
                        style={{
                          width: `${Math.min(
                            100,
                            (savingsPrediction.predictedSavingsAmount /
                              (savingsPrediction.targetSavingsAmount || 1)) *
                              100
                          )}%`,
                        }}
                      />
                    </div>
                  </div>
                </div>

                <div className="p-5 sm:p-6 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Predicted Investments
                    </span>
                    <span className="text-[11px] font-mono font-semibold text-teal-700 dark:text-teal-400">
                      {savingsPrediction.predictedInvestmentPct}%
                    </span>
                  </div>
                  <div className="text-2xl sm:text-3xl font-bold font-mono tabular-nums text-foreground">
                    RM{'\u00A0'}{savingsPrediction.predictedInvestmentAmount.toLocaleString()}
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-[11px] text-muted-foreground font-mono">
                      <span>
                        Goal {savingsPrediction.investmentTargetPct}% (RM{'\u00A0'}
                        {savingsPrediction.targetInvestmentAmount.toLocaleString()})
                      </span>
                      <span>
                        {(
                          (savingsPrediction.predictedInvestmentAmount /
                            (savingsPrediction.targetInvestmentAmount || 1)) *
                          100
                        ).toFixed(0)}
                        %
                      </span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-black/[0.06] dark:bg-white/[0.08] overflow-hidden">
                      <div
                        className="h-full rounded-full bg-[#0D6E52] dark:bg-teal-400 transition-all duration-500"
                        style={{
                          width: `${Math.min(
                            100,
                            (savingsPrediction.predictedInvestmentAmount /
                              (savingsPrediction.targetInvestmentAmount || 1)) *
                              100
                          )}%`,
                        }}
                      />
                    </div>
                  </div>
                </div>

                <div className="p-5 sm:p-6 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Projected Living
                    </span>
                    <span className="text-[11px] font-mono text-muted-foreground">
                      Cap RM{'\u00A0'}{savingsPrediction.targetLivingBudget.toLocaleString()}
                    </span>
                  </div>
                  <div
                    className={`text-2xl sm:text-3xl font-bold font-mono tabular-nums ${
                      savingsPrediction.projectedTotalSpend > savingsPrediction.targetLivingBudget
                        ? 'text-rose-700 dark:text-rose-400'
                        : 'text-foreground'
                    }`}
                  >
                    RM{'\u00A0'}{savingsPrediction.projectedTotalSpend.toLocaleString()}
                  </div>
                  <p className="text-[11px] font-mono text-muted-foreground">
                    Safe pace:{' '}
                    <strong className="text-emerald-700 dark:text-emerald-400">
                      RM{'\u00A0'}{savingsPrediction.safeDailyLivingAllowance.toFixed(2)}/day
                    </strong>
                  </p>
                </div>
              </div>

              <div className="px-5 sm:px-6 py-3.5 bg-emerald-500/[0.05] border-t border-black/[0.06] dark:border-white/[0.06] flex items-start gap-2.5 text-xs text-foreground leading-relaxed">
                <Sparkles className="h-4 w-4 text-emerald-700 dark:text-emerald-400 shrink-0 mt-0.5" />
                <span>{savingsPrediction.insightMessage}</span>
              </div>
            </section>

            {/* Payday Cycle & Savings Shield */}
            <section className="rounded-3xl border border-black/[0.07] dark:border-white/[0.08] bg-card overflow-hidden">
              <div className="p-5 sm:p-6 border-b border-black/[0.07] dark:border-white/[0.08] flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="h-10 w-10 rounded-2xl bg-amber-500/12 text-amber-700 dark:text-amber-400 flex items-center justify-center shrink-0">
                    <ShieldCheck className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="text-sm sm:text-base font-semibold text-foreground">
                        Payday Cycle & Savings Shield
                      </h2>
                      <span
                        className={`text-[10px] font-semibold px-2.5 py-0.5 rounded-full ${
                          paydayInfo.cyclePhase === 'living_phase'
                            ? 'bg-amber-500/15 text-amber-800 dark:text-amber-300'
                            : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                        }`}
                      >
                        {paydayInfo.cyclePhase === 'living_phase'
                          ? 'Living Phase'
                          : 'Payday Settlement'}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">{paydayInfo.headline}</p>
                  </div>
                </div>

                <div className="text-left sm:text-right">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground block">
                    Payday Anchor
                  </span>
                  <span className="font-mono text-sm font-semibold text-foreground">
                    {paydayInfo.paydayDay}th of month
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-black/[0.06] dark:divide-white/[0.06]">
                <div className="p-5 sm:p-6 space-y-3">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-foreground">
                      Pre-Quarantined Savings ({paydayInfo.savingsTargetPct + paydayInfo.investmentTargetPct}%)
                    </span>
                    <span className="font-mono font-bold text-foreground">
                      RM{'\u00A0'}{paydayInfo.preQuarantinedSavings.toLocaleString()}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Ring-fenced from Day 1 so your living allowance stays steady without end-of-month cliffs.
                  </p>
                  <div className="space-y-1.5 pt-1">
                    <div className="flex items-center justify-between text-[11px] font-mono text-muted-foreground">
                      <span>Fulfilled this month</span>
                      <span className="font-semibold text-foreground">
                        RM{'\u00A0'}{paydayInfo.actualSavedThisMonth.toLocaleString()} ({paydayInfo.savingsProgressPct}%)
                      </span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-black/[0.06] dark:bg-white/[0.08] overflow-hidden">
                      <div
                        className="h-full rounded-full bg-[#B8862D] dark:bg-amber-400 transition-all duration-500"
                        style={{ width: `${paydayInfo.savingsProgressPct}%` }}
                      />
                    </div>
                  </div>
                </div>

                <div className="p-5 sm:p-6 space-y-3">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-foreground inline-flex items-center gap-1.5">
                      <Wallet className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-400" />
                      Protected Living Pool
                    </span>
                    <span className="font-mono font-bold text-foreground">
                      RM{'\u00A0'}{paydayInfo.targetLivingBudget.toLocaleString()}/mo
                    </span>
                  </div>
                  <div className="flex items-baseline gap-2 pt-1">
                    <span className="text-2xl sm:text-3xl font-bold font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
                      RM{'\u00A0'}{paydayInfo.dailyLivingAllowance.toFixed(2)}
                    </span>
                    <span className="text-xs font-mono text-muted-foreground">
                      / day · {paydayInfo.daysRemainingInMonth}d left
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed flex items-start gap-2">
                    <Info className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-400 shrink-0 mt-0.5" />
                    <span>{paydayInfo.detail}</span>
                  </p>
                </div>
              </div>

              {tripSummaries.length > 0 && (
                <div className="p-5 sm:p-6 border-t border-black/[0.07] dark:border-white/[0.08] space-y-3">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground inline-flex items-center gap-1.5">
                      <Plane className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-400" />
                      Active Trip Envelopes
                    </h3>
                    <span className="text-[11px] text-muted-foreground">
                      Quarantined from domestic daily limits
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {tripSummaries.map((ts) => (
                      <div
                        key={ts.tripTag}
                        className="rounded-2xl border border-black/[0.07] dark:border-white/[0.08] bg-background p-4 space-y-2"
                      >
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-semibold text-foreground">{ts.tripTag}</span>
                          <span
                            className={`text-[10px] font-mono font-semibold px-2 py-0.5 rounded-full ${
                              ts.isOverBudget
                                ? 'bg-rose-500/15 text-rose-700 dark:text-rose-400'
                                : 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400'
                            }`}
                          >
                            {ts.isOverBudget ? 'Over' : `${ts.spentPercent}%`}
                          </span>
                        </div>
                        <div className="flex items-baseline justify-between text-xs font-mono">
                          <span className="text-muted-foreground">
                            {ts.currency} {ts.spentNative.toLocaleString()}
                          </span>
                          <span className="font-semibold text-foreground">
                            Cap {ts.currency} {ts.budgetAmount.toLocaleString()}
                          </span>
                        </div>
                        <div className="h-1.5 w-full rounded-full bg-black/[0.06] dark:bg-white/[0.08] overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${
                              ts.isOverBudget
                                ? 'bg-rose-500'
                                : 'bg-[#0D6E52] dark:bg-emerald-500'
                            }`}
                            style={{ width: `${Math.min(100, ts.spentPercent)}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>
          </motion.div>
        )}

        {activeWorkspace === 'commitments' && (
          <motion.div
            key="workspace-commitments"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            className="space-y-6"
          >
            <InstallmentDashboard />
            <RecurringCommitments />
          </motion.div>
        )}
      </AnimatePresence>

      {/* AI Auto-Tune Caps Modal */}
      <AnimatePresence>
        {isAutoTuneOpen && (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsAutoTuneOpen(false)}
              className="fixed inset-0 bg-black/60 backdrop-blur-sm"
            />

            <motion.div
              role="dialog"
              aria-modal="true"
              aria-labelledby="ai-autotune-title"
              initial={{ opacity: 0, y: 24, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 16, scale: 0.98 }}
              transition={{ type: 'spring', stiffness: 420, damping: 34 }}
              className="relative z-10 w-full max-w-2xl max-h-[90dvh] flex flex-col rounded-t-3xl sm:rounded-3xl border border-black/[0.1] dark:border-white/[0.12] bg-white dark:bg-zinc-950 shadow-2xl overflow-hidden"
            >
              <div className="px-6 py-5 border-b border-black/[0.07] dark:border-white/[0.08] flex items-center justify-between gap-3 shrink-0">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-2xl bg-emerald-500/12 text-emerald-700 dark:text-emerald-400 flex items-center justify-center shrink-0">
                    <SlidersHorizontal className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 id="ai-autotune-title" className="text-base font-semibold text-foreground">
                      AI Intelligent Category Caps
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      Calibrated from your spending history & savings target
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setIsAutoTuneOpen(false)}
                  className="h-9 w-9 rounded-xl text-muted-foreground hover:text-foreground hover:bg-black/[0.05] dark:hover:bg-white/[0.07] flex items-center justify-center cursor-pointer transition-colors"
                  aria-label="Close AI Auto-Tune dialog"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
                <div className="rounded-2xl bg-emerald-500/[0.07] border border-emerald-500/20 p-4 space-y-1.5 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2 font-semibold">
                    <span className="text-emerald-800 dark:text-emerald-300">
                      Savings Shield Equation
                    </span>
                    <span className="font-mono text-foreground">
                      RM{'\u00A0'}{intelligentPlan.baselineIncome.toLocaleString()} − RM{'\u00A0'}
                      {intelligentPlan.targetSavingsAmount.toLocaleString()} ={' '}
                      <strong className="text-emerald-700 dark:text-emerald-400">
                        RM{'\u00A0'}{intelligentPlan.targetLivingBudget.toLocaleString()} pool
                      </strong>
                    </span>
                  </div>
                  <p className="text-muted-foreground leading-relaxed">
                    {intelligentPlan.summaryInsight}
                  </p>
                </div>

                <div className="rounded-2xl border border-black/[0.07] dark:border-white/[0.08] divide-y divide-black/[0.06] dark:divide-white/[0.06] overflow-hidden">
                  {intelligentPlan.suggestions.map((s) => {
                    const currentVal = customCapsDraft[s.category] ?? s.suggestedCap;
                    const isLocked = Boolean(lockedCategories[s.category]);
                    return (
                      <div
                        key={s.category}
                        className="p-4 flex flex-wrap items-center justify-between gap-3 bg-card"
                      >
                        <div className="space-y-1 min-w-[200px] flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-foreground">
                              {s.category}
                            </span>
                            <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-black/[0.05] dark:bg-white/[0.07] text-muted-foreground">
                              {s.natureLabel}
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground leading-relaxed">
                            {s.reasoning}
                          </p>
                          {s.historicalAvg > 0 && (
                            <span className="text-[11px] font-mono text-muted-foreground/80 block">
                              Avg RM{'\u00A0'}{s.historicalAvg.toFixed(2)}/mo
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            onClick={() => toggleLockCategory(s.category)}
                            className={`h-8 w-8 rounded-lg flex items-center justify-center transition-colors cursor-pointer ${
                              isLocked
                                ? 'text-amber-600 dark:text-amber-400 bg-amber-500/15'
                                : 'text-muted-foreground hover:text-foreground hover:bg-black/[0.05] dark:hover:bg-white/[0.07]'
                            }`}
                            title={isLocked ? 'Unlock category cap' : 'Lock category cap'}
                          >
                            {isLocked ? (
                              <Lock className="h-3.5 w-3.5" />
                            ) : (
                              <Unlock className="h-3.5 w-3.5" />
                            )}
                          </button>

                          <div className="relative">
                            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[11px] font-mono text-muted-foreground">
                              RM
                            </span>
                            <input
                              type="number"
                              value={currentVal}
                              onChange={(e) => {
                                const val = parseFloat(e.target.value) || 0;
                                setCustomCapsDraft((prev) => ({ ...prev, [s.category]: val }));
                              }}
                              className="w-28 rounded-xl border border-black/[0.12] dark:border-white/[0.15] bg-background pl-8 pr-2.5 py-1.5 text-xs font-mono font-semibold text-right text-foreground outline-none focus:border-emerald-600"
                            />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="px-6 py-4 border-t border-black/[0.07] dark:border-white/[0.08] bg-card flex flex-wrap items-center justify-between gap-3 shrink-0">
                <div className="text-xs space-y-0.5">
                  <div className="flex items-center gap-2 font-mono">
                    <span
                      className={`font-bold text-sm ${
                        isDraftSumExceeded
                          ? 'text-rose-600 dark:text-rose-400'
                          : 'text-foreground'
                      }`}
                    >
                      RM{'\u00A0'}{draftSum.toLocaleString()}
                    </span>
                    <span className="text-muted-foreground">
                      / RM{'\u00A0'}{maxLivingBudget.toLocaleString()} limit
                    </span>
                  </div>
                  {isDraftSumExceeded ? (
                    <button
                      type="button"
                      onClick={handleAutoFitDraft}
                      className="text-[11px] font-semibold text-rose-600 dark:text-rose-400 hover:underline cursor-pointer"
                    >
                      Over by RM{'\u00A0'}{(draftSum - maxLivingBudget).toLocaleString()} — click to Auto-Fit
                    </button>
                  ) : (
                    <span className="text-[11px] text-emerald-700 dark:text-emerald-400">
                      Savings target fully protected
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setIsAutoTuneOpen(false)}
                    className="px-4 py-2 rounded-xl text-xs font-semibold text-muted-foreground hover:text-foreground hover:bg-black/[0.05] dark:hover:bg-white/[0.07] cursor-pointer transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleApplySmartCaps}
                    className="inline-flex items-center gap-1.5 px-5 py-2 rounded-xl bg-[#0D6E52] hover:bg-[#0A5740] dark:bg-emerald-600 dark:hover:bg-emerald-500 text-white text-xs font-semibold cursor-pointer active:scale-[0.98] transition-all"
                  >
                    <Check className="h-4 w-4" />
                    <span>Apply Smart Caps</span>
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
