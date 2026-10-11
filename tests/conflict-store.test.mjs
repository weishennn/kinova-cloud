import test from 'node:test';
import assert from 'node:assert/strict';

const storage = new Map();
let rejectConflictWrites = false;
globalThis.window = { dispatchEvent() {} };
globalThis.CustomEvent = class CustomEvent {
  constructor(type) { this.type = type; }
};
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => {
    if (rejectConflictWrites && key === 'cashflow_sync_conflicts_v1') {
      throw new Error('Simulated storage quota failure');
    }
    storage.set(key, String(value));
  },
  removeItem: (key) => storage.delete(key),
};

const { getSyncConflicts, recordSyncConflict } = await import('../src/lib/data-integrity.ts');

test('recordSyncConflict verifies both versions are durable before acknowledging success', () => {
  storage.clear();
  rejectConflictWrites = false;
  const conflict = {
    entityId: 'tx-1',
    kind: 'transaction',
    serverChangedAt: 2,
    clientMutationChangedAt: 1,
    conflictingFields: ['Amount'],
    serverRecord: { Id: 'tx-1', Amount: 60 },
    clientRecord: { Id: 'tx-1', Amount: 70 },
    resolution: 'Manual choice required',
  };

  assert.equal(recordSyncConflict(conflict), true);
  assert.equal(getSyncConflicts().length, 1);
  assert.deepEqual(getSyncConflicts()[0].conflictingFields, ['Amount']);
  assert.equal(recordSyncConflict(conflict), true);
  assert.equal(getSyncConflicts().length, 1);
});

test('recordSyncConflict returns false when the local store cannot persist the conflict', () => {
  storage.clear();
  rejectConflictWrites = true;
  assert.equal(recordSyncConflict({
    entityId: 'tx-2',
    kind: 'transaction',
    serverChangedAt: 2,
    clientMutationChangedAt: 1,
    serverRecord: { Id: 'tx-2', Amount: 60 },
    clientRecord: { Id: 'tx-2', Amount: 70 },
    resolution: 'Manual choice required',
  }), false);
  assert.equal(getSyncConflicts().length, 0);
  rejectConflictWrites = false;
});
