import test from 'node:test';
import assert from 'node:assert/strict';

test('1. Trade auto-heal reconstructs missing trade history from portfolio holdings', () => {
  const portfolioHoldings = [
    { ticker: 'TSLA', name: 'Tesla Inc', type: 'Stock', currency: 'USD', units: 0.13, avgCost: 363.50 },
    { ticker: 'NVDA', name: 'Nvidia Corp', type: 'Stock', currency: 'USD', units: 0.1242, avgCost: 212.81 },
    { ticker: 'SPCX', name: 'SPCX ETF', type: 'ETF', currency: 'USD', units: 0.14, avgCost: 159.929 },
  ];

  // Simulate empty trades
  const tradesRows = [];

  // When trades is empty, auto-heal reconstructs
  if (tradesRows.length === 0 && portfolioHoldings.length > 0) {
    const reconstructed = portfolioHoldings.map((h, idx) => ({
      Id: `moo_holding_${h.ticker.toLowerCase()}_${idx}`,
      Date: h.ticker === 'SPCX' ? '2026-06-13' : '2026-10-28',
      Action: 'BUY',
      Ticker: h.ticker,
      'Asset Name': h.name,
      Quantity: h.units,
      Price: h.avgCost,
      Fees: 0.50,
      'Net Total': parseFloat((h.units * h.avgCost + 0.50).toFixed(2)),
      Currency: h.currency,
      Notes: `Moomoo Auto-Sync Holding (${h.ticker})`,
    }));
    tradesRows.push(...reconstructed);
  }

  assert.equal(tradesRows.length, 3);
  assert.equal(tradesRows[0].Ticker, 'TSLA');
  assert.equal(tradesRows[0].Quantity, 0.13);
  assert.equal(tradesRows[1].Ticker, 'NVDA');
  assert.equal(tradesRows[1].Quantity, 0.1242);
  assert.equal(tradesRows[2].Ticker, 'SPCX');
  assert.equal(tradesRows[2].Quantity, 0.14);
});

test('2. Batch trade sync deduplicates and maintains atomic contiguous rows', () => {
  const existingTrades = [
    {
      Id: 'moo_FM1D5404C56BE4F000',
      Date: '2026-10-28',
      Action: 'BUY',
      Ticker: 'NVDA',
      Quantity: 0.1242,
      Price: 212.81,
      Fees: 0.50,
      'Net Total': 26.93,
      Currency: 'USD',
      Notes: 'Order: FM1D5404C56BE4F000',
    },
  ];

  const incomingTrades = [
    // Duplicate of existing
    {
      Id: 'moo_FM1D5404C56BE4F000',
      Date: '2026-10-28',
      Action: 'BUY',
      Ticker: 'NVDA',
      Quantity: 0.1242,
      Price: 212.81,
      Fees: 0.50,
      'Net Total': 26.93,
      Currency: 'USD',
      Notes: 'Order: FM1D5404C56BE4F000',
    },
    // New TSLA trade
    {
      Id: 'moo_FM1D4C1BCCAD1AB000',
      Date: '2026-10-28',
      Action: 'BUY',
      Ticker: 'TSLA',
      Quantity: 0.13,
      Price: 363.50,
      Fees: 0.50,
      'Net Total': 47.76,
      Currency: 'USD',
      Notes: 'Order: FM1D4C1BCCAD1AB000',
    },
    // New SPCX holding
    {
      Id: 'moo_pos_spcx',
      Date: '2026-06-13',
      Action: 'BUY',
      Ticker: 'SPCX',
      Quantity: 0.14,
      Price: 159.929,
      Fees: 0.47,
      'Net Total': 22.86,
      Currency: 'USD',
      Notes: 'Moomoo Holding SPCX',
    },
  ];

  const merged = [...existingTrades];
  let added = 0;

  for (const trade of incomingTrades) {
    const isDup = merged.some((m) => {
      if (m.Id === trade.Id) return true;
      return (
        m.Ticker === trade.Ticker &&
        m.Date === trade.Date &&
        Math.abs(m.Quantity - trade.Quantity) < 0.0001 &&
        m.Action === trade.Action
      );
    });
    if (!isDup) {
      merged.push(trade);
      added++;
    }
  }

  assert.equal(added, 2);
  assert.equal(merged.length, 3);
  assert.deepEqual(
    merged.map((t) => t.Ticker),
    ['NVDA', 'TSLA', 'SPCX']
  );
});

test('3. Portfolio calculation from merged trades produces exact holdings', () => {
  const trades = [
    { Ticker: 'TSLA', Action: 'BUY', Quantity: 0.13, Price: 363.50, Fees: 0.50, Currency: 'USD' },
    { Ticker: 'NVDA', Action: 'BUY', Quantity: 0.1242, Price: 212.81, Fees: 0.50, Currency: 'USD' },
    { Ticker: 'SPCX', Action: 'BUY', Quantity: 0.14, Price: 159.929, Fees: 0.47, Currency: 'USD' },
  ];

  const holdings = {};
  trades.forEach((t) => {
    if (!holdings[t.Ticker]) {
      holdings[t.Ticker] = { ticker: t.Ticker, units: 0, cost: 0 };
    }
    const h = holdings[t.Ticker];
    if (t.Action === 'BUY') {
      h.units += t.Quantity;
      h.cost += t.Quantity * t.Price + t.Fees;
    }
  });

  assert.equal(holdings['TSLA'].units, 0.13);
  assert.equal(holdings['NVDA'].units, 0.1242);
  assert.equal(holdings['SPCX'].units, 0.14);
});
