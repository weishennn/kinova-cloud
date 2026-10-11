/**
 * Invoice types
 */
export interface Invoice {
  id: string;
  fileId: string; // Google Drive file ID
  fileName: string;
  mimeType: string;
  thumbnailUrl?: string;
  downloadUrl: string;
  date: string;
  category: string;
  amount: number;
  currency: string;
  vendor: string;
  notes?: string;
  tags?: string[];
  uploadedAt: string;
}

export interface InvoiceFilters {
  dateFrom?: string;
  dateTo?: string;
  category?: string;
  vendor?: string;
  amountMin?: number;
  amountMax?: number;
  search?: string;
}
