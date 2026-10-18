export type AiIntent = 'transaction' | 'installment' | 'trade' | 'trip' | 'unknown';

export interface AiTransactionData {
  amount: number;
  currency: string;
  type: 'Expense' | 'Income' | 'Investment';
  category: string;
  description: string;
  date: string;
  subtotal?: number | null;
  taxAmount?: number | null;
  taxRate?: number | null;
  taxIncluded?: boolean;
  taxLabel?: string;
  taxes?: Array<{ label: string; rate?: number | null; amount?: number | null }>;
  discountAmount?: number | null;
  dealsDescription?: string | null;
  billAmount?: number | null;
  notes?: string;
}

export interface AiReceiptItem {
  name: string;
  amount: number;
  quantity?: number;
  unitPrice?: number;
  brand?: string;
  productType?: string;
  qtyReconciled?: string;
  category?: string;
}

export interface AiInstallmentData {
  name: string;
  totalPrincipal: number;
  currency: string;
  category: string;
  tenureMonths: number;
  annualInterestRate: number;
  startDate: string;
  tripTag?: string;
  notes?: string;
}

export interface AiTradeData {
  action: 'BUY' | 'SELL' | 'DIVIDEND' | 'REINVEST';
  ticker: string;
  assetName?: string;
  assetType?: string;
  quantity?: number | null;
  price?: number | null;
  fees?: number | null;
  currency: string;
  date: string;
  notes?: string;
  isReinvested?: boolean;
}

export interface AiTripData {
  name: string;
  destination?: string;
  startDate: string;
  endDate?: string;
  budget?: number | null;
  currency: string;
  rateToMyr?: number | null;
  description?: string;
}

type AiCommandMeta = {
  confidence: number;
  missingFields?: string[];
  model?: string;
};

export type AiCommand =
  | ({ intent: 'transaction'; data: AiTransactionData } & AiCommandMeta)
  | ({ intent: 'installment'; data: AiInstallmentData } & AiCommandMeta)
  | ({ intent: 'trade'; data: AiTradeData } & AiCommandMeta)
  | ({ intent: 'trip'; data: AiTripData } & AiCommandMeta)
  | ({ intent: 'unknown'; data: null } & AiCommandMeta);

export type AiPrefill =
  | {
      kind: 'transaction';
      data: AiTransactionData;
      receipt?: { dataUrl: string; fileName: string; mimeType: string };
      receiptItems?: Array<AiReceiptItem & { includedInExpense?: boolean }>;
    }
  | { kind: 'installment'; data: AiInstallmentData }
  | { kind: 'trade'; data: AiTradeData }
  | { kind: 'trip'; data: AiTripData };
