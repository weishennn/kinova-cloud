export interface PendingReceiptUpload {
  id: string;
  accountScope: string;
  transactionId: string;
  sheetName: string;
  rowIndex: number;
  fileName: string;
  mimeType: string;
  base64: string;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
  leaseUntil: number;
  uploadedUrl?: string;
}

export interface ReceiptUploadQueueStore {
  list(): Promise<PendingReceiptUpload[]>;
  put(item: PendingReceiptUpload): Promise<void>;
  claim(id: string, now: number, leaseMs: number): Promise<PendingReceiptUpload | null>;
  remove(id: string): Promise<void>;
}

export interface ReceiptUploadDependencies {
  store: ReceiptUploadQueueStore;
  accountScope: string;
  isTransactionReady: (item: PendingReceiptUpload) => Promise<boolean>;
  uploadFile: (item: PendingReceiptUpload) => Promise<string>;
  attachReceipt: (item: PendingReceiptUpload) => Promise<{ success?: boolean; pending?: boolean; conflict?: boolean } | void>;
  now?: () => number;
}

const DATABASE_NAME = 'kinova-receipt-uploads';
const DATABASE_VERSION = 1;
const OBJECT_STORE_NAME = 'pending';
const CLAIM_LEASE_MS = 60_000;
const LEDGER_RECHECK_MS = 15_000;
const BASE_RETRY_MS = 5_000;
const MAX_RETRY_MS = 30 * 60_000;
export const RECEIPT_UPLOAD_QUEUE_EVENT = 'kinova_receipt_upload_queue_changed';

let databasePromise: Promise<IDBDatabase> | null = null;
let activeDrain: Promise<{ completed: number; deferred: number; failed: number }> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('Receipt upload storage is unavailable in this browser.'));
  }
  if (databasePromise) return databasePromise;

  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(OBJECT_STORE_NAME)) {
        database.createObjectStore(OBJECT_STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => reject(request.error || new Error('Could not open receipt upload storage.'));
    request.onblocked = () => reject(new Error('Receipt upload storage is blocked by another app tab.'));
  }).catch((error) => {
    databasePromise = null;
    throw error;
  });

  return databasePromise!;
}

function finishTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Receipt upload storage transaction failed.'));
    transaction.onabort = () => reject(transaction.error || new Error('Receipt upload storage transaction was aborted.'));
  });
}

export const receiptUploadQueueStore: ReceiptUploadQueueStore & {
  nextWakeAt(accountScope: string): Promise<number | null>;
} = {
  async list() {
    const database = await openDatabase();
    const transaction = database.transaction(OBJECT_STORE_NAME, 'readonly');
    const request = transaction.objectStore(OBJECT_STORE_NAME).getAll();
    const done = finishTransaction(transaction);
    const rows = await new Promise<PendingReceiptUpload[]>((resolve, reject) => {
      request.onsuccess = () => resolve((request.result || []) as PendingReceiptUpload[]);
      request.onerror = () => reject(request.error || new Error('Could not read receipt upload queue.'));
    });
    await done;
    return rows;
  },

  async put(item) {
    const database = await openDatabase();
    const transaction = database.transaction(OBJECT_STORE_NAME, 'readwrite');
    transaction.objectStore(OBJECT_STORE_NAME).put(item);
    await finishTransaction(transaction);
  },

  async claim(id, now, leaseMs) {
    const database = await openDatabase();
    const transaction = database.transaction(OBJECT_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(OBJECT_STORE_NAME);
    const request = store.get(id);
    let claimed: PendingReceiptUpload | null = null;
    request.onsuccess = () => {
      const current = request.result as PendingReceiptUpload | undefined;
      if (!current || current.accountScope === '' || current.nextAttemptAt > now || current.leaseUntil > now) return;
      claimed = { ...current, leaseUntil: now + leaseMs };
      store.put(claimed);
    };
    const done = finishTransaction(transaction);
    await done;
    return claimed;
  },

  async remove(id) {
    const database = await openDatabase();
    const transaction = database.transaction(OBJECT_STORE_NAME, 'readwrite');
    transaction.objectStore(OBJECT_STORE_NAME).delete(id);
    await finishTransaction(transaction);
  },

  async nextWakeAt(accountScope) {
    const now = Date.now();
    const entries = (await this.list()).filter((item) => item.accountScope === accountScope);
    if (entries.length === 0) return null;
    return Math.min(...entries.map((item) => Math.max(item.nextAttemptAt || 0, item.leaseUntil || 0, now)));
  },
};

export async function enqueueReceiptUpload(
  input: Omit<PendingReceiptUpload, 'id' | 'attempts' | 'nextAttemptAt' | 'leaseUntil' | 'uploadedUrl'>,
  store: ReceiptUploadQueueStore = receiptUploadQueueStore,
): Promise<PendingReceiptUpload> {
  const item: PendingReceiptUpload = {
    ...input,
    id: `${input.accountScope}:${input.transactionId}`,
    attempts: 0,
    nextAttemptAt: 0,
    leaseUntil: 0,
  };
  await store.put(item);
  return item;
}

export function notifyReceiptUploadQueueChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(RECEIPT_UPLOAD_QUEUE_EVENT));
  }
}

export function processPendingReceiptUploads(dependencies: ReceiptUploadDependencies) {
  if (activeDrain) return activeDrain;
  activeDrain = drainReceiptUploads(dependencies).finally(() => {
    activeDrain = null;
  });
  return activeDrain;
}

async function drainReceiptUploads({
  store,
  accountScope,
  isTransactionReady,
  uploadFile,
  attachReceipt,
  now = Date.now,
}: ReceiptUploadDependencies): Promise<{ completed: number; deferred: number; failed: number }> {
  const summary = { completed: 0, deferred: 0, failed: 0 };
  const entries = (await store.list()).filter((item) => item.accountScope === accountScope);

  for (const entry of entries) {
    let currentTime = now();
    const claimed = await store.claim(entry.id, currentTime, CLAIM_LEASE_MS);
    if (!claimed) continue;

    let item = claimed;
    try {
      if (!(await isTransactionReady(item))) {
        await store.put({ ...item, leaseUntil: 0, nextAttemptAt: currentTime + LEDGER_RECHECK_MS });
        summary.deferred += 1;
        continue;
      }

      if (!item.uploadedUrl) {
        const uploadedUrl = (await uploadFile(item)).trim();
        if (!uploadedUrl) throw new Error('Drive did not return a receipt URL.');
        item = { ...item, uploadedUrl };
        // Save the Drive URL before touching Sheets so a restart can retry linking without re-uploading.
        await store.put(item);
      }

      const result = await attachReceipt(item);
      if (result?.success === false && result.pending !== true) {
        throw new Error(result.conflict ? 'Receipt link conflicted with a newer transaction edit.' : 'Receipt link was not saved.');
      }
      await store.remove(item.id);
      summary.completed += 1;
    } catch (error) {
      currentTime = now();
      const attempts = item.attempts + 1;
      const delay = Math.min(BASE_RETRY_MS * (2 ** Math.min(attempts - 1, 10)), MAX_RETRY_MS);
      await store.put({
        ...item,
        attempts,
        leaseUntil: 0,
        nextAttemptAt: currentTime + delay,
      });
      summary.failed += 1;
      console.warn('[ReceiptUploadQueue] Receipt upload/link will retry:', error);
    }
  }

  return summary;
}
