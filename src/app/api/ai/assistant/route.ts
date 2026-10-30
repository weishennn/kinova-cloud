import { NextRequest, NextResponse } from 'next/server';
import { getValidGoogleSession } from '@/lib/google-auth';
import { recordUserAiCall } from '@/lib/admin-registry';
import { generateGeminiContent } from '@/lib/gemini-key-pool';
import { getLocalDateString } from '@/lib/date-helper';
import { normalizeToCanonicalCategory } from '@/lib/canonical-categories';
import {
  parseAssistantJsonResponse,
  type AssistantParserCandidate,
  type AssistantPendingContext,
  shouldUseTransactionCapturePrompt,
} from '@/lib/kinova-assistant';
import { requiresExtendedReasoning } from '@/lib/intent-router';

export interface AssistantTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface AssistantRequestBody {
  text?: string;
  pendingContext?: AssistantPendingContext | null;
  parserCandidate?: AssistantParserCandidate | null;
  imageBase64?: string;
  mimeType?: string;
  today?: string;
  profile?: {
    language?: 'zh' | 'en' | 'ms' | 'auto';
    paydayDay?: number | null;
    monthlyBudgetCap?: number | null;
    baselineIncome?: number | null;
    emergencyReserve?: number | null;
    goals?: Array<{ name: string; targetAmount: number; currentAmount?: number }>;
    rejectedChips?: Array<{ text: string }>;
    habits?: Array<{ text: string; amount?: number; category: string; source?: string }>;
  };
  deterministicFacts?: {
    currentMonthTotalSpent?: number;
    currentMonthBudgetRemaining?: number;
    categorySpending?: Record<string, number>;
    categoryMedians?: Record<string, number>;
    matchedRecordCount?: number;
    matchedExactSpent?: number;
    queryItemFoundInLedger?: boolean;
    timeframeLabel?: string;
    categoryLabel?: string;
    priceLadder?: Array<{ store: string; unitPrice: number; unit: string; date: string; isLowest: boolean }>;
    categoryBreakdown?: Array<{ category: string; amount: number; percentage: number }>;
    largestExpense?: { id?: string; date: string; description: string; category?: string; amount: number } | null;
    potentialDuplicate?: { date: string; amount: number; description: string } | null;
  };
  recentActions?: Array<{
    actionType: string;
    summary: string;
    timestamp: number;
    payload?: Record<string, unknown>;
  }>;
  sessionTurns?: AssistantTurn[];
  ledgerSample?: Array<{
    date: string;
    description: string;
    category: string;
    amount: number;
    type: string;
  }>;
}

const PENDING_INTENTS = new Set<AssistantPendingContext['intent']>([
  'transaction', 'installment', 'trade', 'trip',
]);

function normalizePendingContext(value: unknown): AssistantPendingContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.intent !== 'string' ||
    !PENDING_INTENTS.has(candidate.intent as AssistantPendingContext['intent']) ||
    typeof candidate.originalRequest !== 'string' ||
    !candidate.originalRequest.trim() ||
    !candidate.knownFields ||
    typeof candidate.knownFields !== 'object' ||
    Array.isArray(candidate.knownFields) ||
    !Array.isArray(candidate.missingFields)
  ) return null;

  const knownFields = candidate.knownFields as Record<string, unknown>;
  try {
    if (JSON.stringify(knownFields).length > 6000) return null;
  } catch {
    return null;
  }

  return {
    intent: candidate.intent as AssistantPendingContext['intent'],
    originalRequest: candidate.originalRequest.trim().slice(0, 1200),
    knownFields,
    missingFields: candidate.missingFields
      .filter((field): field is string => typeof field === 'string' && Boolean(field.trim()))
      .slice(0, 12),
  };
}

function normalizeParserCandidate(value: unknown): AssistantParserCandidate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.amount !== 'number' || !Number.isFinite(candidate.amount) || candidate.amount <= 0 ||
    typeof candidate.currency !== 'string' || !candidate.currency.trim() ||
    (candidate.type !== 'Expense' && candidate.type !== 'Income') ||
    typeof candidate.category !== 'string' || !candidate.category.trim() ||
    !Array.isArray(candidate.unresolvedFields)
  ) return null;

  return {
    amount: candidate.amount,
    currency: candidate.currency.trim().slice(0, 8),
    type: candidate.type,
    category: candidate.category.trim().slice(0, 80),
    unresolvedFields: candidate.unresolvedFields
      .filter((field): field is string => typeof field === 'string' && Boolean(field.trim()))
      .slice(0, 8),
  };
}

