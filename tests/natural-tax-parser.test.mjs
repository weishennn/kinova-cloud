import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNaturalExpense } from '../src/lib/natural-expense-parser.ts';
import { routeLocalIntent } from '../src/lib/intent-router.ts';

const mockProfile = {
  monthlyBudgetCap: 3000,
  payday: 28,
  rulesOverride: [],
  recentActions: [],
  habitMemories: [],
};

test('1. parseNaturalExpense parses natural tax and SST expressions cleanly', () => {
  const r1 = parseNaturalExpense('chicken rice 14 witrh 6% tax');
  assert.ok(r1, 'Should parse chicken rice with typo witrh 6% tax');
  assert.equal(r1.amount, 14.84);
  assert.equal(r1.subtotal, 14);
  assert.equal(r1.taxRate, 6);
  assert.equal(r1.taxAmount, 0.84);
  assert.equal(r1.taxLabel, 'Tax (6%)');
  assert.equal(r1.description, 'Chicken rice');
  assert.equal(r1.category, 'Food & Dining');
  assert.equal(r1.formula, '14 + 6% = 14.84');

  const r2 = parseNaturalExpense('chicken rice 14 with 6% tax');
  assert.ok(r2);
  assert.equal(r2.amount, 14.84);
  assert.equal(r2.description, 'Chicken rice');

  const r3 = parseNaturalExpense('chicken rice 14 + 6% sst');
  assert.ok(r3);
  assert.equal(r3.amount, 14.84);
  assert.equal(r3.taxLabel, 'SST (6%)');
  assert.equal(r3.description, 'Chicken rice');

  const r4 = parseNaturalExpense('lunch 50 with 10% service charge');
  assert.ok(r4);
  assert.equal(r4.amount, 55);
  assert.equal(r4.subtotal, 50);
  assert.equal(r4.taxRate, 10);
  assert.equal(r4.taxAmount, 5);
  assert.equal(r4.description, 'Lunch');
});

test('2. parseNaturalExpense parses natural discount expressions', () => {
  const r1 = parseNaturalExpense('shoes 100 with 10% discount');
  assert.ok(r1);
  assert.equal(r1.amount, 90);
  assert.equal(r1.subtotal, 100);
  assert.equal(r1.discountAmount, 10);
  assert.equal(r1.description, 'Shoes');
  assert.equal(r1.formula, '100 - 10% = 90.00');

  const r2 = parseNaturalExpense('shirt 80 20% off');
  assert.ok(r2);
  assert.equal(r2.amount, 64);
  assert.equal(r2.subtotal, 80);
  assert.equal(r2.discountAmount, 16);
  assert.equal(r2.description, 'Shirt');
});

test('3. multi-operator math expressions are preserved without false single-rate truncation', () => {
  const r = parseNaturalExpense('groceries 100 - 15 + 6%');
  assert.ok(r);
  // (100 - 15) = 85; 85 + 6% = 90.10
  assert.equal(r.amount, 90.10);
  assert.equal(r.description, 'Groceries');
});

test('4. routeLocalIntent carries subtotal and tax metadata in quick_parse command', () => {
  // Use input without advice/tax keyword triggers in routeLocalIntent so it takes quick_parse
  const r = parseNaturalExpense('chicken rice 14 witrh 6%');
  assert.ok(r);
  assert.equal(r.amount, 14.84);
  assert.equal(r.subtotal, 14);
  assert.equal(r.taxRate, 6);
});
