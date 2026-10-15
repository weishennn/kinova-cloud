import { NextRequest, NextResponse } from 'next/server';
import { getValidGoogleSession } from '@/lib/google-auth';
import { recordUserAiCall } from '@/lib/admin-registry';
import { getLoadBalancedGeminiKeys, reportGeminiKeyFailure } from '@/lib/gemini-key-pool';

interface GroundedWebSource {
  title: string;
  uri: string;
}

interface StockQuoteSummary {
  ticker: string;
  name: string;
  price: number;
  currency: string;
  changePercent: number;
}

function safeText(value: unknown, maxLength: number): string {
  return typeof value === 'string'
    ? value.trim().replace(/[\u0000-\u001f]/g, ' ').slice(0, maxLength)
    : '';
}

// Extract potential stock ticker symbol from query
function extractTickerSymbol(query: string): string | null {
  const clean = query.toUpperCase();
  const knownSymbols = [
    'NVDA', 'TSLA', 'AAPL', 'MSFT', 'GOOGL', 'GOOG', 'AMZN', 'META',
    'AMD', 'PLTR', 'SMCI', 'AVGO', 'ARM', 'INTC', 'BABA', 'PDD',
    'SPY', 'QQQ', 'VOO', 'VTI', 'VT', 'SCHD', 'JEPI',
    '1155.KL', '1023.KL', '5183.KL', '5347.KL', '1295.KL',
  ];

  for (const sym of knownSymbols) {
    const rx = new RegExp(`(^|[^A-Z0-9.])${sym.replace('.', '\\.')}([^A-Z0-9.]|$)`, 'i');
    if (rx.test(clean)) return sym;
  }

  // Ticker pattern e.g. "$NVDA" or standalone 2-5 letter uppercase word
  const dollarMatch = clean.match(/\$([A-Z]{1,5})\b/);
  if (dollarMatch) return dollarMatch[1];

  return null;
}

async function fetchLiveStockQuote(ticker: string): Promise<StockQuoteSummary | null> {
  const cleanTicker = ticker.trim().toUpperCase();
  if (!cleanTicker) return null;

  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(cleanTicker)}?interval=1d&range=1d`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(6000),
      });

      if (res.ok) {
        const data = await res.json();
        const meta = data?.chart?.result?.[0]?.meta;
        if (meta) {
          const price = Number(meta.regularMarketPrice || meta.fulldayPrice || meta.chartPreviousClose || 0);
          if (price > 0) {
            return {
              ticker: cleanTicker,
              name: String(meta.longName || meta.shortName || cleanTicker),
              price,
              currency: String(meta.currency || 'USD').toUpperCase(),
              changePercent: Number(meta.regularMarketChangePercent ?? 0),
            };
          }
        }
      }
    } catch {
      // Continue to next fallback host
    }
  }
  return null;
}

export async function POST(req: NextRequest) {
  try {
    const { session } = await getValidGoogleSession(req);
    if (session) {
      const aiStatus = await recordUserAiCall(session.email);
      if (!aiStatus.allowed) {
        return NextResponse.json(
          { success: false, error: 'Your account access has been restricted by the administrator.' },
          { status: 403 }
        );
      }
    }

    const body = await req.json();
    const query = safeText(body?.query, 300);
    if (!query || query.length < 2) {
      return NextResponse.json({ success: false, error: 'Query is required.' }, { status: 400 });
    }

    const apiKeys = getLoadBalancedGeminiKeys();
    if (apiKeys.length === 0) {
      return NextResponse.json(
        { success: false, error: 'AI investment insights need a configured GEMINI_API_KEY.' },
        { status: 503 }
      );
    }

    // Check if query is targeting a specific stock ticker
    const detectedTicker = safeText(body?.ticker, 12) || extractTickerSymbol(query);
    let liveQuote: StockQuoteSummary | null = null;
    if (detectedTicker) {
      liveQuote = await fetchLiveStockQuote(detectedTicker);
    }

    let quoteContext = '';
    if (liveQuote) {
      const sign = liveQuote.changePercent >= 0 ? '+' : '';
      quoteContext = `\n[Real-time Market Quote: ${liveQuote.name} (${liveQuote.ticker}) is currently trading at ${liveQuote.currency} ${liveQuote.price.toFixed(2)} (${sign}${liveQuote.changePercent.toFixed(2)}% today)]\n`;
    }

    const prompt = `You are Kinova AI's senior investment and market intelligence advisor.
