import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectSuggestedPayday,
  isChipRejected,
  updateUserMoneyProfile,
  getUserMoneyProfile,
  CLOUD_SYNC_KEYS,
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

test('updateUserMoneyProfile persists scalar budget/income/reserve keys, dispatches sync event, and honors goal max=3', () => {
  const store = new Map();
  const events = [];
  const prevWindow = globalThis.window;
  const prevStorage = globalThis.localStorage;
  const prevCustomEvent = globalThis.CustomEvent;

  globalThis.window = {
    dispatchEvent: (ev) => events.push(ev),
  };
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  };
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  try {
    updateUserMoneyProfile({
      monthlyBudgetCap: 3500,
      baselineIncome: 7000,
      emergencyReserve: 20000,
      goals: [
        { id: 'g1', name: 'Japan Trip', targetAmount: 8000, currentAmount: 0 },
        { id: 'g2', name: 'Emergency Fund', targetAmount: 15000, currentAmount: 0 },
        { id: 'g3', name: 'Laptop', targetAmount: 5000, currentAmount: 0 },
        { id: 'g4', name: 'Extra Goal Ignored', targetAmount: 1000, currentAmount: 0 },
      ],
    });

    assert.equal(store.get(CLOUD_SYNC_KEYS.MONTHLY_BUDGET), '3500');
    assert.equal(store.get(CLOUD_SYNC_KEYS.BASELINE_INCOME), '7000');
    assert.equal(store.get(CLOUD_SYNC_KEYS.EMERGENCY_RESERVE), '20000');

    const profile = getUserMoneyProfile();
    assert.equal(profile.monthlyBudgetCap, 3500);
    assert.equal(profile.baselineIncome, 7000);
    assert.equal(profile.emergencyReserve, 20000);
    assert.equal(profile.goals.length, 3);
    assert.ok(events.some((e) => e.type === 'cashflow_cloud_settings_synced' && e.detail?.key === CLOUD_SYNC_KEYS.MONTHLY_BUDGET));
  } finally {
    globalThis.window = prevWindow;
    globalThis.localStorage = prevStorage;
    globalThis.CustomEvent = prevCustomEvent;
  }
});
