import test from 'node:test';
import assert from 'node:assert/strict';

// Mock localStorage for Node test runner
const storage = new Map();
globalThis.window = {};
globalThis.localStorage = {
  getItem: (k) => storage.get(k) ?? null,
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
  clear: () => storage.clear(),
  get length() { return storage.size; },
  key: (i) => Array.from(storage.keys())[i] ?? null,
};

import {
  CACHE_KEYS,
  backupPendingQueuesForAccount,
  restorePendingQueuesForAccount,
  getPendingQueueSummary,
} from '../src/lib/cache-manager.ts';

test('backupPendingQueuesForAccount preserves pending mutations under account-scoped keys without data loss', () => {
  storage.clear();

  // User A has 2 offline transactions and 1 setting update
  const userATx = [
    { id: 'p1', type: 'add', sheetName: '2026-10', rowId: 'tx-1', rowData: { Amount: 50 } },
    { id: 'p2', type: 'update', sheetName: '2026-10', rowId: 'tx-2', rowData: { Amount: 80 } },
  ];
  const userASettings = [
    { mutationId: 's1', key: 'cashflow_currency', value: 'MYR', changedAt: 1000 },
  ];

  localStorage.setItem(CACHE_KEYS.PENDING_QUEUE, JSON.stringify(userATx));
  localStorage.setItem(CACHE_KEYS.PENDING_SETTINGS_QUEUE, JSON.stringify(userASettings));

  const summary = getPendingQueueSummary();
  assert.equal(summary.transactions, 2);
  assert.equal(summary.settings, 1);
  assert.equal(summary.total, 3);

  // Backup for user A
  const backupRes = backupPendingQueuesForAccount('usera@gmail.com');
  assert.equal(backupRes.backedUp, 3);

  // Verify scoped keys exist
  assert.ok(localStorage.getItem('cashflow_pending_queue_scoped:usera@gmail.com'));
  assert.ok(localStorage.getItem('cashflow_pending_settings_scoped:usera@gmail.com'));

  // Clear active queues (simulating signOut / wipeAccountStorage)
  localStorage.removeItem(CACHE_KEYS.PENDING_QUEUE);
  localStorage.removeItem(CACHE_KEYS.PENDING_SETTINGS_QUEUE);

  const afterWipe = getPendingQueueSummary();
  assert.equal(afterWipe.total, 0);

  // User B logs in: User B has no scoped queue
  const userBRestore = restorePendingQueuesForAccount('userb@gmail.com');
  assert.equal(userBRestore.restored, 0);
  assert.equal(getPendingQueueSummary().total, 0);

  // User A logs back in: User A's offline mutations are restored!
  const userARestore = restorePendingQueuesForAccount('usera@gmail.com');
  assert.equal(userARestore.restored, 3);

  const restoredSummary = getPendingQueueSummary();
  assert.equal(restoredSummary.transactions, 2);
  assert.equal(restoredSummary.settings, 1);
  assert.equal(restoredSummary.total, 3);
});
