import test from 'node:test';
import assert from 'node:assert/strict';

import { getAdminEmail, isAdminEmail } from '../src/lib/admin-email-policy.ts';

test('admin email matching fails closed when ADMIN_EMAIL is unset or blank', () => {
  assert.equal(getAdminEmail(undefined), '');
  assert.equal(isAdminEmail('admin@example.com', undefined), false);
  assert.equal(getAdminEmail('   '), '');
  assert.equal(isAdminEmail('admin@example.com', '   '), false);
});

test('admin email matching is case-insensitive when explicitly configured', () => {
  assert.equal(getAdminEmail('Admin@Example.com '), 'admin@example.com');
  assert.equal(isAdminEmail('ADMIN@example.com', 'Admin@Example.com '), true);
  assert.equal(isAdminEmail('other@example.com', 'Admin@Example.com '), false);
});
