import test from 'node:test';
import assert from 'node:assert/strict';

import { routeLocalIntent, isQuestionOrAdviceRequest } from '../src/lib/intent-router.ts';

const mockProfile = {
  language: 'auto',
  paydayDay: null,
  suggestedPayday: null,
  monthlyBudgetCap: null,
  baselineIncome: null,
  emergencyReserve: null,
  goals: [],
  rejectedChips: [],
  recentActions: [
    {
      id: 'act_1',
      actionType: 'record',
      targetType: 'transaction',
      timestamp: Date.now() - 5000,
      summary: 'Shell 60.00 (Transport)',
      payload: { amount: 60, category: 'Transport', description: 'Shell' },
    },
  ],
};

const TODAY = '2026-10-29';

test('routeLocalIntent handles undo in multiple languages', () => {
  for (const phrase of ['undo', '撤回', '记错了', 'padam', 'tak jadi', 'cancel last']) {
    const res = routeLocalIntent(phrase, mockProfile, TODAY);
    assert.ok(res, `Failed on ${phrase}`);
    assert.equal(res.mode, 'undo');
    assert.equal(res.actionToUndo?.id, 'act_1');
  }
});

test('routeLocalIntent handles repeat in multiple languages', () => {
  for (const phrase of ['same again', '一样', '跟昨天一样', 'sama macam semalam', '再来一笔']) {
    const res = routeLocalIntent(phrase, mockProfile, TODAY);
    assert.ok(res, `Failed on ${phrase}`);
    assert.equal(res.mode, 'repeat');
    assert.equal(res.baseAction?.id, 'act_1');
    assert.equal(res.targetDate, TODAY);
  }
});

test('routeLocalIntent handles amount corrections', () => {
  for (const phrase of ['not 15, 18', '不是15是18', 'bukan 15, tapi 18', '改去 18']) {
    const res = routeLocalIntent(phrase, mockProfile, TODAY);
    assert.ok(res, `Failed on ${phrase}`);
    assert.equal(res.mode, 'correct');
    assert.equal(res.patch.amount, 18);
  }
});

test('routeLocalIntent handles category corrections', () => {
  const res1 = routeLocalIntent('that was food not transport', mockProfile, TODAY);
  assert.ok(res1);
  assert.equal(res1.mode, 'correct');
  assert.equal(res1.patch.category, 'Food & Dining');

  const res2 = routeLocalIntent('那是餐饮不是交通', mockProfile, TODAY);
  assert.ok(res2);
  assert.equal(res2.mode, 'correct');
  assert.equal(res2.patch.category, 'Food & Dining');
});

test('routeLocalIntent sets preferences for payday, budget, and alias', () => {
  const paydayRes = routeLocalIntent('payday is the 28th', mockProfile, TODAY);
  assert.ok(paydayRes);
  assert.equal(paydayRes.mode, 'set_preference');
  assert.equal(paydayRes.preference.key, 'paydayDay');
  assert.equal(paydayRes.preference.value, 28);

  const budgetRes = routeLocalIntent('预算 3000', mockProfile, TODAY);
  assert.ok(budgetRes);
  assert.equal(budgetRes.mode, 'set_preference');
  assert.equal(budgetRes.preference.key, 'monthlyBudgetCap');
  assert.equal(budgetRes.preference.value, 3000);

  const aliasRes = routeLocalIntent('call abc zapfan', mockProfile, TODAY);
  assert.ok(aliasRes);
  assert.equal(aliasRes.mode, 'set_preference');
  assert.equal(aliasRes.preference.key, 'alias');
  assert.deepEqual(aliasRes.preference.value, { rawPattern: 'abc', alias: 'zapfan' });
});

test('routeLocalIntent handles navigation intents', () => {
  const nav1 = routeLocalIntent('go to budget', mockProfile, TODAY);
  assert.ok(nav1);
  assert.equal(nav1.mode, 'navigate');
  assert.equal(nav1.path, '/budget');

  const nav2 = routeLocalIntent('打开投资', mockProfile, TODAY);
  assert.ok(nav2);
  assert.equal(nav2.mode, 'navigate');
  assert.equal(nav2.path, '/investments');

  const nav3 = routeLocalIntent('what kinova knows', mockProfile, TODAY);
  assert.ok(nav3);
  assert.equal(nav3.mode, 'navigate');
  assert.equal(nav3.path, '/settings#kinova-knows');
});

test('routeLocalIntent fast paths clear simple expenses as Quick parse', () => {
  const expenseRes = routeLocalIntent('Shell 60', mockProfile, TODAY);
  assert.ok(expenseRes);
  assert.equal(expenseRes.mode, 'quick_parse');
  assert.equal(expenseRes.label, 'Quick parse');
  assert.equal(expenseRes.command.data.amount, 60);
});

test('routeLocalIntent delegates questions and advice to Gemini (returns null)', () => {
  assert.equal(routeLocalIntent('should I buy this iPhone?', mockProfile, TODAY), null);
  assert.equal(routeLocalIntent('怎么看这笔支出', mockProfile, TODAY), null);
  assert.equal(routeLocalIntent('can I afford dinner?', mockProfile, TODAY), null);
  assert.equal(routeLocalIntent('哪家超市比较便宜', mockProfile, TODAY), null);
  assert.equal(routeLocalIntent('这笔有扣税吗？', mockProfile, TODAY), null);
});
