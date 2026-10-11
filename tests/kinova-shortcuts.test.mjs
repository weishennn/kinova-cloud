import test from 'node:test';
import assert from 'node:assert/strict';

import {
  saveShortcutQuickDraft,
  getShortcutQuickDraft,
  claimShortcutDraft,
  acknowledgeShortcutDraft,
  decodeOpaqueDraftTicket,
  normalizeApplePayTransactionInput,
  parseAmountAndCurrencyFromRawInput,
  findDuplicateTransactionsInLedger,
  inspectShortcutUrlSafety,
  runShortcutGeminiOcrWithFastFail,
  recordShortcutDraftToLedger,
} from '../src/lib/shortcut-draft-store.ts';

test('1. URL safety check rejects raw financial fields, screenshots, or secrets in URL query/hash', () => {
  const safeRedirect = inspectShortcutUrlSafety('https://kinova.example.com/?quickDraft=drf_0123456789abcdef01234567');
  assert.equal(safeRedirect.safe, true);
  assert.equal(safeRedirect.hasOpaqueDraftId, true);
  assert.deepEqual(safeRedirect.leakedParams, []);

  const unsafeAmount = inspectShortcutUrlSafety('https://kinova.example.com/?quickDraft=drf_0123456789abcdef01234567&amount=45.90&merchant=Starbucks');
  assert.equal(unsafeAmount.safe, false);
  assert.ok(unsafeAmount.leakedParams.includes('amount'));
  assert.ok(unsafeAmount.leakedParams.includes('merchant'));

  const unsafeToken = inspectShortcutUrlSafety('https://kinova.example.com/#token=secret_123&imageBase64=abcd');
  assert.equal(unsafeToken.safe, false);
  assert.ok(unsafeToken.leakedParams.includes('token'));
  assert.ok(unsafeToken.leakedParams.includes('imageBase64'));
});

test('2. Apple Pay transaction trigger gracefully handles missing/partial fields and prompts user to complete', () => {
  // Case A: Wallet trigger only passes CardOrPassName and no amount or merchant
  const cardOnly = normalizeApplePayTransactionInput({
    cardOrPass: 'Maybank Visa Infinite',
    date: '2026-10-10',
  }, '2026-10-10');

  assert.equal(cardOnly.merchant, '');
  assert.equal(cardOnly.amount, null);
  assert.ok(cardOnly.missingFields.includes('description'));
  assert.ok(cardOnly.missingFields.includes('amount'));
  assert.equal(cardOnly.cardOrPass, 'Maybank Visa Infinite');

  // Case B: Wallet trigger passes ambiguous '$' amount and merchant
  const ambiguousCurrency = normalizeApplePayTransactionInput({
    merchant: 'Toast Box',
    amount: '$12.80',
    date: '2026-10-10',
  }, '2026-10-10');

  assert.equal(ambiguousCurrency.merchant, 'Toast Box');
  assert.equal(ambiguousCurrency.amount, 12.8);
  assert.equal(ambiguousCurrency.currencyAmbiguous, true);
  assert.ok(ambiguousCurrency.candidateCurrencies.includes('SGD'));
  assert.ok(ambiguousCurrency.candidateCurrencies.includes('USD'));
  assert.ok(ambiguousCurrency.uncertainFields.includes('currency'));

  // Case C: Explicit RM currency string
  const explicitMyr = parseAmountAndCurrencyFromRawInput('RM 38.50', undefined, 'MYR');
  assert.equal(explicitMyr.amount, 38.5);
  assert.equal(explicitMyr.currency, 'MYR');
  assert.equal(explicitMyr.currencyAmbiguous, false);
});

