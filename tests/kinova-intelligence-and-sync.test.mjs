import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeSpendingAnalytics,
  isSpendingAnalyticsQuery,
  resolveTimeframe,
} from '../src/lib/spending-analytics.ts';
import { computeDeterministicLedgerFacts as computeCopilotFacts } from '../src/lib/copilot-ledger-facts.ts';
import {
  buildRebalanceCapsProposedAction,
  computeDeterministicLedgerFacts,
} from '../src/lib/kinova-assistant.ts';
import { isQuestionOrAdviceRequest, requiresExtendedReasoning } from '../src/lib/intent-router.ts';
import { formatAssetCurrency, formatCurrency, formatPnl } from '../src/lib/currency.ts';
import { formatPeriodDisplay, stepPeriod } from '../src/lib/period-helper.ts';

test('Intent & Analytics routing: budget, goals, affordability, and big-expense queries route to Kinova AI reasoning instead of rigid analytics', () => {
  assert.equal(isSpendingAnalyticsQuery('我这个月预算还剩多少？'), false);
  assert.equal(isSpendingAnalyticsQuery('最近有什么大额开支？'), false);
  assert.equal(isSpendingAnalyticsQuery('Can I afford RM 800 headphones?'), false);
  assert.equal(isSpendingAnalyticsQuery('帮我平衡这个月的超支预算'), false);

  assert.equal(isQuestionOrAdviceRequest('我这个月预算还剩多少？'), true);
  assert.equal(requiresExtendedReasoning('最近有什么大额开支？'), true);

  assert.equal(isSpendingAnalyticsQuery('这个月花了多少'), true);
  assert.equal(isSpendingAnalyticsQuery('我在 Mamak 一共消费了多少？'), true);
});

test('Spending analytics filters specific merchant accurately and ignores tx_sample', () => {
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const txs = [
    { id: 'tx_sample', date: `${ym}-01`, type: 'expense', category: 'Food & Dining', description: 'Starter', amount: 999, currency: 'MYR' },
    { id: 'tx_1', date: `${ym}-03`, type: 'expense', category: 'Food & Dining', description: 'Mamak Roti Canai', amount: 12.5, currency: 'MYR' },
    { id: 'tx_2', date: `${ym}-05`, type: 'expense', category: 'Food & Dining', description: 'Sushi Zanmai', amount: 68, currency: 'MYR' },
    { id: 'tx_3', date: `${ym}-07`, type: 'expense', category: 'Food & Dining', description: 'Mamak Nasi Kandar', amount: 15, currency: 'MYR' },
  ];

  const mamakStats = computeSpendingAnalytics('我在 Mamak 一共消费了多少？', txs);
  assert.equal(mamakStats.transactionCount, 2);
  assert.equal(Number(mamakStats.totalSpent.toFixed(2)), 27.5);

  const lastYearRange = resolveTimeframe('去年交通花了多少');
  assert.equal(lastYearRange.startDate, `${now.getFullYear() - 1}-01-01`);
  assert.equal(lastYearRange.endDate, `${now.getFullYear() - 1}-12-31`);

  const recentRange = resolveTimeframe('最近消费情况');
  assert.ok(recentRange.startDate < recentRange.endDate);
});

