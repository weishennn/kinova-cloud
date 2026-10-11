'use client';

import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { Sparkles, Mic, MicOff, Check, CornerDownLeft, Loader2, Camera, X, Pencil, Paperclip } from 'lucide-react';
import { parseNaturalExpense, ParsedExpense } from '@/lib/natural-expense-parser';
import {
  addUnifiedRow,
  applyOptimisticAddToQueryCache,
  applyOptimisticUpdateToQueryCache,
} from '@/hooks/useSheets';
import { useTransactions } from '@/hooks/useTransactions';
import { useQueryClient } from '@tanstack/react-query';
import { getLocalDateString, normalizeDateString } from '@/lib/date-helper';
import { useAppStore } from '@/stores/app-store';
import type { AiCommand, AiReceiptItem, AiTransactionData } from '@/types/ai-command';
import { compressImageFile } from '@/lib/image-compressor';
import { formatClaimFileName } from '@/lib/claim-helper';
import {
  analyzePurchaseForTaxRelief,
  calculateYearlyTaxReliefSummary,
  applyTaxReliefTag,
} from '@/lib/lhdn-tax-helper';
import { driveApi } from '@/lib/sheets-api';
import { MoneyCalculator } from '@/components/shared/money-calculator';
import { toast } from 'sonner';

const CATEGORY_EMOJIS: Record<string, string> = {
  'Food & Dining': '🍔',
  'Transport': '🚗',
  'Shopping': '🛍️',
  'Housing & Bills': '🏠',
  'Parents': '👨‍👩‍👧',
  'Insurance': '🛡️',
  'Entertainment': '🎬',
  'Health': '🏥',
  'Education': '📚',
  'Salary': '💰',
  'Claim Allowance': '🧾',
  'Freelance': '💻',
  'Investment Return': '📈',
  'Gift & Bonus': '🎁',
  'Other': '📦',
};

const EXPENSE_CATEGORIES = [
  'Food & Dining',
  'Transport',
  'Shopping',
  'Housing & Bills',
  'Parents',
  'Insurance',
  'Entertainment',
  'Health',
  'Education',
  'Other',
];

