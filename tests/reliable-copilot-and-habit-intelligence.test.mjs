import test from 'node:test';
import assert from 'node:assert/strict';

import { computeDeterministicLedgerFacts } from '../src/lib/copilot-ledger-facts.ts';
import { mineUserHabitSuggestions } from '../src/lib/habit-suggestions.ts';
import {
  matchMerchantCategoryRule,
} from '../src/lib/merchant-rules.ts';
import { generateProactiveAlerts } from '../src/lib/proactive-alerts.ts';

test('1. computeDeterministicLedgerFacts calculates exact ledger statistics across 100% of transactions', () => {
  const sampleLedger = [
    { id: 'tx-1', date: '2026-10-01', amount: 12.5, type: 'expense', category: 'Food & Dining', description: 'Chicken Rice', currency: 'MYR' },
    { id: 'tx-2', date: '2026-10-05', amount: 80.0, type: 'expense', category: 'Transport', description: 'Shell Petrol FuelSave 95', currency: 'MYR' },
    { id: 'tx-3', date: '2026-10-10', amount: 15.0, type: 'expense', category: 'Food & Dining', description: '四夕豆花 Tau Foo Fah', currency: 'MYR' },
    { id: 'tx-4', date: '2026-09-15', amount: 3000.0, type: 'income', category: 'Salary', description: 'Monthly Salary', currency: 'MYR' },
    { id: 'tx-5', date: '2026-08-20', amount: 120.0, type: 'expense', category: 'Shopping', description: 'Uniqlo Shirt', currency: 'MYR' },
  ];

  // Query 1: Category-specific spending
  const foodFacts = computeDeterministicLedgerFacts('查查我在吃的上面花了多少钱', sampleLedger, '2026-10-18');
  assert.equal(foodFacts.transactionCount, 2);
  assert.equal(foodFacts.exactTotalSpent, 27.5);
  assert.equal(foodFacts.matchingTransactionIds.length, 2);
  assert.ok(foodFacts.categoryLabel?.includes('餐饮') || foodFacts.categoryLabel?.includes('Food'));

  // Query 1b: All-spending query (populates categoryBreakdown)
  const allFacts = computeDeterministicLedgerFacts('今年总共花了多少钱', sampleLedger, '2026-10-18');
  assert.ok(allFacts.exactTotalSpent > 0);
  const foodCategory = allFacts.categoryBreakdown?.find((c) => c.category === 'Food & Dining');
  assert.ok(foodCategory, 'All-spending query should breakdown categories');
  assert.equal(foodCategory.amount, 27.5);

  // Query 2: Specific merchant search
  const tofuFacts = computeDeterministicLedgerFacts('四夕豆花', sampleLedger);
  assert.equal(tofuFacts.transactionCount, 1);
  assert.equal(tofuFacts.exactTotalSpent, 15.0);
  assert.equal(tofuFacts.matchingTransactionIds[0], 'tx-3');
  assert.equal(tofuFacts.isFoundInPersonalLedger, true);

  // Query 3: Item not in personal ledger (returns 0 matched records with clear notice)
  const unknownFacts = computeDeterministicLedgerFacts('iPad Pro', sampleLedger);
  assert.equal(unknownFacts.transactionCount, 0);
  assert.equal(unknownFacts.exactTotalSpent, 0);
  assert.equal(unknownFacts.isFoundInPersonalLedger, false);
});

test('2. mineUserHabitSuggestions generates contextual chips from real user expense history', () => {
  const sampleTransactions = [
    { id: '1', date: '2026-10-01', amount: 15, type: 'expense', category: 'Food & Dining', description: '四夕豆花', currency: 'MYR' },
    { id: '2', date: '2026-10-03', amount: 15, type: 'expense', category: 'Food & Dining', description: '四夕豆花', currency: 'MYR' },
    { id: '3', date: '2026-10-08', amount: 16, type: 'expense', category: 'Food & Dining', description: '四夕豆花', currency: 'MYR' },
    { id: '4', date: '2026-10-04', amount: 80, type: 'expense', category: 'Transport', description: 'Shell Petrol', currency: 'MYR' },
    { id: '5', date: '2026-10-12', amount: 82, type: 'expense', category: 'Transport', description: 'Shell Petrol', currency: 'MYR' },
    { id: '6', date: '2026-10-02', amount: 45, type: 'expense', category: 'Bills', description: 'Unifi Internet', currency: 'MYR' },
  ];

  // At lunch time (12:30 PM)
  const lunchTime = new Date('2026-10-15T12:30:00');
  const lunchSuggestions = mineUserHabitSuggestions(sampleTransactions, lunchTime);

  assert.ok(lunchSuggestions.length >= 2, 'Should provide personalized suggestions');
  const beanSuggestion = lunchSuggestions.find((s) => s.text.includes('四夕豆花'));
  assert.ok(beanSuggestion, 'Top frequented food merchant should appear in lunch suggestions');
  assert.equal(beanSuggestion.text, '四夕豆花 15');

  const shellSuggestion = lunchSuggestions.find((s) => s.text.includes('Shell Petrol'));
  assert.ok(shellSuggestion, 'Frequent transport should appear');
  assert.equal(shellSuggestion.text, 'Shell Petrol 81');
});

