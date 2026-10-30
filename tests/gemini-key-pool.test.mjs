import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseGeminiApiKeys,
  getLoadBalancedGeminiKeys,
  reportGeminiKeyFailure,
  resetGeminiKeyPoolStateForTests,
  generateGeminiContent,
} from '../src/lib/gemini-key-pool.ts';
import { runShortcutGeminiOcrWithFastFail } from '../src/lib/shortcut-draft-store.ts';

test('parseGeminiApiKeys supports comma-separated and numbered env vars with deduplication', () => {
  const env = {
    GEMINI_API_KEY: 'key-alpha, key-beta',
    GEMINI_API_KEYS: 'key-beta;key-gamma',
    GEMINI_API_KEY_1: 'key-alpha',
    GEMINI_API_KEY_2: '"key-delta"',
    GEMINI_API_KEY_3: "'key-epsilon'",
  };
  const keys = parseGeminiApiKeys(env);
  assert.deepEqual(keys, ['key-alpha', 'key-beta', 'key-gamma', 'key-delta', 'key-epsilon']);
});

test('getLoadBalancedGeminiKeys rotates starting key in round-robin order across 3 keys', () => {
  resetGeminiKeyPoolStateForTests();
  const env = {
    GEMINI_API_KEY_1: 'key-1',
    GEMINI_API_KEY_2: 'key-2',
    GEMINI_API_KEY_3: 'key-3',
  };

  const firstCall = getLoadBalancedGeminiKeys(env);
  const secondCall = getLoadBalancedGeminiKeys(env);
  const thirdCall = getLoadBalancedGeminiKeys(env);
  const fourthCall = getLoadBalancedGeminiKeys(env);

  assert.deepEqual(firstCall, ['key-1', 'key-2', 'key-3']);
  assert.deepEqual(secondCall, ['key-2', 'key-3', 'key-1']);
  assert.deepEqual(thirdCall, ['key-3', 'key-1', 'key-2']);
  assert.deepEqual(fourthCall, ['key-1', 'key-2', 'key-3']);
});

test('multi-stage Gemini calls can reuse the same healthy key slot', async () => {
  resetGeminiKeyPoolStateForTests();
  const env = {
    GEMINI_API_KEY_1: 'key-one',
    GEMINI_API_KEY_2: 'key-two',
    GEMINI_MODEL: 'gemini-2.5-flash',
  };
  const usedKeys = [];
  const fetchFn = async (_url, init) => {
    usedKeys.push(init?.headers?.['x-goog-api-key']);
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
    }), { status: 200 });
  };
  const first = await generateGeminiContent({
    prompt: 'test',
    thinking: false,
    models: ['gemini-2.5-flash'],
    env,
    fetchFn,
  });
  const second = await generateGeminiContent({
    prompt: 'review',
    thinking: false,
    models: ['gemini-2.5-flash'],
    env,
    fetchFn,
    preferredKeySlot: first.keySlot,
    onlyPreferredKey: true,
  });

  assert.equal(first.keySlot, 0);
  assert.equal(second.keySlot, 0);
  assert.deepEqual(usedKeys, ['key-one', 'key-one']);
});

test('reportGeminiKeyFailure deprioritizes 429 rate-limited keys while keeping healthy keys first', () => {
  resetGeminiKeyPoolStateForTests();
  const env = {
    GEMINI_API_KEY: 'key-1,key-2,key-3',
  };

  reportGeminiKeyFailure('key-1', 429);

  const ordered = getLoadBalancedGeminiKeys(env);
  assert.equal(ordered[2], 'key-1');
  assert.deepEqual(new Set(ordered.slice(0, 2)), new Set(['key-2', 'key-3']));
});

test('runShortcutGeminiOcrWithFastFail automatically fails over to key-2 when key-1 hits HTTP 429', async () => {
  resetGeminiKeyPoolStateForTests();
  const usedKeys = [];

  const result = await runShortcutGeminiOcrWithFastFail({
    geminiKeys: ['key-exhausted', 'key-healthy-2', 'key-healthy-3'],
    onKeyFailure: reportGeminiKeyFailure,
    preferredModel: 'gemini-2.5-flash',
    prompt: 'test',
    mimeType: 'image/jpeg',
    cleanBase64: 'dGVzdA==',
    fetchImpl: async (_url, init) => {
      const apiKey = init?.headers?.['x-goog-api-key'];
      usedKeys.push(apiKey);
      if (apiKey === 'key-exhausted') {
        return new Response(JSON.stringify({ error: { message: 'Resource exhausted' } }), {
          status: 429,
        });
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      amount: 38.5,
                      currency: 'MYR',
                      merchant: 'Village Grocer',
                      category: 'Food & Dining',
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 }
      );
    },
  });

  assert.deepEqual(usedKeys, ['key-exhausted', 'key-healthy-2']);
  assert.equal(result.attempts, 2);
  assert.equal(result.parsedOcr.amount, 38.5);
  assert.equal(result.parsedOcr.merchant, 'Village Grocer');
});
