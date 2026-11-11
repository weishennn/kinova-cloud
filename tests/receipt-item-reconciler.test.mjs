import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractQuantityFromItemName,
  isDiscreteMultiQtyItem,
  computeCandidateExpectedSubtotals,
  reconcileKinovaReceiptItems,
} from '../src/lib/receipt-item-reconciler.ts';

test('1. Multiplies unmultiplied 3-plate sushi unit price against explicit subtotal', () => {
  const reconciled = reconcileKinovaReceiptItems(
    [
      { name: 'Salmon Sushi', quantity: 3, unitPrice: 6.0, amount: 6.0 },
      { name: 'Green Tea', quantity: 1, unitPrice: 2.0, amount: 2.0 },
    ],
    { subtotal: 20.0, amount: 20.0 }
  );

  assert.equal(reconciled[0].quantity, 3);
  assert.equal(reconciled[0].unitPrice, 6.0);
  assert.equal(reconciled[0].amount, 18.0);
  assert.equal(reconciled[0].qtyReconciled, 'multiplied_unit_price');
  assert.equal(reconciled[1].amount, 2.0);
});

test('2. Handles missing subtotal using tax-exclusive total even when taxIncluded flag was mistakenly set', () => {
  const reconciled = reconcileKinovaReceiptItems(
    [{ name: 'Salmon Sushi', quantity: 3, unitPrice: 6.0, amount: 6.0 }],
    {
      subtotal: null,
      amount: 20.88,
      taxAmount: 2.88,
      taxRate: 16,
      taxIncluded: true,
    }
  );

  assert.equal(reconciled[0].amount, 18.0);
  assert.equal(reconciled[0].unitPrice, 6.0);
  assert.equal(reconciled[0].qtyReconciled, 'multiplied_unit_price');
});

test('3. Handles missing subtotal on discounted receipt via pre-discount gross total', () => {
  const reconciled = reconcileKinovaReceiptItems(
    [{ name: 'Salmon Sushi', quantity: 3, unitPrice: 6.0, amount: 6.0 }],
    {
      subtotal: null,
      amount: 15.0,
      discountAmount: 3.0,
    }
  );

  assert.equal(reconciled[0].amount, 18.0);
  assert.equal(reconciled[0].unitPrice, 6.0);
});

test('4. Fallback multiplies unmultiplied unitPrice===amount when receipt totals are missing', () => {
  const reconciled = reconcileKinovaReceiptItems(
    [{ name: 'Salmon Sushi', quantity: 3, unitPrice: 6.0, amount: 6.0 }],
    null
  );

  assert.equal(reconciled[0].amount, 18.0);
  assert.equal(reconciled[0].unitPrice, 6.0);
  assert.equal(reconciled[0].qtyReconciled, 'multiplied_unit_price');
});

test('5. Divides accidentally double-multiplied item total back to true extended amount', () => {
  const reconciled = reconcileKinovaReceiptItems(
    [{ name: 'Salmon Sushi', quantity: 3, unitPrice: 6.0, amount: 54.0 }],
    { subtotal: 18.0, amount: 18.0 }
  );

  assert.equal(reconciled[0].amount, 18.0);
  assert.equal(reconciled[0].unitPrice, 6.0);
  assert.equal(reconciled[0].qtyReconciled, 'divided_overmultiplied_total');
});

test('6. Normalizes unitPrice when OCR copied extended line total into unitPrice', () => {
  const reconciled = reconcileKinovaReceiptItems(
    [{ name: 'Salmon Sushi', quantity: 3, unitPrice: 18.0, amount: 18.0 }],
    { subtotal: 18.0, amount: 18.0 }
  );

  assert.equal(reconciled[0].amount, 18.0);
  assert.equal(reconciled[0].unitPrice, 6.0);
});

test('7. Extracts quantity multipliers embedded in prefix, suffix, and parenthetical item names', () => {
  assert.deepEqual(extractQuantityFromItemName('3x Salmon Sushi'), { cleanName: 'Salmon Sushi', parsedQty: 3 });
  assert.deepEqual(extractQuantityFromItemName('Salmon Sushi x3'), { cleanName: 'Salmon Sushi', parsedQty: 3 });
  assert.deepEqual(extractQuantityFromItemName('Salmon Sushi (×3)'), { cleanName: 'Salmon Sushi', parsedQty: 3 });
  assert.deepEqual(extractQuantityFromItemName('RON 95'), { cleanName: 'RON 95', parsedQty: null });

  const reconciled = reconcileKinovaReceiptItems(
    [{ name: 'Salmon Sushi x3', quantity: 1, unitPrice: 6.0, amount: 6.0 }],
    { subtotal: 18.0 }
  );
  assert.equal(reconciled[0].name, 'Salmon Sushi');
  assert.equal(reconciled[0].quantity, 3);
  assert.equal(reconciled[0].unitPrice, 6.0);
  assert.equal(reconciled[0].amount, 18.0);
});

test('8. Never multiplies continuous fuel/weight/volume items', () => {
  assert.equal(isDiscreteMultiQtyItem({ name: 'RON 95 Fuel', quantity: 3, unitPrice: 2.05 }), false);
  assert.equal(isDiscreteMultiQtyItem({ name: 'Bananas 2 kg', quantity: 2, unitPrice: 5.0 }), false);

  const reconciled = reconcileKinovaReceiptItems(
    [{ name: 'Petronas Primax 95 (20.00 Litres)', quantity: 20, unitPrice: 2.05, amount: 41.0 }],
    { subtotal: 41.0, amount: 41.0 }
  );
  assert.equal(reconciled[0].amount, 41.0);
});

test('9. computeCandidateExpectedSubtotals produces prioritized candidate list', () => {
  const candidates = computeCandidateExpectedSubtotals({
    subtotal: 20.0,
    amount: 23.2,
    taxAmount: 3.2,
    taxRate: 16,
    taxIncluded: false,
  });
  assert.equal(candidates[0], 20.0);
});
