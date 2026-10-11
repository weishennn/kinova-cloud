import { NextResponse } from 'next/server';

interface StockSearchResult {
  symbol: string;
  name: string;
  exchange: string;
  type: string;
}

const FALLBACK_POPULAR_STOCKS: StockSearchResult[] = [
  { symbol: 'SPCX', name: 'Space Exploration Technologies Corp.', exchange: 'NASDAQ', type: 'Equity' },
  { symbol: 'SPY', name: 'SPDR S&P 500 ETF Trust', exchange: 'NYSEArca', type: 'ETF' },
  { symbol: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ', type: 'Equity' },
  { symbol: 'MSFT', name: 'Microsoft Corporation', exchange: 'NASDAQ', type: 'Equity' },
  { symbol: 'NVDA', name: 'NVIDIA Corporation', exchange: 'NASDAQ', type: 'Equity' },
  { symbol: 'TSLA', name: 'Tesla, Inc.', exchange: 'NASDAQ', type: 'Equity' },
  { symbol: 'AMZN', name: 'Amazon.com, Inc.', exchange: 'NASDAQ', type: 'Equity' },
  { symbol: 'GOOGL', name: 'Alphabet Inc.', exchange: 'NASDAQ', type: 'Equity' },
  { symbol: 'QQQ', name: 'Invesco QQQ Trust', exchange: 'NASDAQ', type: 'ETF' },
  { symbol: '1155.KL', name: 'Malayan Banking Berhad (Maybank)', exchange: 'KLSE', type: 'Equity' },
  { symbol: '5183.KL', name: 'Petronas Chemicals Group', exchange: 'KLSE', type: 'Equity' },
  { symbol: '1023.KL', name: 'Bursa Malaysia Berhad', exchange: 'KLSE', type: 'Equity' },
  { symbol: 'BTC-USD', name: 'Bitcoin USD', exchange: 'CCC', type: 'Cryptocurrency' },
  { symbol: 'ETH-USD', name: 'Ethereum USD', exchange: 'CCC', type: 'Cryptocurrency' },
];

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = (searchParams.get('q') || '').trim();

  if (!query) {
    return NextResponse.json({ success: true, results: FALLBACK_POPULAR_STOCKS.slice(0, 8) });
  }

  try {
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=10&newsCount=0&enableFuzzyQuery=false`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'application/json',
      },
      next: { revalidate: 60 },
    });

    if (response.ok) {
      const data = await response.json();
      const quotes = Array.isArray(data.quotes) ? data.quotes : [];
      const results: StockSearchResult[] = quotes
        .filter((q: any) => q && q.symbol)
        .map((q: any) => ({
          symbol: String(q.symbol).toUpperCase(),
          name: String(q.shortname || q.longname || q.symbol),
          exchange: String(q.exchDisp || q.exchange || ''),
          type: String(q.typeDisp || q.quoteType || 'Stock'),
        }));

      if (results.length > 0) {
        return NextResponse.json({ success: true, results });
      }
    }
  } catch (err) {
    console.warn('Failed to query Yahoo Finance search, using fallback:', err);
  }

  // Fallback filtering if upstream is down or returned no results
  const qUpper = query.toUpperCase();
  const filtered = FALLBACK_POPULAR_STOCKS.filter(
    s => s.symbol.includes(qUpper) || s.name.toUpperCase().includes(qUpper)
  );

  return NextResponse.json({
    success: true,
    results: filtered.length > 0 ? filtered : [
      { symbol: qUpper, name: `${qUpper} (Custom Stock)`, exchange: 'Global', type: 'Stock' }
    ],
  });
}
