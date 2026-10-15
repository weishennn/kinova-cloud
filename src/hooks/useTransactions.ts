import { useMemo, useState, useEffect } from 'react';
import { useSheetData, useAddRow, useUpdateRow, useDeleteRow } from './useSheets';

import { parseCurrencyAmount } from '@/lib/sheets-api';
import { getAmountInBaseCurrency } from '@/lib/currency';
import { parseLocalDate } from '@/lib/date-helper';
import { parseLegacyPaidItemsFromNotes, parseReceiptItemsFromNotes, type StoredReceiptItem } from '@/lib/receipt-items';
import { isMonthInRollingWindow } from '@/lib/cache-manager';
import {
  buildSplitwiseTransactionsFromTrips,
  fetchSplitwiseTripSnapshot,
  getSavedSplitwiseConnection,
} from '@/lib/splitwise';

const refreshedInviteCodesThisSession = new Set<string>();

// Standardized Transaction Interface
export interface Transaction {
  id: string;
  date: string;
  amount: number;
  type: 'income' | 'expense' | 'investment';
  category: string;
  subCategory?: string;
  description: string;
  account: string;
  currency: string;
  baseAmount?: number;
  baseCurrency?: string;
  fxRateToBase?: number;
  notes?: string;
  receiptItems?: StoredReceiptItem[];
  tripTag?: string;
  tripId?: string;
  receiptUrl?: string;
  _month?: string;
  _rowIndex?: number;
}

export function normalizeTransaction(raw: Record<string, unknown>): Transaction {
  const amountVal = raw.Amount !== undefined ? raw.Amount : raw.amount;
  const numAmount = parseCurrencyAmount(amountVal);
  
  const rawType = String(raw.Type || raw.type || 'expense').toLowerCase();
  const type: 'income' | 'expense' | 'investment' = 
    rawType === 'income' ? 'income' : rawType === 'investment' ? 'investment' : 'expense';

  const category = String(raw.Category || raw.category || 'Other');
  const description = String(raw.Description || raw.description || raw.title || category);
  const trip = String(raw.TripTag || raw.tripTag || raw.tripId || '');
  const rawBaseAmount = raw.BaseAmount !== undefined ? raw.BaseAmount : raw.baseAmount !== undefined ? raw.baseAmount : raw.base_amount;
  const parsedBaseAmount = rawBaseAmount === undefined || rawBaseAmount === null || rawBaseAmount === ''
    ? undefined
    : parseCurrencyAmount(rawBaseAmount);

  const notes = String(raw.Notes || raw.notes || '');
  const storedReceiptItems = parseReceiptItemsFromNotes(notes);

  return {
    id: String(raw.Id || raw.id || `tx_${Math.random().toString(36).substring(2, 9)}`),
    date: String(raw.Date || raw.date || ''),
    amount: Math.abs(numAmount),
    type: type,
    category: category,
    subCategory: String(raw.SubCategory || raw.subCategory || ''),
    description: description,
    account: String(raw.PaymentMethod || raw.paymentMethod || raw.account || ''),
    currency: String(raw.Currency || raw.currency || 'MYR'),
    baseAmount: Number.isFinite(parsedBaseAmount) ? parsedBaseAmount : undefined,
    baseCurrency: String(raw.BaseCurrency || raw.baseCurrency || raw.base_currency || 'MYR'),
    fxRateToBase: Number(raw.FxRateToBase || raw.fxRateToBase || raw.fx_rate_to_base || 0) || undefined,
    notes,
    receiptItems: storedReceiptItems.length > 0
      ? storedReceiptItems
      : parseLegacyPaidItemsFromNotes(notes),
    tripTag: trip,
    tripId: trip,
    receiptUrl: String(raw.ReceiptUrl || raw.receiptUrl || ''),
    _month: String(raw._month || (raw.Date ? String(raw.Date).substring(0, 7) : '')),
    _rowIndex: typeof raw._rowIndex === 'number' ? raw._rowIndex : undefined,
  };
}

