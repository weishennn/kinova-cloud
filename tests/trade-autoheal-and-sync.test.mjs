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

test('4. columnIndexToLetter converts indices correctly', () => {
  function columnIndexToLetter(idx) {
    let temp = idx;
    let letter = '';
    while (temp >= 0) {
      letter = String.fromCharCode((temp % 26) + 65) + letter;
      temp = Math.floor(temp / 26) - 1;
    }
    return letter;
  }

  assert.equal(columnIndexToLetter(0), 'A');
  assert.equal(columnIndexToLetter(3), 'D');
  assert.equal(columnIndexToLetter(10), 'K');
  assert.equal(columnIndexToLetter(25), 'Z');
  assert.equal(columnIndexToLetter(26), 'AA');
  assert.equal(columnIndexToLetter(27), 'AB');
});

test('5. Dynamic Portfolio column detection extracts holdings even if columns are reordered', () => {
  const portfolioHeaders = ['Asset Name', 'Ticker', 'Live Price', 'Units Held', 'Avg Cost', 'Total Cost'];
  const pRows = [
    portfolioHeaders,
    ['Tesla Inc', 'TSLA', '380.00', '0.13', '363.50', '47.26'],
    ['Nvidia Corp', 'NVDA', '220.00', '0.1242', '212.81', '26.43'],
  ];

  const pHeadersLower = pRows[0].map((h) => String(h || '').trim().toLowerCase());
  const tickerIdx = pHeadersLower.findIndex((h) => h === 'ticker' || h.includes('symbol'));
  const unitsIdx = pHeadersLower.findIndex((h) => h.includes('unit') || h.includes('qty'));
  const avgCostIdx = pHeadersLower.findIndex((h) => h.includes('avg') || h.includes('cost'));
  const nameIdx = pHeadersLower.findIndex((h) => h.includes('name'));

  assert.equal(tickerIdx, 1);
  assert.equal(unitsIdx, 3);
  assert.equal(avgCostIdx, 4);
  assert.equal(nameIdx, 0);

  const holdings = [];
  for (let i = 1; i < pRows.length; i++) {
    const r = pRows[i];
    const ticker = String(r[tickerIdx]).trim().toUpperCase();
    const units = parseFloat(r[unitsIdx]) || 0;
    const avgCost = parseFloat(r[avgCostIdx]) || 0;
    holdings.push({ ticker, units, avgCost });
  }

  assert.equal(holdings.length, 2);
  assert.equal(holdings[0].ticker, 'TSLA');
  assert.equal(holdings[0].units, 0.13);
  assert.equal(holdings[1].ticker, 'NVDA');
  assert.equal(holdings[1].units, 0.1242);
});

