import { NextResponse } from 'next/server';

interface StockQuote {
  ticker: string;
  price: number;
  currency: string;
  changePercent?: number;
  name?: string;
  timestamp?: number;
}

async function fetchSingleQuote(symbol: string): Promise<StockQuote | null> {
  const cleanTicker = symbol.trim().toUpperCase();
  if (!cleanTicker) return null;

  // 1. Try Yahoo Finance with resilient multi-host fallback (query1 & query2)
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(cleanTicker)}?interval=1d&range=1d`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(8000),
        next: { revalidate: 30 }, // Cache 30 seconds
      });

      if (res.ok) {
        const data = await res.json();
        const meta = data?.chart?.result?.[0]?.meta;
        if (meta) {
          const price = Number(meta.regularMarketPrice || meta.fulldayPrice || meta.chartPreviousClose || 0);
          if (price > 0) {
            const currency = String(meta.currency || 'USD').toUpperCase();
            const changePercent = Number(meta.regularMarketChangePercent ?? 0);
            const name = String(meta.longName || meta.shortName || cleanTicker);

            return {
              ticker: cleanTicker,
              price,
              currency,
              changePercent,
              name,
              timestamp: meta.regularMarketTime ? meta.regularMarketTime * 1000 : Date.now(),
            };
          }
        }
      }
    } catch (err) {
      console.warn(`Yahoo (${host}) quote fetch error for ${cleanTicker}:`, err);
    }
  }

  // 2. High-reliability fallback: Google Apps Script Portfolio tab (powered by Google's native GOOGLEFINANCE)
  try {
    const appsScriptUrl = process.env.NEXT_PUBLIC_APPS_SCRIPT_URL;
    if (appsScriptUrl) {
      const res = await fetch(`${appsScriptUrl}?action=getPortfolio`, {
        next: { revalidate: 60 }
      });
      if (res.ok) {
        const data = await res.json();
        const rows = Array.isArray(data?.data) ? data.data : [];
        const match = rows.find((r: any) => String(r.ticker || r.Ticker || '').toUpperCase() === cleanTicker);
        if (match && typeof match.livePrice === 'number' && match.livePrice > 0) {
          return {
            ticker: cleanTicker,
            price: match.livePrice,
            currency: String(match.currency || 'USD').toUpperCase(),
            changePercent: Number(match.returnPercent ? match.returnPercent * 100 : 0),
            name: String(match.name || cleanTicker),
            timestamp: Date.now(),
          };
        }
      }
    }
  } catch (err) {
    console.warn(`Apps Script fallback quote fetch error for ${cleanTicker}:`, err);
  }

  return null;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = searchParams.get('ticker');
  const tickers = searchParams.get('tickers');

  if (tickers) {
    const tickerList = tickers.split(',').map(t => t.trim()).filter(Boolean).slice(0, 30);
    const results = await Promise.all(tickerList.map(fetchSingleQuote));
    const quotesMap: Record<string, StockQuote> = {};
    results.forEach(q => {
      if (q) quotesMap[q.ticker] = q;
    });
    return NextResponse.json({ success: true, quotes: quotesMap });
  }

  if (!ticker) {
    return NextResponse.json({ success: false, error: 'Missing ticker parameter' }, { status: 400 });
  }

  const quote = await fetchSingleQuote(ticker);
  if (!quote) {
    return NextResponse.json({ success: false, error: `Could not retrieve quote for ${ticker}` }, { status: 404 });
  }

  return NextResponse.json({ success: true, ...quote });
}
