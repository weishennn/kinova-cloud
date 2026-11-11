/**
 * Kinova Assistant Client Orchestrator (Master Upgrade v3).
 *
 * Implements the "two speeds, one assistant" architecture:
 * 1. Fast Path (Local, 0ms, 0 API cost):
 *    - Session control (undo, repeat, correct)
 *    - Instant preferences (payday, budget, category cap, alias)
 *    - Clear unambiguous expenses ("Shell 60", "午餐 15") -> labeled "Quick parse"
 * 2. Assistant Path (Gemini + Deterministic CFO Autopilot):
 *    - Receives a complete, deterministic `cashflowBriefing` on EVERY turn (anchored to `safeRefDate`).
 *    - Supports interactive `proposedAction.type = 'rebalance_caps'` (1-Tap Rebalance Confirmation Card)
 *      and `proposedAction.type = 'allocate_payday_envelope'` (1-Tap Payday Settlement Envelope Card).
 */

import {
  isQuestionOrAdviceRequest,
  isRebalanceBudgetRequest,
  requiresExtendedReasoning,
  routeLocalIntent,
  type LocalRouteResult,
} from './intent-router.ts';
import { parseNaturalExpense } from './natural-expense-parser.ts';
import { getUserMoneyProfile, type UserMoneyProfile } from './user-money-profile.ts';
import { getLocalDateString, parseLocalDate } from './date-helper.ts';
import { getAmountInBaseCurrency } from './currency.ts';
import {
  getSavedCategoryCaps,
  getLockedCategoryCaps,
  resolveCategoryCapValue,
  getCategoryCommitmentBreakdown,
  predictMonthlySavingsAndInvestments,
  getPaydayCycleIntelligence,
  rebalanceCategoryCapsForSpending,
  isTripQuarantinedExpense,
  type CategoryRebalanceSuggestion,
  type PaydayEnvelopeAllocationPlan,
} from './category-budget-helper.ts';
import { CANONICAL_EXPENSE_CATEGORIES, normalizeToCanonicalCategory } from './canonical-categories.ts';
import type { AiCommand } from '../types/ai-command.ts';
import {
  computeDeterministicLedgerFacts as computeCopilotFacts,
} from './copilot-ledger-facts.ts';
import { mineUserHabitSuggestions } from './habit-suggestions.ts';
import { getHabitMemories, type HabitMemoryItem } from './habit-memory-engine.ts';

export interface CompactHabitMemoryPromptItem {
  rawPattern: string;
  preferredAlias: string;
  category: string;
  keywords?: string[];
  timeSlot?: string;
}

export function serializeHabitMemoriesForPrompt(
  memories: HabitMemoryItem[],
  limit: number = 30
): CompactHabitMemoryPromptItem[] {
  if (!Array.isArray(memories) || memories.length === 0) return [];
  return memories
    .slice()
    .sort((a, b) => (b.frequency || 1) * (b.confidence || 0.5) - (a.frequency || 1) * (a.confidence || 0.5))
    .slice(0, Math.max(1, limit))
    .map((m) => ({
      rawPattern: m.rawPattern,
      preferredAlias: m.preferredAlias,
      category: m.category,
      ...(Array.isArray(m.keywords) && m.keywords.length > 0 ? { keywords: m.keywords.slice(0, 8) } : {}),
      ...(m.timeSlot && m.timeSlot !== 'any' ? { timeSlot: m.timeSlot } : {}),
    }));
}

export interface AssistantTurnMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface AssistantPendingContext {
  intent: 'transaction' | 'installment' | 'trade' | 'trip';
  originalRequest: string;
  knownFields: Record<string, unknown>;
  missingFields: string[];
}

export interface AssistantParserCandidate {
  amount: number;
  currency: string;
  type: 'Expense' | 'Income';
  category: string;
  unresolvedFields: string[];
}

