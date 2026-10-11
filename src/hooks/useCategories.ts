import { useMemo } from 'react';
import { useSheetData, useAddRow, useUpdateRow, useDeleteRow } from './useSheets';

export interface Category {
  id: string;
  name: string;
  type: 'income' | 'expense';
  icon: string;
  color: string;
}

export function useCategories() {
  const { data, isLoading, error } = useSheetData('Categories');

  const categories = useMemo(() => {
    if (!data?.rows) return [];
    return data.rows as unknown as Category[];
  }, [data?.rows]);

  return { categories, isLoading, error };
}

export function useCategoriesByType(type: 'income' | 'expense') {
  const { categories, isLoading } = useCategories();

  const filtered = useMemo(() => {
    return categories.filter(c => c.type === type);
  }, [categories, type]);

  return { categories: filtered, isLoading };
}

export function useAddCategory() {
  const mutation = useAddRow();
  return {
    ...mutation,
    mutate: (rowData: Record<string, unknown>) =>
      mutation.mutate({ sheetName: 'Categories', rowData }),
    mutateAsync: (rowData: Record<string, unknown>) =>
      mutation.mutateAsync({ sheetName: 'Categories', rowData }),
  };
}

export function useUpdateCategory() {
  const mutation = useUpdateRow();
  return {
    ...mutation,
    mutate: (args: { rowIndex: number; rowData: Record<string, unknown> }) =>
      mutation.mutate({ sheetName: 'Categories', ...args }),
    mutateAsync: (args: { rowIndex: number; rowData: Record<string, unknown> }) =>
      mutation.mutateAsync({ sheetName: 'Categories', ...args }),
  };
}

export function useDeleteCategory() {
  const mutation = useDeleteRow();
  return {
    ...mutation,
    mutate: (args: { rowIndex: number }) =>
      mutation.mutate({ sheetName: 'Categories', ...args }),
    mutateAsync: (args: { rowIndex: number }) =>
      mutation.mutateAsync({ sheetName: 'Categories', ...args }),
  };
}
