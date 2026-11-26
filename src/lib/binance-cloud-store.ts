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
