'use client';

import { ArrowLeft, ArrowRight, CalendarDays, ChevronDown, RotateCcw } from 'lucide-react';
import {
  buildPeriodCatalog,
  formatPeriodDisplay,
  stepPeriod,
} from '@/lib/period-helper';

interface PeriodBarProps {
  selectedMonth: string;
  onSelectMonth: (next: string) => void;
  sheetMonths?: string[];
  transactions?: Array<{ date?: string }>;
  selectId?: string;
  selectAriaLabel?: string;
}

export function PeriodBar({
  selectedMonth,
  onSelectMonth,
  sheetMonths = [],
  transactions = [],
  selectId = 'kinova-period-select',
  selectAriaLabel = 'Select month or year',
}: PeriodBarProps) {
  const { currentMonth, currentMonthShort, currentYearStr, orderedYears, months } = buildPeriodCatalog(
    sheetMonths,
    selectedMonth,
    transactions
  );

  const periodKind = selectedMonth === 'all' ? 'all' : selectedMonth.startsWith('year-') ? 'year' : 'month';

  return (
    <div className="cockpit-period-row !py-0">
      <div className="cockpit-period-tabs" role="group" aria-label="Period type">
        <button
          type="button"
          className={periodKind === 'month' ? 'is-active' : ''}
          aria-pressed={periodKind === 'month'}
          onClick={() => {
            if (selectedMonth.startsWith('year-')) {
              const yr = selectedMonth.slice(5);
              onSelectMonth(yr === currentYearStr ? currentMonth : `${yr}-01`);
            } else {
              onSelectMonth(currentMonth);
            }
          }}
        >
          Month
        </button>
        <button
          type="button"
          className={periodKind === 'year' ? 'is-active' : ''}
          aria-pressed={periodKind === 'year'}
          onClick={() => {
            const yr = /^\d{4}-\d{2}$/.test(selectedMonth) ? selectedMonth.slice(0, 4) : currentYearStr;
            onSelectMonth(`year-${yr}`);
          }}
        >
          Year
        </button>
        <button
          type="button"
          className={periodKind === 'all' ? 'is-active' : ''}
          aria-pressed={periodKind === 'all'}
          onClick={() => onSelectMonth('all')}
        >
          All time
        </button>
      </div>

      <div className="cockpit-period-select-wrap">
        <div className="cockpit-period-arrows">
          <button
            type="button"
            className="cockpit-period-arrow"
            aria-label="Previous period"
            onClick={() => onSelectMonth(stepPeriod(selectedMonth, -1, currentMonth))}
          >
            <ArrowLeft size={15} />
          </button>
          <button
            type="button"
            className="cockpit-period-arrow"
            aria-label="Next period"
            onClick={() => onSelectMonth(stepPeriod(selectedMonth, 1, currentMonth))}
          >
            <ArrowRight size={15} />
          </button>
        </div>

        <label className="cockpit-period-select-label" htmlFor={selectId}>
          <CalendarDays size={14} />
          <select
            id={selectId}
            aria-label={selectAriaLabel}
            value={selectedMonth}
            onChange={(event) => onSelectMonth(event.target.value)}
          >
            {orderedYears.map((year) => {
              const yearLabel =
                year === currentYearStr
                  ? `${year} (Current Year)`
                  : Number(year) === Number(currentYearStr) - 1
                    ? `${year} (Last Year)`
                    : Number(year) === Number(currentYearStr) + 1
                      ? `${year} (Next Year)`
                      : year;
              return (
                <optgroup key={year} label={yearLabel}>
                  <option value={`year-${year}`}>{year} full year</option>
                  {months
                    .filter((month) => month.startsWith(year))
                    .map((month) => (
                      <option key={month} value={month}>
                        {month === currentMonth ? `${formatPeriodDisplay(month)} (Current)` : formatPeriodDisplay(month)}
                      </option>
                    ))}
                </optgroup>
              );
            })}
            <option value="all">All time</option>
          </select>
          <ChevronDown size={14} className="cockpit-period-chevron" />
        </label>

        {selectedMonth !== currentMonth && (
          <button
            type="button"
            onClick={() => onSelectMonth(currentMonth)}
            className="cockpit-current-jump-btn"
            title={`Jump back to current month (${formatPeriodDisplay(currentMonth)})`}
            aria-label={`Jump back to current month (${formatPeriodDisplay(currentMonth)})`}
          >
            <RotateCcw size={13} className="cockpit-current-jump-icon" />
            <span className="cockpit-current-jump-text">
              <span className="hidden sm:inline">{currentMonthShort} (Current)</span>
              <span className="sm:hidden">{currentMonthShort}</span>
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
