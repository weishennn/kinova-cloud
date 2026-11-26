import { NextRequest, NextResponse } from 'next/server';
import { getValidGoogleSession, setSessionCookie } from '@/lib/google-auth';
import { callBinancePublic, callBinanceSigned, getBinanceConfig, type BinanceConfig } from '@/lib/binance-client';
import {
  fetchBinanceEquityQuotes,
  fetchBinanceTickers24h,
  fetchServerUsdToMyr,
  fetchTokenizedEquityMap,
  readStoredBinanceLedger,
  saveStoredBinanceLedger,
} from '@/lib/binance-cloud-store';
import {
  computeBinanceAnalytics,
  createEmptyBinanceLedger,
  formatKlDate,
  mergeFundingById,
  mergeSpotAndFundingBalances,
  mergeTradesById,
  normalizeC2cOrder,
  normalizeConvertTrade,
  normalizeCryptoTransfer,
  normalizeEquityTrade,
  normalizeFiatOrder,
  normalizeSpotTrade,
  resolveAssetPriceUsd,
  splitSymbolPair,
  STABLECOIN_ASSETS,
  type BinanceFundingEvent,
  type BinanceTicker24h,
  type BinanceTradeExecution,
} from '@/lib/binance-sync';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LOOKBACK_DAYS = 365;
const OVERLAP_MS = 24 * 60 * 60 * 1000;

let cachedExchangeMap: Record<string, { baseAsset: string; quoteAsset: string }> = {};
let cachedExchangeMapAt = 0;

async function getExchangeSymbolMap(
  config: BinanceConfig
): Promise<Record<string, { baseAsset: string; quoteAsset: string }>> {
  const now = Date.now();
  if (cachedExchangeMapAt > 0 && now - cachedExchangeMapAt < 60 * 60 * 1000 && Object.keys(cachedExchangeMap).length > 0) {
    return cachedExchangeMap;
  }

  const res = await callBinancePublic<{
    symbols?: Array<{ symbol?: string; baseAsset?: string; quoteAsset?: string }>;
  }>('/api/v3/exchangeInfo', {}, config);

  if (res.success && Array.isArray(res.data?.symbols)) {
    const map: Record<string, { baseAsset: string; quoteAsset: string }> = {};
    for (const s of res.data.symbols) {
      const sym = String(s.symbol || '').trim().toUpperCase();
      const base = String(s.baseAsset || '').trim().toUpperCase();
      const quote = String(s.quoteAsset || '').trim().toUpperCase();
      if (sym && base && quote) {
        map[sym] = { baseAsset: base, quoteAsset: quote };
      }
    }
    cachedExchangeMap = map;
    cachedExchangeMapAt = now;
  }
  return cachedExchangeMap;
}

