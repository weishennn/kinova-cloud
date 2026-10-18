import { getLocalDateString, getDaysInMonth } from './date-helper.ts';
import { getAmountInBaseCurrency } from './currency.ts';
import { type MinimalTransaction } from './habit-suggestions.ts';

export interface ProactiveAlert {
  id: string;
  type: 'budget_pace' | 'price_increase' | 'category_spike';
  severity: 'warning' | 'info' | 'critical';
  title: string;
  message: string;
  explanation: string;
  actionLabel: string;
  actionCategory?: string;
  actionSearchTerm?: string;
  matchingTransactionIds: string[];
}

const KNOWN_SUBSCRIPTION_KEYWORDS = [
  'netflix', 'spotify', 'youtube', 'unifi', 'maxis', 'celcom', 'digi', 'umobile', 'time',
  'astro', 'chatgpt', 'openai', 'claude', 'anthropic', 'apple', 'icloud', 'google one',
  'prime', 'disney', 'gym', 'fitness', 'coway', 'cuckoo', 'indah water', 'tnb'
];

/**
 * Mines transactions to discover explainable, numerical proactive alerts:
 * 1. Month-end budget overspend projection
 * 2. Subscription/recurring bill price changes
 * 3. Category spending spikes vs trailing 3-month daily pace
 */
