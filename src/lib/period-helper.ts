/**
 * Shared period selection utilities for Kinova across Home Cockpit,
 * Flow (/transactions), Budget (/budget), and Analytics (/analytics).
 */

export function getCurrentYearMonth(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function stepPeriod(
  selectedMonth: string,
  direction: -1 | 1,
  currentMonth: string = getCurrentYearMonth()
): string {
  if (!selectedMonth || selectedMonth === 'all') {
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

export function formatPeriodDisplay(period: string, locale: string = 'en-MY'): string {
  if (!period || period === 'all') return 'All time';
  if (period.startsWith('year-')) {
    return `${period.slice(5)} full year`;
  }
  const [year, month] = period.split('-').map(Number);
  if (!year || !month || Number.isNaN(year) || Number.isNaN(month)) {
    return period;
  }
  return new Date(year, month - 1, 1).toLocaleString(locale, { month: 'long', year: 'numeric' });
}

export function formatShortMonth(period: string, locale: string = 'en-MY'): string {
  if (!/^\d{4}-\d{2}$/.test(period)) return 'Current';
  const [year, month] = period.split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleString(locale, { month: 'short' });
}

export interface PeriodCatalog {
  currentMonth: string;
  currentMonthShort: string;
  currentYearStr: string;
  orderedYears: string[];
  months: string[];
}

export function buildPeriodCatalog(
  sheetMonths: string[] = [],
  selectedMonth?: string,
  transactions: Array<{ date?: string }> = []
): PeriodCatalog {
  const currentMonth = getCurrentYearMonth();
  const [curYear] = currentMonth.split('-').map(Number);
  const currentYearStr = String(curYear);
  const activeYears = new Set<number>([curYear - 1, curYear, curYear + 1]);

  sheetMonths.forEach((m) => {
    if (/^\d{4}-\d{2}$/.test(m)) activeYears.add(Number(m.slice(0, 4)));
  });

  transactions.forEach((t) => {
    if (t.date && /^\d{4}-\d{2}/.test(t.date)) {
      activeYears.add(Number(t.date.slice(0, 4)));
    }
  });

  if (selectedMonth?.startsWith('year-')) {
    const y = Number(selectedMonth.slice(5));
    if (Number.isFinite(y) && y >= 2000 && y <= 2100) activeYears.add(y);
  } else if (selectedMonth && /^\d{4}-\d{2}$/.test(selectedMonth)) {
    const y = Number(selectedMonth.slice(0, 4));
    if (Number.isFinite(y) && y >= 2000 && y <= 2100) activeYears.add(y);
  }

  const monthSet = new Set<string>([currentMonth]);
  activeYears.forEach((yr) => {
    for (let m = 1; m <= 12; m += 1) {
      monthSet.add(`${yr}-${String(m).padStart(2, '0')}`);
    }
  });

  const months = Array.from(monthSet).sort((a, b) => b.localeCompare(a));
  const orderedYears = Array.from(activeYears)
    .map(String)
    .sort((a, b) => {
      if (a === currentYearStr) return -1;
      if (b === currentYearStr) return 1;
      return b.localeCompare(a);
    });

  return {
    currentMonth,
    currentMonthShort: formatShortMonth(currentMonth),
    currentYearStr,
    orderedYears,
    months,
  };
}
