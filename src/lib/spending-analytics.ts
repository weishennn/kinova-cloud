function getLocalDateString(d: Date = new Date()): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export interface SpendingTransaction {
  id: string;
  date: string;
  amount: number;
  type: string;
  category?: string;
  description?: string;
  currency?: string;
  receiptUrl?: string;
}

export interface SpendingTimeframe {
  key: 'this_month' | 'last_month' | 'this_year' | 'all_time' | 'custom_month';
  label: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  prevStartDate?: string;
  prevEndDate?: string;
  prevLabel?: string;
}

export interface SpendingCategoryTarget {
  key: string;
  label: string;
  synonyms: string[];
}

export const KNOWN_CATEGORY_TARGETS: SpendingCategoryTarget[] = [
  {
    key: 'Food',
    label: '餐饮美食 (Food & Dining)',
    synonyms: ['food', 'dining', 'restaurant', 'cafe', 'makan', 'groceries', '餐饮', '饮食', '食物', '饭', '吃', '外卖', '超市', '买菜', '咖啡', 'coffee'],
  },
  {
    key: 'Transport',
    label: '交通出行 (Transport & Fuel)',
    synonyms: ['transport', 'petrol', 'fuel', 'grab', 'taxi', 'parking', 'toll', '交通', '汽油', '油钱', '车', '打车', '泊车', '过路费'],
  },
  {
    key: 'Shopping',
    label: '购物消费 (Shopping)',
    synonyms: ['shopping', 'clothes', 'buy', '购物', '买东西', '衣服', '服饰', '网购', '淘宝', 'shopee', 'lazada'],
  },
  {
    key: 'Entertainment',
    label: '休闲娱乐 (Entertainment)',
    synonyms: ['entertainment', 'movie', 'cinema', 'game', 'games', '娱乐', '电影', '游戏', '玩', '聚会'],
  },
  {
    key: 'Bills',
    label: '水电账单 (Bills & Utilities)',
    synonyms: ['bill', 'bills', 'utilities', 'telco', 'wifi', 'phone', 'electricity', 'water', '账单', '水电', '话费', '网费', '电话费'],
  },
  {
    key: 'Health',
    label: '医疗健康 (Health & Medical)',
    synonyms: ['health', 'medical', 'medicine', 'doctor', 'clinic', 'hospital', 'pharmacy', '医疗', '看病', '药', '诊所', '保健'],
  },
  {
    key: 'Travel',
    label: '旅行度假 (Travel)',
    synonyms: ['travel', 'trip', 'flight', 'hotel', 'airbnb', '旅游', '旅行', '度假', '机票', '酒店', '住宿'],
  },
  {
    key: 'Education',
    label: '学习进修 (Education)',
    synonyms: ['education', 'course', 'class', 'tuition', 'book', 'books', '教育', '学费', '培训', '课程', '书', '书籍'],
  },
];

export interface SpendingAnalyticsResult<T extends SpendingTransaction = SpendingTransaction> {
  isAnalyticsQuery: boolean;
  timeframe: SpendingTimeframe;
  categoryName?: string;
  categoryLabel?: string;
  totalSpent: number;
  currency: string;
  transactionCount: number;
  largestExpense: T | null;
  dailyAverage: number;
  previousPeriodSpent: number | null;
  percentageChange: number | null; // e.g. +15.2 or -8.4
  matchingTransactions: T[];
  categoryBreakdown?: Array<{ category: string; amount: number; percentage: number }>;
  conversationalSummary: string;
}

const SPENDING_INTENT_REGEX = /(花了多少|消费了多少|支出了多少|总开销|总支出|总共花|开销多少|花销|消费统计|本月支出|这个月.*花|上个月.*花|今年.*花|几多钱|一共.*花|how much.*(?:spend|spent)|(?:spend|spent).*how much|total (?:spending|expense)|monthly expense)/i;

export function isSpendingAnalyticsQuery(query: string): boolean {
  const clean = query.trim().toLowerCase();
  if (SPENDING_INTENT_REGEX.test(clean)) return true;
  // Patterns like "food 这个月", "food 支出"
  if (/(food|transport|shopping|餐饮|交通|开销|支出).*(这个月|上个月|今年|总共|花了)/i.test(clean)) return true;
  return false;
}

