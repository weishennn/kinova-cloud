import test from 'node:test';
import assert from 'node:assert/strict';

import {
  summarizeLedgerPatternsForHabitOptimization,
  validateHabitOptimizationPlan,
  applyHabitOptimizationPlan,
} from '../src/lib/habit-optimizer.ts';

test('1. summarizeLedgerPatternsForHabitOptimization aggregates recurring merchants and skips noise/generic items', () => {
  const existingHabits = [
    {
      id: 'h_shell',
      rawPattern: 'Shell',
      preferredAlias: 'Shell 汽油',
      category: 'Transport',
      keywords: ['fuelsave', 'shellstation'],
      frequency: 5,
      confidence: 1,
      learnedSource: 'manual',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ];

  const txs = [
    { id: '1', type: 'expense', category: 'Food & Dining', description: '四夕豆花', notes: '[转账给: TAN CHIN HONG]', amount: 12 },
    { id: '2', type: 'expense', category: 'Food & Dining', description: '四夕豆花', notes: '[转账给: TAN CHIN HONG]', amount: 14 },
    { id: '3', type: 'expense', category: 'Food & Dining', description: 'Sushi Zanmai', amount: 45 },
    { id: '4', type: 'expense', category: 'Food & Dining', description: 'Sushi Zanmai', amount: 52 },
    // Generic single-word food items must be skipped
    { id: '5', type: 'expense', category: 'Food & Dining', description: 'sushi', amount: 18 },
    { id: '6', type: 'expense', category: 'Food & Dining', description: 'sushi', amount: 19 },
    // Income must be skipped
    { id: '7', type: 'income', category: 'Salary', description: 'Company Payroll', amount: 5000 },
    { id: '8', type: 'income', category: 'Salary', description: 'Company Payroll', amount: 5000 },
    // Itemized OCR string must be skipped
    { id: '9', type: 'expense', category: 'Food & Dining', description: 'AEON (Salmon Sushi x2, Tea x1)', amount: 30 },
    { id: '10', type: 'expense', category: 'Food & Dining', description: 'AEON (Salmon Sushi x2, Tea x1)', amount: 32 },
  ];

  const summary = summarizeLedgerPatternsForHabitOptimization(txs, existingHabits);
  assert.equal(summary.some((s) => s.rawPattern === 'TAN CHIN HONG' && s.sampleDescription === '四夕豆花'), true);
  assert.equal(summary.some((s) => s.rawPattern === 'Sushi Zanmai' && s.count === 2), true);
  assert.equal(summary.some((s) => s.rawPattern.toLowerCase() === 'sushi'), false);
  assert.equal(summary.some((s) => s.rawPattern === 'Company Payroll'), false);
  assert.equal(summary.some((s) => s.rawPattern.includes('Salmon Sushi')), false);
});

test('2. validateHabitOptimizationPlan protects manual rules, filters generic keywords, and blocks noisy AI additions', () => {
  const habits = [
    {
      id: 'h_manual_shell',
      rawPattern: 'Shell',
      preferredAlias: 'Shell 汽油',
      category: 'Transport',
      frequency: 5,
      confidence: 1,
      learnedSource: 'manual',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
    {
      id: 'h_auto_junk',
      rawPattern: 'QuickLunch',
      preferredAlias: 'QuickLunch',
      category: 'Food & Dining',
      frequency: 1,
      confidence: 0.7,
      learnedSource: 'user_confirmed',
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
    },
    {
      id: 'h_tan_1',
      rawPattern: 'TAN CHIN HONG',
      preferredAlias: '四夕豆花',
      category: 'Food & Dining',
      frequency: 3,
      confidence: 0.9,
      learnedSource: 'auto_learned',
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
    },
    {
      id: 'h_tan_2',
      rawPattern: 'TAN CHIN HONG ENT',
      preferredAlias: '四夕豆花店',
      category: 'Food & Dining',
      frequency: 2,
      confidence: 0.85,
      learnedSource: 'auto_learned',
      createdAt: '2026-10-02T00:00:00Z',
      updatedAt: '2026-10-02T00:00:00Z',
    },
  ];

  const candidates = [
    {
      key: 'sushi zanmai',
      rawPattern: 'Sushi Zanmai',
      preferredAlias: 'Sushi Zanmai',
      category: 'Food & Dining',
      count: 1,
      timeSlot: 'dinner',
      firstSeenAt: '2026-10-01T00:00:00Z',
      lastSeenAt: '2026-10-10T00:00:00Z',
    },
  ];

  const rawAiPlan = {
    summary: '清理 1 条泛词规则、合并 2 条同商户变体，并为常规店铺补充触发字眼。',
    drops: [
      { id: 'h_manual_shell', reason: 'Attempted manual drop' }, // MUST be blocked
      { id: 'h_auto_junk', reason: '单次临时快餐词，无记忆价值' },
      { id: 'nonexistent', reason: 'Ghost ID' },
    ],
    merges: [
      {
        keepId: 'h_tan_1',
        removeIds: ['h_tan_2'],
        rawPattern: 'TAN CHIN HONG',
        preferredAlias: '四夕豆花',
        category: 'Food & Dining',
        keywords: ['四夕', '豆花', 'tanchinhong'], // "豆花" should be stripped because generic
        reason: '合并同一商户两笔记录',
      },
    ],
    updates: [
      {
        id: 'h_manual_shell',
        preferredAlias: 'Changed By AI', // manual preferredAlias should remain protected
        category: 'Transport',
        keywords: ['fuelsave', 'petrol', '汽油', 'shellstation'], // "petrol"/"汽油" stripped
        reason: '补充油站触发字眼',
      },
    ],
    additions: [
      // Rejected: generic noun
      {
        rawPattern: 'sushi',
        preferredAlias: 'sushi',
        category: 'Food & Dining',
        keywords: ['sushi'],
        reason: 'Too generic',
      },
      // Rejected: trivial 1-to-1 default without useful keywords
      {
        rawPattern: 'Sushi King',
        preferredAlias: 'Sushi King',
        category: 'Food & Dining',
        keywords: ['sushi'], // "sushi" gets stripped -> 0 keywords -> rejected
        reason: 'Redundant',
      },
      // Accepted: Sushi Zanmai with distinctive shorthand keyword "zanmai"
      {
        rawPattern: 'Sushi Zanmai',
        preferredAlias: 'Sushi Zanmai',
        category: 'Food & Dining',
        keywords: ['zanmai', 'sushi'],
        timeSlot: 'dinner',
        reason: '提炼高频简写字眼 zanmai',
      },
    ],
  };

  const validated = validateHabitOptimizationPlan(rawAiPlan, habits, candidates);
  assert.equal(validated.hasChanges, true);
  assert.deepEqual(validated.drops.map((d) => d.id), ['h_auto_junk']);
  assert.equal(validated.merges.length, 1);
  assert.deepEqual(validated.merges[0].keywords.includes('四夕'), true);
  assert.deepEqual(validated.merges[0].keywords.includes('tanchinhong'), true);
  assert.deepEqual(validated.merges[0].keywords.includes('豆花'), false);

  // Manual rule keeps user alias & gets clean non-generic keywords only
  assert.equal(validated.updates.length, 1);
  assert.equal(validated.updates[0].preferredAlias, 'Shell 汽油');
  assert.deepEqual(validated.updates[0].keywords, ['fuelsave', 'shellstation']);

  // Only Sushi Zanmai curated into additions with sanitized ["zanmai"] keyword and candidate key
  assert.equal(validated.additions.length, 1);
  assert.equal(validated.additions[0].rawPattern, 'Sushi Zanmai');
  assert.deepEqual(validated.additions[0].keywords, ['zanmai']);
  assert.equal(validated.additions[0].fromCandidateKey, 'sushi zanmai');

  // Apply plan cleanly
  const applied = applyHabitOptimizationPlan(habits, candidates, validated, '2026-10-30T00:00:00Z');
  assert.deepEqual(applied.stats, { dropped: 1, merged: 1, updated: 1, added: 1 });
  assert.equal(applied.nextCandidates.length, 0);
  assert.equal(applied.nextHabits.some((h) => h.id === 'h_auto_junk'), false);
  assert.equal(applied.nextHabits.some((h) => h.id === 'h_tan_2'), false);
  const mergedTan = applied.nextHabits.find((h) => h.id === 'h_tan_1');
  assert.ok(mergedTan);
  assert.equal(mergedTan.frequency, 5);
  assert.equal(mergedTan.keywords.includes('四夕'), true);
  assert.equal(applied.nextHabits.some((h) => h.rawPattern === 'Sushi Zanmai' && h.keywords?.includes('zanmai')), true);
});
