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
  getItemSearchTarget,
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
  const validTransactions = allTransactions.filter((t) => t && t.id !== 'tx_sample' && Boolean(t.date));

  const cleanKeyword = extractCleanItemKeyword(cleanQuery).toLowerCase();
  const distinctCategories = Array.from(
    new Set(validTransactions.map((t) => t.category).filter((c): c is string => Boolean(c)))
  );
  const targetCategory = resolveTargetCategory(cleanKeyword || cleanQuery, distinctCategories);
  const isCheapestOrPriceLadderQuery = /(最便宜|cheapest|cheaper|哪家|哪间|哪里|price ladder|lowest price|best price)/i.test(cleanQuery);
  const isLargestOrBigExpenseQuery = /(大额|最大|最贵|highest|largest|biggest|most expensive|top spend)/i.test(cleanQuery);

  // Check if query names a specific merchant/item even alongside a category (e.g. "Shell petrol")
  const GENERIC_QUERY_WORDS = new Set([
    '', 'spending', 'expense', 'expenses', 'total', 'budget', 'money', 'food', 'dining',
    'transport', 'petrol', 'fuel', 'shopping', 'bills', 'insurance', 'health', 'sport',
    '支出', '开销', '消费', '预算', '汽油', '油钱', '打油', '打汽油', '餐饮', '交通', '购物',
  ]);
  const { synonyms: keywordSynonyms } = getItemSearchTarget(cleanQuery);
  const hasSpecificEntity = Boolean(
    (cleanKeyword && !targetCategory && !GENERIC_QUERY_WORDS.has(cleanKeyword)) ||
    isCheapestOrPriceLadderQuery
  );

  // 1. If an explicit merchant/item entity or store price-comparison is identified:
  if (hasSpecificEntity && !isLargestOrBigExpenseQuery) {
    const hasExplicitTimeframe = /(?:这个月|本月|上个月|上月|今年|去年|今天|今日|最近|过去\d+天|\d{4}年\d{1,2}月|\b(?:this|last)\s+(?:month|year|30\s+days)\b)/i.test(cleanQuery);
    const timeframe = hasExplicitTimeframe
      ? resolveTimeframe(cleanQuery, today)
      : {
          key: 'all_time' as const,
          label: '历史全部记录 (All Time)',
          startDate: '2000-01-01',
          endDate: '2099-12-31',
        };

    const targetLower = cleanKeyword;
    const searchTerms = Array.from(new Set([targetLower, ...keywordSynonyms.map((s) => s.toLowerCase())])).filter(
      (s) => s && s.length >= 2
    );
    const matchedTxs: T[] = [];
    const storeMap = new Map<string, { store: string; minUnitPrice: number; unit: string; date: string }>();

    for (const tx of validTransactions) {
      if (String(tx.type || '').toLowerCase() !== 'expense') continue;
      if (tx.date < timeframe.startDate || tx.date > timeframe.endDate) continue;

      const desc = (tx.description || '').toLowerCase();
      const cat = (tx.category || '').toLowerCase();
      const notes = typeof (tx as { notes?: unknown }).notes === 'string' ? String((tx as { notes?: unknown }).notes) : '';
      const notesLower = notes.toLowerCase();
      const merchant = typeof (tx as { merchant?: unknown }).merchant === 'string' ? String((tx as { merchant?: unknown }).merchant).toLowerCase() : '';
      const subCategory = typeof (tx as { subCategory?: unknown }).subCategory === 'string' ? String((tx as { subCategory?: unknown }).subCategory).toLowerCase() : '';
      const receiptItems = parseReceiptItemsFromNotes(notes);

      let isMatch = false;

      if (
        searchTerms.some(
          (term) =>
            desc.includes(term) ||
            cat.includes(term) ||
            notesLower.includes(term) ||
            merchant.includes(term) ||
            subCategory.includes(term)
        )
      ) {
        isMatch = true;
      }

      for (const item of receiptItems) {
        const score = scoreReceiptItemQuery(item, targetLower || cleanQuery);
        if (score >= 70 || searchTerms.some((term) => item.name.toLowerCase().includes(term))) {
          isMatch = true;
          const storeName = tx.description || tx.category || 'Unknown Store';
          const existing = storeMap.get(storeName);
          if (!existing || item.unitPrice < existing.minUnitPrice) {
            storeMap.set(storeName, {
              store: storeName,
              minUnitPrice: item.unitPrice,
              unit: /petrol|fuel|ron95|ron97|fuelsave|汽油/i.test(`${item.name} ${cleanQuery}`) ? '/L' : 'item',
              date: tx.date,
            });
          }
        }
      }

      // If cheapest/price ladder query matched a merchant without itemized receipt lines, still rank by tx amount
      if (isMatch && isCheapestOrPriceLadderQuery && receiptItems.length === 0) {
        const storeName = tx.description || tx.category || 'Unknown Store';
        const txAmt = getAmountInBaseCurrency(tx.amount || 0, tx.currency, tx.baseAmount);
        const existing = storeMap.get(storeName);
        if (txAmt > 0 && (!existing || txAmt < existing.minUnitPrice)) {
          storeMap.set(storeName, {
            store: storeName,
            minUnitPrice: Number(txAmt.toFixed(2)),
            unit: 'bill',
            date: tx.date,
          });
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
      queryType: 'merchant_lookup',
      timeframeLabel: timeframe.label,
      timeframeRange: { startDate: timeframe.startDate, endDate: timeframe.endDate },
      itemOrMerchantName: cleanKeyword || cleanQuery,
      exactTotalSpent: 0,
      transactionCount: 0,
      matchingTransactionIds: [],
      isFoundInPersonalLedger: false,
      relevantTransactionsSample: [],
    };
  }

  // 2. Spending Analytics / Budget / Largest Expense Query
  if (
    isSpendingAnalyticsQuery(cleanQuery) ||
    Boolean(targetCategory) ||
    isLargestOrBigExpenseQuery ||
    /(预算|budget|还剩|remaining|开销|支出|spend|spent)/i.test(cleanQuery)
  ) {
    const analytics = computeSpendingAnalytics(cleanQuery, validTransactions, today);
    const matching = isLargestOrBigExpenseQuery
      ? [...analytics.matchingTransactions].sort(
          (a, b) => getAmountInBaseCurrency(b.amount || 0, b.currency, b.baseAmount) - getAmountInBaseCurrency(a.amount || 0, a.currency, a.baseAmount)
        )
      : analytics.matchingTransactions;
    const matchingIds = matching.map((t) => t.id);

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
      relevantTransactionsSample: matching.slice(0, 30),
    };
  }

  // 3. Fallback to general item price or merchant search
  const targetLower = cleanKeyword || cleanQuery.toLowerCase();

  const matchedTxs: T[] = [];
  const storeMap = new Map<string, { store: string; minUnitPrice: number; unit: string; date: string }>();

  for (const tx of validTransactions) {
    if (String(tx.type || '').toLowerCase() !== 'expense') continue;

    const desc = (tx.description || '').toLowerCase();
    const cat = (tx.category || '').toLowerCase();
    const notes = typeof (tx as { notes?: unknown }).notes === 'string' ? String((tx as { notes?: unknown }).notes) : '';
    const notesLower = notes.toLowerCase();
    const merchant = typeof (tx as { merchant?: unknown }).merchant === 'string' ? String((tx as { merchant?: unknown }).merchant).toLowerCase() : '';
    const receiptItems = parseReceiptItemsFromNotes(notes);

    let isMatch = false;

    if (desc.includes(targetLower) || cat.includes(targetLower) || notesLower.includes(targetLower) || merchant.includes(targetLower)) {
      isMatch = true;
    }

    for (const item of receiptItems) {
      const score = scoreReceiptItemQuery(item, targetLower);
      if (score >= 70 || item.name.toLowerCase().includes(targetLower)) {
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
    relevantTransactionsSample: validTransactions.filter((t) => String(t.type || '').toLowerCase() === 'expense').slice(0, 15),
  };
}
