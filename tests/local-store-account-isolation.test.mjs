import test from 'node:test';
import assert from 'node:assert/strict';
import { backupLocalStoreForLocalMode, restoreLocalStoreForLocalMode } from '../src/lib/cache-manager.ts';

const STORE_KEY = 'cashflow_local_store';
const BACKUP_KEY = 'cashflow_local_store_scoped:local_only';

function installStorage() {
  const values = new Map();
  let failWrites = false;
  globalThis.window = {};
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      if (failWrites) throw new Error('Simulated localStorage quota failure');
      values.set(key, String(value));
    },
    removeItem: (key) => values.delete(key),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
    set failWrites(value) { failWrites = value; },
  };
  globalThis.CustomEvent = class CustomEvent {};
  return values;
}

test('local-only database is verified in scoped backup before account cleanup and can be restored', () => {
  const values = installStorage();
  const ledger = JSON.stringify({ transactions: [{ Id: 'local-1', Amount: 12.5 }] });
  values.set(STORE_KEY, ledger);

  assert.deepEqual(backupLocalStoreForLocalMode(), { success: true, preserved: true });
  assert.equal(values.get(BACKUP_KEY), ledger);

  values.delete(STORE_KEY);
  assert.deepEqual(restoreLocalStoreForLocalMode(), { success: true, restored: true });
  assert.equal(values.get(STORE_KEY), ledger);
  assert.equal(values.has(BACKUP_KEY), false);
});

test('local-only backup failure leaves the active ledger untouched', () => {
  const values = installStorage();
  const ledger = JSON.stringify({ transactions: [{ Id: 'local-2', Amount: 5 }] });
  values.set(STORE_KEY, ledger);
  localStorage.failWrites = true;

  const result = backupLocalStoreForLocalMode();
  assert.equal(result.success, false);
  assert.equal(values.get(STORE_KEY), ledger);
  assert.equal(values.has(BACKUP_KEY), false);
});

test('restore refuses to replace different active local data and retains both copies', () => {
  const values = installStorage();
  const active = JSON.stringify({ transactions: [{ Id: 'local-new', Amount: 9 }] });
  const backup = JSON.stringify({ transactions: [{ Id: 'local-old', Amount: 7 }] });
  values.set(STORE_KEY, active);
  values.set(BACKUP_KEY, backup);

  const result = restoreLocalStoreForLocalMode();
  assert.equal(result.success, false);
  assert.equal(values.get(STORE_KEY), active);
  assert.equal(values.get(BACKUP_KEY), backup);
});