function buildTimeWindows(startMs: number, endMs: number, maxChunkDays: number): Array<{ start: number; end: number }> {
  const chunkMs = maxChunkDays * DAY_MS;
  const windows: Array<{ start: number; end: number }> = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const nextEnd = Math.min(endMs, cursor + chunkMs);
    windows.push({ start: cursor, end: nextEnd });
    cursor = nextEnd + 1;
  }
  return windows;
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const current = idx++;
      if (current >= items.length) return;
      results[current] = await fn(items[current]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function GET(req: NextRequest) {
  try {
    const { session, refreshed } = await getValidGoogleSession(req);
    if (!session) return NextResponse.json({ success: false, error: 'Unauthorized.' }, { status: 401 });
    if (!session.isAdmin) return NextResponse.json({ success: false, error: 'Forbidden.' }, { status: 403 });

    const config = getBinanceConfig();
    const ledger = await readStoredBinanceLedger(session).catch(() => null);
    const response = NextResponse.json({
      success: true,
      configured: Boolean(config),
      proxyEnabled: Boolean(config?.proxyUrl),
      keyType: config?.keyType || null,
      lastSyncAt: ledger?.lastSyncAt || null,
      tradesCount: ledger?.trades.length || 0,
      fundingEventsCount: ledger?.fundingEvents.length || 0,
    });
    if (refreshed) setSessionCookie(response, session);
    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to check Binance sync status.';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { session, refreshed } = await getValidGoogleSession(req);
    if (!session) return NextResponse.json({ success: false, error: 'Unauthorized.' }, { status: 401 });
    if (!session.isAdmin) {
      return NextResponse.json(
        { success: false, error: 'Binance sync is restricted to the workspace owner.' },
        { status: 403 }
      );
    }

    const config = getBinanceConfig();
    if (!config) {
      return NextResponse.json(
        {
          success: false,
          error: 'Binance API credentials are not configured. Set BINANCE_API_KEY and BINANCE_PRIVATE_KEY.',
        },
        { status: 400 }
      );
    }

    let fullHistory = false;
    let lookbackDays = DEFAULT_LOOKBACK_DAYS;
    let extraSymbols: string[] = [];
    try {
      const body = (await req.json()) as {
        fullHistory?: boolean;
        lookbackDays?: number;
        extraSymbols?: string[];
      };
      fullHistory = body?.fullHistory === true;
      if (Number.isFinite(Number(body?.lookbackDays)) && Number(body.lookbackDays) > 0) {
        lookbackDays = Math.min(1095, Math.max(30, Number(body.lookbackDays)));
      }
      if (Array.isArray(body?.extraSymbols)) {
        extraSymbols = body.extraSymbols
          .map((s) => String(s).trim().toUpperCase())
          .filter((s) => /^[A-Z0-9]{4,16}$/.test(s));
      }
    } catch {
      // Optional JSON body
    }

    const existingLedger = fullHistory
      ? createEmptyBinanceLedger()
      : (await readStoredBinanceLedger(session).catch(() => null)) || createEmptyBinanceLedger();

    // Preserve overrides and customSymbols even on fullHistory re-sync
    if (fullHistory) {
      const prev = await readStoredBinanceLedger(session).catch(() => null);
      if (prev) {
        existingLedger.costBasisOverrides = prev.costBasisOverrides;
        existingLedger.customSymbols = prev.customSymbols;
      }
    }

    const warnings: string[] = [];
    const nowMs = Date.now();
    const startMs = existingLedger.lastHistorySyncMs > 0 && !fullHistory
      ? Math.max(0, existingLedger.lastHistorySyncMs - OVERLAP_MS)
      : nowMs - lookbackDays * DAY_MS;

    const [spotRes, fundingRes, walletRes, tickerMap, tokenizedMap, exchangeMap, usdToMyr] = await Promise.all([
      callBinanceSigned<{ balances?: Array<{ asset?: string; free?: string; locked?: string }> }>('/api/v3/account', {
        method: 'GET',
        params: { omitZeroBalances: 'true' },
        config,
      }),
      callBinanceSigned<Array<{ asset?: string; free?: string; locked?: string; freeze?: string; withdrawing?: string }>>(
        '/sapi/v1/asset/get-funding-asset',
        { method: 'POST', params: { needBtcValuation: 'false' }, config }
      ),
      callBinanceSigned<Array<{
        walletName?: string;
        activate?: boolean;
        assetBalances?: Array<{ asset?: string; free?: string; locked?: string; freeze?: string; withdrawing?: string }>;
      }>>('/sapi/v1/asset/wallet/balance', {
        method: 'GET',
        params: { needBalanceDetail: 'true', quoteAsset: 'USDT' },
        config,
      }),
      fetchBinanceTickers24h(config, true),
      fetchTokenizedEquityMap(config),
      getExchangeSymbolMap(config),
      fetchServerUsdToMyr(),
    ]);

    if (!spotRes.success) {
      return NextResponse.json(
        { success: false, error: spotRes.error || 'Failed to read Binance Spot account.' },
        { status: spotRes.status && spotRes.status >= 400 ? spotRes.status : 502 }
      );
    }
    if (!fundingRes.success) {
      warnings.push(`Funding wallet read warning: ${fundingRes.error || 'Unavailable'}`);
    }

    const balances = mergeSpotAndFundingBalances(
      spotRes.data?.balances || [],
      fundingRes.success && Array.isArray(fundingRes.data) ? fundingRes.data : [],
      walletRes.success && Array.isArray(walletRes.data) ? walletRes.data : []
    );

    // 1. Funding & Conversion windows
    const incomingFunding: BinanceFundingEvent[] = [];
    const incomingTrades: BinanceTradeExecution[] = [];
    const discoveredAssets = new Set<string>(balances.map((b) => b.asset));

    const windows30 = buildTimeWindows(startMs, nowMs, 29);
    const windows89 = buildTimeWindows(startMs, nowMs, 89);

    // 1A. P2P (C2C) Orders (BUY & SELL, 30-day chunks in parallel)
    for (const tradeType of ['BUY', 'SELL'] as const) {
      const p2pResults = await mapLimited(windows30, 5, (w) =>
        callBinanceSigned<{ data?: Array<Record<string, unknown>> }>(
          '/sapi/v1/c2c/orderMatch/listUserOrderHistory',
          {
            method: 'GET',
            params: {
              tradeType,
              startTimestamp: w.start,
              endTimestamp: w.end,
              rows: 100,
              page: 1,
            },
            config,
          }
        )
      );
      let warnedP2p = false;
      for (const res of p2pResults) {
        if (!res.success) {
          if (!warnedP2p && res.code !== -1002 && res.status !== 404) {
            warnings.push(`P2P ${tradeType} sync: ${res.error}`);
            warnedP2p = true;
          }
          continue;
        }
        const rows = Array.isArray(res.data?.data) ? res.data.data : [];
        for (const r of rows) {
          const ev = normalizeC2cOrder(r, usdToMyr);
          if (ev) {
            incomingFunding.push(ev);
            discoveredAssets.add(ev.asset);
          }
        }
      }
    }

    // 1B. Fiat Deposits & Withdrawals (89-day chunks in parallel)
    for (const txType of [0, 1] as const) {
      const fiatResults = await mapLimited(windows89, 5, (w) =>
        callBinanceSigned<{ data?: Array<Record<string, unknown>> }>('/sapi/v1/fiat/orders', {
          method: 'GET',
          params: {
            transactionType: txType,
            beginTime: w.start,
            endTime: w.end,
            rows: 500,
            page: 1,
          },
          config,
        })
      );
      let warnedFiat = false;
      for (const res of fiatResults) {
        if (!res.success) {
          if (!warnedFiat) {
            warnings.push(`Fiat ${txType === 0 ? 'deposit' : 'withdraw'} sync: ${res.error}`);
            warnedFiat = true;
          }
          continue;
        }
        const rows = Array.isArray(res.data?.data) ? res.data.data : [];
        for (const r of rows) {
          const ev = normalizeFiatOrder(r, txType, usdToMyr);
          if (ev) incomingFunding.push(ev);
        }
      }
    }

    // 1C. On-chain Crypto Deposits & Withdrawals (89-day chunks in parallel)
    const depWdResults = await mapLimited(windows89, 4, (w) =>
      Promise.all([
        callBinanceSigned<Array<Record<string, unknown>>>('/sapi/v1/capital/deposit/hisrec', {
          method: 'GET',
          params: { startTime: w.start, endTime: w.end, limit: 1000 },
          config,
        }),
        callBinanceSigned<Array<Record<string, unknown>>>('/sapi/v1/capital/withdraw/history', {
          method: 'GET',
          params: { startTime: w.start, endTime: w.end, limit: 1000 },
          config,
        }),
      ])
    );
    let warnedDep = false;
    let warnedWd = false;
    for (const [depRes, wdRes] of depWdResults) {
      if (depRes.success && Array.isArray(depRes.data)) {
        for (const r of depRes.data) {
          const ev = normalizeCryptoTransfer(r, 'crypto_deposit', tickerMap);
          if (ev) {
            incomingFunding.push(ev);
            discoveredAssets.add(ev.asset);
          }
        }
      } else if (!depRes.success && !warnedDep) {
        warnings.push(`Crypto deposit history: ${depRes.error}`);
        warnedDep = true;
      }

      if (wdRes.success && Array.isArray(wdRes.data)) {
        for (const r of wdRes.data) {
          const ev = normalizeCryptoTransfer(r, 'crypto_withdraw', tickerMap);
          if (ev) {
            incomingFunding.push(ev);
            discoveredAssets.add(ev.asset);
          }
        }
      } else if (!wdRes.success && !warnedWd) {
        warnings.push(`Crypto withdraw history: ${wdRes.error}`);
        warnedWd = true;
      }
    }

    // 1D. Spot <-> Funding internal transfers (neutral moves, in parallel)
    for (const transferType of ['MAIN_FUNDING', 'FUNDING_MAIN'] as const) {
      const xferResults = await mapLimited(windows30, 5, (w) =>
        callBinanceSigned<{ rows?: Array<Record<string, unknown>> }>('/sapi/v1/asset/transfer', {
          method: 'GET',
          params: { type: transferType, startTime: w.start, endTime: w.end, size: 100, current: 1 },
          config,
        })
      );
      for (const res of xferResults) {
        if (!res.success) continue;
        const rows = Array.isArray(res.data?.rows) ? res.data.rows : [];
        for (const r of rows) {
          const tranId = String(r.tranId || '').trim();
          const asset = String(r.asset || '').trim().toUpperCase();
          const amount = Number(r.amount || 0);
          const ts = Number(r.timestamp || 0);
          if (!tranId || !asset || amount <= 0 || ts <= 0) continue;
          discoveredAssets.add(asset);
          incomingFunding.push({
            id: `xfer_${transferType}_${tranId}`,
            timestamp: ts,
            date: formatKlDate(ts),
            kind: 'internal_transfer',
            direction: 'neutral',
            asset,
            amount,
            usdValue: amount * resolveAssetPriceUsd(asset, tickerMap).priceUsd,
            status: String(r.status || 'CONFIRMED'),
            note: transferType === 'MAIN_FUNDING' ? 'Spot → Funding' : 'Funding → Spot',
          });
        }
      }
    }

    // 1E. Binance Convert tradeFlow (30-day chunks in parallel)
    const convResults = await mapLimited(windows30, 5, (w) =>
      callBinanceSigned<{ list?: Array<Record<string, unknown>> }>('/sapi/v1/convert/tradeFlow', {
        method: 'GET',
        params: { startTime: w.start, endTime: w.end, limit: 1000 },
        config,
      })
    );
    let warnedConv = false;
    for (const convRes of convResults) {
      if (!convRes.success) {
        if (!warnedConv && convRes.code !== -1002) {
          warnings.push(`Convert history: ${convRes.error}`);
          warnedConv = true;
        }
        continue;
      }
      const list = Array.isArray(convRes.data?.list) ? convRes.data.list : [];
      for (const item of list) {
        const legs = normalizeConvertTrade(item, tickerMap);
        for (const leg of legs) {
          incomingTrades.push(leg);
          discoveredAssets.add(leg.baseAsset);
        }
      }
    }

    // 1F. Small-balance Dust -> BNB conversions
    const dustRes = await callBinanceSigned<{
      userAssetDribblets?: Array<{
        transId?: number;
        operateTime?: number;
        userAssetDribbletDetails?: Array<{
          fromAsset?: string;
          amount?: string;
          transferedAmount?: string;
        }>;
      }>;
    }>('/sapi/v1/asset/dribblet', { method: 'GET', config });

    if (dustRes.success && Array.isArray(dustRes.data?.userAssetDribblets)) {
      const bnbPriceUsd = resolveAssetPriceUsd('BNB', tickerMap).priceUsd;
      for (const batch of dustRes.data.userAssetDribblets) {
        const ts = Number(batch.operateTime || 0);
        const transId = String(batch.transId || ts);
        for (const d of batch.userAssetDribbletDetails || []) {
          const fromAsset = String(d.fromAsset || '').trim().toUpperCase();
          const qty = Number(d.amount || 0);
          const bnbReceived = Number(d.transferedAmount || 0);
          if (!fromAsset || qty <= 0 || ts <= 0) continue;
          const totalUsd = bnbReceived * bnbPriceUsd;
          incomingTrades.push({
            id: `dust_${transId}_${fromAsset}`,
            timestamp: ts,
            date: formatKlDate(ts),
            source: 'dust',
            symbol: `${fromAsset}BNB`,
            baseAsset: fromAsset,
            quoteAsset: 'BNB',
            side: 'SELL',
            quantity: qty,
            priceUsd: qty > 0 ? totalUsd / qty : 0,
            totalUsd,
            feeUsd: 0,
            note: `Dust Convert ${fromAsset} → ${bnbReceived} BNB`,
          });
        }
      }
    }

    // 1G. Binance US Equities / Stocks (/sapi/v1/equity/trade/history + order/history + tokenized/history)
    const equityOrderFees = new Map<string, number>();
    const equityOrderRows: Array<Record<string, unknown>> = [];
    const eqOrderResults = await mapLimited(windows89, 4, (w) =>
      callBinanceSigned<Array<Record<string, unknown>> | { rows?: Array<Record<string, unknown>> }>(
        '/sapi/v1/equity/order/history',
        {
          method: 'GET',
          params: { startTime: w.start, endTime: w.end, current: 1, size: 100 },
          config,
        }
      )
    );
    for (const res of eqOrderResults) {
      if (!res.success) continue;
      const rows = Array.isArray(res.data)
        ? res.data
        : Array.isArray((res.data as { rows?: unknown[] } | undefined)?.rows)
          ? (res.data as { rows: Array<Record<string, unknown>> }).rows
          : [];
      for (const ord of rows) {
        equityOrderRows.push(ord);
        const oid = String(ord.orderId || '').trim();
        const fee = Number(ord.fee || 0);
        if (oid && Number.isFinite(fee) && fee > 0) {
          equityOrderFees.set(oid, fee);
        }
      }
    }

    const seenEquityOrderIds = new Set<string>();
    const eqTradeResults = await mapLimited(windows89, 4, async (w) => {
      const collected: Array<Record<string, unknown>> = [];
      for (let page = 1; page <= 10; page++) {
        const res = await callBinanceSigned<{ rows?: Array<Record<string, unknown>>; total?: number }>(
          '/sapi/v1/equity/trade/history',
          {
            method: 'GET',
            params: { startTime: w.start, endTime: w.end, current: page, size: 100 },
            config,
          }
        );
        if (!res.success) break;
        const rows = Array.isArray(res.data?.rows) ? res.data.rows : [];
        collected.push(...rows);
        if (rows.length < 100) break;
      }
      return collected;
    });
    for (const rows of eqTradeResults) {
      for (const r of rows) {
        const oid = String(r.orderId || '').trim();
        if (oid) seenEquityOrderIds.add(oid);
        const feeOverride = oid ? equityOrderFees.get(oid) : undefined;
        const norm = normalizeEquityTrade(r, tickerMap as Record<string, BinanceTicker24h>, feeOverride);
        if (norm) incomingTrades.push(norm);
      }
    }
    // Fallback for any filled equity order not yet returned by trade/history
    for (const ord of equityOrderRows) {
      const oid = String(ord.orderId || '').trim();
      const status = String(ord.status || '').toUpperCase();
      if (oid && !seenEquityOrderIds.has(oid) && (status === 'FILLED' || Number(ord.filledQty || 0) > 0)) {
        const norm = normalizeEquityTrade(ord, tickerMap as Record<string, BinanceTicker24h>);
        if (norm) incomingTrades.push(norm);
      }
    }

    // Track tokenized bStock mint/redeem conversions so underlying equity shares aren't double-counted
    const equityNetAdjustment: Record<string, number> = {};
    let tokLastId: number | undefined;
    for (let page = 0; page < 10; page++) {
      const tokRes = await callBinanceSigned<{
        rows?: Array<Record<string, unknown>>;
        hasMore?: boolean;
        nextLastId?: number;
      }>('/sapi/v1/equity/tokenized/history', {
        method: 'GET',
        params: tokLastId !== undefined ? { lastId: tokLastId, size: 100 } : { size: 100 },
        config,
      });
      if (!tokRes.success) break;
      const rows = Array.isArray(tokRes.data?.rows) ? tokRes.data.rows : [];
      for (const r of rows) {
        if (String(r.status || '').toUpperCase() !== 'S') continue;
        const underlying = String(r.underlyingAsset || '').trim().toUpperCase();
        const amt = Number(r.underlyingAssetAmount || 0);
        const cType = String(r.convertType || '').toUpperCase();
        if (!underlying || !Number.isFinite(amt) || amt <= 0) continue;
        if (cType === 'MINT') {
          equityNetAdjustment[underlying] = (equityNetAdjustment[underlying] || 0) - amt;
        } else if (cType === 'REDEEM') {
          equityNetAdjustment[underlying] = (equityNetAdjustment[underlying] || 0) + amt;
        }
      }
      if (!tokRes.data?.hasMore || !tokRes.data?.nextLastId) break;
      tokLastId = tokRes.data.nextLastId;
    }

    // 2. Discover candidate Spot symbols & paginate myTrades with fromId
    const customSymbols = [
      ...new Set([...existingLedger.customSymbols, ...extraSymbols]),
    ];
    const candidateSymbols = new Set<string>([
      ...Object.keys(existingLedger.symbolFromIds),
      ...customSymbols,
    ]);

    for (const asset of discoveredAssets) {
      if (STABLECOIN_ASSETS.has(asset)) continue;
      for (const quote of ['USDT', 'FDUSD', 'USDC', 'BTC', 'BNB']) {
        const sym = `${asset}${quote}`;
        if (Object.keys(exchangeMap).length === 0 || exchangeMap[sym]) {
          candidateSymbols.add(sym);
        }
      }
    }

    const updatedFromIds: Record<string, number> = { ...existingLedger.symbolFromIds };
    const symbolsList = [...candidateSymbols].slice(0, 80);

    await mapLimited(symbolsList, 4, async (symbol) => {
      let nextFromId = fullHistory ? 0 : (updatedFromIds[symbol] ? updatedFromIds[symbol] + 1 : 0);
      for (let page = 0; page < 10; page++) {
        const res = await callBinanceSigned<Array<Record<string, unknown>>>('/api/v3/myTrades', {
          method: 'GET',
          params: { symbol, fromId: nextFromId, limit: 1000 },
          config,
        });
        if (!res.success) {
          // Ignore invalid symbol errors quietly during auto-discovery
          if (res.code !== -1121) {
            warnings.push(`Trades (${symbol}): ${res.error}`);
          }
          break;
        }
        const rows = Array.isArray(res.data) ? res.data : [];
        if (rows.length === 0) break;

        const pair = splitSymbolPair(symbol, exchangeMap);
        let maxId = nextFromId;
        for (const r of rows) {
          const rawId = Number(r.id);
          if (Number.isFinite(rawId) && rawId > maxId) maxId = rawId;
          const norm = normalizeSpotTrade(r, symbol, pair, tickerMap as Record<string, BinanceTicker24h>);
          if (norm) incomingTrades.push(norm);
        }
        updatedFromIds[symbol] = maxId;
        if (rows.length < 1000) break;
        nextFromId = maxId + 1;
      }
    });

    const completedIso = new Date().toISOString();
    const mergedTrades = mergeTradesById(existingLedger.trades, incomingTrades);
    const mergedFunding = mergeFundingById(existingLedger.fundingEvents, incomingFunding);

    const effectiveTokenizedMap = {
      ...(existingLedger.tokenizedAssetMap || {}),
      ...tokenizedMap,
    };

    const updatedLedger = {
      version: 1 as const,
      lastSyncAt: completedIso,
      lastHistorySyncMs: nowMs,
      symbolFromIds: updatedFromIds,
      trades: mergedTrades,
      fundingEvents: mergedFunding,
      costBasisOverrides: existingLedger.costBasisOverrides,
      customSymbols,
      lastBalances: balances,
      tokenizedAssetMap: effectiveTokenizedMap,
      equityNetAdjustment,
    };

    await saveStoredBinanceLedger(session, updatedLedger);

    const equitySymbols = new Set<string>();
    for (const b of balances) {
      if (effectiveTokenizedMap[b.asset]) equitySymbols.add(effectiveTokenizedMap[b.asset]);
      else if ((b.equityQty || 0) > 0) equitySymbols.add(b.asset);
    }
    for (const tr of mergedTrades) {
      if (tr.source === 'equity') equitySymbols.add(tr.baseAsset);
    }
    const equityPrices = await fetchBinanceEquityQuotes([...equitySymbols], config);

    const analytics = computeBinanceAnalytics({
      balances,
      trades: mergedTrades,
      fundingEvents: mergedFunding,
      tickerMap,
      usdToMyr,
      costBasisOverrides: updatedLedger.costBasisOverrides,
      equityPrices,
      tokenizedAssetMap: effectiveTokenizedMap,
      equityNetAdjustment,
    });

    const response = NextResponse.json({
      success: true,
      mode: fullHistory ? 'full' : 'incremental',
      lastSyncAt: completedIso,
      usdToMyr,
      newTradesImported: Math.max(0, mergedTrades.length - existingLedger.trades.length),
      newFundingEventsImported: Math.max(0, mergedFunding.length - existingLedger.fundingEvents.length),
      balances,
      analytics,
      ledger: {
        trades: mergedTrades,
        fundingEvents: mergedFunding,
        costBasisOverrides: updatedLedger.costBasisOverrides,
        customSymbols: updatedLedger.customSymbols,
      },
      warnings,
    });
    if (refreshed) setSessionCookie(response, session);
    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Binance sync failed.';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
