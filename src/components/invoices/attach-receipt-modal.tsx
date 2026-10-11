'use client';

import React, { useState, useMemo, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  UploadCloud, CheckCircle2, Calendar as CalendarIcon,
  Search, FileText, Check, Loader2, Paperclip, AlertCircle, RefreshCw
} from 'lucide-react';
import { Transaction } from '@/hooks/useTransactions';
import { useQueryClient } from '@tanstack/react-query';
import { useAddRow, updateUnifiedRow } from '@/hooks/useSheets';
import { driveApi } from '@/lib/sheets-api';
import { compressImageFile } from '@/lib/image-compressor';
import { formatClaimFileName } from '@/lib/claim-helper';
import { getTransactionTaxRelief } from '@/lib/lhdn-tax-helper';
import { getLocalDateString } from '@/lib/date-helper';
import { useLockBodyScroll } from '@/hooks/useLockBodyScroll';
import { CockpitModalHeader } from '@/components/money-cockpit/cockpit-modal';
import { toast } from 'sonner';

interface AttachReceiptModalProps {
  isOpen: boolean;
  onClose: () => void;
  file: File | null;
  transactions: Transaction[];
  onSuccess: () => void;
  initialTransactionId?: string | null;
}

const EXPENSE_CATEGORIES = [
  'Food & Dining',
  'Transport',
  'Shopping',
  'Housing & Bills',
  'Entertainment',
  'Health',
  'Education',
  'Other',
];

const springTransition = { type: 'spring' as const, damping: 25, stiffness: 300 };

