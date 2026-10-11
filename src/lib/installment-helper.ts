import { addUnifiedRow, deleteUnifiedRow } from '@/hooks/useSheets';
import { Transaction } from '@/hooks/useTransactions';
import { getLocalDateString, parseLocalDate } from '@/lib/date-helper';
import { saveSettingWithCloudSync } from './cloud-settings-sync';

export interface GroupedInstallmentPlan {
  name: string;
  category: string;
  currency: string;
  monthlyAmount: number;
  totalTenure: number;
  latestPaidIndex: number;
  totalPaid: number;
  totalPayable: number;
  remainingBalance: number;
  startDate: string;
  endDate: string;
  nextDueDate?: string;
  status: 'active' | 'completed';
  transactions: Transaction[];
  annualInterestRate?: number;
}

export interface StoredInstallmentPlan {
  id: string;
  name: string;
  category: string;
  currency: string;
  totalPrincipal: number;
  tenureMonths: number;
  annualInterestRate: number;
  monthlyAmount: number;
  totalPayable: number;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM
  autoRecord: boolean;
  notes?: string;
  tripTag?: string;
}

export const INSTALLMENTS_STORAGE_KEY = 'cashflow_installment_plans';
export const INSTALLMENT_PRESET_MONTHS = [3, 6, 12, 18, 24, 36] as const;
export const MIN_INSTALLMENT_MONTHS = 1;
export const MAX_INSTALLMENT_MONTHS = 120;

export function normalizeInstallmentMonths(value: number): number {
  if (!Number.isFinite(value)) return MIN_INSTALLMENT_MONTHS;
  return Math.min(MAX_INSTALLMENT_MONTHS, Math.max(MIN_INSTALLMENT_MONTHS, Math.round(value)));
}

