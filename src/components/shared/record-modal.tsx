'use client';

import React, { useState, useRef, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  X, Upload, Camera, Check, Calendar, CreditCard, 
  Tag, FileText, ArrowDownRight, ArrowUpRight, TrendingUp, Loader2,
  Plane, ChevronRight, Percent, ShieldCheck, Lock, Landmark, Eye, Sparkles
} from 'lucide-react';
import Link from 'next/link';
import { useAppStore } from '@/stores/app-store';
import {
  addUnifiedRow,
  updateUnifiedRow,
  useSheetData,
  applyOptimisticAddToQueryCache,
  applyOptimisticUpdateToQueryCache,
} from '@/hooks/useSheets';
import { sheetsData } from '@/lib/sheets-data';
import { driveApi } from '@/lib/sheets-api';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { formatClaimFileName } from '@/lib/claim-helper';
import { ACCOUNTING_BASE_CURRENCY, COMMON_CURRENCIES, getAmountInBaseCurrency, getCachedRatesToMyr } from '@/lib/currency';
import { isSafeTransactionAmount, isSafeTransactionConversion } from '@/lib/money-validation';
import { compressImageFile } from '@/lib/image-compressor';
import {
  calculateInstallmentPlan,
  INSTALLMENT_PRESET_MONTHS,
  MAX_INSTALLMENT_MONTHS,
  MIN_INSTALLMENT_MONTHS,
  upsertSavedInstallmentPlan,
} from '@/lib/installment-helper';
import { getLocalDateString, parseLocalDate, normalizeDateString, shiftMonthSafe } from '@/lib/date-helper';
import { useLockBodyScroll } from '@/hooks/useLockBodyScroll';
import { useTransactions } from '@/hooks/useTransactions';
import { CockpitModalHeader } from '@/components/money-cockpit/cockpit-modal';
import { MoneyCalculator } from '@/components/shared/money-calculator';
import {
  LHDN_TAX_CATEGORIES,
  analyzePurchaseForTaxRelief,
  applyPayslipDeductionsTag,
  applyTaxReliefTag,
  calculateYearlyTaxReliefSummary,
  extractExplicitTaxCategoryId,
  extractPayslipDeductionsFromNotes,
  getSavedLhdnTaxCaps,
  getTaxCategoryById,
} from '@/lib/lhdn-tax-helper';
import {
  findDuplicateTransactionsInLedger,
  type ShortcutQuickDraft,
} from '@/lib/shortcut-draft-store';

const CATEGORIES = {
  Expense: [
    { name: 'Food & Dining', icon: '🍔' },
    { name: 'Transport', icon: '🚗' },
    { name: 'Shopping', icon: '🛍️' },
    { name: 'Housing & Bills', icon: '🏠' },
    { name: 'Parents', icon: '👨‍👩‍👧' },
    { name: 'Insurance', icon: '🛡️' },
    { name: 'Entertainment', icon: '🎬' },
    { name: 'Health', icon: '🏥' },
    { name: 'Education', icon: '📚' },
    { name: 'Other', icon: '📦' },
  ],
  TripExpense: [
    { name: 'Food & Dining', icon: '🍔' },
    { name: 'Transport', icon: '🚗' },
    { name: 'Stay & Hotel', icon: '🏨' },
    { name: 'Flights', icon: '✈️' },
    { name: 'Shopping', icon: '🛍️' },
    { name: 'Entertainment', icon: '🎬' },
    { name: 'Health', icon: '🏥' },
    { name: 'Insurance', icon: '🛡️' },
    { name: 'Education', icon: '📚' },
    { name: 'Other', icon: '📦' },
  ],
  Income: [
    { name: 'Salary', icon: '💰' },
    { name: 'Claim Allowance', icon: '🧾' },
    { name: 'Freelance', icon: '💻' },
    { name: 'Investment Return', icon: '📈' },
    { name: 'Gift & Bonus', icon: '🎁' },
    { name: 'Other', icon: '💵' },
  ],
  Investment: [
    { name: 'Fixed Deposit', icon: '🔒' },
    { name: 'ASNB / Unit Trust', icon: '📈' },
    { name: 'EPF / KWSP', icon: '🏛️' },
    { name: 'Emergency Savings', icon: '🛡️' },
    { name: 'Other Savings', icon: '📦' },
  ]
};

const FD_BANKS = ['Maybank', 'CIMB', 'Public Bank', 'Hong Leong', 'RHB', 'AmBank', 'Affin Bank', 'Other'];
const FD_TENURES = [
  { label: '1M', months: 1 },
  { label: '3M', months: 3 },
  { label: '6M', months: 6 },
  { label: '12M', months: 12 },
];
const ASNB_FUNDS = ['ASM', 'ASB', 'ASM 2 Wawasan', 'ASM 3', 'ASB 2', 'Public Mutual'];
const EPF_ACCOUNTS = ['Akaun Persaraan (Acc 1)', 'Akaun Sejahtera (Acc 2)', 'Akaun Fleksibel (Acc 3)'];

function dataUrlToFile(dataUrl: string, fileName: string, mimeType: string): File {
  const base64 = dataUrl.split(',')[1] || '';
  const bytes = atob(base64);
  const binary = new Uint8Array(bytes.length);
  for (let index = 0; index < bytes.length; index += 1) binary[index] = bytes.charCodeAt(index);
  return new File([binary], fileName, { type: mimeType });
}

