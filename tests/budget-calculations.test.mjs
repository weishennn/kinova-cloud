import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateDailySafeSpend,
  countActiveBudgetMonths,
  fitCapsToLivingBudget,
  getAllBudgetCategoryRows,
  getCategoryCommitmentBreakdown,
  getSavedCategoryCaps,
  isDailyCategory,
  normalizeCategoryCapsRecord,
  predictMonthlySavingsAndInvestments,
  resolveCategoryCapValue,
  saveCategoryCaps,
} from '../src/lib/category-budget-helper.ts';
import { computeDeterministicLedgerFacts } from '../src/lib/kinova-assistant.ts';
import {
  calculateFinancialHealthScore,
  generateAiFinancialBriefing,
  predictCashflowTrajectory,
} from '../src/lib/financial-intelligence.ts';

function withMockLocalStorage(initialEntries, fn) {
  const store = new Map(Object.entries(initialEntries || {}));
  const previousLocalStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };
  try {
    return fn(store);
  } finally {
    if (previousLocalStorage === undefined) {
      delete globalThis.localStorage;
    } else {
      globalThis.localStorage = previousLocalStorage;
    }
  }
}

test('1. getCategoryCommitmentBreakdown converts foreign-currency installments to MYR and excludes trip plans', () => {
  const installments = [
    {
      id: 'inst_jpy_laptop',
      name: 'Keyboard Split Pay',
      category: 'Shopping',
      monthlyAmount: 2910,
      currency: 'JPY',
      startDate: '2026-10-01',
      endDate: '2026-12-31',
      tenureMonths: 3,
      remainingMonths: 2,
    },
    {
      id: 'inst_trip_tokyo',
      name: 'Shinkansen Pass',
      category: 'Transport',
      monthlyAmount: 500,
      currency: 'MYR',
      tripTag: 'Tokyo 2026',
      startDate: '2026-10-01',
      endDate: '2026-12-31',
      tenureMonths: 3,
      remainingMonths: 2,
    },
  ];

  withMockLocalStorage(
    {
      cashflow_installment_plans: JSON.stringify(installments),
    },
    () => {
      const breakdown = getCategoryCommitmentBreakdown([], '2026-11', {
        referenceDate: new Date(2026, 10, 10),
      });

      // 2910 JPY * 0.028 = RM 81.48 (NOT RM 2910!)
      const shoppingReserve = breakdown.unpaidReserveByCategory.get('Shopping') || 0;
      assert.equal(Number(shoppingReserve.toFixed(2)), 81.48);

      // Trip-tagged installment must not leak into domestic Transport reserve
      assert.equal(breakdown.unpaidReserveByCategory.get('Transport') || 0, 0);
    }
  );
});

test('2. Future-effective recurring commitments are not reserved in earlier months', () => {
  const recurring = [
    {
      id: 'rec_future_gym',
      name: 'New Gym Membership',
      category: 'Sport',
      amount: 180,
      effectiveFrom: '2026-12',
      history: [{ effectiveFrom: '2026-12', amount: 180 }],
    },
    {
      id: 'rec_active_wifi',
      name: 'TIME Fibre',
      category: 'Housing & Bills',
      amount: 139,
      effectiveFrom: '2026-09',
      history: [{ effectiveFrom: '2026-09', amount: 139 }],
    },
  ];

  withMockLocalStorage(
    {
      cashflow_recurring_commitments: JSON.stringify(recurring),
    },
    () => {
      const novBreakdown = getCategoryCommitmentBreakdown([], '2026-11', {
        referenceDate: new Date(2026, 10, 10),
      });
      assert.equal(novBreakdown.unpaidReserveByCategory.get('Sport') || 0, 0);
      assert.equal(novBreakdown.totalCommittedByCategory.get('Sport') || 0, 0);
      assert.equal(novBreakdown.unpaidReserveByCategory.get('Housing & Bills'), 139);

      const decBreakdown = getCategoryCommitmentBreakdown([], '2026-12', {
        referenceDate: new Date(2026, 10, 10),
      });
      assert.equal(decBreakdown.unpaidReserveByCategory.get('Sport'), 180);
    }
  );
});