export function AttachReceiptModal({
  isOpen,
  onClose,
  file,
  transactions,
  onSuccess,
  initialTransactionId,
}: AttachReceiptModalProps) {
  const queryClient = useQueryClient();
  const addInvoiceMutation = useAddRow();
  useLockBodyScroll(isOpen);

  const [mounted, setMounted] = useState(false);
  const [mode, setMode] = useState<'attach' | 'new'>('attach');
  const [selectedTxId, setSelectedTxId] = useState<string | null>(null);
  const [filterDate, setFilterDate] = useState<string>(getLocalDateString());
  const [filterAllDates, setFilterAllDates] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isUploading, setIsUploading] = useState(false);

  // New claim form state
  const [newDate, setNewDate] = useState(getLocalDateString());
  const [newVendor, setNewVendor] = useState('');
  const [newAmount, setNewAmount] = useState<string>('');
  const [newCurrency, setNewCurrency] = useState('MYR');
  const [newCategory, setNewCategory] = useState('Food & Dining');
  const [newNotes, setNewNotes] = useState('');

  // Thumbnail preview
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Pre-select transaction if initialTransactionId is provided
  useEffect(() => {
    if (isOpen && initialTransactionId) {
      setMode('attach');
      setSelectedTxId(initialTransactionId);
      const targetTx = transactions.find((t) => t.id === initialTransactionId);
      if (targetTx?.date) {
        setFilterDate(targetTx.date);
        setFilterAllDates(false);
      } else {
        setFilterAllDates(true);
      }
    }
  }, [isOpen, initialTransactionId, transactions]);

  useEffect(() => {
    if (file) {
      if (file.type.startsWith('image/')) {
        const url = URL.createObjectURL(file);
        setPreviewUrl(url);
        return () => URL.revokeObjectURL(url);
      } else {
        setPreviewUrl(null);
      }
      setNewVendor(file.name.replace(/\.[^/.]+$/, ''));
    }
  }, [file]);

  // Filter transactions based on date and search query
  const filteredTransactions = useMemo(() => {
    let list = transactions;

    if (!filterAllDates && filterDate) {
      list = list.filter((t) => t.date === filterDate);
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter((t) => 
        (t.description && t.description.toLowerCase().includes(q)) ||
        (t.category && t.category.toLowerCase().includes(q)) ||
        String(t.amount).includes(q)
      );
    }

    // Sort descending by date
    return list.slice(0, 30);
  }, [transactions, filterDate, filterAllDates, searchQuery]);

  const selectedTx = useMemo(() => {
    return transactions.find((t) => t.id === selectedTxId) || null;
  }, [transactions, selectedTxId]);

  const handleUploadAndSave = async () => {
    if (!file || isUploading) return;
    setIsUploading(true);

    try {
      const { base64, mimeType } = await compressImageFile(file);

      if (mode === 'attach') {
        if (!selectedTx) {
          toast.error('Please select a transaction to attach this receipt to');
          setIsUploading(false);
          return;
        }

        const taxCat = getTransactionTaxRelief(selectedTx);
        const fileCatLabel = taxCat ? `LHDN_${taxCat.shortName}` : selectedTx.category;
        const fileName = formatClaimFileName(
          selectedTx.date,
          fileCatLabel,
          selectedTx.amount,
          selectedTx.description,
          file.name
        );

        toast.info(`Uploading receipt to Google Drive...`);
        const res = await driveApi.uploadFile(fileName, mimeType || file.type || 'image/jpeg', base64);
        const fileUrl = res.data?.url || '';

        if (!fileUrl) {
          throw new Error('Google Drive upload failed to return a file link');
        }

        const targetSheet = selectedTx._month || (selectedTx.date ? selectedTx.date.substring(0, 7) : 'Transactions');
        await updateUnifiedRow(targetSheet, selectedTx._rowIndex || 2, {
          Id: selectedTx.id,
          id: selectedTx.id,
          Date: selectedTx.date,
          date: selectedTx.date,
          Category: selectedTx.category,
          category: selectedTx.category,
          SubCategory: selectedTx.subCategory || '',
          subCategory: selectedTx.subCategory || '',
          Description: selectedTx.description,
          description: selectedTx.description,
          Amount: selectedTx.amount,
          amount: selectedTx.amount,
          Currency: selectedTx.currency || 'MYR',
          currency: selectedTx.currency || 'MYR',
          ReceiptUrl: fileUrl,
          receiptUrl: fileUrl,
          Notes: selectedTx.notes || '',
          notes: selectedTx.notes || '',
          _month: selectedTx._month,
        });

        queryClient.invalidateQueries({ queryKey: ['sheet'] });
        queryClient.invalidateQueries({ queryKey: ['months'] });
        queryClient.invalidateQueries({ queryKey: ['overview'] });

        toast.success(`Attached receipt to "${selectedTx.description}" (MYR ${selectedTx.amount.toFixed(2)})! 📎🎉`);
        onSuccess();
        onClose();
      } else {
        // Record new claim / invoice
        const amt = typeof newAmount === 'number' ? newAmount : parseFloat(String(newAmount)) || 0;
        if (amt <= 0) {
          toast.error('Please enter a valid amount');
          setIsUploading(false);
          return;
        }

        const vendorName = newVendor.trim() || file.name.replace(/\.[^/.]+$/, '');
        const fileName = formatClaimFileName(
          newDate,
          newCategory,
          amt,
          vendorName,
          file.name
        );

        toast.info(`Uploading claim receipt to Google Drive...`);
        const res = await driveApi.uploadFile(fileName, mimeType || file.type || 'image/jpeg', base64);
        const fileUrl = res.data?.url || '';

        if (!fileUrl) {
          throw new Error('Google Drive upload failed to return a file link');
        }

        await addInvoiceMutation.mutateAsync({
          sheetName: 'Invoices',
          rowData: {
            Date: newDate,
            Vendor: vendorName,
            Amount: amt,
            Currency: newCurrency,
            Category: newCategory,
            Url: fileUrl,
            Status: 'Uploaded',
            Notes: newNotes.trim() || 'Uploaded via Invoices & Claims',
          },
        });

        queryClient.invalidateQueries({ queryKey: ['sheet'] });
        queryClient.invalidateQueries({ queryKey: ['months'] });
        queryClient.invalidateQueries({ queryKey: ['overview'] });

        toast.success(`Saved claim for "${vendorName}" to Google Drive & Invoices! 🎉`);
        onSuccess();
        onClose();
      }
    } catch (err: any) {
      console.error(err);
      toast.error('Upload failed: ' + (err.message || 'Unknown error'));
    } finally {
      setIsUploading(false);
    }
  };

  if (!mounted || !isOpen || !file) return null;

  return ReactDOM.createPortal(
    <AnimatePresence>
      <div className="fixed inset-0 z-[200] flex items-center justify-center p-3 sm:p-4">
        {/* Backdrop */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={() => !isUploading && onClose()}
          className="fixed inset-0 bg-black/85 backdrop-blur-md"
        />

        {/* Modal Window */}
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-labelledby="attach-receipt-title"
          initial={{ scale: 0.95, opacity: 0, y: 15 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.95, opacity: 0, y: 15 }}
          transition={springTransition}
          className="relative max-w-lg w-full max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain touch-pan-y [-webkit-overflow-scrolling:touch] custom-scrollbar rounded-3xl border border-slate-200 dark:border-white/[0.12] bg-[#0c101c]/95 backdrop-blur-3xl p-4 sm:p-5 shadow-2xl z-10 flex flex-col space-y-4"
        >
          <CockpitModalHeader
            title="Upload & attach receipt"
            titleId="attach-receipt-title"
            description="Choose which record this receipt belongs to."
            icon={<Paperclip size={20} />}
            onClose={onClose}
            closeDisabled={isUploading}
            closeLabel="Close receipt upload"
          />

          {/* Selected File Card */}
          <div className="flex items-center gap-3 p-2.5 rounded-2xl bg-white/90 dark:bg-zinc-900/70 border border-slate-200 dark:border-white/[0.06]">
            {previewUrl ? (
              <img
                src={previewUrl}
                alt="Receipt thumbnail"
                className="h-12 w-12 rounded-xl object-cover border border-slate-200 dark:border-white/10 shrink-0"
              />
            ) : (
              <div className="h-12 w-12 rounded-xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center text-indigo-800 dark:text-indigo-400 shrink-0">
                <FileText className="h-6 w-6" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-slate-950 dark:text-white truncate">{file.name}</p>
              <p className="text-[10px] text-slate-600 dark:text-zinc-400 font-mono mt-0.5">
                {(file.size / 1024).toFixed(0)} KB • Auto-compress for Google Drive
              </p>
            </div>
          </div>

          {/* Mode Switcher Tabs */}
          <div className="grid grid-cols-2 gap-1.5 p-1 rounded-2xl bg-white dark:bg-zinc-950 border border-slate-200 dark:border-white/[0.08]">
            <button
              type="button"
              onClick={() => setMode('attach')}
              className={`min-h-[38px] rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                mode === 'attach'
                  ? 'bg-gradient-to-r from-indigo-500 to-purple-600 text-white dark:text-white shadow-md'
                  : 'text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white'
              }`}
            >
              <Paperclip className="h-3.5 w-3.5" />
              <span>Attach to Transaction</span>
            </button>
            <button
              type="button"
              onClick={() => setMode('new')}
              className={`min-h-[38px] rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                mode === 'new'
                  ? 'bg-gradient-to-r from-indigo-500 to-purple-600 text-white dark:text-white shadow-md'
                  : 'text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white'
              }`}
            >
              <FileText className="h-3.5 w-3.5" />
              <span>New Standalone Claim</span>
            </button>
          </div>

          {/* Mode 1: Attach to Existing Transaction */}
          {mode === 'attach' ? (
            <div className="space-y-3">
              {/* Date & Search Filters */}
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <CalendarIcon className="h-3.5 w-3.5 text-indigo-800 dark:text-indigo-400" />
                    <span className="text-[11px] font-semibold text-slate-700 dark:text-zinc-300">Transaction Date:</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setFilterAllDates(!filterAllDates)}
                      className={`text-[10px] font-bold px-2 py-0.5 rounded-lg border transition-all cursor-pointer ${
                        filterAllDates
                          ? 'bg-indigo-500/20 text-indigo-800 dark:text-indigo-200 border-indigo-500/40'
                          : 'bg-white dark:bg-zinc-900 text-slate-600 dark:text-zinc-400 border-slate-200 dark:border-zinc-800 hover:text-slate-950 dark:hover:text-white'
                      }`}
                    >
                      {filterAllDates ? 'All Dates Active' : 'Show All Dates'}
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {!filterAllDates && (
                    <input
                      type="date"
                      value={filterDate}
                      onChange={(e) => setFilterDate(e.target.value)}
                      className="w-full h-9 rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/90 px-3 text-xs text-slate-950 dark:text-white outline-none focus:border-indigo-500 transition-colors"
                    />
                  )}
                  <div className={`relative ${filterAllDates ? 'sm:col-span-2' : ''}`}>
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-500 dark:text-zinc-400" />
                    <input
                      type="text"
                      placeholder="Search description or amount..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full h-9 rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/90 pl-8 pr-3 text-xs text-slate-950 dark:text-white placeholder-zinc-500 outline-none focus:border-indigo-500 transition-colors"
                    />
                  </div>
                </div>
              </div>

              {/* Transactions List */}
              <div className="space-y-1.5">
                <span className="text-[10px] uppercase font-bold tracking-wider text-slate-500 dark:text-zinc-400 block">
                  Select Transaction ({filteredTransactions.length} found)
                </span>

                <div className="max-h-[220px] overflow-y-auto overscroll-contain space-y-1.5 pr-1 custom-scrollbar">
                  {filteredTransactions.length === 0 ? (
                    <div className="text-center py-6 px-3 rounded-2xl border border-dashed border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-950/40 space-y-2">
                      <AlertCircle className="h-6 w-6 text-slate-600 dark:text-zinc-300 mx-auto" />
                      <p className="text-xs text-slate-600 dark:text-zinc-400">
                        No transactions found for this date.
                      </p>
                      <button
                        type="button"
                        onClick={() => setFilterAllDates(true)}
                        className="text-[11px] text-indigo-800 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 font-semibold underline underline-offset-2 cursor-pointer"
                      >
                        Show recent transactions across all dates
                      </button>
                    </div>
                  ) : (
                    filteredTransactions.map((tx) => {
                      const isSelected = selectedTxId === tx.id;
                      const hasReceipt = Boolean(tx.receiptUrl);
                      const txTaxCat = getTransactionTaxRelief(tx);

                      return (
                        <div
                          key={tx.id}
                          onClick={() => setSelectedTxId(tx.id)}
                          className={`flex items-center justify-between p-2.5 rounded-xl border transition-all cursor-pointer touch-manipulation ${
                            isSelected
                              ? 'bg-indigo-500/15 border-indigo-500/50 shadow-md ring-1 ring-indigo-500/30'
                              : 'bg-white/90 dark:bg-zinc-900/50 border-slate-200 dark:border-white/[0.06] hover:bg-white dark:hover:bg-zinc-900 hover:border-slate-300 dark:hover:border-zinc-700'
                          }`}
                        >
                          <div className="flex items-center gap-2.5 min-w-0 pr-2">
                            <div className={`h-5 w-5 rounded-full flex items-center justify-center shrink-0 border ${
                              isSelected
                                ? 'bg-indigo-500 border-indigo-400 text-white dark:text-white'
                                : 'border-slate-300 dark:border-zinc-700 bg-slate-100 dark:bg-zinc-800 text-transparent'
                            }`}>
                              <Check className="h-3 w-3 stroke-[3]" />
                            </div>
                            <div className="min-w-0">
                              <p className="text-xs font-semibold text-slate-950 dark:text-white truncate">
                                {tx.description || tx.category}
                              </p>
                              <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-slate-600 dark:text-zinc-400">
                                <span>{tx.date}</span>
                                <span>•</span>
                                <span className="text-slate-700 dark:text-zinc-300 font-medium">{tx.category}</span>
                                {txTaxCat && (
                                  <>
                                    <span>•</span>
                                    <span className="text-emerald-800 dark:text-emerald-400 font-bold">🇲🇾 {txTaxCat.shortName}</span>
                                  </>
                                )}
                                {hasReceipt && (
                                  <>
                                    <span>•</span>
                                    <span className="text-amber-800 dark:text-amber-400 font-medium">Has receipt</span>
                                  </>
                                )}
                              </div>
                            </div>
                          </div>

                          <div className="text-right shrink-0">
                            <span className="text-xs font-mono font-bold text-slate-950 dark:text-white block">
                              {tx.currency || 'MYR'} {tx.amount.toFixed(2)}
                            </span>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          ) : (
            /* Mode 2: Record Standalone Claim / Invoice */
            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold tracking-wider text-slate-600 dark:text-zinc-400">Date</label>
                  <input
                    type="date"
                    value={newDate}
                    onChange={(e) => setNewDate(e.target.value)}
                    className="w-full h-9 rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/90 px-3 text-xs text-slate-950 dark:text-white outline-none focus:border-indigo-500 transition-colors"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold tracking-wider text-slate-600 dark:text-zinc-400">Vendor / Title</label>
                  <input
                    type="text"
                    placeholder="e.g. Shell Petrol, Starbucks"
                    value={newVendor}
                    onChange={(e) => setNewVendor(e.target.value)}
                    className="w-full h-9 rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/90 px-3 text-xs text-slate-950 dark:text-white outline-none focus:border-indigo-500 transition-colors"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold tracking-wider text-slate-600 dark:text-zinc-400">Amount ({newCurrency})</label>
                  <input
                    type="number"
                    step="0.01"
                    placeholder="0.00"
                    value={newAmount}
                    onChange={(e) => setNewAmount(e.target.value)}
                    className="w-full h-9 rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/90 px-3 font-mono font-bold text-xs text-emerald-800 dark:text-emerald-400 outline-none focus:border-indigo-500 transition-colors"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold tracking-wider text-slate-600 dark:text-zinc-400">Category</label>
                  <select
                    value={newCategory}
                    onChange={(e) => setNewCategory(e.target.value)}
                    className="w-full h-9 rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/90 px-2.5 text-xs text-slate-950 dark:text-white outline-none focus:border-indigo-500 transition-colors"
                  >
                    {EXPENSE_CATEGORIES.map((cat) => (
                      <option key={cat} value={cat}>{cat}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold tracking-wider text-slate-600 dark:text-zinc-400">Notes (Optional)</label>
                <input
                  type="text"
                  placeholder="e.g. Project allowance claim"
                  value={newNotes}
                  onChange={(e) => setNewNotes(e.target.value)}
                  className="w-full h-9 rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/90 px-3 text-xs text-slate-950 dark:text-white outline-none focus:border-indigo-500 transition-colors"
                />
              </div>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-200 dark:border-white/[0.08]">
            <button
              type="button"
              onClick={onClose}
              disabled={isUploading}
              className="text-xs text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white px-3 py-2 rounded-xl hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            >
              Cancel
            </button>

            <button
              type="button"
              onClick={handleUploadAndSave}
              disabled={isUploading || (mode === 'attach' && !selectedTxId) || (mode === 'new' && (!newAmount || (parseFloat(newAmount) || 0) <= 0))}
              className="inline-flex min-h-[42px] items-center gap-2 rounded-2xl bg-gradient-to-r from-indigo-500 via-indigo-600 to-purple-600 px-5 py-2 text-xs font-bold text-white dark:text-white shadow-lg shadow-indigo-500/25 hover:from-indigo-400 hover:to-purple-500 active:scale-[0.98] transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isUploading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Uploading to Drive...</span>
                </>
              ) : (
                <>
                  <UploadCloud className="h-4 w-4" />
                  <span>
                    {mode === 'attach'
                      ? selectedTx
                        ? `Attach to "${selectedTx.description || selectedTx.category}"`
                        : 'Select a Transaction'
                      : 'Save Claim to Invoices'}
                  </span>
                </>
              )}
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>,
    document.body
  );
}
