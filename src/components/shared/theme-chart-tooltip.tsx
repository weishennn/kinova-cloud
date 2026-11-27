'use client';

import React from 'react';

interface ThemeChartTooltipProps {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; color?: string }>;
  label?: string;
  currencyPrefix?: string;
}

export function ThemeChartTooltip({
  active,
  payload,
  label,
  currencyPrefix = 'RM\u00A0',
}: ThemeChartTooltipProps) {
  if (!active || !payload?.length) return null;

  return (
    <div className="rounded-2xl border border-black/[0.08] dark:border-white/[0.12] bg-white/95 dark:bg-zinc-950/95 px-3.5 py-2.5 shadow-xl backdrop-blur-md">
      {label && (
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
          {label}
        </p>
      )}
      <div className="space-y-1">
        {payload.map((entry, idx) => (
          <div key={`${entry.name || 'val'}-${idx}`} className="flex items-center justify-between gap-4 text-xs">
            {entry.name && (
              <span className="text-muted-foreground font-medium">{entry.name}</span>
            )}
            <span className="font-mono font-bold tabular-nums text-foreground">
              {currencyPrefix}
              {Number(entry.value || 0).toLocaleString('en-MY', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
