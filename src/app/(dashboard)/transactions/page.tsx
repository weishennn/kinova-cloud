"use client"

import { useState, useMemo, useEffect } from "react"
import { motion, AnimatePresence } from "framer-motion"
import {
  Search,
  ArrowDownRight,
  ArrowUpRight,
  TrendingUp,
  Receipt,
  Trash2,
  Edit2,
  Inbox,
  ChevronLeft,
  ChevronRight,
  Calendar,
  CreditCard,
  RotateCcw,
  X
} from "lucide-react"
import { useTransactions, useDeleteTransaction, type Transaction } from "@/hooks/useTransactions"
import { useMonthList } from "@/hooks/useSheets"
import { useAppStore } from "@/stores/app-store"
import { TransactionDetailModal } from "@/components/shared/transaction-detail-modal"
import { SmartQuickInput } from "@/components/shared/smart-quick-input"
import { toast } from "sonner"
import { confirmAction } from "@/stores/confirm-dialog-store"
import { getAmountInBaseCurrency } from "@/lib/currency"
import { getLocalDateString, getRelativeDateString, getTransactionRecordedInfo, parseLocalDate } from "@/lib/date-helper"
import { getTransactionTaxRelief } from "@/lib/lhdn-tax-helper"
import { buildPeriodCatalog, formatPeriodDisplay, stepPeriod } from "@/lib/period-helper"
import { normalizeToCanonicalCategory } from "@/lib/canonical-categories"
import { AnimatedNumber } from "@/components/shared/animated-number"
import { CockpitPageHeading } from "@/components/money-cockpit/cockpit-page-heading"

interface DayGroup {
  date: string;
  title: string;
  weekday: string;
  formattedDate: string;
  isToday: boolean;
  isYesterday: boolean;
  totalExpense: number;
  totalIncome: number;
  transactions: Transaction[];
}

