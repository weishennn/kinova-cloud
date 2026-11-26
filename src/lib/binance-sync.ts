export const BINANCE_LEDGER_META_KEY = 'binance_ledger_v1_meta';
export const BINANCE_LEDGER_CHUNK_PREFIX = 'binance_ledger_v1_chunk_';
export const BINANCE_LOCAL_CACHE_PREFIX = 'cashflow_binance_ledger_v1_';
export const BINANCE_MAX_CHUNK_CHARS = 40_000;

export const STABLECOIN_ASSETS = new Set([
  'USDT',
  'USDC',
  'FDUSD',
  'BUSD',
  'TUSD',
  'USDP',
  'DAI',
  'USD',
]);

export const QUOTE_PRIORITY = ['USDT', 'FDUSD', 'USDC', 'BUSD', 'TUSD', 'BTC', 'ETH', 'BNB'];

export interface BinanceTicker24h {
  symbol: string;
  lastPrice: number;
  priceChangePercent: number;
  quoteVolume?: number;
}

export interface BinanceWalletBalance {
  asset: string;
  spotFree: number;
  spotLocked: number;
  spotQty: number;
  fundingFree: number;
  fundingLocked: number;
  fundingFreeze: number;
  fundingWithdrawing: number;
  fundingQty: number;
  equityQty?: number;
  totalQty: number;
}

export type BinanceFundingKind =
  | 'p2p_buy'
  | 'p2p_sell'
  | 'fiat_deposit'
  | 'fiat_withdraw'
  | 'crypto_deposit'
  | 'crypto_withdraw'
  | 'internal_transfer';

export interface BinanceFundingEvent {
  id: string;
  timestamp: number;
  date: string;
  kind: BinanceFundingKind;
  direction: 'in' | 'out' | 'neutral';
  asset: string;
  amount: number;
  fiatCurrency?: string;
  fiatAmount?: number;
  usdValue: number;
  status: string;
  network?: string;
  txId?: string;
  note?: string;
}

export interface BinanceTradeExecution {
  id: string;
  timestamp: number;
  date: string;
  source: 'spot' | 'convert' | 'dust' | 'equity';
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  priceUsd: number;
  totalUsd: number;
  feeUsd: number;
  commissionAsset?: string;
  rawCommission?: number;
  note?: string;
}

export interface BinanceStoredLedger {
  version: 1;
  lastSyncAt: string;
  lastHistorySyncMs: number;
  symbolFromIds: Record<string, number>;
  trades: BinanceTradeExecution[];
  fundingEvents: BinanceFundingEvent[];
  costBasisOverrides: Record<string, number>; // fundingEventId -> override USD total cost
  customSymbols: string[];
  lastBalances?: BinanceWalletBalance[];
  tokenizedAssetMap?: Record<string, string>; // tokenizedAsset (e.g. AAPLB) -> underlying (AAPL)
  equityNetAdjustment?: Record<string, number>; // underlying symbol -> net minted/redeemed adjustment
  equityHistorySynced?: boolean;
}

export interface BinanceHoldingSummary {
  asset: string;
  assetKind: 'Crypto' | 'Stock';
  isStablecoin: boolean;
  spotQty: number;
  fundingQty: number;
  equityQty: number;
  lockedQty: number;
  totalQty: number;
  livePriceUsd: number;
  change24hPct: number;
  marketValueUsd: number;
  marketValueMyr: number;
  avgCostFifoUsd: number;
  avgCostWeightedUsd: number;
  totalCostFifoUsd: number;
  totalCostWeightedUsd: number;
  unrealizedPnlFifoUsd: number;
  unrealizedPnlWeightedUsd: number;
  unrealizedPctFifo: number;
  unrealizedPctWeighted: number;
  realizedPnlFifoUsd: number;
  realizedPnlWeightedUsd: number;
  totalFeesUsd: number;
  tradesCount: number;
  closedTradesCount: number;
  untrackedQty: number;
  status: 'active' | 'closed' | 'stablecoin';
}

export interface BinanceFundingSummary {
  totalDepositedUsd: number;
  totalDepositedMyr: number;
  totalWithdrawnUsd: number;
  totalWithdrawnMyr: number;
  netFundedUsd: number;
  netFundedMyr: number;
  p2pBuyUsd: number;
  p2pSellUsd: number;
  fiatDepositUsd: number;
  fiatWithdrawUsd: number;
  cryptoDepositUsd: number;
  cryptoWithdrawUsd: number;
}

export interface BinanceTradeRealizedInfo {
  tradeId: string;
  realizedFifoUsd: number;
  realizedWeightedUsd: number;
  costSoldFifoUsd: number;
  costSoldWeightedUsd: number;
  proceedsUsd: number;
  returnPctFifo: number;
  returnPctWeighted: number;
}

export interface BinanceAnalyticsReport {
  holdings: BinanceHoldingSummary[];
  fundingSummary: BinanceFundingSummary;
  tradeRealizedMap: Record<string, BinanceTradeRealizedInfo>;
  totals: {
    totalValueUsd: number;
    totalValueMyr: number;
    spotValueUsd: number;
    fundingValueUsd: number;
    stablecoinValueUsd: number;
    activeCostFifoUsd: number;
    activeCostWeightedUsd: number;
    unrealizedPnlFifoUsd: number;
    unrealizedPnlWeightedUsd: number;
    unrealizedPctFifo: number;
    unrealizedPctWeighted: number;
    realizedPnlFifoUsd: number;
    realizedPnlWeightedUsd: number;
    totalFeesUsd: number;
    trueNetReturnUsd: number;
    trueNetReturnMyr: number;
    trueNetReturnPct: number;
  };
}

export function createEmptyBinanceLedger(): BinanceStoredLedger {
  return {
    version: 1,
    lastSyncAt: '',
    lastHistorySyncMs: 0,
    symbolFromIds: {},
    trades: [],
    fundingEvents: [],
    costBasisOverrides: {},
    customSymbols: [],
    lastBalances: [],
  };
}

export function formatKlDate(timestampMs: number): string {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kuala_Lumpur',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestampMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function toNum(val: unknown): number {
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
}

