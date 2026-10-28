/**
 * Kinova Assistant Client Orchestrator.
 *
 * Implements the "two speeds, one assistant" architecture:
 * 1. Fast Path (Local, 0ms, 0 API cost):
 *    - Session control (undo, repeat, correct)
 *    - Instant preferences (payday, budget, alias)
 *    - Clear unambiguous expenses ("Shell 60", "午餐 15") -> labeled "Quick parse"
 * 2. Assistant Path (Gemini with Thinking):
 *    - Debounced ~400ms after user stops typing
 *    - Advice, questions, judgment ("can I afford this?", "怎么看这笔")
 *    - Complex multi-part input, tax relief, trades, installments, trips
 *    - Receipt & payment screenshot interpretation
 */

import { routeLocalIntent, type LocalRouteResult } from './intent-router.ts';
import { getUserMoneyProfile, type UserMoneyProfile } from './user-money-profile.ts';
import { getLocalDateString } from './date-helper.ts';
import type { AiCommand } from '../types/ai-command.ts';

export interface AssistantTurnMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface DeterministicLedgerFacts {
  currentMonthTotalSpent: number;
  currentMonthBudgetRemaining: number | null;
  categorySpending: Record<string, number>;
  categoryMedians: Record<string, number>;
  matchedRecordCount: number;
  matchedExactSpent: number;
  queryItemFoundInLedger: boolean;
  potentialDuplicate: { date: string; amount: number; description: string } | null;
}

