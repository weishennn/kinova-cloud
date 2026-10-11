'use client';

import React, { useState, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Edit2, Trash2, Receipt, ExternalLink, Calendar,
  CreditCard, Tag, ArrowDownRight, ArrowUpRight, Plane, Loader2, Download
} from 'lucide-react';
import { useAppStore } from '@/stores/app-store';
import {
  useDeleteRow,
  useUpdateRow,
  useSheetData,
  applyOptimisticDeleteToQueryCache,
  applyOptimisticUpdateToQueryCache,
} from '@/hooks/useSheets';
import { Transaction, useTransactions } from '@/hooks/useTransactions';
import { extractDriveFileId, deleteDriveReceipt, downloadReceiptFile, formatClaimFileName } from '@/lib/claim-helper';
import { extractInstallmentInfo, deleteInstallmentPlan, GroupedInstallmentPlan } from '@/lib/installment-helper';
import {
  LHDN_TAX_CATEGORIES,
  getTransactionTaxRelief,
  applyTaxReliefTag,
  calculateYearlyTaxReliefSummary,
} from '@/lib/lhdn-tax-helper';
import { useQueryClient } from '@tanstack/react-query';
import { CockpitModalHeader } from '@/components/money-cockpit/cockpit-modal';
import { toast } from 'sonner';
import { useLockBodyScroll } from '@/hooks/useLockBodyScroll';
import { confirmAction } from '@/stores/confirm-dialog-store';

interface TransactionDetailModalProps {
  transaction: Transaction | null;
  onClose: () => void;
  onDeleted?: (tx: Transaction) => void;
}