export function RecordPaymentModal() {
  const { isQuickAddOpen, setQuickAddOpen, editTransaction, setEditTransaction, aiPrefill, setAiPrefill, selectedMonth, setSelectedMonth } = useAppStore();
  const queryClient = useQueryClient();

  const [type, setType] = useState<'Expense' | 'Income' | 'Investment'>('Expense');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('Food & Dining');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState(() => getLocalDateString());
  const [notes, setNotes] = useState('');
  const [tripTag, setTripTag] = useState('');
  const [transactionCurrency, setTransactionCurrency] = useState('MYR');
  const [manualUntagged, setManualUntagged] = useState(false);
  const [shortcutDraft, setShortcutDraft] = useState<ShortcutQuickDraft | null>(null);
  const [shortcutCurrencyConfirmed, setShortcutCurrencyConfirmed] = useState<boolean>(true);
  const [shortcutDuplicateConfirmed, setShortcutDuplicateConfirmed] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [receiptPreview, setReceiptPreview] = useState<string | null>(null);
  const [showReceiptModal, setShowReceiptModal] = useState<boolean>(false);
  const [isScanningReceipt, setIsScanningReceipt] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  // Installment state for Expense
  const [isInstallment, setIsInstallment] = useState(false);
  const [installmentMonths, setInstallmentMonths] = useState(12);
  const [customInstallmentMonths, setCustomInstallmentMonths] = useState('');
  const [hasInterest, setHasInterest] = useState(false);
  const [installmentInterestRate, setInstallmentInterestRate] = useState('0');
  const [firstPaymentDate, setFirstPaymentDate] = useState<string>('');

  // Whenever modal opens afresh without an edit transaction or shortcut draft, guarantee it defaults to current local date
  useEffect(() => {
    if (isQuickAddOpen && !editTransaction && !shortcutDraft) {
      const today = getLocalDateString();
      setDate(today);
      setFirstPaymentDate(today);
    }
  }, [isQuickAddOpen, editTransaction, shortcutDraft]);

  useEffect(() => {
    if (!firstPaymentDate) {
      setFirstPaymentDate(date);
    }
  }, [date, firstPaymentDate]);

  // Fixed Deposit & Savings specific state
  const [fdBank, setFdBank] = useState('Maybank');
  const [fdTenureMonths, setFdTenureMonths] = useState(6);
  const [fdInterestRate, setFdInterestRate] = useState('3.85');
  const [asnbFund, setAsnbFund] = useState('ASM');
  const [epfAccount, setEpfAccount] = useState('Akaun Persaraan (Acc 1)');

  // Helper to detect if current description is matching an auto-generated template
  const isAutoGeneratedDescription = (desc: string) => {
    const trimmed = desc.trim();
    if (!trimmed) return true;
    if (trimmed.includes('Unit Trust Deposit')) return true;
    if (trimmed.includes('EPF Contribution')) return true;
    if (/^.* FD \(\d+M @ [\d.]*%\)$/.test(trimmed)) return true;
    if (trimmed === 'Emergency Savings Deposit' || trimmed === 'Savings Deposit') return true;
    return false;
  };

  const parsedPrincipal = parseFloat(amount) || 0;
  const parsedRate = parseFloat(fdInterestRate) || 0;
  const expectedInterest = (parsedPrincipal > 0 && parsedRate > 0 && fdTenureMonths > 0)
    ? (parsedPrincipal * (parsedRate / 100) * (fdTenureMonths / 12))
    : 0;
  const maturityAmount = parsedPrincipal + expectedInterest;

  const fdMaturityDate = useMemo(() => {
    if (!date || !fdTenureMonths) return '';
    try {
      const d = parseLocalDate(date);
      d.setMonth(d.getMonth() + Number(fdTenureMonths));
      return getLocalDateString(d);
    } catch {
      return '';
    }
  }, [date, fdTenureMonths]);

  // Installment plan calculation
  const effectiveInstallmentStart = firstPaymentDate || date;
  const effectiveInstallmentMonths = customInstallmentMonths === ''
    ? installmentMonths
    : Number(customInstallmentMonths);
  const installmentPlan = useMemo(() => {
    if (
      !isInstallment ||
      type !== 'Expense' ||
      parsedPrincipal <= 0 ||
      !Number.isInteger(effectiveInstallmentMonths) ||
      effectiveInstallmentMonths < MIN_INSTALLMENT_MONTHS ||
      effectiveInstallmentMonths > MAX_INSTALLMENT_MONTHS
    ) return null;
    return calculateInstallmentPlan({
      baseDescription: description || category,
      totalPrincipal: parsedPrincipal,
      tenureMonths: effectiveInstallmentMonths,
      annualInterestRate: hasInterest ? (parseFloat(installmentInterestRate) || 0) : 0,
      startDate: effectiveInstallmentStart,
      currency: transactionCurrency,
      category,
      tripTag,
      userNotes: notes,
    });
  }, [isInstallment, type, parsedPrincipal, description, category, installmentMonths, customInstallmentMonths, effectiveInstallmentMonths, hasInterest, installmentInterestRate, effectiveInstallmentStart, transactionCurrency, tripTag, notes]);

  const handleCategoryChange = (newCat: string) => {
    setCategory(newCat);
    if (type === 'Investment') {
      if (isAutoGeneratedDescription(description)) {
        if (newCat === 'Fixed Deposit') {
          setDescription(`${fdBank} FD (${fdTenureMonths}M @ ${fdInterestRate}%)`);
        } else if (newCat === 'ASNB / Unit Trust') {
          setDescription(`${asnbFund} Unit Trust Deposit`);
        } else if (newCat === 'EPF / KWSP') {
          setDescription(`EPF Contribution (${epfAccount})`);
        } else if (newCat === 'Emergency Savings') {
          setDescription('Emergency Savings Deposit');
        } else if (newCat === 'Other Savings') {
          setDescription('Savings Deposit');
        }
      }
    } else {
      if (isAutoGeneratedDescription(description)) {
        setDescription('');
      }
    }
  };

  const handleFdBankChange = (b: string) => {
    setFdBank(b);
    if (isAutoGeneratedDescription(description)) {
      setDescription(`${b} FD (${fdTenureMonths}M @ ${fdInterestRate}%)`);
    }
  };

  const handleFdTenureChange = (m: number) => {
    setFdTenureMonths(m);
    if (isAutoGeneratedDescription(description)) {
      setDescription(`${fdBank} FD (${m}M @ ${fdInterestRate}%)`);
    }
  };

  const handleFdRateChange = (r: string) => {
    setFdInterestRate(r);
    if (isAutoGeneratedDescription(description)) {
      setDescription(`${fdBank} FD (${fdTenureMonths}M @ ${r}%)`);
    }
  };

  const handleAsnbFundChange = (f: string) => {
    setAsnbFund(f);
    if (isAutoGeneratedDescription(description)) {
      setDescription(`${f} Unit Trust Deposit`);
    }
  };

  const handleEpfAccountChange = (acc: string) => {
    setEpfAccount(acc);
    if (isAutoGeneratedDescription(description)) {
      setDescription(`EPF Contribution (${acc})`);
    }
  };

  // Malaysia LHDN Tax Relief state & real-time quota calculation
  const [selectedTaxCategoryId, setSelectedTaxCategoryId] = useState<string>('');
  const [manualTaxOverride, setManualTaxOverride] = useState<boolean>(false);
  const [payslipPcb, setPayslipPcb] = useState<string>('');
  const [payslipEpf, setPayslipEpf] = useState<string>('');
  const [payslipSocso, setPayslipSocso] = useState<string>('');

  const assessmentYear = useMemo(() => {
    if (date && /^\d{4}/.test(date)) return date.substring(0, 4);
    return String(new Date().getFullYear());
  }, [date]);

  const { transactions: yearTransactions = [] } = useTransactions({ period: `year-${assessmentYear}` });

  const yearlyTaxSummary = useMemo(() => {
    const editId = editTransaction ? String(editTransaction.Id || editTransaction.id || '') : '';
    const relevantTxs = editId ? yearTransactions.filter((t) => t.id !== editId) : yearTransactions;
    return calculateYearlyTaxReliefSummary(relevantTxs, assessmentYear, getSavedLhdnTaxCaps());
  }, [yearTransactions, assessmentYear, editTransaction]);

  const purchaseTaxAnalysis = useMemo(() => {
    return analyzePurchaseForTaxRelief({
      type: type.toLowerCase(),
      category,
      description,
      notes,
    });
  }, [type, category, description, notes]);

  // Auto-select LHDN tax category when detected unless user manually overrode it
  useEffect(() => {
    if (manualTaxOverride) return;
    if (purchaseTaxAnalysis.isEligible && purchaseTaxAnalysis.matchedCategory) {
      setSelectedTaxCategoryId(purchaseTaxAnalysis.matchedCategory.id);
    } else {
      setSelectedTaxCategoryId('');
    }
  }, [purchaseTaxAnalysis, manualTaxOverride]);

  const activeTaxCategory = useMemo(() => {
    return getTaxCategoryById(selectedTaxCategoryId);
  }, [selectedTaxCategoryId]);

  const activeTaxQuotaInfo = useMemo(() => {
    if (!activeTaxCategory) return null;
    const progress = yearlyTaxSummary.byCategoryId[activeTaxCategory.id];
    const limit = progress ? progress.limit : activeTaxCategory.defaultLimit;
    const usedBefore = progress ? progress.totalSpent : 0;
    const remainingBefore = Math.max(0, limit - usedBefore);
    const currentPurchaseRm = getAmountInBaseCurrency(
      parseFloat(amount) || 0,
      transactionCurrency,
      undefined,
      getCachedRatesToMyr()
    );
    const claimableThisTx = Math.min(currentPurchaseRm, remainingBefore);
    const remainingAfter = Math.max(0, remainingBefore - currentPurchaseRm);
    const totalUsedAfter = usedBefore + currentPurchaseRm;
    const percentAfter = limit > 0 ? Math.min(100, (totalUsedAfter / limit) * 100) : 0;
    return {
      limit,
      usedBefore,
      remainingBefore,
      currentPurchaseRm,
      claimableThisTx,
      remainingAfter,
      totalUsedAfter,
      percentAfter,
      isAlreadyFull: remainingBefore <= 0,
      exceedsRemaining: currentPurchaseRm > remainingBefore && remainingBefore > 0,
    };
  }, [activeTaxCategory, yearlyTaxSummary, amount, transactionCurrency]);

  useEffect(() => {
    if (!editTransaction) return;
    const rawType = String(editTransaction.Type || editTransaction.type || 'Expense').toLowerCase();
    setType(rawType === 'income' ? 'Income' : rawType === 'investment' ? 'Investment' : 'Expense');
    setAmount(String(editTransaction.Amount || editTransaction.amount || ''));
    setCategory(String(editTransaction.Category || editTransaction.category || 'Other'));
    setDescription(String(editTransaction.Description || editTransaction.description || ''));
    setDate(String(editTransaction.Date || editTransaction.date || getLocalDateString()));
    const rawNotes = String(editTransaction.Notes || editTransaction.notes || '');
    setNotes(rawNotes);
    setTripTag(String(editTransaction.TripTag || editTransaction.tripTag || ''));
    setTransactionCurrency(String(editTransaction.Currency || editTransaction.currency || 'MYR').toUpperCase());
    const existingReceipt = String(editTransaction.ReceiptUrl || editTransaction.receiptUrl || '');
    setReceiptPreview(existingReceipt || null);
    setReceiptFile(null);
    setManualUntagged(false);

    const payslip = extractPayslipDeductionsFromNotes(rawNotes);
    setPayslipPcb(payslip.pcbAmount > 0 ? String(payslip.pcbAmount) : '');
    setPayslipEpf(payslip.epfAmount > 0 ? String(payslip.epfAmount) : '');
    setPayslipSocso(payslip.socsoAmount > 0 ? String(payslip.socsoAmount) : '');

    const explicitTax = extractExplicitTaxCategoryId({
      notes: rawNotes,
      subCategory: String(editTransaction.SubCategory || editTransaction.subCategory || ''),
    });
    if (explicitTax === 'none') {
      setSelectedTaxCategoryId('');
      setManualTaxOverride(true);
    } else if (explicitTax) {
      setSelectedTaxCategoryId(explicitTax);
      setManualTaxOverride(true);
    } else {
      setManualTaxOverride(false);
    }
  }, [editTransaction]);

  // AI installment drafts only prefill this existing form. Saving still requires the user.
  useEffect(() => {
    if (!isQuickAddOpen || editTransaction || aiPrefill?.kind !== 'installment') return;
    const draft = aiPrefill.data;
    setType('Expense');
    setAmount(String(draft.totalPrincipal));
    setCategory(draft.category || 'Shopping');
    setDescription(draft.name);
    setDate(draft.startDate);
    setFirstPaymentDate(draft.startDate);
    setNotes(draft.notes || '');
    setTripTag(draft.tripTag || '');
    setTransactionCurrency(draft.currency || 'MYR');
    setIsInstallment(true);
    setCustomInstallmentMonths(String(draft.tenureMonths));
    setHasInterest(draft.annualInterestRate > 0);
    setInstallmentInterestRate(String(draft.annualInterestRate || 0));
    setAiPrefill(null);
  }, [aiPrefill, editTransaction, isQuickAddOpen, setAiPrefill]);

  // AI transaction drafts (including Smart Input receipt scans) still require review and submit.
  useEffect(() => {
    if (!isQuickAddOpen || editTransaction || aiPrefill?.kind !== 'transaction') return;
    const draft = aiPrefill.data;
    setType(draft.type);
    setAmount(String(draft.amount));
    setCategory(draft.category || 'Other');
    setDescription(draft.description);
    setDate(draft.date || getLocalDateString());
    const taxSummary = [
      draft.taxLabel,
      draft.taxAmount != null ? `tax ${draft.currency || 'MYR'} ${Number(draft.taxAmount).toFixed(2)}` : '',
      draft.taxRate != null ? `${Number(draft.taxRate)}%` : '',
      draft.taxIncluded === true ? 'included' : '',
    ].filter(Boolean).join(' ');
    setNotes([draft.notes, taxSummary ? `Tax breakdown: ${taxSummary}` : ''].filter(Boolean).join('\n'));
    setTransactionCurrency(draft.currency || 'MYR');
    setIsInstallment(false);
    setCustomInstallmentMonths('');
    setHasInterest(false);
    setInstallmentInterestRate('0');
    if (aiPrefill.receipt) {
      setReceiptPreview(aiPrefill.receipt.dataUrl);
      setReceiptFile(dataUrlToFile(aiPrefill.receipt.dataUrl, aiPrefill.receipt.fileName, aiPrefill.receipt.mimeType));
    }
    setAiPrefill(null);
  }, [aiPrefill, editTransaction, isQuickAddOpen, setAiPrefill]);

  // Claim opaque ?quickDraft=drf_... (or fresh draft on app foreground) created by iPhone Back Tap Screenshot or Apple Pay
  useEffect(() => {
    if (typeof window === 'undefined') return;

    let isClaiming = false;
    let needsFollowUpCheck = false;
    const retryTimers: Array<ReturnType<typeof setTimeout>> = [];

    const checkAndClaimQuickDraft = async () => {
      if (isClaiming) {
        needsFollowUpCheck = true;
        return;
      }
      const params = new URLSearchParams(window.location.search);
      const shortcutError = params.get('shortcutError');
      if (shortcutError) {
        params.delete('shortcutError');
        const nextSearch = params.toString();
        const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`;
        window.history.replaceState({}, '', nextUrl);
        toast.error(decodeURIComponent(shortcutError), { duration: 6000 });
      }

      const urlDraftId = params.get('quickDraft');
      const targetId = urlDraftId && /^drf_[a-zA-Z0-9_-]{16,}$/i.test(urlDraftId.trim())
        ? urlDraftId.trim()
        : 'latest';

      try {
        isClaiming = true;
        const res = await fetch(`/api/shortcuts/ingest?id=${encodeURIComponent(targetId)}&_t=${Date.now()}`, {
          cache: 'no-store',
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return;
        const json = await res.json();

        // Sync any background auto-recorded Double Tap transactions into local SWR + React Query cache in 0ms
        if (Array.isArray(json?.recentAutoRecorded) && json.recentAutoRecorded.length > 0) {
          let syncedIds: string[] = [];
          try {
            const rawSynced = localStorage.getItem('kinova_synced_shortcut_tx_ids');
            if (rawSynced) {
              const parsedSynced = JSON.parse(rawSynced);
              if (Array.isArray(parsedSynced)) syncedIds = parsedSynced.map(String);
            }
          } catch {
            // ignore
          }
          const syncedSet = new Set(syncedIds);
          const newlyAdded: Array<{ sheetName: string; rowData: Record<string, unknown> }> = [];

          for (const item of json.recentAutoRecorded) {
            const txId = String(item?.transactionId || '').trim();
            const sheetName = String(item?.sheetName || '').trim();
            const rowData = item?.rowData as Record<string, unknown> | undefined;
            if (!txId || !sheetName || !rowData || syncedSet.has(txId)) continue;
            syncedSet.add(txId);
            const optimisticRow = sheetsData.optimisticAddRow(sheetName, rowData);
            applyOptimisticAddToQueryCache(queryClient, sheetName, optimisticRow);
            newlyAdded.push({ sheetName, rowData });
          }

          if (newlyAdded.length > 0) {
            try {
              localStorage.setItem(
                'kinova_synced_shortcut_tx_ids',
                JSON.stringify(Array.from(syncedSet).slice(-50))
              );
            } catch {
              // ignore
            }
            void queryClient.invalidateQueries({ queryKey: ['sheet'] });
            void queryClient.invalidateQueries({ queryKey: ['months'] });
            const latestItem = newlyAdded[0];
            const desc = String(latestItem.rowData.Description || '快捷指令消费');
            const amt = Number(latestItem.rowData.Amount || 0).toFixed(2);
            const curr = String(latestItem.rowData.Currency || 'MYR');
            const targetMonth = latestItem.sheetName;
            toast.success(
              `✅ 快捷指令已入账：${curr} ${amt} · ${desc}`,
              targetMonth && targetMonth !== selectedMonth
                ? {
                    action: {
                      label: `View ${targetMonth}`,
                      onClick: () => setSelectedMonth(targetMonth),
                    },
                  }
                : undefined
            );
          }
        }

        if (!json?.success || !json?.draft) return;

        const draft = json.draft as ShortcutQuickDraft;
        const draftUniqueKey = `${draft.fingerprint || ''}|${draft.createdAt || draft.draftId}`;
        try {
          const lastClaimed = sessionStorage.getItem('kinova_last_claimed_draft');
          if (lastClaimed === draftUniqueKey) {
            return;
          }
          sessionStorage.setItem('kinova_last_claimed_draft', draftUniqueKey);
        } catch {
          // ignore storage errors
        }

        // Only remove ?quickDraft=... from URL after we have successfully claimed the draft
        if (urlDraftId) {
          const cleanParams = new URLSearchParams(window.location.search);
          cleanParams.delete('quickDraft');
          const nextSearch = cleanParams.toString();
          const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`;
          window.history.replaceState({}, '', nextUrl);
        }

        // Acknowledge draft on server so it isn't re-claimed later
        void fetch(`/api/shortcuts/ingest?ack=${encodeURIComponent(draft.draftId)}`, {
          cache: 'no-store',
        }).catch(() => {});

        setEditTransaction(null);
        setShortcutDraft(draft);
        setShortcutCurrencyConfirmed(!draft.currencyAmbiguous);
        setShortcutDuplicateConfirmed(false);
        setType(draft.type || 'Expense');
        setAmount(draft.amount != null && draft.amount > 0 ? String(draft.amount) : '');
        setCategory(draft.category || 'Food & Dining');
        const resolvedDesc = draft.description || draft.merchant || (draft.category && draft.category !== 'Other' ? draft.category : '');
        setDescription(resolvedDesc);
        setDate(draft.date || getLocalDateString());
        setTransactionCurrency(draft.currency || 'MYR');
        setNotes(draft.notes || '');
        setIsInstallment(false);
        setQuickAddOpen(true);
        toast.info(
          draft.source === 'apple_pay_wallet'
            ? ' 已载入 Apple Pay 待确认草稿，请核对补充并点击保存后才会入账。'
            : '📱 已载入「Kinova 快速记账」截图草稿，请核对补充并点击保存后才会入账。',
          { duration: 5000 }
        );
      } catch {
        // silent
      } finally {
        isClaiming = false;
        if (needsFollowUpCheck) {
          needsFollowUpCheck = false;
          void checkAndClaimQuickDraft();
        }
      }
    };

    const triggerBurstCheck = () => {
      for (const t of retryTimers) clearTimeout(t);
      retryTimers.length = 0;
      void checkAndClaimQuickDraft();
      for (const delayMs of [400, 1200, 2500, 4500]) {
        const timer = setTimeout(() => {
          void checkAndClaimQuickDraft();
        }, delayMs);
        retryTimers.push(timer);
      }
    };

    // Run on initial mount
    triggerBurstCheck();

    // Re-check automatically when user returns to PWA or window regains focus!
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        triggerBurstCheck();
        void queryClient.invalidateQueries({ queryKey: ['sheet'] });
        void queryClient.invalidateQueries({ queryKey: ['months'] });
      }
    };
    const handleFocus = () => {
      triggerBurstCheck();
      void queryClient.invalidateQueries({ queryKey: ['sheet'] });
      void queryClient.invalidateQueries({ queryKey: ['months'] });
    };

    // Also poll lightly while app is visible in case Back Tap was triggered while Kinova was already foregrounded
    const pollInterval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void checkAndClaimQuickDraft();
      }
    }, 2500);

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('focus', handleFocus);
    window.addEventListener('pageshow', handleFocus);
    window.addEventListener('popstate', handleFocus);

    return () => {
      for (const t of retryTimers) clearTimeout(t);
      clearInterval(pollInterval);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('pageshow', handleFocus);
      window.removeEventListener('popstate', handleFocus);
    };
  }, [queryClient, selectedMonth, setEditTransaction, setQuickAddOpen, setSelectedMonth]);

  const shortcutLedgerDuplicates = useMemo(() => {
    if (!shortcutDraft) return [];
    const numAmt = parseFloat(amount);
    return findDuplicateTransactionsInLedger(
      {
        amount: Number.isFinite(numAmt) && numAmt > 0 ? numAmt : null,
        currency: transactionCurrency,
        date,
        description,
        merchant: shortcutDraft.merchant,
      },
      yearTransactions.map((t) => ({
        id: String(t.id || ''),
        date: String(t.date || ''),
        amount: Number(t.amount || 0),
        currency: String(t.currency || 'MYR'),
        description: String(t.description || ''),
        category: String(t.category || ''),
        type: String(t.type || 'expense'),
      }))
    );
  }, [shortcutDraft, amount, transactionCurrency, date, description, yearTransactions]);

  const closeModal = () => {
    setEditTransaction(null);
    setShortcutDraft(null);
    setShortcutCurrencyConfirmed(true);
    setShortcutDuplicateConfirmed(false);
    setReceiptFile(null);
    setReceiptPreview(null);
    setShowReceiptModal(false);
    setPayslipPcb('');
    setPayslipEpf('');
    setPayslipSocso('');
    setQuickAddOpen(false);
  };

  // Available trips with full schedule
  const { data: rawTripsData } = useSheetData('Trips');
  const tripsList = useMemo(() => {
    return (rawTripsData?.rows || []).map((r: any, idx: number) => {
      const name = String(r.TripName || r.tripName || r.Name || r.name || `Trip #${idx + 1}`).trim();
      const id = String(r.Id || r.id || name).trim();
      const startDate = String(r.StartDate || r.startDate || r.start_date || '').trim();
      const endDate = String(r.EndDate || r.endDate || r.end_date || '').trim();
      const destination = String(r.Destination || r.destination || '').trim();
      const currency = String(r.Currency || r.currency || 'MYR').trim().toUpperCase();
      return { id, name, startDate, endDate, destination, currency };
    }).filter(t => t.name);
  }, [rawTripsData]);

  // Trip matching current date (e.g. 20/9 - 30/9 Chengdu Trip)
  const activeTripForDate = useMemo(() => {
    if (!date) return null;
    return tripsList.find(t => {
      if (!t.startDate) return false;
      const start = t.startDate;
      const end = t.endDate || t.startDate;
      return date >= start && date <= end;
    }) || null;
  }, [tripsList, date]);

  const suggestedTrip = useMemo(() => {
    // 1. If currently inside the trip dates, that's our primary match
    if (activeTripForDate) return activeTripForDate;

    // 2. Pre-trip / keyword detection (e.g. buying flight ticket on 1/9 for Chengdu trip)
    const text = `${description} ${category}`.toLowerCase();
    const travelWords = [
      'flight', 'airline', 'airasia', 'firefly', 'batik', 'malaysia airlines', 'scoot',
      'hotel', 'airbnb', 'hostel', 'resort', 'ticket', 'visa', 'airport', 'klook',
      'trip.com', 'agoda', 'booking', 'ferry', 'train', 'travel'
    ];
    return tripsList.find((trip) => {
      const nameMatch = text.includes(trip.name.toLowerCase());
      const destMatch = trip.destination && text.includes(trip.destination.toLowerCase());
      const hasTravelWord = travelWords.some(w => text.includes(w));
      return nameMatch || destMatch || (hasTravelWord && trip.startDate && date <= trip.startDate);
    }) || null;
  }, [activeTripForDate, category, date, description, tripsList]);

  // Suggest or auto-tag a trip when detected, while preserving manual un-tag
  useEffect(() => {
    if (suggestedTrip && !tripTag && !manualUntagged) {
      setTripTag(suggestedTrip.name);
    }
  }, [manualUntagged, suggestedTrip, tripTag]);

  const selectedTrip = useMemo(() => {
    if (tripTag) {
      return tripsList.find((t) => t.name === tripTag) || null;
    }
    if (!manualUntagged) {
      return activeTripForDate;
    }
    return null;
  }, [tripTag, tripsList, manualUntagged, activeTripForDate]);

  const showTripCurrency = Boolean(
    selectedTrip ||
    activeTripForDate ||
    tripTag ||
    (editTransaction && editTransaction.currency && editTransaction.currency !== 'MYR')
  );

  useEffect(() => {
    if (editTransaction || shortcutDraft) return;
    if (selectedTrip?.currency) {
      setTransactionCurrency(selectedTrip.currency);
    } else if (!selectedTrip) {
      setTransactionCurrency('MYR');
    }
  }, [selectedTrip, editTransaction, shortcutDraft]);

  const handleTypeChange = (newType: 'Expense' | 'Income' | 'Investment') => {
    setType(newType);
    const firstCat = CATEGORIES[newType][0].name;
    setCategory(firstCat);
    if (newType === 'Investment') {
      if (firstCat === 'Fixed Deposit') {
        setDescription(`${fdBank} FD (${fdTenureMonths}M @ ${fdInterestRate}%)`);
      } else if (firstCat === 'ASNB / Unit Trust') {
        setDescription(`${asnbFund} Unit Trust Deposit`);
      }
    } else {
      if (isAutoGeneratedDescription(description)) {
        setDescription('');
      }
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setReceiptFile(file);
      try {
        const { dataUrl } = await compressImageFile(file);
        setReceiptPreview(dataUrl);
      } catch (err) {
        console.error('Failed to compress image, using fallback reader', err);
        const reader = new FileReader();
        reader.onloadend = () => {
          setReceiptPreview(reader.result as string);
        };
        reader.readAsDataURL(file);
      }
    }
  };

  const handleScanReceipt = async () => {
    if (!receiptFile || !receiptPreview || receiptPreview.startsWith('http')) return;
    if (!receiptFile.type.startsWith('image/')) {
      toast.error('Gemini receipt scanning supports image files only');
      return;
    }

    const imageBase64 = receiptPreview.split(',')[1];
    if (!imageBase64) {
      toast.error('Receipt image is not ready yet');
      return;
    }

    setIsScanningReceipt(true);
    try {
      const res = await fetch('/api/ai/parse-receipt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageBase64,
          mimeType: receiptPreview.match(/^data:([^;]+);/)?.[1] || 'image/jpeg',
          today: getLocalDateString(),
        }),
      });
      const json = await res.json();
      const parsed = json.success ? json.data?.data : null;
      if (!res.ok || !parsed) throw new Error(json.error || 'Could not read this receipt');

      setType('Expense');
      setAmount(String(parsed.amount));
      setCategory(String(parsed.category || 'Other'));
      setDescription(String(parsed.description || 'Receipt expense'));
      setDate(String(parsed.date || getLocalDateString()));
      setTransactionCurrency(String(parsed.currency || 'MYR').toUpperCase());
      const taxSummary = [
        parsed.taxLabel,
        parsed.taxAmount != null ? `tax ${parsed.currency || 'MYR'} ${Number(parsed.taxAmount).toFixed(2)}` : '',
        parsed.taxRate != null ? `${Number(parsed.taxRate)}%` : '',
      ].filter(Boolean).join(' ');
      setNotes(`${String(parsed.notes || 'Scanned from receipt; please verify before saving.')}${taxSummary ? ` (${taxSummary})` : ''}`);
      toast.success('Receipt details filled in. Please review before saving.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Receipt scanning failed');
    } finally {
      setIsScanningReceipt(false);
    }
  };

  const removeReceipt = () => {
    setReceiptFile(null);
    setReceiptPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (cameraInputRef.current) cameraInputRef.current.value = '';
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isSafeTransactionAmount(amount)) {
      toast.error(
        shortcutDraft
          ? '系统未能从快捷指令获取有效金额，请补充大于 0 且最多两位小数的金额后再保存'
          : 'Enter an amount greater than zero with at most two decimal places'
      );
      return;
    }

    if (shortcutDraft && !description.trim()) {
      toast.error('系统未能识别商家/消费描述，请补充商家或说明后再保存');
      return;
    }

    if (shortcutDraft && !shortcutCurrencyConfirmed) {
      toast.error('货币符号存在歧义，请先在上方草稿提示框中点击确认实际币种后再保存');
      return;
    }

    const hasShortcutDuplicates =
      Boolean(shortcutDraft) &&
      (shortcutLedgerDuplicates.length > 0 || Boolean(shortcutDraft?.suspectedDuplicateOfDraftId));

    if (hasShortcutDuplicates && !shortcutDuplicateConfirmed) {
      toast.error('检测到同日同金额疑似重复交易，请核对上方提示并点击「确认这是另一笔真实消费」后再保存');
      return;
    }

    if (
      type === 'Expense' &&
      isInstallment &&
      (!Number.isInteger(effectiveInstallmentMonths) ||
        effectiveInstallmentMonths < MIN_INSTALLMENT_MONTHS ||
        effectiveInstallmentMonths > MAX_INSTALLMENT_MONTHS)
    ) {
      toast.error(`Installment duration must be a whole number from ${MIN_INSTALLMENT_MONTHS} to ${MAX_INSTALLMENT_MONTHS} months`);
      return;
    }

    const parsedAmount = parseFloat(amount);
    const pendingCurrency = transactionCurrency;
    const monthStr = date.substring(0, 7);
    const existingReceiptUrl = editTransaction ? String(editTransaction.ReceiptUrl || editTransaction.receiptUrl || '') : '';

    // Auto-formatting for Investment type (FD terms, ASNB fund, EPF account)
    let finalDesc = description.trim();
    let finalNotes = notes.trim();
    if (type === 'Investment') {
      if (category === 'Fixed Deposit') {
        if (!finalDesc) {
          finalDesc = `${fdBank} FD (${fdTenureMonths}M @ ${fdInterestRate}%)`;
        }
        const fdNoteDetails = `[Fixed Deposit] Bank: ${fdBank} | Tenure: ${fdTenureMonths} Months | Rate: ${fdInterestRate}% p.a. | Expected Return: +${transactionCurrency} ${expectedInterest.toFixed(2)} | Maturity Date: ${fdMaturityDate} | Maturity Total: ${transactionCurrency} ${maturityAmount.toFixed(2)}`;
        if (!finalNotes.includes('[Fixed Deposit]')) {
          finalNotes = finalNotes ? `${finalNotes}\n${fdNoteDetails}` : fdNoteDetails;
        }
      } else if (category === 'ASNB / Unit Trust') {
        if (!finalDesc) {
          finalDesc = `${asnbFund} Unit Trust Deposit`;
        }
        const asnbDetails = `[ASNB / Unit Trust] Fund: ${asnbFund}`;
        if (!finalNotes.includes('[ASNB / Unit Trust]')) {
          finalNotes = finalNotes ? `${finalNotes}\n${asnbDetails}` : asnbDetails;
        }
      } else if (category === 'EPF / KWSP') {
        if (!finalDesc) {
          finalDesc = `EPF Contribution (${epfAccount})`;
        }
        const epfDetails = `[EPF / KWSP] Account: ${epfAccount}`;
        if (!finalNotes.includes('[EPF / KWSP]')) {
          finalNotes = finalNotes ? `${finalNotes}\n${epfDetails}` : epfDetails;
        }
      } else if (category === 'Emergency Savings') {
        if (!finalDesc) {
          finalDesc = 'Emergency Savings Deposit';
        }
        const emDetails = `[Emergency Savings] Liquid Reserve`;
        if (!finalNotes.includes('[Emergency Savings]')) {
          finalNotes = finalNotes ? `${finalNotes}\n${emDetails}` : emDetails;
        }
      }
    }

    // Installment handling for Expense
    let targetAmount = parsedAmount;
    let targetDate = normalizeDateString(date);
    if (type === 'Expense' && isInstallment && installmentPlan && installmentPlan.schedule.length > 0) {
      const firstInst = installmentPlan.schedule[0];
      targetAmount = firstInst.amount;
      targetDate = normalizeDateString(firstInst.date);
      finalDesc = firstInst.description;
      finalNotes = firstInst.notes;
    }
    const finalMonthStr = targetDate.substring(0, 7);
    const baseAmount = getAmountInBaseCurrency(targetAmount, pendingCurrency, undefined, getCachedRatesToMyr());
    const baseRate = targetAmount > 0 ? baseAmount / targetAmount : 1;
    if (!isSafeTransactionConversion(targetAmount, baseAmount, baseRate)) {
      toast.error('This amount or its currency conversion is outside the safe numeric range.');
      return;
    }

    const existingSubCategory = editTransaction
      ? String(editTransaction.SubCategory || editTransaction.subCategory || '')
      : '';
    if (type === 'Income') {
      finalNotes = applyPayslipDeductionsTag(
        finalNotes,
        parseFloat(payslipPcb) || 0,
        parseFloat(payslipEpf) || 0,
        parseFloat(payslipSocso) || 0
      );
    }
    const taxTagged = applyTaxReliefTag(
      finalNotes,
      existingSubCategory,
      selectedTaxCategoryId || null,
      manualTaxOverride && !selectedTaxCategoryId
    );
    finalNotes = taxTagged.notes;
    const finalSubCategory = taxTagged.subCategory;

    const rowData = {
        Date: targetDate,
        Type: type,
        Category: category,
        SubCategory: finalSubCategory,
        Description: finalDesc || category,
        Amount: targetAmount,
        Currency: transactionCurrency,
        BaseAmount: Number(baseAmount.toFixed(2)),
        BaseCurrency: ACCOUNTING_BASE_CURRENCY,
        FxRateToBase: Number(baseRate.toFixed(8)),
        TripTag: tripTag,
        ReceiptUrl: existingReceiptUrl,
        Notes: finalNotes,
    };
    const pendingReceipt = receiptFile;
    const pendingPreview = receiptPreview;
    const pendingDate = targetDate;
    const pendingCategory = finalSubCategory || category;
    const pendingDescription = finalDesc || category;
    const savedTaxCat = activeTaxCategory;

    if (editTransaction && (editTransaction.Id || editTransaction.id)) {
      const editTxId = String(editTransaction.Id || editTransaction.id);
      const targetReceiptUrl = receiptPreview ? (receiptPreview.startsWith('http') ? receiptPreview : existingReceiptUrl) : '';

      // Instant optimistic UI + local SWR cache update (<10ms)
      const updatedTx = {
        ...rowData,
        subCategory: finalSubCategory,
        ReceiptUrl: targetReceiptUrl,
        receiptUrl: targetReceiptUrl,
        Id: editTxId,
        id: editTxId,
        _month: finalMonthStr,
        _rowIndex: editTransaction._rowIndex,
      };

      applyOptimisticUpdateToQueryCache(
        queryClient,
        String(editTransaction._month || finalMonthStr),
        typeof editTransaction._rowIndex === 'number' ? editTransaction._rowIndex : 2,
        updatedTx,
      );

      // Close modal and notify user immediately
      closeModal();
      toast.success('Transaction updated! ⚡');

      // Asynchronous background update to Google Drive & databases
      void (async () => {
        try {
          let uploadedReceiptUrl = targetReceiptUrl;
          if (pendingReceipt && pendingPreview && pendingPreview.startsWith('data:')) {
            const fileName = formatClaimFileName(pendingDate, pendingCategory, targetAmount, pendingDescription, pendingReceipt.name);
            const isPdf = pendingReceipt.type === 'application/pdf' || pendingReceipt.name?.toLowerCase().endsWith('.pdf');
            const uploadMime = isPdf ? 'application/pdf' : 'image/jpeg';
            const res = await driveApi.uploadFile(fileName, uploadMime, pendingPreview.split(',')[1]);
            uploadedReceiptUrl = res.data?.url || '';
          }

          await updateUnifiedRow(String(editTransaction._month || finalMonthStr), Number(editTransaction._rowIndex || 2), {
            ...rowData,
            ReceiptUrl: uploadedReceiptUrl,
            Id: editTxId,
            _month: finalMonthStr,
          });
          if (uploadedReceiptUrl && uploadedReceiptUrl !== targetReceiptUrl) {
            applyOptimisticUpdateToQueryCache(
              queryClient,
              String(editTransaction._month || finalMonthStr),
              typeof editTransaction._rowIndex === 'number' ? editTransaction._rowIndex : 2,
              {
                ...updatedTx,
                ReceiptUrl: uploadedReceiptUrl,
                receiptUrl: uploadedReceiptUrl,
              },
            );
          }
          queryClient.invalidateQueries({ queryKey: ['months'] });
          queryClient.invalidateQueries({ queryKey: ['overview'] });
        } catch (err: unknown) {
          console.error('Failed to update transaction in background', err);
        }
      })();
      return;
    }

    // Optimistic UI + local SWR cache update so transaction appears instantly (<10ms)
    const tempId = `tx_${Date.now()}`;
    const optimisticRow = {
      Id: tempId,
      id: tempId,
      Date: targetDate,
      date: targetDate,
      Type: type.toLowerCase(),
      type: type.toLowerCase(),
      Category: category,
      category: category,
      SubCategory: finalSubCategory,
      subCategory: finalSubCategory,
      Description: finalDesc || category,
      description: finalDesc || category,
      Amount: targetAmount,
      amount: targetAmount,
      baseAmount: Number(baseAmount.toFixed(2)),
      baseCurrency: ACCOUNTING_BASE_CURRENCY,
      fxRateToBase: Number(baseRate.toFixed(8)),
      Currency: pendingCurrency,
      currency: pendingCurrency,
      TripTag: tripTag,
      tripTag: tripTag,
      ReceiptUrl: pendingPreview || '',
      receiptUrl: pendingPreview || '',
      Notes: finalNotes,
      notes: finalNotes,
      _month: finalMonthStr,
      _rowIndex: 2,
    };

    const todayStr = getLocalDateString();
    const isFutureInstallment = type === 'Expense' && isInstallment && targetDate > todayStr;

    if (!isFutureInstallment) {
      applyOptimisticAddToQueryCache(queryClient, finalMonthStr, optimisticRow);
    }

    // Register persistent installment plan immediately so UI reflects it right away
    if (type === 'Expense' && isInstallment && installmentPlan && installmentPlan.schedule.length > 0 && !editTransaction) {
      const lastItem = installmentPlan.schedule[installmentPlan.schedule.length - 1];
      upsertSavedInstallmentPlan({
        id: `plan_${Date.now()}`,
        name: (description || category).trim(),
        category,
        currency: transactionCurrency,
        totalPrincipal: parsedAmount,
        tenureMonths: effectiveInstallmentMonths,
        annualInterestRate: hasInterest ? (parseFloat(installmentInterestRate) || 0) : 0,
        monthlyAmount: installmentPlan.monthlyAmount,
        totalPayable: installmentPlan.totalPayable,
        startDate: effectiveInstallmentStart,
        endDate: lastItem ? lastItem.month : '',
        autoRecord: false,
        tripTag,
        notes: finalNotes,
      });
    }

    // Close immediately so the next expense can be entered while cloud sync runs.
    setIsSubmitting(false);
    setShortcutDraft(null);
    setShortcutCurrencyConfirmed(true);
    setShortcutDuplicateConfirmed(false);
    setAmount('');
    setDescription('');
    setNotes('');
    setTripTag('');
    setSelectedTaxCategoryId('');
    setManualTaxOverride(false);
    setPayslipPcb('');
    setPayslipEpf('');
    setPayslipSocso('');
    setTransactionCurrency('MYR');
    setIsInstallment(false);
    setInstallmentMonths(12);
    setCustomInstallmentMonths('');
    setHasInterest(false);
    setInstallmentInterestRate('0');
    removeReceipt();
    setQuickAddOpen(false);

    const isOtherPeriod =
      Boolean(finalMonthStr) &&
      finalMonthStr !== selectedMonth &&
      selectedMonth !== 'all' &&
      selectedMonth !== `year-${finalMonthStr.slice(0, 4)}`;
    const toastOptions = isOtherPeriod
      ? {
          action: {
            label: `View ${finalMonthStr}`,
            onClick: () => setSelectedMonth(finalMonthStr),
          },
          duration: 5000,
        }
      : undefined;

    if (isInstallment) {
      if (isFutureInstallment) {
        toast.success(`Installment plan for "${description || category}" scheduled! First payment due on ${targetDate}.`, toastOptions);
      } else {
        toast.success(`Installment 1/${installmentMonths} (${pendingCurrency} ${targetAmount.toFixed(2)}) recorded! Future months will be tracked month-by-month.`, toastOptions);
      }
    } else if (savedTaxCat) {
      if (pendingPreview) {
        toast.success(`Recorded under LHDN ${savedTaxCat.shortName} with tax receipt! 🇲🇾🧾`, toastOptions);
      } else {
        toast.success(`Recorded under LHDN ${savedTaxCat.shortName}! Don't forget to attach the receipt in Invoices & Claims. 🇲🇾📸`, toastOptions);
      }
    } else {
      toast.success(
        isOtherPeriod
          ? `${type} of ${pendingCurrency} ${targetAmount.toFixed(2)} recorded to ${finalMonthStr}! ⚡`
          : `${type} of ${pendingCurrency} ${targetAmount.toFixed(2)} recorded! ⚡`,
        toastOptions
      );
    }

    void (async () => {
      try {
        let receiptUrl = '';
        if (pendingReceipt && pendingPreview && pendingPreview.startsWith('data:')) {
          const fileName = formatClaimFileName(pendingDate, pendingCategory, targetAmount, pendingDescription, pendingReceipt.name);
          const isPdf = pendingReceipt.type === 'application/pdf' || pendingReceipt.name?.toLowerCase().endsWith('.pdf');
          const uploadMime = isPdf ? 'application/pdf' : 'image/jpeg';
          const res = await driveApi.uploadFile(fileName, uploadMime, pendingPreview.split(',')[1]);
          receiptUrl = res.data?.url || '';
        }

        // Only insert Month 1 transaction if it starts today or in the past.
        // If starting next month, it will be recorded when that month arrives.
        if (!isFutureInstallment) {
          await addUnifiedRow(finalMonthStr, { ...rowData, Id: tempId, id: tempId, ReceiptUrl: receiptUrl });
          if (receiptUrl) {
            applyOptimisticUpdateToQueryCache(queryClient, finalMonthStr, 2, {
              ...optimisticRow,
              ReceiptUrl: receiptUrl,
              receiptUrl,
            });
          }
        }

        queryClient.invalidateQueries({ queryKey: ['months'] });
        queryClient.invalidateQueries({ queryKey: ['overview'] });
      } catch (err: unknown) {
        console.error('Failed to record transaction in background', err);
      }
    })();
  };

  useLockBodyScroll(isQuickAddOpen || showReceiptModal);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <AnimatePresence>
      {isQuickAddOpen && (
        <div className="cockpit-record-modal-overlay fixed inset-0 z-[200] flex items-center justify-center p-4">
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => !isSubmitting && closeModal()}
            className="fixed inset-0 bg-black/75"
          />

          {/* Modal Window */}
          <motion.div
            id="record-transaction-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="record-modal-title"
            aria-describedby="record-modal-description"
            initial={{ opacity: 0, scale: 0.96, y: 14 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 14 }}
            transition={{ type: "spring" as const, damping: 28, stiffness: 350 }}
            className="cockpit-record-modal-frame relative w-full max-w-lg max-h-[calc(100dvh-1.5rem)] overflow-y-auto overscroll-contain touch-pan-y [-webkit-overflow-scrolling:touch] custom-scrollbar rounded-3xl border border-slate-200 dark:border-white/[0.12] bg-white dark:bg-[#090d16] p-4 sm:p-6 shadow-[0_25px_60px_-15px_rgba(0,0,0,0.85),0_0_40px_rgba(99,102,241,0.12)] z-10"
          >
            {/* Header */}
            <CockpitModalHeader
              title={editTransaction ? 'Edit transaction' : 'Record a transaction'}
              titleId="record-modal-title"
              description="Add the details for this entry."
              descriptionId="record-modal-description"
              icon={<CreditCard size={20} />}
              onClose={closeModal}
              closeLabel="Close transaction form"
            />

          <form onSubmit={handleSubmit} className="mt-3 space-y-2.5 sm:mt-5 sm:space-y-5">
            {shortcutDraft && (
              <div className="rounded-2xl border border-indigo-500/35 bg-indigo-500/10 p-3 sm:p-3.5 space-y-2.5 text-xs">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="font-bold text-indigo-950 dark:text-indigo-200 flex items-center gap-1.5">
                    <Sparkles className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                    {shortcutDraft.source === 'apple_pay_wallet'
                      ? ' Apple Pay 交易触发 · 待确认草稿'
                      : '📱 Kinova 快速记账 · 背面轻点截图草稿'}
                  </span>
                  <span className="rounded-full bg-amber-500/20 border border-amber-500/40 px-2 py-0.5 text-[10px] font-bold text-amber-900 dark:text-amber-200">
                    需确认后入账（绝不自动记账）
                  </span>
                </div>

                <p className="text-[11px] leading-relaxed text-slate-700 dark:text-zinc-300">
                  {shortcutDraft.aiDisclosure}
                </p>

                {shortcutDraft.ocrSummary && (
                  <div className="rounded-xl border border-indigo-500/30 bg-indigo-50/70 dark:bg-zinc-900/80 p-2.5 text-indigo-950 dark:text-indigo-200 text-[11px] flex items-start gap-1.5 leading-snug">
                    <span className="font-bold shrink-0">📸 画面识别:</span>
                    <span>{shortcutDraft.ocrSummary}</span>
                  </div>
                )}

                {/* Missing or Uncertain Field Prompts */}
                {(shortcutDraft.missingFields.length > 0 || shortcutDraft.uncertainFields.length > 0) && (
                  <div className="rounded-xl border border-amber-500/35 bg-amber-500/15 p-2.5 space-y-1.5 text-amber-950 dark:text-amber-200">
                    <div className="font-bold text-[11px]">
                      ⚠️ 请核对补充以下未完整提取的字段：
                    </div>
                    <ul className="list-disc pl-4 space-y-1 text-[11px] leading-relaxed">
                      {shortcutDraft.missingFields.includes('amount') && (!amount || parseFloat(amount) <= 0) && (
                        <li>未提取到<strong>消费金额</strong>，请在下方手动输入。（提示：若此前在快捷指令 App 或主屏幕直接点击测试，请切换到支付成功页如 Touch &apos;n Go / Grab / Apple Pay / 银行转账或纸质收据前，再双击手机背面轻点截图）。</li>
                      )}
                      {shortcutDraft.missingFields.includes('description') && !description.trim() && (
                        <li>未提取到<strong>商家或消费说明</strong>，请在下方 Description 栏补充。</li>
                      )}
                      {shortcutDraft.uncertainFields.includes('category') && (
                        <li>消费类别为系统根据上下文预选（<strong>{category}</strong>），请核对下方类别按钮。</li>
                      )}
                    </ul>
                  </div>
                )}

                {/* Currency Ambiguity Confirmation */}
                {(shortcutDraft.currencyAmbiguous || !shortcutCurrencyConfirmed) && (
                  <div className="rounded-xl border border-rose-500/40 bg-rose-500/15 p-2.5 space-y-2 text-rose-950 dark:text-rose-200">
                    <div className="font-bold text-[11px]">
                      💱 币种符号存在歧义或未明确提供，请点击确认实际币种：
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {Array.from(new Set([...(shortcutDraft.candidateCurrencies || []), 'MYR', 'SGD', 'USD', 'JPY', 'CNY'])).map((code) => (
                        <button
                          key={code}
                          type="button"
                          onClick={() => {
                            setTransactionCurrency(code);
                            setShortcutCurrencyConfirmed(true);
                          }}
                          className={`px-2.5 py-1 rounded-lg text-xs font-mono font-bold border transition-all cursor-pointer ${
                            transactionCurrency === code && shortcutCurrencyConfirmed
                              ? 'border-emerald-500 bg-emerald-600 text-white'
                              : 'border-rose-400/50 bg-white/90 dark:bg-zinc-900 text-slate-800 dark:text-zinc-200'
                          }`}
                        >
                          {transactionCurrency === code && shortcutCurrencyConfirmed ? '✓ ' : ''}
                          {code}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Duplicate Candidate Warning */}
                {(shortcutLedgerDuplicates.length > 0 || Boolean(shortcutDraft.suspectedDuplicateOfDraftId)) && (
                  <div className="rounded-xl border border-rose-500/45 bg-rose-500/15 p-2.5 space-y-2 text-rose-950 dark:text-rose-200">
                    <div className="font-bold text-[11px]">
                      🛡️ 疑似重复记账提醒：
                    </div>
                    {shortcutLedgerDuplicates.length > 0 ? (
                      <div className="text-[11px] leading-relaxed">
                        账本中已存在同日同金额记录：
                        <strong className="ml-1">
                          {shortcutLedgerDuplicates[0].description} ({shortcutLedgerDuplicates[0].currency || 'MYR'}{' '}
                          {Number(shortcutLedgerDuplicates[0].amount).toFixed(2)} · {shortcutLedgerDuplicates[0].date})
                        </strong>
                        。如果是同一笔交易重复触发，请直接关闭窗口；如果是另一笔真实消费，请点击下方确认按钮。
                      </div>
                    ) : (
                      <div className="text-[11px] leading-relaxed">
                        15 分钟内已收到过相同指纹的快捷指令草稿（ID: <code>{shortcutDraft.suspectedDuplicateOfDraftId}</code>）。请确认是否重复触发。
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => setShortcutDuplicateConfirmed(!shortcutDuplicateConfirmed)}
                      className={`px-3 py-1.5 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
                        shortcutDuplicateConfirmed
                          ? 'border-emerald-500 bg-emerald-600 text-white'
                          : 'border-rose-400 bg-white dark:bg-zinc-900 text-rose-800 dark:text-rose-200'
                      }`}
                    >
                      {shortcutDuplicateConfirmed
                        ? '✓ 已确认：这是另一笔真实消费'
                        : '点击确认：这是另一笔真实消费（非重复提交）'}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Type Selector (Expense / Income / Investment) with Sliding Pill */}
            <div className="relative isolate grid grid-cols-3 gap-1.5 overflow-hidden rounded-2xl bg-white/90 dark:bg-zinc-950/80 p-1 sm:p-1.5 border border-slate-200 dark:border-white/[0.08]">
              <button
                type="button"
                onClick={() => handleTypeChange('Expense')}
                className={`relative z-10 flex min-h-[42px] items-center justify-center gap-1.5 py-2 rounded-xl font-semibold text-xs sm:text-sm transition-colors cursor-pointer touch-manipulation select-none active:scale-[0.96] ${
                  type === 'Expense' ? 'text-rose-800 dark:text-rose-300' : 'text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white'
                }`}
              >
                {type === 'Expense' && (
                  <motion.div
                    layoutId="record-modal-type-indicator"
                    className="absolute inset-0 z-0 rounded-xl bg-rose-500/20 border border-rose-500/40 shadow-sm pointer-events-none"
                    transition={{ type: 'spring' as const, stiffness: 450, damping: 30 }}
                  />
                )}
                <ArrowUpRight className="relative z-10 h-4 w-4 pointer-events-none" />
                <span className="relative z-10 pointer-events-none">Expense</span>
              </button>

              <button
                type="button"
                onClick={() => handleTypeChange('Income')}
                className={`relative z-10 flex min-h-[42px] items-center justify-center gap-1.5 py-2 rounded-xl font-semibold text-xs sm:text-sm transition-colors cursor-pointer touch-manipulation select-none active:scale-[0.96] ${
                  type === 'Income' ? 'text-emerald-800 dark:text-emerald-300' : 'text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white'
                }`}
              >
                {type === 'Income' && (
                  <motion.div
                    layoutId="record-modal-type-indicator"
                    className="absolute inset-0 z-0 rounded-xl bg-emerald-500/20 border border-emerald-500/40 shadow-sm pointer-events-none"
                    transition={{ type: 'spring' as const, stiffness: 450, damping: 30 }}
                  />
                )}
                <ArrowDownRight className="relative z-10 h-4 w-4 pointer-events-none" />
                <span className="relative z-10 pointer-events-none">Income</span>
              </button>

              <button
                type="button"
                onClick={() => handleTypeChange('Investment')}
                className={`relative z-10 flex min-h-[42px] items-center justify-center gap-1.5 py-2 rounded-xl font-semibold text-xs sm:text-sm transition-colors cursor-pointer touch-manipulation select-none active:scale-[0.96] ${
                  type === 'Investment' ? 'text-indigo-800 dark:text-indigo-300' : 'text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white'
                }`}
              >
                {type === 'Investment' && (
                  <motion.div
                    layoutId="record-modal-type-indicator"
                    className="absolute inset-0 z-0 rounded-xl bg-indigo-500/20 border border-indigo-500/40 shadow-sm pointer-events-none"
                    transition={{ type: 'spring' as const, stiffness: 450, damping: 30 }}
                  />
                )}
                <TrendingUp className="relative z-10 h-4 w-4 pointer-events-none" />
                <span className="relative z-10 pointer-events-none">Investment</span>
              </button>
            </div>

            {/* Big Amount Input with dynamic Glow & Interactive Currency Selector */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="record-amount" className="text-xs font-semibold text-slate-700 dark:text-zinc-300 uppercase tracking-wider">Amount ({transactionCurrency})</label>
                {showTripCurrency && (
                  <div className="flex items-center gap-1">
                    {Array.from(
                      new Set([
                        'MYR',
                        ...(selectedTrip?.currency ? [selectedTrip.currency] : []),
                        ...(activeTripForDate?.currency ? [activeTripForDate.currency] : []),
                        ...(suggestedTrip?.currency ? [suggestedTrip.currency] : []),
                        transactionCurrency,
                      ]),
                    ).map((code) => (
                      <button
                        key={code}
                        type="button"
                        onClick={() => setTransactionCurrency(code)}
                        className={`px-2 py-0.5 rounded-lg text-[10px] font-mono font-bold border transition-all cursor-pointer ${
                          transactionCurrency === code
                            ? 'border-indigo-500 bg-indigo-500/20 text-indigo-900 dark:text-indigo-200'
                            : 'border-slate-200 dark:border-zinc-800 bg-white/80 dark:bg-zinc-900 text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-white'
                        }`}
                      >
                        Pay {code}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className={`relative flex items-center rounded-2xl border transition-all duration-300 ${
                type === 'Expense'
                  ? 'border-slate-200 dark:border-white/[0.08] bg-white/90 dark:bg-zinc-900/60 focus-within:border-rose-500/60 focus-within:shadow-[0_0_20px_rgba(244,63,94,0.15)]'
                  : type === 'Income'
                  ? 'border-slate-200 dark:border-white/[0.08] bg-white/90 dark:bg-zinc-900/60 focus-within:border-emerald-500/60 focus-within:shadow-[0_0_20px_rgba(16,185,129,0.15)]'
                  : 'border-slate-200 dark:border-white/[0.08] bg-white/90 dark:bg-zinc-900/60 focus-within:border-indigo-500/60 focus-within:shadow-[0_0_20px_rgba(99,102,241,0.15)]'
              }`}>
                <select
                  aria-label="Transaction currency"
                  value={transactionCurrency}
                  onChange={(e) => setTransactionCurrency(e.target.value)}
                  className="absolute left-3 z-10 rounded-xl bg-slate-100/90 dark:bg-zinc-800/90 px-2 py-1 text-base sm:text-lg font-bold font-mono text-indigo-800 dark:text-indigo-300 border border-slate-200/80 dark:border-white/10 outline-none cursor-pointer hover:border-indigo-500/50"
                >
                  {COMMON_CURRENCIES.map((item) => (
                    <option key={item.code} value={item.code} className="bg-white dark:bg-zinc-900 text-slate-950 dark:text-white text-sm">
                      {item.code}
                    </option>
                  ))}
                </select>
                <input
                  id="record-amount"
                  type="number"
                  step="0.01"
                  required
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="w-full rounded-2xl bg-transparent py-2.5 sm:py-3.5 pl-24 sm:pl-28 pr-4 text-2xl sm:text-3xl font-extrabold font-mono tabular-nums text-slate-950 dark:text-white placeholder-zinc-600 outline-none"
                />
              </div>
              <MoneyCalculator
                value={amount}
                onChange={setAmount}
                currency={transactionCurrency}
              />
            </div>

            {/* Description & Date in compact 2-column row (placed right below Amount) */}
            <div className="grid grid-cols-[1.35fr_1fr] gap-2.5 sm:gap-3">
              <div className="space-y-1.5">
                <label htmlFor="record-description" className="text-xs font-semibold text-slate-700 dark:text-zinc-300 uppercase tracking-wider">Item / Description</label>
                <div className="relative">
                  <input
                    id="record-description"
                    type="text"
                    placeholder="e.g. Nasi Lemak, Petrol..."
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    className="w-full rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/60 py-2.5 px-3 text-sm text-slate-950 dark:text-white placeholder-zinc-500 outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="record-date" className="text-xs font-semibold text-slate-700 dark:text-zinc-300 uppercase tracking-wider">Date</label>
                <div className="relative flex items-center">
                  <input
                    id="record-date"
                    type="date"
                    value={date}
                    onChange={(e) => {
                      setDate(e.target.value);
                      setManualUntagged(false);
                    }}
                    className="w-full rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/60 py-2.5 px-2.5 text-xs sm:text-sm text-slate-950 dark:text-white outline-none focus:border-indigo-500"
                  />
                </div>
              </div>
            </div>

            {/* Category Grid (5 columns so 10 categories fit in 2 rows; switches to TripExpense with Stay & Hotel + Flights when tagged to a trip) */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span id="record-category-label" className="text-xs font-semibold text-slate-700 dark:text-zinc-300 uppercase tracking-wider">Category</span>
                {type === 'Expense' && (tripTag || activeTripForDate || category === 'Stay & Hotel' || category === 'Flights') && (
                  <span className="text-[10px] font-semibold text-indigo-800 dark:text-indigo-300 bg-indigo-500/10 border border-indigo-500/20 px-2 py-0.5 rounded-full">
                    ✈️ Trip Categories Synced (Stay &amp; Flights)
                  </span>
                )}
              </div>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] sm:grid-cols-5 gap-1.5 sm:gap-2">
                {(type === 'Expense' && (tripTag || activeTripForDate || category === 'Stay & Hotel' || category === 'Flights')
                  ? CATEGORIES.TripExpense
                  : CATEGORIES[type]
                ).map((cat) => (
                  <motion.button
                    key={cat.name}
                    type="button"
                    whileHover={{ scale: 1.04 }}
                    whileTap={{ scale: 0.96 }}
                    transition={{ type: 'spring' as const, stiffness: 400, damping: 25 }}
                    onClick={() => handleCategoryChange(cat.name)}
                    aria-pressed={category === cat.name}
                    aria-label={`Select category ${cat.name}`}
                    className={`min-h-[54px] sm:min-h-[58px] flex flex-col items-center justify-center px-1.5 py-2 sm:p-2 rounded-xl sm:rounded-2xl border text-center transition-all cursor-pointer touch-manipulation select-none active:scale-[0.95] ${
                      category === cat.name
                        ? 'border-indigo-500 bg-indigo-500/25 text-slate-950 dark:text-white shadow-[0_0_15px_rgba(99,102,241,0.25)] ring-1 ring-indigo-500/50'
                        : 'border-slate-200 dark:border-white/[0.08] bg-white/90 dark:bg-zinc-900/50 text-slate-700 dark:text-zinc-300 hover:border-slate-300 dark:hover:border-zinc-700 hover:text-slate-950 dark:hover:text-white'
                    }`}
                  >
                    <span className="text-lg sm:text-xl mb-0.5 leading-none">{cat.icon}</span>
                    <span className="text-[clamp(10px,2.6vw,12px)] leading-tight break-words line-clamp-2 w-full font-medium px-0.5">{cat.name}</span>
                  </motion.button>
                ))}
              </div>
            </div>

            {/* Installment Plan Toggle for Expense */}
            {type === 'Expense' && (
              <div className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/40 p-2.5 sm:p-3.5 space-y-2.5">
                <div className="flex items-center justify-between gap-2.5">
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <div className="p-1.5 sm:p-2 rounded-xl bg-purple-500/15 text-violet-800 dark:text-purple-400 border border-purple-500/20 shrink-0">
                      <CreditCard className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <span className="block truncate text-xs font-bold text-slate-950 dark:text-white uppercase tracking-wider">Installment Plan (分期付款)</span>
                      <span className="block text-[10px] text-slate-600 dark:text-zinc-400">Pay over months with or without interest</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={isInstallment}
                    onClick={() => setIsInstallment(!isInstallment)}
                    aria-label="Enable installment plan"
                    className="relative inline-flex min-h-[44px] min-w-[48px] items-center justify-center p-1 cursor-pointer touch-manipulation focus:outline-none shrink-0"
                  >
                    {/* iOS Pill Track */}
                    <span
                      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors duration-200 ease-in-out ${
                        isInstallment
                          ? 'bg-gradient-to-r from-indigo-500 to-purple-600 shadow-md shadow-purple-500/30'
                          : 'bg-slate-100 dark:bg-zinc-800 border border-slate-200 dark:border-white/[0.08]'
                      }`}
                    >
                      {/* Sliding Knob */}
                      <span
                        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition duration-200 ease-in-out ${
                          isInstallment ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </span>
                  </button>
                </div>

                {isInstallment && (
                  <div className="space-y-3 pt-2 border-t border-slate-200 dark:border-zinc-800/80">
                    {/* First Payment Starts / Timing */}
                    <div className="p-3 rounded-2xl bg-purple-950/20 border border-purple-500/25 space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-1.5">
                        <label className="text-[11px] font-bold text-violet-800 dark:text-purple-300 uppercase tracking-wider block">
                          First Payment Starts
                        </label>
                        <div className="flex flex-wrap items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => setFirstPaymentDate(date)}
                            className={`px-2 py-0.5 rounded-lg text-[10px] font-semibold border transition-all cursor-pointer ${
                              firstPaymentDate === date
                                ? 'border-purple-500 bg-purple-500/30 text-violet-800 dark:text-purple-200'
                                : 'border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-slate-600 dark:text-zinc-400 hover:text-slate-800 dark:hover:text-zinc-200'
                            }`}
                          >
                            Same as Purchase
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              try {
                                const d = parseLocalDate(date || getLocalDateString());
                                const nextM = shiftMonthSafe(d, 1);
                                setFirstPaymentDate(getLocalDateString(nextM));
                              } catch {
                                const d = shiftMonthSafe(new Date(), 1);
                                setFirstPaymentDate(getLocalDateString(d));
                              }
                            }}
                            className={`px-2 py-0.5 rounded-lg text-[10px] font-semibold border transition-all cursor-pointer ${
                              firstPaymentDate !== date
                                ? 'border-purple-500 bg-purple-500/30 text-violet-800 dark:text-purple-200'
                                : 'border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-slate-600 dark:text-zinc-400 hover:text-slate-800 dark:hover:text-zinc-200'
                            }`}
                          >
                            📅 Start Next Month
                          </button>
                        </div>
                      </div>
                      <input
                        type="date"
                        value={firstPaymentDate}
                        onChange={(e) => setFirstPaymentDate(e.target.value)}
                        className="w-full rounded-xl border border-slate-300 dark:border-zinc-700 bg-white/90 dark:bg-zinc-900/90 px-3 py-1.5 text-xs text-slate-950 dark:text-white font-mono outline-none focus:border-purple-400"
                      />
                    </div>

                    {/* Duration / Tenure */}
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-semibold text-slate-600 dark:text-zinc-400 uppercase tracking-wider block">Tenure (Months)</label>
                       <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
                         {INSTALLMENT_PRESET_MONTHS.map((m) => (
                          <button
                            key={m}
                            type="button"
                             onClick={() => {
                               setInstallmentMonths(m);
                               setCustomInstallmentMonths('');
                             }}
                             aria-pressed={installmentMonths === m && customInstallmentMonths === ''}
                             className={`min-h-[44px] rounded-xl text-xs font-bold border transition-all cursor-pointer touch-manipulation ${
                               installmentMonths === m && customInstallmentMonths === ''
                                ? 'border-purple-500 bg-purple-600 text-white dark:text-white shadow-sm'
                                : 'border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/60 text-slate-600 dark:text-zinc-400 hover:border-slate-300 dark:hover:border-zinc-700 hover:text-slate-950 dark:hover:text-white'
                            }`}
                          >
                            {m}M
                          </button>
                        ))}
                      </div>
                      <div className="mt-2 flex items-center gap-2">
                        <label htmlFor="record-custom-installment-months" className="sr-only">Custom installment duration in months</label>
                        <input
                          id="record-custom-installment-months"
                          type="number"
                          inputMode="numeric"
                          min={MIN_INSTALLMENT_MONTHS}
                          max={MAX_INSTALLMENT_MONTHS}
                          step="1"
                          placeholder="Custom months"
                          value={customInstallmentMonths}
                          onChange={(e) => {
                            const next = e.target.value;
                            setCustomInstallmentMonths(next);
                          }}
                          className="min-h-[44px] w-full rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/60 px-3 py-2 text-sm text-slate-950 dark:text-white font-mono outline-none transition-colors placeholder:text-slate-600 dark:placeholder:text-zinc-300 focus:border-purple-500"
                        />
                        <span className="shrink-0 text-xs text-slate-500 dark:text-zinc-400">months</span>
                      </div>
                      <p className="text-[10px] text-slate-500 dark:text-zinc-400">Choose a preset or enter any whole number from {MIN_INSTALLMENT_MONTHS}–{MAX_INSTALLMENT_MONTHS} months.</p>
                    </div>

                    {/* Interest Mode */}
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                        <span className="text-slate-600 dark:text-zinc-400 font-medium">Interest Option</span>
                        <div className="flex flex-wrap items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              setHasInterest(false);
                              setInstallmentInterestRate('0');
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
                            With Interest / Fee
                          </button>
                        </div>
                      </div>

                      {hasInterest && (
                        <div className="relative flex items-center">
                          <Percent className="absolute left-3 h-3.5 w-3.5 text-slate-500 dark:text-zinc-400" />
                          <input
                            type="number"
                            step="0.01"
                            placeholder="Annual Interest Rate % (e.g. 3.0)"
                            value={installmentInterestRate}
                            onChange={(e) => setInstallmentInterestRate(e.target.value)}
                            className="w-full rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/80 py-2 pl-9 pr-3 text-xs text-slate-950 dark:text-white font-mono outline-none focus:border-purple-500"
                          />
                        </div>
                      )}
                    </div>

                    {/* Live Calculation Preview Card */}
                    {installmentPlan && parsedPrincipal > 0 && (
                      <div className="rounded-xl bg-purple-950/20 border border-purple-500/25 p-3 space-y-2">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-slate-700 dark:text-zinc-300 font-medium">Monthly Installment</span>
                          <span className="font-extrabold font-mono text-violet-800 dark:text-purple-400 text-sm">
                            {transactionCurrency} {installmentPlan.monthlyAmount.toFixed(2)} / mo
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-slate-600 dark:text-zinc-400 font-medium">Total Payable ({effectiveInstallmentMonths} Months)</span>
                          <span className="font-bold font-mono text-slate-950 dark:text-white">
                            {transactionCurrency} {installmentPlan.totalPayable.toFixed(2)}
                            {hasInterest && installmentPlan.totalInterest > 0 && (
                              <span className="text-[10px] text-slate-600 dark:text-zinc-400 font-normal ml-1">
                                (incl. +{transactionCurrency} {installmentPlan.totalInterest.toFixed(2)} interest)
                              </span>
                            )}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-[11px] pt-1 border-t border-purple-500/20 text-slate-600 dark:text-zinc-400">
                          <span>Timeline</span>
                          <span className="min-w-0 text-right font-semibold text-violet-800 dark:text-purple-300 font-mono">
                            {installmentPlan.schedule[0]?.month} ➔ {installmentPlan.schedule[installmentPlan.schedule.length - 1]?.month}
                          </span>
                        </div>
                        <p className="text-[10px] text-slate-600 dark:text-zinc-400 italic pt-0.5">
                          ✨ Month 1 will be recorded now. Months 2 to {effectiveInstallmentMonths} will be scheduled across future month tabs in Google Sheets.
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Investment Context & Smart Helpers */}
            {type === 'Investment' && (
              <div className="space-y-3">
                {/* Stock/Crypto Guidance Banner */}
                <div className="flex items-center justify-between p-3 rounded-2xl bg-indigo-500/10 border border-indigo-500/25 text-xs text-indigo-800 dark:text-indigo-300">
                  <div className="flex items-center gap-2">
                    <TrendingUp className="h-4 w-4 text-indigo-800 dark:text-indigo-400 shrink-0" />
                    <span>Trading US Stocks, Bursa or Crypto?</span>
                  </div>
                  <Link
                    href="/investments"
                    onClick={closeModal}
                    className="font-bold text-indigo-800 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 flex items-center gap-0.5 underline underline-offset-2 shrink-0 cursor-pointer"
                  >
                    Go to Investments <ChevronRight className="h-3 w-3" />
                  </Link>
                </div>

                {/* Fixed Deposit Smart Calculator & Terms */}
                {category === 'Fixed Deposit' && (
                  <div className="rounded-2xl border border-indigo-500/30 bg-indigo-950/20 p-4 space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Lock className="h-4 w-4 text-indigo-800 dark:text-indigo-400" />
                        <span className="text-xs font-bold text-slate-950 dark:text-white uppercase tracking-wider">Fixed Deposit Terms</span>
                      </div>
                      <span className="text-[11px] font-semibold text-indigo-800 dark:text-indigo-400 bg-indigo-500/10 px-2.5 py-0.5 rounded-full border border-indigo-500/20">
                        Smart Calculator
                      </span>
                    </div>

                    {/* Bank Selection */}
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-semibold text-slate-600 dark:text-zinc-400 uppercase tracking-wider block">Bank / Institution</label>
                      <div className="flex flex-wrap gap-1.5">
                        {FD_BANKS.map((b) => (
                          <button
                            key={b}
                            type="button"
                            onClick={() => handleFdBankChange(b)}
                            className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors cursor-pointer ${
                              fdBank === b
                                ? 'border-indigo-500 bg-indigo-500/20 text-indigo-800 dark:text-indigo-300'
                                : 'border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/60 text-slate-600 dark:text-zinc-400 hover:border-slate-300 dark:hover:border-zinc-700'
                            }`}
                          >
                            {b}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Tenure Selection */}
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-semibold text-slate-600 dark:text-zinc-400 uppercase tracking-wider block">Duration / Tenure</label>
                      <div className="grid grid-cols-4 gap-2">
                        {FD_TENURES.map((t) => (
                          <button
                            key={t.label}
                            type="button"
                            onClick={() => handleFdTenureChange(t.months)}
                            className={`py-2 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
                              fdTenureMonths === t.months
                                ? 'border-indigo-500 bg-indigo-500 text-white dark:text-white shadow-sm'
                                : 'border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/60 text-slate-600 dark:text-zinc-400 hover:border-slate-300 dark:hover:border-zinc-700 hover:text-slate-950 dark:hover:text-white'
                            }`}
                          >
                            {t.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Interest Rate Input */}
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-semibold text-slate-600 dark:text-zinc-400 uppercase tracking-wider block">Interest Rate (% p.a.)</label>
                      <div className="relative flex items-center">
                        <Percent className="absolute left-3 h-3.5 w-3.5 text-slate-500 dark:text-zinc-400" />
                        <input
                          type="number"
                          step="0.01"
                          placeholder="3.85"
                          value={fdInterestRate}
                          onChange={(e) => handleFdRateChange(e.target.value)}
                          className="w-full rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/80 py-2 pl-9 pr-3 text-sm text-slate-950 dark:text-white font-mono outline-none focus:border-indigo-500"
                        />
                      </div>
                    </div>

                    {/* FD Computation Result Card */}
                    <div className="rounded-xl bg-white/90 dark:bg-zinc-900/80 border border-slate-200 dark:border-zinc-800/80 p-3 space-y-2">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-slate-600 dark:text-zinc-400 font-medium">Expected Interest Return</span>
                        <span className="font-bold font-mono text-emerald-800 dark:text-emerald-400">
                          +{transactionCurrency} {expectedInterest.toFixed(2)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-slate-600 dark:text-zinc-400 font-medium">Total at Maturity</span>
                        <span className="font-bold font-mono text-slate-950 dark:text-white">
                          {transactionCurrency} {maturityAmount.toFixed(2)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-xs pt-1 border-t border-slate-200 dark:border-zinc-800">
                        <span className="text-slate-600 dark:text-zinc-400 font-medium flex items-center gap-1">
                          <Calendar className="h-3 w-3 text-indigo-800 dark:text-indigo-400" /> Maturity Date
                        </span>
                        <span className="font-semibold text-indigo-800 dark:text-indigo-300 font-mono">
                          {fdMaturityDate || 'N/A'}
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                {/* ASNB / Unit Trust selector */}
                {category === 'ASNB / Unit Trust' && (
                  <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/40 p-3.5 space-y-2">
                    <label className="text-[11px] font-semibold text-slate-600 dark:text-zinc-400 uppercase tracking-wider block">Select ASNB / Unit Trust Fund</label>
                    <div className="flex flex-wrap gap-1.5">
                      {ASNB_FUNDS.map((f) => (
                        <button
                          key={f}
                          type="button"
                          onClick={() => handleAsnbFundChange(f)}
                          className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all cursor-pointer ${
                            asnbFund === f
                              ? 'border-indigo-500 bg-indigo-500/20 text-indigo-800 dark:text-indigo-300'
                              : 'border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-slate-600 dark:text-zinc-400 hover:border-slate-300 dark:hover:border-zinc-700'
                          }`}
                        >
                          {f}
                        </button>
                      ))}
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-zinc-400 pt-1">
                      💡 Tip: When ASNB declares dividend, record it under <span className="text-indigo-800 dark:text-indigo-400 font-semibold">Investments &gt; Buy/Sell Stock</span> with Action <span className="text-emerald-800 dark:text-emerald-400 font-semibold">DIVIDEND</span> and toggle <span className="text-slate-950 dark:text-white font-medium">Reinvest</span> to automatically add units to your holdings!
                    </p>
                  </div>
                )}

                {/* EPF / KWSP selector */}
                {category === 'EPF / KWSP' && (
                  <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/40 p-3.5 space-y-2">
                    <label className="text-[11px] font-semibold text-slate-600 dark:text-zinc-400 uppercase tracking-wider block">EPF / KWSP Account Type</label>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      {EPF_ACCOUNTS.map((acc) => (
                        <button
                          key={acc}
                          type="button"
                          onClick={() => handleEpfAccountChange(acc)}
                          className={`p-2.5 rounded-xl text-xs font-semibold border text-center transition-all cursor-pointer ${
                            epfAccount === acc
                              ? 'border-indigo-500 bg-indigo-500/20 text-indigo-800 dark:text-indigo-300 shadow-sm'
                              : 'border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-slate-600 dark:text-zinc-400 hover:border-slate-300 dark:hover:border-zinc-700'
                          }`}
                        >
                          {acc}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Emergency Savings Guide */}
                {category === 'Emergency Savings' && (
                  <div className="rounded-2xl border border-emerald-500/20 bg-emerald-950/20 p-3.5 space-y-1.5">
                    <div className="flex items-center gap-1.5 text-xs font-bold text-emerald-800 dark:text-emerald-400">
                      <ShieldCheck className="h-4 w-4" />
                      <span>Emergency Safety Net</span>
                    </div>
                    <p className="text-[11px] text-slate-700 dark:text-zinc-300 leading-relaxed">
                      Emergency savings should ideally cover 3–6 months of living expenses in an easily accessible liquid account (e.g. GXBank, Rize, KDI Save, Boost Bank, High-Yield Savings). Every ringgit added here builds your financial fortress!
                    </p>
                  </div>
                )}
              </div>
            )}

            {showTripCurrency && (
              <div className="space-y-2">
                <label htmlFor="record-currency" className="text-xs font-medium text-slate-600 dark:text-zinc-400 uppercase tracking-wider">{editTransaction ? 'Currency' : 'Trip currency'}</label>
                <select id="record-currency" value={transactionCurrency} onChange={(e) => setTransactionCurrency(e.target.value)} className="min-h-[44px] w-full rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/60 py-2.5 px-3 text-sm text-slate-950 dark:text-white outline-none focus:border-indigo-500">
                  {COMMON_CURRENCIES.map((item) => <option key={item.code} value={item.code}>{item.code} - {item.name}</option>)}
                </select>
                <p className="text-[11px] text-slate-500 dark:text-zinc-400">The amount and currency are saved as entered. No automatic conversion is written to the sheet.</p>
              </div>
            )}

            {/* Smart Trip Tagging: shown only when suggested or manually selected */}
            {tripsList.length > 0 && (suggestedTrip || tripTag) && (
              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-600 dark:text-zinc-400 uppercase tracking-wider flex items-center justify-between">
                  <span className="flex items-center gap-1.5">
                    <Plane className="h-3.5 w-3.5 text-indigo-800 dark:text-indigo-400" />
                    <span>Trip Sync & Tagging</span>
                  </span>
                  {tripTag && (
                    <span className="text-[11px] text-indigo-800 dark:text-indigo-400 font-semibold font-mono">
                      Tagged: {tripTag}
                    </span>
                  )}
                </label>

                {/* Case 1: In-Trip Date Auto-Detect (e.g. 20/9 - 30/9 Chengdu Trip) */}
                {suggestedTrip ? (
                  <div className="p-3.5 rounded-2xl bg-indigo-500/10 border border-indigo-500/30 space-y-2">
                    <label className="flex items-start gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={tripTag === suggestedTrip.name}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setTripTag(suggestedTrip.name);
                            setManualUntagged(false);
                            if (suggestedTrip.currency) {
                              setTransactionCurrency(suggestedTrip.currency);
                            }
                          } else {
                            setTripTag('');
                            setManualUntagged(true);
                            setTransactionCurrency('MYR');
                          }
                        }}
                        className="h-4 w-4 mt-0.5 rounded accent-indigo-500 cursor-pointer"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                            <span className="text-xs font-bold text-slate-950 dark:text-white">
                            Tag to {suggestedTrip.name}
                          </span>
                          <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-indigo-500/20 text-indigo-800 dark:text-indigo-300 border border-indigo-500/30">
                            Active Trip
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-600 dark:text-zinc-400 mt-0.5 leading-relaxed">
                          This looks related to {suggestedTrip.destination || 'your trip'} ({suggestedTrip.startDate} ~ {suggestedTrip.endDate || suggestedTrip.startDate}). Uncheck if it is personal.
                        </p>
                      </div>
                    </label>
                  </div>
                ) : null}
                {/* Dropdown for manually picking any other trip or personal */}
                <div className="pt-1">
                  <select
                    value={tripTag}
                    onChange={(e) => {
                      const nextVal = e.target.value;
                      setTripTag(nextVal);
                      if (!nextVal) {
                        setManualUntagged(true);
                        setTransactionCurrency('MYR');
                      } else {
                        setManualUntagged(false);
                        const picked = tripsList.find((t) => t.name === nextVal);
                        if (picked?.currency) {
                          setTransactionCurrency(picked.currency);
                        }
                      }
                    }}
                    className="w-full rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/60 py-2.5 px-3 text-xs text-slate-700 dark:text-zinc-300 outline-none focus:border-indigo-500"
                  >
                    <option value="">None (Personal / Non-Trip Expense)</option>
                    {tripsList.map((t) => (
                      <option key={t.id || t.name} value={t.name}>
                        ✈️ {t.name} {t.startDate ? `(${t.startDate})` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {/* Subtle button to manually tag trip if not auto-detected */}
            {tripsList.length > 0 && !suggestedTrip && !tripTag && (
              <div className="pt-0.5">
                <button
                  type="button"
                  onClick={() => {
                    setTripTag(tripsList[0].name);
                    setManualUntagged(false);
                  }}
                  className="text-xs text-slate-600 dark:text-zinc-400 hover:text-indigo-800 dark:hover:text-indigo-400 flex items-center gap-1.5 transition-colors cursor-pointer"
                >
                  <Plane className="h-3.5 w-3.5 text-slate-500 dark:text-zinc-400" />
                  <span>+ Tag to a trip (optional)</span>
                </button>
              </div>
            )}

            {/* Malaysia LHDN Personal Tax Relief Assistant */}
            {(type === 'Expense' || type === 'Investment') && (
              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-600 dark:text-zinc-400 uppercase tracking-wider flex items-center justify-between">
                  <span className="flex items-center gap-1.5">
                    <Landmark className="h-3.5 w-3.5 text-emerald-800 dark:text-emerald-400" />
                    <span>🇲🇾 Malaysia LHDN Tax Relief (YA {assessmentYear})</span>
                  </span>
                  {activeTaxCategory && activeTaxQuotaInfo ? (
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase ${
                      activeTaxQuotaInfo.isAlreadyFull
                        ? 'bg-rose-500/20 text-rose-800 dark:text-rose-300 border border-rose-500/30'
                        : activeTaxQuotaInfo.exceedsRemaining
                        ? 'bg-amber-500/20 text-amber-800 dark:text-amber-300 border border-amber-500/30'
                        : 'bg-emerald-500/20 text-emerald-800 dark:text-emerald-300 border border-emerald-500/30'
                    }`}>
                      {activeTaxQuotaInfo.isAlreadyFull
                        ? `Quota Full (RM ${activeTaxQuotaInfo.limit})`
                        : `Eligible • RM ${activeTaxQuotaInfo.remainingBefore.toFixed(0)} Left`}
                    </span>
                  ) : purchaseTaxAnalysis.nonQualifyingWarning ? (
                    <span className="text-[10px] px-2 py-0.5 rounded-full font-bold uppercase bg-amber-500/20 text-amber-800 dark:text-amber-300 border border-amber-500/30">
                      Not Eligible
                    </span>
                  ) : (
                    <span className="text-[10px] text-slate-500 dark:text-zinc-400 font-medium">
                      Not tax-deductible
                    </span>
                  )}
                </label>

                {activeTaxCategory && activeTaxQuotaInfo ? (
                  <div className={`p-3.5 rounded-2xl border space-y-3 ${
                    activeTaxQuotaInfo.isAlreadyFull
                      ? 'bg-rose-950/15 border-rose-500/30'
                      : activeTaxQuotaInfo.exceedsRemaining
                      ? 'bg-amber-950/15 border-amber-500/30'
                      : 'bg-emerald-950/15 border-emerald-500/30'
                  }`}>
                    {/* Checkbox + Category Header */}
                    <label className="flex items-start gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={Boolean(selectedTaxCategoryId)}
                        onChange={(e) => {
                          if (!e.target.checked) {
                            setSelectedTaxCategoryId('');
                            setManualTaxOverride(true);
                          }
                        }}
                        className="h-4 w-4 mt-0.5 rounded accent-emerald-500 cursor-pointer"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-xs font-bold text-slate-950 dark:text-white">
                            {activeTaxCategory.icon} {activeTaxCategory.name}
                          </span>
                          <span className="text-[10px] text-slate-600 dark:text-zinc-400 font-mono">
                            (Cap: RM {activeTaxQuotaInfo.limit.toFixed(0)}/yr)
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-700 dark:text-zinc-300 mt-0.5 leading-relaxed">
                          {activeTaxCategory.qualifies}
                        </p>
                      </div>
                    </label>

                    {/* Live Quota Progress Bar (same design as BudgetPage) */}
                    <div className="rounded-xl bg-white/90 dark:bg-zinc-950/70 border border-slate-200 dark:border-zinc-800/80 p-3 space-y-2">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-slate-600 dark:text-zinc-400">
                          Claimed in {assessmentYear}: <strong className="text-slate-950 dark:text-white font-mono">RM {activeTaxQuotaInfo.usedBefore.toFixed(2)}</strong> / RM {activeTaxQuotaInfo.limit.toFixed(0)}
                        </span>
                        <span className={`font-mono font-bold ${
                          activeTaxQuotaInfo.isAlreadyFull ? 'text-rose-800 dark:text-rose-400' : 'text-emerald-800 dark:text-emerald-400'
                        }`}>
                          RM {activeTaxQuotaInfo.remainingBefore.toFixed(2)} quota left
                        </span>
                      </div>

                      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-zinc-800">
                        <div
                          className={`h-full rounded-full transition-all duration-500 ${
                            activeTaxQuotaInfo.isAlreadyFull
                              ? 'bg-rose-500'
                              : activeTaxQuotaInfo.percentAfter > 85
                              ? 'bg-amber-400'
                              : 'bg-emerald-500'
                          }`}
                          style={{ width: `${Math.min(activeTaxQuotaInfo.percentAfter, 100)}%` }}
                        />
                      </div>

                      {activeTaxQuotaInfo.currentPurchaseRm > 0 && (
                        <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-slate-200 dark:border-zinc-800/80 text-[11px]">
                          <span className="text-slate-700 dark:text-zinc-300">
                            This purchase can deduct:{' '}
                            <strong className={activeTaxQuotaInfo.claimableThisTx > 0 ? 'text-emerald-800 dark:text-emerald-400 font-mono' : 'text-rose-800 dark:text-rose-400 font-mono'}>
                              RM {activeTaxQuotaInfo.claimableThisTx.toFixed(2)}
                            </strong>
                            {activeTaxQuotaInfo.exceedsRemaining && (
                              <span className="text-amber-800 dark:text-amber-300 text-[10px] ml-1">
                                (capped at remaining limit)
                              </span>
                            )}
                          </span>
                          <span className="text-slate-600 dark:text-zinc-400 font-mono">
                            After this: <strong className="text-slate-800 dark:text-zinc-200">RM {activeTaxQuotaInfo.remainingAfter.toFixed(2)} left</strong>
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Smart Receipt Save Reminder */}
                    {activeTaxQuotaInfo.isAlreadyFull ? (
                      <div className="p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/25 text-[11px] text-rose-800 dark:text-rose-200 leading-relaxed">
                        ⚠️ Your YA {assessmentYear} limit (RM {activeTaxQuotaInfo.limit.toFixed(0)}) for {activeTaxCategory.shortName} is already maxed out. You do not need to save this receipt for tax relief.
                      </div>
                    ) : !receiptPreview ? (
                      <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 flex flex-wrap items-center justify-between gap-2">
                        <div className="text-[11px] text-amber-800 dark:text-amber-200 leading-relaxed flex-1 min-w-[180px]">
                          <strong className="text-amber-800 dark:text-amber-300">📸 Save receipt now!</strong> You still have RM {activeTaxQuotaInfo.remainingBefore.toFixed(0)} tax limit left. Snap/upload below so you won&apos;t lose it when filing e-Filing.
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => cameraInputRef.current?.click()}
                            className="px-2.5 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/35 text-amber-800 dark:text-amber-200 text-[11px] font-semibold flex items-center gap-1 cursor-pointer"
                          >
                            <Camera className="h-3 w-3" />
                            <span>Snap</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => fileInputRef.current?.click()}
                            className="px-2.5 py-1.5 rounded-lg bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 border border-slate-300 dark:border-zinc-700 text-slate-800 dark:text-zinc-200 text-[11px] font-semibold flex items-center gap-1 cursor-pointer"
                          >
                            <Upload className="h-3 w-3" />
                            <span>Upload</span>
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/25 text-[11px] text-emerald-800 dark:text-emerald-300 flex items-center gap-2">
                        <Check className="h-3.5 w-3.5 shrink-0 text-emerald-800 dark:text-emerald-400" />
                        <span>
                          Receipt attached! Will be indexed under <strong>Invoices &amp; Claims → LHDN Tax Relief</strong>.
                        </span>
                      </div>
                    )}

                    {/* Category Switcher Dropdown */}
                    <select
                      value={selectedTaxCategoryId}
                      onChange={(e) => {
                        setSelectedTaxCategoryId(e.target.value);
                        setManualTaxOverride(true);
                      }}
                      className="w-full rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/80 py-2 px-3 text-xs text-slate-800 dark:text-zinc-200 outline-none focus:border-emerald-500"
                    >
                      <option value="">None (Do Not Claim Tax Relief)</option>
                      {LHDN_TAX_CATEGORIES.map((cat) => {
                        const prog = yearlyTaxSummary.byCategoryId[cat.id];
                        const rem = prog ? prog.remainingQuota : cat.defaultLimit;
                        const lim = prog ? prog.limit : cat.defaultLimit;
                        return (
                          <option key={cat.id} value={cat.id}>
                            {cat.icon} {cat.name} — RM {rem.toFixed(0)} left of RM {lim.toFixed(0)}
                          </option>
                        );
                      })}
                    </select>
                  </div>
                ) : purchaseTaxAnalysis.nonQualifyingWarning ? (
                  <div className="p-3.5 rounded-2xl bg-amber-950/15 border border-amber-500/30 space-y-2.5">
                    <div className="text-xs font-bold text-amber-800 dark:text-amber-300 flex items-center gap-1.5">
                      <span>⚠️ Not Eligible for LHDN Tax Relief</span>
                    </div>
                    <p className="text-[11px] text-slate-700 dark:text-zinc-300 leading-relaxed">
                      {purchaseTaxAnalysis.nonQualifyingWarning}
                    </p>
                    <select
                      value={selectedTaxCategoryId}
                      onChange={(e) => {
                        setSelectedTaxCategoryId(e.target.value);
                        setManualTaxOverride(true);
                      }}
                      className="w-full rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/80 py-2 px-3 text-xs text-slate-700 dark:text-zinc-300 outline-none focus:border-indigo-500"
                    >
                      <option value="">Keep as Non-Deductible Expense</option>
                      {LHDN_TAX_CATEGORIES.map((cat) => {
                        const prog = yearlyTaxSummary.byCategoryId[cat.id];
                        const rem = prog ? prog.remainingQuota : cat.defaultLimit;
                        const lim = prog ? prog.limit : cat.defaultLimit;
                        return (
                          <option key={cat.id} value={cat.id}>
                            Override: {cat.icon} {cat.name} (RM {rem.toFixed(0)} / RM {lim.toFixed(0)} left)
                          </option>
                        );
                      })}
                    </select>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <select
                      value={selectedTaxCategoryId}
                      onChange={(e) => {
                        setSelectedTaxCategoryId(e.target.value);
                        setManualTaxOverride(true);
                      }}
                      className="w-full rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/60 py-2.5 px-3 text-xs text-slate-700 dark:text-zinc-300 outline-none focus:border-indigo-500"
                    >
                      <option value="">
                        {category === 'Food & Dining' || category === 'Entertainment'
                          ? 'None — Everyday food & entertainment are not tax-deductible'
                          : 'None — Auto-detects when you type item (or select LHDN category manually)'}
                      </option>
                      {LHDN_TAX_CATEGORIES.map((cat) => {
                        const prog = yearlyTaxSummary.byCategoryId[cat.id];
                        const rem = prog ? prog.remainingQuota : cat.defaultLimit;
                        const lim = prog ? prog.limit : cat.defaultLimit;
                        return (
                          <option key={cat.id} value={cat.id}>
                            {cat.icon} {cat.name} — RM {rem.toFixed(0)} left of RM {lim.toFixed(0)}
                          </option>
                        );
                      })}
                    </select>
                  </div>
                )}
              </div>
            )}

            {/* Malaysia LHDN Payslip PCB, EPF & SOCSO Tracker when recording Salary / Bonus Income */}
            {type === 'Income' && (category === 'Salary' || category === 'Gift & Bonus') && (
              <div className="rounded-2xl border border-emerald-500/25 bg-emerald-950/10 p-3.5 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-xs font-bold text-slate-950 dark:text-white uppercase tracking-wider">
                    <Landmark className="h-3.5 w-3.5 text-emerald-800 dark:text-emerald-400" />
                    <span>🇲🇾 Payslip PCB, EPF &amp; SOCSO Tracker (Optional)</span>
                  </span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-emerald-500/20 text-emerald-800 dark:text-emerald-300 border border-emerald-500/30">
                    YA {assessmentYear} e-Filing
                  </span>
                </div>
                <p className="text-[11px] text-slate-700 dark:text-zinc-300 leading-relaxed">
                  Enter your monthly <strong>PCB</strong>, <strong>EPF (KWSP, max RM 4,000/yr)</strong>, and <strong>SOCSO &amp; EIS (PERKESO, max RM 350/yr)</strong> separately so CashFlow can estimate your LHDN tax refund or extra tax payable without double-counting standalone EPF/SOCSO transactions.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  <div className="space-y-1">
                    <label className="text-[10px] font-semibold text-slate-600 dark:text-zinc-400 uppercase tracking-wider block">
                      PCB Deducted (RM)
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="e.g. 180.00"
                      value={payslipPcb}
                      onChange={(e) => setPayslipPcb(e.target.value)}
                      className="w-full rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/80 py-2 px-3 text-xs font-mono text-slate-950 dark:text-white placeholder-zinc-600 outline-none focus:border-emerald-500"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-semibold text-slate-600 dark:text-zinc-400 uppercase tracking-wider block">
                      Employee EPF / KWSP (RM)
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="e.g. 550.00"
                      value={payslipEpf}
                      onChange={(e) => setPayslipEpf(e.target.value)}
                      className="w-full rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/80 py-2 px-3 text-xs font-mono text-slate-950 dark:text-white placeholder-zinc-600 outline-none focus:border-emerald-500"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-semibold text-slate-600 dark:text-zinc-400 uppercase tracking-wider block">
                      Employee SOCSO &amp; EIS (RM)
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="e.g. 29.65"
                      value={payslipSocso}
                      onChange={(e) => setPayslipSocso(e.target.value)}
                      className="w-full rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/80 py-2 px-3 text-xs font-mono text-slate-950 dark:text-white placeholder-zinc-600 outline-none focus:border-emerald-500"
                    />
                  </div>
                </div>
                {((parseFloat(payslipPcb) || 0) + (parseFloat(payslipEpf) || 0) + (parseFloat(payslipSocso) || 0)) > 0 && (parseFloat(amount) || 0) > 0 && (
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-emerald-500/20 text-[11px]">
                    <span className="text-slate-600 dark:text-zinc-400 font-mono">
                      Total Deductions: RM {((parseFloat(payslipPcb) || 0) + (parseFloat(payslipEpf) || 0) + (parseFloat(payslipSocso) || 0)).toFixed(2)}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        const gross = parseFloat(amount) || 0;
                        const totalDeduct = (parseFloat(payslipPcb) || 0) + (parseFloat(payslipEpf) || 0) + (parseFloat(payslipSocso) || 0);
                        const net = Math.max(0, Number((gross - totalDeduct).toFixed(2)));
                        setAmount(String(net));
                        toast.success(`Deducted RM ${totalDeduct.toFixed(2)} from RM ${gross.toFixed(2)} → Net RM ${net.toFixed(2)}`);
                      }}
                      className="rounded-xl border border-emerald-500/40 bg-emerald-500/15 hover:bg-emerald-500/25 px-2.5 py-1 font-mono font-bold text-emerald-800 dark:text-emerald-300 transition-colors cursor-pointer"
                    >
                      − Deduct from Gross Amount (Net: RM {Math.max(0, (parseFloat(amount) || 0) - ((parseFloat(payslipPcb) || 0) + (parseFloat(payslipEpf) || 0) + (parseFloat(payslipSocso) || 0))).toFixed(2)})
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Receipt / Invoice Photo Upload */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-600 dark:text-zinc-400 uppercase tracking-wider flex items-center justify-between">
                <span>Receipt / Invoice Photo (Google Drive)</span>
                {receiptFile && <span className="text-emerald-800 dark:text-emerald-400 text-xs">Attached</span>}
              </label>

              {/* Camera Input (capture="environment") */}
              <input
                type="file"
                ref={cameraInputRef}
                accept="image/*"
                capture="environment"
                onChange={handleFileSelect}
                className="hidden"
              />

              {/* Gallery / File Picker (NO capture, allows Photo Library / Files selection) */}
              <input
                type="file"
                ref={fileInputRef}
                accept="image/*,application/pdf"
                onChange={handleFileSelect}
                className="hidden"
              />

              {!receiptPreview ? (
                <div className="grid grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    onClick={() => cameraInputRef.current?.click()}
                    className="rounded-xl border border-dashed border-slate-200 dark:border-zinc-800 hover:border-indigo-500/50 bg-white/90 dark:bg-zinc-900/30 p-2.5 sm:p-3.5 flex items-center justify-center gap-2 text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white transition-all cursor-pointer"
                  >
                    <Camera className="h-4 w-4 sm:h-5 sm:w-5 text-indigo-800 dark:text-indigo-400 shrink-0" />
                    <span className="text-xs font-semibold">Take Photo</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="rounded-xl border border-dashed border-slate-200 dark:border-zinc-800 hover:border-indigo-500/50 bg-white/90 dark:bg-zinc-900/30 p-2.5 sm:p-3.5 flex items-center justify-center gap-2 text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white transition-all cursor-pointer"
                  >
                    <Upload className="h-4 w-4 sm:h-5 sm:w-5 text-violet-800 dark:text-purple-400 shrink-0" />
                    <span className="text-xs font-semibold">Upload Receipt</span>
                  </button>
                </div>
              ) : (
                <div className="relative flex items-center gap-3 p-3 rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/50">
                  <div 
                    onClick={() => setShowReceiptModal(true)}
                    className="relative cursor-pointer group shrink-0"
                    title="Click to view full receipt"
                  >
                    <img
                      src={receiptPreview}
                      alt="Receipt preview"
                      className="h-16 w-16 rounded-xl object-cover border border-slate-300 dark:border-zinc-700 group-hover:opacity-80 transition-opacity"
                    />
                    <div className="absolute inset-0 flex items-center justify-center bg-black/40 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity">
                      <Eye className="h-5 w-5 text-slate-950 dark:text-white" />
                    </div>
                  </div>
                   <div
                     className="flex-1 min-w-0 cursor-pointer"
                    onClick={() => setShowReceiptModal(true)}
                  >
                    <p className="text-sm font-medium text-slate-950 dark:text-white truncate">{receiptFile?.name || (editTransaction ? 'Attached Receipt' : 'Photo Receipt')}</p>
                     <p className="text-xs text-slate-500 dark:text-zinc-400">{receiptPreview.startsWith('http') ? 'Saved in Google Drive' : 'Optimized & ready to save (Click to view full size)'}</p>
                   </div>
                   {receiptFile && receiptFile.type.startsWith('image/') && !receiptPreview.startsWith('http') && (
                     <button
                       type="button"
                       onClick={() => void handleScanReceipt()}
                       disabled={isScanningReceipt}
                       className="inline-flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-xl border border-indigo-500/30 bg-indigo-500/10 px-2.5 text-[11px] font-semibold text-indigo-800 dark:text-indigo-300 hover:bg-indigo-500/20 disabled:opacity-50 cursor-pointer touch-manipulation"
                     >
                       {isScanningReceipt ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                       <span>{isScanningReceipt ? 'Scanning' : 'Scan'}</span>
                     </button>
                   )}
                   <button
                    type="button"
                    onClick={removeReceipt}
                    className="p-1.5 rounded-lg bg-rose-500/10 text-rose-800 dark:text-rose-400 hover:bg-rose-500/20"
                    title="Remove receipt"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              )}
            </div>

            {/* Submit Button */}
            <motion.button
              type="submit"
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              transition={{ type: 'spring' as const, stiffness: 400, damping: 25 }}
              disabled={isSubmitting}
              className="relative sticky bottom-0 z-10 w-full min-h-[48px] flex items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-indigo-500 via-indigo-600 to-purple-600 py-3.5 font-bold text-white dark:text-white shadow-xl shadow-indigo-500/25 hover:from-indigo-600 hover:to-purple-700 disabled:opacity-50 transition-all cursor-pointer text-base"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="h-5 w-5 animate-spin" />
                  <span>Saving to Google Sheet...</span>
                </>
              ) : (
                <>
                  <Check className="h-5 w-5 stroke-[2.5]" />
                  <span>{editTransaction ? 'Save Changes' : 'Record Transaction'}</span>
                </>
              )}
            </motion.button>
          </form>
        </motion.div>
      </div>
      )}

      {/* Fullscreen Receipt Preview Lightbox Modal */}
      {showReceiptModal && receiptPreview && (
        <div 
          className="fixed inset-0 z-[260] flex items-center justify-center bg-black/80 backdrop-blur-md p-4"
          onClick={() => setShowReceiptModal(false)}
        >
          <div 
            className="relative max-w-lg w-full max-h-[calc(100dvh-2rem)] bg-white dark:bg-zinc-900 rounded-2xl overflow-hidden border border-slate-200 dark:border-zinc-800 shadow-2xl flex flex-col"
            role="dialog"
            aria-modal="true"
            aria-labelledby="receipt-preview-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/90 shrink-0">
              <span id="receipt-preview-title" className="text-xs font-semibold text-slate-700 dark:text-zinc-300">Receipt Preview</span>
              <button
                type="button"
                onClick={() => setShowReceiptModal(false)}
                className="p-1 rounded-lg text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-3 overflow-y-auto overscroll-contain touch-pan-y [-webkit-overflow-scrolling:touch] custom-scrollbar max-h-[calc(100dvh-6rem)] flex items-center justify-center bg-white dark:bg-zinc-950">
              <img
                src={receiptPreview}
                alt="Full receipt"
                className="max-h-[calc(100dvh-8rem)] w-auto object-contain rounded-lg shadow-lg"
              />
            </div>
          </div>
        </div>
      )}
    </AnimatePresence>,
    document.body
  );
}