export function generateProactiveAlerts<T extends MinimalTransaction>(
  allTransactions: T[],
  budgetCap?: number,
  referenceDateStr?: string
): ProactiveAlert[] {
  const alerts: ProactiveAlert[] = [];
  if (!Array.isArray(allTransactions) || allTransactions.length === 0) return alerts;

  const todayStr = referenceDateStr || getLocalDateString();
  const today = new Date(todayStr);
  const currentYear = today.getFullYear();
  const currentMonthNum = today.getMonth() + 1; // 1-12
  const currentMonthStr = `${currentYear}-${String(currentMonthNum).padStart(2, '0')}`;
  const dayOfMonth = Math.max(1, today.getDate());
  const totalDaysInMonth = getDaysInMonth(currentYear, currentMonthNum);

  // Separate current month vs past months expenses
  const currentMonthExpenses = allTransactions.filter(
    (t) => t.type === 'expense' && t.date?.startsWith(currentMonthStr) && t.amount > 0
  );

  const prevMonthDate = new Date(currentYear, currentMonthNum - 2, 1);
  const prevMonthStr = `${prevMonthDate.getFullYear()}-${String(prevMonthDate.getMonth() + 1).padStart(2, '0')}`;
  const prevMonthExpenses = allTransactions.filter(
    (t) => t.type === 'expense' && t.date?.startsWith(prevMonthStr) && t.amount > 0
  );

  const currentMonthTotal = Number(
    currentMonthExpenses
      .reduce((sum, t) => sum + getAmountInBaseCurrency(t.amount, t.currency), 0)
      .toFixed(2)
  );

  const prevMonthTotal = Number(
    prevMonthExpenses
      .reduce((sum, t) => sum + getAmountInBaseCurrency(t.amount, t.currency), 0)
      .toFixed(2)
  );

  // 1. Month-End Overspend Projection (Run-rate pacing)
  const baselineThreshold = (budgetCap && budgetCap > 0) ? budgetCap : prevMonthTotal;
  if (dayOfMonth >= 3 && currentMonthTotal > 80 && baselineThreshold > 100) {
    const dailyPace = currentMonthTotal / dayOfMonth;
    const projectedMonthEnd = Math.round(dailyPace * totalDaysInMonth);

    if (projectedMonthEnd >= baselineThreshold * 1.15) {
      const overspendDelta = projectedMonthEnd - baselineThreshold;
      const overspendPercent = Math.round((overspendDelta / baselineThreshold) * 100);
      const isCritical = projectedMonthEnd >= baselineThreshold * 1.3;

      alerts.push({
        id: `alert_budget_pace_${currentMonthStr}`,
        type: 'budget_pace',
        severity: isCritical ? 'critical' : 'warning',
        title: isCritical ? '月底超支红色预警' : '月底超支偏高预警',
        message: `按当前日均支出速度，预计本月底将支出 RM ${projectedMonthEnd.toLocaleString('en-MY')}，可能超出预算基准约 ${overspendPercent}%。`,
        explanation: `依据：本月已过 ${dayOfMonth} 天（共 ${totalDaysInMonth} 天），累计支出 RM ${currentMonthTotal.toFixed(2)}，当前日均 RM ${dailyPace.toFixed(2)}。基准开销为 RM ${baselineThreshold.toFixed(2)}（日均基准 RM ${(baselineThreshold / totalDaysInMonth).toFixed(2)}）。`,
        actionLabel: `查看本月账目 (${currentMonthExpenses.length}笔)`,
        matchingTransactionIds: currentMonthExpenses.map((t) => t.id),
      });
    }
  }

  // 2. Subscription / Recurring Price Changes
  // Group current and previous month transactions by normalized merchant
  const currMerchantMap = new Map<string, { merchant: string; amount: number; tx: T }>();
  for (const t of currentMonthExpenses) {
    const desc = (t.description || t.category || '').trim();
    const lower = desc.toLowerCase();
    const isSub = KNOWN_SUBSCRIPTION_KEYWORDS.some((kw) => lower.includes(kw));
    if (isSub) {
      currMerchantMap.set(lower, { merchant: desc, amount: t.amount, tx: t });
    }
  }

  const prevMerchantMap = new Map<string, { merchant: string; amount: number; tx: T }>();
  for (const t of prevMonthExpenses) {
    const desc = (t.description || t.category || '').trim();
    const lower = desc.toLowerCase();
    const isSub = KNOWN_SUBSCRIPTION_KEYWORDS.some((kw) => lower.includes(kw));
    if (isSub) {
      prevMerchantMap.set(lower, { merchant: desc, amount: t.amount, tx: t });
    }
  }

  for (const [key, curr] of currMerchantMap.entries()) {
    const prev = prevMerchantMap.get(key);
    if (prev && Math.abs(curr.amount - prev.amount) >= 2.0) {
      const delta = curr.amount - prev.amount;
      const isIncrease = delta > 0;
      const pctChange = Math.round((Math.abs(delta) / prev.amount) * 100);

      alerts.push({
        id: `alert_sub_price_${key}`,
        type: 'price_increase',
        severity: isIncrease ? 'warning' : 'info',
        title: isIncrease ? `订阅扣费上涨提醒 (${curr.merchant})` : `订阅费用变动 (${curr.merchant})`,
        message: `检测到「${curr.merchant}」本月扣款与上月存在金额变动。`,
        explanation: `依据：上月 (${prevMonthStr}) 扣款 RM ${prev.amount.toFixed(2)}，本月 (${currentMonthStr}) 扣款 RM ${curr.amount.toFixed(2)}，变动 ${isIncrease ? '+' : '-'}RM ${Math.abs(delta).toFixed(2)} (${isIncrease ? '+' : '-'}${pctChange}%)。`,
        actionLabel: `查看「${curr.merchant}」扣款记录`,
        actionSearchTerm: curr.merchant,
        matchingTransactionIds: [curr.tx.id, prev.tx.id],
      });
    }
  }

  // 3. Category Spending Spikes (vs Trailing 3-month daily pace)
  // Calculate trailing 3-month category daily averages
  const trailingCatTotals = new Map<string, { total: number; days: number }>();
  for (let mOffset = 1; mOffset <= 3; mOffset++) {
    const pDate = new Date(currentYear, currentMonthNum - 1 - mOffset, 1);
    const pStr = `${pDate.getFullYear()}-${String(pDate.getMonth() + 1).padStart(2, '0')}`;
    const pDays = getDaysInMonth(pDate.getFullYear(), pDate.getMonth() + 1);

    const mExpenses = allTransactions.filter(
      (t) => t.type === 'expense' && t.date?.startsWith(pStr) && t.amount > 0
    );

    for (const t of mExpenses) {
      const cat = t.category || 'Other';
      const existing = trailingCatTotals.get(cat) || { total: 0, days: 0 };
      existing.total += getAmountInBaseCurrency(t.amount, t.currency);
      trailingCatTotals.set(cat, existing);
    }

    // Add days for each category present
    for (const entry of trailingCatTotals.values()) {
      entry.days += pDays;
    }
  }

  // Current month category totals
  const currCatTotals = new Map<string, { total: number; txs: T[] }>();
  for (const t of currentMonthExpenses) {
    const cat = t.category || 'Other';
    const existing = currCatTotals.get(cat) || { total: 0, txs: [] };
    existing.total += getAmountInBaseCurrency(t.amount, t.currency);
    existing.txs.push(t);
    currCatTotals.set(cat, existing);
  }

  for (const [cat, curr] of currCatTotals.entries()) {
    const hist = trailingCatTotals.get(cat);
    if (!hist || hist.days === 0 || hist.total < 100) continue;

    const histDailyPace = hist.total / hist.days;
    const currDailyPace = curr.total / dayOfMonth;

    if (curr.total >= 150 && currDailyPace >= histDailyPace * 1.35) {
      const increasePct = Math.round(((currDailyPace - histDailyPace) / histDailyPace) * 100);

      alerts.push({
        id: `alert_cat_spike_${cat}`,
        type: 'category_spike',
        severity: 'warning',
        title: `「${cat}」支出进度偏高`,
        message: `本月「${cat}」支出进度显著快于往期同期平均水平。`,
        explanation: `依据：本月「${cat}」已累计支出 RM ${curr.total.toFixed(2)}（日均 RM ${currDailyPace.toFixed(2)}），过去 3 个月该分类日均仅 RM ${histDailyPace.toFixed(2)}，增速达 +${increasePct}%。`,
        actionLabel: `查看「${cat}」账目 (${curr.txs.length}笔)`,
        actionCategory: cat,
        matchingTransactionIds: curr.txs.map((t) => t.id),
      });
    }
  }

  return alerts;
}