export function buildAssistantParserCandidate(text: string): AssistantParserCandidate | null {
  const parsed = parseNaturalExpense(text);
  if (!parsed || !Number.isFinite(parsed.amount) || parsed.amount <= 0) return null;

  return {
    amount: parsed.amount,
    currency: parsed.currency || 'MYR',
    type: parsed.type,
    category: parsed.category,
    unresolvedFields: [
      ...(parsed.hasUnparsedTemporalContext ? ['date'] : []),
      ...(parsed.hasUnparsedCalculationContext ? ['amount'] : []),
    ],
  };
}

export function resolveAssistantParserCandidate(
  text: string,
  hasImage: boolean,
  providedCandidate?: AssistantParserCandidate | null,
): AssistantParserCandidate | null {
  if (providedCandidate) return providedCandidate;
  return hasImage ? null : buildAssistantParserCandidate(text);
}

export function shouldUseTransactionCapturePrompt(
  text: string,
  hasImage: boolean,
  candidate: AssistantParserCandidate | null,
): boolean {
  return Boolean(
    candidate &&
    text.trim() &&
    !hasImage &&
    !isQuestionOrAdviceRequest(text) &&
    !isRebalanceBudgetRequest(text)
  );
}

export function updateAssistantConversation(
  currentTurns: AssistantTurnMessage[],
  userText: string,
  response: AssistantApiResponse,
): { turns: AssistantTurnMessage[]; pendingContext: AssistantPendingContext | null } {
  const assistantText = response.clarification?.question || response.answer || response.reasoning || '';
  const turns: AssistantTurnMessage[] = [
    ...currentTurns,
    { role: 'user' as const, text: userText },
    { role: 'assistant' as const, text: assistantText },
  ].slice(-6);
  return {
    turns,
    pendingContext: response.mode === 'clarify' ? response.pendingContext || null : null,
  };
}

export interface CategoryCashflowSnapshot {
  category: string;
  cap: number;
  spent: number;
  unpaidBillReserve: number;
  unreservedRemaining: number;
  isLocked?: boolean;
  status: 'on_track' | 'tight' | 'over_cap';
}

export interface PersonalCashflowBriefing {
  baselineIncome: number;
  actualIncomeThisMonth: number;
  targetSavingsAmount: number;
  targetInvestmentAmount: number;
  targetLivingBudget: number;
  spentSoFar: number;
  tripQuarantinedSpent: number;
  unpaidCommittedBillsReserve: number;
  remainingSafeLivingPool: number;
  safeDailyLivingAllowance: number;
  daysRemainingInMonth: number;
  daysUntilPayday: number;
  pacingStatus: string;
  categorySnapshots: CategoryCashflowSnapshot[];
  overCapCategories: string[];
  smartRebalanceSummary?: string;
  rebalancePlan?: CategoryRebalanceSuggestion;
  paydayEnvelopePlan?: PaydayEnvelopeAllocationPlan;
}

export interface DeterministicLedgerFacts {
  currentMonthTotalSpent: number;
  currentMonthBudgetRemaining: number | null;
  categorySpending: Record<string, number>;
  categoryCaps?: Record<string, number>;
  lockedCaps?: Record<string, boolean>;
  categoryMedians: Record<string, number>;
  matchedRecordCount: number;
  matchedExactSpent: number;
  queryItemFoundInLedger: boolean;
  timeframeLabel?: string;
  categoryLabel?: string;
  priceLadder?: Array<{ store: string; unitPrice: number; unit: string; date: string; isLowest: boolean }>;
  categoryBreakdown?: Array<{ category: string; amount: number; percentage: number }>;
  largestExpense?: { id?: string; date: string; description: string; category?: string; amount: number } | null;
  potentialDuplicate: { date: string; amount: number; description: string } | null;
  relevantTransactionsSample?: Array<{
    date: string;
    description: string;
    category: string;
    amount: number;
    type?: string;
  }>;
  cashflowBriefing?: PersonalCashflowBriefing;
}

