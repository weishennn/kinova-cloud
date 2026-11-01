import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateIntelligentCategoryCaps,
  getPaydayCycleIntelligence,
  getCategoryRealtimeBudgetStatus,
  predictMonthlySavingsAndInvestments,
  fitCapsToLivingBudget,
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

  // STRICT REQUIREMENT: All cap sum MUST be lower than or equal to income - savings!
  assert.ok(
    plan.totalSuggestedCaps <= plan.targetLivingBudget,
    `Total caps (${plan.totalSuggestedCaps}) must be <= living budget (${plan.targetLivingBudget} = income - savings)`
  );

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
  assert.ok(food.suggestedCap >= 450);
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

test('Monthly Savings & Investment Prediction: Follows daily spend to predict savings and investments as percentage', () => {
  // Scenario 1: Controlled spending
  // Suppose today is day 10 of a 30-day month, user has spent RM 400 total in Food & Dining.
  // Burn rate: RM 40/day. Remaining 20 days: 40 * 20 = RM 800.
  // Total projected spend: RM 1200.
  // Monthly income: RM 3000. Surplus: RM 1800.
  // Target: 20% savings (RM 600) + 20% investments (RM 600) = 40% (RM 1200).
  const txsControlled = [
    { id: '1', date: '2026-11-02', type: 'expense', category: 'Food & Dining', amount: 150 },
    { id: '2', date: '2026-11-05', type: 'expense', category: 'Food & Dining', amount: 100 },
    { id: '3', date: '2026-11-09', type: 'expense', category: 'Food & Dining', amount: 150 },
  ];

  const prediction = predictMonthlySavingsAndInvestments(txsControlled, {
    baselineIncome: 3000,
    savingsTargetPct: 20,
    investmentTargetPct: 20,
    selectedMonth: '2026-11',
    referenceDate: new Date(2026, 10, 10), // Nov 10
  });

  assert.equal(prediction.baselineIncome, 3000);
  assert.equal(prediction.spentSoFar, 400);
  assert.equal(prediction.daysPassed, 10);
  assert.equal(prediction.currentDailySpend, 40);
  assert.equal(prediction.projectedTotalSpend, 1200);
  assert.equal(prediction.projectedMonthEndSurplus, 1800);

  // Equal 50/50 split of surplus between savings and investments
  assert.equal(prediction.predictedSavingsAmount, 900);
  assert.equal(prediction.predictedSavingsPct, 30.0); // 900 / 3000 = 30%
  assert.equal(prediction.predictedInvestmentAmount, 900);
  assert.equal(prediction.predictedInvestmentPct, 30.0); // 900 / 3000 = 30%
  assert.equal(prediction.predictedTotalSavedPct, 60.0);
  assert.equal(prediction.pacingStatus, 'ahead_of_target');

  // Scenario 2: Deficit / Overspending
  // Day 10, user already spent RM 2200 in Food & Dining daily burn.
  // Burn rate: RM 220/day.
  // Projected spend: 2200 + 220 * 20 = RM 6600 (> 3000).
  const txsOver = [
    { id: '1', date: '2026-11-05', type: 'expense', category: 'Food & Dining', amount: 2200 },
  ];
  const predDeficit = predictMonthlySavingsAndInvestments(txsOver, {
    baselineIncome: 3000,
    savingsTargetPct: 20,
    investmentTargetPct: 20,
    selectedMonth: '2026-11',
    referenceDate: new Date(2026, 10, 10),
  });

  assert.equal(predDeficit.spentSoFar, 2200);
  assert.equal(predDeficit.projectedMonthEndSurplus, 0);
  assert.equal(predDeficit.predictedSavingsAmount, 0);
  assert.equal(predDeficit.predictedSavingsPct, 0);
  assert.equal(predDeficit.predictedInvestmentAmount, 0);
  assert.equal(predDeficit.predictedInvestmentPct, 0);
  assert.equal(predDeficit.pacingStatus, 'in_deficit');
});

