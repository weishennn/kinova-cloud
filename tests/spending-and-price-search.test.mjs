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

  // 5. Conversational query: "我找我买过的鸡饭多少钱" MUST match English "Hainanese Chicken Rice" & Chinese "传统海南鸡饭"
  const convScoreEnglish = scoreReceiptItemQuery(chickenRice, '我找我买过的鸡饭多少钱');
  assert.ok(convScoreEnglish >= 90, '我找我买过的鸡饭多少钱 must match Hainanese Chicken Rice');

  const convScoreChinese = scoreReceiptItemQuery(chineseItem, '我买过鸡饭多少钱？');
  assert.ok(convScoreChinese >= 90, '我买过鸡饭多少钱？ must match 传统海南鸡饭');

  // 6. Conversational query for chicken rice MUST NOT match Omu Rice
  const convOmuScore = scoreReceiptItemQuery(omuRice, '我找我买过的鸡饭多少钱');
  assert.equal(convOmuScore, 0, '我找我买过的鸡饭多少钱 must NOT match Omu Rice');
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

test('scoreReceiptItemQuery & extractCleanItemKeyword handle egg / 鸡蛋 / telur seamlessly', () => {
  const eggItemChinese = {
    name: '鸡蛋',
    quantity: 1,
    unitPrice: 8.5,
    amount: 8.5,
    category: 'Groceries',
  };

  const eggItemWithBrand = {
    name: '买鸡蛋',
    quantity: 1,
    unitPrice: 12.0,
    amount: 12.0,
    brand: 'Farm Fresh',
    category: 'Food',
  };

  const singleCharEgg = {
    name: '买蛋',
    quantity: 1,
    unitPrice: 6.0,
    amount: 6.0,
    category: 'Groceries',
  };

  const malayEgg = {
    name: 'Telur Ayam Gred A 30s',
    quantity: 1,
    unitPrice: 14.5,
    amount: 14.5,
    category: 'Groceries',
  };

  const englishEgg = {
    name: 'Grade A Eggs 10s',
    quantity: 1,
    unitPrice: 7.2,
    amount: 7.2,
    category: 'Groceries',
  };

  // 1. "egg" must match Chinese "鸡蛋", "买鸡蛋", "买蛋", Malay "Telur Ayam", and English "Grade A Eggs"
  assert.ok(scoreReceiptItemQuery(eggItemChinese, 'egg') >= 90, 'egg should match 鸡蛋');
  assert.ok(scoreReceiptItemQuery(eggItemWithBrand, 'egg') >= 90, 'egg should match 买鸡蛋');
  assert.ok(scoreReceiptItemQuery(singleCharEgg, 'egg') >= 90, 'egg should match 买蛋');
  assert.ok(scoreReceiptItemQuery(malayEgg, 'egg') >= 90, 'egg should match Telur Ayam');
  assert.ok(scoreReceiptItemQuery(englishEgg, 'egg') >= 90, 'egg should match Grade A Eggs');

  // 2. "eggs" plural must also match
  assert.ok(scoreReceiptItemQuery(eggItemChinese, 'eggs') >= 90, 'eggs should match 鸡蛋');
  assert.ok(scoreReceiptItemQuery(singleCharEgg, 'eggs') >= 90, 'eggs should match 买蛋');

  // 3. "我查egg" (user conversational inquiry) must cleanly match 鸡蛋
  assert.ok(scoreReceiptItemQuery(eggItemChinese, '我查egg') >= 90, '我查egg should match 鸡蛋');
  assert.ok(scoreReceiptItemQuery(eggItemWithBrand, '我查egg') >= 90, '我查egg should match 买鸡蛋');
  assert.ok(scoreReceiptItemQuery(eggItemChinese, '查egg') >= 90, '查egg should match 鸡蛋');
  assert.ok(scoreReceiptItemQuery(eggItemChinese, '找egg') >= 90, '找egg should match 鸡蛋');
  assert.ok(scoreReceiptItemQuery(eggItemChinese, 'how much is egg') >= 90, 'how much is egg should match 鸡蛋');

  // 4. Reverse: "鸡蛋" must match English "Grade A Eggs" and Malay "Telur Ayam"
  assert.ok(scoreReceiptItemQuery(englishEgg, '鸡蛋') >= 90, '鸡蛋 should match Grade A Eggs');
  assert.ok(scoreReceiptItemQuery(malayEgg, '鸡蛋') >= 90, '鸡蛋 should match Telur Ayam');

  // 5. Negative matching: "egg" must NOT match unrelated items
  const chickenRice = {
    name: 'Hainanese Chicken Rice',
    quantity: 1,
    unitPrice: 12.5,
    amount: 12.5,
    category: 'Food',
  };
  assert.equal(scoreReceiptItemQuery(chickenRice, 'egg'), 0, 'egg must NOT match chicken rice');
});
