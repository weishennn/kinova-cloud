/**
 * Currency formatting and real-time exchange rate utilities
 */

export const COMMON_CURRENCIES = [
  { code: 'MYR', symbol: 'RM', name: 'Malaysian Ringgit' },
  { code: 'USD', symbol: '$', name: 'US Dollar' },
  { code: 'SGD', symbol: 'S$', name: 'Singapore Dollar' },
  { code: 'EUR', symbol: '€', name: 'Euro' },
  { code: 'GBP', symbol: '£', name: 'British Pound' },
  { code: 'JPY', symbol: '¥', name: 'Japanese Yen' },
  { code: 'AUD', symbol: 'A$', name: 'Australian Dollar' },
  { code: 'IDR', symbol: 'Rp', name: 'Indonesian Rupiah' },
  { code: 'THB', symbol: '฿', name: 'Thai Baht' },
  { code: 'CNY', symbol: '¥', name: 'Chinese Yuan' },
  { code: 'HKD', symbol: 'HK$', name: 'Hong Kong Dollar' },
] as const;

/**
 * The app displays its cross-currency summaries in MYR. Keep the accounting
 * base explicit so a transaction's entered currency is never mistaken for a
 * MYR amount when it is included in a total.
 *
 * ACCOUNTING CONVENTION (Standard Line-Item Conversion Rule):
 * In accordance with standard financial accounting principles (such as IFRS / IAS 21),
 * each individual foreign-currency transaction is converted to MYR at its entry/transaction
 * date and stored with its line-item BaseAmount rounded to 2 decimal places (cents),
 * along with the FxRateToBase used.
 * Aggregate reports and month/category totals calculate the sum of these recorded BaseAmount values.
 * This guarantees that summing rows in any filtered view matches the individual line-item
 * MYR values displayed on screen, preventing discrepancies between line views and aggregate reports.
 */
export const ACCOUNTING_BASE_CURRENCY = 'MYR';

// Realistic baseline exchange rates: 1 Foreign Unit = X MYR
export const DEFAULT_RATES_TO_MYR: Record<string, number> = {
  MYR: 1.0,
  USD: 4.10,
  SGD: 3.20,
  CNY: 0.60,
  HKD: 0.53,
  EUR: 4.60,
  GBP: 5.45,
  JPY: 0.028,
  AUD: 2.80,
  THB: 0.13,
  IDR: 0.00027,
};

// Rates where 1 MYR = X Foreign (for legacy compatibility)
export const DEFAULT_EXCHANGE_RATES: Record<string, number> = {
  MYR: 1.0,
  USD: 1 / 4.10,
  SGD: 1 / 3.20,
  CNY: 1 / 0.60,
  HKD: 1 / 0.53,
  EUR: 1 / 4.60,
  GBP: 1 / 5.45,
  JPY: 1 / 0.028,
  AUD: 1 / 2.80,
  THB: 1 / 0.13,
  IDR: 1 / 0.00027,
};

/**
 * Format a number to currency string
 */
export function formatCurrency(
  amount: number, 
  currencyCode: string = 'MYR', 
  showSymbol: boolean = true
): string {
  const currencyInfo = COMMON_CURRENCIES.find(c => c.code === currencyCode.toUpperCase());
  
  const formatted = new Intl.NumberFormat('en-MY', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);

  if (!showSymbol) return formatted;
  
  const symbol = currencyInfo?.symbol || currencyCode;
  return `${symbol} ${formatted}`;
}

export function formatAssetCurrency(val: number, curr = 'USD'): string {
  const c = (curr || 'USD').toUpperCase();
  if (c === 'USD') return `$${val.toFixed(2)}`;
  if (c === 'MYR') return `RM ${val.toFixed(2)}`;
  if (c === 'SGD') return `S$${val.toFixed(2)}`;
  if (c === 'CNY') return `¥${val.toFixed(2)}`;
  if (c === 'HKD') return `HK$${val.toFixed(2)}`;
  return `${c} ${val.toFixed(2)}`;
}

