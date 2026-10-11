/**
 * Tax types
 */
export interface TaxBracket {
  min: number;
  max: number | null; // null = no upper limit
  rate: number; // percentage
  cumulativeTax: number; // tax at bottom of this bracket
}

export interface TaxRelief {
  id: string;
  name: string;
  nameZh?: string;
  maxAmount: number;
  description: string;
  category: string;
}

export interface TaxCalculation {
  grossIncome: number;
  totalReliefs: number;
  chargeableIncome: number;
  taxPayable: number;
  effectiveRate: number;
  monthlyPCB: number; // Monthly tax deduction
  bracketBreakdown: {
    bracket: TaxBracket;
    taxableInBracket: number;
    taxForBracket: number;
  }[];
  reliefsUsed: {
    relief: TaxRelief;
    amount: number;
  }[];
}

export interface TaxConfig {
  country: string;
  year: number;
  brackets: TaxBracket[];
  reliefs: TaxRelief[];
}
