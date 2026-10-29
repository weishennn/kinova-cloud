import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CANONICAL_EXPENSE_CATEGORIES,
  CANONICAL_INCOME_CATEGORIES,
  CANONICAL_INVESTMENT_CATEGORIES,
  normalizeToCanonicalCategory,
  isLegacyFoodOrGrocery,
} from '../src/lib/canonical-categories.ts';

test('1. Canonical categories include Sport and Gift', () => {
  assert.ok(CANONICAL_EXPENSE_CATEGORIES.includes('Sport'), 'Sport must be in expense categories');
  assert.ok(CANONICAL_EXPENSE_CATEGORIES.includes('Gift'), 'Gift must be in expense categories');
  assert.ok(CANONICAL_INCOME_CATEGORIES.includes('Gift & Bonus'));
  assert.ok(CANONICAL_INVESTMENT_CATEGORIES.includes('Emergency Savings'));
});

test('2. normalizeToCanonicalCategory maps Gemini hallucinations to valid categories', () => {
  // Common Gemini / OCR hallucinations for expenses:
  assert.equal(normalizeToCanonicalCategory('Groceries', 'Expense'), 'Food & Dining');
  assert.equal(normalizeToCanonicalCategory('groceries', 'Expense'), 'Food & Dining');
  assert.equal(normalizeToCanonicalCategory('Food', 'Expense'), 'Food & Dining');
  assert.equal(normalizeToCanonicalCategory('food', 'Expense'), 'Food & Dining');
  assert.equal(normalizeToCanonicalCategory('Dining', 'Expense'), 'Food & Dining');
  assert.equal(normalizeToCanonicalCategory('Dining Out', 'Expense'), 'Food & Dining');
  assert.equal(normalizeToCanonicalCategory('Supermarket', 'Expense'), 'Food & Dining');
  assert.equal(normalizeToCanonicalCategory('Coffee', 'Expense'), 'Food & Dining');
  assert.equal(normalizeToCanonicalCategory('Fuel', 'Expense'), 'Transport');
  assert.equal(normalizeToCanonicalCategory('Gas', 'Expense'), 'Transport');
  assert.equal(normalizeToCanonicalCategory('Utilities', 'Expense'), 'Housing & Bills');
  assert.equal(normalizeToCanonicalCategory('Electricity', 'Expense'), 'Housing & Bills');
  assert.equal(normalizeToCanonicalCategory('Badminton', 'Expense'), 'Sport');
  assert.equal(normalizeToCanonicalCategory('Gym', 'Expense'), 'Sport');
  assert.equal(normalizeToCanonicalCategory('Fitness', 'Expense'), 'Sport');
  assert.equal(normalizeToCanonicalCategory('Presents', 'Expense'), 'Gift');
  assert.equal(normalizeToCanonicalCategory('Birthday Gift', 'Expense'), 'Gift');
  assert.equal(normalizeToCanonicalCategory('Technology', 'Expense'), 'Shopping');
  assert.equal(normalizeToCanonicalCategory('Doctor', 'Expense'), 'Health');
  assert.equal(normalizeToCanonicalCategory('Movies', 'Expense'), 'Entertainment');

  // Completely unknown category falls back to 'Other'
  assert.equal(normalizeToCanonicalCategory('Quantum Computing Hardware', 'Expense'), 'Other');
});

test('3. Context-aware category fallback when category is missing or invalid', () => {
  // If Gemini outputs empty category, infer from context text:
  assert.equal(normalizeToCanonicalCategory('', 'Expense', 'Yonex Badminton Racket'), 'Sport');
  assert.equal(normalizeToCanonicalCategory('', 'Expense', 'Birthday present for friend'), 'Gift');
  assert.equal(normalizeToCanonicalCategory('', 'Expense', 'Shell V-Power fuel'), 'Transport');
  assert.equal(normalizeToCanonicalCategory('', 'Expense', 'Chicken rice lunch'), 'Food & Dining');
  assert.equal(normalizeToCanonicalCategory('', 'Expense', 'Jaya Grocer weekly groceries'), 'Food & Dining');
  assert.equal(normalizeToCanonicalCategory('', 'Expense', 'Village Grocer vegetables'), 'Food & Dining');
});

test('4. Income categories normalization', () => {
  assert.equal(normalizeToCanonicalCategory('Payroll', 'Income'), 'Salary');
  assert.equal(normalizeToCanonicalCategory('Dividend', 'Income'), 'Investment Return');
  assert.equal(normalizeToCanonicalCategory('Bonus', 'Income'), 'Gift & Bonus');
  assert.equal(normalizeToCanonicalCategory('Side Gig', 'Income'), 'Freelance');
  assert.equal(normalizeToCanonicalCategory('Unknown Source', 'Income'), 'Other');
});

test('5. isLegacyFoodOrGrocery strictly detects all grocery and food variations', () => {
  assert.equal(isLegacyFoodOrGrocery('groceries'), true);
  assert.equal(isLegacyFoodOrGrocery('Groceries'), true);
  assert.equal(isLegacyFoodOrGrocery('food'), true);
  assert.equal(isLegacyFoodOrGrocery('Food'), true);
  assert.equal(isLegacyFoodOrGrocery('Dining'), true);
  assert.equal(isLegacyFoodOrGrocery('Food and Dining'), true);
  assert.equal(isLegacyFoodOrGrocery('groceries / food'), true);
  assert.equal(isLegacyFoodOrGrocery('Groceries & Food'), true);
  assert.equal(isLegacyFoodOrGrocery('Supermarket'), true);
  assert.equal(isLegacyFoodOrGrocery('买菜'), true);
  assert.equal(isLegacyFoodOrGrocery('食品'), true);
  assert.equal(isLegacyFoodOrGrocery('餐饮'), true);

  // Already canonical Food & Dining should return false (no conversion needed)
  assert.equal(isLegacyFoodOrGrocery('Food & Dining'), false);

  // Other categories should return false
  assert.equal(isLegacyFoodOrGrocery('Transport'), false);
  assert.equal(isLegacyFoodOrGrocery('Shopping'), false);
  assert.equal(isLegacyFoodOrGrocery('Housing & Bills'), false);
});