test('3. Paid commitments across category aliases and deterministic IDs are not double-counted in reserves', () => {
  const recurring = [
    {
      id: 'rec:parent-1',
      name: 'Monthly Parents Support',
      category: 'Parents',
      amount: 500,
      effectiveFrom: '2026-01',
    },
    {
      id: 'rec_tnb_bill',
      name: 'TNB Electricity',
      category: 'Housing & Bills',
      amount: 120,
      effectiveFrom: '2026-01',
    },
  ];

  const monthTxs = [
    {
      id: 'manual_1',
      date: '2026-11-03',
      type: 'Expense',
      category: 'Family', // synonym for Parents
      description: 'Monthly Parents',
      amount: 500,
    },
    {
      id: 'tx_rec_rec_tnb_bill_2026-11',
      date: '2026-11-05',
      type: 'Expense',
      category: 'Bills', // synonym for Housing & Bills
      description: 'Electricity auto debit',
      amount: 120,
    },
  ];

  withMockLocalStorage(
    {
      cashflow_recurring_commitments: JSON.stringify(recurring),
    },
    () => {
      const breakdown = getCategoryCommitmentBreakdown(monthTxs, '2026-11', {
        referenceDate: new Date(2026, 10, 10),
      });
      assert.equal(breakdown.unpaidReserveByCategory.get('Parents') || 0, 0);
      assert.equal(breakdown.unpaidReserveByCategory.get('Housing & Bills') || 0, 0);
    }
  );
});

test('4. Early-paid-off installment plans do not reserve future months once tenure payments are complete', () => {
  const installments = [
    {
      id: 'inst_phone_3m',
      name: 'Phone Split',
      category: 'Shopping',
      monthlyAmount: 400,
      currency: 'MYR',
      startDate: '2026-08-01',
      endDate: '2026-12-31',
      tenureMonths: 3,
    },
  ];

  const txs = [
    {
      id: 'tx_inst_inst_phone_3m_2026-08',
      date: '2026-08-05',
      type: 'Expense',
      category: 'Shopping',
      description: 'Phone Split (Installment 1/3)',
      amount: 400,
    },
    {
      id: 'tx_inst_inst_phone_3m_2026-09',
      date: '2026-09-05',
      type: 'Expense',
      category: 'Shopping',
      description: 'Phone Split (Installment 2/3)',
      amount: 400,
    },
    {
      id: 'tx_inst_inst_phone_3m_2026-10',
      date: '2026-10-05',
      type: 'Expense',
      category: 'Shopping',
      description: 'Phone Split (Installment 3/3)',
      amount: 400,
    },
  ];

  withMockLocalStorage(
    {
      cashflow_installment_plans: JSON.stringify(installments),
    },
    () => {
      const novBreakdown = getCategoryCommitmentBreakdown(txs, '2026-11', {
        referenceDate: new Date(2026, 10, 10),
      });
      assert.equal(novBreakdown.unpaidReserveByCategory.get('Shopping') || 0, 0);
      assert.equal(novBreakdown.totalCommittedByCategory.get('Shopping') || 0, 0);
    }
  );
});

test('5. Category cap canonicalization preserves explicit RM 0 without alias duplication', () => {
  const normalized = normalizeCategoryCapsRecord({
    Parents: 0,
    Family: 300,
    Bills: 450,
  });
  assert.equal(normalized['Parents'], 0);
  assert.equal(normalized['Housing & Bills'], 450);
  assert.equal('Family' in normalized, false);
  assert.equal('Bills' in normalized, false);

  assert.equal(resolveCategoryCapValue('Parents', { Parents: 0, Family: 300 }, 500), 0);

  withMockLocalStorage(
    {
      cashflow_category_caps: JSON.stringify({
        'Food & Dining': 900,
        Parents: 0,
        Family: 350, // legacy user value alongside default zero stub
      }),
    },
    (store) => {
      const loaded = getSavedCategoryCaps();
      assert.equal(loaded['Parents'], 350);
      assert.equal('Family' in loaded, false);

      saveCategoryCaps({ 'Food & Dining': 800, Parents: 0, Family: 350 });
      const persisted = JSON.parse(store.get('cashflow_category_caps') || '{}');
      assert.equal(persisted['Parents'], 0);
      assert.equal('Family' in persisted, false);
    }
  );
});

