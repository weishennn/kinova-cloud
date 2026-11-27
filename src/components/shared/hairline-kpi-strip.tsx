'use client';

import React from 'react';

export interface KpiMetricItem {
  label: string;
  value: React.ReactNode;
  sublabel?: React.ReactNode;
  tone?: 'default' | 'emerald' | 'rose' | 'amber' | 'gold';
}

interface HairlineKpiStripProps {
  items: KpiMetricItem[];
  ariaLabel?: string;
}

const TONE_CLASS: Record<NonNullable<KpiMetricItem['tone']>, string> = {
  default: 'text-foreground',
  emerald: 'text-emerald-700 dark:text-emerald-400',
  rose: 'text-rose-700 dark:text-rose-400',
  amber: 'text-amber-700 dark:text-amber-400',
  gold: 'text-[#B8862D] dark:text-[#E5B85C]',
};

export function HairlineKpiStrip({ items, ariaLabel = 'Summary metrics' }: HairlineKpiStripProps) {
  const colsClass =
    items.length === 3
      ? 'sm:grid-cols-3'
      : items.length === 2
      ? 'sm:grid-cols-2'
      : 'sm:grid-cols-2 lg:grid-cols-4';

  return (
    <section
      aria-label={ariaLabel}
      className="rounded-3xl border border-black/[0.07] dark:border-white/[0.08] bg-card overflow-hidden"
    >
      <div className={`grid grid-cols-1 ${colsClass} gap-px bg-black/[0.06] dark:bg-white/[0.06]`}>
        {items.map((item) => (
          <div
            key={item.label}
            className="bg-card p-5 sm:p-6 flex flex-col justify-between gap-2 min-w-0"
          >
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {item.label}
            </span>
            <div
              className={`text-2xl sm:text-[26px] font-bold font-mono tabular-nums tracking-tight truncate ${
                TONE_CLASS[item.tone || 'default']
              }`}
            >
              {item.value}
            </div>
            {item.sublabel && (
              <div className="text-xs text-muted-foreground truncate">{item.sublabel}</div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
