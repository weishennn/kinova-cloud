import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  buildTickerMap,
  computeBinanceAnalytics,
  computeFundingSummary,
  createEmptyBinanceLedger,
  mergeSpotAndFundingBalances,
  normalizeC2cOrder,
  normalizeConvertTrade,
  normalizeEquityTrade,
  normalizeSpotTrade,
  parseChunkedBinanceLedger,
  serializeChunkedBinanceLedger,
  BINANCE_MAX_CHUNK_CHARS,
} from '../src/lib/binance-sync.ts';
import { detectBinanceKeyType, normalizePrivateKeyPem, signBinancePayload } from '../src/lib/binance-client.ts';

test('Ed25519 keys produce valid Base64 signatures and HMAC secrets produce Hex signatures', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  assert.equal(detectBinanceKeyType(pem), 'ed25519');

  const quotedEscapedPem = `"${pem.trim().replace(/\n/g, '\\n')}"`;
  assert.equal(normalizePrivateKeyPem(quotedEscapedPem), pem.trim());

  const payload = 'omitZeroBalances=true&timestamp=1700000000000';
  const sigB64 = signBinancePayload(payload, pem);
  const verified = crypto.verify(null, Buffer.from(payload, 'utf8'), publicKey, Buffer.from(sigB64, 'base64'));
  assert.equal(verified, true);

  assert.equal(detectBinanceKeyType('my_hmac_secret'), 'hmac');
  const hmacSig = signBinancePayload(payload, 'my_hmac_secret');
  assert.match(hmacSig, /^[a-f0-9]{64}$/);
});

test('merges Spot and Funding balances per asset cleanly', () => {
  const merged = mergeSpotAndFundingBalances(
    [
      { asset: 'BTC', free: '0.25', locked: '0.05' },
      { asset: 'USDT', free: '500', locked: '0' },
    ],
    [
      { asset: 'BTC', free: '0.1', locked: '0', freeze: '0', withdrawing: '0' },
      { asset: 'SOL', free: '10', locked: '2', freeze: '0', withdrawing: '0' },
    ]
  );

  const btc = merged.find((b) => b.asset === 'BTC');
  assert.ok(btc);
  assert.ok(Math.abs(btc.spotQty - 0.3) < 1e-9);
  assert.ok(Math.abs(btc.fundingQty - 0.1) < 1e-9);
  assert.ok(Math.abs(btc.totalQty - 0.4) < 1e-9);

  const sol = merged.find((b) => b.asset === 'SOL');
  assert.ok(sol);
  assert.equal(sol.fundingQty, 12);
  assert.equal(sol.spotQty, 0);
});

test('Net Funded In totals P2P + Fiat + Deposits minus Withdrawals and ignores internal Spot<->Funding transfers', () => {
  const c2cBuy = normalizeC2cOrder(
    {
      orderNumber: 'p2p-1',
      createTime: 1700000000000,
      orderStatus: 'COMPLETED',
      tradeType: 'BUY',
      asset: 'USDT',
      amount: '1000',
      fiat: 'MYR',
      totalPrice: '4400',
    },
    4.2
  );
  assert.ok(c2cBuy);

  const summary = computeFundingSummary(
    [
      c2cBuy,
      {
        id: 'dep_1',
        timestamp: 1700001000000,
        date: '2026-01-02',
        kind: 'crypto_deposit',
        direction: 'in',
        asset: 'ETH',
        amount: 1,
        usdValue: 2500,
        status: 'COMPLETED',
      },
      {
        id: 'xfer_1',
        timestamp: 1700002000000,
        date: '2026-01-03',
        kind: 'internal_transfer',
        direction: 'neutral',
        asset: 'USDT',
        amount: 500,
        usdValue: 500,
        status: 'CONFIRMED',
      },
      {
        id: 'wd_1',
        timestamp: 1700003000000,
        date: '2026-01-04',
        kind: 'crypto_withdraw',
        direction: 'out',
        asset: 'USDT',
        amount: 300,
        usdValue: 300,
        status: 'COMPLETED',
      },
    ],
    4.2,
    { dep_1: 2000 } // override deposit cost basis from $2500 to $2000
  );

  assert.equal(summary.totalDepositedUsd, 3000);
  assert.equal(summary.totalWithdrawnUsd, 300);
  assert.equal(summary.netFundedUsd, 2700);
  assert.equal(summary.totalDepositedMyr, 4400 + 2000 * 4.2);
});