export type ProposedActionType =
  | 'save_transaction'
  | 'save_trade'
  | 'save_installment'
  | 'save_trip'
  | 'set_preference'
  | 'navigate'
  | 'undo'
  | 'rebalance_caps'
  | 'allocate_payday_envelope';

export interface AssistantApiResponse {
  mode: 'record' | 'advise' | 'correct' | 'repeat' | 'undo' | 'set_preference' | 'navigate' | 'clarify' | 'rebalance' | 'unknown';
  reasoning: string;
  answer: string;
  proposedAction: {
    label: string;
    type: ProposedActionType;
    payload: Record<string, unknown>;
  } | null;
  command: AiCommand | null;
  clarification: {
    question: string;
    options: [string, string];
  } | null;
  pendingContext: AssistantPendingContext | null;
  receiptAnalysis: {
    merchant: string;
    netAmount: number;
    taxReliefCategory: string | null;
    isDuplicate: boolean;
    comparisonToMedian: string | null;
  } | null;
}

export type KinovaTurnResult =
  | {
      source: 'local';
      localResult: LocalRouteResult;
    }
  | {
      source: 'assistant';
      assistantResult: AssistantApiResponse;
      model?: string;
    };

/**
 * Helper: Builds an executable `rebalance_caps` proposedAction when the user asks to rebalance
 * their budget (e.g. "I overspent RM 150 on dinner, can you fix my budget?" or "帮我平衡这个月的超支").
 */
export function buildRebalanceCapsProposedAction(
  queryText: string,
  transactions: Array<any>,
  profile: UserMoneyProfile,
  today: string = getLocalDateString()
): {
  rebalancePlan: CategoryRebalanceSuggestion;
  proposedAction: NonNullable<AssistantApiResponse['proposedAction']>;
} | null {
  const parsedRef = parseLocalDate(today);
  const safeRefDate = !Number.isNaN(parsedRef.getTime()) ? parsedRef : new Date();
  const currentYearMonth = today.slice(0, 7);
  const categoryCaps = getSavedCategoryCaps();
  const lockedCaps = getLockedCategoryCaps();

  // Detect if the user mentioned a specific overspent category/amount in the sentence
  // e.g. "I overspent RM 150 on dinner, can you fix my budget?"
  const parsedCandidate = parseNaturalExpense(queryText);
  const inferredCategory =
    parsedCandidate?.category && parsedCandidate.category !== 'Other'
      ? parsedCandidate.category
      : normalizeToCanonicalCategory(queryText, 'Expense', queryText);

  // Check if that amount is already recorded today or is a proposed/unrecorded overspend
  const candidateAmt = parsedCandidate?.amount && parsedCandidate.amount > 0 ? parsedCandidate.amount : 0;
  const alreadyRecordedToday =
    candidateAmt > 0 &&
    transactions.some(
      (t) =>
        t?.date === today &&
        String(t?.type || '').toLowerCase() === 'expense' &&
        Math.abs(getAmountInBaseCurrency(Number(t.amount) || 0, t.currency, t.baseAmount) - candidateAmt) < 0.05
    );

  const savingsPred = predictMonthlySavingsAndInvestments(transactions, {
    baselineIncome: profile.baselineIncome || undefined,
    savingsTargetPct: profile.savingsTargetPct,
    investmentTargetPct: profile.investmentTargetPct,
    selectedMonth: currentYearMonth,
    referenceDate: safeRefDate,
  });

  // Determine target category to rebalance: explicit mentioned category, or first over-cap category
  let targetCategory = inferredCategory && inferredCategory !== 'Other' ? inferredCategory : '';
  if (!targetCategory) {
    const { unpaidReserveByCategory } = getCategoryCommitmentBreakdown(transactions, currentYearMonth, { referenceDate: safeRefDate });
    for (const cat of CANONICAL_EXPENSE_CATEGORIES) {
      const cap = resolveCategoryCapValue(cat, categoryCaps, 0);
      const spent = transactions
        .filter(
          (t) =>
            String(t?.type || '').toLowerCase() === 'expense' &&
            String(t?.date || '').startsWith(currentYearMonth) &&
            normalizeToCanonicalCategory(t?.category || 'Other', 'Expense', t?.description) === cat &&
            !isTripQuarantinedExpense(t)
        )
        .reduce((s, t) => s + getAmountInBaseCurrency(Number(t.amount) || 0, t.currency, t.baseAmount), 0);
      const reserve = unpaidReserveByCategory.get(cat) || 0;
      if (spent + reserve > cap) {
        targetCategory = cat;
        break;
      }
    }
  }
  if (!targetCategory) targetCategory = 'Food & Dining';

  const rebalancePlan = rebalanceCategoryCapsForSpending({
    currentMonthTransactions: transactions,
    currentCaps: categoryCaps,
    lockedCaps,
    maxLivingBudget: savingsPred.targetLivingBudget,
    targetCategory,
    proposedAmount: !alreadyRecordedToday ? candidateAmt : 0,
    targetMonth: currentYearMonth,
    referenceDate: safeRefDate,
  });

  if (rebalancePlan.donors.length === 0 && rebalancePlan.newTargetCap <= rebalancePlan.previousTargetCap) {
    return null;
  }

  return {
    rebalancePlan,
    proposedAction: {
      label: 'Apply New Caps',
      type: 'rebalance_caps',
      payload: {
        targetCategory: rebalancePlan.targetCategory,
        previousTargetCap: rebalancePlan.previousTargetCap,
        newTargetCap: rebalancePlan.newTargetCap,
        targetIncrease: Number(Math.max(0, rebalancePlan.newTargetCap - rebalancePlan.previousTargetCap).toFixed(2)),
        deficitCovered: rebalancePlan.deficitCovered,
        unfundedDeficit: rebalancePlan.unfundedDeficit,
        donors: rebalancePlan.donors,
        updatedCaps: rebalancePlan.updatedCaps,
        summaryText: rebalancePlan.summaryText,
      },
    },
  };
}