test('3. Merchant category memory rules allow users to override defaults and prioritize specific rules', () => {
  const customRules = [
    {
      id: 'rule-1',
      merchantPattern: '四夕豆花',
      category: 'Food & Dining',
      subCategory: 'Dessert',
      createdAt: '2026-10-01T00:00:00Z',
      source: 'user_override',
    },
    {
      id: 'rule-2',
      merchantPattern: 'Shell Select Store',
      category: 'Groceries',
      subCategory: 'Snacks',
      createdAt: '2026-10-02T00:00:00Z',
      source: 'user_override',
    },
    {
      id: 'rule-3',
      merchantPattern: 'Shell',
      category: 'Transport',
      subCategory: 'Fuel',
      createdAt: '2026-10-01T00:00:00Z',
      source: 'user_override',
    },
  ];

  // Match 1: exact / partial merchant match
  const match1 = matchMerchantCategoryRule('四夕豆花 (SS2 Branch)', customRules);
  assert.ok(match1);
  assert.equal(match1.category, 'Food & Dining');
  assert.equal(match1.subCategory, 'Dessert');

  // Match 2: Longest pattern precedence (Shell Select Store should win over Shell)
  const matchStore = matchMerchantCategoryRule('Shell Select Store Mid Valley', customRules);
  assert.ok(matchStore);
  assert.equal(matchStore.category, 'Groceries', 'More specific rule must take precedence');

  // Match 3: Generic fallback to shorter rule when specific pattern is absent
  const matchFuel = matchMerchantCategoryRule('Shell Petrol Station Bangsar', customRules);
  assert.ok(matchFuel);
  assert.equal(matchFuel.category, 'Transport');

  // Match 4: Unknown merchant returns null
  const matchUnknown = matchMerchantCategoryRule('Random Tech Store', customRules);
  assert.equal(matchUnknown, null);
});

test('4. generateProactiveAlerts detects budget run-rate overspend, subscription hikes, and category spikes with clear explanations', () => {
  const referenceDate = '2026-10-15'; // Day 15 of 31 days in October

  const alertLedger = [
    // Previous month (2026-09) subscriptions & baseline
    { id: 'sub-sep', date: '2026-09-05', amount: 45.0, type: 'expense', category: 'Bills', description: 'Netflix Premium', currency: 'MYR' },
    { id: 'base-sep-1', date: '2026-09-10', amount: 1000.0, type: 'expense', category: 'Food & Dining', description: 'September Dining', currency: 'MYR' },
    { id: 'base-aug-1', date: '2026-08-10', amount: 1000.0, type: 'expense', category: 'Food & Dining', description: 'August Dining', currency: 'MYR' },
    { id: 'base-jul-1', date: '2026-07-10', amount: 1000.0, type: 'expense', category: 'Food & Dining', description: 'July Dining', currency: 'MYR' },

    // Current month (2026-10) up to Day 15:
    // 1) Netflix increased from 45 to 65
    { id: 'sub-oct', date: '2026-10-05', amount: 65.0, type: 'expense', category: 'Bills', description: 'Netflix Premium', currency: 'MYR' },

    // 2) Heavy Dining spending: 1500 spent in 15 days = 100/day vs historical 1000/30 = 33.3/day (3x spike)
    { id: 'food-oct-1', date: '2026-10-02', amount: 500.0, type: 'expense', category: 'Food & Dining', description: 'Fine Dining 1', currency: 'MYR' },
    { id: 'food-oct-2', date: '2026-10-08', amount: 500.0, type: 'expense', category: 'Food & Dining', description: 'Fine Dining 2', currency: 'MYR' },
    { id: 'food-oct-3', date: '2026-10-14', amount: 500.0, type: 'expense', category: 'Food & Dining', description: 'Fine Dining 3', currency: 'MYR' },
  ];

  // Set user budget cap at 2000 (projected is ~3234, so >1.3x -> critical)
  const alerts = generateProactiveAlerts(alertLedger, 2000, referenceDate);

  // Verification 1: Budget pace alert
  const budgetAlert = alerts.find((a) => a.type === 'budget_pace');
  assert.ok(budgetAlert, 'Should trigger budget pace overspend alert');
  assert.equal(budgetAlert.severity, 'critical');
  assert.ok(budgetAlert.explanation.includes('依据：'), 'Must provide explainable evidence string');
  assert.ok(budgetAlert.explanation.includes('2000.00'), 'Must cite user budget');
  assert.ok(budgetAlert.matchingTransactionIds.length >= 4, 'Must link to all current month transactions');

  // Verification 2: Subscription price hike alert
  const subAlert = alerts.find((a) => a.type === 'price_increase');
  assert.ok(subAlert, 'Should detect Netflix price increase');
  assert.equal(subAlert.actionSearchTerm, 'Netflix Premium');
  assert.ok(subAlert.explanation.includes('65.00') && subAlert.explanation.includes('45.00'));
  assert.deepEqual(subAlert.matchingTransactionIds, ['sub-oct', 'sub-sep']);

  // Verification 3: Category spending spike alert
  const categoryAlert = alerts.find((a) => a.type === 'category_spike');
  assert.ok(categoryAlert, 'Should detect Food & Dining spike');
  assert.equal(categoryAlert.actionCategory, 'Food & Dining');
  assert.ok(categoryAlert.explanation.includes('Food & Dining'));
  assert.equal(categoryAlert.matchingTransactionIds.length, 3);
});
