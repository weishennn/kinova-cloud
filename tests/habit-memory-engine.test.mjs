import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanPayeeOrMerchantPattern,
  matchHabitMemory,
  learnOrStrengthenHabit,
  observeHabitCandidate,
  clearNonManualHabits,
  isEligibleHabitMerchant,
  isRedundantCategoryMapping,
  sanitizeHabitKeywords,
  getHabitMemories,
  DEFAULT_HABIT_MEMORIES,
  mineHabitsFromLedger,
  getCurrentTimeSlot,
} from '../src/lib/habit-memory-engine.ts';

import { parseNaturalExpense } from '../src/lib/natural-expense-parser.ts';

test('1. cleanPayeeOrMerchantPattern removes DuitNow & bank transfer prefixes', () => {
  assert.equal(cleanPayeeOrMerchantPattern('DuitNow Transfer to abc'), 'abc');
  assert.equal(cleanPayeeOrMerchantPattern('Transfer to TAN CHIN HONG'), 'TAN CHIN HONG');
  assert.equal(cleanPayeeOrMerchantPattern('转账给 李小龙'), '李小龙');
  assert.equal(cleanPayeeOrMerchantPattern('Payment to Shell Petrol'), 'Shell Petrol');
  assert.equal(cleanPayeeOrMerchantPattern('abc'), 'abc');
});

test('2. matchHabitMemory resolves raw payee to colloquial alias & category', () => {
  const customMemories = [
    {
      id: 'habit_abc',
      rawPattern: 'abc',
      preferredAlias: 'zapfan',
      category: 'Food & Dining',
      subCategory: 'Lunch',
      defaultItemName: '杂饭 / 经济饭',
      typicalAmount: 13.50,
      timeSlot: 'lunch',
      frequency: 4,
      confidence: 0.95,
      learnedSource: 'user_confirmed',
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-24T00:00:00Z',
    },
    {
      id: 'habit_tan',
      rawPattern: 'TAN CHIN HONG',
      preferredAlias: '四夕豆花',
      category: 'Food & Dining',
      frequency: 2,
      confidence: 0.85,
      learnedSource: 'auto_learned',
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-24T00:00:00Z',
    },
  ];

  // Match 1: Exact payee match
  const matchAbc = matchHabitMemory('abc', customMemories);
  assert.ok(matchAbc);
  assert.equal(matchAbc.resolvedDescription, 'zapfan');
  assert.equal(matchAbc.resolvedCategory, 'Food & Dining');
  assert.equal(matchAbc.matchedPattern, 'abc');
  assert.equal(matchAbc.isAlias, true);

  // Match 2: In-context transfer string
  const matchTransfer = matchHabitMemory('DuitNow Transfer to abc', customMemories);
  assert.ok(matchTransfer);
  assert.equal(matchTransfer.resolvedDescription, 'zapfan');
  assert.equal(matchTransfer.resolvedCategory, 'Food & Dining');

  // Match 3: Registered legal business name
  const matchTan = matchHabitMemory('TAN CHIN HONG', customMemories);
  assert.ok(matchTan);
  assert.equal(matchTan.resolvedDescription, '四夕豆花');

  // Match 4: Unknown payee
  const matchUnknown = matchHabitMemory('Random Unknown Store', customMemories);
  assert.equal(matchUnknown, null);
});

test('3. mineHabitsFromLedger discovers repeat payee-to-alias relationships', () => {
  const sampleTransactions = [
    { id: '1', date: '2026-10-01', amount: 13.5, type: 'expense', category: 'Food & Dining', description: 'zapfan', notes: '[转账给: abc]' },
    { id: '2', date: '2026-10-03', amount: 14.0, type: 'expense', category: 'Food & Dining', description: 'zapfan', notes: '[转账给: abc]' },
    { id: '3', date: '2026-10-08', amount: 12.0, type: 'expense', category: 'Food & Dining', description: 'zapfan', notes: '[转账给: abc]' },
    { id: '4', date: '2026-10-04', amount: 80.0, type: 'expense', category: 'Transport', description: 'Shell Petrol', merchant: 'Shell' },
  ];

  const mined = mineHabitsFromLedger(sampleTransactions);
  assert.ok(mined.length >= 1, 'Should extract at least 1 habit');
  const abcHabit = mined.find((h) => h.rawPattern.toLowerCase() === 'abc');
  assert.ok(abcHabit, 'Should discover habit for payee abc');
  assert.equal(abcHabit.preferredAlias, 'zapfan');
  assert.equal(abcHabit.category, 'Food & Dining');
  assert.equal(abcHabit.frequency, 3);
  assert.ok(abcHabit.typicalAmount && abcHabit.typicalAmount > 12 && abcHabit.typicalAmount < 14);
});

