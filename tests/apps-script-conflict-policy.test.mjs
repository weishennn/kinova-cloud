import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function loadConflictHelpers() {
  const source = await readFile(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
  const start = source.indexOf('function normalizeConflictValue(');
  const end = source.indexOf('function updateRow(', start);
  assert.notEqual(start, -1, 'Apps Script conflict normalizer should exist');
  assert.notEqual(end, -1, 'Apps Script updateRow should follow the conflict helpers');
  const context = vm.createContext({});
  vm.runInContext(source.slice(start, end), context);
  return context.findConcurrentFieldConflicts;
}

test('Apps Script conflict policy ignores sheet fields not present in the stored schema', async () => {
  const findConflicts = await loadConflictHelpers();
  const fields = findConflicts(
    { Amount: 50, BaseCurrency: 'MYR' },
    { Amount: 50 },
    { Amount: 60, BaseCurrency: 'MYR' }
  );
  assert.deepEqual(Array.from(fields), []);
});

test('Apps Script conflict policy reports same-field concurrent edits', async () => {
  const findConflicts = await loadConflictHelpers();
  const fields = findConflicts(
    { Amount: '50.00' },
    { Amount: 60 },
    { Amount: 70 }
  );
  assert.deepEqual(Array.from(fields), ['Amount']);
});
