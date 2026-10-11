import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveNotFoundUpdatePolicy,
  detectConcurrentFieldConflict,
  buildTransactionBaseRecord,
  buildConflictResolutionUpdate,
  persistConflictBeforeTombstone,
} from '../src/lib/conflict-policy.ts';

test('resolveNotFoundUpdatePolicy discards and tombstones absent records to prevent resurrection', () => {
  // A row deleted on server (not tombstoned locally yet, not explicit force restore)
  const result = resolveNotFoundUpdatePolicy('tx-123', false, false);
  assert.equal(result.action, 'discard_and_tombstone');
  assert.match(result.reason, /Record was deleted on the server/);
});

test('resolveNotFoundUpdatePolicy acknowledges already tombstoned records without re-adding', () => {
  const result = resolveNotFoundUpdatePolicy('tx-123', true, false);
  assert.equal(result.action, 'discard_and_tombstone');
  assert.match(result.reason, /already tombstoned/);
});

test('resolveNotFoundUpdatePolicy allows force_restore only when explicitly requested by user', () => {
  const result = resolveNotFoundUpdatePolicy('tx-123', false, true);
  assert.equal(result.action, 'force_restore');
  assert.match(result.reason, /explicitly requested/);
});

test('detectConcurrentFieldConflict detects when server was changed away from client base', () => {
  const base = { Id: 'tx-1', Amount: '50.00', Category: 'Food & Dining', Description: 'Lunch' };
  // Server was updated by Device A: Amount changed to 60.00
  const server = { Id: 'tx-1', Amount: '60.00', Category: 'Food & Dining', Description: 'Lunch' };
  // Client on Device B changed Amount to 70.00
  const clientUpdate = { Id: 'tx-1', Amount: '70.00' };

  const conflict = detectConcurrentFieldConflict(base, server, clientUpdate);
  assert.equal(conflict.hasConflict, true);
  assert.deepEqual(conflict.conflictingFields, ['Amount']);
});

test('detectConcurrentFieldConflict detects no conflict when fields are unchanged or client matches server', () => {
  const base = { Id: 'tx-1', Amount: '50.00', Category: 'Food & Dining' };
  const server = { Id: 'tx-1', Amount: '50.00', Category: 'Food & Dining' };
  const clientUpdate = { Id: 'tx-1', Amount: '60.00' };

  const conflict = detectConcurrentFieldConflict(base, server, clientUpdate);
  assert.equal(conflict.hasConflict, false);
  assert.deepEqual(conflict.conflictingFields, []);
});

test('detectConcurrentFieldConflict compares money numerically and ignores date formatting differences', () => {
  const base = { Date: '2026-10-11', Amount: '50.00', Description: 'Lunch' };
  const server = { Date: new Date('2026-10-11T00:00:00.000Z'), Amount: 50, Description: 'Lunch' };
  const client = { Date: '2026-10-11', Amount: 75, Description: 'Lunch' };

  const conflict = detectConcurrentFieldConflict(base, server, client);
  assert.equal(conflict.hasConflict, false);
  assert.deepEqual(conflict.conflictingFields, []);
});

test('detectConcurrentFieldConflict ignores client-only fields that are not stored in the sheet', () => {
  const base = { Id: 'tx-1', Amount: 50, BaseCurrency: 'MYR' };
  const server = { Id: 'tx-1', Amount: 50 };
  const client = { Id: 'tx-1', Amount: 60, BaseCurrency: 'MYR' };

  const conflict = detectConcurrentFieldConflict(base, server, client);
  assert.equal(conflict.hasConflict, false);
  assert.deepEqual(conflict.conflictingFields, []);
});

test('buildTransactionBaseRecord maps normalized transaction fields into sheet column names', () => {
  const base = buildTransactionBaseRecord({
    id: 'tx-1',
    date: '2026-10-11',
    type: 'income',
    category: 'Salary',
    subCategory: 'Monthly',
    description: 'October salary',
    amount: 1000,
    currency: 'MYR',
    baseAmount: 1000,
    baseCurrency: 'MYR',
    fxRateToBase: 1,
    tripTag: '',
    receiptUrl: '',
    notes: '',
  });

  assert.equal(base.Id, 'tx-1');
  assert.equal(base.Type, 'Income');
  assert.equal(base.Amount, 1000);
  assert.equal(base.Description, 'October salary');
});

test('keeping a concurrent client edit updates the server row and retains its latest base snapshot', () => {
  const result = buildConflictResolutionUpdate(
    { Id: 'tx-1', Date: '2026-02-03', Amount: 75, _baseData: { Amount: 50 } },
    { Id: 'tx-1', Date: '2026-01-31', Amount: 60, _month: '2026-01', _rowIndex: 9 },
    'tx-1'
  );

  assert.equal(result.sheetName, '2026-01');
  assert.equal(result.rowIndex, 9);
  assert.equal(result.rowData.Date, '2026-02-03');
  assert.equal(result.rowData.Amount, 75);
  assert.equal(result.rowData.Id, 'tx-1');
  assert.deepEqual(result.rowData._baseData, {
    Id: 'tx-1', Date: '2026-01-31', Amount: 60, _month: '2026-01', _rowIndex: 9,
  });
});

test('deleted server records remain explicit restores rather than ordinary updates', () => {
  assert.equal(
    buildConflictResolutionUpdate(
      { Id: 'tx-1', Amount: 75 },
      { status: 'deleted_on_server', sheetName: '2026-01' },
      'tx-1'
    ),
    null
  );
});

test('a deleted-row update is not tombstoned until its conflict is durably recorded', () => {
  const calls = [];
  const saved = persistConflictBeforeTombstone(
    () => { calls.push('persist'); return false; },
    () => calls.push('clear'),
    () => calls.push('tombstone')
  );

  assert.equal(saved, false);
  assert.deepEqual(calls, ['persist', 'clear', 'persist']);
});

test('a deleted-row conflict retries after cache cleanup, then tombstones only after persistence', () => {
  const calls = [];
  let attempts = 0;
  const saved = persistConflictBeforeTombstone(
    () => { calls.push('persist'); attempts += 1; return attempts === 2; },
    () => calls.push('clear'),
    () => calls.push('tombstone')
  );

  assert.equal(saved, true);
  assert.deepEqual(calls, ['persist', 'clear', 'persist', 'tombstone']);
});
