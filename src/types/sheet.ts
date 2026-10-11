/**
 * Dynamic sheet schema types - the core of adaptive functionality
 */
export interface SheetSchema {
  sheetName: string;
  headers: string[];
  rowCount: number;
}

export interface SheetData {
  schema: SheetSchema;
  rows: Record<string, unknown>[];
}

export interface SheetRow {
  _rowIndex: number; // Internal row index for updates/deletes
  [key: string]: unknown;
}

export interface AppSettings {
  defaultCurrency: string;
  taxCountry: string;
  theme: 'dark' | 'light' | 'system';
  language: 'en' | 'zh' | 'bilingual';
  [key: string]: unknown;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}
