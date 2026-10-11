'use client';

import React, { useState, useMemo } from 'react';
import ReactDOM from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Calendar, Download, Trash2, CheckCircle2, AlertTriangle,
  X, Check, Eye, ExternalLink, Loader2, HardDrive, ShieldCheck
} from 'lucide-react';
import {
  formatClaimFileName,
  downloadReceiptBatch,
  deleteDriveReceipt,
  extractDriveFileId
} from '@/lib/claim-helper';
import { useQueryClient } from '@tanstack/react-query';
import { deleteUnifiedRow, updateUnifiedRow } from '@/hooks/useSheets';
import { toast } from 'sonner';
import { getLocalDateString, getRelativeDateString } from '@/lib/date-helper';
import { useLockBodyScroll } from '@/hooks/useLockBodyScroll';
import { CockpitModalHeader } from '@/components/money-cockpit/cockpit-modal';

export interface InvoiceItem {
  id: string;
  title: string;
  vendor: string;
  date: string;
  amount: number;
  currency: string;
  url: string;
  source: 'invoice' | 'transaction';
  rowIndex?: number;
  _month?: string;
  txId?: string;
}

interface DateRangeDownloadModalProps {
  isOpen: boolean;
  onClose: () => void;
  invoices: InvoiceItem[];
  initialFrom?: string;
  initialTo?: string;
  onAfterDelete?: () => void;
}

const springTransition = { type: 'spring' as const, damping: 25, stiffness: 300 };

const containerVariants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.04 }
  }
};

const itemVariants = {
  hidden: { opacity: 0, x: -20 },
  show: { opacity: 1, x: 0, transition: springTransition }
};

