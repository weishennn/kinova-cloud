import { getAmountInBaseCurrency } from './currency.ts';
import { getLocalDateString } from './date-helper.ts';
import { CANONICAL_EXPENSE_CATEGORIES } from './canonical-categories.ts';
import { getUserMoneyProfile } from './user-money-profile.ts';

export interface CategoryBudgetCap {
  category: string;
  capAmount: number;
}

export const DEFAULT_CATEGORY_CAPS: Record<string, number> = {
  'Food & Dining': 1200,
  'Transport': 400,
  'Shopping': 500,
  'Housing & Bills': 1000,
  'Parents': 500,
  'Insurance': 350,
  'Entertainment': 250,
  'Health': 200,
  'Education': 150,
  'Sport': 200,
  'Gift': 150,
  'Other': 200,
};

const STORAGE_KEY = 'cashflow_category_caps';

/**
 * Loads category budget caps from localStorage with sensible defaults.
 */
export function getSavedCategoryCaps(): Record<string, number> {
  if (typeof window === 'undefined') return DEFAULT_CATEGORY_CAPS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        return { ...DEFAULT_CATEGORY_CAPS, ...parsed };
      }
    }
  } catch {}
  return DEFAULT_CATEGORY_CAPS;
}

/**
 * Saves category budget caps to localStorage with background cloud SOT sync.
 */
export function saveCategoryCaps(caps: Record<string, number>): void {
  if (typeof window === 'undefined') return;
  const serialized = JSON.stringify(caps);
  try {
    localStorage.setItem(STORAGE_KEY, serialized);
    window.dispatchEvent(new CustomEvent('cashflow_cloud_settings_synced', { detail: { key: STORAGE_KEY, value: serialized } }));
  } catch {}
  try {
    // Dynamic import to avoid SSR and Node test environment dependency cascades
    import('./cloud-settings-sync.ts')
      .then((mod) => {
        if (mod && mod.saveSettingWithCloudSync) {
          mod.saveSettingWithCloudSync(STORAGE_KEY, serialized);
        }
      })
      .catch(() => {});
  } catch {}
}

/**
 * Calculates days remaining in the specified or current calendar month.
 */
