import { getAmountInBaseCurrency } from './currency.ts';
import { getLocalDateString } from './date-helper.ts';
import { CANONICAL_EXPENSE_CATEGORIES } from './canonical-categories.ts';
import { getUserMoneyProfile } from './user-money-profile.ts';

export interface CategoryBudgetCap {
  category: string;
  capAmount: number;
}

export const DEFAULT_CATEGORY_CAPS: Record<string, number> = {
  'Food & Dining': 600,
  'Housing & Bills': 500,
  'Insurance': 250,
  'Transport': 150,
  'Education': 100,
  'Health': 100,
  'Shopping': 100,
  'Sport': 50,
  'Entertainment': 50,
  'Gift': 50,
  'Other': 50,
  'Parents': 0,
};

const STORAGE_KEY = 'cashflow_category_caps';

/**
 * Resolves a numeric cap for a category while strictly preserving explicit 0 caps.
 * Fixes the `||` bug where setting a category cap to 0 fell back to default or 500.
 */
export function resolveCategoryCapValue(
  category: string,
  caps?: Record<string, number> | null,
  fallbackIfMissing = 0
): number {
  if (caps && Object.prototype.hasOwnProperty.call(caps, category)) {
    const val = Number(caps[category]);
    if (Number.isFinite(val) && val >= 0) {
      return val;
    }
  }
  if (Object.prototype.hasOwnProperty.call(DEFAULT_CATEGORY_CAPS, category)) {
    return DEFAULT_CATEGORY_CAPS[category];
  }
  return fallbackIfMissing;
}

/**
 * Loads category budget caps from localStorage.
 * Strictly preserves any explicit 0 caps set by the user.
 */
export function getSavedCategoryCaps(): Record<string, number> {
  if (typeof window === 'undefined') return { ...DEFAULT_CATEGORY_CAPS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && Object.keys(parsed).length > 0) {
        const sanitized: Record<string, number> = {};
        for (const [k, v] of Object.entries(parsed)) {
          const num = Number(v);
          if (Number.isFinite(num) && num >= 0) {
            sanitized[k] = num;
          }
        }
        if (Object.keys(sanitized).length > 0) {
          return sanitized;
        }
      }
    }
  } catch {}
  return { ...DEFAULT_CATEGORY_CAPS };
}

/**
 * Saves category budget caps to localStorage with background cloud SOT sync.
 */
