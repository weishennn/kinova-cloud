'use client';

import React, { useState, useMemo, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ChevronLeft, ChevronRight, Calendar as CalendarIcon,
  Receipt, Download, ExternalLink, X, Eye, FileText, CheckCircle2, AlertCircle, ArrowDownRight, ArrowUpRight, Plus
} from 'lucide-react';
import { Transaction } from '@/hooks/useTransactions';
import { formatClaimFileName, downloadReceiptFile, getReceiptThumbnailUrl } from '@/lib/claim-helper';
import { toast } from 'sonner';
import { TransactionDetailModal } from '@/components/shared/transaction-detail-modal';
import { useAppStore } from '@/stores/app-store';
import { getLocalDateString } from '@/lib/date-helper';
import { useLockBodyScroll } from '@/hooks/useLockBodyScroll';

interface ClaimsCalendarProps {
  transactions: Transaction[];
  invoices?: Array<{
    id: string;
    title: string;
    vendor: string;
    date: string;
    amount: number;
    url: string;
    source?: 'invoice' | 'transaction';
    rowIndex?: number;
    _month?: string;
    txId?: string;
  }>;
  onOpenRangeDownload?: (from?: string, to?: string) => void;
}

export function ClaimsCalendar({ transactions, invoices = [], onOpenRangeDownload }: ClaimsCalendarProps) {
  const { setQuickAddOpen, setEditTransaction, selectedMonth: globalMonth, setSelectedMonth: setGlobalMonth } = useAppStore();
  const [previewItem, setPreviewItem] = useState<{ url: string; title: string; filename: string } | null>(null);
  useLockBodyScroll(Boolean(previewItem));

  // Initialize to globalMonth if valid
  const [currentDate, setCurrentDate] = useState(() => {
    if (globalMonth && globalMonth !== 'all') {
      const targetStr = globalMonth.startsWith('year-') ? `${globalMonth.replace('year-', '')}-01` : globalMonth;
      const [y, m] = targetStr.split('-').map(Number);
      if (!isNaN(y) && !isNaN(m)) {
        return new Date(y, m - 1, 1);
      }
    }
    return new Date();
  });

  const [selectedDateStr, setSelectedDateStr] = useState<string>(() => {
    const today = new Date();
    const todayStr = getLocalDateString(today);
    if (globalMonth && globalMonth !== 'all') {
      const targetStr = globalMonth.startsWith('year-') ? `${globalMonth.replace('year-', '')}-01` : globalMonth;
      const [y, m] = targetStr.split('-').map(Number);
      if (today.getFullYear() === y && (today.getMonth() + 1) === m) {
        return todayStr;
      }
      return `${y}-${String(m).padStart(2, '0')}-01`;
    }
    return todayStr;
  });

  // Automatically sync calendar when global selectedMonth changes anywhere in the app
  useEffect(() => {
    if (!globalMonth || globalMonth === 'all') return;
    const targetStr = globalMonth.startsWith('year-') ? `${globalMonth.replace('year-', '')}-01` : globalMonth;
    const [y, m] = targetStr.split('-').map(Number);
    if (!isNaN(y) && !isNaN(m)) {
      const curY = currentDate.getFullYear();
      const curM = currentDate.getMonth() + 1;
      if (curY !== y || curM !== m) {
        const nextDate = new Date(y, m - 1, 1);
        setCurrentDate(nextDate);
        const today = new Date();
        if (today.getFullYear() === y && (today.getMonth() + 1) === m) {
          setSelectedDateStr(getLocalDateString(today));
        } else {
          setSelectedDateStr(`${y}-${String(m).padStart(2, '0')}-01`);
        }
      }
    }
  }, [globalMonth]);

  const [selectedTx, setSelectedTx] = useState<Transaction | null>(null);

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth(); // 0-indexed

  // Month navigation helper that properly updates both current month AND selected date
  const changeMonth = (targetYear: number, targetMonth: number) => {
    const nextDate = new Date(targetYear, targetMonth, 1);
    setCurrentDate(nextDate);
    const padM = String(nextDate.getMonth() + 1).padStart(2, '0');
    const newMonthStr = `${nextDate.getFullYear()}-${padM}`;

    // Sync with global store so top cards and other tabs follow
    setGlobalMonth(newMonthStr);

    const today = new Date();
    if (today.getFullYear() === nextDate.getFullYear() && today.getMonth() === nextDate.getMonth()) {
      setSelectedDateStr(getLocalDateString(today));
    } else {
      setSelectedDateStr(`${newMonthStr}-01`);
    }
  };

  const prevMonth = () => {
    changeMonth(year, month - 1);
  };

  const nextMonth = () => {
    changeMonth(year, month + 1);
  };

  const goToToday = () => {
    const today = new Date();
    changeMonth(today.getFullYear(), today.getMonth());
  };

  // Pre-populate comprehensive selectable month list (current year 12 months + previous year + transactions)
  const availableMonths = useMemo(() => {
    const list = new Set<string>();
    const currentYear = new Date().getFullYear();
    for (let m = 12; m >= 1; m--) {
      list.add(`${currentYear}-${String(m).padStart(2, '0')}`);
    }
    for (let m = 12; m >= 1; m--) {
      list.add(`${currentYear - 1}-${String(m).padStart(2, '0')}`);
    }
    transactions.forEach((t) => {
      if (t.date && /^\d{4}-\d{2}/.test(t.date)) {
        list.add(t.date.substring(0, 7));
      }
    });
    return Array.from(list).sort().reverse();
  }, [transactions]);

  // Recurring commitment due days mapped from real user commitments
  const recurringDueDays = useMemo(() => {
    if (typeof window === 'undefined') return new Map<number, string[]>();
    try {
      const raw = localStorage.getItem('cashflow_recurring_commitments');
      if (!raw) return new Map<number, string[]>();
      const list = JSON.parse(raw);
      const map = new Map<number, string[]>();
      list.forEach((item: any) => {
        const day = Number(item.dayOfMonth || item.day);
        if (day >= 1 && day <= 31) {
          const existing = map.get(day) || [];
          existing.push(item.name || item.category || 'Commitment');
          map.set(day, existing);
        }
      });
      return map;
    } catch {
      return new Map<number, string[]>();
    }
  }, []);

  const handleAddOnSelectedDate = () => {
    setEditTransaction({
      date: selectedDateStr,
      Date: selectedDateStr,
    });
    setQuickAddOpen(true);
  };

  // Month strings
  const monthLabel = currentDate.toLocaleString('default', { month: 'long', year: 'numeric' });
  const currentMonthKey = `${year}-${String(month + 1).padStart(2, '0')}`;

  // Aggregate daily transactions and receipts
  const dailyData = useMemo(() => {
    const map: Record<string, {
      transactions: Transaction[];
      totalExpense: number;
      totalIncome: number;
      receiptCount: number;
      claimableTotal: number;
    }> = {};

    transactions.forEach((t) => {
      if (!t.date) return;
      const d = t.date;
      if (!map[d]) {
        map[d] = { transactions: [], totalExpense: 0, totalIncome: 0, receiptCount: 0, claimableTotal: 0 };
      }
      map[d].transactions.push(t);
      if (t.type === 'expense') {
        map[d].totalExpense += t.amount;
        if (t.receiptUrl) {
          map[d].receiptCount += 1;
          map[d].claimableTotal += t.amount;
        }
      } else if (t.type === 'income') {
        map[d].totalIncome += t.amount;
      }
    });

    return map;
  }, [transactions]);

  // Monthly summary metrics
  const monthlyMetrics = useMemo(() => {
    let totalExpense = 0;
    let claimableTotal = 0;
    let receiptCount = 0;
    const allClaimItems: Array<{ url: string; filename: string }> = [];

    Object.entries(dailyData).forEach(([dateStr, data]) => {
      if (dateStr.startsWith(currentMonthKey)) {
        totalExpense += data.totalExpense;
        claimableTotal += data.claimableTotal;
        receiptCount += data.receiptCount;

        data.transactions.forEach((t) => {
          if (t.receiptUrl && t.type === 'expense') {
            allClaimItems.push({
              url: t.receiptUrl,
              filename: formatClaimFileName(t.date, t.category, t.amount, t.description),
            });
          }
        });
      }
    });

    return { totalExpense, claimableTotal, receiptCount, allClaimItems };
  }, [dailyData, currentMonthKey]);

  // Calendar grid calculations
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDayIndex = new Date(year, month, 1).getDay(); // 0 is Sunday, 1 is Monday...
  // Normalize so Monday is 0, Sunday is 6
  const startDayOffset = (firstDayIndex + 6) % 7;

  // Selected day data
  const selectedDayInfo = dailyData[selectedDateStr] || {
    transactions: [],
    totalExpense: 0,
    totalIncome: 0,
    receiptCount: 0,
    claimableTotal: 0,
  };

  const handleDownloadAllMonthClaims = async () => {
    if (monthlyMetrics.allClaimItems.length === 0) {
      toast.info('No receipt attachments in this month to download');
      return;
    }
    toast.info(`Downloading ${monthlyMetrics.allClaimItems.length} receipts for claims...`);
    for (const item of monthlyMetrics.allClaimItems) {
      await downloadReceiptFile(item.url, item.filename);
      // Small pause between downloads
      await new Promise((r) => setTimeout(r, 400));
    }
    toast.success('All monthly claim receipts downloaded! 🚀');
  };

  return (
    <div className="space-y-6">
      {/* Month Navigation & Metrics Bar */}
      <div className="rounded-3xl border border-slate-200 dark:border-zinc-800/80 bg-white/90 dark:bg-zinc-900/40 p-5 backdrop-blur-xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl bg-indigo-500/15 border border-indigo-500/20 flex items-center justify-center text-indigo-800 dark:text-indigo-400 shrink-0">
              <CalendarIcon className="h-5 w-5" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg md:text-xl font-extrabold text-slate-950 dark:text-white tracking-tight">
                  {monthLabel}
                </h2>

                {/* Month Jump Selector Dropdown */}
                <select
                  value={currentMonthKey}
                  onChange={(e) => {
                    const [y, m] = e.target.value.split('-').map(Number);
                    changeMonth(y, m - 1);
                  }}
                  className="rounded-xl border border-slate-300 dark:border-zinc-700/80 bg-slate-100 dark:bg-zinc-800/90 px-2.5 py-1 text-xs font-bold text-indigo-800 dark:text-indigo-300 hover:text-slate-950 dark:hover:text-white outline-none focus:border-indigo-500 cursor-pointer shadow-sm hover:bg-slate-200 dark:hover:bg-zinc-700 transition-all"
                >
                  {availableMonths.map((mKey) => {
                    const [y, m] = mKey.split('-').map(Number);
                    const label = new Date(y, m - 1, 1).toLocaleString('default', { month: 'short', year: 'numeric' });
                    return (
                      <option key={mKey} value={mKey} className="bg-white dark:bg-zinc-900 text-slate-950 dark:text-white">
                        {label} ({mKey})
                      </option>
                    );
                  })}
                </select>
              </div>
              <p className="text-xs text-slate-600 dark:text-zinc-400">Daily spending breakdown & allowance claim receipts</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={goToToday}
              className="px-3 py-1.5 rounded-xl border border-slate-300 dark:border-zinc-700 bg-slate-100 dark:bg-zinc-800/90 hover:bg-slate-200 dark:hover:bg-zinc-700 text-xs font-bold text-slate-800 dark:text-zinc-200 transition-colors cursor-pointer shadow-sm"
            >
              Today
            </button>
            <div className="flex rounded-xl border border-slate-300 dark:border-zinc-700 bg-slate-100 dark:bg-zinc-800/80 p-0.5 shadow-sm">
              <button
                onClick={prevMonth}
                className="px-2.5 py-1.5 rounded-lg text-slate-700 dark:text-zinc-300 hover:text-slate-950 dark:hover:text-white hover:bg-slate-200 dark:hover:bg-zinc-700 flex items-center gap-1 text-xs font-semibold transition-colors cursor-pointer"
                title="Previous Month"
              >
                <ChevronLeft className="h-4 w-4" />
                <span className="text-[11px]">Prev</span>
              </button>
              <button
                onClick={nextMonth}
                className="px-2.5 py-1.5 rounded-lg text-slate-700 dark:text-zinc-300 hover:text-slate-950 dark:hover:text-white hover:bg-slate-200 dark:hover:bg-zinc-700 flex items-center gap-1 text-xs font-semibold transition-colors cursor-pointer"
                title="Next Month"
              >
                <span className="text-[11px]">Next</span>
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>

        {/* Month Summary Pillars */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-3 border-t border-slate-200 dark:border-zinc-800/60">
          <div className="p-3 rounded-2xl bg-white/90 dark:bg-zinc-950/60 border border-slate-200 dark:border-zinc-800/60">
            <span className="text-[11px] font-semibold text-slate-600 dark:text-zinc-400 uppercase tracking-wider block">
              Total Month Spend
            </span>
            <span className="text-xl font-black text-rose-800 dark:text-rose-400 mt-1 block">
              RM {monthlyMetrics.totalExpense.toFixed(2)}
            </span>
          </div>

          <div className="p-3 rounded-2xl bg-emerald-950/20 border border-emerald-500/20">
            <span className="text-[11px] font-semibold text-emerald-800 dark:text-emerald-400 uppercase tracking-wider block">
              Claimable with Receipts
            </span>
            <span className="text-xl font-black text-emerald-800 dark:text-emerald-300 mt-1 block">
              RM {monthlyMetrics.claimableTotal.toFixed(2)}
            </span>
          </div>

          <div className="p-3 rounded-2xl bg-indigo-950/20 border border-indigo-500/20 flex flex-wrap items-center justify-between gap-2">
            <div>
              <span className="text-[11px] font-semibold text-indigo-800 dark:text-indigo-300 uppercase tracking-wider block">
                Claim Receipts
              </span>
              <span className="text-xl font-black text-slate-950 dark:text-white mt-1 block">
                {monthlyMetrics.receiptCount} Attached
              </span>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  const firstDay = `${year}-${String(month + 1).padStart(2, '0')}-01`;
                  const lastDayNum = new Date(year, month + 1, 0).getDate();
                  const lastDay = `${year}-${String(month + 1).padStart(2, '0')}-${String(lastDayNum).padStart(2, '0')}`;
                  onOpenRangeDownload?.(firstDay, lastDay);
                }}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-300 dark:border-zinc-700 bg-slate-100 dark:bg-zinc-800/90 hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-800 dark:text-zinc-200 text-xs font-semibold transition-all cursor-pointer"
                title="Download receipts for a custom date range"
              >
                <CalendarIcon className="h-3.5 w-3.5 text-indigo-800 dark:text-indigo-400" />
                <span>Date Range</span>
              </button>

              {monthlyMetrics.receiptCount > 0 && (
                <button
                  type="button"
                  onClick={handleDownloadAllMonthClaims}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-indigo-500 hover:bg-indigo-600 text-white dark:text-white text-xs font-semibold shadow-md transition-all cursor-pointer"
                  title="Download all claim receipts for this month"
                >
                  <Download className="h-3.5 w-3.5" />
                  <span>Download All</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Calendar Grid & Day Inspector Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-7 gap-6">
        {/* Calendar Matrix (4 columns on lg) */}
        <div className="lg:col-span-4 rounded-3xl border border-slate-200 dark:border-zinc-800/80 bg-white/90 dark:bg-zinc-900/40 p-4 md:p-6 backdrop-blur-xl space-y-4">
          {/* Weekday Headers (Mon - Sun) */}
          <div className="grid grid-cols-7 gap-1 text-center text-xs font-bold text-slate-600 dark:text-zinc-400 uppercase tracking-wider pb-2 border-b border-slate-200 dark:border-zinc-800/60">
            <span>Mon</span>
            <span>Tue</span>
            <span>Wed</span>
            <span>Thu</span>
            <span>Fri</span>
            <span>Sat</span>
            <span>Sun</span>
          </div>

          {/* Days Grid */}
          <div className="grid grid-cols-7 gap-1.5">
            {/* Blank offset days */}
            {Array.from({ length: startDayOffset }).map((_, i) => (
              <div key={`empty-${i}`} className="min-h-[64px] rounded-2xl bg-white/90 dark:bg-zinc-950/20 opacity-30" />
            ))}

            {/* Actual Month Days */}
            {Array.from({ length: daysInMonth }).map((_, i) => {
              const dayNum = i + 1;
              const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
              const dayData = dailyData[dateStr];
              const isSelected = selectedDateStr === dateStr;
              const isToday = getLocalDateString() === dateStr;
              const hasSpend = dayData && dayData.totalExpense > 0;
              const hasReceipt = dayData && dayData.receiptCount > 0;

              return (
                <button
                  key={dateStr}
                  onClick={() => setSelectedDateStr(dateStr)}
                  className={`min-h-[64px] sm:min-h-[72px] p-1.5 sm:p-2 rounded-2xl border text-left flex flex-col justify-between transition-all cursor-pointer select-none ${
                    isSelected
                      ? 'border-indigo-500 bg-indigo-500/20 shadow-lg shadow-indigo-500/15 scale-[1.02] z-10'
                      : isToday
                      ? 'border-slate-400 dark:border-zinc-600 bg-white/90 dark:bg-zinc-900/90 shadow-sm'
                      : hasReceipt
                      ? 'border-indigo-500/30 bg-white/90 dark:bg-zinc-950/60 hover:bg-white/90 dark:hover:bg-zinc-900/70 hover:border-indigo-500/50'
                      : 'border-slate-200 dark:border-zinc-800/60 bg-white/90 dark:bg-zinc-950/40 hover:bg-white/90 dark:hover:bg-zinc-900/60 hover:border-slate-300 dark:hover:border-zinc-700'
                  }`}
                >
                  <div className="flex items-start justify-between w-full leading-none">
                    <span className={`text-xs font-bold ${
                      isSelected ? 'text-indigo-800 dark:text-indigo-300' : isToday ? 'text-slate-950 dark:text-white underline decoration-indigo-400 font-extrabold' : 'text-slate-600 dark:text-zinc-400'
                    }`}>
                      {dayNum}
                    </span>
                    <div className="flex items-center gap-0.5 shrink-0">
                      {recurringDueDays.has(dayNum) && (
                        <span title={`Recurring Due: ${recurringDueDays.get(dayNum)?.join(', ')}`} className="text-[9px] leading-none">
                          🔔
                        </span>
                      )}
                      {hasReceipt && (
                        <span
                          title={`${dayData.receiptCount} receipt${dayData.receiptCount > 1 ? 's' : ''} attached`}
                          className="inline-flex items-center justify-center h-4 min-w-[16px] px-1 rounded-full bg-indigo-500/25 text-indigo-800 dark:text-indigo-300 border border-indigo-500/40 text-[9px] font-bold font-mono shadow-[0_0_8px_rgba(99,102,241,0.25)]"
                        >
                          <Receipt className="h-2.5 w-2.5" />
                          {dayData.receiptCount > 1 && <span className="ml-0.5">{dayData.receiptCount}</span>}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="mt-1 min-h-[20px]">
                    {hasSpend ? (
                      <span className="text-[11px] sm:text-xs font-extrabold text-rose-800 dark:text-rose-400 truncate block font-mono">
                        RM {dayData.totalExpense >= 1000 ? `${(dayData.totalExpense / 1000).toFixed(1)}k` : dayData.totalExpense.toFixed(0)}
                      </span>
                    ) : dayData && dayData.totalIncome > 0 ? (
                      <span className="text-[11px] sm:text-xs font-extrabold text-emerald-800 dark:text-emerald-400 truncate block font-mono">
                        +RM {dayData.totalIncome.toFixed(0)}
                      </span>
                    ) : (
                      <span className="text-[10px] text-slate-700 dark:text-zinc-200 block">—</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Selected Day Inspector (3 columns on lg) */}
        <div className="lg:col-span-3 rounded-3xl border border-slate-200 dark:border-zinc-800/80 bg-white/90 dark:bg-zinc-900/40 p-5 md:p-6 backdrop-blur-xl flex flex-col justify-between space-y-4">
          <div className="space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-zinc-800/60">
              <div>
                <span className="text-xs font-bold text-indigo-800 dark:text-indigo-400 uppercase tracking-wider block">
                  Selected Date
                </span>
                <h3 className="text-base md:text-lg font-bold text-slate-950 dark:text-white mt-0.5">
                  {new Date(selectedDateStr).toLocaleDateString('en-MY', {
                    weekday: 'short',
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric'
                  })}
                </h3>
              </div>

              <div className="text-right flex flex-col items-end gap-1">
                <div>
                  <span className="text-xs text-slate-600 dark:text-zinc-400 block">Daily Spend</span>
                  <span className="text-base font-black text-rose-800 dark:text-rose-400">
                    RM {selectedDayInfo.totalExpense.toFixed(2)}
                  </span>
                </div>
                {selectedDayInfo.receiptCount > 0 && (
                  <button
                    type="button"
                    onClick={() => onOpenRangeDownload?.(selectedDateStr, selectedDateStr)}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-800 dark:text-indigo-300 border border-indigo-500/30 text-[11px] font-semibold transition-colors cursor-pointer"
                    title="Download receipts for this day"
                  >
                    <Download className="h-3 w-3" />
                    <span>Download ({selectedDayInfo.receiptCount})</span>
                  </button>
                )}
              </div>
            </div>

            {/* List of transactions for selected day */}
            <div className="space-y-3 max-h-[380px] overflow-y-auto overscroll-contain touch-pan-y [-webkit-overflow-scrolling:touch] custom-scrollbar pr-1">
              {selectedDayInfo.transactions.length === 0 ? (
                <div className="py-10 text-center text-slate-500 dark:text-zinc-400 space-y-2.5">
                  <CalendarIcon className="h-8 w-8 mx-auto text-slate-700 dark:text-zinc-200" />
                  <div>
                    <p className="text-sm font-medium text-slate-700 dark:text-zinc-300">No transactions on this date</p>
                    <p className="text-xs text-slate-500 dark:text-zinc-400">Date: {selectedDateStr}</p>
                  </div>
                  <button
                    type="button"
                    onClick={handleAddOnSelectedDate}
                    className="mt-1 px-3 py-1.5 rounded-xl bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-800 dark:text-indigo-300 border border-indigo-500/30 text-xs font-semibold inline-flex items-center gap-1.5 transition-colors cursor-pointer"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span>Record on {selectedDateStr}</span>
                  </button>
                </div>
              ) : (
                selectedDayInfo.transactions.map((t, idx) => {
                  const isIncome = t.type === 'income';
                  const hasReceipt = Boolean(t.receiptUrl);
                  const claimFileName = formatClaimFileName(t.date, t.category, t.amount, t.description);
                  const receiptThumb = hasReceipt ? getReceiptThumbnailUrl(t.receiptUrl!, 240) : '';

                  return (
                    <div
                      key={t.id || idx}
                      onClick={() => setSelectedTx(t)}
                      className={`p-3.5 sm:p-4 rounded-2xl border transition-all cursor-pointer group shadow-sm hover:shadow-md ${
                        hasReceipt
                          ? 'border-indigo-500/35 bg-gradient-to-br from-indigo-950/20 via-slate-100 dark:via-zinc-900/70 to-white dark:to-zinc-950/90 hover:border-indigo-500/50'
                          : 'border-slate-200 dark:border-zinc-800/80 bg-white/90 dark:bg-zinc-950/60 hover:bg-white/90 dark:hover:bg-zinc-900/60 hover:border-slate-300 dark:hover:border-zinc-700'
                      }`}
                    >
                      {/* Top Header: Title, Category, Amount & Receipt Badge */}
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2.5 min-w-0 flex-1">
                          <div className={`h-8 w-8 rounded-xl flex items-center justify-center shrink-0 ${
                            isIncome
                              ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-400 border border-emerald-500/20'
                              : 'bg-rose-500/15 text-rose-800 dark:text-rose-400 border border-rose-500/20'
                          }`}>
                            {isIncome ? <ArrowDownRight className="h-4 w-4" /> : <ArrowUpRight className="h-4 w-4" />}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <p className="text-xs sm:text-sm font-bold text-slate-950 dark:text-white truncate group-hover:text-indigo-800 dark:group-hover:text-indigo-300 transition-colors">
                                {t.description || t.category}
                              </p>
                              {hasReceipt && (
                                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-indigo-500/20 text-indigo-800 dark:text-indigo-300 border border-indigo-500/30 text-[9px] font-bold shrink-0">
                                  <CheckCircle2 className="h-2.5 w-2.5 text-indigo-800 dark:text-indigo-400" />
                                  <span>Receipt</span>
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-slate-600 dark:text-zinc-400 mt-0.5">
                              {t.category}{t.account && t.account !== 'Cash' && t.account !== 'Default' ? ` • ${t.account}` : ''}
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <span className={`text-sm sm:text-base font-extrabold font-mono tabular-nums ${
                            isIncome ? 'text-emerald-800 dark:text-emerald-400' : 'text-slate-950 dark:text-white'
                          }`}>
                            {isIncome ? '+' : '-'}{t.currency || 'MYR'} {t.amount.toFixed(2)}
                          </span>
                          <ChevronRight className="h-4 w-4 text-slate-600 dark:text-zinc-300 group-hover:text-slate-700 dark:group-hover:text-zinc-300 transition-colors shrink-0" />
                        </div>
                      </div>

                      {/* Receipt Action Card when attached */}
                      {hasReceipt && (
                        <div
                          className="mt-3 p-2.5 rounded-xl bg-white/90 dark:bg-zinc-900/90 border border-slate-200 dark:border-white/[0.08] flex items-center justify-between gap-3 shadow-inner"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {/* Left: Thumbnail & Status */}
                          <div
                            className="flex items-center gap-2.5 min-w-0 flex-1 cursor-pointer"
                            onClick={() => {
                              setPreviewItem({ url: t.receiptUrl!, title: t.description || t.category, filename: claimFileName });
                            }}
                          >
                            <div className="relative h-10 w-10 sm:h-11 sm:w-11 rounded-lg overflow-hidden bg-black/60 border border-slate-200 dark:border-white/10 shrink-0 flex items-center justify-center group/thumb">
                              <img
                                src={receiptThumb}
                                alt="Receipt Thumbnail"
                                className="h-full w-full object-cover transition-transform duration-200 group-hover/thumb:scale-110"
                                onError={(e) => {
                                  (e.target as HTMLElement).style.display = 'none';
                                }}
                              />
                              <Receipt className="absolute h-4 w-4 text-indigo-800/80 dark:text-indigo-400/80 pointer-events-none" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="text-xs font-semibold text-slate-900 dark:text-zinc-100 truncate">
                                Tax Invoice / Receipt
                              </p>
                              <p className="text-[10px] text-indigo-800/90 dark:text-indigo-300/90 font-mono truncate">
                                Ready for Claim • Tap to view
                              </p>
                            </div>
                          </div>

                          {/* Right: Action Buttons */}
                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              type="button"
                              onClick={() => {
                                setPreviewItem({ url: t.receiptUrl!, title: t.description || t.category, filename: claimFileName });
                              }}
                              className="min-h-[36px] px-2.5 py-1.5 rounded-xl bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-800 dark:text-zinc-200 hover:text-slate-950 dark:hover:text-white text-xs font-semibold flex items-center gap-1.5 border border-slate-200 dark:border-white/[0.06] transition-colors cursor-pointer active:scale-[0.96]"
                              title="Preview receipt"
                            >
                              <Eye className="h-3.5 w-3.5" />
                              <span className="hidden xs:inline text-[11px]">View</span>
                            </button>

                            <button
                              type="button"
                              onClick={() => {
                                downloadReceiptFile(t.receiptUrl!, claimFileName);
                              }}
                              className="min-h-[36px] px-2.5 py-1.5 rounded-xl bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-800 dark:text-indigo-300 hover:text-indigo-800 dark:hover:text-indigo-200 text-xs font-semibold flex items-center gap-1.5 border border-indigo-500/30 transition-colors cursor-pointer active:scale-[0.96]"
                              title="Download receipt for claim"
                            >
                              <Download className="h-3.5 w-3.5" />
                              <span className="hidden xs:inline text-[11px]">Claim</span>
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Lightbox Receipt Preview - portaled to body for iOS scroll fix */}
      {typeof document !== 'undefined' && ReactDOM.createPortal(
        <AnimatePresence>
        {previewItem && (
          <div className="fixed inset-0 z-[500] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setPreviewItem(null)}
              className="fixed inset-0 bg-black/90 backdrop-blur-md"
            />

            <motion.div
              role="dialog"
              aria-modal="true"
              aria-label={`Receipt preview: ${previewItem.title}`}
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              transition={{ type: "spring" as const, damping: 28, stiffness: 350 }}
              className="relative w-full max-w-2xl max-h-[calc(100dvh-1.5rem)] overflow-y-auto overscroll-contain touch-pan-y [-webkit-overflow-scrolling:touch] custom-scrollbar rounded-3xl border border-slate-200 dark:border-white/[0.12] bg-white/95 dark:bg-[#090d16]/95 backdrop-blur-3xl p-5 shadow-2xl z-10 flex flex-col space-y-4"
            >
              <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-zinc-800">
                <div className="min-w-0 pr-3">
                  <h3 className="text-sm sm:text-base font-bold text-slate-950 dark:text-white truncate">{previewItem.title}</h3>
                  <p className="text-[11px] font-mono text-slate-600 dark:text-zinc-400 mt-0.5 truncate max-w-xs">{previewItem.filename}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => downloadReceiptFile(previewItem.url, previewItem.filename)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-indigo-500 hover:bg-indigo-600 text-white dark:text-white text-xs font-semibold transition-colors cursor-pointer"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>Download</span>
                  </button>
                  <a
                    href={previewItem.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="p-2 rounded-xl text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white bg-white dark:bg-zinc-900 border border-slate-200 dark:border-white/5 transition-colors"
                    title="Open in Google Drive"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </a>
                  <button
                    onClick={() => setPreviewItem(null)}
                    className="p-2 rounded-xl text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white bg-white dark:bg-zinc-900 border border-slate-200 dark:border-white/5 transition-colors"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-center min-h-[260px] max-h-[70vh] overflow-hidden rounded-2xl bg-black/60 p-2 border border-slate-200 dark:border-white/5 relative">
                <img
                  src={getReceiptThumbnailUrl(previewItem.url, 1200)}
                  alt={previewItem.title}
                  className="max-h-[65vh] max-w-full object-contain rounded-xl"
                  onError={(e) => {
                    const target = e.target as HTMLElement;
                    target.style.display = 'none';
                    const fallback = target.nextElementSibling as HTMLElement;
                    if (fallback) fallback.style.display = 'flex';
                  }}
                />
                <div className="hidden flex-col items-center justify-center p-8 text-center space-y-3">
                  <FileText className="h-12 w-12 text-indigo-800/80 dark:text-indigo-400/80" />
                  <div>
                    <p className="text-sm font-semibold text-slate-950 dark:text-white">Receipt Document</p>
                    <p className="text-xs text-slate-600 dark:text-zinc-400 mt-1">Direct preview not supported for this format.</p>
                  </div>
                  <a
                    href={previewItem.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-4 py-2 rounded-xl bg-indigo-500 text-white dark:text-white text-xs font-semibold inline-flex items-center gap-1.5"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    <span>Open in Google Drive</span>
                  </a>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>,
        document.body
      )}

      {/* Unified Transaction Details Modal with Edit & Delete */}
      <TransactionDetailModal
        transaction={selectedTx}
        onClose={() => setSelectedTx(null)}
      />
    </div>
  );
}
