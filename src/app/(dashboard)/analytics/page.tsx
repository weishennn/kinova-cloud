'use client';

import React, { useState, useMemo } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { motion } from 'framer-motion';
import { useTransactions } from '@/hooks/useTransactions';
import { useAppStore } from '@/stores/app-store';
import { AnimatedNumber } from '@/components/shared/animated-number';
import { CockpitPageHeading } from '@/components/money-cockpit/cockpit-page-heading';
import { PeriodBar } from '@/components/shared/period-bar';
import { ThemeChartTooltip } from '@/components/shared/theme-chart-tooltip';
import {
  Inbox,
  PieChart,
  ArrowUpRight,
  ArrowDownRight,
  PiggyBank,
  ChevronRight,
  Sparkles,
} from 'lucide-react';

const BarChart = dynamic(() => import('recharts').then((m) => m.BarChart), { ssr: false });
const Bar = dynamic(() => import('recharts').then((m) => m.Bar), { ssr: false });
const XAxis = dynamic(() => import('recharts').then((m) => m.XAxis), { ssr: false });
const YAxis = dynamic(() => import('recharts').then((m) => m.YAxis), { ssr: false });
const Tooltip = dynamic(() => import('recharts').then((m) => m.Tooltip), { ssr: false });
const ResponsiveContainer = dynamic(() => import('recharts').then((m) => m.ResponsiveContainer), { ssr: false });
const CartesianGrid = dynamic(() => import('recharts').then((m) => m.CartesianGrid), { ssr: false });

import { CATEGORY_COLORS } from '@/lib/design-tokens';
import { getAmountInBaseCurrency } from '@/lib/currency';
import { parseLocalDate } from '@/lib/date-helper';
import { useMonthList } from '@/hooks/useSheets';
import { buildPeriodCatalog, formatPeriodDisplay } from '@/lib/period-helper';