export function useTransactions(filters?: { period?: string; month?: string; from?: string; to?: string; type?: string; category?: string }) {
  const period = filters?.period || filters?.month;
  const effectivePeriod = period && /^\d{4}-\d{2}$/.test(period) && isMonthInRollingWindow(period)
    ? undefined
    : period;
  const { data, isLoading, error, refetch } = useSheetData('Transactions', effectivePeriod);
  const { data: tripsData } = useSheetData('Trips');
  const rows = data?.rows;
  const tripsRows = tripsData?.rows;

  const [trixpenseTick, setTrixpenseTick] = useState(0);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const bump = () => setTrixpenseTick((prev) => prev + 1);
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void refetch();
      }
    };
    const onPageShow = () => {
      void refetch();
    };
    window.addEventListener('trixpense-sync-updated', bump);
    window.addEventListener('storage', bump);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      window.removeEventListener('trixpense-sync-updated', bump);
      window.removeEventListener('storage', bump);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [refetch]);

  // Automatically refresh linked Trixpense trip snapshots once per session in the background
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const codes = new Set<string>();
    if (Array.isArray(tripsRows)) {
      tripsRows.forEach((row: any, idx: number) => {
        const name = String(row?.TripName || row?.tripName || row?.Name || row?.name || `Trip #${idx + 1}`).trim();
        const id = String(row?.Id || row?.id || name).trim();
        const conn = getSavedSplitwiseConnection(id) || getSavedSplitwiseConnection(name);
        if (conn?.inviteCode) codes.add(conn.inviteCode);
      });
    }
    try {
      const prefix = 'cashflow:splitwise-link:';
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        if (!key || !key.startsWith(prefix)) continue;
        const tripId = decodeURIComponent(key.slice(prefix.length));
        const conn = getSavedSplitwiseConnection(tripId);
        if (conn?.inviteCode) codes.add(conn.inviteCode);
      }
    } catch {
      // ignore
    }

    codes.forEach((code) => {
      if (refreshedInviteCodesThisSession.has(code)) return;
      refreshedInviteCodesThisSession.add(code);
      void fetchSplitwiseTripSnapshot(code).catch(() => {
        // Ignore background refresh errors
      });
    });
  }, [tripsRows]);

  const filterFrom = filters?.from;
  const filterTo = filters?.to;
  const filterType = filters?.type;
  const filterCategory = filters?.category;

  const transactions = useMemo(() => {
    const rawRows = Array.isArray(rows) ? rows : [];
    
    // Normalize every row (handles both Google Sheet capital headers and lowercase)
    let list = rawRows.map((row) => normalizeTransaction(row as Record<string, unknown>));

    // Merge user's personal share of linked Trixpense trip expenses
    const trixpenseRows = buildSplitwiseTransactionsFromTrips(
      (Array.isArray(tripsRows) ? tripsRows : []) as Array<Record<string, unknown>>,
    );
    if (trixpenseRows.length > 0) {
      list = [
        ...list,
        ...trixpenseRows.map((tx) => ({
          ...tx,
          _month: tx.date.substring(0, 7),
        })),
      ];
    }

    // Exclude starter placeholder and empty rows
    list = list.filter(t => t.id !== 'tx_sample' && !!t.date);

    // Multi-tier Deduplication:
    // 1) First tier: Deduplicate by unique transaction ID (preferring row with receiptUrl or _rowIndex)
    const idMap = new Map<string, Transaction>();
    const deduplicatedById: Transaction[] = [];

    for (const t of list) {
      if (!t.id) continue;
      if (idMap.has(t.id)) {
        const existing = idMap.get(t.id)!;
        // Keep row with receiptUrl or valid row index
        if (!existing.receiptUrl && t.receiptUrl) {
          idMap.set(t.id, t);
        } else if (existing._rowIndex === undefined && t._rowIndex !== undefined) {
          idMap.set(t.id, t);
        }
        continue;
      }
      idMap.set(t.id, t);
      deduplicatedById.push(t);
    }

    list = deduplicatedById;

    if (period && /^\d{4}-\d{2}$/.test(period)) {
      list = list.filter(t => t.date.startsWith(period));
    }
    if (filterFrom) {
      list = list.filter(t => t.date >= filterFrom);
    }
    if (filterTo) {
      list = list.filter(t => t.date <= filterTo);
    }
    if (filterType) {
      list = list.filter(t => t.type === filterType);
    }
    if (filterCategory) {
      list = list.filter(t => t.category === filterCategory);
    }

    // Sort by date descending, breaking same-day ties by newest appended row (_rowIndex descending)
    return list.sort((a, b) => {
      const dateDiff = parseLocalDate(b.date).getTime() - parseLocalDate(a.date).getTime();
      if (dateDiff !== 0) return dateDiff;
      const rowA = typeof a._rowIndex === 'number' ? a._rowIndex : Number.MAX_SAFE_INTEGER;
      const rowB = typeof b._rowIndex === 'number' ? b._rowIndex : Number.MAX_SAFE_INTEGER;
      return rowB - rowA;
    });
  }, [rows, tripsRows, trixpenseTick, period, filterFrom, filterTo, filterType, filterCategory]);

  return { transactions, isLoading, error, refetch };
}