/**
 * Computes deterministic facts AND a holistic Personal Cashflow Briefing across 100% of the user's ledger.
 * Strictly anchors all date calculations to `today` (`safeRefDate`).
 */
export function computeDeterministicLedgerFacts(
  transactions: Array<{
    id?: string;
    date?: string;
    type?: string;
    category?: string;
    subCategory?: string;
    description?: string;
    amount?: number;
    currency?: string;
    baseAmount?: number;
    notes?: string;
    tripTag?: string;
    TripTag?: string;
    receiptItems?: any[];
  }>,
  profile: UserMoneyProfile,
  queryKeyword?: string,
  today: string = getLocalDateString(),
  pendingReceipt?: { amount: number; merchant?: string; date?: string }
): DeterministicLedgerFacts {
  const parsedRef = parseLocalDate(today);
  const safeRefDate = !Number.isNaN(parsedRef.getTime()) ? parsedRef : new Date();
  const currentYearMonth = today.slice(0, 7);

  let currentMonthTotalSpent = 0;
  let actualIncomeThisMonth = 0;
  const categorySpending: Record<string, number> = {};
  const categoryValues: Record<string, number[]> = {};

  let potentialDuplicate: { date: string; amount: number; description: string } | null = null;

  for (const t of transactions) {
    if (!t || typeof t !== 'object') continue;
    const typeLower = String(t.type || '').toLowerCase();
    const rawAmount = Number(t.amount) || 0;
    const baseAmount = getAmountInBaseCurrency(rawAmount, t.currency, t.baseAmount);
    const dateStr = String(t.date || '');
    const category = typeLower === 'expense' ? normalizeToCanonicalCategory(String(t.category || 'Other'), 'Expense', String(t.description || '')) : String(t.category || 'Other');
    const description = String(t.description || '');

    if (typeLower === 'income' && baseAmount > 0 && dateStr.startsWith(currentYearMonth)) {
      actualIncomeThisMonth += baseAmount;
    }

    if (typeLower === 'expense' && baseAmount > 0) {
      if (dateStr.startsWith(currentYearMonth) && !isTripQuarantinedExpense(t)) {
        currentMonthTotalSpent += baseAmount;
        if (!isTripQuarantinedExpense(t)) {
          categorySpending[category] = Number(((categorySpending[category] || 0) + baseAmount).toFixed(2));
        }
      }

      if (!isTripQuarantinedExpense(t)) { if (!categoryValues[category]) categoryValues[category] = [];
      categoryValues[category].push(baseAmount); }

      if (pendingReceipt && pendingReceipt.amount > 0) {
        if (Math.abs(rawAmount - pendingReceipt.amount) < 0.05 || Math.abs(baseAmount - pendingReceipt.amount) < 0.05) {
          const merchantA = description.toLowerCase().replace(/[^a-z0-9]/g, '');
          const merchantB = (pendingReceipt.merchant || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          if (merchantA && merchantB && (merchantA.includes(merchantB) || merchantB.includes(merchantA))) {
            potentialDuplicate = {
              date: dateStr,
              amount: baseAmount,
              description,
            };
          }
        }
      }
    }
  }

  const categoryMedians: Record<string, number> = {};
  for (const [cat, vals] of Object.entries(categoryValues)) {
    if (vals.length === 0) continue;
    vals.sort((a, b) => a - b);
    const mid = Math.floor(vals.length / 2);
    categoryMedians[cat] = Number(
      (vals.length % 2 === 0 ? (vals[mid - 1] + vals[mid]) / 2 : vals[mid]).toFixed(2)
    );
  }

  const categoryCaps = getSavedCategoryCaps();
  const lockedCaps = getLockedCategoryCaps();
  const sumOfCategoryCaps = CANONICAL_EXPENSE_CATEGORIES.reduce((s, cat) => s + resolveCategoryCapValue(cat, categoryCaps, 0), 0);

  const savingsPred = predictMonthlySavingsAndInvestments(transactions, {
    baselineIncome: profile.baselineIncome || (actualIncomeThisMonth > 0 ? actualIncomeThisMonth : undefined),
    savingsTargetPct: profile.savingsTargetPct,
    investmentTargetPct: profile.investmentTargetPct,
    selectedMonth: currentYearMonth,
    referenceDate: safeRefDate,
  });

  const paydayInfo = getPaydayCycleIntelligence(transactions, {
    paydayDay: profile.paydayDay ?? undefined,
    baselineIncome: savingsPred.baselineIncome,
    savingsTargetPct: savingsPred.savingsTargetPct,
    investmentTargetPct: savingsPred.investmentTargetPct,
    referenceDate: safeRefDate,
  });

  const { unpaidReserveByCategory } = getCategoryCommitmentBreakdown(transactions, currentYearMonth, { referenceDate: safeRefDate });

  const categorySnapshots: CategoryCashflowSnapshot[] = [];
  const overCapCategories: string[] = [];

  for (const cat of CANONICAL_EXPENSE_CATEGORIES) {
    const cap = resolveCategoryCapValue(cat, categoryCaps, 0);
    const spent = Number((categorySpending[cat] || 0).toFixed(2));
    const unpaidBillReserve = Number((unpaidReserveByCategory.get(cat) || 0).toFixed(2));
    const unreservedRemaining = Number((cap - spent - unpaidBillReserve).toFixed(2));
    const status: CategoryCashflowSnapshot['status'] =
      unreservedRemaining < 0 ? 'over_cap' : cap > 0 && (spent + unpaidBillReserve) / cap >= 0.85 ? 'tight' : 'on_track';
    if (status === 'over_cap') {
      overCapCategories.push(cat);
    }
    categorySnapshots.push({
      category: cat,
      cap,
      spent,
      unpaidBillReserve,
      unreservedRemaining,
      isLocked: Boolean(lockedCaps[cat]),
      status,
    });
  }

  let smartRebalanceSummary: string | undefined;
  let rebalancePlan: CategoryRebalanceSuggestion | undefined;
  if (overCapCategories.length > 0 || (queryKeyword && isRebalanceBudgetRequest(queryKeyword))) {
    const built = buildRebalanceCapsProposedAction(queryKeyword || '', transactions, profile, today);
    if (built) {
      rebalancePlan = built.rebalancePlan;
      smartRebalanceSummary = built.rebalancePlan.summaryText;
    } else if (overCapCategories.length > 0) {
      rebalancePlan = rebalanceCategoryCapsForSpending({
        currentMonthTransactions: transactions,
        currentCaps: categoryCaps,
        lockedCaps,
        maxLivingBudget: savingsPred.targetLivingBudget,
        targetCategory: overCapCategories[0],
        targetMonth: currentYearMonth,
        referenceDate: safeRefDate,
      });
      smartRebalanceSummary = rebalancePlan.summaryText;
    }
  }

  const cashflowBriefing: PersonalCashflowBriefing = {
    baselineIncome: savingsPred.baselineIncome,
    actualIncomeThisMonth: Number(actualIncomeThisMonth.toFixed(2)),
    targetSavingsAmount: savingsPred.targetSavingsAmount,
    targetInvestmentAmount: savingsPred.targetInvestmentAmount,
    targetLivingBudget: savingsPred.targetLivingBudget,
    spentSoFar: savingsPred.spentSoFar,
    tripQuarantinedSpent: savingsPred.tripQuarantinedSpent || 0,
    unpaidCommittedBillsReserve: savingsPred.unpaidCommittedReserve || 0,
    remainingSafeLivingPool: Number(
      Math.max(0, savingsPred.targetLivingBudget - savingsPred.spentSoFar - (savingsPred.unpaidCommittedReserve || 0)).toFixed(2)
    ),
    safeDailyLivingAllowance: savingsPred.safeDailyLivingAllowance,
    daysRemainingInMonth: savingsPred.daysRemaining,
    daysUntilPayday: paydayInfo.daysUntilPayday,
    pacingStatus: savingsPred.pacingStatus,
    categorySnapshots,
    overCapCategories,
    smartRebalanceSummary,
    rebalancePlan,
    paydayEnvelopePlan: paydayInfo.envelopePlan,
  };

  const effectiveMonthlyBudget =
    profile.monthlyBudgetCap && profile.monthlyBudgetCap > 0
      ? profile.monthlyBudgetCap
      : savingsPred.targetLivingBudget > 0
      ? savingsPred.targetLivingBudget
      : sumOfCategoryCaps > 0
      ? sumOfCategoryCaps
      : null;

  const currentMonthBudgetRemaining =
    effectiveMonthlyBudget !== null ? effectiveMonthlyBudget - currentMonthTotalSpent : null;

  let matchedRecordCount = 0;
  let matchedExactSpent = 0;
  let queryItemFoundInLedger = false;
  let timeframeLabel: string | undefined;
  let categoryLabel: string | undefined;
  let priceLadder: DeterministicLedgerFacts['priceLadder'];
  let categoryBreakdown: DeterministicLedgerFacts['categoryBreakdown'];
  let largestExpense: DeterministicLedgerFacts['largestExpense'];
  let relevantTransactionsSample: DeterministicLedgerFacts['relevantTransactionsSample'];

  const cleanQuery = queryKeyword?.trim() || '';
  if (cleanQuery.length >= 2) {
    try {
      const copilotFacts = computeCopilotFacts(cleanQuery, transactions as any, today);
      timeframeLabel = copilotFacts.timeframeLabel;
      categoryLabel = copilotFacts.categoryLabel;
      priceLadder = copilotFacts.priceLadder;
      categoryBreakdown = copilotFacts.categoryBreakdown;
      largestExpense = copilotFacts.largestExpense;
      if (copilotFacts.relevantTransactionsSample && copilotFacts.relevantTransactionsSample.length > 0) {
        relevantTransactionsSample = copilotFacts.relevantTransactionsSample.map((t) => ({
          date: t.date,
          description: t.description || '',
          category: t.category || '',
          amount: Number(getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount).toFixed(2)),
          type: t.type,
        }));
      }

      if (copilotFacts.transactionCount > 0 || copilotFacts.isFoundInPersonalLedger) {
        matchedRecordCount = copilotFacts.transactionCount;
        matchedExactSpent = copilotFacts.exactTotalSpent;
        queryItemFoundInLedger = true;
      }
    } catch (err) {
      console.warn('[computeDeterministicLedgerFacts] Copilot facts error:', err);
    }

    if (!queryItemFoundInLedger) {
      const lowerQ = cleanQuery.toLowerCase();
      for (const t of transactions) {
        if (!t || typeof t !== 'object') continue;
        const typeLower = String(t.type || '').toLowerCase(); const isExpense = typeLower === 'expense'; const rawCatFallback = String(t.category || 'Other');
        const baseAmt = getAmountInBaseCurrency(Number(t.amount) || 0, t.currency, t.baseAmount);
        const category = typeLower === 'expense' ? normalizeToCanonicalCategory(String(t.category || 'Other'), 'Expense', String(t.description || '')) : String(t.category || 'Other');
        const description = String(t.description || '');

        if (isExpense && baseAmt > 0) {
          if (description.toLowerCase().includes(lowerQ) || category.toLowerCase().includes(lowerQ) || rawCatFallback.toLowerCase().includes(lowerQ)) {
            matchedRecordCount += 1;
            matchedExactSpent += baseAmt;
            queryItemFoundInLedger = true;
          }
        }
      }
    }
  }

  return {
    currentMonthTotalSpent: Number(currentMonthTotalSpent.toFixed(2)),
    currentMonthBudgetRemaining:
      currentMonthBudgetRemaining !== null ? Number(currentMonthBudgetRemaining.toFixed(2)) : null,
    categorySpending,
    categoryCaps,
    lockedCaps,
    categoryMedians,
    matchedRecordCount,
    matchedExactSpent: Number(matchedExactSpent.toFixed(2)),
    queryItemFoundInLedger,
    timeframeLabel,
    categoryLabel,
    priceLadder,
    categoryBreakdown,
    largestExpense,
    potentialDuplicate,
    relevantTransactionsSample,
    cashflowBriefing,
  };
}