export function SmartQuickInput() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { setAiPrefill, setQuickAddOpen, selectedMonth, setSelectedMonth } = useAppStore();
  const { transactions = [] } = useTransactions();
  const [input, setInput] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [aiParsed, setAiParsed] = useState<AiCommand | null>(null);
  const [isAiParsing, setIsAiParsing] = useState(false);
  const [isAiEnhanced, setIsAiEnhanced] = useState(false);
  const [isScanningReceipt, setIsScanningReceipt] = useState(false);
  const [scanError, setScanError] = useState('');
  const [receiptAttachment, setReceiptAttachment] = useState<{
    dataUrl: string;
    base64: string;
    fileName: string;
    mimeType: string;
  } | null>(null);
  const [saveReceiptPhoto, setSaveReceiptPhoto] = useState(true);
  const [isEditingDetails, setIsEditingDetails] = useState(false);
  const [receiptItems, setReceiptItems] = useState<AiReceiptItem[]>([]);
  const [selectedReceiptItems, setSelectedReceiptItems] = useState<number[]>([]);
  const [originalReceiptData, setOriginalReceiptData] = useState<{
    totalAmount: number;
    subtotal: number;
    taxAmount: number;
    taxRate: number | null;
    description: string;
  } | null>(null);
  const [receiptRawText, setReceiptRawText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const receiptInputRef = useRef<HTMLInputElement>(null);

  // Parse in real-time as user types or dictates (0ms instant local preview)
  const localParsed: ParsedExpense | null = useMemo(() => {
    return parseNaturalExpense(input);
  }, [input]);

  const localCommand = useMemo<AiCommand | null>(() => {
    if (!localParsed) return null;
    if (localParsed.isInstallment) {
      return {
        intent: 'installment',
        confidence: 1,
        data: {
          name: localParsed.description,
          totalPrincipal: localParsed.amount,
          currency: localParsed.currency || 'MYR',
          category: localParsed.category,
          tenureMonths: localParsed.installmentMonths || 12,
          annualInterestRate: localParsed.interestRate ?? 0,
          startDate: localParsed.date,
        },
      };
    }
    return { intent: 'transaction', confidence: 1, data: localParsed };
  }, [localParsed]);

  const prefersAiForTax = /\b(?:before tax|after tax|including tax|plus tax)\b/i.test(input) && !localParsed?.formula;
  const activeCommand = prefersAiForTax && !aiParsed ? null : aiParsed || localCommand;

  // Real-time Malaysia LHDN Tax Relief preview for SmartQuickInput
  const taxPreviewInfo = useMemo(() => {
    if (!activeCommand || activeCommand.intent !== 'transaction' || !activeCommand.data) return null;
    const txData = activeCommand.data as AiTransactionData;
    if (txData.type && txData.type.toLowerCase() === 'income') return null;
    const analysis = analyzePurchaseForTaxRelief({
      description: txData.description || '',
      category: txData.category || '',
      notes: txData.notes || '',
    });
    if (!analysis.isEligible && !analysis.warningMessage) return null;
    const yearStr = txData.date && /^\d{4}/.test(txData.date) ? txData.date.substring(0, 4) : String(new Date().getFullYear());
    const summary = calculateYearlyTaxReliefSummary(transactions, yearStr);
    const catStatus = analysis.category
      ? summary.categories.find((c) => c.category.id === analysis.category!.id) || null
      : null;
    return {
      ...analysis,
      catStatus,
      yearStr,
    };
  }, [activeCommand, transactions]);

  const clearReceiptState = () => {
    setReceiptAttachment(null);
    setReceiptItems([]);
    setSelectedReceiptItems([]);
    setOriginalReceiptData(null);
    setReceiptRawText('');
    setScanError('');
    setSaveReceiptPhoto(true);
    setIsEditingDetails(false);
  };

  const updateTransactionData = (patch: Partial<AiTransactionData>) => {
    setAiParsed((current) => {
      const base = current || localCommand;
      if (base?.intent === 'transaction' && base.data) {
        return {
          ...base,
          confidence: 1,
          data: { ...base.data, ...patch },
        };
      }
      return current;
    });
  };

  const toggleReceiptItem = (index: number) => {
    if (receiptItems.length <= 1 || !aiParsed || aiParsed.intent !== 'transaction' || !originalReceiptData) return;
    const nextSelected = selectedReceiptItems.includes(index)
      ? selectedReceiptItems.filter((i) => i !== index)
      : [...selectedReceiptItems, index].sort((a, b) => a - b);

    if (nextSelected.length === 0) return; // Keep at least one item selected

    setSelectedReceiptItems(nextSelected);

    const currentTx = aiParsed.data as AiTransactionData;
    const activeTaxRate = currentTx.taxRate ?? originalReceiptData.taxRate;
    const allSelected = nextSelected.length === receiptItems.length;

    if (allSelected) {
      if (activeTaxRate != null && originalReceiptData.taxRate != null && Math.abs(activeTaxRate - originalReceiptData.taxRate) > 0.01) {
        const recomputedTax = Number(((originalReceiptData.subtotal * activeTaxRate) / 100).toFixed(2));
        updateTransactionData({
          subtotal: originalReceiptData.subtotal,
          taxRate: activeTaxRate,
          taxAmount: recomputedTax,
          amount: Number((originalReceiptData.subtotal + recomputedTax).toFixed(2)),
          description: originalReceiptData.description,
        });
      } else {
        updateTransactionData({
          amount: originalReceiptData.totalAmount,
          subtotal: originalReceiptData.subtotal,
          taxAmount: originalReceiptData.taxAmount,
          taxRate: activeTaxRate,
          description: originalReceiptData.description,
        });
      }
      return;
    }

    // A subset of items is selected
    const selectedSubtotal = Number(nextSelected.reduce((sum, i) => sum + receiptItems[i].amount, 0).toFixed(2));
    const fullItemsTotal = Number(receiptItems.reduce((sum, item) => sum + item.amount, 0).toFixed(2));
    const impliedFullTax = Math.max(
      originalReceiptData.taxAmount || 0,
      fullItemsTotal > 0 && originalReceiptData.totalAmount > fullItemsTotal
        ? Number((originalReceiptData.totalAmount - fullItemsTotal).toFixed(2))
        : 0
    );

    let allocatedTax = 0;
    if (activeTaxRate != null && activeTaxRate > 0) {
      allocatedTax = Number(((selectedSubtotal * activeTaxRate) / 100).toFixed(2));
    } else if (impliedFullTax > 0 && fullItemsTotal > 0) {
      allocatedTax = Number(((selectedSubtotal / fullItemsTotal) * impliedFullTax).toFixed(2));
    }

    const nextAmount = Number((selectedSubtotal + allocatedTax).toFixed(2));
    const chosenFoods = nextSelected.map((i) => receiptItems[i].name).join(', ');
    const baseMerchant = originalReceiptData.description.split(' (')[0].trim();
    const updatedDesc = `${baseMerchant} (${chosenFoods})`;

    updateTransactionData({
      subtotal: selectedSubtotal,
      amount: nextAmount,
      taxAmount: allocatedTax,
      taxRate: activeTaxRate,
      description: updatedDesc,
    });
  };

  const splitMultiQuantityReceiptItem = (targetIndex?: number) => {
    const nextItems: AiReceiptItem[] = [];
    const nextSelected: number[] = [];

    receiptItems.forEach((item, idx) => {
      const wasSelected = selectedReceiptItems.includes(idx);
      const qty = Math.round(Number(item.quantity) || 1);
      const shouldSplit = (targetIndex === undefined || targetIndex === idx) && qty > 1 && qty <= 20;

      if (!shouldSplit) {
        const newIdx = nextItems.length;
        nextItems.push(item);
        if (wasSelected) nextSelected.push(newIdx);
        return;
      }

      const totalCents = Math.round(item.amount * 100);
      const baseUnitCents = Math.floor(totalCents / qty);
      const remainderCents = totalCents - baseUnitCents * qty;
      const cleanName = item.name.replace(/\s*\(\d+\/\d+\)\s*$/, '').trim();

      for (let i = 0; i < qty; i++) {
        const cents = i === qty - 1 ? baseUnitCents + remainderCents : baseUnitCents;
        const unitAmt = Number((cents / 100).toFixed(2));
        const newIdx = nextItems.length;
        nextItems.push({
          ...item,
          name: `${cleanName} (${i + 1}/${qty})`,
          quantity: 1,
          unitPrice: unitAmt,
          amount: unitAmt,
        });
        if (wasSelected) nextSelected.push(newIdx);
      }
    });

    setReceiptItems(nextItems);
    setSelectedReceiptItems(nextSelected);
    toast.success('✂️ Split multi-quantity item into individual plates — tap any plate to unselect!');
  };

  const multiplyReceiptItemByQty = (index: number) => {
    const target = receiptItems[index];
    if (!target) return;
    const qty = Math.round(Number(target.quantity) || 1);
    if (qty <= 1) return;

    const currentAmt = Number(target.amount) || 0;
    const nextLineTotal = Number((currentAmt * qty).toFixed(2));
    const delta = Number((nextLineTotal - currentAmt).toFixed(2));

    const nextItems = receiptItems.map((it, i) =>
      i === index
        ? {
            ...it,
            unitPrice: currentAmt,
            amount: nextLineTotal,
            qtyReconciled: 'multiplied_unit_price' as const,
          }
        : it
    );
    setReceiptItems(nextItems);

    if (originalReceiptData) {
      const nextOrigSubtotal = Number((originalReceiptData.subtotal + delta).toFixed(2));
      const activeTaxRate = (aiParsed?.data as AiTransactionData | undefined)?.taxRate ?? originalReceiptData.taxRate;
      const nextOrigTax =
        activeTaxRate != null && activeTaxRate > 0
          ? Number(((nextOrigSubtotal * activeTaxRate) / 100).toFixed(2))
          : originalReceiptData.taxAmount;
      const nextOrigTotal = Number((nextOrigSubtotal + (nextOrigTax || 0)).toFixed(2));

      setOriginalReceiptData({
        ...originalReceiptData,
        subtotal: nextOrigSubtotal,
        taxAmount: nextOrigTax,
        totalAmount: nextOrigTotal,
      });

      const selectedSubtotal = Number(
        selectedReceiptItems.reduce((sum, idx) => sum + (nextItems[idx]?.amount || 0), 0).toFixed(2)
      );
      const allocatedTax =
        activeTaxRate != null && activeTaxRate > 0
          ? Number(((selectedSubtotal * activeTaxRate) / 100).toFixed(2))
          : nextOrigTax || 0;
      updateTransactionData({
        subtotal: selectedSubtotal,
        taxAmount: allocatedTax,
        amount: Number((selectedSubtotal + allocatedTax).toFixed(2)),
      });
    }
  };

  // Voice Recognition setup
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = 'en-MY'; // Malaysian English

      recognition.onresult = (event: any) => {
        const transcript = Array.from(event.results)
          .map((res: any) => res[0].transcript)
          .join('');
        setInput(transcript);
      };

      recognition.onerror = () => {
        setIsListening(false);
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognitionRef.current = recognition;
    }
  }, []);



  const handleAiParse = async () => {
    const trimmed = input.trim();
    if (trimmed.length < 4 || isAiParsing) return;

    setIsAiParsing(true);
    try {
      const res = await fetch('/api/ai/parse-expense', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: trimmed, today: getLocalDateString() }),
      });
      const json = await res.json();
      if (!res.ok || !json.success || !json.data) {
        throw new Error(json.error || 'Gemini could not understand that command');
      }
      setAiParsed(json.data as AiCommand);
      setIsAiEnhanced(true);
    } catch (error) {
      console.warn('AI parse error, using local fallback', error);
      toast.error(error instanceof Error ? error.message : 'Gemini parsing failed');
    } finally {
      setIsAiParsing(false);
    }
  };

  const handleReceiptScan = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    if (!file.type.startsWith('image/')) {
      toast.error('Receipt scanning supports image files only');
      setScanError('Please choose a JPG, PNG, or WebP receipt image.');
      return;
    }

    setScanError('');
    setIsScanningReceipt(true);
    const toastId = toast.loading('🔍 Reading receipt with Gemini...');
    try {
      const { base64, dataUrl, mimeType } = await compressImageFile(file);
      const res = await fetch('/api/ai/parse-receipt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: base64, mimeType, today: getLocalDateString() }),
      });
      const json = await res.json();
      const payload = json.success ? (json.data as (AiCommand & { items?: AiReceiptItem[]; rawText?: string })) : null;
      if (!res.ok || !payload || payload.intent !== 'transaction' || !payload.data) {
        throw new Error(json?.error || 'Could not read this receipt');
      }

      const tx = payload.data as AiTransactionData;
      const items = Array.isArray(payload.items)
        ? payload.items.filter((item) => item && typeof item.name === 'string' && Number(item.amount) > 0).slice(0, 15)
        : [];
      const safeItems = items.length > 0
        ? items
        : [{ name: tx.description, amount: tx.subtotal || tx.amount, category: tx.category }];

      const itemsSum = Number(safeItems.reduce((sum, item) => sum + item.amount, 0).toFixed(2));
      const origSubtotal = tx.subtotal && tx.subtotal > 0 ? tx.subtotal : itemsSum;
      const origTotal = tx.amount;

      // Reconcile combined tax rate & amount (e.g. Service Charge 10% + SST 6% = 16%)
      let effectiveTaxAmount = tx.taxAmount && tx.taxAmount >= 0 ? tx.taxAmount : 0;
      let effectiveTaxRate: number | null = tx.taxRate ?? null;

      if (Array.isArray(tx.taxes) && tx.taxes.length > 0) {
        const summedRate = Number(tx.taxes.reduce((s, t) => s + (Number(t?.rate) > 0 ? Number(t.rate) : 0), 0).toFixed(2));
        const summedAmt = Number(tx.taxes.reduce((s, t) => s + (Number(t?.amount) > 0 ? Number(t.amount) : 0), 0).toFixed(2));
        if (summedRate > 0 && (effectiveTaxRate == null || summedRate > effectiveTaxRate)) {
          effectiveTaxRate = summedRate;
        }
        if (summedAmt > 0 && summedAmt > effectiveTaxAmount) {
          effectiveTaxAmount = summedAmt;
        }
      }

      const impliedTaxAmount = origTotal > origSubtotal + 0.01 ? Number((origTotal - origSubtotal).toFixed(2)) : 0;
      if (origSubtotal > 0 && impliedTaxAmount > 0) {
        const impliedRate = Number(((impliedTaxAmount / origSubtotal) * 100).toFixed(2));
        if (effectiveTaxRate == null || Math.abs(impliedRate - effectiveTaxRate) > 1.2) {
          const commonRates = [6, 8, 10, 16, 18, 5, 7, 9, 12, 15];
          const snapped = commonRates.find((r) => Math.abs(r - impliedRate) <= 0.85);
          effectiveTaxRate = snapped ?? Number((Math.round(impliedRate * 2) / 2).toFixed(1));
          effectiveTaxAmount = impliedTaxAmount;
        } else if (effectiveTaxAmount <= 0 || Math.abs(impliedTaxAmount - effectiveTaxAmount) > 0.05) {
          effectiveTaxAmount = impliedTaxAmount;
        }
      }

      tx.subtotal = origSubtotal;
      tx.taxAmount = effectiveTaxAmount > 0 ? effectiveTaxAmount : tx.taxAmount;
      tx.taxRate = effectiveTaxRate;

      setOriginalReceiptData({
        totalAmount: origTotal,
        subtotal: origSubtotal,
        taxAmount: effectiveTaxAmount,
        taxRate: effectiveTaxRate,
        description: tx.description,
      });

      setReceiptAttachment({ dataUrl, base64, fileName: file.name, mimeType });
      setReceiptItems(safeItems);
      setSelectedReceiptItems(safeItems.map((_, index) => index));
      setReceiptRawText(typeof payload.rawText === 'string' ? payload.rawText : '');
      setAiParsed({ ...payload, data: tx });
      setIsAiEnhanced(true);
      setSaveReceiptPhoto(true);
      setInput(tx.description);
      toast.success(`✨ Receipt read: ${tx.currency} ${tx.amount.toFixed(2)} (${tx.description})`, { id: toastId });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Receipt scanning failed';
      setScanError(message);
      toast.error(message, { id: toastId });
    } finally {
      setIsScanningReceipt(false);
    }
  };

  const toggleListening = () => {
    if (!recognitionRef.current) {
      toast.info('Voice dictation is supported in Chrome, Edge, and Safari browsers.');
      return;
    }
    if (isListening) {
      recognitionRef.current.stop();
      setIsListening(false);
    } else {
      try {
        recognitionRef.current.start();
        setIsListening(true);
        toast.info('🎙️ Listening... Say e.g. "Mamak lunch 18" or "Shell petrol 60"');
      } catch (err) {
        console.error(err);
      }
    }
  };

  const handleQuickSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!activeCommand || isSubmitting) return;

    if (activeCommand.intent !== 'transaction') {
      if (!activeCommand.data) {
        toast.error('Gemini needs more details before opening a form');
        return;
      }

      if (activeCommand.intent === 'installment') {
        setAiPrefill({ kind: 'installment', data: activeCommand.data });
        setQuickAddOpen(true);
        toast.info('Review the installment details before saving');
      } else if (activeCommand.intent === 'trade') {
        setAiPrefill({ kind: 'trade', data: activeCommand.data });
        router.push('/investments');
        toast.info('Review the trade details before saving');
      } else if (activeCommand.intent === 'trip') {
        setAiPrefill({ kind: 'trip', data: activeCommand.data });
        router.push('/trips');
        toast.info('Review the trip details before saving');
      } else {
        toast.error('This command is not supported yet');
        return;
      }

      setInput('');
      setAiParsed(null);
      setIsAiEnhanced(false);
      clearReceiptState();
      return;
    }

    const activeParsed = activeCommand.data as AiTransactionData;
    if (!activeParsed || !activeParsed.amount) return;

    setIsSubmitting(true);
    const safeDate = normalizeDateString(activeParsed.date);
    const monthStr = safeDate.substring(0, 7);
    const tempId = `tx_${Date.now()}`;

    let finalNotes = activeParsed.notes || '';
    if (activeParsed.taxAmount != null && activeParsed.taxAmount > 0) {
      const taxRateStr = activeParsed.taxRate != null ? ` (${activeParsed.taxRate}%)` : '';
      const taxNote = `[Tax: ${activeParsed.currency || 'MYR'} ${activeParsed.taxAmount.toFixed(2)}${taxRateStr}]`;
      if (!finalNotes.includes(taxNote)) {
        finalNotes = finalNotes ? `${finalNotes} ${taxNote}` : taxNote;
      }
    }
    if (receiptItems.length > 0 && selectedReceiptItems.length < receiptItems.length) {
      const chosenFoods = selectedReceiptItems
        .map((idx) => `${receiptItems[idx].name} (${activeParsed.currency || 'MYR'} ${receiptItems[idx].amount.toFixed(2)})`)
        .join(', ');
      finalNotes = finalNotes ? `${finalNotes} [Paid items: ${chosenFoods}]` : `[Paid items: ${chosenFoods}]`;
    }

    const currentReceipt = receiptAttachment;
    const shouldUploadPhoto = saveReceiptPhoto && Boolean(currentReceipt?.base64);

    let finalSubCategory = '';
    if (taxPreviewInfo?.isEligible && taxPreviewInfo.category) {
      const tagged = applyTaxReliefTag(taxPreviewInfo.category.id, finalNotes);
      finalSubCategory = tagged.subCategory;
      finalNotes = tagged.notes;
    }

    const rowData: Record<string, any> = {
      Id: tempId,
      id: tempId,
      Date: safeDate,
      date: safeDate,
      Type: activeParsed.type.toLowerCase(),
      type: activeParsed.type.toLowerCase(),
      Category: activeParsed.category,
      category: activeParsed.category,
      SubCategory: finalSubCategory,
      subCategory: finalSubCategory,
      Description: activeParsed.description,
      description: activeParsed.description,
      Amount: activeParsed.amount,
      amount: activeParsed.amount,
      Currency: activeParsed.currency || 'MYR',
      currency: activeParsed.currency || 'MYR',
      TripTag: '',
      tripTag: '',
      ReceiptUrl: currentReceipt?.dataUrl || '',
      receiptUrl: currentReceipt?.dataUrl || '',
      Notes: finalNotes,
      notes: finalNotes,
      _month: monthStr,
      _rowIndex: 2,
    };

    // Instant Optimistic Feedback (<10ms) across all active transaction queries + local SWR cache
    applyOptimisticAddToQueryCache(queryClient, monthStr, rowData);

    const recordedText = `${activeParsed.currency || 'MYR'} ${activeParsed.amount.toFixed(2)} for ${activeParsed.description}`;
    const savedTaxCat = taxPreviewInfo?.isEligible ? taxPreviewInfo.category : null;
    setInput('');
    setAiParsed(null);
    setIsAiEnhanced(false);
    clearReceiptState();
    setIsSubmitting(false);

    const isOtherPeriod =
      Boolean(monthStr) &&
      monthStr !== selectedMonth &&
      selectedMonth !== 'all' &&
      selectedMonth !== `year-${monthStr.slice(0, 4)}`;
    const toastOptions = isOtherPeriod
      ? {
          action: {
            label: `View ${monthStr}`,
            onClick: () => setSelectedMonth(monthStr),
          },
          duration: 5000,
        }
      : undefined;

    const toastMsg = currentReceipt && shouldUploadPhoto
      ? `📸 Recorded & saved receipt photo: ${recordedText}!`
      : savedTaxCat
      ? `🇲🇾 Recorded (${savedTaxCat.shortName} Tax Relief): ${recordedText}! Remember to attach your receipt in Invoices & Tax.`
      : isOtherPeriod
      ? `✨ Recorded to ${monthStr}: ${recordedText}!`
      : `✨ Recorded: ${recordedText}!`;
    toast.success(toastMsg, toastOptions);

    // Asynchronously save to Google Sheets (and upload photo to Google Drive) in background
    void (async () => {
      try {
        let uploadedUrl = '';
        if (shouldUploadPhoto && currentReceipt?.base64) {
          try {
            const fileCatLabel = savedTaxCat ? `LHDN_${savedTaxCat.shortName}` : activeParsed.category;
            const fileName = formatClaimFileName(
              activeParsed.date,
              fileCatLabel,
              activeParsed.amount,
              activeParsed.description,
              currentReceipt.fileName
            );
            const res = await driveApi.uploadFile(
              fileName,
              currentReceipt.mimeType || 'image/jpeg',
              currentReceipt.base64
            );
            uploadedUrl = res.data?.url || '';
          } catch (uploadErr) {
            console.warn('Drive receipt upload failed, saving sheet row without url:', uploadErr);
          }
        }

        await addUnifiedRow(monthStr, {
          Id: tempId,
          id: tempId,
          Date: safeDate,
          Type: activeParsed.type,
          Category: activeParsed.category,
          SubCategory: finalSubCategory,
          Description: activeParsed.description,
          Amount: activeParsed.amount,
          Currency: activeParsed.currency || 'MYR',
          TripTag: '',
          ReceiptUrl: uploadedUrl,
          Notes: finalNotes,
        });
        if (uploadedUrl) {
          applyOptimisticUpdateToQueryCache(queryClient, monthStr, 2, {
            ...rowData,
            ReceiptUrl: uploadedUrl,
            receiptUrl: uploadedUrl,
          });
        }
        queryClient.invalidateQueries({ queryKey: ['months'] });
        queryClient.invalidateQueries({ queryKey: ['overview'] });
      } catch (err) {
        console.warn('Background sync failed', err);
      }
    })();
  };

  return (
    <div className="relative rounded-2xl border border-indigo-500/25 bg-white dark:bg-zinc-950 p-2.5 sm:p-3 shadow-sm space-y-1.5 transition-colors focus-within:border-indigo-500/60">
      <form onSubmit={handleQuickSubmit} className="relative flex items-center gap-2">
        <div className="relative flex-1">
          <Sparkles className={`absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 shrink-0 pointer-events-none transition-colors ${
            isAiParsing ? 'text-amber-800 dark:text-amber-400 animate-spin' : isAiEnhanced ? 'text-emerald-800 dark:text-emerald-400' : 'text-indigo-800 dark:text-indigo-400'
          }`} />
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => {
              const val = e.target.value;
              setInput(val);
              if (receiptAttachment) {
                updateTransactionData({ description: val });
              } else {
                setAiParsed(null);
                setIsAiEnhanced(false);
                setScanError('');
              }
            }}
            onPointerDown={(e) => {
              // Pre-scroll instantly before focus so native caret coordinates are accurate
              e.currentTarget.scrollIntoView({ block: 'nearest', behavior: 'instant' as ScrollBehavior });
            }}

            placeholder={receiptAttachment ? 'Edit receipt description...' : 'e.g. Mamak lunch 18, Shell petrol 60, Groceries 45...'}
            className="block w-full h-11 rounded-2xl border border-slate-200 dark:border-white/[0.08] bg-white/90 dark:bg-zinc-950/90 py-2.5 pl-10 pr-20 text-[16px] sm:text-sm text-slate-950 dark:text-white placeholder-zinc-400 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400/50 transition-colors shadow-inner touch-manipulation leading-5"
          />
          {/* Action buttons: Camera Scan + Voice Dictation */}
          <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
            <input
              ref={receiptInputRef}
              type="file"
              accept="image/*"
              onChange={(e) => void handleReceiptScan(e)}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => receiptInputRef.current?.click()}
              disabled={isScanningReceipt}
              title="Scan receipt with Gemini"
              aria-label="Scan receipt with Gemini"
              className="relative min-w-[34px] min-h-[34px] flex items-center justify-center rounded-xl text-indigo-800 dark:text-indigo-300 hover:text-slate-950 dark:hover:text-white hover:bg-indigo-500/20 disabled:opacity-50 transition-all cursor-pointer touch-manipulation active:scale-[0.92]"
            >
              {isScanningReceipt ? <Loader2 className="h-4 w-4 animate-spin text-amber-800 dark:text-amber-400" /> : <Camera className="h-4 w-4" />}
            </button>
            {isListening && (
              <span className="absolute -inset-1 rounded-xl bg-rose-500/40 animate-ping pointer-events-none" />
            )}
            <button
              type="button"
              onClick={toggleListening}
              title={isListening ? 'Stop listening' : 'Speak to record'}
              aria-label={isListening ? 'Stop listening' : 'Speak to record'}
              className={`relative min-w-[34px] min-h-[34px] flex items-center justify-center rounded-xl transition-all cursor-pointer touch-manipulation active:scale-[0.92] ${
                isListening
                  ? 'bg-rose-500 text-white dark:text-white shadow-lg shadow-rose-500/50'
                  : 'text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-zinc-800/80'
              }`}
            >
              {isListening ? <MicOff className="h-4 w-4 animate-pulse" /> : <Mic className="h-4 w-4" />}
            </button>
          </div>
        </div>

        <motion.button
          type="submit"
          disabled={!activeCommand || isSubmitting}
          whileTap={{ scale: 0.95 }}
          className={`h-11 px-4 rounded-2xl flex items-center gap-1.5 text-xs font-semibold shadow-md transition-all shrink-0 cursor-pointer ${
            activeCommand && !isSubmitting
              ? 'bg-gradient-to-r from-indigo-500 to-purple-600 text-white dark:text-white shadow-indigo-500/25 hover:from-indigo-400 hover:to-purple-500'
              : 'bg-slate-100 dark:bg-zinc-800/50 text-slate-500 dark:text-zinc-400 border border-slate-200 dark:border-white/5 cursor-not-allowed'
          }`}
        >
          {isSubmitting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <>
              <span>{receiptAttachment ? 'Save' : 'Record'}</span>
              <CornerDownLeft className="h-3 w-3 opacity-60 hidden sm:inline" />
            </>
          )}
        </motion.button>
      </form>

      {/* Loading state for OCR receipt scanning */}
      {isScanningReceipt && (
        <div role="status" className="flex items-center gap-2 rounded-xl border border-indigo-500/20 bg-indigo-500/10 px-3 py-2 text-xs text-indigo-800 dark:text-indigo-200">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-800 dark:text-amber-400" />
          <span>Gemini is reading your receipt...</span>
        </div>
      )}

      {/* OCR error banner */}
      {scanError && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-800 dark:text-rose-200">
          <span>{scanError}</span>
          <button type="button" onClick={() => setScanError('')} className="font-semibold underline underline-offset-2 hover:text-slate-950 dark:hover:text-white">Dismiss</button>
        </div>
      )}

      {/* AI enhancement prompt */}
      {input.trim().length >= 4 && !isAiEnhanced && !receiptAttachment && (
        <div className="flex justify-center pt-0.5">
          <button
            type="button"
            onClick={() => void handleAiParse()}
            disabled={isAiParsing}
            className="inline-flex min-h-[32px] items-center gap-1.5 rounded-xl px-2.5 text-[11px] font-semibold text-indigo-800 dark:text-indigo-300 hover:bg-indigo-500/10 hover:text-indigo-800 dark:hover:text-indigo-200 disabled:opacity-50 cursor-pointer touch-manipulation"
          >
            {isAiParsing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
            <span>Use Gemini for tax, trades, installments & trips</span>
          </button>
        </div>
      )}

      {/* Command Preview & Receipt Item Selector */}
      <AnimatePresence>
        {activeCommand && (
          <motion.div
            initial={{ opacity: 0, y: -4, height: 0 }}
            animate={{ opacity: 1, y: 0, height: 'auto' }}
            exit={{ opacity: 0, y: -4, height: 0 }}
            className="pt-1 text-xs"
          >
            {/* If a receipt is attached, render full interactive preview card */}
            {receiptAttachment && activeCommand.intent === 'transaction' && activeCommand.data ? (
              <div className="rounded-2xl border border-indigo-500/30 bg-white/90 dark:bg-zinc-950/80 p-3 sm:p-4 text-left shadow-lg space-y-3">
                {/* Header */}
                <div className="flex items-center justify-between gap-2 border-b border-slate-200 dark:border-white/[0.06] pb-2.5">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 px-2.5 py-0.5 text-[11px] font-bold text-emerald-800 dark:text-emerald-300">
                      <Camera className="h-3 w-3" />
                      Receipt OCR Ready
                    </span>
                    <span className="text-[11px] text-slate-600 dark:text-zinc-400">Edit details or tap save below</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      clearReceiptState();
                      setAiParsed(null);
                      setIsAiEnhanced(false);
                      setInput('');
                    }}
                    className="rounded-lg p-1 text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-zinc-800 text-xs transition-colors cursor-pointer"
                    title="Discard receipt"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                {/* Option to save receipt photo to Drive */}
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-white/90 dark:bg-zinc-900/60 px-3 py-2 border border-slate-200 dark:border-white/[0.04]">
                  <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-700 dark:text-zinc-300 hover:text-slate-950 dark:hover:text-white select-none">
                    <input
                      type="checkbox"
                      checked={saveReceiptPhoto}
                      onChange={(e) => setSaveReceiptPhoto(e.target.checked)}
                      className="h-3.5 w-3.5 rounded border-slate-300 dark:border-zinc-700 bg-slate-100 dark:bg-zinc-800 text-indigo-700 dark:text-indigo-500 focus:ring-indigo-400 accent-indigo-500"
                    />
                    <span className="flex items-center gap-1.5 font-medium">
                      <Paperclip className="h-3.5 w-3.5 text-indigo-800 dark:text-indigo-400" />
                      <span>Save receipt photo to Google Drive</span>
                    </span>
                  </label>
                  {receiptAttachment && (
                    <span className="text-[10px] text-slate-600 dark:text-zinc-400 truncate max-w-[200px]">
                      {receiptAttachment.fileName}
                    </span>
                  )}
                </div>

                {/* Food / Items Selector (if multiple items or multi-quantity items detected) */}
                {(receiptItems.length > 1 || receiptItems.some((it) => (Number(it.quantity) || 1) > 1)) && (
                  <div className="space-y-1.5 rounded-xl bg-white/90 dark:bg-zinc-900/70 p-2.5 border border-slate-200 dark:border-white/[0.04]">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                      <span className="font-semibold text-slate-800 dark:text-zinc-200">Which items did you pay for?</span>
                      <div className="flex items-center gap-2">
                        {receiptItems.some((it) => (Number(it.quantity) || 1) > 1) && (
                          <button
                            type="button"
                            onClick={() => splitMultiQuantityReceiptItem()}
                            className="text-[10px] rounded-md bg-emerald-500/15 border border-emerald-500/35 px-2 py-0.5 text-emerald-800 dark:text-emerald-300 hover:bg-emerald-500/25 font-semibold cursor-pointer transition-colors"
                            title="Split multi-quantity items (e.g. 2× Laksa) into individual 1× plates so you can select just 1 plate"
                          >
                            ✂️ Split multi-qty into single plates
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            if (!originalReceiptData) return;
                            setSelectedReceiptItems(receiptItems.map((_, i) => i));
                            const activeTaxRate = activeCommand.data.taxRate ?? originalReceiptData.taxRate;
                            if (activeTaxRate != null && originalReceiptData.taxRate != null && Math.abs(activeTaxRate - originalReceiptData.taxRate) > 0.01) {
                              const fullTax = Number(((originalReceiptData.subtotal * activeTaxRate) / 100).toFixed(2));
                              updateTransactionData({
                                subtotal: originalReceiptData.subtotal,
                                taxRate: activeTaxRate,
                                taxAmount: fullTax,
                                amount: Number((originalReceiptData.subtotal + fullTax).toFixed(2)),
                                description: originalReceiptData.description,
                              });
                            } else {
                              updateTransactionData({
                                amount: originalReceiptData.totalAmount,
                                subtotal: originalReceiptData.subtotal,
                                taxAmount: originalReceiptData.taxAmount,
                                taxRate: activeTaxRate,
                                description: originalReceiptData.description,
                              });
                            }
                          }}
                          className="text-[10px] text-indigo-800 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 font-medium cursor-pointer"
                        >
                          Select all
                        </button>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {receiptItems.map((item, idx) => {
                        const isSelected = selectedReceiptItems.includes(idx);
                        const qty = Math.round(Number(item.quantity) || 1);
                        const unitPrice = Number((item.unitPrice && item.unitPrice > 0 ? item.unitPrice : item.amount / qty).toFixed(2));
                        return (
                          <div key={`${item.name}-${idx}`} className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => toggleReceiptItem(idx)}
                              className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all cursor-pointer ${
                                isSelected
                                  ? 'bg-indigo-600/30 border border-indigo-500/50 text-slate-950 dark:text-white shadow-sm'
                                  : 'bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 text-slate-500 dark:text-zinc-400 line-through opacity-60'
                              }`}
                            >
                              <span>{isSelected ? '✓' : '✗'}</span>
                              {qty > 1 && (
                                <span className="rounded bg-indigo-500/20 px-1 py-0.2 font-mono text-[10px] font-bold text-indigo-900 dark:text-indigo-200">
                                  {qty}×
                                </span>
                              )}
                              <span>{item.name}</span>
                              {qty > 1 && (
                                <span className="text-[10px] opacity-75 font-mono">
                                  (@{unitPrice.toFixed(2)})
                                </span>
                              )}
                              <span className="font-mono text-[11px] opacity-90">{activeCommand.data.currency} {item.amount.toFixed(2)}</span>
                            </button>
                            {qty > 1 && (
                              <button
                                type="button"
                                onClick={() => multiplyReceiptItemByQty(idx)}
                                title={`If ${item.amount.toFixed(2)} is a single-plate price, click to multiply ×${qty}`}
                                className="rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-1 text-[10px] font-semibold text-amber-800 dark:text-amber-300 hover:bg-amber-500/20 cursor-pointer"
                              >
                                ×{qty}
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Compact Editable Fields */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <div className="sm:col-span-2 space-y-1">
                    <label className="text-[10px] uppercase font-bold tracking-wider text-slate-600 dark:text-zinc-400">Description / Merchant</label>
                    <input
                      type="text"
                      value={activeCommand.data.description}
                      onChange={(e) => updateTransactionData({ description: e.target.value })}
                      className="w-full h-9 rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/90 px-3 text-sm text-slate-950 dark:text-white outline-none focus:border-indigo-500 transition-colors"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] uppercase font-bold tracking-wider text-slate-600 dark:text-zinc-400">Total Amount ({activeCommand.data.currency})</label>
                    <input
                      type="number"
                      step="0.01"
                      value={activeCommand.data.amount}
                      onChange={(e) => updateTransactionData({ amount: Number(e.target.value) || 0 })}
                      className="w-full h-9 rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/90 px-3 font-mono font-bold text-sm text-emerald-800 dark:text-emerald-400 outline-none focus:border-indigo-500 transition-colors"
                    />
                  </div>
                  <div className="sm:col-span-3">
                    <MoneyCalculator
                      value={String(activeCommand.data.amount || '')}
                      onChange={(val) => updateTransactionData({ amount: parseFloat(val) || 0 })}
                      currency={activeCommand.data.currency || 'MYR'}
                      compact
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] uppercase font-bold tracking-wider text-slate-600 dark:text-zinc-400">Date</label>
                    <input
                      type="date"
                      value={activeCommand.data.date}
                      onChange={(e) => updateTransactionData({ date: e.target.value })}
                      className="w-full h-9 rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/90 px-3 text-xs text-slate-950 dark:text-white outline-none focus:border-indigo-500 transition-colors"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] uppercase font-bold tracking-wider text-slate-600 dark:text-zinc-400">Category</label>
                    <select
                      value={activeCommand.data.category}
                      onChange={(e) => updateTransactionData({ category: e.target.value })}
                      className="w-full h-9 rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/90 px-2.5 text-xs text-slate-950 dark:text-white outline-none focus:border-indigo-500 transition-colors"
                    >
                      {EXPENSE_CATEGORIES.map((cat) => (
                        <option key={cat} value={cat}>{cat}</option>
                      ))}
                    </select>
                  </div>
                  {(activeCommand.data.taxAmount != null || activeCommand.data.taxRate != null || originalReceiptData != null) && (
                    <div className="space-y-1">
                      <label className="text-[10px] uppercase font-bold tracking-wider text-amber-800/90 dark:text-amber-400/90 flex items-center justify-between gap-1">
                        <span className="truncate" title={activeCommand.data.taxLabel || 'Tax / Service Charge'}>
                          {activeCommand.data.taxLabel ? `Tax (${activeCommand.data.taxLabel})` : 'Tax Rate (%)'}
                        </span>
                        {activeCommand.data.taxAmount != null && activeCommand.data.taxAmount > 0 && (
                          <span className="text-amber-800/70 dark:text-amber-400/70 lowercase font-mono shrink-0">
                            ≈ {activeCommand.data.currency} {activeCommand.data.taxAmount.toFixed(2)}
                          </span>
                        )}
                      </label>
                      <div className="relative">
                        <input
                          type="number"
                          step="0.5"
                          min="0"
                          max="100"
                          placeholder="e.g. 16"
                          value={
                            activeCommand.data.taxRate != null
                              ? activeCommand.data.taxRate
                              : activeCommand.data.taxAmount && (activeCommand.data.subtotal || originalReceiptData?.subtotal)
                              ? Number(((activeCommand.data.taxAmount / (activeCommand.data.subtotal || originalReceiptData!.subtotal)) * 100).toFixed(1))
                              : ''
                          }
                          onChange={(e) => {
                            const val = e.target.value.trim();
                            const subtotal = activeCommand.data.subtotal || originalReceiptData?.subtotal || (activeCommand.data.amount - (activeCommand.data.taxAmount || 0));
                            if (!val) {
                              updateTransactionData({ taxRate: null, taxAmount: null, amount: subtotal });
                              if (originalReceiptData) {
                                setOriginalReceiptData({
                                  ...originalReceiptData,
                                  taxRate: null,
                                  taxAmount: 0,
                                  totalAmount: originalReceiptData.subtotal,
                                });
                              }
                              return;
                            }
                            const r = parseFloat(val);
                            if (isNaN(r) || r < 0) return;
                            const newTax = Number(((subtotal * r) / 100).toFixed(2));
                            updateTransactionData({
                              taxRate: r,
                              taxAmount: newTax,
                              subtotal,
                              amount: Number((subtotal + newTax).toFixed(2)),
                            });
                            if (originalReceiptData) {
                              const origFullTax = Number(((originalReceiptData.subtotal * r) / 100).toFixed(2));
                              setOriginalReceiptData({
                                ...originalReceiptData,
                                taxRate: r,
                                taxAmount: origFullTax,
                                totalAmount: Number((originalReceiptData.subtotal + origFullTax).toFixed(2)),
                              });
                            }
                          }}
                          className="w-full h-9 rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/90 px-3 pr-8 font-mono text-xs text-amber-800 dark:text-amber-300 outline-none focus:border-indigo-500 transition-colors"
                        />
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-500 dark:text-zinc-400 font-mono pointer-events-none">%</span>
                      </div>
                      <div className="flex flex-wrap gap-1 pt-0.5">
                        {[
                          { label: '0%', rate: 0 },
                          { label: '6% SST', rate: 6 },
                          { label: '8% SST', rate: 8 },
                          { label: '10% Svc', rate: 10 },
                          { label: '16% (10+6)', rate: 16 },
                          { label: '18% (10+8)', rate: 18 },
                        ].map((preset) => {
                          const isCurrent = Math.abs((activeCommand.data.taxRate ?? -1) - preset.rate) < 0.05;
                          return (
                            <button
                              key={preset.rate}
                              type="button"
                              onClick={() => {
                                const subtotal = activeCommand.data.subtotal || originalReceiptData?.subtotal || (activeCommand.data.amount - (activeCommand.data.taxAmount || 0));
                                const newTax = Number(((subtotal * preset.rate) / 100).toFixed(2));
                                updateTransactionData({
                                  taxRate: preset.rate,
                                  taxAmount: newTax,
                                  subtotal,
                                  amount: Number((subtotal + newTax).toFixed(2)),
                                  taxLabel: preset.rate === 16 ? '10% Service Charge + 6% SST' : preset.rate === 18 ? '10% Service Charge + 8% SST' : activeCommand.data.taxLabel,
                                });
                                if (originalReceiptData) {
                                  const origFullTax = Number(((originalReceiptData.subtotal * preset.rate) / 100).toFixed(2));
                                  setOriginalReceiptData({
                                    ...originalReceiptData,
                                    taxRate: preset.rate,
                                    taxAmount: origFullTax,
                                    totalAmount: Number((originalReceiptData.subtotal + origFullTax).toFixed(2)),
                                  });
                                }
                              }}
                              className={`rounded-md px-1.5 py-0.5 text-[10px] font-mono font-semibold transition-colors cursor-pointer ${
                                isCurrent
                                  ? 'bg-amber-500/25 border border-amber-500/50 text-amber-900 dark:text-amber-200'
                                  : 'bg-slate-100 dark:bg-zinc-800/80 border border-slate-200 dark:border-zinc-700/60 text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-200'
                              }`}
                            >
                              {preset.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>

                {/* Bottom Action Row: Direct Save & Modal Option */}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-slate-200 dark:border-white/[0.06]">
                  <button
                    type="button"
                    onClick={() => {
                      setAiPrefill({ kind: 'transaction', data: activeCommand.data, receipt: receiptAttachment || undefined });
                      setQuickAddOpen(true);
                      setInput('');
                      setAiParsed(null);
                      setIsAiEnhanced(false);
                      clearReceiptState();
                    }}
                    className="text-[11px] text-slate-600 dark:text-zinc-400 hover:text-slate-800 dark:hover:text-zinc-200 underline underline-offset-2 transition-colors cursor-pointer"
                  >
                    Open full form instead
                  </button>

                  <button
                    type="button"
                    onClick={() => void handleQuickSubmit()}
                    disabled={isSubmitting}
                    className="inline-flex min-h-[38px] items-center gap-1.5 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-4 py-1.5 text-xs font-bold text-white dark:text-white shadow-lg shadow-emerald-500/20 hover:from-emerald-400 hover:to-teal-400 active:scale-[0.98] transition-all cursor-pointer disabled:opacity-50"
                  >
                    {isSubmitting ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        <span>Saving...</span>
                      </>
                    ) : (
                      <>
                        <Check className="h-4 w-4" />
                        <span>Save {activeCommand.data.currency} {activeCommand.data.amount.toFixed(2)} to Records</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            ) : (
              /* Non-receipt compact preview with inline editing support */
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] font-semibold text-slate-600 dark:text-zinc-400">Preview:</span>
                    
                    {isAiEnhanced && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gradient-to-r from-amber-500/20 to-emerald-500/20 text-emerald-800 dark:text-emerald-300 border border-emerald-500/40 text-[10px] font-bold shadow-sm">
                        <Sparkles className="h-3 w-3 text-amber-800 dark:text-amber-400 animate-pulse" />
                        Gemini AI
                      </span>
                    )}

                    {isAiParsing && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400 text-[10px] font-medium animate-pulse">
                        <Loader2 className="h-2.5 w-2.5 animate-spin" />
                        AI parsing...
                      </span>
                    )}

                    {activeCommand.intent === 'transaction' && activeCommand.data && (
                      <>
                        <button
                          type="button"
                          onClick={() => setIsEditingDetails(!isEditingDetails)}
                          title="Click to edit details"
                          className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-indigo-500/15 text-indigo-800 dark:text-indigo-300 border border-indigo-500/30 font-medium hover:bg-indigo-500/25 transition-colors cursor-pointer"
                        >
                          <span>{CATEGORY_EMOJIS[activeCommand.data.category] || '🏷️'}</span>
                          <span>{activeCommand.data.category}</span>
                        </button>
                        <span className="font-mono font-bold text-slate-950 dark:text-white px-2 py-0.5 rounded-lg bg-slate-100 dark:bg-zinc-800/80 border border-slate-300 dark:border-zinc-700/60">
                          {activeCommand.data.currency} {activeCommand.data.amount.toFixed(2)}
                        </span>
                        {localParsed?.formula && !aiParsed && (
                          <span className="rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-2 py-0.5 text-[10px] font-mono font-semibold text-indigo-800 dark:text-indigo-300">
                            🧮 {localParsed.formula}
                          </span>
                        )}
                        {(activeCommand.data.taxAmount != null || activeCommand.data.taxRate != null) && (
                          <span className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-800 dark:text-amber-300">
                            Tax {activeCommand.data.taxRate != null ? `${activeCommand.data.taxRate}%` : activeCommand.data.taxAmount?.toFixed(2)}
                          </span>
                        )}
                        <span className="text-slate-800 dark:text-zinc-200 font-semibold truncate max-w-[160px]">
                          &ldquo;{activeCommand.data.description}&rdquo;
                        </span>
                        <button
                          type="button"
                          onClick={() => setIsEditingDetails(!isEditingDetails)}
                          title="Click to edit date"
                          className="text-[11px] text-slate-600 dark:text-zinc-400 hover:text-slate-800 dark:hover:text-zinc-200 transition-colors cursor-pointer"
                        >
                          • {activeCommand.data.date}
                        </button>
                        {taxPreviewInfo?.isEligible && taxPreviewInfo.category && (
                          <button
                            type="button"
                            onClick={() => receiptInputRef.current?.click()}
                            title={`${taxPreviewInfo.reason} Tap to scan & save receipt photo!`}
                            className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border border-emerald-500/35 text-[10px] font-bold hover:bg-emerald-500/25 transition-colors cursor-pointer"
                          >
                            <span>🇲🇾 LHDN {taxPreviewInfo.category.shortName}</span>
                            {taxPreviewInfo.catStatus && (
                              <span className="font-mono">
                                • RM {taxPreviewInfo.catStatus.remainingLimit.toFixed(0)} left
                              </span>
                            )}
                            <span>• 📸 Snap Receipt</span>
                          </button>
                        )}
                        {!taxPreviewInfo?.isEligible && taxPreviewInfo?.warningMessage && (
                          <span
                            title={taxPreviewInfo.warningMessage}
                            className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-amber-500/15 text-amber-800 dark:text-amber-300 border border-amber-500/35 text-[10px] font-bold"
                          >
                            ⚠️ Not LHDN Deductible
                          </span>
                        )}
                      </>
                    )}

                    {activeCommand.intent === 'installment' && activeCommand.data && (
                      <>
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-amber-500/15 text-amber-800 dark:text-amber-300 border border-amber-500/30 font-medium">
                          Installment • {activeCommand.data.tenureMonths} months
                          {activeCommand.data.annualInterestRate > 0 ? ` • ${activeCommand.data.annualInterestRate}% p.a.` : ''}
                        </span>
                        <span className="font-mono font-bold text-slate-950 dark:text-white px-2 py-0.5 rounded-lg bg-slate-100 dark:bg-zinc-800/80 border border-slate-300 dark:border-zinc-700/60">
                          {activeCommand.data.currency} {activeCommand.data.totalPrincipal.toFixed(2)}
                        </span>
                        <span className="text-slate-800 dark:text-zinc-200 font-semibold truncate max-w-[160px]">&ldquo;{activeCommand.data.name}&rdquo;</span>
                        <span className="text-[11px] text-slate-500 dark:text-zinc-400">• Review form</span>
                      </>
                    )}

                    {activeCommand.intent === 'trade' && activeCommand.data && (
                      <>
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border border-emerald-500/30 font-medium">
                          Trade • {activeCommand.data.action}
                        </span>
                        <span className="font-mono font-bold text-slate-950 dark:text-white px-2 py-0.5 rounded-lg bg-slate-100 dark:bg-zinc-800/80 border border-slate-300 dark:border-zinc-700/60">
                          {activeCommand.data.ticker}
                        </span>
                        <span className="text-slate-800 dark:text-zinc-200 font-semibold truncate max-w-[160px]">
                          {activeCommand.data.quantity ?? '—'} × {activeCommand.data.price ? `${activeCommand.data.currency} ${activeCommand.data.price}` : 'price needed'}
                        </span>
                        <span className="text-[11px] text-slate-500 dark:text-zinc-400">• Review form</span>
                      </>
                    )}

                    {activeCommand.intent === 'trip' && activeCommand.data && (
                      <>
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-cyan-500/15 text-cyan-800 dark:text-cyan-300 border border-cyan-500/30 font-medium">
                          Trip plan
                        </span>
                        <span className="text-slate-800 dark:text-zinc-200 font-semibold truncate max-w-[160px]">&ldquo;{activeCommand.data.name}&rdquo;</span>
                        <span className="font-mono font-bold text-slate-950 dark:text-white px-2 py-0.5 rounded-lg bg-slate-100 dark:bg-zinc-800/80 border border-slate-300 dark:border-zinc-700/60">
                          {activeCommand.data.budget ? `${activeCommand.data.currency} ${activeCommand.data.budget.toFixed(2)}` : 'Budget needed'}
                        </span>
                        <span className="text-[11px] text-slate-500 dark:text-zinc-400">• {activeCommand.data.startDate}</span>
                      </>
                    )}

                    {activeCommand.intent === 'unknown' && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 dark:bg-zinc-800 px-2.5 py-0.5 text-slate-700 dark:text-zinc-300 border border-slate-300 dark:border-zinc-700/60 font-medium">
                        Add more details and try Gemini again
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {activeCommand.intent === 'transaction' ? (
                      <button
                        type="button"
                        onClick={() => setIsEditingDetails((prev) => !prev)}
                        className={`text-[11px] font-bold flex items-center gap-1.5 px-2.5 py-1 rounded-lg border transition-all cursor-pointer shrink-0 ${
                          isEditingDetails
                            ? 'bg-indigo-500/20 text-indigo-800 dark:text-indigo-200 border-indigo-500/40 shadow-sm'
                            : 'bg-slate-100 dark:bg-zinc-800/80 text-indigo-800 dark:text-indigo-300 border-indigo-500/30 hover:bg-indigo-500/15 hover:text-slate-950 dark:hover:text-white'
                        }`}
                      >
                        <Pencil className="h-3 w-3" />
                        <span>{isEditingDetails ? 'Close edit' : 'Tap to edit'}</span>
                      </button>
                    ) : activeCommand.intent !== 'unknown' ? (
                      <button
                        type="button"
                        onClick={() => void handleQuickSubmit()}
                        className="text-[11px] font-bold text-emerald-800 dark:text-emerald-400 hover:text-emerald-800 dark:hover:text-emerald-300 flex items-center gap-1 underline underline-offset-2 cursor-pointer shrink-0"
                      >
                        <Check className="h-3.5 w-3.5" />
                        <span>Review & open form</span>
                      </button>
                    ) : null}
                  </div>
                </div>

                {/* Inline Quick Calculator & Tax Bar right under the preview */}
                {activeCommand.intent === 'transaction' && activeCommand.data && (
                  <MoneyCalculator
                    value={String(activeCommand.data.amount || '')}
                    onChange={(val) => updateTransactionData({ amount: parseFloat(val) || 0 })}
                    currency={activeCommand.data.currency || 'MYR'}
                    compact
                  />
                )}

                {/* Expandable inline editor for typed commands */}
                {isEditingDetails && activeCommand.intent === 'transaction' && activeCommand.data && (
                  <div className="rounded-2xl border border-indigo-500/30 bg-white/90 dark:bg-zinc-950/80 p-3 sm:p-4 text-left shadow-lg space-y-3 mt-1.5 animate-in fade-in slide-in-from-top-1 duration-200">
                    <div className="flex items-center justify-between border-b border-slate-200 dark:border-white/[0.06] pb-2">
                      <div className="flex items-center gap-1.5 text-xs text-indigo-800 dark:text-indigo-300 font-semibold">
                        <Pencil className="h-3.5 w-3.5" />
                        <span>Edit transaction details before saving</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setIsEditingDetails(false)}
                        className="text-[11px] text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white cursor-pointer"
                      >
                        Done
                      </button>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <div className="sm:col-span-2 space-y-1">
                        <label className="text-[10px] uppercase font-bold tracking-wider text-slate-600 dark:text-zinc-400">Description</label>
                        <input
                          type="text"
                          value={activeCommand.data.description}
                          onChange={(e) => updateTransactionData({ description: e.target.value })}
                          className="w-full h-9 rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/90 px-3 text-sm text-slate-950 dark:text-white outline-none focus:border-indigo-500 transition-colors"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] uppercase font-bold tracking-wider text-slate-600 dark:text-zinc-400">Total Amount ({activeCommand.data.currency})</label>
                        <input
                          type="number"
                          step="0.01"
                          value={activeCommand.data.amount}
                          onChange={(e) => updateTransactionData({ amount: Number(e.target.value) || 0 })}
                          className="w-full h-9 rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/90 px-3 font-mono font-bold text-sm text-emerald-800 dark:text-emerald-400 outline-none focus:border-indigo-500 transition-colors"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] uppercase font-bold tracking-wider text-slate-600 dark:text-zinc-400">Date</label>
                        <input
                          type="date"
                          value={activeCommand.data.date}
                          onChange={(e) => updateTransactionData({ date: e.target.value })}
                          className="w-full h-9 rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/90 px-3 text-xs text-slate-950 dark:text-white outline-none focus:border-indigo-500 transition-colors"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] uppercase font-bold tracking-wider text-slate-600 dark:text-zinc-400">Category</label>
                        <select
                          value={activeCommand.data.category}
                          onChange={(e) => updateTransactionData({ category: e.target.value })}
                          className="w-full h-9 rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/90 px-2.5 text-xs text-slate-950 dark:text-white outline-none focus:border-indigo-500 transition-colors"
                        >
                          {EXPENSE_CATEGORIES.map((cat) => (
                            <option key={cat} value={cat}>{cat}</option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] uppercase font-bold tracking-wider text-amber-800/90 dark:text-amber-400/90 flex items-center justify-between">
                          <span>Tax Rate (%)</span>
                          {activeCommand.data.taxAmount != null && activeCommand.data.taxAmount > 0 && (
                            <span className="text-amber-800/70 dark:text-amber-400/70 lowercase font-mono">
                              ≈ {activeCommand.data.currency} {activeCommand.data.taxAmount.toFixed(2)}
                            </span>
                          )}
                        </label>
                        <div className="relative">
                          <input
                            type="number"
                            step="0.5"
                            min="0"
                            max="100"
                            placeholder="e.g. 6 (SST)"
                            value={activeCommand.data.taxRate ?? ''}
                            onChange={(e) => {
                              const val = e.target.value.trim();
                              const base = activeCommand.data.subtotal || (activeCommand.data.taxAmount != null ? Number((activeCommand.data.amount - activeCommand.data.taxAmount).toFixed(2)) : activeCommand.data.amount);
                              if (!val) {
                                updateTransactionData({ taxRate: null, taxAmount: null, amount: base });
                                return;
                              }
                              const r = parseFloat(val);
                              if (isNaN(r) || r < 0) return;
                              const newTax = Number(((base * r) / 100).toFixed(2));
                              updateTransactionData({ 
                                taxRate: r, 
                                taxAmount: newTax,
                                subtotal: base,
                                amount: Number((base + newTax).toFixed(2))
                              });
                            }}
                            className="w-full h-9 rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/90 px-3 pr-8 font-mono text-xs text-amber-800 dark:text-amber-300 outline-none focus:border-indigo-500 transition-colors"
                          />
                          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-500 dark:text-zinc-400 font-mono pointer-events-none">%</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-slate-200 dark:border-white/[0.06]">
                      <button
                        type="button"
                        onClick={() => {
                          setAiPrefill({ kind: 'transaction', data: activeCommand.data });
                          setQuickAddOpen(true);
                          setInput('');
                          setAiParsed(null);
                          setIsAiEnhanced(false);
                          clearReceiptState();
                        }}
                        className="text-[11px] text-slate-600 dark:text-zinc-400 hover:text-slate-800 dark:hover:text-zinc-200 underline underline-offset-2 transition-colors cursor-pointer"
                      >
                        Open full form instead
                      </button>

                      <button
                        type="button"
                        onClick={() => void handleQuickSubmit()}
                        disabled={isSubmitting}
                        className="inline-flex min-h-[38px] items-center gap-1.5 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-4 py-1.5 text-xs font-bold text-white dark:text-white shadow-lg shadow-emerald-500/20 hover:from-emerald-400 hover:to-teal-400 active:scale-[0.98] transition-all cursor-pointer disabled:opacity-50"
                      >
                        {isSubmitting ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            <span>Saving...</span>
                          </>
                        ) : (
                          <>
                            <Check className="h-4 w-4" />
                            <span>Save {activeCommand.data.currency} {activeCommand.data.amount.toFixed(2)} to Records</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