export function useTransactionSummary(period?: { from: string; to: string }) {
  const { transactions, isLoading } = useTransactions(period);

  const summary = useMemo(() => {
    let totalIncome = 0;
    let totalExpense = 0;

    transactions.forEach(t => {
      const baseAmount = getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount);
      if (t.type === 'income') totalIncome += baseAmount;
      if (t.type === 'expense') totalExpense += baseAmount;
    });

    return {
      totalIncome,
      totalExpense,
      balance: totalIncome - totalExpense,
    };
  }, [transactions]);

  return { summary, isLoading };
}

export function useCategoryBreakdown(period?: { from: string; to: string }) {
  const { transactions, isLoading } = useTransactions(period);

  const breakdown = useMemo(() => {
    const expensesByCategory: Record<string, number> = {};
    
    transactions
      .filter(t => t.type === 'expense')
      .forEach(t => {
        expensesByCategory[t.category] = (expensesByCategory[t.category] || 0) +
          getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount);
      });

    return Object.entries(expensesByCategory)
      .map(([category, amount]) => ({ name: category, value: amount }))
      .sort((a, b) => b.value - a.value);
  }, [transactions]);

  return { breakdown, isLoading };
}

export function useAddTransaction() {
  const mutation = useAddRow();
  return {
    ...mutation,
    mutate: (rowData: Record<string, unknown>, options?: Parameters<typeof mutation.mutate>[1]) =>
      mutation.mutate({ sheetName: 'Transactions', rowData }, options),
    mutateAsync: (rowData: Record<string, unknown>, options?: Parameters<typeof mutation.mutateAsync>[1]) =>
      mutation.mutateAsync({ sheetName: 'Transactions', rowData }, options),
  };
}

export function useUpdateTransaction() {
  const mutation = useUpdateRow();
  return {
    ...mutation,
    mutate: (args: { rowIndex: number; rowData: Record<string, unknown> }, options?: Parameters<typeof mutation.mutate>[1]) =>
      mutation.mutate({ sheetName: 'Transactions', ...args }, options),
    mutateAsync: (args: { rowIndex: number; rowData: Record<string, unknown> }, options?: Parameters<typeof mutation.mutateAsync>[1]) =>
      mutation.mutateAsync({ sheetName: 'Transactions', ...args }, options),
  };
}

export function useDeleteTransaction() {
  const mutation = useDeleteRow();
  return {
    ...mutation,
    mutate: (args: { id?: string; rowIndex?: number; sheetName?: string }, options?: Parameters<typeof mutation.mutate>[1]) =>
      mutation.mutate({ sheetName: args.sheetName || 'Transactions', rowIndex: args.rowIndex, id: args.id }, options),
    mutateAsync: (args: { id?: string; rowIndex?: number; sheetName?: string }, options?: Parameters<typeof mutation.mutateAsync>[1]) =>
      mutation.mutateAsync({ sheetName: args.sheetName || 'Transactions', rowIndex: args.rowIndex, id: args.id }, options),
  };
}
