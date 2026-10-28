import test from 'node:test';
import assert from 'node:assert/strict';

import { computeDeterministicLedgerFacts } from '../src/lib/kinova-assistant.ts';

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
