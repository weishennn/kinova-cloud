import { getLocalDateString, normalizeDateString, parseLocalDate } from './date-helper.ts';
import type { AiTradeData } from '../types/ai-command.ts';

const VALID_TRADE_CURRENCIES = new Set(['USD', 'MYR', 'SGD', 'HKD', 'CNY', 'EUR', 'GBP', 'JPY']);
const VALID_TRADE_ACTIONS = new Set(['BUY', 'SELL', 'DIVIDEND', 'REINVEST']);

export interface RawTradeFeeBreakdown {
  commission?: number | null;
  platformFee?: number | null;
  secFee?: number | null;
  tafFee?: number | null;
  clearingFee?: number | null;
  tax?: number | null;
  otherFees?: number | null;
  [key: string]: unknown;
}

export interface ParsedTradePayload {
  action: 'BUY' | 'SELL' | 'DIVIDEND' | 'REINVEST';
  ticker: string;
  assetName: string;
  assetType: 'US Stock' | 'MY Stock' | 'ETF' | 'Crypto' | 'Unit Trust' | 'Other';
  quantity: number;
  price: number;
  fees: number;
  netTotal: number;
  currency: string;
  date: string;
  feeBreakdown?: RawTradeFeeBreakdown;
  notes: string;
  isReinvested?: boolean;
}

export function sanitizeTradeDate(value: unknown, fallbackToday?: string): string {
  if (typeof value !== 'string') return fallbackToday || getLocalDateString();
  const trimmed = value.trim();
  if (!trimmed) return fallbackToday || getLocalDateString();
  const normalized = normalizeDateString(trimmed);
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    const parsed = parseLocalDate(normalized);
    if (!Number.isNaN(parsed.getTime())) {
      return normalized;
    }
  }
  return fallbackToday || getLocalDateString();
}

export function sanitizeTradeCurrency(value: unknown, fallback: string = 'USD'): string {
  if (typeof value !== 'string') return fallback;
  const upper = value.trim().toUpperCase();
  if (VALID_TRADE_CURRENCIES.has(upper)) return upper;
  if (upper === 'RM') return 'MYR';
  if (upper === '$' || upper === 'US$') return 'USD';
  if (upper === 'S$') return 'SGD';
  if (upper === 'HK$') return 'HKD';
  return fallback;
}

export function sanitizeTradeAction(value: unknown): 'BUY' | 'SELL' | 'DIVIDEND' | 'REINVEST' {
  if (typeof value !== 'string') return 'BUY';
  const upper = value.trim().toUpperCase();
  if (VALID_TRADE_ACTIONS.has(upper)) {
    return upper as 'BUY' | 'SELL' | 'DIVIDEND' | 'REINVEST';
  }
  if (upper.includes('SELL') || upper.includes('卖') || upper.includes('SHORT')) return 'SELL';
  if (upper.includes('REINVEST') || upper.includes('再投资')) return 'REINVEST';
  if (upper.includes('DIVIDEND') || upper.includes('分红') || upper.includes('股息')) return 'DIVIDEND';
  return 'BUY';
}

export function inferTradeAssetType(ticker: string, rawType?: string): 'US Stock' | 'MY Stock' | 'ETF' | 'Crypto' | 'Unit Trust' | 'Other' {
  const cleanTicker = ticker.trim().toUpperCase();
  if (rawType && typeof rawType === 'string') {
    const t = rawType.trim();
    if (t === 'US Stock' || t === 'MY Stock' || t === 'ETF' || t === 'Crypto' || t === 'Unit Trust' || t === 'Other') {
      return t;
    }
    if (t.toLowerCase().includes('crypto') || cleanTicker.endsWith('-USD') || cleanTicker.endsWith('USDT')) return 'Crypto';
    if (t.toLowerCase().includes('etf')) return 'ETF';
    if (t.toLowerCase().includes('bursa') || t.toLowerCase().includes('malaysia')) return 'MY Stock';
  }

  if (cleanTicker.endsWith('.KL') || cleanTicker.endsWith('.MY') || /^\d{4}$/.test(cleanTicker)) {
    return 'MY Stock';
  }
  if (['BTC', 'ETH', 'SOL', 'USDT', 'BNB', 'DOGE', 'XRP'].some(c => cleanTicker.startsWith(c))) {
    return 'Crypto';
  }
  if (['VOO', 'QQQ', 'SPY', 'IVV', 'VTI', 'SCHD', 'ARKK', 'SMH', 'SOXX', 'XLK', 'IWM', 'DIA', 'VT'].includes(cleanTicker)) {
    return 'ETF';
  }
  return 'US Stock';
}