export function buildTickerMap(rawTickers: Array<Record<string, unknown>>): Record<string, BinanceTicker24h> {
  const map: Record<string, BinanceTicker24h> = {};
  for (const row of rawTickers) {
    const symbol = String(row.symbol || '').trim().toUpperCase();
    if (!symbol) continue;
    const lastPrice = toNum(row.lastPrice ?? row.price);
    const priceChangePercent = toNum(row.priceChangePercent);
    const quoteVolume = toNum(row.quoteVolume);
    if (lastPrice > 0) {
      map[symbol] = { symbol, lastPrice, priceChangePercent, quoteVolume };
    }
  }
  return map;
}

export function extractWalletUsdValuations(
  allWalletRows: Array<{
    assetBalances?: Array<{
      asset?: unknown;
      free?: unknown;
      locked?: unknown;
      freeze?: unknown;
      withdrawing?: unknown;
      btcValuation?: unknown;
    }>;
  }>,
  btcPriceUsd: number
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!Number.isFinite(btcPriceUsd) || btcPriceUsd <= 0) return out;
  for (const w of allWalletRows) {
    for (const item of w.assetBalances || []) {
      const asset = String(item.asset || '').trim().toUpperCase();
      const btcVal = Math.max(0, toNum(item.btcValuation));
      const qty =
        Math.max(0, toNum(item.free)) +
        Math.max(0, toNum(item.locked)) +
        Math.max(0, toNum(item.freeze)) +
        Math.max(0, toNum(item.withdrawing));
      if (asset && btcVal > 0 && qty > 0 && !out[asset]) {
        out[asset] = (btcVal * btcPriceUsd) / qty;
      }
    }
  }
  return out;
}

export function resolveAssetPriceUsd(
  asset: string,
  tickerMap: Record<string, BinanceTicker24h>,
  equityPrices: Record<string, { priceUsd: number; change24hPct: number }> = {},
  tokenizedAssetMap: Record<string, string> = {},
  fallbackUsdPriceMap: Record<string, number> = {}
): { priceUsd: number; change24hPct: number } {
  const clean = asset.trim().toUpperCase();
  if (!clean) return { priceUsd: 0, change24hPct: 0 };
  if (STABLECOIN_ASSETS.has(clean)) {
    const direct = tickerMap[`${clean}USDT`];
    return {
      priceUsd: direct && direct.lastPrice > 0 ? direct.lastPrice : 1,
      change24hPct: direct ? direct.priceChangePercent : 0,
    };
  }

  for (const q of ['USDT', 'FDUSD', 'USDC', 'BUSD']) {
    const t = tickerMap[`${clean}${q}`];
    if (t && t.lastPrice > 0) {
      return { priceUsd: t.lastPrice, change24hPct: t.priceChangePercent };
    }
  }

  const underlying = tokenizedAssetMap[clean]
    || (clean.length >= 3 && (clean.endsWith('ON') || clean.endsWith('B')) ? clean.replace(/(ON|B)$/, '') : clean);
  if (equityPrices[clean]?.priceUsd > 0) {
    return equityPrices[clean];
  }
  if (equityPrices[underlying]?.priceUsd > 0) {
    return equityPrices[underlying];
  }

  const btcPair = tickerMap[`${clean}BTC`];
  const btcUsdt = tickerMap.BTCUSDT;
  if (btcPair && btcUsdt && btcPair.lastPrice > 0 && btcUsdt.lastPrice > 0) {
    return {
      priceUsd: btcPair.lastPrice * btcUsdt.lastPrice,
      change24hPct: btcPair.priceChangePercent + btcUsdt.priceChangePercent,
    };
  }

  const bnbPair = tickerMap[`${clean}BNB`];
  const bnbUsdt = tickerMap.BNBUSDT;
  if (bnbPair && bnbUsdt && bnbPair.lastPrice > 0 && bnbUsdt.lastPrice > 0) {
    return {
      priceUsd: bnbPair.lastPrice * bnbUsdt.lastPrice,
      change24hPct: bnbPair.priceChangePercent + bnbUsdt.priceChangePercent,
    };
  }

  if (fallbackUsdPriceMap[clean] > 0) {
    return { priceUsd: fallbackUsdPriceMap[clean], change24hPct: 0 };
  }

  return { priceUsd: 0, change24hPct: 0 };
}

