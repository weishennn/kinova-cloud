import {
  computeSpendingAnalytics,
  type SpendingTransaction,
  type SpendingTimeframe,
  isSpendingAnalyticsQuery,
} from './spending-analytics.ts';
import {
  parseReceiptItemsFromNotes,
  extractCleanItemKeyword,
  scoreReceiptItemQuery,
} from './receipt-items.ts';
import { getLocalDateString } from './date-helper.ts';

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
 * Zero truncation of transaction totals, ensuring AI Copilot answers with mathematical precision.
 */
export function computeDeterministicLedgerFacts<T extends SpendingTransaction>(
  query: string,
  allTransactions: T[],
  referenceDateStr?: string
): DeterministicLedgerFacts {
  const cleanQuery = query.trim();
  const today = referenceDateStr || getLocalDateString();

  // 1. Is this a spending analytics query (e.g. "今年总共花了多少", "这个月在餐饮花了多少", "上月交通支出")?
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
            amount: analytics.largestExpense.amount,
          }
        : null,
      relevantTransactionsSample: analytics.matchingTransactions.slice(0, 30),
    };
  }

  // 2. Is this an item price or merchant search (e.g. "四夕豆花吃过什么", "哪里打汽油最便宜", "买过鸡蛋多少钱")?
  const cleanKeyword = extractCleanItemKeyword(cleanQuery).toLowerCase();
  const targetLower = cleanKeyword || cleanQuery.toLowerCase();

  // Find all transactions matching merchant or receipt items
  const matchedTxs: T[] = [];
  const storeMap = new Map<string, { store: string; minUnitPrice: number; unit: string; date: string }>();

  for (const tx of allTransactions) {
    if (tx.type !== 'expense') continue;

    const desc = (tx.description || '').toLowerCase();
    const cat = (tx.category || '').toLowerCase();
    const notes = (tx.receiptUrl ? '' : '') + (typeof (tx as any).notes === 'string' ? (tx as any).notes : '');
    const receiptItems = parseReceiptItemsFromNotes(notes);

    let isMatch = false;

    // Check direct description or category matching
    if (desc.includes(targetLower) || cat.includes(targetLower)) {
      isMatch = true;
    }

    // Check receipt items
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
    // Sort matching transactions by date descending
    matchedTxs.sort((a, b) => b.date.localeCompare(a.date));

    const totalSpent = Number(matchedTxs.reduce((sum, t) => sum + (t.amount || 0), 0).toFixed(2));
    const matchingIds = matchedTxs.map((t) => t.id);

    // Build price ladder if multiple stores found
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

  // 3. Not found in user's personal ledger
  return {
    queryType: 'item_lookup',
    timeframeLabel: '个人账本检索',
    itemOrMerchantName: cleanKeyword || cleanQuery,
    exactTotalSpent: 0,
    transactionCount: 0,
    matchingTransactionIds: [],
    isFoundInPersonalLedger: false,
    relevantTransactionsSample: allTransactions.filter((t) => t.type === 'expense').slice(0, 15),
  };
}