test('3. Ephemeral draft store assigns opaque ID, detects duplicate drafts, and enforces confirm-before-save', () => {
  const normalized = normalizeApplePayTransactionInput({
    merchant: 'Grab Rides',
    amount: 'RM 24.50',
    cardOrPass: 'Apple Pay (Visa)',
    date: '2026-10-10',
    notes: 'Airport ride',
  }, '2026-10-10');

  const first = saveShortcutQuickDraft(normalized);
  assert.match(first.draftId, /^drf_[a-zA-Z0-9_-]{24,}$/);
  assert.equal(first.suspectedDuplicateOfDraftId, null);

  // Second identical submission triggers duplicate candidate warning
  const second = saveShortcutQuickDraft(normalized);
  assert.equal(second.suspectedDuplicateOfDraftId, first.draftId);

  // Claiming draft returns it for modal review
  const claimed = getShortcutQuickDraft(first.draftId);
  assert.ok(claimed);
  assert.equal(claimed.merchant, 'Grab Rides');
  assert.equal(claimed.amount, 24.5);
});

test('4. Ledger duplicate candidate detector identifies same-day/same-amount/same-merchant entries without auto-blocking unrelated entries', () => {
  const existingLedger = [
    {
      id: 'tx-12',
      date: '2026-10-10',
      category: 'Food & Dining',
      description: 'Arabica Coffee',
      amount: 22.0,
      currency: 'MYR',
    },
    {
      id: 'tx-13',
      date: '2026-10-10',
      category: 'Transport',
      description: 'Shell Petrol',
      amount: 95.0,
      currency: 'MYR',
    },
  ];

  const dupes = findDuplicateTransactionsInLedger(
    {
      description: 'Arabica Coffee KL',
      merchant: 'Arabica Coffee KL',
      amount: 22.0,
      currency: 'MYR',
      date: '2026-10-10',
    },
    existingLedger
  );

  assert.equal(dupes.length, 1);
  assert.equal(dupes[0].id, 'tx-12');

  const nonDupes = findDuplicateTransactionsInLedger(
    {
      description: 'Village Grocer',
      merchant: 'Village Grocer',
      amount: 64.2,
      currency: 'MYR',
      date: '2026-10-10',
    },
    existingLedger
  );

  assert.equal(nonDupes.length, 0);
});

test('5. ShortcutQuickDraft encodes and decodes ocrSummary and effective fields without data loss, and enforces one-time ACK', () => {
  const sample = saveShortcutQuickDraft({
    source: 'back_tap_screenshot',
    amount: 48.71,
    currency: 'AUD',
    currencyAmbiguous: false,
    candidateCurrencies: ['AUD'],
    type: 'Expense',
    category: 'Other',
    description: 'Wh',
    merchant: 'Wh',
    date: '2026-10-10',
    ocrSummary: '识别到应用账单界面，应付给 Wh 金额为 AUD 48.71',
    notes: '截图中包含应付 AUD 48.71 给 Wh 的记录',
    missingFields: [],
    uncertainFields: [],
    fingerprint: 'kfp_test_12345',
    aiDisclosure: '需确认后入账',
  });

  assert.ok(sample.draftId.startsWith('drf_'));
  assert.equal(sample.amount, 48.71);
  assert.equal(sample.ocrSummary, '识别到应用账单界面，应付给 Wh 金额为 AUD 48.71');

  // Verify stateless ticket decrypts directly across containers
  const statelessDecoded = decodeOpaqueDraftTicket(sample.draftId);
  assert.ok(statelessDecoded);
  assert.equal(statelessDecoded.amount, 48.71);
  assert.equal(statelessDecoded.description, 'Wh');
  assert.equal(statelessDecoded.ocrSummary, '识别到应用账单界面，应付给 Wh 金额为 AUD 48.71');

  // Verify 'latest' claim works when iOS resumes backgrounded PWA without URL params
  const latestClaimed = claimShortcutDraft('latest');
  assert.ok(latestClaimed);
  assert.equal(latestClaimed.draftId, sample.draftId);

  // Verify acknowledgment removes it from the latest store and blocks re-claiming
  const acked = acknowledgeShortcutDraft(sample.draftId);
  assert.equal(acked, true);
  assert.equal(getShortcutQuickDraft(sample.draftId), null);
});

