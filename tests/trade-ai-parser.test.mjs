import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sanitizeTradeDate,
  sanitizeTradeCurrency,
  sanitizeTradeAction,
  inferTradeAssetType,
  reconcileTradeFees,
  buildTradeAiPrompt,
} from '../src/lib/trade-ai-parser.ts';

test('1. sanitizeTradeDate correctly normalizes dates and provides safe fallbacks', () => {
  assert.equal(sanitizeTradeDate('2026-10-28'), '2026-10-28');
  assert.equal(sanitizeTradeDate('28/10/2026'), '2026-10-28');
  assert.equal(sanitizeTradeDate('', '2026-10-28'), '2026-10-28');
  assert.equal(sanitizeTradeDate(null, '2026-10-28'), '2026-10-28');
});

test('2. sanitizeTradeCurrency normalizes broker currency symbols to ISO codes', () => {
  assert.equal(sanitizeTradeCurrency('USD'), 'USD');
  assert.equal(sanitizeTradeCurrency('$'), 'USD');
  assert.equal(sanitizeTradeCurrency('US$'), 'USD');
  assert.equal(sanitizeTradeCurrency('RM'), 'MYR');
  assert.equal(sanitizeTradeCurrency('MYR'), 'MYR');
  assert.equal(sanitizeTradeCurrency('S$'), 'SGD');
  assert.equal(sanitizeTradeCurrency('HK$'), 'HKD');
  assert.equal(sanitizeTradeCurrency('UNKNOWN', 'USD'), 'USD');
});

test('3. sanitizeTradeAction normalizes actions in English and Chinese', () => {
  assert.equal(sanitizeTradeAction('BUY'), 'BUY');
  assert.equal(sanitizeTradeAction('买入'), 'BUY');
  assert.equal(sanitizeTradeAction('SELL'), 'SELL');
  assert.equal(sanitizeTradeAction('卖出'), 'SELL');
  assert.equal(sanitizeTradeAction('DIVIDEND'), 'DIVIDEND');
  assert.equal(sanitizeTradeAction('分红'), 'DIVIDEND');
  assert.equal(sanitizeTradeAction('股息'), 'DIVIDEND');
  assert.equal(sanitizeTradeAction('REINVEST'), 'REINVEST');
  assert.equal(sanitizeTradeAction('再投资'), 'REINVEST');
});

test('4. inferTradeAssetType identifies stock vs ETF vs crypto vs Bursa Malaysia', () => {
  assert.equal(inferTradeAssetType('NVDA'), 'US Stock');
  assert.equal(inferTradeAssetType('AAPL'), 'US Stock');
  assert.equal(inferTradeAssetType('VOO'), 'ETF');
  assert.equal(inferTradeAssetType('QQQ'), 'ETF');
  assert.equal(inferTradeAssetType('SPY'), 'ETF');
  assert.equal(inferTradeAssetType('1155.KL'), 'MY Stock');
  assert.equal(inferTradeAssetType('5183.MY'), 'MY Stock');
  assert.equal(inferTradeAssetType('1155'), 'MY Stock');
  assert.equal(inferTradeAssetType('BTC-USD'), 'Crypto');
  assert.equal(inferTradeAssetType('ETH'), 'Crypto');
});

test('5. reconcileTradeFees sums itemized Moomoo fees and calculates net totals', () => {
  // Scenario A: Moomoo US Stock Buy
  // 10 shares @ $135.20 = $1352.00
  // Commission: $0.99, Platform: $1.00, SEC: $0.04, Clearing: $0.02 = Total $2.05
  // Net Total = $1354.05
  const reconciled = reconcileTradeFees({
    quantity: 10,
    price: 135.20,
    action: 'BUY',
    feeBreakdown: {
      commission: 0.99,
      platformFee: 1.00,
      secFee: 0.04,
      clearingFee: 0.02,
    },
    orderId: 'MOM123456',
  });

  assert.equal(reconciled.fees, 2.05);
  assert.equal(reconciled.netTotal, 1354.05);
  assert.ok(reconciled.formattedNotes.includes('Order #MOM123456'));
  assert.ok(reconciled.formattedNotes.includes('Comm: 0.99'));
  assert.ok(reconciled.formattedNotes.includes('Platform: 1.00'));
});

test('6. reconcileTradeFees handles sell executions and net deduction', () => {
  // Scenario B: Sell 5 shares @ $200.00 = $1000.00
  // Fees = $3.00
  // Net Proceeds = $997.00
  const reconciled = reconcileTradeFees({
    quantity: 5,
    price: 200.00,
    action: 'SELL',
    fees: 3.00,
  });

  assert.equal(reconciled.fees, 3.00);
  assert.equal(reconciled.netTotal, 997.00);
});

test('7. buildTradeAiPrompt includes Moomoo fee specifics and date injection', () => {
  const prompt = buildTradeAiPrompt('2026-10-28');
  assert.ok(prompt.includes('2026-10-28'));
  assert.ok(prompt.includes('Moomoo'));
  assert.ok(prompt.includes('Platform Fee'));
  assert.ok(prompt.includes('Commission'));
  assert.ok(prompt.includes('SEC Fee'));
});
