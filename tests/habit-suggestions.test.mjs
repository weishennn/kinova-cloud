import test from 'node:test';
import assert from 'node:assert/strict';

import { mineUserHabitSuggestions } from '../src/lib/habit-suggestions.ts';

test('mineUserHabitSuggestions returns default fallback when user has fewer than 3 expenses', () => {
  const transactions = [
    { id: '1', date: '2026-10-20', type: 'expense', amount: 15, description: 'Lunch' },
  ];

  const chips = mineUserHabitSuggestions(transactions, 12);
  assert.ok(chips.length > 0);
  assert.equal(chips[0].isPersonalized, undefined);
});

test('mineUserHabitSuggestions returns ONLY user habits and NEVER default fallback when >= 3 expenses exist', () => {
  const transactions = [
    { id: '1', date: '2026-10-20', type: 'expense', amount: 14, category: 'Food & Dining', description: 'Village Grocer Chicken' },
    { id: '2', date: '2026-10-21', type: 'expense', amount: 15, category: 'Food & Dining', description: 'Village Grocer Chicken' },
    { id: '3', date: '2026-10-22', type: 'expense', amount: 16, category: 'Food & Dining', description: 'Village Grocer Chicken' },
    { id: '4', date: '2026-10-23', type: 'expense', amount: 60, category: 'Transport', description: 'Shell Petrol' },
  ];

  const chips = mineUserHabitSuggestions(transactions, 12);
  assert.ok(chips.length > 0);
  // Every chip must be personalized
  for (const chip of chips) {
    assert.equal(chip.isPersonalized, true);
    assert.notEqual(chip.text, 'Breakfast 12');
    assert.notEqual(chip.text, 'Lunch 15');
  }

  // Check median calculation for Village Grocer: [14, 15, 16] -> median 15
  const vgChip = chips.find((c) => c.text.includes('Village Grocer Chicken'));
  assert.ok(vgChip);
  assert.equal(vgChip.actionPayload?.amount, 15);
  assert.equal(vgChip.actionPayload?.category, 'Food & Dining');
});

test('mineUserHabitSuggestions suppresses rejected chips for 30 days', () => {
  const now = Date.now();
  const transactions = [
    { id: '1', date: '2026-10-20', type: 'expense', amount: 15, category: 'Food & Dining', description: 'Mamak Rice' },
    { id: '2', date: '2026-10-21', type: 'expense', amount: 15, category: 'Food & Dining', description: 'Mamak Rice' },
    { id: '3', date: '2026-10-22', type: 'expense', amount: 15, category: 'Food & Dining', description: 'Mamak Rice' },
    { id: '4', date: '2026-10-23', type: 'expense', amount: 60, category: 'Transport', description: 'Shell Petrol' },
  ];

  const rejectedChips = [
    { text: 'Mamak Rice 15', rejectedAt: now - 1000 },
  ];

  const chips = mineUserHabitSuggestions(transactions, 12, false, rejectedChips, now);
  const mamak = chips.find((c) => c.text.includes('Mamak Rice'));
  assert.equal(mamak, undefined, 'Mamak Rice chip should be suppressed because it was rejected recently');
});
