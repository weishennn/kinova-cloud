'use client';

import React, { useState, useRef, useMemo, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  UploadCloud, Search, Filter, FileText, ExternalLink, 
  Trash2, X, Eye, Loader2, Image as ImageIcon, Plus, CheckCircle2, 
  Calendar as CalendarIcon, Download, HardDrive, ShieldCheck,
  Edit2, Check, AlertTriangle, ChevronLeft, ChevronRight, Sparkles, Paperclip, ChevronDown, ChevronUp
} from 'lucide-react';
import { useSheetData, useAddRow, useDeleteRow, updateUnifiedRow } from '@/hooks/useSheets';
import { useTransactions } from '@/hooks/useTransactions';
import { useQueryClient } from '@tanstack/react-query';
import { driveApi } from '@/lib/sheets-api';
import { 
  formatClaimFileName, 
  downloadReceiptFile, 
  deleteDriveReceipt, 
  extractDriveFileId 
} from '@/lib/claim-helper';
import {
  LHDN_TAX_CATEGORIES,
  YearlyTaxProfileOverride,
  calculateYearlyTaxReliefSummary,
  getSavedTaxCaps,
  saveTaxCaps,
  getSavedTaxRate,
  saveTaxRate,
  getSavedTaxProfile,
  saveTaxProfileForYear,
  getTransactionTaxRelief,
} from '@/lib/lhdn-tax-helper';
import { getAmountInBaseCurrency } from '@/lib/currency';
import { AnimatedNumber } from '@/components/shared/animated-number';
import { SETTINGS_UPDATED_EVENT } from '@/lib/cloud-settings-sync';
import { ClaimsCalendar } from '@/components/invoices/claims-calendar';
import { 
  DateRangeDownloadModal, 
  InvoiceItem 
} from '@/components/invoices/date-range-download-modal';
import { AttachReceiptModal } from '@/components/invoices/attach-receipt-modal';
import { compressImageFile } from '@/lib/image-compressor';
import { getLocalDateString } from '@/lib/date-helper';
import { useLockBodyScroll } from '@/hooks/useLockBodyScroll';
import { toast } from 'sonner';
import { CockpitPageHeading } from '@/components/money-cockpit/cockpit-page-heading';

// Animation Variants
const staggerContainer = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.08 }
  }
};

const headerButtonVariants = {
  hidden: { opacity: 0, y: -10 },
  show: { opacity: 1, y: 0, transition: { type: 'spring' as const, stiffness: 300, damping: 24 } }
};

const gridContainer = { 
  show: { transition: { staggerChildren: 0.06 } } 
};

const gridItem = { 
  hidden: { opacity: 0, y: 20, scale: 0.95 }, 
  show: { opacity: 1, y: 0, scale: 1, transition: { type: 'spring' as const, stiffness: 400, damping: 30 } } 
};

