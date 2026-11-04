/**
 * Centralized Design Tokens for CashFlow
 * Consistent colors, typography metrics, spacing, and surface tokens across the entire application.
 */

export const CATEGORY_COLORS: Record<string, string> = {
  'Food & Dining': '#ef4444',
  'Food': '#ef4444',
  'Transport': '#f97316',
  'Stay & Hotel': '#7c3aed',
  'Flights': '#0284c7',
  'Shopping': '#f59e0b',
  'Housing & Bills': '#3b82f6',
  'Housing': '#3b82f6',
  'Parents': '#ec4899',
  'Parents Allowance': '#ec4899',
  'Entertainment': '#8b5cf6',
  'Health': '#ec4899',
  'Insurance': '#0284c7',
  'Education': '#14b8a6',
  'Sport': '#0ea5e9',
  'Gift': '#ec4899',
  'Salary': '#10b981',
  'Claim Allowance': '#06b6d4',
  'Allowance': '#06b6d4',
  'Investment': '#6366f1',
  'Stocks & Crypto': '#6366f1',
  'Fixed Deposit': '#4f46e5',
  'ASNB / Unit Trust': '#7c3aed',
  'EPF / KWSP': '#0284c7',
  'Emergency Savings': '#059669',
  'Other': '#6b7280',
};

export const CATEGORY_EMOJIS: Record<string, string> = {
  'Food & Dining': '🍔',
  'Food': '🍔',
  'Transport': '🚗',
  'Stay & Hotel': '🏨',
  'Flights': '✈️',
  'Shopping': '🛍️',
  'Housing & Bills': '🏠',
  'Housing': '🏠',
  'Parents': '👨‍👩‍👧',
  'Parents Allowance': '👨‍👩‍👧',
  'Insurance': '🛡️',
  'Entertainment': '🎬',
  'Health': '🏥',
  'Education': '📚',
  'Sport': '🏸',
  'Gift': '🎁',
  'Salary': '💰',
  'Claim Allowance': '🧾',
  'Allowance': '🧾',
  'Freelance': '💻',
  'Investment Return': '📈',
  'Gift & Bonus': '🎁',
  'Fixed Deposit': '🔒',
  'ASNB / Unit Trust': '📈',
  'EPF / KWSP': '🏛️',
  'Emergency Savings': '🛡️',
  'Other Savings': '📦',
  'Other': '📦',
};

export const ASSET_TYPE_COLORS: Record<string, string> = {
  'US Stock': '#3b82f6',
  'MY Stock': '#10b981',
  'Crypto': '#f59e0b',
  'ETF': '#8b5cf6',
  'Unit Trust': '#ec4899',
  'Other': '#6b7280',
};

/**
 * Standardized Layout & Surface Tokens to eliminate "box-sticking-to-box" clutter.
 * Use `groupedSurface` + `groupedListDivide` for lists (categories, transactions, holdings)
 * instead of rendering separate bordered boxes for every single item.
 */
export const LAYOUT_TOKENS = {
  pageContainer: 'max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-7',
  sectionGap: 'space-y-6',
  gridGap: 'gap-4 sm:gap-5',
  cardSurface:
    'rounded-3xl bg-white/95 dark:bg-zinc-900/90 border border-zinc-200/60 dark:border-zinc-800/70 p-5 sm:p-6 shadow-[0_2px_12px_-4px_rgba(0,0,0,0.04)]',
  groupedSurface:
    'rounded-3xl bg-white/95 dark:bg-zinc-900/90 border border-zinc-200/60 dark:border-zinc-800/70 overflow-hidden shadow-[0_2px_12px_-4px_rgba(0,0,0,0.04)]',
  groupedListDivide: 'divide-y divide-zinc-100 dark:divide-zinc-800/60',
  groupedRowItem: 'px-5 py-4 transition-colors hover:bg-zinc-50/70 dark:hover:bg-zinc-800/40',
  subtlePill:
    'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium bg-zinc-100/80 dark:bg-zinc-800/80 text-zinc-700 dark:text-zinc-300',
} as const;

export function getCategoryColor(category: string): string {
  return CATEGORY_COLORS[category] || '#6b7280';
}

export function getCategoryEmoji(category: string): string {
  return CATEGORY_EMOJIS[category] || '📦';
}