export interface AssistantApiResponse {
  mode: 'record' | 'advise' | 'correct' | 'repeat' | 'undo' | 'set_preference' | 'navigate' | 'clarify' | 'unknown';
  reasoning: string;
  answer: string;
  proposedAction: {
    label: string;
    type: 'save_transaction' | 'save_trade' | 'save_installment' | 'save_trip' | 'set_preference' | 'navigate' | 'undo';
    payload: Record<string, unknown>;
  } | null;
  command: AiCommand | null;
  clarification: {
    question: string;
    options: [string, string];
  } | null;
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
 * Computes deterministic facts across 100% of the user's ledger transactions.
 * Never ask the AI to do math on a sample.
 */
export function computeDeterministicLedgerFacts(
  transactions: Array<{
    id?: string;
    date?: string;
    type?: string;
    category?: string;
    description?: string;
    amount?: number;
  }>,
  profile: UserMoneyProfile,
  queryKeyword?: string,
  today: string = getLocalDateString(),
  pendingReceipt?: { amount: number; merchant?: string; date?: string }
): DeterministicLedgerFacts {
  const currentYearMonth = today.slice(0, 7);
  let currentMonthTotalSpent = 0;
  const categorySpending: Record<string, number> = {};
  const categoryValues: Record<string, number[]> = {};

  let matchedRecordCount = 0;
  let matchedExactSpent = 0;
  let queryItemFoundInLedger = false;
  const cleanQuery = queryKeyword?.trim().toLowerCase() || '';

  let potentialDuplicate: { date: string; amount: number; description: string } | null = null;

  for (const t of transactions) {
    if (!t || typeof t !== 'object') continue;
    const isExpense = String(t.type || '').toLowerCase() === 'expense';
    const amount = Number(t.amount) || 0;
    const dateStr = String(t.date || '');
    const category = String(t.category || 'Other');
    const description = String(t.description || '');

    if (isExpense && amount > 0) {
      // Month-to-date total
      if (dateStr.startsWith(currentYearMonth)) {
        currentMonthTotalSpent += amount;
        categorySpending[category] = (categorySpending[category] || 0) + amount;
      }

      // Collect amounts for median calculation (last 90 days)
      if (!categoryValues[category]) categoryValues[category] = [];
      categoryValues[category].push(amount);

      // Check query keyword match
      if (cleanQuery.length >= 2) {
        if (
          description.toLowerCase().includes(cleanQuery) ||
          category.toLowerCase().includes(cleanQuery)
        ) {
          matchedRecordCount += 1;
          matchedExactSpent += amount;
          queryItemFoundInLedger = true;
        }
      }

      // Check duplicate against pending receipt
      if (pendingReceipt && pendingReceipt.amount > 0) {
        if (Math.abs(amount - pendingReceipt.amount) < 0.05) {
          const merchantA = description.toLowerCase().replace(/[^a-z0-9]/g, '');
          const merchantB = (pendingReceipt.merchant || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          if (merchantA && merchantB && (merchantA.includes(merchantB) || merchantB.includes(merchantA))) {
            potentialDuplicate = {
              date: dateStr,
              amount,
              description,
            };
          }
        }
      }
    }
  }

  // Calculate medians
  const categoryMedians: Record<string, number> = {};
  for (const [cat, vals] of Object.entries(categoryValues)) {
    if (vals.length === 0) continue;
    vals.sort((a, b) => a - b);
    const mid = Math.floor(vals.length / 2);
    categoryMedians[cat] =
      vals.length % 2 === 0 ? (vals[mid - 1] + vals[mid]) / 2 : vals[mid];
  }

  const currentMonthBudgetRemaining =
    profile.monthlyBudgetCap && profile.monthlyBudgetCap > 0
      ? profile.monthlyBudgetCap - currentMonthTotalSpent
      : null;

  return {
    currentMonthTotalSpent: Number(currentMonthTotalSpent.toFixed(2)),
    currentMonthBudgetRemaining:
      currentMonthBudgetRemaining !== null ? Number(currentMonthBudgetRemaining.toFixed(2)) : null,
    categorySpending,
    categoryMedians,
    matchedRecordCount,
    matchedExactSpent: Number(matchedExactSpent.toFixed(2)),
    queryItemFoundInLedger,
    potentialDuplicate,
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
  forceAssistant?: boolean;
}

/**
 * Executes a turn of Kinova.
 * If text has an instant local match, returns instantly.
 * Otherwise, calls the Gemini Assistant endpoint.
 */
export async function runKinovaTurn(
  options: RunKinovaTurnOptions
): Promise<KinovaTurnResult> {
  const today = options.today || getLocalDateString();
  const profile = options.profile || getUserMoneyProfile(options.transactions);
  const text = (options.text || '').trim();

  // If text-only and not forced to assistant, check local router first (0ms latency)
  if (text && !options.imageBase64 && !options.forceAssistant) {
    const localMatch = routeLocalIntent(text, profile, today);
    if (localMatch) {
      return {
        source: 'local',
        localResult: localMatch,
      };
    }
  }

  // Assistant path (Gemini)
  const allTx = options.transactions || [];
  const deterministicFacts = computeDeterministicLedgerFacts(
    allTx,
    profile,
    text,
    today
  );

  // Take small sample of matching or recent transactions
  const ledgerSample = allTx
    .slice(0, 20)
    .map((t) => ({
      date: String(t.date || ''),
      description: String(t.description || ''),
      category: String(t.category || ''),
      amount: Number(t.amount) || 0,
      type: String(t.type || 'Expense'),
    }));

  const res = await fetch('/api/ai/assistant', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
        emergencyReserve: profile.emergencyReserve,
        goals: profile.goals,
        rejectedChips: profile.rejectedChips,
      },
      deterministicFacts,
      recentActions: profile.recentActions,
      sessionTurns: options.sessionTurns,
      ledgerSample,
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

  return {
    source: 'assistant',
    assistantResult: responseJson.data as AssistantApiResponse,
    model: responseJson.model,
  };
}

/**
 * Safely parses raw assistant text output into structured JSON,
 * stripping markdown fences and thought blocks.
 */
export function parseAssistantJsonResponse(rawText: string): Record<string, unknown> {
  if (!rawText || typeof rawText !== 'string') {
    throw new Error('Empty assistant response');
  }

  let clean = rawText.trim();
  // Strip code fences if present
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