test('6. Gemini Vision OCR fast-fail retry logic: normal 200, timeout, 404 fallback, and 429/503 fast-fail', async () => {
  // 6a. Normal 200 OK response (unwraps array or object, 1 attempt)
  const normalRes = await runShortcutGeminiOcrWithFastFail({
    geminiKey: 'test-key-isolated',
    preferredModel: 'gemini-flash-lite-latest',
    prompt: 'test',
    mimeType: 'image/png',
    cleanBase64: 'AAAA',
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify([
                      {
                        amount: 16.9,
                        currency: 'MYR',
                        merchant: 'FamilyMart',
                        category: 'Food & Dining',
                        ocrSummary: '识别到 FamilyMart 消费 RM 16.90',
                      },
                    ]),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 }
      ),
  });
  assert.equal(normalRes.attempts, 1);
  assert.equal(normalRes.modelUsed, 'gemini-flash-lite-latest');
  assert.equal(normalRes.parsedOcr.amount, 16.9);
  assert.equal(normalRes.parsedOcr.merchant, 'FamilyMart');
  assert.equal(normalRes.ocrFallbackNotice, '');

  // 6b. Model timeout / network error -> stops IMMEDIATELY after 1 attempt (never cascades across models)
  const timeoutRes = await runShortcutGeminiOcrWithFastFail({
    geminiKey: 'test-key-isolated',
    preferredModel: 'gemini-flash-lite-latest',
    prompt: 'test',
    mimeType: 'image/png',
    cleanBase64: 'AAAA',
    fetchImpl: async () => {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    },
  });
  assert.equal(timeoutRes.attempts, 1);
  assert.equal(timeoutRes.modelUsed, null);
  assert.match(timeoutRes.ocrFallbackNotice, /超时/);

  // 6c. 404 Model Not Found -> tries 1 fallback model (2 attempts total) and succeeds
  let count404 = 0;
  const fallback404Res = await runShortcutGeminiOcrWithFastFail({
    geminiKey: 'test-key-isolated',
    preferredModel: 'non-existent-gemini-model',
    prompt: 'test',
    mimeType: 'image/png',
    cleanBase64: 'AAAA',
    fetchImpl: async () => {
      count404 += 1;
      if (count404 === 1) {
        return new Response(JSON.stringify({ error: { message: 'Model not found' } }), { status: 404 });
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: JSON.stringify({ amount: 32.0, currency: 'MYR', merchant: 'ZUS Coffee' }) }],
              },
            },
          ],
        }),
        { status: 200 }
      );
    },
  });
  assert.equal(fallback404Res.attempts, 2);
  assert.equal(fallback404Res.modelUsed, 'gemini-2.5-flash');
  assert.equal(fallback404Res.parsedOcr.amount, 32.0);

  // 6d. 429 Quota / 503 Busy -> stops IMMEDIATELY after 1 attempt (no cascade)
  const res429 = await runShortcutGeminiOcrWithFastFail({
    geminiKey: 'test-key-isolated',
    preferredModel: 'gemini-flash-lite-latest',
    prompt: 'test',
    mimeType: 'image/png',
    cleanBase64: 'AAAA',
    fetchImpl: async () => new Response('Quota exceeded', { status: 429 }),
  });
  assert.equal(res429.attempts, 1);
  assert.match(res429.ocrFallbackNotice, /429/);

  const res503 = await runShortcutGeminiOcrWithFastFail({
    geminiKey: 'test-key-isolated',
    preferredModel: 'gemini-flash-lite-latest',
    prompt: 'test',
    mimeType: 'image/png',
    cleanBase64: 'AAAA',
    fetchImpl: async () => new Response('Service Unavailable', { status: 503 }),
  });
  assert.equal(res503.attempts, 1);
  assert.match(res503.ocrFallbackNotice, /503/);
});