test('Copilot deterministic facts build fuel price ladder even with petrol category words and surface largest expense', () => {
  const now = new Date();
  const yr = now.getFullYear();
  const ym = `${yr}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const txs = [
    {
      id: 'tx_sample',
      date: `${ym}-01`,
      type: 'expense',
      category: 'Transport',
      description: 'Sample Petrol',
      amount: 500,
      currency: 'MYR',
    },
    {
      id: 'tx_petronas',
      date: `${ym}-04`,
      type: 'expense',
      category: 'Transport',
      description: 'Petronas RON95',
      amount: 41,
      currency: 'MYR',
      notes: 'RON95 20L [Receipt Items: RON95 x20 @ 2.05 = MYR 41.00]',
    },
    {
      id: 'tx_shell',
      date: `${ym}-08`,
      type: 'expense',
      category: 'Transport',
      description: 'Shell V-Power',
      amount: 60,
      currency: 'MYR',
      notes: 'Petrol [Receipt Items: Shell Fuel x20 @ 3.00 = MYR 60.00]',
    },
    {
      id: 'tx_flight',
      date: `${ym}-09`,
      type: 'expense',
      category: 'Shopping',
      description: 'Sony WH-1000XM5',
      amount: 1299,
      currency: 'MYR',
    },
  ];

  const fuelFacts = computeCopilotFacts('今年我在哪里打汽油最便宜？', txs);
  assert.ok(Array.isArray(fuelFacts.priceLadder) && fuelFacts.priceLadder.length >= 2);
  assert.equal(fuelFacts.priceLadder[0].isLowest, true);
  assert.ok(fuelFacts.priceLadder[0].unitPrice <= fuelFacts.priceLadder[1].unitPrice);

  const bigFacts = computeCopilotFacts('最近有什么大额开支？', txs);
  assert.equal(bigFacts.largestExpense?.description, 'Sony WH-1000XM5');
  assert.equal(bigFacts.largestExpense?.amount, 1299);
});

test('CFO Cashflow Briefing computes month-over-month totals, top expenses, goals progress, and consistent rebalance payload', () => {
  const txs = [
    { id: 'inc_cur', date: '2026-11-01', type: 'income', category: 'Salary', description: 'Nov Salary', amount: 6000, currency: 'MYR' },
    { id: 'inc_prev', date: '2026-10-01', type: 'income', category: 'Salary', description: 'Oct Salary', amount: 5800, currency: 'MYR' },
    { id: 'exp_cur_1', date: '2026-11-05', type: 'expense', category: 'Food & Dining', description: 'Hotpot Dinner', amount: 320, currency: 'MYR' },
    { id: 'exp_cur_2', date: '2026-11-06', type: 'expense', category: 'Shopping', description: 'Sneakers', amount: 450, currency: 'MYR' },
    { id: 'exp_prev_1', date: '2026-10-10', type: 'expense', category: 'Food & Dining', description: 'Oct Groceries', amount: 500, currency: 'MYR' },
    { id: 'inv_cur_1', date: '2026-11-02', type: 'investment', category: 'Emergency Savings', description: 'Maybank Goal', amount: 800, currency: 'MYR' },
  ];
  const profile = {
    language: 'zh',
    paydayDay: 28,
    suggestedPayday: 1,
    monthlyBudgetCap: 3000,
    baselineIncome: 6000,
    savingsTargetPct: 20,
    investmentTargetPct: 10,
    emergencyReserve: 5000,
    goals: [{ id: 'g1', name: 'Japan Trip Fund', targetAmount: 10000, currentAmount: 6000 }],
    rejectedChips: [],
    recentActions: [],
  };

  const facts = computeDeterministicLedgerFacts(txs, profile, '这个月对比上个月花了多少？目标进度如何？', '2026-11-27');
  const briefing = facts.cashflowBriefing;
  assert.ok(briefing);
  assert.equal(briefing.lastMonthIncome, 5800);
  assert.equal(briefing.lastMonthTotalSpent, 500);
  assert.equal(briefing.currentMonthSavedOrInvested, 800);
  assert.equal(briefing.topExpensesThisMonth?.[0]?.description, 'Sneakers');
  assert.equal(briefing.goalsProgress?.[0]?.progressPct, 60);
  assert.equal(briefing.goalsProgress?.[0]?.remainingAmount, 4000);

  const rebalance = buildRebalanceCapsProposedAction('I overspent RM 300 on Shopping, fix budget', txs, profile, '2026-11-27');
  if (rebalance) {
    assert.ok(rebalance.proposedAction.payload.updatedCaps);
    assert.ok(rebalance.proposedAction.payload.rebalancedCaps);
    assert.equal(
      rebalance.proposedAction.payload.updatedCaps,
      rebalance.proposedAction.payload.rebalancedCaps
    );
  }
});

test('Currency formatters prevent RM/number line wrapping and period helpers stay uniform', () => {
  assert.equal(formatCurrency(1000, 'MYR'), 'RM\u00A01,000.00');
  assert.equal(formatAssetCurrency(1250.5, 'MYR'), 'RM\u00A01250.50');
  assert.equal(formatPnl(-42, 'MYR'), '-RM\u00A042.00');

  assert.equal(formatPeriodDisplay('all'), 'All time');
  assert.equal(formatPeriodDisplay('year-2026'), '2026 full year');
  assert.equal(stepPeriod('2026-11', -1, '2026-11'), '2026-10');
});
