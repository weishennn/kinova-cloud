import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveNotFoundUpdatePolicy,
  detectConcurrentFieldConflict,
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