export function mergeSpotAndFundingBalances(
  spotBalances: Array<{ asset?: unknown; free?: unknown; locked?: unknown }>,
  fundingBalances: Array<{
    asset?: unknown;
    free?: unknown;
    locked?: unknown;
    freeze?: unknown;
    withdrawing?: unknown;
  }>,
  allWalletRows: Array<{
    walletName?: unknown;
    activate?: unknown;
    assetBalances?: Array<{
      asset?: unknown;
      free?: unknown;
      locked?: unknown;
      freeze?: unknown;
      withdrawing?: unknown;
    }>;
  }> = []
): BinanceWalletBalance[] {
  const byAsset = new Map<string, BinanceWalletBalance>();
  const ensure = (asset: string) => {
    const clean = asset.trim().toUpperCase();
    let row = byAsset.get(clean);
    if (!row) {
      row = {
        asset: clean,
        spotFree: 0,
        spotLocked: 0,
        spotQty: 0,
        fundingFree: 0,
        fundingLocked: 0,
        fundingFreeze: 0,
        fundingWithdrawing: 0,
        fundingQty: 0,
        equityQty: 0,
        totalQty: 0,
      };
      byAsset.set(clean, row);
    }
    return row;
  };

  for (const b of spotBalances) {
    const asset = String(b.asset || '').trim().toUpperCase();
    if (!asset) continue;
    const free = Math.max(0, toNum(b.free));
    const locked = Math.max(0, toNum(b.locked));
    if (free + locked <= 0) continue;
    const row = ensure(asset);
    row.spotFree += free;
    row.spotLocked += locked;
    row.spotQty = row.spotFree + row.spotLocked;
    row.totalQty = row.spotQty + row.fundingQty + (row.equityQty || 0);
  }

  for (const f of fundingBalances) {
    const asset = String(f.asset || '').trim().toUpperCase();
    if (!asset) continue;
    const free = Math.max(0, toNum(f.free));
    const locked = Math.max(0, toNum(f.locked));
    const freeze = Math.max(0, toNum(f.freeze));
    const withdrawing = Math.max(0, toNum(f.withdrawing));
    if (free + locked + freeze + withdrawing <= 0) continue;
    const row = ensure(asset);
    row.fundingFree += free;
    row.fundingLocked += locked;
    row.fundingFreeze += freeze;
    row.fundingWithdrawing += withdrawing;
    row.fundingQty = row.fundingFree + row.fundingLocked + row.fundingFreeze + row.fundingWithdrawing;
    row.totalQty = row.spotQty + row.fundingQty + (row.equityQty || 0);
  }

  // Merge any extra wallets (e.g. Stock/Equity/TradFi/Alpha) from /sapi/v1/asset/wallet/balance
  for (const w of allWalletRows) {
    const walletName = String(w.walletName || '').trim().toLowerCase();
    if (!walletName || walletName === 'spot' || walletName === 'funding') continue;
    if (/margin|futures|coin-m|isolated|options/.test(walletName)) continue;
    const list = Array.isArray(w.assetBalances) ? w.assetBalances : [];
    for (const item of list) {
      const asset = String(item.asset || '').trim().toUpperCase();
      if (!asset) continue;
      const qty =
        Math.max(0, toNum(item.free)) +
        Math.max(0, toNum(item.locked)) +
        Math.max(0, toNum(item.freeze)) +
        Math.max(0, toNum(item.withdrawing));
      if (qty <= 0) continue;
      const row = ensure(asset);
      row.equityQty = (row.equityQty || 0) + qty;
      row.totalQty = row.spotQty + row.fundingQty + row.equityQty;
    }
  }

  return [...byAsset.values()].filter((r) => r.totalQty > 1e-12);
}

/**
 * Splits an exchange symbol like "BTCUSDT" into { baseAsset, quoteAsset } using exchangeInfo or quote list.
 */
export function splitSymbolPair(
  symbol: string,
  exchangeSymbolMap?: Record<string, { baseAsset: string; quoteAsset: string }>
): { baseAsset: string; quoteAsset: string } {
  const clean = symbol.trim().toUpperCase();
  if (exchangeSymbolMap?.[clean]) return exchangeSymbolMap[clean];
  for (const q of QUOTE_PRIORITY) {
    if (clean.endsWith(q) && clean.length > q.length) {
      return { baseAsset: clean.slice(0, clean.length - q.length), quoteAsset: q };
    }
  }
  return { baseAsset: clean, quoteAsset: 'USDT' };
}

export function normalizeSpotTrade(
  raw: Record<string, unknown>,
  symbol: string,
  pair: { baseAsset: string; quoteAsset: string },
  tickerMap: Record<string, BinanceTicker24h>
): BinanceTradeExecution | null {
  const tradeId = String(raw.id ?? '').trim();
  const timestamp = toNum(raw.time);
  const qty = toNum(raw.qty);
  const price = toNum(raw.price);
  const quoteQty = toNum(raw.quoteQty) || qty * price;
  if (!tradeId || timestamp <= 0 || qty <= 0) return null;

  const isBuyer = raw.isBuyer === true;
  const side: 'BUY' | 'SELL' = isBuyer ? 'BUY' : 'SELL';
  const commission = Math.max(0, toNum(raw.commission));
  const commissionAsset = String(raw.commissionAsset || '').trim().toUpperCase();

  const quotePriceUsd = resolveAssetPriceUsd(pair.quoteAsset, tickerMap).priceUsd || 1;
  const totalUsd = quoteQty * quotePriceUsd;

  let effectiveQty = qty;
  let feeUsd = 0;

  if (commission > 0 && commissionAsset) {
    if (commissionAsset === pair.baseAsset) {
      const basePriceUsd = totalUsd > 0 && qty > 0 ? totalUsd / qty : resolveAssetPriceUsd(pair.baseAsset, tickerMap).priceUsd;
      feeUsd = commission * basePriceUsd;
      if (side === 'BUY') {
        // Gross qty was traded, commission was deducted in baseAsset so net units added = qty - commission
        effectiveQty = Math.max(0, qty - commission);
      }
    } else if (commissionAsset === pair.quoteAsset) {
      feeUsd = commission * quotePriceUsd;
    } else {
      const commPriceUsd = resolveAssetPriceUsd(commissionAsset, tickerMap).priceUsd;
      feeUsd = commission * commPriceUsd;
    }
  }

  const priceUsd = effectiveQty > 0 ? totalUsd / effectiveQty : price * quotePriceUsd;

  return {
    id: `spot_${symbol.toUpperCase()}_${tradeId}`,
    timestamp,
    date: formatKlDate(timestamp),
    source: 'spot',
    symbol: symbol.toUpperCase(),
    baseAsset: pair.baseAsset.toUpperCase(),
    quoteAsset: pair.quoteAsset.toUpperCase(),
    side,
    quantity: effectiveQty,
    priceUsd,
    totalUsd,
    feeUsd,
    commissionAsset: commissionAsset || undefined,
    rawCommission: commission || undefined,
    note: `Spot ${side} ${symbol.toUpperCase()}`,
  };
}

