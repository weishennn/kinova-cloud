'use client';

import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowDownLeft, ArrowLeft, ArrowRight, ArrowUpRight, CalendarDays, CalendarRange, ChevronDown, CircleHelp, CloudAlert, House, Receipt, Search, ShoppingBag, Sparkles, Train, TrendingUp, Utensils, Wallet } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useAppStore } from '@/stores/app-store';
import { Transaction, useTransactions } from '@/hooks/useTransactions';
import { useMonthList } from '@/hooks/useSheets';
import { getAmountInBaseCurrency, ACCOUNTING_BASE_CURRENCY } from '@/lib/currency';
import { getLocalDateString, getTransactionRecordedInfo, parseLocalDate } from '@/lib/date-helper';
import { MoneyOrbit } from './money-orbit';
import { SmartQuickInput } from '@/components/shared/smart-quick-input';
import { TransactionDetailModal } from '@/components/shared/transaction-detail-modal';
import { RecurringCommitments } from '@/components/dashboard/recurring-commitments';
import { InstallmentDashboard } from '@/components/dashboard/installment-dashboard';
import { IncomeAdvisor } from '@/components/dashboard/income-advisor';
import { ClaimsCalendar } from '@/components/invoices/claims-calendar';
import { useSyncAndRefresh } from '@/hooks/useSyncAndRefresh';

