import { addUnifiedRow } from '@/hooks/useSheets';
import { getLocalMonthString, getDaysInMonth } from './date-helper';
import { saveSettingWithCloudSync } from './cloud-settings-sync';

export interface CommitmentRateHistory {
  effectiveFrom: string; // 'YYYY-MM'
  amount: number;
}

export interface RecurringCommitment {
  id: string;
  name: string;
  category: string;
  subCategory?: string;
  dayOfMonth: number; // 1 to 31
  amount: number; // current/base amount
  effectiveFrom: string; // 'YYYY-MM'
  history: CommitmentRateHistory[];
  autoRecord: boolean; // whether to automatically write to Google Sheets on the due day
  lastAutoRecordedMonth?: string; // 'YYYY-MM' of last auto-record
  notes?: string;
}

interface RecurringTransactionLike {
  id?: string;
  date?: string;
  type?: string;
  category?: string;
  description?: string;
  notes?: string;
  Id?: string;
  Date?: string;
  Type?: string;
  Category?: string;
  Description?: string;
  Notes?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const DEFAULT_COMMITMENTS: RecurringCommitment[] = [];

export const RECURRING_STORAGE_KEY = 'cashflow_recurring_commitments';

/**
 * Get active rate for a given month 'YYYY-MM'.
 * Preserves past data by looking up the applicable rate history for that specific month.
 */
export function getCommitmentRateForMonth(commitment: RecurringCommitment, monthStr: string): number {
  if (!commitment.history || commitment.history.length === 0) {
    return commitment.amount || 0;
  }
  // Sort history descending by effectiveFrom
  const sorted = [...commitment.history].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  const matched = sorted.find(h => h.effectiveFrom <= monthStr);
  if (matched) {
    return matched.amount;
  }
  // If target month is earlier than the earliest record, return earliest rate
  return sorted[sorted.length - 1].amount;
}

/**
 * Load commitments from localStorage
 */
export function getSavedCommitments(): RecurringCommitment[] {
  if (typeof window === 'undefined') return [];
  const raw = localStorage.getItem(RECURRING_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.filter(isRecord).map((c) => {
        const history = Array.isArray(c.history) ? c.history : [];
        return {
          ...c,
          history: history.length > 0
            ? history as CommitmentRateHistory[]
            : [{
                effectiveFrom: typeof c.effectiveFrom === 'string' ? c.effectiveFrom : '2026-01',
                amount: typeof c.amount === 'number' ? c.amount : 0,
              }],
        } as RecurringCommitment;
      });
    }
  } catch (e) {
    console.error('Failed to parse recurring commitments', e);
  }
  return [];
}

/**
 * Save commitments to localStorage and sync plan changes to Google Sheets
 */
export function saveCommitmentsToStorage(list: RecurringCommitment[]): void {
  if (typeof window === 'undefined') return;
  saveSettingWithCloudSync(RECURRING_STORAGE_KEY, JSON.stringify(list));
}

/**
 * Update local commitment metadata (such as lastAutoRecordedMonth) without
 * queueing a full cloud plan mutation when recorded status is already derived
 * directly from the monthly transactions sheet.
 */
export function saveCommitmentsLocallyOnly(list: RecurringCommitment[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(RECURRING_STORAGE_KEY, JSON.stringify(list));
  } catch (e) {
    console.warn('Failed to save commitments locally:', e);
  }
}

/**
 * Update commitment with a new amount effective from a specific month (e.g. '2027-01').
 * Guarantees that prior months retain their original rate.
 */
export function updateCommitmentRate(
  commitment: RecurringCommitment,
  newAmount: number,
  effectiveFromMonth: string
): RecurringCommitment {
  const existingHistory = commitment.history && commitment.history.length > 0
    ? commitment.history
    : [{ effectiveFrom: commitment.effectiveFrom || '2026-01', amount: commitment.amount }];

  const existingIndex = existingHistory.findIndex(h => h.effectiveFrom === effectiveFromMonth);
  let updatedHistory: CommitmentRateHistory[];

  if (existingIndex >= 0) {
    updatedHistory = existingHistory.map((h, i) => i === existingIndex ? { ...h, amount: newAmount } : h);
  } else {
    updatedHistory = [...existingHistory, { effectiveFrom: effectiveFromMonth, amount: newAmount }];
  }

  // Sort history ascending
  updatedHistory.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));

  const todayMonth = getLocalMonthString();
  const currentRate = getCommitmentRateForMonth({ ...commitment, history: updatedHistory }, todayMonth);

  return {
    ...commitment,
    amount: currentRate,
    history: updatedHistory,
    effectiveFrom: effectiveFromMonth,
  };
}

/**
 * Safely determines if a transaction matches a recurring commitment for a given month.
 * Avoids false positives from empty descriptions, single-letter prefixes, or mismatched categories.
 */
