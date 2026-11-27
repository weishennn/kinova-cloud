'use client';

import React from 'react';
import { motion } from 'framer-motion';

export interface SegmentedTabItem<T extends string> {
  id: T;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  badge?: string;
  badgeTone?: 'emerald' | 'rose' | 'amber' | 'neutral';
}

interface SegmentedTabsProps<T extends string> {
  items: ReadonlyArray<SegmentedTabItem<T>>;
  value: T;
  onChange: (value: T) => void;
  layoutId: string;
  ariaLabel?: string;
  className?: string;
}

export function SegmentedTabs<T extends string>({
  items,
  value,
  onChange,
  layoutId,
  ariaLabel,
  className = '',
}: SegmentedTabsProps<T>) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={`relative inline-flex items-center gap-1 rounded-2xl bg-black/[0.04] dark:bg-white/[0.05] p-1 border border-black/[0.06] dark:border-white/[0.08] ${className}`}
    >
      {items.map((item) => {
        const Icon = item.icon;
        const isActive = value === item.id;
        const badgeCls =
          item.badgeTone === 'rose'
            ? 'bg-rose-500/15 text-rose-700 dark:text-rose-400'
            : item.badgeTone === 'amber'
            ? 'bg-amber-500/15 text-amber-800 dark:text-amber-300'
            : item.badgeTone === 'emerald'
            ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
            : 'bg-black/[0.06] dark:bg-white/[0.1] text-muted-foreground';

        return (
          <button
            key={item.id}
            role="tab"
            type="button"
            aria-selected={isActive}
            onClick={() => onChange(item.id)}
            className={`relative z-10 inline-flex items-center gap-1.5 min-h-[38px] px-3.5 sm:px-4 py-1.5 rounded-xl text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap touch-manipulation ${
              isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {isActive && (
              <motion.div
                layoutId={layoutId}
                className="absolute inset-0 rounded-xl bg-white dark:bg-zinc-900 shadow-sm border border-black/[0.06] dark:border-white/[0.1] pointer-events-none"
                transition={{ type: 'spring', stiffness: 460, damping: 34 }}
              />
            )}
            {Icon && <Icon className="relative z-10 h-3.5 w-3.5 shrink-0" />}
            <span className="relative z-10">{item.label}</span>
            {item.badge && (
              <span className={`relative z-10 text-[10px] font-mono px-1.5 py-0.5 rounded-full ${badgeCls}`}>
                {item.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
