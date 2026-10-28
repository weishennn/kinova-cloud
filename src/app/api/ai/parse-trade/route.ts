import { NextRequest, NextResponse } from 'next/server';
import { getLocalDateString } from '@/lib/date-helper';
import { getValidGoogleSession } from '@/lib/google-auth';
import { recordUserAiCall } from '@/lib/admin-registry';
import { generateGeminiContent } from '@/lib/gemini-key-pool';
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

    const prompt = buildTradeAiPrompt(today) + (textInput ? `\n\nHere are the broker trade details to analyze:\n"""\n${textInput}\n"""` : '');

    let cleanJson = '';
    try {
      const result = await generateGeminiContent({
        prompt,
        imageBase64: imageBase64 || undefined,
        mimeType: imageBase64 ? mimeType : undefined,
        responseMimeType: 'application/json',
        thinking: false,
        thinkingBudget: 0,
        temperature: 0.1,
        maxOutputTokens: 2048,
        timeoutMs: 25_000,
      });
      cleanJson = result.text;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Trade extraction failed';
      return NextResponse.json({ success: false, error: errorMsg }, { status: 502 });
    }

    let parsedResult: Record<string, unknown> | null = null;
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