export function TransactionDetailModal({
  transaction,
  onClose,
  onDeleted,
}: TransactionDetailModalProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  useLockBodyScroll(Boolean(transaction));

  useEffect(() => {
    if (!transaction) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [transaction, onClose]);

  if (!mounted || typeof document === 'undefined') return null;

  return createPortal(
    <AnimatePresence>
      {transaction && (
        <TransactionDetailContent
          transaction={transaction}
          onClose={onClose}
          onDeleted={onDeleted}
        />
      )}
    </AnimatePresence>,
    document.body,
  );
}

function TransactionDetailContent({
  transaction,
  onClose,
  onDeleted,
}: {
  transaction: Transaction;
  onClose: () => void;
  onDeleted?: (tx: Transaction) => void;
}) {
  const queryClient = useQueryClient();
  const { setQuickAddOpen, setEditTransaction, setEditInstallmentPlan } = useAppStore();
  const { transactions = [] } = useTransactions();
  const deleteMutation = useDeleteRow();
  const updateMutation = useUpdateRow();
  const { data: tripsData } = useSheetData('Trips');

  const trips = React.useMemo(
    () =>
      (tripsData?.rows || [])
        .map((row: any) => String(row.Name || row.TripName || row.name || '').trim())
        .filter(Boolean),
    [tripsData]
  );

  const detectedTaxCat = useMemo(() => getTransactionTaxRelief(transaction), [transaction]);
  const [currentTrip, setCurrentTrip] = useState<string>(transaction?.tripTag || '');
  const [currentTaxCatId, setCurrentTaxCatId] = useState<string>(detectedTaxCat?.id || 'none');
  const [prevTxId, setPrevTxId] = useState<string | undefined>(transaction?.id);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isDeletingReceipt, setIsDeletingReceipt] = useState(false);

  if (transaction && transaction.id !== prevTxId) {
    setPrevTxId(transaction.id);
    setCurrentTrip(transaction.tripTag || '');
    setCurrentTaxCatId(getTransactionTaxRelief(transaction)?.id || 'none');
  }

  const txYear = useMemo(() => {
    if (transaction?.date && /^\d{4}/.test(transaction.date)) {
      return transaction.date.substring(0, 4);
    }
    return String(new Date().getFullYear());
  }, [transaction]);

  const activeTaxCatStatus = useMemo(() => {
    if (!currentTaxCatId || currentTaxCatId === 'none') return null;
    const summary = calculateYearlyTaxReliefSummary(transactions, txYear);
    return summary.categories.find((c) => c.category.id === currentTaxCatId) || null;
  }, [transactions, txYear, currentTaxCatId]);

  const isInstallment = Boolean(
    transaction?.description?.includes('(Installment') ||
    transaction?.notes?.includes('[Installment Plan')
  );
  const installmentMatch = transaction?.description?.match(/Installment\s*(\d+)\/(\d+)/i) ||
    transaction?.notes?.match(/Installment\s*Plan\s*(\d+)\/(\d+)/i);

  const relatedPlan: GroupedInstallmentPlan | null = useMemo(() => {
    if (!isInstallment || !transaction) return null;
    const info = extractInstallmentInfo(transaction);
    if (!info) return null;

    const baseName = info.planName.toLowerCase();
    const relatedTxs = transactions.filter((t) => {
      const tInfo = extractInstallmentInfo(t);
      if (!tInfo) return false;
      return tInfo.planName.toLowerCase() === baseName;
    });

    const allTxs = relatedTxs.some((t) => t.id === transaction.id)
      ? relatedTxs
      : [transaction, ...relatedTxs];

    const sorted = [...allTxs].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const startDate = sorted[0]?.date || transaction.date;

    return {
      name: info.planName,
      category: transaction.category || 'Shopping',
      currency: transaction.currency || 'MYR',
      monthlyAmount: transaction.amount,
      totalTenure: info.totalTenure,
      latestPaidIndex: info.instIndex,
      totalPaid: info.instIndex * transaction.amount,
      totalPayable: info.totalPayable,
      remainingBalance: Math.max(0, info.totalPayable - (info.instIndex * transaction.amount)),
      startDate,
      endDate: sorted[sorted.length - 1]?.date || transaction.date,
      status: (info.instIndex >= info.totalTenure ? 'completed' : 'active') as 'active' | 'completed',
      transactions: allTxs,
      annualInterestRate: info.annualInterestRate,
    };
  }, [transaction, isInstallment, transactions]);

  const isIncome = transaction?.type === 'income';
  const isInvestment = transaction?.type === 'investment';

  const handleEdit = () => {
    const tx = transaction;
    onClose();
    setEditTransaction(tx as unknown as Record<string, unknown>);
    setQuickAddOpen(true);
  };

  const handleDelete = async () => {
    const ok = await confirmAction({
      title: 'Delete Transaction?',
      description: `Delete transaction "${transaction.description || transaction.category}" (${transaction.currency || 'MYR'} ${transaction.amount.toFixed(2)})? This cannot be undone.`,
      confirmText: 'Delete',
      cancelText: 'Cancel',
      variant: 'danger',
      icon: 'trash',
    });
    if (!ok) return;

    const targetSheet = transaction._month || (transaction.date ? transaction.date.substring(0, 7) : 'Transactions');

    // Instant (<10ms) optimistic removal from UI + local SWR cache
    applyOptimisticDeleteToQueryCache(queryClient, targetSheet, transaction._rowIndex || 2, transaction.id);
    toast.success('Transaction deleted ⚡');
    onDeleted?.(transaction);
    onClose();

    // Free storage from Google Drive and sync deletion in background
    if (transaction.receiptUrl) {
      const driveId = extractDriveFileId(transaction.receiptUrl);
      if (driveId) {
        deleteDriveReceipt(driveId).catch(console.warn);
      }
    }
    deleteMutation.mutate({
      sheetName: targetSheet,
      rowIndex: transaction._rowIndex || 2,
      id: transaction.id,
    });
  };

  const handleDeleteReceiptOnly = async () => {
    if (!transaction.receiptUrl) return;
    const ok = await confirmAction({
      title: 'Delete Receipt from Drive?',
      description: 'Delete this receipt file from Google Drive to free up storage space? The spending transaction itself will remain saved in Cashflow.',
      confirmText: 'Delete Receipt',
      cancelText: 'Keep Receipt',
      variant: 'danger',
      icon: 'trash',
    });
    if (!ok) return;

    const targetSheet = transaction._month || (transaction.date ? transaction.date.substring(0, 7) : 'Transactions');
    const updatedData = {
      Date: transaction.date,
      Type: transaction.type,
      Category: transaction.category,
      SubCategory: transaction.subCategory || '',
      subCategory: transaction.subCategory || '',
      Description: transaction.description,
      Amount: transaction.amount,
      Currency: transaction.currency,
      Notes: transaction.notes,
      TripTag: transaction.tripTag || '',
      ReceiptUrl: '',
      receiptUrl: '',
      Id: transaction.id,
      id: transaction.id,
      _month: transaction._month,
    };

    // Optimistically clear receiptUrl in active queries + local SWR cache immediately (<10ms)
    applyOptimisticUpdateToQueryCache(queryClient, targetSheet, transaction._rowIndex || 2, updatedData);
    toast.success('Receipt deleted from Google Drive! Storage freed. 🗑️');
    onClose();

    const driveId = extractDriveFileId(transaction.receiptUrl);
    if (driveId) {
      deleteDriveReceipt(driveId).catch(console.warn);
    }
    updateMutation.mutate({
      sheetName: targetSheet,
      rowIndex: transaction._rowIndex || 2,
      rowData: updatedData,
    });
  };

  const handleTripChange = (newTrip: string) => {
    setCurrentTrip(newTrip);
    const targetSheet = transaction._month || (transaction.date ? transaction.date.substring(0, 7) : 'Transactions');
    updateMutation.mutate({
      sheetName: targetSheet,
      rowIndex: transaction._rowIndex || 2,
      rowData: {
        Date: transaction.date,
        Type: transaction.type,
        Category: transaction.category,
        SubCategory: transaction.subCategory || '',
        subCategory: transaction.subCategory || '',
        Description: transaction.description,
        Amount: transaction.amount,
        Currency: transaction.currency,
        Notes: transaction.notes,
        ReceiptUrl: transaction.receiptUrl || '',
        TripTag: newTrip,
        tripTag: newTrip,
        _month: transaction._month,
        Id: transaction.id,
        id: transaction.id,
      },
    });
    toast.success(newTrip ? `Tagged to ${newTrip}` : 'Removed from trip');
  };

  const handleTaxCategoryChange = (newCatId: string) => {
    setCurrentTaxCatId(newCatId);
    const { subCategory, notes } = applyTaxReliefTag(newCatId, transaction.notes || '');
    const targetSheet = transaction._month || (transaction.date ? transaction.date.substring(0, 7) : 'Transactions');
    updateMutation.mutate({
      sheetName: targetSheet,
      rowIndex: transaction._rowIndex || 2,
      rowData: {
        Date: transaction.date,
        Type: transaction.type,
        Category: transaction.category,
        SubCategory: subCategory,
        subCategory: subCategory,
        Description: transaction.description,
        Amount: transaction.amount,
        Currency: transaction.currency,
        Notes: notes,
        notes: notes,
        ReceiptUrl: transaction.receiptUrl || '',
        TripTag: currentTrip || '',
        tripTag: currentTrip || '',
        _month: transaction._month,
        Id: transaction.id,
        id: transaction.id,
      },
    });
    const cat = LHDN_TAX_CATEGORIES.find((c) => c.id === newCatId);
    toast.success(cat ? `🇲🇾 Tagged to LHDN: ${cat.shortName}` : 'Removed from LHDN tax relief');
  };

  const handleOpenPlanEdit = () => {
    if (relatedPlan) {
      onClose();
      setEditInstallmentPlan(relatedPlan);
    }
  };

  const handleDeleteEntirePlan = async () => {
    if (!relatedPlan) return;
    const count = relatedPlan.transactions.length;
    const ok = await confirmAction({
      title: 'Delete Entire Installment Plan?',
      description: `Delete installment plan "${relatedPlan.name}"? All ${count} monthly installment transactions will be permanently removed.`,
      confirmText: 'Delete Entire Plan',
      cancelText: 'Cancel',
      variant: 'danger',
      icon: 'trash',
    });
    if (!ok) return;

    // Optimistically remove all installment transactions immediately (<10ms)
    for (const tx of relatedPlan.transactions) {
      const sheet = tx._month || (tx.date ? tx.date.substring(0, 7) : 'Transactions');
      applyOptimisticDeleteToQueryCache(queryClient, sheet, tx._rowIndex, tx.id);
    }
    toast.success(`Installment plan "${relatedPlan.name}" deleted. ⚡`);
    onDeleted?.(transaction);
    onClose();

    void deleteInstallmentPlan(relatedPlan.transactions, relatedPlan.name).then(() => {
      queryClient.invalidateQueries({ queryKey: ['overview'] });
    });
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/80 backdrop-blur-md"
          />

          {/* Modal Card */}
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="transaction-details-title"
            aria-describedby="transaction-details-description"
            initial={{ opacity: 0, scale: 0.92, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.92, y: 20 }}
            transition={{ type: 'spring' as const, stiffness: 380, damping: 28 }}
            className="relative z-10 w-full max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain touch-pan-y [-webkit-overflow-scrolling:touch] custom-scrollbar rounded-3xl border border-slate-200 dark:border-white/[0.12] bg-white/95 dark:bg-[#090d16]/95 backdrop-blur-2xl p-6 shadow-2xl space-y-5"
          >
            <CockpitModalHeader
              title={transaction.description || transaction.category}
              titleId="transaction-details-title"
              description={`${isInstallment ? 'Installment' : transaction.type} · ${transaction.category} · ${transaction.date}`}
              descriptionId="transaction-details-description"
              icon={<Receipt size={20} />}
              onClose={onClose}
              closeLabel="Close transaction details"
            />

          {/* Amount Hero */}
          <div className="text-center py-2">
            <div
              className={`text-3xl sm:text-4xl font-black font-mono tabular-nums tracking-tight ${
                isIncome
                  ? 'text-emerald-800 dark:text-emerald-400'
                  : isInvestment
                  ? 'text-indigo-800 dark:text-indigo-400'
                  : isInstallment
                  ? 'text-violet-800 dark:text-purple-400'
                  : 'text-rose-800 dark:text-rose-400'
              }`}
            >
              {isIncome ? '+' : '-'}{transaction.currency === 'USD' ? '$' : transaction.currency === 'CNY' ? '¥' : transaction.currency === 'SGD' ? 'S$' : (transaction.currency || 'MYR') + ' '}{transaction.amount.toFixed(2)}
            </div>
            {transaction.currency && transaction.currency !== 'MYR' && (
              <p className="text-xs text-indigo-800 dark:text-indigo-400 font-mono mt-1 font-semibold">
                {transaction.notes && transaction.notes.includes('Cost: RM')
                  ? transaction.notes.match(/Cost:\s*RM\s*[\d.]+/)?.[0]
                  : `Original Currency: ${transaction.currency}`}
              </p>
            )}
            <p className="text-xs text-slate-600 dark:text-zinc-400 mt-1 font-medium">{transaction.date}</p>
          </div>

          {/* Installment Badge Banner */}
          {isInstallment && (
            <div className="p-3 rounded-2xl bg-purple-500/10 border border-purple-500/25 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CreditCard className="h-4 w-4 text-violet-800 dark:text-purple-400" />
                <span className="text-xs font-bold text-violet-800 dark:text-purple-300 uppercase tracking-wider">
                  {installmentMatch ? `Installment ${installmentMatch[1]} of ${installmentMatch[2]}` : 'Installment Plan'}
                </span>
              </div>
              <span className="text-[11px] font-semibold text-violet-800 dark:text-purple-400 bg-purple-500/15 px-2 py-0.5 rounded-full border border-purple-500/30">
                Monthly Commitment
              </span>
            </div>
          )}

          {/* Details Breakdown */}
          <div className="space-y-3 rounded-2xl bg-white/90 dark:bg-zinc-900/40 border border-slate-200 dark:border-zinc-800/80 p-4 text-xs">
            <div>
              <span className="text-slate-500 dark:text-zinc-400 block mb-0.5 font-medium">Description</span>
              <p className="text-sm font-semibold text-slate-950 dark:text-white break-words">
                {transaction.description || transaction.category}
              </p>
            </div>

            <div className="pt-2 border-t border-slate-200 dark:border-zinc-800/60">
              <span className="text-slate-500 dark:text-zinc-400 block mb-0.5 font-medium">Category</span>
              <span className="font-semibold text-slate-800 dark:text-zinc-200">{transaction.category}</span>
            </div>

            {/* Trip Assignment */}
            <div className="pt-2 border-t border-slate-200 dark:border-zinc-800/60">
              <span className="text-slate-500 dark:text-zinc-400 block mb-1.5 font-medium">Trip Assignment</span>
              {String(transaction.id || '').startsWith('trixpense_') ? (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border border-emerald-500/25 text-xs font-semibold">
                  🔗 ✈️ {currentTrip || 'Trixpense Trip'} (Live Synced from Trixpense)
                </span>
              ) : trips.length > 0 ? (
                <select
                  value={currentTrip}
                  onChange={(e) => handleTripChange(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-2 text-xs text-slate-950 dark:text-white outline-none focus:border-indigo-500 cursor-pointer"
                >
                  <option value="">No trip (Everyday expense)</option>
                  {trips.map((trip) => (
                    <option key={trip} value={trip}>
                      ✈️ {trip}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-slate-600 dark:text-zinc-400 italic">
                  {currentTrip ? `✈️ ${currentTrip}` : 'Not tagged to any trip'}
                </span>
              )}
            </div>

            {/* Malaysia LHDN Tax Relief Assignment */}
            {!isIncome && !String(transaction.id || '').startsWith('trixpense_') && (
              <div className="pt-2 border-t border-slate-200 dark:border-zinc-800/60 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-slate-500 dark:text-zinc-400 font-medium">🇲🇾 LHDN Tax Relief (YA {txYear})</span>
                  {activeTaxCatStatus && (
                    <span className="text-[11px] font-mono text-emerald-800 dark:text-emerald-400 font-semibold">
                      RM {activeTaxCatStatus.remainingLimit.toFixed(0)} left of RM {activeTaxCatStatus.limit.toFixed(0)}
                    </span>
                  )}
                </div>
                <select
                  value={currentTaxCatId}
                  onChange={(e) => handleTaxCategoryChange(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-2 text-xs text-slate-950 dark:text-white outline-none focus:border-indigo-500 cursor-pointer"
                >
                  <option value="none">Not Tax Deductible (Standard Expense)</option>
                  {LHDN_TAX_CATEGORIES.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.icon} {c.name} (Cap: RM {c.defaultLimit.toLocaleString()})
                    </option>
                  ))}
                </select>
                {activeTaxCatStatus && !transaction.receiptUrl && (
                  <p className="text-[11px] text-amber-800 dark:text-amber-300 font-medium pt-0.5">
                    ⚠️ Missing receipt for LHDN audit — tap &ldquo;Edit Transaction&rdquo; below to attach a photo or PDF receipt.
                  </p>
                )}
              </div>
            )}

            {/* Notes */}
            {transaction.notes && (
              <div className="pt-2 border-t border-slate-200 dark:border-zinc-800/60">
                <span className="text-slate-500 dark:text-zinc-400 block mb-1 font-medium">Notes</span>
                <p className="text-slate-700 dark:text-zinc-300 italic whitespace-pre-wrap leading-relaxed bg-white/90 dark:bg-zinc-950/60 p-2.5 rounded-xl border border-slate-200 dark:border-zinc-800/60">
                  {transaction.notes}
                </p>
              </div>
            )}

            {/* Cloud Receipt Document */}
            {transaction.receiptUrl && (
              <div className="pt-2 border-t border-slate-200 dark:border-zinc-800/60 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-slate-500 dark:text-zinc-400 font-medium">Receipt Document</span>
                  <button
                    type="button"
                    onClick={handleDeleteReceiptOnly}
                    disabled={isDeletingReceipt}
                    className="flex items-center gap-1 text-[11px] text-rose-800 dark:text-rose-400 hover:text-rose-800 dark:hover:text-rose-300 hover:underline transition-colors cursor-pointer disabled:opacity-50"
                    title="Delete receipt file from Google Drive to save cloud storage"
                  >
                    {isDeletingReceipt ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Trash2 className="h-3 w-3" />
                    )}
                    <span>Delete from Drive</span>
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <a
                    href={transaction.receiptUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 flex items-center justify-between p-2.5 rounded-xl bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/20 text-indigo-800 dark:text-indigo-300 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <Receipt className="h-4 w-4" />
                      <span className="font-semibold text-xs">View Cloud Receipt</span>
                    </div>
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>

                  <button
                    type="button"
                    onClick={() => {
                      const claimFileName = formatClaimFileName(
                        transaction.date,
                        transaction.category,
                        transaction.amount,
                        transaction.description
                      );
                      downloadReceiptFile(transaction.receiptUrl!, claimFileName);
                    }}
                    className="p-2.5 rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-700 dark:text-zinc-300 hover:text-slate-950 dark:hover:text-white transition-colors cursor-pointer"
                    title="Download receipt for claim"
                  >
                    <Download className="h-4 w-4" />
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Action Buttons */}
          {String(transaction.id || '').startsWith('trixpense_') ? (
            <div className="space-y-2 pt-1">
              <a
                href="/trips"
                onClick={() => onClose()}
                className="w-full py-3 px-4 rounded-2xl bg-gradient-to-r from-emerald-500 via-teal-600 to-indigo-600 hover:from-emerald-600 hover:to-indigo-700 text-white font-bold text-sm shadow-xl shadow-emerald-500/20 transition-all flex items-center justify-center gap-2 cursor-pointer"
              >
                <Plane className="h-4 w-4" />
                <span>Manage Shared Trip in Trip Tracker</span>
              </a>
            </div>
          ) : isInstallment && relatedPlan ? (
            <div className="space-y-2 pt-1">
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={handleOpenPlanEdit}
                className="w-full py-3 px-4 rounded-2xl bg-gradient-to-r from-purple-600 via-indigo-600 to-purple-700 hover:from-purple-500 hover:to-indigo-500 text-white dark:text-white font-bold text-sm shadow-xl shadow-purple-500/25 transition-all flex items-center justify-center gap-2 cursor-pointer"
              >
                <CreditCard className="h-4 w-4" />
                <span>Edit Installment Plan (Reschedule/Shift)</span>
              </motion.button>

              <div className="grid grid-cols-2 gap-2">
                <motion.button
                  whileHover={{ scale: 1.01 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={handleEdit}
                  className="py-2.5 px-3 rounded-2xl border border-slate-200 dark:border-zinc-800 hover:bg-white dark:hover:bg-zinc-900 text-slate-700 dark:text-zinc-300 font-semibold text-xs transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <Edit2 className="h-3.5 w-3.5" />
                  <span>Edit This Month</span>
                </motion.button>

                <motion.button
                  whileHover={{ scale: 1.01 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={handleDelete}
                  disabled={isDeleting}
                  className="py-2.5 px-3 rounded-2xl border border-rose-500/30 hover:bg-rose-500/10 text-rose-800 dark:text-rose-400 font-semibold text-xs transition-colors flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>Delete This Month</span>
                </motion.button>
              </div>

              <motion.button
                whileHover={{ scale: 1.01 }}
                whileTap={{ scale: 0.98 }}
                onClick={handleDeleteEntirePlan}
                disabled={isDeleting}
                className="w-full py-2 px-3 rounded-2xl bg-rose-500/10 hover:bg-rose-500/20 text-rose-800 dark:text-rose-400 border border-rose-500/25 font-semibold text-xs transition-colors flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                {isDeleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                <span>Delete Entire Plan ({relatedPlan.transactions.length} Months)</span>
              </motion.button>
            </div>
          ) : (
            <div className="space-y-2 pt-1">
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={handleEdit}
                className="w-full py-3 px-4 rounded-2xl bg-gradient-to-r from-indigo-500 via-indigo-600 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white dark:text-white font-bold text-sm shadow-xl shadow-indigo-500/25 transition-all flex items-center justify-center gap-2 cursor-pointer"
              >
                <Edit2 className="h-4 w-4" />
                <span>Edit Transaction</span>
              </motion.button>

              <motion.button
                whileHover={{ scale: 1.01 }}
                whileTap={{ scale: 0.98 }}
                onClick={handleDelete}
                disabled={isDeleting}
                className="w-full py-2.5 px-4 rounded-2xl border border-rose-500/30 hover:bg-rose-500/10 text-rose-800 dark:text-rose-400 font-semibold text-xs transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
              >
                {isDeleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                <span>{isDeleting ? 'Deleting...' : 'Delete Transaction'}</span>
              </motion.button>
            </div>
          )}
        </motion.div>
    </div>
  );
}