export function normalizeEquityTrade(
  raw: Record<string, unknown>,
  tickerMap: Record<string, BinanceTicker24h>,
  feeUsdOverride?: number
): BinanceTradeExecution | null {
  const executionId = String(raw.executionId || raw.id || raw.orderId || '').trim();
  const symbol = String(raw.symbol || '').trim().toUpperCase();
  const quote = String(raw.quote || 'USDC').trim().toUpperCase();
  const sideRaw = String(raw.side || '').trim().toUpperCase();
  const side: 'BUY' | 'SELL' = sideRaw === 'SELL' ? 'SELL' : 'BUY';
  const qty = Math.max(0, toNum(raw.qty ?? raw.filledQty));
  const price = Math.max(0, toNum(raw.price ?? raw.avgFilledPrice));
  const rawTotal = Math.max(0, toNum(raw.total ?? raw.filledTotal)) || qty * price;
  const timestamp = toNum(raw.executionAt ?? raw.updatedAt ?? raw.createdAt);

  if (!executionId || !symbol || qty <= 0 || timestamp <= 0) return null;

  const quotePriceUsd = resolveAssetPriceUsd(quote, tickerMap).priceUsd || 1;
  const totalUsd = rawTotal * quotePriceUsd;
  const priceUsd = qty > 0 ? totalUsd / qty : price * quotePriceUsd;
  const feeUsd = Math.max(0, feeUsdOverride ?? toNum(raw.fee)) * quotePriceUsd;

  return {
    id: `eq_${symbol}_${executionId}`,
    timestamp,
    date: formatKlDate(timestamp),
    source: 'equity',
    symbol: `${symbol}${quote}`,
    baseAsset: symbol,
    quoteAsset: quote,
    side,
    quantity: qty,
    priceUsd,
    totalUsd,
    feeUsd,
    commissionAsset: quote,
    note: `Binance Stock ${side} ${symbol} (${quote})`,
  };
}

export function normalizeConvertTrade(
  raw: Record<string, unknown>,
  tickerMap: Record<string, BinanceTicker24h>
): BinanceTradeExecution[] {
  const orderId = String(raw.orderId ?? raw.quoteId ?? '').trim();
  const timestamp = toNum(raw.createTime);
  const fromAsset = String(raw.fromAsset || '').trim().toUpperCase();
  const toAsset = String(raw.toAsset || '').trim().toUpperCase();
  const fromAmount = Math.max(0, toNum(raw.fromAmount));
  const toAmount = Math.max(0, toNum(raw.toAmount));
  const status = String(raw.orderStatus || '').toUpperCase();
  if (!orderId || timestamp <= 0 || !fromAsset || !toAsset || fromAmount <= 0 || toAmount <= 0) return [];
  if (status && status !== 'SUCCESS') return [];

  const out: BinanceTradeExecution[] = [];
  const fromIsStable = STABLECOIN_ASSETS.has(fromAsset);
  const toIsStable = STABLECOIN_ASSETS.has(toAsset);

  if (fromIsStable && !toIsStable) {
    out.push({
      id: `conv_${orderId}_buy`,
      timestamp,
      date: formatKlDate(timestamp),
      source: 'convert',
      symbol: `${toAsset}${fromAsset}`,
      baseAsset: toAsset,
      quoteAsset: fromAsset,
      side: 'BUY',
      quantity: toAmount,
      priceUsd: fromAmount / toAmount,
      totalUsd: fromAmount,
      feeUsd: 0,
      note: `Convert ${fromAmount} ${fromAsset} → ${toAmount} ${toAsset}`,
    });
  } else if (!fromIsStable && toIsStable) {
    out.push({
      id: `conv_${orderId}_sell`,
      timestamp,
      date: formatKlDate(timestamp),
      source: 'convert',
      symbol: `${fromAsset}${toAsset}`,
      baseAsset: fromAsset,
      quoteAsset: toAsset,
      side: 'SELL',
      quantity: fromAmount,
      priceUsd: toAmount / fromAmount,
      totalUsd: toAmount,
      feeUsd: 0,
      note: `Convert ${fromAmount} ${fromAsset} → ${toAmount} ${toAsset}`,
    });
  } else if (!fromIsStable && !toIsStable) {
    const toUsd = toAmount * (resolveAssetPriceUsd(toAsset, tickerMap).priceUsd || 0);
    const fromUsd = fromAmount * (resolveAssetPriceUsd(fromAsset, tickerMap).priceUsd || 0);
    const legUsd = toUsd > 0 ? toUsd : fromUsd;
    out.push({
      id: `conv_${orderId}_sell`,
      timestamp,
      date: formatKlDate(timestamp),
      source: 'convert',
      symbol: `${fromAsset}${toAsset}`,
      baseAsset: fromAsset,
      quoteAsset: toAsset,
      side: 'SELL',
      quantity: fromAmount,
      priceUsd: fromAmount > 0 ? legUsd / fromAmount : 0,
      totalUsd: legUsd,
      feeUsd: 0,
      note: `Convert Swap Out: ${fromAmount} ${fromAsset} → ${toAsset}`,
    });
    out.push({
      id: `conv_${orderId}_buy`,
      timestamp: timestamp + 1,
      date: formatKlDate(timestamp),
      source: 'convert',
      symbol: `${toAsset}${fromAsset}`,
      baseAsset: toAsset,
      quoteAsset: fromAsset,
      side: 'BUY',
      quantity: toAmount,
      priceUsd: toAmount > 0 ? legUsd / toAmount : 0,
      totalUsd: legUsd,
      feeUsd: 0,
      note: `Convert Swap In: ${fromAsset} → ${toAmount} ${toAsset}`,
    });
  }
  return out;
}

export function normalizeC2cOrder(
  raw: Record<string, unknown>,
  usdToMyr: number
): BinanceFundingEvent | null {
  const orderNumber = String(raw.orderNumber || '').trim();
  const timestamp = toNum(raw.createTime);
  const status = String(raw.orderStatus || '').toUpperCase();
  if (!orderNumber || timestamp <= 0) return null;
  if (status && status !== 'COMPLETED') return null;

  const tradeType = String(raw.tradeType || '').toUpperCase(); // BUY | SELL
  const asset = String(raw.asset || '').trim().toUpperCase();
  const amount = Math.max(0, toNum(raw.amount));
  const fiatCurrency = String(raw.fiat || raw.fiatCurrency || '').trim().toUpperCase();
  const fiatAmount = Math.max(0, toNum(raw.totalPrice));
  if (!asset || amount <= 0) return null;

  const isBuy = tradeType === 'BUY';
  let usdValue = amount;
  if (!STABLECOIN_ASSETS.has(asset)) {
    if (fiatCurrency === 'USD') usdValue = fiatAmount;
    else if (fiatCurrency === 'MYR' && usdToMyr > 0) usdValue = fiatAmount / usdToMyr;
  }

  return {
    id: `c2c_${orderNumber}`,
    timestamp,
    date: formatKlDate(timestamp),
    kind: isBuy ? 'p2p_buy' : 'p2p_sell',
    direction: isBuy ? 'in' : 'out',
    asset,
    amount,
    fiatCurrency: fiatCurrency || undefined,
    fiatAmount: fiatAmount || undefined,
    usdValue,
    status: 'COMPLETED',
    note: `P2P ${tradeType} ${amount} ${asset}${fiatCurrency ? ` (${fiatCurrency} ${fiatAmount.toFixed(2)})` : ''}`,
  };
}

