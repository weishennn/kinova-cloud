import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanPayeeOrMerchantPattern,
  matchHabitMemory,
  learnOrStrengthenHabit,
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
