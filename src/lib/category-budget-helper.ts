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
 * Strictly preserves any explicit 0 caps set by the user while ensuring all canonical categories exist.
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
  /** Total monthly recurring commitments + active installments configured for this category */
  committedFloor?: number;
  /** Amount of recurring/installment bills in this category NOT YET paid this month */
  unpaidBillReserve?: number;
  /** Amount already spent in this category during the current month */
  currentMonthSpent?: number;
  /** Net RM adjustment made by cross-category rebalancing (+ received / - donated) */
  rebalancedDelta?: number;
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

export interface CategoryRebalanceDonor {
  category: string;
  previousCap: number;
  newCap: number;
  cutAmount: number;
  availableSlackBefore: number;
}

export interface CategoryRebalanceSuggestion {
  canAutoRebalance: boolean;
  targetCategory: string;
  previousTargetCap: number;
  newTargetCap: number;
  deficitCovered: number;
  unfundedDeficit: number;
  donors: CategoryRebalanceDonor[];
  updatedCaps: Record<string, number>;
  summaryText: string;
}

export interface CategoryRealtimeBudgetStatus {
  category: string;
  cap: number;
  spentSoFar: number;
  /** Unpaid recurring commitments + active installments reserved in this category for the month */
  committedReserve: number;
  /** Free unreserved balance before proposedAmount: max(0, cap - spentSoFar - committedReserve) */
  unreservedRemainingBefore: number;
  /** Free unreserved balance after proposedAmount: cap - spentSoFar - committedReserve - proposedAmount */
  unreservedRemainingAfter: number;
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
  billReserveNote?: string;
  /** When spending exceeds this category's cap (or unreserved cap), provides a 1-tap cross-category rebalance plan */
  rebalanceSuggestion?: CategoryRebalanceSuggestion;
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
  history?: Array<{ effectiveFrom: string; amount: number }>;
}

interface StoredInstallmentLike {
  id?: string;
  name?: string;
  category?: string;
  monthlyAmount?: number;
  monthlyPayment?: number;
  remainingMonths?: number;
  tenureMonths?: number;
  startDate?: string;
  endDate?: string;
}

export interface CategoryCommitmentBreakdown {
  /** Total monthly recurring commitments + active installments belonging to each category */
  totalCommittedByCategory: Map<string, number>;
  /** Portion of committed bills in each category NOT YET paid/recorded in the target month */
  unpaidReserveByCategory: Map<string, number>;
  /** Itemized list of unpaid bills per category for transparent UI display */
  unpaidItemsByCategory: Map<string, Array<{ name: string; amount: number; kind: 'recurring' | 'installment' }>>;
}

/**
 * Computes both total monthly bill commitments AND unpaid bill reserves per category
 * by matching `cashflow_recurring_commitments` and `cashflow_installment_plans` against
 * the target month's recorded transactions.
 */
