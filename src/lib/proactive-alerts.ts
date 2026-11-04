import { getLocalDateString, getDaysInMonth } from './date-helper.ts';
import { getAmountInBaseCurrency } from './currency.ts';
import {
  isLumpSumExpense,
  isTripQuarantinedExpense,
  resolveCategoryCapValue,
  getSavedCategoryCaps,
  predictMonthlySavingsAndInvestments,
} from './category-budget-helper.ts';
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

export interface SwNotificationPayload {
  tag: string;
  title: string;
  body: string;
  url: string;
  slot: 'morning_safe_to_spend' | 'evening_meal_checkin' | 'budget_alert';
  timestamp: number;
  data: Record<string, unknown>;
}

const KNOWN_SUBSCRIPTION_KEYWORDS = [
  'netflix', 'spotify', 'youtube', 'unifi', 'maxis', 'celcom', 'digi', 'umobile', 'time',
  'astro', 'chatgpt', 'openai', 'claude', 'anthropic', 'apple', 'icloud', 'google one',
  'prime', 'disney', 'gym', 'fitness', 'coway', 'cuckoo', 'indah water', 'tnb',
];

const FIXED_OR_PERIODIC_CATEGORIES = new Set([
  'Housing & Bills',
  'Insurance',
  'Parents',
  'Education',
]);

/**
 * Mines transactions to discover explainable, numerical proactive alerts:
 * 1. Month-end budget overspend projection (separates fixed/lump-sum bills and quarantined trip expenses from daily burn rate!)
 * 2. Subscription/recurring bill price changes (in base currency MYR)
 * 3. Category spending spikes vs trailing 3-month daily pace (excluding quarantined trip expenses)
 */
