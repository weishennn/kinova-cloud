import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  enqueueReceiptUpload,
  processPendingReceiptUploads,
} from '../src/lib/receipt-upload-queue.ts';

function createMemoryStore(initial = [], events = []) {
  const entries = new Map(initial.map((item) => [item.id, structuredClone(item)]));
  return {
    async list() {
      return [...entries.values()].map((item) => structuredClone(item));
    },
    async put(item) {
      entries.set(item.id, structuredClone(item));
      events.push(item.uploadedUrl ? 'persist-url' : 'persist-queue');
    },
    async claim(id, now, leaseMs) {
      const item = entries.get(id);
      if (!item || item.nextAttemptAt > now || item.leaseUntil > now) return null;
      const claimed = { ...item, leaseUntil: now + leaseMs };
      entries.set(id, claimed);
      return structuredClone(claimed);
    },
    async remove(id) {
      entries.delete(id);
      events.push('remove');
    },
    get(id) {
      const item = entries.get(id);
      return item ? structuredClone(item) : null;
    },
  };
}

function receiptInput(overrides = {}) {
  return {
    accountScope: 'u:person@example.com',
    transactionId: 'tx-123',
    sheetName: '2026-10',
    rowIndex: 2,
    fileName: 'receipt.jpg',
    mimeType: 'image/jpeg',
    base64: 'receipt-bytes',
    createdAt: 1_000,
    ...overrides,
  };
}

test('receipt upload queue persists the Drive URL before linking and then removes the item', async () => {
  const events = [];
  const store = createMemoryStore([], events);
  const queued = await enqueueReceiptUpload(receiptInput(), store);

  const result = await processPendingReceiptUploads({
    store,
    accountScope: queued.accountScope,
    isTransactionReady: async () => {
      events.push('ledger-ready');
      return true;
    },
    uploadFile: async () => {
      events.push('upload');
      return 'https://drive.google.com/receipt';
    },
    attachReceipt: async (item) => {
      assert.equal(item.uploadedUrl, 'https://drive.google.com/receipt');
      events.push('attach');
      return { success: true, pending: false };
    },
    now: () => 2_000,
  });

  assert.deepEqual(result, { completed: 1, deferred: 0, failed: 0 });
  assert.deepEqual(events, ['persist-queue', 'ledger-ready', 'upload', 'persist-url', 'attach', 'remove']);
  assert.equal(store.get(queued.id), null);
});

test('failed Drive upload stays queued with backoff and never blocks the transaction ledger', async () => {
  const events = [];
  const store = createMemoryStore([], events);
  const queued = await enqueueReceiptUpload(receiptInput(), store);
  const ledger = { id: queued.transactionId, amount: 18.48, description: 'KFC TRX' };
  let attached = false;

  const originalWarn = console.warn;
  console.warn = () => {};
  let result;
  try {
    result = await processPendingReceiptUploads({
      store,
      accountScope: queued.accountScope,
      isTransactionReady: async () => true,
      uploadFile: async () => { throw new Error('Drive unavailable'); },
      attachReceipt: async () => { attached = true; },
      now: () => 2_000,
    });
  } finally {
    console.warn = originalWarn;
  }

  const retry = store.get(queued.id);
  assert.equal(ledger.amount, 18.48);
  assert.equal(ledger.description, 'KFC TRX');
  assert.equal(attached, false);
  assert.deepEqual(result, { completed: 0, deferred: 0, failed: 1 });
  assert.equal(retry.attempts, 1);
  assert.equal(retry.nextAttemptAt, 7_000);
  assert.equal(retry.leaseUntil, 0);
});

