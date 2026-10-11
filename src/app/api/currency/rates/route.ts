import { NextResponse } from 'next/server';

interface RatesResponse {
  success: boolean;
  base: string; // 'MYR'
  ratesToMYR: Record<string, number>; // 1 [CURRENCY] = X MYR
  ratesFromMYR: Record<string, number>; // 1 MYR = X [CURRENCY]
  timestamp: number;
}

// Fallback rates to MYR in case of network issues
const DEFAULT_RATES_TO_MYR: Record<string, number> = {
  MYR: 1.0,
  USD: 4.20,
  SGD: 3.25,
  CNY: 0.60,
  HKD: 0.54,
  EUR: 4.60,
  GBP: 5.45,
  JPY: 0.028,
  AUD: 2.80,
  THB: 0.13,
  IDR: 0.00027,
};

// In-memory cache for 5 minutes
let cachedRates: RatesResponse | null = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

const PAIRS: Array<{ code: string; symbol: string }> = [
  { code: 'USD', symbol: 'USDMYR=X' },
  { code: 'SGD', symbol: 'SGDMYR=X' },
  { code: 'CNY', symbol: 'CNYMYR=X' },
  { code: 'HKD', symbol: 'HKDMYR=X' },
  { code: 'EUR', symbol: 'EURMYR=X' },
  { code: 'GBP', symbol: 'GBPMYR=X' },
  { code: 'JPY', symbol: 'JPYMYR=X' },
  { code: 'AUD', symbol: 'AUDMYR=X' },
  { code: 'THB', symbol: 'THBMYR=X' },
  { code: 'IDR', symbol: 'IDRMYR=X' },
];

async function fetchPairRate(pair: { code: string; symbol: string }): Promise<{ code: string; rate: number }> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(pair.symbol)}?interval=1d&range=1d`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(8000),
      next: { revalidate: 300 }, // 5 mins
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const price = Number(data?.chart?.result?.[0]?.meta?.regularMarketPrice);
    if (!isNaN(price) && price > 0) {
      return { code: pair.code, rate: price };
    }
  } catch (err) {
    console.warn(`Failed to fetch rate for ${pair.symbol}:`, err);
  }
  return { code: pair.code, rate: DEFAULT_RATES_TO_MYR[pair.code] || 1.0 };
}

export async function GET() {
  const now = Date.now();
  if (cachedRates && (now - lastFetchTime < CACHE_TTL_MS)) {
    return NextResponse.json(cachedRates);
  }

  try {
    const results = await Promise.all(PAIRS.map(fetchPairRate));
    const ratesToMYR: Record<string, number> = { MYR: 1.0 };
    const ratesFromMYR: Record<string, number> = { MYR: 1.0 };

    results.forEach(({ code, rate }) => {
      ratesToMYR[code] = rate;
      ratesFromMYR[code] = rate > 0 ? 1 / rate : 1.0;
    });

    cachedRates = {
      success: true,
      base: 'MYR',
      ratesToMYR,
      ratesFromMYR,
      timestamp: now,
    };
    lastFetchTime = now;

    return NextResponse.json(cachedRates);
  } catch (err) {
    console.error('Error fetching live FX rates:', err);
    // Return default fallback
    const fallbackRatesToMYR = { ...DEFAULT_RATES_TO_MYR };
    const fallbackRatesFromMYR: Record<string, number> = {};
    Object.entries(fallbackRatesToMYR).forEach(([k, v]) => {
      fallbackRatesFromMYR[k] = v > 0 ? 1 / v : 1.0;
    });

    return NextResponse.json({
      success: true,
      base: 'MYR',
      ratesToMYR: fallbackRatesToMYR,
      ratesFromMYR: fallbackRatesFromMYR,
      timestamp: now,
    });
  }
}