test('4. parseNaturalExpense automatically maps learned habit alias and category', () => {
  // Mock localStorage for test environment
  globalThis.localStorage = {
    store: new Map([
      [
        'cashflow_habit_memory',
        JSON.stringify([
          {
            id: 'habit_abc',
            rawPattern: 'abc',
            preferredAlias: 'zapfan',
            category: 'Food & Dining',
            subCategory: 'Lunch',
            confidence: 0.95,
            frequency: 5,
            learnedSource: 'user_confirmed',
            createdAt: '2026-10-01T00:00:00Z',
            updatedAt: '2026-10-24T00:00:00Z',
          },
        ]),
      ],
    ]),
    getItem(key) {
      return this.store.get(key) || null;
    },
    setItem(key, value) {
      this.store.set(key, String(value));
    },
    removeItem(key) {
      this.store.delete(key);
    },
    clear() {
      this.store.clear();
    },
  };

  // Case A: User types "abc 14.50" -> instantly resolves to "zapfan" under "Food & Dining"
  const parsed1 = parseNaturalExpense('abc 14.50');
  assert.ok(parsed1);
  assert.equal(parsed1.amount, 14.5);
  assert.equal(parsed1.description, 'zapfan');
  assert.equal(parsed1.category, 'Food & Dining');
  assert.ok(parsed1.habitMatch);
  assert.equal(parsed1.habitMatch.rawPattern, 'abc');
  assert.equal(parsed1.habitMatch.alias, 'zapfan');

  // Case B: User types "转给 abc 12" -> resolves to "zapfan"
  const parsed2 = parseNaturalExpense('转给 abc 12');
  assert.ok(parsed2);
  assert.equal(parsed2.amount, 12);
  assert.equal(parsed2.description, 'zapfan');
  assert.equal(parsed2.category, 'Food & Dining');
});

