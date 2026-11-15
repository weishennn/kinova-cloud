import {
  computeSpendingAnalytics,
  type SpendingTransaction,
  isSpendingAnalyticsQuery,
  resolveTargetCategory,
  resolveTimeframe,
} from './spending-analytics.ts';
import {
  parseReceiptItemsFromNotes,
  extractCleanItemKeyword,
  scoreReceiptItemQuery,
} from './receipt-items.ts';
import { getLocalDateString } from './date-helper.ts';
import { getAmountInBaseCurrency } from './currency.ts';

export interface DeterministicLedgerFacts {
  queryType: 'analytics' | 'item_lookup' | 'merchant_lookup' | 'general';
  timeframeLabel: string;
  timeframeRange?: { startDate: string; endDate: string };
  categoryLabel?: string;
  exactTotalSpent: number;
  transactionCount: number;
  matchingTransactionIds: string[];
  isFoundInPersonalLedger: boolean;
  categoryBreakdown?: Array<{ category: string; amount: number; percentage: number }>;
  largestExpense?: {
    id: string;
    date: string;
    description: string;
    category: string;
    amount: number;
  } | null;
  itemOrMerchantName?: string;
  priceLadder?: Array<{
    store: string;
    unitPrice: number;
    unit: string;
    date: string;
    isLowest: boolean;
  }>;
  relevantTransactionsSample: SpendingTransaction[];
}

/**
 * Computes deterministic numerical facts across 100% of the user's ledger transactions.
 * Converts all foreign-currency records into base MYR before summing.
 */
