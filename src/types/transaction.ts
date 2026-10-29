/**
 * Transaction types
 */
export type TransactionType = 'Income' | 'Expense' | 'Investment';

export interface Transaction {
  id: string; // row index in sheet
  date: string; // ISO date
  type: TransactionType;
  category: string;
  subCategory?: string;
  amount: number;
  currency: string;
  paymentMethod?: string;
  notes?: string;
  tripTag?: string;
  invoiceLink?: string;
  isRecurring?: boolean;
  recurringFrequency?: 'daily' | 'weekly' | 'monthly' | 'yearly';
  [key: string]: unknown; // For dynamic/adaptive columns
}

export interface TransactionFilters {
  dateFrom?: string;
  dateTo?: string;
  type?: TransactionType;
  category?: string;
  tripTag?: string;
  search?: string;
}

export interface TransactionSummary {
  totalIncome: number;
  totalExpense: number;
  balance: number;
  savingsRate: number;
  dailyAverage: number;
  categoryBreakdown: { category: string; amount: number; percentage: number; color: string }[];
  monthlyTrend: { month: string; income: number; expense: number }[];
}
