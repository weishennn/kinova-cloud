import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectSuggestedPayday,
  isChipRejected,
} from '../src/lib/user-money-profile.ts';

test('detectSuggestedPayday returns candidate day when income is recurring across 2+ months', () => {
  const transactions = [
    { type: 'Expense', date: '2026-01-15', amount: 50 },
    { type: 'Income', date: '2026-01-28', amount: 4500 },
    { type: 'Income', date: '2026-02-27', amount: 4500 }, // within ±2 days of 28
    { type: 'Expense', date: '2026-02-10', amount: 120 },
  ];

  const suggested = detectSuggestedPayday(transactions);
  assert.ok(suggested === 27 || suggested === 28);
});

test('detectSuggestedPayday returns null if incomes are only in 1 month', () => {
  const transactions = [
    { type: 'Income', date: '2026-01-15', amount: 2000 },
    { type: 'Income', date: '2026-01-28', amount: 3000 },
  ];

  const suggested = detectSuggestedPayday(transactions);
  assert.equal(suggested, null);
});

test('detectSuggestedPayday returns null if no income records exist', () => {
  const transactions = [
    { type: 'Expense', date: '2026-01-28', amount: 100 },
    { type: 'Expense', date: '2026-02-28', amount: 100 },
  ];

  const suggested = detectSuggestedPayday(transactions);
  assert.equal(suggested, null);
});

test('isChipRejected honors 30-day suppression window', () => {
  const now = Date.now();
  const twentyDaysAgo = now - 20 * 24 * 60 * 60 * 1000;
  const fortyDaysAgo = now - 40 * 24 * 60 * 60 * 1000;

  const rejectedChips = [
    { text: '午餐 RM15', rejectedAt: twentyDaysAgo },
    { text: 'Shell 60', rejectedAt: fortyDaysAgo },
  ];

  assert.equal(isChipRejected('午餐 RM15', rejectedChips, now), true);
  assert.equal(isChipRejected('Shell 60', rejectedChips, now), false);
  assert.equal(isChipRejected('Starbucks 18', rejectedChips, now), false);
});
