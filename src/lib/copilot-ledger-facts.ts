import {
  computeSpendingAnalytics,
  type SpendingTransaction,
  isSpendingAnalyticsQuery,
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

  // 1. Is this a spending analytics query?
  if (isSpendingAnalyticsQuery(cleanQuery)) {
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

  // 2. Is this an item price or merchant search?
  const cleanKeyword = extractCleanItemKeyword(cleanQuery).toLowerCase();
  const targetLower = cleanKeyword || cleanQuery.toLowerCase();

  const matchedTxs: T[] = [];
  const storeMap = new Map<string, { store: string; minUnitPrice: number; unit: string; date: string }>();

  for (const tx of allTransactions) {
    if (String(tx.type || '').toLowerCase() !== 'expense') continue;

    const desc = (tx.description || '').toLowerCase();
    const cat = (tx.category || '').toLowerCase();
    const notes = typeof (tx as any).notes === 'string' ? (tx as any).notes : '';
    const receiptItems = parseReceiptItemsFromNotes(notes);

    let isMatch = false;

    if (desc.includes(targetLower) || cat.includes(targetLower)) {
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