export function saveCategoryCaps(caps: Record<string, number>): void {
  if (typeof window === 'undefined') return;
  const sanitized: Record<string, number> = {};
  for (const [k, v] of Object.entries(caps || {})) {
    const num = Number(v);
    if (Number.isFinite(num) && num >= 0) {
      sanitized[k] = Math.round(num * 100) / 100;
    }
  }
  const serialized = JSON.stringify(sanitized);
  try {
    localStorage.setItem(STORAGE_KEY, serialized);
    window.dispatchEvent(
      new CustomEvent('cashflow_cloud_settings_synced', {
        detail: { key: STORAGE_KEY, value: serialized },
      })
    );
  } catch {}
  try {
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
export function getMonthDaysInfo(monthStr?: string, referenceDate?: Date) {
  const now = referenceDate || new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1; // 1-indexed
  const todayDate = now.getDate();

  // Full Year View (e.g. "year-2026")
  if (monthStr?.startsWith('year-')) {
    const y = parseInt(monthStr.replace('year-', ''), 10);
    const targetYear = !isNaN(y) ? y : currentYear;
    const isLeap = (targetYear % 4 === 0 && targetYear % 100 !== 0) || targetYear % 400 === 0;
    const totalDays = isLeap ? 366 : 365;
    const isCurrentYear = targetYear === currentYear;
    const isPastYear = targetYear < currentYear;

    let daysRemaining = 0;
    if (isCurrentYear) {
      const endOfYear = new Date(currentYear, 11, 31, 23, 59, 59);
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
    if (!isNaN(y) && !isNaN(m) && m >= 1 && m <= 12) {
      year = y;
      month = m;
    }
  }

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
    todayDate: isCurrentMonth ? todayDate : isPastMonth ? totalDays : 1,
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
  const isOverBudget = totalBudget > 0 && totalSpent > totalBudget;
  const overAmount = isOverBudget ? totalSpent - totalBudget : 0;
  const spentPercent = totalBudget > 0 ? (totalSpent / totalBudget) * 100 : 0;

  return {
    totalBudget,
    totalSpent,
    remainingBudget: Number(remainingBudget.toFixed(2)),
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
  committedFloor?: number;
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
  paydayWindowDailyAllowance?: number;
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
  dailyAllowanceAfter: number;
  todaySpentInCategory: number;
  isDailyCategory: boolean;
  isDailyPaceExceeded?: boolean;
  badgeText: string;
  badgeColor: 'emerald' | 'amber' | 'rose';
  pacingNote?: string;
}

export interface MonthlySavingsPrediction {
  baselineIncome: number;
  savingsTargetPct: number;
  investmentTargetPct: number;
  totalSavingsTargetPct: number;
  targetSavingsAmount: number;
  targetInvestmentAmount: number;
  targetLivingBudget: number;

  todayDate: number;
  totalDaysInMonth: number;
  daysPassed: number;
  daysRemaining: number;

  spentSoFar: number;
  lumpSumSpent: number;
  dailyVariableSpent: number;
  unpaidCommittedReserve?: number;
  currentDailySpend: number;

  projectedTotalSpend: number;
  projectedMonthEndSurplus: number;

  predictedSavingsAmount: number;
  predictedSavingsPct: number;
  predictedInvestmentAmount: number;
  predictedInvestmentPct: number;
  predictedTotalSavedAmount: number;
  predictedTotalSavedPct: number;

  safeDailyLivingAllowance: number;
  pacingStatus: 'ahead_of_target' | 'on_track' | 'risk_of_under_saving' | 'in_deficit';
  pacingDifferenceDaily: number;
  insightMessage: string;
}

interface GenericTransaction {
  id?: string;
  type?: string;
  amount?: number;
  currency?: string;
  baseAmount?: number;
  category?: string;
  description?: string;
  notes?: string;
  date?: string;
}

interface StoredRecurringLike {
  id?: string;
  name?: string;
  category?: string;
  amount?: number;
  dayOfMonth?: number;
}

interface StoredInstallmentLike {
  id?: string;
  name?: string;
  category?: string;
  monthlyAmount?: number;
  monthlyPayment?: number;
  remainingMonths?: number;
  endDate?: string;
}

function getCommittedFixedByCategory(targetMonthPrefix: string): Map<string, number> {
  const map = new Map<string, number>();
  if (typeof window === 'undefined' && typeof localStorage === 'undefined') return map;

  try {
    const rawRec = localStorage.getItem('cashflow_recurring_commitments');
    if (rawRec) {
      const list = JSON.parse(rawRec) as StoredRecurringLike[];
      if (Array.isArray(list)) {
        for (const item of list) {
          const amt = Number(item?.amount) || 0;
          const cat = item?.category || 'Housing & Bills';
          if (amt > 0) {
            map.set(cat, (map.get(cat) || 0) + amt);
          }
        }
      }
    }
  } catch {}

  try {
    const rawInst = localStorage.getItem('cashflow_installment_plans');
    if (rawInst) {
      const list = JSON.parse(rawInst) as StoredInstallmentLike[];
      if (Array.isArray(list)) {
        for (const plan of list) {
          if (plan?.endDate && plan.endDate < targetMonthPrefix) continue;
          if (typeof plan?.remainingMonths === 'number' && plan.remainingMonths <= 0) continue;
          const amt = Number(plan?.monthlyAmount ?? plan?.monthlyPayment) || 0;
          const cat = plan?.category || 'Shopping';
          if (amt > 0) {
            map.set(cat, (map.get(cat) || 0) + amt);
          }
        }
      }
    }
  } catch {}

  return map;
}

/**
 * Helper to refresh reasoning, dailyAllowance, and sharePercent after any cap scaling/trimming
 * so the displayed explanation ALWAYS matches the final suggestedCap number.
 */
function synchronizeSuggestionMetadata(
  suggestions: IntelligentCapSuggestion[],
  targetLivingBudget: number,
  totalSavingsPct: number
): void {
  const totalCaps = Math.max(1, suggestions.reduce((sum, s) => sum + s.suggestedCap, 0));

  for (const s of suggestions) {
    s.sharePercent = Math.round((s.suggestedCap / totalCaps) * 100);

    if (s.category === 'Food & Dining') {
      const foodDaily = Number((s.suggestedCap / 30).toFixed(1));
      s.dailyAllowance = foodDaily;
      s.reasoning =
        s.historicalAvg > 0
          ? `Allocated RM ${s.suggestedCap} (RM ${foodDaily}/day vs historical avg RM ${s.historicalAvg}/mo) for active daily meal pacing while strictly reserving your ${totalSavingsPct}% savings goal.`
          : `Allocated RM ${s.suggestedCap} (RM ${foodDaily}/day) for active daily meal pacing while strictly reserving your ${totalSavingsPct}% savings goal.`;
    } else if (s.category === 'Insurance') {
      s.reasoning =
        s.suggestedCap > 0
          ? `Identified as a monthly recurring commitment. Suggested cap matches your steady RM ${s.suggestedCap}/mo premium without waste.`
          : `No active insurance premium detected in your ledger or recurring rules (set to RM 0; raise if needed).`;
    } else if (s.category === 'Housing & Bills') {
      s.reasoning =
        s.suggestedCap > 0
          ? `Baseline rent & utilities (avg RM ${s.historicalAvg}/mo) + bill buffer (RM ${s.suggestedCap}/mo) to handle seasonal utility spikes.`
          : `No housing or utility bills detected yet (set to RM 0).`;
    } else if (s.category === 'Transport') {
      s.dailyAllowance = Number((s.suggestedCap / 30).toFixed(1));
      s.reasoning = `Based on your regular commute, toll, and fuel trends (avg RM ${s.historicalAvg}/mo · cap RM ${s.suggestedCap}/mo).`;
    } else if (s.category === 'Parents') {
      s.reasoning =
        s.suggestedCap > 0
          ? `Regular family support commitment locked at RM ${s.suggestedCap}/mo.`
          : `No regular family support detected (set to RM 0; adjust if needed).`;
    } else if (s.category === 'Health') {
      s.reasoning =
        s.suggestedCap > 0
          ? `Essential medical, clinic, and pharmacy safety net (RM ${s.suggestedCap}/mo · historical avg RM ${s.historicalAvg}/mo).`
          : `No recurring medical spend detected (RM 0; adjust if needed).`;
    } else if (s.category === 'Education') {
      s.reasoning =
        s.suggestedCap > 0
          ? `Occasional self-learning & course reserve (RM ${s.suggestedCap}/mo). Handled as a flexible lump sum so it does not distort daily living burn rate.`
          : `No recurring education spend detected (set to RM 0 so unused reserves don't crowd out daily living).`;
    } else if (s.category === 'Sport') {
      s.reasoning =
        s.suggestedCap > 0
          ? `Monthly sports & gym cap (RM ${s.suggestedCap}). Spend one time, use whole month.`
          : `No sport/gym expenses detected in recent months (RM 0).`;
    } else if (s.category === 'Shopping') {
      s.reasoning = `Monthly retail & lifestyle cap (RM ${s.suggestedCap}). Spend one time, use whole month.`;
    } else {
      s.reasoning =
        s.suggestedCap > 0
          ? `Monthly capped budget (RM ${s.suggestedCap}). Spend one time, use whole month.`
          : `Minimal historical spend detected (RM 0).`;
    }
  }
}

/**
 * Computes intelligent category spending caps derived dynamically from:
 * 1. True multi-month historical spending (including RM 0 months so one-off expenses don't inflate monthly averages).
 * 2. Active Recurring Commitments and Installment Plans per category.
 * 3. User's Income Allocation baseline income, savings/investment targets, and explicit monthlyBudgetCap.
 * 4. Strict necessity-ordered trimming (Other -> Gift -> Entertainment -> Shopping -> Sport -> Food & Dining -> Transport -> Education -> Health, preserving Insurance and Housing & Bills).
 */
export function generateIntelligentCategoryCaps(
  allTransactions: GenericTransaction[] = [],
  options?: {
    baselineIncome?: number;
    savingsTargetPct?: number;
    investmentTargetPct?: number;
    configuredCaps?: Record<string, number>;
    lockedCaps?: Record<string, boolean>;
    monthlyBudgetCap?: number;
  }
): IntelligentBudgetPlan {
  const profile = typeof window !== 'undefined' ? getUserMoneyProfile() : null;
  const currentCaps = options?.configuredCaps || getSavedCategoryCaps();

  // 1. Resolve Monthly Income & Target Savings
  const savedIncome =
    typeof window !== 'undefined' ? parseFloat(localStorage.getItem('cashflow_baseline_income') || '0') : 0;
  const baselineIncome =
    options?.baselineIncome || (savedIncome > 0 ? savedIncome : profile?.baselineIncome ?? 3000);

  const savedSavingsPct =
    typeof window !== 'undefined' ? parseFloat(localStorage.getItem('cashflow_savings_target_pct') || '20') : 20;
  const savingsTargetPct = options?.savingsTargetPct ?? (isNaN(savedSavingsPct) ? 20 : savedSavingsPct);

  const savedInvestPct =
    typeof window !== 'undefined' ? parseFloat(localStorage.getItem('cashflow_investment_target_pct') || '20') : 20;
  const investmentTargetPct = options?.investmentTargetPct ?? (isNaN(savedInvestPct) ? 20 : savedInvestPct);

  const totalSavingsPct = Math.min(80, Math.max(0, savingsTargetPct + investmentTargetPct));
  const targetSavingsAmount = Math.round(baselineIncome * (totalSavingsPct / 100));

  const incomeDerivedLivingBudget = Math.max(800, baselineIncome - targetSavingsAmount);
  const explicitMonthlyCap = options?.monthlyBudgetCap ?? profile?.monthlyBudgetCap ?? null;
  const targetLivingBudget =
    explicitMonthlyCap && explicitMonthlyCap > 0
      ? Math.min(incomeDerivedLivingBudget, explicitMonthlyCap)
      : incomeDerivedLivingBudget;

  // 2. Aggregate Historical Spending by Category and Month
  const currentMonthPrefix = getLocalDateString().slice(0, 7);
  const categoryMonthlyMap = new Map<string, Map<string, number>>();
  const allObservedMonths = new Set<string>();

  CANONICAL_EXPENSE_CATEGORIES.forEach((cat) => categoryMonthlyMap.set(cat, new Map()));

  const validTxs = Array.isArray(allTransactions) ? allTransactions : [];
  validTxs.forEach((t) => {
    if (!t.date || t.date.length < 7 || String(t.type || '').toLowerCase() !== 'expense' || t.id === 'tx_sample') {
      return;
    }
    const cat = t.category || 'Other';
    const monthKey = t.date.slice(0, 7);
    const amount = getAmountInBaseCurrency(t.amount || 0, t.currency, t.baseAmount);
    if (amount <= 0) return;

    allObservedMonths.add(monthKey);
    if (!categoryMonthlyMap.has(cat)) {
      categoryMonthlyMap.set(cat, new Map());
    }
    const catMonths = categoryMonthlyMap.get(cat)!;
    catMonths.set(monthKey, (catMonths.get(monthKey) || 0) + amount);
  });

  // Determine the denominator of completed ledger months (up to trailing 6 completed months)
  const completedLedgerMonths = Array.from(allObservedMonths)
    .filter((m) => m < currentMonthPrefix)
    .sort()
    .slice(-6);
  const referenceMonths =
    completedLedgerMonths.length > 0
      ? completedLedgerMonths
      : Array.from(allObservedMonths).sort().slice(-6);
  const hasRealLedgerHistory = referenceMonths.length > 0;
  const totalLedgerMonthsCount = Math.max(1, referenceMonths.length);

  // Also check user's configured recurring commitments & active installments
  const committedByCat = getCommittedFixedByCategory(currentMonthPrefix);

  // 3. Compute Statistical Profile per Category across ALL reference months (including RM 0 months!)
  interface CategoryStats {
    category: string;
    avgAcrossAllMonths: number;
    activeMonthAvg: number;
    activeMonthMedian: number;
    recentChronological: number;
    activeSampleCount: number;
    committedFloor: number;
  }

  const statsMap = new Map<string, CategoryStats>();

  categoryMonthlyMap.forEach((months, cat) => {
    const committedFloor = Math.round(committedByCat.get(cat) || 0);
    if (!hasRealLedgerHistory) {
      statsMap.set(cat, {
        category: cat,
        avgAcrossAllMonths: 0,
        activeMonthAvg: 0,
        activeMonthMedian: 0,
        recentChronological: 0,
        activeSampleCount: 0,
        committedFloor,
      });
      return;
    }

    const chronologicalAmounts = referenceMonths.map((m) => months.get(m) || 0);
    const activeValues = chronologicalAmounts.filter((v) => v > 0);

    if (activeValues.length === 0) {
      statsMap.set(cat, {
        category: cat,
        avgAcrossAllMonths: 0,
        activeMonthAvg: 0,
        activeMonthMedian: 0,
        recentChronological: 0,
        activeSampleCount: 0,
        committedFloor,
      });
      return;
    }

    let weightedSum = 0;
    let weightTotal = 0;
    chronologicalAmounts.forEach((val, idx) => {
      const weight = idx >= chronologicalAmounts.length - 2 ? 1.5 : 1.0;
      weightedSum += val * weight;
      weightTotal += weight;
    });
    const avgAcrossAllMonths = weightedSum / (weightTotal || 1);

    const activeSum = activeValues.reduce((acc, v) => acc + v, 0);
    const activeMonthAvg = activeSum / activeValues.length;
    const sortedActive = [...activeValues].sort((a, b) => a - b);
    const mid = Math.floor(sortedActive.length / 2);
    const activeMonthMedian =
      sortedActive.length % 2 === 0
        ? (sortedActive[mid - 1] + sortedActive[mid]) / 2
        : sortedActive[mid];
    const recentChronological = chronologicalAmounts[chronologicalAmounts.length - 1] || 0;

    statsMap.set(cat, {
      category: cat,
      avgAcrossAllMonths,
      activeMonthAvg,
      activeMonthMedian,
      recentChronological,
      activeSampleCount: activeValues.length,
      committedFloor,
    });
  });

  // 4. Classify and Generate Cap Suggestions
  const suggestions: IntelligentCapSuggestion[] = [];
  let committedCapsSum = 0;

  // Tier A: Insurance (Fixed Monthly Commitment)
  const insuranceStats = statsMap.get('Insurance')!;
  let insuranceCap = hasRealLedgerHistory ? 0 : 250;
  if (insuranceStats.committedFloor > 0 || insuranceStats.activeSampleCount > 0) {
    const baseIns =
      insuranceStats.activeSampleCount >= Math.ceil(totalLedgerMonthsCount / 2)
        ? insuranceStats.activeMonthMedian
        : insuranceStats.avgAcrossAllMonths;
    insuranceCap = Math.max(insuranceStats.committedFloor, Math.round(baseIns / 10) * 10 || 250);
  }
  committedCapsSum += insuranceCap;
  suggestions.push({
    category: 'Insurance',
    currentCap: resolveCategoryCapValue('Insurance', currentCaps, 250),
    suggestedCap: insuranceCap,
    historicalAvg: Math.round(insuranceStats.avgAcrossAllMonths || insuranceCap),
    nature: 'fixed',
    natureLabel: 'Fixed Monthly Recurring',
    reasoning: '',
    committedFloor: insuranceStats.committedFloor || (insuranceStats.activeSampleCount > 0 ? insuranceCap : 0),
  });

  // Tier B: Quasi-Fixed Housing & Bills
  const housingStats = statsMap.get('Housing & Bills')!;
  let housingCap = hasRealLedgerHistory ? 0 : 500;
  if (housingStats.committedFloor > 0 || housingStats.activeSampleCount > 0) {
    const baseHousing = Math.max(housingStats.avgAcrossAllMonths, housingStats.activeMonthMedian * 0.9);
    housingCap = Math.max(
      housingStats.committedFloor,
      300,
      Math.round((baseHousing * 1.08) / 10) * 10
    );
  }
  committedCapsSum += housingCap;
  suggestions.push({
    category: 'Housing & Bills',
    currentCap: resolveCategoryCapValue('Housing & Bills', currentCaps, 500),
    suggestedCap: housingCap,
    historicalAvg: Math.round(housingStats.avgAcrossAllMonths || housingCap),
    nature: 'quasi-fixed',
    natureLabel: 'Quasi-Fixed Baseline + Bills Buffer',
    reasoning: '',
    committedFloor: housingStats.committedFloor || (housingStats.activeSampleCount > 0 ? Math.round(housingStats.avgAcrossAllMonths) : 0),
  });

  // Tier C: Commute & Transport Trend
  const transportStats = statsMap.get('Transport')!;
  let transportCap = hasRealLedgerHistory ? 0 : 150;
  if (transportStats.committedFloor > 0 || transportStats.activeSampleCount > 0) {
    const baseTrans = Math.max(transportStats.avgAcrossAllMonths, transportStats.activeMonthMedian * 0.85);
    transportCap = Math.max(
      transportStats.committedFloor,
      80,
      Math.round((baseTrans * 1.05) / 10) * 10
    );
  }
  committedCapsSum += transportCap;
  suggestions.push({
    category: 'Transport',
    currentCap: resolveCategoryCapValue('Transport', currentCaps, 150),
    suggestedCap: transportCap,
    historicalAvg: Math.round(transportStats.avgAcrossAllMonths || transportCap),
    nature: 'trend',
    natureLabel: 'Commute & Fuel Trend',
    reasoning: '',
    committedFloor: transportStats.committedFloor,
  });

  // Parents support
  const parentsStats = statsMap.get('Parents')!;
  let parentsCap = 0;
  if (parentsStats.committedFloor > 0 || parentsStats.activeSampleCount > 0) {
    const baseParents =
      parentsStats.activeSampleCount >= Math.ceil(totalLedgerMonthsCount / 2)
        ? parentsStats.activeMonthMedian
        : parentsStats.avgAcrossAllMonths;
    parentsCap = Math.max(parentsStats.committedFloor, Math.round(baseParents / 50) * 50);
    committedCapsSum += parentsCap;
  }
  suggestions.push({
    category: 'Parents',
    currentCap: resolveCategoryCapValue('Parents', currentCaps, 0),
    suggestedCap: parentsCap,
    historicalAvg: Math.round(parentsStats.avgAcrossAllMonths || 0),
    nature: 'fixed',
    natureLabel: 'Family Commitment',
    reasoning: '',
    committedFloor: parentsStats.committedFloor || parentsCap,
  });

  // Health baseline
  const healthStats = statsMap.get('Health')!;
  let healthCap = hasRealLedgerHistory ? 50 : 100;
  if (healthStats.committedFloor > 0 || healthStats.activeSampleCount > 0) {
    healthCap = Math.max(
      healthStats.committedFloor,
      50,
      Math.round(healthStats.avgAcrossAllMonths / 10) * 10
    );
  }
  committedCapsSum += healthCap;
  suggestions.push({
    category: 'Health',
    currentCap: resolveCategoryCapValue('Health', currentCaps, 100),
    suggestedCap: healthCap,
    historicalAvg: Math.round(healthStats.avgAcrossAllMonths || healthCap),
    nature: 'quasi-fixed',
    natureLabel: 'Wellness & Medical Baseline',
    reasoning: '',
    committedFloor: healthStats.committedFloor,
  });

  // Education baseline (uses avgAcrossAllMonths so a 1-time course is amortized properly)
  const educationStats = statsMap.get('Education')!;
  let educationCap = hasRealLedgerHistory ? 0 : 100;
  if (educationStats.committedFloor > 0 || educationStats.activeSampleCount > 0) {
    educationCap = Math.max(
      educationStats.committedFloor,
      50,
      Math.round(educationStats.avgAcrossAllMonths / 10) * 10
    );
  }
  committedCapsSum += educationCap;
  suggestions.push({
    category: 'Education',
    currentCap: resolveCategoryCapValue('Education', currentCaps, 100),
    suggestedCap: educationCap,
    historicalAvg: Math.round(educationStats.avgAcrossAllMonths || 0),
    nature: 'quasi-fixed',
    natureLabel: 'Periodic Education / Courses',
    reasoning: '',
    committedFloor: educationStats.committedFloor,
  });

  // 5. Allocate Remaining Discretionary Living Pool
  const remainingDiscretionaryPool = Math.max(500, targetLivingBudget - committedCapsSum);
  const discretionaryNames = ['Food & Dining', 'Shopping', 'Sport', 'Entertainment', 'Gift', 'Other'];
  const discretionaryAvgs: Record<string, number> = {};
  let totalDiscretionaryAvg = 0;

  discretionaryNames.forEach((cat) => {
    const st = statsMap.get(cat);
    const fallbackDefault =
      cat === 'Food & Dining'
        ? 700
        : cat === 'Shopping'
        ? 250
        : cat === 'Sport'
        ? 120
        : 100;
    const avg =
      st && (st.avgAcrossAllMonths > 0 || st.committedFloor > 0)
        ? Math.max(st.avgAcrossAllMonths, st.committedFloor)
        : fallbackDefault;
    discretionaryAvgs[cat] = avg;
    totalDiscretionaryAvg += avg;
  });

  const rawFoodWeight = discretionaryAvgs['Food & Dining'] / (totalDiscretionaryAvg || 1);
  const effectiveFoodWeight = Math.max(0.48, Math.min(0.65, rawFoodWeight));
  const foodStats = statsMap.get('Food & Dining')!;
  const suggestedFoodCap = Math.max(600, Math.round((remainingDiscretionaryPool * effectiveFoodWeight) / 10) * 10);

  suggestions.push({
    category: 'Food & Dining',
    currentCap: resolveCategoryCapValue('Food & Dining', currentCaps, 600),
    suggestedCap: suggestedFoodCap,
    historicalAvg: Math.round(foodStats.avgAcrossAllMonths || discretionaryAvgs['Food & Dining']),
    nature: 'discretionary',
    natureLabel: 'Daily Sustenance (Paced Daily)',
    reasoning: '',
    committedFloor: foodStats.committedFloor,
  });

  const poolAfterFood = Math.max(200, remainingDiscretionaryPool - suggestedFoodCap);
  const otherDiscretionaryNames = ['Shopping', 'Sport', 'Entertainment', 'Gift', 'Other'];
  const otherDiscretionaryTotalAvg =
    otherDiscretionaryNames.reduce((acc, cat) => acc + discretionaryAvgs[cat], 0) || 1;

  otherDiscretionaryNames.forEach((cat) => {
    const st = statsMap.get(cat)!;
    const weight = discretionaryAvgs[cat] / otherDiscretionaryTotalAvg;
    const minFloor = cat === 'Shopping' ? 150 : cat === 'Sport' ? 80 : 50;
    const allocated = Math.max(minFloor, Math.round((poolAfterFood * weight) / 10) * 10);

    suggestions.push({
      category: cat,
      currentCap: resolveCategoryCapValue(cat, currentCaps, DEFAULT_CATEGORY_CAPS[cat] ?? 50),
      suggestedCap: allocated,
      historicalAvg: Math.round(st.avgAcrossAllMonths || discretionaryAvgs[cat]),
      nature: 'discretionary',
      natureLabel: 'Monthly Capped Bucket',
      reasoning: '',
      committedFloor: st.committedFloor,
    });
  });

  if (options?.lockedCaps) {
    for (const s of suggestions) {
      if (options.lockedCaps[s.category]) {
        s.suggestedCap = resolveCategoryCapValue(s.category, options.configuredCaps, s.suggestedCap);
      }
    }
  }

  // 6. Strict Hard Constraint: Sum of ALL Suggested Caps MUST be <= targetLivingBudget
  // Necessity-ordered trimming:
  // Pass 1: Discretionary non-essentials first (Other -> Gift -> Entertainment -> Shopping -> Sport -> Food & Dining)
  // Pass 2: Quasi-fixed / trend categories (Transport -> Education -> Health)
  // Pass 3: Only touch Housing & Bills or Insurance if mathematically unavoidable.
  const currentTotal = suggestions.reduce((sum, s) => sum + s.suggestedCap, 0);
  if (currentTotal > targetLivingBudget) {
    let excess = currentTotal - targetLivingBudget;
    const byCategory = new Map(suggestions.map((s) => [s.category, s]));
    const isLocked = (cat: string) => Boolean(options?.lockedCaps && options.lockedCaps[cat]);

    // Pass 1: Trim discretionary categories in strict low-priority-first order
    const discretionaryTrimOrder = ['Other', 'Gift', 'Entertainment', 'Shopping', 'Sport', 'Food & Dining'];
    while (excess > 0) {
      let trimmedAny = false;
      for (const catName of discretionaryTrimOrder) {
        if (isLocked(catName)) continue;
        const item = byCategory.get(catName);
        if (!item) continue;
        const floor = item.category === 'Food & Dining' ? 400 : Math.max(30, item.committedFloor || 0);
        if (item.suggestedCap > floor && excess > 0) {
          const step = Math.min(10, excess, item.suggestedCap - floor);
          item.suggestedCap -= step;
          excess -= step;
          trimmedAny = true;
          if (excess <= 0) break;
        }
      }
      if (!trimmedAny) break;
    }

    // Pass 2: Trim quasi-fixed and trend categories in strict necessity order (Transport -> Education -> Health)
    if (excess > 0) {
      const flexibleTrimOrder = ['Transport', 'Education', 'Health'];
      for (const catName of flexibleTrimOrder) {
        if (isLocked(catName)) continue;
        const item = byCategory.get(catName);
        if (!item) continue;
        const floor = Math.max(40, item.committedFloor || 0);
        if (item.suggestedCap > floor && excess > 0) {
          const step = Math.min(item.suggestedCap - floor, excess);
          item.suggestedCap -= step;
          excess -= step;
          if (excess <= 0) break;
        }
      }
    }

    // Pass 3: If still in excess, trim down to 0 in strict necessity order (protecting Housing & Bills and Insurance until absolute last)
    if (excess > 0) {
      const finalTrimOrder = [
        'Other',
        'Gift',
        'Entertainment',
        'Shopping',
        'Sport',
        'Education',
        'Transport',
        'Health',
        'Food & Dining',
        'Parents',
        'Housing & Bills',
        'Insurance',
      ];
      for (const catName of finalTrimOrder) {
        if (isLocked(catName)) continue;
        const item = byCategory.get(catName);
        if (!item) continue;
        if (item.suggestedCap > 0 && excess > 0) {
          const cut = Math.min(item.suggestedCap, excess);
          item.suggestedCap -= cut;
          excess -= cut;
          if (excess <= 0) break;
        }
      }
    }
  }

  // Synchronize reasoning, dailyAllowance, and sharePercent AFTER trimming!
  synchronizeSuggestionMetadata(suggestions, targetLivingBudget, totalSavingsPct);

  const totalSuggestedCaps = suggestions.reduce((sum, s) => sum + s.suggestedCap, 0);
  const savingsHealthStatus: 'healthy' | 'tight' | 'exceeded' =
    totalSuggestedCaps <= targetLivingBudget
      ? 'healthy'
      : totalSuggestedCaps <= baselineIncome * 0.95
      ? 'tight'
      : 'exceeded';

  const summaryInsight =
    savingsHealthStatus === 'healthy'
      ? `✨ These caps total RM ${totalSuggestedCaps.toLocaleString()} (strictly under your RM ${targetLivingBudget.toLocaleString()} living budget), guaranteeing your ${totalSavingsPct}% savings & investment target (RM ${targetSavingsAmount.toLocaleString()}/mo).`
      : `⚠️ Total caps trimmed to fit strictly within your RM ${targetLivingBudget.toLocaleString()} living budget.`;

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
 * Only Food & Dining is a daily variable expense category.
 * All other categories are budget-capped buckets ("spend one time, use whole month").
 */
export function isDailyCategory(category?: string): boolean {
  if (!category) return false;
  const normalized = category.trim().toLowerCase();
  return normalized === 'food & dining' || normalized === 'food';
}

/**
 * Determines whether an expense belongs to a monthly-capped bucket ("spend one time, use whole month")
 * rather than a daily variable burn-rate routine.
 */
export function isLumpSumExpense(category: string, _amount?: number): boolean {
  return !isDailyCategory(category);
}

/**
 * Scales or trims a record of category caps so that their sum is strictly <= maxLivingBudget (Income - Savings).
 * Preserves explicit 0 caps and respects fixed recurring commitments.
 */
export function fitCapsToLivingBudget(
  caps: Record<string, number>,
  maxLivingBudget: number,
  lockedCaps?: Record<string, boolean>
): Record<string, number> {
  const result: Record<string, number> = {};
  const keys = Object.keys(caps).length > 0 ? Object.keys(caps) : Array.from(CANONICAL_EXPENSE_CATEGORIES);

  keys.forEach((cat) => {
    const val = Number(caps[cat]);
    result[cat] = Number.isFinite(val) && val >= 0 ? val : 0;
  });

  const currentSum = Object.values(result).reduce((sum, v) => sum + v, 0);
  if (currentSum <= maxLivingBudget && currentSum > 0) return result;

  const isLocked = (cat: string) => Boolean(lockedCaps && lockedCaps[cat]);
  const fixedCategories = new Set<string>();
  keys.forEach((cat) => {
    if (isLocked(cat)) {
      fixedCategories.add(cat);
    }
  });
  if (fixedCategories.size === 0 && result['Insurance'] !== undefined) {
    fixedCategories.add('Insurance');
  }

  let fixedSum = 0;
  fixedCategories.forEach((cat) => {
    if (result[cat]) fixedSum += result[cat];
  });

  if (fixedSum >= maxLivingBudget) {
    const scale = maxLivingBudget / (currentSum || 1);
    keys.forEach((cat) => {
      if (!isLocked(cat)) {
        result[cat] = Math.max(0, Math.floor((result[cat] * scale) / 10) * 10);
      }
    });
  } else {
    const availableForFlexible = maxLivingBudget - fixedSum;
    const flexibleSum = Object.entries(result)
      .filter(([cat]) => !fixedCategories.has(cat))
      .reduce((sum, [, v]) => sum + v, 0);

    if (flexibleSum > 0) {
      const scale = availableForFlexible / flexibleSum;
      keys.forEach((cat) => {
        if (!fixedCategories.has(cat)) {
          result[cat] = Math.max(0, Math.floor((result[cat] * scale) / 10) * 10);
        }
      });
    }
  }

  const adjustedSum = Object.values(result).reduce((sum, v) => sum + v, 0);
  if (adjustedSum > maxLivingBudget) {
    let excess = adjustedSum - maxLivingBudget;
    const trimOrder = [
      'Other',
      'Gift',
      'Entertainment',
      'Shopping',
      'Sport',
      'Education',
      'Health',
      'Transport',
      'Housing & Bills',
      'Food & Dining',
    ];
    for (const cat of trimOrder) {
      if (!isLocked(cat) && result[cat] > 0 && excess > 0) {
        const cut = Math.min(result[cat], excess);
        result[cat] -= cut;
        excess -= cut;
        if (excess <= 0) break;
      }
    }
    if (excess > 0) {
      for (const cat of Object.keys(result)) {
        if (!isLocked(cat) && result[cat] > 0 && excess > 0) {
          const cut = Math.min(result[cat], excess);
          result[cat] -= cut;
          excess -= cut;
          if (excess <= 0) break;
        }
      }
    }
  }

  return result;
}

/**
 * Helper to resolve which month prefix to filter by when a caller passes transactions:
 * - If explicitMonth (`YYYY-MM`) is provided, use it.
 * - If any transaction matches the current/reference month (`YYYY-MM`), filter to that month
 *   (prevents 60-day multi-month rolling caches from summing 2-3 months against 1 month's cap).
 * - If all passed transactions belong to a single historical month (e.g. unit test fixtures), use that month.
 */
function resolveEffectiveMonthFilter(
  transactions: GenericTransaction[],
  defaultMonthPrefix: string,
  explicitMonth?: string
): string | null {
  if (explicitMonth && /^\d{4}-\d{2}$/.test(explicitMonth)) {
    return explicitMonth;
  }
  const monthsPresent = new Set<string>();
  for (const t of transactions) {
    if (t?.date && t.date.length >= 7 && String(t.type || '').toLowerCase() === 'expense' && t.id !== 'tx_sample') {
      monthsPresent.add(t.date.slice(0, 7));
    }
  }
  if (monthsPresent.has(defaultMonthPrefix)) {
    return defaultMonthPrefix;
  }
  if (monthsPresent.size > 1) {
    return Array.from(monthsPresent).sort().pop() || defaultMonthPrefix;
  }
  return null;
}

/**
 * Dynamically predicts month-end savings and investments based on:
 * 1. User's baseline income (from Income Allocation).
 * 2. Distinction between one-time / episodic lump sums (Education, Insurance, Bills)
 *    and routine daily burn rate (Food).
 * 3. User's target savings and investment percentage split.
 */
export function predictMonthlySavingsAndInvestments(
  currentMonthTransactions: GenericTransaction[] = [],
  options?: {
    baselineIncome?: number;
    savingsTargetPct?: number;
    investmentTargetPct?: number;
    selectedMonth?: string;
    referenceDate?: Date;
  }
): MonthlySavingsPrediction {
  const profile = typeof window !== 'undefined' ? getUserMoneyProfile() : null;

  const savedIncome =
    typeof window !== 'undefined' ? parseFloat(localStorage.getItem('cashflow_baseline_income') || '0') : 0;
  const baselineIncome =
    options?.baselineIncome || (savedIncome > 0 ? savedIncome : profile?.baselineIncome ?? 3000);

  const savedSavingsPct =
    typeof window !== 'undefined' ? parseFloat(localStorage.getItem('cashflow_savings_target_pct') || '20') : 20;
  const savingsTargetPct = options?.savingsTargetPct ?? (isNaN(savedSavingsPct) ? 20 : savedSavingsPct);

  const savedInvestPct =
    typeof window !== 'undefined' ? parseFloat(localStorage.getItem('cashflow_investment_target_pct') || '20') : 20;
  const investmentTargetPct = options?.investmentTargetPct ?? (isNaN(savedInvestPct) ? 20 : savedInvestPct);

  const totalSavingsTargetPct = Math.min(90, Math.max(0, savingsTargetPct + investmentTargetPct));
  const targetSavingsAmount = Math.round(baselineIncome * (savingsTargetPct / 100));
  const targetInvestmentAmount = Math.round(baselineIncome * (investmentTargetPct / 100));
  const totalTargetSavings = targetSavingsAmount + targetInvestmentAmount;
  const targetLivingBudget = Math.max(0, baselineIncome - totalTargetSavings);

  const daysInfo = getMonthDaysInfo(options?.selectedMonth, options?.referenceDate);
  const totalDaysInMonth = daysInfo.totalDays || 30;
  const todayDate = options?.referenceDate ? options.referenceDate.getDate() : daysInfo.todayDate || 1;
  const daysPassed = Math.max(1, Math.min(totalDaysInMonth, todayDate));
  const daysRemaining = Math.max(0, totalDaysInMonth - daysPassed);
  const defaultMonthPrefix = `${daysInfo.year}-${String(daysInfo.month || new Date().getMonth() + 1).padStart(2, '0')}`;

  const validTxs = Array.isArray(currentMonthTransactions) ? currentMonthTransactions : [];
  const monthFilter = resolveEffectiveMonthFilter(validTxs, defaultMonthPrefix, options?.selectedMonth);

  let lumpSumSpent = 0;
  let dailyVariableSpent = 0;
  const spentByCategory = new Map<string, number>();

  validTxs.forEach((t) => {
    if (String(t.type || '').toLowerCase() !== 'expense' || t.id === 'tx_sample') return;
    if (monthFilter && t.date && t.date.length >= 7 && !t.date.startsWith(monthFilter)) return;

    const amt = getAmountInBaseCurrency(t.amount || 0, t.currency, t.baseAmount);
    if (amt <= 0) return;
    const cat = t.category || 'Other';
    spentByCategory.set(cat, (spentByCategory.get(cat) || 0) + amt);

    if (isLumpSumExpense(cat, amt)) {
      lumpSumSpent += amt;
    } else {
      dailyVariableSpent += amt;
    }
  });

  lumpSumSpent = Number(lumpSumSpent.toFixed(2));
  dailyVariableSpent = Number(dailyVariableSpent.toFixed(2));
  const spentSoFar = Number((lumpSumSpent + dailyVariableSpent).toFixed(2));

  // Track unpaid recurring commitments & installments for UI display
  const committedByCat = getCommittedFixedByCategory(monthFilter || defaultMonthPrefix);
  let unpaidCommittedReserve = 0;
  committedByCat.forEach((committedAmt, cat) => {
    const alreadyPaidInCat = spentByCategory.get(cat) || 0;
    if (committedAmt > alreadyPaidInCat) {
      unpaidCommittedReserve += committedAmt - alreadyPaidInCat;
    }
  });
  unpaidCommittedReserve = Number(unpaidCommittedReserve.toFixed(2));

  // Current daily variable burn rate
  const currentDailySpend = Number((dailyVariableSpent / daysPassed).toFixed(2));

  // Dynamic remaining living budget
  const remainingLivingPool = Math.max(0, targetLivingBudget - spentSoFar - unpaidCommittedReserve);
  const safeDailyLivingAllowance =
    daysRemaining > 0 ? Number((remainingLivingPool / daysRemaining).toFixed(2)) : 0;

  let effectiveDailyRate = safeDailyLivingAllowance;
  if (daysPassed >= 3 && dailyVariableSpent > 0) {
    const dayWeight = Math.min(1, (daysPassed - 2) / 7);
    effectiveDailyRate = dayWeight * currentDailySpend + (1 - dayWeight) * safeDailyLivingAllowance;
  } else if (dailyVariableSpent > 0) {
    effectiveDailyRate = currentDailySpend;
  }

  const projectedRemainingDaily = Number((effectiveDailyRate * daysRemaining).toFixed(2));
  const projectedTotalSpend = Number(
    (lumpSumSpent + unpaidCommittedReserve + dailyVariableSpent + projectedRemainingDaily).toFixed(2)
  );

  const projectedMonthEndSurplus = Number(Math.max(0, baselineIncome - projectedTotalSpend).toFixed(2));

  const savingsWeight = totalSavingsTargetPct > 0 ? savingsTargetPct / totalSavingsTargetPct : 0.5;
  const investWeight = totalSavingsTargetPct > 0 ? investmentTargetPct / totalSavingsTargetPct : 0.5;

  let predictedSavingsAmount = 0;
  let predictedInvestmentAmount = 0;

  if (projectedMonthEndSurplus > 0) {
    predictedSavingsAmount = Math.round(projectedMonthEndSurplus * savingsWeight);
    predictedInvestmentAmount = Math.round(projectedMonthEndSurplus * investWeight);
  }

  const predictedTotalSavedAmount = predictedSavingsAmount + predictedInvestmentAmount;
  const predictedSavingsPct =
    baselineIncome > 0 ? Number(((predictedSavingsAmount / baselineIncome) * 100).toFixed(1)) : 0;
  const predictedInvestmentPct =
    baselineIncome > 0 ? Number(((predictedInvestmentAmount / baselineIncome) * 100).toFixed(1)) : 0;
  const predictedTotalSavedPct =
    baselineIncome > 0 ? Number(((predictedTotalSavedAmount / baselineIncome) * 100).toFixed(1)) : 0;

  const pacingDifferenceDaily = Number((safeDailyLivingAllowance - currentDailySpend).toFixed(2));

  let pacingStatus: MonthlySavingsPrediction['pacingStatus'] = 'on_track';
  let insightMessage = '';
  const hasLumpSum = lumpSumSpent > 0;

  if (projectedTotalSpend > baselineIncome) {
    pacingStatus = 'in_deficit';
    const deficitAmt = (projectedTotalSpend - baselineIncome).toFixed(2);
    insightMessage = `⚠️ Living deficit warning: At your current burn rate (RM ${currentDailySpend.toFixed(2)}/day), month-end spend (RM ${projectedTotalSpend.toFixed(2)}) will exceed income by RM ${deficitAmt}. Reduce daily living to RM ${safeDailyLivingAllowance.toFixed(2)}/day to recover.`;
  } else if (predictedTotalSavedPct < totalSavingsTargetPct * 0.85) {
    pacingStatus = 'risk_of_under_saving';
    insightMessage = `⚠️ Under-saving risk: At RM ${currentDailySpend.toFixed(2)}/day, predicted savings is RM ${predictedSavingsAmount.toLocaleString()} (${predictedSavingsPct}%) and investments RM ${predictedInvestmentAmount.toLocaleString()} (${predictedInvestmentPct}%), below your ${totalSavingsTargetPct}% target. Keep daily spend under RM ${safeDailyLivingAllowance.toFixed(2)}/day to protect your full target.`;
  } else if (predictedTotalSavedPct > totalSavingsTargetPct) {
    pacingStatus = 'ahead_of_target';
    insightMessage = hasLumpSum
      ? `🎉 Ahead of goal! Lump sum (RM ${lumpSumSpent.toFixed(2)}) absorbed. Daily living pace (RM ${currentDailySpend.toFixed(2)}/day) keeps savings on track at RM ${predictedSavingsAmount.toLocaleString()} (${predictedSavingsPct}%) and investments at RM ${predictedInvestmentAmount.toLocaleString()} (${predictedInvestmentPct}%)!`
      : `🎉 Ahead of goal! At RM ${currentDailySpend.toFixed(2)}/day, predicted savings is RM ${predictedSavingsAmount.toLocaleString()} (${predictedSavingsPct}%) and investments RM ${predictedInvestmentAmount.toLocaleString()} (${predictedInvestmentPct}%), outperforming your ${totalSavingsTargetPct}% target!`;
  } else {
    pacingStatus = 'on_track';
    insightMessage = hasLumpSum
      ? `✨ On track: Lump sum (RM ${lumpSumSpent.toFixed(2)}) absorbed. Safe daily allowance adjusted to RM ${safeDailyLivingAllowance.toFixed(2)}/day, preserving your ${totalSavingsTargetPct}% savings target (RM ${predictedSavingsAmount.toLocaleString()} savings + RM ${predictedInvestmentAmount.toLocaleString()} investments).`
      : `✨ On track: At RM ${currentDailySpend.toFixed(2)}/day, you are projected to save RM ${predictedSavingsAmount.toLocaleString()} (${predictedSavingsPct}%) and invest RM ${predictedInvestmentAmount.toLocaleString()} (${predictedInvestmentPct}%), hitting your ${totalSavingsTargetPct}% target.`;
  }

  return {
    baselineIncome,
    savingsTargetPct,
    investmentTargetPct,
    totalSavingsTargetPct,
    targetSavingsAmount,
    targetInvestmentAmount,
    targetLivingBudget,
    todayDate,
    totalDaysInMonth,
    daysPassed,
    daysRemaining,
    spentSoFar,
    lumpSumSpent,
    dailyVariableSpent,
    unpaidCommittedReserve,
    currentDailySpend,
    projectedTotalSpend,
    projectedMonthEndSurplus,
    predictedSavingsAmount,
    predictedSavingsPct,
    predictedInvestmentAmount,
    predictedInvestmentPct,
    predictedTotalSavedAmount,
    predictedTotalSavedPct,
    safeDailyLivingAllowance,
    pacingStatus,
    pacingDifferenceDaily,
    insightMessage,
  };
}

/**
 * Solves Payday Cycle timing across any payday day (1-31), including wrap-around into next month:
 * 1. Fixes `daysUntilPayday` when `todayDate > paydayDay` (calculates days to next month's payday instead of returning 0).
 * 2. Supports wrap-around for late-month paydays (e.g. 28th) into the first days of next month (daysSincePayday <= 6),
 *    while preventing early-month paydays (e.g. 5th) from staying stuck in `payday_settlement` for 26 days.
 */
export function getPaydayCycleIntelligence(
  currentMonthTransactions: GenericTransaction[] = [],
  options?: {
    paydayDay?: number;
    baselineIncome?: number;
    savingsTargetPct?: number;
    investmentTargetPct?: number;
    referenceDate?: Date;
  }
): PaydayCycleIntelligence {
  const now = options?.referenceDate || new Date();
  const todayDate = now.getDate();
  const daysInfo = getMonthDaysInfo(undefined, now);
  const profile = typeof window !== 'undefined' ? getUserMoneyProfile() : null;

  const rawPayday = options?.paydayDay ?? profile?.paydayDay ?? 25;
  const effectivePaydayInThisMonth = Math.min(Math.max(1, rawPayday), daysInfo.totalDays);

  const savedIncome =
    typeof window !== 'undefined' ? parseFloat(localStorage.getItem('cashflow_baseline_income') || '0') : 0;
  const baselineIncome =
    options?.baselineIncome || (savedIncome > 0 ? savedIncome : profile?.baselineIncome ?? 3000);

  const savedSavingsPct =
    typeof window !== 'undefined' ? parseFloat(localStorage.getItem('cashflow_savings_target_pct') || '20') : 20;
  const savingsTargetPct = options?.savingsTargetPct ?? (isNaN(savedSavingsPct) ? 20 : savedSavingsPct);

  const savedInvestPct =
    typeof window !== 'undefined' ? parseFloat(localStorage.getItem('cashflow_investment_target_pct') || '20') : 20;
  const investmentTargetPct = options?.investmentTargetPct ?? (isNaN(savedInvestPct) ? 20 : savedInvestPct);

  const totalSavingsPct = Math.min(80, Math.max(0, savingsTargetPct + investmentTargetPct));
  const preQuarantinedSavings = Math.round(baselineIncome * (totalSavingsPct / 100));
  const targetLivingBudget = Math.max(500, baselineIncome - preQuarantinedSavings);

  // Accurate daysUntilPayday with next-month rollover when todayDate > effectivePaydayInThisMonth
  let daysUntilPayday = 0;
  if (todayDate <= effectivePaydayInThisMonth) {
    daysUntilPayday = effectivePaydayInThisMonth - todayDate;
  } else {
    const nextMonthDays = new Date(daysInfo.year, daysInfo.month + 1, 0).getDate();
    const nextPaydayClamped = Math.min(Math.max(1, rawPayday), nextMonthDays);
    daysUntilPayday = (daysInfo.totalDays - todayDate) + nextPaydayClamped;
  }

  // Support wrap-around for late-month paydays (e.g. 28th) into early next month (1st-3rd),
  // while keeping early-month paydays (e.g. 5th) strictly within a 7-day settlement window (0..6 days since payday).
  const daysInPrevMonth = new Date(daysInfo.year, daysInfo.month - 1, 0).getDate();
  const prevPaydayClamped = Math.min(Math.max(1, rawPayday), daysInPrevMonth);
  const daysSincePayday =
    todayDate >= effectivePaydayInThisMonth
      ? todayDate - effectivePaydayInThisMonth
      : todayDate + (daysInPrevMonth - prevPaydayClamped);
  const isPaydayWeek = daysSincePayday >= 0 && daysSincePayday <= 6;
  const cyclePhase: PaydayCycleIntelligence['cyclePhase'] = isPaydayWeek ? 'payday_settlement' : 'living_phase';

  const defaultMonthPrefix = getLocalDateString(now).slice(0, 7);
  const validTxs = Array.isArray(currentMonthTransactions) ? currentMonthTransactions : [];
  const monthFilter = resolveEffectiveMonthFilter(validTxs, defaultMonthPrefix);

  // Calculate actual savings/investment transfers executed this month
  const actualSavedThisMonth = validTxs.reduce((acc, t) => {
    if (monthFilter && t.date && t.date.length >= 7 && !t.date.startsWith(monthFilter)) return acc;
    const isInvest = String(t.type || '').toLowerCase() === 'investment';
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

  const savingsProgressPct =
    preQuarantinedSavings > 0 ? Math.min(100, Math.round((actualSavedThisMonth / preQuarantinedSavings) * 100)) : 100;
  const savingsGoalFulfilled = actualSavedThisMonth >= preQuarantinedSavings * 0.9;

  const totalLivingSpent = validTxs.reduce((acc, t) => {
    if (monthFilter && t.date && t.date.length >= 7 && !t.date.startsWith(monthFilter)) return acc;
    if (String(t.type || '').toLowerCase() === 'expense' && t.id !== 'tx_sample') {
      return acc + getAmountInBaseCurrency(t.amount || 0, t.currency, t.baseAmount);
    }
    return acc;
  }, 0);

  const remainingLivingBudget = Math.max(0, targetLivingBudget - totalLivingSpent);
  const dailyLivingAllowance =
    daysInfo.daysRemaining > 0 ? Number((remainingLivingBudget / daysInfo.daysRemaining).toFixed(2)) : 0;
  const paydayDivisor = Math.max(1, daysUntilPayday > 0 ? daysUntilPayday : daysInfo.daysRemaining);
  const paydayWindowDailyAllowance = Number((remainingLivingBudget / paydayDivisor).toFixed(2));

  let headline = '';
  let detail = '';

  if (cyclePhase === 'living_phase') {
    headline = `Active Living Phase · ${daysUntilPayday} days until Payday (${rawPayday}th)`;
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
    paydayDay: rawPayday,
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
    paydayWindowDailyAllowance,
    actualSavedThisMonth,
    savingsGoalFulfilled,
    savingsProgressPct,
    headline,
    detail,
  };
}

/**
 * Computes real-time in-context category budget feedback:
 * 1. Filters multi-month rolling caches to the active month (`YYYY-MM`) and ignores `ignoreTransactionId` when editing.
 * 2. Preserves explicit `0` caps instead of falling back to `500`.
 * 3. Updates daily allowance and pacing feedback dynamically with `proposedAmount` while preserving canonical badge wording.
 */
export function getCategoryRealtimeBudgetStatus(
  category: string,
  currentMonthTransactions: GenericTransaction[] = [],
  caps?: Record<string, number>,
  proposedAmount = 0,
  options?: {
    targetMonth?: string;
    ignoreTransactionId?: string;
    referenceDate?: Date;
  }
): CategoryRealtimeBudgetStatus {
  const currentCaps = caps || getSavedCategoryCaps();
  const cap = resolveCategoryCapValue(category, currentCaps, 500);
  const now = options?.referenceDate || new Date();
  const todayStr = getLocalDateString(now);
  const defaultMonthPrefix = options?.targetMonth || todayStr.slice(0, 7);
  const daysInfo = getMonthDaysInfo(defaultMonthPrefix, now);

  const validTxs = Array.isArray(currentMonthTransactions) ? currentMonthTransactions : [];
  const monthFilter = resolveEffectiveMonthFilter(validTxs, defaultMonthPrefix, options?.targetMonth);

  let spentSoFar = 0;
  let todaySpentInCategory = 0;

  validTxs.forEach((t) => {
    if (String(t.type || '').toLowerCase() !== 'expense' || t.id === 'tx_sample' || !t.date) return;
    if (options?.ignoreTransactionId && String(t.id) === String(options.ignoreTransactionId)) return;
    if (monthFilter && t.date.length >= 7 && !t.date.startsWith(monthFilter)) return;

    if (t.category === category) {
      const amt = getAmountInBaseCurrency(t.amount || 0, t.currency, t.baseAmount);
      spentSoFar += amt;
      if (t.date === todayStr) {
        todaySpentInCategory += amt;
      }
    }
  });

  const remainingBefore = Math.max(0, cap - spentSoFar);
  const isOverCapBefore = cap > 0 ? spentSoFar > cap : spentSoFar > 0;
  const spentPercentBefore = cap > 0 ? (spentSoFar / cap) * 100 : spentSoFar > 0 ? 100 : 0;

  const validProposed = Math.max(0, Number(proposedAmount) || 0);
  const spentAfter = spentSoFar + validProposed;
  const remainingAfter = cap - spentAfter;
  const isOverCapAfter = cap > 0 ? spentAfter > cap : spentAfter > 0;
  const spentPercentAfter = cap > 0 ? (spentAfter / cap) * 100 : spentAfter > 0 ? 100 : 0;

  const dailyCat = isDailyCategory(category);
  const dailyAllowanceRemaining =
    daysInfo.daysRemaining > 0 ? Number((remainingBefore / daysInfo.daysRemaining).toFixed(2)) : 0;

  const futureDays = Math.max(1, daysInfo.daysRemaining - (validProposed > 0 || todaySpentInCategory > 0 ? 1 : 0));
  const dailyAllowanceAfter =
    daysInfo.daysRemaining > 0 ? Number((Math.max(0, remainingAfter) / futureDays).toFixed(2)) : 0;

  const todayTotalWithProposed = todaySpentInCategory + validProposed;
  const baselineDailyAllowance = cap > 0 ? cap / (daysInfo.totalDays || 30) : 0;
  const isDailyPaceExceeded =
    dailyCat &&
    cap > 0 &&
    !isOverCapAfter &&
    todayTotalWithProposed > Math.max(dailyAllowanceRemaining * 1.35, baselineDailyAllowance * 1.5);

  let badgeColor: 'emerald' | 'amber' | 'rose' = 'emerald';
  let badgeText = '';

  if (isOverCapAfter) {
    badgeColor = 'rose';
    const overAmt = spentAfter - cap;
    badgeText = isOverCapBefore
      ? `Over cap by RM ${overAmt.toFixed(2)}`
      : `Will exceed cap by RM ${overAmt.toFixed(2)}!`;
  } else if (spentPercentAfter > 80 || isDailyPaceExceeded) {
    badgeColor = 'amber';
    badgeText = `Approaching cap (${spentPercentAfter.toFixed(0)}% used · RM ${remainingAfter.toFixed(2)} left)`;
  } else {
    badgeColor = 'emerald';
    badgeText = `Well on track (${spentPercentAfter.toFixed(0)}% used · RM ${remainingAfter.toFixed(2)} left)`;
  }

  let pacingNote: string | undefined;
  if (dailyCat) {
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
    dailyAllowanceAfter,
    todaySpentInCategory: Number(todaySpentInCategory.toFixed(2)),
    isDailyCategory: dailyCat,
    isDailyPaceExceeded,
    badgeText,
    badgeColor,
    pacingNote,
  };
}