test('6. getAllBudgetCategoryRows & countActiveBudgetMonths handle past, year, all-time, and Food aliases cleanly', () => {
  const txs = [
    { id: 't1', date: '2026-09-10', type: 'Expense', category: 'Groceries', description: 'Jaya Grocer', amount: 120 },
    { id: 't2', date: '2026-11-02', type: 'Expense', category: 'Dining', description: 'Cafe', amount: 80 },
    { id: 't3', date: '2026-11-04', type: 'Expense', category: 'Shopping', description: 'Tokyo Hotel', amount: 2000, tripTag: 'Tokyo 2026' },
  ];

  const caps = { 'Food & Dining': 600, Shopping: 150, Parents: 0 };
  const refDate = new Date(2026, 10, 10);

  withMockLocalStorage(
    {
      cashflow_recurring_commitments: JSON.stringify([
        { id: 'rec_net', name: 'Internet', category: 'Housing & Bills', amount: 100, effectiveFrom: '2026-01' },
      ]),
    },
    () => {
      assert.equal(isDailyCategory(''), false);
      assert.equal(isDailyCategory('Groceries'), true);
      assert.equal(isDailyCategory('Dining'), true);

      assert.equal(countActiveBudgetMonths(txs), 2);

      // Past month: unpaidBillReserve must be 0 even for recurring commitments
      const sepRows = getAllBudgetCategoryRows(txs, { caps, targetMonth: '2026-09', referenceDate: refDate });
      const sepHousing = sepRows.find((r) => r.category === 'Housing & Bills');
      const sepFood = sepRows.find((r) => r.category === 'Food & Dining');
      assert.equal(sepHousing?.unpaidBillReserve, 0);
      assert.equal(sepFood?.spent, 120);

      // Current month: Groceries + Dining folded into Food & Dining; Tokyo trip excluded from Shopping
      const novRows = getAllBudgetCategoryRows(txs, { caps, targetMonth: '2026-11', referenceDate: refDate });
      const novFood = novRows.find((r) => r.category === 'Food & Dining');
      const novShopping = novRows.find((r) => r.category === 'Shopping');
      const novHousing = novRows.find((r) => r.category === 'Housing & Bills');
      assert.equal(novFood?.spent, 80);
      assert.equal(novFood?.isDailyCategory, true);
      assert.equal(novShopping?.spent, 0);
      assert.equal(novHousing?.unpaidBillReserve, 100);

      // Year mode: 12x caps and full 2026 living spend (120 + 80 = 200), zero reserve
      const yearRows = getAllBudgetCategoryRows(txs, { caps, targetMonth: 'year-2026', referenceDate: refDate });
      const yearFood = yearRows.find((r) => r.category === 'Food & Dining');
      const yearHousing = yearRows.find((r) => r.category === 'Housing & Bills');
      assert.equal(yearFood?.cap, 7200);
      assert.equal(yearFood?.spent, 200);
      assert.equal(yearHousing?.unpaidBillReserve, 0);

      // All-time mode: 2 active months -> 2x caps and total living spend
      const allRows = getAllBudgetCategoryRows(txs, { caps, targetMonth: 'all', referenceDate: refDate });
      const allFood = allRows.find((r) => r.category === 'Food & Dining');
      assert.equal(allFood?.cap, 1200);
      assert.equal(allFood?.spent, 200);
      assert.equal(allFood?.unpaidBillReserve, 0);
    }
  );
});