test('5. learnOrStrengthenHabit rejects identity auto_learned & itemized OCR names while keeping aliases and manual rules', () => {
  const store = new Map();
  const prevWindow = globalThis.window;
  const prevStorage = globalThis.localStorage;
  const prevEvent = globalThis.Event;
  globalThis.window = { dispatchEvent() {} };
  globalThis.Event = globalThis.Event || class Event { constructor(t) { this.type = t; } };
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };

  try {

  // Seed polluted legacy + habit records alongside legitimate entries
  const pollutedSeed = [
    {
      id: 'habit_sushi',
      rawPattern: 'sushi',
      preferredAlias: 'sushi',
      category: 'Food & Dining',
      frequency: 1,
      confidence: 0.75,
      learnedSource: 'auto_learned',
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
    },
    {
      id: 'habit_long_ocr',
      rawPattern: 'Sushi King (Salmon Sushi x2, Tamago x1 + 3 more)',
      preferredAlias: 'Sushi King Dinner',
      category: 'Food & Dining',
      frequency: 1,
      confidence: 0.75,
      learnedSource: 'auto_learned',
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
    },
    {
      id: 'habit_confirmed',
      rawPattern: 'Sushi Zanmai',
      preferredAlias: 'Sushi Zanmai',
      category: 'Food & Dining',
      frequency: 2,
      confidence: 0.9,
      learnedSource: 'user_confirmed',
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
    },
    ...DEFAULT_HABIT_MEMORIES,
  ];
  const legacySeed = [
    { id: 'habit_sushi', merchantPattern: 'sushi', category: 'Food & Dining', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' },
    { id: 'habit_long_ocr', merchantPattern: 'Sushi King (Salmon Sushi x2, Tamago x1 + 3 more)', category: 'Food & Dining', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' },
    { id: 'habit_confirmed', merchantPattern: 'Sushi Zanmai', category: 'Food & Dining', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' },
  ];

  localStorage.setItem('cashflow_habit_memory', JSON.stringify(pollutedSeed));
  localStorage.setItem('cashflow_merchant_category_rules', JSON.stringify(legacySeed));

  // Auto-cleanup on load removes polluted auto_learned entries & legacy copies, keeping user_confirmed & manual
  const cleaned = getHabitMemories();
  assert.equal(cleaned.some((h) => h.rawPattern === 'sushi'), false);
  assert.equal(cleaned.some((h) => h.rawPattern.includes('Salmon Sushi')), false);
  assert.equal(cleaned.some((h) => h.rawPattern === 'Sushi Zanmai'), true);
  assert.equal(cleaned.some((h) => h.rawPattern === 'Shell'), true);

  const cleanedLegacy = JSON.parse(localStorage.getItem('cashflow_merchant_category_rules'));
  assert.equal(cleanedLegacy.some((r) => r.merchantPattern === 'sushi'), false);
  assert.equal(cleanedLegacy.some((r) => r.merchantPattern.includes('Salmon Sushi')), false);

  // Reject identity auto_learned ("sushi" -> "sushi")
  assert.equal(
    learnOrStrengthenHabit({
      rawInputOrMerchant: 'sushi',
      aliasOrDescription: 'sushi',
      category: 'Food & Dining',
      source: 'auto_learned',
    }),
    null
  );

  // Reject itemized OCR receipt name even when alias differs
  assert.equal(
    learnOrStrengthenHabit({
      rawInputOrMerchant: 'AEON (Sushi x3, Green Tea x1)',
      aliasOrDescription: 'AEON Dinner',
      category: 'Food & Dining',
      source: 'auto_learned',
    }),
    null
  );

  // Reject >36 char rawPattern for auto_learned
  assert.equal(
    learnOrStrengthenHabit({
      rawInputOrMerchant: 'Very Long Registered Merchant Sdn Bhd Enterprise',
      aliasOrDescription: 'Dinner',
      category: 'Food & Dining',
      source: 'auto_learned',
    }),
    null
  );

  // Accept concise colloquial alias pair
  const learnedAlias = learnOrStrengthenHabit({
    rawInputOrMerchant: 'TAN CHIN HONG',
    aliasOrDescription: '四夕豆花',
    category: 'Food & Dining',
    source: 'auto_learned',
  });
  assert.ok(learnedAlias);
  assert.equal(learnedAlias.rawPattern, 'TAN CHIN HONG');
  assert.equal(learnedAlias.preferredAlias, '四夕豆花');

  // Auto-learning never overwrites a manual rule's preferredAlias or learnedSource
  const strengthenedManual = learnOrStrengthenHabit({
    rawInputOrMerchant: 'Shell',
    aliasOrDescription: 'Shell Station',
    category: 'Transport',
    source: 'auto_learned',
  });
  assert.ok(strengthenedManual);
  assert.equal(strengthenedManual.learnedSource, 'manual');
  assert.equal(strengthenedManual.preferredAlias, 'Shell 汽油');
  } finally {
    globalThis.window = prevWindow;
    globalThis.localStorage = prevStorage;
    globalThis.Event = prevEvent;
  }
});

function withMockStorage(fn) {
  const store = new Map();
  const prevWindow = globalThis.window;
  const prevStorage = globalThis.localStorage;
  const prevEvent = globalThis.Event;
  globalThis.window = { dispatchEvent() {} };
  globalThis.Event = globalThis.Event || class Event { constructor(t) { this.type = t; } };
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
  try {
    fn(store);
  } finally {
    globalThis.window = prevWindow;
    globalThis.localStorage = prevStorage;
    globalThis.Event = prevEvent;
  }
}

test('6. observeHabitCandidate rejects noise/redundant defaults and stages new habits until repeated', () => {
  withMockStorage((store) => {
    localStorage.setItem('cashflow_habit_memory', JSON.stringify([]));
    localStorage.setItem('cashflow_merchant_category_rules', JSON.stringify([]));

    // Generic nouns, qty-prefixed line items, and embedded prices are rejected outright
    assert.equal(isEligibleHabitMerchant('sushi'), false);
    assert.equal(isEligibleHabitMerchant('lunch'), false);
    assert.equal(isEligibleHabitMerchant('3x Salmon Sushi'), false);
    assert.equal(isEligibleHabitMerchant('Shell 60'), false);
    assert.equal(isRedundantCategoryMapping('Sushi King', 'Sushi King', 'Food & Dining'), true);

    assert.equal(
      observeHabitCandidate({
        rawInputOrMerchant: 'sushi',
        aliasOrDescription: 'sushi',
        category: 'Food & Dining',
      }).candidateCount,
      0
    );

    assert.equal(
      observeHabitCandidate({
        rawInputOrMerchant: 'Sushi King',
        aliasOrDescription: 'Sushi King',
        category: 'Food & Dining',
      }).candidateCount,
      0
    );

    // Non-obvious payee alias stages on occurrence #1 without writing to active memories
    const pass1 = observeHabitCandidate({
      rawInputOrMerchant: 'TAN CHIN HONG',
      aliasOrDescription: '四夕豆花',
      category: 'Food & Dining',
      amount: 12.5,
    });
    assert.equal(pass1.promoted, false);
    assert.equal(pass1.candidateCount, 1);
    assert.equal(getHabitMemories().length, 0);

    // Sporadic different alias resets candidate instead of promoting noisy rule
    const mismatch = observeHabitCandidate({
      rawInputOrMerchant: 'TAN CHIN HONG',
      aliasOrDescription: 'Something Else',
      category: 'Other',
      amount: 9,
    });
    assert.equal(mismatch.promoted, false);
    assert.equal(mismatch.candidateCount, 1);

    // Repeated consistent alias promotes at count === 2
    observeHabitCandidate({
      rawInputOrMerchant: 'TAN CHIN HONG',
      aliasOrDescription: '四夕豆花',
      category: 'Food & Dining',
      amount: 12.5,
    });
    const pass2 = observeHabitCandidate({
      rawInputOrMerchant: 'TAN CHIN HONG',
      aliasOrDescription: '四夕豆花',
      category: 'Food & Dining',
      amount: 13.0,
    });
    assert.equal(pass2.promoted, true);
    assert.ok(pass2.habit);
    assert.equal(pass2.habit.rawPattern, 'TAN CHIN HONG');
    assert.equal(pass2.habit.preferredAlias, '四夕豆花');
    assert.equal(pass2.habit.learnedSource, 'auto_learned');
    assert.equal(getHabitMemories().length, 1);
    assert.ok(store.has('cashflow_habit_candidates'));

    // Non-obvious category override (BookXcess -> Education) also promotes cleanly after 2 repeats
    const book1 = observeHabitCandidate({
      rawInputOrMerchant: 'BookXcess',
      aliasOrDescription: 'BookXcess',
      category: 'Education',
      amount: 45,
    });
    assert.equal(book1.promoted, false);
    const book2 = observeHabitCandidate({
      rawInputOrMerchant: 'BookXcess',
      aliasOrDescription: 'BookXcess',
      category: 'Education',
      amount: 60,
    });
    assert.equal(book2.promoted, true);
    assert.equal(book2.habit?.learnedSource, 'user_confirmed');
  });
});

test('7. getHabitMemories purges polluted user_confirmed & habit_rule_* legacy bloat and clearNonManualHabits preserves manual rules', () => {
  withMockStorage(() => {
    const legacyBloatedHabits = [
      {
        id: 'habit_old_sushi_uc',
        rawPattern: 'sushi',
        preferredAlias: 'sushi',
        category: 'Food & Dining',
        frequency: 2,
        confidence: 0.9,
        learnedSource: 'user_confirmed',
        createdAt: '2026-10-01T00:00:00Z',
        updatedAt: '2026-10-01T00:00:00Z',
      },
      {
        id: 'habit_old_redundant_1shot',
        rawPattern: "McDonald's",
        preferredAlias: "McDonald's",
        category: 'Food & Dining',
        frequency: 1,
        confidence: 0.75,
        learnedSource: 'user_confirmed',
        createdAt: '2026-10-01T00:00:00Z',
        updatedAt: '2026-10-01T00:00:00Z',
      },
      {
        id: 'habit_rule_itemized',
        rawPattern: 'AEON (Sushi x3, Green Tea)',
        preferredAlias: 'AEON',
        category: 'Food & Dining',
        frequency: 3,
        confidence: 0.9,
        learnedSource: 'manual',
        createdAt: '2026-10-01T00:00:00Z',
        updatedAt: '2026-10-01T00:00:00Z',
      },
      {
        id: 'habit_kept_zanmai',
        rawPattern: 'Sushi Zanmai',
        preferredAlias: 'Sushi Zanmai',
        category: 'Food & Dining',
        frequency: 2,
        confidence: 0.9,
        learnedSource: 'user_confirmed',
        createdAt: '2026-10-01T00:00:00Z',
        updatedAt: '2026-10-01T00:00:00Z',
      },
      {
        id: 'habit_kept_alias',
        rawPattern: 'abc',
        preferredAlias: 'zapfan',
        category: 'Food & Dining',
        frequency: 3,
        confidence: 0.95,
        learnedSource: 'auto_learned',
        createdAt: '2026-10-01T00:00:00Z',
        updatedAt: '2026-10-01T00:00:00Z',
      },
      ...DEFAULT_HABIT_MEMORIES,
    ];

    const legacyMirror = legacyBloatedHabits.map((h) => ({
      id: h.id,
      merchantPattern: h.rawPattern,
      category: h.category,
      createdAt: h.createdAt,
      updatedAt: h.updatedAt,
    }));

    localStorage.setItem('cashflow_habit_memory', JSON.stringify(legacyBloatedHabits));
    localStorage.setItem('cashflow_merchant_category_rules', JSON.stringify(legacyMirror));

    const cleaned = getHabitMemories();
    assert.equal(cleaned.some((h) => h.rawPattern === 'sushi'), false);
    assert.equal(cleaned.some((h) => h.rawPattern === "McDonald's"), false);
    assert.equal(cleaned.some((h) => h.id === 'habit_rule_itemized'), false);
    assert.equal(cleaned.some((h) => h.rawPattern === 'Sushi Zanmai'), true);
    assert.equal(cleaned.some((h) => h.rawPattern === 'abc'), true);
    assert.equal(cleaned.some((h) => h.rawPattern === 'Shell'), true);

    const { removed, remaining } = clearNonManualHabits();
    assert.equal(removed, 2);
    assert.equal(remaining.every((h) => h.learnedSource === 'manual'), true);
    assert.equal(remaining.some((h) => h.rawPattern === 'Shell'), true);
  });
});

test('8. Respects explicit empty list vs uninitialized null storage', () => {
  withMockStorage(() => {
    // Uninitialized (null) returns starters
    assert.equal(getHabitMemories().length, DEFAULT_HABIT_MEMORIES.length);

    // Explicit empty array stays empty rather than resurrecting defaults
    localStorage.setItem('cashflow_habit_memory', JSON.stringify([]));
    localStorage.setItem('cashflow_merchant_category_rules', JSON.stringify([]));
    assert.deepEqual(getHabitMemories(), []);
  });
});

test('9. matchHabitMemory & parseNaturalExpense resolve keywords, compact names, and CJK brand stems without false positives', () => {
  withMockStorage(() => {
    const memories = [
      {
        id: 'h_tan',
        rawPattern: 'TAN CHIN HONG',
        preferredAlias: '四夕豆花',
        category: 'Food & Dining',
        keywords: ['tnh'],
        frequency: 4,
        confidence: 0.95,
        learnedSource: 'auto_learned',
        createdAt: '2026-10-01T00:00:00Z',
        updatedAt: '2026-10-20T00:00:00Z',
      },
      {
        id: 'h_zanmai',
        rawPattern: 'Sushi Zanmai',
        preferredAlias: 'Sushi Zanmai',
        category: 'Food & Dining',
        keywords: ['zanmai'],
        frequency: 3,
        confidence: 0.9,
        learnedSource: 'user_confirmed',
        createdAt: '2026-10-01T00:00:00Z',
        updatedAt: '2026-10-20T00:00:00Z',
      },
      {
        id: 'h_shell_store',
        rawPattern: 'Shell Select Store',
        preferredAlias: 'Shell Select Store',
        category: 'Shopping',
        frequency: 2,
        confidence: 0.9,
        learnedSource: 'manual',
        createdAt: '2026-10-01T00:00:00Z',
        updatedAt: '2026-10-20T00:00:00Z',
      },
      ...DEFAULT_HABIT_MEMORIES,
    ];
    localStorage.setItem('cashflow_habit_memory', JSON.stringify(memories));
    localStorage.setItem('cashflow_merchant_category_rules', JSON.stringify([]));

    // 1. Explicit keyword match ("zanmai 45") resolves full merchant
    const pZanmai = parseNaturalExpense('zanmai 45');
    assert.ok(pZanmai);
    assert.equal(pZanmai.amount, 45);
    assert.equal(pZanmai.description, 'Sushi Zanmai');
    assert.equal(pZanmai.category, 'Food & Dining');
    assert.equal(pZanmai.habitMatch?.matchedVia, 'keyword');
    assert.equal(pZanmai.habitMatch?.matchedToken, 'zanmai');

    // 2. Space-collapsed match ("tanchinhong 12")
    const pCompact = parseNaturalExpense('tanchinhong 12');
    assert.ok(pCompact);
    assert.equal(pCompact.amount, 12);
    assert.equal(pCompact.description, '四夕豆花');
    assert.equal(pCompact.habitMatch?.matchedVia, 'compact');

    // 3. Distinctive CJK brand stem ("四夕 13")
    const pStem = parseNaturalExpense('四夕 13');
    assert.ok(pStem);
    assert.equal(pStem.description, '四夕豆花');
    assert.equal(pStem.habitMatch?.matchedVia, 'stem');
    assert.equal(pStem.habitMatch?.matchedToken, '四夕');

    // 4. Generic suffix ("豆花 12") or unrelated words must NOT false-match TAN CHIN HONG
    assert.equal(matchHabitMemory('豆花 12', memories), null);
    assert.equal(matchHabitMemory('Random Unknown Store', memories), null);

    // 5. Specificity still beats shorter match
    const pSpecific = matchHabitMemory('Shell Select Store Mid Valley', memories);
    assert.ok(pSpecific);
    assert.equal(pSpecific.matchedPattern, 'Shell Select Store');
    assert.equal(pSpecific.resolvedCategory, 'Shopping');

    const pPetrol = matchHabitMemory('Shell Petrol Station Bangsar', memories);
    assert.ok(pPetrol);
    assert.equal(pPetrol.matchedPattern, 'Shell');
    assert.equal(pPetrol.resolvedCategory, 'Transport');

    // 6. Keyword sanitizer blocks generic nouns for AI suggestions but preserves manual keywords
    const aiKeywords = sanitizeHabitKeywords(['zanmai', 'sushi', 'lunch', '汽油', '豆花', 'sushizanmai'], {
      source: 'ai',
      rawPattern: 'Sushi Zanmai',
      preferredAlias: 'Sushi Zanmai',
    });
    assert.deepEqual(aiKeywords, ['zanmai', 'sushizanmai']);

    const manualKeywords = sanitizeHabitKeywords(['豆花', '四夕'], {
      source: 'manual',
      rawPattern: 'TAN CHIN HONG',
      preferredAlias: '四夕豆花',
    });
    assert.deepEqual(manualKeywords, ['豆花', '四夕']);
  });
});