test('Day 1 Lump Sum Education: Does NOT collapse predicted savings to 0% on Day 1', () => {
  // User scenario:
  // Nov 1 (Day 1 of 30 days). User pays RM 200 for Education.
  // Income: RM 3000. Target savings: 20% (600), Target investments: 20% (600).
  // Total savings target: 40% (1200). Living budget: RM 1800.
  //
  // OLD FLAWED BUG:
  // Naive burn rate was 200 / 1 = 200/day -> Month projected spend = 200 + 200*29 = 6000.
  // Deficit RM 3000, predicted saving = 0%!
  //
  // NEW CORRECT BEHAVIOR:
  // Education is an episodic lump sum (lumpSumSpent = 200, dailyVariableSpent = 0).
  // Daily variable spend rate is 0 (not 200!).
  // Remaining living budget: 1800 - 200 = 1600.
  // Safe daily allowance for remaining 29 days: 1600 / 29 = 55.17/day.
  // Predicted month-end savings and investments remain 100% on track at 20% + 20%!
  const txsDay1Education = [
    { id: 'edu_1', date: '2026-11-01', type: 'expense', category: 'Education', amount: 200 },
  ];

  const pred = predictMonthlySavingsAndInvestments(txsDay1Education, {
    baselineIncome: 3000,
    savingsTargetPct: 20,
    investmentTargetPct: 20,
    selectedMonth: '2026-11',
    referenceDate: new Date(2026, 10, 1), // Nov 1
  });

  assert.equal(pred.daysPassed, 1);
  assert.equal(pred.daysRemaining, 29);
  assert.equal(pred.spentSoFar, 200);
  assert.equal(pred.lumpSumSpent, 200);
  assert.equal(pred.dailyVariableSpent, 0);

  // Daily spend must NOT be 200!
  assert.equal(pred.currentDailySpend, 0);

  // Safe daily allowance adjusts to absorb the lump sum (1600 / 29 = 55.17)
  assert.equal(pred.safeDailyLivingAllowance, 55.17);

  // Predicted savings & investments MUST stay intact at 20% + 20% (RM 600 + RM 600)
  assert.equal(pred.predictedSavingsAmount, 600);
  assert.equal(pred.predictedSavingsPct, 20.0);
  assert.equal(pred.predictedInvestmentAmount, 600);
  assert.equal(pred.predictedInvestmentPct, 20.0);
  assert.equal(pred.predictedTotalSavedPct, 40.0);
  assert.equal(pred.pacingStatus, 'on_track');
  assert.match(pred.insightMessage, /Lump sum \(RM 200\.00\) absorbed/);
});

test('fitCapsToLivingBudget: Strictly ensures sum of all caps <= income - savings', () => {
  const bloatedCaps = {
    'Food & Dining': 1200,
    'Housing & Bills': 800,
    'Transport': 400,
    'Shopping': 500,
    'Entertainment': 300,
    'Sport': 250,
  }; // Total = 3450

  const maxLivingBudget = 1800; // Income RM 3000 - Savings RM 1200
  const fitted = fitCapsToLivingBudget(bloatedCaps, maxLivingBudget);

  const fittedSum = Object.values(fitted).reduce((a, b) => a + b, 0);
  assert.ok(
    fittedSum <= maxLivingBudget,
    `Fitted sum (${fittedSum}) must be <= living budget (${maxLivingBudget})`
  );
  assert.ok(fitted['Food & Dining'] >= 400); // Food & Dining preserves living floor
});

test('Only Food & Dining is daily; other categories (Sport, Transport, Shopping) are monthly budget-capped', () => {
  // On Day 2, user spent:
  // - Food & Dining: RM 40 (daily variable expense: RM 20/day)
  // - Sport: RM 50 (monthly capped bucket: spend one time, use whole month)
  // - Transport: RM 60 (monthly capped bucket: e.g. reload Touch 'n Go)
  const txs = [
    { id: 'f1', date: '2026-11-01', type: 'expense', category: 'Food & Dining', amount: 20 },
    { id: 'f2', date: '2026-11-02', type: 'expense', category: 'Food & Dining', amount: 20 },
    { id: 's1', date: '2026-11-02', type: 'expense', category: 'Sport', amount: 50 },
    { id: 't1', date: '2026-11-02', type: 'expense', category: 'Transport', amount: 60 },
  ];

  const pred = predictMonthlySavingsAndInvestments(txs, {
    baselineIncome: 3000,
    savingsTargetPct: 20,
    investmentTargetPct: 20,
    selectedMonth: '2026-11',
    referenceDate: new Date(2026, 10, 2), // Day 2
  });

  assert.equal(pred.daysPassed, 2);
  assert.equal(pred.spentSoFar, 150); // 40 food + 50 sport + 60 transport
  assert.equal(pred.dailyVariableSpent, 40); // ONLY food is daily
  assert.equal(pred.lumpSumSpent, 110); // Sport (50) + Transport (60) are monthly-capped buckets

  // Daily burn rate must ONLY reflect Food: RM 40 / 2 days = RM 20.00/day
  // It must NOT treat Sport or Transport as daily burn! (which would have been 150 / 2 = 75/day)
  assert.equal(pred.currentDailySpend, 20.0);

  // Month-end savings and investments remain protected!
  assert.ok(pred.pacingStatus === 'on_track' || pred.pacingStatus === 'ahead_of_target');
});