export default function InvoicesPage() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<'tax' | 'calendar' | 'vault'>('tax');
  const [searchQuery, setSearchQuery] = useState('');
  const [vaultFilter, setVaultFilter] = useState<'all' | 'tax'>('all');
  const [selectedPreview, setSelectedPreview] = useState<{ url: string; title: string; filename: string } | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Date Range Download Modal state
  const [isRangeModalOpen, setIsRangeModalOpen] = useState(false);
  const [rangeModalFrom, setRangeModalFrom] = useState<string | undefined>(undefined);
  const [rangeModalTo, setRangeModalTo] = useState<string | undefined>(undefined);
  const [rangeTaxOnly, setRangeTaxOnly] = useState(false);

  // Single delete confirmation state
  const [invoiceToDelete, setInvoiceToDelete] = useState<InvoiceItem | null>(null);
  const [isDeletingSingle, setIsDeletingSingle] = useState(false);

  // Attach Receipt to Transaction Modal state
  const [fileToAttach, setFileToAttach] = useState<File | null>(null);
  const [isAttachModalOpen, setIsAttachModalOpen] = useState(false);
  const [preselectedAttachTxId, setPreselectedAttachTxId] = useState<string | null>(null);

  // LHDN Tax Relief state (Assessment Year, Custom Caps, Tax Bracket Rate, Income/PCB Profile)
  const currentYearStr = useMemo(() => String(new Date().getFullYear()), []);
  const [selectedTaxYear, setSelectedTaxYear] = useState<string>(currentYearStr);
  const [taxCaps, setTaxCaps] = useState<Record<string, number>>(() => getSavedTaxCaps());
  const [taxRate, setTaxRate] = useState<number>(() => getSavedTaxRate());
  const [taxProfile, setTaxProfile] = useState<YearlyTaxProfileOverride>(() => getSavedTaxProfile(currentYearStr));
  const [isEditingTaxRate, setIsEditingTaxRate] = useState(false);
  const [taxRateInput, setTaxRateInput] = useState(String(getSavedTaxRate()));
  const [isEditingAnnualIncome, setIsEditingAnnualIncome] = useState(false);
  const [annualIncomeInput, setAnnualIncomeInput] = useState('');
  const [isEditingPcbPaid, setIsEditingPcbPaid] = useState(false);
  const [pcbPaidInput, setPcbPaidInput] = useState('');
  const [isEditingPayslipEpf, setIsEditingPayslipEpf] = useState(false);
  const [payslipEpfInput, setPayslipEpfInput] = useState('');
  const [isEditingPayslipSocso, setIsEditingPayslipSocso] = useState(false);
  const [payslipSocsoInput, setPayslipSocsoInput] = useState('');
  const [isEditingOtherReliefs, setIsEditingOtherReliefs] = useState(false);
  const [otherReliefsInput, setOtherReliefsInput] = useState('');
  const [isEditingOtherRebates, setIsEditingOtherRebates] = useState(false);
  const [otherRebatesInput, setOtherRebatesInput] = useState('');
  const [editingTaxCategory, setEditingTaxCategory] = useState<string | null>(null);
  const [taxCapInput, setTaxCapInput] = useState('');
  const [taxViewFilter, setTaxViewFilter] = useState<'all' | 'claimed' | 'missing'>('all');
  const [expandedTaxCatId, setExpandedTaxCatId] = useState<string | null>(null);

  useEffect(() => {
    setTaxProfile(getSavedTaxProfile(selectedTaxYear));
    setIsEditingAnnualIncome(false);
    setIsEditingPcbPaid(false);
    setIsEditingPayslipEpf(false);
    setIsEditingPayslipSocso(false);
    setIsEditingOtherReliefs(false);
    setIsEditingOtherRebates(false);
  }, [selectedTaxYear]);

  useEffect(() => {
    const syncTaxSettings = () => {
      setTaxCaps(getSavedTaxCaps());
      const r = getSavedTaxRate();
      setTaxRate(r);
      setTaxRateInput(String(r));
      setTaxProfile(getSavedTaxProfile(selectedTaxYear));
    };
    window.addEventListener(SETTINGS_UPDATED_EVENT, syncTaxSettings);
    return () => window.removeEventListener(SETTINGS_UPDATED_EVENT, syncTaxSettings);
  }, [selectedTaxYear]);

  useLockBodyScroll(Boolean(invoiceToDelete || selectedPreview || isAttachModalOpen));

  // Real hooks
  const { data: rawInvoicesData } = useSheetData('Invoices');
  const { transactions = [] } = useTransactions();
  const addInvoiceMutation = useAddRow();
  const deleteInvoiceMutation = useDeleteRow();

  // Available years for LHDN Assessment Year selector
  const availableTaxYears = useMemo(() => {
    const years = new Set<string>([currentYearStr, String(Number(currentYearStr) - 1)]);
    transactions.forEach((t) => {
      if (t.date && /^\d{4}/.test(t.date)) {
        years.add(t.date.substring(0, 4));
      }
    });
    return Array.from(years).sort((a, b) => b.localeCompare(a));
  }, [transactions, currentYearStr]);

  // Calculate LHDN Tax Relief Summary for selected Assessment Year
  const taxReliefSummary = useMemo(() => {
    return calculateYearlyTaxReliefSummary(transactions, selectedTaxYear, taxCaps, taxRate, taxProfile);
  }, [transactions, selectedTaxYear, taxCaps, taxRate, taxProfile]);

  // Map transaction ID -> tax relief category for quick badge display
  const txTaxReliefMap = useMemo(() => {
    const map = new Map<string, ReturnType<typeof getTransactionTaxRelief>>();
    transactions.forEach((t) => {
      const cat = getTransactionTaxRelief(t);
      if (cat) {
        map.set(t.id, cat);
      }
    });
    return map;
  }, [transactions]);

  // Combine invoices from Invoices sheet and transaction receipt attachments
  const allInvoices: InvoiceItem[] = useMemo(() => {
    const list: InvoiceItem[] = [];

    // 1. From Invoices sheet
    const invoiceRows = rawInvoicesData?.rows || [];
    invoiceRows.forEach((r: any, idx: number) => {
      const url = String(r.Url || r.url || '');
      if (url) {
        list.push({
          id: String(r.Id || r.id || `inv_${idx}`),
          title: String(r.Vendor || r.vendor || r.Title || 'Invoice'),
          vendor: String(r.Vendor || r.vendor || 'Vendor'),
          date: String(r.Date || r.date || ''),
          amount: parseFloat(String(r.Amount || r.amount || 0)) || 0,
          currency: String(r.Currency || r.currency || 'MYR'),
          url: url,
          source: 'invoice',
          rowIndex: idx,
        });
      }
    });

    // 2. From Transaction Receipts
    transactions.forEach((t) => {
      if (t.receiptUrl) {
        list.push({
          id: `tx_${t.id}`,
          title: t.description || t.category,
          vendor: t.account || t.category,
          date: t.date,
          amount: t.amount,
          currency: t.currency || 'MYR',
          url: t.receiptUrl,
          source: 'transaction',
          rowIndex: t._rowIndex,
          _month: t._month,
          txId: t.id,
        });
      }
    });

    // Deduplicate by URL
    const seenUrls = new Set<string>();
    const deduplicated = list.filter((item) => {
      if (!item.url || seenUrls.has(item.url)) return false;
      seenUrls.add(item.url);
      return true;
    });

    // Sort descending by date
    return deduplicated.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [rawInvoicesData, transactions]);

  // Filtered by search and vault tax filter
  const filteredInvoices = useMemo(() => {
    let list = allInvoices;
    if (vaultFilter === 'tax') {
      list = list.filter((inv) => {
        if (inv.txId && txTaxReliefMap.has(inv.txId)) return true;
        return Boolean(
          getTransactionTaxRelief({
            type: 'expense',
            description: inv.title,
            category: inv.vendor,
            subCategory: '',
            notes: '',
          })
        );
      });
    }
    if (!searchQuery.trim()) return list;
    const q = searchQuery.toLowerCase();
    return list.filter(inv =>
      inv.title.toLowerCase().includes(q) ||
      inv.vendor.toLowerCase().includes(q) ||
      inv.date.includes(q)
    );
  }, [allInvoices, searchQuery, vaultFilter, txTaxReliefMap]);

  // Tax-only invoices for DateRangeDownloadModal when triggered from Tax tab
  const modalInvoices = useMemo(() => {
    if (!rangeTaxOnly) return allInvoices;
    return allInvoices.filter((inv) => {
      if (inv.txId && txTaxReliefMap.has(inv.txId)) return true;
      return Boolean(
        getTransactionTaxRelief({
          type: 'expense',
          description: inv.title,
          category: inv.vendor,
          subCategory: '',
          notes: '',
        })
      );
    });
  }, [allInvoices, rangeTaxOnly, txTaxReliefMap]);

  // Open Range modal with optional prefilled dates
  const handleOpenRangeDownload = (from?: string, to?: string, taxOnly = false) => {
    setRangeModalFrom(from);
    setRangeModalTo(to);
    setRangeTaxOnly(taxOnly);
    setIsRangeModalOpen(true);
  };

  // Trigger file picker pre-targeted to a specific transaction (e.g., Missing Receipt item)
  const handleAttachToSpecificTx = (txId: string) => {
    setPreselectedAttachTxId(txId);
    fileInputRef.current?.click();
  };

  const handleSaveTaxCap = (categoryId: string) => {
    const parsed = parseFloat(taxCapInput);
    if (!isNaN(parsed) && parsed >= 0) {
      const updated = { ...taxCaps, [categoryId]: parsed };
      setTaxCaps(updated);
      saveTaxCaps(updated);
      toast.success('Updated LHDN relief limit!');
    }
    setEditingTaxCategory(null);
    setTaxCapInput('');
  };

  const handleSaveTaxRate = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseFloat(taxRateInput);
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 30) {
      setTaxRate(parsed);
      saveTaxRate(parsed);
      setIsEditingTaxRate(false);
      toast.success(`Updated estimated tax rate to ${parsed}%`);
    }
  };

  const handleSaveAnnualIncome = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseFloat(annualIncomeInput);
    if (!isNaN(parsed) && parsed >= 0) {
      const updated = saveTaxProfileForYear(selectedTaxYear, { annualIncomeOverride: parsed });
      setTaxProfile(updated);
      setIsEditingAnnualIncome(false);
      toast.success(`Updated YA ${selectedTaxYear} Annual Taxable Income to RM ${parsed.toFixed(2)}`);
    }
  };

  const handleResetAnnualIncome = () => {
    const updated = saveTaxProfileForYear(selectedTaxYear, { annualIncomeOverride: null });
    setTaxProfile(updated);
    setIsEditingAnnualIncome(false);
    toast.success(`Reset YA ${selectedTaxYear} income to auto-track from recorded Salary/Income!`);
  };

  const handleSavePcbPaid = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseFloat(pcbPaidInput);
    if (!isNaN(parsed) && parsed >= 0) {
      const updated = saveTaxProfileForYear(selectedTaxYear, { pcbPaidOverride: parsed });
      setTaxProfile(updated);
      setIsEditingPcbPaid(false);
      toast.success(`Updated YA ${selectedTaxYear} Total PCB Paid to RM ${parsed.toFixed(2)}`);
    }
  };

  const handleResetPcbPaid = () => {
    const updated = saveTaxProfileForYear(selectedTaxYear, { pcbPaidOverride: null });
    setTaxProfile(updated);
    setIsEditingPcbPaid(false);
    toast.success(`Reset YA ${selectedTaxYear} PCB to auto-track from payslip & transactions!`);
  };

  const handleSavePayslipEpf = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseFloat(payslipEpfInput);
    if (!isNaN(parsed) && parsed >= 0) {
      const updated = saveTaxProfileForYear(selectedTaxYear, { epfFromSalaryOverride: parsed });
      setTaxProfile(updated);
      setIsEditingPayslipEpf(false);
      toast.success(`Updated YA ${selectedTaxYear} Payslip EPF deduction to RM ${parsed.toFixed(2)}`);
    }
  };

  const handleResetPayslipEpf = () => {
    const updated = saveTaxProfileForYear(selectedTaxYear, { epfFromSalaryOverride: null });
    setTaxProfile(updated);
    setIsEditingPayslipEpf(false);
    toast.success(`Reset YA ${selectedTaxYear} Payslip EPF to auto-track!`);
  };

  const handleSavePayslipSocso = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseFloat(payslipSocsoInput);
    if (!isNaN(parsed) && parsed >= 0) {
      const updated = saveTaxProfileForYear(selectedTaxYear, { socsoFromSalaryOverride: parsed });
      setTaxProfile(updated);
      setIsEditingPayslipSocso(false);
      toast.success(`Updated YA ${selectedTaxYear} Payslip SOCSO deduction to RM ${parsed.toFixed(2)}`);
    }
  };

  const handleResetPayslipSocso = () => {
    const updated = saveTaxProfileForYear(selectedTaxYear, { socsoFromSalaryOverride: null });
    setTaxProfile(updated);
    setIsEditingPayslipSocso(false);
    toast.success(`Reset YA ${selectedTaxYear} Payslip SOCSO to auto-track!`);
  };

  const handleSaveOtherReliefs = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseFloat(otherReliefsInput);
    if (!isNaN(parsed) && parsed >= 0) {
      const updated = saveTaxProfileForYear(selectedTaxYear, { additionalReliefsOverride: parsed });
      setTaxProfile(updated);
      setIsEditingOtherReliefs(false);
      toast.success(`Updated YA ${selectedTaxYear} Other Reliefs (Spouse/Child/Donations) to RM ${parsed.toFixed(2)}`);
    }
  };

  const handleResetOtherReliefs = () => {
    const updated = saveTaxProfileForYear(selectedTaxYear, { additionalReliefsOverride: null });
    setTaxProfile(updated);
    setIsEditingOtherReliefs(false);
    toast.success(`Reset YA ${selectedTaxYear} Other Reliefs to RM 0.00!`);
  };

  const handleSaveOtherRebates = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseFloat(otherRebatesInput);
    if (!isNaN(parsed) && parsed >= 0) {
      const updated = saveTaxProfileForYear(selectedTaxYear, { additionalRebatesOverride: parsed });
      setTaxProfile(updated);
      setIsEditingOtherRebates(false);
      toast.success(`Updated YA ${selectedTaxYear} Zakat / Other Tax Rebates to RM ${parsed.toFixed(2)}`);
    }
  };

  const handleResetOtherRebates = () => {
    const updated = saveTaxProfileForYear(selectedTaxYear, { additionalRebatesOverride: null });
    setTaxProfile(updated);
    setIsEditingOtherRebates(false);
    toast.success(`Reset YA ${selectedTaxYear} Zakat / Other Rebates to auto-track!`);
  };

  // Handle single invoice deletion from Drive and Sheet
  const handleConfirmSingleDelete = async () => {
    if (!invoiceToDelete) return;
    setIsDeletingSingle(true);

    try {
      // 1. Delete from Google Drive
      const driveId = extractDriveFileId(invoiceToDelete.url);
      if (driveId) {
        await deleteDriveReceipt(driveId);
      }

      // 2. Update Sheet
      if (invoiceToDelete.source === 'invoice') {
        await deleteInvoiceMutation.mutateAsync({
          sheetName: 'Invoices',
          rowIndex: invoiceToDelete.rowIndex,
          id: invoiceToDelete.id,
        });
      } else if (invoiceToDelete.source === 'transaction') {
        const originalTx = transactions.find((t) => t.id === (invoiceToDelete.txId || invoiceToDelete.id));
        const targetSheet = invoiceToDelete._month || (invoiceToDelete.date ? invoiceToDelete.date.substring(0, 7) : 'Transactions');
        await updateUnifiedRow(targetSheet, invoiceToDelete.rowIndex || 2, {
          Date: originalTx?.date || invoiceToDelete.date,
          Category: originalTx?.category || invoiceToDelete.vendor,
          SubCategory: originalTx?.subCategory || '',
          subCategory: originalTx?.subCategory || '',
          Description: originalTx?.description || invoiceToDelete.title,
          Amount: originalTx?.amount ?? invoiceToDelete.amount,
          Currency: originalTx?.currency || invoiceToDelete.currency || 'MYR',
          ReceiptUrl: '',
          receiptUrl: '',
          Notes: originalTx?.notes || '',
          notes: originalTx?.notes || '',
          Id: invoiceToDelete.txId || invoiceToDelete.id,
          _month: invoiceToDelete._month,
        });
      }

      queryClient.invalidateQueries({ queryKey: ['sheet'] });
      queryClient.invalidateQueries({ queryKey: ['months'] });
      queryClient.invalidateQueries({ queryKey: ['overview'] });

      toast.success(`Deleted "${invoiceToDelete.title}" from Google Drive! Storage freed. 🗑️`);
      setInvoiceToDelete(null);
    } catch (err: any) {
      console.error(err);
      toast.error('Failed to delete receipt from Google Drive');
    } finally {
      setIsDeletingSingle(false);
    }
  };

  // Handle file selection: opens attach modal to select date and transaction
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || !e.target.files[0]) return;
    const file = e.target.files[0];
    setFileToAttach(file);
    setIsAttachModalOpen(true);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Circular gauge values for Tax Relief Hero Card (same SVG geometry as BudgetPage)
  const activeTaxCapTotal = useMemo(() => {
    const activeSum = taxReliefSummary.categories
      .filter((c) => c.totalSpent > 0)
      .reduce((acc, c) => acc + c.limit, 0);
    return activeSum > 0 ? activeSum : 2500;
  }, [taxReliefSummary]);

  const taxProgressPercent = activeTaxCapTotal > 0
    ? Math.min((taxReliefSummary.totalClaimable / activeTaxCapTotal) * 100, 100)
    : 0;
  const circumference = 2 * Math.PI * 45; // ~282.7
  const taxStrokeDashoffset = circumference - (circumference * taxProgressPercent) / 100;

  const displayedTaxCategories = useMemo(() => {
    if (taxViewFilter === 'claimed') {
      return taxReliefSummary.categories.filter((c) => c.totalSpent > 0);
    }
    if (taxViewFilter === 'missing') {
      return taxReliefSummary.categories.filter((c) => c.missingReceiptCount > 0);
    }
    return taxReliefSummary.categories;
  }, [taxReliefSummary, taxViewFilter]);

  return (
    <div className="cockpit-module-page min-h-full">
      {/* Hidden file inputs */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileChange}
        accept="image/*,application/pdf"
        className="hidden"
      />

      <CockpitPageHeading
        title="Invoices, Claims & Tax Relief"
        description="Malaysia LHDN personal tax relief tracker, receipt audit vault, and daily claims"
        action={<motion.div
          variants={staggerContainer}
          initial="hidden"
          animate="show"
          className="flex flex-wrap items-center gap-2"
        >
          {/* Download by Date Range Button */}
          <motion.div variants={headerButtonVariants}>
            <motion.button
              whileHover={{ scale: 1.04 }}
              whileTap={{ scale: 0.96 }}
              onClick={() => handleOpenRangeDownload(undefined, undefined, false)}
              className="cockpit-secondary-action"
              title="Choose start & end date to download and clean up Drive"
            >
              <Download className="h-4 w-4" />
              <span>Download by Date Range</span>
            </motion.button>
          </motion.div>

          <motion.div variants={headerButtonVariants}>
            <motion.button
              whileHover={{ scale: 1.04 }}
              whileTap={{ scale: 0.96 }}
              onClick={() => {
                setPreselectedAttachTxId(null);
                fileInputRef.current?.click();
              }}
              disabled={isUploading}
              className="cockpit-primary-action"
            >
              {isUploading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Uploading...</span>
                </>
              ) : (
                <>
                  <UploadCloud className="h-4 w-4" />
                  <span>Upload Receipt</span>
                </>
              )}
            </motion.button>
          </motion.div>
        </motion.div>}
      />

      {/* Tab Navigation */}
      <div className="flex items-center gap-2 border-b border-slate-200 dark:border-white/[0.08] pb-3.5 overflow-x-auto no-scrollbar">
        <div className="cockpit-segmented-control relative flex items-center gap-1.5 p-1 rounded-2xl bg-white/90 dark:bg-zinc-950/80 border border-slate-200 dark:border-white/[0.08] shadow-sm">
          {(['tax', 'calendar', 'vault'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`relative flex items-center gap-2 min-h-[38px] px-3.5 sm:px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-colors duration-300 cursor-pointer touch-manipulation select-none active:scale-[0.96] whitespace-nowrap ${
                activeTab === tab
                  ? 'text-indigo-800 dark:text-indigo-200'
                  : 'text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white'
              }`}
            >
              {activeTab === tab && (
                <motion.div
                  layoutId="tab-indicator"
                  className="cockpit-segmented-pill absolute inset-0 rounded-xl -z-10 border pointer-events-none"
                  transition={{ type: "spring", bounce: 0.2, duration: 0.4 }}
                />
              )}
              {tab === 'tax' ? (
                <ShieldCheck className={`h-4 w-4 ${activeTab === tab ? 'text-emerald-800 dark:text-emerald-400' : ''}`} />
              ) : tab === 'calendar' ? (
                <CalendarIcon className={`h-4 w-4 ${activeTab === tab ? 'text-indigo-800 dark:text-indigo-400' : ''}`} />
              ) : (
                <FileText className={`h-4 w-4 ${activeTab === tab ? 'text-violet-800 dark:text-purple-400' : ''}`} />
              )}
              <span className="relative z-10">
                {tab === 'tax'
                  ? '🇲🇾 LHDN Tax Relief'
                  : tab === 'calendar'
                  ? 'Claims Calendar'
                  : `Receipts Vault (${allInvoices.length})`}
              </span>
              {tab === 'tax' && taxReliefSummary.missingReceiptCount > 0 && (
                <span className="relative z-10 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-800 dark:text-amber-300 border border-amber-500/30">
                  {taxReliefSummary.missingReceiptCount} Missing
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      <div className="relative">
        <AnimatePresence mode="wait">
          {activeTab === 'tax' ? (
            <motion.div
              key="tax"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.3 }}
              className="space-y-6 max-w-4xl"
            >
              {/* Assessment Year Selector Bar (Identical UI to BudgetPage Month Selector) */}
              <div className="bg-white/90 dark:bg-zinc-900/60 p-3.5 sm:p-4 rounded-3xl border border-slate-200 dark:border-white/[0.08] backdrop-blur-xl shadow-lg space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="p-2 rounded-xl bg-emerald-500/15 text-emerald-800 dark:text-emerald-400 border border-emerald-500/20 shrink-0">
                      <ShieldCheck className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] font-semibold text-slate-600 dark:text-zinc-400 uppercase tracking-wider block">
                          Malaysia LHDN Assessment Year (Tahun Taksiran)
                        </span>
                        {selectedTaxYear === currentYearStr && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border border-emerald-500/30">
                            Current YA
                          </span>
                        )}
                      </div>
                      <span className="text-sm sm:text-base font-bold text-slate-950 dark:text-white tracking-tight truncate block">
                        YA {selectedTaxYear} Personal Tax Relief & Receipt Audit Tracker
                      </span>
                    </div>
                  </div>

                  {/* Editable Tax Bracket Rate */}
                  {!isEditingTaxRate ? (
                    <button
                      type="button"
                      onClick={() => setIsEditingTaxRate(true)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/80 hover:bg-slate-100 dark:hover:bg-zinc-800 text-xs font-semibold text-slate-800 dark:text-zinc-200 transition-colors cursor-pointer"
                      title="Set your LHDN income tax bracket % to estimate tax savings"
                    >
                      <Edit2 className="h-3 w-3 text-emerald-800 dark:text-emerald-400" />
                      <span>Tax Rate: {taxRate}%</span>
                    </button>
                  ) : (
                    <form onSubmit={handleSaveTaxRate} className="flex items-center gap-1.5">
                      <span className="text-[11px] text-slate-600 dark:text-zinc-400">Tax %:</span>
                      <input
                        type="number"
                        min="0"
                        max="30"
                        step="1"
                        value={taxRateInput}
                        onChange={(e) => setTaxRateInput(e.target.value)}
                        className="w-16 rounded-xl border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-2.5 py-1 text-xs text-slate-950 dark:text-white outline-none focus:border-indigo-500 font-mono"
                      />
                      <button
                        type="submit"
                        className="p-1.5 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white dark:text-white cursor-pointer"
                      >
                        <Check className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setIsEditingTaxRate(false)}
                        className="p-1.5 rounded-xl bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-600 dark:text-zinc-400 cursor-pointer"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </form>
                  )}
                </div>

                {/* Year Navigation Box */}
                <div className="flex items-center justify-between gap-1.5 rounded-2xl border border-slate-200 dark:border-white/[0.08] bg-white/90 dark:bg-zinc-950/60 p-1 w-full">
                  <button
                    type="button"
                    onClick={() => setSelectedTaxYear(String(Number(selectedTaxYear) - 1))}
                    className="min-w-[40px] min-h-[40px] p-2 rounded-xl bg-white/90 dark:bg-zinc-900/80 hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-700 dark:text-zinc-300 hover:text-slate-950 dark:hover:text-white transition-colors cursor-pointer border border-slate-200 dark:border-white/[0.06] active:scale-95 flex items-center justify-center shrink-0"
                    title="Previous Assessment Year"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>

                  <select
                    value={selectedTaxYear}
                    onChange={(e) => setSelectedTaxYear(e.target.value)}
                    className="min-h-[40px] flex-1 min-w-0 rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white/90 dark:bg-zinc-900/90 px-3 py-1.5 text-xs font-semibold text-slate-950 dark:text-white outline-none focus:border-indigo-500 cursor-pointer transition-colors font-mono text-center truncate"
                  >
                    {availableTaxYears.map((yr) => (
                      <option key={yr} value={yr} className="bg-white dark:bg-zinc-900 text-slate-950 dark:text-white font-mono">
                        Assessment Year (YA) {yr} (Jan 1 – Dec 31, {yr})
                      </option>
                    ))}
                  </select>

                  <button
                    type="button"
                    onClick={() => setSelectedTaxYear(String(Number(selectedTaxYear) + 1))}
                    className="min-w-[40px] min-h-[40px] p-2 rounded-xl bg-white/90 dark:bg-zinc-900/80 hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-700 dark:text-zinc-300 hover:text-slate-950 dark:hover:text-white transition-colors cursor-pointer border border-slate-200 dark:border-white/[0.06] active:scale-95 flex items-center justify-center shrink-0"
                    title="Next Assessment Year"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {/* Hero Overview Grid: Circular Relief Gauge + Receipt Readiness Card (Identical layout to BudgetPage) */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Card 1: Circular Relief Gauge */}
                <motion.div
                  whileHover={{ y: -4, scale: 1.01 }}
                  transition={{ type: 'spring' as const, stiffness: 400, damping: 25 }}
                  className="rounded-3xl border border-slate-200 dark:border-white/[0.08] bg-card/60 p-6 text-center backdrop-blur-2xl flex flex-col justify-between shadow-xl hover:border-indigo-500/40 transition-colors specular-card"
                >
                  <div className="relative mx-auto h-48 w-48">
                    <svg className="h-full w-full" viewBox="0 0 100 100">
                      <circle cx="50" cy="50" r="45" fill="none" stroke="#27272a" strokeWidth="8" />
                      <motion.circle
                        cx="50"
                        cy="50"
                        r="45"
                        fill="none"
                        stroke="#10b981"
                        strokeWidth="8"
                        strokeDasharray={circumference}
                        strokeDashoffset={taxStrokeDashoffset}
                        strokeLinecap="round"
                        transform="rotate(-90 50 50)"
                        initial={{ strokeDashoffset: circumference }}
                        animate={{ strokeDashoffset: taxStrokeDashoffset }}
                        transition={{ duration: 1.2, ease: 'easeOut' }}
                        className="drop-shadow-[0_0_8px_rgba(16,185,129,0.3)]"
                      />
                    </svg>
                    <div className="absolute inset-0 flex flex-col items-center justify-center px-2">
                      <span className="text-slate-600 dark:text-zinc-400 text-[10px] uppercase tracking-wider font-semibold">
                        Claimable Relief
                      </span>
                      <span className="text-2xl font-black text-slate-950 dark:text-white mt-0.5 font-mono tabular-nums">
                        <AnimatedNumber value={taxReliefSummary.totalClaimable} decimals={0} animateOnMount />
                      </span>
                      <span className="text-emerald-800 dark:text-emerald-400 text-[11px] mt-0.5 font-bold font-mono tabular-nums">
                        <AnimatedNumber value={taxReliefSummary.estimatedTaxSaved} prefix="Saves ~RM " suffix=" tax" decimals={0} animateOnMount />
                      </span>
                    </div>
                  </div>

                  <div className="mt-4 flex items-center justify-center gap-5 text-xs text-slate-600 dark:text-zinc-400 border-t border-slate-200 dark:border-white/[0.06] pt-4">
                    <div>
                      <span>Total Spent: </span>
                      <strong className="text-slate-950 dark:text-white font-mono tabular-nums">
                        <AnimatedNumber value={taxReliefSummary.totalEligibleSpent} animateOnMount />
                      </strong>
                    </div>
                    <div className="w-px h-4 bg-slate-100 dark:bg-zinc-800" />
                    <div>
                      <span>Active Reliefs: </span>
                      <strong className="text-emerald-800 dark:text-emerald-400 font-mono tabular-nums">
                        {taxReliefSummary.categories.filter((c) => c.totalSpent > 0).length} / {LHDN_TAX_CATEGORIES.length}
                      </strong>
                    </div>
                  </div>
                </motion.div>

                {/* Card 2: LHDN Receipt Readiness & Missing Receipt Alert Card */}
                <motion.div
                  whileHover={{ y: -4, scale: 1.01 }}
                  transition={{ type: 'spring' as const, stiffness: 400, damping: 25 }}
                  className={`rounded-3xl border p-6 backdrop-blur-xl shadow-xl transition-colors flex flex-col justify-between space-y-4 specular-card ${
                    taxReliefSummary.missingReceiptCount > 0
                      ? 'border-amber-500/30 bg-gradient-to-br from-amber-950/25 via-slate-100 dark:via-zinc-900/50 to-white dark:to-zinc-950 hover:border-amber-500/50'
                      : 'border-emerald-500/25 bg-gradient-to-br from-emerald-950/25 via-slate-100 dark:via-zinc-900/50 to-white dark:to-zinc-950 hover:border-emerald-500/40'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className={`p-2 rounded-xl border ${
                        taxReliefSummary.missingReceiptCount > 0
                          ? 'bg-amber-500/15 text-amber-800 dark:text-amber-400 border-amber-500/30'
                          : 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-400 border-emerald-500/30'
                      }`}>
                        {taxReliefSummary.missingReceiptCount > 0 ? (
                          <AlertTriangle className="h-5 w-5" />
                        ) : (
                          <Sparkles className="h-5 w-5" />
                        )}
                      </div>
                      <div>
                        <span className="text-xs font-bold text-slate-950 dark:text-white uppercase tracking-wider block">
                          LHDN Receipt Audit Vault
                        </span>
                        <span className="text-[11px] text-slate-600 dark:text-zinc-400">
                          LHDN requires keeping tax receipts for 7 years
                        </span>
                      </div>
                    </div>

                    <span className={`text-[11px] font-bold px-2.5 py-0.5 rounded-full uppercase tracking-wider ${
                      taxReliefSummary.missingReceiptCount > 0
                        ? 'bg-amber-500/15 text-amber-800 dark:text-amber-300 border border-amber-500/30'
                        : 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border border-emerald-500/30'
                    }`}>
                      {taxReliefSummary.missingReceiptCount > 0
                        ? `${taxReliefSummary.missingReceiptCount} Missing`
                        : 'Audit Ready'}
                    </span>
                  </div>

                  {/* Receipt Readiness Counter */}
                  <div className="py-1">
                    <span className="text-[11px] text-slate-600 dark:text-zinc-400 font-semibold uppercase tracking-wider block">
                      Receipts Safely Stored in Google Drive
                    </span>
                    <div className={`text-3xl sm:text-4xl font-black font-mono tracking-tight mt-1 ${
                      taxReliefSummary.missingReceiptCount > 0 ? 'text-amber-800 dark:text-amber-400' : 'text-emerald-800 dark:text-emerald-400'
                    }`}>
                      {taxReliefSummary.attachedReceiptCount} / {taxReliefSummary.totalTaxTransactions}
                      <span className="text-xs font-normal text-slate-600 dark:text-zinc-400 ml-1.5">receipts saved</span>
                    </div>

                    {taxReliefSummary.missingReceiptCount > 0 ? (
                      <div className="mt-2.5 space-y-1.5">
                        <p className="text-xs text-amber-800/90 dark:text-amber-200/90 font-medium">
                          ⚠️ You have {taxReliefSummary.missingReceiptCount} tax-deductible purchase(s) without a receipt attached. Attach them now so you never lose your tax claim:
                        </p>
                        <div className="max-h-28 overflow-y-auto space-y-1.5 pr-1 custom-scrollbar">
                          {taxReliefSummary.categories
                            .flatMap((c) =>
                              c.transactions
                                .filter((tx) => !tx.receiptUrl)
                                .map((tx) => ({ tx, cat: c.category }))
                            )
                            .slice(0, 4)
                            .map(({ tx, cat }) => (
                              <div
                                key={tx.id}
                                className="flex items-center justify-between gap-2 p-2 rounded-xl bg-white/90 dark:bg-zinc-900/80 border border-amber-500/25 text-xs"
                              >
                                <div className="min-w-0">
                                  <p className="font-semibold text-slate-950 dark:text-white truncate">
                                    {cat.icon} {tx.description || tx.category}
                                  </p>
                                  <p className="text-[10px] text-slate-600 dark:text-zinc-400 font-mono">
                                    {tx.date} • RM {tx.amount.toFixed(2)}
                                  </p>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => handleAttachToSpecificTx(tx.id)}
                                  className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-800 dark:text-amber-200 border border-amber-500/40 text-[11px] font-bold transition-colors cursor-pointer"
                                >
                                  <Paperclip className="h-3 w-3" />
                                  <span>Attach</span>
                                </button>
                              </div>
                            ))}
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs text-slate-700 dark:text-zinc-300 mt-2 leading-relaxed">
                        {taxReliefSummary.totalTaxTransactions === 0
                          ? `When you record a payment (like books, phone, clinic, gym, internet, or SSPN), Kinova automatically alerts you if it qualifies for LHDN tax relief and reminds you to attach the receipt.`
                          : `🎉 Every tax-deductible purchase in YA ${selectedTaxYear} has its receipt attached in Google Drive! You can view or download all of them anytime during April e-Filing.`}
                      </p>
                    )}
                  </div>

                  <div className="pt-3 border-t border-slate-200 dark:border-zinc-800/80 flex flex-wrap items-center justify-between gap-2 text-xs">
                    <button
                      type="button"
                      onClick={() => {
                        setVaultFilter('tax');
                        setActiveTab('vault');
                      }}
                      className="text-indigo-800 dark:text-indigo-300 hover:text-indigo-800 dark:hover:text-indigo-200 font-semibold cursor-pointer underline underline-offset-2"
                    >
                      View All Tax Receipts in Vault →
                    </button>
                    <button
                      type="button"
                      onClick={() => handleOpenRangeDownload(`${selectedTaxYear}-01-01`, `${selectedTaxYear}-12-31`, true)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-800 dark:text-emerald-300 border border-emerald-500/30 font-bold text-[11px] transition-colors cursor-pointer"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>Download YA {selectedTaxYear} Tax Receipts</span>
                    </button>
                  </div>
                </motion.div>
              </div>

              {/* Official Malaysia LHDN e-Filing (Form BE) Income, PCB & Refund/Extra Tax Estimator Card */}
              <div className="rounded-3xl border border-slate-200 dark:border-white/[0.08] bg-card/60 p-5 sm:p-6 backdrop-blur-2xl shadow-xl space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-xs sm:text-sm font-extrabold text-slate-950 dark:text-white uppercase tracking-wider flex items-center gap-2">
                      <span>🇲🇾 LHDN e-Filing Tax &amp; PCB Refund Estimator (Form BE — YA {selectedTaxYear})</span>
                    </h3>
                    <p className="text-[11px] text-slate-600 dark:text-zinc-400 mt-0.5">
                      Estimates your Form BE settlement using Annual Income, RM 9,000 Self Relief, Tracked &amp; Custom Reliefs, Rebates (RM 400 / Zakat / Spouse), and PCB Paid
                    </p>
                  </div>

                  {/* Settlement Status Badge */}
                  <span className={`text-xs font-extrabold px-3 py-1 rounded-full font-mono ${
                    taxReliefSummary.settlementStatus === 'refund'
                      ? 'bg-emerald-500/20 text-emerald-800 dark:text-emerald-300 border border-emerald-500/40'
                      : taxReliefSummary.settlementStatus === 'pay_extra'
                      ? 'bg-rose-500/20 text-rose-800 dark:text-rose-300 border border-rose-500/40'
                      : 'bg-indigo-500/20 text-indigo-800 dark:text-indigo-300 border border-indigo-500/40'
                  }`}>
                    {taxReliefSummary.settlementStatus === 'refund'
                      ? `🎉 Est. Tax Refund: +RM ${taxReliefSummary.refundAmount.toFixed(2)}`
                      : taxReliefSummary.settlementStatus === 'pay_extra'
                      ? `⚠️ Est. Extra Tax: RM ${taxReliefSummary.extraTaxToPay.toFixed(2)}`
                      : `✅ Est. RM 0.00 Extra Tax`}
                  </span>
                </div>

                {/* 4-Step Form BE Breakdown Grid (Identical sub-card styling to BudgetPage) */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  {/* Step 1: Annual Taxable Income */}
                  <div className="rounded-2xl border border-slate-200 dark:border-zinc-800/80 bg-white/90 dark:bg-zinc-900/50 p-3.5 flex flex-col justify-between space-y-2">
                    <div>
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-600 dark:text-zinc-400">
                          1. Annual Income
                        </span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-zinc-300 font-mono">
                          {taxReliefSummary.isIncomeOverridden ? 'Manual' : 'Auto'}
                        </span>
                      </div>

                      {!isEditingAnnualIncome ? (
                        <div className="mt-1 flex items-center justify-between gap-1">
                          <span className="text-lg font-black text-slate-950 dark:text-white font-mono tabular-nums">
                            RM {taxReliefSummary.annualTaxableIncome.toFixed(2)}
                          </span>
                          <div className="flex items-center gap-1">
                            {taxReliefSummary.isIncomeOverridden && (
                              <button
                                type="button"
                                onClick={handleResetAnnualIncome}
                                className="px-1.5 py-0.5 rounded text-[10px] bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-700 dark:text-zinc-300 cursor-pointer"
                                title="Reset to auto-summed Income transactions"
                              >
                                Auto
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                setAnnualIncomeInput(String(taxReliefSummary.annualTaxableIncome));
                                setIsEditingAnnualIncome(true);
                              }}
                              className="p-1.5 rounded-lg text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer transition-colors"
                              title="Set or override Annual Gross Taxable Income (Pendapatan Tahunan)"
                            >
                              <Edit2 className="h-3.5 w-3.5 text-indigo-800 dark:text-indigo-400" />
                            </button>
                          </div>
                        </div>
                      ) : (
                        <form onSubmit={handleSaveAnnualIncome} className="mt-1.5 flex items-center gap-1">
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            placeholder="Annual RM"
                            value={annualIncomeInput}
                            onChange={(e) => setAnnualIncomeInput(e.target.value)}
                            className="w-full rounded-lg border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-2 py-1 text-xs text-slate-950 dark:text-white font-mono outline-none focus:border-indigo-500"
                          />
                          <button type="submit" className="p-1 rounded-lg bg-emerald-500 text-white dark:text-white cursor-pointer">
                            <Check className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setIsEditingAnnualIncome(false)}
                            className="p-1 rounded-lg bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400 cursor-pointer"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </form>
                      )}
                    </div>

                    <p className="text-[10px] text-slate-600 dark:text-zinc-400 leading-relaxed">
                      {taxReliefSummary.isIncomeOverridden
                        ? `Manual annual income (Recorded in app: RM ${taxReliefSummary.recordedTaxableIncome.toFixed(0)} across ${taxReliefSummary.incomeTransactionCount} record(s))`
                        : `Auto-summed from ${taxReliefSummary.incomeTransactionCount} Salary/Income record(s) in ${selectedTaxYear}. Tap ✏️ to enter full year EA Form income.`}
                    </p>
                  </div>

                  {/* Step 2: Total Tax Reliefs (RM 9,000 Base + Claimable Reliefs + Payslip EPF/SOCSO + Other Reliefs) */}
                  <div className="rounded-2xl border border-slate-200 dark:border-zinc-800/80 bg-white/90 dark:bg-zinc-900/50 p-3.5 flex flex-col justify-between space-y-2">
                    <div>
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-600 dark:text-zinc-400">
                          2. Total Tax Reliefs
                        </span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 font-mono">
                          Deducted
                        </span>
                      </div>
                      <div className="mt-1 text-lg font-black text-emerald-800 dark:text-emerald-400 font-mono tabular-nums">
                        - RM {(taxReliefSummary.individualBaseRelief + taxReliefSummary.totalClaimableRelief + taxReliefSummary.additionalReliefs).toFixed(2)}
                      </div>
                    </div>

                    <div className="space-y-1 text-[10px] text-slate-600 dark:text-zinc-400">
                      <div className="flex justify-between">
                        <span>Auto Self Relief:</span>
                        <strong className="text-slate-800 dark:text-zinc-200 font-mono">RM {taxReliefSummary.individualBaseRelief.toFixed(0)}</strong>
                      </div>
                      <div className="flex justify-between">
                        <span>Tracked Category Reliefs:</span>
                        <strong className="text-emerald-800 dark:text-emerald-300 font-mono">RM {taxReliefSummary.totalClaimableRelief.toFixed(0)}</strong>
                      </div>
                      {/* Payslip EPF inline editor (capped at RM 4,000 sub-limit inside epf_life) */}
                      {!isEditingPayslipEpf ? (
                        <div className="flex items-center justify-between pt-0.5 border-t border-slate-200 dark:border-zinc-800/80">
                          <span>Payslip EPF (max 4k):</span>
                          <span className="inline-flex items-center gap-1 font-mono text-slate-700 dark:text-zinc-300">
                            RM {taxReliefSummary.effectivePayslipEpf.toFixed(0)}
                            {taxProfile.epfFromSalaryOverride != null && (
                              <button
                                type="button"
                                onClick={handleResetPayslipEpf}
                                className="px-1 rounded bg-slate-100 dark:bg-zinc-800 text-[9px] text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white cursor-pointer"
                              >
                                Auto
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                setPayslipEpfInput(String(taxReliefSummary.effectivePayslipEpf));
                                setIsEditingPayslipEpf(true);
                              }}
                              className="text-indigo-800 dark:text-indigo-400 hover:text-slate-950 dark:hover:text-white cursor-pointer"
                              title="Enter total mandatory EPF deducted on your payslips for the year (capped at RM 4,000 sub-limit; auto-deduplicated against standalone EPF records)"
                            >
                              <Edit2 className="h-3 w-3" />
                            </button>
                          </span>
                        </div>
                      ) : (
                        <form onSubmit={handleSavePayslipEpf} className="flex items-center gap-1 pt-1">
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            placeholder="Yearly EPF RM"
                            value={payslipEpfInput}
                            onChange={(e) => setPayslipEpfInput(e.target.value)}
                            className="w-full rounded border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-1.5 py-0.5 text-[10px] text-slate-950 dark:text-white font-mono outline-none"
                          />
                          <button type="submit" className="p-0.5 rounded bg-emerald-500 text-white dark:text-white cursor-pointer">
                            <Check className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setIsEditingPayslipEpf(false)}
                            className="p-0.5 rounded bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400 cursor-pointer"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </form>
                      )}

                      {/* Payslip SOCSO inline editor (capped at RM 350 limit inside socso_eis) */}
                      {!isEditingPayslipSocso ? (
                        <div className="flex items-center justify-between">
                          <span>Payslip SOCSO (max 350):</span>
                          <span className="inline-flex items-center gap-1 font-mono text-slate-700 dark:text-zinc-300">
                            RM {taxReliefSummary.effectivePayslipSocso.toFixed(0)}
                            {taxProfile.socsoFromSalaryOverride != null && (
                              <button
                                type="button"
                                onClick={handleResetPayslipSocso}
                                className="px-1 rounded bg-slate-100 dark:bg-zinc-800 text-[9px] text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white cursor-pointer"
                              >
                                Auto
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                setPayslipSocsoInput(String(taxReliefSummary.effectivePayslipSocso));
                                setIsEditingPayslipSocso(true);
                              }}
                              className="text-indigo-800 dark:text-indigo-400 hover:text-slate-950 dark:hover:text-white cursor-pointer"
                              title="Enter total SOCSO & EIS (PERKESO) deducted on your payslips for the year (capped at RM 350; auto-deduplicated against standalone SOCSO records)"
                            >
                              <Edit2 className="h-3 w-3" />
                            </button>
                          </span>
                        </div>
                      ) : (
                        <form onSubmit={handleSavePayslipSocso} className="flex items-center gap-1 pt-0.5">
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            placeholder="Yearly SOCSO RM"
                            value={payslipSocsoInput}
                            onChange={(e) => setPayslipSocsoInput(e.target.value)}
                            className="w-full rounded border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-1.5 py-0.5 text-[10px] text-slate-950 dark:text-white font-mono outline-none"
                          />
                          <button type="submit" className="p-0.5 rounded bg-emerald-500 text-white dark:text-white cursor-pointer">
                            <Check className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setIsEditingPayslipSocso(false)}
                            className="p-0.5 rounded bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400 cursor-pointer"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </form>
                      )}

                      {/* Other Form BE Reliefs inline editor (Spouse RM 4k, Child RM 2k/8k, Donations) */}
                      {!isEditingOtherReliefs ? (
                        <div className="flex items-center justify-between">
                          <span>Other Reliefs (Spouse/Child):</span>
                          <span className="inline-flex items-center gap-1 font-mono text-slate-700 dark:text-zinc-300">
                            RM {taxReliefSummary.additionalReliefs.toFixed(0)}
                            {taxProfile.additionalReliefsOverride != null && taxProfile.additionalReliefsOverride > 0 && (
                              <button
                                type="button"
                                onClick={handleResetOtherReliefs}
                                className="px-1 rounded bg-slate-100 dark:bg-zinc-800 text-[9px] text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white cursor-pointer"
                              >
                                Clear
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                setOtherReliefsInput(String(taxReliefSummary.additionalReliefs));
                                setIsEditingOtherReliefs(true);
                              }}
                              className="text-indigo-800 dark:text-indigo-400 hover:text-slate-950 dark:hover:text-white cursor-pointer"
                              title="Add other Form BE reliefs such as Spouse Relief (RM 4,000), Child Relief (RM 2,000–8,000), Disabled Relief, or Approved Donations"
                            >
                              <Edit2 className="h-3 w-3" />
                            </button>
                          </span>
                        </div>
                      ) : (
                        <form onSubmit={handleSaveOtherReliefs} className="flex items-center gap-1 pt-0.5">
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            placeholder="Spouse/Child RM"
                            value={otherReliefsInput}
                            onChange={(e) => setOtherReliefsInput(e.target.value)}
                            className="w-full rounded border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-1.5 py-0.5 text-[10px] text-slate-950 dark:text-white font-mono outline-none"
                          />
                          <button type="submit" className="p-0.5 rounded bg-emerald-500 text-white dark:text-white cursor-pointer">
                            <Check className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setIsEditingOtherReliefs(false)}
                            className="p-0.5 rounded bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400 cursor-pointer"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </form>
                      )}
                    </div>
                  </div>

                  {/* Step 3: Chargeable Income & Estimated LHDN Tax Payable */}
                  <div className="rounded-2xl border border-slate-200 dark:border-zinc-800/80 bg-white/90 dark:bg-zinc-900/50 p-3.5 flex flex-col justify-between space-y-2">
                    <div>
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-600 dark:text-zinc-400">
                          3. Estimated LHDN Tax
                        </span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-800 dark:text-indigo-300 font-mono">
                          {taxReliefSummary.effectiveMarginalTaxRate}% Bracket
                        </span>
                      </div>
                      <div className="mt-1 text-lg font-black text-slate-950 dark:text-white font-mono tabular-nums">
                        RM {taxReliefSummary.actualTaxPayable.toFixed(2)}
                      </div>
                    </div>

                    <div className="space-y-1 text-[10px] text-slate-600 dark:text-zinc-400 leading-relaxed">
                      <div className="flex justify-between">
                        <span>Chargeable Income:</span>
                        <strong className="text-slate-800 dark:text-zinc-200 font-mono">RM {taxReliefSummary.chargeableIncome.toFixed(0)}</strong>
                      </div>
                      {taxReliefSummary.statutoryRebate > 0 && (
                        <div className="text-emerald-800 dark:text-emerald-400 font-medium">
                          Includes RM 400 Self Rebate (≤ RM 35k)
                        </div>
                      )}
                      {/* Zakat / Fitrah / Spouse Rebate inline editor */}
                      {!isEditingOtherRebates ? (
                        <div className="flex items-center justify-between pt-0.5 border-t border-slate-200 dark:border-zinc-800/80">
                          <span>Zakat / Other Rebates:</span>
                          <span className="inline-flex items-center gap-1 font-mono text-slate-700 dark:text-zinc-300">
                            RM {taxReliefSummary.additionalRebates.toFixed(0)}
                            {taxProfile.additionalRebatesOverride != null && (
                              <button
                                type="button"
                                onClick={handleResetOtherRebates}
                                className="px-1 rounded bg-slate-100 dark:bg-zinc-800 text-[9px] text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white cursor-pointer"
                              >
                                Auto
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                setOtherRebatesInput(String(taxReliefSummary.additionalRebates));
                                setIsEditingOtherRebates(true);
                              }}
                              className="text-indigo-800 dark:text-indigo-400 hover:text-slate-950 dark:hover:text-white cursor-pointer"
                              title="Enter Zakat / Fitrah paid or Spouse Tax Rebate (RM 400 when chargeable income ≤ RM 35,000). Deducted 1-for-1 directly from LHDN tax!"
                            >
                              <Edit2 className="h-3 w-3" />
                            </button>
                          </span>
                        </div>
                      ) : (
                        <form onSubmit={handleSaveOtherRebates} className="flex items-center gap-1 pt-0.5">
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            placeholder="Zakat/Rebate RM"
                            value={otherRebatesInput}
                            onChange={(e) => setOtherRebatesInput(e.target.value)}
                            className="w-full rounded border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-1.5 py-0.5 text-[10px] text-slate-950 dark:text-white font-mono outline-none"
                          />
                          <button type="submit" className="p-0.5 rounded bg-emerald-500 text-white dark:text-white cursor-pointer">
                            <Check className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setIsEditingOtherRebates(false)}
                            className="p-0.5 rounded bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400 cursor-pointer"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </form>
                      )}
                      {taxReliefSummary.annualTaxableIncome > 0 && (
                        <div className="text-emerald-800 dark:text-emerald-300 font-semibold pt-0.5">
                          ✨ Reliefs &amp; rebates cut tax from RM {taxReliefSummary.taxWithoutReliefs.toFixed(0)} → RM {taxReliefSummary.actualTaxPayable.toFixed(0)} (Saved RM {taxReliefSummary.estimatedTaxSaved.toFixed(2)})
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Step 4: PCB Already Paid (Potongan Cukai Bulanan) */}
                  <div className="rounded-2xl border border-slate-200 dark:border-zinc-800/80 bg-white/90 dark:bg-zinc-900/50 p-3.5 flex flex-col justify-between space-y-2">
                    <div>
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-600 dark:text-zinc-400">
                          4. PCB Already Paid
                        </span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-zinc-300 font-mono">
                          {taxReliefSummary.isPcbOverridden ? 'Manual' : 'Auto'}
                        </span>
                      </div>

                      {!isEditingPcbPaid ? (
                        <div className="mt-1 flex items-center justify-between gap-1">
                          <span className="text-lg font-black text-indigo-800 dark:text-indigo-300 font-mono tabular-nums">
                            RM {taxReliefSummary.totalPcbPaid.toFixed(2)}
                          </span>
                          <div className="flex items-center gap-1">
                            {taxReliefSummary.isPcbOverridden && (
                              <button
                                type="button"
                                onClick={handleResetPcbPaid}
                                className="px-1.5 py-0.5 rounded text-[10px] bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-700 dark:text-zinc-300 cursor-pointer"
                                title="Reset to auto-summed PCB"
                              >
                                Auto
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                setPcbPaidInput(String(taxReliefSummary.totalPcbPaid));
                                setIsEditingPcbPaid(true);
                              }}
                              className="p-1.5 rounded-lg text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer transition-colors"
                              title="Enter total PCB / MTD already deducted from your salary in this year"
                            >
                              <Edit2 className="h-3.5 w-3.5 text-indigo-800 dark:text-indigo-400" />
                            </button>
                          </div>
                        </div>
                      ) : (
                        <form onSubmit={handleSavePcbPaid} className="mt-1.5 flex items-center gap-1">
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            placeholder="Total PCB RM"
                            value={pcbPaidInput}
                            onChange={(e) => setPcbPaidInput(e.target.value)}
                            className="w-full rounded-lg border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-2 py-1 text-xs text-slate-950 dark:text-white font-mono outline-none focus:border-indigo-500"
                          />
                          <button type="submit" className="p-1 rounded-lg bg-emerald-500 text-white dark:text-white cursor-pointer">
                            <Check className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setIsEditingPcbPaid(false)}
                            className="p-1 rounded-lg bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400 cursor-pointer"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </form>
                      )}
                    </div>

                    <p className="text-[10px] text-slate-600 dark:text-zinc-400 leading-relaxed">
                      {taxReliefSummary.isPcbOverridden
                        ? `Manual PCB paid (Auto-tracked from records: RM ${taxReliefSummary.recordedPcbPaid.toFixed(2)})`
                        : `Auto-tracked from Salary [PCB] tags & PCB expenses. Tap ✏️ to enter total PCB from your payslip/EA Form.`}
                    </p>
                  </div>
                </div>

                {/* Final Net Tax Settlement Banner (Estimated Refund vs Estimated Extra Tax to Pay) */}
                <div className={`rounded-2xl border p-3.5 flex flex-wrap items-center justify-between gap-3 ${
                  taxReliefSummary.settlementStatus === 'refund'
                    ? 'border-emerald-500/35 bg-emerald-950/20'
                    : taxReliefSummary.settlementStatus === 'pay_extra'
                    ? 'border-rose-500/35 bg-rose-950/20'
                    : 'border-indigo-500/25 bg-indigo-950/15'
                }`}>
                  <div className="space-y-0.5 flex-1 min-w-[240px]">
                    <div className="text-xs font-extrabold text-slate-950 dark:text-white">
                      {taxReliefSummary.settlementStatus === 'refund' ? (
                        <span className="text-emerald-800 dark:text-emerald-300">
                          🎉 Estimated Tax Refund You Can Claim Back from LHDN: +RM {taxReliefSummary.refundAmount.toFixed(2)}
                        </span>
                      ) : taxReliefSummary.settlementStatus === 'pay_extra' ? (
                        <span className="text-rose-800 dark:text-rose-300">
                          ⚠️ Estimated Extra Tax to Pay LHDN: RM {taxReliefSummary.extraTaxToPay.toFixed(2)}
                        </span>
                      ) : taxReliefSummary.annualTaxableIncome === 0 ? (
                        <span className="text-indigo-800 dark:text-indigo-200">
                          💡 Tap ✏️ on &quot;1. Annual Income&quot; and &quot;4. PCB Already Paid&quot; above (or record Salary) to estimate your Refund or Extra Tax!
                        </span>
                      ) : (
                        <span className="text-emerald-800 dark:text-emerald-300">
                          ✅ Estimated RM 0.00 Extra Tax to Pay — Your LHDN tax is covered!
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-slate-700 dark:text-zinc-300 leading-relaxed">
                      {taxReliefSummary.settlementStatus === 'refund'
                        ? `Based on RM ${taxReliefSummary.totalPcbPaid.toFixed(2)} PCB paid minus your estimated Form BE tax of RM ${taxReliefSummary.actualTaxPayable.toFixed(2)} (after RM ${(taxReliefSummary.individualBaseRelief + taxReliefSummary.totalClaimableRelief + taxReliefSummary.additionalReliefs).toFixed(0)} reliefs and RM ${taxReliefSummary.totalTaxRebates.toFixed(0)} rebates), your estimated LHDN tax refund is RM ${taxReliefSummary.refundAmount.toFixed(2)}.`
                        : taxReliefSummary.settlementStatus === 'pay_extra'
                        ? `Your estimated Form BE tax is RM ${taxReliefSummary.actualTaxPayable.toFixed(2)} (${taxReliefSummary.bracketLabel}) minus RM ${taxReliefSummary.totalPcbPaid.toFixed(2)} PCB already paid = RM ${taxReliefSummary.extraTaxToPay.toFixed(2)} estimated balance due. You can also add Spouse/Child reliefs or Zakat rebates using ✏️ above.`
                        : `Estimate formula: Gross Income (RM ${taxReliefSummary.annualTaxableIncome.toFixed(0)}) − Total Reliefs (RM ${(taxReliefSummary.individualBaseRelief + taxReliefSummary.totalClaimableRelief + taxReliefSummary.additionalReliefs).toFixed(0)}) = Chargeable Income (RM ${taxReliefSummary.chargeableIncome.toFixed(0)}) → Estimated Net Tax (RM ${taxReliefSummary.actualTaxPayable.toFixed(2)}).`}
                    </p>
                  </div>
                </div>
              </div>

              {/* Category Relief Breakdown & Limits (Exact same card + progress bar UI as BudgetPage) */}
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-xs uppercase font-semibold text-slate-600 dark:text-zinc-400 tracking-wider">
                      Malaysia LHDN Tax Relief Categories & Annual Limits (YA {selectedTaxYear})
                    </h3>
                    <p className="text-[11px] text-slate-500 dark:text-zinc-400 mt-0.5">
                      Tap any category to see what qualifies, what is excluded, and view/attach receipts
                    </p>
                  </div>

                  {/* Filter pills */}
                  <div className="flex items-center gap-1.5 p-1 rounded-xl bg-white/90 dark:bg-zinc-900/90 border border-slate-200 dark:border-white/[0.06]">
                    {([
                      { id: 'all', label: `All (${LHDN_TAX_CATEGORIES.length})` },
                      { id: 'claimed', label: `Claimed (${taxReliefSummary.categories.filter(c => c.totalSpent > 0).length})` },
                      { id: 'missing', label: `Missing Receipt (${taxReliefSummary.categories.filter(c => c.missingReceiptCount > 0).length})` },
                    ] as const).map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => setTaxViewFilter(f.id)}
                        className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors cursor-pointer ${
                          taxViewFilter === f.id
                            ? 'bg-indigo-500/20 text-indigo-800 dark:text-indigo-300 border border-indigo-500/30'
                            : 'text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white'
                        }`}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                </div>

                {displayedTaxCategories.length === 0 ? (
                  <div className="text-center py-10 rounded-2xl border border-slate-200 dark:border-zinc-800/80 bg-white/90 dark:bg-zinc-900/20">
                    <p className="text-xs text-slate-600 dark:text-zinc-400">No categories match the current filter.</p>
                    <button
                      type="button"
                      onClick={() => setTaxViewFilter('all')}
                      className="mt-2 text-xs text-indigo-800 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 font-semibold underline cursor-pointer"
                    >
                      Show all 10 Malaysia LHDN categories
                    </button>
                  </div>
                ) : (
                  displayedTaxCategories.map((item) => {
                    const { category: cat, limit: cap, totalSpent, remainingLimit, percentUsed, isMaxedOut, transactions: catTxs, attachedReceiptCount, missingReceiptCount } = item;
                    const isEditingThis = editingTaxCategory === cat.id;
                    const isExpanded = expandedTaxCatId === cat.id;

                    return (
                      <div
                        key={cat.id}
                        className={`rounded-2xl border p-4 space-y-2.5 transition-all ${
                          missingReceiptCount > 0
                            ? 'border-amber-500/35 bg-amber-950/15'
                            : isMaxedOut
                            ? 'border-indigo-500/35 bg-indigo-950/15'
                            : totalSpent > 0
                            ? 'border-emerald-500/30 bg-emerald-950/10'
                            : 'border-slate-200 dark:border-zinc-800/80 bg-white/90 dark:bg-zinc-900/40'
                        }`}
                      >
                        {/* Top Row: Category Title, Badges & Cap Editor */}
                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                          <div
                            onClick={() => setExpandedTaxCatId(isExpanded ? null : cat.id)}
                            className="flex flex-wrap items-center gap-2 cursor-pointer select-none"
                          >
                            <span className="text-base">{cat.icon}</span>
                            <span className="font-bold text-slate-950 dark:text-white text-sm">{cat.name}</span>
                            <span className="text-[10px] text-slate-600 dark:text-zinc-400 font-medium hidden sm:inline">
                              ({cat.malayName})
                            </span>
                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                              isMaxedOut
                                ? 'bg-indigo-500/20 text-indigo-800 dark:text-indigo-300'
                                : percentUsed > 70
                                ? 'bg-amber-500/20 text-amber-800 dark:text-amber-300'
                                : totalSpent > 0
                                ? 'bg-emerald-500/20 text-emerald-800 dark:text-emerald-300'
                                : 'bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400'
                            }`}>
                              {percentUsed.toFixed(0)}%
                            </span>
                            {missingReceiptCount > 0 && (
                              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-800 dark:text-amber-300 border border-amber-500/30">
                                ⚠️ {missingReceiptCount} Missing Receipt
                              </span>
                            )}
                          </div>

                          <div className="flex items-center gap-2">
                            {!isEditingThis ? (
                              <div className="flex items-center gap-2 text-slate-600 dark:text-zinc-400">
                                <span className="font-mono">
                                  <strong className="text-slate-950 dark:text-white font-bold">RM {totalSpent.toFixed(2)}</strong> / Cap: RM {cap.toFixed(0)}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingTaxCategory(cat.id);
                                    setTaxCapInput(String(cap));
                                  }}
                                  className="p-1 rounded-lg text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer transition-colors"
                                  title="Edit LHDN annual cap for this category"
                                >
                                  <Edit2 className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            ) : (
                              <div className="flex items-center gap-1.5">
                                <span className="text-[11px] text-slate-600 dark:text-zinc-400">Cap: RM</span>
                                <input
                                  type="number"
                                  value={taxCapInput}
                                  onChange={(e) => setTaxCapInput(e.target.value)}
                                  className="w-20 rounded-lg border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-2 py-1 text-xs text-slate-950 dark:text-white font-mono outline-none focus:border-indigo-500"
                                />
                                <button
                                  type="button"
                                  onClick={() => handleSaveTaxCap(cat.id)}
                                  className="p-1 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white dark:text-white cursor-pointer"
                                >
                                  <Check className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditingTaxCategory(null)}
                                  className="p-1 rounded-lg bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-600 dark:text-zinc-400 cursor-pointer"
                                >
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Progress Bar (Identical to BudgetPage) */}
                        <div
                          onClick={() => setExpandedTaxCatId(isExpanded ? null : cat.id)}
                          className="h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-zinc-800 cursor-pointer"
                        >
                          <div
                            className={`h-full rounded-full transition-all duration-500 ${
                              isMaxedOut
                                ? 'bg-indigo-500'
                                : percentUsed > 75
                                ? 'bg-amber-400'
                                : 'bg-emerald-500'
                            }`}
                            style={{ width: `${Math.min(percentUsed, 100)}%` }}
                          />
                        </div>

                        {/* Bottom Info Row + Expand Toggle */}
                        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-600 dark:text-zinc-400 pt-0.5">
                          <div>
                            {isMaxedOut ? (
                              <span className="text-indigo-800 dark:text-indigo-300 font-semibold">
                                Max RM {cap.toFixed(0)} relief reached! (Spent RM {totalSpent.toFixed(2)})
                              </span>
                            ) : (
                              <span>
                                Remaining Relief Quota:{' '}
                                <strong className="text-emerald-800 dark:text-emerald-400 font-mono">RM {remainingLimit.toFixed(2)}</strong>
                              </span>
                            )}
                          </div>

                          <div className="flex items-center gap-3">
                            <span className="font-mono text-slate-700 dark:text-zinc-300">
                              {catTxs.length} item(s) •{' '}
                              <strong className={missingReceiptCount > 0 ? 'text-amber-800 dark:text-amber-400' : 'text-emerald-800 dark:text-emerald-400'}>
                                {attachedReceiptCount}/{catTxs.length} receipt(s)
                              </strong>
                            </span>
                            <button
                              type="button"
                              onClick={() => setExpandedTaxCatId(isExpanded ? null : cat.id)}
                              className="inline-flex items-center gap-1 text-indigo-800 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 font-semibold cursor-pointer"
                            >
                              <span>{isExpanded ? 'Hide Details' : 'What Qualifies & Receipts'}</span>
                              {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                            </button>
                          </div>
                        </div>

                        {/* Expandable Guide & Recorded Transactions / Receipts List */}
                        <AnimatePresence>
                          {isExpanded && (
                            <motion.div
                              initial={{ opacity: 0, height: 0 }}
                              animate={{ opacity: 1, height: 'auto' }}
                              exit={{ opacity: 0, height: 0 }}
                              className="overflow-hidden pt-2 border-t border-slate-200 dark:border-white/[0.06] space-y-3"
                            >
                              {/* Plain-Language LHDN Rules Box */}
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs">
                                <div className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 space-y-1">
                                  <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-800 dark:text-emerald-300 block">
                                    ✅ What Qualifies for LHDN Relief
                                  </span>
                                  <p className="text-slate-800 dark:text-zinc-200 text-[11px] leading-relaxed">{cat.qualifies}</p>
                                </div>
                                <div className="p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/20 space-y-1">
                                  <span className="text-[10px] font-bold uppercase tracking-wider text-rose-800 dark:text-rose-300 block">
                                    ❌ Common Items That Do NOT Qualify
                                  </span>
                                  <p className="text-slate-700 dark:text-zinc-300 text-[11px] leading-relaxed">{cat.excludes}</p>
                                </div>
                              </div>

                              {/* Recorded Transactions in this Category */}
                              <div className="space-y-1.5">
                                <span className="text-[10px] uppercase font-bold tracking-wider text-slate-600 dark:text-zinc-400 block">
                                  Recorded Purchases in YA {selectedTaxYear} ({catTxs.length})
                                </span>
                                {catTxs.length === 0 ? (
                                  <p className="text-xs text-slate-500 dark:text-zinc-400 py-2">
                                    No purchases recorded under {cat.shortName} for YA {selectedTaxYear} yet. When you record an eligible purchase, it will appear here automatically.
                                  </p>
                                ) : (
                                  <div className="space-y-1.5">
                                    {catTxs.map((tx) => {
                                      const amtMyr = getAmountInBaseCurrency(tx.amount, tx.currency, tx.baseAmount);
                                      const hasReceipt = Boolean(tx.receiptUrl && tx.receiptUrl.trim().length > 0);
                                      const claimFileName = formatClaimFileName(
                                        tx.date,
                                        `LHDN_${cat.shortName}`,
                                        amtMyr,
                                        tx.description || tx.category
                                      );

                                      return (
                                        <div
                                          key={tx.id}
                                          className="flex flex-wrap items-center justify-between gap-2 p-2.5 rounded-xl bg-white/90 dark:bg-zinc-950/70 border border-slate-200 dark:border-white/[0.06] text-xs"
                                        >
                                          <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-2">
                                              <p className="font-semibold text-slate-950 dark:text-white truncate">
                                                {tx.description || tx.category}
                                              </p>
                                              {hasReceipt ? (
                                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border border-emerald-500/30 text-[10px] font-bold">
                                                  <CheckCircle2 className="h-2.5 w-2.5" /> Receipt Saved
                                                </span>
                                              ) : (
                                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-amber-500/20 text-amber-800 dark:text-amber-300 border border-amber-500/30 text-[10px] font-bold">
                                                  <AlertTriangle className="h-2.5 w-2.5" /> Missing Receipt
                                                </span>
                                              )}
                                            </div>
                                            <p className="text-[10px] text-slate-600 dark:text-zinc-400 font-mono mt-0.5">
                                              {tx.date} • {tx.category} • RM {amtMyr.toFixed(2)}
                                            </p>
                                          </div>

                                          <div className="flex items-center gap-1.5 shrink-0">
                                            {hasReceipt ? (
                                              <>
                                                <button
                                                  type="button"
                                                  onClick={() =>
                                                    setSelectedPreview({
                                                      url: tx.receiptUrl!,
                                                      title: tx.description || tx.category,
                                                      filename: claimFileName,
                                                    })
                                                  }
                                                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-800 dark:text-zinc-200 text-[11px] font-semibold transition-colors cursor-pointer"
                                                >
                                                  <Eye className="h-3 w-3 text-indigo-800 dark:text-indigo-400" />
                                                  <span>View Receipt</span>
                                                </button>
                                                <button
                                                  type="button"
                                                  onClick={() => downloadReceiptFile(tx.receiptUrl!, claimFileName)}
                                                  className="p-1.5 rounded-lg bg-slate-100 dark:bg-zinc-800 hover:bg-indigo-500/20 text-slate-700 dark:text-zinc-300 hover:text-indigo-800 dark:hover:text-indigo-300 transition-colors cursor-pointer"
                                                  title="Download Receipt"
                                                >
                                                  <Download className="h-3.5 w-3.5" />
                                                </button>
                                              </>
                                            ) : (
                                              <button
                                                type="button"
                                                onClick={() => handleAttachToSpecificTx(tx.id)}
                                                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-800 dark:text-amber-200 border border-amber-500/40 text-[11px] font-bold transition-colors cursor-pointer"
                                              >
                                                <Paperclip className="h-3 w-3" />
                                                <span>Attach Receipt Now</span>
                                              </button>
                                            )}
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    );
                  })
                )}
              </div>
            </motion.div>
          ) : activeTab === 'calendar' ? (
            <motion.div
              key="calendar"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.3 }}
            >
              <ClaimsCalendar 
                transactions={transactions} 
                invoices={allInvoices} 
                onOpenRangeDownload={(from, to) => handleOpenRangeDownload(from, to, false)}
              />
            </motion.div>
          ) : (
            <motion.div
              key="vault"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.3 }}
              className="space-y-6"
            >
              {/* Upload Drop Zone Card */}
              <motion.div
                whileHover="hover"
                onClick={() => {
                  if (!isUploading) {
                    setPreselectedAttachTxId(null);
                    fileInputRef.current?.click();
                  }
                }}
                className="group relative flex cursor-pointer flex-col items-center justify-center rounded-3xl border-2 border-dashed border-slate-200 dark:border-zinc-800/60 bg-white/90 dark:bg-zinc-900/30 backdrop-blur-sm py-10 transition-all hover:border-indigo-500/40 hover:bg-indigo-500/5 overflow-hidden"
              >
                {/* Subtle particle/sparkle effect background on hover */}
                <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-700 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-indigo-500/10 via-transparent to-transparent" />
                
                <motion.div 
                  variants={{
                    hover: { y: [0, -6, 0], transition: { duration: 1.5, repeat: Infinity, ease: "easeInOut" } }
                  }}
                  className="mb-4 rounded-2xl bg-slate-100 dark:bg-zinc-800/80 p-4 transition-transform group-hover:scale-110 shadow-lg shadow-black/20 ring-1 ring-white/5"
                >
                  {isUploading ? (
                    <Loader2 className="h-8 w-8 text-indigo-800 dark:text-indigo-400 animate-spin" />
                  ) : (
                    <UploadCloud className="h-8 w-8 text-indigo-800 dark:text-indigo-400" />
                  )}
                </motion.div>
                <h3 className="text-sm font-bold text-slate-950 dark:text-white relative z-10">Tap to upload receipt or invoice</h3>
                <p className="mt-1.5 text-xs text-slate-500 dark:text-zinc-400 relative z-10">
                  Files are automatically named with date and saved to Google Drive
                </p>
              </motion.div>

              {/* Search bar, Tax Filter Pill & Range Download Action */}
              <div className="flex flex-wrap items-center gap-3">
                <div className="relative flex-1 min-w-[220px] group">
                  <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500 dark:text-zinc-400 group-focus-within:text-indigo-800 dark:group-focus-within:text-indigo-400 transition-colors" />
                  <input
                    type="text"
                    placeholder="Search invoices by vendor, date (e.g. 2026-09), or title..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full rounded-2xl border border-slate-200 dark:border-zinc-800/80 bg-white/90 dark:bg-zinc-900/40 backdrop-blur-sm py-2.5 pl-10 pr-4 text-sm text-slate-950 dark:text-white placeholder-zinc-500 outline-none focus:border-indigo-500/50 focus:bg-white/90 dark:focus:bg-zinc-900/80 transition-all shadow-sm"
                  />
                </div>

                {/* All vs Tax Relief Filter */}
                <div className="flex items-center gap-1 p-1 rounded-2xl bg-white/90 dark:bg-zinc-900/80 border border-slate-200 dark:border-zinc-800/80">
                  <button
                    type="button"
                    onClick={() => setVaultFilter('all')}
                    className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-colors cursor-pointer ${
                      vaultFilter === 'all'
                        ? 'bg-slate-100 dark:bg-zinc-800 text-slate-950 dark:text-white'
                        : 'text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white'
                    }`}
                  >
                    All Receipts
                  </button>
                  <button
                    type="button"
                    onClick={() => setVaultFilter('tax')}
                    className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-colors cursor-pointer ${
                      vaultFilter === 'tax'
                        ? 'bg-emerald-500/20 text-emerald-800 dark:text-emerald-300 border border-emerald-500/30'
                        : 'text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white'
                    }`}
                  >
                    🇲🇾 Tax Relief Only
                  </button>
                </div>

                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => handleOpenRangeDownload(undefined, undefined, vaultFilter === 'tax')}
                  className="flex items-center gap-1.5 px-4 py-2.5 rounded-2xl bg-white/90 dark:bg-zinc-900/80 hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-700 dark:text-zinc-300 hover:text-slate-950 dark:hover:text-white border border-slate-200 dark:border-zinc-800/80 backdrop-blur-sm text-xs font-semibold transition-all shadow-sm cursor-pointer"
                >
                  <CalendarIcon className="h-3.5 w-3.5 text-indigo-800 dark:text-indigo-400" />
                  <span>Filter by Date Range</span>
                </motion.button>
              </div>

              {/* Invoices Grid */}
              {filteredInvoices.length === 0 ? (
                <motion.div 
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="flex flex-col items-center justify-center py-16 text-center border border-dashed border-slate-200 dark:border-zinc-800/60 rounded-3xl bg-white/90 dark:bg-zinc-950/40 backdrop-blur-sm"
                >
                  <motion.div 
                    animate={{ y: [0, -10, 0] }}
                    transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
                    className="p-4 rounded-full bg-white/90 dark:bg-zinc-900/80 border border-slate-200 dark:border-zinc-800 text-slate-500 dark:text-zinc-400 mb-4 shadow-xl"
                  >
                    <FileText className="h-7 w-7" />
                  </motion.div>
                  <p className="text-sm font-semibold text-slate-700 dark:text-zinc-300">No receipts found</p>
                  <p className="text-xs text-slate-500 dark:text-zinc-400 mt-1.5 max-w-xs leading-relaxed">
                    Upload a bill above or attach receipts when recording transactions.
                  </p>
                </motion.div>
              ) : (
                <motion.div 
                  variants={gridContainer}
                  initial="hidden"
                  animate="show"
                  className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4"
                >
                  {filteredInvoices.map((inv) => {
                    const invTaxCat =
                      (inv.txId && txTaxReliefMap.get(inv.txId)) ||
                      getTransactionTaxRelief({
                        type: 'expense',
                        description: inv.title,
                        category: inv.vendor,
                        subCategory: '',
                        notes: '',
                      });
                    const claimFileName = formatClaimFileName(
                      inv.date,
                      invTaxCat ? `LHDN_${invTaxCat.shortName}` : inv.title,
                      inv.amount,
                      inv.vendor
                    );

                    return (
                      <motion.div
                        key={inv.id}
                        variants={gridItem}
                        className="group relative overflow-hidden rounded-2xl border border-slate-200 dark:border-zinc-800/60 bg-white/90 dark:bg-zinc-900/30 backdrop-blur-sm hover:border-indigo-500/30 transition-all duration-300 hover:-translate-y-1 hover:shadow-xl hover:shadow-indigo-500/10 hover:bg-white/90 dark:hover:bg-zinc-900/60 flex flex-col"
                      >
                        {/* Thumbnail / Preview Area */}
                        <div 
                          onClick={() => setSelectedPreview({ url: inv.url, title: inv.title, filename: claimFileName })}
                          className="aspect-[4/3] w-full bg-white/90 dark:bg-zinc-950/80 flex items-center justify-center relative cursor-pointer overflow-hidden"
                        >
                          {inv.url.startsWith('data:image') || inv.url.includes('google.com') || inv.url.match(/\.(jpeg|jpg|gif|png|webp)$/i) ? (
                            <img
                              src={inv.url}
                              alt={inv.title}
                              className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500 ease-out"
                              onError={(e) => {
                                (e.target as HTMLElement).style.display = 'none';
                              }}
                            />
                          ) : (
                            <FileText className="h-10 w-10 text-slate-600 dark:text-zinc-300 group-hover:text-indigo-800 dark:group-hover:text-indigo-400 group-hover:scale-110 transition-all duration-500 ease-out" />
                          )}
                          {invTaxCat && (
                            <span className="absolute top-2 left-2 z-10 inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-emerald-950/90 border border-emerald-500/40 text-emerald-800 dark:text-emerald-300 text-[10px] font-bold shadow-md backdrop-blur-sm">
                              🇲🇾 {invTaxCat.shortName}
                            </span>
                          )}
                          
                          <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity duration-300 backdrop-blur-[2px]">
                            <motion.div whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }}>
                              <Eye className="h-7 w-7 text-slate-950 dark:text-white drop-shadow-md" />
                            </motion.div>
                          </div>
                        </div>

                        {/* Info Area */}
                        <div className="p-3.5 flex-1 flex flex-col justify-between relative overflow-hidden">
                          <div className="relative z-10">
                            <p className="font-semibold text-xs text-slate-900 dark:text-zinc-100 truncate group-hover:text-slate-950 dark:group-hover:text-white transition-colors" title={inv.title}>
                              {inv.title}
                            </p>
                            <p className="text-[11px] text-slate-500 dark:text-zinc-400 mt-1 truncate font-medium">{inv.date || 'No Date'}</p>
                          </div>

                          <div className="mt-3 pt-2.5 border-t border-slate-200 dark:border-zinc-800/60 flex items-center justify-between relative z-10">
                            <span className="text-xs font-bold bg-gradient-to-r from-emerald-400 to-emerald-300 bg-clip-text text-transparent">
                              {inv.amount > 0 ? `RM ${inv.amount.toFixed(2)}` : 'Attached'}
                            </span>
                            
                            <div className="flex items-center gap-0.5 translate-y-1 opacity-0 group-hover:translate-y-0 group-hover:opacity-100 transition-all duration-300 ease-out">
                              {/* Download Button */}
                              <button
                                onClick={() => downloadReceiptFile(inv.url, claimFileName)}
                                className="p-1.5 rounded-lg text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white hover:bg-indigo-500/20 hover:text-indigo-800 dark:hover:text-indigo-300 transition-colors cursor-pointer"
                                title="Download for Claim"
                              >
                                <Download className="h-3.5 w-3.5" />
                              </button>

                              {/* Open in Drive Link */}
                              <a
                                href={inv.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="p-1.5 rounded-lg text-slate-500 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
                                title="Open in Drive"
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                              </a>

                              {/* Delete from Google Drive Button */}
                              <button
                                onClick={() => setInvoiceToDelete(inv)}
                                className="p-1.5 rounded-lg text-slate-500 dark:text-zinc-400 hover:text-rose-800 dark:hover:text-rose-400 hover:bg-rose-500/15 transition-colors cursor-pointer"
                                title="Delete file from Google Drive to free storage"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>
                        </div>
                      </motion.div>
                    );
                  })}
                </motion.div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Date Range Download & Drive Storage Cleaner Modal */}
      <DateRangeDownloadModal
        isOpen={isRangeModalOpen}
        onClose={() => setIsRangeModalOpen(false)}
        invoices={modalInvoices}
        initialFrom={rangeModalFrom}
        initialTo={rangeModalTo}
      />

      {/* Attach Receipt to Transaction Modal */}
      <AttachReceiptModal
        isOpen={isAttachModalOpen}
        onClose={() => {
          setIsAttachModalOpen(false);
          setFileToAttach(null);
          setPreselectedAttachTxId(null);
        }}
        file={fileToAttach}
        transactions={transactions}
        initialTransactionId={preselectedAttachTxId}
        onSuccess={() => {
          queryClient.invalidateQueries({ queryKey: ['sheet'] });
          queryClient.invalidateQueries({ queryKey: ['months'] });
          queryClient.invalidateQueries({ queryKey: ['overview'] });
        }}
      />

      {/* Single Invoice Delete Confirmation Modal - portaled to body for iOS scroll fix */}
      {typeof document !== 'undefined' && ReactDOM.createPortal(
        <AnimatePresence>
        {invoiceToDelete && (
          <div className="fixed inset-0 z-[220] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => !isDeletingSingle && setInvoiceToDelete(null)}
              className="fixed inset-0 bg-black/60 backdrop-blur-md"
            />

            <motion.div
              role="dialog"
              aria-modal="true"
              aria-labelledby="invoice-delete-title"
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              transition={{ type: "spring", damping: 28, stiffness: 350 }}
              className="relative max-w-md w-full max-h-[calc(100dvh-1.5rem)] overflow-y-auto overscroll-contain touch-pan-y [-webkit-overflow-scrolling:touch] custom-scrollbar rounded-3xl border border-rose-500/20 bg-white/95 dark:bg-[#090d16]/95 backdrop-blur-3xl p-6 shadow-2xl z-10 space-y-5"
            >
              <div className="flex items-start gap-4">
                <motion.div 
                  animate={{ scale: [1, 1.05, 1], boxShadow: ["0px 0px 0px rgba(244,63,94,0)", "0px 0px 20px rgba(244,63,94,0.2)", "0px 0px 0px rgba(244,63,94,0)"] }}
                  transition={{ duration: 2, repeat: Infinity }}
                  className="h-12 w-12 rounded-2xl bg-rose-500/10 border border-rose-500/30 flex items-center justify-center text-rose-800 dark:text-rose-400 shrink-0"
                >
                  <HardDrive className="h-6 w-6" />
                </motion.div>
                <div className="pt-0.5">
                  <h3 id="invoice-delete-title" className="text-lg font-bold text-slate-950 dark:text-white tracking-tight">
                    Delete from Google Drive?
                  </h3>
                  <p className="text-sm text-rose-800/80 dark:text-rose-300/80 font-medium mt-1">
                    Free up cloud space so your Google Drive won&apos;t get full
                  </p>
                </div>
              </div>

              <div className="p-4 rounded-2xl bg-white/90 dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800/60 text-xs space-y-3 text-slate-700 dark:text-zinc-300 backdrop-blur-sm">
                <div>
                  <span className="text-slate-500 dark:text-zinc-400 block text-[11px] uppercase tracking-wider font-semibold mb-1">Invoice Document</span>
                  <p className="text-sm font-bold text-slate-950 dark:text-white mt-0.5 truncate">{invoiceToDelete.title}</p>
                  <p className="text-slate-600 dark:text-zinc-400 font-mono text-[11px] mt-1">
                    {invoiceToDelete.date} • {invoiceToDelete.amount > 0 ? `RM ${invoiceToDelete.amount.toFixed(2)}` : 'Attached'}
                  </p>
                </div>

                <div className="flex items-start gap-2.5 pt-3 border-t border-slate-200 dark:border-zinc-800/80 text-[11px] text-slate-600 dark:text-zinc-400 leading-relaxed">
                  <ShieldCheck className="h-4 w-4 text-emerald-800 dark:text-emerald-400 shrink-0 mt-0.5" />
                  <span>
                    <strong className="text-slate-700 dark:text-zinc-300">Financial records remain safe:</strong> Your transaction amounts, categories, and analytics are preserved. Only the cloud file copy in Google Drive is trashed.
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 pt-2">
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  type="button"
                  onClick={() => setInvoiceToDelete(null)}
                  disabled={isDeletingSingle}
                  className="w-full py-2.5 rounded-2xl border border-slate-300 dark:border-zinc-700/60 bg-white/90 dark:bg-zinc-900/50 hover:bg-slate-100 dark:hover:bg-zinc-800 hover:border-slate-400 dark:hover:border-zinc-600 text-xs font-bold text-slate-700 dark:text-zinc-300 transition-all cursor-pointer shadow-sm"
                >
                  Keep in Drive
                </motion.button>

                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  type="button"
                  onClick={handleConfirmSingleDelete}
                  disabled={isDeletingSingle}
                  className="relative group w-full flex items-center justify-center gap-2 py-2.5 rounded-2xl bg-rose-600/90 hover:bg-rose-500 disabled:opacity-50 text-xs font-bold text-white dark:text-white shadow-lg shadow-rose-600/20 transition-all cursor-pointer overflow-hidden"
                >
                  <div className="absolute inset-0 bg-gradient-to-r from-rose-400/0 via-white/10 to-rose-400/0 -translate-x-full group-hover:animate-[shimmer_1.5s_infinite]" />
                  {isDeletingSingle ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin relative z-10" />
                      <span className="relative z-10">Deleting...</span>
                    </>
                  ) : (
                    <>
                      <Trash2 className="h-3.5 w-3.5 relative z-10" />
                      <span className="relative z-10">Delete from Drive</span>
                    </>
                  )}
                </motion.button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>,
        document.body
      )}

      {/* Lightbox Preview Modal - portaled to body for iOS scroll fix */}
      {typeof document !== 'undefined' && ReactDOM.createPortal(
        <AnimatePresence>
        {selectedPreview && (
          <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 md:p-8">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={() => setSelectedPreview(null)}
              className="fixed inset-0 bg-black/90 backdrop-blur-xl"
            />

            <motion.div
              role="dialog"
              aria-modal="true"
              aria-label={`Receipt preview: ${selectedPreview.title}`}
              initial={{ scale: 0.85, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, transition: { duration: 0.15 } }}
              transition={{ type: "spring", damping: 28, stiffness: 350 }}
              className="relative max-w-4xl w-full max-h-[calc(100dvh-1.5rem)] flex flex-col rounded-3xl border border-slate-200 dark:border-white/[0.12] bg-white/95 dark:bg-[#090d16]/95 shadow-2xl overflow-y-auto overscroll-contain touch-pan-y [-webkit-overflow-scrolling:touch] custom-scrollbar z-10 backdrop-blur-3xl"
            >
              <div className="flex items-center justify-between p-4 border-b border-slate-200 dark:border-zinc-800/60 bg-white/90 dark:bg-zinc-950/90 backdrop-blur-xl z-20">
                <div className="min-w-0 pr-4">
                  <span className="text-sm font-bold text-slate-950 dark:text-white truncate block">
                    {selectedPreview.title}
                  </span>
                  <span className="text-[11px] font-mono text-slate-600/80 dark:text-zinc-400/80 truncate block mt-0.5">
                    {selectedPreview.filename}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <motion.button
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={() => downloadReceiptFile(selectedPreview.url, selectedPreview.filename)}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-indigo-500 hover:bg-indigo-400 text-white dark:text-white text-xs font-bold transition-colors cursor-pointer shadow-lg shadow-indigo-500/25"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>Download</span>
                  </motion.button>
                  <motion.a
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    href={selectedPreview.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="p-2 rounded-xl text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800/80 hover:border-slate-300 dark:hover:border-zinc-700 transition-all shadow-sm"
                    title="Open in Google Drive"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </motion.a>
                  <motion.button
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={() => setSelectedPreview(null)}
                    className="p-2 rounded-xl text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800/80 hover:border-slate-300 dark:hover:border-zinc-700 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-all shadow-sm ml-1"
                  >
                    <X className="h-4 w-4" />
                  </motion.button>
                </div>
              </div>

              <div className="flex-1 flex items-center justify-center p-2 sm:p-4 bg-white dark:bg-zinc-950 overflow-y-auto overscroll-contain touch-pan-y [-webkit-overflow-scrolling:touch] min-h-0">
                <img
                  src={selectedPreview.url}
                  alt={selectedPreview.title}
                  className="max-h-[calc(100dvh-8rem)] w-auto object-contain rounded-xl drop-shadow-2xl"
                />
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>,
        document.body
      )}
    </div>
  );
}
