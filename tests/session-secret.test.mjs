import test from 'node:test';
import assert from 'node:assert/strict';

import { getConfiguredSessionSecret } from '../src/lib/session-secret-policy.ts';

test('session encryption requires an explicitly configured server secret', () => {
  assert.equal(getConfiguredSessionSecret({}), '');
  assert.equal(getConfiguredSessionSecret({ AUTH_SECRET: '   ' }), '');
});

test('session secret selection prefers AUTH_SECRET and retains server-secret fallbacks', () => {
  assert.equal(
    getConfiguredSessionSecret({ AUTH_SECRET: 'auth-secret', GOOGLE_CLIENT_SECRET: 'oauth-secret' }),
    'auth-secret'
  );
  assert.equal(getConfiguredSessionSecret({ GOOGLE_CLIENT_SECRET: 'oauth-secret' }), 'oauth-secret');
  assert.equal(getConfiguredSessionSecret({ CASHFLOW_PROXY_TOKEN: 'proxy-token' }), 'proxy-token');
});