const ASSISTANT_SYSTEM_PROMPT = `You are Kinova, this user's personal financial assistant in Malaysia. You help them think and act. You are not a receipt OCR bot.

Today is {{TODAY}}. Default currency MYR. Reply in the language of this turn (Chinese, English, Malay, or Manglish). Use profile.language when it is zh, en, or ms.

You receive:
- USER PROFILE (payday, budget, reserve, goals, habits, rejected chips). These are facts the user can edit. Do not invent missing profile fields.
- DETERMINISTIC LEDGER FACTS computed in code across the whole ledger. Quote these numbers exactly. Never recompute totals from the sample.
- LAST 6 TURNS and LAST 8 ACTIONS so "undo", "that one", "same again", and "what about last month?" work.
- A small sample of matching transactions for names and dates only.

Decide exactly one mode:
- record: they want something logged. Fill the existing transaction | installment | trade | trip shape. Do not invent amount, ticker, tax rate, or date. Missing required fields => mode clarify.
- advise: they want a judgment (can I afford this, is this expensive for me, which store was cheaper, am I over budget, should this be tax relief). Answer from their numbers. One direct opinion, the evidence, and at most one proposed action. No generic lecture.
- correct: patch the last action (amount, category, merchant, date, type).
- repeat: same as the last expense, date = today unless they named one.
- undo: only the last confirmed action in this session.
- set_preference: payday, budget, baseline income, emergency reserve, language, merchant alias.
- navigate: an existing page.
- clarify: two intents are close, or a required field is missing. Ask one question. Offer at most 2 choices.
- unknown: you cannot tell. Ask one question.

For a recording request, treat an explicit bare number as the amount in the default currency unless the message clearly identifies it as a date, time, quantity, percentage, or calculation. Never ask for an amount already present in the original message.
When the user names a merchant or purpose, put those words in transaction data.description, excluding the amount and date phrase. A simple expense phrase with a merchant/purpose and amount is a record request. Do not leave description null.

If a LOCAL PARSER CANDIDATE is provided, it is supporting evidence extracted from the same message, not a final decision. Check it against the original wording and use values that the wording supports. For a clear recording request, carry a supported candidate amount into the command and pendingContext; do not ask the user to repeat it. Never use a candidate for a field listed as unresolvedFields, and use the original wording to resolve those fields.

Clarification state:
- When a record request is missing required information, return pendingContext with the intent, the original request, every field you understand with its value, and only the required fields still missing.
- When pendingContext is supplied, interpret the new user message in the context of the unresolved fields. Merge an answer into knownFields, preserve all previously understood fields, keep originalRequest as the initial request, and recompute missingFields. Do not ask the user to repeat a field already known.
- If the new message completes the request, return the complete command and set pendingContext to null. If it clearly starts an unrelated request, handle it as a new request.
- Do not guess uncertain values. A clarification response must preserve the current state in pendingContext so the next reply can continue from it.

Rules:
- If the ledger has no matching records, say clearly that no records exist in their personal ledger (e.g. "在你的个人账本中暂无此记录" / "No matching records found in your personal ledger"). NEVER invent or hallucinate market prices when there is no match. Missing data must be explicitly reported as missing.
- For receipts or screenshots: extract the net out-of-pocket amount, items, tax, and deductions. Then interpret: tax relief hint (e.g. LHDN Lifestyle RM2,500, Medical RM10,000), duplicate check against facts, comparison to user median, and one proposed action button.
- Always provide reasoning: 1-2 concise user-facing sentences citing evidence (e.g. "6 weekday lunches, median RM 15.50" or "receipt net RM 42.30 after SST, not the pre-discount bill"). Never dump raw chain of thought.
- For mode "record" with a transaction, command.data must include amount (number), currency, type, category, description (non-empty string), and date (YYYY-MM-DD). Use the merchant/purpose words from the user's message for description; never return null when those words are present.
- Resolve relative date language against Today and return a YYYY-MM-DD date; never replace a named past/future period with today. If the period does not identify the transaction's exact day, ask only for the date.
- Return ONLY valid JSON matching this schema:
{
  "mode": "record" | "advise" | "correct" | "repeat" | "undo" | "set_preference" | "navigate" | "clarify" | "unknown",
  "reasoning": string,
  "answer": string,
  "proposedAction": {
    "label": string,
    "type": "save_transaction" | "save_trade" | "save_installment" | "save_trip" | "set_preference" | "navigate" | "undo",
    "payload": { ... }
  } | null,
  "command": {
    "intent": "transaction" | "installment" | "trade" | "trip",
    "confidence": 0.0 - 1.0,
    "data": object
  } | null,
  "clarification": {
    "question": string,
    "options": [string, string]
  } | null,
  "pendingContext": {
    "intent": "transaction" | "installment" | "trade" | "trip",
    "originalRequest": string,
    "knownFields": object,
    "missingFields": string[]
  } | null,
  "receiptAnalysis": {
    "merchant": string,
    "netAmount": number,
    "taxReliefCategory": string | null,
    "isDuplicate": boolean,
    "comparisonToMedian": string | null
  } | null
}`;