export function getMonthDaysInfo(monthStr?: string) {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1; // 1-indexed
  const todayDate = now.getDate();

  // Full Year View (e.g. "year-2026")
  if (monthStr?.startsWith('year-')) {
    const y = parseInt(monthStr.replace('year-', ''), 10);
    const targetYear = !isNaN(y) ? y : currentYear;
    const isLeap = (targetYear % 4 === 0 && targetYear % 100 !== 0) || (targetYear % 400 === 0);
    const totalDays = isLeap ? 366 : 365;
    const isCurrentYear = targetYear === currentYear;
    const isPastYear = targetYear < currentYear;

    let daysRemaining = 0;
    if (isCurrentYear) {
      const endOfYear = new Date(currentYear, 11, 31);
      const diffTime = endOfYear.getTime() - now.getTime();
      daysRemaining = Math.max(1, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
    } else if (isPastYear) {
      daysRemaining = 0;
    } else {
      daysRemaining = totalDays;
    }

    return {
      year: targetYear,
      month: 0,
      todayDate,
      totalDays,
      daysRemaining,
      isCurrentMonth: isCurrentYear,
      isPastMonth: isPastYear,
      isYearView: true,
    };
  }

  let year = currentYear;
  let month = currentMonth;

  if (monthStr && monthStr !== 'all') {
    const [y, m] = monthStr.split('-').map(Number);
    if (!isNaN(y) && !isNaN(m)) {
      year = y;
      month = m;
    }
  }

  // Days in month = day 0 of next month
  const totalDays = new Date(year, month, 0).getDate();

  const isCurrentMonth = year === currentYear && month === currentMonth;
  const isPastMonth = year < currentYear || (year === currentYear && month < currentMonth);

  let daysRemaining = 0;
  if (isCurrentMonth) {
    daysRemaining = Math.max(1, totalDays - todayDate + 1); // inclusive of today
  } else if (isPastMonth) {
    daysRemaining = 0;
  } else {
    daysRemaining = totalDays;
  }

  return {
    year,
    month,
    todayDate: isCurrentMonth ? todayDate : (isPastMonth ? totalDays : 1),
    totalDays,
    daysRemaining,
    isCurrentMonth,
    isPastMonth,
    isYearView: false,
  };
}

/**
 * Calculates daily safe-to-spend allowance given total monthly budget, current total spent, and optional monthStr.
 */
export function calculateDailySafeSpend(totalBudget: number, totalSpent: number, monthStr?: string) {
  const { totalDays, todayDate, daysRemaining, isCurrentMonth, isPastMonth } = getMonthDaysInfo(monthStr);
  const remainingBudget = Math.max(0, totalBudget - totalSpent);
  const divisor = daysRemaining > 0 ? daysRemaining : totalDays;
  const dailyAllowance = remainingBudget / (divisor || 1);
  const isOverBudget = totalSpent > totalBudget;
  const overAmount = isOverBudget ? totalSpent - totalBudget : 0;
  const spentPercent = totalBudget > 0 ? (totalSpent / totalBudget) * 100 : 0;

  return {
    totalBudget,
    totalSpent,
    remainingBudget,
    dailyAllowance: Number(dailyAllowance.toFixed(2)),
    daysRemaining,
    todayDate,
    totalDays,
    isCurrentMonth,
    isPastMonth,
    isOverBudget,
    overAmount: Number(overAmount.toFixed(2)),
    spentPercent: Number(spentPercent.toFixed(1)),
  };
}

export type CategoryExpenseNature = 'fixed' | 'quasi-fixed' | 'trend' | 'discretionary';

export interface IntelligentCapSuggestion {
  category: string;
  currentCap: number;
  suggestedCap: number;
  historicalAvg: number;
  nature: CategoryExpenseNature;
  natureLabel: string;
  reasoning: string;
  dailyAllowance?: number;
  sharePercent?: number;
}

export interface IntelligentBudgetPlan {
  baselineIncome: number;
  savingsTargetPct: number;
  investmentTargetPct: number;
  targetSavingsAmount: number;
  targetLivingBudget: number;
  totalSuggestedCaps: number;
  suggestions: IntelligentCapSuggestion[];
  savingsHealthStatus: 'healthy' | 'tight' | 'exceeded';
  summaryInsight: string;
}

export interface PaydayCycleIntelligence {
  paydayDay: number;
  todayDate: number;
  daysRemainingInMonth: number;
  daysUntilPayday: number;
  isPaydayWeek: boolean;
  cyclePhase: 'living_phase' | 'payday_settlement';
  baselineIncome: number;
  savingsTargetPct: number;
  investmentTargetPct: number;
  preQuarantinedSavings: number;
  targetLivingBudget: number;
  dailyLivingAllowance: number;
  actualSavedThisMonth: number;
  savingsGoalFulfilled: boolean;
  savingsProgressPct: number;
  headline: string;
  detail: string;
}

export interface CategoryRealtimeBudgetStatus {
  category: string;
  cap: number;
  spentSoFar: number;
  remainingBefore: number;
  remainingAfter: number;
  spentPercentBefore: number;
  spentPercentAfter: number;
  isOverCapBefore: boolean;
  isOverCapAfter: boolean;
  daysRemainingInMonth: number;
  dailyAllowanceRemaining: number;
  todaySpentInCategory: number;
  isDailyCategory: boolean;
  badgeText: string;
  badgeColor: 'emerald' | 'amber' | 'rose';
  pacingNote?: string;
}

interface GenericTransaction {
  id?: string;
  type?: string;
  amount?: number;
  currency?: string;
  baseAmount?: number;
  category?: string;
  date?: string;
}

/**
 * Computes intelligent category spending caps derived dynamically from:
 * 1. Historical spending patterns (recurring fixed, quasi-fixed bills, commute trend, discretionary living).
 * 2. User's Income Allocation baseline income and savings/investment targets.
 * 3. Never hardcoded — adapts as spending and savings progress.
 */
export function generateIntelligentCategoryCaps(
  allTransactions: GenericTransaction[] = [],
  options?: {
    baselineIncome?: number;
    savingsTargetPct?: number;
    investmentTargetPct?: number;
    configuredCaps?: Record<string, number>;
  }
): IntelligentBudgetPlan {
  const profile = typeof window !== 'undefined' ? getUserMoneyProfile() : null;
  const currentCaps = options?.configuredCaps || getSavedCategoryCaps();

  // 1. Resolve Monthly Income & Target Savings
  const savedIncome = typeof window !== 'undefined' ? parseFloat(localStorage.getItem('cashflow_baseline_income') || '0') : 0;
  const baselineIncome = options?.baselineIncome || (savedIncome > 0 ? savedIncome : (profile?.baselineIncome ?? 3000));

  const savedSavingsPct = typeof window !== 'undefined' ? parseFloat(localStorage.getItem('cashflow_savings_target_pct') || '20') : 20;
  const savingsTargetPct = options?.savingsTargetPct ?? (isNaN(savedSavingsPct) ? 20 : savedSavingsPct);

  const savedInvestPct = typeof window !== 'undefined' ? parseFloat(localStorage.getItem('cashflow_investment_target_pct') || '20') : 20;
  const investmentTargetPct = options?.investmentTargetPct ?? (isNaN(savedInvestPct) ? 20 : savedInvestPct);

  const totalSavingsPct = Math.min(80, Math.max(0, savingsTargetPct + investmentTargetPct));
  const targetSavingsAmount = Math.round(baselineIncome * (totalSavingsPct / 100));
  const targetLivingBudget = Math.max(800, baselineIncome - targetSavingsAmount);

  // 2. Aggregate Historical Spending by Category and Month
  const currentMonthPrefix = getLocalDateString().slice(0, 7);
  const categoryMonthlyMap = new Map<string, Map<string, number>>();
  CANONICAL_EXPENSE_CATEGORIES.forEach((cat) => categoryMonthlyMap.set(cat, new Map()));

  const validTxs = Array.isArray(allTransactions) ? allTransactions : [];
  validTxs.forEach((t) => {
    if (!t.date || t.date.length < 7 || t.type !== 'expense' || t.id === 'tx_sample') return;
    const cat = t.category || 'Other';
    const monthKey = t.date.slice(0, 7);
    const amount = getAmountInBaseCurrency(t.amount || 0, t.currency, t.baseAmount);
    if (amount <= 0) return;

    if (!categoryMonthlyMap.has(cat)) {
      categoryMonthlyMap.set(cat, new Map());
    }
    const catMonths = categoryMonthlyMap.get(cat)!;
    catMonths.set(monthKey, (catMonths.get(monthKey) || 0) + amount);
  });

  // 3. Compute Statistical Profile per Category
  interface CategoryStats {
    category: string;
    avg: number;
    median: number;
    stdev: number;
    cv: number; // coefficient of variation
    sampleCount: number;
    recent: number;
  }

  const statsMap = new Map<string, CategoryStats>();

  categoryMonthlyMap.forEach((months, cat) => {
    // Prefer past completed months; if none exist, use all months
    const completedMonths = Array.from(months.entries()).filter(([m]) => m !== currentMonthPrefix);
    const activeEntries = completedMonths.length > 0 ? completedMonths : Array.from(months.entries());
    const values = activeEntries.map(([, val]) => val);

    if (values.length === 0) {
      statsMap.set(cat, { category: cat, avg: 0, median: 0, stdev: 0, cv: 0, sampleCount: 0, recent: 0 });
      return;
    }

    const sum = values.reduce((acc, v) => acc + v, 0);
    const avg = sum / values.length;
    const sorted = [...values].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const variance = values.reduce((acc, v) => acc + Math.pow(v - avg, 2), 0) / values.length;
    const stdev = Math.sqrt(variance);
    const cv = avg > 0 ? stdev / avg : 0;
    const recent = sorted[sorted.length - 1] || avg;

    statsMap.set(cat, { category: cat, avg, median, stdev, cv, sampleCount: values.length, recent });
  });

  // 4. Classify and Generate Cap Suggestions
  const suggestions: IntelligentCapSuggestion[] = [];
  let committedCapsSum = 0;

  // Tier A: Fixed Monthly Commitments (e.g. Insurance)
  const insuranceStats = statsMap.get('Insurance');
  let insuranceCap = 250; // fallback if no transactions
  if (insuranceStats && insuranceStats.avg > 0) {
    // If recurring low variance, lock to mode or median
    insuranceCap = Math.round(insuranceStats.median / 10) * 10 || 250;
  }
  committedCapsSum += insuranceCap;
  suggestions.push({
    category: 'Insurance',
    currentCap: currentCaps['Insurance'] || DEFAULT_CATEGORY_CAPS['Insurance'] || 350,
    suggestedCap: insuranceCap,
    historicalAvg: Math.round(insuranceStats?.avg || insuranceCap),
    nature: 'fixed',
    natureLabel: 'Fixed Monthly Recurring',
    reasoning: `Identified as a monthly recurring commitment. Suggested cap matches your steady RM ${insuranceCap}/mo premium without waste.`,
  });

  // Tier B: Quasi-Fixed Housing & Bills
  const housingStats = statsMap.get('Housing & Bills');
  let housingCap = 500;
  if (housingStats && housingStats.avg > 0) {
    // 85th percentile / slight buffer for utility fluctuations
    housingCap = Math.max(300, Math.round((housingStats.avg * 1.08) / 10) * 10);
  }
  committedCapsSum += housingCap;
  suggestions.push({
    category: 'Housing & Bills',
    currentCap: currentCaps['Housing & Bills'] || DEFAULT_CATEGORY_CAPS['Housing & Bills'] || 1000,
    suggestedCap: housingCap,
    historicalAvg: Math.round(housingStats?.avg || housingCap),
    nature: 'quasi-fixed',
    natureLabel: 'Quasi-Fixed Baseline + Bills Buffer',
    reasoning: `Baseline rent & utilities (avg RM ${Math.round(housingStats?.avg || housingCap)}) + bill buffer to handle seasonal utility spikes.`,
  });

  // Tier C: Commute & Transport Trend
  const transportStats = statsMap.get('Transport');
  let transportCap = 150;
  if (transportStats && transportStats.avg > 0) {
    transportCap = Math.max(80, Math.round(transportStats.median / 10) * 10);
  }
  committedCapsSum += transportCap;
  suggestions.push({
    category: 'Transport',
    currentCap: currentCaps['Transport'] || DEFAULT_CATEGORY_CAPS['Transport'] || 400,
    suggestedCap: transportCap,
    historicalAvg: Math.round(transportStats?.avg || transportCap),
    nature: 'trend',
    natureLabel: 'Commute & Fuel Trend',
    reasoning: `Based on your regular commute, toll, and fuel trends (avg RM ${Math.round(transportStats?.avg || transportCap)}/mo).`,
  });

  // Parents support if any
  const parentsStats = statsMap.get('Parents');
  let parentsCap = 0;
  if (parentsStats && parentsStats.avg > 0) {
    parentsCap = Math.round(parentsStats.median / 50) * 50;
    committedCapsSum += parentsCap;
    suggestions.push({
      category: 'Parents',
      currentCap: currentCaps['Parents'] || DEFAULT_CATEGORY_CAPS['Parents'] || 500,
      suggestedCap: parentsCap,
      historicalAvg: Math.round(parentsStats.avg),
      nature: 'fixed',
      natureLabel: 'Family Commitment',
      reasoning: `Regular family support commitment locked at RM ${parentsCap}/mo.`,
    });
  }

  // Health baseline
  const healthStats = statsMap.get('Health');
  let healthCap = 100;
  if (healthStats && healthStats.avg > 0) {
    healthCap = Math.max(50, Math.round(healthStats.avg / 10) * 10);
  }
  committedCapsSum += healthCap;
  suggestions.push({
    category: 'Health',
    currentCap: currentCaps['Health'] || DEFAULT_CATEGORY_CAPS['Health'] || 200,
    suggestedCap: healthCap,
    historicalAvg: Math.round(healthStats?.avg || healthCap),
    nature: 'quasi-fixed',
    natureLabel: 'Wellness & Medical Baseline',
    reasoning: `Essential medical, clinic, and pharmacy safety net.`,
  });

  // 5. Allocate Remaining Discretionary Living Pool
  const remainingDiscretionaryPool = Math.max(500, targetLivingBudget - committedCapsSum);

  // Discretionary categories
  const discretionaryNames = ['Food & Dining', 'Shopping', 'Sport', 'Entertainment', 'Gift', 'Other'];
  const discretionaryAvgs: Record<string, number> = {};
  let totalDiscretionaryAvg = 0;

  discretionaryNames.forEach((cat) => {
    const st = statsMap.get(cat);
    const avg = st && st.avg > 0 ? st.avg : (cat === 'Food & Dining' ? 700 : cat === 'Shopping' ? 250 : cat === 'Sport' ? 120 : 100);
    discretionaryAvgs[cat] = avg;
    totalDiscretionaryAvg += avg;
  });

  // Food & Dining gets prioritized floor: at least 50% of discretionary pool or min RM 20/day
  const rawFoodWeight = discretionaryAvgs['Food & Dining'] / (totalDiscretionaryAvg || 1);
  const effectiveFoodWeight = Math.max(0.48, Math.min(0.65, rawFoodWeight));
  const suggestedFoodCap = Math.max(600, Math.round((remainingDiscretionaryPool * effectiveFoodWeight) / 10) * 10);
  const foodDaily = Number((suggestedFoodCap / 30).toFixed(1));

  suggestions.push({
    category: 'Food & Dining',
    currentCap: currentCaps['Food & Dining'] || DEFAULT_CATEGORY_CAPS['Food & Dining'] || 1200,
    suggestedCap: suggestedFoodCap,
    historicalAvg: Math.round(discretionaryAvgs['Food & Dining']),
    nature: 'discretionary',
    natureLabel: 'Primary Daily Sustenance',
    reasoning: `Allocated RM ${suggestedFoodCap} (RM ${foodDaily}/day) ensuring healthy daily nutrition while strictly reserving your ${totalSavingsPct}% savings goal.`,
    dailyAllowance: foodDaily,
    sharePercent: Math.round(effectiveFoodWeight * 100),
  });

  // Balance remaining discretionary pool for Shopping, Sport, Entertainment, etc.
  const poolAfterFood = Math.max(200, remainingDiscretionaryPool - suggestedFoodCap);
  const otherDiscretionaryNames = ['Shopping', 'Sport', 'Entertainment', 'Gift', 'Other'];
  const otherDiscretionaryTotalAvg = otherDiscretionaryNames.reduce((acc, cat) => acc + discretionaryAvgs[cat], 0) || 1;

  otherDiscretionaryNames.forEach((cat) => {
    const weight = discretionaryAvgs[cat] / otherDiscretionaryTotalAvg;
    const minFloor = cat === 'Shopping' ? 150 : cat === 'Sport' ? 80 : 50;
    const allocated = Math.max(minFloor, Math.round((poolAfterFood * weight) / 10) * 10);
    const st = statsMap.get(cat);

    let reasoning = `Adjusted to RM ${allocated} to preserve your ${totalSavingsPct}% savings target.`;
    if (cat === 'Sport') {
      reasoning = `Fitness & gym activities fitted flexibly within your discretionary allowance (RM ${allocated}).`;
    } else if (cat === 'Shopping') {
      reasoning = `Lifestyle & retail cap (RM ${allocated}) calibrated against your monthly surplus.`;
    }

    suggestions.push({
      category: cat,
      currentCap: currentCaps[cat] || DEFAULT_CATEGORY_CAPS[cat] || 200,
      suggestedCap: allocated,
      historicalAvg: Math.round(st?.avg || discretionaryAvgs[cat]),
      nature: 'discretionary',
      natureLabel: 'Flexible Discretionary',
      reasoning,
      sharePercent: Math.round(weight * 100),
    });
  });

  const totalSuggestedCaps = suggestions.reduce((sum, s) => sum + s.suggestedCap, 0);
  const savingsHealthStatus: 'healthy' | 'tight' | 'exceeded' =
    totalSuggestedCaps <= targetLivingBudget
      ? 'healthy'
      : totalSuggestedCaps <= baselineIncome * 0.95
      ? 'tight'
      : 'exceeded';

  const summaryInsight =
    savingsHealthStatus === 'healthy'
      ? `✨ These caps guarantee your ${totalSavingsPct}% savings target (RM ${targetSavingsAmount}/mo) from a monthly income of RM ${baselineIncome.toLocaleString()}.`
      : `⚠️ Your historical spending requires slight trimming in flexible discretionary categories to hit your full RM ${targetSavingsAmount} savings target.`;

  return {
    baselineIncome,
    savingsTargetPct,
    investmentTargetPct,
    targetSavingsAmount,
    targetLivingBudget,
    totalSuggestedCaps,
    suggestions,
    savingsHealthStatus,
    summaryInsight,
  };
}

/**
 * Solves the "Payday in the Last Week" timing reality:
 * 1. Pre-quarantines target savings from Day 1 so the user never has a false "huge budget" in weeks 1-3.
 * 2. In the final week, salary lands and transfers to savings/investments fulfill the goal without an artificial cliff.
 */
export function getPaydayCycleIntelligence(
  currentMonthTransactions: GenericTransaction[] = [],
  options?: {
    paydayDay?: number;
    baselineIncome?: number;
    savingsTargetPct?: number;
    investmentTargetPct?: number;
  }
): PaydayCycleIntelligence {
  const now = new Date();
  const todayDate = now.getDate();
  const daysInfo = getMonthDaysInfo();
  const profile = typeof window !== 'undefined' ? getUserMoneyProfile() : null;

  const paydayDay = options?.paydayDay ?? (profile?.paydayDay ?? 25);
  const savedIncome = typeof window !== 'undefined' ? parseFloat(localStorage.getItem('cashflow_baseline_income') || '0') : 0;
  const baselineIncome = options?.baselineIncome || (savedIncome > 0 ? savedIncome : (profile?.baselineIncome ?? 3000));

  const savedSavingsPct = typeof window !== 'undefined' ? parseFloat(localStorage.getItem('cashflow_savings_target_pct') || '20') : 20;
  const savingsTargetPct = options?.savingsTargetPct ?? (isNaN(savedSavingsPct) ? 20 : savedSavingsPct);

  const savedInvestPct = typeof window !== 'undefined' ? parseFloat(localStorage.getItem('cashflow_investment_target_pct') || '20') : 20;
  const investmentTargetPct = options?.investmentTargetPct ?? (isNaN(savedInvestPct) ? 20 : savedInvestPct);

  const totalSavingsPct = Math.min(80, Math.max(0, savingsTargetPct + investmentTargetPct));
  const preQuarantinedSavings = Math.round(baselineIncome * (totalSavingsPct / 100));
  const targetLivingBudget = Math.max(500, baselineIncome - preQuarantinedSavings);

  const isPaydayWeek = todayDate >= paydayDay;
  const daysUntilPayday = Math.max(0, paydayDay - todayDate);
  const cyclePhase = isPaydayWeek ? 'payday_settlement' : 'living_phase';

  // Calculate actual savings/investment transfers executed this month
  const actualSavedThisMonth = currentMonthTransactions.reduce((acc, t) => {
    const isInvest = t.type === 'investment';
    const isSavingsCat =
      t.category === 'Fixed Deposit' ||
      t.category === 'ASNB / Unit Trust' ||
      t.category === 'EPF / KWSP' ||
      t.category === 'Emergency Savings' ||
      t.category === 'Other Savings' ||
      t.category === 'Stocks & Crypto';

    if (isInvest || isSavingsCat) {
      return acc + getAmountInBaseCurrency(t.amount || 0, t.currency, t.baseAmount);
    }
    return acc;
  }, 0);

  const savingsProgressPct = preQuarantinedSavings > 0
    ? Math.min(100, Math.round((actualSavedThisMonth / preQuarantinedSavings) * 100))
    : 100;
  const savingsGoalFulfilled = actualSavedThisMonth >= preQuarantinedSavings * 0.9;

  // Calculate total living expenses so far
  const totalLivingSpent = currentMonthTransactions.reduce((acc, t) => {
    if (t.type === 'expense' && t.id !== 'tx_sample') {
      return acc + getAmountInBaseCurrency(t.amount || 0, t.currency, t.baseAmount);
    }
    return acc;
  }, 0);

  const remainingLivingBudget = Math.max(0, targetLivingBudget - totalLivingSpent);
  const dailyLivingAllowance = daysInfo.daysRemaining > 0
    ? Number((remainingLivingBudget / daysInfo.daysRemaining).toFixed(2))
    : 0;

  let headline = '';
  let detail = '';

  if (cyclePhase === 'living_phase') {
    headline = `Active Living Phase · ${daysUntilPayday} days until Payday (${paydayDay}th)`;
    detail = `Your RM ${preQuarantinedSavings.toLocaleString()} savings goal is pre-quarantined from your living budget. You can spend up to RM ${dailyLivingAllowance.toFixed(2)}/day safely without facing an end-of-month budget cut-off.`;
  } else {
    headline = savingsGoalFulfilled
      ? `Payday Settlement Complete · Goal Achieved (RM ${actualSavedThisMonth.toLocaleString()})`
      : `Payday Week · Salary Cycle Settlement`;
    detail = savingsGoalFulfilled
      ? `Your target savings for this cycle are secured! Your remaining living budget continues steadily at RM ${dailyLivingAllowance.toFixed(2)}/day.`
      : `Salary lands this week. When you transfer to savings or investments, it fulfills your planned RM ${preQuarantinedSavings.toLocaleString()} envelope without penalizing your daily allowance.`;
  }

  return {
    paydayDay,
    todayDate,
    daysRemainingInMonth: daysInfo.daysRemaining,
    daysUntilPayday,
    isPaydayWeek,
    cyclePhase,
    baselineIncome,
    savingsTargetPct,
    investmentTargetPct,
    preQuarantinedSavings,
    targetLivingBudget,
    dailyLivingAllowance,
    actualSavedThisMonth,
    savingsGoalFulfilled,
    savingsProgressPct,
    headline,
    detail,
  };
}

/**
 * Computes real-time in-context category budget feedback:
 * 1. Remaining budget in the category before and after a proposed transaction.
 * 2. Daily safe pace for daily categories (Food & Dining).
 * 3. Immediate warning if an entry will exceed the category cap.
 */
export function getCategoryRealtimeBudgetStatus(
  category: string,
  currentMonthTransactions: GenericTransaction[] = [],
  caps?: Record<string, number>,
  proposedAmount = 0
): CategoryRealtimeBudgetStatus {
  const currentCaps = caps || getSavedCategoryCaps();
  const cap = currentCaps[category] || DEFAULT_CATEGORY_CAPS[category] || 500;
  const todayStr = getLocalDateString();
  const daysInfo = getMonthDaysInfo();

  let spentSoFar = 0;
  let todaySpentInCategory = 0;

  const validTxs = Array.isArray(currentMonthTransactions) ? currentMonthTransactions : [];
  validTxs.forEach((t) => {
    if (t.type !== 'expense' || t.id === 'tx_sample' || !t.date) return;
    if (t.category === category) {
      const amt = getAmountInBaseCurrency(t.amount || 0, t.currency, t.baseAmount);
      spentSoFar += amt;
      if (t.date === todayStr) {
        todaySpentInCategory += amt;
      }
    }
  });

  const remainingBefore = Math.max(0, cap - spentSoFar);
  const isOverCapBefore = spentSoFar > cap;
  const spentPercentBefore = cap > 0 ? (spentSoFar / cap) * 100 : 0;

  const validProposed = Math.max(0, Number(proposedAmount) || 0);
  const spentAfter = spentSoFar + validProposed;
  const remainingAfter = cap - spentAfter;
  const isOverCapAfter = spentAfter > cap;
  const spentPercentAfter = cap > 0 ? (spentAfter / cap) * 100 : 0;

  const isDailyCategory = category === 'Food & Dining';
  const dailyAllowanceRemaining = daysInfo.daysRemaining > 0
    ? Number((remainingBefore / daysInfo.daysRemaining).toFixed(2))
    : 0;

  let badgeColor: 'emerald' | 'amber' | 'rose' = 'emerald';
  let badgeText = '';

  if (isOverCapAfter) {
    badgeColor = 'rose';
    const overAmt = spentAfter - cap;
    badgeText = isOverCapBefore
      ? `Over cap by RM ${overAmt.toFixed(2)}`
      : `Will exceed cap by RM ${overAmt.toFixed(2)}!`;
  } else if (spentPercentAfter > 80) {
    badgeColor = 'amber';
    badgeText = `Approaching cap (${spentPercentAfter.toFixed(0)}% used · RM ${remainingAfter.toFixed(2)} left)`;
  } else {
    badgeColor = 'emerald';
    badgeText = `Well on track (${spentPercentAfter.toFixed(0)}% used · RM ${remainingAfter.toFixed(2)} left)`;
  }

  let pacingNote: string | undefined;
  if (isDailyCategory) {
    pacingNote = `Food pacing: RM ${dailyAllowanceRemaining.toFixed(2)}/day allowance (${daysInfo.daysRemaining} days left). Today so far: RM ${todaySpentInCategory.toFixed(2)}.`;
  }

  return {
    category,
    cap,
    spentSoFar: Number(spentSoFar.toFixed(2)),
    remainingBefore: Number(remainingBefore.toFixed(2)),
    remainingAfter: Number(remainingAfter.toFixed(2)),
    spentPercentBefore: Number(spentPercentBefore.toFixed(1)),
    spentPercentAfter: Number(spentPercentAfter.toFixed(1)),
    isOverCapBefore,
    isOverCapAfter,
    daysRemainingInMonth: daysInfo.daysRemaining,
    dailyAllowanceRemaining,
    todaySpentInCategory: Number(todaySpentInCategory.toFixed(2)),
    isDailyCategory,
    badgeText,
    badgeColor,
    pacingNote,
  };
}