export function reconcileTradeFees(data: {
  quantity: number;
  price: number;
  fees?: number | null;
  netTotal?: number | null;
  action: 'BUY' | 'SELL' | 'DIVIDEND' | 'REINVEST';
  feeBreakdown?: RawTradeFeeBreakdown;
  orderId?: string | null;
}): {
  fees: number;
  netTotal: number;
  formattedNotes: string;
} {
  const qty = Math.max(0, data.quantity || 0);
  const price = Math.max(0, data.price || 0);
  const rawSubtotal = Number((qty * price).toFixed(2));

  let extractedFees = typeof data.fees === 'number' && Number.isFinite(data.fees) && data.fees >= 0
    ? Number(data.fees.toFixed(2))
    : 0;

  // Reconcile from feeBreakdown items if provided
  const breakdown = data.feeBreakdown || {};
  const breakdownSum = [
    breakdown.commission,
    breakdown.platformFee,
    breakdown.secFee,
    breakdown.tafFee,
    breakdown.clearingFee,
    breakdown.tax,
    breakdown.otherFees,
  ].reduce((acc: number, val) => {
    return typeof val === 'number' && Number.isFinite(val) && val > 0 ? acc + val : acc;
  }, 0);

  if (breakdownSum > 0 && Math.abs(breakdownSum - extractedFees) > 0.001) {
    extractedFees = Number(breakdownSum.toFixed(2));
  }

  // If fees was 0 or missing, but netTotal was provided, deduce fee difference
  if (extractedFees === 0 && typeof data.netTotal === 'number' && data.netTotal > 0 && rawSubtotal > 0) {
    const diff = Number(Math.abs(data.netTotal - rawSubtotal).toFixed(2));
    // Sanity check: fees are usually < 10% of trade value
    if (diff > 0 && diff < rawSubtotal * 0.15) {
      extractedFees = diff;
    }
  }

  // Calculate net total
  let netTotal: number;
  if (typeof data.netTotal === 'number' && data.netTotal > 0) {
    netTotal = Number(data.netTotal.toFixed(2));
  } else if (data.action === 'BUY') {
    netTotal = Number((rawSubtotal + extractedFees).toFixed(2));
  } else {
    netTotal = Number(Math.max(0, rawSubtotal - extractedFees).toFixed(2));
  }

  // Build clean fee notes for easy audit
  const parts: string[] = [];
  if (data.orderId) {
    parts.push(`Order #${data.orderId}`);
  }
  const feeItems: string[] = [];
  if (breakdown.commission && breakdown.commission > 0) feeItems.push(`Comm: ${breakdown.commission.toFixed(2)}`);
  if (breakdown.platformFee && breakdown.platformFee > 0) feeItems.push(`Platform: ${breakdown.platformFee.toFixed(2)}`);
  if (breakdown.secFee && breakdown.secFee > 0) feeItems.push(`SEC: ${breakdown.secFee.toFixed(2)}`);
  if (breakdown.tafFee && breakdown.tafFee > 0) feeItems.push(`TAF: ${breakdown.tafFee.toFixed(2)}`);
  if (breakdown.clearingFee && breakdown.clearingFee > 0) feeItems.push(`Clearing: ${breakdown.clearingFee.toFixed(2)}`);
  if (breakdown.tax && breakdown.tax > 0) feeItems.push(`Tax: ${breakdown.tax.toFixed(2)}`);

  if (feeItems.length > 0) {
    parts.push(`Fees: ${feeItems.join(', ')}`);
  } else if (extractedFees > 0) {
    parts.push(`Total Fees: ${extractedFees.toFixed(2)}`);
  }

  const formattedNotes = parts.join(' | ');

  return {
    fees: extractedFees,
    netTotal,
    formattedNotes,
  };
}

