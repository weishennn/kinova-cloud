import { NextRequest, NextResponse } from 'next/server';
import { getValidGoogleSession } from '@/lib/google-auth';
import { recordUserAiCall } from '@/lib/admin-registry';
import { generateGeminiContent } from '@/lib/gemini-key-pool';
import { getLocalDateString } from '@/lib/date-helper';

interface CopilotTransactionContext {
  id: string;
  date: string;
  type: string;
  category: string;
  description: string;
  amount: number;
  currency: string;
  notes?: string;
  receiptItems?: Array<{
    name: string;
    quantity: number;
    unitPrice: number;
    amount: number;
    brand?: string;
  }>;
}

interface GroundedWebSource {
  title: string;
  uri: string;
}

function safeText(value: unknown, maxLength: number): string {
  return typeof value === 'string'
    ? value.trim().replace(/[\u0000-\u001f]/g, ' ').slice(0, maxLength)
    : '';
}

export async function POST(req: NextRequest) {
  try {
    const { session } = await getValidGoogleSession(req);
    if (!session) {
      return NextResponse.json(
        { success: false, error: 'Please sign in with your Google Account to use Kinova Copilot.' },
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

    const body = await req.json();
    const query = safeText(body?.query, 400);
    if (!query || query.length < 2) {
      return NextResponse.json(
        { success: false, error: 'Please enter a query or question.' },
        { status: 400 }
      );
    }

    const today = safeText(body?.today, 20) || getLocalDateString();
    const rawTxList = Array.isArray(body?.transactions) ? body.transactions : [];

    // Compact transactions to conserve tokens (keep recent expenses and those with receipt items)
    const transactionContext: CopilotTransactionContext[] = rawTxList
      .filter((t: unknown): t is Record<string, unknown> => Boolean(t) && typeof t === 'object')
      .slice(0, 150)
      .map((t: Record<string, unknown>) => ({
        id: String(t.id || ''),
        date: String(t.date || ''),
        type: String(t.type || 'expense'),
        category: String(t.category || ''),
        description: String(t.description || ''),
        amount: Number(t.amount) || 0,
        currency: String(t.currency || 'MYR'),
        notes: typeof t.notes === 'string' ? t.notes.slice(0, 160) : undefined,
        receiptItems: Array.isArray(t.receiptItems)
          ? t.receiptItems.slice(0, 15).map((it: Record<string, unknown>) => ({
              name: String(it.name || ''),
              quantity: Number(it.quantity) || 1,
              unitPrice: Number(it.unitPrice) || 0,
              amount: Number(it.amount) || 0,
              brand: typeof it.brand === 'string' ? it.brand : undefined,
            }))
          : undefined,
      }));

    const deterministicFacts = body?.deterministicFacts && typeof body.deterministicFacts === 'object'
      ? body.deterministicFacts
      : null;

    const factsBlock = deterministicFacts
      ? `
【DETERMINISTIC FACTS FROM 100% OF USER'S PERSONAL LEDGER】:
- Is Found in Personal Ledger: ${deterministicFacts.isFoundInPersonalLedger ? 'YES' : 'NO (NOT FOUND IN USER LEDGER)'}
- Statistical Timeframe: ${deterministicFacts.timeframeLabel || 'N/A'}
- Matched Ledger Records: ${Number(deterministicFacts.transactionCount) || 0} transactions
- Exact Total Spent: RM ${(Number(deterministicFacts.exactTotalSpent) || 0).toFixed(2)}
${deterministicFacts.categoryLabel ? `- Target Category: ${deterministicFacts.categoryLabel}` : ''}
${deterministicFacts.categoryBreakdown ? `- Category Breakdown: ${JSON.stringify(deterministicFacts.categoryBreakdown)}` : ''}
${deterministicFacts.largestExpense ? `- Largest Expense: ${deterministicFacts.largestExpense.date} 「${deterministicFacts.largestExpense.description}」 RM ${deterministicFacts.largestExpense.amount}` : ''}
${deterministicFacts.priceLadder && deterministicFacts.priceLadder.length > 0 ? `- Store Price Ladder: ${JSON.stringify(deterministicFacts.priceLadder)}` : ''}
`
      : '';

    const prompt = `You are Kinova AI Copilot, a 2026-era financial assistant for an expense tracker in Malaysia.
Today is ${today}. Currency is MYR unless stated otherwise.
The user asked: "${query}"
${factsBlock}
Here is a summary of the user's relevant ledger transactions & scanned receipts:
${JSON.stringify(transactionContext, null, 2)}

【TASK & STRICT 2026 ACCURACY INSTRUCTIONS】:
1. Multi-lingual: Understand Chinese, English, Malay, or Manglish. Answer in the same language the user asked (if Chinese, use clear Simplified Chinese).
2. ACCURACY & NO ARITHMETIC HALLUCINATIONS:
   If deterministic facts are provided above, they were programmatically calculated across the user's 100% entire ledger. You MUST state and use these exact numbers (RM ${(deterministicFacts?.exactTotalSpent || 0).toFixed(2)}, ${deterministicFacts?.transactionCount || 0} transactions, timeframe: ${deterministicFacts?.timeframeLabel || 'N/A'}). DO NOT recalculate or guess totals from the sample transactions.
3. PERSONAL LEDGER vs MARKET REFERENCE:
   - If the item/merchant was NOT found in the user's personal ledger (or transaction count is 0):
     You MUST explicitly state: "在你的个人账本中暂无此记录" (or "No records found in your personal ledger").
     DO NOT invent, fabricate, or guess market prices when there is no match. Missing data must be explicitly reported as missing.
     Set "type": "conversational".
   - If found in personal ledger:
     Interpret and explain the figures directly from the user's personal ledger facts.
4. For store comparisons (e.g. petrol stations, grocery stores), build or reference a "priceLadder" sorted from lowest unit price to highest.
5. If they received discounts or government subsidies (e.g. BUDI MADANI fuel subsidy, vouchers), summarize them in "savingsSummary".
6. Tone: Crisp, friendly, highly intelligent, and direct (no generic filler).

Return strictly a valid JSON object matching this schema:
{
  "headline": string,
  "answer": string,
  "type": "price_ladder" | "analytics" | "market_benchmark" | "conversational",
  "timeframe": string,
  "matchedCount": number,
  "isFoundInPersonalLedger": boolean,
  "priceLadder": [
    {
      "store": string,
      "unitPrice": number,
      "unit": string,
      "date": string,
      "isLowest": boolean
    }
  ],
  "savingsSummary": {
    "totalSaved": number,
    "details": string
  } | null,
  "actionTip": string | null
}`;

    const result = await generateGeminiContent({
      prompt,
      responseMimeType: 'application/json',
      thinking: true,
      thinkingBudget: 2048,
      temperature: 0.4,
      maxOutputTokens: 4096,
      timeoutMs: 45_000,
    });

    const parsed = JSON.parse(result.text);
    if (deterministicFacts) {
      parsed.timeframe = deterministicFacts.timeframeLabel || parsed.timeframe || '';
      parsed.matchedCount = Number(deterministicFacts.transactionCount) || 0;
      parsed.isFoundInPersonalLedger = Boolean(deterministicFacts.isFoundInPersonalLedger);
      parsed.exactTotalSpent = Number(deterministicFacts.exactTotalSpent) || 0;
      parsed.matchingTransactionIds = Array.isArray(deterministicFacts.matchingTransactionIds)
        ? deterministicFacts.matchingTransactionIds
        : [];
      if ((!parsed.priceLadder || parsed.priceLadder.length === 0) && Array.isArray(deterministicFacts.priceLadder)) {
        parsed.priceLadder = deterministicFacts.priceLadder;
      }
    }
    return NextResponse.json({ success: true, data: parsed, model: result.model });
  } catch (error) {
    console.error('[KinovaCopilot] Error:', error);
    const errorMsg = error instanceof Error ? error.message : 'Failed to process copilot query.';
    return NextResponse.json(
      { success: false, error: errorMsg },
      { status: 502 }
    );
  }
}