const moneyFormat = new Intl.NumberFormat('en-MY', {
  style: 'currency',
  currency: ACCOUNTING_BASE_CURRENCY,
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatMoney(amount: number) {
  return moneyFormat.format(amount);
}

const AreaChart = dynamic(() => import('recharts').then((mod) => mod.AreaChart), { ssr: false });
const Area = dynamic(() => import('recharts').then((mod) => mod.Area), { ssr: false });
const XAxis = dynamic(() => import('recharts').then((mod) => mod.XAxis), { ssr: false });
const YAxis = dynamic(() => import('recharts').then((mod) => mod.YAxis), { ssr: false });
const CartesianGrid = dynamic(() => import('recharts').then((mod) => mod.CartesianGrid), { ssr: false });
const Tooltip = dynamic(() => import('recharts').then((mod) => mod.Tooltip), { ssr: false });
const ResponsiveContainer = dynamic(() => import('recharts').then((mod) => mod.ResponsiveContainer), { ssr: false });

const categoryColors = ['#8b5cf6', '#558d78', '#8a77a8', '#aa8152', '#5b8c99', '#9c6d6d'];

function currentMonthValue() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function monthName(monthValue: string) {
  if (monthValue === 'all') return 'All time';
  if (monthValue.startsWith('year-')) return `${monthValue.slice(5)} full year`;
  const [year, month] = monthValue.split('-').map(Number);
  if (!year || !month) return monthValue;
  return new Date(year, month - 1, 1).toLocaleString('en-MY', { month: 'long', year: 'numeric' });
}

function dateGroupLabel(value: string) {
  if (value === getLocalDateString()) return 'Today';
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (value === getLocalDateString(yesterday)) return 'Yesterday';
  const date = parseLocalDate(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('en-MY', { weekday: 'long', day: 'numeric', month: 'short' }).format(date);
}

function categoryIcon(category: string) {
  const normalized = category.toLowerCase();
  if (normalized.includes('food') || normalized.includes('dining')) return Utensils;
  if (normalized.includes('transport') || normalized.includes('travel')) return Train;
  if (normalized.includes('home') || normalized.includes('housing') || normalized.includes('bill')) return House;
  if (normalized.includes('shop')) return ShoppingBag;
  if (normalized.includes('invest') || normalized.includes('saving')) return TrendingUp;
  return Sparkles;
}

function signedAmount(transaction: Transaction, formatMoney: (amount: number) => string) {
  const amount = getAmountInBaseCurrency(transaction.amount, transaction.currency, transaction.baseAmount);
  const sign = transaction.type === 'income' ? '+' : '−';
  return `${sign}${formatMoney(amount)}`;
}

export function CashflowCockpit() {
  const { selectedMonth, setSelectedMonth } = useAppStore();
  const { data: sheetMonths = [] } = useMonthList();
  const { transactions = [], isLoading, error } = useTransactions(selectedMonth ? { period: selectedMonth } : undefined);
  const { syncAndRefresh } = useSyncAndRefresh();
  const [selectedTransaction, setSelectedTransaction] = useState<Transaction | null>(null);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [activityView, setActivityView] = useState<'recent' | 'calendar'>('recent');

  const currentMonth = currentMonthValue();
  const currentYearStr = currentMonth.slice(0, 4);
  const { months, orderedYears } = useMemo(() => {
    const currentYear = Number(currentYearStr);
    const years = new Set<number>([currentYear, currentYear - 1, currentYear + 1]);
    sheetMonths.forEach((m) => {
      if (/^\d{4}-\d{2}$/.test(m)) years.add(Number(m.slice(0, 4)));
    });
    transactions.forEach((transaction) => {
      if (/^\d{4}-\d{2}/.test(transaction.date)) years.add(Number(transaction.date.slice(0, 4)));
    });
    if (selectedMonth.startsWith('year-')) {
      const selY = Number(selectedMonth.slice(5));
      if (Number.isFinite(selY) && selY >= 2000 && selY <= 2100) years.add(selY);
    } else if (/^\d{4}-\d{2}$/.test(selectedMonth)) {
      const selY = Number(selectedMonth.slice(0, 4));
      if (Number.isFinite(selY) && selY >= 2000 && selY <= 2100) years.add(selY);
    }
    const values = new Set<string>([currentMonth, ...sheetMonths]);
    years.forEach((yr) => {
      for (let month = 1; month <= 12; month += 1) {
        values.add(`${yr}-${String(month).padStart(2, '0')}`);
      }
    });
    const sortedMonths = [...values].filter((value) => /^\d{4}-\d{2}$/.test(value)).sort((a, b) => b.localeCompare(a));
    const uniqueYears = [...new Set(sortedMonths.map((m) => m.slice(0, 4)))].sort((a, b) => {
      if (a === currentYearStr) return -1;
      if (b === currentYearStr) return 1;
      return b.localeCompare(a);
    });
    return { months: sortedMonths, orderedYears: uniqueYears };
  }, [currentMonth, currentYearStr, selectedMonth, sheetMonths, transactions]);

  const visibleTransactions = useMemo(() => {
    if (selectedMonth === 'all') return transactions.filter((transaction) => transaction.date && transaction.id !== 'tx_sample');
    if (selectedMonth.startsWith('year-')) {
      const year = selectedMonth.slice(5);
      return transactions.filter((transaction) => transaction.date?.startsWith(year) && transaction.id !== 'tx_sample');
    }
    return transactions.filter((transaction) => transaction.date?.startsWith(selectedMonth) && transaction.id !== 'tx_sample');
  }, [selectedMonth, transactions]);

  const totals = useMemo(() => visibleTransactions.reduce((result, transaction) => {
    const amount = getAmountInBaseCurrency(transaction.amount, transaction.currency, transaction.baseAmount);
    if (transaction.type === 'income') result.income += amount;
    if (transaction.type === 'expense') result.spending += amount;
    if (transaction.type === 'investment') result.invested += amount;
    return result;
  }, { income: 0, spending: 0, invested: 0 }), [visibleTransactions]);

  const netCashflow = totals.income - totals.spending;
  const categoryTotals = useMemo(() => {
    const byCategory = new Map<string, number>();
    visibleTransactions.filter((transaction) => transaction.type === 'expense').forEach((transaction) => {
      byCategory.set(transaction.category, (byCategory.get(transaction.category) || 0) + getAmountInBaseCurrency(transaction.amount, transaction.currency, transaction.baseAmount));
    });
    return [...byCategory.entries()].map(([name, amount]) => ({ name, amount }))
      .sort((a, b) => b.amount - a.amount);
  }, [visibleTransactions]);

  const filteredRecent = useMemo(() => {
    const list = activeCategory
      ? visibleTransactions.filter((transaction) => transaction.type === 'expense' && transaction.category === activeCategory)
      : visibleTransactions;
    return [...list]
      .sort((a, b) => {
        const dateCmp = b.date.localeCompare(a.date);
        if (dateCmp !== 0) return dateCmp;
        const rowA = typeof a._rowIndex === 'number' ? a._rowIndex : Number.MAX_SAFE_INTEGER;
        const rowB = typeof b._rowIndex === 'number' ? b._rowIndex : Number.MAX_SAFE_INTEGER;
        return rowB - rowA;
      })
      .slice(0, 7);
  }, [activeCategory, visibleTransactions]);
  const recentGroups = useMemo(() => {
    const groups = new Map<string, Transaction[]>();
    filteredRecent.forEach((transaction) => {
      const group = groups.get(transaction.date) || [];
      group.push(transaction);
      groups.set(transaction.date, group);
    });
    return [...groups.entries()].map(([date, items]) => ({ date, label: dateGroupLabel(date), items }));
  }, [filteredRecent]);

  const changePeriod = (direction: -1 | 1) => {
    if (selectedMonth === 'all') {
      setSelectedMonth(currentMonth);
      return;
    }
    if (selectedMonth.startsWith('year-')) {
      const year = Number(selectedMonth.slice(5)) + direction;
      setSelectedMonth(`year-${year}`);
      return;
    }
    const [year, month] = selectedMonth.split('-').map(Number);
    const next = new Date(year, month - 1 + direction, 1);
    setSelectedMonth(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`);
  };

  const periodKind = selectedMonth === 'all' ? 'all' : selectedMonth.startsWith('year-') ? 'year' : 'month';
  const trendData = useMemo(() => {
    const byPeriod = new Map<string, { income: number; expense: number }>();
    const monthKeys = periodKind === 'year'
      ? Array.from({ length: 12 }, (_, index) => `${selectedMonth.slice(5)}-${String(index + 1).padStart(2, '0')}`)
      : periodKind === 'all'
        ? [...new Set(visibleTransactions.map((transaction) => transaction.date.slice(0, 7)).filter((value) => /^\d{4}-\d{2}$/.test(value)))].sort().slice(-12)
        : [];

    if (periodKind === 'month') {
      const [year, month] = selectedMonth.split('-').map(Number);
      const daysInMonth = new Date(year, month, 0).getDate();
      const lastVisibleDay = selectedMonth === currentMonth ? new Date().getDate() : daysInMonth;
      for (let day = 1; day <= lastVisibleDay; day += 1) {
        byPeriod.set(`${selectedMonth}-${String(day).padStart(2, '0')}`, { income: 0, expense: 0 });
      }
      visibleTransactions.forEach((transaction) => {
        const key = transaction.date.slice(0, 10);
        const bucket = byPeriod.get(key);
        if (!bucket) return;
        const amount = getAmountInBaseCurrency(transaction.amount, transaction.currency, transaction.baseAmount);
        if (transaction.type === 'income') bucket.income += amount;
        if (transaction.type === 'expense') bucket.expense += amount;
      });
      return [...byPeriod.entries()].map(([date, values]) => ({
        label: String(Number(date.slice(8, 10))),
        ...values,
      }));
    }

    monthKeys.forEach((key) => byPeriod.set(key, { income: 0, expense: 0 }));
    visibleTransactions.forEach((transaction) => {
      const bucket = byPeriod.get(transaction.date.slice(0, 7));
      if (!bucket) return;
      const amount = getAmountInBaseCurrency(transaction.amount, transaction.currency, transaction.baseAmount);
      if (transaction.type === 'income') bucket.income += amount;
      if (transaction.type === 'expense') bucket.expense += amount;
    });
    return [...byPeriod.entries()].map(([key, values]) => ({
      label: new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1).toLocaleString('en-MY', { month: 'short' }),
      ...values,
    }));
  }, [currentMonth, periodKind, selectedMonth, visibleTransactions]);
  const hasTrendData = trendData.some((period) => period.income > 0 || period.expense > 0);
  const greeting = new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 18 ? 'Good afternoon' : 'Good evening';

  return (
    <div className="money-cockpit-page">
      <div className="cockpit-period-row">
        <div className="cockpit-period-tabs" role="group" aria-label="Period type">
          <button
            type="button"
            className={periodKind === 'month' ? 'is-active' : ''}
            aria-pressed={periodKind === 'month'}
            onClick={() => {
              if (selectedMonth.startsWith('year-')) {
                const yr = selectedMonth.slice(5);
                setSelectedMonth(yr === currentMonth.slice(0, 4) ? currentMonth : `${yr}-01`);
              } else {
                setSelectedMonth(currentMonth);
              }
            }}
          >
            Month
          </button>
          <button
            type="button"
            className={periodKind === 'year' ? 'is-active' : ''}
            aria-pressed={periodKind === 'year'}
            onClick={() => {
              const yr = /^\d{4}-\d{2}$/.test(selectedMonth) ? selectedMonth.slice(0, 4) : String(new Date().getFullYear());
              setSelectedMonth(`year-${yr}`);
            }}
          >
            Year
          </button>
          <button type="button" className={periodKind === 'all' ? 'is-active' : ''} aria-pressed={periodKind === 'all'} onClick={() => setSelectedMonth('all')}>All time</button>
        </div>
        <div className="cockpit-period-select-wrap">
          {selectedMonth !== currentMonth && (
            <button
              type="button"
              onClick={() => setSelectedMonth(currentMonth)}
              className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/25 transition-colors cursor-pointer shrink-0"
              title="Jump back to current month"
            >
              Current
            </button>
          )}
          <button type="button" className="cockpit-period-arrow" aria-label="Previous period" onClick={() => changePeriod(-1)}><ArrowLeft size={15} /></button>
          <label className="cockpit-period-select-label" htmlFor="cockpit-period"><CalendarDays size={14} />
            <select id="cockpit-period" value={selectedMonth} onChange={(event) => setSelectedMonth(event.target.value)}>
              {orderedYears.map((year) => {
                const yearLabel =
                  year === currentYearStr
                    ? `${year} (Current Year)`
                    : Number(year) === Number(currentYearStr) - 1
                    ? `${year} (Last Year)`
                    : Number(year) === Number(currentYearStr) + 1
                    ? `${year} (Next Year)`
                    : year;
                return (
                  <optgroup key={year} label={yearLabel}>
                    <option value={`year-${year}`}>{year} full year</option>
                    {months.filter((month) => month.startsWith(year)).map((month) => (
                      <option key={month} value={month}>
                        {month === currentMonth ? `★ ${monthName(month)} (Current)` : monthName(month)}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
              <option value="all">All time</option>
            </select>
            <ChevronDown size={14} className="cockpit-period-chevron" />
          </label>
          <button type="button" className="cockpit-period-arrow" aria-label="Next period" onClick={() => changePeriod(1)}><ArrowRight size={15} /></button>
        </div>
      </div>

      <section className="cockpit-quick-entry-top" aria-label="Gemini quick entry">
        <SmartQuickInput />
      </section>

      <main className="cockpit-grid">
        <section className="cockpit-welcome cockpit-area-welcome">
          <div>
            <p className="cockpit-eyebrow">{greeting}</p>
            <h1>Your money, at a glance.</h1>
            <p className="cockpit-welcome-note">{monthName(selectedMonth)} · A clear view of what came in and went out.</p>
          </div>
        </section>

        <div className="cockpit-area-orbit">
          <MoneyOrbit
            income={totals.income}
            spending={totals.spending}
            invested={totals.invested}
            netCashflow={netCashflow}
            formatMoney={formatMoney}
          />
        </div>

        <section className="cockpit-trend cockpit-area-trend" aria-labelledby="trend-title">
          <div className="cockpit-section-heading">
            <div><p className="cockpit-eyebrow">CASH FLOW</p><h2 id="trend-title">Income and spending</h2></div>
            <div className="cockpit-chart-legend" aria-label="Chart legend">
              <span><i className="income" />Income</span><span><i className="expense" />Expenses</span>
            </div>
          </div>
          {isLoading ? (
            <div className="cockpit-chart-skeleton" aria-label="Loading cash flow trend"><i /></div>
          ) : error ? (
            <div className="cockpit-inline-empty is-error"><CloudAlert size={18} /><span>Cash flow could not be loaded.</span><button type="button" onClick={() => void syncAndRefresh()}>Retry</button></div>
          ) : hasTrendData ? (
            <div className="cockpit-chart" role="img" aria-label={`Income and expense trend for ${monthName(selectedMonth)}`}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trendData} margin={{ top: 10, right: 4, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="income-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#24804d" stopOpacity={0.16} /><stop offset="100%" stopColor="#24804d" stopOpacity={0} /></linearGradient>
                    <linearGradient id="expense-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#c2413b" stopOpacity={0.12} /><stop offset="100%" stopColor="#c2413b" stopOpacity={0} /></linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} stroke="var(--cockpit-gridline)" strokeDasharray="3 5" />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} interval="preserveStartEnd" tick={{ fill: 'var(--cockpit-muted)', fontSize: 11 }} />
                  <YAxis hide domain={[0, 'dataMax']} />
                  <Tooltip
                    cursor={{ stroke: 'var(--cockpit-line-strong)', strokeDasharray: '3 3' }}
                    contentStyle={{ color: 'var(--cockpit-text)', background: 'var(--cockpit-surface)', border: '1px solid var(--cockpit-line)', borderRadius: 12, boxShadow: '0 8px 24px rgba(15, 23, 42, .12)' }}
                    labelStyle={{ color: 'var(--cockpit-muted)', fontSize: 11, marginBottom: 4 }}
                    formatter={(value: unknown) => formatMoney(Number(value))}
                  />
                  <Area type="monotone" dataKey="income" name="Income" stroke="#24804d" strokeWidth={2} fill="url(#income-fill)" activeDot={{ r: 4, strokeWidth: 0 }} />
                  <Area type="monotone" dataKey="expense" name="Expenses" stroke="#c2413b" strokeWidth={2} fill="url(#expense-fill)" activeDot={{ r: 4, strokeWidth: 0 }} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="cockpit-chart-empty"><TrendingUp size={20} aria-hidden="true" /><span>Your trend will appear after your first transaction in this period.</span></div>
          )}
        </section>

        <section className="cockpit-pulse cockpit-area-pulse" aria-labelledby="pulse-title">
          <div className="cockpit-section-heading">
            <div><p className="cockpit-eyebrow">SPENDING</p><h2 id="pulse-title">Top categories</h2></div>
            <Link href="/analytics" className="cockpit-text-link">See analytics <ArrowRight size={14} /></Link>
          </div>
          {categoryTotals.length ? (
            <div className="cockpit-category-track" aria-label="Top spending categories; select one to filter recent activity">
              {categoryTotals.slice(0, 5).map(({ name, amount }, index) => {
                const percent = totals.spending > 0 ? Math.round((amount / totals.spending) * 100) : 0;
                const CategoryIcon = categoryIcon(name);
                return (
                  <button type="button" key={name} onClick={() => setActiveCategory(activeCategory === name ? null : name)} aria-pressed={activeCategory === name} className={`cockpit-category-chip ${activeCategory === name ? 'is-selected' : ''}`} style={{ '--category-accent': categoryColors[index % categoryColors.length] } as CSSProperties}>
                    <span className="cockpit-category-icon"><CategoryIcon size={14} aria-hidden="true" /></span>
                    <span className="cockpit-category-name">{name}</span>
                    <strong>{formatMoney(amount)}</strong>
                    <span className="cockpit-category-share">{percent}% of spending</span>
                    <span className="cockpit-category-meter"><i style={{ width: `${percent}%` }} /></span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="cockpit-inline-empty"><Wallet size={18} /><span>No spending categories for {monthName(selectedMonth).toLowerCase()} yet.</span></div>
          )}
        </section>

        <section className="cockpit-insight cockpit-area-insight" aria-labelledby="insight-title">
          <div className="cockpit-insight-orbit"><Sparkles size={16} /></div>
          <div>
            <p className="cockpit-eyebrow">A QUICK READ</p>
            <h2 id="insight-title">{categoryTotals[0] ? `${categoryTotals[0].name} leads this period.` : 'Your money story starts here.'}</h2>
            <p>{categoryTotals[0]
              ? `${formatMoney(categoryTotals[0].amount)} recorded${totals.spending > 0 ? ` · ${Math.round((categoryTotals[0].amount / totals.spending) * 100)}% of spending` : ''}. Tap its pulse above to follow those transactions.`
              : 'Add your first transaction and your personal money map will take shape.'}</p>
          </div>
          {categoryTotals[0] && <button type="button" onClick={() => setActiveCategory(categoryTotals[0].name)} aria-label={`Show ${categoryTotals[0].name} transactions`}><ArrowRight size={16} /></button>}
        </section>

        <section className="cockpit-stream cockpit-area-stream" aria-labelledby="stream-title">
          <div className="cockpit-section-heading">
            <div><p className="cockpit-eyebrow">ACTIVITY</p><h2 id="stream-title">{activityView === 'recent' ? 'Recent transactions' : 'Claims calendar'}</h2></div>
            <div className="cockpit-stream-actions">
              <div className="cockpit-view-toggle" role="group" aria-label="Activity view">
                <button type="button" aria-label="Show recent transactions" aria-pressed={activityView === 'recent'} className={activityView === 'recent' ? 'is-active' : ''} onClick={() => setActivityView('recent')}><ArrowLeft size={14} /></button>
                <button type="button" aria-label="Show claims calendar" aria-pressed={activityView === 'calendar'} className={activityView === 'calendar' ? 'is-active' : ''} onClick={() => setActivityView('calendar')}><CalendarRange size={14} /></button>
              </div>
              <Link href="/transactions" className="cockpit-text-link">All transactions <ArrowRight size={14} /></Link>
            </div>
          </div>
          {activeCategory && activityView === 'recent' && <button type="button" className="cockpit-filter-pill" onClick={() => setActiveCategory(null)}><span>{activeCategory}</span><span aria-hidden="true">×</span><span className="sr-only">Clear category filter</span></button>}
          {activityView === 'calendar' ? (
            <div className="cockpit-calendar"><ClaimsCalendar transactions={transactions} /></div>
          ) : isLoading ? (
            <div className="cockpit-stream-skeleton" aria-label="Loading transactions"><i /><i /><i /></div>
          ) : error ? (
            <div className="cockpit-inline-empty is-error"><CloudAlert size={18} /><span>Transactions could not be loaded.</span><button type="button" onClick={() => void syncAndRefresh()}>Retry</button></div>
          ) : filteredRecent.length ? (
            <div className="cockpit-transaction-list">
              <AnimatePresence initial={false}>
                {recentGroups.map((group) => (
                  <motion.section key={group.date} className="cockpit-date-group" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                    <h3>{group.label}</h3>
                    {group.items.map((transaction) => (
                      <motion.button
                        type="button"
                        key={transaction.id}
                        className="cockpit-transaction"
                        onClick={() => setSelectedTransaction(transaction)}
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        transition={{ duration: 0.16 }}
                        aria-label={`View ${transaction.description || transaction.category}, ${signedAmount(transaction, formatMoney)}, ${transaction.date}`}
                      >
                        <span className={`cockpit-tx-icon ${transaction.type}`}>
                          {transaction.type === 'income' ? <ArrowDownLeft size={16} aria-hidden="true" /> : transaction.type === 'investment' ? <TrendingUp size={16} aria-hidden="true" /> : <ArrowUpRight size={16} aria-hidden="true" />}
                        </span>
                        <span className="cockpit-tx-copy">
                          <strong>{transaction.description || transaction.category}</strong>
                          <small>
                            {transaction.category}
                            {transaction.account ? ` · ${transaction.account}` : ''}
                            {(() => {
                              const rec = getTransactionRecordedInfo(transaction);
                              return rec ? ` · ${rec.compactLabel}` : '';
                            })()}
                            {transaction.receiptUrl ? ' · Receipt attached' : ''}
                          </small>
                        </span>
                        <span className={`cockpit-tx-amount ${transaction.type}`}>{signedAmount(transaction, formatMoney)}</span>
                      </motion.button>
                    ))}
                  </motion.section>
                ))}
              </AnimatePresence>
            </div>
          ) : (
            <div className="cockpit-inline-empty"><Search size={18} /><span>{activeCategory ? `No ${activeCategory} entries in this period.` : 'No transactions in this period. Use the + button at the bottom to add one.'}</span></div>
          )}
        </section>

        <section className="cockpit-area-commitments">
          <div className="cockpit-section-heading cockpit-secondary-heading"><div><p className="cockpit-eyebrow">UP NEXT</p><h2>Recurring commitments</h2></div><CircleHelp size={15} aria-hidden="true" /></div>
          <RecurringCommitments />
        </section>

        <section className="cockpit-area-installments">
          <div className="cockpit-section-heading cockpit-secondary-heading"><div><p className="cockpit-eyebrow">PAYING OVER TIME</p><h2>Installments</h2></div><Receipt size={15} aria-hidden="true" /></div>
          <InstallmentDashboard />
        </section>

        <section className="cockpit-area-advisor" aria-labelledby="advisor-title">
          <div className="cockpit-section-heading cockpit-secondary-heading"><div><p className="cockpit-eyebrow">PLANNING</p><h2 id="advisor-title">Income allocation</h2></div><Wallet size={15} aria-hidden="true" /></div>
          <IncomeAdvisor liveIncome={totals.income} liveExpense={totals.spending} transactions={visibleTransactions} monthLabel={monthName(selectedMonth)} />
        </section>
      </main>
      <footer className="cockpit-footer"><span>Kinova overview · {monthName(selectedMonth)}</span><span>Amounts shown in MYR</span></footer>
      <TransactionDetailModal transaction={selectedTransaction} onClose={() => setSelectedTransaction(null)} />
    </div>
  );
}
