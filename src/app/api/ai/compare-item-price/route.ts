import { NextRequest, NextResponse } from 'next/server';
import { getValidGoogleSession } from '@/lib/google-auth';
import { recordUserAiCall } from '@/lib/admin-registry';
import { getLoadBalancedGeminiKeys, reportGeminiKeyFailure, STANDARD_GEMINI_MODEL, STANDARD_GEMINI_MODELS } from '@/lib/gemini-key-pool';
import { extractCleanItemKeyword } from '@/lib/receipt-items';

interface GroundedWebSource {
  title: string;
  uri: string;
}

function safeText(value: unknown, maxLength: number): string {
  return typeof value === 'string'
    ? value.trim().replace(/[\u0000-\u001f]/g, ' ').slice(0, maxLength)
    : '';
}

export async function POST(req: NextRequest) {
  try {
    const { session } = await getValidGoogleSession(req);
    if (!session) {
      return NextResponse.json(
        { success: false, error: 'Please sign in with your Google Account to compare online prices.' },
        { status: 401 }
      );
    }

    const aiStatus = await recordUserAiCall(session.email);
    if (!aiStatus.allowed) {
      return NextResponse.json(
        { success: false, error: 'Your account access has been restricted by the administrator.' },
        { status: 403 }
      );
    }

    const body = await req.json();
    const rawItemName = safeText(body?.itemName, 160);
    const brand = safeText(body?.brand, 80);
    const productType = safeText(body?.productType, 80);

    const cleanItemName = extractCleanItemKeyword(rawItemName);
    if (cleanItemName.length < 2) {
      return NextResponse.json(
        { success: false, error: 'Choose a product or dish to check price.' },
        { status: 400 }
      );
    }

    const apiKeys = getLoadBalancedGeminiKeys();
    if (apiKeys.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Online comparison needs a server-side GEMINI_API_KEY.' },
        { status: 503 }
      );
    }

    const productDescription = [brand, cleanItemName, productType]
      .filter(Boolean)
      .filter(
        (value, index, values) =>
          values.findIndex((other) => other.toLowerCase() === value.toLowerCase()) === index
      )
      .join(' · ');

    const prompt = `给出该商品/餐食在马来西亚的当前典型公开发售价格与参考区间（以 MYR 计）：
${JSON.stringify(productDescription)}

【回答要求】：
1. 语言：中文提问用简体中文，英文用英文。
2. 极度精炼！整体 60~100 字以内，杜绝冗长废话，排版清爽如下：
• 🛒 典型参考价：
  - 普通小贩/茶餐室/平价超市：RM X - RM Y
  - 商场美食广场/中高档餐馆：RM A - RM B
• 💡 差价原因：(一句话简述，如加鸡腿/加料/大包装/品牌差异)`;

    const preferredModel = process.env.GEMINI_PRICE_SEARCH_MODEL || process.env.GEMINI_MODEL || STANDARD_GEMINI_MODEL;
    const models = [preferredModel, ...STANDARD_GEMINI_MODELS].filter((v, i, a) => a.indexOf(v) === i);

    let summary = '';
    let sources: GroundedWebSource[] = [];

    // Phase 1: Try with Google Search tool (Fast 5.5s timeout)
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
                  maxOutputTokens: 800,
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
                  .map((part: { text?: unknown }) => safeText(part?.text, 2000))
                  .filter(Boolean)
                  .join('\n')
                  .slice(0, 2500)
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
                  .filter(
                    (source, index, all) =>
                      all.findIndex((candidateSource) => candidateSource.uri === source.uri) === index
                  )
                  .slice(0, 5);
              }
              break searchLoop;
            }
          } else if (searchRes && (searchRes.status === 429 || searchRes.status === 401 || searchRes.status === 403 || searchRes.status >= 500)) {
            reportGeminiKeyFailure(apiKey, searchRes.status);
          }
        } catch {
          // Continue to next model/key
        }
      }
    }

    // Phase 2: If Search failed, hit rate limit, or timed out, fall back immediately to direct generation!
    // Direct generation takes only 2-3s and delivers full Malaysian price intelligence reliably.
    if (!summary) {
      directLoop: for (const apiKey of apiKeys) {
        for (const model of models) {
          try {
            const directRes = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'x-goog-api-key': apiKey,
                },
                body: JSON.stringify({
                  contents: [{ role: 'user', parts: [{ text: prompt }] }],
                  generationConfig: {
                    temperature: 0.1,
                    maxOutputTokens: 800,
                    thinkingConfig: {
                      thinkingBudget: 0,
                    },
                  },
                }),
                signal: AbortSignal.timeout(7000),
              }
            ).catch(() => null);

            if (directRes && directRes.ok) {
              const data = await directRes.json();
              const candidate = data?.candidates?.[0];
              const text = Array.isArray(candidate?.content?.parts)
                ? candidate.content.parts
                    .map((part: { text?: unknown }) => safeText(part?.text, 2000))
                    .filter(Boolean)
                    .join('\n')
                    .slice(0, 2500)
                : '';
              if (text) {
                summary = text;
                break directLoop;
              }
            } else if (directRes && (directRes.status === 429 || directRes.status === 401 || directRes.status === 403 || directRes.status >= 500)) {
              reportGeminiKeyFailure(apiKey, directRes.status);
            }
          } catch {
            // Continue
          }
        }
      }
    }

    if (!summary) {
      return NextResponse.json(
        { success: false, error: 'AI 比价服务当前繁忙（已尝试多通道重试），请稍后再试。' },
        { status: 503 }
      );
    }

    return NextResponse.json({
      success: true,
      summary,
      sources,
      cleanItemName,
    });
  } catch {
    return NextResponse.json(
      { success: false, error: 'Online price search failed. Try again in a moment.' },
      { status: 500 }
    );
  }
}