export function generateProactiveAlerts<T extends MinimalTransaction & { baseAmount?: number; tripTag?: string; tripId?: string; notes?: string }>(
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
  const [yPart, mPart, dPart] = todayStr.split('-').map(Number);
  const currentYear = !isNaN(yPart) ? yPart : new Date().getFullYear();
  const currentMonthNum = !isNaN(mPart) ? mPart : new Date().getMonth() + 1;
  const currentMonthStr = `${currentYear}-${String(currentMonthNum).padStart(2, '0')}`;
  const dayOfMonth = Math.max(1, !isNaN(dPart) ? dPart : new Date().getDate());
  const totalDaysInMonth = getDaysInMonth(currentYear, currentMonthNum);
  const daysRemaining = Math.max(0, totalDaysInMonth - dayOfMonth);

  const currentMonthExpenses = allTransactions.filter(
    (t) =>
      String(t.type || '').toLowerCase() === 'expense' &&
      t.date?.startsWith(currentMonthStr) &&
      t.amount > 0 &&
      !isTripQuarantinedExpense(t)
  );

  const prevMonthDate = new Date(currentYear, currentMonthNum - 2, 1);
  const prevMonthStr = `${prevMonthDate.getFullYear()}-${String(prevMonthDate.getMonth() + 1).padStart(2, '0')}`;
  const prevMonthExpenses = allTransactions.filter(
    (t) =>
      String(t.type || '').toLowerCase() === 'expense' &&
      t.date?.startsWith(prevMonthStr) &&
      t.amount > 0 &&
      !isTripQuarantinedExpense(t)
  );

  let currentMonthTotal = 0;
  let lumpSumSpent = 0;
  let dailyVariableSpent = 0;

  for (const t of currentMonthExpenses) {
    const amt = getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount);
    currentMonthTotal += amt;
    const cat = t.category || 'Other';
    if (isLumpSumExpense(cat, amt, t)) {
      lumpSumSpent += amt;
    } else {
      dailyVariableSpent += amt;
    }
  }

  currentMonthTotal = Number(currentMonthTotal.toFixed(2));
  lumpSumSpent = Number(lumpSumSpent.toFixed(2));
  dailyVariableSpent = Number(dailyVariableSpent.toFixed(2));

  const prevMonthTotal = Number(
    prevMonthExpenses
      .reduce((sum, t) => sum + getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount), 0)
      .toFixed(2)
  );

  // 1. Month-End Overspend Projection (Lump-sum & Trip-Quarantine aware!)
  const baselineThreshold = budgetCap && budgetCap > 0 ? budgetCap : prevMonthTotal;
  if (dayOfMonth >= 3 && currentMonthTotal > 80 && baselineThreshold > 100) {
    const dailyVariablePace = dailyVariableSpent / dayOfMonth;
    const projectedMonthEnd = Math.round(lumpSumSpent + dailyVariableSpent + dailyVariablePace * daysRemaining);

    if (projectedMonthEnd >= baselineThreshold * 1.15) {
      const overspendDelta = projectedMonthEnd - baselineThreshold;
      const overspendPercent = Math.round((overspendDelta / baselineThreshold) * 100);
      const isCritical = projectedMonthEnd >= baselineThreshold * 1.3;

      alerts.push({
        id: `alert_budget_pace_${currentMonthStr}`,
        type: 'budget_pace',
        severity: isCritical ? 'critical' : 'warning',
        title:
          effectiveLang === 'en'
            ? isCritical
              ? 'Month-end budget warning'
              : 'Month-end spending pace is high'
            : effectiveLang === 'ms'
            ? isCritical
              ? 'Amaran bajet hujung bulan'
              : 'Kadar belanja hujung bulan tinggi'
            : isCritical
            ? '月底超支红色预警'
            : '月底超支偏高预警',
        message:
          effectiveLang === 'en'
            ? `Factoring in fixed bills (RM ${lumpSumSpent.toFixed(0)}) and daily pace (RM ${dailyVariablePace.toFixed(2)}/day), month-end spend may reach RM ${projectedMonthEnd.toLocaleString('en-MY')} (~${overspendPercent}% over budget).`
            : effectiveLang === 'ms'
            ? `Mengambil kira bil tetap (RM ${lumpSumSpent.toFixed(0)}) dan kadar harian (RM ${dailyVariablePace.toFixed(2)}/hari), belanja hujung bulan mungkin mencecah RM ${projectedMonthEnd.toLocaleString('en-MY')} (~${overspendPercent}% melebihi bajet).`
            : `综合非日常账单（RM ${lumpSumSpent.toFixed(0)}）与日常餐饮步调（日均 RM ${dailyVariablePace.toFixed(2)}），预计本月底总支出将达 RM ${projectedMonthEnd.toLocaleString('en-MY')}，超出预算基准约 ${overspendPercent}%。`,
        explanation:
          effectiveLang === 'en'
            ? `Based on ${dayOfMonth}/${totalDaysInMonth} days: RM ${currentMonthTotal.toFixed(2)} spent so far (RM ${lumpSumSpent.toFixed(2)} monthly/lump-sum + RM ${dailyVariableSpent.toFixed(2)} daily variable at RM ${dailyVariablePace.toFixed(2)}/day) vs RM ${baselineThreshold.toFixed(2)} baseline.`
            : effectiveLang === 'ms'
            ? `Berdasarkan ${dayOfMonth}/${totalDaysInMonth} hari: RM ${currentMonthTotal.toFixed(2)} dibelanjakan (RM ${lumpSumSpent.toFixed(2)} komitmen/sekali + RM ${dailyVariableSpent.toFixed(2)} harian pada RM ${dailyVariablePace.toFixed(2)}/hari) berbanding asas RM ${baselineThreshold.toFixed(2)}.`
            : `依据：本月已过 ${dayOfMonth}/${totalDaysInMonth} 天，累计支出 RM ${currentMonthTotal.toFixed(2)}（其中月度/单次项 RM ${lumpSumSpent.toFixed(2)}，日常餐饮 RM ${dailyVariableSpent.toFixed(2)} · 日均 RM ${dailyVariablePace.toFixed(2)}），预算基准为 RM ${baselineThreshold.toFixed(2)}。`,
        actionLabel:
          effectiveLang === 'en'
            ? `View this month's records (${currentMonthExpenses.length})`
            : effectiveLang === 'ms'
            ? `Lihat rekod bulan ini (${currentMonthExpenses.length})`
            : `查看本月账目 (${currentMonthExpenses.length}笔)`,
        matchingTransactionIds: currentMonthExpenses.map((t) => t.id),
      });
    }
  }

  // 2. Subscription / Recurring Price Changes (using base currency MYR)
  const currMerchantMap = new Map<string, { merchant: string; amount: number; tx: T }>();
  for (const t of currentMonthExpenses) {
    const desc = (t.description || t.category || '').trim();
    const lower = desc.toLowerCase();
    const isSub = KNOWN_SUBSCRIPTION_KEYWORDS.some((kw) => lower.includes(kw));
    if (isSub) {
      currMerchantMap.set(lower, {
        merchant: desc,
        amount: getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount),
        tx: t,
      });
    }
  }

  const prevMerchantMap = new Map<string, { merchant: string; amount: number; tx: T }>();
  for (const t of prevMonthExpenses) {
    const desc = (t.description || t.category || '').trim();
    const lower = desc.toLowerCase();
    const isSub = KNOWN_SUBSCRIPTION_KEYWORDS.some((kw) => lower.includes(kw));
    if (isSub) {
      prevMerchantMap.set(lower, {
        merchant: desc,
        amount: getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount),
        tx: t,
      });
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
        title:
          effectiveLang === 'en'
            ? isIncrease
              ? `Subscription price increased (${curr.merchant})`
              : `Subscription price changed (${curr.merchant})`
            : effectiveLang === 'ms'
            ? isIncrease
              ? `Harga langganan meningkat (${curr.merchant})`
              : `Harga langganan berubah (${curr.merchant})`
            : isIncrease
            ? `订阅扣费上涨提醒 (${curr.merchant})`
            : `订阅费用变动 (${curr.merchant})`,
        message:
          effectiveLang === 'en'
            ? `The ${curr.merchant} charge changed this month compared with last month.`
            : effectiveLang === 'ms'
            ? `Caj ${curr.merchant} bulan ini berubah berbanding bulan lepas.`
            : `检测到「${curr.merchant}」本月扣款与上月存在金额变动。`,
        explanation:
          effectiveLang === 'en'
            ? `Ledger records: RM ${prev.amount.toFixed(2)} in ${prevMonthStr} and RM ${curr.amount.toFixed(2)} in ${currentMonthStr}, a ${isIncrease ? '+' : '-'}RM ${Math.abs(delta).toFixed(2)} (${isIncrease ? '+' : '-'}${pctChange}%) change.`
            : effectiveLang === 'ms'
            ? `Rekod lejar: RM ${prev.amount.toFixed(2)} pada ${prevMonthStr} dan RM ${curr.amount.toFixed(2)} pada ${currentMonthStr}, perubahan ${isIncrease ? '+' : '-'}RM ${Math.abs(delta).toFixed(2)} (${isIncrease ? '+' : '-'}${pctChange}%).`
            : `依据：上月 (${prevMonthStr}) 扣款 RM ${prev.amount.toFixed(2)}，本月 (${currentMonthStr}) 扣款 RM ${curr.amount.toFixed(2)}，变动 ${isIncrease ? '+' : '-'}RM ${Math.abs(delta).toFixed(2)} (${isIncrease ? '+' : '-'}${pctChange}%)。`,
        actionLabel:
          effectiveLang === 'en'
            ? `View ${curr.merchant} charges`
            : effectiveLang === 'ms'
            ? `Lihat caj ${curr.merchant}`
            : `查看「${curr.merchant}」扣款记录`,
        actionSearchTerm: curr.merchant,
        matchingTransactionIds: [curr.tx.id, prev.tx.id],
      });
    }
  }

  // 3. Category Spending Spikes (excluding quarantined trip expenses)
  const trailingCatTotals = new Map<string, { total: number; days: number; months: number }>();
  for (let mOffset = 1; mOffset <= 3; mOffset++) {
    const pDate = new Date(currentYear, currentMonthNum - 1 - mOffset, 1);
    const pStr = `${pDate.getFullYear()}-${String(pDate.getMonth() + 1).padStart(2, '0')}`;
    const pDays = getDaysInMonth(pDate.getFullYear(), pDate.getMonth() + 1);

    const mExpenses = allTransactions.filter(
      (t) =>
        String(t.type || '').toLowerCase() === 'expense' &&
        t.date?.startsWith(pStr) &&
        t.amount > 0 &&
        !isTripQuarantinedExpense(t)
    );

    const monthCatMap = new Map<string, number>();
    for (const t of mExpenses) {
      const cat = t.category || 'Other';
      monthCatMap.set(cat, (monthCatMap.get(cat) || 0) + getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount));
    }

    for (const [cat, amt] of monthCatMap.entries()) {
      if (amt > 0) {
        const existing = trailingCatTotals.get(cat) || { total: 0, days: 0, months: 0 };
        existing.total += amt;
        existing.days += pDays;
        existing.months += 1;
        trailingCatTotals.set(cat, existing);
      }
    }
  }

  const savedCaps = getSavedCategoryCaps();
  const currCatTotals = new Map<string, { total: number; txs: T[] }>();
  for (const t of currentMonthExpenses) {
    const cat = t.category || 'Other';
    const existing = currCatTotals.get(cat) || { total: 0, txs: [] };
    existing.total += getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount);
    existing.txs.push(t);
    currCatTotals.set(cat, existing);
  }

  for (const [cat, curr] of currCatTotals.entries()) {
    const hist = trailingCatTotals.get(cat);
    if (!hist || hist.days === 0 || hist.total < 100) continue;

    const isFixedBucket = FIXED_OR_PERIODIC_CATEGORIES.has(cat);
    const catCap = resolveCategoryCapValue(cat, savedCaps, 0);

    if (isFixedBucket) {
      const histMonthlyAvg = hist.total / Math.max(1, hist.months);
      const exceedsCap = catCap > 0 ? curr.total > catCap * 1.05 : true;
      if (curr.total >= 150 && exceedsCap && curr.total >= histMonthlyAvg * 1.25) {
        const increasePct = Math.round(((curr.total - histMonthlyAvg) / histMonthlyAvg) * 100);
        alerts.push({
          id: `alert_cat_spike_${cat}`,
          type: 'category_spike',
          severity: 'warning',
          title:
            effectiveLang === 'en'
              ? `Higher Monthly Total in "${cat}"`
              : effectiveLang === 'ms'
              ? `Jumlah Bulanan "${cat}" Meningkat`
              : `「${cat}」月度总额高于往期`,
          message:
            effectiveLang === 'en'
              ? `"${cat}" total this month is RM ${curr.total.toFixed(2)}, +${increasePct}% above your historical monthly average.`
              : effectiveLang === 'ms'
              ? `Jumlah "${cat}" bulan ini ialah RM ${curr.total.toFixed(2)}, +${increasePct}% melebihi purata bulanan.`
              : `本月「${cat}」累计 RM ${curr.total.toFixed(2)}，高于往期月均水平 +${increasePct}%。`,
          explanation:
            effectiveLang === 'en'
              ? `Basis: "${cat}" spent RM ${curr.total.toFixed(2)} this month vs historical active monthly average of RM ${histMonthlyAvg.toFixed(2)}/mo.`
              : effectiveLang === 'ms'
              ? `Asas: "${cat}" berjumlah RM ${curr.total.toFixed(2)} bulan ini berbanding purata bulanan RM ${histMonthlyAvg.toFixed(2)}/bln.`
              : `依据：本月「${cat}」已支出 RM ${curr.total.toFixed(2)}，往期活跃月份月均为 RM ${histMonthlyAvg.toFixed(2)}/月（+${increasePct}%）。`,
          actionLabel:
            effectiveLang === 'en'
              ? `View "${cat}" records (${curr.txs.length})`
              : effectiveLang === 'ms'
              ? `Lihat rekod "${cat}" (${curr.txs.length})`
              : `查看「${cat}」账目 (${curr.txs.length}笔)`,
          actionCategory: cat,
          matchingTransactionIds: curr.txs.map((t) => t.id),
        });
      }
      continue;
    }

    if (dayOfMonth < 5) continue;

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
          (t) =>
            (t.category || '').toLowerCase().includes('food') ||
            (t.category || '').toLowerCase().includes('dining')
        );

        if (!hasFoodToday) {
          const rawHabits = localStorage.getItem('cashflow_habit_memory');
          if (rawHabits) {
            const habits = JSON.parse(rawHabits);
            if (Array.isArray(habits)) {
              alerts.push({
                id: `alert_habit_meal_${todayStr}`,
                type: 'habit_anticipation',
                severity: 'info',
                title:
                  effectiveLang === 'en'
                    ? `🍱 It's ${slotLabelEn} time`
                    : effectiveLang === 'ms'
                    ? `🍱 Masa ${slotLabelMs}`
                    : `🍱 ${slotLabel}时间到了`,
                message:
                  effectiveLang === 'en'
                    ? `Have you had ${slotLabelEn}? Tap to record it.`
                    : effectiveLang === 'ms'
                    ? `Sudah makan ${slotLabelMs}? Ketik untuk merekodkannya.`
                    : `今天${slotLabel}吃了什么？点击即可快速记一笔。`,
                explanation:
                  effectiveLang === 'en'
                    ? `Time check: it is ${isLunchTime ? '11:30–14:30' : '17:30–21:00'} and no food spending has been recorded today.`
                    : effectiveLang === 'ms'
                    ? `Semakan masa: sekarang ${isLunchTime ? '11:30–14:30' : '17:30–21:00'} dan tiada belanja makanan direkodkan hari ini.`
                    : `时段感知：当前是 ${slotLabel} 时段（${isLunchTime ? '11:30~14:30' : '17:30~21:00'}），您今天尚未记录任何餐饮开销。`,
                actionLabel:
                  effectiveLang === 'en'
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
    } catch {}
  }

  return alerts;
}

/**
 * Pillar 4.2: Builds Service Worker / Local Push Notification Payloads for:
 * 1. Morning Safe-to-Spend Briefing (e.g. "Safe to spend today: RM 48.50")
 * 2. Evening Unlogged Meal Check-in (if no Food & Dining expense was logged today)
 */
export function buildDailyNotificationPayloads<
  T extends MinimalTransaction & { baseAmount?: number; tripTag?: string; tripId?: string; notes?: string }
>(params: {
  allTransactions: T[];
  monthlyBudgetCap?: number;
  baselineIncome?: number;
  referenceDate?: Date;
  language?: 'zh' | 'en' | 'ms' | 'auto';
}): {
  morningBriefing: SwNotificationPayload;
  eveningMealCheckin: SwNotificationPayload | null;
} {
  const {
    allTransactions = [],
    monthlyBudgetCap = 0,
    baselineIncome = 0,
    referenceDate = new Date(),
    language = 'zh',
  } = params;

  const effLang = language === 'en' || language === 'ms' ? language : 'zh';
  const todayStr = getLocalDateString(referenceDate);

  const prediction = predictMonthlySavingsAndInvestments(allTransactions, {
    baselineIncome: baselineIncome > 0 ? baselineIncome : monthlyBudgetCap > 0 ? monthlyBudgetCap : undefined,
    referenceDate,
  });

  const effectivePool = monthlyBudgetCap > 0 ? monthlyBudgetCap : prediction.targetLivingBudget;
  const safeDaily = Number(prediction.safeDailyLivingAllowance.toFixed(2));
  const unpaidReserve = Number(prediction.unpaidCommittedReserve || 0);
  const freeRemaining = Number(Math.max(0, effectivePool - prediction.spentSoFar - unpaidReserve).toFixed(2));

  const morningBriefing: SwNotificationPayload = {
    tag: `kinova_morning_briefing_${todayStr}`,
    slot: 'morning_safe_to_spend',
    url: '/budget',
    timestamp: referenceDate.getTime(),
    title:
      effLang === 'en'
        ? `☀️ Today's Safe-to-Spend: RM ${safeDaily.toFixed(2)}`
        : effLang === 'ms'
        ? `☀️ Had Belanja Selamat Hari Ini: RM ${safeDaily.toFixed(2)}`
        : `☀️ 今日安全可用额度：RM ${safeDaily.toFixed(2)}`,
    body:
      effLang === 'en'
        ? `Free living budget remaining: RM ${freeRemaining.toFixed(0)}${
            unpaidReserve > 0
              ? ` (RM ${unpaidReserve.toFixed(0)} reserved for upcoming bills)`
              : ''
          }.`
        : effLang === 'ms'
        ? `Baki bajet bebas: RM ${freeRemaining.toFixed(0)}${
            unpaidReserve > 0
              ? ` (RM ${unpaidReserve.toFixed(0)} dikhaskan untuk bil)`
              : ''
          }.`
        : `本月自由可用余额 RM ${freeRemaining.toFixed(0)}${
            unpaidReserve > 0
              ? `（已预留待付固定账单 RM ${unpaidReserve.toFixed(0)}）`
              : ''
          }，保持节奏即可稳守储蓄目标。`,
    data: {
      date: todayStr,
      safeDailyBurnRemaining: safeDaily,
      freeRemaining,
      upcomingCommitmentsRemaining: unpaidReserve,
    },
  };

  const todayFoodLogged = allTransactions.some(
    (t) =>
      String(t.type || '').toLowerCase() === 'expense' &&
      t.date === todayStr &&
      ((t.category || '').toLowerCase().includes('food') ||
        (t.category || '').toLowerCase().includes('dining'))
  );

  const eveningMealCheckin: SwNotificationPayload | null = todayFoodLogged
    ? null
    : {
        tag: `kinova_evening_checkin_${todayStr}`,
        slot: 'evening_meal_checkin',
        url: '/?quickRecord=food',
        timestamp: referenceDate.getTime(),
        title:
          effLang === 'en'
            ? `🍱 No meals logged yet today`
            : effLang === 'ms'
            ? `🍱 Belum ada rekod makanan hari ini`
            : `🍱 今天还没有记录餐饮开销哦`,
        body:
          effLang === 'en'
            ? `Tap to log today's lunch or dinner in 1 second (Safe daily allowance: RM ${safeDaily.toFixed(2)}).`
            : effLang === 'ms'
            ? `Ketik untuk merekod makan tengah hari atau malam (Had selamat: RM ${safeDaily.toFixed(2)}).`
            : `点击即可语音或一句话补记今日午/晚餐（今日安全额度 RM ${safeDaily.toFixed(2)}）。`,
        data: {
          date: todayStr,
          safeDailyBurnRemaining: safeDaily,
        },
      };

  return {
    morningBriefing,
    eveningMealCheckin,
  };
}

/**
 * Pillar 4.2: Dispatches a deduplicated notification via the PWA Service Worker
 * (`navigator.serviceWorker.ready`) with fallback to standard `Notification` API.
 */
export async function dispatchServiceWorkerBriefingNotification(
  payload: SwNotificationPayload,
): Promise<boolean> {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return false;
  if (Notification.permission !== 'granted') return false;

  const dedupeKey = `cashflow_sw_notified_${payload.tag}`;
  try {
    if (localStorage.getItem(dedupeKey) === '1') {
      return false; // Already shown today
    }

    if ('serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.ready;
      if (registration && typeof registration.showNotification === 'function') {
        await registration.showNotification(payload.title, {
          body: payload.body,
          tag: payload.tag,
          data: { url: payload.url, ...payload.data },
        });
        localStorage.setItem(dedupeKey, '1');
        return true;
      }
    }

    new Notification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      data: { url: payload.url, ...payload.data },
    });
    localStorage.setItem(dedupeKey, '1');
    return true;
  } catch {
    return false;
  }
}

