import { NextRequest, NextResponse } from 'next/server';
import { getValidGoogleSession } from '@/lib/google-auth';
import { recordUserAiCall } from '@/lib/admin-registry';
import { getLoadBalancedGeminiKeys, reportGeminiKeyFailure } from '@/lib/gemini-key-pool';
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

    const prompt = `Provide the current typical market price and price range in Malaysia for this item/food/product, priced in MYR:
${JSON.stringify(productDescription)}

Instructions:
1. If this is a food dish, dining item, or meal (e.g. 鸡饭 / chicken rice, 椰浆饭, 咖啡, 杂饭, 面食, hawker food, or cafe dining):
   - Explain the current typical price range in Malaysia across common dining settings:
     • 普通茶餐室 / 小贩中心 (Hawker / Kopitiam): typically around RM 8.00 - RM 13.00.
     • 空调餐馆 / 商场美食广场 (Cafe / Mall food court): typically RM 15.00 - RM 25.00.
   - Mention common variations affecting price (e.g. 加料/鸡腿/配料/饮料套餐等带来的差异).
2. If this is a retail consumer product or grocery (e.g. shampoo, eggs, milk, groceries):
   - Use Google Search to find current listings across major Malaysian retailers (Lotus's, Giant, Watsons, Guardian, Shopee, etc.).
   - Give a clear price comparison or typical price range.
3. Match the user's language (respond in Simplified Chinese if the input is in Chinese; English if English).
4. Keep the answer structured, concise, and helpful (under 140 words).`;

    const model = process.env.GEMINI_PRICE_SEARCH_MODEL || 'gemini-2.5-flash';
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
              temperature: 0.1,
              maxOutputTokens: 800,
            },
          }),
          signal: AbortSignal.timeout(14_000),
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
        { success: false, error: 'Online price search timed out. Try again in a moment.' },
        { status: 504 }
      );
    }

    if (!response.ok) {
      const message =
        response.status === 429
          ? 'Gemini search quota is temporarily exhausted. Try again later.'
          : response.status === 401 || response.status === 403
            ? 'Gemini rejected the configured server key.'
            : 'Online price search failed. Try again in a moment.';
      return NextResponse.json({ success: false, error: message }, { status: 502 });
    }

    const data = await response.json();
    const candidate = data?.candidates?.[0];
    const summary = Array.isArray(candidate?.content?.parts)
      ? candidate.content.parts
          .map((part: { text?: unknown }) => safeText(part?.text, 2000))
          .filter(Boolean)
          .join('\n')
          .slice(0, 2500)
      : '';

    if (!summary) {
      return NextResponse.json(
        { success: false, error: 'Google Search did not return a comparable price result.' },
        { status: 502 }
      );
    }

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
            (source, index, all) =>
              all.findIndex((candidateSource) => candidateSource.uri === source.uri) === index
          )
          .slice(0, 5)
      : [];

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
