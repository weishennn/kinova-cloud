import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateFinancialHealthScore,
  predictCashflowTrajectory,
  discoverUnmarkedRecurringExpenses,
  getContextualSmartTag,
  generateAiFinancialBriefing,
} from '../src/lib/financial-intelligence.ts';

test('1. calculateFinancialHealthScore evaluates financial wellness across 4 core dimensions', () => {
  const transactions = [
    { id: 'tx-1', date: '2026-10-01', amount: 5000, type: 'income', category: 'Salary' },
    { id: 'tx-2', date: '2026-10-02', amount: 1200, type: 'expense', category: 'Housing & Bills', description: 'Rental' },
    { id: 'tx-3', date: '2026-10-05', amount: 350, type: 'expense', category: 'Transport', description: 'Petrol & Toll' },
    { id: 'tx-4', date: '2026-10-10', amount: 450, type: 'expense', category: 'Food & Dining', description: 'Dining' },
  ];

  // Budget cap 3000, income 5000, expenses 2000 -> 60% savings rate!
  const report = calculateFinancialHealthScore({
    transactions,
    monthlyBudgetCap: 3000,
    baselineIncome: 5000,
    emergencyFundBalance: 15000,
    referenceDateStr: '2026-10-15',
  });

  assert.ok(report.totalScore >= 75, `Expected score >= 75, got ${report.totalScore}`);
  assert.equal(report.dimensions.savingsRate.maxScore, 30);
  assert.ok(report.dimensions.savingsRate.percentage >= 80);
  assert.equal(report.dimensions.budgetDiscipline.maxScore, 25);
  assert.ok(report.recommendations.length > 0);
});

test('2. predictCashflowTrajectory calculates 30/60/90 days balance and deficit status', () => {
  const transactions = [
    { id: 'tx-1', date: '2026-09-01', amount: 4500, type: 'income', category: 'Salary' },
    { id: 'tx-2', date: '2026-09-05', amount: 30, type: 'expense', category: 'Food & Dining' },
    { id: 'tx-3', date: '2026-09-12', amount: 40, type: 'expense', category: 'Food & Dining' },
    { id: 'tx-4', date: '2026-10-01', amount: 4500, type: 'income', category: 'Salary' },
    { id: 'tx-5', date: '2026-10-05', amount: 35, type: 'expense', category: 'Food & Dining' },
  ];

  const commitments = [
    {
      id: 'comm-1',
      name: 'Unifi Internet',
      category: 'Bills',
      dayOfMonth: 15,
      amount: 139,
      effectiveFrom: '2026-01',
      history: [],
      autoRecord: false,
    },
  ];

  const forecast = predictCashflowTrajectory({
    transactions,
    startingCash: 3000,
    baselineMonthlyIncome: 4500,
    commitmentsOverride: commitments,
    referenceDateStr: '2026-10-15',
  });

  assert.equal(forecast.forecast30Days.length, 30);
  assert.ok(forecast.dailyBurnRate > 0);
  assert.ok(forecast.forecast60DaysBalance > 0);
  assert.ok(forecast.forecast90DaysBalance > 0);
  assert.equal(forecast.status, 'safe');
});

test('3. discoverUnmarkedRecurringExpenses detects repeating subscriptions across months', () => {
  const transactions = [
    // Month 1 (August)
    { id: '1', date: '2026-08-05', amount: 45, type: 'expense', category: 'Entertainment', description: 'Netflix' },
    { id: '2', date: '2026-08-12', amount: 139, type: 'expense', category: 'Bills', description: 'Unifi' },
    { id: '3', date: '2026-08-15', amount: 80, type: 'expense', category: 'Food & Dining', description: 'Four Beans' },

    // Month 2 (September)
    { id: '4', date: '2026-09-05', amount: 45, type: 'expense', category: 'Entertainment', description: 'Netflix' },
    { id: '5', date: '2026-09-12', amount: 139, type: 'expense', category: 'Bills', description: 'Unifi' },

    // Month 3 (October)
    { id: '6', date: '2026-10-05', amount: 45, type: 'expense', category: 'Entertainment', description: 'Netflix' },
  ];

  const existingCommitments = [
    {
      id: 'comm-netflix',
      name: 'Netflix',
      category: 'Entertainment',
      dayOfMonth: 5,
      amount: 45,
      effectiveFrom: '2026-01',
      history: [],
      autoRecord: false,
    },
  ];

  const discovered = discoverUnmarkedRecurringExpenses(transactions, existingCommitments);

  // Netflix should be marked as already tracked
  const netflix = discovered.find((d) => d.name.toLowerCase() === 'netflix');
  assert.ok(netflix);
  assert.equal(netflix.isAlreadyTracked, true);

  // Unifi should be detected as UNTRACKED candidate
  const unifi = discovered.find((d) => d.name.toLowerCase() === 'unifi');
  assert.ok(unifi, 'Unifi must be discovered as recurring expense');
  assert.equal(unifi.isAlreadyTracked, false);
  assert.equal(unifi.averageAmount, 139);
  assert.equal(unifi.occurrencesCount, 2);
  assert.equal(unifi.detectedDayOfMonth, 12);
});

