import { isQuestionOrAdviceRequest } from './intent-router.ts';
import { parseNaturalExpense } from './natural-expense-parser.ts';

export interface AssistantExpenseDraft {
  amount: number;
  currency: string;
  category: string;
  type: 'Expense' | 'Income';
  description: string;
  dateNeedsResolution: true;
}

/**
 * Carry high-confidence fields into the AI request when the local parser only
 * failed because it could not resolve a broader relative-date phrase.
 */
export function buildAssistantExpenseDraft(text: string): AssistantExpenseDraft | null {
  if (!text.trim() || isQuestionOrAdviceRequest(text)) return null;

  const parsed = parseNaturalExpense(text);
  if (
    !parsed ||
    !parsed.hasUnparsedTemporalContext ||
    parsed.amount <= 0 ||
    parsed.category === 'Other' ||
    !parsed.description
  ) {
    return null;
  }

  return {
    amount: parsed.amount,
    currency: parsed.currency || 'MYR',
    category: parsed.category,
    type: parsed.type,
    description: parsed.description,
    dateNeedsResolution: true,
  };
}

export function isAmountClarificationQuestion(question: string): boolean {
  return /\b(?:amount|how\s+much|price|cost|total|sum|berapa|jumlah|harga|wang|duit)\b|(?:金额|金額|多少|价钱|價格|價錢)/i.test(question);
}

/** Replace a model's redundant amount question with the only unresolved field. */
export function restoreDateOnlyClarification(
  response: Record<string, unknown>,
  draft: AssistantExpenseDraft,
): boolean {
  if (response.mode !== 'clarify' && response.mode !== 'unknown') return false;

  const clarification = response.clarification && typeof response.clarification === 'object'
    ? response.clarification as { question?: unknown }
    : null;
  const question = typeof clarification?.question === 'string'
    ? clarification.question
    : typeof response.answer === 'string' ? response.answer : '';
  if (!isAmountClarificationQuestion(question)) return false;

  const hasChinese = /[\u3400-\u9fff]/u.test(question);
  const hasMalay = /\b(?:berapa|jumlah|harga|wang|duit)\b/i.test(question);
  const understood = hasChinese
    ? `我理解金额是 ${draft.currency} ${draft.amount.toFixed(2)}，用于${draft.description}。请问应该使用哪一天？`
    : hasMalay
      ? `Saya faham jumlahnya ${draft.currency} ${draft.amount.toFixed(2)} untuk ${draft.description}. Tarikh yang mana perlu digunakan?`
      : `I understood ${draft.currency} ${draft.amount.toFixed(2)} for ${draft.description}. Which date should I use?`;
  response.mode = 'clarify';
  response.answer = understood;
  response.reasoning = 'The amount was already present in the message; only the exact date needs clarification.';
  response.clarification = { question: understood, options: [] };
  return true;
}
