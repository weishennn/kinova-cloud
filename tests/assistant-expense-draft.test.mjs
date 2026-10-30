import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAssistantExpenseDraft,
  isAmountClarificationQuestion,
  restoreDateOnlyClarification,
  restoreKnownExpenseFields,
} from '../src/lib/assistant-expense-draft.ts';

test('unresolved relative dates retain the amount and merchant as AI context', () => {
  const draft = buildAssistantExpenseDraft('mamak lunch 15 last week');

  assert.ok(draft);
  assert.equal(draft.amount, 15);
  assert.equal(draft.currency, 'MYR');
  assert.equal(draft.category, 'Food & Dining');
  assert.equal(draft.description, 'Mamak lunch');
  assert.equal(draft.dateNeedsResolution, true);
});

test('known description removes unresolved date wording generically', () => {
  const draft = buildAssistantExpenseDraft('mamak lunch 15 two weeks ago');
  assert.equal(draft?.description, 'Mamak lunch');
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

test('record commands keep known amount and non-empty description when Gemini omits them', () => {
  const draft = buildAssistantExpenseDraft('mamak lunch 15 last week');
  const response = {
    mode: 'record',
    command: { intent: 'transaction', data: { amount: null, currency: '', type: 'Expense', category: 'Other', description: null, date: '2026-10-23' } },
    proposedAction: { type: 'save_transaction', payload: { amount: null, description: null, date: '2026-10-23' } },
  };

  assert.ok(draft);
  assert.equal(restoreKnownExpenseFields(response, draft), true);
  assert.deepEqual(response.command.data, {
    amount: 15,
    currency: 'MYR',
    type: 'Expense',
    category: 'Food & Dining',
    description: 'Mamak lunch',
    date: '2026-10-23',
  });
  assert.equal(response.proposedAction.payload.amount, 15);
  assert.equal(response.proposedAction.payload.description, 'Mamak lunch');
});
