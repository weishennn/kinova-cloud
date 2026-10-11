import { useMemo } from 'react';
import { useSheetData, useAddRow } from './useSheets';
import { convertCurrency } from '@/lib/currency';

export interface Investment {
  id: string;
  name: string;
  type: string;
  current_value: number | string;
  cost_basis: number | string;
  currency: string;
  last_updated: string;
}

export function useInvestments() {
  const { data, isLoading, error } = useSheetData('Investments');

  const investments = useMemo(() => {
    if (!data?.rows) return [];
    return data.rows as unknown as Investment[];
  }, [data?.rows]);

  return { investments, isLoading, error };
}

export function usePortfolioSummary() {
  const { investments, isLoading } = useInvestments();

  const summary = useMemo(() => {
    let totalValue = 0;
    let totalCost = 0;

    investments.forEach(inv => {
      const val = typeof inv.current_value === 'string' ? parseFloat(inv.current_value) : inv.current_value;
      const cost = typeof inv.cost_basis === 'string' ? parseFloat(inv.cost_basis) : inv.cost_basis;
      const currency = inv.currency || 'MYR';
      
      totalValue += convertCurrency(val || 0, currency, 'MYR');
      totalCost += convertCurrency(cost || 0, currency, 'MYR');
    });

    const unrealizedGain = totalValue - totalCost;
    const returnPercentage = totalCost > 0 ? (unrealizedGain / totalCost) * 100 : 0;

    return {
      totalValue,
      totalCost,
      unrealizedGain,
      returnPercentage,
    };
  }, [investments]);

  return { summary, isLoading };
}

export function useAddInvestment() {
  const mutation = useAddRow();
  return {
    ...mutation,
    mutate: (rowData: Record<string, unknown>) =>
      mutation.mutate({ sheetName: 'Investments', rowData }),
    mutateAsync: (rowData: Record<string, unknown>) =>
      mutation.mutateAsync({ sheetName: 'Investments', rowData }),
  };
}
