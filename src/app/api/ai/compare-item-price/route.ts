import { NextRequest, NextResponse } from 'next/server';
import { getValidGoogleSession } from '@/lib/google-auth';
import { recordUserAiCall } from '@/lib/admin-registry';
import { getLoadBalancedGeminiKeys, generateGeminiWithSearchFallback, type GroundedWebSource } from '@/lib/gemini-key-pool';
import { extractCleanItemKeyword } from '@/lib/receipt-items';

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

    let summary = '';
    let sources: GroundedWebSource[] = [];

    try {
      const searchResult = await generateGeminiWithSearchFallback({
        prompt,
        maxOutputTokens: 800,
        temperature: 0.1,
        searchTimeoutMs: 4_500,
        searchTotalTimeoutMs: 7_500,
        directTimeoutMs: 8_000,
        directTotalTimeoutMs: 12_000,
        preferredSearchModel: process.env.GEMINI_PRICE_SEARCH_MODEL,
      });
      summary = searchResult.summary.slice(0, 2500);
      sources = searchResult.sources;
    } catch (directErr) {
      console.warn('[CompareItemPrice] Generation error:', directErr);
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
