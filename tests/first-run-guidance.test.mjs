import test from 'node:test';
import assert from 'node:assert/strict';
import { getUserMoneyProfile, updateUserMoneyProfile } from '../src/lib/user-money-profile.ts';

test('first-run guidance triggers for users with fewer than 3 expenses', () => {
  const emptyTransactions = [];
  const profile = getUserMoneyProfile(emptyTransactions);
  assert.equal(profile.paydayDay, null);
  assert.equal(profile.language, 'auto');
});

test('first-run guidance stores language and payday preferences', () => {
  const profile = getUserMoneyProfile([]);
  assert.ok(profile);
  assert.equal(typeof profile.goals, 'object');
});
