'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  CreditCard, Calendar, Clock, Trash2, CheckCircle2,
  ArrowRight, Sparkles, AlertCircle, Percent, Loader2, Tag
} from 'lucide-react';
import { useAppStore } from '@/stores/app-store';
import { 
  calculateInstallmentPlan, 
  updateInstallmentPlan, 
  deleteInstallmentPlan,
  removeSavedInstallmentPlan,
  upsertSavedInstallmentPlan,
  GroupedInstallmentPlan,
  INSTALLMENT_PRESET_MONTHS,
  MAX_INSTALLMENT_MONTHS,
  MIN_INSTALLMENT_MONTHS,
} from '@/lib/installment-helper';
import { applyOptimisticAddToQueryCache, applyOptimisticDeleteToQueryCache } from '@/hooks/useSheets';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { getLocalDateString, parseLocalDate, shiftMonthSafe, normalizeDateString } from '@/lib/date-helper';
import { useLockBodyScroll } from '@/hooks/useLockBodyScroll';
import { CockpitModalHeader } from '@/components/money-cockpit/cockpit-modal';
import { MoneyCalculator } from '@/components/shared/money-calculator';
import { confirmAction } from '@/stores/confirm-dialog-store';

const COMMON_CATEGORIES = [
  'Shopping', 'Electronics', 'Housing & Bills', 'Transport', 
  'Health', 'Education', 'Entertainment', 'Other'
];

export function EditInstallmentModal() {
  const { editInstallmentPlan, setEditInstallmentPlan } = useAppStore();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  useLockBodyScroll(Boolean(editInstallmentPlan));

  if (!mounted || typeof document === 'undefined') return null;

  return createPortal(
    <AnimatePresence>
      {editInstallmentPlan && (
        <EditInstallmentContent
          plan={editInstallmentPlan}
          onClose={() => setEditInstallmentPlan(null)}
        />
      )}
    </AnimatePresence>,
    document.body,
  );
}

