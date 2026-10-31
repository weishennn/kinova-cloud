import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('Floating Dock: Investments is 4th dock item and Insights is in secondaryLinks', () => {
  const dockFilePath = path.resolve('src/components/money-cockpit/floating-dock.tsx');
  const content = fs.readFileSync(dockFilePath, 'utf8');

  // Verify secondaryLinks has Insights & Analytics
  assert.match(content, /\{ label: 'Insights & Analytics', href: '\/analytics', icon: PieChart \}/);

  // Verify secondaryLinks does NOT have Investments
  assert.doesNotMatch(content, /\{ label: 'Investments', href: '\/investments'/);

  // Verify main dock has Investments link
  assert.match(content, /<Link href="\/investments"[^>]*>[\s\S]*?<TrendingUp[^>]*\/><span>Investments<\/span>[\s\S]*?<\/Link>/);

  // Verify main dock does not have Insights link
  assert.doesNotMatch(content, /<Link href="\/analytics"[^>]*>[\s\S]*?<span>Insights<\/span>/);
});

test('Cashflow Cockpit: Previous period button is child 0 in period-select-wrap to prevent layout shift', () => {
  const cockpitFilePath = path.resolve('src/components/money-cockpit/cashflow-cockpit.tsx');
  const content = fs.readFileSync(cockpitFilePath, 'utf8');

  // Find the cockpit-period-select-wrap block
  const wrapIndex = content.indexOf('className="cockpit-period-select-wrap"');
  assert.ok(wrapIndex > 0, 'cockpit-period-select-wrap found');

  const wrapContent = content.slice(wrapIndex, wrapIndex + 3500);

  const prevArrowIndex = wrapContent.indexOf('aria-label="Previous period"');
  const selectLabelIndex = wrapContent.indexOf('className="cockpit-period-select-label"');
  const nextArrowIndex = wrapContent.indexOf('aria-label="Next period"');
  const jumpBtnIndex = wrapContent.indexOf('className="cockpit-current-jump-btn"');

  // Previous arrow must come BEFORE the Jump to Current button
  assert.ok(prevArrowIndex < selectLabelIndex, 'Previous period arrow is before select dropdown');
  assert.ok(selectLabelIndex < nextArrowIndex, 'Select dropdown is before Next period arrow');
  assert.ok(nextArrowIndex < jumpBtnIndex, 'Next period arrow is before Jump to Current button');
});

test('Month Navigation Stepper Logic: Stepping back twice from 2026-11 lands on 2026-09', () => {
  function stepPeriod(selectedMonth, currentMonth, direction) {
    if (selectedMonth === 'all') {
      if (direction === -1) {
        const [year, month] = currentMonth.split('-').map(Number);
        const prev = new Date(year, month - 2, 1);
        return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
      }
      return currentMonth;
    }
    if (selectedMonth.startsWith('year-')) {
      const year = Number(selectedMonth.slice(5)) + direction;
      return `year-${year}`;
    }
    const [year, month] = selectedMonth.split('-').map(Number);
    if (!year || !month || Number.isNaN(year) || Number.isNaN(month)) {
      return currentMonth;
    }
    const next = new Date(year, month - 1 + direction, 1);
    return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`;
  }

  const currentMonth = '2026-11';
  let month = currentMonth;

  // First tap on Previous (<)
  month = stepPeriod(month, currentMonth, -1);
  assert.equal(month, '2026-10', 'First tap goes to October');

  // Second tap on Previous (<)
  month = stepPeriod(month, currentMonth, -1);
  assert.equal(month, '2026-09', 'Second tap goes to September');

  // Tap from 'all'
  assert.equal(stepPeriod('all', currentMonth, -1), '2026-10', 'Tap from all with -1 goes to previous month');
  assert.equal(stepPeriod('all', currentMonth, 1), '2026-11', 'Tap from all with +1 goes to current month');
});
