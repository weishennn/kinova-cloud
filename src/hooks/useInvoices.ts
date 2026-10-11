import { useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSheetData, useDeleteRow } from './useSheets';
import { driveApi } from '@/lib/sheets-api';

export interface Invoice {
  id: string;
  date: string;
  vendor: string;
  amount: number | string;
  status: 'paid' | 'unpaid';
  due_date: string;
  url: string;
}

export function useInvoices(filters?: { status?: string }) {
  const { data, isLoading, error } = useSheetData('Invoices');

  const invoices = useMemo(() => {
    if (!data?.rows) return [];
    let filtered = data.rows as unknown as Invoice[];
    
    if (filters?.status) {
      filtered = filtered.filter(i => i.status === filters.status);
    }
    
    return filtered.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  }, [data?.rows, filters]);

  return { invoices, isLoading, error };
}

export function useUploadInvoice() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async ({ file, fileName, mimeType }: { file: string; fileName: string; mimeType: string }) => {
      // 1. Upload to Drive
      const driveRes = await driveApi.uploadFile(fileName, mimeType, file);
      if (!driveRes.success) throw new Error('Failed to upload to Drive');
      
      return driveRes.data;
    },
    onSuccess: () => {
      // Typically you'd then use useAddRow('Invoices') to record the URL
      queryClient.invalidateQueries({ queryKey: ['sheet', 'Invoices'] });
    }
  });
}

export function useDeleteInvoice() {
  const mutation = useDeleteRow();
  return {
    ...mutation,
    mutate: (args: { rowIndex: number }) =>
      mutation.mutate({ sheetName: 'Invoices', ...args }),
    mutateAsync: (args: { rowIndex: number }) =>
      mutation.mutateAsync({ sheetName: 'Invoices', ...args }),
  };
}
