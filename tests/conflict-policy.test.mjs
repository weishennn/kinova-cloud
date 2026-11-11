import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveNotFoundUpdatePolicy,
  detectConcurrentFieldConflict,
  buildTransactionBaseRecord,
  buildConflictResolutionUpdate,
  persistConflictBeforeTombstone,
} from '../src/lib/conflict-policy.ts';
import { coalescePendingMutations } from '../src/lib/cache-manager.ts';
import { arePlanRecordsEquivalent } from '../src/lib/plan-equivalence.ts';

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

test('detectConcurrentFieldConflict normalizes Type and Currency casing cleanly without false conflict', () => {
  const base = { Id: 'tx-1', Type: 'expense', Currency: 'myr', BaseCurrency: 'myr', Amount: 12 };
  const server = { Id: 'tx-1', Type: 'Expense', Currency: 'MYR', BaseCurrency: 'MYR', Amount: 12 };
  const client = { Id: 'tx-1', Type: 'expense', Currency: 'MYR', Amount: 20 };

  const conflict = detectConcurrentFieldConflict(base, server, client);
  assert.equal(conflict.hasConflict, false);
  assert.deepEqual(conflict.conflictingFields, []);
});

test('coalescePendingMutations preserves earliest V0 _baseData across consecutive updates and strips _baseData on add+update', () => {
  const queue = [
    {
      id: 'm1',
      type: 'update',
      sheetName: '2026-10',
      rowId: 'tx-1',
      timestamp: 1000,
      retryCount: 0,
      rowData: {
        Id: 'tx-1',
        Amount: 60,
        _baseData: { Amount: 50, Description: 'Lunch' },
      },
    },
    {
      id: 'm2',
      type: 'update',
      sheetName: '2026-10',
      rowId: 'tx-1',
      timestamp: 2000,
      retryCount: 0,
      rowData: {
        Id: 'tx-1',
        Amount: 75,
        Category: 'Food & Dining',
        _baseData: { Amount: 60, Category: 'Other', Description: 'Lunch' },
      },
    },
    {
      id: 'm3',
      type: 'add',
      sheetName: '2026-10',
      rowId: 'tx-new',
      timestamp: 1000,
      retryCount: 0,
      rowData: { Id: 'tx-new', Amount: 10 },
    },
    {
      id: 'm4',
      type: 'update',
      sheetName: '2026-10',
      rowId: 'tx-new',
      timestamp: 2000,
      retryCount: 0,
      rowData: { Id: 'tx-new', Amount: 15, _baseData: { Amount: 10 } },
    },
  ];

  const coalesced = coalescePendingMutations(queue);
  assert.equal(coalesced.length, 2);

  const updated = coalesced.find((m) => m.rowId === 'tx-1');
  assert.ok(updated);
  assert.equal(updated.rowData.Amount, 75);
  assert.equal(updated.rowData.Category, 'Food & Dining');
  // Must retain V0 Amount (50) for Amount AND keep Category base (Other) from m2
  assert.deepEqual(updated.rowData._baseData, {
    Amount: 50,
    Category: 'Other',
    Description: 'Lunch',
  });

  const added = coalesced.find((m) => m.rowId === 'tx-new');
  assert.ok(added);
  assert.equal(added.type, 'add');
  assert.equal(added.rowData.Amount, 15);
  assert.equal('_baseData' in added.rowData, false);
});

test('arePlanRecordsEquivalent ignores key order, undefined properties, and optionally lastAutoRecordedMonth', () => {
  const localPlan = {
    name: 'Netflix',
    id: 'plan-1',
    amount: 55,
    lastAutoRecordedMonth: '2026-10',
    notes: undefined,
  };
  const sheetPlan = {
    id: 'plan-1',
    amount: 55,
    name: 'Netflix',
    lastAutoRecordedMonth: '2026-11',
  };

  assert.equal(arePlanRecordsEquivalent(localPlan, sheetPlan, { ignoreVolatile: true }), true);
  assert.equal(arePlanRecordsEquivalent(localPlan, sheetPlan, { ignoreVolatile: false }), false);
  assert.equal(
    arePlanRecordsEquivalent(
      { id: 'p2', name: 'Gym', amount: 100, notes: undefined },
      { amount: 100, name: 'Gym', id: 'p2' },
      { ignoreVolatile: false }
    ),
    true
  );
});