test('7. calculateDailySafeSpend deducts unpaidReserve cleanly on active months only', () => {
  const refDate = new Date(2026, 10, 10); // Nov 10 -> 21 days left inclusive in Nov (30 days)
  const nov = calculateDailySafeSpend(3000, 900, '2026-11', refDate, { unpaidReserve: 1200 });
  assert.equal(nov.remainingBudget, 2100);
  assert.equal(nov.safeRemainingBudget, 900);
  assert.equal(nov.daysRemaining, 21);
  assert.equal(nov.dailyAllowance, Number((900 / 21).toFixed(2)));

  // Past month ignores unpaidReserve
  const past = calculateDailySafeSpend(3000, 900, '2026-09', refDate, { unpaidReserve: 1200 });
  assert.equal(past.isPastMonth, true);
  assert.equal(past.safeRemainingBudget, 2100);
});

test('8. fitCapsToLivingBudget keeps explicit RM 0, locked caps, and spent+reserve floors without aliases', () => {
  const refDate = new Date(2026, 10, 10);
  const txs = [
    { id: 't1', date: '2026-11-05', type: 'Expense', category: 'Food & Dining', amount: 300 },
  ];

  withMockLocalStorage({}, () => {
    const fitted = fitCapsToLivingBudget(
      {
        'Food & Dining': 1000,
        Shopping: 500,
        Transport: 400,
        Parents: 0,
        Family: 200,
      },
      1500,
      { Shopping: true },
      txs,
      refDate
    );

    assert.equal('Family' in fitted, false);
    assert.equal(fitted['Parents'], 0);
    assert.equal(fitted['Shopping'], 500);
    assert.ok(fitted['Food & Dining'] >= 300);
    const total = Object.values(fitted).reduce((s, v) => s + v, 0);
    assert.ok(total <= 1500, `Expected fitted total (${total}) <= 1500`);
  });
});

test('9. predictMonthlySavingsAndInvestments & computeDeterministicLedgerFacts quarantine trips and align spend', () => {
  const refDate = new Date(2026, 10, 10);
  const txs = [
    { id: 'inc1', date: '2026-11-01', type: 'Income', category: 'Salary', description: 'Salary', amount: 5000 },
    { id: 'e1', date: '2026-11-02', type: 'Expense', category: 'Groceries', description: 'Groceries', amount: 150 },
    { id: 'e2', date: '2026-11-03', type: 'Expense', category: 'Family', description: 'Mom Gift', amount: 250 },
    { id: 'trip1', date: '2026-11-04', type: 'Expense', category: 'Transport', description: 'Flight to Tokyo', amount: 1800, tripTag: 'Tokyo 2026' },
  ];

  const profile = {
    language: 'auto',
    paydayDay: 28,
    suggestedPayday: null,
    monthlyBudgetCap: 3000,
    baselineIncome: 5000,
    savingsTargetPct: 20,
    investmentTargetPct: 20,
    emergencyMonthsGoal: 6,
    emergencyReserve: 15000,
    goals: [],
    rejectedChips: [],
    recentActions: [],
  };

  withMockLocalStorage(
    {
      cashflow_installment_plans: JSON.stringify([
        {
          id: 'inst_jpy',
          name: 'Watch Split',
          category: 'Shopping',
          monthlyAmount: 2910,
          currency: 'JPY',
          startDate: '2026-10-01',
          endDate: '2026-12-31',
          tenureMonths: 3,
        },
      ]),
    },
    () => {
      const pred = predictMonthlySavingsAndInvestments(txs, {
        selectedMonth: '2026-11',
        baselineIncome: 5000,
        savingsTargetPct: 20,
        investmentTargetPct: 20,
        referenceDate: refDate,
      });
      assert.equal(pred.spentSoFar, 400);
      assert.equal(pred.tripQuarantinedSpent, 1800);
      assert.equal(Number((pred.unpaidCommittedReserve || 0).toFixed(2)), 81.48);

      const facts = computeDeterministicLedgerFacts(txs, profile, 'Tokyo', '2026-11-10');
      assert.equal(facts.currentMonthTotalSpent, 400);
      assert.equal(facts.currentMonthBudgetRemaining, 2600);
      assert.equal(facts.categorySpending['Food & Dining'], 150);
      assert.equal(facts.categorySpending['Parents'], 250);
      assert.equal(facts.cashflowBriefing?.spentSoFar, 400);
      assert.equal(facts.cashflowBriefing?.tripQuarantinedSpent, 1800);
      assert.equal(facts.cashflowBriefing?.unpaidCommittedBillsReserve, 81.48);
      assert.equal(facts.cashflowBriefing?.remainingSafeLivingPool, 2518.52);
    }
  );
});

