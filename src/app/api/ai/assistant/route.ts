import { NextRequest, NextResponse } from 'next/server';
import { getValidGoogleSession } from '@/lib/google-auth';
import { recordUserAiCall } from '@/lib/admin-registry';
import { generateGeminiContent } from '@/lib/gemini-key-pool';
import { getLocalDateString } from '@/lib/date-helper';
import { normalizeToCanonicalCategory } from '@/lib/canonical-categories';
import { parseAssistantJsonResponse } from '@/lib/kinova-assistant';

export interface AssistantTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface AssistantRequestBody {
  text?: string;
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

Rules:
- If the ledger has no matching records, say clearly that no records exist in their personal ledger (e.g. "在你的个人账本中暂无此记录" / "No matching records found in your personal ledger"). NEVER invent or hallucinate market prices when there is no match. Missing data must be explicitly reported as missing.
- For receipts or screenshots: extract the net out-of-pocket amount, items, tax, and deductions. Then interpret: tax relief hint (e.g. LHDN Lifestyle RM2,500, Medical RM10,000), duplicate check against facts, comparison to user median, and one proposed action button.
- Always provide reasoning: 1-2 concise user-facing sentences citing evidence (e.g. "6 weekday lunches, median RM 15.50" or "receipt net RM 42.30 after SST, not the pre-discount bill"). Never dump raw chain of thought.
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
    "data": { ... }
  } | null,
  "clarification": {
    "question": string,
    "options": [string, string]
  } | null,
  "receiptAnalysis": {
    "merchant": string,
    "netAmount": number,
    "taxReliefCategory": string | null,
    "isDuplicate": boolean,
    "comparisonToMedian": string | null
  } | null
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
      factsBlock,
      actionsBlock,
      turnsBlock,
      sampleBlock,
    ]
      .filter(Boolean)
      .join('\n');

    const result = await generateGeminiContent({
      prompt: userPrompt,
      systemInstruction: ASSISTANT_SYSTEM_PROMPT.replace('{{TODAY}}', today),
      imageBase64: imageBase64 || undefined,
      mimeType: imageBase64 ? mimeType : undefined,
      responseMimeType: 'application/json',
      thinking: true,
      thinkingBudget: 2048,
      temperature: 0.4,
      maxOutputTokens: 4096,
      timeoutMs: 45_000,
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
