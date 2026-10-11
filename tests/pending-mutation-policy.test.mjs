import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getPendingMutationDisposition,
  shouldKeepPendingMutationOnStartup,
} from '../src/lib/pending-mutation-policy.ts';

test('startup keeps failed and previously retried mutations until the server acknowledges them', () => {
  const failed = {
    type: 'update',
    rowId: 'tx-pending-1',
    retryCount: 4,
    status: 'failed',
    lastError: 'Server unavailable',
  };

  assert.equal(shouldKeepPendingMutationOnStartup(failed, () => false), true);
  assert.equal(getPendingMutationDisposition(false), 'unconfirmed');
});

test('a locally tombstoned add/update is discarded, while its queued delete is retained', () => {
  const isTombstoned = (id) => id === 'tx-deleted';

  assert.equal(
    shouldKeepPendingMutationOnStartup({ type: 'update', rowId: 'tx-deleted', retryCount: 3 }, isTombstoned),
    false,
  );
  assert.equal(
    shouldKeepPendingMutationOnStartup({ type: 'delete', rowId: 'tx-deleted', retryCount: 3 }, isTombstoned),
    true,
  );
  assert.equal(getPendingMutationDisposition(true), 'acknowledged');
});
