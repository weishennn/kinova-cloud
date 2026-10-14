import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreReceiptItemQuery } from '../src/lib/receipt-items.ts';
import {
  isSpendingAnalyticsQuery,
  computeSpendingAnalytics,
} from '../src/lib/spending-analytics.ts';

test('scoreReceiptItemQuery strictly requires all tokens for 2-word queries like chicken rice', () => {
  const omuRice = {
    name: 'Japanese Omu Rice',
    quantity: 1,
    unitPrice: 28,
    amount: 28,
    category: 'Food',
  };

  const chickenRice = {
    name: 'Hainanese Chicken Rice',
    quantity: 1,
    unitPrice: 12.5,
    amount: 12.5,
    category: 'Food',
  };

  const roastChicken = {
    name: 'Roast Chicken Chop',
    quantity: 1,
    unitPrice: 22,
    amount: 22,
    category: 'Food',
  };

  // 1. "chicken rice" MUST NOT match "Japanese Omu Rice"
  const omuScore = scoreReceiptItemQuery(omuRice, 'chicken rice');
  assert.equal(omuScore, 0, 'Omu rice must NOT match chicken rice');

  // 2. "chicken rice" MUST match "Hainanese Chicken Rice"
  const chickenRiceScore = scoreReceiptItemQuery(chickenRice, 'chicken rice');
  assert.ok(chickenRiceScore >= 90, 'Hainanese Chicken Rice must match chicken rice');

  // 3. "chicken rice" MUST NOT match "Roast Chicken Chop" (lacks rice)
  const chopScore = scoreReceiptItemQuery(roastChicken, 'chicken rice');
  assert.equal(chopScore, 0, 'Roast chicken chop must NOT match chicken rice');

  // 4. Chinese query: "鸡饭" should match "海南鸡饭"
  const chineseItem = {
    name: '传统海南鸡饭',
    quantity: 1,
    unitPrice: 10,
    amount: 10,
  };
  const chineseScore = scoreReceiptItemQuery(chineseItem, '鸡饭');
  assert.equal(chineseScore, 100, '鸡饭 should match 传统海南鸡饭');
});

test('isSpendingAnalyticsQuery distinguishes spending queries from item price checks', () => {
  // Spending analytics queries
  assert.equal(isSpendingAnalyticsQuery('这个月我花了多少钱在food'), true);
  assert.equal(isSpendingAnalyticsQuery('how much did i spend on food this month'), true);
  assert.equal(isSpendingAnalyticsQuery('上个月交通花了多少'), true);
  assert.equal(isSpendingAnalyticsQuery('这个月总共花了多少钱'), true);
  assert.equal(isSpendingAnalyticsQuery('total spending this month'), true);

  // Price queries (should NOT be spending analytics)
  assert.equal(isSpendingAnalyticsQuery('how much is chicken rice'), false);
  assert.equal(isSpendingAnalyticsQuery('chicken rice 多少钱'), false);
  assert.equal(isSpendingAnalyticsQuery('omu rice price'), false);
});

test('computeSpendingAnalytics correctly aggregates category spending and calculates totals', () => {
  const mockTransactions = [
    {
      id: 'tx-1',
      date: '2026-10-02',
      amount: 15.5,
      type: 'expense',
      category: 'Food',
      description: 'Chicken Rice Stall',
      currency: 'MYR',
    },
    {
      id: 'tx-2',
      date: '2026-10-05',
      amount: 85.0,
      type: 'expense',
      category: 'Food',
      description: 'Haidilao Hotpot',
      currency: 'MYR',
    },
    {
      id: 'tx-3',
      date: '2026-10-08',
      amount: 50.0,
      type: 'expense',
      category: 'Transport',
      description: 'Petrol Shell',
      currency: 'MYR',
    },
    {
      id: 'tx-4',
      date: '2026-09-15',
      amount: 60.0,
      type: 'expense',
      category: 'Food',
      description: 'Cafe Brunch',
      currency: 'MYR',
    },
  ];

  const result = computeSpendingAnalytics(
    '这个月我花了多少钱在food',
    mockTransactions,
    '2026-10-15'
  );

  assert.equal(result.isAnalyticsQuery, true);
  assert.equal(result.categoryName, 'Food');
  // 15.5 + 85.0 = 100.5 (tx-1 and tx-2 in October)
  assert.equal(result.totalSpent, 100.5);
  assert.equal(result.transactionCount, 2);
  assert.equal(result.largestExpense?.description, 'Haidilao Hotpot');
  assert.equal(result.largestExpense?.amount, 85.0);
  assert.equal(result.previousPeriodSpent, 60.0); // September food was 60.0
  assert.ok(result.conversationalSummary.includes('100.50'));
  assert.ok(result.conversationalSummary.includes('Haidilao Hotpot'));
});
