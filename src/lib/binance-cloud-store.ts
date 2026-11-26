import { fetchAdminAppsScript, getAdminAppsScriptEndpoint } from '@/lib/admin-registry';
import type { GoogleUserSession } from '@/lib/google-auth';
import { executeUserGoogleAction } from '@/lib/google-sheets-user-engine';
import { callBinancePublic, type BinanceConfig } from '@/lib/binance-client';
import {
  buildTickerMap,
  parseChunkedBinanceLedger,
  serializeChunkedBinanceLedger,
  type BinanceStoredLedger,
  type BinanceTicker24h,
} from '@/lib/binance-sync';

type JsonRecord = Record<string, unknown>;

let cachedUsdMyr = 4.20;
let cachedUsdMyrAt = 0;
const USD_MYR_TTL_MS = 5 * 60 * 1000;

let cachedTickers: Record<string, BinanceTicker24h> = {};
let cachedTickersAt = 0;
const TICKERS_TTL_MS = 30 * 1000;

let cachedTokenizedMap: Record<string, string> = {};
let cachedTokenizedMapAt = 0;
const TOKENIZED_MAP_TTL_MS = 60 * 60 * 1000;

const cachedEquityQuotes: Record<string, { priceUsd: number; change24hPct: number; fetchedAt: number }> = {};
const EQUITY_QUOTE_TTL_MS = 30 * 1000;

export async function fetchServerUsdToMyr(): Promise<number> {
  const now = Date.now();
  if (cachedUsdMyrAt > 0 && now - cachedUsdMyrAt < USD_MYR_TTL_MS) {
    return cachedUsdMyr;
  }

  try {
    const res = await fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/USDMYR=X?interval=1d&range=1d',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(6000),
        cache: 'no-store',
      }
    );
    if (res.ok) {
      const data = (await res.json()) as {
        chart?: { result?: Array<{ meta?: { regularMarketPrice?: number } }> };
      };
      const rate = Number(data?.chart?.result?.[0]?.meta?.regularMarketPrice);
      if (Number.isFinite(rate) && rate > 0) {
        cachedUsdMyr = rate;
        cachedUsdMyrAt = now;
      }
    }
  } catch {
    // Keep cached or fallback USD/MYR rate
  }
  return cachedUsdMyr;
}

export async function fetchBinanceTickers24h(
  config?: BinanceConfig | null,
  forceFresh = false
): Promise<Record<string, BinanceTicker24h>> {
  const now = Date.now();
  if (!forceFresh && cachedTickersAt > 0 && now - cachedTickersAt < TICKERS_TTL_MS && Object.keys(cachedTickers).length > 0) {
    return cachedTickers;
  }

  const res = await callBinancePublic<Array<Record<string, unknown>>>('/api/v3/ticker/24hr', {}, config);
  if (res.success && Array.isArray(res.data)) {
    cachedTickers = buildTickerMap(res.data);
    cachedTickersAt = now;
  }
  return cachedTickers;
}

export async function fetchTokenizedEquityMap(
  config?: BinanceConfig | null
): Promise<Record<string, string>> {
  const now = Date.now();
  if (cachedTokenizedMapAt > 0 && now - cachedTokenizedMapAt < TOKENIZED_MAP_TTL_MS && Object.keys(cachedTokenizedMap).length > 0) {
    return cachedTokenizedMap;
  }

  try {
    const res = await callBinancePublic<
      Array<{ assetCode?: string; underlyingEquitySymbol?: string }> | { data?: Array<{ assetCode?: string; underlyingEquitySymbol?: string }> }
    >('/sapi/v1/equity/market/tokenized-assets', {}, config, { includeApiKey: true });

    const list = Array.isArray(res.data)
      ? res.data
      : Array.isArray((res.data as { data?: unknown[] } | undefined)?.data)
        ? (res.data as { data: Array<{ assetCode?: string; underlyingEquitySymbol?: string }> }).data
        : [];

    if (res.success && list.length > 0) {
      const nextMap: Record<string, string> = {};
      for (const item of list) {
        const code = String(item.assetCode || '').trim().toUpperCase();
        const underlying = String(item.underlyingEquitySymbol || '').trim().toUpperCase();
        if (code && underlying) nextMap[code] = underlying;
      }
      cachedTokenizedMap = nextMap;
      cachedTokenizedMapAt = now;
    }
  } catch {
    // Tokenized assets endpoint is optional if region/account doesn't enable bStocks
  }
  return cachedTokenizedMap;
}

