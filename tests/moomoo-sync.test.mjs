import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateMoomooNetTotal,
  findMoomooOrderTradeIndex,
  getMoomooSyncStartMs,
  getMoomooTradingMarkets,
  makeMoomooTradeId,
  normalizeMoomooOrder,
  parseMoomooDate,
  parseMoomooSyncState,
  selectMoomooAuthorizedAccounts,
  MOOMOO_FULL_SYNC_START_MS,
  MOOMOO_SYNC_OVERLAP_MS,
} from '../src/lib/moomoo-sync.ts';

test('first Moomoo sync starts from the configured full-history boundary', () => {
  assert.equal(getMoomooSyncStartMs(undefined), MOOMOO_FULL_SYNC_START_MS);
});

test('incremental sync overlaps the last cursor to catch delayed fills and fee updates', () => {
  const lastSyncAt = '2026-10-29T04:00:00.000Z';
  assert.equal(
    getMoomooSyncStartMs(lastSyncAt),
    Date.parse(lastSyncAt) - MOOMOO_SYNC_OVERLAP_MS
  );
});

test('sync state parsing safely rejects malformed values and retains per-account cursors', () => {
  assert.equal(parseMoomooSyncState('{broken'), null);
  assert.equal(parseMoomooSyncState({
    version: 1,
    lastSyncAt: '2026-10-29T04:00:00.000Z',
    accountLastSyncAt: { '12345': '2026-10-29T04:00:00.000Z' },
  }), null, 'previous sync state must trigger one complete backfill after the request fix');
  assert.deepEqual(
    parseMoomooSyncState({
      version: 2,
      lastSyncAt: '2026-10-29T04:00:00.000Z',
      accountLastSyncAt: { '12345': '2026-10-29T04:00:00.000Z', bad: 'invalid' },
    }),
    {
      version: 2,
      lastSyncAt: '2026-10-29T04:00:00.000Z',
      accountLastSyncAt: { '12345': '2026-10-29T04:00:00.000Z' },
    }
  );
});

test('trade IDs are stable per account and order, and legacy order rows can be matched', () => {
  assert.equal(makeMoomooTradeId('12345', 'order-7'), 'moo_12345_order-7');
  assert.equal(
    findMoomooOrderTradeIndex(
      [{ Id: 'moo_order-7', Notes: 'Moomoo Auto-Sync; Order: order-7' }],
      '12345',
      'order-7'
    ),
    0
  );
});

test('same order IDs in different accounts never match each other', () => {
  const rows = [{
    Id: 'moo_54321_order-9',
    Notes: 'Moomoo Auto-Sync (Account: 54321; Order: order-9)',
  }];
  assert.equal(findMoomooOrderTradeIndex(rows, '12345', 'order-9'), -1);
  assert.equal(findMoomooOrderTradeIndex(rows, '54321', 'order-9'), 0);
});

test('configured account selection matches only the full authorized account_id', () => {
  const accounts = [
    { account_id: '281756476993717634', univs_account_card_number: '9071', user_id: '12345678' },
    { account_id: '281756479194114175', univs_account_card_number: '9072', user_id: '12345678' },
  ];
  assert.deepEqual(selectMoomooAuthorizedAccounts(accounts, '281756476993717634'), [accounts[0]]);
  assert.throws(
    () => selectMoomooAuthorizedAccounts(accounts, '9071'),
    /full account_id/,
    'card suffixes must not silently select every authorized account'
  );
  assert.deepEqual(selectMoomooAuthorizedAccounts(accounts), accounts);
});

test('enabled Moomoo markets are translated to the required trd_market query values', () => {
  assert.deepEqual(
    getMoomooTradingMarkets({ enable_market: [2, 11, 1, 11, 7, 14] }),
    ['US', 'MY', 'HK']
  );
});

test('order normalization uses executed quantity, average fill price, itemized fees, and signed sell proceeds', () => {
  const trade = normalizeMoomooOrder(
    {
      order_id: 'order-8',
      code: 'US.AAPL',
      stock_name: 'Apple Inc.',
      side: 'SELL',
      dealt_qty: '2.5',
      dealt_avg_price: '100',
      dealt_time: '2026-10-28T16:20:00Z',
      currency: 'USD',
    },
    '12345',
    {
      totalFee: 1.25,
      currency: 'USD',
      items: [
        { type: 'Commission', amount: 0.75 },
        { type: 'Platform fee', amount: 0.5 },
      ],
    }
  );

  assert.ok(trade);
  assert.equal(trade.Id, 'moo_12345_order-8');
  assert.equal(trade.Action, 'SELL');
  assert.equal(trade.Quantity, 2.5);
  assert.equal(trade.Price, 100);
  assert.equal(trade.Fees, 1.25);
  assert.equal(trade['Net Total'], 248.75);
  assert.match(String(trade.Notes), /Fee sync: confirmed/);
  assert.match(String(trade.Notes), /Fee breakdown: Commission 0\.75, Platform fee 0\.50/);
});

test('net total adds fees to buys and subtracts fees from sells', () => {
  assert.equal(calculateMoomooNetTotal('BUY', 2, 100, 1.25), 201.25);
  assert.equal(calculateMoomooNetTotal('SELL', 2, 100, 1.25), 198.75);
});

test('Moomoo epoch timestamps are converted to the portfolio timezone date', () => {
  const epoch = Date.UTC(2026, 9, 28, 18, 0, 0);
  assert.equal(parseMoomooDate(epoch), '2026-10-29');
  assert.equal(parseMoomooDate('2026-10-28T23:30:00-05:00'), '2026-10-28');
});