export default function AnalyticsPage() {
  const [period, setPeriod] = useState<'Daily' | 'Monthly'>('Daily');
  const [savingsYearFilter, setSavingsYearFilter] = useState<string>('all');
  const { selectedMonth, setSelectedMonth } = useAppStore();
  const { data: sheetMonths = [] } = useMonthList();
  const { transactions = [], isLoading } = useTransactions(
    selectedMonth ? { period: selectedMonth } : undefined
  );

  const { currentMonth: currentMonthStr, orderedYears: availableYears } = useMemo(
    () => buildPeriodCatalog(sheetMonths, selectedMonth, transactions),
    [sheetMonths, selectedMonth, transactions]
  );

  const formatMonthLabel = (mStr: string) => formatPeriodDisplay(mStr);

  // Scoped transactions & expenses for selected month or full year
  const scopedTransactions = useMemo(() => {
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

  const scopedExpenses = useMemo(() => {
    return scopedTransactions.filter((t) => t.type === 'expense');
  }, [scopedTransactions]);

  const allExpenses = useMemo(() => {
    return transactions.filter((t) => t.id !== 'tx_sample' && t.type === 'expense');
  }, [transactions]);

  // Statistics scoped to the selected period
  const stats = useMemo(() => {
    const totalExpense = scopedExpenses.reduce(
      (sum, t) => sum + getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount),
      0
    );
    const count = scopedExpenses.length;
    const maxExpense = scopedExpenses.reduce(
      (max, t) =>
        getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount) > max.amount
          ? { ...t, amount: getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount) }
          : max,
      { amount: 0, description: 'None', category: 'None' }
    );

    const uniqueDays = new Set(scopedExpenses.map((t) => t.date)).size;
    const avgDaily = uniqueDays > 0 ? totalExpense / uniqueDays : 0;

    return { totalExpense, count, maxExpense, avgDaily };
  }, [scopedExpenses]);

  // Scoped category breakdown for selected month
  const breakdown = useMemo(() => {
    const catMap: Record<string, number> = {};
    scopedExpenses.forEach((t) => {
      const cat = t.category || 'Other';
      catMap[cat] = (catMap[cat] || 0) + getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount);
    });
    return Object.entries(catMap)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  }, [scopedExpenses]);

  // Chart data: Days of Week uses scopedExpenses, Monthly Trend uses allExpenses
  const chartData = useMemo(() => {
    if (period === 'Daily') {
      if (scopedExpenses.length === 0) return [];
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const dayTotals = [0, 0, 0, 0, 0, 0, 0];
      scopedExpenses.forEach((t) => {
        if (!t.date) return;
        const d = parseLocalDate(t.date);
        if (!isNaN(d.getTime())) {
          dayTotals[d.getDay()] += getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount);
        }
      });
      return days.map((day, idx) => ({ name: day, value: dayTotals[idx] }));
    }

    if (allExpenses.length === 0) return [];
    const monthlyMap: Record<string, number> = {};
    const sortedExpenses = [...allExpenses].sort(
      (a, b) => parseLocalDate(a.date).getTime() - parseLocalDate(b.date).getTime()
    );

    sortedExpenses.forEach((t) => {
      if (!t.date) return;
      const monthKey = t.date.substring(0, 7);
      monthlyMap[monthKey] =
        (monthlyMap[monthKey] || 0) + getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount);
    });

    return Object.entries(monthlyMap).map(([key, value]) => {
      const [year, month] = key.split('-');
      const dateObj = new Date(parseInt(year, 10), parseInt(month, 10) - 1, 1);
      const name = !isNaN(dateObj.getTime())
        ? dateObj.toLocaleString('default', { month: 'short', year: '2-digit' })
        : key;
      return { name, value };
    });
  }, [scopedExpenses, allExpenses, period]);

  const hasData = chartData.some((d) => d.value > 0);

  // Monthly Savings Tracker & History
  const monthlySavingsHistory = useMemo(() => {
    const monthMap: Record<string, { income: number; expense: number; count: number }> = {};

    transactions.forEach((t) => {
      if (t.id === 'tx_sample' || !t.date || t.date.length < 7) return;
      const mKey = t.date.substring(0, 7);
      if (!monthMap[mKey]) {
        monthMap[mKey] = { income: 0, expense: 0, count: 0 };
      }
      monthMap[mKey].count += 1;
      const baseAmount = getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount);
      const isTrade =
        String(t.id || '').startsWith('tx_trade_') ||
        t.category === 'Stocks & Crypto' ||
        t.subCategory?.toUpperCase() === 'SELL' ||
        t.subCategory?.toUpperCase() === 'BUY' ||
        /^(SELL|BUY)\s+[0-9]/i.test(t.description || '');
      if (t.type === 'income' && !isTrade) monthMap[mKey].income += baseAmount;
      if (t.type === 'expense') monthMap[mKey].expense += baseAmount;
    });

    if (!monthMap[currentMonthStr]) {
      monthMap[currentMonthStr] = { income: 0, expense: 0, count: 0 };
    }

    return Object.entries(monthMap)
      .map(([monthKey, val]) => {
        const saved = val.income - val.expense;
        const savingsRate = val.income > 0 ? (saved / val.income) * 100 : 0;
        const [y, m] = monthKey.split('-').map(Number);
        const dateObj = new Date(y, m - 1, 1);
        const monthName = !isNaN(dateObj.getTime())
          ? dateObj.toLocaleString('en-US', { month: 'long', year: 'numeric' })
          : monthKey;
        return {
          monthKey,
          monthName,
          income: val.income,
          expense: val.expense,
          saved,
          savingsRate,
          count: val.count,
          isCurrent: monthKey === currentMonthStr,
        };
      })
      .sort((a, b) => b.monthKey.localeCompare(a.monthKey));
  }, [transactions, currentMonthStr]);

  const displayedSavingsMonths = useMemo(() => {
    if (savingsYearFilter === 'all') return monthlySavingsHistory;
    return monthlySavingsHistory.filter((m) => m.monthKey.startsWith(savingsYearFilter));
  }, [monthlySavingsHistory, savingsYearFilter]);

  const annualSummary = useMemo(() => {
    const targetYear =
      savingsYearFilter === 'all'
        ? availableYears[0] || currentMonthStr.substring(0, 4)
        : savingsYearFilter;
    const yearMonths = monthlySavingsHistory.filter((m) => m.monthKey.startsWith(targetYear));
    const income = yearMonths.reduce((s, m) => s + m.income, 0);
    const expense = yearMonths.reduce((s, m) => s + m.expense, 0);
    const saved = income - expense;
    const savingsRate = income > 0 ? (saved / income) * 100 : 0;
    return { targetYear, income, expense, saved, savingsRate, monthCount: yearMonths.length };
  }, [monthlySavingsHistory, savingsYearFilter, availableYears, currentMonthStr]);

  return (
    <div className="cockpit-module-page space-y-6 sm:space-y-8 pb-8">
      <CockpitPageHeading
        title="Analytics"
        description="Spending cadence, category weight, and multi-year net savings"
        action={
          <div className="relative inline-flex items-center rounded-2xl bg-black/[0.04] dark:bg-white/[0.05] p-1 border border-black/[0.06] dark:border-white/[0.08]">
            {(['Daily', 'Monthly'] as const).map((tab) => {
              const isActive = period === tab;
              return (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setPeriod(tab)}
                  className={`relative z-10 min-h-[38px] px-4 py-1.5 text-xs font-semibold rounded-xl transition-colors cursor-pointer touch-manipulation ${
                    isActive
                      ? 'text-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {isActive && (
                    <motion.div
                      layoutId="analytics-period-pill"
                      className="absolute inset-0 rounded-xl bg-white dark:bg-zinc-900 shadow-sm border border-black/[0.06] dark:border-white/[0.1] pointer-events-none"
                      transition={{ type: 'spring', stiffness: 460, damping: 34 }}
                    />
                  )}
                  <span className="relative z-10">
                    {tab === 'Daily' ? 'Days of Week' : 'Monthly Trend'}
                  </span>
                </button>
              );
            })}
          </div>
        }
      />

      {/* Period Selector Strip */}
      <div className="rounded-2xl border border-black/[0.07] dark:border-white/[0.08] bg-card px-4 py-3">
        <PeriodBar
          selectedMonth={selectedMonth}
          onSelectMonth={setSelectedMonth}
          sheetMonths={sheetMonths}
          transactions={transactions}
          selectId="analytics-period-select"
          selectAriaLabel="Select month or year for analytics"
        />
      </div>

      {/* Unified KPI Strip */}
      <section
        aria-label="Spending summary metrics"
        className="rounded-3xl border border-black/[0.07] dark:border-white/[0.08] bg-card overflow-hidden"
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 divide-y sm:divide-y-0 sm:gap-px bg-black/[0.06] dark:bg-white/[0.06]">
          <div className="bg-card p-5 sm:p-6 flex flex-col justify-between gap-2 min-w-0">
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              Total Expenses
            </span>
            <div className="text-2xl sm:text-[26px] font-bold font-mono tabular-nums tracking-tight text-foreground">
              <AnimatedNumber value={stats.totalExpense} animateOnMount />
            </div>
            <span className="text-xs text-muted-foreground font-mono truncate">
              {stats.count} {stats.count === 1 ? 'entry' : 'entries'} ·{' '}
              {selectedMonth === 'all' ? 'All time' : formatMonthLabel(selectedMonth)}
            </span>
          </div>

          <div className="bg-card p-5 sm:p-6 flex flex-col justify-between gap-2 min-w-0">
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              Daily Average
            </span>
            <div className="text-2xl sm:text-[26px] font-bold font-mono tabular-nums tracking-tight text-amber-700 dark:text-amber-400">
              <AnimatedNumber value={stats.avgDaily} animateOnMount />
            </div>
            <span className="text-xs text-muted-foreground">
              Per active spending day
            </span>
          </div>

          <div className="bg-card p-5 sm:p-6 flex flex-col justify-between gap-2 min-w-0">
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              Largest Expense
            </span>
            <div className="text-2xl sm:text-[26px] font-bold font-mono tabular-nums tracking-tight text-rose-700 dark:text-rose-400">
              <AnimatedNumber value={stats.maxExpense.amount} animateOnMount />
            </div>
            <span
              className="text-xs text-muted-foreground truncate"
              title={stats.maxExpense.description || stats.maxExpense.category}
            >
              {stats.maxExpense.description || stats.maxExpense.category}
            </span>
          </div>

          <div className="bg-card p-5 sm:p-6 flex flex-col justify-between gap-2 min-w-0">
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              Top Category
            </span>
            <div
              className="text-xl sm:text-2xl font-bold tracking-tight text-emerald-700 dark:text-emerald-400 truncate"
              title={breakdown[0]?.name || 'None'}
            >
              {breakdown[0]?.name || 'None'}
            </div>
            <span className="text-xs text-muted-foreground font-mono truncate">
              {breakdown[0] && stats.totalExpense > 0
                ? `${((breakdown[0].value / stats.totalExpense) * 100).toFixed(1)}% of total spend`
                : 'No categorized spend'}
            </span>
          </div>
        </div>
      </section>

      {/* Primary Visuals: 12-col Asymmetric Split */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        {/* Main Bar Chart */}
        <section className="lg:col-span-7 rounded-3xl border border-black/[0.07] dark:border-white/[0.08] bg-card p-5 sm:p-6 flex flex-col min-h-[380px] min-w-0">
          <div className="mb-5 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-foreground">
                {period === 'Daily' ? 'Spending by Day of Week' : 'Monthly Spending Trend'}
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5 truncate">
                {period === 'Daily'
                  ? formatMonthLabel(selectedMonth)
                  : 'Chronological outflow across all recorded months'}
              </p>
            </div>
            {isLoading && (
              <span className="text-[11px] font-mono text-muted-foreground animate-pulse shrink-0">
                Syncing…
              </span>
            )}
          </div>

          {!hasData ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center py-12">
              <div className="h-12 w-12 rounded-2xl bg-black/[0.04] dark:bg-white/[0.05] text-muted-foreground flex items-center justify-center mb-3">
                <Inbox className="h-5 w-5" />
              </div>
              <h3 className="text-sm font-semibold text-foreground">No expenses in this period</h3>
              <p className="text-xs text-muted-foreground max-w-xs mt-1 leading-relaxed">
                Switch to another month or record a payment to see your spending cadence here.
              </p>
            </div>
          ) : (
            <div className="flex-1 w-full min-h-[280px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                  <defs>
                    <linearGradient id="analyticsBarJade" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#10b981" stopOpacity={0.95} />
                      <stop offset="100%" stopColor="#0d6e52" stopOpacity={0.85} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    vertical={false}
                    stroke="currentColor"
                    className="text-black/[0.07] dark:text-white/[0.07]"
                  />
                  <XAxis
                    dataKey="name"
                    stroke="currentColor"
                    className="text-muted-foreground"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    dy={8}
                  />
                  <YAxis
                    stroke="currentColor"
                    className="text-muted-foreground"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(val) => `RM ${val}`}
                  />
                  <Tooltip
                    cursor={{ fill: 'currentColor', opacity: 0.05 }}
                    content={<ThemeChartTooltip />}
                  />
                  <Bar
                    dataKey="value"
                    fill="url(#analyticsBarJade)"
                    radius={[10, 10, 4, 4]}
                    maxBarSize={44}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>

        {/* Category Breakdown */}
        <section className="lg:col-span-5 rounded-3xl border border-black/[0.07] dark:border-white/[0.08] bg-card p-5 sm:p-6 flex flex-col min-w-0">
          <div className="flex items-center justify-between gap-2 mb-5">
            <div className="flex items-center gap-2 min-w-0">
              <PieChart className="h-4 w-4 text-emerald-700 dark:text-emerald-400 shrink-0" />
              <h2 className="text-sm font-semibold text-foreground truncate">
                Category Breakdown
              </h2>
            </div>
            <span className="text-[11px] font-mono text-muted-foreground shrink-0">
              {breakdown.length} {breakdown.length === 1 ? 'category' : 'categories'}
            </span>
          </div>

          {breakdown.length === 0 ? (
            <div className="flex-1 flex items-center justify-center py-10">
              <p className="text-xs text-muted-foreground text-center">
                No categorized expenses for {formatMonthLabel(selectedMonth)}.
              </p>
            </div>
          ) : (
            <div className="space-y-1.5 overflow-y-auto max-h-[300px] pr-1">
              {breakdown.map((item) => {
                const percent = stats.totalExpense > 0 ? (item.value / stats.totalExpense) * 100 : 0;
                const color = CATEGORY_COLORS[item.name] || '#0D6E52';
                return (
                  <Link
                    key={item.name}
                    href={`/transactions?category=${encodeURIComponent(item.name)}`}
                    className="block rounded-2xl px-3 py-2.5 hover:bg-black/[0.03] dark:hover:bg-white/[0.04] transition-colors group"
                  >
                    <div className="flex items-center justify-between gap-3 text-xs">
                      <div className="flex items-center gap-2.5 min-w-0 flex-1">
                        <span
                          className="h-2.5 w-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: color }}
                        />
                        <span className="font-medium text-foreground truncate group-hover:text-emerald-700 dark:group-hover:text-emerald-400 transition-colors">
                          {item.name}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0 font-mono tabular-nums">
                        <span className="font-semibold text-foreground">
                          RM{'\u00A0'}{item.value.toFixed(2)}
                        </span>
                        <span className="text-[11px] text-muted-foreground w-11 text-right">
                          {percent.toFixed(1)}%
                        </span>
                      </div>
                    </div>
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.07]">
                      <div
                        className="h-full rounded-full transition-all duration-500"
                        style={{ width: `${percent}%`, backgroundColor: color }}
                      />
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {/* Monthly Savings History & Multi-Year Track-Back */}
      <section className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-base sm:text-lg font-semibold text-foreground flex items-center gap-2">
              <PiggyBank className="h-5 w-5 text-emerald-700 dark:text-emerald-400" />
              <span>Savings History</span>
            </h2>
            <p className="text-xs text-muted-foreground mt-1">
              Click any month to inspect its spending breakdown above
            </p>
          </div>

          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              type="button"
              onClick={() => setSavingsYearFilter('all')}
              className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold cursor-pointer transition-colors ${
                savingsYearFilter === 'all'
                  ? 'bg-[#0D6E52] dark:bg-emerald-600 text-white'
                  : 'bg-card text-muted-foreground hover:text-foreground border border-black/[0.08] dark:border-white/[0.08]'
              }`}
            >
              All Years
            </button>
            {availableYears.map((year) => (
              <button
                key={year}
                type="button"
                onClick={() => setSavingsYearFilter(year)}
                className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold cursor-pointer transition-colors ${
                  savingsYearFilter === year
                    ? 'bg-[#0D6E52] dark:bg-emerald-600 text-white'
                    : 'bg-card text-muted-foreground hover:text-foreground border border-black/[0.08] dark:border-white/[0.08]'
                }`}
              >
                {year}
              </button>
            ))}
          </div>
        </div>

        {/* Annual Summary Hero Banner */}
        <div className="atelier-hero rounded-3xl bg-gradient-to-br from-[#0E1513] via-[#11201B] to-[#0A0F0D] border border-emerald-500/20 p-5 sm:p-7 text-[#F5F4EF] flex flex-wrap items-center justify-between gap-5 sm:gap-6">
          <div className="space-y-1.5 min-w-0">
            <div className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-emerald-300">
              <Sparkles className="h-3.5 w-3.5 shrink-0" />
              <span>{annualSummary.targetYear} Net Savings</span>
            </div>
            <div className="text-2xl sm:text-4xl font-bold font-mono tabular-nums tracking-tight text-white">
              {annualSummary.saved >= 0 ? '+' : '-'}RM{'\u00A0'}
              {Math.abs(annualSummary.saved).toLocaleString('en-MY', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </div>
            <p className="text-xs text-[#9AA6A1] font-mono">
              Across {annualSummary.monthCount} recorded{' '}
              {annualSummary.monthCount === 1 ? 'month' : 'months'}
            </p>
          </div>

          <div className="grid grid-cols-3 gap-3 sm:gap-8 text-xs font-mono w-full sm:w-auto min-w-0">
            <div className="min-w-0">
              <span className="text-[#9AA6A1] block text-[10px] uppercase tracking-wider font-semibold">
                Earned
              </span>
              <span className="text-emerald-400 font-semibold text-xs sm:text-base tabular-nums mt-1 block truncate">
                RM{'\u00A0'}{annualSummary.income.toLocaleString('en-MY', { maximumFractionDigits: 0 })}
              </span>
            </div>
            <div className="min-w-0">
              <span className="text-[#9AA6A1] block text-[10px] uppercase tracking-wider font-semibold">
                Spent
              </span>
              <span className="text-rose-400 font-semibold text-xs sm:text-base tabular-nums mt-1 block truncate">
                RM{'\u00A0'}{annualSummary.expense.toLocaleString('en-MY', { maximumFractionDigits: 0 })}
              </span>
            </div>
            <div className="min-w-0">
              <span className="text-[#9AA6A1] block text-[10px] uppercase tracking-wider font-semibold">
                Saved Rate
              </span>
              <span className="text-[#E5B85C] font-semibold text-xs sm:text-base tabular-nums mt-1 block truncate">
                {annualSummary.savingsRate.toFixed(1)}%
              </span>
            </div>
          </div>
        </div>

        {/* Monthly Savings Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {displayedSavingsMonths.map((m) => {
            const isSelected = selectedMonth === m.monthKey;
            const isNetPositive = m.saved >= 0;

            return (
              <button
                key={m.monthKey}
                type="button"
                onClick={() => {
                  setSelectedMonth(m.monthKey);
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }}
                aria-label={`View savings for ${m.monthName}, saved RM ${m.saved.toFixed(2)}`}
                className={`text-left w-full p-5 rounded-3xl border transition-colors duration-200 cursor-pointer group ${
                  isSelected
                    ? 'border-emerald-500/50 bg-emerald-500/[0.06] ring-1 ring-emerald-500/20'
                    : 'border-black/[0.07] dark:border-white/[0.08] bg-card hover:border-black/[0.16] dark:hover:border-white/[0.18]'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-semibold text-sm sm:text-base text-foreground truncate group-hover:text-emerald-700 dark:group-hover:text-emerald-400 transition-colors">
                      {m.monthName}
                    </span>
                    {m.isCurrent && (
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-800 dark:text-amber-300 shrink-0">
                        Now
                      </span>
                    )}
                  </div>

                  <span
                    className={`text-[11px] font-semibold font-mono px-2.5 py-0.5 rounded-full shrink-0 ${
                      isNetPositive
                        ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-400'
                        : 'bg-rose-500/15 text-rose-800 dark:text-rose-400'
                    }`}
                  >
                    {isNetPositive ? `${m.savingsRate.toFixed(1)}% saved` : 'Deficit'}
                  </span>
                </div>

                <div className="mt-4 flex items-baseline justify-between gap-2">
                  <span className="text-xs text-muted-foreground font-medium">Net Saved</span>
                  <span
                    className={`text-xl sm:text-2xl font-bold font-mono tabular-nums tracking-tight ${
                      isNetPositive
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : 'text-rose-700 dark:text-rose-400'
                    }`}
                  >
                    {isNetPositive ? '+' : '-'}RM{'\u00A0'}
                    {Math.abs(m.saved).toLocaleString('en-MY', {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </span>
                </div>

                <div className="mt-4 space-y-2">
                  <div className="flex items-center justify-between gap-2 text-xs font-mono tabular-nums">
                    <span className="text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1">
                      <ArrowDownRight className="h-3.5 w-3.5 shrink-0" />
                      RM{'\u00A0'}{m.income.toFixed(2)}
                    </span>
                    <span className="text-rose-700 dark:text-rose-400 inline-flex items-center gap-1">
                      <ArrowUpRight className="h-3.5 w-3.5 shrink-0" />
                      RM{'\u00A0'}{m.expense.toFixed(2)}
                    </span>
                  </div>

                  <div className="h-1.5 w-full rounded-full bg-black/[0.06] dark:bg-white/[0.08] overflow-hidden flex">
                    {m.income > 0 ? (
                      <>
                        <div
                          className="h-full bg-rose-500/85 transition-all duration-500"
                          style={{ width: `${Math.min(100, (m.expense / m.income) * 100)}%` }}
                        />
                        <div
                          className="h-full bg-emerald-500/85 transition-all duration-500"
                          style={{
                            width: `${Math.max(0, 100 - (m.expense / m.income) * 100)}%`,
                          }}
                        />
                      </>
                    ) : (
                      <div className="h-full w-full bg-black/[0.08] dark:bg-white/[0.1]" />
                    )}
                  </div>
                </div>

                <div className="mt-4 pt-3 border-t border-black/[0.06] dark:border-white/[0.06] flex items-center justify-between text-[11px] text-muted-foreground font-mono">
                  <span>{m.count} records</span>
                  <span className="text-emerald-700 dark:text-emerald-400 font-semibold inline-flex items-center gap-0.5">
                    <span>{isSelected ? 'Selected' : 'Inspect'}</span>
                    <ChevronRight className="h-3.5 w-3.5 group-hover:translate-x-0.5 transition-transform" />
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