export function normalizeFiatOrder(
  raw: Record<string, unknown>,
  transactionType: 0 | 1,
  usdToMyr: number
): BinanceFundingEvent | null {
  const orderNo = String(raw.orderNo || '').trim();
  const timestamp = toNum(raw.createTime || raw.updateTime);
  const status = String(raw.status || '').toUpperCase();
  if (!orderNo || timestamp <= 0) return null;
  if (status && status !== 'SUCCESSFUL' && status !== 'COMPLETED' && status !== 'FINISHED') return null;

  const fiatCurrency = String(raw.fiatCurrency || 'USD').trim().toUpperCase();
  const amount = Math.max(0, toNum(raw.amount) || toNum(raw.indicatedAmount));
  if (amount <= 0) return null;

  const usdValue = fiatCurrency === 'USD'
    ? amount
    : fiatCurrency === 'MYR' && usdToMyr > 0
      ? amount / usdToMyr
      : amount;

  return {
    id: `fiat_${transactionType}_${orderNo}`,
    timestamp,
    date: formatKlDate(timestamp),
    kind: transactionType === 0 ? 'fiat_deposit' : 'fiat_withdraw',
    direction: transactionType === 0 ? 'in' : 'out',
    asset: fiatCurrency,
    amount,
    fiatCurrency,
    fiatAmount: amount,
    usdValue,
    status,
    note: `Fiat ${transactionType === 0 ? 'Deposit' : 'Withdraw'} (${raw.method || 'Bank/Card'})`,
  };
}

export function normalizeCryptoTransfer(
  raw: Record<string, unknown>,
  kind: 'crypto_deposit' | 'crypto_withdraw',
  tickerMap: Record<string, BinanceTicker24h>
): BinanceFundingEvent | null {
  const id = String(raw.id || raw.txId || '').trim();
  const asset = String(raw.coin || raw.asset || '').trim().toUpperCase();
  const amount = Math.max(0, toNum(raw.amount));
  const timestamp = kind === 'crypto_deposit'
    ? toNum(raw.insertTime)
    : toNum(Date.parse(String(raw.applyTime || '')) || raw.applyTime);

  if (!id || !asset || amount <= 0 || !Number.isFinite(timestamp) || timestamp <= 0) return null;

  // For deposits: status 1 = success, 6 = credited. For withdrawals: status 6 = completed.
  const statusNum = Number(raw.status);
  if (kind === 'crypto_deposit' && Number.isFinite(statusNum) && statusNum !== 1 && statusNum !== 6) return null;
  if (kind === 'crypto_withdraw' && Number.isFinite(statusNum) && statusNum !== 6) return null;

  const priceUsd = resolveAssetPriceUsd(asset, tickerMap).priceUsd;
  const usdValue = amount * priceUsd;

  return {
    id: `${kind === 'crypto_deposit' ? 'dep' : 'wd'}_${id}`,
    timestamp,
    date: formatKlDate(timestamp),
    kind,
    direction: kind === 'crypto_deposit' ? 'in' : 'out',
    asset,
    amount,
    usdValue,
    status: 'COMPLETED',
    network: String(raw.network || '').trim() || undefined,
    txId: String(raw.txId || '').trim() || undefined,
    note: `${kind === 'crypto_deposit' ? 'On-chain Deposit' : 'On-chain Withdrawal'} (${raw.network || asset})`,
  };
}

export function computeFundingSummary(
  events: BinanceFundingEvent[],
  usdToMyr: number,
  costBasisOverrides: Record<string, number> = {}
): BinanceFundingSummary {
  const summary: BinanceFundingSummary = {
    totalDepositedUsd: 0,
    totalDepositedMyr: 0,
    totalWithdrawnUsd: 0,
    totalWithdrawnMyr: 0,
    netFundedUsd: 0,
    netFundedMyr: 0,
    p2pBuyUsd: 0,
    p2pSellUsd: 0,
    fiatDepositUsd: 0,
    fiatWithdrawUsd: 0,
    cryptoDepositUsd: 0,
    cryptoWithdrawUsd: 0,
  };

  for (const ev of events) {
    if (ev.direction === 'neutral' || ev.kind === 'internal_transfer') continue;
    const override = costBasisOverrides[ev.id];
    const usdVal = Number.isFinite(override) && override >= 0 ? override : ev.usdValue;
    const myrVal =
      !Number.isFinite(override) && ev.fiatCurrency === 'MYR' && Number(ev.fiatAmount) > 0
        ? Number(ev.fiatAmount)
        : usdVal * usdToMyr;

    if (ev.direction === 'in') {
      summary.totalDepositedUsd += usdVal;
      summary.totalDepositedMyr += myrVal;
      if (ev.kind === 'p2p_buy') summary.p2pBuyUsd += usdVal;
      else if (ev.kind === 'fiat_deposit') summary.fiatDepositUsd += usdVal;
      else if (ev.kind === 'crypto_deposit') summary.cryptoDepositUsd += usdVal;
    } else if (ev.direction === 'out') {
      summary.totalWithdrawnUsd += usdVal;
      summary.totalWithdrawnMyr += myrVal;
      if (ev.kind === 'p2p_sell') summary.p2pSellUsd += usdVal;
      else if (ev.kind === 'fiat_withdraw') summary.fiatWithdrawUsd += usdVal;
      else if (ev.kind === 'crypto_withdraw') summary.cryptoWithdrawUsd += usdVal;
    }
  }

  summary.netFundedUsd = summary.totalDepositedUsd - summary.totalWithdrawnUsd;
  summary.netFundedMyr = summary.totalDepositedMyr - summary.totalWithdrawnMyr;
  return summary;
}

