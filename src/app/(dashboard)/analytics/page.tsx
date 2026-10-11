'use client';

import React, { useState, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { motion } from 'framer-motion';
import { useTransactions } from '@/hooks/useTransactions';
import { useAppStore } from '@/stores/app-store';
import { AnimatedNumber } from '@/components/shared/animated-number';
import { CockpitPageHeading } from '@/components/money-cockpit/cockpit-page-heading';
import {
  BarChart3,
  TrendingUp,
  Calendar,
  Inbox,
  DollarSign,
  PieChart,
  ArrowUpRight,
  ArrowDownRight,
  PiggyBank,
  ChevronLeft,
  ChevronRight,
  Check,
  Sparkles
} from 'lucide-react';

const BarChart = dynamic(() => import('recharts').then(m => m.BarChart), { ssr: false });
const Bar = dynamic(() => import('recharts').then(m => m.Bar), { ssr: false });
const XAxis = dynamic(() => import('recharts').then(m => m.XAxis), { ssr: false });
const YAxis = dynamic(() => import('recharts').then(m => m.YAxis), { ssr: false });
const Tooltip = dynamic(() => import('recharts').then(m => m.Tooltip), { ssr: false });
const ResponsiveContainer = dynamic(() => import('recharts').then(m => m.ResponsiveContainer), { ssr: false });
const CartesianGrid = dynamic(() => import('recharts').then(m => m.CartesianGrid), { ssr: false });

import { CATEGORY_COLORS } from '@/lib/design-tokens';
import { getAmountInBaseCurrency } from '@/lib/currency';
import { parseLocalDate } from '@/lib/date-helper';

export default function AnalyticsPage() {
  const [period, setPeriod] = useState<'Daily' | 'Monthly'>('Daily');
  const [savingsYearFilter, setSavingsYearFilter] = useState<string>('all');
  const { selectedMonth, setSelectedMonth } = useAppStore();
  const { transactions = [], isLoading } = useTransactions(selectedMonth ? { period: selectedMonth } : undefined);

  // Current active month in YYYY-MM format, e.g. "2026-10"
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
  const scopedTransactions = useMemo(() => {
    if (selectedMonth === 'all') {
      return transactions.filter(t => t.id !== 'tx_sample' && !!t.date);
    }
    if (selectedMonth.startsWith('year-')) {
      const y = selectedMonth.replace('year-', '');
      return transactions.filter(t => t.id !== 'tx_sample' && !!t.date && t.date.startsWith(y));
    }
    return transactions.filter(t => t.id !== 'tx_sample' && !!t.date && t.date.startsWith(selectedMonth));
  }, [transactions, selectedMonth]);

  const scopedExpenses = useMemo(() => {
    return scopedTransactions.filter(t => t.type === 'expense');
  }, [scopedTransactions]);

  const allExpenses = useMemo(() => {
    return transactions.filter(t => t.id !== 'tx_sample' && t.type === 'expense');
  }, [transactions]);

  // Statistics scoped to the selected period
  const stats = useMemo(() => {
    const totalExpense = scopedExpenses.reduce((sum, t) => sum + getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount), 0);
    const count = scopedExpenses.length;
    const maxExpense = scopedExpenses.reduce(
      (max, t) => (getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount) > max.amount
        ? { ...t, amount: getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount) }
        : max),
      { amount: 0, description: 'None', category: 'None' }
    );

    // Distinct active spending days in selected period
    const uniqueDays = new Set(scopedExpenses.map(t => t.date)).size;
    const avgDaily = uniqueDays > 0 ? totalExpense / uniqueDays : 0;

    return { totalExpense, count, maxExpense, avgDaily };
  }, [scopedExpenses]);

  // Scoped category breakdown for selected month
  const breakdown = useMemo(() => {
    const catMap: Record<string, number> = {};
    scopedExpenses.forEach(t => {
      const cat = t.category || 'Other';
      catMap[cat] = (catMap[cat] || 0) + getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount);
    });
    return Object.entries(catMap)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  }, [scopedExpenses]);

  // Process chart data: Days of Week uses scopedExpenses, Monthly Trend uses allExpenses
  const chartData = useMemo(() => {
    if (period === 'Daily') {
      if (scopedExpenses.length === 0) return [];
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const dayTotals = [0, 0, 0, 0, 0, 0, 0];
      scopedExpenses.forEach(t => {
        if (!t.date) return;
        const d = parseLocalDate(t.date);
        if (!isNaN(d.getTime())) {
          dayTotals[d.getDay()] += getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount);
        }
      });
      return days.map((day, idx) => ({ name: day, value: dayTotals[idx] }));
    } else {
      if (allExpenses.length === 0) return [];
      // Monthly aggregation chronologically sorted
      const monthlyMap: Record<string, number> = {};
      const sortedExpenses = [...allExpenses].sort((a, b) => parseLocalDate(a.date).getTime() - parseLocalDate(b.date).getTime());

      sortedExpenses.forEach(t => {
        if (!t.date) return;
        const monthKey = t.date.substring(0, 7);
        monthlyMap[monthKey] = (monthlyMap[monthKey] || 0) + getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount);
      });

      return Object.entries(monthlyMap).map(([key, value]) => {
        const [year, month] = key.split('-');
        const dateObj = new Date(parseInt(year), parseInt(month) - 1, 1);
        const name = !isNaN(dateObj.getTime())
          ? dateObj.toLocaleString('default', { month: 'short', year: '2-digit' })
          : key;
        return { name, value };
      });
    }
  }, [scopedExpenses, allExpenses, period]);

  const hasData = chartData.some(d => d.value > 0);

  // Monthly Savings Tracker & History: track back which month you saved how much
  const monthlySavingsHistory = useMemo(() => {
    const monthMap: Record<string, { income: number; expense: number; count: number }> = {};

    transactions.forEach(t => {
      if (t.id === 'tx_sample' || !t.date || t.date.length < 7) return;
      const mKey = t.date.substring(0, 7);
      if (!monthMap[mKey]) {
        monthMap[mKey] = { income: 0, expense: 0, count: 0 };
      }
      monthMap[mKey].count += 1;
      const baseAmount = getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount);
      if (t.type === 'income') monthMap[mKey].income += baseAmount;
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

  // Multi-year filter and annual summary for Savings History
  const displayedSavingsMonths = useMemo(() => {
    if (savingsYearFilter === 'all') return monthlySavingsHistory;
    return monthlySavingsHistory.filter(m => m.monthKey.startsWith(savingsYearFilter));
  }, [monthlySavingsHistory, savingsYearFilter]);

  const annualSummary = useMemo(() => {
    const targetYear = savingsYearFilter === 'all'
      ? (availableYears[0] || currentMonthStr.substring(0, 4))
      : savingsYearFilter;
    const yearMonths = monthlySavingsHistory.filter(m => m.monthKey.startsWith(targetYear));
    const income = yearMonths.reduce((s, m) => s + m.income, 0);
    const expense = yearMonths.reduce((s, m) => s + m.expense, 0);
    const saved = income - expense;
    const savingsRate = income > 0 ? (saved / income) * 100 : 0;
    return { targetYear, income, expense, saved, savingsRate, monthCount: yearMonths.length };
  }, [monthlySavingsHistory, savingsYearFilter, availableYears, currentMonthStr]);

  return (
    <div className="cockpit-module-page">
      <CockpitPageHeading
        title="Expense & Savings Analytics"
        description="Analyze monthly spending, category distribution, and track back historical savings across years"
        action={(
          <div className="cockpit-segmented-control relative flex space-x-1 rounded-2xl bg-white/90 dark:bg-zinc-950/80 p-1.5 border border-slate-200 dark:border-white/[0.08] backdrop-blur-md">
          {(['Daily', 'Monthly'] as const).map((tab) => {
            const isActive = period === tab;
            return (
              <button
                key={tab}
                type="button"
                onClick={() => setPeriod(tab)}
                className={`relative z-10 min-h-[44px] px-4 py-2 text-xs font-semibold rounded-xl transition-all cursor-pointer touch-manipulation active:scale-[0.97] ${
                  isActive ? 'text-indigo-800 dark:text-indigo-200 font-bold' : 'text-slate-600 dark:text-zinc-400 hover:text-slate-800 dark:hover:text-zinc-200'
                }`}
              >
                {isActive && (
                  <motion.div
                    layoutId="analytics-period-pill"
                    className="cockpit-segmented-pill absolute inset-0 rounded-xl border pointer-events-none"
                    transition={{ type: 'spring' as const, stiffness: 450, damping: 32 }}
                  />
                )}
                <span className="relative z-10">{tab === 'Daily' ? 'Days of Week' : 'Monthly Trend'}</span>
              </button>
            );
          })}
          </div>
        )}
      />

      {/* Month Selector Bar with Year Optgroups */}
      <div className="bg-white/90 dark:bg-zinc-900/60 p-3.5 sm:p-4 rounded-3xl border border-slate-200 dark:border-white/[0.08] backdrop-blur-xl shadow-lg space-y-3">
        {/* Header: Label + Selected Month */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="p-2 rounded-xl bg-indigo-500/15 text-indigo-800 dark:text-indigo-400 border border-indigo-500/20 shrink-0">
              <Calendar className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-semibold text-slate-600 dark:text-zinc-400 uppercase tracking-wider block">Analytics Period</span>
                {selectedMonth === currentMonthStr && (
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border border-emerald-500/30">
                    Current
                  </span>
                )}
              </div>
              <span className="text-sm sm:text-base font-bold text-slate-950 dark:text-white tracking-tight truncate block">{formatMonthLabel(selectedMonth)}</span>
            </div>
          </div>
          <span className="text-[11px] text-slate-500 dark:text-zinc-400 hidden sm:inline">Filter analytics & trends</span>
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
                  Full Year {year} (All {year})
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

      {/* Summary KPI Cards with Spring Hover and Specular Highlights */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <motion.div
          whileHover={{ y: -3, scale: 1.015 }}
          transition={{ type: 'spring' as const, stiffness: 400, damping: 25 }}
          className="p-5 rounded-3xl border border-slate-200 dark:border-white/[0.08] bg-card/60 backdrop-blur-2xl specular-card transition-all duration-300 hover:border-slate-200 dark:hover:border-white/[0.15] shadow-xl"
        >
          <span className="text-xs text-slate-600 dark:text-zinc-400 font-semibold uppercase tracking-wider">Total Expenses</span>
          <div className="text-xl sm:text-2xl font-extrabold font-mono tabular-nums tracking-tight text-slate-950 dark:text-white mt-1.5">
            <AnimatedNumber value={stats.totalExpense} animateOnMount />
          </div>
          <span className="text-[11px] text-slate-600 dark:text-zinc-400 mt-1 block font-medium font-mono">
            {stats.count} recorded payments in {selectedMonth === 'all' ? 'all time' : formatMonthLabel(selectedMonth).split(' ')[0]}
          </span>
        </motion.div>

        <motion.div
          whileHover={{ y: -3, scale: 1.015 }}
          transition={{ type: 'spring' as const, stiffness: 400, damping: 25 }}
          className="p-5 rounded-3xl border border-slate-200 dark:border-white/[0.08] bg-card/60 backdrop-blur-2xl specular-card transition-all duration-300 hover:border-indigo-500/40 shadow-xl"
        >
          <span className="text-xs text-slate-600 dark:text-zinc-400 font-semibold uppercase tracking-wider">Average Daily Spend</span>
          <div className="text-xl sm:text-2xl font-extrabold font-mono tabular-nums tracking-tight text-indigo-800 dark:text-indigo-300 mt-1.5">
            <AnimatedNumber value={stats.avgDaily} animateOnMount />
          </div>
          <span className="text-[11px] text-slate-600 dark:text-zinc-400 mt-1 block font-medium">per active spending day</span>
        </motion.div>

        <motion.div
          whileHover={{ y: -3, scale: 1.015 }}
          transition={{ type: 'spring' as const, stiffness: 400, damping: 25 }}
          className="p-5 rounded-3xl border border-slate-200 dark:border-white/[0.08] bg-card/60 backdrop-blur-2xl specular-card transition-all duration-300 hover:border-rose-500/40 shadow-xl"
        >
          <span className="text-xs text-slate-600 dark:text-zinc-400 font-semibold uppercase tracking-wider">Highest Single Expense</span>
          <div className="text-xl sm:text-2xl font-extrabold font-mono tabular-nums tracking-tight text-rose-800 dark:text-rose-400 mt-1.5">
            <AnimatedNumber value={stats.maxExpense.amount} animateOnMount />
          </div>
          <span className="text-[11px] text-slate-600 dark:text-zinc-400 mt-1 block line-clamp-2 break-words font-medium" title={stats.maxExpense.description || stats.maxExpense.category}>
            {stats.maxExpense.description || stats.maxExpense.category}
          </span>
        </motion.div>

        <motion.div
          whileHover={{ y: -3, scale: 1.015 }}
          transition={{ type: 'spring' as const, stiffness: 400, damping: 25 }}
          className="p-5 rounded-3xl border border-slate-200 dark:border-white/[0.08] bg-card/60 backdrop-blur-2xl specular-card transition-all duration-300 hover:border-emerald-500/40 shadow-xl"
        >
          <span className="text-xs text-slate-600 dark:text-zinc-400 font-semibold uppercase tracking-wider">Top Category</span>
          <div className="min-w-0 text-xl sm:text-2xl font-extrabold text-emerald-800 dark:text-emerald-400 mt-1.5 break-words leading-tight" title={breakdown[0]?.name || 'None'}>
            {breakdown[0]?.name || 'None'}
          </div>
          <span className="text-[11px] text-slate-600 dark:text-zinc-400 mt-1 block font-medium">
            {breakdown[0] && stats.totalExpense > 0
              ? `${((breakdown[0].value / stats.totalExpense) * 100).toFixed(1)}% of spending`
              : 'No categorized data'}
          </span>
        </motion.div>
      </div>

      {/* Main Chart */}
      <div className="h-[360px] w-full rounded-3xl border border-slate-200 dark:border-white/[0.08] bg-card/60 backdrop-blur-2xl p-5 sm:p-6 flex flex-col justify-center shadow-xl">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs text-slate-600 dark:text-zinc-400 font-semibold uppercase tracking-wider">
            {period === 'Daily'
              ? `Spending by Day of Week (${formatMonthLabel(selectedMonth)})`
              : 'Monthly Spending Trend Over Time'}
          </span>
        </div>
        {!hasData ? (
          <div className="text-center py-12">
            <div className="h-12 w-12 rounded-2xl bg-slate-100 dark:bg-zinc-800/80 text-slate-600 dark:text-zinc-400 mx-auto flex items-center justify-center mb-3">
              <Inbox className="h-6 w-6" />
            </div>
            <h3 className="text-base font-semibold text-slate-950 dark:text-white">No Expense Records for Selected Period</h3>
            <p className="text-xs text-slate-600 dark:text-zinc-400 max-w-sm mx-auto mt-1">
              Select another month or record expenses to visualize spending trends.
            </p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
              <XAxis dataKey="name" stroke="#94a3b8" fontSize={12} tickLine={false} axisLine={false} />
              <YAxis stroke="#94a3b8" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(val) => `RM ${val}`} />
              <Tooltip
                cursor={{ fill: '#1e293b', opacity: 0.4 }}
                contentStyle={{
                  backgroundColor: '#0f172a',
                  borderColor: 'rgba(255,255,255,0.1)',
                  borderRadius: '16px',
                  color: '#f8fafc',
                  boxShadow: '0 10px 25px -5px rgba(0,0,0,0.5)'
                }}
                formatter={(val: unknown) => [`RM ${Number(val || 0).toFixed(2)}`, 'Expense']}
              />
              <Bar dataKey="value" fill="#6366f1" radius={[8, 8, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Category Spending Breakdown List */}
      <div className="rounded-3xl border border-slate-200 dark:border-white/[0.08] bg-card/60 backdrop-blur-2xl p-6 space-y-4 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold text-slate-950 dark:text-white flex items-center gap-2">
            <PieChart className="h-4 w-4 text-indigo-800 dark:text-indigo-400" />
            <span>Category Spending Breakdown ({formatMonthLabel(selectedMonth)})</span>
          </h2>
          <span className="text-xs text-slate-600 dark:text-zinc-400 font-mono">{breakdown.length} Categories</span>
        </div>

        {breakdown.length === 0 ? (
          <p className="text-xs text-slate-600 dark:text-zinc-400 text-center py-6">No categorized expenses recorded for {formatMonthLabel(selectedMonth)}</p>
        ) : (
          <div className="space-y-3.5">
            {breakdown.map((item) => {
              const percent = stats.totalExpense > 0 ? (item.value / stats.totalExpense) * 100 : 0;
              const color = CATEGORY_COLORS[item.name] || '#6366f1';
              return (
                <div key={item.name} className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
                      <span className="font-semibold text-slate-950 dark:text-white">{item.name}</span>
                    </div>
                    <div className="text-slate-600 dark:text-zinc-400">
                      <strong className="text-slate-950 dark:text-white font-mono tabular-nums tracking-tight">RM {item.value.toFixed(2)}</strong>
                      <span className="text-slate-600 dark:text-zinc-400 font-mono ml-1.5">({percent.toFixed(1)}%)</span>
                    </div>
                  </div>
                  <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-zinc-800/80">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{ width: `${percent}%`, backgroundColor: color }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Monthly Savings History & Multi-Year Track Back ("track back like which month i save how much") */}
      <div className="rounded-3xl border border-slate-200 dark:border-white/[0.08] bg-card/60 backdrop-blur-2xl p-6 space-y-5 shadow-xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base sm:text-lg font-bold text-slate-950 dark:text-white flex items-center gap-2.5">
              <PiggyBank className="h-5 w-5 text-emerald-800 dark:text-emerald-400" />
              <span>Monthly Savings History & Annual Track-Back</span>
            </h2>
            <p className="text-xs text-slate-600 dark:text-zinc-400 mt-1">
              Track back your historical income, expenses, and exact net savings across months and years
            </p>
          </div>

          {/* Multi-Year Filter Tabs */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              type="button"
              onClick={() => setSavingsYearFilter('all')}
              className={`px-3 py-1.5 rounded-xl text-xs font-semibold cursor-pointer transition-all active:scale-95 ${
                savingsYearFilter === 'all'
                  ? 'bg-indigo-600 text-white dark:text-white shadow-md shadow-indigo-600/30'
                  : 'bg-slate-100 dark:bg-zinc-800/80 text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white border border-slate-200 dark:border-white/[0.06]'
              }`}
            >
              All Years
            </button>
            {availableYears.map(year => (
              <button
                key={year}
                type="button"
                onClick={() => setSavingsYearFilter(year)}
                className={`px-3 py-1.5 rounded-xl text-xs font-semibold cursor-pointer transition-all active:scale-95 ${
                  savingsYearFilter === year
                    ? 'bg-indigo-600 text-white dark:text-white shadow-md shadow-indigo-600/30'
                    : 'bg-slate-100 dark:bg-zinc-800/80 text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white border border-slate-200 dark:border-white/[0.06]'
                }`}
              >
                Year {year}
              </button>
            ))}
          </div>
        </div>

        {/* Annual Overview Highlight Banner */}
        <div className="p-4 sm:p-5 rounded-2xl bg-gradient-to-r from-emerald-950/25 via-slate-100 dark:via-zinc-900/80 to-indigo-950/25 border border-emerald-500/25 flex flex-wrap items-center justify-between gap-4 shadow-inner">
          <div>
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-emerald-800 dark:text-emerald-400" />
              <span className="text-xs font-bold text-emerald-800 dark:text-emerald-400 uppercase tracking-wider block">
                {annualSummary.targetYear} Annual Savings Summary
              </span>
            </div>
            <span className="text-2xl sm:text-3xl font-black font-mono tracking-tight text-slate-950 dark:text-white mt-1 block">
              {annualSummary.saved >= 0 ? '+' : '-'}RM {Math.abs(annualSummary.saved).toFixed(2)}
            </span>
            <span className="text-[11px] text-slate-600 dark:text-zinc-400 font-mono">
              Total Net Saved in {annualSummary.targetYear} across {annualSummary.monthCount} recorded months
            </span>
          </div>

          <div className="flex items-center gap-4 sm:gap-6 text-xs font-mono ml-auto">
            <div>
              <span className="text-slate-600 dark:text-zinc-400 block text-[10px] uppercase font-semibold">Earned</span>
              <span className="text-emerald-800 dark:text-emerald-400 font-bold text-sm">RM {annualSummary.income.toFixed(2)}</span>
            </div>
            <div className="w-px h-7 bg-slate-100 dark:bg-zinc-800" />
            <div>
              <span className="text-slate-600 dark:text-zinc-400 block text-[10px] uppercase font-semibold">Spent</span>
              <span className="text-rose-800 dark:text-rose-400 font-bold text-sm">RM {annualSummary.expense.toFixed(2)}</span>
            </div>
            <div className="w-px h-7 bg-slate-100 dark:bg-zinc-800" />
            <div>
              <span className="text-slate-600 dark:text-zinc-400 block text-[10px] uppercase font-semibold">Saved Rate</span>
              <span className="text-slate-950 dark:text-white font-bold text-sm">{annualSummary.savingsRate.toFixed(1)}%</span>
            </div>
          </div>
        </div>

        {/* Monthly Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
          {displayedSavingsMonths.map((m) => {
            const isSelected = selectedMonth === m.monthKey;
            const isNetPositive = m.saved >= 0;

            return (
              <motion.div
                key={m.monthKey}
                whileHover={{ y: -2, scale: 1.01 }}
                transition={{ type: 'spring' as const, stiffness: 400, damping: 25 }}
                onClick={() => {
                  setSelectedMonth(m.monthKey);
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }}
                role="button"
                tabIndex={0}
                aria-label={`View savings for ${m.monthName}, saved RM ${m.saved.toFixed(2)}`}
                className={`p-4 sm:p-5 rounded-2xl border transition-all cursor-pointer shadow-md group ${
                  isSelected
                    ? 'border-indigo-500/50 bg-gradient-to-br from-indigo-950/40 via-slate-100 dark:via-zinc-900/80 to-white dark:to-zinc-900 ring-2 ring-indigo-500/30'
                    : 'border-slate-200 dark:border-white/[0.06] bg-white/90 dark:bg-zinc-900/50 hover:bg-white/90 dark:hover:bg-zinc-900/80 hover:border-slate-200 dark:hover:border-white/[0.12]'
                }`}
              >
                {/* Top Row: Month Name & Badges */}
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-sm sm:text-base text-slate-950 dark:text-white group-hover:text-indigo-800 dark:group-hover:text-indigo-300 transition-colors">
                      {m.monthName}
                    </span>
                    {m.isCurrent && (
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-indigo-500/15 text-indigo-800 dark:text-indigo-300 border border-indigo-500/25">
                        Current
                      </span>
                    )}
                    {isSelected && (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-800 dark:text-emerald-400 border border-emerald-500/25">
                        Selected
                      </span>
                    )}
                  </div>

                  <span className={`text-[11px] font-bold font-mono px-2.5 py-0.5 rounded-full ${
                    isNetPositive
                      ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-400 border border-emerald-500/30'
                      : 'bg-rose-500/15 text-rose-800 dark:text-rose-400 border border-rose-500/30'
                  }`}>
                    {isNetPositive ? `${m.savingsRate.toFixed(1)}% Saved` : 'Deficit'}
                  </span>
                </div>

                {/* Net Saved Highlight */}
                <div className="mt-3 flex items-baseline justify-between">
                  <span className="text-xs text-slate-600 dark:text-zinc-400 uppercase tracking-wider font-semibold">Net Saved</span>
                  <span className={`text-xl sm:text-2xl font-black font-mono tracking-tight tabular-nums ${
                    isNetPositive ? 'text-emerald-800 dark:text-emerald-400' : 'text-rose-800 dark:text-rose-400'
                  }`}>
                    {isNetPositive ? '+' : '-'}RM {Math.abs(m.saved).toFixed(2)}
                  </span>
                </div>

                {/* Breakdown Bar (Income vs Expense) */}
                <div className="mt-3 space-y-1.5">
                  <div className="flex items-center justify-between text-xs font-mono">
                    <span className="text-emerald-800 dark:text-emerald-400 flex items-center gap-1 font-medium">
                      <ArrowDownRight className="h-3.5 w-3.5" />
                      RM {m.income.toFixed(2)}
                    </span>
                    <span className="text-rose-800 dark:text-rose-400 flex items-center gap-1 font-medium">
                      <ArrowUpRight className="h-3.5 w-3.5" />
                      RM {m.expense.toFixed(2)}
                    </span>
                  </div>

                  <div className="h-2 w-full rounded-full bg-slate-100 dark:bg-zinc-800 overflow-hidden flex">
                    {m.income > 0 ? (
                      <>
                        <div
                          className="h-full bg-rose-500 transition-all"
                          style={{ width: `${Math.min(100, (m.expense / m.income) * 100)}%` }}
                        />
                        <div
                          className="h-full bg-emerald-500 transition-all"
                          style={{ width: `${Math.max(0, 100 - (m.expense / m.income) * 100)}%` }}
                        />
                      </>
                    ) : (
                      <div className="h-full w-full bg-slate-200 dark:bg-zinc-700" />
                    )}
                  </div>
                </div>

                {/* Footer with transaction count and inspect cue */}
                <div className="mt-3.5 pt-2.5 border-t border-slate-200 dark:border-white/[0.05] flex items-center justify-between text-[11px] text-slate-600 dark:text-zinc-400 font-mono">
                  <span>{m.count} records</span>
                  <span className="text-indigo-800 dark:text-indigo-400 group-hover:text-indigo-800 dark:group-hover:text-indigo-300 font-semibold transition-colors flex items-center gap-0.5">
                    <span>{isSelected ? 'Viewing Analytics' : 'Inspect Month'}</span>
                    <ChevronRight className="h-3.5 w-3.5 group-hover:translate-x-0.5 transition-transform" />
                  </span>
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
