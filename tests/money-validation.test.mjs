import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isSafeTransactionAmount,
  isSafeTransactionConversion,
} from '../src/lib/money-validation.ts';

test('transaction amounts must be positive, cent-precise, and safely representable', () => {
  assert.equal(isSafeTransactionAmount(0), false);
  assert.equal(isSafeTransactionAmount(-0.01), false);
  assert.equal(isSafeTransactionAmount(Number.POSITIVE_INFINITY), false);
  assert.equal(isSafeTransactionAmount(1e308), false);
  assert.equal(isSafeTransactionAmount(1e14), false);
  assert.equal(isSafeTransactionAmount(1e-100), false);
  assert.equal(isSafeTransactionAmount(0.0049), false);
  assert.equal(isSafeTransactionAmount(0.005), false);
  assert.equal(isSafeTransactionAmount(12.345), false);
  assert.equal(isSafeTransactionAmount(12.34), true);
  assert.equal(isSafeTransactionAmount(0.29), true);
});

test('a small foreign-currency amount is valid while non-finite FX conversions are rejected', () => {
  assert.equal(isSafeTransactionConversion(0.01, 0.0000027, 0.00027), true);
  assert.equal(isSafeTransactionConversion(12.34, Number.POSITIVE_INFINITY, Infinity), false);
  assert.equal(isSafeTransactionConversion(12.34, 50.594, 4.1), true);
});
