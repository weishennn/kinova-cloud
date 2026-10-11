import { saveSettingWithCloudSync } from './cloud-settings-sync';

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
  saveSettingWithCloudSync(STORAGE_KEY, JSON.stringify(caps));
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
