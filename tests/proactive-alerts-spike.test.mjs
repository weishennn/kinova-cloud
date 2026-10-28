import test from 'node:test';
import assert from 'node:assert/strict';

import { generateProactiveAlerts } from '../src/lib/proactive-alerts.ts';

test('generateProactiveAlerts calculates category spike against true trailing days', () => {
  // Current month: October 2026 (day 10). Category 'Shopping' spent RM 500 in 10 days = RM 50/day.
  // Trailing 3 months (July, August, September): total 92 days.
  // In July: Shopping RM 300.
  // In August: Shopping RM 0.
  // In September: Shopping RM 0.
  // Total trailing shopping: RM 300 across 92 days = RM 3.26/day.
  // Current pace (RM 50/day) is > 1.35x hist pace -> should trigger category spike alert!

  const currentMonthExpenses = [
    { id: 'tx_c1', date: '2026-10-02', amount: 250, currency: 'MYR', type: 'expense', category: 'Shopping' },
    { id: 'tx_c2', date: '2026-10-08', amount: 250, currency: 'MYR', type: 'expense', category: 'Shopping' },
  ];

  const historicalExpenses = [
    { id: 'tx_h1', date: '2026-07-15', amount: 300, currency: 'MYR', type: 'expense', category: 'Shopping' },
  ];

  const allTransactions = [...currentMonthExpenses, ...historicalExpenses];

  const alerts = generateProactiveAlerts(allTransactions, undefined, '2026-10-10');

  const spikeAlert = alerts.find((a) => a.type === 'category_spike' && a.actionCategory === 'Shopping');
  assert.ok(spikeAlert, 'Should trigger Shopping category spike alert');
  assert.ok(spikeAlert.explanation.includes('Shopping'));
});