test('7. Background auto-record writes valid transactions via mocked fetch, skips duplicates and missing amounts, and returns iOS notification text', async () => {
  const capturedPayloads = [];
  const mockFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    capturedPayloads.push(body);
    return new Response(
      JSON.stringify({
        status: 'success',
        data: { success: true, deduplicated: false },
      }),
      { status: 200 }
    );
  };

  // 7a. Valid receipt draft -> auto-records and acknowledges draft so modal won't re-pop
  const validDraft = saveShortcutQuickDraft({
    source: 'back_tap_screenshot',
    amount: 18.5,
    currency: 'MYR',
    currencyAmbiguous: false,
    candidateCurrencies: ['MYR'],
    type: 'Expense',
    category: 'Food & Dining',
    description: 'Oriental Kopi',
    merchant: 'Oriental Kopi',
    date: '2026-10-10',
    ocrSummary: '识别到 Oriental Kopi 消费 RM 18.50',
    notes: 'Nasi Lemak',
    missingFields: [],
    uncertainFields: [],
    fingerprint: 'kfp_oriental_kopi_1850',
    aiDisclosure: '自动入账',
  });

  const autoRes = await recordShortcutDraftToLedger(validDraft, {
    autoRecord: true,
    scriptUrl: 'https://mock.script.google.com/macros/s/test/exec',
    apiSecret: 'mock-secret',
    fetchImpl: mockFetch,
  });

  assert.equal(autoRes.autoRecorded, true);
  assert.equal(autoRes.duplicateSkipped, false);
  assert.equal(autoRes.sheetName, '2026-10');
  assert.match(autoRes.notificationTitle, /已记账 MYR 18\.50 \(2026-10-10\)/);
  assert.match(autoRes.notificationText, /\[2026-10-10\]/);
  assert.match(autoRes.notificationText, /Oriental Kopi/);
  assert.equal(capturedPayloads.length, 1);
  assert.equal(capturedPayloads[0].action, 'addRow');
  assert.equal(capturedPayloads[0].sheetName, '2026-10');
  assert.equal(capturedPayloads[0].rowData.Amount, 18.5);
  assert.equal(capturedPayloads[0].rowData.Description, 'Oriental Kopi');
  assert.equal(capturedPayloads[0].rowData.Category, 'Food & Dining');

  // Verify draft was automatically acknowledged so opening Kinova later won't pop the modal again
  assert.equal(getShortcutQuickDraft(validDraft.draftId), null);

  // 7b. Missing amount screenshot -> refuses to auto-record, returns warning notification
  const emptyAmountDraft = saveShortcutQuickDraft({
    source: 'back_tap_screenshot',
    amount: null,
    currency: 'MYR',
    currencyAmbiguous: false,
    candidateCurrencies: ['MYR'],
    type: 'Expense',
    category: 'Other',
    description: '待确认商户',
    merchant: '',
    date: '2026-10-10',
    ocrSummary: '',
    notes: '未识别到金额',
    missingFields: ['amount'],
    uncertainFields: [],
    fingerprint: 'kfp_empty_amount_test',
    aiDisclosure: '待补充',
  });

  const emptyRes = await recordShortcutDraftToLedger(emptyAmountDraft, {
    autoRecord: true,
    fetchImpl: mockFetch,
  });

  assert.equal(emptyRes.autoRecorded, false);
  assert.match(emptyRes.notificationTitle, /未自动记账/);
  assert.equal(capturedPayloads.length, 1); // No extra network write made

  // 7c. Duplicate draft -> skips writing and notifies user
  const dupDraft = {
    ...validDraft,
    draftId: 'drf_dup_test_1234567890123456',
    suspectedDuplicateOfDraftId: validDraft.draftId,
  };
  const dupRes = await recordShortcutDraftToLedger(dupDraft, {
    autoRecord: true,
    scriptUrl: 'https://mock.script.google.com/macros/s/test/exec',
    fetchImpl: mockFetch,
  });

  assert.equal(dupRes.autoRecorded, false);
  assert.equal(dupRes.duplicateSkipped, true);
  assert.match(dupRes.notificationText, /已跳过重复记录/);
  assert.equal(capturedPayloads.length, 1); // Still 1
});


