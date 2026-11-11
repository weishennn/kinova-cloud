import { NextRequest, NextResponse } from 'next/server';
import { getValidGoogleSession } from '@/lib/google-auth';
import { recordUserAiCall } from '@/lib/admin-registry';
import { generateGeminiContent } from '@/lib/gemini-key-pool';
import { parseAssistantJsonResponse } from '@/lib/kinova-assistant';
import { CANONICAL_EXPENSE_CATEGORIES } from '@/lib/canonical-categories';
import type { HabitCandidateRecord, HabitMemoryItem } from '@/lib/habit-memory-engine';
import {
  validateHabitOptimizationPlan,
  type HabitLedgerPatternSummary,
} from '@/lib/habit-optimizer';

export const maxDuration = 30;

const OPTIMIZE_HABITS_SYSTEM_PROMPT = `You are Kinova's Personal Habit Memory Curator.
Your job is to audit, declutter, merge, and enrich the user's Habit Memory rules so they NEVER bloat with junk, while accurately understanding the user's partial shorthand wording ("字眼").

You will receive:
1. EXISTING HABIT MEMORIES (each with id, rawPattern, preferredAlias, category, learnedSource, frequency, keywords).
2. STAGED CANDIDATES (patterns the user repeated/edited recently, waiting for curation).
3. RECURRING LEDGER PATTERNS (merchant/payee frequency summary from recent expenses).

Strict Curation Rules:
1. DROPS (dropIds): Recommend dropping ONLY low-value clutter in non-manual rules (learnedSource !== "manual"), OR obviously broken polluted entries:
   - Single generic food/commodity words (e.g. "sushi", "lunch", "dinner", "coffee", "petrol", "杂饭", "豆花", "奶茶") that are NOT specific shops or payees.
   - Long itemized receipt descriptions, one-off generic transactions, or trivial 1-to-1 rules where built-in classification already knows the category AND no useful shorthand alias/keyword exists.
   - NEVER propose dropping valid user "manual" rules unless clearly polluted receipt text.
2. MERGES (merges): If 2+ rules represent the same merchant/payee (e.g. "TAN CHIN HONG" & "TAN CHIN HONG ENT", or "Shell SS2" & "Shell Damansara"), merge them into the cleaner entry and combine their trigger keywords.
3. UPDATES & KEYWORDS ("字眼" extraction):
   - Users rarely type exact bank legal names or full merchant names — they type partial wording / shorthand ("字眼").
   - For each worthy habit rule (including manual ones!), extract 1 to 5 concise, HIGH-SIGNAL trigger keywords into "keywords" (e.g. for "TAN CHIN HONG" -> "四夕豆花", keywords: ["四夕", "tanchinhong"]; for "Sushi Zanmai", keywords: ["zanmai", "sushizanmai"]; for "abc" -> "zapfan", keywords: ["zapfan"]).
   - Also normalize messy/verbose non-manual preferredAlias into a crisp colloquial name (e.g. legal SSM name -> brand/shop name).
   - CRITICAL KEYWORD RULE: NEVER put generic commodity words ("sushi", "lunch", "food", "petrol", "coffee", "tea", "超市", "汽油", "午餐", "晚餐", "豆花", "杂饭") or company suffixes ("sdn", "bhd", "store", "shop", "mart") into "keywords", because those would falsely hijack other stores! Keywords must uniquely identify THIS merchant/habit.
4. ADDITIONS (additions): From STAGED CANDIDATES or RECURRING LEDGER PATTERNS, promote ONLY high-value recurring habits:
   - Hidden DuitNow/bank payee-to-colloquial-name translations, non-obvious category overrides (e.g. BookXcess -> Education), or frequent merchants with useful partial-wording "keywords".
   - Do NOT dump every recurring generic food/store into additions. Less is more!
   - Allowed expense categories ONLY: ${CANONICAL_EXPENSE_CATEGORIES.join(', ')}.

Reply in the user's language (default Chinese "zh" with natural concise explanations in summary & reason).
Return ONLY valid JSON matching this schema:
{
  "summary": "1-2 sentence summary of what was cleaned, merged, and enriched",
  "drops": [
    { "id": string, "reason": string }
  ],
  "merges": [
    {
      "keepId": string,
      "removeIds": string[],
      "rawPattern": string,
      "preferredAlias": string,
      "category": string,
      "keywords": string[],
      "reason": string
    }
  ],
  "updates": [
    {
      "id": string,
      "preferredAlias": string,
      "category": string,
      "keywords": string[],
      "reason": string
    }
  ],
  "additions": [
    {
      "rawPattern": string,
      "preferredAlias": string,
      "category": string,
      "keywords": string[],
      "timeSlot": "breakfast" | "lunch" | "dinner" | "any",
      "typicalAmount": number | null,
      "reason": string
    }
  ]
}`;

