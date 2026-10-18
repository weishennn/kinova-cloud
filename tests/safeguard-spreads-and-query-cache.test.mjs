import test from 'node:test';
import assert from 'node:assert/strict';
import { matchMerchantCategoryRule } from '../src/lib/merchant-rules.ts';

test('1. matchMerchantCategoryRule safely handles non-array rulesOverride and invalid inputs without spreading errors', () => {
  // If an object or non-array override is passed, it should not crash with spread error
  assert.equal(matchMerchantCategoryRule('completely unknown merchant xyz', null), null);
  assert.equal(matchMerchantCategoryRule('completely unknown merchant xyz', {}), null);
  assert.equal(matchMerchantCategoryRule('completely unknown merchant xyz', undefined), null);
  assert.equal(matchMerchantCategoryRule('completely unknown merchant xyz', 123), null);

  // If null is passed for a known merchant like shell, it falls back to DEFAULT_MERCHANT_RULES safely
  const shellRule = matchMerchantCategoryRule('shell petrol 82.36', null);
  assert.ok(shellRule);
  assert.equal(shellRule.category, 'Transport');

  // Valid custom array works as expected
  const rule = matchMerchantCategoryRule('Four Beans dessert 18', [
    {
      id: 'rule_1',
      merchantPattern: 'Four Beans',
      category: 'Food',
      subCategory: 'Dessert',
      createdAt: '2026-10-18T00:00:00Z',
      updatedAt: '2026-10-18T00:00:00Z',
    },
  ]);
  assert.ok(rule);
  assert.equal(rule.category, 'Food');
  assert.equal(rule.subCategory, 'Dessert');
});

test('2. Defensively normalize history query cache shapes (Object with rows vs direct array)', () => {
  // Simulates what ReceiptPriceSearch does with historyQuery.data
  function extractHistoryList(data) {
    if (Array.isArray(data)) {
      return data;
    }
    if (data && typeof data === 'object' && Array.isArray(data.rows)) {
      return data.rows;
    }
    return [];
  }

  // A: Standard array data
  assert.deepEqual(extractHistoryList([{ id: 'tx_1' }]), [{ id: 'tx_1' }]);

  // B: Clobbered object data from setQueriesData({ queryKey: ['sheet', 'Transactions'] })
  assert.deepEqual(extractHistoryList({ headers: ['Id'], rows: [{ id: 'tx_2' }] }), [{ id: 'tx_2' }]);

  // C: Error or null data
  assert.deepEqual(extractHistoryList(null), []);
  assert.deepEqual(extractHistoryList(undefined), []);
  assert.deepEqual(extractHistoryList({ error: 'Failed to fetch' }), []);

  // Ensure spread syntax over the extracted list is ALWAYS valid and never throws
  const transactions = [{ id: 'tx_current' }];
  for (const candidate of [null, undefined, {}, { error: '500' }, { rows: [{ id: 'tx_row' }] }, [{ id: 'tx_arr' }]]) {
    assert.doesNotThrow(() => {
      const historyList = extractHistoryList(candidate);
      const combined = [...transactions, ...historyList];
      assert.ok(Array.isArray(combined));
    });
  }
});
