import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureGoogleApiSuccess } from '../src/lib/google-api-result.ts';

test('cross-month source deletion is acknowledged only after a successful Sheets response', async () => {
  await assert.doesNotReject(
    ensureGoogleApiSuccess(new Response('', { status: 200 }), 'source row delete'),
  );

  await assert.rejects(
    ensureGoogleApiSuccess(
      new Response('permission denied', { status: 403 }),
      'source row delete after cross-month move',
    ),
    /Google Sheets source row delete after cross-month move failed: permission denied/,
  );
});
