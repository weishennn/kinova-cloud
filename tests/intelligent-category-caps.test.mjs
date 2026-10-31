import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateIntelligentCategoryCaps,
  getPaydayCycleIntelligence,
  getCategoryRealtimeBudgetStatus
} from '../src/lib/category-budget-helper.ts';

test('Intelligent Category Caps: Identifies fixed, quasi-fixed, trend, and discretionary spending', () => {
  const transactions = [
    // Month 1 (2026-09)
    { id: '1', date: '2026-09-05', type: 'expense', category: 'Insurance', amount: 250 },
    { id: '2', date: '2026-09-08', type: 'expense', category: 'Housing & Bills', amount: 480 },
    { id: '3', date: '2026-09-12', type: 'expense', category: 'Transport', amount: 145 },
    { id: '4', date: '2026-09-15', type: 'expense', category: 'Food & Dining', amount: 820 },
    { id: '5', date: '2026-09-20', type: 'expense', category: 'Shopping', amount: 240 },
    { id: '6', date: '2026-09-22', type: 'expense', category: 'Sport', amount: 110 },

    // Month 2 (2026-10)
    { id: '7', date: '2026-10-05', type: 'expense', category: 'Insurance', amount: 250 },
    { id: '8', date: '2026-10-08', type: 'expense', category: 'Housing & Bills', amount: 510 },
    { id: '9', date: '2026-10-12', type: 'expense', category: 'Transport', amount: 155 },
    { id: '10', date: '2026-10-15', type: 'expense', category: 'Food & Dining', amount: 790 },
    { id: '11', date: '2026-10-20', type: 'expense', category: 'Shopping', amount: 260 },
    { id: '12', date: '2026-10-22', type: 'expense', category: 'Sport', amount: 130 },
  ];

  const plan = generateIntelligentCategoryCaps(transactions, {
    baselineIncome: 3000,
    savingsTargetPct: 20,
    investmentTargetPct: 20,
  });

  assert.equal(plan.baselineIncome, 3000);
  assert.equal(plan.targetSavingsAmount, 1200); // 40% of 3000
  assert.equal(plan.targetLivingBudget, 1800); // 3000 - 1200

  // Insurance must be identified as fixed recurring ~250
  const insurance = plan.suggestions.find((s) => s.category === 'Insurance');
  assert.ok(insurance);
  assert.equal(insurance.suggestedCap, 250);
  assert.equal(insurance.nature, 'fixed');

  // Housing must be quasi-fixed around ~500
  const housing = plan.suggestions.find((s) => s.category === 'Housing & Bills');
  assert.ok(housing);
  assert.ok(housing.suggestedCap >= 480 && housing.suggestedCap <= 550);
  assert.equal(housing.nature, 'quasi-fixed');

  // Transport must be trend-based around ~150
  const transport = plan.suggestions.find((s) => s.category === 'Transport');
  assert.ok(transport);
  assert.ok(transport.suggestedCap >= 140 && transport.suggestedCap <= 160);
  assert.equal(transport.nature, 'trend');

  // Food & Dining must be discretionary with a daily allowance
  const food = plan.suggestions.find((s) => s.category === 'Food & Dining');
  assert.ok(food);
  assert.equal(food.nature, 'discretionary');
  assert.ok(food.suggestedCap >= 600);
  assert.ok(food.dailyAllowance > 0);
});

test('Payday Cycle Intelligence: Pre-quarantines savings so living allowance never suffers a sudden cliff', () => {
  const currentTxs = [
    { id: 't1', date: '2026-11-02', type: 'expense', category: 'Food & Dining', amount: 45 },
    { id: 't2', date: '2026-11-26', type: 'investment', category: 'ASNB / Unit Trust', amount: 600 },
  ];

  const cycle = getPaydayCycleIntelligence(currentTxs, {
    paydayDay: 25,
    baselineIncome: 3000,
    savingsTargetPct: 20,
    investmentTargetPct: 20,
  });

  assert.equal(cycle.paydayDay, 25);
  assert.equal(cycle.preQuarantinedSavings, 1200);
  assert.equal(cycle.targetLivingBudget, 1800);
  assert.ok(cycle.dailyLivingAllowance > 0);
  assert.equal(cycle.actualSavedThisMonth, 600);
});

test('Category Real-Time Status: Computes remaining budget, impact of proposed expense, and food burn rate', () => {
  const currentMonthTxs = [
    { id: 't1', date: '2026-11-01', type: 'expense', category: 'Food & Dining', amount: 50 },
    { id: 't2', date: '2026-11-02', type: 'expense', category: 'Food & Dining', amount: 30 },
  ];

  const caps = { 'Food & Dining': 900 };

  // Status before new expense
  const statusBefore = getCategoryRealtimeBudgetStatus('Food & Dining', currentMonthTxs, caps, 0);
  assert.equal(statusBefore.spentSoFar, 80);
  assert.equal(statusBefore.remainingBefore, 820);
  assert.equal(statusBefore.isOverCapBefore, false);
  assert.equal(statusBefore.isDailyCategory, true);
  assert.ok(statusBefore.dailyAllowanceRemaining > 0);

  // Status with proposed expense of RM 40
  const statusWith40 = getCategoryRealtimeBudgetStatus('Food & Dining', currentMonthTxs, caps, 40);
  assert.equal(statusWith40.remainingAfter, 780);
  assert.equal(statusWith40.isOverCapAfter, false);

  // Status with proposed expense of RM 900 (which exceeds cap of 900 because 80 + 900 = 980)
  const statusOver = getCategoryRealtimeBudgetStatus('Food & Dining', currentMonthTxs, caps, 900);
  assert.equal(statusOver.isOverCapAfter, true);
  assert.equal(statusOver.badgeColor, 'rose');
  assert.match(statusOver.badgeText, /Will exceed cap by RM 80\.00/);
});
