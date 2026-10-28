/**
 * User Money Profile & Personal Memory Engine for Kinova.
 *
 * Centralizes what Kinova knows about the user:
 * - Preferred language (zh, en, ms, auto)
 * - Payday day of month (1-31 or null)
 * - Auto-detected suggested payday from historical income patterns
 * - Monthly budget cap
 * - Baseline monthly income & emergency reserve
 * - User financial goals (up to 3)
 * - Rejected habit chips (suppressed for 30 days)
 * - Recent user actions (last 8 actions for context and undo)
 */

export const CLOUD_SYNC_KEYS = {
  INSTALLMENTS: 'cashflow_installment_plans',
  RECURRING: 'cashflow_recurring_commitments',
  CATEGORY_CAPS: 'cashflow_category_caps',
  LHDN_TAX_CAPS: 'cashflow_lhdn_tax_caps',
  LHDN_TAX_RATE: 'cashflow_lhdn_tax_rate',
  LHDN_TAX_PROFILE: 'cashflow_lhdn_tax_profile',
  MONTHLY_BUDGET: 'cashflow_monthly_budget',
  BASELINE_INCOME: 'cashflow_baseline_income',
  EMERGENCY_RESERVE: 'cashflow_emergency_reserve',
  CURRENCY: 'cashflow_currency',
} as const;

function saveProfileSetting(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(key, value);
    window.dispatchEvent(new CustomEvent('cashflow_cloud_settings_synced', { detail: { key, value } }));
  } catch (err) {
    console.error(`[UserProfile] Storage error for ${key}:`, err);
  }

  // Trigger cloud sync in browser
  try {
    import('./cloud-settings-sync.ts').then((mod) => {
      mod.saveSettingWithCloudSync(key, value);
    }).catch(() => {});
  } catch {}
}

export type ProfileLanguage = 'zh' | 'en' | 'ms' | 'auto';

export interface UserGoal {
  id: string;
  name: string;
  targetAmount: number;
  currentAmount?: number;
  targetDate?: string; // YYYY-MM-DD
}

export interface RejectedChip {
  text: string;
  rejectedAt: number; // Unix timestamp ms
}

export interface RecentAction {
  id: string;
  actionType: 'record' | 'edit' | 'delete' | 'undo';
  targetType: 'transaction' | 'trade' | 'installment' | 'preference';
  timestamp: number;
  summary: string;
  payload: Record<string, unknown>;
}

export interface UserMoneyProfile {
  language: ProfileLanguage;
  paydayDay: number | null;
  suggestedPayday: number | null;
  monthlyBudgetCap: number | null;
  baselineIncome: number | null;
  emergencyReserve: number | null;
  goals: UserGoal[];
  rejectedChips: RejectedChip[];
  recentActions: RecentAction[];
}

export const PROFILE_STORAGE_KEYS = {
  LANGUAGE: 'cashflow_preferred_language',
  PAYDAY_DAY: 'cashflow_payday_day',
  GOALS: 'cashflow_user_goals',
  REJECTED_CHIPS: 'cashflow_rejected_chips',
  RECENT_ACTIONS: 'cashflow_recent_actions',
} as const;

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Pure function: Detects if the user has a recurring payday.
 * Rule: If the same income day-of-month (±2 days) appears across 2 or more distinct months,
 * returns that candidate day. Otherwise returns null.
 */
