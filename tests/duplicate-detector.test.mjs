import test from 'node:test';
import assert from 'node:assert/strict';
import { findSuspectedDuplicates } from '../src/lib/duplicate-detector.ts';

test('duplicate-detector: detects exact same day and same amount', () => {
  const existing = [
    { id: 'tx_1', date: '2026-10-16', amount: 5.65, currency: 'MYR', description: 'NSK Grocer' },
  ];
  const candidate = {
    date: '2026-10-16',
    amount: 5.65,
    currency: 'MYR',
    description: 'NSK Grocer Groceries',
  };

  const results = findSuspectedDuplicates(candidate, existing);
  assert.equal(results.length, 1);
  assert.equal(results[0].reason, 'same_day_same_amount');
});

test('duplicate-detector: detects receipt duplicate via matching invoice number even with different dates', () => {
  const existing = [
    {
      id: 'tx_row33',
      date: '2026-10-05',
      amount: 18.44,
      currency: 'MYR',
      description: 'Sin Hing Long Sabah Pork Noodle',
      notes: 'Invoice no: SHL029662 [Tax: MYR 1.04]',
    },
  ];
  const candidate = {
    date: '2026-10-16', // defaulted to today during ocr
    amount: 18.44,
    currency: 'MYR',
    description: 'Sabah Pork Noodle',
    notes: 'Invoice no: SHL029662 [Tax: MYR 1.04]',
  };

  const results = findSuspectedDuplicates(candidate, existing);
  assert.equal(results.length, 1);
  assert.equal(results[0].reason, 'same_invoice_no');
  assert.match(results[0].explanation, /SHL029662/);
});

test('duplicate-detector: detects receipt duplicate via matching line items within 14 days', () => {
  const existing = [
    {
      id: 'tx_row33',
      date: '2026-10-05',
      amount: 18.44,
      currency: 'MYR',
      description: 'Sin Hing Long Sabah Pork Noodle',
      receiptItems: [
        { name: 'Sabah Pork Noodle (Dry) Hakka Mee' },
      ],
    },
  ];
  const candidate = {
    date: '2026-10-16',
    amount: 18.44,
    currency: 'MYR',
    description: 'Sabah Pork Noodle',
    items: [
      { name: 'Sabah Pork Noodle (Dry) Hakka Mee' },
    ],
  };

  const results = findSuspectedDuplicates(candidate, existing);
  assert.equal(results.length, 1);
  assert.equal(results[0].reason, 'same_items');
});

test('duplicate-detector: does NOT flag normal recurring meals on separate dates', () => {
  const existing = [
    { id: 'tx_1', date: '2026-10-01', amount: 8.0, currency: 'MYR', description: 'Lunch zapfan' },
  ];
  const candidate = {
    date: '2026-10-08', // 7 days later
    amount: 8.0,
    currency: 'MYR',
    description: 'Lunch zapfan',
  };

  const results = findSuspectedDuplicates(candidate, existing);
  assert.equal(results.length, 0);
});

test('duplicate-detector: ignores self when editing an existing transaction', () => {
  const existing = [
    { id: 'tx_edit_me', date: '2026-10-16', amount: 20.0, currency: 'MYR', description: 'Petrol' },
  ];
  const candidate = {
    date: '2026-10-16',
    amount: 20.0,
    currency: 'MYR',
    description: 'Petrol Shell',
    ignoreId: 'tx_edit_me',
  };

  const results = findSuspectedDuplicates(candidate, existing);
  assert.equal(results.length, 0);
});