export function resolveTimeframe(query: string, referenceDateStr?: string): SpendingTimeframe {
  const refDate = referenceDateStr ? new Date(referenceDateStr) : new Date();
  const year = refDate.getFullYear();
  const month = refDate.getMonth(); // 0-indexed

  const clean = query.toLowerCase();

  // 1. Last month / 上个月
  if (/(上个?月|last\s*month|previous\s*month)/i.test(clean)) {
    const prevMonthDate = new Date(year, month - 1, 1);
    const pYear = prevMonthDate.getFullYear();
    const pMonth = prevMonthDate.getMonth();
    const lastDay = new Date(pYear, pMonth + 1, 0).getDate();

    const startDate = `${pYear}-${String(pMonth + 1).padStart(2, '0')}-01`;
    const endDate = `${pYear}-${String(pMonth + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

    // Two months ago for comparison
    const twoMonthsAgo = new Date(pYear, pMonth - 1, 1);
    const twoYear = twoMonthsAgo.getFullYear();
    const twoMonth = twoMonthsAgo.getMonth();
    const twoLastDay = new Date(twoYear, twoMonth + 1, 0).getDate();

    return {
      key: 'last_month',
      label: `${pYear}年${pMonth + 1}月 (上个月)`,
      startDate,
      endDate,
      prevStartDate: `${twoYear}-${String(twoMonth + 1).padStart(2, '0')}-01`,
      prevEndDate: `${twoYear}-${String(twoMonth + 1).padStart(2, '0')}-${String(twoLastDay).padStart(2, '0')}`,
      prevLabel: `${twoYear}年${twoMonth + 1}月`,
    };
  }

  // 2. This year / 今年
  if (/(今年|this\s*year)/i.test(clean)) {
    return {
      key: 'this_year',
      label: `${year}年度`,
      startDate: `${year}-01-01`,
      endDate: `${year}-12-31`,
      prevStartDate: `${year - 1}-01-01`,
      prevEndDate: `${year - 1}-12-31`,
      prevLabel: `${year - 1}年度`,
    };
  }

  // 3. All time / 全部
  if (/(全部|所有|all\s*time|一直以来)/i.test(clean)) {
    return {
      key: 'all_time',
      label: '历史全部记录',
      startDate: '2000-01-01',
      endDate: '2099-12-31',
    };
  }

  // 4. Default: This month / 这个月
  const thisMonthLastDay = new Date(year, month + 1, 0).getDate();
  const startDate = `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const endDate = `${year}-${String(month + 1).padStart(2, '0')}-${String(thisMonthLastDay).padStart(2, '0')}`;

  const prevMonthDate = new Date(year, month - 1, 1);
  const pYear = prevMonthDate.getFullYear();
  const pMonth = prevMonthDate.getMonth();
  const pLastDay = new Date(pYear, pMonth + 1, 0).getDate();

  return {
    key: 'this_month',
    label: `${year}年${month + 1}月 (本月)`,
    startDate,
    endDate,
    prevStartDate: `${pYear}-${String(pMonth + 1).padStart(2, '0')}-01`,
    prevEndDate: `${pYear}-${String(pMonth + 1).padStart(2, '0')}-${String(pLastDay).padStart(2, '0')}`,
    prevLabel: `${pYear}年${pMonth + 1}月`,
  };
}

export function resolveTargetCategory(query: string, availableCategories: string[] = []): { key: string; label: string } | null {
  const clean = query.toLowerCase();

  // First check predefined targets
  for (const target of KNOWN_CATEGORY_TARGETS) {
    if (target.synonyms.some((syn) => clean.includes(syn))) {
      return { key: target.key, label: target.label };
    }
  }

  // Check available ledger categories
  for (const cat of availableCategories) {
    if (!cat) continue;
    const catLower = cat.toLowerCase();
    if (clean.includes(catLower)) {
      return { key: cat, label: cat };
    }
  }

  return null;
}

function formatAmount(currency: string, amount: number): string {
  const curr = /^[A-Z]{3}$/.test(currency) ? currency : 'MYR';
  try {
    return new Intl.NumberFormat('zh-CN', {
      style: 'currency',
      currency: curr,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${curr} ${amount.toFixed(2)}`;
  }
}

export function computeSpendingAnalytics<T extends SpendingTransaction = SpendingTransaction>(
  query: string,
  transactions: T[],
  referenceDateStr?: string
): SpendingAnalyticsResult<T> {
  const isAnalytics = isSpendingAnalyticsQuery(query);
  const timeframe = resolveTimeframe(query, referenceDateStr);

  const distinctCategories = Array.from(
    new Set(transactions.map((t) => t.category).filter((c): c is string => Boolean(c)))
  );
  const targetCategory = resolveTargetCategory(query, distinctCategories);

  // Filter expenses within target timeframe
  const periodExpenses = transactions.filter((t) => {
    if (String(t.type || '').toLowerCase() !== 'expense') return false;
    return t.date >= timeframe.startDate && t.date <= timeframe.endDate;
  });

  // Filter matching category if requested
  const matchingTransactions = periodExpenses.filter((t) => {
    if (!targetCategory) return true;
    const catLower = (t.category || '').toLowerCase();
    const descLower = (t.description || '').toLowerCase();
    const targetKeyLower = targetCategory.key.toLowerCase();

    if (catLower.includes(targetKeyLower) || targetKeyLower.includes(catLower)) return true;

    // Also check synonym matches
    const known = KNOWN_CATEGORY_TARGETS.find((k) => k.key.toLowerCase() === targetKeyLower);
    if (known && known.synonyms.some((syn) => catLower.includes(syn) || descLower.includes(syn))) {
      return true;
    }
    return false;
  }).sort((a, b) => b.date.localeCompare(a.date) || b.amount - a.amount);

  const currency = matchingTransactions[0]?.currency || transactions[0]?.currency || 'MYR';
  const totalSpent = Number(matchingTransactions.reduce((acc, t) => acc + (t.amount || 0), 0).toFixed(2));
  const transactionCount = matchingTransactions.length;

  const largestExpense = matchingTransactions.length > 0
    ? [...matchingTransactions].sort((a, b) => b.amount - a.amount)[0]
    : null;

  // Daily average
  const todayStr = referenceDateStr || getLocalDateString();
  let daysCount = 30;
  if (timeframe.key === 'this_month') {
    const todayDate = new Date(todayStr);
    daysCount = Math.max(1, todayDate.getDate());
  } else {
    const start = new Date(timeframe.startDate).getTime();
    const end = new Date(timeframe.endDate).getTime();
    daysCount = Math.max(1, Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1);
  }
  const dailyAverage = Number((totalSpent / daysCount).toFixed(2));

  // Compute previous period comparison
  let previousPeriodSpent: number | null = null;
  let percentageChange: number | null = null;

  if (timeframe.prevStartDate && timeframe.prevEndDate) {
    const prevPeriodExpenses = transactions.filter((t) => {
      if (String(t.type || '').toLowerCase() !== 'expense') return false;
      if (t.date < timeframe.prevStartDate! || t.date > timeframe.prevEndDate!) return false;
      if (!targetCategory) return true;

      const catLower = (t.category || '').toLowerCase();
      const descLower = (t.description || '').toLowerCase();
      const targetKeyLower = targetCategory.key.toLowerCase();
      if (catLower.includes(targetKeyLower) || targetKeyLower.includes(catLower)) return true;

      const known = KNOWN_CATEGORY_TARGETS.find((k) => k.key.toLowerCase() === targetKeyLower);
      if (known && known.synonyms.some((syn) => catLower.includes(syn) || descLower.includes(syn))) {
        return true;
      }
      return false;
    });

    previousPeriodSpent = Number(prevPeriodExpenses.reduce((acc, t) => acc + (t.amount || 0), 0).toFixed(2));
    if (previousPeriodSpent > 0) {
      percentageChange = Number((((totalSpent - previousPeriodSpent) / previousPeriodSpent) * 100).toFixed(1));
    }
  }

  // Category breakdown if user asked for all expenses
  let categoryBreakdown: Array<{ category: string; amount: number; percentage: number }> | undefined;
  if (!targetCategory && periodExpenses.length > 0 && totalSpent > 0) {
    const catMap = new Map<string, number>();
    for (const t of periodExpenses) {
      const cat = t.category || 'Other';
      catMap.set(cat, (catMap.get(cat) || 0) + t.amount);
    }
    categoryBreakdown = Array.from(catMap.entries())
      .map(([category, amount]) => ({
        category,
        amount: Number(amount.toFixed(2)),
        percentage: Number(((amount / totalSpent) * 100).toFixed(1)),
      }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5);
  }

  // Generate conversational natural language summary
  const catText = targetCategory ? `在「${targetCategory.label}」分类` : '总共';
  let conversationalSummary = `你${timeframe.label}${catText}支出了 ${formatAmount(currency, totalSpent)}（共 ${transactionCount} 笔账单）。`;

  if (percentageChange !== null && previousPeriodSpent !== null) {
    if (percentageChange > 0) {
      conversationalSummary += ` 相比上期 (${formatAmount(currency, previousPeriodSpent)}) 增长了 +${percentageChange}%。`;
    } else if (percentageChange < 0) {
      conversationalSummary += ` 相比上期 (${formatAmount(currency, previousPeriodSpent)}) 节省了 ${Math.abs(percentageChange)}%。`;
    } else {
      conversationalSummary += ` 与上期支出持平。`;
    }
  }

  if (largestExpense) {
    conversationalSummary += ` 其中单笔最高的一笔是 ${largestExpense.date} 的「${largestExpense.description || largestExpense.category}」(${formatAmount(currency, largestExpense.amount)})。`;
  }

  return {
    isAnalyticsQuery: isAnalytics,
    timeframe,
    categoryName: targetCategory?.key,
    categoryLabel: targetCategory?.label,
    totalSpent,
    currency,
    transactionCount,
    largestExpense,
    dailyAverage,
    previousPeriodSpent,
    percentageChange,
    matchingTransactions,
    categoryBreakdown,
    conversationalSummary,
  };
}
