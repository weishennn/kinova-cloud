import test from 'node:test';
import assert from 'node:assert/strict';

import {
  scoreReceiptItemQuery,
  extractCleanItemKeyword,
  getItemSearchTarget,
} from '../src/lib/receipt-items.ts';

test('1. Multi-lingual Malaysian food and brand synonyms match correctly', () => {
  // Test 1: 四夕豆花 / Four Beans / 豆花
  const tauFooFahItem = {
    name: '四夕豆花 / 甜品',
    quantity: 1,
    unitPrice: 18.74,
    amount: 18.74,
    category: 'Food & Dining',
  };

  assert.ok(scoreReceiptItemQuery(tauFooFahItem, '四夕豆花') >= 70, 'Matches exact shop name');
  assert.ok(scoreReceiptItemQuery(tauFooFahItem, '豆花') >= 70, 'Matches dish name');
  assert.ok(scoreReceiptItemQuery(tauFooFahItem, 'four beans') >= 70, 'Matches English merchant name');
  assert.ok(scoreReceiptItemQuery(tauFooFahItem, 'tau foo fah') >= 70, 'Matches Cantonese romanization');

  // Test 2: FuelSave 95 / Shell / RON95 / Budi Madani
  const petrolItem = {
    name: 'FuelSave 95',
    quantity: 43.81,
    unitPrice: 1.88,
    amount: 82.36,
    category: 'Transport',
    brand: 'Shell',
  };

  assert.ok(scoreReceiptItemQuery(petrolItem, 'fuelsave') >= 70);
  assert.ok(scoreReceiptItemQuery(petrolItem, 'fuelsave 95') >= 70);
  assert.ok(scoreReceiptItemQuery(petrolItem, 'ron95') >= 70);
  assert.ok(scoreReceiptItemQuery(petrolItem, 'petrol') >= 70);
  assert.ok(scoreReceiptItemQuery(petrolItem, 'shell') >= 70);
  assert.ok(scoreReceiptItemQuery(petrolItem, '汽油') >= 70);
});

test('2. extractCleanItemKeyword handles conversational Malaysian prefixes and suffixes', () => {
  assert.equal(extractCleanItemKeyword('我在四夕豆花买过多少钱？'), '四夕豆花');
  assert.equal(extractCleanItemKeyword('查查fuelsave 95价格'), 'fuelsave 95');
  assert.equal(extractCleanItemKeyword('请问这里鸡蛋多少钱？'), '鸡蛋');
  assert.equal(extractCleanItemKeyword('how much did i pay for chicken rice?'), 'chicken rice');
  assert.equal(extractCleanItemKeyword('where was petrol cheapest last time?'), 'petrol');
});

test('3. Store Price Ladder correctly sorts stores from lowest unit price to highest', () => {
  const matchingPurchases = [
    {
      store: 'Petronas Bandar Utama',
      unitPrice: 2.05,
      date: '2026-09-15',
    },
    {
      store: 'Shell Petaling Jaya',
      unitPrice: 1.88,
      date: '2026-10-18',
    },
    {
      store: 'BHPetrol Subang',
      unitPrice: 2.05,
      date: '2026-08-10',
    },
  ];

  // Group by store and find minimum unit price
  const storeMap = new Map();
  for (const p of matchingPurchases) {
    const existing = storeMap.get(p.store);
    if (!existing) {
      storeMap.set(p.store, { store: p.store, minUnitPrice: p.unitPrice, latestDate: p.date });
    } else {
      if (p.unitPrice < existing.minUnitPrice) existing.minUnitPrice = p.unitPrice;
      if (p.date > existing.latestDate) existing.latestDate = p.date;
    }
  }

  const ladder = Array.from(storeMap.values()).sort((a, b) => a.minUnitPrice - b.minUnitPrice);

  assert.equal(ladder.length, 3);
  assert.equal(ladder[0].store, 'Shell Petaling Jaya', 'Cheapest store must be rank 1');
  assert.equal(ladder[0].minUnitPrice, 1.88);
  assert.ok(ladder[1].minUnitPrice >= ladder[0].minUnitPrice);
});

test('4. computeDeterministicLedgerFacts correctly extracts merchant spending and does not default to Food & Dining', async () => {
  const { computeDeterministicLedgerFacts } = await import('../src/lib/copilot-ledger-facts.ts');

  const mockLedger = [
    { id: '1', date: '2026-11-02', amount: 35.0, type: 'Expense', category: 'Food & Dining', description: 'Pegacorn Cafe', notes: 'Dinner' },
    { id: '2', date: '2026-11-05', amount: 80.0, type: 'Expense', category: 'Transport', description: 'Shell Petrol', notes: 'Fuel' },
    { id: '3', date: '2026-11-08', amount: 159.0, type: 'Expense', category: 'Shopping', description: 'Xiaomi 吹风筒', notes: '[商家: Show See Malaysia]' },
    { id: '4', date: '2026-10-15', amount: 45.0, type: 'Expense', category: 'Food & Dining', description: 'Pegacorn Cafe', notes: 'Brunch' },
  ];

  // 1. "我再pegacorn 花了多少钱" -> should match Pegacorn (all time = RM 80)
  const facts1 = computeDeterministicLedgerFacts('我再pegacorn 花了多少钱', mockLedger, '2026-11-15');
  assert.equal(facts1.queryType, 'merchant_lookup');
  assert.equal(facts1.itemOrMerchantName, 'pegacorn');
  assert.equal(facts1.isFoundInPersonalLedger, true);
  assert.equal(facts1.exactTotalSpent, 80);
  assert.equal(facts1.transactionCount, 2);

  // 2. "我在pegacorn花了多少钱" -> should match Pegacorn
  const facts2 = computeDeterministicLedgerFacts('我在pegacorn花了多少钱', mockLedger, '2026-11-15');
  assert.equal(facts2.itemOrMerchantName, 'pegacorn');
  assert.equal(facts2.exactTotalSpent, 80);

  // 3. "这个月在pegacorn花了多少" -> only November (RM 35)
  const facts3 = computeDeterministicLedgerFacts('这个月在pegacorn花了多少', mockLedger, '2026-11-15');
  assert.equal(facts3.exactTotalSpent, 35);
  assert.equal(facts3.transactionCount, 1);

  // 4. "show see malaysia 花了多少" -> matches note [商家: Show See Malaysia]
  const facts4 = computeDeterministicLedgerFacts('show see malaysia 花了多少', mockLedger, '2026-11-15');
  assert.equal(facts4.itemOrMerchantName, 'show see malaysia');
  assert.equal(facts4.exactTotalSpent, 159);
  assert.equal(facts4.transactionCount, 1);

  // 5. Merchant not in ledger -> returns 0, isFoundInPersonalLedger = false (NEVER whole month Food & Dining)
  const facts5 = computeDeterministicLedgerFacts('我在星巴克花了多少钱', mockLedger, '2026-11-15');
  assert.equal(facts5.itemOrMerchantName, '星巴克');
  assert.equal(facts5.isFoundInPersonalLedger, false);
  assert.equal(facts5.exactTotalSpent, 0);
  assert.equal(facts5.transactionCount, 0);
});
