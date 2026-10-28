import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getStandardGeminiModelOrder,
  extractTextFromGeminiResponse,
  stripJsonFences,
  generateGeminiContent,
  resetGeminiKeyPoolStateForTests,
} from '../src/lib/gemini-key-pool.ts';

test('getStandardGeminiModelOrder enforces gemini-2.5-flash then gemini-flash-latest by default', () => {
  const models = getStandardGeminiModelOrder({});
  assert.deepEqual(models, ['gemini-2.5-flash', 'gemini-flash-latest']);
  assert(!models.includes('gemini-3.5-flash'));
  assert(!models.includes('gemini-3.8-flash'));
});

test('getStandardGeminiModelOrder puts process.env.GEMINI_MODEL first when configured', () => {
  const models = getStandardGeminiModelOrder({ GEMINI_MODEL: 'gemini-2.5-pro' });
  assert.deepEqual(models, ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-flash-latest']);
});

test('extractTextFromGeminiResponse concatenates text parts and ignores thought parts', () => {
  const payload = {
    candidates: [
      {
        content: {
          parts: [
            { thought: true, text: 'Let me think about this financial question...' },
            { text: '{"headline": "Budget analysis",' },
            { text: ' "status": "ok"}' },
          ],
        },
      },
    ],
  };

  const text = extractTextFromGeminiResponse(payload);
  assert.equal(text, '{"headline": "Budget analysis", "status": "ok"}');
});

test('stripJsonFences strips markdown code blocks', () => {
  const withFence = '```json\n{"success": true}\n```';
  assert.equal(stripJsonFences(withFence), '{"success": true}');

  const withPlainFence = '```\n{"success": true}\n```';
  assert.equal(stripJsonFences(withPlainFence), '{"success": true}');

  const clean = '{"success": true}';
  assert.equal(stripJsonFences(clean), '{"success": true}');
});

test('generateGeminiContent retries without thinkingConfig when model returns 400 mentioning thinkingConfig', async () => {
  resetGeminiKeyPoolStateForTests();
  const env = { GEMINI_API_KEY: 'test-key' };
  const requests = [];

  const mockFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);

    // First attempt with thinkingConfig -> reject with 400
    if (body.generationConfig?.thinkingConfig) {
      return new Response(
        JSON.stringify({
          error: {
            code: 400,
            message: 'thinkingConfig is not supported for this model or budget',
          },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Retry without thinkingConfig -> succeed
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text: '{"answer": "Retried successfully"}' }],
            },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  const result = await generateGeminiContent({
    prompt: 'Analyze budget',
    thinking: true,
    env,
    fetchFn: mockFetch,
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].generationConfig.thinkingConfig.thinkingBudget, 2048);
  assert.equal(requests[1].generationConfig.thinkingConfig, undefined);
  assert.equal(result.text, '{"answer": "Retried successfully"}');
});

test('generateGeminiContent fails over to next key on 429', async () => {
  resetGeminiKeyPoolStateForTests();
  const env = { GEMINI_API_KEY: 'key-1,key-2' };
  const usedKeys = [];

  const mockFetch = async (_url, init) => {
    const key = init.headers['x-goog-api-key'];
    usedKeys.push(key);

    if (key === 'key-1') {
      return new Response(JSON.stringify({ error: 'Quota exceeded' }), { status: 429 });
    }

    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text: '{"status": "ok"}' }],
            },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  const result = await generateGeminiContent({
    prompt: 'Hello',
    env,
    fetchFn: mockFetch,
  });

  assert.deepEqual(usedKeys, ['key-1', 'key-2']);
  assert.equal(result.text, '{"status": "ok"}');
});
