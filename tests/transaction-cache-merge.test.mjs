import test from 'node:test';
import assert from 'node:assert/strict';

import { applyPendingTransactionUpdate } from '../src/lib/transaction-cache-merge.ts';

const oldRow = {
  Id: 'tx-move-1',
  Date: '2026-09-30',
  Amount: 42.5,
  Description: 'QA move',
  _month: '2026-09',
};

const movedRowData = {
  ...oldRow,
  Date: '2026-10-01',
  Amount: 43.25,
  _month: '2026-09', // retained source metadata must not override the edited date
};

test('offline cross-month edit leaves the source month and appears once in the destination month', () => {
  const oldMonth = applyPendingTransactionUpdate(
    [oldRow], '2026-09', '2026-09', 'tx-move-1', movedRowData, true,
  );
  const newMonth = applyPendingTransactionUpdate(
    [], '2026-10', '2026-09', 'tx-move-1', movedRowData, true,
  );

  assert.equal(oldMonth.some((row) => row.Id === 'tx-move-1'), false);
  assert.equal(newMonth.length, 1);
  assert.equal(newMonth[0].Date, '2026-10-01');
  assert.equal(newMonth[0].Amount, 43.25);
  assert.equal(newMonth[0]._month, '2026-10');
  assert.equal(newMonth[0]._pendingSync, true);
});

test('same-month pending edit updates the existing row without duplicating it', () => {
  const updated = applyPendingTransactionUpdate(
    [oldRow],
    '2026-09',
    '2026-09',
    'tx-move-1',
    { ...oldRow, Amount: 50 },
    true,
  );

  assert.equal(updated.length, 1);
  assert.equal(updated[0].Amount, 50);
  assert.equal(updated[0]._pendingSync, true);
});

test('cross-year move is removed from the source year and shown in the destination year', () => {
  const row = { ...oldRow, Date: '2026-12-31', _month: '2026-12' };
  const moved = { ...row, Date: '2027-01-01', _month: '2026-12' };

  const sourceYear = applyPendingTransactionUpdate(
    [row], 'year-2026', '2026-12', 'tx-move-1', moved, true,
  );
  const destinationYear = applyPendingTransactionUpdate(
    [], 'year-2027', '2026-12', 'tx-move-1', moved, true,
  );

  assert.equal(sourceYear.length, 0);
  assert.equal(destinationYear.length, 1);
  assert.equal(destinationYear[0]._month, '2027-01');
  assert.equal(destinationYear[0]._pendingSync, true);
});
