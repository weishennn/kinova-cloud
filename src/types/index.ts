export * from './transaction';
export * from './investment';
export * from './sheet';
export * from './invoice';
export * from './trip';
export * from './tax';

// Category types
export interface Category {
  id: string;
  name: string;
  type: 'Income' | 'Expense';
  icon: string;
  color: string;
  parentCategory?: string;
  [key: string]: unknown;
}

// Payment method
export type PaymentMethod = 'Cash' | 'DebitCard' | 'CreditCard' | 'BankTransfer' | 'EWallet' | 'Other';

// Currency
export interface CurrencyRate {
  from: string;
  to: string;
  rate: number;
  lastUpdated: string;
}

// Budget
export interface Budget {
  id: string;
  category: string;
  monthlyLimit: number;
  currentSpent: number;
  percentage: number;
  rollover: boolean;
}

// Dashboard widget
export interface DashboardWidget {
  id: string;
  type: 'summary' | 'chart' | 'list' | 'progress';
  title: string;
  data: unknown;
}