export function formatPnl(pnl: number, curr = 'USD'): string {
  const sign = pnl >= 0 ? '+' : '-';
  const absVal = Math.abs(pnl);
  const c = (curr || 'USD').toUpperCase();
  if (c === 'USD') return `${sign}$${absVal.toFixed(2)}`;
  if (c === 'MYR') return `${sign}RM ${absVal.toFixed(2)}`;
  if (c === 'SGD') return `${sign}S$${absVal.toFixed(2)}`;
  if (c === 'CNY') return `${sign}¥${absVal.toFixed(2)}`;
  if (c === 'HKD') return `${sign}HK$${absVal.toFixed(2)}`;
  return `${sign}${c} ${absVal.toFixed(2)}`;
}

/**
 * Convert amount between currencies using real-time ratesToMYR mapping
 * (1 Foreign Currency = X MYR)
 */
export function convertCurrency(
  amount: number,
  fromCode: string,
  toCode: string,
  ratesToMyr: Record<string, number> = DEFAULT_RATES_TO_MYR
): number {
  const from = (fromCode || 'MYR').toUpperCase();
  const to = (toCode || 'MYR').toUpperCase();
  if (from === to) return amount;
  
  const fromToMyrRate = ratesToMyr[from] ?? DEFAULT_RATES_TO_MYR[from] ?? 1.0;
  const toToMyrRate = ratesToMyr[to] ?? DEFAULT_RATES_TO_MYR[to] ?? 1.0;
  
  // Convert from source to MYR, then from MYR to destination
  const amountInMyr = amount * fromToMyrRate;
  if (to === 'MYR') return amountInMyr;
  return toToMyrRate > 0 ? amountInMyr / toToMyrRate : amountInMyr;
}

/**
 * Return a transaction amount in the accounting base currency. New rows can
 * provide a stored base amount (captured at entry time); older rows fall back
 * to the cached/default FX table instead of being added as raw foreign units.
 */
export function getAmountInBaseCurrency(
  amount: number,
  currencyCode: string = ACCOUNTING_BASE_CURRENCY,
  storedBaseAmount?: number,
  ratesToMyr: Record<string, number> = getCachedRatesToMyr(),
): number {
  if (Number.isFinite(storedBaseAmount)) return Number(storedBaseAmount);
  return convertCurrency(amount, currencyCode, ACCOUNTING_BASE_CURRENCY, ratesToMyr);
}

/**
 * Fetch real-time exchange rates with local storage caching for instant access
 */
export async function fetchLiveExchangeRates(): Promise<Record<string, number>> {
  if (typeof window === 'undefined') return DEFAULT_RATES_TO_MYR;

  // Try memory/cache
  const cached = localStorage.getItem('cashflow_live_fx_rates');
  let currentRates = DEFAULT_RATES_TO_MYR;
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (parsed?.ratesToMYR) {
        currentRates = { ...DEFAULT_RATES_TO_MYR, ...parsed.ratesToMYR };
      }
    } catch (e) {
      // ignore
    }
  }

  try {
    const res = await fetch('/api/currency/rates');
    if (res.ok) {
      const data = await res.json();
      if (data?.ratesToMYR) {
        localStorage.setItem('cashflow_live_fx_rates', JSON.stringify(data));
        return { ...DEFAULT_RATES_TO_MYR, ...data.ratesToMYR };
      }
    }
  } catch (err) {
    console.warn('Could not fetch live FX rates, using cache/defaults:', err);
  }

  return currentRates;
}

export function getCachedRatesToMyr(): Record<string, number> {
  if (typeof window === 'undefined') return DEFAULT_RATES_TO_MYR;
  try {
    const cached = localStorage.getItem('cashflow_live_fx_rates');
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed?.ratesToMYR) return { ...DEFAULT_RATES_TO_MYR, ...parsed.ratesToMYR };
    }
  } catch (e) {
    // ignore
  }
  return DEFAULT_RATES_TO_MYR;
}