export function computeBinanceAnalytics(params: {
  balances: BinanceWalletBalance[];
  trades: BinanceTradeExecution[];
  fundingEvents: BinanceFundingEvent[];
  tickerMap: Record<string, BinanceTicker24h>;
  usdToMyr: number;
  costBasisOverrides?: Record<string, number>;
  equityPrices?: Record<string, { priceUsd: number; change24hPct: number }>;
  tokenizedAssetMap?: Record<string, string>;
  equityNetAdjustment?: Record<string, number>;
  fallbackUsdPriceMap?: Record<string, number>;
}): BinanceAnalyticsReport {
  const {
    balances,
    trades,
    fundingEvents,
    tickerMap,
    usdToMyr,
    costBasisOverrides = {},
    equityPrices = {},
    tokenizedAssetMap = {},
    equityNetAdjustment = {},
    fallbackUsdPriceMap = {},
  } = params;

  const balanceMap = new Map<string, BinanceWalletBalance>();
  for (const b of balances) {
    balanceMap.set(b.asset.toUpperCase(), b);
  }

  const tradesByAsset = new Map<string, BinanceTradeExecution[]>();
  const equityAssetSet = new Set<string>(Object.keys(tokenizedAssetMap).map((k) => k.toUpperCase()));
  for (const tr of trades) {
    const asset = tr.baseAsset.toUpperCase();
    if (!asset || STABLECOIN_ASSETS.has(asset)) continue;
    if (tr.source === 'equity') equityAssetSet.add(asset);
    const list = tradesByAsset.get(asset) || [];
    list.push(tr);
    tradesByAsset.set(asset, list);
  }

  const allAssets = new Set<string>([
    ...balanceMap.keys(),
    ...tradesByAsset.keys(),
  ]);

  const tradeRealizedMap: Record<string, BinanceTradeRealizedInfo> = {};
  const holdings: BinanceHoldingSummary[] = [];

  for (const asset of allAssets) {
    const bal = balanceMap.get(asset);
    const spotQty = bal?.spotQty ?? 0;
    const fundingQty = bal?.fundingQty ?? 0;
    let equityQty = bal?.equityQty ?? 0;
    const lockedQty = (bal?.spotLocked ?? 0) + (bal?.fundingLocked ?? 0) + (bal?.fundingFreeze ?? 0);
    let totalQty = bal?.totalQty ?? 0;

    const isStablecoin = STABLECOIN_ASSETS.has(asset);
    const assetTrades = [...(tradesByAsset.get(asset) || [])].sort((a, b) => a.timestamp - b.timestamp);
    const strippedOndoOrB = asset.length >= 3 && (asset.endsWith('ON') || asset.endsWith('B'))
      ? asset.replace(/(ON|B)$/, '')
      : '';
    const isStock =
      equityAssetSet.has(asset) ||
      Boolean(tokenizedAssetMap[asset]) ||
      (bal?.equityQty || 0) > 0 ||
      Boolean(strippedOndoOrB && equityPrices[strippedOndoOrB]?.priceUsd > 0);

    // If Binance US Equities doesn't expose un-tokenized equity shares in Spot/Funding/wallet balance,
    // derive remaining equity shares held from equity trade fills minus any minted tokenized shares.
    if (isStock && totalQty <= 1e-10) {
      let netEqQty = 0;
      for (const tr of assetTrades) {
        if (tr.source === 'equity') {
          netEqQty += tr.side === 'BUY' ? tr.quantity : -tr.quantity;
        }
      }
      netEqQty += Number(equityNetAdjustment[asset] || 0);
      if (netEqQty > 1e-8) {
        equityQty = netEqQty;
        totalQty = netEqQty;
      }
    }

    const { priceUsd: livePriceUsd, change24hPct } = resolveAssetPriceUsd(
      asset,
      tickerMap,
      equityPrices,
      tokenizedAssetMap,
      fallbackUsdPriceMap
    );
    const marketValueUsd = totalQty * livePriceUsd;
    const marketValueMyr = marketValueUsd * usdToMyr;

    if (isStablecoin) {
      if (totalQty <= 1e-8) continue;
      holdings.push({
        asset,
        assetKind: 'Crypto',
        isStablecoin: true,
        spotQty,
        fundingQty,
        equityQty: 0,
        lockedQty,
        totalQty,
        livePriceUsd,
        change24hPct,
        marketValueUsd,
        marketValueMyr,
        avgCostFifoUsd: livePriceUsd,
        avgCostWeightedUsd: livePriceUsd,
        totalCostFifoUsd: marketValueUsd,
        totalCostWeightedUsd: marketValueUsd,
        unrealizedPnlFifoUsd: 0,
        unrealizedPnlWeightedUsd: 0,
        unrealizedPctFifo: 0,
        unrealizedPctWeighted: 0,
        realizedPnlFifoUsd: 0,
        realizedPnlWeightedUsd: 0,
        totalFeesUsd: 0,
        tradesCount: 0,
        closedTradesCount: 0,
        untrackedQty: 0,
        status: 'stablecoin',
      });
      continue;
    }

    const fifoLots: Array<{ qty: number; unitCostUsd: number }> = [];
    let wQty = 0;
    let wTotalCostUsd = 0;
    let realizedFifoUsd = 0;
    let realizedWeightedUsd = 0;
    let totalFeesUsd = 0;
    let closedTradesCount = 0;

    for (const tr of assetTrades) {
      totalFeesUsd += tr.feeUsd;
      if (tr.side === 'BUY') {
        if (tr.quantity <= 0) continue;
        const costWithFee = tr.totalUsd + tr.feeUsd;
        fifoLots.push({ qty: tr.quantity, unitCostUsd: costWithFee / tr.quantity });
        wQty += tr.quantity;
        wTotalCostUsd += costWithFee;
      } else {
        if (tr.quantity <= 0) continue;
        const netProceeds = Math.max(0, tr.totalUsd - tr.feeUsd);
        const proceedsPerUnit = netProceeds / tr.quantity;

        // FIFO consumption
        let remaining = tr.quantity;
        let fifoCostSold = 0;
        while (remaining > 1e-10 && fifoLots.length > 0) {
          const head = fifoLots[0];
          const matched = Math.min(remaining, head.qty);
          fifoCostSold += matched * head.unitCostUsd;
          head.qty -= matched;
          remaining -= matched;
          if (head.qty <= 1e-10) fifoLots.shift();
        }
        const matchedQty = tr.quantity - remaining;
        const matchedProceeds = matchedQty * proceedsPerUnit;
        const txRealizedFifo = matchedProceeds - fifoCostSold;
        realizedFifoUsd += txRealizedFifo;

        // Weighted avg consumption
        const priorAvgW = wQty > 1e-10 ? wTotalCostUsd / wQty : 0;
        const matchedW = Math.min(tr.quantity, wQty);
        const wCostSold = matchedW * priorAvgW;
        const txRealizedW = matchedW * proceedsPerUnit - wCostSold;
        realizedWeightedUsd += txRealizedW;

        wQty = Math.max(0, wQty - tr.quantity);
        wTotalCostUsd = Math.max(0, wTotalCostUsd - wCostSold);
        if (wQty <= 1e-10) {
          wQty = 0;
          wTotalCostUsd = 0;
        }

        closedTradesCount += 1;
        tradeRealizedMap[tr.id] = {
          tradeId: tr.id,
          realizedFifoUsd: txRealizedFifo,
          realizedWeightedUsd: txRealizedW,
          costSoldFifoUsd: fifoCostSold,
          costSoldWeightedUsd: wCostSold,
          proceedsUsd: netProceeds,
          returnPctFifo: fifoCostSold > 0 ? (txRealizedFifo / fifoCostSold) * 100 : 0,
          returnPctWeighted: wCostSold > 0 ? (txRealizedW / wCostSold) * 100 : 0,
        };
      }
    }

    const trackedFifoQty = fifoLots.reduce((sum, l) => sum + l.qty, 0);
    const totalCostFifoUsd = fifoLots.reduce((sum, l) => sum + l.qty * l.unitCostUsd, 0);
    const avgCostFifoUsd = trackedFifoQty > 1e-10 ? totalCostFifoUsd / trackedFifoQty : 0;

    const avgCostWeightedUsd = wQty > 1e-10 ? wTotalCostUsd / wQty : 0;
    const totalCostWeightedUsd = wTotalCostUsd;

    // Only measure unrealized PnL on the quantity we have tracked cost basis for (or full qty if zero untracked).
    const trackedQtyForValuation = totalQty > 0 ? Math.min(totalQty, trackedFifoQty) : 0;
    const untrackedQty = Math.max(0, totalQty - trackedFifoQty);
    const trackedMarketValueUsd = trackedQtyForValuation * livePriceUsd;

    const unrealizedPnlFifoUsd = totalQty > 1e-8 && trackedFifoQty > 1e-8
      ? trackedMarketValueUsd - totalCostFifoUsd
      : 0;
    const unrealizedPnlWeightedUsd = totalQty > 1e-8 && wQty > 1e-8
      ? Math.min(totalQty, wQty) * livePriceUsd - totalCostWeightedUsd
      : 0;

    const unrealizedPctFifo = totalCostFifoUsd > 0 ? (unrealizedPnlFifoUsd / totalCostFifoUsd) * 100 : 0;
    const unrealizedPctWeighted = totalCostWeightedUsd > 0 ? (unrealizedPnlWeightedUsd / totalCostWeightedUsd) * 100 : 0;

    if (totalQty <= 1e-10 && assetTrades.length === 0) continue;

    holdings.push({
      asset,
      assetKind: isStock ? 'Stock' : 'Crypto',
      isStablecoin: false,
      spotQty,
      fundingQty,
      equityQty,
      lockedQty,
      totalQty,
      livePriceUsd,
      change24hPct,
      marketValueUsd,
      marketValueMyr,
      avgCostFifoUsd,
      avgCostWeightedUsd,
      totalCostFifoUsd: totalQty > 1e-8 ? totalCostFifoUsd : 0,
      totalCostWeightedUsd: totalQty > 1e-8 ? totalCostWeightedUsd : 0,
      unrealizedPnlFifoUsd,
      unrealizedPnlWeightedUsd,
      unrealizedPctFifo,
      unrealizedPctWeighted,
      realizedPnlFifoUsd: realizedFifoUsd,
      realizedPnlWeightedUsd: realizedWeightedUsd,
      totalFeesUsd,
      tradesCount: assetTrades.length,
      closedTradesCount,
      untrackedQty,
      status: totalQty > 1e-8 ? 'active' : 'closed',
    });
  }

  holdings.sort((a, b) => b.marketValueUsd - a.marketValueUsd || Math.abs(b.realizedPnlFifoUsd) - Math.abs(a.realizedPnlFifoUsd));

  const fundingSummary = computeFundingSummary(fundingEvents, usdToMyr, costBasisOverrides);

  let totalValueUsd = 0;
  let spotValueUsd = 0;
  let fundingValueUsd = 0;
  let stablecoinValueUsd = 0;
  let activeCostFifoUsd = 0;
  let activeCostWeightedUsd = 0;
  let unrealizedPnlFifoUsd = 0;
  let unrealizedPnlWeightedUsd = 0;
  let realizedPnlFifoUsd = 0;
  let realizedPnlWeightedUsd = 0;
  let totalFeesUsd = 0;

  for (const h of holdings) {
    totalValueUsd += h.marketValueUsd;
    spotValueUsd += h.spotQty * h.livePriceUsd;
    fundingValueUsd += h.fundingQty * h.livePriceUsd;
    if (h.isStablecoin) {
      stablecoinValueUsd += h.marketValueUsd;
    } else {
      activeCostFifoUsd += h.totalCostFifoUsd;
      activeCostWeightedUsd += h.totalCostWeightedUsd;
      unrealizedPnlFifoUsd += h.unrealizedPnlFifoUsd;
      unrealizedPnlWeightedUsd += h.unrealizedPnlWeightedUsd;
      realizedPnlFifoUsd += h.realizedPnlFifoUsd;
      realizedPnlWeightedUsd += h.realizedPnlWeightedUsd;
      totalFeesUsd += h.totalFeesUsd;
    }
  }

  const totalValueMyr = totalValueUsd * usdToMyr;
  const trueNetReturnUsd = totalValueUsd - fundingSummary.netFundedUsd;
  const trueNetReturnMyr = totalValueMyr - fundingSummary.netFundedMyr;
  const trueNetReturnPct = fundingSummary.netFundedUsd > 0
    ? (trueNetReturnUsd / fundingSummary.netFundedUsd) * 100
    : 0;

  return {
    holdings,
    fundingSummary,
    tradeRealizedMap,
    totals: {
      totalValueUsd,
      totalValueMyr,
      spotValueUsd,
      fundingValueUsd,
      stablecoinValueUsd,
      activeCostFifoUsd,
      activeCostWeightedUsd,
      unrealizedPnlFifoUsd,
      unrealizedPnlWeightedUsd,
      unrealizedPctFifo: activeCostFifoUsd > 0 ? (unrealizedPnlFifoUsd / activeCostFifoUsd) * 100 : 0,
      unrealizedPctWeighted: activeCostWeightedUsd > 0 ? (unrealizedPnlWeightedUsd / activeCostWeightedUsd) * 100 : 0,
      realizedPnlFifoUsd,
      realizedPnlWeightedUsd,
      totalFeesUsd,
      trueNetReturnUsd,
      trueNetReturnMyr,
      trueNetReturnPct,
    },
  };
}