The user is asking: "${query}"
${quoteContext}
Provide an objective, structured, and insightful analysis grounded in current market reality using Google Search.
Match the user's language (respond in Simplified Chinese if the user asked in Chinese; respond in English if asked in English).

Structure your answer with clarity:
1. 🎯 核心结论与市场主线 (Core Summary & Current Market Trend)
2. 💡 标的分析与投资逻辑 (High-Conviction Pillars):
   - 🛡️ 稳健底仓与核心资产 (e.g. S&P 500 ETF VOO, 纳指 QQQ, 高股息优质蓝筹)
   - 🚀 成长赛道与热点标的 (e.g. AI 算力与基础设施龙头，分析估值水平与主要催化剂)
   - ⚠️ 需警惕或逢高减仓/避免追高的板块 (Trim/Avoid: e.g. 高估值泡沫、高负债、无壁垒个股)
3. ⚖️ 仓位管理与实操建议 (Execution & DCA Strategy: 定投分批建仓、不追高、止损防守策略)
4. ⚠️ 严正免责声明:
   "免责声明：以上内容基于公开市场资讯及 AI 整理分析，仅供参考，不构成任何投资建议或买卖邀约。金融市场有风险，投资需独立决策并做好风控。"

Keep your response well-structured, readable, and under 500 words. CRITICAL: Always finish all sentences and conclusions completely without trailing off or cutting off. Use clear bullet points and markdown bold headers.`;

    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    let response: Response | null = null;

    for (const apiKey of apiKeys) {
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            tools: [{ google_search: {} }],
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens: 3500,
            },
          }),
          signal: AbortSignal.timeout(18_000),
        }
      ).catch(() => null);

      if (response?.ok) break;
      if (response && (response.status === 429 || response.status === 401 || response.status === 403)) {
        reportGeminiKeyFailure(apiKey, response.status);
        if (apiKeys.indexOf(apiKey) + 1 < apiKeys.length) continue;
      }
      break;
    }

    if (!response) {
      return NextResponse.json(
        { success: false, error: 'Market insights search timed out. Try again in a moment.' },
        { status: 504 }
      );
    }

    if (!response.ok) {
      const message =
        response.status === 429
          ? 'Gemini search quota is temporarily cooling down. Try again shortly.'
          : 'AI market lookup is temporarily unavailable.';
      return NextResponse.json({ success: false, error: message }, { status: 502 });
    }

    const data = await response.json();
    const candidate = data?.candidates?.[0];
    const summary = Array.isArray(candidate?.content?.parts)
      ? candidate.content.parts
          .map((part: { text?: unknown }) => safeText(part?.text, 9000))
          .filter(Boolean)
          .join('\n')
          .slice(0, 10000)
      : '';

    if (!summary) {
      return NextResponse.json(
        { success: false, error: 'AI could not synthesize market analysis at this moment.' },
        { status: 502 }
      );
    }

    // Parse Grounding sources if available
    const groundingChunks = candidate?.groundingMetadata?.groundingChunks;
    const sources: GroundedWebSource[] = Array.isArray(groundingChunks)
      ? groundingChunks
          .flatMap((chunk: Record<string, unknown>) => {
            const web = chunk?.web as Record<string, unknown> | undefined;
            const uri = safeText(web?.uri, 500);
            const title = safeText(web?.title, 160);
            if (!uri || !/^https:\/\//i.test(uri)) return [];
            return [{ title: title || new URL(uri).hostname, uri }];
          })
          .filter(
            (source, index, all) => all.findIndex((cand) => cand.uri === source.uri) === index
          )
          .slice(0, 5)
      : [];

    return NextResponse.json({
      success: true,
      summary,
      sources,
      quote: liveQuote,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to retrieve stock insights',
      },
      { status: 500 }
    );
  }
}
