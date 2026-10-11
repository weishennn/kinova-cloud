/**
 * Date utility helpers that operate strictly in local timezone (not UTC).
 * 
 * Prevents timezone bugs where `new Date().toISOString().split('T')[0]` 
 * returns yesterday's date in any timezone ahead of UTC (e.g. UTC+8 Malaysia/Singapore/China
 * between 00:00 and 08:00 AM).
 */

/**
 * Returns a date formatted as 'YYYY-MM-DD' in local timezone.
 */
export function getLocalDateString(d: Date = new Date()): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Returns a month string formatted as 'YYYY-MM' in local timezone.
 */
export function getLocalMonthString(d: Date = new Date()): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * Returns the exact number of calendar days in a given month (1-12) of a year.
 * Accurately handles leap years (February 29 vs 28) and 30-day months (April, June, Sept, Nov).
 */
export function getDaysInMonth(year: number, month: number): number {
  if (isNaN(year) || isNaN(month) || month < 1 || month > 12) return 31;
  return new Date(year, month, 0).getDate();
}

/**
 * Normalizes and clamps any date string ('YYYY-MM-DD', 'YYYY/MM/DD', etc.)
 * to a strictly valid calendar date.
 * If day exceeds the month's maximum days (e.g. Sept 31 -> Sept 30, Feb 30 -> Feb 28/29),
 * it clamps the day to the last valid day of that month.
 */
export function normalizeDateString(dateStr: string, fallbackDate: Date = new Date()): string {
  if (!dateStr || typeof dateStr !== 'string') return getLocalDateString(fallbackDate);
  const trimmed = dateStr.trim();

  // Format: YYYY-MM-DD or YYYY/MM/DD or DD-MM-YYYY / DD/MM/YYYY
  const parts = trimmed.split(/[-/]/).map(Number);
  if (parts.length === 3 && !isNaN(parts[0]) && !isNaN(parts[1]) && !isNaN(parts[2])) {
    let year = parts[0];
    let month = parts[1];
    let day = parts[2];

    // If format is DD-MM-YYYY or MM-DD-YYYY
    if (parts[2] >= 1000 && parts[0] <= 31) {
      year = parts[2];
      month = parts[1];
      day = parts[0];
    }

    if (month < 1) month = 1;
    if (month > 12) month = 12;

    const maxDays = getDaysInMonth(year, month);
    const clampedDay = Math.max(1, Math.min(day, maxDays));

    const yStr = String(year).padStart(4, '0');
    const mStr = String(month).padStart(2, '0');
    const dStr = String(clampedDay).padStart(2, '0');
    return `${yStr}-${mStr}-${dStr}`;
  }

  const parsed = new Date(trimmed);
  if (isNaN(parsed.getTime())) {
    return getLocalDateString(fallbackDate);
  }
  return getLocalDateString(parsed);
}

/**
 * Safely shifts a Date by N months, preserving the day-of-month if possible,
 * but safely clamping to the maximum day of the target month if the target month has fewer days.
 * E.g. Aug 31 + 1 month -> Sept 30 (never rolls over into Oct 1).
 * Jan 31 + 1 month -> Feb 28 or 29 (never rolls over into March 3).
 */
export function shiftMonthSafe(baseDate: Date, monthsOffset: number): Date {
  const currentYear = baseDate.getFullYear();
  const currentMonth = baseDate.getMonth(); // 0-indexed
  const currentDay = baseDate.getDate();

  const totalMonths = currentMonth + monthsOffset;
  const targetYear = currentYear + Math.floor(totalMonths / 12);
  const targetMonth = ((totalMonths % 12) + 12) % 12; // 0-indexed 0..11

  const maxDaysInTarget = getDaysInMonth(targetYear, targetMonth + 1);
  const safeDay = Math.min(currentDay, maxDaysInTarget);

  return new Date(targetYear, targetMonth, safeDay);
}

/**
 * Safely parses a 'YYYY-MM-DD' date string into a local Date object.
 * Native `new Date('YYYY-MM-DD')` is parsed as UTC midnight in JavaScript,
 * which can cause day shifts when queried in non-UTC timezones.
 * Also clamps invalid days (e.g. 9/31 -> Sept 30) to prevent unwanted rollover.
 */
export function parseLocalDate(dateStr: string): Date {
  if (!dateStr) return new Date();
  const normalized = normalizeDateString(dateStr);
  const parts = normalized.split(/[-/]/).map(Number);
  if (parts.length >= 3 && !isNaN(parts[0]) && !isNaN(parts[1]) && !isNaN(parts[2])) {
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }
  return new Date(dateStr);
}

/**
 * Returns a date relative to base date by offset in days in 'YYYY-MM-DD' local format.
 * E.g. getRelativeDateString(-1) returns yesterday's local date.
 */
export function getRelativeDateString(daysOffset: number, baseDate: Date = new Date()): string {
  const d = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + daysOffset);
  return getLocalDateString(d);
}

/**
 * Calculates start and end dates ('YYYY-MM-DD') for a given month or year string.
 * - 'YYYY-MM' -> from 1st of month to last day of month
 * - 'year-YYYY' -> from YYYY-01-01 to YYYY-12-31
 * - 'all' or empty -> current month
 */
export function getMonthDateRange(targetStr?: string): { from: string; to: string } {
  if (!targetStr || targetStr === 'all') {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth() + 1;
    const padM = String(m).padStart(2, '0');
    const lastDay = new Date(y, m, 0).getDate();
    return {
      from: `${y}-${padM}-01`,
      to: `${y}-${padM}-${String(lastDay).padStart(2, '0')}`,
    };
  }

  if (targetStr.startsWith('year-')) {
    const y = targetStr.replace('year-', '');
    return {
      from: `${y}-01-01`,
      to: `${y}-12-31`,
    };
  }

  const [yStr, mStr] = targetStr.split('-');
  const y = parseInt(yStr, 10);
  const m = parseInt(mStr, 10);
  if (isNaN(y) || isNaN(m)) {
    return getMonthDateRange();
  }

  const padM = String(m).padStart(2, '0');
  const lastDay = new Date(y, m, 0).getDate();
  return {
    from: `${y}-${padM}-01`,
    to: `${y}-${padM}-${String(lastDay).padStart(2, '0')}`,
  };
}
