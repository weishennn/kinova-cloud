import test from 'node:test';
import assert from 'node:assert/strict';

import { getReceiptReasoningReasons } from '../src/lib/receipt-reasoning.ts';

const clearReceipt = {
  merchant: 'Kopitiam Sample',
  description: 'Kopitiam Sample',
  amount: 15.37,
  subtotal: 14.5,
  taxAmount: 0.87,
  taxRate: 6,
  taxIncluded: false,
  taxLabel: 'SST',
  items: [
    { name: 'Nasi Lemak', quantity: 1, unitPrice: 12, amount: 12 },
    { name: 'Teh O', quantity: 1, unitPrice: 2.5, amount: 2.5 },
  ],
};

test('clear receipt with separate, reconciling SST stays on the fast OCR path', () => {
  assert.deepEqual(getReceiptReasoningReasons(clearReceipt), []);
});

test('clear tax-inclusive receipt stays on the fast OCR path', () => {
  assert.deepEqual(getReceiptReasoningReasons({
    ...clearReceipt,
    amount: 15.37,
    subtotal: 15.37,
    taxIncluded: true,
    items: [{ name: 'Meal', quantity: 1, unitPrice: 15.37, amount: 15.37 }],
  }), []);
});

test('quantity and extended line amount disagreement requests a careful second read', () => {
  const reasons = getReceiptReasoningReasons({
    ...clearReceipt,
    amount: 6,
    subtotal: 6,
    taxAmount: null,
    taxRate: null,
    taxLabel: '',
    items: [{ name: 'Roti Canai', quantity: 2, unitPrice: 3, amount: 3 }],
  });
  assert.ok(reasons.includes('quantity_line_total_mismatch'));
  assert.ok(reasons.includes('items_total_mismatch'));
});

test('fractional weighed or measured quantities remain valid and larger item mismatches are caught', () => {
  assert.deepEqual(getReceiptReasoningReasons({
    merchant: 'Fresh Market',
    description: 'Fresh Market',
    amount: 1.25,
    subtotal: 1.25,
    taxAmount: null,
    taxRate: null,
    taxIncluded: false,
    taxLabel: '',
    items: [{ name: 'Fruit', quantity: 0.5, unitPrice: 2.5, amount: 1.25 }],
  }), []);

  const reasons = getReceiptReasoningReasons({
    merchant: 'Shop',
    description: 'Shop',
    amount: 100,
    subtotal: 100,
    taxAmount: null,
    taxRate: null,
    taxIncluded: false,
    taxLabel: '',
    items: [{ name: 'Item', quantity: 1, unitPrice: 100, amount: 98 }],
  });
  assert.ok(reasons.includes('items_total_mismatch'));
});

test('conflicting subtotal, tax, and paid total requests a careful second read', () => {
  const reasons = getReceiptReasoningReasons({
    ...clearReceipt,
    amount: 10.9,
    subtotal: 10,
    taxAmount: 0.6,
    taxRate: 6,
    items: [{ name: 'Lunch', quantity: 1, unitPrice: 10, amount: 10 }],
  });
  assert.ok(reasons.includes('tax_math_unclear'));
});

test('unexplained subtotal-to-total difference requests a tax or charge review', () => {
  const reasons = getReceiptReasoningReasons({
    ...clearReceipt,
    amount: 15.37,
    subtotal: 14.5,
    taxAmount: null,
    taxRate: null,
    taxLabel: '',
    items: [{ name: 'Meal', quantity: 1, unitPrice: 14.5, amount: 14.5 }],
  });
  assert.ok(reasons.includes('tax_math_unclear'));
});

test('generic merchant and explicit visual uncertainty request a careful second read', () => {
  const reasons = getReceiptReasoningReasons({
    ...clearReceipt,
    merchant: 'Payment successful',
    needsReasoning: true,
    ambiguities: ['merchant hard to read'],
    notes: 'The merchant name is blurry.',
  });
  assert.ok(reasons.includes('merchant_unclear'));
  assert.ok(reasons.includes('model_flagged_uncertainty'));
  assert.ok(reasons.includes('ocr_text_uncertain'));
});

test('question-mark placeholders on merchant, item, or tax fields request a careful second read', () => {
  const reasons = getReceiptReasoningReasons({
    ...clearReceipt,
    merchant: 'K?pi Sample',
    taxLabel: 'SST ?%',
    items: [{ name: 'N?si Lemak', quantity: 1, unitPrice: 12, amount: 12 }],
  });
  assert.ok(reasons.includes('merchant_unclear'));
  assert.ok(reasons.includes('item_name_unclear'));
  assert.ok(reasons.includes('tax_math_unclear'));
});

test('discounted total that reconciles to the printed gross remains fast', () => {
  assert.deepEqual(getReceiptReasoningReasons({
    merchant: 'Dessert Shop',
    description: 'Dessert Shop',
    amount: 18.74,
    subtotal: 22.05,
    discountAmount: 3.31,
    taxAmount: null,
    taxRate: null,
    taxIncluded: false,
    taxLabel: '',
    items: [{ name: 'Dessert Set', quantity: 1, unitPrice: 22.05, amount: 22.05 }],
  }), []);
});
