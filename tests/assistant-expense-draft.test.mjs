import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAssistantExpenseDraft,
  isAmountClarificationQuestion,
  restoreDateOnlyClarification,
} from '../src/lib/assistant-expense-draft.ts';

test('unresolved relative dates retain the amount and merchant as AI context', () => {
  const draft = buildAssistantExpenseDraft('mamak lunch 15 last week');

  assert.ok(draft);
  assert.equal(draft.amount, 15);
  assert.equal(draft.currency, 'MYR');
  assert.equal(draft.category, 'Food & Dining');
  assert.match(draft.description, /mamak lunch/i);
  assert.equal(draft.dateNeedsResolution, true);
});

test('date-range candidates are not built for questions or unresolved expenses', () => {
  assert.equal(buildAssistantExpenseDraft('should I buy lunch for 15 next week?'), null);
  assert.equal(buildAssistantExpenseDraft('mamak lunch'), null);
});

test('amount clarification detection covers English, Malay, and Chinese', () => {
  assert.equal(isAmountClarificationQuestion('How much was it?'), true);
  assert.equal(isAmountClarificationQuestion('Berapa jumlah untuk mamak?'), true);
  assert.equal(isAmountClarificationQuestion('金额是多少？'), true);
  assert.equal(isAmountClarificationQuestion('Which date should I use?'), false);
});

test('a redundant Malay amount question is corrected to ask only for the unresolved date', () => {
  const draft = buildAssistantExpenseDraft('mamak lunch 15 last week');
  const response = {
    mode: 'clarify',
    answer: 'Berapa jumlah untuk mamak lunch?',
    clarification: { question: 'Berapa jumlah untuk mamak lunch?', options: ['RM 10', 'RM 15'] },
  };

  assert.ok(draft);
  assert.equal(restoreDateOnlyClarification(response, draft), true);
  assert.match(response.clarification.question, /MYR 15\.00/);
  assert.match(response.clarification.question, /Tarikh/);
  assert.doesNotMatch(response.clarification.question, /Berapa jumlah/i);
  assert.deepEqual(response.clarification.options, []);
});

test('a valid date clarification is left unchanged', () => {
  const draft = buildAssistantExpenseDraft('mamak lunch 15 last week');
  const response = {
    mode: 'clarify',
    answer: 'Which date should I use?',
    clarification: { question: 'Which date should I use?', options: [] },
  };

  assert.ok(draft);
  assert.equal(restoreDateOnlyClarification(response, draft), false);
  assert.equal(response.clarification.question, 'Which date should I use?');
});