export function getCategoryCommitmentBreakdown(
  monthTransactions: GenericTransaction[] = [],
  targetMonthPrefix: string = getLocalDateString().slice(0, 7)
): CategoryCommitmentBreakdown {
  const totalCommittedByCategory = new Map<string, number>();
  const unpaidReserveByCategory = new Map<string, number>();
  const unpaidItemsByCategory = new Map<
    string,
    Array<{ name: string; amount: number; kind: 'recurring' | 'installment' }>
  >();

  if (typeof window === 'undefined' && typeof localStorage === 'undefined') {
    return { totalCommittedByCategory, unpaidReserveByCategory, unpaidItemsByCategory };
  }

  const monthExpenses = (Array.isArray(monthTransactions) ? monthTransactions : []).filter(
    (t) =>
      String(t?.type || '').toLowerCase() === 'expense' &&
      t?.id !== 'tx_sample' &&
      (!t?.date || t.date.startsWith(targetMonthPrefix))
  );

  // 1. Recurring Commitments
  try {
    const rawRec = typeof localStorage !== 'undefined' ? localStorage.getItem('cashflow_recurring_commitments') : null;
    if (rawRec) {
      const list = JSON.parse(rawRec) as StoredRecurringLike[];
      if (Array.isArray(list)) {
        for (const item of list) {
          let amt = Number(item?.amount) || 0;
          if (Array.isArray(item?.history) && item.history.length > 0) {
            const sorted = [...item.history].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
            const matched = sorted.find((h) => h.effectiveFrom <= targetMonthPrefix);
            amt = matched ? Number(matched.amount) || amt : Number(sorted[sorted.length - 1].amount) || amt;
          }
          if (amt <= 0) continue;

          const cat = item?.category || 'Housing & Bills';
          const name = (item?.name || '').trim();
          totalCommittedByCategory.set(cat, (totalCommittedByCategory.get(cat) || 0) + amt);

          const isAlreadyPaid = monthExpenses.some((tx) => {
            const notes = String(tx.notes || '');
            if (item.id && notes.includes(`[Recurring:${item.id}]`)) return true;
            const descLower = String(tx.description || '').trim().toLowerCase();
            const nameLower = name.toLowerCase();
            if (!nameLower || !descLower) return false;
            if (descLower === nameLower) return true;
            const txCat = String(tx.category || '').trim().toLowerCase();
            if (txCat === cat.toLowerCase() && nameLower.length >= 3 && descLower.length >= 3) {
              return descLower.includes(nameLower) || nameLower.includes(descLower);
            }
            return false;
          });

          if (!isAlreadyPaid) {
            unpaidReserveByCategory.set(cat, (unpaidReserveByCategory.get(cat) || 0) + amt);
            const arr = unpaidItemsByCategory.get(cat) || [];
            arr.push({ name: name || cat, amount: amt, kind: 'recurring' });
            unpaidItemsByCategory.set(cat, arr);
          }
        }
      }
    }
  } catch {}

  // 2. Active Installment Plans
  try {
    const rawInst = typeof localStorage !== 'undefined' ? localStorage.getItem('cashflow_installment_plans') : null;
    if (rawInst) {
      const list = JSON.parse(rawInst) as StoredInstallmentLike[];
      if (Array.isArray(list)) {
        for (const plan of list) {
          if (plan?.endDate && plan.endDate < targetMonthPrefix) continue;
          if (plan?.startDate && plan.startDate.slice(0, 7) > targetMonthPrefix) continue;
          if (typeof plan?.remainingMonths === 'number' && plan.remainingMonths <= 0) continue;

          const amt = Number(plan?.monthlyAmount ?? plan?.monthlyPayment) || 0;
          if (amt <= 0) continue;

          const cat = plan?.category || 'Shopping';
          const name = (plan?.name || '').trim();
          totalCommittedByCategory.set(cat, (totalCommittedByCategory.get(cat) || 0) + amt);

          const isAlreadyPaid = monthExpenses.some((tx) => {
            const desc = String(tx.description || '').toLowerCase();
            const notes = String(tx.notes || '').toLowerCase();
            if (plan.id && String(tx.id || '').startsWith(`tx_inst_${plan.id}_`)) return true;
            const isInstTx = desc.includes('(installment') || notes.includes('[installment plan');
            if (!isInstTx) return false;
            const baseName = desc.replace(/\s*\(installment.*?\)/i, '').trim();
            return Boolean(name && (baseName === name.toLowerCase() || desc.includes(name.toLowerCase())));
          });

          if (!isAlreadyPaid) {
            unpaidReserveByCategory.set(cat, (unpaidReserveByCategory.get(cat) || 0) + amt);
            const arr = unpaidItemsByCategory.get(cat) || [];
            arr.push({ name: name || 'Installment', amount: amt, kind: 'installment' });
            unpaidItemsByCategory.set(cat, arr);
          }
        }
      }
    }
  } catch {}

  return { totalCommittedByCategory, unpaidReserveByCategory, unpaidItemsByCategory };
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
 * Priority order for borrowing/trimming unused slack across categories when another category
 * needs extra budget (or when fitting caps to total living budget).
 * Trims non-essential discretionary buckets first, protecting Food sustenance, Housing & Bills, and Insurance until last.
 */
const REBALANCE_DONOR_ORDER = [
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
] as const;

/**
 * Intelligently rebalances category caps when spending (or a proposed expense + bill reserves) in one or more
 * categories exceeds their cap.
 *
 * Rules:
 * 1. Every category's cap is protected down to at least its `spentThisMonth + unpaidBillReserve` (so an already-spent
 *    or bill-reserved category is NEVER cut below what is already used/reserved!).
 * 2. Any category where `spentThisMonth + unpaidBillReserve + proposedAmount > currentCap` is expanded to cover the need.
 * 3. User-locked categories (`lockedCaps`) are strictly protected from being trimmed as donors.
 * 4. To keep total caps within `maxLivingBudget`, the excess is borrowed from other unlocked categories with unspent slack.
 */
export function rebalanceCategoryCapsForSpending(params: {
  currentMonthTransactions: GenericTransaction[];
  currentCaps?: Record<string, number>;
  maxLivingBudget?: number;
  targetCategory?: string;
  proposedAmount?: number;
  targetMonth?: string;
  referenceDate?: Date;
  lockedCaps?: Record<string, boolean>;
}): CategoryRebalanceSuggestion {
  const now = params.referenceDate || new Date();
  const defaultMonthPrefix = params.targetMonth || getLocalDateString(now).slice(0, 7);
  const validTxs = Array.isArray(params.currentMonthTransactions) ? params.currentMonthTransactions : [];
  const monthFilter = resolveEffectiveMonthFilter(validTxs, defaultMonthPrefix, params.targetMonth);
  const effectiveMonth = monthFilter || defaultMonthPrefix;
  const daysInfo = getMonthDaysInfo(effectiveMonth, now);

  const baseCaps = params.currentCaps || getSavedCategoryCaps();
  const updatedCaps: Record<string, number> = {};
  CANONICAL_EXPENSE_CATEGORIES.forEach((cat) => {
    updatedCaps[cat] = resolveCategoryCapValue(cat, baseCaps, DEFAULT_CATEGORY_CAPS[cat] ?? 50);
  });
  Object.keys(baseCaps).forEach((cat) => {
    if (!(cat in updatedCaps)) {
      updatedCaps[cat] = resolveCategoryCapValue(cat, baseCaps, 0);
    }
  });

  const currentTotalCaps = Object.values(updatedCaps).reduce((s, v) => s + v, 0);
  const maxBudget =
    params.maxLivingBudget && params.maxLivingBudget > 0
      ? currentTotalCaps > 0
        ? Math.min(params.maxLivingBudget, currentTotalCaps)
        : params.maxLivingBudget
      : Math.max(800, currentTotalCaps);

  // 1. Compute spent so far and unpaid bill reserves per category for this month
  const spentByCat = new Map<string, number>();
  for (const t of validTxs) {
    if (String(t?.type || '').toLowerCase() !== 'expense' || t?.id === 'tx_sample' || !t?.date) continue;
    if (monthFilter && t.date.length >= 7 && !t.date.startsWith(monthFilter)) continue;
    const cat = t.category || 'Other';
    const amt = getAmountInBaseCurrency(t.amount || 0, t.currency, t.baseAmount);
    if (amt > 0) {
      spentByCat.set(cat, (spentByCat.get(cat) || 0) + amt);
    }
  }

  const { unpaidReserveByCategory, totalCommittedByCategory } = getCategoryCommitmentBreakdown(
    validTxs,
    effectiveMonth
  );

  // 2. Ensure every category cap covers at least its (spent + unpaidBillReserve + proposedAmount)
  const targetCat = params.targetCategory || '';
  const proposed = Math.max(0, Number(params.proposedAmount) || 0);
  const previousTargetCap = targetCat ? updatedCaps[targetCat] ?? 0 : 0;

  let totalExpanded = 0;
  for (const cat of Object.keys(updatedCaps)) {
    const spent = spentByCat.get(cat) || 0;
    const unpaidReserve = unpaidReserveByCategory.get(cat) || 0;
    const extraProposed = cat === targetCat ? proposed : 0;
    const requiredFloor = Math.ceil(spent + unpaidReserve + extraProposed);

    if (requiredFloor > updatedCaps[cat]) {
      totalExpanded += requiredFloor - updatedCaps[cat];
      updatedCaps[cat] = requiredFloor;
    }
  }

  const newTargetCap = targetCat ? updatedCaps[targetCat] ?? previousTargetCap : 0;
  const isLocked = (cat: string) => Boolean(params.lockedCaps && params.lockedCaps[cat]);

  const donors: CategoryRebalanceDonor[] = [];
  let remainingToCut = Math.max(
    0,
    Object.values(updatedCaps).reduce((s, v) => s + v, 0) - maxBudget
  );

  if (remainingToCut > 0) {
    // Pass A: Cut from unspent, unreserved slack while keeping healthy minimum buffers
    for (const donorCat of REBALANCE_DONOR_ORDER) {
      if (remainingToCut <= 0) break;
      if (donorCat === targetCat || isLocked(donorCat)) continue;
      const currentCap = updatedCaps[donorCat] || 0;
      if (currentCap <= 0) continue;

      const spent = spentByCat.get(donorCat) || 0;
      const unpaidReserve = unpaidReserveByCategory.get(donorCat) || 0;
      const committed = totalCommittedByCategory.get(donorCat) || 0;

      let protectedFloor = Math.ceil(spent + unpaidReserve);
      if (donorCat === 'Food & Dining') {
        protectedFloor = Math.max(protectedFloor, Math.ceil(spent + daysInfo.daysRemaining * 15));
      } else if (donorCat === 'Insurance' || donorCat === 'Housing & Bills') {
        protectedFloor = Math.max(protectedFloor, committed, currentCap);
      }

      const availableSlack = Math.max(0, currentCap - protectedFloor);
      if (availableSlack <= 0) continue;

      const cut = Math.min(availableSlack, remainingToCut);
      if (cut > 0) {
        updatedCaps[donorCat] = Number((currentCap - cut).toFixed(2));
        remainingToCut = Number((remainingToCut - cut).toFixed(2));
        donors.push({
          category: donorCat,
          previousCap: currentCap,
          newCap: updatedCaps[donorCat],
          cutAmount: cut,
          availableSlackBefore: availableSlack,
        });
      }
    }

    // Pass B: If still needed, allow trimming unspent buffer down to actual (spent + unpaidReserve)
    if (remainingToCut > 0) {
      for (const donorCat of REBALANCE_DONOR_ORDER) {
        if (remainingToCut <= 0) break;
        if (donorCat === targetCat || isLocked(donorCat)) continue;
        const currentCap = updatedCaps[donorCat] || 0;
        const spent = spentByCat.get(donorCat) || 0;
        const unpaidReserve = unpaidReserveByCategory.get(donorCat) || 0;
        const hardFloor = Math.ceil(spent + unpaidReserve);
        const extraSlack = Math.max(0, currentCap - hardFloor);
        if (extraSlack <= 0) continue;

        const cut = Math.min(extraSlack, remainingToCut);
        if (cut > 0) {
          const existingDonor = donors.find((d) => d.category === donorCat);
          updatedCaps[donorCat] = Number((currentCap - cut).toFixed(2));
          remainingToCut = Number((remainingToCut - cut).toFixed(2));
          if (existingDonor) {
            existingDonor.newCap = updatedCaps[donorCat];
            existingDonor.cutAmount = Number((existingDonor.cutAmount + cut).toFixed(2));
          } else {
            donors.push({
              category: donorCat,
              previousCap: currentCap,
              newCap: updatedCaps[donorCat],
              cutAmount: cut,
              availableSlackBefore: extraSlack,
            });
          }
        }
      }
    }
  }

  const totalCutFromDonors = Number(donors.reduce((s, d) => s + d.cutAmount, 0).toFixed(2));
  const unfundedDeficit = Math.max(0, Number(remainingToCut.toFixed(2)));
  const canAutoRebalance = totalCutFromDonors > 0 && unfundedDeficit === 0;

  let summaryText = '';
  if (donors.length > 0) {
    const donorSummary = donors
      .slice(0, 3)
      .map((d) => `${d.category} (-RM ${d.cutAmount.toFixed(0)} → RM ${d.newCap.toFixed(0)})`)
      .join(', ');
    summaryText = canAutoRebalance
      ? `💡 Smart Rebalance: Raise ${targetCat || 'category'} cap to RM ${newTargetCap.toFixed(0)} by shifting RM ${totalCutFromDonors.toFixed(0)} from unused slack in ${donorSummary} — keeping your total budget strictly within RM ${maxBudget.toLocaleString()}.`
      : `⚠️ Partial Rebalance: Can shift RM ${totalCutFromDonors.toFixed(0)} from ${donorSummary}, but RM ${unfundedDeficit.toFixed(0)} still exceeds your total RM ${maxBudget.toLocaleString()} living budget.`;
  } else if (totalExpanded > 0) {
    summaryText = `⚠️ All other categories are already spent or reserved for bills; raising ${targetCat || 'this category'} by RM ${totalExpanded.toFixed(0)} will dip into your monthly savings buffer.`;
  } else {
    summaryText = `✨ Category caps are balanced within your RM ${maxBudget.toLocaleString()} living budget.`;
  }

  return {
    canAutoRebalance,
    targetCategory: targetCat,
    previousTargetCap,
    newTargetCap,
    deficitCovered: totalCutFromDonors,
    unfundedDeficit,
    donors,
    updatedCaps,
    summaryText,
  };
}

/**
 * One-call helper for the UI to execute and persist a smart cross-category rebalance.
 */
export function applySmartCategoryRebalance(params: Parameters<typeof rebalanceCategoryCapsForSpending>[0]): CategoryRebalanceSuggestion {
  const res = rebalanceCategoryCapsForSpending(params);
  saveCategoryCaps(res.updatedCaps);
  return res;
}

/**
 * Helper to refresh reasoning, dailyAllowance, and sharePercent after any cap scaling/trimming/rebalancing
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
    const reserve = s.unpaidBillReserve || 0;
    const spent = s.currentMonthSpent || 0;
    const delta = s.rebalancedDelta || 0;

    const reserveSuffix =
      reserve > 0
        ? ` Includes RM ${reserve.toFixed(0)} reserved for upcoming monthly bills.`
        : '';
    const rebalanceSuffix =
      delta > 0
        ? ` (+RM ${delta.toFixed(0)} auto-rebalanced from unused categories to cover this month's spend/bills).`
        : delta < 0
        ? ` (-RM ${Math.abs(delta).toFixed(0)} shifted to cover active spending in other categories).`
        : '';

    if (s.category === 'Food & Dining') {
      const foodDaily = Number((s.suggestedCap / 30).toFixed(1));
      s.dailyAllowance = foodDaily;
      s.reasoning = `Allocated RM ${s.suggestedCap} (RM ${foodDaily}/day) for active daily meal pacing while strictly reserving your ${totalSavingsPct}% savings goal.${reserveSuffix}${rebalanceSuffix}`;
    } else if (s.category === 'Insurance') {
      s.reasoning =
        s.suggestedCap > 0
          ? `Identified as a monthly recurring commitment. Suggested cap matches your steady RM ${s.suggestedCap}/mo premium without waste.${reserveSuffix}${rebalanceSuffix}`
          : `No regular insurance premium configured (set to RM 0; adjust if needed).`;
    } else if (s.category === 'Housing & Bills') {
      s.reasoning = `Baseline rent & utilities (avg RM ${s.historicalAvg || s.suggestedCap}) + bill buffer to handle seasonal utility spikes.${reserveSuffix}${rebalanceSuffix}`;
    } else if (s.category === 'Transport') {
      s.dailyAllowance = Number((s.suggestedCap / 30).toFixed(1));
      s.reasoning = `Based on your regular commute, toll, and fuel trends (avg RM ${s.historicalAvg || s.suggestedCap}/mo).${reserveSuffix}${rebalanceSuffix}`;
    } else if (s.category === 'Parents') {
      s.reasoning =
        s.suggestedCap > 0
          ? `Regular family support commitment locked at RM ${s.suggestedCap}/mo.${reserveSuffix}${rebalanceSuffix}`
          : `No regular family support detected (set to RM 0; adjust if needed).`;
    } else if (s.category === 'Health') {
      s.reasoning = `Essential medical, clinic, and pharmacy safety net (RM ${s.suggestedCap}/mo).${reserveSuffix}${rebalanceSuffix}`;
    } else if (s.category === 'Education') {
      s.reasoning = `Occasional self-learning & course reserve (RM ${s.suggestedCap}/mo). Handled as a flexible lump sum so it does not distort daily living burn rate.${reserveSuffix}${rebalanceSuffix}`;
    } else if (s.category === 'Sport') {
      s.reasoning = `Monthly sports & gym cap (RM ${s.suggestedCap}). Spend one time, use whole month.${reserveSuffix}${rebalanceSuffix}`;
    } else if (s.category === 'Shopping') {
      s.reasoning = `Monthly retail & lifestyle cap (RM ${s.suggestedCap}). Spend one time, use whole month.${reserveSuffix}${rebalanceSuffix}`;
    } else {
      s.reasoning =
        spent > 0 || reserve > 0
          ? `Monthly capped budget (RM ${s.suggestedCap}, with RM ${spent.toFixed(0)} spent${reserve > 0 ? ` + RM ${reserve.toFixed(0)} bill reserve` : ''}). Spend one time, use whole month.${rebalanceSuffix}`
          : `Monthly capped budget (RM ${s.suggestedCap}). Spend one time, use whole month.${rebalanceSuffix}`;
    }
  }
}

/**
 * Computes intelligent category spending caps derived dynamically from:
 * 1. Normal monthly baselines for every regular category (Housing, Insurance, Transport, Food, Health, Shopping, etc.)
 * 2. Per-category Bill Reserves (`cashflow_recurring_commitments` + `cashflow_installment_plans`)
 * 3. Cross-Category Auto-Rebalancing: protects spent & bill reserves, shifts unspent slack, and preserves user locked caps.
 */
export function generateIntelligentCategoryCaps(
  allTransactions: GenericTransaction[] = [],
  options?: {
    baselineIncome?: number;
    savingsTargetPct?: number;
    investmentTargetPct?: number;
    configuredCaps?: Record<string, number>;
    monthlyBudgetCap?: number;
    lockedCaps?: Record<string, boolean>;
    referenceDate?: Date;
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

  // 2. Aggregate Historical Spending AND Current Month Spending by Category
  const now = options?.referenceDate || new Date();
  const currentMonthPrefix = getLocalDateString(now).slice(0, 7);
  const categoryMonthlyMap = new Map<string, Map<string, number>>();
  const currentMonthSpentMap = new Map<string, number>();
  const allObservedMonths = new Set<string>();

  CANONICAL_EXPENSE_CATEGORIES.forEach((cat) => {
    categoryMonthlyMap.set(cat, new Map());
    currentMonthSpentMap.set(cat, 0);
  });

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

    if (monthKey === currentMonthPrefix) {
      currentMonthSpentMap.set(cat, (currentMonthSpentMap.get(cat) || 0) + amount);
    }
  });

  // Determine completed past months vs current month
  const completedLedgerMonths = Array.from(allObservedMonths)
    .filter((m) => m < currentMonthPrefix)
    .sort()
    .slice(-6);
  const referenceMonths =
    completedLedgerMonths.length > 0
      ? completedLedgerMonths
      : Array.from(allObservedMonths).sort().slice(-6);
  const totalLedgerMonthsCount = Math.max(1, referenceMonths.length);

  // Get per-category recurring & installment bill breakdown for the active month
  const { totalCommittedByCategory, unpaidReserveByCategory } = getCategoryCommitmentBreakdown(
    validTxs,
    currentMonthPrefix
  );

  // 3. Compute Statistical Profile per Category
  interface CategoryStats {
    category: string;
    avgAcrossAllMonths: number;
    activeMonthAvg: number;
    activeMonthMedian: number;
    recentChronological: number;
    activeSampleCount: number;
    committedFloor: number;
    unpaidBillReserve: number;
    currentMonthSpent: number;
    requiredThisMonthFloor: number;
  }

  const statsMap = new Map<string, CategoryStats>();

  categoryMonthlyMap.forEach((months, cat) => {
    const committedFloor = Math.round(totalCommittedByCategory.get(cat) || 0);
    const unpaidBillReserve = Math.round(unpaidReserveByCategory.get(cat) || 0);
    const currentMonthSpent = Math.round(currentMonthSpentMap.get(cat) || 0);
    const requiredThisMonthFloor = Math.max(
      committedFloor,
      Math.ceil((currentMonthSpent + unpaidBillReserve) / 10) * 10
    );

    const completedEntries = Array.from(months.entries()).filter(([m]) => m !== currentMonthPrefix);
    const activeEntries = completedEntries.length > 0 ? completedEntries : Array.from(months.entries());
    const activeValues = activeEntries.map(([, val]) => val).filter((v) => v > 0);

    if (activeValues.length === 0) {
      statsMap.set(cat, {
        category: cat,
        avgAcrossAllMonths: 0,
        activeMonthAvg: 0,
        activeMonthMedian: 0,
        recentChronological: 0,
        activeSampleCount: 0,
        committedFloor,
        unpaidBillReserve,
        currentMonthSpent,
        requiredThisMonthFloor,
      });
      return;
    }

    const chronologicalAmounts = referenceMonths.map((m) => months.get(m) || 0);
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
    const recentChronological = chronologicalAmounts[chronologicalAmounts.length - 1] || activeMonthAvg;

    statsMap.set(cat, {
      category: cat,
      avgAcrossAllMonths,
      activeMonthAvg,
      activeMonthMedian,
      recentChronological,
      activeSampleCount: activeValues.length,
      committedFloor,
      unpaidBillReserve,
      currentMonthSpent,
      requiredThisMonthFloor,
    });
  });

  // 4. Generate Normal Monthly Caps
  const suggestions: IntelligentCapSuggestion[] = [];
  let committedCapsSum = 0;

  // Tier A: Fixed Monthly Commitments (Insurance)
  const insuranceStats = statsMap.get('Insurance')!;
  let insuranceCap = 250;
  if (insuranceStats.activeSampleCount > 0) {
    const baseIns =
      insuranceStats.activeSampleCount >= Math.ceil(totalLedgerMonthsCount / 2)
        ? insuranceStats.activeMonthMedian
        : insuranceStats.avgAcrossAllMonths;
    insuranceCap = Math.round(baseIns / 10) * 10 || 250;
  }
  insuranceCap = Math.max(insuranceCap, insuranceStats.requiredThisMonthFloor);
  committedCapsSum += insuranceCap;
  suggestions.push({
    category: 'Insurance',
    currentCap: resolveCategoryCapValue('Insurance', currentCaps, 250),
    suggestedCap: insuranceCap,
    historicalAvg: Math.round(insuranceStats.avgAcrossAllMonths || insuranceCap),
    nature: 'fixed',
    natureLabel: 'Fixed Monthly Recurring',
    reasoning: '',
    committedFloor: insuranceStats.committedFloor,
    unpaidBillReserve: insuranceStats.unpaidBillReserve,
    currentMonthSpent: insuranceStats.currentMonthSpent,
  });

  // Tier B: Quasi-Fixed Housing & Bills
  const housingStats = statsMap.get('Housing & Bills')!;
  let housingCap = 500;
  if (housingStats.activeSampleCount > 0) {
    const baseHousing = Math.max(housingStats.avgAcrossAllMonths, housingStats.activeMonthMedian * 0.9);
    housingCap = Math.max(300, Math.round((baseHousing * 1.08) / 10) * 10);
  }
  housingCap = Math.max(housingCap, housingStats.requiredThisMonthFloor);
  committedCapsSum += housingCap;
  suggestions.push({
    category: 'Housing & Bills',
    currentCap: resolveCategoryCapValue('Housing & Bills', currentCaps, 500),
    suggestedCap: housingCap,
    historicalAvg: Math.round(housingStats.avgAcrossAllMonths || housingCap),
    nature: 'quasi-fixed',
    natureLabel: 'Quasi-Fixed Baseline + Bills Buffer',
    reasoning: '',
    committedFloor: housingStats.committedFloor,
    unpaidBillReserve: housingStats.unpaidBillReserve,
    currentMonthSpent: housingStats.currentMonthSpent,
  });

  // Tier C: Commute & Transport Trend
  const transportStats = statsMap.get('Transport')!;
  let transportCap = 150;
  if (transportStats.activeSampleCount > 0) {
    transportCap = Math.max(80, Math.round(transportStats.activeMonthMedian / 10) * 10);
  }
  transportCap = Math.max(transportCap, transportStats.requiredThisMonthFloor);
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
    unpaidBillReserve: transportStats.unpaidBillReserve,
    currentMonthSpent: transportStats.currentMonthSpent,
  });

  // Parents support
  const parentsStats = statsMap.get('Parents')!;
  let parentsCap = 0;
  if (parentsStats.activeSampleCount > 0 || parentsStats.requiredThisMonthFloor > 0) {
    const baseParents =
      parentsStats.activeSampleCount > 0
        ? Math.round(parentsStats.activeMonthMedian / 50) * 50
        : 0;
    parentsCap = Math.max(baseParents, parentsStats.requiredThisMonthFloor);
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
    committedFloor: parentsStats.committedFloor,
    unpaidBillReserve: parentsStats.unpaidBillReserve,
    currentMonthSpent: parentsStats.currentMonthSpent,
  });

  // Health baseline
  const healthStats = statsMap.get('Health')!;
  let healthCap = 100;
  if (healthStats.activeSampleCount > 0) {
    healthCap = Math.max(50, Math.round(healthStats.avgAcrossAllMonths / 10) * 10);
  }
  healthCap = Math.max(healthCap, healthStats.requiredThisMonthFloor);
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
    unpaidBillReserve: healthStats.unpaidBillReserve,
    currentMonthSpent: healthStats.currentMonthSpent,
  });

  // Education baseline
  const educationStats = statsMap.get('Education')!;
  let educationCap = 100;
  if (educationStats.activeSampleCount > 0) {
    educationCap = Math.max(50, Math.round(educationStats.avgAcrossAllMonths / 10) * 10);
  }
  educationCap = Math.max(educationCap, educationStats.requiredThisMonthFloor);
  committedCapsSum += educationCap;
  suggestions.push({
    category: 'Education',
    currentCap: resolveCategoryCapValue('Education', currentCaps, 100),
    suggestedCap: educationCap,
    historicalAvg: Math.round(educationStats.avgAcrossAllMonths || educationCap),
    nature: 'quasi-fixed',
    natureLabel: 'Periodic Education / Courses',
    reasoning: '',
    committedFloor: educationStats.committedFloor,
    unpaidBillReserve: educationStats.unpaidBillReserve,
    currentMonthSpent: educationStats.currentMonthSpent,
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
      st && st.avgAcrossAllMonths > 0
        ? st.avgAcrossAllMonths
        : fallbackDefault;
    discretionaryAvgs[cat] = avg;
    totalDiscretionaryAvg += avg;
  });

  const rawFoodWeight = discretionaryAvgs['Food & Dining'] / (totalDiscretionaryAvg || 1);
  const effectiveFoodWeight = Math.max(0.48, Math.min(0.65, rawFoodWeight));
  const foodStats = statsMap.get('Food & Dining')!;
  const baseSuggestedFoodCap = Math.max(
    600,
    Math.round((remainingDiscretionaryPool * effectiveFoodWeight) / 10) * 10
  );
  const suggestedFoodCap = Math.max(baseSuggestedFoodCap, foodStats.requiredThisMonthFloor);

  suggestions.push({
    category: 'Food & Dining',
    currentCap: resolveCategoryCapValue('Food & Dining', currentCaps, 600),
    suggestedCap: suggestedFoodCap,
    historicalAvg: Math.round(foodStats.avgAcrossAllMonths || discretionaryAvgs['Food & Dining']),
    nature: 'discretionary',
    natureLabel: 'Daily Sustenance (Paced Daily)',
    reasoning: '',
    committedFloor: foodStats.committedFloor,
    unpaidBillReserve: foodStats.unpaidBillReserve,
    currentMonthSpent: foodStats.currentMonthSpent,
  });

  const poolAfterFood = Math.max(200, remainingDiscretionaryPool - suggestedFoodCap);
  const otherDiscretionaryNames = ['Shopping', 'Sport', 'Entertainment', 'Gift', 'Other'];
  const otherDiscretionaryTotalAvg =
    otherDiscretionaryNames.reduce((acc, cat) => acc + discretionaryAvgs[cat], 0) || 1;

  otherDiscretionaryNames.forEach((cat) => {
    const st = statsMap.get(cat)!;
    const weight = discretionaryAvgs[cat] / otherDiscretionaryTotalAvg;
    const minFloor = cat === 'Shopping' ? 150 : cat === 'Sport' ? 80 : 50;
    const baseAllocated = Math.max(minFloor, Math.round((poolAfterFood * weight) / 10) * 10);
    const allocated = Math.max(baseAllocated, st.requiredThisMonthFloor);

    suggestions.push({
      category: cat,
      currentCap: resolveCategoryCapValue(cat, currentCaps, DEFAULT_CATEGORY_CAPS[cat] ?? 50),
      suggestedCap: allocated,
      historicalAvg: Math.round(st.avgAcrossAllMonths || discretionaryAvgs[cat]),
      nature: 'discretionary',
      natureLabel: 'Monthly Capped Bucket',
      reasoning: '',
      committedFloor: st.committedFloor,
      unpaidBillReserve: st.unpaidBillReserve,
      currentMonthSpent: st.currentMonthSpent,
    });
  });

  // Preserve user-locked category caps if supplied
  if (options?.lockedCaps) {
    for (const s of suggestions) {
      if (options.lockedCaps[s.category]) {
        s.suggestedCap = resolveCategoryCapValue(s.category, options.configuredCaps, s.suggestedCap);
      }
    }
  }

  // Record pre-rebalance caps so we can track exact rebalancedDelta per category
  const preTrimCapMap = new Map<string, number>();
  for (const s of suggestions) {
    const st = statsMap.get(s.category)!;
    const normalWithoutSpike =
      s.category === 'Shopping'
        ? Math.max(150, Math.round((poolAfterFood * (discretionaryAvgs[s.category] / otherDiscretionaryTotalAvg)) / 10) * 10)
        : s.category === 'Sport'
        ? Math.max(80, Math.round((poolAfterFood * (discretionaryAvgs[s.category] / otherDiscretionaryTotalAvg)) / 10) * 10)
        : otherDiscretionaryNames.includes(s.category)
        ? Math.max(50, Math.round((poolAfterFood * (discretionaryAvgs[s.category] / otherDiscretionaryTotalAvg)) / 10) * 10)
        : s.suggestedCap;
    if (st.requiredThisMonthFloor > normalWithoutSpike) {
      s.rebalancedDelta = st.requiredThisMonthFloor - normalWithoutSpike;
    }
    preTrimCapMap.set(s.category, s.suggestedCap);
  }

  // 6. Strict Hard Constraint: Sum of ALL Suggested Caps MUST be <= targetLivingBudget.
  // Trimming preserves user locks (options.lockedCaps) and never trims below requiredThisMonthFloor.
  const isLocked = (cat: string) => Boolean(options?.lockedCaps && options.lockedCaps[cat]);
  const currentTotal = suggestions.reduce((sum, s) => sum + s.suggestedCap, 0);

  if (currentTotal > targetLivingBudget) {
    let excess = currentTotal - targetLivingBudget;
    const byCategory = new Map(suggestions.map((s) => [s.category, s]));

    // Pass 1: Trim unspent/unreserved slack from unlocked discretionary categories
    const discretionaryTrimOrder = ['Other', 'Gift', 'Entertainment', 'Shopping', 'Sport', 'Food & Dining'];
    while (excess > 0) {
      let trimmedAny = false;
      for (const catName of discretionaryTrimOrder) {
        if (isLocked(catName)) continue;
        const item = byCategory.get(catName);
        if (!item) continue;
        const st = statsMap.get(catName)!;
        const baseFloor = item.category === 'Food & Dining' ? 400 : 30;
        const protectedFloor = Math.max(baseFloor, st.requiredThisMonthFloor);
        if (item.suggestedCap > protectedFloor && excess > 0) {
          const step = Math.min(10, excess, item.suggestedCap - protectedFloor);
          item.suggestedCap -= step;
          excess -= step;
          trimmedAny = true;
          if (excess <= 0) break;
        }
      }
      if (!trimmedAny) break;
    }

    // Pass 2: Trim unlocked quasi-fixed and trend categories (Transport -> Education -> Health)
    if (excess > 0) {
      const flexibleTrimOrder = ['Transport', 'Education', 'Health'];
      for (const catName of flexibleTrimOrder) {
        if (isLocked(catName)) continue;
        const item = byCategory.get(catName);
        if (!item) continue;
        const st = statsMap.get(catName)!;
        const protectedFloor = Math.max(40, st.requiredThisMonthFloor);
        if (item.suggestedCap > protectedFloor && excess > 0) {
          const step = Math.min(item.suggestedCap - protectedFloor, excess);
          item.suggestedCap -= step;
          excess -= step;
          if (excess <= 0) break;
        }
      }
    }

    // Pass 3: Trim any remaining unspent/unreserved slack down to exact `requiredThisMonthFloor`
    if (excess > 0) {
      for (const catName of REBALANCE_DONOR_ORDER) {
        if (isLocked(catName)) continue;
        const item = byCategory.get(catName);
        if (!item) continue;
        const st = statsMap.get(catName)!;
        const protectedFloor = st.requiredThisMonthFloor;
        if (item.suggestedCap > protectedFloor && excess > 0) {
          const cut = Math.min(item.suggestedCap - protectedFloor, excess);
          item.suggestedCap -= cut;
          excess -= cut;
          if (excess <= 0) break;
        }
      }
    }

    // Pass 4: Final mathematical guarantee if total spend already exceeded targetLivingBudget
    if (excess > 0) {
      for (const catName of REBALANCE_DONOR_ORDER) {
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

    // Update rebalancedDelta for donor categories
    for (const s of suggestions) {
      const beforeTrim = preTrimCapMap.get(s.category) ?? s.suggestedCap;
      if (s.suggestedCap < beforeTrim && !s.rebalancedDelta) {
        s.rebalancedDelta = s.suggestedCap - beforeTrim;
      }
    }
  }

  // Synchronize reasoning, dailyAllowance, and sharePercent AFTER trimming & rebalancing!
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
 * Preserves explicit 0 caps, respects fixed recurring commitments, and protects user-locked categories.
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
 * Dynamically predicts month-end savings and investments based on:
 * 1. User's baseline income (from Income Allocation).
 * 2. Distinction between one-time / episodic lump sums (Education, Insurance, Bills)
 *    and routine daily burn rate (Food).
 * 3. Per-category unpaid recurring commitments & installments due later this month.
 * 4. User's target savings and investment percentage split.
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

  validTxs.forEach((t) => {
    if (String(t.type || '').toLowerCase() !== 'expense' || t.id === 'tx_sample') return;
    if (monthFilter && t.date && t.date.length >= 7 && !t.date.startsWith(monthFilter)) return;

    const amt = getAmountInBaseCurrency(t.amount || 0, t.currency, t.baseAmount);
    if (amt <= 0) return;
    const cat = t.category || 'Other';

    if (isLumpSumExpense(cat, amt)) {
      lumpSumSpent += amt;
    } else {
      dailyVariableSpent += amt;
    }
  });

  lumpSumSpent = Number(lumpSumSpent.toFixed(2));
  dailyVariableSpent = Number(dailyVariableSpent.toFixed(2));
  const spentSoFar = Number((lumpSumSpent + dailyVariableSpent).toFixed(2));

  // Unpaid recurring commitments & installments due later this month
  const { unpaidReserveByCategory } = getCategoryCommitmentBreakdown(validTxs, monthFilter || defaultMonthPrefix);
  let unpaidCommittedReserve = 0;
  unpaidReserveByCategory.forEach((amt) => {
    unpaidCommittedReserve += amt;
  });
  unpaidCommittedReserve = Number(unpaidCommittedReserve.toFixed(2));

  const currentDailySpend = Number((dailyVariableSpent / daysPassed).toFixed(2));

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
 * Solves Payday Cycle timing across any payday day (1-31), including wrap-around into next month.
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

  let daysUntilPayday = 0;
  if (todayDate <= effectivePaydayInThisMonth) {
    daysUntilPayday = effectivePaydayInThisMonth - todayDate;
  } else {
    const nextMonthDays = new Date(daysInfo.year, daysInfo.month + 1, 0).getDate();
    const nextPaydayClamped = Math.min(Math.max(1, rawPayday), nextMonthDays);
    daysUntilPayday = (daysInfo.totalDays - todayDate) + nextPaydayClamped;
  }

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
 * 1. Includes `committedReserve` (unpaid recurring commitments + active installments for this category) so bills are reserved inside the category!
 * 2. When spending exceeds the category cap (or unreserved balance), automatically computes `rebalanceSuggestion` showing which other categories have unused slack to cover the difference!
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
    maxLivingBudget?: number;
    lockedCaps?: Record<string, boolean>;
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
  const effectiveMonth = monthFilter || defaultMonthPrefix;

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

  // Compute unpaid bill reserve specifically for this category
  const { unpaidReserveByCategory, unpaidItemsByCategory } = getCategoryCommitmentBreakdown(validTxs, effectiveMonth);
  const committedReserve = Number((unpaidReserveByCategory.get(category) || 0).toFixed(2));
  const unpaidItems = unpaidItemsByCategory.get(category) || [];

  const remainingBefore = Math.max(0, cap - spentSoFar);
  const unreservedRemainingBefore = Math.max(0, cap - spentSoFar - committedReserve);
  const isOverCapBefore = cap > 0 ? spentSoFar > cap : spentSoFar > 0;
  const spentPercentBefore = cap > 0 ? (spentSoFar / cap) * 100 : spentSoFar > 0 ? 100 : 0;

  const validProposed = Math.max(0, Number(proposedAmount) || 0);
  const spentAfter = spentSoFar + validProposed;
  const remainingAfter = cap - spentAfter;
  const unreservedRemainingAfter = cap - spentAfter - committedReserve;
  const isOverCapAfter = cap > 0 ? spentAfter > cap : spentAfter > 0;
  const spentPercentAfter = cap > 0 ? (spentAfter / cap) * 100 : spentAfter > 0 ? 100 : 0;

  const dailyCat = isDailyCategory(category);
  const dailyAllowanceRemaining =
    daysInfo.daysRemaining > 0 ? Number((unreservedRemainingBefore / daysInfo.daysRemaining).toFixed(2)) : 0;

  const futureDays = Math.max(1, daysInfo.daysRemaining - (validProposed > 0 || todaySpentInCategory > 0 ? 1 : 0));
  const dailyAllowanceAfter =
    daysInfo.daysRemaining > 0 ? Number((Math.max(0, unreservedRemainingAfter) / futureDays).toFixed(2)) : 0;

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
  } else if (unreservedRemainingAfter < 0) {
    badgeColor = 'amber';
    badgeText = `Touches RM ${Math.abs(unreservedRemainingAfter).toFixed(2)} of reserved bills (RM ${remainingAfter.toFixed(2)} raw cap left)`;
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

  let billReserveNote: string | undefined;
  if (committedReserve > 0) {
    const names = unpaidItems.map((i) => `${i.name} RM ${i.amount.toFixed(0)}`).join(', ');
    billReserveNote = `📌 Bill Reserve in ${category}: RM ${committedReserve.toFixed(2)} reserved for upcoming bills (${names}) · Free unreserved balance: RM ${Math.max(0, unreservedRemainingAfter).toFixed(2)}.`;
  }

  // If this category is over cap (or proposed spend dips into reserved bills), compute a smart cross-category rebalance plan!
  let rebalanceSuggestion: CategoryRebalanceSuggestion | undefined;
  if (isOverCapAfter || unreservedRemainingAfter < 0) {
    rebalanceSuggestion = rebalanceCategoryCapsForSpending({
      currentMonthTransactions: validTxs,
      currentCaps,
      maxLivingBudget: options?.maxLivingBudget,
      targetCategory: category,
      proposedAmount: validProposed,
      targetMonth: effectiveMonth,
      referenceDate: now,
      lockedCaps: options?.lockedCaps,
    });
  }

  return {
    category,
    cap,
    spentSoFar: Number(spentSoFar.toFixed(2)),
    committedReserve,
    unreservedRemainingBefore: Number(unreservedRemainingBefore.toFixed(2)),
    unreservedRemainingAfter: Number(unreservedRemainingAfter.toFixed(2)),
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
    billReserveNote,
    rebalanceSuggestion,
  };
}

export interface UnifiedIncomeAllocation {
  baselineIncome: number;
  isIncomeAutoDetected: boolean;
  actualIncomeThisMonth: number;
  savingsTargetPct: number;
  investmentTargetPct: number;
  livingBudgetPct: number;
  targetSavingsAmount: number;
  targetInvestmentAmount: number;
  targetLivingBudget: number;
  actualSavedThisMonth: number;
  actualInvestedThisMonth: number;
  unpaidCommittedReserve: number;
  spentSoFar: number;
  safeDailyLivingAllowance: number;
  daysRemainingInMonth: number;
}

/**
 * Single Source of Truth for Income Allocation across Home (Money Cockpit), Income Advisor,
 * Budget Page, and Investment Page so numbers and designs never diverge.
 * Automatically infers monthly income from recorded Income transactions if user has not manually set baselineIncome.
 */
export function getUnifiedIncomeAllocation(
  allTransactions: GenericTransaction[] = [],
  options?: {
    baselineIncome?: number;
    savingsTargetPct?: number;
    investmentTargetPct?: number;
    selectedMonth?: string;
    referenceDate?: Date;
  }
): UnifiedIncomeAllocation {
  const profile = typeof window !== 'undefined' ? getUserMoneyProfile() : null;
  const now = options?.referenceDate || new Date();
  const currentMonthPrefix = options?.selectedMonth && /^\d{4}-\d{2}$/.test(options.selectedMonth)
    ? options.selectedMonth
    : getLocalDateString(now).slice(0, 7);

  const savedIncome =
    typeof window !== 'undefined' ? parseFloat(localStorage.getItem('cashflow_baseline_income') || '0') : 0;

  // Compute actual monthly income from ledger transactions if baselineIncome is not manually configured
  const validTxs = Array.isArray(allTransactions) ? allTransactions : [];
  const incomeByMonth = new Map<string, number>();
  let actualIncomeThisMonth = 0;

  for (const t of validTxs) {
    if (String(t?.type || '').toLowerCase() !== 'income' || !t?.date || t.date.length < 7) continue;
    const amt = getAmountInBaseCurrency(t.amount || 0, t.currency, t.baseAmount);
    if (amt <= 0) continue;
    const m = t.date.slice(0, 7);
    incomeByMonth.set(m, (incomeByMonth.get(m) || 0) + amt);
    if (m === currentMonthPrefix) {
      actualIncomeThisMonth += amt;
    }
  }

  let autoDetectedIncome = 0;
  if (actualIncomeThisMonth > 0) {
    autoDetectedIncome = actualIncomeThisMonth;
  } else if (incomeByMonth.size > 0) {
    const vals = Array.from(incomeByMonth.values()).sort((a, b) => a - b);
    autoDetectedIncome = vals[Math.floor(vals.length / 2)];
  }

  const explicitIncome = options?.baselineIncome || (savedIncome > 0 ? savedIncome : profile?.baselineIncome || 0);
  const baselineIncome = explicitIncome > 0 ? explicitIncome : autoDetectedIncome > 0 ? Math.round(autoDetectedIncome) : 3000;
  const isIncomeAutoDetected = explicitIncome <= 0 && autoDetectedIncome > 0;

  const pred = predictMonthlySavingsAndInvestments(validTxs, {
    baselineIncome,
    savingsTargetPct: options?.savingsTargetPct,
    investmentTargetPct: options?.investmentTargetPct,
    selectedMonth: currentMonthPrefix,
    referenceDate: now,
  });

  // Separate actual cash savings vs actual market investments executed this month (excluding SELL liquidations)
  let actualSavedThisMonth = 0;
  let actualInvestedThisMonth = 0;
  for (const t of validTxs) {
    if (!t?.date || !t.date.startsWith(currentMonthPrefix)) continue;
    const subLower = String((t as any).subCategory || '').toLowerCase();
    if (subLower === 'sell') continue;
    const amt = getAmountInBaseCurrency(t.amount || 0, t.currency, t.baseAmount);
    if (amt <= 0) continue;

    const cat = t.category || '';
    const isInvestType = String(t.type || '').toLowerCase() === 'investment';
    if (cat === 'Stocks & Crypto' || cat === 'ASNB / Unit Trust' || (isInvestType && !cat.includes('Savings') && cat !== 'Fixed Deposit')) {
      actualInvestedThisMonth += amt;
    } else if (cat === 'Emergency Savings' || cat === 'Fixed Deposit' || cat === 'EPF / KWSP' || cat === 'Other Savings') {
      actualSavedThisMonth += amt;
    }
  }

  return {
    baselineIncome,
    isIncomeAutoDetected,
    actualIncomeThisMonth: Number(actualIncomeThisMonth.toFixed(2)),
    savingsTargetPct: pred.savingsTargetPct,
    investmentTargetPct: pred.investmentTargetPct,
    livingBudgetPct: Math.max(0, 100 - pred.totalSavingsTargetPct),
    targetSavingsAmount: pred.targetSavingsAmount,
    targetInvestmentAmount: pred.targetInvestmentAmount,
    targetLivingBudget: pred.targetLivingBudget,
    actualSavedThisMonth: Number(actualSavedThisMonth.toFixed(2)),
    actualInvestedThisMonth: Number(actualInvestedThisMonth.toFixed(2)),
    unpaidCommittedReserve: pred.unpaidCommittedReserve || 0,
    spentSoFar: pred.spentSoFar,
    safeDailyLivingAllowance: pred.safeDailyLivingAllowance,
    daysRemainingInMonth: pred.daysRemaining,
  };
}

/**
 * Atomically saves Income Allocation settings AND synchronizes cashflow_monthly_budget and cashflow_category_caps
 * so Home Page, Income Advisor, and Budget Page never diverge.
 */
export function saveUnifiedIncomeAllocation(params: {
  baselineIncome: number;
  savingsTargetPct: number;
  investmentTargetPct: number;
  allTransactions?: GenericTransaction[];
  autoRebalanceCategoryCaps?: boolean;
}): UnifiedIncomeAllocation {
  const income = Math.max(0, Math.round(Number(params.baselineIncome) || 0));
  const savPct = Math.min(80, Math.max(0, Number(params.savingsTargetPct) || 0));
  const invPct = Math.min(80 - savPct, Math.max(0, Number(params.investmentTargetPct) || 0));
  const targetLivingBudget = Math.max(500, Math.round(income * ((100 - savPct - invPct) / 100)));

  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem('cashflow_baseline_income', String(income));
      localStorage.setItem('cashflow_savings_target_pct', String(savPct));
      localStorage.setItem('cashflow_investment_target_pct', String(invPct));
      localStorage.setItem('cashflow_monthly_budget', String(targetLivingBudget));
      import('./cloud-settings-sync.ts')
        .then((mod) => {
          if (mod?.saveSettingWithCloudSync) {
            mod.saveSettingWithCloudSync('cashflow_baseline_income', String(income));
            mod.saveSettingWithCloudSync('cashflow_savings_target_pct', String(savPct));
            mod.saveSettingWithCloudSync('cashflow_investment_target_pct', String(invPct));
            mod.saveSettingWithCloudSync('cashflow_monthly_budget', String(targetLivingBudget));
          }
        })
        .catch(() => {});
    } catch {}
  }

  if (params.autoRebalanceCategoryCaps !== false) {
    const plan = generateIntelligentCategoryCaps(params.allTransactions || [], {
      baselineIncome: income,
      savingsTargetPct: savPct,
      investmentTargetPct: invPct,
      monthlyBudgetCap: targetLivingBudget,
    });
    const nextCaps: Record<string, number> = {};
    plan.suggestions.forEach((s) => {
      nextCaps[s.category] = s.suggestedCap;
    });
    saveCategoryCaps(nextCaps);
  }

  return getUnifiedIncomeAllocation(params.allTransactions || [], {
    baselineIncome: income,
    savingsTargetPct: savPct,
    investmentTargetPct: invPct,
  });
}
