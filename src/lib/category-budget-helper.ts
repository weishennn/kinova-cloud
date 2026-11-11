import { getAmountInBaseCurrency } from './currency.ts';
import { getLocalDateString, parseLocalDate } from './date-helper.ts';
import { CANONICAL_EXPENSE_CATEGORIES, normalizeToCanonicalCategory } from './canonical-categories.ts';
import { getUserMoneyProfile } from './user-money-profile.ts';

export interface CategoryBudgetCap {
  category: string;
  capAmount: number;
}

export const DEFAULT_CATEGORY_CAPS: Record<string, number> = {
  'Food & Dining': 900,
  'Housing & Bills': 500,
  'Insurance': 200,
  'Transport': 200,
  'Shopping': 150,
  'Sport': 150,
  'Health': 80,
  'Entertainment': 80,
  'Education': 50,
  'Gift': 50,
  'Other': 50,
  'Parents': 0,
};

const STORAGE_KEY = 'cashflow_category_caps';
export const LOCKED_CAPS_STORAGE_KEY = 'cashflow_locked_category_caps';
export const TRIP_ENVELOPES_STORAGE_KEY = 'cashflow_trip_budget_envelopes_v1';

/**
 * Normalizes a category caps record so legacy aliases (e.g. 'Family', 'Bills', 'Food', 'Groceries')
 * map cleanly onto canonical categories without creating duplicate rows or clobbering explicit 0 caps.
 */
export function normalizeCategoryCapsRecord(
  caps?: Record<string, number> | null,
  mergeDefaults: boolean = true,
  recoverLegacyZeroStubs: boolean = false
): Record<string, number> {
  const base: Record<string, number> = mergeDefaults ? { ...DEFAULT_CATEGORY_CAPS } : {};
  if (!caps || typeof caps !== 'object') return base;

  const canonicalInput: Record<string, number> = {};
  const aliasInput: Array<{ canonical: string; value: number }> = [];

  for (const [rawKey, rawVal] of Object.entries(caps)) {
    const num = Number(rawVal);
    if (!Number.isFinite(num) || num < 0) continue;
    const cleanNum = Math.round(num * 100) / 100;
    const trimmedKey = String(rawKey || '').trim();
    if (!trimmedKey) continue;

    if ((CANONICAL_EXPENSE_CATEGORIES as readonly string[]).includes(trimmedKey)) {
      canonicalInput[trimmedKey] = cleanNum;
    } else {
      const mapped = normalizeToCanonicalCategory(trimmedKey, 'Expense');
      aliasInput.push({ canonical: mapped, value: cleanNum });
    }
  }

  const out: Record<string, number> = { ...base, ...canonicalInput };
  const mergedAliasCanonical = new Set<string>();
  for (const { canonical, value } of aliasInput) {
    const hadCanonical = Object.prototype.hasOwnProperty.call(canonicalInput, canonical);
    if (!hadCanonical) {
      if (!mergedAliasCanonical.has(canonical)) {
        out[canonical] = value;
        mergedAliasCanonical.add(canonical);
      } else {
        out[canonical] = Math.round(((out[canonical] || 0) + value) * 100) / 100;
      }
    } else if (
      recoverLegacyZeroStubs &&
      value > 0 &&
      canonicalInput[canonical] === 0 &&
      (DEFAULT_CATEGORY_CAPS[canonical] ?? 0) === 0
    ) {
      out[canonical] = value;
    }
  }

  return out;
}

/**
 * Resolves a numeric cap for a category while strictly preserving explicit 0 caps.
 * Fixes the `||` bug where setting a category cap to 0 fell back to default or 500.
 */
export function resolveCategoryCapValue(
  category: string,
  caps?: Record<string, number> | null,
  fallbackIfMissing = 0
): number {
  const trimmed = String(category || '').trim();
  const canonical = trimmed ? normalizeToCanonicalCategory(trimmed, 'Expense') : '';

  if (caps && Object.prototype.hasOwnProperty.call(caps, category)) {
    const val = Number(caps[category]);
    if (Number.isFinite(val) && val >= 0) {
      return val;
    }
  }
  if (canonical && canonical !== category && caps && Object.prototype.hasOwnProperty.call(caps, canonical)) {
    const val = Number(caps[canonical]);
    if (Number.isFinite(val) && val >= 0) {
      return val;
    }
  }
  if (canonical && Object.prototype.hasOwnProperty.call(DEFAULT_CATEGORY_CAPS, canonical)) {
    return DEFAULT_CATEGORY_CAPS[canonical];
  }
  if (Object.prototype.hasOwnProperty.call(DEFAULT_CATEGORY_CAPS, category)) {
    return DEFAULT_CATEGORY_CAPS[category];
  }
  return fallbackIfMissing;
}

/**
 * Loads user-locked category caps (`lockedCaps`) from localStorage.
 * Locked categories are never modified by auto-fit, auto-tune, or cross-category rebalancing.
 */
export function getLockedCategoryCaps(): Record<string, boolean> {
  if (typeof window === 'undefined' && typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(LOCKED_CAPS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const clean: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (v === true) {
          const canon = normalizeToCanonicalCategory(k, 'Expense');
          clean[canon] = true;
        }
      }
      return clean;
    }
  } catch {}
  return {};
}

/**
 * Persists user-locked category caps (`lockedCaps`) and broadcasts across tabs + cloud sync.
 */
export function saveLockedCategoryCaps(lockedCaps: Record<string, boolean>): void {
  if (typeof window === 'undefined' && typeof localStorage === 'undefined') return;
  const clean: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(lockedCaps || {})) {
    if (v === true) {
      const canon = normalizeToCanonicalCategory(k, 'Expense');
      clean[canon] = true;
    }
  }
  const serialized = JSON.stringify(clean);
  let prevRaw: string | null = null;
  try {
    prevRaw = localStorage.getItem(LOCKED_CAPS_STORAGE_KEY);
    localStorage.setItem(LOCKED_CAPS_STORAGE_KEY, serialized);
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(
        new CustomEvent('cashflow_cloud_settings_synced', {
          detail: { key: LOCKED_CAPS_STORAGE_KEY, value: serialized },
        })
      );
    }
  } catch {}
  if (prevRaw !== serialized) {
    try {
      import('./cloud-settings-sync.ts')
        .then((mod) => {
          if (mod && mod.saveSettingWithCloudSync) {
            mod.saveSettingWithCloudSync(LOCKED_CAPS_STORAGE_KEY, serialized, { forceSync: true });
          }
        })
        .catch(() => {});
    } catch {}
  }
}

/**
 * Loads category budget caps from localStorage.
 * Strictly preserves any explicit 0 caps set by the user while ensuring all canonical categories exist
 * and normalizing legacy alias keys.
 */
export function getSavedCategoryCaps(): Record<string, number> {
  if (typeof window === 'undefined' && typeof localStorage === 'undefined') return { ...DEFAULT_CATEGORY_CAPS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && Object.keys(parsed).length > 0) {
        const normalized = normalizeCategoryCapsRecord(parsed as Record<string, number>, true, true);
        if (Object.keys(normalized).length > 0) {
          return normalized;
        }
      }
    }
  } catch {}
  return { ...DEFAULT_CATEGORY_CAPS };
}

/**
 * Saves category budget caps to localStorage with background cloud SOT sync and cross-tab broadcast.
 */
