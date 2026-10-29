import test from 'node:test';
import assert from 'node:assert/strict';

import { generateProactiveAlerts } from '../src/lib/proactive-alerts.ts';

test('generateProactiveAlerts calculates category spike against active months only (not all 92 days)', () => {
  // Current month: October 2026 (day 10).
  // Trailing months: July (31 days), August (31 days), September (30 days).
  // In July: Shopping spent RM 300 (31 days).
  // In August: Shopping spent RM 0.
  // In September: Shopping spent RM 0.
  // With active-month calculation: Shopping denominator is 31 days (July only), histDailyPace = 300 / 31 = 9.68 RM/day.
  // Under the old bug (92 days), histDailyPace would be 300 / 92 = 3.26 RM/day.

  const historicalExpenses = [
    { id: 'tx_h1', date: '2026-07-15', amount: 300, currency: 'MYR', type: 'expense', category: 'Shopping' },
  ];

  // Case 1: Real spike (RM 500 in 10 days = RM 50/day > 9.68 * 1.35 = 13.06 RM/day) -> triggers alert
  const spikeExpenses = [
    { id: 'tx_c1', date: '2026-10-02', amount: 250, currency: 'MYR', type: 'expense', category: 'Shopping' },
    { id: 'tx_c2', date: '2026-10-08', amount: 250, currency: 'MYR', type: 'expense', category: 'Shopping' },
    ...historicalExpenses,
  ];

  const spikeAlerts = generateProactiveAlerts(spikeExpenses, undefined, '2026-10-10');
  const spikeAlert = spikeAlerts.find((a) => a.type === 'category_spike' && a.actionCategory === 'Shopping');
  assert.ok(spikeAlert, 'Should trigger Shopping category spike alert');
  assert.ok(spikeAlert.explanation.includes('31 天'), `Explanation should cite 31 active days: ${spikeAlert.explanation}`);

  // Case 2: Moderate spending (RM 120 in 10 days = RM 12/day < 13.06 RM/day)
  // Under the old 92-day bug (3.26 RM/day), 12/day would have falsely triggered. With active months (9.68 RM/day), it must NOT trigger!
  const normalExpenses = [
    { id: 'tx_c3', date: '2026-10-03', amount: 60, currency: 'MYR', type: 'expense', category: 'Shopping' },
    { id: 'tx_c4', date: '2026-10-07', amount: 60, currency: 'MYR', type: 'expense', category: 'Shopping' },
    ...historicalExpenses,
  ];

  const normalAlerts = generateProactiveAlerts(normalExpenses, undefined, '2026-10-10');
  const falseSpikeAlert = normalAlerts.find((a) => a.type === 'category_spike' && a.actionCategory === 'Shopping');
  assert.equal(falseSpikeAlert, undefined, 'Should NOT trigger false spike when spending is below active-month baseline');
});
