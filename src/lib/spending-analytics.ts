import { getAmountInBaseCurrency } from './currency.ts';
import { extractCleanItemKeyword } from './receipt-items.ts';

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
  baseAmount?: number;
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
    synonyms: ['housing', 'bill', 'bills', 'utilities', 'telco', 'wifi', 'phone', 'electricity', 'water', 'rent', 'rental', '账单', '水电', '话费', '网费', '电话费', '房租', '居家'],
  },
  {
    key: 'Health',
    label: '医疗健康 (Health & Medical)',
    synonyms: ['health', 'medical', 'medicine', 'doctor', 'clinic', 'hospital', 'pharmacy', '医疗', '看病', '药', '诊所', '保健'],
  },
  {
    key: 'Insurance',
    label: '保险保障 (Insurance)',
    synonyms: ['insurance', 'takaful', 'aia', 'prudential', 'great eastern', 'allianz', 'medical card', '保险', '保费', '保单', '医药卡'],
  },
  {
    key: 'Parents',
    label: '孝亲家用 (Parents)',
    synonyms: ['parents', 'parent', 'mom', 'dad', 'mother', 'father', '父母', '家用', '孝亲', '妈妈', '爸爸'],
  },
  {
    key: 'Sport',
    label: '运动健身 (Sport)',
    synonyms: ['sport', 'sports', 'badminton', 'gym', 'fitness', 'workout', 'running', 'swimming', 'pickleball', '运动', '羽毛球', '健身', '跑步', '球场'],
  },
  {
    key: 'Gift',
    label: '礼物红包 (Gift)',
    synonyms: ['gift', 'gifts', 'present', 'angpow', 'angpao', 'hongbao', 'red packet', 'donation', '礼物', '红包', '送礼', '人情', '礼金'],
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

const SPENDING_INTENT_REGEX = /(花了多少|消费了多少|支出了多少|总开销|总支出|总共花|开销多少|花销|消费统计|本月支出|这个月.*花|上个月.*花|今年.*花|去年.*花|几多钱|一共.*花|how much.*(?:spend|spent)|(?:spend|spent).*how much|total (?:spending|expense)|monthly expense)/i;
const COMPLEX_ADVISORY_OR_BUDGET_REGEX = /(预算|budget|还剩|remaining|left|目标|goal|还差|能买|买得起|afford|值得|worth|平衡|rebalance|最便宜|cheapest|哪家|compare|对比|大额|largest|biggest|为什么|why|建议|advice|should i|can i|扣税|tax|relief)/i;

export function isSpendingAnalyticsQuery(query: string): boolean {
  const clean = query.trim().toLowerCase();
  if (COMPLEX_ADVISORY_OR_BUDGET_REGEX.test(clean)) return false;
  if (SPENDING_INTENT_REGEX.test(clean)) return true;
  if (/(food|transport|shopping|sport|insurance|parents|gift|bills|餐饮|交通|运动|保险|购物|水电|开销|支出).*(这个月|上个月|今年|去年|总共|花了)/i.test(clean)) return true;
  return false;
}

export function resolveTimeframe(query: string, referenceDateStr?: string): SpendingTimeframe {
  const refDate = referenceDateStr ? new Date(referenceDateStr) : new Date();
  const year = refDate.getFullYear();
  const month = refDate.getMonth(); // 0-indexed

  const clean = query.toLowerCase();

  // 1. Explicit YYYY年M月 or Month Name (e.g. "9月", "10月")
  const cnMonthMatch = clean.match(/(?:(\d{4})\s*年\s*)?(1[0-2]|0?[1-9])\s*月/);
  if (cnMonthMatch && !/(这个月|本月|上个月|上月)/.test(clean)) {
    const targetY = cnMonthMatch[1] ? parseInt(cnMonthMatch[1], 10) : year;
    const targetM = parseInt(cnMonthMatch[2], 10); // 1-12
    const lastDay = new Date(targetY, targetM, 0).getDate();
    const prevDate = new Date(targetY, targetM - 2, 1);
    const pYear = prevDate.getFullYear();
    const pMonth = prevDate.getMonth() + 1;
    const pLastDay = new Date(pYear, pMonth, 0).getDate();

    return {
      key: 'custom_month',
      label: `${targetY}年${targetM}月`,
      startDate: `${targetY}-${String(targetM).padStart(2, '0')}-01`,
      endDate: `${targetY}-${String(targetM).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
      prevStartDate: `${pYear}-${String(pMonth).padStart(2, '0')}-01`,
      prevEndDate: `${pYear}-${String(pMonth).padStart(2, '0')}-${String(pLastDay).padStart(2, '0')}`,
      prevLabel: `${pYear}年${pMonth}月`,
    };
  }

  // 2. Last month / 上个月
  if (/(上个?月|last\s*month|previous\s*month)/i.test(clean)) {
    const prevMonthDate = new Date(year, month - 1, 1);
    const pYear = prevMonthDate.getFullYear();
    const pMonth = prevMonthDate.getMonth();
    const lastDay = new Date(pYear, pMonth + 1, 0).getDate();

    const startDate = `${pYear}-${String(pMonth + 1).padStart(2, '0')}-01`;
    const endDate = `${pYear}-${String(pMonth + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

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

  // 3. Last year / 去年
  if (/(去年|last\s*year|previous\s*year)/i.test(clean)) {
    const lastYear = year - 1;
    return {
      key: 'this_year',
      label: `${lastYear}年度 (去年)`,
      startDate: `${lastYear}-01-01`,
      endDate: `${lastYear}-12-31`,
      prevStartDate: `${lastYear - 1}-01-01`,
      prevEndDate: `${lastYear - 1}-12-31`,
      prevLabel: `${lastYear - 1}年度`,
    };
  }

  // 4. This year / 今年
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

  // 5. Recent 30 days / 最近
  if (/(最近|近期|过去\s*30\s*天|last\s*30\s*days|recent)/i.test(clean)) {
    const start = new Date(refDate);
    start.setDate(start.getDate() - 29);
    const prevEnd = new Date(start);
    prevEnd.setDate(prevEnd.getDate() - 1);
    const prevStart = new Date(prevEnd);
    prevStart.setDate(prevStart.getDate() - 29);
    return {
      key: 'all_time',
      label: '最近 30 天',
      startDate: getLocalDateString(start),
      endDate: getLocalDateString(refDate),
      prevStartDate: getLocalDateString(prevStart),
      prevEndDate: getLocalDateString(prevEnd),
      prevLabel: '前 30 天',
    };
  }

  // 6. All time / 全部
  if (/(全部|所有|all\s*time|一直以来|一共|总共)/i.test(clean) && !/(这个月|本月|今天|今日|今年)/.test(clean)) {
    return {
      key: 'all_time',
      label: '历史全部记录',
      startDate: '2000-01-01',
      endDate: '2099-12-31',
    };
  }

  // 7. Default: This month / 这个月
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

function matchesSynonymToken(clean: string, syn: string): boolean {
  const s = syn.toLowerCase().trim();
  if (!s) return false;
  if (/[\u4e00-\u9fa5]/.test(s)) {
    return clean.includes(s);
  }
  const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'i').test(clean);
}

export function resolveTargetCategory(query: string, availableCategories: string[] = []): { key: string; label: string } | null {
  const clean = query.toLowerCase();

  // 1. Check predefined targets (preserving canonical short keys like 'Food' and 'Bills')
  for (const target of KNOWN_CATEGORY_TARGETS) {
    if (target.synonyms.some((syn) => matchesSynonymToken(clean, syn))) {
      return { key: target.key, label: target.label };
    }
  }

  // 2. Check available ledger categories
  for (const cat of availableCategories) {
    if (!cat) continue;
    const catLower = cat.toLowerCase();
    if (matchesSynonymToken(clean, catLower)) {
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

function getTxBaseMyr(t: SpendingTransaction): number {
  return getAmountInBaseCurrency(t.amount || 0, t.currency, t.baseAmount);
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
  const extractedKeyword = extractCleanItemKeyword(query).toLowerCase().trim();
  const GENERIC_SPEND_WORDS = new Set([
    '', 'spending', 'expense', 'expenses', 'total', 'overall', 'all', 'money',
    '支出', '开销', '消费', '花销', '总支出', '总开销', '整体支出', '整体', '全部', '所有', '一共', '总共',
    '大额', '大额开支', '大额消费', '开支', '预算', '最近', '最大', '最贵',
  ]);
  const NON_ENTITY_PHRASE_REGEX =
    /(?:大额|最大|最贵|最近|有什么|多少|怎么|还剩|剩下|预算|目标|储蓄|建议|总结|对比|比较|largest|biggest|most expensive|highest|recent|remaining|left|budget|summary|advice|top\s*spend)/i;
  const targetMerchant =
    !targetCategory &&
    extractedKeyword.length >= 2 &&
    !GENERIC_SPEND_WORDS.has(extractedKeyword) &&
    !NON_ENTITY_PHRASE_REGEX.test(extractedKeyword)
      ? extractedKeyword
      : null;

  const matchesFilter = (t: T): boolean => {
    if (t.id === 'tx_sample') return false;
    if (targetCategory) {
      const catLower = (t.category || '').toLowerCase();
      const descLower = (t.description || '').toLowerCase();
      const targetKeyLower = targetCategory.key.toLowerCase();

      if (catLower.includes(targetKeyLower) || targetKeyLower.includes(catLower)) return true;

      const known = KNOWN_CATEGORY_TARGETS.find((k) => k.key.toLowerCase() === targetKeyLower);
      if (known && known.synonyms.some((syn) => catLower.includes(syn) || descLower.includes(syn))) {
        return true;
      }
      return false;
    }
    if (targetMerchant) {
      const descLower = (t.description || '').toLowerCase();
      const catLower = (t.category || '').toLowerCase();
      const notesLower = typeof (t as { notes?: unknown }).notes === 'string'
        ? String((t as { notes?: unknown }).notes).toLowerCase()
        : '';
      return descLower.includes(targetMerchant) || catLower.includes(targetMerchant) || notesLower.includes(targetMerchant);
    }
    return true;
  };

  const periodExpenses = transactions.filter((t) => {
    if (t.id === 'tx_sample') return false;
    if (String(t.type || '').toLowerCase() !== 'expense') return false;
    return t.date >= timeframe.startDate && t.date <= timeframe.endDate;
  });

  const matchingTransactions = periodExpenses
    .filter(matchesFilter)
    .sort((a, b) => b.date.localeCompare(a.date) || getTxBaseMyr(b) - getTxBaseMyr(a));

  const currency = matchingTransactions[0]?.currency || transactions[0]?.currency || 'MYR';
  const totalSpent = Number(matchingTransactions.reduce((acc, t) => acc + getTxBaseMyr(t), 0).toFixed(2));
  const transactionCount = matchingTransactions.length;

  const largestExpense =
    matchingTransactions.length > 0
      ? [...matchingTransactions].sort((a, b) => getTxBaseMyr(b) - getTxBaseMyr(a))[0]
      : null;

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

  let previousPeriodSpent: number | null = null;
  let percentageChange: number | null = null;

  if (timeframe.prevStartDate && timeframe.prevEndDate) {
    const prevPeriodExpenses = transactions.filter((t) => {
      if (t.id === 'tx_sample') return false;
      if (String(t.type || '').toLowerCase() !== 'expense') return false;
      if (t.date < timeframe.prevStartDate! || t.date > timeframe.prevEndDate!) return false;
      return matchesFilter(t);
    });

    previousPeriodSpent = Number(prevPeriodExpenses.reduce((acc, t) => acc + getTxBaseMyr(t), 0).toFixed(2));
    if (previousPeriodSpent > 0) {
      percentageChange = Number((((totalSpent - previousPeriodSpent) / previousPeriodSpent) * 100).toFixed(1));
    }
  }

  let categoryBreakdown: Array<{ category: string; amount: number; percentage: number }> | undefined;
  if (!targetCategory && !targetMerchant && periodExpenses.length > 0 && totalSpent > 0) {
    const catMap = new Map<string, number>();
    for (const t of periodExpenses) {
      const cat = t.category || 'Other';
      catMap.set(cat, (catMap.get(cat) || 0) + getTxBaseMyr(t));
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

  const catText = targetCategory
    ? `在「${targetCategory.label}」分类`
    : targetMerchant
    ? `在「${targetMerchant}」`
    : '总共';
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
    const largestMyr = getTxBaseMyr(largestExpense);
    conversationalSummary += ` 其中单笔最高的一笔是 ${largestExpense.date} 的「${largestExpense.description || largestExpense.category}」(${formatAmount(currency, largestMyr)})。`;
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