export default function TransactionsPage() {
  const { setQuickAddOpen, setEditTransaction, selectedMonth, setSelectedMonth } = useAppStore()
  const [filterType, setFilterType] = useState<'all' | 'expense' | 'income' | 'investment' | 'tax'>('all')
  const [filterCategory, setFilterCategory] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedTx, setSelectedTx] = useState<Transaction | null>(null)

  useEffect(() => {
    const syncParamsFromUrl = () => {
      if (typeof window === 'undefined') return;
      const params = new URLSearchParams(window.location.search);
      const typeParam = params.get('type')?.toLowerCase();
      if (typeParam === 'investment' || typeParam === 'expense' || typeParam === 'income' || typeParam === 'tax') {
        setFilterType(typeParam as any);
      }
      const categoryParam = params.get('category');
      if (categoryParam && categoryParam.trim()) {
        setFilterCategory(categoryParam.trim());
        if (!typeParam) setFilterType('expense');
      } else {
        setFilterCategory(null);
      }
    };
    syncParamsFromUrl();
    window.addEventListener('popstate', syncParamsFromUrl);
    return () => window.removeEventListener('popstate', syncParamsFromUrl);
  }, []);

  const { data: months = [] } = useMonthList()
  const { transactions = [], isLoading } = useTransactions(selectedMonth ? { period: selectedMonth } : undefined)
  const deleteMutation = useDeleteTransaction()

  const { currentMonth: currentMonthStr, currentMonthShort, currentYearStr, orderedYears: availableYears, months: catalogMonths } = useMemo(
    () => buildPeriodCatalog(months, selectedMonth, transactions),
    [months, selectedMonth, transactions]
  );

  const monthsByYear = useMemo(() => {
    const byYear: Record<string, string[]> = {};
    catalogMonths.forEach((m) => {
      const y = m.substring(0, 4);
      if (!byYear[y]) byYear[y] = [];
      byYear[y].push(m);
    });
    return byYear;
  }, [catalogMonths]);

  const currentMonthName = formatPeriodDisplay(currentMonthStr);
  const formatPeriodLabel = (pStr: string) => formatPeriodDisplay(pStr);

  // Filter transactions
  const filteredTransactions = useMemo(() => {
    return transactions.filter(t => {
      // Filter out starter placeholder
      if (t.id === 'tx_sample') return false;

      // Filter by type or LHDN tax relief
      if (filterType === 'tax') {
        if (!getTransactionTaxRelief(t)) return false;
      } else if (filterType !== 'all' && t.type !== filterType) {
        return false;
      }

      // Filter by explicit category pill (?category=...)
      if (filterCategory) {
        const canonical = normalizeToCanonicalCategory(
          t.category || 'Other',
          t.type === 'income' ? 'Income' : 'Expense',
          t.description
        );
        const targetLower = filterCategory.toLowerCase();
        if (
          canonical.toLowerCase() !== targetLower &&
          String(t.category || '').toLowerCase() !== targetLower
        ) {
          return false;
        }
      }

      // Filter by month/period
      if (selectedMonth && selectedMonth !== 'all') {
        if (selectedMonth.startsWith('year-')) {
          const y = selectedMonth.replace('year-', '');
          if (!t.date || !t.date.startsWith(y)) return false;
        } else if (!t.date || !t.date.startsWith(selectedMonth)) {
          return false;
        }
      }

      // Filter by search query
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        const desc = (t.description || '').toLowerCase();
        const cat = (t.category || '').toLowerCase();
        const acc = (t.account || '').toLowerCase();
        const notes = (t.notes || '').toLowerCase();
        return desc.includes(query) || cat.includes(query) || acc.includes(query) || notes.includes(query);
      }

      return true;
    });
  }, [transactions, filterType, filterCategory, selectedMonth, searchQuery]);

  // Group filtered transactions by day with daily totals
  const dayGroups = useMemo<DayGroup[]>(() => {
    const todayStr = getLocalDateString();
    const yesterdayStr = getRelativeDateString(-1);

    const map = new Map<string, Transaction[]>();

    filteredTransactions.forEach((t) => {
      const d = t.date || 'Unknown';
      if (!map.has(d)) {
        map.set(d, []);
      }
      map.get(d)!.push(t);
    });

    const groups: DayGroup[] = [];
    const sortedDates = Array.from(map.keys()).sort((a, b) => b.localeCompare(a));

    sortedDates.forEach((dateKey) => {
      const txs = map.get(dateKey)!;
      let totalExpense = 0;
      let totalIncome = 0;

      txs.forEach((t) => {
        const baseAmount = getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount);
        if (t.type === 'expense') totalExpense += baseAmount;
        if (t.type === 'income') totalIncome += baseAmount;
      });

      const isToday = dateKey === todayStr;
      const isYesterday = dateKey === yesterdayStr;

      let title = dateKey;
      let weekday = '';
      let formattedDate = dateKey;

      if (dateKey !== 'Unknown') {
        const parsed = parseLocalDate(dateKey);
        weekday = parsed.toLocaleDateString('en-US', { weekday: 'long' });
        formattedDate = parsed.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
        if (isToday) {
          title = 'Today';
        } else if (isYesterday) {
          title = 'Yesterday';
        } else {
          title = `${parsed.toLocaleDateString('en-US', { weekday: 'short' })}, ${parsed.toLocaleDateString('en-US', { day: 'numeric', month: 'short' })}`;
        }
      }

      groups.push({
        date: dateKey,
        title,
        weekday,
        formattedDate,
        isToday,
        isYesterday,
        totalExpense,
        totalIncome,
        transactions: txs,
      });
    });

    return groups;
  }, [filteredTransactions]);

  // Dynamic summary reflecting the active filters & selected month
  const displaySummary = useMemo(() => {
    let income = 0;
    let expense = 0;
    let investedBuys = 0;
    let investedSells = 0;
    let savingsDeposits = 0;
    filteredTransactions.forEach(t => {
      const baseAmount = getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount);
      const isTrade = String(t.id || '').startsWith('tx_trade_') ||
        t.category === 'Stocks & Crypto' ||
        t.subCategory?.toUpperCase() === 'SELL' ||
        t.subCategory?.toUpperCase() === 'BUY' ||
        /^(SELL|BUY)\s+[0-9]/i.test(t.description || '');
      if (t.type === 'income' && !isTrade) income += baseAmount;
      if (t.type === 'expense') expense += baseAmount;
      if (t.type === 'investment' || isTrade) {
        const isCashSavings = t.category === 'Emergency Savings' || t.category === 'Fixed Deposit' || t.category === 'Other Savings';
        if (isCashSavings) {
          savingsDeposits += baseAmount;
        } else {
          const isSell = t.subCategory?.toUpperCase() === 'SELL' || /^(SELL)\b/i.test(t.description || '');
          if (isSell) {
            investedSells += baseAmount;
          } else {
            investedBuys += baseAmount;
          }
        }
      }
    });
    return {
      totalIncome: income,
      totalExpense: expense,
      totalInvested: investedBuys - investedSells,
      investedBuys,
      investedSells,
      savingsDeposits,
      balance: income - expense
    };
  }, [filteredTransactions]);

  const changePeriod = (direction: -1 | 1) => {
    setSelectedMonth(stepPeriod(selectedMonth, direction, currentMonthStr));
  };

  const handleDelete = async (t: Transaction, index?: number) => {
    const ok = await confirmAction({
      title: 'Delete Transaction?',
      description: `Are you sure you want to delete "${t.description || t.category}" (${t.currency || 'MYR'} ${t.amount.toFixed(2)})? This action cannot be undone.`,
      confirmText: 'Delete',
      cancelText: 'Cancel',
      variant: 'danger',
      icon: 'trash',
    });
    if (!ok) return;

    const targetSheet = t._month || (t.date ? t.date.substring(0, 7) : 'Transactions');
    if (selectedTx?.id === t.id) {
      setSelectedTx(null);
    }
    toast.success('Transaction deleted');
    deleteMutation.mutate(
      {
        id: t.id,
        sheetName: targetSheet,
        rowIndex: t._rowIndex || (index !== undefined ? index + 2 : 2)
      },
      {
        onError: () => {
          toast.error('Failed to delete transaction');
        }
      }
    );
  };

  const openEdit = (t: Transaction) => {
    setSelectedTx(null);
    setEditTransaction(t as unknown as Record<string, unknown>);
    setQuickAddOpen(true);
  };

  // Reusable transaction card
  const renderTransactionCard = (t: Transaction, keyId: string | number, isGrouped: boolean = true) => {
    const isIncome = t.type === 'income';
    const isInvestment = t.type === 'investment';
    const isSell = isInvestment && (t.subCategory?.toUpperCase() === 'SELL' || /^(SELL)\b/i.test(t.description || ''));
    const isTrixpense = String(t.id || '').startsWith('trixpense_');
    const isInst = Boolean(t.description?.includes('(Installment') || t.notes?.includes('[Installment Plan'));
    const instMatch = t.description?.match(/Installment\s*(\d+\/\d+)/i) || t.notes?.match(/Installment\s*Plan\s*(\d+\/\d+)/i);
    const taxCat = getTransactionTaxRelief(t);

    return (
      <motion.div
        key={keyId}
        role="button"
        tabIndex={0}
        aria-label={`View transaction ${t.description || t.category}, ${t.type} RM ${t.amount.toFixed(2)}`}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setSelectedTx(t);
          }
        }}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        whileHover={{ y: -1, scale: 1.002 }}
        whileTap={{ scale: 0.99 }}
        transition={{ type: 'spring' as const, stiffness: 400, damping: 25 }}
        onClick={() => setSelectedTx(t)}
        className={`flex cursor-pointer items-center justify-between p-3.5 sm:p-4 rounded-2xl border transition-all group shadow-[0_1px_2px_rgba(17,20,24,0.03)] focus-visible:ring-2 focus-visible:ring-emerald-500 ${
          isIncome || isSell
            ? 'border-black/[0.07] dark:border-white/[0.07] bg-card hover:border-emerald-500/40'
            : isInvestment
            ? 'border-black/[0.07] dark:border-white/[0.07] bg-card hover:border-amber-500/40'
            : isInst
            ? 'border-black/[0.07] dark:border-white/[0.07] bg-card hover:border-amber-500/40'
            : 'border-black/[0.07] dark:border-white/[0.07] bg-card hover:border-rose-500/35'
        }`}
      >
        {/* Left: Icon */}
        <div className="flex items-center gap-3.5 min-w-0 flex-1">
          <div className={`flex h-10 w-10 sm:h-11 sm:w-11 shrink-0 items-center justify-center rounded-xl border ${
            isIncome || isSell
              ? 'bg-emerald-500/12 text-emerald-800 dark:text-emerald-400 border-emerald-500/25'
              : isInvestment
              ? 'bg-amber-500/12 text-amber-800 dark:text-amber-400 border-amber-500/25'
              : isInst
              ? 'bg-amber-500/12 text-amber-800 dark:text-amber-300 border-amber-500/25'
              : 'bg-rose-500/12 text-rose-800 dark:text-rose-400 border-rose-500/25'
          }`}>
            {isIncome || isSell ? <ArrowDownRight className="h-5 w-5" /> : isInvestment ? <TrendingUp className="h-5 w-5" /> : isInst ? <CreditCard className="h-5 w-5" /> : <ArrowUpRight className="h-5 w-5" />}
          </div>

          {/* Middle: Details */}
          <div className="min-w-0 flex-1 pr-2">
            <div className="flex items-center gap-2">
              <p className="font-semibold text-sm sm:text-base text-slate-900 dark:text-zinc-100 truncate group-hover:text-slate-950 dark:group-hover:text-white transition-colors">
                {t.description || t.category}
              </p>
              {isTrixpense && (
                <span className="shrink-0 inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-md bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border border-emerald-500/25 font-mono font-semibold">
                  🔗 Trixpense
                </span>
              )}
              {t.receiptUrl ? (
                <span className="shrink-0 inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-md bg-emerald-500/12 text-emerald-800 dark:text-emerald-300 border border-emerald-500/20 font-medium">
                  <Receipt className="h-3 w-3" />
                  <span className="hidden xs:inline">Receipt</span>
                </span>
              ) : taxCat ? (
                <span className="shrink-0 inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-md bg-amber-500/15 text-amber-800 dark:text-amber-300 border border-amber-500/30 font-semibold">
                  <span>⚠️ No Receipt</span>
                </span>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 mt-1 text-xs text-slate-600 dark:text-zinc-400">
              <span className="px-2 py-0.5 rounded-md bg-slate-100 dark:bg-zinc-800/80 text-[11px] font-semibold text-slate-800 dark:text-zinc-200 border border-slate-200 dark:border-white/[0.04]">
                {t.category}
              </span>
              {!isGrouped && (
                <span className="text-[11px] text-slate-600 dark:text-zinc-400">{t.date}</span>
              )}
              {(() => {
                const rec = getTransactionRecordedInfo(t);
                if (!rec) return null;
                return (
                  <span
                    className={`text-[10px] font-mono ${
                      rec.isDifferentDay
                        ? 'px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/20'
                        : 'text-slate-400 dark:text-zinc-500'
                    }`}
                  >
                    {rec.compactLabel}
                  </span>
                );
              })()}
              {taxCat && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border border-emerald-500/25 text-[11px] font-semibold">
                  🇲🇾 LHDN: {taxCat.shortName}
                </span>
              )}
              {isInst && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-500/12 text-amber-800 dark:text-amber-300 border border-amber-500/20 text-[11px] font-semibold">
                  {instMatch ? `Installment ${instMatch[1]}` : 'Installment'}
                </span>
              )}
              {t.account && t.account !== 'Cash' && t.account !== 'Default' && t.account !== '-' && !isTrixpense && (
                <span className="text-[11px] text-muted-foreground hidden xs:inline">• {t.account}</span>
              )}
              {t.tripTag && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-teal-500/12 text-teal-800 dark:text-teal-300 border border-teal-500/20 text-[11px] font-medium">
                  {t.tripTag}
                </span>
              )}
            </div>

            {t.notes && (
              <p className="text-[11px] text-slate-600 dark:text-zinc-400 italic truncate mt-1">
                "{t.notes}"
              </p>
            )}
          </div>
        </div>

        {/* Right: Amount & Actions */}
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          <div className="text-right">
            <div className={`text-sm sm:text-base font-bold font-mono tabular-nums whitespace-nowrap tracking-tight ${
              isIncome || isSell ? 'text-emerald-700 dark:text-emerald-400' : isInvestment ? 'text-amber-700 dark:text-amber-400' : isInst ? 'text-amber-700 dark:text-amber-300' : 'text-foreground'
            }`}>
              {isIncome || isSell ? '+' : '-'}{t.currency === 'USD' ? '$' : t.currency === 'CNY' ? '¥' : t.currency === 'SGD' ? 'S$' : ((t.currency === 'MYR' || !t.currency) ? 'RM\u00A0' : `${t.currency}\u00A0`)}{t.amount.toFixed(2)}
            </div>
            {t.currency && t.currency !== 'MYR' && (
              <div className="text-[10px] text-slate-600 dark:text-zinc-400 font-mono whitespace-nowrap tabular-nums mt-0.5">
                {t.notes && t.notes.includes('Cost: RM')
                  ? t.notes.match(/Cost:\s*RM\s*[\d.]+/)?.[0]?.replace('RM ', 'RM\u00A0')
                  : t.baseAmount && t.baseAmount > 0
                  ? `≈ RM\u00A0${t.baseAmount.toFixed(2)}`
                  : t.currency}
              </div>
            )}
          </div>

          {/* Desktop Quick Actions */}
          {!isTrixpense && (
            <div className="hidden sm:flex items-center gap-1">
              <button
                onClick={(e) => { e.stopPropagation(); openEdit(t); }}
                className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-xl text-muted-foreground hover:text-emerald-700 dark:hover:text-emerald-300 hover:bg-black/[0.05] dark:hover:bg-white/[0.06] transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-emerald-500"
                title="Edit transaction"
                aria-label={`Edit transaction ${t.description || t.category}`}
              >
                <Edit2 className="h-4 w-4" />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); void handleDelete(t); }}
                className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-xl text-slate-600 dark:text-zinc-400 hover:text-rose-800 dark:hover:text-rose-400 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-rose-400"
                title="Delete transaction"
                aria-label={`Delete transaction ${t.description || t.category}`}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          )}

          {/* Mobile tap affordance */}
          <ChevronRight className="h-4 w-4 text-slate-500 dark:text-zinc-400 group-hover:text-slate-700 dark:group-hover:text-zinc-300 transition-colors sm:hidden" />
        </div>
      </motion.div>
    );
  };

  return (
    <div className="cockpit-module-page">
      <CockpitPageHeading
        title="Transactions"
        description="View and manage your recorded expenses, incomes & investments"
      />

      {/* Smart Natural Language Quick-Input with Voice Dictation */}
      <SmartQuickInput />

      {/* Filter, Month and Search Toolbar */}
      <div className="space-y-3">
        {/* Row 1: Type Filter Chips + Optional Deep-Linked Category Chip */}
        <div className="flex flex-wrap items-center gap-2.5">
          {/* Type Filter Chips with animated sliding pill */}
          <div className="cockpit-segmented-control relative flex w-full sm:w-auto justify-between sm:justify-start rounded-2xl bg-white/90 dark:bg-zinc-950/80 p-1 border border-slate-200 dark:border-white/[0.08] shadow-sm overflow-x-auto no-scrollbar">
            {(['all', 'expense', 'income', 'investment', 'tax'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setFilterType(t)}
                className={`relative z-10 flex-1 sm:flex-initial min-h-[40px] px-2 sm:px-3.5 py-1.5 rounded-xl text-xs font-semibold capitalize transition-colors cursor-pointer touch-manipulation select-none active:scale-[0.96] whitespace-nowrap ${
                  filterType === t
                    ? 'text-emerald-800 dark:text-emerald-300'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {filterType === t && (
                  <motion.div
                    layoutId="tx-filter-pill"
                    className="cockpit-segmented-pill absolute inset-0 rounded-xl border pointer-events-none"
                    transition={{ type: 'spring' as const, stiffness: 450, damping: 32 }}
                  />
                )}
                <span className="relative z-10 pointer-events-none">
                  {t === 'tax' ? '🇲🇾 Tax' : t}
                </span>
              </button>
            ))}
          </div>

          {filterCategory && (
            <button
              type="button"
              onClick={() => {
                setFilterCategory(null);
                if (typeof window !== 'undefined') {
                  const url = new URL(window.location.href);
                  url.searchParams.delete('category');
                  window.history.replaceState({}, '', url.toString());
                }
              }}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-500/12 hover:bg-emerald-500/20 border border-emerald-500/25 text-emerald-800 dark:text-emerald-200 text-xs font-semibold transition-all cursor-pointer whitespace-nowrap"
              title="Clear category filter"
            >
              <span>Category: {filterCategory}</span>
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Row 2: Unified Period Tabs + Month Stepper (< >) + Search Field */}
        <div className="flex flex-col lg:flex-row items-stretch lg:items-center gap-2.5 sm:gap-3">
          <div className="cockpit-period-tabs shrink-0" role="group" aria-label="Period type">
            <button
              type="button"
              className={selectedMonth !== 'all' && !selectedMonth?.startsWith('year-') ? 'is-active' : ''}
              onClick={() => {
                if (selectedMonth?.startsWith('year-')) {
                  const yr = selectedMonth.slice(5);
                  setSelectedMonth(yr === currentYearStr ? currentMonthStr : `${yr}-01`);
                } else {
                  setSelectedMonth(currentMonthStr);
                }
              }}
            >
              Month
            </button>
            <button
              type="button"
              className={selectedMonth?.startsWith('year-') ? 'is-active' : ''}
              onClick={() => {
                const yr = /^\d{4}-\d{2}$/.test(selectedMonth || '') ? selectedMonth.slice(0, 4) : currentYearStr;
                setSelectedMonth(`year-${yr}`);
              }}
            >
              Year
            </button>
            <button
              type="button"
              className={selectedMonth === 'all' ? 'is-active' : ''}
              onClick={() => setSelectedMonth('all')}
            >
              All time
            </button>
          </div>

          {/* Month & Multi-Year Selector with < and > navigation */}
          <div className="cockpit-period-select-wrap">
            <div className="cockpit-period-arrows">
              <button
                type="button"
                onClick={() => changePeriod(-1)}
                className="cockpit-period-arrow"
                aria-label="Previous period"
                title="Previous period"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>

              <button
                type="button"
                onClick={() => changePeriod(1)}
                className="cockpit-period-arrow"
                aria-label="Next period"
                title="Next period"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>

            <select
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(e.target.value)}
              className="flex-1 sm:flex-initial h-11 min-w-[165px] rounded-xl border border-black/[0.08] dark:border-white/[0.08] bg-background px-3.5 py-2 text-base sm:text-xs font-mono text-foreground outline-none focus:border-emerald-600 cursor-pointer transition-colors"
              aria-label="Filter transactions by month or year"
            >
              {availableYears.map(year => {
                const curYStr = currentYearStr;
                const yLabel =
                  year === curYStr
                    ? `── ${year} (Current Year) ──`
                    : Number(year) === Number(curYStr) - 1
                    ? `── ${year} (Last Year) ──`
                    : Number(year) === Number(curYStr) + 1
                    ? `── ${year} (Next Year) ──`
                    : `── Year ${year} ──`;
                return (
                  <optgroup key={year} label={yLabel} className="bg-card text-emerald-700 dark:text-emerald-400 font-bold">
                    <option value={`year-${year}`} className="bg-card text-foreground font-mono font-semibold">
                      {year} full year
                    </option>
                    {monthsByYear[year]?.map(m => (
                      <option key={m} value={m} className="bg-card text-foreground font-mono">
                        {m === currentMonthStr ? `${formatPeriodLabel(m)} (Current)` : formatPeriodLabel(m)}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
              <option value="all" className="bg-card text-foreground font-mono">
                All time
              </option>
            </select>

            {selectedMonth !== currentMonthStr && (
              <button
                type="button"
                onClick={() => setSelectedMonth(currentMonthStr)}
                className="h-11 px-3 shrink-0 inline-flex items-center gap-1.5 justify-center rounded-xl border border-emerald-500/25 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300 text-xs font-semibold hover:bg-emerald-500/20 active:scale-[0.96] transition-all cursor-pointer touch-manipulation"
                title={`Jump back to current month (${currentMonthName})`}
                aria-label={`Jump back to current month (${currentMonthName})`}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{currentMonthShort} (Current)</span>
                <span className="sm:hidden">{currentMonthShort}</span>
              </button>
            )}
          </div>

          {/* Search Field (16px text-base on mobile to prevent iOS Safari auto-zoom) */}
          <div className="flex-1 relative min-w-[200px]">
            <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <input
              type="search"
              inputMode="search"
              enterKeyHint="search"
              placeholder="Search transactions, categories, notes..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full h-11 rounded-xl border border-black/[0.08] dark:border-white/[0.08] bg-background py-2.5 pl-10 pr-10 text-base sm:text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-emerald-600 focus:ring-2 focus:ring-emerald-500/15 transition-all"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 h-7 w-7 flex items-center justify-center rounded-lg text-slate-500 dark:text-zinc-400 hover:text-slate-800 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                aria-label="Clear search query"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Summary Bar */}
      {filterType === 'investment' ? (
        <div className="space-y-2">
          <div className="grid grid-cols-3 gap-2.5 rounded-[20px] border border-amber-500/25 bg-card p-4 shadow-[0_1px_2px_rgba(17,20,24,0.03)]">
            <div className="text-center">
              <span className="block text-xs font-semibold text-muted-foreground">Net Invested</span>
              <div className="text-base md:text-lg font-bold text-amber-700 dark:text-amber-400 font-mono tabular-nums mt-0.5">
                <AnimatedNumber value={displaySummary.totalInvested} animateOnMount />
              </div>
              <span className="block text-[10px] text-muted-foreground">Stocks & Assets</span>
            </div>
            <div className="text-center border-l border-black/[0.07] dark:border-white/[0.08]">
              <span className="block text-xs font-semibold text-muted-foreground">Total Purchases</span>
              <div className="text-base md:text-lg font-bold text-foreground font-mono tabular-nums mt-0.5">
                <AnimatedNumber value={displaySummary.investedBuys} animateOnMount />
              </div>
              <span className="block text-[10px] text-amber-700 dark:text-amber-400">BUY orders</span>
            </div>
            <div className="text-center border-l border-black/[0.07] dark:border-white/[0.08]">
              <span className="block text-xs font-semibold text-muted-foreground">Total Liquidated</span>
              <div className="text-base md:text-lg font-bold text-emerald-700 dark:text-emerald-400 font-mono tabular-nums mt-0.5">
                <AnimatedNumber value={displaySummary.investedSells} animateOnMount />
              </div>
              <span className="block text-[10px] text-emerald-600 dark:text-emerald-400">SELL proceeds</span>
            </div>
          </div>
          {displaySummary.savingsDeposits > 0 && (
            <div className="flex items-center justify-between px-3.5 py-2 rounded-xl bg-emerald-500/[0.08] border border-emerald-500/20 text-xs text-emerald-900 dark:text-emerald-300">
              <span className="font-medium">Separate Cash & Emergency Savings:</span>
              <span className="font-mono font-bold">RM{'\u00A0'}{displaySummary.savingsDeposits.toFixed(2)}</span>
            </div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-3 rounded-[20px] border border-black/[0.08] dark:border-white/[0.08] bg-card p-4 shadow-[0_1px_2px_rgba(17,20,24,0.03)]">
          <div className="text-center">
            <div className="min-w-0 px-1 text-xs leading-tight text-slate-700 dark:text-zinc-300 font-medium">
              <span className="block">Income</span>
            </div>
            <div className="text-base md:text-lg font-bold text-emerald-800 dark:text-emerald-400 font-mono tabular-nums mt-0.5">
              <AnimatedNumber value={displaySummary.totalIncome} animateOnMount />
            </div>
          </div>
          <div className="text-center border-l border-slate-200 dark:border-white/[0.08]">
            <div className="min-w-0 px-1 text-xs leading-tight text-slate-700 dark:text-zinc-300 font-medium">
              <span className="block">Expenses</span>
            </div>
            <div className="text-base md:text-lg font-bold text-rose-800 dark:text-rose-400 font-mono tabular-nums mt-0.5">
              <AnimatedNumber value={displaySummary.totalExpense} animateOnMount />
            </div>
          </div>
          <div className="text-center border-l border-slate-200 dark:border-white/[0.08]">
            <div className="min-w-0 px-1 text-xs leading-tight text-slate-700 dark:text-zinc-300 font-medium">
              <span className="block">Invested</span>
            </div>
            <div className="text-base md:text-lg font-bold text-amber-700 dark:text-amber-400 font-mono tabular-nums mt-0.5">
              <AnimatedNumber value={displaySummary.totalInvested} animateOnMount />
            </div>
          </div>
        </div>
      )}

      {/* Transaction List */}
      <div className="space-y-4">
        {isLoading ? (
          <div className="space-y-2.5" aria-live="polite" aria-label="Loading transactions">
            {[1, 2, 3].map((item) => (
              <div key={item} className="h-[78px] rounded-2xl border border-slate-200 dark:border-white/[0.06] bg-white/90 dark:bg-zinc-900/60 animate-pulse" />
            ))}
          </div>
        ) : filteredTransactions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center border border-dashed border-slate-200 dark:border-zinc-800 rounded-3xl bg-white/90 dark:bg-zinc-950/40">
            <div className="p-3 rounded-full bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 text-slate-500 dark:text-zinc-400 mb-3">
              <Inbox className="h-6 w-6" />
            </div>
            <p className="text-sm font-semibold text-slate-700 dark:text-zinc-300">No transactions found</p>
            <p className="text-xs text-slate-500 dark:text-zinc-400 mt-1 max-w-xs">
              {transactions.length === 0
                ? "Your sheet is empty. Use the + button at the bottom to add your first transaction."
                : "No transactions match your current search or filter."}
            </p>
          </div>
        ) : (
          /* Grouped by Day View */
          <div className="space-y-4">
            {dayGroups.map((group) => (
              <div key={group.date} className="space-y-2">
                {/* Day Group Header (clean Atelier styling) */}
                <div className="flex items-center justify-between px-3.5 py-2.5 rounded-2xl bg-card border border-black/[0.08] dark:border-white/[0.08] shadow-[0_1px_2px_rgba(17,20,24,0.03)]">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className={`flex items-center justify-center h-8 w-8 rounded-xl shrink-0 ${
                      group.isToday
                        ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border border-emerald-500/30'
                        : group.isYesterday
                        ? 'bg-amber-500/12 text-amber-800 dark:text-amber-300 border border-amber-500/25'
                        : 'bg-black/[0.04] dark:bg-white/[0.05] text-muted-foreground border border-black/[0.07] dark:border-white/[0.08]'
                    }`}>
                      <Calendar className="h-4 w-4" />
                    </div>

                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`text-xs sm:text-sm font-semibold tracking-tight truncate ${
                          group.isToday ? 'text-emerald-800 dark:text-emerald-300' : 'text-foreground'
                        }`}>
                          {group.title}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 text-[10px] text-slate-500 dark:text-zinc-400 font-mono">
                        <span>{group.formattedDate}</span>
                        <span>•</span>
                        <span>{group.transactions.length} {group.transactions.length === 1 ? 'record' : 'records'}</span>
                      </div>
                    </div>
                  </div>

                  {/* Daily Spent / Income Total */}
                  <div className="text-right shrink-0">
                    <div className="flex items-center gap-1.5 justify-end">
                      <span className="text-[10px] uppercase font-bold tracking-wider text-slate-500 dark:text-zinc-400">
                        Spent
                      </span>
                      <span className="text-xs sm:text-sm font-bold font-mono text-rose-800 dark:text-rose-400 tabular-nums whitespace-nowrap">
                        RM{'\u00A0'}{group.totalExpense.toFixed(2)}
                      </span>
                    </div>
                    {group.totalIncome > 0 && (
                      <div className="flex items-center gap-1 justify-end text-[10px] font-mono text-emerald-800 dark:text-emerald-400 whitespace-nowrap tabular-nums mt-0.5">
                        <span className="text-slate-500 dark:text-zinc-400 font-sans text-[9px]">Income</span>
                        <span>+RM{'\u00A0'}{group.totalIncome.toFixed(2)}</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Transactions for this Day */}
                <div className="space-y-2">
                  {group.transactions.map((t, idx) =>
                    renderTransactionCard(t, `${group.date}_${t.id || idx}`, true)
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Transaction Details Modal */}
      <TransactionDetailModal
        transaction={selectedTx}
        onClose={() => setSelectedTx(null)}
      />
    </div>
  );
}
