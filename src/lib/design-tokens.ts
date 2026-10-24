/**
 * Centralized Design Tokens for CashFlow
 * Consistent colors, typography metrics, and category accents across the entire application.
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

export function getCategoryColor(category: string): string {
  return CATEGORY_COLORS[category] || '#6b7280';
}

export function getCategoryEmoji(category: string): string {
  return CATEGORY_EMOJIS[category] || '📦';
}
