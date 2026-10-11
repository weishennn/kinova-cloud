'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Shield, CheckCircle2, Clock, Calendar, Plus, Edit2, Check,
  Trash2, AlertCircle, Heart, Home, Wifi, Car, Film, Coffee,
  ShoppingBag, HelpCircle, Sparkles, TrendingUp
} from 'lucide-react';
import { useTransactions } from '@/hooks/useTransactions';
import { addUnifiedRow, applyOptimisticAddToQueryCache } from '@/hooks/useSheets';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  RecurringCommitment,
  getSavedCommitments,
  saveCommitmentsToStorage,
  saveCommitmentsLocallyOnly,
  getCommitmentRateForMonth,
  updateCommitmentRate,
  isTransactionMatchingCommitment
} from '@/lib/recurring-helper';
import { confirmAction } from '@/stores/confirm-dialog-store';
import { getDaysInMonth, getLocalDateString } from '@/lib/date-helper';
import { SETTINGS_UPDATED_EVENT } from '@/lib/cloud-settings-sync';
import { CockpitModalHeader } from '@/components/money-cockpit/cockpit-modal';
import { MoneyCalculator } from '@/components/shared/money-calculator';

const CATEGORY_ICONS: Record<string, { icon: any; color: string }> = {
  'Insurance': { icon: Shield, color: 'text-sky-400 bg-sky-500/10 border-sky-500/20' },
  'Parents': { icon: Heart, color: 'text-rose-800 dark:text-rose-400 bg-rose-500/10 border-rose-500/20' },
  'Family': { icon: Heart, color: 'text-rose-800 dark:text-rose-400 bg-rose-500/10 border-rose-500/20' },
  'Housing & Bills': { icon: Home, color: 'text-amber-800 dark:text-amber-400 bg-amber-500/10 border-amber-500/20' },
  'Bills': { icon: Wifi, color: 'text-cyan-800 dark:text-cyan-400 bg-cyan-500/10 border-cyan-500/20' },
  'Transport': { icon: Car, color: 'text-indigo-800 dark:text-indigo-400 bg-indigo-500/10 border-indigo-500/20' },
  'Entertainment': { icon: Film, color: 'text-violet-800 dark:text-purple-400 bg-purple-500/10 border-purple-500/20' },
  'Food & Dining': { icon: Coffee, color: 'text-orange-800 dark:text-orange-400 bg-orange-500/10 border-orange-500/20' },
  'Shopping': { icon: ShoppingBag, color: 'text-emerald-800 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
};

const AVAILABLE_CATEGORIES = [
  'Insurance',
  'Parents',
  'Housing & Bills',
  'Transport',
  'Entertainment',
  'Food & Dining',
  'Shopping',
  'Other'
];

export function RecurringCommitments() {
  const queryClient = useQueryClient();
  const { transactions = [] } = useTransactions();
  const [commitments, setCommitments] = useState<RecurringCommitment[]>([]);
  const [mounted, setMounted] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<RecurringCommitment | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Form states
  const [formName, setFormName] = useState('');
  const [formCategory, setFormCategory] = useState('Insurance');
  const [formAmount, setFormAmount] = useState('');
  const [formDay, setFormDay] = useState<number | string>(20);
  const [formEffectiveMonth, setFormEffectiveMonth] = useState('');
  const [formAutoRecord, setFormAutoRecord] = useState(false);

  const today = new Date();
  const currentYear = today.getFullYear();
  const currentMonthNum = today.getMonth() + 1;
  const currentDay = today.getDate();
  const currentMonthStr = `${currentYear}-${String(currentMonthNum).padStart(2, '0')}`;

  // Initial load & dynamic cloud sync listener
  useEffect(() => {
    setMounted(true);
    const loaded = getSavedCommitments();
    setCommitments(loaded);

    const handleCloudSync = () => {
      setCommitments(getSavedCommitments());
    };

    window.addEventListener(SETTINGS_UPDATED_EVENT, handleCloudSync);
    return () => {
      window.removeEventListener(SETTINGS_UPDATED_EVENT, handleCloudSync);
    };
  }, []);

  // Financial writes are never triggered merely by opening the page. The
  // project guide requires an explicit user action before recording data.

  // Total monthly commitment sum for this month
  const totalMonthlyCommitments = useMemo(() => {
    return commitments.reduce((sum, c) => {
      return sum + getCommitmentRateForMonth(c, currentMonthStr);
    }, 0);
  }, [commitments, currentMonthStr]);

  const openAddModal = () => {
    setEditingItem(null);
    setFormName('');
    setFormCategory('Parents');
    setFormAmount('');
    setFormDay(1);
    setFormEffectiveMonth(currentMonthStr);
    setFormAutoRecord(false);
    setIsModalOpen(true);
  };

  const openEditModal = (item: RecurringCommitment) => {
    setEditingItem(item);
    setFormName(item.name);
    setFormCategory(item.category);
    setFormAmount(getCommitmentRateForMonth(item, currentMonthStr).toString());
    setFormDay(item.dayOfMonth);
    setFormEffectiveMonth(currentMonthStr);
    setFormAutoRecord(item.autoRecord !== false);
    setIsModalOpen(true);
  };

  const handleDelete = async (id: string, name: string) => {
    const ok = await confirmAction({
      title: 'Remove Recurring Commitment?',
      description: `Remove "${name}"? Past recorded transactions will NOT be affected.`,
      confirmText: 'Remove',
      cancelText: 'Keep',
      variant: 'danger',
      icon: 'trash',
    });
    if (!ok) return;

    const updated = commitments.filter(c => c.id !== id);
    setCommitments(updated);
    saveCommitmentsToStorage(updated);
    toast.success(`Removed "${name}"`);
  };

  const handleSaveModal = (e: React.FormEvent) => {
    e.preventDefault();
    const parsedAmount = parseFloat(formAmount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      toast.error('Please enter a valid amount');
      return;
    }
    if (!formName.trim()) {
      toast.error('Please enter a commitment name');
      return;
    }

    const effectiveMonth = formEffectiveMonth || currentMonthStr;
    const normalizedDay = Math.min(31, Math.max(1, parseInt(String(formDay), 10) || 1));

    if (editingItem) {
      // Update existing item while preserving historical rates!
      const updated = commitments.map(c => {
        if (c.id === editingItem.id) {
          const withRateHistory = updateCommitmentRate(c, parsedAmount, effectiveMonth);
          return {
            ...withRateHistory,
            name: formName.trim(),
            category: formCategory,
            dayOfMonth: normalizedDay,
            autoRecord: formAutoRecord,
          };
        }
        return c;
      });

      setCommitments(updated);
      saveCommitmentsToStorage(updated);
      toast.success(`Updated "${formName}". Rate changes apply from ${effectiveMonth} onwards.`);
    } else {
      // Create new commitment
      const newCommitment: RecurringCommitment = {
        id: `commitment_${Date.now()}`,
        name: formName.trim(),
        category: formCategory,
        dayOfMonth: normalizedDay,
        amount: parsedAmount,
        effectiveFrom: effectiveMonth,
        history: [{ effectiveFrom: effectiveMonth, amount: parsedAmount }],
        autoRecord: formAutoRecord,
      };

      const updated = [...commitments, newCommitment];
      setCommitments(updated);
      saveCommitmentsToStorage(updated);
      toast.success(`Added recurring commitment "${formName}"!`);
    }

    setIsModalOpen(false);
  };

  // Clear stale lastAutoRecordedMonth when transactions are deleted
  useEffect(() => {
    if (!mounted || transactions.length === 0) return;
    let hasStale = false;
    const cleaned = commitments.map(c => {
      if (c.lastAutoRecordedMonth === currentMonthStr) {
        const hasTx = transactions.some(t =>
          isTransactionMatchingCommitment(t, c, currentMonthStr)
        );
        if (!hasTx) {
          hasStale = true;
          return { ...c, lastAutoRecordedMonth: undefined };
        }
      }
      return c;
    });

    if (hasStale) {
      setCommitments(cleaned);
      saveCommitmentsLocallyOnly(cleaned);
    }
  }, [mounted, transactions, currentMonthStr]);

  // Manual 1-click recording (for early payment or manual trigger)
  const handleManualRecord = (commitment: RecurringCommitment, e?: React.MouseEvent<HTMLButtonElement>) => {
    e?.preventDefault();
    e?.stopPropagation();

    // Prevent duplicate recording if already present in this month
    const existing = transactions.find(t =>
      isTransactionMatchingCommitment(t, commitment, currentMonthStr)
    );

    if (existing) {
      toast.warning(`"${commitment.name}" is already recorded for ${currentMonthStr}!`);
      return;
    }

    // Capture the card's viewport position and blur the button before it unmounts
    // so the browser does not jump focus/scroll up to Recent Transactions when
    // the new transaction row is inserted above this section.
    const btn = e?.currentTarget;
    const anchorEl = (btn?.closest('[data-commitment-card]') || btn?.closest('.cockpit-area-commitments')) as HTMLElement | null;
    const beforeTop = anchorEl ? anchorEl.getBoundingClientRect().top : null;
    const savedScrollY = typeof window !== 'undefined' ? window.scrollY : 0;
    btn?.blur();

    const rate = getCommitmentRateForMonth(commitment, currentMonthStr);
    const todayStr = getLocalDateString();
    // Record on today's actual date (e.g. 5th) if in the current month, allowing accurate late/early payments
    const recordDate = todayStr.startsWith(currentMonthStr)
      ? todayStr
      : `${currentMonthStr}-${String(commitment.dayOfMonth).padStart(2, '0')}`;

    const txId = `tx_rec_${String(commitment.id).replace(/[^A-Za-z0-9_-]/g, '_')}_${currentMonthStr}`;
    const subCat = commitment.subCategory || 'Monthly Commitment';
    const notesStr = `[Recurring:${commitment.id}] Monthly recurring commitment (Due ${commitment.dayOfMonth}th)`;

    const optimisticRow = {
      Id: txId,
      id: txId,
      Date: recordDate,
      date: recordDate,
      Type: 'Expense',
      type: 'expense',
      Category: commitment.category,
      category: commitment.category,
      SubCategory: subCat,
      subCategory: subCat,
      Description: commitment.name,
      description: commitment.name,
      Amount: rate,
      amount: rate,
      Currency: 'MYR',
      currency: 'MYR',
      TripTag: '',
      tripTag: '',
      ReceiptUrl: '',
      receiptUrl: '',
      Notes: notesStr,
      notes: notesStr,
      _month: currentMonthStr,
      _rowIndex: 2,
      _forceRestore: true,
    };

    // Instant optimistic UI + local SWR cache update (<10ms)
    applyOptimisticAddToQueryCache(queryClient, currentMonthStr, optimisticRow);

    const updated = commitments.map(c =>
      c.id === commitment.id ? { ...c, lastAutoRecordedMonth: currentMonthStr } : c
    );
    setCommitments(updated);
    saveCommitmentsLocallyOnly(updated);

    // Lock the clicked commitment card in the exact same viewport spot
    if (typeof window !== 'undefined') {
      const restoreViewport = () => {
        if (anchorEl && beforeTop !== null && anchorEl.isConnected) {
          const afterTop = anchorEl.getBoundingClientRect().top;
          const delta = afterTop - beforeTop;
          if (Math.abs(delta) > 1) {
            window.scrollBy({ top: delta, behavior: 'instant' as ScrollBehavior });
          }
        } else if (Math.abs(window.scrollY - savedScrollY) > 10) {
          window.scrollTo({ top: savedScrollY, behavior: 'instant' as ScrollBehavior });
        }
      };
      restoreViewport();
      window.requestAnimationFrame(() => {
        restoreViewport();
        window.requestAnimationFrame(restoreViewport);
      });
    }

    toast.success(`Recorded RM ${rate.toFixed(2)} for ${commitment.name} on ${recordDate}! ⚡`);

    // Asynchronous background sync to Google Sheets
    void (async () => {
      try {
        await addUnifiedRow(currentMonthStr, {
          Id: txId,
          Date: recordDate,
          Type: 'Expense',
          Category: commitment.category,
          SubCategory: subCat,
          Description: commitment.name,
          Amount: rate,
          Currency: 'MYR',
          TripTag: '',
          ReceiptUrl: '',
          Notes: notesStr,
          _forceRestore: true,
        });
        queryClient.invalidateQueries({ queryKey: ['overview'] });
      } catch (err) {
        console.error('Failed to sync recurring commitment in background:', err);
      }
    })();
  };

  if (!mounted) return null;

  return (
    <div className="rounded-3xl border border-slate-200 dark:border-white/[0.08] bg-card/60 p-6 backdrop-blur-2xl shadow-xl space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-base font-extrabold text-slate-950 dark:text-white tracking-tight flex items-center gap-2">
              <span>Monthly Recurring Commitments</span>
              <span className="text-[10px] px-2.5 py-0.5 rounded-full font-bold bg-indigo-500/20 text-indigo-800 dark:text-indigo-300 border border-indigo-500/30">
                Auto-Record Active
              </span>
            </h3>
          </div>
          <p className="text-xs text-slate-600 dark:text-zinc-400 mt-0.5">
            Auto-adds to your expenses on the due date • Historical records before rate changes stay untouched
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="text-right">
            <span className="text-[10px] text-slate-600 dark:text-zinc-400 uppercase tracking-wider block">Monthly Total</span>
            <span className="text-sm font-bold text-slate-950 dark:text-white font-mono tabular-nums">
              RM {totalMonthlyCommitments.toFixed(2)}
            </span>
          </div>

          <button
            type="button"
            onClick={openAddModal}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-2xl bg-indigo-500 hover:bg-indigo-600 text-white dark:text-white text-xs font-semibold shadow-md shadow-indigo-500/20 transition-all cursor-pointer"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Add Commitment</span>
          </button>
        </div>
      </div>

      {/* Commitments List */}
      <div className="grid gap-3 sm:grid-cols-2">
        {commitments.map((item) => {
          const currentRate = getCommitmentRateForMonth(item, currentMonthStr);
          const iconConfig = CATEGORY_ICONS[item.category] || { icon: Shield, color: 'text-indigo-800 dark:text-indigo-400 bg-indigo-500/10 border-indigo-500/20' };
          const IconComponent = iconConfig.icon;

          // Check if recorded for this month
          const matchedTx = transactions.find(t =>
            isTransactionMatchingCommitment(t, item, currentMonthStr)
          );

          const daysInCurrentMonth = getDaysInMonth(currentYear, currentMonthNum);
          const effectiveDueDay = Math.min(item.dayOfMonth, daysInCurrentMonth);
          const isRecorded = !!matchedTx;
          const isDueOrPast = currentDay >= effectiveDueDay;

          // Check if future scheduled change exists
          const futureRateChange = item.history?.find(h => h.effectiveFrom > currentMonthStr);

          return (
            <motion.div
              key={item.id}
              data-commitment-card
              whileHover={{ y: -3, scale: 1.01 }}
              transition={{ type: 'spring' as const, stiffness: 400, damping: 25 }}
              className={`rounded-3xl border p-4 transition-all duration-300 specular-card shadow-sm hover:shadow-md ${
                isRecorded
                  ? 'border-emerald-500/25 bg-gradient-to-br from-emerald-950/20 via-slate-100 dark:via-zinc-900/60 to-white dark:to-zinc-950 hover:border-emerald-500/40'
                  : isDueOrPast
                    ? 'border-amber-500/25 bg-gradient-to-br from-amber-950/20 via-slate-100 dark:via-zinc-900/60 to-white dark:to-zinc-950 hover:border-amber-500/40'
                    : 'border-slate-200 dark:border-zinc-800/80 bg-gradient-to-br from-zinc-900/70 via-slate-100 dark:via-zinc-900/50 to-white dark:to-zinc-950 hover:border-slate-300 dark:hover:border-zinc-700/80'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className={`h-11 w-11 rounded-2xl flex items-center justify-center border shadow-sm ${iconConfig.color}`}>
                    <IconComponent className="h-5 w-5" />
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-slate-950 dark:text-white flex items-center gap-1.5">
                      <span>{item.name}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-lg font-mono text-slate-700 dark:text-zinc-300 bg-slate-100 dark:bg-zinc-800 border border-slate-300 dark:border-zinc-700/50">
                        {item.dayOfMonth}th
                      </span>
                    </h4>
                    <span className="text-xs text-slate-600 dark:text-zinc-400 block font-mono font-semibold mt-0.5">
                      RM {currentRate.toFixed(2)} / month
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => openEditModal(item)}
                    className="p-1.5 rounded-xl text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                    title="Edit amount or effective date"
                  >
                    <Edit2 className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(item.id, item.name)}
                    className="p-1.5 rounded-xl text-slate-500 dark:text-zinc-400 hover:text-rose-800 dark:hover:text-rose-400 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                    title="Delete commitment"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              {/* Status and Action Row */}
              <div className="mt-3 pt-3 border-t border-slate-200 dark:border-zinc-800/60 flex items-center justify-between gap-2">
                <div className="text-xs">
                  {isRecorded ? (
                    <span className="text-emerald-800 dark:text-emerald-400 font-semibold flex items-center gap-1.5">
                      <CheckCircle2 className="h-4 w-4" />
                      <span>Recorded for {currentMonthStr}</span>
                    </span>
                  ) : isDueOrPast ? (
                    <span className="text-amber-800 dark:text-amber-400 font-semibold flex items-center gap-1.5">
                      <Clock className="h-4 w-4" />
                      <span>Due on {effectiveDueDay}th • Pending</span>
                    </span>
                  ) : (
                    <span className="text-slate-600 dark:text-zinc-400 flex items-center gap-1.5 font-medium">
                      <Calendar className="h-4 w-4 text-slate-500 dark:text-zinc-400" />
                      <span>In {effectiveDueDay - currentDay} days ({currentMonthStr}-{String(effectiveDueDay).padStart(2, '0')})</span>
                    </span>
                  )}

                  {/* Future rate note if scheduled */}
                  {futureRateChange && (
                    <span className="text-[10px] text-indigo-800 dark:text-indigo-300 font-mono block mt-1">
                      📈 Increases to RM {futureRateChange.amount.toFixed(2)} in {futureRateChange.effectiveFrom}
                    </span>
                  )}
                </div>

                {!isRecorded && (
                  <button
                    type="button"
                    onClick={(e) => handleManualRecord(item, e)}
                    disabled={isSubmitting}
                    className="px-3.5 py-1.5 rounded-xl bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-800 dark:text-zinc-200 text-xs font-semibold border border-slate-300 dark:border-zinc-700/50 transition-colors cursor-pointer shrink-0 disabled:opacity-50"
                  >
                    {isDueOrPast ? 'Record Now' : 'Record Early'}
                  </button>
                )}
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* Add / Edit Modal */}
      {typeof document !== 'undefined' && createPortal(
        <AnimatePresence>
          {isModalOpen && (
            <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setIsModalOpen(false)}
                className="fixed inset-0 bg-black/85 backdrop-blur-md"
              />

              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 15 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 15 }}
                className="relative z-10 w-full max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain touch-pan-y [-webkit-overflow-scrolling:touch] rounded-3xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-5 sm:p-6 shadow-2xl"
                role="dialog"
                aria-modal="true"
                aria-labelledby="recurring-commitment-dialog-title"
                aria-describedby="recurring-commitment-dialog-description"
              >
                <CockpitModalHeader
                  title={editingItem ? `Edit ${editingItem.name}` : 'Add a commitment'}
                  titleId="recurring-commitment-dialog-title"
                  description="Set the amount, category, and monthly due date."
                  descriptionId="recurring-commitment-dialog-description"
                  icon={<Calendar size={20} />}
                  onClose={() => setIsModalOpen(false)}
                  closeLabel="Close commitment form"
                />

                <form onSubmit={handleSaveModal} className="mt-4 space-y-4">
                {/* Name */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-slate-600 dark:text-zinc-400">Commitment Name</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Monthly Insurance, Give Parents, Rent"
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    className="w-full rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/60 p-3 text-xs text-slate-950 dark:text-white outline-none focus:border-indigo-500"
                  />
                </div>

                {/* Category & Day Grid */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-slate-600 dark:text-zinc-400">Category</label>
                    <select
                      value={formCategory}
                      onChange={(e) => setFormCategory(e.target.value)}
                      className="w-full rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/60 p-3 text-xs text-slate-950 dark:text-white outline-none focus:border-indigo-500"
                    >
                      {AVAILABLE_CATEGORIES.map(cat => (
                        <option key={cat} value={cat}>{cat}</option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-slate-600 dark:text-zinc-400">Due Day (1-31)</label>
                    <input
                      type="number"
                      min={1}
                      max={31}
                      required
                      value={formDay}
                      onChange={(e) => setFormDay(e.target.value)}
                      onBlur={() => setFormDay(Math.min(31, Math.max(1, parseInt(String(formDay), 10) || 1)))}
                      className="w-full rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/60 p-3 text-xs text-slate-950 dark:text-white font-mono outline-none focus:border-indigo-500"
                    />
                  </div>
                </div>

                {/* Amount */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-slate-600 dark:text-zinc-400">Monthly Amount (RM)</label>
                  <input
                    type="number"
                    step="0.01"
                    required
                    placeholder="0.00"
                    value={formAmount}
                    onChange={(e) => setFormAmount(e.target.value)}
                    className="w-full rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/60 p-3 text-sm font-bold text-slate-950 dark:text-white font-mono outline-none focus:border-indigo-500"
                  />
                  <MoneyCalculator
                    value={formAmount}
                    onChange={setFormAmount}
                    currency="MYR"
                    compact
                  />
                </div>

                {/* Effective Starting Month */}
                <div className="space-y-1.5 p-3.5 rounded-2xl bg-white/90 dark:bg-zinc-900/40 border border-slate-200 dark:border-zinc-800/80">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-semibold text-slate-800 dark:text-zinc-200 block">
                      Effective Starting Month
                    </label>
                    <span className="text-[10px] text-indigo-800 dark:text-indigo-400 font-mono">Preserves Past Data</span>
                  </div>
                  <input
                    type="text"
                    placeholder="YYYY-MM (e.g. 2026-09, 2027-01)"
                    value={formEffectiveMonth}
                    onChange={(e) => setFormEffectiveMonth(e.target.value)}
                    className="w-full rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-2.5 text-xs text-slate-950 dark:text-white font-mono outline-none focus:border-indigo-500"
                  />
                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    <button
                      type="button"
                      onClick={() => setFormEffectiveMonth(currentMonthStr)}
                      className={`text-[11px] px-2.5 py-1 rounded-lg transition-colors cursor-pointer ${
                        formEffectiveMonth === currentMonthStr
                          ? 'bg-indigo-500 text-white dark:text-white font-bold'
                          : 'bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-700 dark:text-zinc-300'
                      }`}
                    >
                      Current Month ({currentMonthStr})
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const nextM = currentMonthNum === 12
                          ? `${currentYear + 1}-01`
                          : `${currentYear}-${String(currentMonthNum + 1).padStart(2, '0')}`;
                        setFormEffectiveMonth(nextM);
                      }}
                      className="text-[11px] px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-700 dark:text-zinc-300 transition-colors cursor-pointer"
                    >
                      Next Month
                    </button>
                  </div>
                  <p className="text-[11px] text-slate-600 dark:text-zinc-400 mt-1 leading-relaxed">
                    💡 If this amount changes in the future (e.g. increases in 2027-01), set that month here. All previous records will <strong>remain strictly unchanged</strong>.
                  </p>
                </div>

                {/* Auto-record checkbox */}
                <label className="flex items-center gap-2.5 p-3 rounded-2xl bg-white/90 dark:bg-zinc-900/40 border border-slate-200 dark:border-zinc-800/60 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formAutoRecord}
                    onChange={(e) => setFormAutoRecord(e.target.checked)}
                    className="h-4 w-4 rounded accent-indigo-500"
                  />
                  <div className="text-xs text-left">
                    <span className="font-semibold text-slate-800 dark:text-zinc-200 block">Auto-record on due day</span>
                    <span className="text-[11px] text-slate-600 dark:text-zinc-400 block">
                      Automatically writes to your Google Sheet on the {formDay}th of each month
                    </span>
                  </div>
                </label>

                {/* Full-width touch-friendly Buttons */}
                <div className="pt-3 border-t border-slate-200 dark:border-zinc-800/80 space-y-2">
                  <button
                    type="submit"
                    className="w-full py-3.5 px-4 rounded-2xl bg-gradient-to-r from-indigo-500 via-indigo-600 to-purple-600 hover:from-indigo-600 hover:to-purple-700 active:scale-[0.98] text-white dark:text-white font-bold text-sm shadow-xl shadow-indigo-500/25 transition-all cursor-pointer flex items-center justify-center gap-2"
                  >
                    <Check className="h-4 w-4" />
                    <span>{editingItem ? 'Save Changes' : 'Create Commitment'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsModalOpen(false)}
                    className="w-full py-2.5 rounded-2xl text-xs text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white hover:bg-white dark:hover:bg-zinc-900 transition-colors text-center cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </div>
  );
}