export interface RunKinovaTurnOptions {
  text?: string;
  imageBase64?: string;
  mimeType?: string;
  today?: string;
  profile?: UserMoneyProfile;
  transactions?: Array<any>;
  sessionTurns?: AssistantTurnMessage[];
  pendingContext?: AssistantPendingContext | null;
  forceAssistant?: boolean;
  factQuery?: string;
  pendingReceipt?: { amount: number; merchant?: string; date?: string };
  habitMemories?: HabitMemoryItem[];
  signal?: AbortSignal;
}

export async function runKinovaTurn(
  options: RunKinovaTurnOptions
): Promise<KinovaTurnResult> {
  const today = options.today || getLocalDateString();
  const profile = options.profile || getUserMoneyProfile(options.transactions);
  const text = (options.text || '').trim();
  const parserCandidate = options.imageBase64 ? null : buildAssistantParserCandidate(text);
  if (text && !options.imageBase64 && !options.forceAssistant) {
    const localMatch = routeLocalIntent(text, profile, today);
    if (localMatch) {
      return {
        source: 'local',
        localResult: localMatch,
      };
    }
  }

  const allTx = options.transactions || [];
  const isRebalanceReq = Boolean(text && isRebalanceBudgetRequest(text));
  const useExtendedReasoning = isRebalanceReq || requiresExtendedReasoning(text, Boolean(options.imageBase64));
  const includeLedgerContext =
    useExtendedReasoning ||
    Boolean(options.factQuery || options.pendingReceipt);
  const deterministicFacts = includeLedgerContext
    ? computeDeterministicLedgerFacts(
        allTx,
        profile,
        options.factQuery || text,
        today,
        options.pendingReceipt
      )
    : undefined;

  const ledgerSample = deterministicFacts
    ? deterministicFacts.relevantTransactionsSample && deterministicFacts.relevantTransactionsSample.length > 0
      ? deterministicFacts.relevantTransactionsSample.slice(0, 20)
      : allTx.slice(0, 20).map((t) => ({
          date: String(t.date || ''),
          description: String(t.description || ''),
          category: String(t.category || ''),
          amount: Number(getAmountInBaseCurrency(Number(t.amount) || 0, t.currency, t.baseAmount).toFixed(2)),
          type: String(t.type || 'Expense'),
        }))
    : undefined;

  const habits = includeLedgerContext
    ? mineUserHabitSuggestions(allTx as any, undefined, undefined, profile.rejectedChips).slice(0, 5)
    : [];
  const habitMemories = serializeHabitMemoriesForPrompt(options.habitMemories ?? getHabitMemories(), 30);

  const res = await fetch('/api/ai/assistant', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: options.signal || AbortSignal.timeout(useExtendedReasoning ? 50_000 : 20_000),
    body: JSON.stringify({
      text: text || undefined,
      imageBase64: options.imageBase64 || undefined,
      mimeType: options.mimeType || undefined,
      today,
      profile: {
        language: profile.language,
        paydayDay: profile.paydayDay,
        monthlyBudgetCap: profile.monthlyBudgetCap,
        baselineIncome: profile.baselineIncome,
        savingsTargetPct: profile.savingsTargetPct,
        investmentTargetPct: profile.investmentTargetPct,
        emergencyReserve: profile.emergencyReserve,
        goals: profile.goals,
        rejectedChips: profile.rejectedChips,
        habitMemories,
        habits: habits.map((h) => ({
          text: h.text,
          amount: h.actionPayload?.amount,
          category: h.actionPayload?.category || 'Food & Dining',
          source: h.isPersonalized ? 'learned_habit' : 'default',
        })),
      },
      recentActions: profile.recentActions,
      sessionTurns: options.sessionTurns,
      ...(options.pendingContext ? { pendingContext: options.pendingContext } : {}),
      ...(parserCandidate ? { parserCandidate } : {}),
      ...(deterministicFacts ? { deterministicFacts } : {}),
      ...(ledgerSample ? { ledgerSample } : {}),
    }),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.error || `Kinova Assistant error (${res.status})`);
  }

  const responseJson = await res.json();
  if (!responseJson.success || !responseJson.data) {
    throw new Error(responseJson.error || 'Empty response from Kinova Assistant');
  }

  const assistantResult = responseJson.data as AssistantApiResponse;

  // Pillar 1.1: If user requested budget rebalancing (or Gemini returned mode='rebalance')
  // and proposedAction isn't already populated, attach the deterministic `rebalance_caps` action card!
  if (
    (isRebalanceReq || assistantResult.mode === 'rebalance') &&
    (!assistantResult.proposedAction || assistantResult.proposedAction.type !== 'rebalance_caps')
  ) {
    const builtRebalance = buildRebalanceCapsProposedAction(text, allTx, profile, today);
    if (builtRebalance) {
      assistantResult.proposedAction = builtRebalance.proposedAction;
    }
  }

  return {
    source: 'assistant',
    assistantResult,
    model: responseJson.model,
  };
}

export function parseAssistantJsonResponse(rawText: string): Record<string, unknown> {
  if (!rawText || typeof rawText !== 'string') {
    throw new Error('Empty assistant response');
  }

  let clean = rawText.trim();
  const fenceMatch = clean.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    clean = fenceMatch[1].trim();
  }

  try {
    return JSON.parse(clean);
  } catch {
    const match = clean.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        throw new Error('Assistant returned invalid JSON');
      }
    }
    throw new Error('Assistant returned invalid JSON');
  }
}
