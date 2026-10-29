import { getLocalDateString, getDaysInMonth } from './date-helper.ts';
import { getAmountInBaseCurrency } from './currency.ts';
import { type MinimalTransaction } from './habit-suggestions.ts';

export interface ProactiveAlert {
  id: string;
  type: 'budget_pace' | 'price_increase' | 'category_spike' | 'habit_anticipation' | 'habit_discovery';
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
  referenceDateStr?: string,
  userLanguage?: 'zh' | 'en' | 'ms' | 'auto'
): ProactiveAlert[] {
  const alerts: ProactiveAlert[] = [];
  if (!Array.isArray(allTransactions) || allTransactions.length === 0) return alerts;

  let lang = userLanguage;
  if (!lang || lang === 'auto') {
    if (typeof window !== 'undefined') {
      try {
        const stored = localStorage.getItem('cashflow_preferred_language');
        if (stored === 'zh' || stored === 'en' || stored === 'ms') {
          lang = stored;
        } else if (typeof navigator !== 'undefined') {
          const nav = (navigator.language || '').toLowerCase();
          if (nav.startsWith('ms') || nav.startsWith('id')) lang = 'ms';
          else if (nav.startsWith('en')) lang = 'en';
          else lang = 'zh';
        }
      } catch {}
    }
  }
  const effectiveLang = lang === 'en' || lang === 'ms' ? lang : 'zh';

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
        title: effectiveLang === 'en'
          ? (isCritical ? 'Month-end budget warning' : 'Month-end spending pace is high')
          : effectiveLang === 'ms'
            ? (isCritical ? 'Amaran bajet hujung bulan' : 'Kadar belanja hujung bulan tinggi')
            : (isCritical ? '月底超支红色预警' : '月底超支偏高预警'),
        message: effectiveLang === 'en'
          ? `At the current daily pace, spending may reach RM ${projectedMonthEnd.toLocaleString('en-MY')} by month-end, about ${overspendPercent}% above the budget baseline.`
          : effectiveLang === 'ms'
            ? `Pada kadar harian semasa, perbelanjaan mungkin mencecah RM ${projectedMonthEnd.toLocaleString('en-MY')} menjelang hujung bulan, kira-kira ${overspendPercent}% melebihi asas bajet.`
            : `按当前日均支出速度，预计本月底将支出 RM ${projectedMonthEnd.toLocaleString('en-MY')}，可能超出预算基准约 ${overspendPercent}%。`,
        explanation: effectiveLang === 'en'
          ? `Based on ${dayOfMonth} of ${totalDaysInMonth} days: RM ${currentMonthTotal.toFixed(2)} spent so far, averaging RM ${dailyPace.toFixed(2)}/day. The baseline is RM ${baselineThreshold.toFixed(2)} (RM ${(baselineThreshold / totalDaysInMonth).toFixed(2)}/day).`
          : effectiveLang === 'ms'
            ? `Berdasarkan ${dayOfMonth} daripada ${totalDaysInMonth} hari: RM ${currentMonthTotal.toFixed(2)} telah dibelanjakan, purata RM ${dailyPace.toFixed(2)}/hari. Asas bajet ialah RM ${baselineThreshold.toFixed(2)} (RM ${(baselineThreshold / totalDaysInMonth).toFixed(2)}/hari).`
            : `依据：本月已过 ${dayOfMonth} 天（共 ${totalDaysInMonth} 天），累计支出 RM ${currentMonthTotal.toFixed(2)}，当前日均 RM ${dailyPace.toFixed(2)}。基准开销为 RM ${baselineThreshold.toFixed(2)}（日均基准 RM ${(baselineThreshold / totalDaysInMonth).toFixed(2)}）。`,
        actionLabel: effectiveLang === 'en'
          ? `View this month's records (${currentMonthExpenses.length})`
          : effectiveLang === 'ms'
            ? `Lihat rekod bulan ini (${currentMonthExpenses.length})`
            : `查看本月账目 (${currentMonthExpenses.length}笔)`,
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
        title: effectiveLang === 'en'
          ? (isIncrease ? `Subscription price increased (${curr.merchant})` : `Subscription price changed (${curr.merchant})`)
          : effectiveLang === 'ms'
            ? (isIncrease ? `Harga langganan meningkat (${curr.merchant})` : `Harga langganan berubah (${curr.merchant})`)
            : (isIncrease ? `订阅扣费上涨提醒 (${curr.merchant})` : `订阅费用变动 (${curr.merchant})`),
        message: effectiveLang === 'en'
          ? `The ${curr.merchant} charge changed this month compared with last month.`
          : effectiveLang === 'ms'
            ? `Caj ${curr.merchant} bulan ini berubah berbanding bulan lepas.`
            : `检测到「${curr.merchant}」本月扣款与上月存在金额变动。`,
        explanation: effectiveLang === 'en'
          ? `Ledger records: RM ${prev.amount.toFixed(2)} in ${prevMonthStr} and RM ${curr.amount.toFixed(2)} in ${currentMonthStr}, a ${isIncrease ? '+' : '-'}RM ${Math.abs(delta).toFixed(2)} (${isIncrease ? '+' : '-'}${pctChange}%) change.`
          : effectiveLang === 'ms'
            ? `Rekod lejar: RM ${prev.amount.toFixed(2)} pada ${prevMonthStr} dan RM ${curr.amount.toFixed(2)} pada ${currentMonthStr}, perubahan ${isIncrease ? '+' : '-'}RM ${Math.abs(delta).toFixed(2)} (${isIncrease ? '+' : '-'}${pctChange}%).`
            : `依据：上月 (${prevMonthStr}) 扣款 RM ${prev.amount.toFixed(2)}，本月 (${currentMonthStr}) 扣款 RM ${curr.amount.toFixed(2)}，变动 ${isIncrease ? '+' : '-'}RM ${Math.abs(delta).toFixed(2)} (${isIncrease ? '+' : '-'}${pctChange}%)。`,
        actionLabel: effectiveLang === 'en'
          ? `View ${curr.merchant} charges`
          : effectiveLang === 'ms'
            ? `Lihat caj ${curr.merchant}`
            : `查看「${curr.merchant}」扣款记录`,
        actionSearchTerm: curr.merchant,
        matchingTransactionIds: [curr.tx.id, prev.tx.id],
      });
    }
  }

  // 3. Category Spending Spikes (vs Trailing 3-month daily pace)
  // For each trailing month, track spending and ONLY credit that month's days to categories that were actually active in that month
  const trailingCatTotals = new Map<string, { total: number; days: number }>();
  for (let mOffset = 1; mOffset <= 3; mOffset++) {
    const pDate = new Date(currentYear, currentMonthNum - 1 - mOffset, 1);
    const pStr = `${pDate.getFullYear()}-${String(pDate.getMonth() + 1).padStart(2, '0')}`;
    const pDays = getDaysInMonth(pDate.getFullYear(), pDate.getMonth() + 1);

    const mExpenses = allTransactions.filter(
      (t) => t.type === 'expense' && t.date?.startsWith(pStr) && t.amount > 0
    );

    const monthCatMap = new Map<string, number>();
    for (const t of mExpenses) {
      const cat = t.category || 'Other';
      monthCatMap.set(cat, (monthCatMap.get(cat) || 0) + getAmountInBaseCurrency(t.amount, t.currency));
    }

    for (const [cat, amt] of monthCatMap.entries()) {
      if (amt > 0) {
        const existing = trailingCatTotals.get(cat) || { total: 0, days: 0 };
        existing.total += amt;
        existing.days += pDays; // ONLY add days for months where this category had spending > 0!
        trailingCatTotals.set(cat, existing);
      }
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

      let title = `「${cat}」支出进度偏高`;
      let message = `本月「${cat}」支出进度显著快于往期活跃月份平均水平。`;
      let explanation = `依据：本月「${cat}」已累计支出 RM ${curr.total.toFixed(2)}（日均 RM ${currDailyPace.toFixed(2)}），往期活跃月份（共 ${hist.days} 天）日均 RM ${histDailyPace.toFixed(2)}，增速达 +${increasePct}%。`;
      let actionLabel = `查看「${cat}」账目 (${curr.txs.length}笔)`;

      if (effectiveLang === 'en') {
        title = `High Spending Pace in "${cat}"`;
        message = `Spending pace in "${cat}" this month is significantly higher than historical active months.`;
        explanation = `Basis: "${cat}" spent RM ${curr.total.toFixed(2)} so far (daily RM ${currDailyPace.toFixed(2)}). Historical active months (${hist.days} days) averaged RM ${histDailyPace.toFixed(2)}/day, a +${increasePct}% surge.`;
        actionLabel = `View "${cat}" records (${curr.txs.length})`;
      } else if (effectiveLang === 'ms') {
        title = `Kadar Perbelanjaan Tinggi untuk "${cat}"`;
        message = `Kadar perbelanjaan "${cat}" bulan ini jauh lebih laju berbanding bulan-bulan aktif sebelum ini.`;
        explanation = `Asas: RM ${curr.total.toFixed(2)} dibelanjakan untuk "${cat}" (harian RM ${currDailyPace.toFixed(2)}). Purata bulan aktif (${hist.days} hari) ialah RM ${histDailyPace.toFixed(2)}/hari (+${increasePct}%).`;
        actionLabel = `Lihat rekod "${cat}" (${curr.txs.length})`;
      }

      alerts.push({
        id: `alert_cat_spike_${cat}`,
        type: 'category_spike',
        severity: 'warning',
        title,
        message,
        explanation,
        actionLabel,
        actionCategory: cat,
        matchingTransactionIds: curr.txs.map((t) => t.id),
      });
    }
  }

  // 4. Proactive Habit Anticipation (e.g. Lunch/Dinner contextual habits)
  if (typeof window !== 'undefined') {
    try {
      const now = new Date();
      const currentHour = now.getHours();
      const isLunchTime = currentHour >= 11 && currentHour < 15;
      const isDinnerTime = currentHour >= 17 && currentHour < 21;
      if (isLunchTime || isDinnerTime) {
        const slotLabel = isLunchTime ? '午餐' : '晚餐';
        const slotLabelEn = isLunchTime ? 'lunch' : 'dinner';
        const slotLabelMs = isLunchTime ? 'makan tengah hari' : 'makan malam';
        const todayTxs = currentMonthExpenses.filter((t) => t.date === todayStr);
        const hasFoodToday = todayTxs.some(
          (t) => (t.category || '').toLowerCase().includes('food') || (t.category || '').toLowerCase().includes('dining')
        );

        if (!hasFoodToday) {
          const rawHabits = localStorage.getItem('cashflow_habit_memory');
          if (rawHabits) {
            const habits = JSON.parse(rawHabits);
            if (Array.isArray(habits)) {
              if (hasFoodToday === false) {
                alerts.push({
                  id: `alert_habit_meal_${todayStr}`,
                  type: 'habit_anticipation',
                  severity: 'info',
                  title: effectiveLang === 'en'
                    ? `🍱 It's ${slotLabelEn} time`
                    : effectiveLang === 'ms'
                      ? `🍱 Masa ${slotLabelMs}`
                      : `🍱 ${slotLabel}时间到了`,
                  message: effectiveLang === 'en'
                    ? `Have you had ${slotLabelEn}? Tap to record it.`
                    : effectiveLang === 'ms'
                      ? `Sudah makan ${slotLabelMs}? Ketik untuk merekodkannya.`
                      : `今天${slotLabel}吃了什么？点击即可快速记一笔。`,
                  explanation: effectiveLang === 'en'
                    ? `Time check: it is ${isLunchTime ? '11:30–14:30' : '17:30–21:00'} and no food spending has been recorded today.`
                    : effectiveLang === 'ms'
                      ? `Semakan masa: sekarang ${isLunchTime ? '11:30–14:30' : '17:30–21:00'} dan tiada belanja makanan direkodkan hari ini.`
                      : `时段感知：当前是 ${slotLabel} 时段（${isLunchTime ? '11:30~14:30' : '17:30~21:00'}），您今天尚未记录任何餐饮开销。`,
                  actionLabel: effectiveLang === 'en'
                    ? `Record ${slotLabelEn}`
                    : effectiveLang === 'ms'
                      ? `Rekod ${slotLabelMs}`
                      : `记一笔${slotLabel}`,
                  actionSearchTerm: ``,
                  matchingTransactionIds: [],
                });
              }
            }
          }
        }
      }
    } catch {}
  }

  return alerts;
}
