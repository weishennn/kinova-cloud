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
  ticker: string;
  name: string;
  type: InvestmentType | string;
  currency: string;
  units: number;
  avgBuyPrice: number;
  avgBuyPriceBase: number;
  totalCost: number; // cost basis in original currency (e.g. USD)
  totalCostBase: number; // cost basis in MYR (what user actually paid)
  currentPrice: number;
  marketValue: number;
  marketValueBase: number;
  unrealizedPL: number;
  unrealizedPLBase: number;
  unrealizedPLPercent: number;
  realizedPL: number; // cumulative realized gain/loss in original currency
  realizedPLBase: number; // cumulative realized gain/loss in MYR
  totalPLBase: number; // unrealizedPLBase + realizedPLBase
  totalDividends?: number;
  totalDividendsBase?: number;
  currentFxRate: number;
  status: 'active' | 'closed';
  closedTradesCount?: number;
  totalHistoricalCostAsset?: number;
  totalHistoricalCostBase?: number;
  totalHistoricalProceedsAsset?: number;
  totalHistoricalProceedsBase?: number;
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
