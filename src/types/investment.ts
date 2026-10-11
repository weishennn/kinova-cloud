/**
 * Investment types
 */
export type InvestmentType = 'Stock' | 'Crypto' | 'UnitTrust' | 'FixedDeposit' | 'Bond' | 'RealEstate' | 'Other';
export type InvestmentAction = 'Buy' | 'Sell' | 'Dividend' | 'Interest';

export interface Investment {
  id: string;
  date: string;
  type: InvestmentType;
  name: string;
  action: InvestmentAction;
  quantity: number;
  price: number;
  fees: number;
  notes?: string;
  [key: string]: unknown;
}

export interface InvestmentHolding {
  name: string;
  type: InvestmentType;
  totalQuantity: number;
  avgBuyPrice: number;
  currentPrice: number;
  totalInvested: number;
  currentValue: number;
  unrealizedPL: number;
  unrealizedPLPercent: number;
  realizedPL: number;
}

export interface PortfolioSummary {
  totalInvested: number;
  currentValue: number;
  totalPL: number;
  totalPLPercent: number;
  holdings: InvestmentHolding[];
  allocationByType: { type: string; value: number; percentage: number; color: string }[];
  monthlyPerformance: { month: string; value: number; pl: number }[];
}
