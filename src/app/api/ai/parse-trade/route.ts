import { NextRequest, NextResponse } from 'next/server';
import { getLocalDateString } from '@/lib/date-helper';
import { getValidGoogleSession } from '@/lib/google-auth';
import { recordUserAiCall } from '@/lib/admin-registry';
import { getLoadBalancedGeminiKeys, reportGeminiKeyFailure } from '@/lib/gemini-key-pool';
import {
  buildTradeAiPrompt,
  inferTradeAssetType,
  reconcileTradeFees,
  sanitizeTradeAction,
  sanitizeTradeCurrency,
  sanitizeTradeDate,
  type ParsedTradePayload,
  type RawTradeFeeBreakdown,
} from '@/lib/trade-ai-parser';

export async function POST(req: NextRequest) {
  try {
    const { session } = await getValidGoogleSession(req);
    // If authenticated via Google, record AI usage and check whitelist
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
    const rawImage = typeof body?.imageBase64 === 'string' ? body.imageBase64 : '';
    const imageBase64 = rawImage.replace(/^data:image\/\w+;base64,/, '').trim();
    const mimeType = typeof body?.mimeType === 'string' ? body.mimeType : 'image/jpeg';
    const textInput = typeof body?.text === 'string' ? body.text.trim() : '';
    const today = sanitizeTradeDate(body?.today, getLocalDateString());

    if (!imageBase64 && !textInput) {
      return NextResponse.json(
        { success: false, error: 'A trade confirmation screenshot or text details are required.' },
        { status: 400 }
      );
    }

    const apiKeys = getLoadBalancedGeminiKeys();
    if (apiKeys.length === 0) {
      return NextResponse.json(
        { success: false, error: 'GEMINI_API_KEY is not configured in server environment.' },
        { status: 500 }
      );
    }

    const preferredModel = (process.env.GEMINI_OCR_MODEL || process.env.GEMINI_MODEL || '').trim();
    const models = [
      'gemini-2.5-flash',
      preferredModel,
      'gemini-flash-latest',
      'gemini-3.5-flash',
    ].filter((v, i, a) => Boolean(v) && a.indexOf(v) === i);

    const prompt = buildTradeAiPrompt(today);

    // Build parts: image or text
    const parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }> = [
      { text: prompt },
    ];

    if (imageBase64) {
      parts.push({
        inline_data: {
          mime_type: mimeType,
          data: imageBase64,
        },
      });
    }

    if (textInput) {
      parts.push({
        text: `Here are the broker trade details to analyze:\n"""\n${textInput}\n"""`,
      });
    }

    let parsedResult: Record<string, unknown> | null = null;

    for (const model of models) {
      let res: Response | null = null;
      let shouldTryNextModel = false;

      for (let keyIdx = 0; keyIdx < apiKeys.length; keyIdx += 1) {
        const apiKey = apiKeys[keyIdx];
        try {
          res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ role: 'user', parts }],
                generationConfig: {
                  responseMimeType: 'application/json',
                  temperature: 0.1,
                  maxOutputTokens: 2048,
                },
              }),
              signal: AbortSignal.timeout(25000),
            }
          );
        } catch {
          // Timeout or connection error on this key/model, failover to next key
          continue;
        }

        if (res && res.ok) break;

        // Model-level overload (503) or missing (404): failover to next candidate model immediately!
        if (res && (res.status === 503 || res.status === 404)) {
          shouldTryNextModel = true;
          break;
        }

        if (res && (res.status === 429 || res.status === 401 || res.status === 403 || res.status >= 500)) {
          reportGeminiKeyFailure(apiKey, res.status);
          if (keyIdx + 1 < apiKeys.length) {
            continue; // Failover to next configured API key
          }
        }
        break;
      }

      if (shouldTryNextModel) continue;

      if (!res || !res.ok) {
        const status = res?.status ?? 502;
        const userMessage = status === 429
          ? 'Gemini quota is temporarily exhausted across all configured keys. Try again in a moment.'
          : status === 503
            ? 'Gemini service is temporarily overloaded (HTTP 503). Retrying...'
            : `AI trade OCR failed (${status}). Please verify the screenshot is clear.`;
        return NextResponse.json({ success: false, error: userMessage }, { status: 502 });
      }

      const responseData = await res.json();
      const rawJson = responseData.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawJson) {
        return NextResponse.json({ success: false, error: 'Gemini returned no trade data.' }, { status: 502 });
      }

      let cleanJson = rawJson.trim();
      const blockMatch = cleanJson.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (blockMatch) {
        cleanJson = blockMatch[1].trim();
      }

      try {
        parsedResult = JSON.parse(cleanJson) as Record<string, unknown>;
      } catch {
        const jsonMatch = cleanJson.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            parsedResult = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
          } catch {
            return NextResponse.json({ success: false, error: 'AI returned invalid JSON trade structure.' }, { status: 502 });
          }
        }
      }

      if (parsedResult) break;
    }

    if (!parsedResult) {
      return NextResponse.json({ success: false, error: 'Could not extract trade details from this screenshot.' }, { status: 502 });
    }

    // Extract & sanitize trade fields
    const rawTicker = String(parsedResult.ticker || '').trim().toUpperCase();
    if (!rawTicker) {
      return NextResponse.json({ success: false, error: 'No stock ticker found in the screenshot.' }, { status: 422 });
    }

    const action = sanitizeTradeAction(parsedResult.action);
    const assetType = inferTradeAssetType(rawTicker, typeof parsedResult.assetType === 'string' ? parsedResult.assetType : undefined);
    const assetName = String(parsedResult.assetName || rawTicker).trim();
    const currency = sanitizeTradeCurrency(parsedResult.currency, assetType === 'MY Stock' ? 'MYR' : 'USD');
    const date = sanitizeTradeDate(parsedResult.date, today);

    const quantity = Math.max(0, parseFloat(String(parsedResult.quantity || 0)) || 0);
    const price = Math.max(0, parseFloat(String(parsedResult.price || 0)) || 0);
    const rawFees = parseFloat(String(parsedResult.fees || 0)) || 0;
    const rawNetTotal = parseFloat(String(parsedResult.netTotal || 0)) || 0;
    const orderId = parsedResult.orderId ? String(parsedResult.orderId) : null;
    const rawFeeBreakdown = (typeof parsedResult.feeBreakdown === 'object' && parsedResult.feeBreakdown !== null)
      ? (parsedResult.feeBreakdown as RawTradeFeeBreakdown)
      : undefined;

    const reconciled = reconcileTradeFees({
      quantity,
      price,
      fees: rawFees,
      netTotal: rawNetTotal,
      action,
      feeBreakdown: rawFeeBreakdown,
      orderId,
    });

    const responsePayload: ParsedTradePayload = {
      action,
      ticker: rawTicker,
      assetName,
      assetType,
      quantity,
      price,
      fees: reconciled.fees,
      netTotal: reconciled.netTotal,
      currency,
      date,
      feeBreakdown: rawFeeBreakdown,
      notes: reconciled.formattedNotes || (orderId ? `Order #${orderId}` : ''),
      isReinvested: action === 'REINVEST',
    };

    return NextResponse.json({
      success: true,
      data: responsePayload,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown trade extraction error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