export function buildTradeAiPrompt(today: string): string {
  return `You are an expert financial OCR analyst specializing in stock brokerage confirmations and execution screens, especially Moomoo (富途牛牛/Futu), Tiger Brokers, Interactive Brokers, Webull, and Bursa Malaysia trade slips.

Analyze this trade confirmation image or screenshot carefully and extract the executed trade and fee details.
Return ONLY a valid JSON object matching the schema below.

Today's date is: ${today}.

CRITICAL EXTRACTION RULES:
1. TICKER / SYMBOL:
   - Extract the stock/ETF symbol accurately without exchange prefix (e.g., "NVDA" from "US.NVDA" or "NASDAQ: NVDA", "1155.KL" or "1155" for Bursa stocks, "00700" or "0700.HK" for Tencent).
   - If stock name is given alongside ticker (e.g. "NVIDIA Corp - NVDA"), ticker is "NVDA" and assetName is "NVIDIA Corp".

2. ACTION:
   - Identify whether this is "BUY" (买入 / Buy / Long) or "SELL" (卖出 / Sell / Short / Close) or "DIVIDEND" / "REINVEST".

3. QUANTITY & PRICE:
   - quantity: The filled or executed number of shares/units (e.g. 10). Do NOT use submitted order quantity if filled quantity is different.
   - price: Executed/filled price per share (e.g. 135.20).

4. CURRENCY:
   - Detect the trade currency: "USD" ($), "MYR" (RM), "SGD" (S$), "HKD" (HK$), "CNY" (¥).

5. CRITICAL: MOOMOO FEES BREAKDOWN & SUMMATION:
   - Broker screens (especially Moomoo) often have a detailed section titled "Fee Details", "Fees Breakdown", "费用明细", or itemized charges:
     * Commission (佣金): broker charge
     * Platform Fee (平台使用费): platform fee
     * SEC Fee (证监会规费): US regulatory fee
     * Trading Activity Fee / TAF (交易活动费): FINRA charge
     * Settlement / Clearing Fee (交收费 / 结算规费): settlement charge
     * Stamp Duty / Tax / GST / SST (印花税 / 税费)
   - You MUST extract every individual fee found into "feeBreakdown".
   - "fees": MUST be the SUM of all transaction fees combined!
   - If total fees is explicitly printed (e.g. "Total Fees: 2.05" or "总费用: 2.05"), use that.

6. NET TOTAL & SETTLEMENT AMOUNT:
   - "netTotal": The final net out-of-pocket settlement amount:
     * For BUY: (quantity * price) + fees
     * For SELL: (quantity * price) - fees
     * If the screen states "Net Settlement Amount" or "Total Amount" or "清算金额" / "结算金额", extract it.

7. DATE:
   - The execution date (YYYY-MM-DD). If year is 2-digit, convert to 4-digit (e.g. 26 -> 2026). If not printed, use ${today}.

8. ORDER ID:
   - Extract the Order ID or Deal ID if present (e.g. "202610280012345").

JSON SCHEMA:
{
  "ticker": "NVDA",
  "assetName": "NVIDIA Corporation",
  "assetType": "US Stock",
  "action": "BUY",
  "quantity": 10,
  "price": 135.20,
  "currency": "USD",
  "date": "YYYY-MM-DD",
  "fees": 2.05,
  "feeBreakdown": {
    "commission": 0.99,
    "platformFee": 1.00,
    "secFee": 0.04,
    "tafFee": 0.01,
    "clearingFee": 0.01,
    "tax": 0.00,
    "otherFees": 0.00
  },
  "netTotal": 1354.05,
  "orderId": "string | null"
}`;
}