export function getSavedInstallmentPlans(): StoredInstallmentPlan[] {
  if (typeof window === 'undefined') return [];
  const raw = localStorage.getItem(INSTALLMENTS_STORAGE_KEY);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveInstallmentPlansToStorage(list: StoredInstallmentPlan[]): void {
  if (typeof window === 'undefined') return;
  saveSettingWithCloudSync(INSTALLMENTS_STORAGE_KEY, JSON.stringify(list));
}

export function upsertSavedInstallmentPlan(plan: StoredInstallmentPlan): void {
  const current = getSavedInstallmentPlans();
  const index = current.findIndex(
    (p) => p.id === plan.id || p.name.toLowerCase() === plan.name.toLowerCase()
  );
  if (index >= 0) {
    current[index] = plan;
  } else {
    current.push(plan);
  }
  saveInstallmentPlansToStorage(current);
}

export function removeSavedInstallmentPlan(nameOrId: string): void {
  const current = getSavedInstallmentPlans();
  const lower = nameOrId.toLowerCase();
  const filtered = current.filter(
    (p) => p.id !== nameOrId && p.name.toLowerCase() !== lower
  );
  saveInstallmentPlansToStorage(filtered);
}

export interface InstallmentPlanParams {
  baseDescription: string;
  totalPrincipal: number;
  tenureMonths: number;
  annualInterestRate: number; // e.g. 0 for 0% EPP, or 3.5 for 3.5%
  startDate: string; // YYYY-MM-DD
  currency: string;
  category: string;
  subCategory?: string;
  tripTag?: string;
  receiptUrl?: string;
  userNotes?: string;
}

export interface CalculatedInstallment {
  monthlyAmount: number;
  totalInterest: number;
  totalPayable: number;
  schedule: Array<{
    installmentIndex: number; // 1-indexed
    totalTenure: number;
    date: string; // YYYY-MM-DD
    month: string; // YYYY-MM
    amount: number;
    description: string;
    notes: string;
  }>;
}

/**
 * Extracts installment details from a Transaction.
 */
export function extractInstallmentInfo(tx: Transaction) {
  const desc = tx.description || '';
  const notes = tx.notes || '';
  const isInst = /\(installment/i.test(desc) || /\[installment plan/i.test(notes);
  if (!isInst) return null;

  const match = desc.match(/^(.*?)\s*\(Installment\s*(\d+)\/(\d+)\)/i) ||
                notes.match(/\[Installment Plan\s*(\d+)\/(\d+)\]/i);

  let planName = 'Installment Plan';
  let instIndex = 1;
  let totalTenure = 12;

  if (match) {
    if (match[3]) {
      planName = (match[1] || tx.category || 'Installment Plan').trim();
      instIndex = parseInt(match[2], 10) || 1;
      totalTenure = parseInt(match[3], 10) || 12;
    } else if (match[2]) {
      instIndex = parseInt(match[1], 10) || 1;
      totalTenure = parseInt(match[2], 10) || 12;
      planName = (desc.replace(/\s*\(Installment.*\)/i, '') || tx.category).trim();
    }
  }

  // Parse total amount from notes if available: e.g. "Total: MYR 3600.00"
  const totalMatch = notes.match(/Total:\s*([A-Za-z$]+)?\s*([\d.]+)/i);
  const parsedTotal = totalMatch && totalMatch[2] ? parseFloat(totalMatch[2]) : (tx.amount * totalTenure);

  // Parse rate from notes: e.g. "3.5% p.a. Interest"
  const rateMatch = notes.match(/([\d.]+)%\s*p\.a\.\s*Interest/i);
  const annualInterestRate = rateMatch ? parseFloat(rateMatch[1]) : 0;

  return {
    planName,
    instIndex,
    totalTenure,
    totalPayable: parsedTotal,
    annualInterestRate,
  };
}

/**
 * Calculates installment monthly payments, total interest, and generates date schedules.
 */
export function calculateInstallmentPlan(params: InstallmentPlanParams): CalculatedInstallment {
  const {
    baseDescription,
    totalPrincipal,
    tenureMonths,
    annualInterestRate,
    startDate,
    currency,
    userNotes = '',
  } = params;

  const principal = Math.max(0, totalPrincipal);
  const tenure = normalizeInstallmentMonths(tenureMonths);
  const rate = Math.max(0, annualInterestRate);

  // This is a flat-rate estimate, which matches common 0%/EPP schedules but
  // is not the same as reducing-balance loan amortization.
  const totalInterest = rate > 0 ? principal * (rate / 100) * (tenure / 12) : 0;
  const totalPayable = principal + totalInterest;
  const monthlyAmount = tenure > 0 ? totalPayable / tenure : totalPayable;

  const start = parseLocalDate(startDate);
  const startYear = isNaN(start.getFullYear()) ? new Date().getFullYear() : start.getFullYear();
  const startMonth = isNaN(start.getMonth()) ? new Date().getMonth() : start.getMonth();
  const startDay = isNaN(start.getDate()) ? new Date().getDate() : start.getDate();

  const schedule: CalculatedInstallment['schedule'] = [];

  for (let i = 1; i <= tenure; i++) {
    const targetDate = new Date(startYear, startMonth + (i - 1), startDay);
    if (targetDate.getMonth() !== (startMonth + (i - 1)) % 12) {
      targetDate.setDate(0);
    }
    const yyyy = targetDate.getFullYear();
    const mm = String(targetDate.getMonth() + 1).padStart(2, '0');
    const dd = String(targetDate.getDate()).padStart(2, '0');
    const dateStr = `${yyyy}-${mm}-${dd}`;
    const monthStr = `${yyyy}-${mm}`;

    const desc = `${baseDescription.trim() || 'Purchase'} (Installment ${i}/${tenure})`;
    const interestNote = rate > 0 ? `${rate}% p.a. Interest` : '0% Interest EPP';
    const roundedMonthlyAmount = Number(monthlyAmount.toFixed(2));
    const amount = i === tenure
      ? Number((totalPayable - roundedMonthlyAmount * (tenure - 1)).toFixed(2))
      : roundedMonthlyAmount;
    const planAudit = `[Installment Plan ${i}/${tenure}] Total: ${currency} ${totalPayable.toFixed(2)} | Tenure: ${tenure} Months | ${interestNote} | Monthly: ${currency} ${amount.toFixed(2)}`;
    const fullNotes = userNotes.trim() ? `${userNotes.trim()}\n${planAudit}` : planAudit;

    schedule.push({
      installmentIndex: i,
      totalTenure: tenure,
      date: dateStr,
      month: monthStr,
      amount,
      description: desc,
      notes: fullNotes,
    });
  }

  return {
    monthlyAmount: Number(monthlyAmount.toFixed(2)),
    totalInterest: Number(totalInterest.toFixed(2)),
    totalPayable: Number(totalPayable.toFixed(2)),
    schedule,
  };
}

/**
 * Record a single installment month when due (Month-by-Month recording).
 */
export async function recordInstallmentMonth(
  planName: string,
  category: string,
  currency: string,
  monthIndex: number,
  totalTenure: number,
  monthlyAmount: number,
  totalPayable: number,
  annualInterestRate: number,
  targetDate: string,
  tripTag: string = '',
  userNotes: string = '',
  planId: string = planName
): Promise<{ success: boolean; id: string }> {
  const targetMonth = targetDate.substring(0, 7);
  const desc = `${planName.trim()} (Installment ${monthIndex}/${totalTenure})`;
  const interestNote = annualInterestRate > 0 ? `${annualInterestRate}% p.a. Interest` : '0% Interest EPP';
  const roundedMonthlyAmount = Number(monthlyAmount.toFixed(2));
  const recordedAmount = monthIndex === totalTenure
    ? Number((totalPayable - roundedMonthlyAmount * (totalTenure - 1)).toFixed(2))
    : roundedMonthlyAmount;
  const planAudit = `[Installment Plan ${monthIndex}/${totalTenure}] Total: ${currency} ${totalPayable.toFixed(2)} | Tenure: ${totalTenure} Months | ${interestNote} | Monthly: ${currency} ${recordedAmount.toFixed(2)}`;
  const fullNotes = userNotes.trim() ? `${userNotes.trim()}\n${planAudit}` : planAudit;

  const rowData = {
    // Stable plan + installment identity makes retrying or running from two
    // devices idempotent at the transaction row level.
    Id: `tx_inst_${String(planId).replace(/[^A-Za-z0-9_-]/g, '_')}_${monthIndex}`,
    Date: targetDate,
    Type: 'Expense',
    Category: category,
    SubCategory: '',
    Description: desc,
    Amount: recordedAmount,
    Currency: currency,
    TripTag: tripTag,
    ReceiptUrl: '',
    Notes: fullNotes,
    _month: targetMonth,
  };

  return addUnifiedRow(targetMonth, rowData);
}

/**
 * Automatically records installment transactions month-by-month as their due date arrives.
 */
export async function checkAndAutoRecordInstallments(
  plans: StoredInstallmentPlan[],
  transactions: Transaction[],
  onRecordSuccess?: (planName: string, monthIndex: number, amount: number) => void
): Promise<void> {
  // Safety guard: NEVER auto-record when in test mode or if empty
  if (!plans || plans.length === 0) return;
  if (typeof window !== 'undefined' && localStorage.getItem('cashflow_test_mode') === 'true') {
    return;
  }

  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  for (const plan of plans) {
    if (!plan.autoRecord) continue;

    // Matching transactions already recorded for this plan
    const matchingTxs = transactions.filter((t) => {
      const desc = (t.description || '').toLowerCase();
      const notes = (t.notes || '').toLowerCase();
      const isInst = desc.includes('(installment') || notes.includes('[installment plan');
      if (!isInst) return false;
      const baseName = desc.replace(/\s*\(installment.*?\)/i, '').trim();
      return baseName === plan.name.toLowerCase() || t.category?.toLowerCase() === plan.name.toLowerCase();
    });

    const paidIndices = new Set<number>();
    matchingTxs.forEach((tx) => {
      const info = extractInstallmentInfo(tx);
      if (info && info.planName.toLowerCase() === plan.name.toLowerCase()) {
        paidIndices.add(info.instIndex);
      }
    });
    const nextIndex = Array.from({ length: plan.tenureMonths }, (_, index) => index + 1)
      .find(index => !paidIndices.has(index));
    if (!nextIndex) continue; // All months completed, including out-of-order payments.

    // Compute target date for nextIndex without timezone skews
    const [startYear, startMonth, startDay] = (plan.startDate || todayStr).split('-').map(Number);
    const targetDate = new Date(startYear, (startMonth - 1) + (nextIndex - 1), startDay || 1);
    const yyyy = targetDate.getFullYear();
    const mm = String(targetDate.getMonth() + 1).padStart(2, '0');
    const dd = String(targetDate.getDate()).padStart(2, '0');
    const targetDateStr = `${yyyy}-${mm}-${dd}`;
    const targetMonthStr = `${yyyy}-${mm}`;

    // Strictly check if the target due date has arrived (today or past).
    // If target date is in the future, the day has NOT reached, so DO NOT RECORD!
    const isDue = targetDateStr <= todayStr;
    if (!isDue) continue;

    // Check if nextIndex is already recorded
    const alreadyRecorded = paidIndices.has(nextIndex) || matchingTxs.some((t) =>
      Boolean(t.date && t.date.startsWith(targetMonthStr) && t.description?.includes(`Installment ${nextIndex}/${plan.tenureMonths}`))
    );

    if (alreadyRecorded) continue;

    try {
      await recordInstallmentMonth(
        plan.name,
        plan.category,
        plan.currency,
        nextIndex,
        plan.tenureMonths,
        plan.monthlyAmount,
        plan.totalPayable,
        plan.annualInterestRate,
        targetDateStr,
        plan.tripTag,
        plan.notes,
        plan.id
      );
      const roundedMonthlyAmount = Number(plan.monthlyAmount.toFixed(2));
      const recordedAmount = nextIndex === plan.tenureMonths
        ? Number((plan.totalPayable - roundedMonthlyAmount * (plan.tenureMonths - 1)).toFixed(2))
        : roundedMonthlyAmount;
      onRecordSuccess?.(plan.name, nextIndex, recordedAmount);
    } catch (err) {
      console.warn(`[Installment] Auto-record failed for ${plan.name} Month ${nextIndex}:`, err);
    }
  }
}

/**
 * Deletes all transactions belonging to an installment plan from Google Sheets.
 */
export async function deleteInstallmentPlan(transactions: Transaction[], planName?: string): Promise<boolean> {
  if (planName) {
    removeSavedInstallmentPlan(planName);
  }

  if (!transactions || transactions.length === 0) return true;

  let hasFailure = false;

  for (const tx of transactions) {
    try {
      const sheet = tx._month || (tx.date ? tx.date.substring(0, 7) : 'Transactions');
      const result = await deleteUnifiedRow(sheet, tx._rowIndex, tx.id);
      if (!result.success) hasFailure = true;
    } catch (err) {
      console.warn('[Installment] Google Sheets delete warning:', err);
      hasFailure = true;
    }
  }

  return !hasFailure;
}

/**
 * Updates/reschedules an existing installment plan:
 * Deletes old transactions and registers the new plan.
 * Records ONLY Month 1 if due, month-by-month. Does NOT pre-fill future months.
 */
export async function updateInstallmentPlan(
  oldTransactions: Transaction[],
  newParams: InstallmentPlanParams,
  oldPlanName?: string,
  providedPlanId?: string
): Promise<boolean> {
  const newPlan = calculateInstallmentPlan(newParams);
  if (!newPlan || newPlan.schedule.length === 0) return false;

  // 1. Clean up old plan from saved storage if name changed
  if (oldPlanName && oldPlanName.toLowerCase() !== newParams.baseDescription.trim().toLowerCase()) {
    removeSavedInstallmentPlan(oldPlanName);
  }

  // 2. Delete old transactions cleanly from Google Sheets & remove old plan entry
  await deleteInstallmentPlan(oldTransactions || [], oldPlanName || newParams.baseDescription);

  // 3. Register/update persistent installment plan
  const firstItem = newPlan.schedule[0];
  const lastItem = newPlan.schedule[newPlan.schedule.length - 1];

  const planId = providedPlanId || `plan_${Date.now()}`;
  upsertSavedInstallmentPlan({
    id: planId,
    name: newParams.baseDescription.trim(),
    category: newParams.category,
    currency: newParams.currency,
    totalPrincipal: newParams.totalPrincipal,
    tenureMonths: newParams.tenureMonths,
    annualInterestRate: newParams.annualInterestRate,
    monthlyAmount: newPlan.monthlyAmount,
    totalPayable: newPlan.totalPayable,
    startDate: newParams.startDate,
    endDate: lastItem.month,
    autoRecord: true,
    tripTag: newParams.tripTag,
    notes: newParams.userNotes,
  });

  // 3. Save Month 1 transaction ONLY if start date has arrived (today or past).
  // If start date is in the future (e.g. next month), do NOT pre-insert; it will auto-record on its due date.
  const todayStr = getLocalDateString();
  if (firstItem.date <= todayStr) {
    const firstRowData = {
      Id: `tx_inst_${planId}_1`,
      Date: firstItem.date,
      Type: 'Expense',
      Category: newParams.category,
      SubCategory: newParams.subCategory || '',
      Description: firstItem.description,
      Amount: firstItem.amount,
      Currency: newParams.currency,
      TripTag: newParams.tripTag || '',
      ReceiptUrl: newParams.receiptUrl || '',
      Notes: firstItem.notes,
      _month: firstItem.month,
    };

    await addUnifiedRow(firstItem.month, firstRowData);
  }

  return true;
}