export async function POST(req: NextRequest) {
  try {
    const { session } = await getValidGoogleSession(req);
    if (!session) {
      return NextResponse.json(
        { success: false, error: 'Please sign in with your Google Account to optimize habit memory with AI.' },
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

    const body = await req.json().catch(() => ({}));
    const rawHabits = Array.isArray(body?.habits) ? (body.habits as HabitMemoryItem[]).slice(0, 80) : [];
    const rawCandidates = Array.isArray(body?.candidates)
      ? (body.candidates as HabitCandidateRecord[]).slice(0, 40)
      : [];
    const recentPatterns = Array.isArray(body?.recentPatterns)
      ? (body.recentPatterns as HabitLedgerPatternSummary[]).slice(0, 30)
      : [];

    if (rawHabits.length === 0 && rawCandidates.length === 0 && recentPatterns.length === 0) {
      return NextResponse.json({
        success: true,
        data: validateHabitOptimizationPlan(
          {
            summary: '当前暂无可优化的习惯记忆或候选消费模式。',
            drops: [],
            merges: [],
            updates: [],
            additions: [],
          },
          [],
          []
        ),
        model: 'deterministic-empty',
      });
    }

    const compactHabits = rawHabits.map((h) => ({
      id: h.id,
      rawPattern: h.rawPattern,
      preferredAlias: h.preferredAlias,
      category: h.category,
      learnedSource: h.learnedSource,
      frequency: h.frequency,
      keywords: Array.isArray(h.keywords) ? h.keywords.slice(0, 8) : [],
    }));

    const compactCandidates = rawCandidates.map((c) => ({
      key: c.key,
      rawPattern: c.rawPattern,
      preferredAlias: c.preferredAlias,
      category: c.category,
      count: c.count,
      lastAmount: c.lastAmount,
    }));

    const userPrompt = [
      `Language preference: ${typeof body?.language === 'string' ? body.language : 'zh'}`,
      `\n【EXISTING HABIT MEMORIES (${compactHabits.length})】:\n${JSON.stringify(compactHabits, null, 2)}`,
      compactCandidates.length > 0
        ? `\n【STAGED CANDIDATES (${compactCandidates.length})】:\n${JSON.stringify(compactCandidates, null, 2)}`
        : '',
      recentPatterns.length > 0
        ? `\n【RECURRING LEDGER PATTERNS (${recentPatterns.length})】:\n${JSON.stringify(recentPatterns, null, 2)}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    const result = await generateGeminiContent({
      prompt: userPrompt,
      systemInstruction: OPTIMIZE_HABITS_SYSTEM_PROMPT,
      responseMimeType: 'application/json',
      thinking: true,
      thinkingBudget: 256,
      temperature: 0.2,
      maxOutputTokens: 2048,
      timeoutMs: 20_000,
      totalTimeoutMs: 25_000,
    });

    let parsedJson: Record<string, unknown>;
    try {
      parsedJson = parseAssistantJsonResponse(result.text);
    } catch {
      return NextResponse.json(
        { success: false, error: 'AI optimizer returned invalid JSON' },
        { status: 502 }
      );
    }

    const validatedPlan = validateHabitOptimizationPlan(parsedJson, rawHabits, rawCandidates);

    return NextResponse.json({
      success: true,
      data: validatedPlan,
      model: result.model,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Habit memory optimization failed';
    console.error('[OptimizeHabitsAPI] Error:', msg);
    return NextResponse.json({ success: false, error: msg }, { status: 502 });
  }
}