test('computes FIFO and Weighted Average Realized & Unrealized PnL across Spot and Convert trades', () => {
  const tickerMap = buildTickerMap([
    { symbol: 'BTCUSDT', lastPrice: '100000', priceChangePercent: '2.5' },
    { symbol: 'BNBUSDT', lastPrice: '600', priceChangePercent: '1.0' },
  ]);

  const buy1 = normalizeSpotTrade(
    {
      id: 1,
      time: 1700000000000,
      qty: '1',
      price: '60000',
      quoteQty: '60000',
      commission: '0',
      commissionAsset: 'USDT',
      isBuyer: true,
    },
    'BTCUSDT',
    { baseAsset: 'BTC', quoteAsset: 'USDT' },
    tickerMap
  );
  const buy2 = normalizeSpotTrade(
    {
      id: 2,
      time: 1700001000000,
      qty: '1',
      price: '80000',
      quoteQty: '80000',
      commission: '0',
      commissionAsset: 'USDT',
      isBuyer: true,
    },
    'BTCUSDT',
    { baseAsset: 'BTC', quoteAsset: 'USDT' },
    tickerMap
  );
  const sell1 = normalizeSpotTrade(
    {
      id: 3,
      time: 1700002000000,
      qty: '1',
      price: '90000',
      quoteQty: '90000',
      commission: '0',
      commissionAsset: 'USDT',
      isBuyer: false,
    },
    'BTCUSDT',
    { baseAsset: 'BTC', quoteAsset: 'USDT' },
    tickerMap
  );

  assert.ok(buy1 && buy2 && sell1);

  const balances = mergeSpotAndFundingBalances(
    [
      { asset: 'BTC', free: '1', locked: '0' },
      { asset: 'USDT', free: '500', locked: '0' },
    ],
    []
  );

  const report = computeBinanceAnalytics({
    balances,
    trades: [buy1, buy2, sell1],
    fundingEvents: [],
    tickerMap,
    usdToMyr: 4.2,
  });

  const btc = report.holdings.find((h) => h.asset === 'BTC');
  assert.ok(btc);
  // FIFO: sold lot 1 ($60k) at $90k -> realized +$30k; remaining lot 2 ($80k) at $100k -> unrealized +$20k
  assert.ok(Math.abs(btc.realizedPnlFifoUsd - 30000) < 1e-6);
  assert.ok(Math.abs(btc.unrealizedPnlFifoUsd - 20000) < 1e-6);
  // Weighted avg: avg cost $70k -> sold 1 at $90k -> realized +$20k; remaining 1 ($70k) at $100k -> unrealized +$30k
  assert.ok(Math.abs(btc.realizedPnlWeightedUsd - 20000) < 1e-6);
  assert.ok(Math.abs(btc.unrealizedPnlWeightedUsd - 30000) < 1e-6);

  const convLegs = normalizeConvertTrade(
    {
      orderId: 'c1',
      createTime: 1700003000000,
      fromAsset: 'USDT',
      toAsset: 'SOL',
      fromAmount: '1000',
      toAmount: '5',
      orderStatus: 'SUCCESS',
    },
    tickerMap
  );
  assert.equal(convLegs.length, 1);
  assert.equal(convLegs[0].side, 'BUY');
  assert.equal(convLegs[0].priceUsd, 200);
});

test('chunked ledger serialization stays within Google Sheets cell limit and round-trips cleanly', () => {
  const ledger = createEmptyBinanceLedger();
  ledger.lastSyncAt = '2026-11-26T16:00:00.000Z';
  ledger.lastHistorySyncMs = 1795700000000;
  for (let i = 0; i < 600; i++) {
    ledger.trades.push({
      id: `spot_BTCUSDT_${i}`,
      timestamp: 1700000000000 + i * 1000,
      date: '2026-01-01',
      source: 'spot',
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      side: i % 2 === 0 ? 'BUY' : 'SELL',
      quantity: 0.01,
      priceUsd: 90000,
      totalUsd: 900,
      feeUsd: 0.9,
      note: 'Spot trade test entry for chunk boundary verification',
    });
  }

  const entries = serializeChunkedBinanceLedger(ledger);
  assert.ok(entries.length > 2);
  for (const entry of entries) {
    assert.ok(entry.value.length <= BINANCE_MAX_CHUNK_CHARS);
  }

  const settingsObj = Object.fromEntries(entries.map((e) => [e.key, e.value]));
  const restored = parseChunkedBinanceLedger(settingsObj);
  assert.ok(restored);
  assert.equal(restored.trades.length, 600);
  assert.equal(restored.lastSyncAt, ledger.lastSyncAt);
});

test('normalizes Binance US equity trades, derives open equity shares, and prices tokenized bStocks', () => {
  const tickerMap = buildTickerMap([
    { symbol: 'USDCUSDT', lastPrice: '1', priceChangePercent: '0' },
  ]);

  const eqBuy = normalizeEquityTrade(
    {
      executionId: 'exec-1',
      orderId: 'ord-1',
      symbol: 'NVDA',
      quote: 'USDC',
      side: 'BUY',
      price: '120',
      qty: '10',
      total: '1200',
      executionAt: 1700000000000,
    },
    tickerMap
  );
  const eqSell = normalizeEquityTrade(
    {
      executionId: 'exec-2',
      orderId: 'ord-2',
      symbol: 'NVDA',
      quote: 'USDC',
      side: 'SELL',
      price: '150',
      qty: '4',
      total: '600',
      executionAt: 1700001000000,
    },
    tickerMap
  );
  assert.ok(eqBuy && eqSell);

  const balances = mergeSpotAndFundingBalances(
    [{ asset: 'AAPLB', free: '2', locked: '0' }],
    []
  );

  const report = computeBinanceAnalytics({
    balances,
    trades: [eqBuy, eqSell],
    fundingEvents: [],
    tickerMap,
    usdToMyr: 4.2,
    equityPrices: {
      NVDA: { priceUsd: 160, change24hPct: 3.2 },
      AAPL: { priceUsd: 220, change24hPct: 1.1 },
    },
    tokenizedAssetMap: { AAPLB: 'AAPL' },
  });

  const nvda = report.holdings.find((h) => h.asset === 'NVDA');
  assert.ok(nvda);
  assert.equal(nvda.assetKind, 'Stock');
  assert.equal(nvda.totalQty, 6);
  assert.equal(nvda.realizedPnlFifoUsd, 120); // 4 * (150 - 120)
  assert.equal(nvda.unrealizedPnlFifoUsd, 240); // 6 * (160 - 120)

  const aaplb = report.holdings.find((h) => h.asset === 'AAPLB');
  assert.ok(aaplb);
  assert.equal(aaplb.assetKind, 'Stock');
  assert.equal(aaplb.livePriceUsd, 220);
  assert.equal(aaplb.marketValueUsd, 440);
});