async function fetchYahooEquityQuote(
  clean: string
): Promise<{ priceUsd: number; change24hPct: number } | null> {
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(clean)}?interval=1m&range=1d&includePrePost=true`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(5000),
        cache: 'no-store',
      });
      if (!res.ok) continue;
      const data = (await res.json()) as {
        chart?: {
          result?: Array<{
            meta?: {
              regularMarketPrice?: number;
              chartPreviousClose?: number;
              previousClose?: number;
              regularMarketChangePercent?: number;
              marketState?: string;
            };
            indicators?: {
              quote?: Array<{
                close?: Array<number | null>;
              }>;
            };
          }>;
        };
      };
      const result = data?.chart?.result?.[0];
      const meta = result?.meta;
      const closes = result?.indicators?.quote?.[0]?.close || [];
      let latestBarPrice = 0;
      for (let i = closes.length - 1; i >= 0; i--) {
        const val = Number(closes[i]);
        if (Number.isFinite(val) && val > 0) {
          latestBarPrice = val;
          break;
        }
      }
      const marketState = String(meta?.marketState || '').toUpperCase();
      const regularPrice = Number(meta?.regularMarketPrice || 0);
      const prevClose = Number(meta?.chartPreviousClose || meta?.previousClose || 0);
      const chosenPrice =
        marketState && marketState !== 'REGULAR' && latestBarPrice > 0
          ? latestBarPrice
          : regularPrice || latestBarPrice || prevClose;
      if (Number.isFinite(chosenPrice) && chosenPrice > 0) {
        const changePct =
          prevClose > 0 && latestBarPrice > 0 && marketState !== 'REGULAR'
            ? ((chosenPrice - prevClose) / prevClose) * 100
            : Number(meta?.regularMarketChangePercent ?? 0) || 0;
        return { priceUsd: chosenPrice, change24hPct: changePct };
      }
    } catch {
      // fallback to next Yahoo host
    }
  }
  return null;
}

async function fetchSingleEquityQuote(
  symbol: string,
  config?: BinanceConfig | null,
  forceFresh = false
): Promise<{ priceUsd: number; change24hPct: number } | null> {
  const clean = symbol.trim().toUpperCase();
  if (!clean) return null;

  const now = Date.now();
  const cached = cachedEquityQuotes[clean];
  if (!forceFresh && cached && now - cached.fetchedAt < EQUITY_QUOTE_TTL_MS) {
    return { priceUsd: cached.priceUsd, change24hPct: cached.change24hPct };
  }

  // Query Binance native equity quote and Yahoo Finance concurrently:
  // Binance's quote reflects Binance's exact orderbook/tokenized stock price,
  // while Yahoo supplies regular + pre/post-market prices and 24h % change.
  const [yahooQuote, binanceRes] = await Promise.all([
    fetchYahooEquityQuote(clean),
    config
      ? callBinancePublic<{
          lastPrice?: string;
          price?: string;
          bidPrice?: string;
          askPrice?: string;
        }>('/sapi/v1/equity/market/quote', { symbol: clean }, config, { includeApiKey: true }).catch(() => null)
      : Promise.resolve(null),
  ]);

  let binancePriceUsd = 0;
  if (binanceRes && binanceRes.success && binanceRes.data) {
    const last = Number(binanceRes.data.lastPrice || binanceRes.data.price || 0);
    const bid = Number(binanceRes.data.bidPrice || 0);
    const ask = Number(binanceRes.data.askPrice || 0);
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : (bid || ask);
    const picked = mid > 0 ? mid : last;
    if (Number.isFinite(picked) && picked > 0) {
      binancePriceUsd = picked;
    }
  }

  const priceUsd = binancePriceUsd > 0 ? binancePriceUsd : (yahooQuote?.priceUsd || 0);
  const change24hPct = yahooQuote?.change24hPct || 0;

  if (priceUsd > 0) {
    cachedEquityQuotes[clean] = { priceUsd, change24hPct, fetchedAt: now };
    return { priceUsd, change24hPct };
  }
  return null;
}

export async function fetchBinanceEquityQuotes(
  symbols: string[],
  config?: BinanceConfig | null,
  forceFresh = false
): Promise<Record<string, { priceUsd: number; change24hPct: number }>> {
  const unique = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))].slice(0, 40);
  if (unique.length === 0) return {};
  const results = await Promise.all(
    unique.map(async (sym) => [sym, await fetchSingleEquityQuote(sym, config, forceFresh)] as const)
  );
  const out: Record<string, { priceUsd: number; change24hPct: number }> = {};
  for (const [sym, q] of results) {
    if (q) out[sym] = q;
  }
  return out;
}

export async function readKinovaSettings(session: GoogleUserSession): Promise<Record<string, unknown>> {
  if (session.isAdmin && getAdminAppsScriptEndpoint()) {
    const response = (await fetchAdminAppsScript('GET', 'getSettings')) as JsonRecord | null;
    if (!response?.success) {
      throw new Error(String(response?.message || 'Could not read Settings from Google Sheets.'));
    }
    const data = (response.data as JsonRecord)?.data || response.data;
    return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  }

  const { result } = await executeUserGoogleAction(session, 'getSettings', {});
  return result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
}

export async function writeKinovaSetting(
  session: GoogleUserSession,
  key: string,
  value: string,
  mutationId: string
): Promise<void> {
  if (session.isAdmin && getAdminAppsScriptEndpoint()) {
    const response = (await fetchAdminAppsScript(
      'POST',
      'updateSettings',
      { key, value, mutationId },
      25000
    )) as JsonRecord | null;
    if (!response?.success) {
      throw new Error(String(response?.message || `Failed to save setting ${key} to Google Sheets.`));
    }
    return;
  }

  await executeUserGoogleAction(session, 'updateSettings', { key, value, mutationId });
}

export async function readStoredBinanceLedger(session: GoogleUserSession): Promise<BinanceStoredLedger | null> {
  const settings = await readKinovaSettings(session);
  return parseChunkedBinanceLedger(settings);
}

export async function saveStoredBinanceLedger(
  session: GoogleUserSession,
  ledger: BinanceStoredLedger
): Promise<void> {
  const entries = serializeChunkedBinanceLedger(ledger);
  const stamp = Date.now();
  // Write sequentially to respect Apps Script LockService & Sheets API quota
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    await writeKinovaSetting(
      session,
      entry.key,
      entry.value,
      `binance_ledger_${stamp}_${i}`
    );
  }
}
