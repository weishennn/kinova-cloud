/**
 * Centralized Design Tokens for CashFlow
 * Consistent colors, typography metrics, spacing, and surface tokens across the entire application.
 */

export const CATEGORY_COLORS: Record<string, string> = {
  'Food & Dining': '#C23B38',
  'Food': '#C23B38',
  'Transport': '#C96A22',
  'Stay & Hotel': '#1F6F8B',
  'Flights': '#0284C7',
  'Shopping': '#B8862D',
  'Housing & Bills': '#2E5B88',
  'Housing': '#2E5B88',
  'Parents': '#B84A6A',
  'Parents Allowance': '#B84A6A',
  'Entertainment': '#6D5A8F',
  'Health': '#B84A6A',
  'Insurance': '#1F6F8B',
  'Education': '#0D6E52',
  'Sport': '#0EA5E9',
  'Gift': '#B84A6A',
  'Salary': '#0D7A58',
  'Claim Allowance': '#1F6F8B',
  'Allowance': '#1F6F8B',
  'Investment': '#0D6E52',
  'Stocks & Crypto': '#0D6E52',
  'Fixed Deposit': '#094D39',
  'ASNB / Unit Trust': '#2E5B88',
  'EPF / KWSP': '#1F6F8B',
  'Emergency Savings': '#0D7A58',
  'Other': '#6B7280',
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
    'rounded-2xl bg-[var(--cockpit-surface)] border border-[var(--cockpit-line)] p-5 sm:p-6 shadow-[0_1px_3px_rgba(18,20,23,0.04)]',
  groupedSurface:
    'rounded-2xl bg-[var(--cockpit-surface)] border border-[var(--cockpit-line)] overflow-hidden shadow-[0_1px_3px_rgba(18,20,23,0.04)]',
  groupedListDivide: 'divide-y divide-[var(--cockpit-line)]',
  groupedRowItem: 'px-5 py-4 transition-colors hover:bg-[var(--cockpit-surface-soft)]',
  subtlePill:
    'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium bg-[var(--cockpit-surface-soft)] text-[var(--cockpit-muted)] border border-[var(--cockpit-line)]',
} as const;

export function getCategoryColor(category: string): string {
  return CATEGORY_COLORS[category] || '#6b7280';
}

export function getCategoryEmoji(category: string): string {
  return CATEGORY_EMOJIS[category] || '📦';
}