test('10. financial-intelligence converts foreign installments to MYR and excludes trip/future/completed commitments', () => {
  const recurring = [
    {
      id: 'rec_internet',
      name: 'Unifi Fibre',
      category: 'Housing & Bills',
      dayOfMonth: 15,
      amount: 149,
      effectiveFrom: '2026-01',
    },
    {
      id: 'rec_future',
      name: 'Future Gym',
      category: 'Sport',
      dayOfMonth: 15,
      amount: 200,
      effectiveFrom: '2026-12',
    },
  ];
  const installments = [
    {
      id: 'inst_jpy_active',
      name: 'Camera Gear',
      currency: 'JPY',
      monthlyAmount: 10000, // 10000 JPY * 0.028 = RM 280
      startDate: '2026-10-01',
      endDate: '2026-12-31',
      remainingMonths: 2,
    },
    {
      id: 'inst_trip_only',
      name: 'JR Rail Pass',
      currency: 'MYR',
      monthlyAmount: 450,
      tripTag: 'Osaka 2026',
      startDate: '2026-10-01',
      endDate: '2026-12-31',
      remainingMonths: 2,
    },
    {
      id: 'inst_paid_off',
      name: 'Old Monitor',
      currency: 'MYR',
      monthlyAmount: 300,
      startDate: '2025-11-01',
      endDate: '2026-10-31',
      remainingMonths: 0,
    },
    {
      id: 'inst_future',
      name: 'Next Month Desk',
      currency: 'MYR',
      monthlyAmount: 250,
      startDate: '2026-12-01',
      endDate: '2027-05-31',
      remainingMonths: 6,
    },
  ];

  withMockLocalStorage(
    {
      cashflow_recurring_commitments: JSON.stringify(recurring),
      cashflow_installment_plans: JSON.stringify(installments),
      cashflow_category_caps: JSON.stringify({
        'Food & Dining': 800,
        'Housing & Bills': 400,
        Bills: 400,
      }),
    },
    () => {
      const txs = [
        { id: 'inc1', date: '2026-11-01', type: 'Income', category: 'Salary', description: 'Salary', amount: 5000 },
        { id: 'exp1', date: '2026-11-02', type: 'Expense', category: 'Food & Dining', description: 'Lunch', amount: 120 },
      ];

      const trajectory = predictCashflowTrajectory({
        transactions: txs,
        startingCash: 3000,
        baselineMonthlyIncome: 5000,
        referenceDateStr: '2026-11-10',
        language: 'en',
      });
      // Fixed monthly commitments in 2026-11: RM 149 (Unifi) + RM 280 (10000 JPY) = RM 429
      assert.equal(Number(trajectory.fixedMonthlyCommitments.toFixed(2)), 429);

      const health = calculateFinancialHealthScore({
        transactions: txs,
        baselineIncome: 5000,
        referenceDateStr: '2026-11-10',
        targetMonthStr: '2026-11',
        language: 'en',
      });
      // 429 / 5000 = 8.58% -> 9%
      assert.match(health.dimensions.fixedCostBurden.details, /9% of income/);

      const healthNoIncome = calculateFinancialHealthScore({
        transactions: [],
        baselineIncome: 0,
        referenceDateStr: '2026-11-10',
        targetMonthStr: '2026-11',
        language: 'en',
      });
      assert.match(healthNoIncome.dimensions.fixedCostBurden.details, /RM 429\/mo/);

      const briefing = generateAiFinancialBriefing(txs, '2026-11', 2000, 'en');
      // Future recurring commitment (2026-12) must not inflate 2026-11 recurring total
      assert.equal(briefing.upcomingCommitmentsTotal, 149);
    }
  );
});
