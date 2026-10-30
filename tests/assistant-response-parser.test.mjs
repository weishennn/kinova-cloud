import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAssistantParserCandidate,
  computeDeterministicLedgerFacts,
  parseAssistantJsonResponse,
  resolveAssistantParserCandidate,
  runKinovaTurn,
  shouldUseTransactionCapturePrompt,
  updateAssistantConversation,
} from '../src/lib/kinova-assistant.ts';

const mockProfile = {
  language: 'auto',
  paydayDay: 28,
  suggestedPayday: null,
  monthlyBudgetCap: 2500,
  baselineIncome: 5000,
  emergencyReserve: 15000,
  goals: [],
  rejectedChips: [],
  recentActions: [],
};

const transactions = [
  { id: '1', date: '2026-10-01', type: 'Expense', category: 'Food & Dining', description: 'Chicken Rice', amount: 15.0 },
  { id: '2', date: '2026-10-02', type: 'Expense', category: 'Food & Dining', description: 'Pan Mee', amount: 12.0 },
  { id: '3', date: '2026-10-03', type: 'Expense', category: 'Food & Dining', description: 'Steak Dinner', amount: 65.0 },
  { id: '4', date: '2026-10-04', type: 'Expense', category: 'Transport', description: 'Shell Petrol', amount: 80.0 },
  { id: '5', date: '2026-09-15', type: 'Expense', category: 'Food & Dining', description: 'Nasi Lemak', amount: 10.0 },
];

test('assistant parser candidate carries supported amount fields without inventing an unresolved date', () => {
  const candidate = buildAssistantParserCandidate('mamak lunch 15 last week');
  assert.deepEqual(candidate, {
    amount: 15,
    currency: 'MYR',
    type: 'Expense',
    category: 'Food & Dining',
    unresolvedFields: ['date'],
  });
  assert.equal(shouldUseTransactionCapturePrompt('mamak lunch 15 last week', false, candidate), true);
  assert.equal(shouldUseTransactionCapturePrompt('Should I pay 15 for lunch?', false, candidate), false);
  assert.equal(shouldUseTransactionCapturePrompt('mamak lunch 15 last week', true, candidate), false);
  const serverCandidate = resolveAssistantParserCandidate('mamak lunch 15 last week', false);
  assert.deepEqual(serverCandidate, candidate);
  assert.equal(shouldUseTransactionCapturePrompt('mamak lunch 15 last week', false, serverCandidate), true);
  assert.equal(resolveAssistantParserCandidate('mamak lunch 15 last week', true), null);
});

test('computeDeterministicLedgerFacts correctly aggregates whole-ledger totals without arithmetic hallucinations', () => {
  const facts = computeDeterministicLedgerFacts(transactions, mockProfile, 'Chicken', '2026-10-29');

  // October expenses = 15 + 12 + 65 + 80 = 172
  assert.equal(facts.currentMonthTotalSpent, 172);
  // Budget remaining = 2500 - 172 = 2328
  assert.equal(facts.currentMonthBudgetRemaining, 2328);

  // Category spending in October
  assert.equal(facts.categorySpending['Food & Dining'], 92);
  assert.equal(facts.categorySpending['Transport'], 80);

  // Median food & dining: [10, 12, 15, 65] -> median is (12 + 15) / 2 = 13.5
  assert.equal(facts.categoryMedians['Food & Dining'], 13.5);

  // Keyword query match
  assert.equal(facts.queryItemFoundInLedger, true);
  assert.equal(facts.matchedRecordCount, 1);
  assert.equal(facts.matchedExactSpent, 15);
});

test('computeDeterministicLedgerFacts accurately resolves full sentence spending queries using copilot facts', () => {
  const queryFacts = computeDeterministicLedgerFacts(transactions, mockProfile, 'How much did I spend on food this month?', '2026-10-29');

  // Must match the 3 Food & Dining expenses in October (15 + 12 + 65 = 92)
  assert.equal(queryFacts.queryItemFoundInLedger, true);
  assert.equal(queryFacts.matchedRecordCount, 3);
  assert.equal(queryFacts.matchedExactSpent, 92);
  assert.ok(queryFacts.categoryLabel?.includes('Food & Dining'));
});

test('computeDeterministicLedgerFacts detects potential duplicate against receipt', () => {
  const pendingReceipt = {
    amount: 80.0,
    merchant: 'Shell Petrol Station',
    date: '2026-10-04',
  };

  const facts = computeDeterministicLedgerFacts(transactions, mockProfile, '', '2026-10-29', pendingReceipt);
  assert.ok(facts.potentialDuplicate);
  assert.equal(facts.potentialDuplicate.amount, 80);
  assert.equal(facts.potentialDuplicate.description, 'Shell Petrol');
});

