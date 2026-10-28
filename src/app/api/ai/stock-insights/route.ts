import { NextRequest, NextResponse } from 'next/server';
import { getValidGoogleSession } from '@/lib/google-auth';
import { recordUserAiCall } from '@/lib/admin-registry';
import { getLoadBalancedGeminiKeys, reportGeminiKeyFailure, generateGeminiContent, STANDARD_GEMINI_MODEL, STANDARD_GEMINI_MODELS } from '@/lib/gemini-key-pool';

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
        signal: AbortSignal.timeout(4000),
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

    const prompt = `你是用户的极简智能理财助手。用户的提问是：“${query}”
${quoteContext}

【必须严格遵守的核心回答要求】：
1. 彻底说人话！严禁使用复杂晦涩的金融黑话（杜绝宏观流动性周期、DCF折现、估值乘数分位数等任何让普通人头晕的术语）。
2. 字数极度精炼！整体严格控制在 100~150 字以内。排版清爽，重点突出，小白一眼就能看懂，严禁大段冗长废话！
3. 严格按以下 3 个极简板块回答：

🎯 核心态度：(用一句话直接表明态度，如：适合长期分批定投，但切忌现在一把梭追高；或 新手优先看大盘指数ETF，少碰高风险妖股)
💡 为什么（大白话）：
• 亮点/推荐：(用一句通俗大白话讲为什么赚钱/强/看好)
• 风险/避坑：(用一句通俗大白话讲什么时候会亏/什么千万别碰)
🛠️ 小白实操：(用一句话给出具体实操建议，如：只用闲钱分批买、绝不借钱炒股、逢大跌少买点)

⚠️ 提示：以上为公开信息参考，投资有风险，决策需独立。`;

    const preferredModel = process.env.GEMINI_MODEL || STANDARD_GEMINI_MODEL;
    const models = [preferredModel, ...STANDARD_GEMINI_MODELS].filter((v, i, a) => a.indexOf(v) === i);

    let summary = '';
    let sources: GroundedWebSource[] = [];

    // Phase 1: Try with Google Search tool (5.5s timeout)
    searchLoop: for (const apiKey of apiKeys) {
      for (const model of models) {
        try {
          const searchRes = await fetch(
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
                  temperature: 0.1,
                  maxOutputTokens: 1000,
                  thinkingConfig: {
                    thinkingBudget: 0,
                  },
                },
              }),
              signal: AbortSignal.timeout(5500),
            }
          ).catch(() => null);

          if (searchRes && searchRes.ok) {
            const data = await searchRes.json();
            const candidate = data?.candidates?.[0];
            const text = Array.isArray(candidate?.content?.parts)
              ? candidate.content.parts
                  .map((part: { text?: unknown }) => safeText(part?.text, 9000))
                  .filter(Boolean)
                  .join('\n')
                  .slice(0, 10000)
              : '';
            if (text) {
              summary = text;
              const groundingChunks = candidate?.groundingMetadata?.groundingChunks;
              if (Array.isArray(groundingChunks)) {
                sources = groundingChunks
                  .flatMap((chunk: Record<string, unknown>) => {
                    const web = chunk?.web as Record<string, unknown> | undefined;
                    const uri = safeText(web?.uri, 500);
                    const title = safeText(web?.title, 160);
                    if (!uri || !/^https:\/\//i.test(uri)) return [];
                    return [{ title: title || new URL(uri).hostname, uri }];
                  })
                  .filter((source, index, all) => all.findIndex((cand) => cand.uri === source.uri) === index)
                  .slice(0, 5);
              }
              break searchLoop;
            }
          } else if (searchRes && (searchRes.status === 429 || searchRes.status === 401 || searchRes.status === 403 || searchRes.status >= 500)) {
            reportGeminiKeyFailure(apiKey, searchRes.status);
          }
        } catch {
          // Continue
        }
      }
    }

    // Phase 2: If Search failed or timed out, fall back immediately to direct generation!
    if (!summary) {
      try {
        const directResult = await generateGeminiContent({
          prompt,
          thinking: false,
          thinkingBudget: 0,
          temperature: 0.1,
          maxOutputTokens: 1000,
          timeoutMs: 10_000,
        });
        summary = directResult.rawText.slice(0, 10000);
      } catch (directErr) {
        console.warn('[StockInsights] Direct generation fallback error:', directErr);
      }
    }

    if (!summary) {
      return NextResponse.json(
        { success: false, error: 'AI 市场分析连接超时（已尝试多通道备选），请稍后重试。' },
        { status: 504 }
      );
    }

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