const TRANSACTION_CAPTURE_SYSTEM_PROMPT = `You are Kinova's transaction capture assistant.
Today is {{TODAY}}. The default currency is MYR. Read the full user message and return either a complete transaction command or one clarification.

The LOCAL PARSER CANDIDATE, when present, contains syntactically recognized fields from the same message. Validate it against the original wording. If the wording supports the candidate amount as the purchase amount, use it; do not ask for that amount again. Treat it as a candidate, not as permission to invent other fields. Do not use any field listed in unresolvedFields.

For an ordinary transaction with no explicit date, use Today. Resolve any date the user names against Today. If their date expression identifies a period but not a specific transaction day, ask only for the missing date. When the user answers a clarification, use PENDING CLARIFICATION STATE and the recent turns to complete the original request, preserving its known fields. Do not ask again for a known field.

Use the user's merchant or purpose as description. Use canonical categories and MYR unless another currency is stated. Do not invent an amount, date, merchant, or tax. If the user explicitly describes tax, calculate only what the provided information supports and preserve tax details in the transaction data.

For mode record, command.data must contain amount, currency, type, category, non-empty description, and date (YYYY-MM-DD). For mode clarify, return the known fields and only unresolved required fields in pendingContext. Keep originalRequest as the initial request across clarification turns. Set command and proposedAction to null for clarify; set clarification to null and pendingContext to null for record.

Return ONLY valid JSON with this shape:
{
  "mode": "record" | "clarify",
  "reasoning": string,
  "answer": string,
  "proposedAction": object | null,
  "command": { "intent": "transaction", "confidence": number, "data": object } | null,
  "clarification": { "question": string, "options": string[] } | null,
  "pendingContext": { "intent": "transaction", "originalRequest": string, "knownFields": object, "missingFields": string[] } | null,
  "receiptAnalysis": null
}`;

