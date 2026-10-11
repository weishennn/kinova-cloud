import test from 'node:test';
import assert from 'node:assert/strict';

// Mock localStorage for Node test runner
const storage = new Map();
let failWritesStartingWith = '';
globalThis.window = {};
globalThis.localStorage = {
  getItem: (k) => storage.get(k) ?? null,
  setItem: (k, v) => {
    if (failWritesStartingWith && k.startsWith(failWritesStartingWith)) {
      throw new Error('Simulated localStorage quota failure');
    }
    storage.set(k, String(v));
  },
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
  getPendingQueueOwnerScope,
} from '../src/lib/cache-manager.ts';

test('backupPendingQueuesForAccount preserves pending mutations under account-scoped keys without data loss', () => {
  storage.clear();
  failWritesStartingWith = '';

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

test('backup merges a later active queue into the previous account backup without replacing earlier mutations', () => {
  storage.clear();
  failWritesStartingWith = '';
  localStorage.setItem(CACHE_KEYS.PENDING_QUEUE, JSON.stringify([
    { id: 'p1', mutationId: 'm1', type: 'add', sheetName: '2026-10', rowId: 'tx-1', rowData: { Amount: 50 } },
  ]));

  assert.equal(backupPendingQueuesForAccount('usera@gmail.com').success, true);
  localStorage.removeItem(CACHE_KEYS.PENDING_QUEUE);
  localStorage.setItem(CACHE_KEYS.PENDING_QUEUE, JSON.stringify([
    { id: 'p2', mutationId: 'm2', type: 'add', sheetName: '2026-10', rowId: 'tx-2', rowData: { Amount: 80 } },
  ]));

  const backup = backupPendingQueuesForAccount('usera@gmail.com');
  assert.equal(backup.success, true);
  const saved = JSON.parse(localStorage.getItem('cashflow_pending_queue_scoped:usera@gmail.com'));
  assert.deepEqual(saved.map((item) => item.rowId), ['tx-1', 'tx-2']);
});

test('failed backup leaves active pending queue untouched', () => {
  storage.clear();
  localStorage.setItem(CACHE_KEYS.PENDING_QUEUE, JSON.stringify([
    { id: 'p1', type: 'add', sheetName: '2026-10', rowId: 'tx-1', rowData: { Amount: 50 } },
  ]));
  failWritesStartingWith = 'cashflow_pending_queue_scoped:';

  const result = backupPendingQueuesForAccount('usera@gmail.com');
  assert.equal(result.success, false);
  assert.equal(JSON.parse(localStorage.getItem(CACHE_KEYS.PENDING_QUEUE))[0].rowId, 'tx-1');

  failWritesStartingWith = '';
});

test('failed restore retains all scoped backups until every active queue is verified', () => {
  storage.clear();
  failWritesStartingWith = '';
  localStorage.setItem('cashflow_pending_queue_scoped:usera@gmail.com', JSON.stringify([
    { id: 'p1', mutationId: 'm1', type: 'add', sheetName: '2026-10', rowId: 'tx-1', rowData: { Amount: 50 } },
  ]));
  localStorage.setItem('cashflow_pending_plan_scoped:usera@gmail.com', JSON.stringify([
    { mutationId: 'p1', changedAt: 1, recordId: 'plan-1' },
  ]));
  localStorage.setItem('cashflow_pending_settings_scoped:usera@gmail.com', JSON.stringify([
    { mutationId: 's1', key: 'cashflow_currency', value: 'MYR', changedAt: 1 },
  ]));
  failWritesStartingWith = CACHE_KEYS.PENDING_PLAN_QUEUE;

  assert.equal(restorePendingQueuesForAccount('usera@gmail.com').restored, 0);
  assert.ok(localStorage.getItem('cashflow_pending_queue_scoped:usera@gmail.com'));
  assert.ok(localStorage.getItem('cashflow_pending_plan_scoped:usera@gmail.com'));
  assert.ok(localStorage.getItem('cashflow_pending_settings_scoped:usera@gmail.com'));

  failWritesStartingWith = '';
  const restored = restorePendingQueuesForAccount('usera@gmail.com');
  assert.equal(restored.restored, 3);
  assert.equal(JSON.parse(localStorage.getItem(CACHE_KEYS.PENDING_QUEUE)).length, 1);
  assert.equal(JSON.parse(localStorage.getItem(CACHE_KEYS.PENDING_PLAN_QUEUE)).length, 1);
  assert.equal(JSON.parse(localStorage.getItem(CACHE_KEYS.PENDING_SETTINGS_QUEUE)).length, 1);
  assert.equal(localStorage.getItem('cashflow_pending_queue_scoped:usera@gmail.com'), null);
  assert.equal(localStorage.getItem('cashflow_pending_plan_scoped:usera@gmail.com'), null);
  assert.equal(localStorage.getItem('cashflow_pending_settings_scoped:usera@gmail.com'), null);
});

test('pending queue ownership is derived from the previous scope, never the incoming account', () => {
  assert.equal(getPendingQueueOwnerScope('google:usera@gmail.com', 'userb@gmail.com', false), 'usera@gmail.com');
  assert.equal(getPendingQueueOwnerScope('local_only', 'usera@gmail.com', true), 'local_only');
  assert.equal(getPendingQueueOwnerScope(null, 'usera@gmail.com', false), 'usera@gmail.com');
  assert.equal(getPendingQueueOwnerScope(null, null, false), null);
});
