import { useMemo } from 'react';
import { useSheetData, useAddRow, useUpdateRow } from './useSheets';
import { useTransactions } from './useTransactions';

export interface Trip {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  budget: number | string;
  currency: string;
  status: 'planned' | 'active' | 'completed';
}

export function useTrips() {
  const { data, isLoading, error } = useSheetData('Trips');

  const trips = useMemo(() => {
    if (!data?.rows) return [];
    return data.rows as unknown as Trip[];
  }, [data?.rows]);

  return { trips, isLoading, error };
}

export function useTripSummary(tripId: string) {
  const { trips } = useTrips();
  // Filter transactions by trip ID (if supported by schema)
  // For demo, we just get all and filter manually
  const { transactions } = useTransactions();

  const summary = useMemo(() => {
    const trip = trips.find(t => t.id === tripId);
    if (!trip) return null;

    // Filter transactions associated with this trip
    // Note: Assuming Transaction model has tripId
    const tripTxs = transactions.filter(t => t.tripId === tripId);
    
    let totalSpent = 0;
    tripTxs.forEach(t => {
      if (t.type === 'expense') {
        const amt = typeof t.amount === 'string' ? parseFloat(t.amount) : t.amount;
        totalSpent += amt || 0;
      }
    });

    const budget = typeof trip.budget === 'string' ? parseFloat(trip.budget) : trip.budget;

    return {
      trip,
      totalSpent,
      budget,
      remaining: budget - totalSpent,
      percentageUsed: budget > 0 ? (totalSpent / budget) * 100 : 0,
    };
  }, [trips, transactions, tripId]);

  return { summary };
}

export function useAddTrip() {
  const mutation = useAddRow();
  return {
    ...mutation,
    mutate: (rowData: Record<string, unknown>) =>
      mutation.mutate({ sheetName: 'Trips', rowData }),
    mutateAsync: (rowData: Record<string, unknown>) =>
      mutation.mutateAsync({ sheetName: 'Trips', rowData }),
  };
}

export function useUpdateTrip() {
  const mutation = useUpdateRow();
  return {
    ...mutation,
    mutate: (args: { rowIndex: number; rowData: Record<string, unknown> }) =>
      mutation.mutate({ sheetName: 'Trips', ...args }),
    mutateAsync: (args: { rowIndex: number; rowData: Record<string, unknown> }) =>
      mutation.mutateAsync({ sheetName: 'Trips', ...args }),
  };
}