export async function POST(req: NextRequest) {
  try {
    const { session } = await getValidGoogleSession(req);
    if (!session) {
      return NextResponse.json(
        { success: false, error: 'Please sign in with your Google Account to use Kinova Assistant.' },
        { status: 401 }
      );
    }

    const aiStatus = await recordUserAiCall(session.email);
    if (!aiStatus.allowed) {
      return NextResponse.json(
        { success: false, error: 'Your account access has been restricted by the administrator.' },
        { status: 403 }
      );
    }

    const body: AssistantRequestBody = await req.json();
    const today = body.today || getLocalDateString();
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const imageBase64 = typeof body.imageBase64 === 'string' ? body.imageBase64.trim() : '';
    const mimeType = body.mimeType || 'image/jpeg';
    const pendingContext = normalizePendingContext(body.pendingContext);
    const parserCandidate = normalizeParserCandidate(body.parserCandidate);

    if (!text && !imageBase64) {
      return NextResponse.json(
        { success: false, error: 'Either text or an image is required for Kinova Assistant.' },
        { status: 400 }
      );
    }

    // Context blocks
    const profileBlock = body.profile
      ? `\n【USER PROFILE】: ${JSON.stringify(body.profile, null, 2)}\n`
      : '';

    const factsBlock = body.deterministicFacts
      ? `\n【DETERMINISTIC FACTS ACROSS FULL LEDGER】: ${JSON.stringify(body.deterministicFacts, null, 2)}\n`
      : '';

    const pendingContextBlock = pendingContext
      ? `\n【PENDING CLARIFICATION STATE】: ${JSON.stringify(pendingContext, null, 2)}\n`
      : '';

    const parserCandidateBlock = parserCandidate
      ? `\n【LOCAL PARSER CANDIDATE — validate against the original message】: ${JSON.stringify(parserCandidate, null, 2)}\n`
      : '';

    const actionsBlock = Array.isArray(body.recentActions) && body.recentActions.length > 0
      ? `\n【RECENT SESSION ACTIONS (LATEST FIRST)】: ${JSON.stringify(body.recentActions.slice(0, 8), null, 2)}\n`
      : '';

    const turnsBlock = Array.isArray(body.sessionTurns) && body.sessionTurns.length > 0
      ? `\n【RECENT CONVERSATION TURNS】: ${JSON.stringify(body.sessionTurns.slice(-6), null, 2)}\n`
      : '';

    const sampleBlock = Array.isArray(body.ledgerSample) && body.ledgerSample.length > 0
      ? `\n【SAMPLE RELEVANT TRANSACTIONS】: ${JSON.stringify(body.ledgerSample.slice(0, 20), null, 2)}\n`
      : '';

    const userPrompt = [
      text ? `User message: "${text}"` : 'Analyze this attached receipt or payment screenshot.',
      profileBlock,
      pendingContextBlock,
      parserCandidateBlock,
      factsBlock,
      actionsBlock,
      turnsBlock,
      sampleBlock,
    ]
      .filter(Boolean)
      .join('\n');

    const useExtendedReasoning = requiresExtendedReasoning(text, Boolean(imageBase64));
    const useTransactionCapturePrompt = shouldUseTransactionCapturePrompt(
      text,
      Boolean(imageBase64),
      parserCandidate,
    );
    const result = await generateGeminiContent({
      prompt: userPrompt,
      systemInstruction: (useTransactionCapturePrompt
        ? TRANSACTION_CAPTURE_SYSTEM_PROMPT
        : ASSISTANT_SYSTEM_PROMPT).replace('{{TODAY}}', today),
      imageBase64: imageBase64 || undefined,
      mimeType: imageBase64 ? mimeType : undefined,
      responseMimeType: 'application/json',
      thinking: useExtendedReasoning,
      thinkingBudget: useExtendedReasoning ? 128 : 0,
      temperature: useExtendedReasoning ? 0.4 : 0.1,
      maxOutputTokens: useExtendedReasoning ? 2048 : 1536,
      timeoutMs: useExtendedReasoning ? 15_000 : imageBase64 ? 20_000 : 10_000,
      totalTimeoutMs: useExtendedReasoning ? 20_000 : imageBase64 ? 25_000 : 15_000,
    });

    let parsedResult: Record<string, unknown>;
    try {
      parsedResult = parseAssistantJsonResponse(result.text);
    } catch {
      return NextResponse.json(
        { success: false, error: 'Assistant returned invalid JSON' },
        { status: 502 }
      );
    }

    parsedResult.pendingContext = parsedResult.mode === 'clarify'
      ? normalizePendingContext(parsedResult.pendingContext)
      : null;

    // Sanitize category if command is present
    if (parsedResult.command && typeof parsedResult.command === 'object') {
      const cmd = parsedResult.command as { data?: { category?: string; type?: string } };
      if (cmd.data?.category) {
        cmd.data.category = normalizeToCanonicalCategory(cmd.data.category, cmd.data.type);
      }
    }

    return NextResponse.json({
      success: true,
      data: parsedResult,
      model: result.model,
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Kinova Assistant request failed';
    console.error('[KinovaAssistant] Error:', errorMsg);
    return NextResponse.json(
      { success: false, error: errorMsg },
      { status: 502 }
    );
  }
}
