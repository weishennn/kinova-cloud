import type { Transaction } from './transaction';

/**
 * Trip types
 */
export type TripStatus = 'Planning' | 'Active' | 'Completed';

export interface Trip {
  id: string;
  tripName: string;
  startDate: string;
  endDate: string;
  budget: number;
  currency: string;
  status: TripStatus;
  description?: string;
  [key: string]: unknown;
}

export interface TripExpense {
  transaction: Transaction; // from transaction.ts
  convertedAmount: number; // Amount in trip's base currency
  exchangeRate: number;
}

export interface TripSummary {
  trip: Trip;
  totalSpent: number;
  budgetRemaining: number;
  budgetUsedPercent: number;
  expensesByCategory: { category: string; amount: number; percentage: number }[];
  dailySpending: { date: string; amount: number }[];
}