export function detectSuggestedPayday(
  transactions: Array<{ type?: string; date?: string; amount?: number }>
): number | null {
  if (!Array.isArray(transactions) || transactions.length === 0) return null;

  const incomeRecords: Array<{ yearMonth: string; day: number; amount: number }> = [];

  for (const t of transactions) {
    if (!t || typeof t !== 'object') continue;
    const typeStr = String(t.type || '').toLowerCase();
    if (typeStr !== 'income') continue;

    const dateStr = String(t.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;

    const amount = Number(t.amount) || 0;
    if (amount <= 0) continue;

    const yearMonth = dateStr.slice(0, 7);
    const day = parseInt(dateStr.slice(8, 10), 10);
    if (day >= 1 && day <= 31) {
      incomeRecords.push({ yearMonth, day, amount });
    }
  }

  if (incomeRecords.length < 2) return null;

  // Only evaluate days that actually appeared in income records
  const actualDays = Array.from(new Set(incomeRecords.map((r) => r.day))).sort((a, b) => b - a);
  let bestDay: number | null = null;
  let maxDistinctMonths = 0;
  let maxTotalAmount = 0;

  for (const candidateDay of actualDays) {
    const matchedMonths = new Set<string>();
    let totalIncome = 0;

    for (const rec of incomeRecords) {
      const diff = Math.abs(rec.day - candidateDay);
      if (diff <= 2) {
        matchedMonths.add(rec.yearMonth);
        totalIncome += rec.amount;
      }
    }

    if (matchedMonths.size >= 2) {
      if (
        matchedMonths.size > maxDistinctMonths ||
        (matchedMonths.size === maxDistinctMonths && totalIncome > maxTotalAmount)
      ) {
        maxDistinctMonths = matchedMonths.size;
        maxTotalAmount = totalIncome;
        bestDay = candidateDay;
      }
    }
  }

  return bestDay;
}

/**
 * Reads the user money profile from local storage.
 */
export function getUserMoneyProfile(
  transactions?: Array<{ type?: string; date?: string; amount?: number }>
): UserMoneyProfile {
  if (typeof window === 'undefined') {
    return {
      language: 'auto',
      paydayDay: null,
      suggestedPayday: null,
      monthlyBudgetCap: null,
      baselineIncome: null,
      emergencyReserve: null,
      goals: [],
      rejectedChips: [],
      recentActions: [],
    };
  }

  let language: ProfileLanguage = 'auto';
  const storedLang = localStorage.getItem(PROFILE_STORAGE_KEYS.LANGUAGE);
  if (storedLang === 'zh' || storedLang === 'en' || storedLang === 'ms' || storedLang === 'auto') {
    language = storedLang;
  }

  let paydayDay: number | null = null;
  const storedPayday = localStorage.getItem(PROFILE_STORAGE_KEYS.PAYDAY_DAY);
  if (storedPayday) {
    const parsed = parseInt(storedPayday, 10);
    if (parsed >= 1 && parsed <= 31) {
      paydayDay = parsed;
    }
  }

  let monthlyBudgetCap: number | null = null;
  const storedBudget = localStorage.getItem(CLOUD_SYNC_KEYS.MONTHLY_BUDGET);
  if (storedBudget) {
    const parsed = parseFloat(storedBudget);
    if (Number.isFinite(parsed) && parsed > 0) monthlyBudgetCap = parsed;
  }

  let baselineIncome: number | null = null;
  const storedIncome = localStorage.getItem(CLOUD_SYNC_KEYS.BASELINE_INCOME);
  if (storedIncome) {
    const parsed = parseFloat(storedIncome);
    if (Number.isFinite(parsed) && parsed > 0) baselineIncome = parsed;
  }

  let emergencyReserve: number | null = null;
  const storedReserve = localStorage.getItem(CLOUD_SYNC_KEYS.EMERGENCY_RESERVE);
  if (storedReserve) {
    const parsed = parseFloat(storedReserve);
    if (Number.isFinite(parsed) && parsed > 0) emergencyReserve = parsed;
  }

  let goals: UserGoal[] = [];
  try {
    const storedGoals = localStorage.getItem(PROFILE_STORAGE_KEYS.GOALS);
    if (storedGoals) {
      const parsed = JSON.parse(storedGoals);
      if (Array.isArray(parsed)) {
        goals = parsed.slice(0, 3).map((g) => ({
          id: String(g.id || Math.random().toString(36).slice(2, 7)),
          name: String(g.name || 'Goal').slice(0, 50),
          targetAmount: Number(g.targetAmount) || 0,
          currentAmount: Number(g.currentAmount) || 0,
          targetDate: typeof g.targetDate === 'string' ? g.targetDate : undefined,
        }));
      }
    }
  } catch {
    goals = [];
  }

  let rejectedChips: RejectedChip[] = [];
  try {
    const storedRejected = localStorage.getItem(PROFILE_STORAGE_KEYS.REJECTED_CHIPS);
    if (storedRejected) {
      const parsed = JSON.parse(storedRejected);
      if (Array.isArray(parsed)) {
        const now = Date.now();
        // Automatically drop rejections older than 30 days
        rejectedChips = parsed.filter(
          (c) => c && typeof c.text === 'string' && typeof c.rejectedAt === 'number' && now - c.rejectedAt < THIRTY_DAYS_MS
        );
      }
    }
  } catch {
    rejectedChips = [];
  }

  let recentActions: RecentAction[] = [];
  try {
    const storedActions = localStorage.getItem(PROFILE_STORAGE_KEYS.RECENT_ACTIONS);
    if (storedActions) {
      const parsed = JSON.parse(storedActions);
      if (Array.isArray(parsed)) {
        recentActions = parsed.slice(0, 8);
      }
    }
  } catch {
    recentActions = [];
  }

  // Payday suggestion: only compute if paydayDay is not already set
  let suggestedPayday: number | null = null;
  if (paydayDay === null && transactions) {
    suggestedPayday = detectSuggestedPayday(transactions);
  }

  return {
    language,
    paydayDay,
    suggestedPayday,
    monthlyBudgetCap,
    baselineIncome,
    emergencyReserve,
    goals,
    rejectedChips,
    recentActions,
  };
}

/**
 * Saves updates to the user money profile and syncs with cloud where appropriate.
 */
export function updateUserMoneyProfile(updates: Partial<UserMoneyProfile>): void {
  if (typeof window === 'undefined') return;

  if (updates.language !== undefined) {
    saveProfileSetting(PROFILE_STORAGE_KEYS.LANGUAGE, updates.language);
  }

  if (updates.paydayDay !== undefined) {
    if (updates.paydayDay === null) {
      saveProfileSetting(PROFILE_STORAGE_KEYS.PAYDAY_DAY, '');
    } else {
      saveProfileSetting(PROFILE_STORAGE_KEYS.PAYDAY_DAY, String(updates.paydayDay));
    }
  }

  if (updates.monthlyBudgetCap !== undefined) {
    if (updates.monthlyBudgetCap === null) {
      saveProfileSetting(CLOUD_SYNC_KEYS.MONTHLY_BUDGET, '');
    } else {
      saveProfileSetting(CLOUD_SYNC_KEYS.MONTHLY_BUDGET, String(updates.monthlyBudgetCap));
    }
  }

  if (updates.baselineIncome !== undefined) {
    if (updates.baselineIncome === null) {
      saveProfileSetting(CLOUD_SYNC_KEYS.BASELINE_INCOME, '');
    } else {
      saveProfileSetting(CLOUD_SYNC_KEYS.BASELINE_INCOME, String(updates.baselineIncome));
    }
  }

  if (updates.emergencyReserve !== undefined) {
    if (updates.emergencyReserve === null) {
      saveProfileSetting(CLOUD_SYNC_KEYS.EMERGENCY_RESERVE, '');
    } else {
      saveProfileSetting(CLOUD_SYNC_KEYS.EMERGENCY_RESERVE, String(updates.emergencyReserve));
    }
  }

  if (updates.goals !== undefined) {
    const trimmedGoals = (updates.goals || []).slice(0, 3);
    saveProfileSetting(PROFILE_STORAGE_KEYS.GOALS, JSON.stringify(trimmedGoals));
  }

  if (updates.rejectedChips !== undefined) {
    saveProfileSetting(PROFILE_STORAGE_KEYS.REJECTED_CHIPS, JSON.stringify(updates.rejectedChips));
  }

  if (updates.recentActions !== undefined) {
    const trimmedActions = (updates.recentActions || []).slice(0, 8);
    saveProfileSetting(PROFILE_STORAGE_KEYS.RECENT_ACTIONS, JSON.stringify(trimmedActions));
  }
}

/**
 * Records a completed action in the recent actions list (keeps max 8).
 */
export function recordRecentAction(action: Omit<RecentAction, 'id' | 'timestamp'>): void {
  if (typeof window === 'undefined') return;
  const current = getUserMoneyProfile().recentActions;
  const newAction: RecentAction = {
    id: `action_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now(),
    ...action,
  };
  const updated = [newAction, ...current].slice(0, 8);
  updateUserMoneyProfile({ recentActions: updated });
}

/**
 * Marks a habit chip as rejected. It will be suppressed from suggestions for 30 days.
 */
export function rejectHabitChip(chipText: string): void {
  if (typeof window === 'undefined' || !chipText) return;
  const current = getUserMoneyProfile().rejectedChips;
  const now = Date.now();
  const filtered = current.filter((c) => c.text.toLowerCase() !== chipText.toLowerCase());
  const updated: RejectedChip[] = [{ text: chipText, rejectedAt: now }, ...filtered];
  updateUserMoneyProfile({ rejectedChips: updated });
}

/**
 * Checks if a habit chip text is currently suppressed.
 */
export function isChipRejected(chipText: string, rejectedChips?: RejectedChip[], now: number = Date.now()): boolean {
  if (!chipText) return false;
  const list = rejectedChips || (typeof window !== 'undefined' ? getUserMoneyProfile().rejectedChips : []);
  const lower = chipText.trim().toLowerCase();
  return list.some((c) => c.text.trim().toLowerCase() === lower && now - c.rejectedAt < THIRTY_DAYS_MS);
}