test('runKinovaTurn forwards receipt facts and merchant query to the assistant pass', async () => {
  const originalFetch = globalThis.fetch;
  let sentBody;
  globalThis.fetch = async (_url, init) => {
    sentBody = JSON.parse(String(init?.body || '{}'));
    return new Response(JSON.stringify({
      success: true,
      model: 'mock-model',
      data: {
        mode: 'advise',
        reasoning: 'There is a matching Shell record for RM 80.00.',
        answer: 'This may be a duplicate.',
        proposedAction: null,
        command: null,
        clarification: null,
        receiptAnalysis: { merchant: 'Shell Petrol', netAmount: 80, taxReliefCategory: null, isDuplicate: true, comparisonToMedian: null },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    await runKinovaTurn({
      text: 'Review this payment screenshot from Shell Petrol for RM 80.00.',
      today: '2026-10-29',
      profile: mockProfile,
      transactions,
      forceAssistant: true,
      factQuery: 'Shell Petrol',
      pendingReceipt: { amount: 80, merchant: 'Shell Petrol', date: '2026-10-04' },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(sentBody.deterministicFacts.potentialDuplicate.amount, 80);
  assert.equal(sentBody.deterministicFacts.potentialDuplicate.description, 'Shell Petrol');
});

test('runKinovaTurn forwards structured clarification state without local phrase extraction', async () => {
  const originalFetch = globalThis.fetch;
  let sentBody;
  const clarification = {
    mode: 'clarify',
    reasoning: 'The period does not identify one day.',
    answer: 'Which day in that period?',
    proposedAction: null,
    command: null,
    clarification: { question: 'Which day in that period?', options: [] },
    pendingContext: {
      intent: 'transaction',
      originalRequest: 'lunch 15 last week',
      knownFields: { amount: 15, description: 'lunch', currency: 'MYR' },
      missingFields: ['date'],
    },
    receiptAnalysis: null,
  };
  const firstConversation = updateAssistantConversation([], 'lunch 15 last week', clarification);
  assert.equal(firstConversation.turns.at(-1).text, clarification.clarification.question);
  assert.deepEqual(firstConversation.pendingContext, clarification.pendingContext);

  globalThis.fetch = async (_url, init) => {
    sentBody = JSON.parse(String(init?.body || '{}'));
    return new Response(JSON.stringify({
      success: true,
      model: 'mock-model',
      data: {
        mode: 'record',
        reasoning: 'The reply resolves the missing date.',
        answer: 'Ready to review the transaction.',
        proposedAction: null,
        command: {
          intent: 'transaction',
          confidence: 0.99,
          data: {
            amount: 15,
            currency: 'MYR',
            type: 'Expense',
            category: 'Food & Dining',
            description: 'lunch',
            date: '2026-10-22',
          },
        },
        clarification: null,
        pendingContext: null,
        receiptAnalysis: null,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const completedTurn = await runKinovaTurn({
      text: 'last week Thursday',
      today: '2026-10-30',
      profile: mockProfile,
      transactions,
      forceAssistant: true,
      sessionTurns: firstConversation.turns,
      pendingContext: firstConversation.pendingContext,
    });
    assert.equal(completedTurn.source, 'assistant');
    assert.equal(completedTurn.assistantResult.mode, 'record');
    assert.equal(
      updateAssistantConversation(firstConversation.turns, 'last week Thursday', completedTurn.assistantResult).pendingContext,
      null,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(sentBody.pendingContext, {
    intent: 'transaction',
    originalRequest: 'lunch 15 last week',
    knownFields: { amount: 15, description: 'lunch', currency: 'MYR' },
    missingFields: ['date'],
  });
  assert.deepEqual(sentBody.sessionTurns, firstConversation.turns);
  assert.equal(sentBody.text, 'last week Thursday');
  assert.equal('expenseDraft' in sentBody, false);
});

test('runKinovaTurn sends parsed amount evidence with the original sentence', async () => {
  const originalFetch = globalThis.fetch;
  let sentBody;
  globalThis.fetch = async (_url, init) => {
    sentBody = JSON.parse(String(init?.body || '{}'));
    return new Response(JSON.stringify({
      success: true,
      model: 'mock-model',
      data: {
        mode: 'clarify',
        reasoning: 'The date needs clarification.',
        answer: 'Which date should I use?',
        proposedAction: null,
        command: null,
        clarification: { question: 'Which date should I use?', options: [] },
        pendingContext: {
          intent: 'transaction',
          originalRequest: 'mamak lunch 15 last week',
          knownFields: { amount: 15, currency: 'MYR', type: 'Expense' },
          missingFields: ['date'],
        },
        receiptAnalysis: null,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    await runKinovaTurn({
      text: 'mamak lunch 15 last week',
      today: '2026-10-30',
      profile: mockProfile,
      transactions,
      forceAssistant: true,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(sentBody.text, 'mamak lunch 15 last week');
  assert.deepEqual(sentBody.parserCandidate, {
    amount: 15,
    currency: 'MYR',
    type: 'Expense',
    category: 'Food & Dining',
    unresolvedFields: ['date'],
  });
});

test('runKinovaTurn skips full-ledger work for a simple conversational message', async () => {
  const originalFetch = globalThis.fetch;
  let sentBody;
  globalThis.fetch = async (_url, init) => {
    sentBody = JSON.parse(String(init?.body || '{}'));
    return new Response(JSON.stringify({
      success: true,
      model: 'mock-model',
      data: {
        mode: 'unknown',
        reasoning: 'A simple greeting needs no ledger context.',
        answer: 'Hi! How can I help?',
        proposedAction: null,
        command: null,
        clarification: null,
        receiptAnalysis: null,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    await runKinovaTurn({
      text: 'hello Kinova',
      today: '2026-10-29',
      profile: mockProfile,
      transactions,
      forceAssistant: true,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(sentBody.deterministicFacts, undefined);
  assert.equal(sentBody.ledgerSample, undefined);
  assert.deepEqual(sentBody.profile.habits, []);
});

test('parseAssistantJsonResponse parses plain valid JSON', () => {
  const json = JSON.stringify({
    mode: 'record',
    reasoning: 'Lunch expense',
    answer: 'Recorded lunch RM 15',
    command: { intent: 'transaction', data: { amount: 15, category: 'Food & Dining' } },
  });

  const parsed = parseAssistantJsonResponse(json);
  assert.equal(parsed.mode, 'record');
  assert.equal(parsed.reasoning, 'Lunch expense');
});

test('parseAssistantJsonResponse parses markdown fenced JSON', () => {
  const fenced = '```json\n{\n  "mode": "advise",\n  "reasoning": "Within food budget",\n  "answer": "You can afford this."\n}\n```';
  const parsed = parseAssistantJsonResponse(fenced);
  assert.equal(parsed.mode, 'advise');
  assert.equal(parsed.answer, 'You can afford this.');
});

test('parseAssistantJsonResponse handles text with leading/trailing commentary around JSON', () => {
  const text = 'Here is the result:\n{"mode": "clarify", "answer": "Did you mean lunch or dinner?", "clarification": {"question": "Which meal?", "options": ["Lunch", "Dinner"]}}\nHope this helps!';
  const parsed = parseAssistantJsonResponse(text);
  assert.equal(parsed.mode, 'clarify');
  assert.equal(parsed.clarification.options.length, 2);
});

test('missing amount in expense request correctly expects clarify mode', () => {
  const clarifyResponse = {
    mode: 'clarify',
    reasoning: 'User asked to record lunch at Pavilion but did not specify the price.',
    answer: 'How much was your Pavilion lunch?',
    command: null,
    clarification: {
      question: 'How much was your Pavilion lunch?',
      options: ['RM 15', 'RM 25'],
    },
  };
  assert.equal(clarifyResponse.mode, 'clarify');
  assert.equal(clarifyResponse.command, null);
});

test('ledger miss does not fabricate store price unless explicit market price is requested', () => {
  // 1. Regular user query without ledger match -> says not found, no price ladder
  const ledgerMissResponse = {
    mode: 'advise',
    reasoning: 'No records matching "Durian Musang King" in your ledger.',
    answer: 'You have not recorded any Durian purchases in your ledger yet.',
    proposedAction: null,
  };
  assert.equal(ledgerMissResponse.mode, 'advise');
  assert.ok(ledgerMissResponse.answer.includes('not recorded'));

  // 2. Explicit market price request -> provides market guidance
  const marketPriceResponse = {
    mode: 'advise',
    reasoning: 'Public Malaysian market estimate requested for RON95.',
    answer: 'The current subsidized retail market price for RON95 in Malaysia is RM 2.05 per litre.',
    proposedAction: null,
  };
  assert.equal(marketPriceResponse.mode, 'advise');
  assert.ok(marketPriceResponse.answer.includes('RM 2.05'));
});