export function saveCategoryCaps(caps: Record<string, number>): void {
  if (typeof window === 'undefined' && typeof localStorage === 'undefined') return;
  const sanitized = normalizeCategoryCapsRecord(caps, false, false);
  const serialized = JSON.stringify(sanitized);
  let prevRaw: string | null = null;
  try {
    prevRaw = localStorage.getItem(STORAGE_KEY);
    localStorage.setItem(STORAGE_KEY, serialized);
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(
        new CustomEvent('cashflow_cloud_settings_synced', {
          detail: { key: STORAGE_KEY, value: serialized },
        })
      );
    }
  } catch {}
  try {
    import('./cache-manager.ts')
      .then((cm) => {
        if (cm && typeof cm.broadcastCrossTabEvent === 'function') {
          cm.broadcastCrossTabEvent('CATEGORY_CAPS_UPDATED', { key: STORAGE_KEY, value: serialized });
        }
      })
      .catch(() => {});
  } catch {}
  if (prevRaw !== serialized) {
    try {
      import('./cloud-settings-sync.ts')
        .then((mod) => {
          if (mod && mod.saveSettingWithCloudSync) {
            mod.saveSettingWithCloudSync(STORAGE_KEY, serialized, { forceSync: true });
          }
        })
        .catch(() => {});
    } catch {}
  }
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
export function calculateDailySafeSpend(
  totalBudget: number,
  totalSpent: number,
  monthStr?: string,
  referenceDate?: Date,
  options?: { unpaidReserve?: number }
) {
  const { totalDays, todayDate, daysRemaining, isCurrentMonth, isPastMonth } = getMonthDaysInfo(
    monthStr,
    referenceDate
  );
  const unpaidReserve = !isPastMonth ? Math.max(0, Number(options?.unpaidReserve) || 0) : 0;
  const remainingBudget = Math.max(0, totalBudget - totalSpent);
  const safeRemainingBudget = Math.max(0, totalBudget - totalSpent - unpaidReserve);
  const divisor = daysRemaining > 0 ? daysRemaining : totalDays;
  const dailyAllowance = safeRemainingBudget / (divisor || 1);
  const isOverBudget = totalBudget > 0 && totalSpent > totalBudget;
  const overAmount = isOverBudget ? totalSpent - totalBudget : 0;
  const spentPercent = totalBudget > 0 ? (totalSpent / totalBudget) * 100 : 0;

  return {
    totalBudget,
    totalSpent,
    remainingBudget: Number(remainingBudget.toFixed(2)),
    safeRemainingBudget: Number(safeRemainingBudget.toFixed(2)),
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

// ---------------------------------------------------------------------------
// Pillar 2: Multi-Currency Trip-Scoped Budget Envelopes & Quarantine Helpers
// ---------------------------------------------------------------------------

export interface TripBudgetEnvelope {
  tripTag: string; // e.g. "Tokyo 2026"
  currency: string; // e.g. "JPY"
  budgetAmount: number; // e.g. 300000 (in native currency)
  fxRateToMyr?: number; // optional custom FX rate (1 unit = X MYR)
  startDate?: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD
  quarantineFromLivingBurn?: boolean; // default true
}

export interface TripEnvelopeStatus {
  tripTag: string;
  currency: string;
  budgetAmount: number;
  budgetAmountMyr: number;
  spentNative: number;
  spentMyr: number;
  remainingNative: number;
  remainingMyr: number;
  spentPercent: number;
  isOverBudget: boolean;
  transactionCount: number;
  categoryBreakdown: Array<{ category: string; amountNative: number; amountMyr: number }>;
}

export function getSavedTripEnvelopes(): Record<string, TripBudgetEnvelope> {
  if (typeof window === 'undefined' && typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(TRIP_ENVELOPES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, TripBudgetEnvelope>;
    }
  } catch {}
  return {};
}

export function saveTripEnvelope(envelope: TripBudgetEnvelope): void {
  if (typeof window === 'undefined' && typeof localStorage === 'undefined') return;
  const tag = String(envelope.tripTag || '').trim();
  if (!tag) return;
  const current = getSavedTripEnvelopes();
  current[tag] = {
    ...envelope,
    tripTag: tag,
    currency: String(envelope.currency || 'MYR').trim().toUpperCase(),
    budgetAmount: Math.max(0, Number(envelope.budgetAmount) || 0),
    quarantineFromLivingBurn: envelope.quarantineFromLivingBurn !== false,
  };
  const serialized = JSON.stringify(current);
  try {
    localStorage.setItem(TRIP_ENVELOPES_STORAGE_KEY, serialized);
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(
        new CustomEvent('cashflow_cloud_settings_synced', {
          detail: { key: TRIP_ENVELOPES_STORAGE_KEY, value: serialized },
        })
      );
    }
  } catch {}
}

export interface GenericTransaction {
  id?: string;
  type?: string;
  amount?: number;
  currency?: string;
  baseAmount?: number;
  category?: string;
  subCategory?: string;
  description?: string;
  notes?: string;
  date?: string;
  tripTag?: string;
  TripTag?: string;
}

/**
 * Determines whether a transaction is a trip-tagged or Trixpense travel expense
 * that should be quarantined from the domestic daily living burn rate.
 */
export function isTripQuarantinedExpense(tx?: GenericTransaction | null): boolean {
  if (!tx) return false;
  const tag = String(tx.tripTag || tx.TripTag || '').trim();
  if (tag.length > 0) {
    const envelopes = getSavedTripEnvelopes();
    if (envelopes[tag] && envelopes[tag].quarantineFromLivingBurn === false) {
      return false;
    }
    return true;
  }
  const idStr = String(tx.id || '');
  const subStr = String(tx.subCategory || '');
  if (idStr.startsWith('trixpense_') || subStr === 'Trixpense Shared Bill') {
    return true;
  }
  return false;
}

/**
 * Computes real-time spending status for a dedicated Trip Budget Envelope (e.g. "Tokyo 2026", JPY 300,000).
 */
export function getTripEnvelopeStatus(
  tripTag: string,
  allTransactions: GenericTransaction[] = [],
  envelopeOverride?: TripBudgetEnvelope
): TripEnvelopeStatus {
  const cleanTag = String(tripTag || '').trim();
  const saved = getSavedTripEnvelopes()[cleanTag];
  const env: TripBudgetEnvelope = envelopeOverride || saved || {
    tripTag: cleanTag,
    currency: 'MYR',
    budgetAmount: 0,
    quarantineFromLivingBurn: true,
  };

  const envCurr = String(env.currency || 'MYR').toUpperCase();
  const customRate = env.fxRateToMyr && env.fxRateToMyr > 0 ? env.fxRateToMyr : undefined;
  const budgetAmount = Math.max(0, Number(env.budgetAmount) || 0);
  const budgetAmountMyr =
    envCurr === 'MYR'
      ? budgetAmount
      : customRate
      ? Number((budgetAmount * customRate).toFixed(2))
      : Number(getAmountInBaseCurrency(budgetAmount, envCurr).toFixed(2));

  let spentNative = 0;
  let spentMyr = 0;
  let txCount = 0;
  const catMap = new Map<string, { native: number; myr: number }>();

  const validTxs = Array.isArray(allTransactions) ? allTransactions : [];
  for (const t of validTxs) {
    if (String(t?.type || '').toLowerCase() !== 'expense' || t?.id === 'tx_sample') continue;
    const tTag = String(t.tripTag || t.TripTag || '').trim();
    if (tTag.toLowerCase() !== cleanTag.toLowerCase()) continue;

    const rawAmt = Number(t.amount) || 0;
    if (rawAmt <= 0) continue;
    const txCurr = String(t.currency || 'MYR').toUpperCase();
    const myrAmt = getAmountInBaseCurrency(rawAmt, txCurr, t.baseAmount);

    let nativeEquiv = rawAmt;
    if (txCurr !== envCurr) {
      if (envCurr === 'MYR') {
        nativeEquiv = myrAmt;
      } else if (customRate && customRate > 0) {
        nativeEquiv = myrAmt / customRate;
      } else {
        const oneEnvUnitInMyr = getAmountInBaseCurrency(1, envCurr) || 1;
        nativeEquiv = myrAmt / oneEnvUnitInMyr;
      }
    }

    spentNative += nativeEquiv;
    spentMyr += myrAmt;
    txCount += 1;

    const cat = t.category || 'Other';
    const existing = catMap.get(cat) || { native: 0, myr: 0 };
    existing.native += nativeEquiv;
    existing.myr += myrAmt;
    catMap.set(cat, existing);
  }

  spentNative = Number(spentNative.toFixed(2));
  spentMyr = Number(spentMyr.toFixed(2));
  const remainingNative = Number(Math.max(0, budgetAmount - spentNative).toFixed(2));
  const remainingMyr = Number(Math.max(0, budgetAmountMyr - spentMyr).toFixed(2));
  const spentPercent = budgetAmount > 0 ? Number(((spentNative / budgetAmount) * 100).toFixed(1)) : 0;

  return {
    tripTag: cleanTag,
    currency: envCurr,
    budgetAmount,
    budgetAmountMyr,
    spentNative,
    spentMyr,
    remainingNative,
    remainingMyr,
    spentPercent,
    isOverBudget: budgetAmount > 0 && spentNative > budgetAmount,
    transactionCount: txCount,
    categoryBreakdown: Array.from(catMap.entries())
      .map(([category, v]) => ({
        category,
        amountNative: Number(v.native.toFixed(2)),
        amountMyr: Number(v.myr.toFixed(2)),
      }))
      .sort((a, b) => b.amountMyr - a.amountMyr),
  };
}

/**
 * Returns spending status summaries for all configured Trip Budget Envelopes.
 */
export function getTripEnvelopeSummaries(
  allTransactions: GenericTransaction[] = [],
  envelopesOverride?: Record<string, TripBudgetEnvelope>
): TripEnvelopeStatus[] {
  const envelopes = envelopesOverride || getSavedTripEnvelopes();
  return Object.values(envelopes).map((env) => getTripEnvelopeStatus(env.tripTag, allTransactions, env));
}

// ---------------------------------------------------------------------------
// Core Budget & Rebalancing Interfaces
// ---------------------------------------------------------------------------

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
  unpaidBillReserve?: number;
  currentMonthSpent?: number;
  rebalancedDelta?: number;
  isLocked?: boolean;
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

export interface PaydayEnvelopeTransferItem {
  id: string;
  type: 'Investment';
  category: 'Emergency Savings' | 'Stocks & Crypto';
  subCategory: string;
  description: string;
  amount: number;
  currency: 'MYR';
  date: string;
  notes: string;
}

export interface PaydayEnvelopeAllocationPlan {
  shouldPrompt: boolean;
  salaryRecordedThisMonth: number;
  baselineIncome: number;
  cyclePhase: 'living_phase' | 'payday_settlement';
  savingsTargetPct: number;
  investmentTargetPct: number;
  plannedSavingsAmount: number;
  plannedInvestmentAmount: number;
  alreadySavedThisMonth: number;
  alreadyInvestedThisMonth: number;
  remainingToSave: number;
  remainingToInvest: number;
  proposedTransfers: PaydayEnvelopeTransferItem[];
  headline: string;
  summaryText: string;
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
  envelopePlan?: PaydayEnvelopeAllocationPlan;
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
  committedReserve: number;
  unreservedRemainingBefore: number;
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
  tripQuarantinedSpent?: number;
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

interface StoredRecurringLike {
  id?: string;
  name?: string;
  category?: string;
  amount?: number;
  dayOfMonth?: number;
  effectiveFrom?: string;
  history?: Array<{ effectiveFrom: string; amount: number }>;
}

interface StoredInstallmentLike {
  id?: string;
  name?: string;
  category?: string;
  currency?: string;
  tripTag?: string;
  monthlyAmount?: number;
  monthlyPayment?: number;
  remainingMonths?: number;
  tenureMonths?: number;
  startDate?: string;
  endDate?: string;
}

export interface CategoryCommitmentBreakdown {
  totalCommittedByCategory: Map<string, number>;
  unpaidReserveByCategory: Map<string, number>;
  unpaidItemsByCategory: Map<string, Array<{ name: string; amount: number; kind: 'recurring' | 'installment' }>>;
}

/**
 * Counts distinct active living expense calendar months ('YYYY-MM') in a ledger.
 * Used to keep 'all' time budget caps consistent across Hero, category rows, and Home cockpit.
 */
export function countActiveBudgetMonths(transactions: GenericTransaction[] = []): number {
  const validTxs = Array.isArray(transactions) ? transactions : [];
  const expenseMonths = new Set<string>();
  const allMonths = new Set<string>();
  for (const t of validTxs) {
    if (!t || t.id === 'tx_sample' || !t.date || t.date.length < 7) continue;
    const m = t.date.slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(m)) continue;
    allMonths.add(m);
    if (String(t.type || '').toLowerCase() === 'expense' && !isTripQuarantinedExpense(t)) {
      expenseMonths.add(m);
    }
  }
  return Math.max(1, expenseMonths.size > 0 ? expenseMonths.size : allMonths.size);
}

export function getCategoryCommitmentBreakdown(
  monthTransactions: GenericTransaction[] = [],
  targetMonthPrefix: string = getLocalDateString().slice(0, 7),
  options?: {
    referenceDate?: Date;
    skipReserveForPastMonth?: boolean;
  }
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

  // Multi-month aggregates ('all' / 'year-YYYY') never reserve single-month pending bills
  if (!targetMonthPrefix || targetMonthPrefix === 'all' || targetMonthPrefix.startsWith('year-')) {
    return { totalCommittedByCategory, unpaidReserveByCategory, unpaidItemsByCategory };
  }

  const daysInfo = getMonthDaysInfo(targetMonthPrefix, options?.referenceDate);
  const skipReserve = (options?.skipReserveForPastMonth ?? true) && daysInfo.isPastMonth;

  const allExpenses = (Array.isArray(monthTransactions) ? monthTransactions : []).filter(
    (t) => String(t?.type || '').toLowerCase() === 'expense' && t?.id !== 'tx_sample'
  );
  const monthExpenses = allExpenses.filter((t) => !t?.date || t.date.startsWith(targetMonthPrefix));

  try {
    const rawRec = localStorage.getItem('cashflow_recurring_commitments');
    if (rawRec) {
      const list = JSON.parse(rawRec) as StoredRecurringLike[];
      if (Array.isArray(list)) {
        for (const item of list) {
          // Do not include or reserve commitments scheduled to start in a future month
          const validHistoryMonths = Array.isArray(item?.history)
            ? item.history
                .map((h) => (typeof h?.effectiveFrom === 'string' ? h.effectiveFrom.slice(0, 7) : ''))
                .filter((m) => /^\d{4}-\d{2}$/.test(m))
            : [];
          const fallbackEffective =
            typeof item?.effectiveFrom === 'string' && /^\d{4}-\d{2}$/.test(item.effectiveFrom.slice(0, 7))
              ? item.effectiveFrom.slice(0, 7)
              : '';
          const earliestEffective =
            validHistoryMonths.length > 0 ? validHistoryMonths.sort()[0] : fallbackEffective;
          if (earliestEffective && targetMonthPrefix < earliestEffective) {
            continue;
          }

          let amt = Number(item?.amount) || 0;
          if (Array.isArray(item?.history) && item.history.length > 0) {
            const sorted = [...item.history].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
            const matched = sorted.find((h) => h.effectiveFrom <= targetMonthPrefix);
            amt = matched ? Number(matched.amount) || amt : Number(sorted[sorted.length - 1].amount) || amt;
          }
          if (amt <= 0) continue;

          const cat = normalizeToCanonicalCategory(item?.category || 'Housing & Bills', 'Expense', item?.name);
          const name = (item?.name || '').trim();
          const sanitizedRecId = item?.id ? String(item.id).replace(/[^A-Za-z0-9_-]/g, '_') : '';
          totalCommittedByCategory.set(cat, (totalCommittedByCategory.get(cat) || 0) + amt);

          if (skipReserve) continue;

          const isAlreadyPaid = monthExpenses.some((tx) => {
            const notes = String(tx.notes || '');
            const txId = String(tx.id || '');
            if (
              item?.id &&
              (notes.includes(`[Recurring:${item.id}]`) ||
                txId.startsWith(`tx_rec_${item.id}_`) ||
                txId.startsWith(`tx_rec_${sanitizedRecId}_`))
            ) {
              return true;
            }
            const descLower = String(tx.description || '').trim().toLowerCase();
            const nameLower = name.toLowerCase();
            if (!nameLower || !descLower) return false;
            if (descLower === nameLower) return true;
            const rawTxCat = String(tx.category || '').trim();
            const txCatCanonical = rawTxCat
              ? normalizeToCanonicalCategory(rawTxCat, 'Expense', String(tx.description || ''))
              : '';
            if ((!txCatCanonical || txCatCanonical === cat) && nameLower.length >= 3 && descLower.length >= 3) {
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

  try {
    const rawInst = localStorage.getItem('cashflow_installment_plans');
    if (rawInst) {
      const list = JSON.parse(rawInst) as StoredInstallmentLike[];
      if (Array.isArray(list)) {
        for (const plan of list) {
          // Quarantine trip-tagged installment plans out of domestic living budget reserves
          if (plan?.tripTag && isTripQuarantinedExpense({ tripTag: plan.tripTag })) continue;
          if (plan?.endDate && plan.endDate.slice(0, 7) < targetMonthPrefix) continue;
          if (plan?.startDate && plan.startDate.slice(0, 7) > targetMonthPrefix) continue;
          if (typeof plan?.remainingMonths === 'number' && plan.remainingMonths <= 0) continue;

          const rawAmt = Number(plan?.monthlyAmount ?? plan?.monthlyPayment) || 0;
          if (rawAmt <= 0) continue;
          const amt = getAmountInBaseCurrency(rawAmt, plan?.currency || 'MYR');
          if (amt <= 0) continue;

          const cat = normalizeToCanonicalCategory(plan?.category || 'Shopping', 'Expense', plan?.name);
          const name = (plan?.name || '').trim();
          const nameLower = name.toLowerCase();
          const sanitizedPlanId = plan?.id ? String(plan.id).replace(/[^A-Za-z0-9_-]/g, '_') : '';

          const matchesPlanTx = (tx: GenericTransaction): boolean => {
            const txId = String(tx.id || '');
            if (
              plan?.id &&
              (txId.startsWith(`tx_inst_${plan.id}_`) || txId.startsWith(`tx_inst_${sanitizedPlanId}_`))
            ) {
              return true;
            }
            const desc = String(tx.description || '').toLowerCase();
            const notes = String(tx.notes || '').toLowerCase();
            const isInstTx = desc.includes('(installment') || notes.includes('[installment plan');
            if (isInstTx) {
              const baseName = desc.replace(/\s*\(installment.*?\)/i, '').trim();
              return Boolean(nameLower && (baseName === nameLower || desc.includes(nameLower)));
            }
            if (nameLower.length >= 4 && desc) {
              const rawTxCat = String(tx.category || '').trim();
              const txCatCanonical = rawTxCat
                ? normalizeToCanonicalCategory(rawTxCat, 'Expense', String(tx.description || ''))
                : '';
              const txAmtMyr = getAmountInBaseCurrency(tx.amount || 0, tx.currency, tx.baseAmount);
              const amtTolerance = Math.max(2, amt * 0.15);
              if (
                (!txCatCanonical || txCatCanonical === cat) &&
                (desc === nameLower || desc.includes(nameLower)) &&
                Math.abs(txAmtMyr - amt) <= amtTolerance
              ) {
                return true;
              }
            }
            return false;
          };

          const isAlreadyPaid = monthExpenses.some(matchesPlanTx);
          const tenure = Number(plan?.tenureMonths) || 0;
          if (!isAlreadyPaid && tenure > 0) {
            const lifetimePaidCount = allExpenses.filter((tx) => {
              if (tx?.date && tx.date.length >= 7 && tx.date.slice(0, 7) > targetMonthPrefix) return false;
              return matchesPlanTx(tx);
            }).length;
            if (lifetimePaidCount >= tenure) {
              continue;
            }
          }

          totalCommittedByCategory.set(cat, (totalCommittedByCategory.get(cat) || 0) + amt);

          if (!skipReserve && !isAlreadyPaid) {
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
 * Strictly respects `lockedCaps`: user-locked categories are NEVER trimmed as donor buckets!
 */
export function rebalanceCategoryCapsForSpending(params: {
  currentMonthTransactions: GenericTransaction[];
  currentCaps?: Record<string, number>;
  lockedCaps?: Record<string, boolean>;
  maxLivingBudget?: number;
  targetCategory?: string;
  proposedAmount?: number;
  targetMonth?: string;
  referenceDate?: Date;
}): CategoryRebalanceSuggestion {
  const now = params.referenceDate || new Date();
  const defaultMonthPrefix = params.targetMonth || getLocalDateString(now).slice(0, 7);
  const validTxs = Array.isArray(params.currentMonthTransactions) ? params.currentMonthTransactions : [];
  const monthFilter = resolveEffectiveMonthFilter(validTxs, defaultMonthPrefix, params.targetMonth);
  const effectiveMonth = monthFilter || defaultMonthPrefix;
  const daysInfo = getMonthDaysInfo(effectiveMonth, now);

  const locked = params.lockedCaps || getLockedCategoryCaps();
  const baseCaps = normalizeCategoryCapsRecord(params.currentCaps || getSavedCategoryCaps(), true, false);
  const updatedCaps: Record<string, number> = { ...baseCaps };

  const currentTotalCaps = Object.values(updatedCaps).reduce((s, v) => s + v, 0);
  const maxBudget =
    params.maxLivingBudget && params.maxLivingBudget > 0
      ? currentTotalCaps > 0
        ? Math.min(params.maxLivingBudget, currentTotalCaps)
        : params.maxLivingBudget
      : Math.max(800, currentTotalCaps);

  // 1. Compute domestic spent so far (excluding quarantined trip expenses) and unpaid bill reserves per category
  const spentByCat = new Map<string, number>();
  for (const t of validTxs) {
    if (String(t?.type || '').toLowerCase() !== 'expense' || t?.id === 'tx_sample' || !t?.date) continue;
    if (monthFilter && t.date.length >= 7 && !t.date.startsWith(monthFilter)) continue;
    if (isTripQuarantinedExpense(t)) continue;
    const cat = normalizeToCanonicalCategory(t.category || 'Other', 'Expense', t.description);
    const amt = getAmountInBaseCurrency(t.amount || 0, t.currency, t.baseAmount);
    if (amt > 0) {
      spentByCat.set(cat, (spentByCat.get(cat) || 0) + amt);
    }
  }

  const { unpaidReserveByCategory, totalCommittedByCategory } = getCategoryCommitmentBreakdown(
    validTxs,
    effectiveMonth,
    { referenceDate: now }
  );

  // 2. Expand target category (and any non-locked over-cap category) to cover (spent + unpaidBillReserve + proposedAmount)
  const targetCat = params.targetCategory
    ? normalizeToCanonicalCategory(params.targetCategory, 'Expense')
    : '';
  const proposed = Math.max(0, Number(params.proposedAmount) || 0);
  const previousTargetCap = targetCat ? updatedCaps[targetCat] ?? 0 : 0;

  let totalExpanded = 0;
  for (const cat of Object.keys(updatedCaps)) {
    // If a category is locked and is NOT the explicit targetCat requested by the user, keep its locked cap untouched
    if (locked[cat] && cat !== targetCat) continue;
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
  const donors: CategoryRebalanceDonor[] = [];
  let remainingToCut = Math.max(
    0,
    Object.values(updatedCaps).reduce((s, v) => s + v, 0) - maxBudget
  );

  if (remainingToCut > 0) {
    // Pass A: Cut from unspent, unreserved slack in UNLOCKED categories
    for (const donorCat of REBALANCE_DONOR_ORDER) {
      if (remainingToCut <= 0) break;
      if (donorCat === targetCat || locked[donorCat]) continue;
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

    // Pass B: If still needed, allow trimming unspent buffer from UNLOCKED Food & Dining, Housing & Bills, or Insurance down to actual (spent + unpaidReserve)
    if (remainingToCut > 0) {
      for (const donorCat of REBALANCE_DONOR_ORDER) {
        if (remainingToCut <= 0) break;
        if (donorCat === targetCat || locked[donorCat]) continue;
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
    summaryText = `⚠️ All other unlocked categories are already spent or reserved for bills; raising ${targetCat || 'this category'} by RM ${totalExpanded.toFixed(0)} will dip into your monthly savings buffer.`;
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
 * One-call helper for the UI or AI Assistant to execute and persist a smart cross-category rebalance.
 */
export function applySmartCategoryRebalance(
  params: Parameters<typeof rebalanceCategoryCapsForSpending>[0]
): CategoryRebalanceSuggestion {
  const res = rebalanceCategoryCapsForSpending(params);
  saveCategoryCaps(res.updatedCaps);
  return res;
}

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

    const lockPrefix = s.isLocked ? '🔒 Locked by user · ' : '';
    const reserveSuffix =
      reserve > 0 ? ` Includes RM ${reserve.toFixed(0)} reserved for upcoming monthly bills.` : '';
    const rebalanceSuffix =
      delta > 0
        ? ` (+RM ${delta.toFixed(0)} auto-rebalanced from unused categories to cover this month's spend/bills).`
        : delta < 0
        ? ` (-RM ${Math.abs(delta).toFixed(0)} shifted to cover active spending in other categories).`
        : '';

    if (s.category === 'Food & Dining') {
      const foodDaily = Number((s.suggestedCap / 30).toFixed(1));
      s.dailyAllowance = foodDaily;
      s.reasoning = `${lockPrefix}Allocated RM ${s.suggestedCap} (RM ${foodDaily}/day) for active daily meal pacing while strictly reserving your ${totalSavingsPct}% savings goal.${reserveSuffix}${rebalanceSuffix}`;
    } else if (s.category === 'Insurance') {
      s.reasoning =
        s.suggestedCap > 0
          ? `${lockPrefix}Identified as a monthly recurring commitment. Suggested cap matches your steady RM ${s.suggestedCap}/mo premium without waste.${reserveSuffix}${rebalanceSuffix}`
          : `${lockPrefix}No regular insurance premium configured (set to RM 0; adjust if needed).`;
    } else if (s.category === 'Housing & Bills') {
      s.reasoning = `${lockPrefix}Baseline rent & utilities (avg RM ${s.historicalAvg || s.suggestedCap}) + bill buffer to handle seasonal utility spikes.${reserveSuffix}${rebalanceSuffix}`;
    } else if (s.category === 'Transport') {
      s.dailyAllowance = Number((s.suggestedCap / 30).toFixed(1));
      s.reasoning = `${lockPrefix}Based on your regular commute, toll, and fuel trends (avg RM ${s.historicalAvg || s.suggestedCap}/mo).${reserveSuffix}${rebalanceSuffix}`;
    } else if (s.category === 'Parents') {
      s.reasoning =
        s.suggestedCap > 0
          ? `${lockPrefix}Regular family support commitment locked at RM ${s.suggestedCap}/mo.${reserveSuffix}${rebalanceSuffix}`
          : `${lockPrefix}No regular family support detected (set to RM 0; adjust if needed).`;
    } else if (s.category === 'Health') {
      s.reasoning = `${lockPrefix}Essential medical, clinic, and pharmacy safety net (RM ${s.suggestedCap}/mo).${reserveSuffix}${rebalanceSuffix}`;
    } else if (s.category === 'Education') {
      s.reasoning = `${lockPrefix}Occasional self-learning & course reserve (RM ${s.suggestedCap}/mo). Handled as a flexible lump sum so it does not distort daily living burn rate.${reserveSuffix}${rebalanceSuffix}`;
    } else if (s.category === 'Sport') {
      s.reasoning = `${lockPrefix}Monthly sports & gym cap (RM ${s.suggestedCap}). Spend one time, use whole month.${reserveSuffix}${rebalanceSuffix}`;
    } else if (s.category === 'Shopping') {
      s.reasoning = `${lockPrefix}Monthly retail & lifestyle cap (RM ${s.suggestedCap}). Spend one time, use whole month.${reserveSuffix}${rebalanceSuffix}`;
    } else {
      s.reasoning =
        spent > 0 || reserve > 0
          ? `${lockPrefix}Monthly capped budget (RM ${s.suggestedCap}, with RM ${spent.toFixed(0)} spent${reserve > 0 ? ` + RM ${reserve.toFixed(0)} bill reserve` : ''}). Spend one time, use whole month.${rebalanceSuffix}`
          : `${lockPrefix}Monthly capped budget (RM ${s.suggestedCap}). Spend one time, use whole month.${rebalanceSuffix}`;
    }
  }
}

/**
 * Computes intelligent category spending caps derived dynamically from:
 * 1. Normal monthly baselines for every regular category — even before you spend in them this month!
 * 2. Per-category Bill Reserves (`cashflow_recurring_commitments` + `cashflow_installment_plans`).
 * 3. Live Cross-Category Auto-Rebalancing while strictly preserving `lockedCaps`!
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
    referenceDate?: Date;
  }
): IntelligentBudgetPlan {
  const now = options?.referenceDate || new Date();
  const hasLocalStorage = typeof window !== 'undefined' || typeof localStorage !== 'undefined';
  const profile = hasLocalStorage ? getUserMoneyProfile() : null;
  const currentCaps = options?.configuredCaps
    ? normalizeCategoryCapsRecord(options.configuredCaps, true, false)
    : getSavedCategoryCaps();
  const locked = options?.lockedCaps || getLockedCategoryCaps();

  // 1. Resolve Monthly Income & Target Savings
  const savedIncome = hasLocalStorage ? parseFloat(localStorage.getItem('cashflow_baseline_income') || '0') : 0;
  const baselineIncome =
    options?.baselineIncome || (savedIncome > 0 ? savedIncome : profile?.baselineIncome ?? 3000);

  const savedSavingsPct = hasLocalStorage ? parseFloat(localStorage.getItem('cashflow_savings_target_pct') || '20') : 20;
  const savingsTargetPct = options?.savingsTargetPct ?? (isNaN(savedSavingsPct) ? 20 : savedSavingsPct);

  const savedInvestPct = hasLocalStorage ? parseFloat(localStorage.getItem('cashflow_investment_target_pct') || '20') : 20;
  const investmentTargetPct = options?.investmentTargetPct ?? (isNaN(savedInvestPct) ? 20 : savedInvestPct);

  const totalSavingsPct = Math.min(80, Math.max(0, savingsTargetPct + investmentTargetPct));
  const targetSavingsAmount = Math.round(baselineIncome * (totalSavingsPct / 100));

  const incomeDerivedLivingBudget = Math.max(800, baselineIncome - targetSavingsAmount);
  const explicitMonthlyCap = options?.monthlyBudgetCap ?? profile?.monthlyBudgetCap ?? null;
  const targetLivingBudget =
    explicitMonthlyCap && explicitMonthlyCap > 0
      ? Math.min(incomeDerivedLivingBudget, explicitMonthlyCap)
      : incomeDerivedLivingBudget;

  // 2. Aggregate Historical Spending AND Current Month Domestic Spending by Category
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
    // Quarantine foreign trip expenses so vacation spending doesn't skew domestic monthly category caps
    if (isTripQuarantinedExpense(t)) return;

    const cat = normalizeToCanonicalCategory(t.category || 'Other', 'Expense', t.description);
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

  const completedLedgerMonths = Array.from(allObservedMonths)
    .filter((m) => m < currentMonthPrefix)
    .sort()
    .slice(-6);
  const referenceMonths =
    completedLedgerMonths.length > 0
      ? completedLedgerMonths
      : Array.from(allObservedMonths).sort().slice(-6);
  const totalLedgerMonthsCount = Math.max(1, referenceMonths.length);

  const { totalCommittedByCategory, unpaidReserveByCategory } = getCategoryCommitmentBreakdown(
    validTxs,
    currentMonthPrefix,
    { referenceDate: now }
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

  // 4. Generate Normal Monthly Caps (respecting lockedCaps if set by user!)
  const suggestions: IntelligentCapSuggestion[] = [];
  let committedCapsSum = 0;

  const applyLockIfSet = (cat: string, computedCap: number): number => {
    if (locked[cat]) {
      return resolveCategoryCapValue(cat, currentCaps, computedCap);
    }
    return computedCap;
  };

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
  insuranceCap = applyLockIfSet('Insurance', Math.max(insuranceCap, insuranceStats.requiredThisMonthFloor));
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
    isLocked: Boolean(locked['Insurance']),
  });

  // Tier B: Quasi-Fixed Housing & Bills
  const housingStats = statsMap.get('Housing & Bills')!;
  let housingCap = 500;
  if (housingStats.activeSampleCount > 0) {
    const baseHousing = Math.max(housingStats.avgAcrossAllMonths, housingStats.activeMonthMedian * 0.9);
    housingCap = Math.max(300, Math.round((baseHousing * 1.08) / 10) * 10);
  }
  housingCap = applyLockIfSet('Housing & Bills', Math.max(housingCap, housingStats.requiredThisMonthFloor));
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
    isLocked: Boolean(locked['Housing & Bills']),
  });

  // Tier C: Commute & Transport Trend
  const transportStats = statsMap.get('Transport')!;
  let transportCap = 150;
  if (transportStats.activeSampleCount > 0) {
    transportCap = Math.max(80, Math.round(transportStats.activeMonthMedian / 10) * 10);
  }
  transportCap = applyLockIfSet('Transport', Math.max(transportCap, transportStats.requiredThisMonthFloor));
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
    isLocked: Boolean(locked['Transport']),
  });

  // Parents support
  const parentsStats = statsMap.get('Parents')!;
  let parentsCap = 0;
  if (parentsStats.activeSampleCount > 0 || parentsStats.requiredThisMonthFloor > 0) {
    const baseParents =
      parentsStats.activeSampleCount > 0 ? Math.round(parentsStats.activeMonthMedian / 50) * 50 : 0;
    parentsCap = Math.max(baseParents, parentsStats.requiredThisMonthFloor);
  }
  parentsCap = applyLockIfSet('Parents', parentsCap);
  committedCapsSum += parentsCap;
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
    isLocked: Boolean(locked['Parents']),
  });

  // Health baseline
  const healthStats = statsMap.get('Health')!;
  let healthCap = 100;
  if (healthStats.activeSampleCount > 0) {
    healthCap = Math.max(50, Math.round(healthStats.avgAcrossAllMonths / 10) * 10);
  }
  healthCap = applyLockIfSet('Health', Math.max(healthCap, healthStats.requiredThisMonthFloor));
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
    isLocked: Boolean(locked['Health']),
  });

  // Education baseline
  const educationStats = statsMap.get('Education')!;
  let educationCap = 100;
  if (educationStats.activeSampleCount > 0) {
    educationCap = Math.max(50, Math.round(educationStats.avgAcrossAllMonths / 10) * 10);
  }
  educationCap = applyLockIfSet('Education', Math.max(educationCap, educationStats.requiredThisMonthFloor));
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
    isLocked: Boolean(locked['Education']),
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
    const avg = st && st.avgAcrossAllMonths > 0 ? st.avgAcrossAllMonths : fallbackDefault;
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
  const suggestedFoodCap = applyLockIfSet(
    'Food & Dining',
    Math.max(baseSuggestedFoodCap, foodStats.requiredThisMonthFloor)
  );

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
    isLocked: Boolean(locked['Food & Dining']),
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
    const allocated = applyLockIfSet(cat, Math.max(baseAllocated, st.requiredThisMonthFloor));

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
      isLocked: Boolean(locked[cat]),
    });
  });

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
    if (!s.isLocked && st.requiredThisMonthFloor > normalWithoutSpike) {
      s.rebalancedDelta = st.requiredThisMonthFloor - normalWithoutSpike;
    }
    preTrimCapMap.set(s.category, s.suggestedCap);
  }

  // 6. Strict Hard Constraint + Dynamic Cross-Category Rebalancing (NEVER trimming locked categories!)
  const currentTotal = suggestions.reduce((sum, s) => sum + s.suggestedCap, 0);
  if (currentTotal > targetLivingBudget) {
    let excess = currentTotal - targetLivingBudget;
    const byCategory = new Map(suggestions.map((s) => [s.category, s]));

    // Pass 1: Trim unspent/unreserved slack from UNLOCKED discretionary categories
    const discretionaryTrimOrder = ['Other', 'Gift', 'Entertainment', 'Shopping', 'Sport', 'Food & Dining'];
    while (excess > 0) {
      let trimmedAny = false;
      for (const catName of discretionaryTrimOrder) {
        if (locked[catName]) continue;
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

    // Pass 2: Trim UNLOCKED quasi-fixed and trend categories (Transport -> Education -> Health)
    if (excess > 0) {
      const flexibleTrimOrder = ['Transport', 'Education', 'Health'];
      for (const catName of flexibleTrimOrder) {
        if (locked[catName]) continue;
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

    // Pass 3: Trim any remaining unspent/unreserved slack in UNLOCKED categories down to exact `requiredThisMonthFloor`
    if (excess > 0) {
      for (const catName of REBALANCE_DONOR_ORDER) {
        if (locked[catName]) continue;
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

    // Pass 4: Final mathematical guarantee across UNLOCKED categories
    if (excess > 0) {
      for (const catName of REBALANCE_DONOR_ORDER) {
        if (locked[catName]) continue;
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

    for (const s of suggestions) {
      const beforeTrim = preTrimCapMap.get(s.category) ?? s.suggestedCap;
      if (s.suggestedCap < beforeTrim && !s.rebalancedDelta) {
        s.rebalancedDelta = s.suggestedCap - beforeTrim;
      }
    }
  }

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
 * All other categories (and any foreign-currency / trip-tagged expense) are lump-sum or trip-quarantined buckets.
 */
export function isDailyCategory(category?: string): boolean {
  if (!category || !category.trim()) return false;
  const trimmed = category.trim();
  const normalized = trimmed.toLowerCase();
  if (normalized === 'food & dining' || normalized === 'food') return true;
  return normalizeToCanonicalCategory(trimmed, 'Expense') === 'Food & Dining';
}

/**
 * Determines whether an expense belongs to a monthly-capped or trip-quarantined bucket
 * rather than a domestic daily variable burn-rate routine.
 */
export function isLumpSumExpense(
  category: string,
  _amount?: number,
  txContext?: GenericTransaction | null
): boolean {
  if (txContext && isTripQuarantinedExpense(txContext)) {
    return true;
  }
  return !isDailyCategory(category);
}

/**
 * Scales or trims a record of category caps so that their sum is strictly <= maxLivingBudget (Income - Savings).
 * Strictly preserves explicit 0 caps and user-locked caps (`lockedCaps`).
 */
export interface BudgetCategoryRowItem {
  category: string;
  cap: number;
  spent: number;
  unpaidBillReserve: number;
  unreservedRemaining: number;
  spentPercent: number;
  reservePercent: number;
  dailyAllowance: number;
  isDailyCategory: boolean;
  isLocked: boolean;
  isOverCap: boolean;
  unpaidBills: Array<{ name: string; amount: number; kind: 'recurring' | 'installment' }>;
}

/**
 * Always returns all 12 canonical expense categories (plus any custom category in caps/transactions)
 * so the Budget Page NEVER hides unspent categories (like Housing & Bills, Insurance, Transport)
 * at the start of the month!
 */
export function getAllBudgetCategoryRows(
  currentMonthTransactions: GenericTransaction[] = [],
  options?: {
    caps?: Record<string, number>;
    lockedCaps?: Record<string, boolean>;
    targetMonth?: string;
    referenceDate?: Date;
  }
): BudgetCategoryRowItem[] {
  const now = options?.referenceDate || new Date();
  const todayMonthPrefix = getLocalDateString(now).slice(0, 7);
  const requestedTarget = options?.targetMonth;
  const isYearMode = Boolean(requestedTarget && /^year-\d{4}$/.test(requestedTarget));
  const isAllTime = requestedTarget === 'all';
  const validTxs = Array.isArray(currentMonthTransactions) ? currentMonthTransactions : [];

  const monthFilter =
    isYearMode || isAllTime
      ? null
      : resolveEffectiveMonthFilter(validTxs, todayMonthPrefix, requestedTarget);
  const effectivePeriod =
    requestedTarget && (isYearMode || isAllTime)
      ? requestedTarget
      : monthFilter || todayMonthPrefix;
  const daysInfo = isAllTime
    ? {
        year: now.getFullYear(),
        month: 0,
        todayDate: 0,
        totalDays: 0,
        daysRemaining: 0,
        isCurrentMonth: false,
        isPastMonth: false,
        isYearView: false,
      }
    : getMonthDaysInfo(effectivePeriod, now);

  const savedCaps = options?.caps
    ? normalizeCategoryCapsRecord(options.caps, true, false)
    : getSavedCategoryCaps();
  const rawLocked = options?.lockedCaps || getLockedCategoryCaps();
  const locked: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(rawLocked || {})) {
    if (v === true) locked[normalizeToCanonicalCategory(k, 'Expense')] = true;
  }

  const { unpaidReserveByCategory, unpaidItemsByCategory } = getCategoryCommitmentBreakdown(
    validTxs,
    effectivePeriod,
    { referenceDate: now }
  );

  const yearPrefix = isYearMode && requestedTarget ? requestedTarget.replace('year-', '') : '';
  const capMultiplier = isYearMode ? 12 : isAllTime ? countActiveBudgetMonths(validTxs) : 1;

  const spentByCat = new Map<string, number>();
  for (const t of validTxs) {
    if (String(t?.type || '').toLowerCase() !== 'expense' || t?.id === 'tx_sample' || !t?.date) continue;
    if (isYearMode) {
      if (!t.date.startsWith(yearPrefix)) continue;
    } else if (!isAllTime && monthFilter && t.date.length >= 7 && !t.date.startsWith(monthFilter)) {
      continue;
    }
    if (isTripQuarantinedExpense(t)) continue;
    const cat = normalizeToCanonicalCategory(t.category || 'Other', 'Expense', t.description);
    const amt = getAmountInBaseCurrency(t.amount || 0, t.currency, t.baseAmount);
    if (amt > 0) {
      spentByCat.set(cat, (spentByCat.get(cat) || 0) + amt);
    }
  }

  const allCategoryNames = Array.from(
    new Set([
      ...CANONICAL_EXPENSE_CATEGORIES,
      ...Object.keys(savedCaps).map((c) => normalizeToCanonicalCategory(c, 'Expense')),
      ...Array.from(spentByCat.keys()),
      ...Array.from(unpaidReserveByCategory.keys()),
    ])
  );

  const rows: BudgetCategoryRowItem[] = allCategoryNames.map((category) => {
    const baseCap = resolveCategoryCapValue(category, savedCaps, DEFAULT_CATEGORY_CAPS[category] ?? 50);
    const cap = Number((baseCap * capMultiplier).toFixed(2));
    const spent = Number((spentByCat.get(category) || 0).toFixed(2));
    const unpaidBillReserve = Number((unpaidReserveByCategory.get(category) || 0).toFixed(2));
    const unreservedRemaining = Number(Math.max(0, cap - spent - unpaidBillReserve).toFixed(2));
    const spentPercent = cap > 0 ? Math.min(100, Number(((spent / cap) * 100).toFixed(1))) : spent > 0 ? 100 : 0;
    const reservePercent =
      cap > 0
        ? Math.min(Math.max(0, 100 - spentPercent), Number(((unpaidBillReserve / cap) * 100).toFixed(1)))
        : 0;
    const dailyAllowance =
      daysInfo.daysRemaining > 0 ? Number((unreservedRemaining / daysInfo.daysRemaining).toFixed(2)) : 0;

    return {
      category,
      cap,
      spent,
      unpaidBillReserve,
      unreservedRemaining,
      spentPercent,
      reservePercent,
      dailyAllowance,
      isDailyCategory: isDailyCategory(category),
      isLocked: Boolean(locked[category]),
      isOverCap: cap > 0 ? spent + unpaidBillReserve > cap : spent + unpaidBillReserve > 0,
      unpaidBills: unpaidItemsByCategory.get(category) || [],
    };
  });

  // Sort order:
  // 1. Categories with active spend or unpaid bill reserves (or Food & Dining / Housing & Bills)
  // 2. Categories with positive cap > 0
  // 3. Categories explicitly set to cap === 0 and spent === 0 at the bottom
  const priorityOrder: Record<string, number> = {
    'Food & Dining': 1,
    'Housing & Bills': 2,
    Transport: 3,
    Sport: 4,
    Insurance: 5,
    Shopping: 6,
    Parents: 7,
    Health: 8,
    Entertainment: 9,
    Education: 10,
    Gift: 11,
    Other: 12,
  };

  return rows.sort((a, b) => {
    const aActive = a.spent > 0 || a.unpaidBillReserve > 0 ? 1 : 0;
    const bActive = b.spent > 0 || b.unpaidBillReserve > 0 ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    const aHasCap = a.cap > 0 ? 1 : 0;
    const bHasCap = b.cap > 0 ? 1 : 0;
    if (aHasCap !== bHasCap) return bHasCap - aHasCap;
    return (priorityOrder[a.category] ?? 99) - (priorityOrder[b.category] ?? 99);
  });
}

/**
 * Scales or trims a record of category caps so that their sum is strictly <= maxLivingBudget (Income - Savings)
 * WITHOUT blindly slashing Food & Dining (e.g. down to RM 663!) or active Sport habits!
 * Uses Priority Waterfall Trimming:
 * 1. Trims idle/optional categories (`Other`, `Gift`, `Education`, `Entertainment`, `Health`) first.
 * 2. Protects `Food & Dining` (at >= RM 900 when living budget >= RM 1,800) and `Sport` (at >= RM 150) until all non-essential slack is exhausted.
 * 3. Strictly preserves explicit 0 caps, user-locked caps (`lockedCaps`), and clean RM 10 multiples.
 */
export function fitCapsToLivingBudget(
  caps: Record<string, number>,
  maxLivingBudget: number,
  lockedCaps?: Record<string, boolean>,
  currentMonthTransactions: GenericTransaction[] = [],
  referenceDate?: Date
): Record<string, number> {
  const rawLocked = lockedCaps || getLockedCategoryCaps();
  const locked: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(rawLocked || {})) {
    if (v === true) locked[normalizeToCanonicalCategory(k, 'Expense')] = true;
  }

  const mergedInput = normalizeCategoryCapsRecord(caps, true, false);
  const result: Record<string, number> = {};
  const keys = Object.keys(mergedInput);

  // Compute current month spent + unpaid bill reserves so Auto-Fit never cuts below what you already spent!
  const currentMonthPrefix = getLocalDateString(referenceDate).slice(0, 7);
  const { unpaidReserveByCategory } = getCategoryCommitmentBreakdown(
    currentMonthTransactions,
    currentMonthPrefix,
    { referenceDate }
  );
  const spentByCat = new Map<string, number>();
  for (const t of Array.isArray(currentMonthTransactions) ? currentMonthTransactions : []) {
    if (String(t?.type || '').toLowerCase() !== 'expense' || t?.id === 'tx_sample') continue;
    if (t?.date && t.date.length >= 7 && !t.date.startsWith(currentMonthPrefix)) continue;
    if (isTripQuarantinedExpense(t)) continue;
    const cat = normalizeToCanonicalCategory(t.category || 'Other', 'Expense', t.description);
    const amt = getAmountInBaseCurrency(t.amount || 0, t.currency, t.baseAmount);
    if (amt > 0) spentByCat.set(cat, (spentByCat.get(cat) || 0) + amt);
  }

  keys.forEach((cat) => {
    const val = Number(mergedInput[cat]);
    const cleanVal = Number.isFinite(val) && val >= 0 ? Math.round(val / 10) * 10 : 0;
    const floorNeeded = Math.ceil(((spentByCat.get(cat) || 0) + (unpaidReserveByCategory.get(cat) || 0)) / 10) * 10;
    result[cat] = locked[cat] ? (Number.isFinite(val) && val >= 0 ? val : 0) : Math.max(cleanVal, floorNeeded);
  });

  // If Food & Dining was previously squashed (e.g. RM 663) and not locked, restore its healthy target before fitting
  if (!locked['Food & Dining'] && result['Food & Dining'] > 0 && result['Food & Dining'] < 900 && maxLivingBudget >= 1800) {
    result['Food & Dining'] = 900;
  }
  if (!locked['Sport'] && result['Sport'] > 0 && result['Sport'] < 150 && (spentByCat.get('Sport') || 0) > 0) {
    result['Sport'] = Math.max(150, result['Sport']);
  }

  const currentSum = Object.values(result).reduce((sum, v) => sum + v, 0);
  if (currentSum <= maxLivingBudget && currentSum > 0) return result;

  let excess = currentSum - maxLivingBudget;

  // Protected floors for each category during Priority Waterfall Trimming:
  const getProtectedFloor = (cat: string, stage: 1 | 2 | 3): number => {
    const hardSpendFloor = Math.ceil(((spentByCat.get(cat) || 0) + (unpaidReserveByCategory.get(cat) || 0)) / 10) * 10;
    if (stage === 1) {
      // Stage 1: Protect Food & Dining, Sport, Transport, Housing & Bills, Insurance; cut idle optional buckets down to hardSpendFloor
      if (cat === 'Food & Dining') return Math.max(hardSpendFloor, maxLivingBudget >= 1800 ? 900 : 650);
      if (cat === 'Sport') return Math.max(hardSpendFloor, 150);
      if (cat === 'Transport') return Math.max(hardSpendFloor, 150);
      if (cat === 'Housing & Bills') return Math.max(hardSpendFloor, 400);
      if (cat === 'Insurance') return Math.max(hardSpendFloor, 150);
      if (cat === 'Shopping') return Math.max(hardSpendFloor, 80);
      return hardSpendFloor; // Other, Gift, Education, Entertainment, Health, Parents can be trimmed to hardSpendFloor (0 if unspent)
    }
    if (stage === 2) {
      // Stage 2: Trim uncommitted Insurance / Housing / Shopping / Transport slack before touching Food & Dining or Sport
      if (cat === 'Food & Dining') return Math.max(hardSpendFloor, maxLivingBudget >= 1800 ? 850 : 600);
      if (cat === 'Sport') return Math.max(hardSpendFloor, 120);
      return hardSpendFloor;
    }
    // Stage 3: Final mathematical guarantee down to hardSpendFloor (or 0 if budget is tiny)
    return 0;
  };

  const trimPass = (order: string[], stage: 1 | 2 | 3) => {
    for (const cat of order) {
      if (locked[cat] || excess <= 0) continue;
      if (!(cat in result)) continue;
      const floor = getProtectedFloor(cat, stage);
      if (result[cat] > floor) {
        const availableCut = result[cat] - floor;
        const cut = Math.min(availableCut, Math.ceil(excess / 10) * 10);
        const actualCut = Math.min(availableCut, cut);
        result[cat] = Math.max(floor, result[cat] - actualCut);
        excess = Object.values(result).reduce((s, v) => s + v, 0) - maxLivingBudget;
      }
    }
  };

  // Stage 1: Trim idle optional categories first
  trimPass(
    ['Other', 'Gift', 'Education', 'Entertainment', 'Health', 'Parents', 'Shopping'],
    1
  );

  // Stage 2: Trim uncommitted fixed/trend slack if still over maxLivingBudget
  if (excess > 0) {
    trimPass(
      ['Insurance', 'Shopping', 'Transport', 'Housing & Bills', 'Sport', 'Food & Dining'],
      2
    );
  }

  // Stage 3: Final guarantee so sum is strictly <= maxLivingBudget
  if (excess > 0) {
    trimPass(
      [
        'Other',
        'Gift',
        'Education',
        'Entertainment',
        'Health',
        'Parents',
        'Insurance',
        'Shopping',
        'Transport',
        'Housing & Bills',
        'Sport',
        'Food & Dining',
      ],
      3
    );
  }

  return result;
}

/**
 * Dynamically predicts month-end savings and investments while quarantining foreign/trip-tagged
 * travel expenses (`tripQuarantinedSpent`) so vacation spending never contaminates domestic daily food burn rate!
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
  const hasLocalStorage = typeof window !== 'undefined' || typeof localStorage !== 'undefined';
  const profile = hasLocalStorage ? getUserMoneyProfile() : null;

  const savedIncome = hasLocalStorage ? parseFloat(localStorage.getItem('cashflow_baseline_income') || '0') : 0;
  const baselineIncome =
    options?.baselineIncome || (savedIncome > 0 ? savedIncome : profile?.baselineIncome ?? 3000);

  const savedSavingsPct = hasLocalStorage ? parseFloat(localStorage.getItem('cashflow_savings_target_pct') || '20') : 20;
  const savingsTargetPct = options?.savingsTargetPct ?? (isNaN(savedSavingsPct) ? 20 : savedSavingsPct);

  const savedInvestPct = hasLocalStorage ? parseFloat(localStorage.getItem('cashflow_investment_target_pct') || '20') : 20;
  const investmentTargetPct = options?.investmentTargetPct ?? (isNaN(savedInvestPct) ? 20 : savedInvestPct);

  const totalSavingsTargetPct = Math.min(90, Math.max(0, savingsTargetPct + investmentTargetPct));
  const targetSavingsAmount = Math.round(baselineIncome * (savingsTargetPct / 100));
  const targetInvestmentAmount = Math.round(baselineIncome * (investmentTargetPct / 100));
  const totalTargetSavings = targetSavingsAmount + targetInvestmentAmount;
  const targetLivingBudget = Math.max(0, baselineIncome - totalTargetSavings);

  const refNow = options?.referenceDate || new Date();
  const fallbackTodayMonth = getLocalDateString(refNow).slice(0, 7);
  const explicitSingleMonth =
    options?.selectedMonth && /^\d{4}-\d{2}$/.test(options.selectedMonth)
      ? options.selectedMonth
      : undefined;
  const validTxs = Array.isArray(currentMonthTransactions) ? currentMonthTransactions : [];
  const monthFilter = resolveEffectiveMonthFilter(validTxs, fallbackTodayMonth, explicitSingleMonth);
  const effectiveMonth = explicitSingleMonth || monthFilter || fallbackTodayMonth;

  const daysInfo = getMonthDaysInfo(effectiveMonth, options?.referenceDate);
  const totalDaysInMonth = daysInfo.totalDays || 30;
  const todayDate = options?.referenceDate ? options.referenceDate.getDate() : daysInfo.todayDate || 1;
  const daysPassed = Math.max(1, Math.min(totalDaysInMonth, todayDate));
  const daysRemaining = Math.max(0, totalDaysInMonth - daysPassed);

  let lumpSumSpent = 0;
  let dailyVariableSpent = 0;
  let tripQuarantinedSpent = 0;

  validTxs.forEach((t) => {
    if (String(t.type || '').toLowerCase() !== 'expense' || t.id === 'tx_sample') return;
    if (monthFilter && t.date && t.date.length >= 7 && !t.date.startsWith(monthFilter)) return;

    const amt = getAmountInBaseCurrency(t.amount || 0, t.currency, t.baseAmount);
    if (amt <= 0) return;

    // Pillar 2: Quarantine trip-tagged expenses from domestic daily living burn rate!
    if (isTripQuarantinedExpense(t)) {
      tripQuarantinedSpent += amt;
      return;
    }

    const cat = normalizeToCanonicalCategory(t.category || 'Other', 'Expense', t.description);
    if (isLumpSumExpense(cat, amt, t)) {
      lumpSumSpent += amt;
    } else {
      dailyVariableSpent += amt;
    }
  });

  lumpSumSpent = Number(lumpSumSpent.toFixed(2));
  dailyVariableSpent = Number(dailyVariableSpent.toFixed(2));
  tripQuarantinedSpent = Number(tripQuarantinedSpent.toFixed(2));
  const spentSoFar = Number((lumpSumSpent + dailyVariableSpent).toFixed(2));

  const { unpaidReserveByCategory } = getCategoryCommitmentBreakdown(validTxs, effectiveMonth, {
    referenceDate: options?.referenceDate,
  });
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
    tripQuarantinedSpent,
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
 * Pillar 1.2: Computes the Payday Settlement Auto-Envelope Plan when `cyclePhase === 'payday_settlement'`
 * and a Salary/Income transaction (>= 80% of baseline income) is recorded this month.
 */
export function computePaydaySettlementEnvelope(
  currentMonthTransactions: GenericTransaction[] = [],
  options?: {
    paydayDay?: number;
    baselineIncome?: number;
    savingsTargetPct?: number;
    investmentTargetPct?: number;
    referenceDate?: Date;
  }
): PaydayEnvelopeAllocationPlan {
  const now = options?.referenceDate || new Date();
  const todayStr = getLocalDateString(now);
  const defaultMonthPrefix = todayStr.slice(0, 7);
  const validTxs = Array.isArray(currentMonthTransactions) ? currentMonthTransactions : [];
  const monthFilter = resolveEffectiveMonthFilter(validTxs, defaultMonthPrefix);

  const hasLocalStorage = typeof window !== 'undefined' || typeof localStorage !== 'undefined';
  const profile = hasLocalStorage ? getUserMoneyProfile() : null;
  const rawPayday = options?.paydayDay ?? profile?.paydayDay ?? 25;
  const daysInfo = getMonthDaysInfo(undefined, now);
  const todayDate = now.getDate();
  const effectivePaydayInThisMonth = Math.min(Math.max(1, rawPayday), daysInfo.totalDays);

  const daysInPrevMonth = new Date(daysInfo.year, daysInfo.month - 1, 0).getDate();
  const prevPaydayClamped = Math.min(Math.max(1, rawPayday), daysInPrevMonth);
  const daysSincePayday =
    todayDate >= effectivePaydayInThisMonth
      ? todayDate - effectivePaydayInThisMonth
      : todayDate + (daysInPrevMonth - prevPaydayClamped);
  const isPaydayWeek = daysSincePayday >= 0 && daysSincePayday <= 6;
  const cyclePhase: 'living_phase' | 'payday_settlement' = isPaydayWeek ? 'payday_settlement' : 'living_phase';

  const savedIncome = hasLocalStorage ? parseFloat(localStorage.getItem('cashflow_baseline_income') || '0') : 0;
  const baselineIncome =
    options?.baselineIncome || (savedIncome > 0 ? savedIncome : profile?.baselineIncome ?? 3000);

  const savedSavingsPct = hasLocalStorage ? parseFloat(localStorage.getItem('cashflow_savings_target_pct') || '20') : 20;
  const savingsTargetPct = options?.savingsTargetPct ?? (isNaN(savedSavingsPct) ? 20 : savedSavingsPct);

  const savedInvestPct = hasLocalStorage ? parseFloat(localStorage.getItem('cashflow_investment_target_pct') || '20') : 20;
  const investmentTargetPct = options?.investmentTargetPct ?? (isNaN(savedInvestPct) ? 20 : savedInvestPct);

  let salaryRecordedThisMonth = 0;
  let alreadySavedThisMonth = 0;
  let alreadyInvestedThisMonth = 0;

  for (const t of validTxs) {
    if (monthFilter && t?.date && t.date.length >= 7 && !t.date.startsWith(monthFilter)) continue;
    const typeLower = String(t?.type || '').toLowerCase();
    const cat = String(t?.category || '');
    const subLower = String(t?.subCategory || '').toLowerCase();
    const amt = getAmountInBaseCurrency(t?.amount || 0, t?.currency, t?.baseAmount);
    if (amt <= 0) continue;

    // Exclude dividend accruals from regular salary income detection
    const isDividend =
      cat === 'Investment Return' ||
      subLower === 'dividend' ||
      subLower === 'reinvest' ||
      /dividend|asnb|distribution|股息|分红|派息/i.test(String(t?.description || ''));

    if (typeLower === 'income' && !isDividend) {
      salaryRecordedThisMonth += amt;
    }

    if (subLower !== 'sell') {
      if (
        cat === 'Stocks & Crypto' ||
        cat === 'ASNB / Unit Trust' ||
        (typeLower === 'investment' && !cat.includes('Savings') && cat !== 'Fixed Deposit')
      ) {
        alreadyInvestedThisMonth += amt;
      } else if (
        cat === 'Emergency Savings' ||
        cat === 'Fixed Deposit' ||
        cat === 'EPF / KWSP' ||
        cat === 'Other Savings'
      ) {
        alreadySavedThisMonth += amt;
      }
    }
  }

  const effectiveBaseForSplit = salaryRecordedThisMonth >= baselineIncome ? salaryRecordedThisMonth : baselineIncome;
  const plannedSavingsAmount = Math.round(effectiveBaseForSplit * (savingsTargetPct / 100));
  const plannedInvestmentAmount = Math.round(effectiveBaseForSplit * (investmentTargetPct / 100));

  const remainingToSave = Math.max(0, Math.round(plannedSavingsAmount - alreadySavedThisMonth));
  const remainingToInvest = Math.max(0, Math.round(plannedInvestmentAmount - alreadyInvestedThisMonth));

  const proposedTransfers: PaydayEnvelopeTransferItem[] = [];
  const activeMonth = monthFilter || defaultMonthPrefix;

  if (remainingToSave > 0) {
    proposedTransfers.push({
      id: `tx_payday_sav_${activeMonth}`,
      type: 'Investment',
      category: 'Emergency Savings',
      subCategory: 'Payday Auto-Envelope',
      description: `Payday Savings Envelope (${savingsTargetPct}%)`,
      amount: remainingToSave,
      currency: 'MYR',
      date: todayStr,
      notes: `[PaydayEnvelope:${activeMonth}] Automated ${savingsTargetPct}% salary savings allocation`,
    });
  }

  if (remainingToInvest > 0) {
    proposedTransfers.push({
      id: `tx_payday_inv_${activeMonth}`,
      type: 'Investment',
      category: 'Stocks & Crypto',
      subCategory: 'Payday Auto-Envelope',
      description: `Payday Investment Envelope (${investmentTargetPct}%)`,
      amount: remainingToInvest,
      currency: 'MYR',
      date: todayStr,
      notes: `[PaydayEnvelope:${activeMonth}] Automated ${investmentTargetPct}% salary investment allocation`,
    });
  }

  const hasQualifyingSalary = salaryRecordedThisMonth >= baselineIncome * 0.8;
  const shouldPrompt =
    cyclePhase === 'payday_settlement' &&
    hasQualifyingSalary &&
    proposedTransfers.length > 0;

  const totalPct = savingsTargetPct + investmentTargetPct;
  const headline = shouldPrompt
    ? `💰 Salary of RM ${salaryRecordedThisMonth.toLocaleString()} detected! Allocate your ${totalPct}% Payday Envelope?`
    : proposedTransfers.length === 0
    ? `✅ Payday Envelope Complete (RM ${(alreadySavedThisMonth + alreadyInvestedThisMonth).toLocaleString()} allocated)`
    : `Payday Envelope Preview (${totalPct}% target)`;

  const summaryText = shouldPrompt
    ? `1-tap transfer of RM ${remainingToSave.toLocaleString()} to Emergency Savings (${savingsTargetPct}%) and RM ${remainingToInvest.toLocaleString()} to Stocks & Crypto (${investmentTargetPct}%) to lock in your monthly wealth goal.`
    : proposedTransfers.length === 0
    ? `Your planned savings and investment envelopes for ${activeMonth} are fully funded.`
    : `Planned envelope: RM ${remainingToSave.toLocaleString()} savings + RM ${remainingToInvest.toLocaleString()} investments.`;

  return {
    shouldPrompt,
    salaryRecordedThisMonth: Number(salaryRecordedThisMonth.toFixed(2)),
    baselineIncome,
    cyclePhase,
    savingsTargetPct,
    investmentTargetPct,
    plannedSavingsAmount,
    plannedInvestmentAmount,
    alreadySavedThisMonth: Number(alreadySavedThisMonth.toFixed(2)),
    alreadyInvestedThisMonth: Number(alreadyInvestedThisMonth.toFixed(2)),
    remainingToSave,
    remainingToInvest,
    proposedTransfers,
    headline,
    summaryText,
  };
}

/**
 * Solves Payday Cycle timing across any payday day (1-31), including wrap-around into next month
 * and attaches `envelopePlan` for 1-tap Payday Settlement allocation.
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
  const hasLocalStorage = typeof window !== 'undefined' || typeof localStorage !== 'undefined';
  const profile = hasLocalStorage ? getUserMoneyProfile() : null;

  const rawPayday = options?.paydayDay ?? profile?.paydayDay ?? 25;
  const effectivePaydayInThisMonth = Math.min(Math.max(1, rawPayday), daysInfo.totalDays);

  const savedIncome = hasLocalStorage ? parseFloat(localStorage.getItem('cashflow_baseline_income') || '0') : 0;
  const baselineIncome =
    options?.baselineIncome || (savedIncome > 0 ? savedIncome : profile?.baselineIncome ?? 3000);

  const savedSavingsPct = hasLocalStorage ? parseFloat(localStorage.getItem('cashflow_savings_target_pct') || '20') : 20;
  const savingsTargetPct = options?.savingsTargetPct ?? (isNaN(savedSavingsPct) ? 20 : savedSavingsPct);

  const savedInvestPct = hasLocalStorage ? parseFloat(localStorage.getItem('cashflow_investment_target_pct') || '20') : 20;
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
    if (String(t.subCategory || '').toLowerCase() === 'sell') return acc;
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
    if (isTripQuarantinedExpense(t)) return acc;
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

  const envelopePlan = computePaydaySettlementEnvelope(validTxs, {
    paydayDay: rawPayday,
    baselineIncome,
    savingsTargetPct,
    investmentTargetPct,
    referenceDate: now,
  });

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
    envelopePlan,
  };
}

/**
 * Computes real-time in-context category budget feedback.
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
  const canonicalCategory = normalizeToCanonicalCategory(category || 'Other', 'Expense');
  const currentCaps = caps ? normalizeCategoryCapsRecord(caps, false, false) : getSavedCategoryCaps();
  const cap = resolveCategoryCapValue(canonicalCategory, currentCaps, 500);
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
    if (isTripQuarantinedExpense(t)) return;

    const txCat = normalizeToCanonicalCategory(t.category || 'Other', 'Expense', t.description);
    if (txCat === canonicalCategory) {
      const amt = getAmountInBaseCurrency(t.amount || 0, t.currency, t.baseAmount);
      spentSoFar += amt;
      if (t.date === todayStr) {
        todaySpentInCategory += amt;
      }
    }
  });

  const { unpaidReserveByCategory, unpaidItemsByCategory } = getCategoryCommitmentBreakdown(validTxs, effectiveMonth, {
    referenceDate: now,
  });
  const committedReserve = Number((unpaidReserveByCategory.get(canonicalCategory) || 0).toFixed(2));
  const unpaidItems = unpaidItemsByCategory.get(canonicalCategory) || [];

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

  const dailyCat = isDailyCategory(canonicalCategory);
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
    billReserveNote = `📌 Bill Reserve in ${canonicalCategory}: RM ${committedReserve.toFixed(2)} reserved for upcoming bills (${names}) · Free unreserved balance: RM ${Math.max(0, unreservedRemainingAfter).toFixed(2)}.`;
  }

  let rebalanceSuggestion: CategoryRebalanceSuggestion | undefined;
  if (isOverCapAfter || unreservedRemainingAfter < 0) {
    rebalanceSuggestion = rebalanceCategoryCapsForSpending({
      currentMonthTransactions: validTxs,
      currentCaps,
      lockedCaps: options?.lockedCaps,
      maxLivingBudget: options?.maxLivingBudget,
      targetCategory: canonicalCategory,
      proposedAmount: validProposed,
      targetMonth: effectiveMonth,
      referenceDate: now,
    });
  }

  return {
    category: canonicalCategory,
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

// ---------------------------------------------------------------------------
// Unified Income Allocation & Dividend Accrual Isolation (Pillar 1 + Pillar 3.1)
// ---------------------------------------------------------------------------

export interface DividendAccrualSummary {
  dividendAccrualThisMonth: number;
  reinvestedDividendsThisMonth: number;
  cashDividendsThisMonth: number;
  ytdDividendTotal: number;
  recentDividendRecords: Array<{ date: string; description: string; amountMyr: number; isReinvested: boolean }>;
}

export interface UnifiedIncomeAllocation {
  baselineIncome: number;
  isIncomeAutoDetected: boolean;
  actualIncomeThisMonth: number;
  dividendAccrualThisMonth: number;
  reinvestedDividendsThisMonth: number;
  dividendSummary: DividendAccrualSummary;
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
 * Detects whether a transaction is a passive dividend / distribution (ASNB, Bursa/US Stock dividend, FD interest)
 * so it can be tracked under `Investment Return` and isolated from regular active salary income.
 */
export function isDividendOrDistributionTransaction(tx?: GenericTransaction | null): boolean {
  if (!tx) return false;
  const cat = String(tx.category || '').trim();
  const sub = String(tx.subCategory || '').trim().toUpperCase();
  const desc = String(tx.description || '').toLowerCase();
  const notes = String(tx.notes || '').toLowerCase();

  if (cat === 'Investment Return') return true;
  if (sub === 'DIVIDEND' || sub === 'REINVEST') return true;
  if (/\b(?:dividend|div|asnb\s*dist|distribution|coupon|fd\s*interest)\b|股息|分红|派息|利息收入/i.test(`${desc} ${notes}`)) {
    return true;
  }
  return false;
}

/**
 * Single Source of Truth for Income Allocation across Home (Money Cockpit), Income Advisor,
 * Budget Page, and Investment Page.
 * Isolates dividend accruals (`Investment Return`, `DIVIDEND`, `REINVEST`) so passive distributions
 * never artificially inflate regular monthly salary income or living budget caps!
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
  const hasLocalStorage = typeof window !== 'undefined' || typeof localStorage !== 'undefined';
  const profile = hasLocalStorage ? getUserMoneyProfile() : null;
  const now = options?.referenceDate || new Date();
  const currentMonthPrefix =
    options?.selectedMonth && /^\d{4}-\d{2}$/.test(options.selectedMonth)
      ? options.selectedMonth
      : getLocalDateString(now).slice(0, 7);
  const currentYearPrefix = currentMonthPrefix.slice(0, 4);

  const savedIncome = hasLocalStorage ? parseFloat(localStorage.getItem('cashflow_baseline_income') || '0') : 0;

  const validTxs = Array.isArray(allTransactions) ? allTransactions : [];
  const salaryByMonth = new Map<string, number>();
  let actualIncomeThisMonth = 0;
  let dividendAccrualThisMonth = 0;
  let reinvestedDividendsThisMonth = 0;
  let cashDividendsThisMonth = 0;
  let ytdDividendTotal = 0;
  const recentDividendRecords: DividendAccrualSummary['recentDividendRecords'] = [];

  for (const t of validTxs) {
    if (!t?.date || t.date.length < 7) continue;
    const typeLower = String(t.type || '').toLowerCase();
    const subUpper = String(t.subCategory || '').toUpperCase();
    const amt = getAmountInBaseCurrency(t.amount || 0, t.currency, t.baseAmount);
    if (amt <= 0) continue;
    const m = t.date.slice(0, 7);

    const isDiv = isDividendOrDistributionTransaction(t);
    if (isDiv && (typeLower === 'income' || typeLower === 'investment' || subUpper === 'DIVIDEND' || subUpper === 'REINVEST')) {
      const isReinvest =
        subUpper === 'REINVEST' ||
        /reinvest|再投资|复投|asnb/i.test(`${t.description || ''} ${t.notes || ''}`);
      if (t.date.startsWith(currentYearPrefix)) {
        ytdDividendTotal += amt;
      }
      if (m === currentMonthPrefix) {
        dividendAccrualThisMonth += amt;
        if (isReinvest) reinvestedDividendsThisMonth += amt;
        else cashDividendsThisMonth += amt;
      }
      recentDividendRecords.push({
        date: t.date.slice(0, 10),
        description: t.description || t.category || 'Dividend',
        amountMyr: Number(amt.toFixed(2)),
        isReinvested: isReinvest,
      });
      continue;
    }

    if (typeLower === 'income') {
      salaryByMonth.set(m, (salaryByMonth.get(m) || 0) + amt);
      if (m === currentMonthPrefix) {
        actualIncomeThisMonth += amt;
      }
    }
  }

  let autoDetectedIncome = 0;
  if (actualIncomeThisMonth > 0) {
    autoDetectedIncome = actualIncomeThisMonth;
  } else if (salaryByMonth.size > 0) {
    const vals = Array.from(salaryByMonth.values()).sort((a, b) => a - b);
    autoDetectedIncome = vals[Math.floor(vals.length / 2)];
  }

  const explicitIncome = options?.baselineIncome || (savedIncome > 0 ? savedIncome : profile?.baselineIncome || 0);
  const baselineIncome =
    explicitIncome > 0 ? explicitIncome : autoDetectedIncome > 0 ? Math.round(autoDetectedIncome) : 3000;
  const isIncomeAutoDetected = explicitIncome <= 0 && autoDetectedIncome > 0;

  const pred = predictMonthlySavingsAndInvestments(validTxs, {
    baselineIncome,
    savingsTargetPct: options?.savingsTargetPct,
    investmentTargetPct: options?.investmentTargetPct,
    selectedMonth: currentMonthPrefix,
    referenceDate: now,
  });

  let actualSavedThisMonth = 0;
  let actualInvestedThisMonth = reinvestedDividendsThisMonth;
  for (const t of validTxs) {
    if (!t?.date || !t.date.startsWith(currentMonthPrefix)) continue;
    if (isDividendOrDistributionTransaction(t)) continue;
    const subLower = String(t.subCategory || '').toLowerCase();
    if (subLower === 'sell') continue;
    const amt = getAmountInBaseCurrency(t.amount || 0, t.currency, t.baseAmount);
    if (amt <= 0) continue;

    const cat = t.category || '';
    const isInvestType = String(t.type || '').toLowerCase() === 'investment';
    if (
      cat === 'Stocks & Crypto' ||
      cat === 'ASNB / Unit Trust' ||
      (isInvestType && !cat.includes('Savings') && cat !== 'Fixed Deposit')
    ) {
      actualInvestedThisMonth += amt;
    } else if (
      cat === 'Emergency Savings' ||
      cat === 'Fixed Deposit' ||
      cat === 'EPF / KWSP' ||
      cat === 'Other Savings'
    ) {
      actualSavedThisMonth += amt;
    }
  }

  recentDividendRecords.sort((a, b) => b.date.localeCompare(a.date));

  return {
    baselineIncome,
    isIncomeAutoDetected,
    actualIncomeThisMonth: Number(actualIncomeThisMonth.toFixed(2)),
    dividendAccrualThisMonth: Number(dividendAccrualThisMonth.toFixed(2)),
    reinvestedDividendsThisMonth: Number(reinvestedDividendsThisMonth.toFixed(2)),
    dividendSummary: {
      dividendAccrualThisMonth: Number(dividendAccrualThisMonth.toFixed(2)),
      reinvestedDividendsThisMonth: Number(reinvestedDividendsThisMonth.toFixed(2)),
      cashDividendsThisMonth: Number(cashDividendsThisMonth.toFixed(2)),
      ytdDividendTotal: Number(ytdDividendTotal.toFixed(2)),
      recentDividendRecords: recentDividendRecords.slice(0, 10),
    },
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
 * (while respecting lockedCaps) so Home Page, Income Advisor, and Budget Page never diverge.
 */
export function saveUnifiedIncomeAllocation(params: {
  baselineIncome: number;
  savingsTargetPct: number;
  investmentTargetPct: number;
  allTransactions?: GenericTransaction[];
  lockedCaps?: Record<string, boolean>;
  autoRebalanceCategoryCaps?: boolean;
  referenceDate?: Date;
}): UnifiedIncomeAllocation {
  const income = Math.max(0, Math.round(Number(params.baselineIncome) || 0));
  const savPct = Math.min(80, Math.max(0, Number(params.savingsTargetPct) || 0));
  const invPct = Math.min(80 - savPct, Math.max(0, Number(params.investmentTargetPct) || 0));
  const targetLivingBudget = Math.max(500, Math.round(income * ((100 - savPct - invPct) / 100)));

  if (typeof window !== 'undefined' || typeof localStorage !== 'undefined') {
    try {
      const prevIncome = localStorage.getItem('cashflow_baseline_income');
      const prevSav = localStorage.getItem('cashflow_savings_target_pct');
      const prevInv = localStorage.getItem('cashflow_investment_target_pct');
      const prevBudget = localStorage.getItem('cashflow_monthly_budget');

      localStorage.setItem('cashflow_baseline_income', String(income));
      localStorage.setItem('cashflow_savings_target_pct', String(savPct));
      localStorage.setItem('cashflow_investment_target_pct', String(invPct));
      localStorage.setItem('cashflow_monthly_budget', String(targetLivingBudget));
      import('./cloud-settings-sync.ts')
        .then((mod) => {
          if (mod?.saveSettingWithCloudSync) {
            if (prevIncome !== String(income)) mod.saveSettingWithCloudSync('cashflow_baseline_income', String(income), { forceSync: true });
            if (prevSav !== String(savPct)) mod.saveSettingWithCloudSync('cashflow_savings_target_pct', String(savPct), { forceSync: true });
            if (prevInv !== String(invPct)) mod.saveSettingWithCloudSync('cashflow_investment_target_pct', String(invPct), { forceSync: true });
            if (prevBudget !== String(targetLivingBudget)) mod.saveSettingWithCloudSync('cashflow_monthly_budget', String(targetLivingBudget), { forceSync: true });
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
      lockedCaps: params.lockedCaps,
      monthlyBudgetCap: targetLivingBudget,
      referenceDate: params.referenceDate,
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
    referenceDate: params.referenceDate,
  });
}