function EditInstallmentContent({
  plan,
  onClose,
}: {
  plan: GroupedInstallmentPlan;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();

  const [name, setName] = useState(plan.name || '');
  const [category, setCategory] = useState(plan.category || 'Shopping');
  const [totalAmount, setTotalAmount] = useState(String(plan.totalPayable || (plan.monthlyAmount * plan.totalTenure)));
  const initialTenureMonths = plan.totalTenure || 12;
  const [tenureMonths, setTenureMonths] = useState(initialTenureMonths);
  const [customTenureMonths, setCustomTenureMonths] = useState(() =>
    INSTALLMENT_PRESET_MONTHS.some((months) => months === initialTenureMonths) ? '' : String(initialTenureMonths)
  );
  const [startDate, setStartDate] = useState(plan.startDate || getLocalDateString());
  const rate = plan.annualInterestRate || 0;
  const [hasInterest, setHasInterest] = useState(rate > 0);
  const [annualInterestRate, setAnnualInterestRate] = useState(String(rate));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Quick Start Date shifts
  const shiftToNextMonth = () => {
    try {
      const current = parseLocalDate(startDate || getLocalDateString());
      const nextMonth = shiftMonthSafe(current, 1);
      setStartDate(getLocalDateString(nextMonth));
    } catch {
      const nextMonth = shiftMonthSafe(new Date(), 1);
      setStartDate(getLocalDateString(nextMonth));
    }
  };

  const shiftToFirstOfNextMonth = () => {
    try {
      const current = parseLocalDate(startDate || getLocalDateString());
      const nextMonth = new Date(current.getFullYear(), current.getMonth() + 1, 1);
      const yyyy = nextMonth.getFullYear();
      const mm = String(nextMonth.getMonth() + 1).padStart(2, '0');
      setStartDate(`${yyyy}-${mm}-01`);
    } catch {
      const today = new Date();
      today.setMonth(today.getMonth() + 1);
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      setStartDate(`${yyyy}-${mm}-01`);
    }
  };

  const resetToToday = () => {
    setStartDate(getLocalDateString());
  };

  // Live calculation preview
  const parsedTotal = parseFloat(totalAmount) || 0;
  const currency = plan.currency || 'MYR';
  const effectiveTenureMonths = customTenureMonths === '' ? tenureMonths : Number(customTenureMonths);

  const previewPlan = useMemo(() => {
    if (
      parsedTotal <= 0 ||
      !Number.isInteger(effectiveTenureMonths) ||
      effectiveTenureMonths < MIN_INSTALLMENT_MONTHS ||
      effectiveTenureMonths > MAX_INSTALLMENT_MONTHS
    ) return null;
    return calculateInstallmentPlan({
      baseDescription: name || 'Purchase',
      totalPrincipal: parsedTotal,
      tenureMonths: effectiveTenureMonths,
      annualInterestRate: hasInterest ? (parseFloat(annualInterestRate) || 0) : 0,
      startDate: startDate || getLocalDateString(),
      currency,
      category,
    });
  }, [name, parsedTotal, tenureMonths, customTenureMonths, effectiveTenureMonths, hasInterest, annualInterestRate, startDate, currency, category]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.error('Please enter a plan name');
      return;
    }
    if (parsedTotal <= 0) {
      toast.error('Please enter a valid total amount');
      return;
    }
    if (
      !Number.isInteger(effectiveTenureMonths) ||
      effectiveTenureMonths < MIN_INSTALLMENT_MONTHS ||
      effectiveTenureMonths > MAX_INSTALLMENT_MONTHS
    ) {
      toast.error(`Installment duration must be a whole number from ${MIN_INSTALLMENT_MONTHS} to ${MAX_INSTALLMENT_MONTHS} months`);
      return;
    }
    if (!startDate) {
      toast.error('Please select a start date');
      return;
    }

    const newParams = {
      baseDescription: name.trim(),
      totalPrincipal: parsedTotal,
      tenureMonths: effectiveTenureMonths,
      annualInterestRate: hasInterest ? (parseFloat(annualInterestRate) || 0) : 0,
      startDate,
      currency,
      category,
    };

    const newPlan = calculateInstallmentPlan(newParams);
    if (!newPlan || newPlan.schedule.length === 0) {
      toast.error('Failed to recalculate installment plan');
      return;
    }

    // 1. Instant optimistic removal of old transactions (<10ms)
    for (const tx of plan.transactions || []) {
      const sheet = tx._month || (tx.date ? tx.date.substring(0, 7) : 'Transactions');
      applyOptimisticDeleteToQueryCache(queryClient, sheet, tx._rowIndex, tx.id);
    }

    // 2. Instant local plan storage update
    if (plan.name && plan.name.toLowerCase() !== name.trim().toLowerCase()) {
      removeSavedInstallmentPlan(plan.name);
    }
    const firstItem = newPlan.schedule[0];
    const lastItem = newPlan.schedule[newPlan.schedule.length - 1];
    const planId = `plan_${Date.now()}`;

    upsertSavedInstallmentPlan({
      id: planId,
      name: newParams.baseDescription,
      category: newParams.category,
      currency: newParams.currency,
      totalPrincipal: newParams.totalPrincipal,
      tenureMonths: newParams.tenureMonths,
      annualInterestRate: newParams.annualInterestRate,
      monthlyAmount: newPlan.monthlyAmount,
      totalPayable: newPlan.totalPayable,
      startDate: newParams.startDate,
      endDate: lastItem.month,
      autoRecord: true,
    });

    // 3. Instant optimistic insertion of Month 1 if due today or earlier
    const todayStr = getLocalDateString();
    if (firstItem.date <= todayStr) {
      const firstRowId = `tx_inst_${planId}_1`;
      applyOptimisticAddToQueryCache(queryClient, firstItem.month, {
        Id: firstRowId,
        id: firstRowId,
        Date: firstItem.date,
        date: firstItem.date,
        Type: 'Expense',
        type: 'expense',
        Category: newParams.category,
        category: newParams.category,
        SubCategory: '',
        subCategory: '',
        Description: firstItem.description,
        description: firstItem.description,
        Amount: firstItem.amount,
        amount: firstItem.amount,
        Currency: newParams.currency,
        currency: newParams.currency,
        TripTag: '',
        tripTag: '',
        ReceiptUrl: '',
        receiptUrl: '',
        Notes: firstItem.notes,
        notes: firstItem.notes,
        _month: firstItem.month,
        _rowIndex: 2,
      });
    }

    toast.success(`Installment plan "${name}" updated! First payment rescheduled to ${startDate}. ⚡`);
    onClose();

    // 4. Asynchronous background sync to Google Sheets
    void updateInstallmentPlan(plan.transactions || [], newParams, plan.name, planId).then(() => {
      queryClient.invalidateQueries({ queryKey: ['overview'] });
    }).catch((err) => {
      console.error('Background installment plan update failed:', err);
    });
  };

  const handleDeleteEntirePlan = async () => {
    const txCount = plan.transactions?.length || 0;
    const confirmMsg = txCount > 0
      ? `Permanently delete the entire installment plan for "${plan.name}"? All ${txCount} monthly installment transactions will be removed.`
      : `Permanently delete the installment plan for "${plan.name}"?`;

    const ok = await confirmAction({
      title: 'Delete Entire Installment Plan?',
      description: confirmMsg,
      confirmText: 'Delete Entire Plan',
      cancelText: 'Cancel',
      variant: 'danger',
      icon: 'trash',
    });
    if (!ok) return;

    // 1. Instant optimistic removal from local storage and React Query cache (<10ms)
    removeSavedInstallmentPlan(plan.name);
    for (const tx of plan.transactions || []) {
      const sheet = tx._month || (tx.date ? tx.date.substring(0, 7) : 'Transactions');
      applyOptimisticDeleteToQueryCache(queryClient, sheet, tx._rowIndex, tx.id);
    }

    toast.success(`Installment plan "${plan.name}" deleted. ⚡`);
    onClose();

    // 2. Asynchronous background deletion in Google Sheets
    void deleteInstallmentPlan(plan.transactions || [], plan.name).then(() => {
      queryClient.invalidateQueries({ queryKey: ['overview'] });
    }).catch((err) => {
      console.error('Background installment plan delete failed:', err);
    });
  };

  return (
    <div className="fixed inset-0 z-[220] flex items-center justify-center p-4">
      {/* Backdrop */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        onClick={onClose}
        className="fixed inset-0 bg-black/80 backdrop-blur-md"
      />

      {/* Modal Window */}
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-installment-title"
        aria-describedby="edit-installment-description"
        initial={{ opacity: 0, scale: 0.95, y: 15 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 15 }}
        transition={{ type: 'spring', damping: 28, stiffness: 350 }}
        className="relative w-full max-w-xl max-h-[calc(100dvh-1.5rem)] overflow-y-auto overscroll-contain touch-pan-y [-webkit-overflow-scrolling:touch] custom-scrollbar rounded-3xl border border-purple-500/30 bg-white/95 dark:bg-[#090d16]/95 backdrop-blur-3xl p-6 shadow-2xl z-10 space-y-5"
      >
        <CockpitModalHeader
          title="Edit installment plan"
          titleId="edit-installment-title"
          description="Adjust the plan schedule, amount, or start date."
          descriptionId="edit-installment-description"
          icon={<CreditCard size={20} />}
          onClose={onClose}
          closeLabel="Close installment editor"
        />

          <form onSubmit={handleSave} className="space-y-4">
            {/* Plan Name & Category */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-[11px] font-semibold text-slate-600 dark:text-zinc-400 uppercase tracking-wider block">Plan Name</label>
                <input
                  type="text"
                  placeholder="e.g. MacBook Pro M3, iPhone 16"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/80 px-3.5 py-2.5 text-sm text-slate-950 dark:text-white font-semibold outline-none focus:border-purple-500 transition-colors"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-[11px] font-semibold text-slate-600 dark:text-zinc-400 uppercase tracking-wider block">Category</label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/80 px-3 py-2.5 text-xs text-slate-950 dark:text-white outline-none focus:border-purple-500 cursor-pointer transition-colors"
                >
                  {COMMON_CATEGORIES.map((c) => (
                    <option key={c} value={c} className="bg-white dark:bg-zinc-900 text-slate-950 dark:text-white">
                      {c}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* First Installment Start Date & Quick Next-Month Shifter */}
            <div className="p-3.5 rounded-2xl border border-purple-500/20 bg-purple-950/15 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <label className="text-xs font-bold text-slate-950 dark:text-white flex items-center gap-1.5">
                    <Calendar className="h-3.5 w-3.5 text-violet-800 dark:text-purple-400" />
                    First Installment Start Date
                  </label>
                  <p className="text-[11px] text-slate-600 dark:text-zinc-400">When does the bank first charge this installment?</p>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={shiftToNextMonth}
                    className="px-2.5 py-1 rounded-lg bg-purple-500/20 hover:bg-purple-500/30 text-violet-800 dark:text-purple-300 border border-purple-500/30 text-[11px] font-semibold transition-all cursor-pointer shadow-sm active:scale-95"
                    title="Move start date +1 month forward"
                  >
                    📅 Start Next Month
                  </button>
                  <button
                    type="button"
                    onClick={shiftToFirstOfNextMonth}
                    className="px-2 py-1 rounded-lg bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-700 dark:text-zinc-300 border border-slate-300 dark:border-zinc-700 text-[11px] font-medium transition-all cursor-pointer active:scale-95"
                  >
                    1st of Next Month
                  </button>
                  <button
                    type="button"
                    onClick={resetToToday}
                    className="px-2 py-1 rounded-lg bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-600 dark:text-zinc-400 hover:text-slate-800 dark:hover:text-zinc-200 border border-slate-300 dark:border-zinc-700 text-[11px] font-medium transition-all cursor-pointer active:scale-95"
                  >
                    Today
                  </button>
                </div>
              </div>

              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full rounded-xl border border-slate-300 dark:border-zinc-700 bg-white/90 dark:bg-zinc-900/90 px-3 py-2 text-xs text-slate-950 dark:text-white font-mono outline-none focus:border-purple-400"
              />
            </div>

            {/* Total Principal & Tenure */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-[11px] font-semibold text-slate-600 dark:text-zinc-400 uppercase tracking-wider block">
                  Total Purchase Price ({currency})
                </label>
                <div className="relative flex items-center">
                  <span className="absolute left-3 text-xs font-bold text-slate-500 dark:text-zinc-400 font-mono">{currency}</span>
                  <input
                    type="number"
                    step="0.01"
                    placeholder="0.00"
                    value={totalAmount}
                    onChange={(e) => setTotalAmount(e.target.value)}
                    className="w-full rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/80 py-2.5 pl-12 pr-3 text-base text-slate-950 dark:text-white font-mono font-bold outline-none focus:border-purple-500 transition-colors"
                  />
                </div>
                <MoneyCalculator
                  value={totalAmount}
                  onChange={setTotalAmount}
                  currency={currency}
                  compact
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-[11px] font-semibold text-slate-600 dark:text-zinc-400 uppercase tracking-wider block">
                  Tenure (Months)
                </label>
                <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
                  {INSTALLMENT_PRESET_MONTHS.map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => {
                        setTenureMonths(m);
                        setCustomTenureMonths('');
                      }}
                      aria-pressed={tenureMonths === m && customTenureMonths === ''}
                      className={`min-h-[44px] rounded-xl text-xs font-bold border transition-all cursor-pointer touch-manipulation ${
                        tenureMonths === m && customTenureMonths === ''
                          ? 'border-purple-500 bg-purple-600 text-white dark:text-white shadow-sm'
                          : 'border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/60 text-slate-600 dark:text-zinc-400 hover:border-slate-300 dark:hover:border-zinc-700 hover:text-slate-950 dark:hover:text-white'
                      }`}
                    >
                      {m}M
                    </button>
                  ))}
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <label htmlFor="edit-custom-installment-months" className="sr-only">Custom installment duration in months</label>
                  <input
                    id="edit-custom-installment-months"
                    type="number"
                    inputMode="numeric"
                    min={MIN_INSTALLMENT_MONTHS}
                    max={MAX_INSTALLMENT_MONTHS}
                    step="1"
                    placeholder="Custom months"
                    value={customTenureMonths}
                    onChange={(e) => {
                      const next = e.target.value;
                      setCustomTenureMonths(next);
                    }}
                    className="min-h-[44px] w-full rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/60 px-3 py-2 text-sm text-slate-950 dark:text-white font-mono outline-none transition-colors placeholder:text-slate-600 dark:placeholder:text-zinc-300 focus:border-purple-500"
                  />
                  <span className="shrink-0 text-xs text-slate-500 dark:text-zinc-400">months</span>
                </div>
                <p className="text-[10px] text-slate-500 dark:text-zinc-400">Choose a preset or enter any whole number from {MIN_INSTALLMENT_MONTHS}–{MAX_INSTALLMENT_MONTHS} months.</p>
              </div>
            </div>

            {/* Interest Option */}
            <div className="space-y-2 pt-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-600 dark:text-zinc-400 font-medium">Interest Option</span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setHasInterest(false);
                      setAnnualInterestRate('0');
                    }}
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition-all cursor-pointer ${
                      !hasInterest
                        ? 'border-emerald-500 bg-emerald-500/20 text-emerald-800 dark:text-emerald-300'
                        : 'border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:hover:text-zinc-300'
                    }`}
                  >
                    0% Interest (EPP)
                  </button>
                  <button
                    type="button"
                    onClick={() => setHasInterest(true)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition-all cursor-pointer ${
                      hasInterest
                        ? 'border-purple-500 bg-purple-500/20 text-violet-800 dark:text-purple-300'
                        : 'border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:hover:text-zinc-300'
                    }`}
                  >
                    With Interest Rate
                  </button>
                </div>
              </div>

              {hasInterest && (
                <div className="relative flex items-center">
                  <Percent className="absolute left-3 h-3.5 w-3.5 text-slate-500 dark:text-zinc-400" />
                  <input
                    type="number"
                    step="0.01"
                    placeholder="Annual Interest Rate % (e.g. 3.5)"
                    value={annualInterestRate}
                    onChange={(e) => setAnnualInterestRate(e.target.value)}
                    className="w-full rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/80 py-2 pl-9 pr-3 text-xs text-slate-950 dark:text-white font-mono outline-none focus:border-purple-500"
                  />
                </div>
              )}
            </div>

            {/* Live Schedule Timeline Preview */}
            {previewPlan && (
              <div className="rounded-2xl bg-white/90 dark:bg-zinc-900/60 border border-slate-200 dark:border-zinc-800/80 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-950 dark:text-white flex items-center gap-1.5">
                    <Sparkles className="h-3.5 w-3.5 text-violet-800 dark:text-purple-400" />
                    Calculated Installment Schedule
                  </span>
                  <div className="text-right">
                    <span className="text-[10px] text-slate-500 dark:text-zinc-400 uppercase block">Monthly</span>
                    <span className="text-sm font-black font-mono text-violet-800 dark:text-purple-400">
                      {currency} {previewPlan.monthlyAmount.toFixed(2)} / mo
                    </span>
                  </div>
                </div>

                {/* Timeline pill preview */}
                <div className="max-h-36 overflow-y-auto overscroll-contain touch-pan-y [-webkit-overflow-scrolling:touch] space-y-1.5 pr-1 custom-scrollbar">
                  {previewPlan.schedule.map((item) => (
                    <div 
                      key={item.installmentIndex}
                      className="flex items-center justify-between py-1 px-2.5 rounded-xl bg-white/90 dark:bg-zinc-950/60 border border-slate-200 dark:border-zinc-800/60 text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-violet-800 dark:text-purple-300 font-bold text-[11px] w-12">
                          M{item.installmentIndex}/{item.totalTenure}
                        </span>
                        <span className="text-slate-700 dark:text-zinc-300 font-medium">{item.date}</span>
                        <span className="text-[10px] text-slate-500 dark:text-zinc-400">({item.month})</span>
                      </div>
                      <span className="font-mono font-bold text-slate-950 dark:text-white">
                        {currency} {item.amount.toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>

                <div className="flex items-center justify-between text-[11px] text-slate-600 dark:text-zinc-400 pt-1 border-t border-slate-200 dark:border-zinc-800/60">
                  <span>Total Payable: <strong className="text-slate-950 dark:text-white">{currency} {previewPlan.totalPayable.toFixed(2)}</strong></span>
                  <span>Timeline: <strong className="text-violet-800 dark:text-purple-300">{previewPlan.schedule[0]?.month} ➔ {previewPlan.schedule[previewPlan.schedule.length - 1]?.month}</strong></span>
                </div>
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-200 dark:border-zinc-800/80">
              <button
                type="button"
                onClick={handleDeleteEntirePlan}
                disabled={isDeleting || isSubmitting}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 text-rose-800 dark:text-rose-400 border border-rose-500/25 text-xs font-semibold transition-all cursor-pointer active:scale-95 disabled:opacity-50"
              >
                {isDeleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                <span>Delete Entire Plan</span>
              </button>

              <div className="flex items-center gap-2 ml-auto">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={isSubmitting || isDeleting}
                  className="px-4 py-2 rounded-xl bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-700 dark:text-zinc-300 text-xs font-semibold transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting || isDeleting}
                  className="flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-white dark:text-white text-xs font-bold shadow-lg shadow-purple-600/30 transition-all cursor-pointer active:scale-95 disabled:opacity-50"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>Rescheduling...</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="h-4 w-4" />
                      <span>Save & Reschedule Plan</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </form>
        </motion.div>
      </div>
  );
}
