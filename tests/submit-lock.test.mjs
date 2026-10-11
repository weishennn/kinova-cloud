import test from 'node:test';
import assert from 'node:assert/strict';

import { acquireSubmitLock, releaseSubmitLock } from '../src/lib/submit-lock.ts';

test('a repeated submit is blocked synchronously until the current submission is released', () => {
  const lock = { current: false };

  assert.equal(acquireSubmitLock(lock), true);
  assert.equal(acquireSubmitLock(lock), false);

  releaseSubmitLock(lock);
  assert.equal(acquireSubmitLock(lock), true);
});

test('releasing a submit lock more than once is safe', () => {
  const lock = { current: false };
  assert.equal(acquireSubmitLock(lock), true);

  releaseSubmitLock(lock);
  releaseSubmitLock(lock);

  assert.equal(acquireSubmitLock(lock), true);
});