export function isTransactionMatchingCommitment(
  tx: RecurringTransactionLike | null | undefined,
  commitment: RecurringCommitment,
  monthStr: string
): boolean {
  if (!tx || !commitment) return false;
  const rawType = String(tx.type || tx.Type || '').toLowerCase();
  if (rawType && rawType !== 'expense') return false;

  const txDate = String(tx.date || tx.Date || '');
  if (!txDate.startsWith(monthStr)) return false;

  // 1. Explicit ID tag in notes takes absolute precedence
  const notes = String(tx.notes || tx.Notes || '');
  if (notes.includes(`[Recurring:${commitment.id}]`)) {
    return true;
  }

  const itemLower = commitment.name.trim().toLowerCase();
  const descLower = String(tx.description || tx.Description || '').trim().toLowerCase();

  // If description or commitment name is empty, avoid fuzzy matches
  if (!itemLower || !descLower) return false;

  // 2. Exact match on description (case-insensitive)
  if (descLower === itemLower) return true;

  // 3. Substring matching requires:
  // - Matching category (case-insensitive)
  // - Minimum 3 characters on both sides to avoid false hits
  const txCat = String(tx.category || tx.Category || '').trim().toLowerCase();
  const commCat = String(commitment.category || '').trim().toLowerCase();
  const categoryMatch = !txCat || !commCat || txCat === commCat;

  if (categoryMatch && descLower.length >= 3 && itemLower.length >= 3) {
    if (descLower.includes(itemLower) || itemLower.includes(descLower)) {
      return true;
    }
  }

  return false;
}

/**
 * Check and auto-record commitments whose due day has arrived.
 * Writes to Google Sheets if not already recorded for the current month.
 */
export async function checkAndAutoRecordCommitments(
  commitments: RecurringCommitment[],
  transactions: RecurringTransactionLike[],
  onRecordSuccess: (commitmentName: string, amount: number, date: string) => void
): Promise<RecurringCommitment[]> {
  // Safety guard: NEVER auto-record when in test mode or if empty
  if (!commitments || commitments.length === 0) return [];
  if (typeof window !== 'undefined' && localStorage.getItem('cashflow_test_mode') === 'true') {
    return commitments;
  }

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonthNum = now.getMonth() + 1;
  const currentDay = now.getDate();
  const currentMonthStr = `${currentYear}-${String(currentMonthNum).padStart(2, '0')}`;

  const updatedList = [...commitments];
  let hasChanges = false;

  for (let i = 0; i < updatedList.length; i++) {
    const c = updatedList[i];
    if (!c.autoRecord || c.amount <= 0) continue;

    // Calculate effective due day for current month (clamps 31st to 30th in Sept/Apr/Jun/Nov, 28th/29th in Feb)
    const daysInMonth = getDaysInMonth(currentYear, currentMonthNum);
    const effectiveDueDay = Math.min(c.dayOfMonth, daysInMonth);

    // Check if due day has arrived in the current month
    if (currentDay < effectiveDueDay) continue;

    // Check active rate for current month
    const rateForThisMonth = getCommitmentRateForMonth(c, currentMonthStr);
    if (rateForThisMonth <= 0) continue;

    // Check if already auto-recorded in local tracker
    if (c.lastAutoRecordedMonth === currentMonthStr) continue;

    // Check if already recorded in Google Sheet transactions for this month
    const alreadyRecordedInTransactions = transactions.some(t => 
      isTransactionMatchingCommitment(t, c, currentMonthStr)
    );

    if (alreadyRecordedInTransactions) {
      if (c.lastAutoRecordedMonth !== currentMonthStr) {
        updatedList[i] = { ...c, lastAutoRecordedMonth: currentMonthStr };
        hasChanges = true;
      }
      continue;
    }

    const recordDate = `${currentMonthStr}-${String(effectiveDueDay).padStart(2, '0')}`;

    try {
      await addUnifiedRow(currentMonthStr, {
        // Stable IDs make concurrent devices and offline retries converge on
        // one monthly record instead of appending a duplicate payment.
        Id: `tx_rec_${String(c.id).replace(/[^A-Za-z0-9_-]/g, '_')}_${currentMonthStr}`,
        Date: recordDate,
        Type: 'Expense',
        Category: c.category,
        SubCategory: c.subCategory || 'Monthly Commitment',
        Description: c.name,
        Amount: rateForThisMonth,
        Currency: 'MYR',
        TripTag: '',
        ReceiptUrl: '',
        Notes: `[Recurring:${c.id}] Monthly recurring commitment (Due ${c.dayOfMonth}th)`,
      });

      updatedList[i] = { ...c, lastAutoRecordedMonth: currentMonthStr };
      hasChanges = true;
      onRecordSuccess(c.name, rateForThisMonth, recordDate);
    } catch (err) {
      console.error(`Failed to auto-record commitment ${c.name}`, err);
    }
  }

  if (hasChanges) {
    saveCommitmentsToStorage(updatedList);
  }

  return updatedList;
}