/**
 * Splits a BinanceStoredLedger into <=40,000-character Settings entries
 * so Google Sheets' 50,000-character cell limit is never breached.
 */
export function serializeChunkedBinanceLedger(ledger: BinanceStoredLedger): Array<{ key: string; value: string }> {
  const json = JSON.stringify(ledger);
  const chunks: string[] = [];
  for (let i = 0; i < json.length; i += BINANCE_MAX_CHUNK_CHARS) {
    chunks.push(json.slice(i, i + BINANCE_MAX_CHUNK_CHARS));
  }
  if (chunks.length === 0) chunks.push('{}');

  const meta = JSON.stringify({
    version: 1,
    chunkCount: chunks.length,
    lastSyncAt: ledger.lastSyncAt,
    updatedAt: new Date().toISOString(),
  });

  const entries: Array<{ key: string; value: string }> = [
    { key: BINANCE_LEDGER_META_KEY, value: meta },
  ];
  chunks.forEach((chunk, idx) => {
    entries.push({ key: `${BINANCE_LEDGER_CHUNK_PREFIX}${idx}`, value: chunk });
  });
  return entries;
}

export function parseChunkedBinanceLedger(settings: Record<string, unknown>): BinanceStoredLedger | null {
  const rawMeta = settings[BINANCE_LEDGER_META_KEY];
  if (!rawMeta || typeof rawMeta !== 'string') return null;

  try {
    const meta = JSON.parse(rawMeta) as { version?: number; chunkCount?: number };
    const chunkCount = Number(meta?.chunkCount || 0);
    if (!Number.isFinite(chunkCount) || chunkCount <= 0) return null;

    let combined = '';
    for (let i = 0; i < chunkCount; i++) {
      const part = settings[`${BINANCE_LEDGER_CHUNK_PREFIX}${i}`];
      if (typeof part !== 'string') return null;
      combined += part;
    }

    const parsed = JSON.parse(combined) as Partial<BinanceStoredLedger>;
    if (!parsed || parsed.version !== 1) return null;

    return {
      version: 1,
      lastSyncAt: typeof parsed.lastSyncAt === 'string' ? parsed.lastSyncAt : '',
      lastHistorySyncMs: Number(parsed.lastHistorySyncMs || 0),
      symbolFromIds: parsed.symbolFromIds && typeof parsed.symbolFromIds === 'object' ? parsed.symbolFromIds : {},
      trades: Array.isArray(parsed.trades) ? parsed.trades : [],
      fundingEvents: Array.isArray(parsed.fundingEvents) ? parsed.fundingEvents : [],
      costBasisOverrides: parsed.costBasisOverrides && typeof parsed.costBasisOverrides === 'object' ? parsed.costBasisOverrides : {},
      customSymbols: Array.isArray(parsed.customSymbols) ? parsed.customSymbols : [],
      lastBalances: Array.isArray(parsed.lastBalances) ? parsed.lastBalances : [],
      tokenizedAssetMap: parsed.tokenizedAssetMap && typeof parsed.tokenizedAssetMap === 'object' ? parsed.tokenizedAssetMap : {},
      equityNetAdjustment: parsed.equityNetAdjustment && typeof parsed.equityNetAdjustment === 'object' ? parsed.equityNetAdjustment : {},
      equityHistorySynced: parsed.equityHistorySynced === true,
    };
  } catch {
    return null;
  }
}

export function mergeTradesById(
  existing: BinanceTradeExecution[],
  incoming: BinanceTradeExecution[]
): BinanceTradeExecution[] {
  const map = new Map<string, BinanceTradeExecution>();
  for (const t of existing) map.set(t.id, t);
  for (const t of incoming) map.set(t.id, t);
  return [...map.values()].sort((a, b) => b.timestamp - a.timestamp);
}

export function mergeFundingById(
  existing: BinanceFundingEvent[],
  incoming: BinanceFundingEvent[]
): BinanceFundingEvent[] {
  const map = new Map<string, BinanceFundingEvent>();
  for (const e of existing) map.set(e.id, e);
  for (const e of incoming) map.set(e.id, e);
  return [...map.values()].sort((a, b) => b.timestamp - a.timestamp);
}
