"use client"

import { useState, useMemo } from "react"
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
import { getLocalDateString, getRelativeDateString, parseLocalDate } from "@/lib/date-helper"
import { getTransactionTaxRelief } from "@/lib/lhdn-tax-helper"
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
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedTx, setSelectedTx] = useState<Transaction | null>(null)

  // Current active month in YYYY-MM format, e.g. "2026-10"
  const currentMonthStr = useMemo(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }, []);

  const { data: months = [] } = useMonthList()
  const { transactions = [], isLoading } = useTransactions(selectedMonth ? { period: selectedMonth } : undefined)
  const deleteMutation = useDeleteTransaction()

  // Extract all available years and months from transactions + current year/month
  const { availableYears, monthsByYear } = useMemo(() => {
    const [curY] = currentMonthStr.split('-').map(Number);
    const curYStr = String(curY);
    const activeYears = new Set<number>([curY, curY - 1, curY + 1]);

    // Add years from sheets query
    months.forEach(m => {
      if (/^\d{4}-\d{2}$/.test(m)) activeYears.add(Number(m.substring(0, 4)));
    });

    // Add years from all recorded transactions
    transactions.forEach(t => {
      if (t.date && t.date.length >= 7 && /^\d{4}-\d{2}/.test(t.date)) {
        activeYears.add(Number(t.date.substring(0, 4)));
      }
    });

    // Add year from currently selected period (e.g. when navigating with < / > arrows)
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
    };
  }, [transactions, months, currentMonthStr, selectedMonth]);

  const formatPeriodLabel = (pStr: string) => {
    if (!pStr || pStr === 'all') return 'All Months';
    if (pStr.startsWith('year-')) {
      return `Full Year ${pStr.replace('year-', '')}`;
    }
    const [y, m] = pStr.split('-').map(Number);
    if (isNaN(y) || isNaN(m)) return pStr;
    const d = new Date(y, m - 1, 1);
    return d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
  };

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
  }, [transactions, filterType, selectedMonth, searchQuery]);

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
    filteredTransactions.forEach(t => {
      const baseAmount = getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount);
      if (t.type === 'income') income += baseAmount;
      if (t.type === 'expense') expense += baseAmount;
    });
    return {
      totalIncome: income,
      totalExpense: expense,
      balance: income - expense
    };
  }, [filteredTransactions]);

  const changePeriod = (direction: -1 | 1) => {
    if (!selectedMonth || selectedMonth === 'all') {
      setSelectedMonth(currentMonthStr);
      return;
    }
    if (selectedMonth.startsWith('year-')) {
      const year = Number(selectedMonth.slice(5)) + direction;
      setSelectedMonth(`year-${year}`);
      return;
    }
    const [year, month] = selectedMonth.split('-').map(Number);
    if (!year || !month) {
      setSelectedMonth(currentMonthStr);
      return;
    }
    const next = new Date(year, month - 1 + direction, 1);
    setSelectedMonth(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`);
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
    const isTrixpense = String(t.id || '').startsWith('trixpense_');
    const isInst = Boolean(t.description?.includes('(Installment') || t.notes?.includes('[Installment Plan'));
    const instMatch = t.description?.match(/Installment\s*(\d+\/\d+)/i) || t.notes?.match(/Installment\s*Plan\s*(\d+\/\d+)/i);
    const taxCat = getTransactionTaxRelief(t);

    return (
      <motion.div
        key={keyId}
        role="button"
        tabIndex={0}
        aria-label={`View transaction ${t.description || t.category}, ${isIncome ? 'income' : 'expense'} RM ${t.amount.toFixed(2)}`}
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
        className={`flex cursor-pointer items-center justify-between p-3.5 sm:p-4 rounded-2xl border transition-all group shadow-sm hover:shadow-md focus-visible:ring-2 focus-visible:ring-indigo-400 ${
          isIncome
            ? 'border-slate-200 dark:border-white/[0.06] bg-white/90 dark:bg-zinc-900/60 hover:bg-slate-100 dark:hover:bg-zinc-800/80 hover:border-emerald-500/40'
            : isInvestment
            ? 'border-slate-200 dark:border-white/[0.06] bg-white/90 dark:bg-zinc-900/60 hover:bg-slate-100 dark:hover:bg-zinc-800/80 hover:border-indigo-500/40'
            : isInst
            ? 'border-slate-200 dark:border-white/[0.06] bg-white/90 dark:bg-zinc-900/60 hover:bg-slate-100 dark:hover:bg-zinc-800/80 hover:border-purple-500/40'
            : 'border-slate-200 dark:border-white/[0.06] bg-white/90 dark:bg-zinc-900/60 hover:bg-slate-100 dark:hover:bg-zinc-800/80 hover:border-rose-500/40'
        }`}
      >
        {/* Left: Icon */}
        <div className="flex items-center gap-3.5 min-w-0 flex-1">
          <div className={`flex h-10 w-10 sm:h-11 sm:w-11 shrink-0 items-center justify-center rounded-2xl border ${
            isIncome
              ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-400 border-emerald-500/25 shadow-[0_0_12px_rgba(16,185,129,0.15)]'
              : isInvestment
              ? 'bg-indigo-500/15 text-indigo-800 dark:text-indigo-400 border-indigo-500/25 shadow-[0_0_12px_rgba(99,102,241,0.15)]'
              : isInst
              ? 'bg-purple-500/15 text-violet-800 dark:text-purple-400 border-purple-500/25 shadow-[0_0_12px_rgba(168,85,247,0.15)]'
              : 'bg-rose-500/15 text-rose-800 dark:text-rose-400 border-rose-500/25 shadow-[0_0_12px_rgba(244,63,94,0.15)]'
          }`}>
            {isIncome ? <ArrowDownRight className="h-5 w-5" /> : isInvestment ? <TrendingUp className="h-5 w-5" /> : isInst ? <CreditCard className="h-5 w-5" /> : <ArrowUpRight className="h-5 w-5" />}
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
                <span className="shrink-0 inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-md bg-indigo-500/15 text-indigo-800 dark:text-indigo-300 border border-indigo-500/20 font-medium">
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
              {taxCat && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border border-emerald-500/25 text-[11px] font-semibold">
                  🇲🇾 LHDN: {taxCat.shortName}
                </span>
              )}
              {isInst && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-purple-500/15 text-violet-800 dark:text-purple-300 border border-purple-500/20 text-[11px] font-semibold">
                  💳 {instMatch ? `Installment ${instMatch[1]}` : 'Installment'}
                </span>
              )}
              {t.account && t.account !== 'Cash' && t.account !== 'Default' && t.account !== '-' && !isTrixpense && (
                <span className="text-[11px] text-slate-600 dark:text-zinc-400 hidden xs:inline">• {t.account}</span>
              )}
              {t.tripTag && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-purple-500/15 text-violet-800 dark:text-purple-300 border border-purple-500/20 text-[11px] font-medium">
                  ✈️ {t.tripTag}
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
            <div className={`text-sm sm:text-base font-bold font-mono tabular-nums tracking-tight ${
              isIncome ? 'text-emerald-800 dark:text-emerald-400' : isInvestment ? 'text-indigo-800 dark:text-indigo-400' : isInst ? 'text-violet-800 dark:text-purple-300' : 'text-slate-900 dark:text-zinc-100'
            }`}>
              {isIncome ? '+' : '-'}{t.currency === 'USD' ? '$' : t.currency === 'CNY' ? '¥' : t.currency === 'SGD' ? 'S$' : (t.currency || 'MYR') + ' '}{t.amount.toFixed(2)}
            </div>
            {t.currency && t.currency !== 'MYR' && (
              <div className="text-[10px] text-slate-600 dark:text-zinc-400 font-mono mt-0.5">
                {t.notes && t.notes.includes('Cost: RM')
                  ? t.notes.match(/Cost:\s*RM\s*[\d.]+/)?.[0]
                  : t.baseAmount && t.baseAmount > 0
                  ? `≈ RM ${t.baseAmount.toFixed(2)}`
                  : t.currency}
              </div>
            )}
          </div>

          {/* Desktop Quick Actions */}
          {!isTrixpense && (
            <div className="hidden sm:flex items-center gap-1">
              <button
                onClick={(e) => { e.stopPropagation(); openEdit(t); }}
                className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-xl text-slate-600 dark:text-zinc-400 hover:text-indigo-800 dark:hover:text-indigo-300 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-indigo-400"
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
        {/* Row 1: Type Filter Chips */}
        <div className="flex items-center gap-3 overflow-x-auto no-scrollbar">
          {/* Type Filter Chips with animated sliding pill */}
          <div className="cockpit-segmented-control relative flex w-full sm:w-auto justify-between sm:justify-start rounded-2xl bg-white/90 dark:bg-zinc-950/80 p-1 border border-slate-200 dark:border-white/[0.08] shadow-sm">
            {(['all', 'expense', 'income', 'investment', 'tax'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setFilterType(t)}
                className={`relative z-10 flex-1 sm:flex-initial min-h-[40px] px-2 sm:px-3.5 py-1.5 rounded-xl text-xs font-semibold capitalize transition-colors cursor-pointer touch-manipulation select-none active:scale-[0.96] whitespace-nowrap ${
                  filterType === t
                    ? 'text-indigo-800 dark:text-indigo-200'
                    : 'text-slate-600 dark:text-zinc-400 hover:text-slate-800 dark:hover:text-zinc-200'
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
        </div>

        {/* Row 2: Month Selector with < > Arrows + Search Field */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 sm:gap-3">
          {/* Month & Multi-Year Selector with < and > navigation */}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => changePeriod(-1)}
              className="h-11 w-11 shrink-0 inline-flex items-center justify-center rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white/90 dark:bg-zinc-900/90 text-slate-700 dark:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800 hover:border-indigo-400/50 active:scale-[0.96] transition-all cursor-pointer touch-manipulation"
              aria-label="Previous period"
              title="Previous period"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>

            <select
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(e.target.value)}
              className="flex-1 sm:flex-initial h-11 min-w-[165px] rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white/90 dark:bg-zinc-900/90 px-3.5 py-2 text-base sm:text-xs font-mono text-slate-950 dark:text-white outline-none focus:border-indigo-400 cursor-pointer transition-colors shadow-inner"
              aria-label="Filter transactions by month or year"
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
                      Full Year {year} (All {year})
                    </option>
                    {monthsByYear[year]?.map(m => (
                      <option key={m} value={m} className="bg-white dark:bg-zinc-900 text-slate-950 dark:text-white font-mono">
                        {m === currentMonthStr ? `★ ${formatPeriodLabel(m)} (Current)` : formatPeriodLabel(m)}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
              <option value="all" className="bg-white dark:bg-zinc-900 text-slate-950 dark:text-white font-mono">
                All Time (All Transactions)
              </option>
            </select>

            <button
              type="button"
              onClick={() => changePeriod(1)}
              className="h-11 w-11 shrink-0 inline-flex items-center justify-center rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white/90 dark:bg-zinc-900/90 text-slate-700 dark:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800 hover:border-indigo-400/50 active:scale-[0.96] transition-all cursor-pointer touch-manipulation"
              aria-label="Next period"
              title="Next period"
            >
              <ChevronRight className="h-4 w-4" />
            </button>

            {selectedMonth !== currentMonthStr && (
              <button
                type="button"
                onClick={() => setSelectedMonth(currentMonthStr)}
                className="h-11 px-3 shrink-0 inline-flex items-center justify-center rounded-xl border border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 text-xs font-bold hover:bg-emerald-500/25 active:scale-[0.96] transition-all cursor-pointer touch-manipulation"
                title="Jump back to current month"
              >
                Current
              </button>
            )}
          </div>

          {/* Search Field (16px text-base on mobile to prevent iOS Safari auto-zoom) */}
          <div className="flex-1 relative min-w-[200px]">
            <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-600 dark:text-zinc-400 pointer-events-none" />
            <input
              type="search"
              inputMode="search"
              enterKeyHint="search"
              placeholder="Search transactions, categories, notes..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full h-11 rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white/90 dark:bg-zinc-900/90 py-2.5 pl-10 pr-10 text-base sm:text-sm text-slate-950 dark:text-white outline-none placeholder:text-slate-500 dark:placeholder:text-zinc-400 focus:border-indigo-400 focus:ring-1 focus:ring-indigo-500/30 transition-all shadow-inner"
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

      {/* Summary Bar: Income & Expenses Only */}
      <div className="grid grid-cols-2 gap-3 rounded-2xl border border-slate-200 dark:border-white/[0.08] bg-card/60 p-4.5 shadow-xl specular-card">
        <div className="text-center">
          <div className="min-w-0 px-1 text-xs leading-tight text-slate-700 dark:text-zinc-300 font-medium">
            <span className="block">Income</span>
            {selectedMonth && <span className="block text-[10px] text-slate-500 dark:text-zinc-400">{formatPeriodLabel(selectedMonth)}</span>}
          </div>
          <div className="text-base md:text-lg font-bold text-emerald-800 dark:text-emerald-400 font-mono tabular-nums mt-0.5">
            <AnimatedNumber value={displaySummary.totalIncome} animateOnMount />
          </div>
        </div>
        <div className="text-center border-l border-slate-200 dark:border-white/[0.08]">
          <div className="min-w-0 px-1 text-xs leading-tight text-slate-700 dark:text-zinc-300 font-medium">
            <span className="block">Expenses</span>
            {selectedMonth && <span className="block text-[10px] text-slate-500 dark:text-zinc-400">{formatPeriodLabel(selectedMonth)}</span>}
          </div>
          <div className="text-base md:text-lg font-bold text-rose-800 dark:text-rose-400 font-mono tabular-nums mt-0.5">
            <AnimatedNumber value={displaySummary.totalExpense} animateOnMount />
          </div>
        </div>
      </div>

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
                {/* Day Group Header (clean, non-blurry) */}
                <div className="flex items-center justify-between px-3.5 py-2.5 rounded-2xl bg-white dark:bg-zinc-950 border border-slate-200 dark:border-white/[0.08] shadow-sm">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className={`flex items-center justify-center h-8 w-8 rounded-xl shrink-0 ${
                      group.isToday
                        ? 'bg-indigo-500/20 text-indigo-800 dark:text-indigo-300 border border-indigo-500/30 shadow-[0_0_12px_rgba(99,102,241,0.2)]'
                        : group.isYesterday
                        ? 'bg-purple-500/15 text-violet-800 dark:text-purple-300 border border-purple-500/25'
                        : 'bg-white dark:bg-zinc-900 text-slate-600 dark:text-zinc-400 border border-slate-200 dark:border-zinc-800'
                    }`}>
                      <Calendar className="h-4 w-4" />
                    </div>

                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`text-xs sm:text-sm font-bold tracking-tight truncate ${
                          group.isToday ? 'text-indigo-800 dark:text-indigo-300' : 'text-slate-900 dark:text-zinc-100'
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
                      <span className="text-xs sm:text-sm font-bold font-mono text-rose-800 dark:text-rose-400 tabular-nums">
                        RM {group.totalExpense.toFixed(2)}
                      </span>
                    </div>
                    {group.totalIncome > 0 && (
                      <div className="flex items-center gap-1 justify-end text-[10px] font-mono text-emerald-800 dark:text-emerald-400 mt-0.5">
                        <span className="text-slate-500 dark:text-zinc-400 font-sans text-[9px]">Income</span>
                        <span>+RM {group.totalIncome.toFixed(2)}</span>
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