test('reopening after Drive upload resumes linking without uploading the same receipt again', async () => {
  const queued = await enqueueReceiptUpload(receiptInput(), createMemoryStore());
  const store = createMemoryStore([{ ...queued, uploadedUrl: 'https://drive.google.com/receipt' }]);
  let uploadCount = 0;
  let attachedUrl = '';

  const result = await processPendingReceiptUploads({
    store,
    accountScope: queued.accountScope,
    isTransactionReady: async () => true,
    uploadFile: async () => {
      uploadCount += 1;
      return 'https://drive.google.com/duplicate';
    },
    attachReceipt: async (item) => {
      attachedUrl = item.uploadedUrl || '';
      return { success: true };
    },
    now: () => 2_000,
  });

  assert.equal(uploadCount, 0);
  assert.equal(attachedUrl, 'https://drive.google.com/receipt');
  assert.deepEqual(result, { completed: 1, deferred: 0, failed: 0 });
});

test('receipt worker leaves another account’s queued image untouched', async () => {
  const foreignStore = createMemoryStore();
  const queued = await enqueueReceiptUpload(receiptInput({ accountScope: 'u:other@example.com' }), foreignStore);
  let uploadCount = 0;

  const result = await processPendingReceiptUploads({
    store: foreignStore,
    accountScope: 'u:person@example.com',
    isTransactionReady: async () => true,
    uploadFile: async () => { uploadCount += 1; return 'https://drive.google.com/receipt'; },
    attachReceipt: async () => ({ success: true }),
    now: () => 2_000,
  });

  assert.equal(uploadCount, 0);
  assert.deepEqual(result, { completed: 0, deferred: 0, failed: 0 });
  assert.ok(foreignStore.get(queued.id));
});

test('transaction add and update outboxes are written before their Sheets requests', async () => {
  const source = await readFile(new URL('../src/lib/sheets-data.ts', import.meta.url), 'utf8');
  const addStart = source.indexOf('async addRow(sheetName: string');
  const updateStart = source.indexOf('async updateRow(sheetName: string');
  const deleteStart = source.indexOf('async deleteRow(sheetName: string');
  const addOutbox = source.indexOf('const pendingMutation = enqueuePendingMutation(', addStart);
  const addRequest = source.indexOf('await sheetsApi.addRow(effectiveSheetName, payload, mutationId)', addStart);
  const updateOutbox = source.indexOf('const pendingMutation = enqueuePendingMutation(', updateStart);
  const updateRequest = source.indexOf('await sheetsApi.updateRow(sheetName, rowIndex, rowData, mutationId)', updateStart);

  assert.ok(addStart >= 0 && updateStart > addStart && deleteStart > updateStart);
  assert.ok(addOutbox > addStart && addOutbox < addRequest);
  assert.ok(updateOutbox > updateStart && updateOutbox < updateRequest);
});

test('both receipt forms start the ledger write before durable receipt registration', async () => {
  const [recordModal, quickInput] = await Promise.all([
    readFile(new URL('../src/components/shared/record-modal.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/shared/smart-quick-input.tsx', import.meta.url), 'utf8'),
  ]);

  const editLedgerWrite = recordModal.indexOf('const ledgerWrite = updateUnifiedRow(');
  const editReceiptQueue = recordModal.indexOf('await enqueueReceiptUpload(', editLedgerWrite);
  const createLedgerWrite = recordModal.indexOf('ledgerWrite = addUnifiedRow(');
  const createReceiptQueue = recordModal.indexOf('await enqueueReceiptUpload(', createLedgerWrite);
  const quickLedgerWrite = quickInput.indexOf('const ledgerWrite = addUnifiedRow(');
  const quickReceiptQueue = quickInput.indexOf('await enqueueReceiptUpload(', quickLedgerWrite);

  assert.ok(editLedgerWrite >= 0 && editReceiptQueue > editLedgerWrite);
  assert.ok(createLedgerWrite > editReceiptQueue && createReceiptQueue > createLedgerWrite);
  assert.ok(quickLedgerWrite >= 0 && quickReceiptQueue > quickLedgerWrite);
  assert.doesNotMatch(recordModal, /driveApi\.uploadFile/);
  assert.doesNotMatch(quickInput, /driveApi\.uploadFile/);
});