export function DateRangeDownloadModal({
  isOpen,
  onClose,
  invoices,
  initialFrom,
  initialTo,
  onAfterDelete,
}: DateRangeDownloadModalProps) {
  const queryClient = useQueryClient();

  // Helper date generators
  const getTodayStr = () => getLocalDateString();
  const getNDaysAgoStr = (days: number) => getRelativeDateString(-days);
  const getFirstDayOfMonthStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  };

  const [dateFrom, setDateFrom] = useState<string>(() => initialFrom || getNDaysAgoStr(6));
  const [dateTo, setDateTo] = useState<string>(() => initialTo || getTodayStr());
  const [activePreset, setActivePreset] = useState<'last7' | 'last14' | 'thisMonth' | 'lastMonth' | null>(null);

  const [deselectedIds, setDeselectedIds] = useState<Set<string>>(new Set());
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<{ current: number; total: number } | null>(null);
  const [showCleanupModal, setShowCleanupModal] = useState(false);
  const [isDeletingFromDrive, setIsDeletingFromDrive] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<{ url: string; title: string } | null>(null);

  // Sync date inputs when modal opens or initial dates change
  React.useEffect(() => {
    if (isOpen) {
      setDateFrom(initialFrom || getNDaysAgoStr(6));
      setDateTo(initialTo || getTodayStr());
      setActivePreset(null);
      setDeselectedIds(new Set());
    }
  }, [isOpen, initialFrom, initialTo]);

  // Filter invoices by date range
  const matchingInvoices = useMemo(() => {
    if (!dateFrom && !dateTo) return invoices;
    return invoices.filter((inv) => {
      if (!inv.date) return false;
      if (dateFrom && inv.date < dateFrom) return false;
      if (dateTo && inv.date > dateTo) return false;
      return true;
    }).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [invoices, dateFrom, dateTo]);

  // Selected invoices list - computed synchronously
  const selectedInvoices = useMemo(() => {
    return matchingInvoices.filter((inv) => !deselectedIds.has(inv.id));
  }, [matchingInvoices, deselectedIds]);

  const totalSelectedAmount = useMemo(() => {
    return selectedInvoices.reduce((sum, inv) => sum + (inv.amount || 0), 0);
  }, [selectedInvoices]);

  const allSelected = matchingInvoices.length > 0 && deselectedIds.size === 0;

  const toggleSelectAll = () => {
    if (allSelected) {
      setDeselectedIds(new Set(matchingInvoices.map((inv) => inv.id)));
    } else {
      setDeselectedIds(new Set());
    }
  };

  const toggleSelectOne = (id: string) => {
    const next = new Set(deselectedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setDeselectedIds(next);
  };

  // Quick preset ranges
  const applyPreset = (preset: 'last7' | 'last14' | 'thisMonth' | 'lastMonth') => {
    setActivePreset(preset);
    setDeselectedIds(new Set());
    const today = new Date();
    if (preset === 'last7') {
      setDateFrom(getNDaysAgoStr(6));
      setDateTo(getTodayStr());
    } else if (preset === 'last14') {
      setDateFrom(getNDaysAgoStr(13));
      setDateTo(getTodayStr());
    } else if (preset === 'thisMonth') {
      const year = today.getFullYear();
      const month = today.getMonth();
      const firstDay = `${year}-${String(month + 1).padStart(2, '0')}-01`;
      const lastDayNum = new Date(year, month + 1, 0).getDate();
      const lastDay = `${year}-${String(month + 1).padStart(2, '0')}-${String(lastDayNum).padStart(2, '0')}`;
      setDateFrom(firstDay);
      setDateTo(lastDay);
    } else if (preset === 'lastMonth') {
      const prevMonthLastDay = new Date(today.getFullYear(), today.getMonth(), 0);
      const prevMonthFirstDay = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      setDateFrom(getLocalDateString(prevMonthFirstDay));
      setDateTo(getLocalDateString(prevMonthLastDay));
    }
  };

  const handleDateFromChange = (val: string) => {
    setDateFrom(val);
    setActivePreset(null);
    setDeselectedIds(new Set());
  };

  const handleDateToChange = (val: string) => {
    setDateTo(val);
    setActivePreset(null);
    setDeselectedIds(new Set());
  };

  // Handle batch download
  const handleStartDownload = async () => {
    if (selectedInvoices.length === 0) {
      toast.error('Please select at least one invoice to download');
      return;
    }

    setIsDownloading(true);
    setDownloadProgress({ current: 0, total: selectedInvoices.length });

    try {
      const downloadPayload = selectedInvoices.map((inv) => ({
        url: inv.url,
        filename: formatClaimFileName(inv.date, inv.title, inv.amount, inv.vendor),
      }));

      await downloadReceiptBatch(downloadPayload, (current, total) => {
        setDownloadProgress({ current, total });
      });

      toast.success(`Downloaded ${selectedInvoices.length} receipts successfully! 🎉`);

      // Immediately prompt user whether they want to delete from Google Drive
      setShowCleanupModal(true);
    } catch (err: any) {
      console.error(err);
      toast.error('Error during download: ' + (err.message || 'Unknown error'));
    } finally {
      setIsDownloading(false);
      setDownloadProgress(null);
    }
  };

  // Handle deleting the selected files from Google Drive
  const handleConfirmDeleteFromDrive = async () => {
    if (selectedInvoices.length === 0) return;

    setIsDeletingFromDrive(true);
    toast.info(`Cleaning up ${selectedInvoices.length} files from Google Drive...`);

    let deletedDriveCount = 0;
    let failedCount = 0;

    try {
      for (const item of selectedInvoices) {
        // 1. Delete from Google Drive if it has a fileId
        const driveId = extractDriveFileId(item.url);
        if (driveId) {
          const ok = await deleteDriveReceipt(driveId);
          if (ok) deletedDriveCount++;
          else failedCount++;
        }

        // 2. Update record in Google Sheets
        if (item.source === 'invoice') {
          // Delete row from Invoices sheet
          try {
            await deleteUnifiedRow('Invoices', item.rowIndex, item.id);
          } catch (e) {
            console.warn('Could not delete Invoices row:', e);
          }
        } else if (item.source === 'transaction') {
          // Clear ReceiptUrl on transaction row so spending data is retained intact
          try {
            const sheetName = item._month || (item.date ? item.date.substring(0, 7) : 'Transactions');
            await updateUnifiedRow(sheetName, item.rowIndex || 2, {
              Date: item.date,
              Category: item.title,
              Description: item.vendor,
              Amount: item.amount,
              ReceiptUrl: '',
              receiptUrl: '',
              Id: item.txId || item.id,
              _month: item._month,
            });
          } catch (e) {
            console.warn('Could not clear transaction receiptUrl:', e);
          }
        }
      }

      // Invalidate queries so UI reflects freed storage and updated state
      queryClient.invalidateQueries({ queryKey: ['sheet'] });
      queryClient.invalidateQueries({ queryKey: ['months'] });
      queryClient.invalidateQueries({ queryKey: ['overview'] });

      toast.success(
        `🎉 Storage reclaimed! Removed ${selectedInvoices.length} receipt files from Google Drive.`
      );
      setShowCleanupModal(false);
      onAfterDelete?.();
      onClose();
    } catch (err: any) {
      console.error('Delete error:', err);
      toast.error('Drive cleanup encountered an issue: ' + (err.message || 'Unknown error'));
    } finally {
      setIsDeletingFromDrive(false);
    }
  };

  useLockBodyScroll(isOpen || showCleanupModal || Boolean(previewUrl));

  if (!isOpen) return null;

  return ReactDOM.createPortal(
    <AnimatePresence>
      <div className="fixed inset-0 z-[150] flex items-center justify-center p-3 sm:p-4">
        {/* Backdrop */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={() => !isDownloading && !isDeletingFromDrive && onClose()}
          className="fixed inset-0 bg-black/80 backdrop-blur-md"
        />

        {/* Modal Window */}
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-labelledby="date-range-download-title"
          aria-describedby="date-range-download-description"
          initial={{ opacity: 0, scale: 0.95, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 20 }}
          transition={{ type: "spring" as const, damping: 28, stiffness: 350 }}
          className="relative w-full max-w-2xl max-h-[calc(100dvh-1.5rem)] overflow-y-auto overscroll-contain touch-pan-y [-webkit-overflow-scrolling:touch] custom-scrollbar rounded-3xl border border-slate-200 dark:border-white/[0.12] bg-white/95 dark:bg-[#090d16]/95 p-4 sm:p-6 shadow-[0_25px_60px_-15px_rgba(0,0,0,0.85),0_0_40px_rgba(99,102,241,0.12)] z-10 backdrop-blur-3xl space-y-4"
        >
          {/* Animated gradient border container */}
          <div className="absolute inset-0 z-[-1] opacity-40 mix-blend-overlay pointer-events-none rounded-3xl bg-[radial-gradient(circle_at_50%_0%,_var(--tw-gradient-stops))] from-indigo-500/30 via-slate-100 dark:via-zinc-950/5 to-white dark:to-zinc-950/50" />

            {/* Download Progress Bar */}
            <AnimatePresence>
              {isDownloading && downloadProgress && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="absolute top-0 left-0 right-0 z-20"
                >
                  <div className="h-1.5 w-full bg-white dark:bg-zinc-900 overflow-hidden rounded-t-3xl relative">
                    <motion.div
                      className="absolute inset-y-0 left-0 bg-gradient-to-r from-indigo-500 via-purple-500 to-emerald-400"
                      initial={{ width: 0 }}
                      animate={{ width: `${(downloadProgress.current / downloadProgress.total) * 100}%` }}
                      transition={{ ease: 'easeOut', duration: 0.3 }}
                    />
                    <motion.div
                      className="absolute inset-y-0 left-0 bg-white/20 w-full blur-md"
                      initial={{ width: 0 }}
                      animate={{ width: `${(downloadProgress.current / downloadProgress.total) * 100}%` }}
                    />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <CockpitModalHeader
              title="Download invoices"
              titleId="date-range-download-title"
              description="Select a date range to download or manage your invoices."
              descriptionId="date-range-download-description"
              icon={<Calendar size={20} />}
              onClose={onClose}
              closeDisabled={isDownloading || isDeletingFromDrive}
              closeLabel="Close invoice download"
            />

            {/* Date Range Selection & Presets */}
            <div className="space-y-2.5 p-3 sm:p-4 rounded-2xl bg-white/90 dark:bg-zinc-900/40 border border-slate-200 dark:border-zinc-800/60 backdrop-blur-md my-2.5 shrink-0 w-full min-w-0 overflow-hidden box-border">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11px] sm:text-xs font-semibold text-slate-700 dark:text-zinc-300 uppercase tracking-wider">
                  Select Period
                </span>
                {/* Preset Chips */}
                <div className="flex flex-wrap items-center gap-1.5">
                  {(['last7', 'last14', 'thisMonth', 'lastMonth'] as const).map((preset) => {
                    const isActive = activePreset === preset;
                    const labels = {
                      last7: 'Last 7 Days',
                      last14: 'Last 14 Days',
                      thisMonth: 'This Month',
                      lastMonth: 'Last Month',
                    };

                    return (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => applyPreset(preset)}
                        className={`px-2.5 py-1 rounded-lg text-[10px] sm:text-[11px] font-medium transition-all cursor-pointer ${
                          isActive
                            ? 'bg-indigo-500/20 text-indigo-800 dark:text-indigo-300 border border-indigo-500/50 shadow-[0_0_10px_rgba(99,102,241,0.2)] font-semibold'
                            : 'bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-700 dark:text-zinc-300 hover:text-slate-950 dark:hover:text-white border border-transparent'
                        }`}
                      >
                        {labels[preset]}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Date Inputs */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-3 pt-0.5 w-full min-w-0">
                <div className="min-w-0 w-full">
                  <label className="block text-[10px] sm:text-[11px] text-slate-600 dark:text-zinc-400 font-medium mb-1">
                    From Date
                  </label>
                  <input
                    type="date"
                    value={dateFrom}
                    onChange={(e) => handleDateFromChange(e.target.value)}
                    className="w-full min-w-0 max-w-full block appearance-none [-webkit-appearance:none] rounded-xl border border-slate-300 dark:border-zinc-700 bg-white/90 dark:bg-zinc-950/60 px-3 py-2 text-xs text-slate-950 dark:text-white outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/50 transition-all font-mono [color-scheme:dark] box-border"
                  />
                </div>

                <div className="min-w-0 w-full">
                  <label className="block text-[10px] sm:text-[11px] text-slate-600 dark:text-zinc-400 font-medium mb-1">
                    To Date
                  </label>
                  <input
                    type="date"
                    value={dateTo}
                    onChange={(e) => handleDateToChange(e.target.value)}
                    className="w-full min-w-0 max-w-full block appearance-none [-webkit-appearance:none] rounded-xl border border-slate-300 dark:border-zinc-700 bg-white/90 dark:bg-zinc-950/60 px-3 py-2 text-xs text-slate-950 dark:text-white outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/50 transition-all font-mono [color-scheme:dark] box-border"
                  />
                </div>
              </div>
            </div>

            {/* Results Summary Bar */}
            <div className="flex flex-wrap items-center justify-between gap-2 px-1 mb-2 shrink-0">
              <div className="flex items-center gap-2">
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.95 }}
                  onClick={toggleSelectAll}
                  disabled={matchingInvoices.length === 0}
                  className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-zinc-300 hover:text-slate-950 dark:hover:text-white cursor-pointer disabled:opacity-40"
                >
                  <motion.div
                    layout
                    className={`h-4 w-4 rounded-md border flex items-center justify-center transition-colors ${
                      allSelected ? 'bg-indigo-500 border-indigo-500 text-white dark:text-white' : 'border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-900'
                    }`}
                  >
                    {allSelected && <Check className="h-3 w-3" />}
                  </motion.div>
                  <span>Select All ({selectedInvoices.length}/{matchingInvoices.length})</span>
                </motion.button>
              </div>

              <div className="text-right">
                <span className="text-xs text-slate-600 dark:text-zinc-400">Total Claimable: </span>
                <strong className="text-xs sm:text-sm font-mono font-bold text-emerald-800 dark:text-emerald-400">
                  RM {totalSelectedAmount.toFixed(2)}
                </strong>
              </div>
            </div>

            {/* List of Matching Invoices */}
            <div className="space-y-2">
              {matchingInvoices.length === 0 ? (
                <div
                  className="py-12 text-center rounded-2xl border border-dashed border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/20 space-y-3"
                >
                  <div className="flex justify-center">
                    <Calendar className="h-10 w-10 text-slate-700 dark:text-zinc-200 drop-shadow-md" />
                  </div>
                  <p className="text-sm font-medium text-slate-700 dark:text-zinc-300">
                    No invoices found in this date range
                  </p>
                  <p className="text-xs text-slate-500 dark:text-zinc-400 max-w-sm mx-auto">
                    Try adjusting the dates above (e.g. {dateFrom || 'start'} to {dateTo || 'end'}) or upload new receipts.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {matchingInvoices.map((inv) => {
                    const isChecked = !deselectedIds.has(inv.id);
                    const claimFileName = formatClaimFileName(inv.date, inv.title, inv.amount, inv.vendor);

                    return (
                      <div
                        key={inv.id}
                        onClick={() => toggleSelectOne(inv.id)}
                        className={`p-3 rounded-2xl border transition-all cursor-pointer flex items-center justify-between gap-3 hover:shadow-lg hover:shadow-indigo-500/10 active:scale-[0.99] ${
                          isChecked
                            ? 'border-indigo-500/50 bg-indigo-500/10 shadow-[0_0_15px_rgba(99,102,241,0.15)]'
                            : 'border-slate-200 dark:border-zinc-800/80 bg-white/90 dark:bg-zinc-900/40 hover:bg-white/90 dark:hover:bg-zinc-900/80'
                        }`}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          {/* Animated Checkbox */}
                          <div
                            className={`h-4 w-4 rounded-md border shrink-0 flex items-center justify-center transition-colors ${
                              isChecked ? 'bg-indigo-500 border-indigo-500 text-white dark:text-white shadow-[0_0_8px_rgba(99,102,241,0.5)]' : 'border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-900'
                            }`}
                          >
                            {isChecked && <Check className="h-3 w-3" />}
                          </div>

                          {/* Small Preview Thumbnail */}
                          <div
                            onClick={(e) => {
                              e.stopPropagation();
                              setPreviewUrl({ url: inv.url, title: inv.title });
                            }}
                            className="h-10 w-10 rounded-xl bg-white dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 overflow-hidden shrink-0 flex items-center justify-center group relative cursor-pointer"
                            title="Click to preview"
                          >
                            {inv.url.startsWith('data:image') || inv.url.includes('google.com') || inv.url.match(/\.(jpeg|jpg|png|webp)$/i) ? (
                              <img src={inv.url} alt="" className="h-full w-full object-cover transition-transform group-hover:scale-110" onError={(e) => { (e.target as HTMLElement).style.display = 'none'; }} />
                            ) : (
                              <Calendar className="h-4 w-4 text-slate-500 dark:text-zinc-400 transition-transform group-hover:scale-110" />
                            )}
                            <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity backdrop-blur-[1px]">
                              <Eye className="h-3.5 w-3.5 text-slate-950 dark:text-white drop-shadow-md" />
                            </div>
                          </div>

                          {/* Details */}
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="text-xs font-bold text-slate-950 dark:text-white truncate max-w-[180px] sm:max-w-xs">
                                {inv.title}
                              </p>
                              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400 shrink-0">
                                {inv.date}
                              </span>
                            </div>
                            <p className="text-[10px] text-slate-600 dark:text-zinc-400 font-mono truncate max-w-[220px] sm:max-w-sm mt-0.5">
                              {claimFileName}
                            </p>
                          </div>
                        </div>

                        {/* Amount & Actions */}
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-xs sm:text-sm font-extrabold font-mono text-emerald-800 dark:text-emerald-400">
                            {inv.amount > 0 ? `RM ${inv.amount.toFixed(2)}` : 'Attached'}
                          </span>

                          <motion.a
                            whileHover={{ scale: 1.1, backgroundColor: 'rgba(39, 39, 42, 1)' }}
                            whileTap={{ scale: 0.9 }}
                            href={inv.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="p-1.5 rounded-lg text-slate-500 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 transition-colors"
                            title="Open in Drive"
                          >
                            <ExternalLink className="h-3 w-3" />
                          </motion.a>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Action Footer */}
            <div className="shrink-0 pt-3 border-t border-slate-200 dark:border-white/[0.08] flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5 mt-auto">
              {/* Secondary Actions (Clean Up & Close) */}
              <div className="flex items-center justify-between sm:justify-start gap-2 order-2 sm:order-1">
                <motion.button
                  whileHover={{ scale: 1.02, boxShadow: '0 0 15px rgba(244, 63, 94, 0.15)' }}
                  whileTap={{ scale: 0.97 }}
                  type="button"
                  onClick={() => setShowCleanupModal(true)}
                  disabled={selectedInvoices.length === 0 || isDownloading || isDeletingFromDrive}
                  className="flex items-center justify-center gap-1.5 flex-1 sm:flex-initial px-3.5 py-2.5 rounded-xl border border-rose-500/30 bg-rose-500/10 hover:bg-rose-500/20 text-rose-800 dark:text-rose-300 text-xs font-semibold transition-all cursor-pointer disabled:opacity-40"
                  title="Delete directly from Google Drive without downloading"
                >
                  <Trash2 className="h-3.5 w-3.5 shrink-0" />
                  <span>Clean Up Drive ({selectedInvoices.length})</span>
                </motion.button>

                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.95 }}
                  type="button"
                  onClick={onClose}
                  disabled={isDownloading || isDeletingFromDrive}
                  className="px-4 py-2.5 rounded-xl text-xs font-semibold text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white bg-white dark:bg-zinc-900 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                >
                  Close
                </motion.button>
              </div>

              {/* Primary Action Button (Download Receipts) - Full width on mobile, prominent */}
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.97 }}
                type="button"
                onClick={handleStartDownload}
                disabled={selectedInvoices.length === 0 || isDownloading || isDeletingFromDrive}
                className="order-1 sm:order-2 w-full sm:w-auto flex items-center justify-center gap-2 px-5 py-3 sm:py-2.5 rounded-xl bg-gradient-to-r from-indigo-500 to-purple-500 hover:from-indigo-400 hover:to-purple-400 disabled:opacity-50 text-white dark:text-white text-sm font-bold shadow-lg shadow-indigo-500/25 transition-all cursor-pointer relative overflow-hidden"
              >
                {isDownloading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                    <span>
                      Downloading {downloadProgress?.current || 0} of {downloadProgress?.total || selectedInvoices.length}...
                    </span>
                  </>
                ) : (
                  <>
                    <Download className="h-4 w-4 shrink-0" />
                    <span>Download {selectedInvoices.length} Receipts</span>
                  </>
                )}
                {/* Subtle shimmer effect over button */}
                {!isDownloading && (
                  <motion.div
                    className="absolute inset-0 bg-white/20 skew-x-[-20deg]"
                    initial={{ x: '-100%' }}
                    animate={{ x: '200%' }}
                    transition={{ repeat: Infinity, duration: 2, ease: 'easeInOut', delay: 1 }}
                  />
                )}
              </motion.button>
            </div>
        </motion.div>

        {/* Post-Download / Storage Clean Up Confirmation Dialog */}
        <AnimatePresence>
          {showCleanupModal && (
            <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => !isDeletingFromDrive && setShowCleanupModal(false)}
                className="fixed inset-0 bg-black/90 backdrop-blur-md"
              />

              <motion.div
                role="dialog"
                aria-modal="true"
                aria-labelledby="receipt-cleanup-title"
                initial={{ opacity: 0, scale: 0.95, y: 30 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 30 }}
                transition={springTransition}
                className="relative max-w-md w-full max-h-[calc(100dvh-1.5rem)] overflow-y-auto overscroll-contain touch-pan-y [-webkit-overflow-scrolling:touch] custom-scrollbar rounded-3xl border border-rose-500/30 bg-white/95 dark:bg-[#090d16]/95 backdrop-blur-3xl p-6 shadow-2xl z-10 space-y-4"
              >
                <div className="flex items-start gap-3">
                  <div className="relative">
                    <motion.div
                      animate={{ scale: [1, 1.2, 1], opacity: [0.2, 0.5, 0.2] }}
                      transition={{ duration: 2, repeat: Infinity }}
                      className="absolute inset-0 bg-rose-500 rounded-2xl blur-md"
                    />
                    <div className="relative h-11 w-11 rounded-2xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center text-rose-800 dark:text-rose-400 shrink-0">
                      <AlertTriangle className="h-6 w-6" />
                    </div>
                  </div>
                  <div>
                    <h3 id="receipt-cleanup-title" className="text-base font-bold text-slate-950 dark:text-white tracking-tight">
                      Delete from Google Drive?
                    </h3>
                    <p className="text-xs text-rose-800/90 dark:text-rose-300/90 font-medium mt-0.5">
                      Free up storage so your Google Drive won&apos;t explode 🚀
                    </p>
                  </div>
                </div>

                <div className="p-3.5 rounded-2xl bg-white/90 dark:bg-zinc-900/80 border border-slate-200 dark:border-zinc-800 text-xs space-y-2 text-slate-700 dark:text-zinc-300">
                  <p>
                    You have selected <strong className="text-slate-950 dark:text-white">{selectedInvoices.length} receipts</strong> totaling <strong className="text-emerald-800 dark:text-emerald-400">RM {totalSelectedAmount.toFixed(2)}</strong>.
                  </p>
                  <div className="flex items-start gap-2 pt-1 border-t border-slate-200 dark:border-zinc-800/80 text-[11px] text-slate-600 dark:text-zinc-400">
                    <ShieldCheck className="h-4 w-4 text-emerald-800 dark:text-emerald-400 shrink-0 mt-0.5" />
                    <span>
                      <strong>Your records are 100% safe:</strong> Your expense amounts, dates, and accounting stats will remain in Kinova. Only the cloud file copy in Google Drive is trashed.
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 pt-2">
                  <motion.button
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    type="button"
                    onClick={() => setShowCleanupModal(false)}
                    disabled={isDeletingFromDrive}
                    className="w-full py-2.5 rounded-xl border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:bg-slate-100 dark:hover:bg-zinc-800 text-xs font-semibold text-slate-700 dark:text-zinc-300 transition-colors cursor-pointer"
                  >
                    Keep in Drive
                  </motion.button>

                  <motion.button
                    whileHover={{ scale: 1.03, boxShadow: '0 0 20px rgba(225, 29, 72, 0.4)' }}
                    whileTap={{ scale: 0.97 }}
                    animate={{ boxShadow: ['0 0 0px rgba(225,29,72,0)', '0 0 15px rgba(225,29,72,0.3)', '0 0 0px rgba(225,29,72,0)'] }}
                    transition={{ repeat: Infinity, duration: 2 }}
                    type="button"
                    onClick={handleConfirmDeleteFromDrive}
                    disabled={isDeletingFromDrive}
                    className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-xs font-bold text-white dark:text-white shadow-lg transition-all cursor-pointer"
                  >
                    {isDeletingFromDrive ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        <span>Deleting...</span>
                      </>
                    ) : (
                      <>
                        <Trash2 className="h-3.5 w-3.5" />
                        <span>Yes, Delete from Drive</span>
                      </>
                    )}
                  </motion.button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Thumbnail Preview Modal */}
        <AnimatePresence>
          {previewUrl && (
            <div className="fixed inset-0 z-[250] flex items-center justify-center p-4">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setPreviewUrl(null)}
                className="fixed inset-0 bg-black/90 backdrop-blur-md"
              />

              <motion.div
                role="dialog"
                aria-modal="true"
                aria-label={`Receipt preview: ${previewUrl.title}`}
                initial={{ scale: 0.8, opacity: 0, y: 20 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.8, opacity: 0, y: 20 }}
                transition={springTransition}
                className="relative max-w-xl w-full max-h-[calc(100dvh-1.5rem)] overflow-y-auto overscroll-contain touch-pan-y [-webkit-overflow-scrolling:touch] custom-scrollbar rounded-3xl border border-slate-200 dark:border-white/[0.12] bg-white/95 dark:bg-[#090d16]/95 backdrop-blur-3xl p-4 shadow-2xl z-10 flex flex-col space-y-3"
              >
                <div className="flex items-center justify-between pb-2 border-b border-slate-200 dark:border-zinc-800/50">
                  <span className="text-xs font-semibold text-slate-950 dark:text-white truncate drop-shadow-md">
                    {previewUrl.title}
                  </span>
                  <motion.button
                    whileHover={{ scale: 1.1, backgroundColor: 'rgba(39,39,42,1)' }}
                    whileTap={{ scale: 0.9 }}
                    onClick={() => setPreviewUrl(null)}
                    className="p-1 rounded-lg text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white bg-white/90 dark:bg-zinc-900/50 transition-colors"
                  >
                    <X className="h-4 w-4" />
                  </motion.button>
                </div>

                <div className="flex items-center justify-center max-h-[65vh] overflow-hidden rounded-2xl bg-black/50 backdrop-blur-sm border border-slate-200 dark:border-zinc-900">
                  <img
                    src={previewUrl.url}
                    alt=""
                    className="max-h-[60vh] w-auto object-contain rounded-xl drop-shadow-2xl"
                  />
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      </div>
    </AnimatePresence>,
    document.body
  );
}