test('4. getContextualSmartTag identifies time slots, weekday vs weekend, and holidays', () => {
  // Tuesday at 12:30 -> 工作日午餐
  const tag1 = getContextualSmartTag('2026-10-20', 'Food & Dining', 'Lunch Chicken Rice', 12);
  assert.equal(tag1.dayTypeTag, '工作日');
  assert.equal(tag1.timeSlotTag, '🍱 工作日午餐');
  assert.equal(tag1.natureTag, '日常弹性');

  // Saturday at 19:30 -> 周末 晚餐
  const tag2 = getContextualSmartTag('2026-10-24', 'Food & Dining', 'Hotpot Dinner', 19);
  assert.equal(tag2.dayTypeTag, '周末');
  assert.equal(tag2.timeSlotTag, '🍲 晚餐聚餐');

  // New Year (01-01)
  const tag3 = getContextualSmartTag('2026-01-01', 'Shopping', 'Gifts', 15);
  assert.ok(tag3.holidayTag?.includes('元旦'));

  // Sport -> Must NEVER be labeled as lunch!
  const tagBadminton = getContextualSmartTag('2026-10-20', 'Sport', '羽毛球馆预订', undefined, undefined, '羽毛球');
  assert.equal(tagBadminton.timeSlotTag, '🏸 羽毛球');
  const tagSportGeneral = getContextualSmartTag('2026-10-20', 'Sport', 'Gym');
  assert.equal(tagSportGeneral.timeSlotTag, '🏅 运动健身');

  // Evening dinner with time marker in description or notes -> Must be dinner, not lunch!
  const tagEveningDinner = getContextualSmartTag('2026-10-20', 'Food & Dining', '晚餐 20:15');
  assert.equal(tagEveningDinner.timeSlotTag, '🍲 晚餐聚餐');

  // Neutral Food & Dining with no hour -> Neutral 日常餐饮, never forced to 工作日午餐!
  const tagNeutralFood = getContextualSmartTag('2026-10-20', 'Food & Dining', 'Super Kitchen');
  assert.equal(tagNeutralFood.timeSlotTag, '🍽️ 日常餐饮');
});

test('5. generateAiFinancialBriefing summarizes monthly highlights, largest expense, and outlook', () => {
  const transactions = [
    { id: '1', date: '2026-10-01', amount: 250, type: 'expense', category: 'Shopping', description: 'Nike Shoes' },
    { id: '2', date: '2026-10-05', amount: 80, type: 'expense', category: 'Transport', description: 'Shell Petrol' },
    { id: '3', date: '2026-10-12', amount: 120, type: 'expense', category: 'Food & Dining', description: 'Family Dinner' },
  ];

  const briefing = generateAiFinancialBriefing(transactions, '2026-10', 1000);

  assert.equal(briefing.totalSpending, 450);
  assert.equal(briefing.topCategoryName, 'Shopping');
  assert.equal(briefing.largestExpense?.description, 'Nike Shoes');
  assert.equal(briefing.largestExpense?.amount, 250);
  assert.equal(briefing.topCategoryRatio, 56);
  assert.ok(briefing.highlights.length >= 2);
  assert.ok(briefing.actionableTip.includes('占比 56%'), 'Actionable tip must show 56% without double multiplication');
  assert.ok(!briefing.actionableTip.includes('5600%'), 'Actionable tip must NOT show 5600%');

  const enBriefing = generateAiFinancialBriefing(transactions, '2026-10', 1000, 'en');
  assert.ok(enBriefing.periodLabel.includes('Financial Briefing'));
  assert.ok(enBriefing.actionableTip.includes('56%'));
  assert.ok(enBriefing.actionableTip.includes('Assistant insight'));
});