export function computeDeterministicLedgerFacts<T extends SpendingTransaction>(
  query: string,
  allTransactions: T[],
  referenceDateStr?: string
): DeterministicLedgerFacts {
  const cleanQuery = query.trim();
  const today = referenceDateStr || getLocalDateString();

  const cleanKeyword = extractCleanItemKeyword(cleanQuery).toLowerCase();
  const distinctCategories = Array.from(
    new Set(allTransactions.map((t) => t.category).filter((c): c is string => Boolean(c)))
  );
  const targetCategory = resolveTargetCategory(cleanKeyword || cleanQuery, distinctCategories);

  // 1. If an explicit merchant/item entity is identified (and it is NOT a broad canonical category):
  // Perform dedicated entity/merchant lookup to prevent general category totals from hijacking the response.
  const hasSpecificEntity = Boolean(cleanKeyword && !targetCategory);

  if (hasSpecificEntity) {
    const hasExplicitTimeframe = /(?:这个月|本月|上个月|上月|今年|去年|今天|今日|\d{4}年\d{1,2}月|\b(?:this|last)\s+month|\bthis\s+year)/i.test(cleanQuery);
    const timeframe = hasExplicitTimeframe
      ? resolveTimeframe(cleanQuery, today)
      : {
          key: 'all_time' as const,
          label: '历史全部记录 (All Time)',
          startDate: '2000-01-01',
          endDate: '2099-12-31',
        };

    const targetLower = cleanKeyword;
    const matchedTxs: T[] = [];
    const storeMap = new Map<string, { store: string; minUnitPrice: number; unit: string; date: string }>();

    for (const tx of allTransactions) {
      if (String(tx.type || '').toLowerCase() !== 'expense') continue;
      if (tx.date < timeframe.startDate || tx.date > timeframe.endDate) continue;

      const desc = (tx.description || '').toLowerCase();
      const cat = (tx.category || '').toLowerCase();
      const notes = typeof (tx as any).notes === 'string' ? (tx as any).notes : '';
      const notesLower = notes.toLowerCase();
      const merchant = typeof (tx as any).merchant === 'string' ? (tx as any).merchant.toLowerCase() : '';
      const subCategory = typeof (tx as any).subCategory === 'string' ? (tx as any).subCategory.toLowerCase() : '';
      const receiptItems = parseReceiptItemsFromNotes(notes);

      let isMatch = false;

      if (
        desc.includes(targetLower) ||
        cat.includes(targetLower) ||
        notesLower.includes(targetLower) ||
        merchant.includes(targetLower) ||
        subCategory.includes(targetLower)
      ) {
        isMatch = true;
      }

      for (const item of receiptItems) {
        const score = scoreReceiptItemQuery(item, targetLower);
        if (score > 0 || item.name.toLowerCase().includes(targetLower)) {
          isMatch = true;
          const storeName = tx.description || tx.category || 'Unknown Store';
          const existing = storeMap.get(storeName);
          if (!existing || item.unitPrice < existing.minUnitPrice) {
            storeMap.set(storeName, {
              store: storeName,
              minUnitPrice: item.unitPrice,
              unit: 'item',
              date: tx.date,
            });
          }
        }
      }

      if (isMatch) {
        matchedTxs.push(tx);
      }
    }

    if (matchedTxs.length > 0) {
      matchedTxs.sort((a, b) => b.date.localeCompare(a.date));

      const totalSpent = Number(
        matchedTxs
          .reduce((sum, t) => sum + getAmountInBaseCurrency(t.amount || 0, t.currency, t.baseAmount), 0)
          .toFixed(2)
      );
      const matchingIds = matchedTxs.map((t) => t.id);

      const priceLadder = Array.from(storeMap.values())
        .sort((a, b) => a.minUnitPrice - b.minUnitPrice)
        .map((entry, idx) => ({
          store: entry.store,
          unitPrice: entry.minUnitPrice,
          unit: entry.unit,
          date: entry.date,
          isLowest: idx === 0,
        }));

      return {
        queryType: storeMap.size > 0 ? 'item_lookup' : 'merchant_lookup',
        timeframeLabel: timeframe.label,
        timeframeRange: { startDate: timeframe.startDate, endDate: timeframe.endDate },
        itemOrMerchantName: cleanKeyword,
        exactTotalSpent: totalSpent,
        transactionCount: matchedTxs.length,
        matchingTransactionIds: matchingIds,
        isFoundInPersonalLedger: true,
        priceLadder: priceLadder.length > 0 ? priceLadder : undefined,
        relevantTransactionsSample: matchedTxs.slice(0, 30),
      };
    }

    return {
      queryType: 'merchant_lookup',
      timeframeLabel: timeframe.label,
      timeframeRange: { startDate: timeframe.startDate, endDate: timeframe.endDate },
      itemOrMerchantName: cleanKeyword,
      exactTotalSpent: 0,
      transactionCount: 0,
      matchingTransactionIds: [],
      isFoundInPersonalLedger: false,
      relevantTransactionsSample: [],
    };
  }

  // 2. Spending Analytics Query (category or full timeframe)
  if (isSpendingAnalyticsQuery(cleanQuery) || targetCategory) {
    const analytics = computeSpendingAnalytics(cleanQuery, allTransactions, today);
    const matchingIds = analytics.matchingTransactions.map((t) => t.id);

    return {
      queryType: 'analytics',
      timeframeLabel: analytics.timeframe.label,
      timeframeRange: {
        startDate: analytics.timeframe.startDate,
        endDate: analytics.timeframe.endDate,
      },
      categoryLabel: analytics.categoryLabel,
      exactTotalSpent: analytics.totalSpent,
      transactionCount: analytics.transactionCount,
      matchingTransactionIds: matchingIds,
      isFoundInPersonalLedger: analytics.transactionCount > 0,
      categoryBreakdown: analytics.categoryBreakdown,
      largestExpense: analytics.largestExpense
        ? {
            id: analytics.largestExpense.id,
            date: analytics.largestExpense.date,
            description: analytics.largestExpense.description || analytics.largestExpense.category || '',
            category: analytics.largestExpense.category || 'Other',
            amount: Number(
              getAmountInBaseCurrency(
                analytics.largestExpense.amount,
                analytics.largestExpense.currency,
                analytics.largestExpense.baseAmount
              ).toFixed(2)
            ),
          }
        : null,
      relevantTransactionsSample: analytics.matchingTransactions.slice(0, 30),
    };
  }

  // 3. Fallback to general item price or merchant search
  const targetLower = cleanKeyword || cleanQuery.toLowerCase();

  const matchedTxs: T[] = [];
  const storeMap = new Map<string, { store: string; minUnitPrice: number; unit: string; date: string }>();

  for (const tx of allTransactions) {
    if (String(tx.type || '').toLowerCase() !== 'expense') continue;

    const desc = (tx.description || '').toLowerCase();
    const cat = (tx.category || '').toLowerCase();
    const notes = typeof (tx as any).notes === 'string' ? (tx as any).notes : '';
    const notesLower = notes.toLowerCase();
    const merchant = typeof (tx as any).merchant === 'string' ? (tx as any).merchant.toLowerCase() : '';
    const receiptItems = parseReceiptItemsFromNotes(notes);

    let isMatch = false;

    if (desc.includes(targetLower) || cat.includes(targetLower) || notesLower.includes(targetLower) || merchant.includes(targetLower)) {
      isMatch = true;
    }

    for (const item of receiptItems) {
      const score = scoreReceiptItemQuery(item, targetLower);
      if (score > 0 || item.name.toLowerCase().includes(targetLower)) {
        isMatch = true;
        const storeName = tx.description || tx.category || 'Unknown Store';
        const existing = storeMap.get(storeName);
        if (!existing || item.unitPrice < existing.minUnitPrice) {
          storeMap.set(storeName, {
            store: storeName,
            minUnitPrice: item.unitPrice,
            unit: 'item',
            date: tx.date,
          });
        }
      }
    }

    if (isMatch) {
      matchedTxs.push(tx);
    }
  }

  if (matchedTxs.length > 0) {
    matchedTxs.sort((a, b) => b.date.localeCompare(a.date));

    const totalSpent = Number(
      matchedTxs
        .reduce((sum, t) => sum + getAmountInBaseCurrency(t.amount || 0, t.currency, t.baseAmount), 0)
        .toFixed(2)
    );
    const matchingIds = matchedTxs.map((t) => t.id);

    const priceLadder = Array.from(storeMap.values())
      .sort((a, b) => a.minUnitPrice - b.minUnitPrice)
      .map((entry, idx) => ({
        store: entry.store,
        unitPrice: entry.minUnitPrice,
        unit: entry.unit,
        date: entry.date,
        isLowest: idx === 0,
      }));

    return {
      queryType: storeMap.size > 0 ? 'item_lookup' : 'merchant_lookup',
      timeframeLabel: '历史全部记录 (All Time)',
      itemOrMerchantName: cleanKeyword || cleanQuery,
      exactTotalSpent: totalSpent,
      transactionCount: matchedTxs.length,
      matchingTransactionIds: matchingIds,
      isFoundInPersonalLedger: true,
      priceLadder: priceLadder.length > 0 ? priceLadder : undefined,
      relevantTransactionsSample: matchedTxs.slice(0, 30),
    };
  }

  return {
    queryType: 'item_lookup',
    timeframeLabel: '个人账本检索',
    itemOrMerchantName: cleanKeyword || cleanQuery,
    exactTotalSpent: 0,
    transactionCount: 0,
    matchingTransactionIds: [],
    isFoundInPersonalLedger: false,
    relevantTransactionsSample: allTransactions.filter((t) => String(t.type || '').toLowerCase() === 'expense').slice(0, 15),
  };
}
