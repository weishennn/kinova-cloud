import test from 'node:test';
import assert from 'node:assert/strict';

import {
  predictCashflowTrajectory,
  calculateFinancialHealthScore,
} from '../src/lib/financial-intelligence.ts';
import { getUserMoneyProfile, PROFILE_STORAGE_KEYS } from '../src/lib/user-money-profile.ts';

test('predictCashflowTrajectory does NOT book day 25 salary when paydayDay is unset', () => {
  const result = predictCashflowTrajectory({
    transactions: [],
    startingCash: 1000,
    baselineMonthlyIncome: 5000,
    paydayDay: null, // unset
    referenceDateStr: '2026-10-01',
  });

  // Day 25 is offset 24 from Oct 1
  const day25Point = result.forecast30Days.find((p) => p.dateStr === '2026-10-25');
  assert.ok(day25Point);
  assert.equal(day25Point.projectedInflow, 0, 'Should not book synthetic salary on day 25');
  assert.ok(result.insightMessage.includes('发薪日未指定'));
});

test('predictCashflowTrajectory books salary on configured paydayDay', () => {
  const result = predictCashflowTrajectory({
    transactions: [],
    startingCash: 1000,
    baselineMonthlyIncome: 5000,
    paydayDay: 28, // configured payday
    referenceDateStr: '2026-10-01',
  });

  const day25Point = result.forecast30Days.find((p) => p.dateStr === '2026-10-25');
  assert.equal(day25Point?.projectedInflow, 0);

  const day28Point = result.forecast30Days.find((p) => p.dateStr === '2026-10-28');
  assert.ok(day28Point);
  assert.equal(day28Point.projectedInflow, 5000, 'Should book salary on configured payday day 28');
});

test('the saved payday preference flows from the existing storage key into the forecast', () => {
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  const entries = new Map([[PROFILE_STORAGE_KEYS.PAYDAY_DAY, '28']]);
  globalThis.window = {};
  globalThis.localStorage = {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, String(value)),
    removeItem: (key) => entries.delete(key),
  };

  try {
    const profile = getUserMoneyProfile();
    const result = predictCashflowTrajectory({
      transactions: [],
      startingCash: 1000,
      baselineMonthlyIncome: 5000,
      paydayDay: profile.paydayDay,
      referenceDateStr: '2026-10-01',
    });
    assert.equal(profile.paydayDay, 28);
    assert.equal(result.forecast30Days.find((point) => point.dateStr === '2026-10-28')?.projectedInflow, 5000);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
});

test('calculateFinancialHealthScore flags insufficient data when income and reserve are missing', () => {
  const report = calculateFinancialHealthScore({
    transactions: [],
    baselineIncome: 0,
    emergencyFundBalance: 0,
    referenceDateStr: '2026-10-29',
  });

  assert.equal(report.hasSufficientData, false);
  assert.equal(report.gradeLabel, '数据不足，暂不评分');
  assert.equal(report.totalScore, 0);
});
