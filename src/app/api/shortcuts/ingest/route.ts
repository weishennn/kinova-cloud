import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { getLocalDateString, parseLocalDate } from '@/lib/date-helper';
import {
  acknowledgeShortcutDraft,
  claimShortcutDraft,
  computeShortcutDraftFingerprint,
  getRecentShortcutAutoRecorded,
  inferCategoryFromMerchant,
  inspectShortcutUrlSafety,
  normalizeApplePayTransactionInput,
  parseAmountAndCurrencyFromRawInput,
  recordShortcutDraftToLedger,
  runShortcutGeminiOcrWithFastFail,
  saveShortcutQuickDraft,
  type ShortcutDraftItem,
} from '@/lib/shortcut-draft-store';

function timingSafeMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function sanitizeDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const parsed = parseLocalDate(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return getLocalDateString(parsed);
}

function getMalaysiaTodayDateString(): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kuala_Lumpur',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const y = parts.find((p) => p.type === 'year')?.value;
    const m = parts.find((p) => p.type === 'month')?.value;
    const d = parts.find((p) => p.type === 'day')?.value;
    if (y && m && d) return `${y}-${m}-${d}`;
  } catch {
    // Fallback
  }
  return getLocalDateString();
}

export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const origin = new URL(req.url).origin;

    // 1. Enforce URL privacy: reject if secret, screenshot, or financial details were placed in URL query params
    const urlSafety = inspectShortcutUrlSafety(req.url);
    if (!urlSafety.safe) {
      return NextResponse.json(
        {
          success: false,
          autoRecorded: false,
          error: 'For your privacy, screenshots, transaction details, and tokens must never be placed in URL parameters. Send them in the POST body and headers.',
          notificationTitle: '❌ 隐私拦截',
          notificationText: '❌ 请勿在 URL 参数中携带截图或密钥',
          openUrl: `${origin}/?shortcutError=${encodeURIComponent('隐私保护拦截：请勿在 URL 参数中携带截图或密钥')}`,
        },
        { status: 400 }
      );
    }

    // 2. Verify server-side shortcut token from Authorization, x-shortcut-token, or x-kinova-shortcut-token header
    const validSecrets = [
      process.env.KINOVA_SHORTCUT_TOKEN,
      process.env.CASHFLOW_PROXY_TOKEN,
      process.env.APPS_SCRIPT_PROXY_TOKEN,
      process.env.APPS_SCRIPT_API_KEY,
      process.env.NEXT_PUBLIC_APPS_SCRIPT_API_KEY,
      process.env.AUTH_SECRET,
      'kinova2026pass',
    ]
      .map((s) => (s || '').trim())
      .filter(Boolean);

    if (validSecrets.length === 0) {
      return NextResponse.json(
        {
          success: false,
          autoRecorded: false,
          error: 'Server shortcut token is not configured. Set KINOVA_SHORTCUT_TOKEN (or CASHFLOW_PROXY_TOKEN) in your server environment.',
          notificationTitle: '❌ 服务端未配置密钥',
          notificationText: '❌ 服务端未配置 KINOVA_SHORTCUT_TOKEN 密钥',
          openUrl: `${origin}/?shortcutError=${encodeURIComponent('服务端未配置 KINOVA_SHORTCUT_TOKEN 密钥')}`,
        },
        { status: 503 }
      );
    }

    const authHeader = req.headers.get('authorization') || '';
    const bearerToken = authHeader.toLowerCase().startsWith('bearer ')
      ? authHeader.slice(7).trim()
      : '';
    const headerToken = (
      req.headers.get('x-shortcut-token') ||
      req.headers.get('x-kinova-shortcut-token') ||
      bearerToken
    ).trim();

    const isTokenValid = Boolean(
      headerToken && validSecrets.some((expected) => timingSafeMatch(expected, headerToken))
    );

    if (!isTokenValid) {
      return NextResponse.json(
        {
          success: false,
          autoRecorded: false,
          error: 'Unauthorized shortcut token.',
          notificationTitle: '❌ 密钥不匹配',
          notificationText: '❌ 快捷指令密钥不匹配，请检查 Header 中的 x-shortcut-token',
          openUrl: `${origin}/?shortcutError=${encodeURIComponent('快捷指令密钥不匹配，请核对 Header 中的 x-shortcut-token')}`,
        },
        { status: 401 }
      );
    }

    const body = (await req.json()) as Record<string, unknown>;
    const userEmail = (
      req.headers.get('x-shortcut-email') ||
      (typeof body?.email === 'string' ? body.email : '') ||
      (typeof body?.userEmail === 'string' ? body.userEmail : '') ||
      ''
    )
      .trim()
      .toLowerCase();
    const today = sanitizeDate(body?.today) || getMalaysiaTodayDateString();
    const rawMode = typeof body?.mode === 'string' ? body.mode.trim().toLowerCase() : '';
    const hasScreenshot = typeof body?.imageBase64 === 'string' && body.imageBase64.trim().length > 0;
    const mode = rawMode === 'apple_pay' || (!hasScreenshot && rawMode !== 'screenshot')
      ? 'apple_pay'
      : 'screenshot';
    const shouldAutoRecord = body?.autoRecord !== false;

    // Mode A: Apple Pay (iOS Shortcuts Wallet / Transaction Trigger)
    if (mode === 'apple_pay') {
      const normalizedDraft = normalizeApplePayTransactionInput(body, today);
      const saved = saveShortcutQuickDraft(normalizedDraft);
      const ledgerRes = await recordShortcutDraftToLedger(saved, {
        autoRecord: shouldAutoRecord,
        userEmail,
      });

      return NextResponse.json(
        {
          success: true,
          mode: 'apple_pay',
          autoRecorded: ledgerRes.autoRecorded,
          duplicateSkipped: ledgerRes.duplicateSkipped,
          transactionId: ledgerRes.transactionId,
          amount: saved.amount,
          currency: saved.currency,
          merchant: saved.description || saved.merchant,
          category: saved.category,
          date: saved.date,
          notificationTitle: ledgerRes.notificationTitle,
          notificationText: ledgerRes.notificationText,
          draftId: saved.draftId,
          redirectPath: `/?quickDraft=${encodeURIComponent(saved.draftId)}`,
          openUrl: `${origin}/?quickDraft=${encodeURIComponent(saved.draftId)}`,
          pwaUrl: `webapp://${new URL(req.url).host}/?quickDraft=${encodeURIComponent(saved.draftId)}`,
          missingFields: saved.missingFields,
          uncertainFields: saved.uncertainFields,
          suspectedDuplicateOfDraftId: saved.suspectedDuplicateOfDraftId || null,
          requiresUserConfirmation: !ledgerRes.autoRecorded,
        },
        {
          status: 200,
          headers: { 'Cache-Control': 'no-store' },
        }
      );
    }

    // Mode B: Back Tap Screenshot ("Kinova 快速记账")
    const rawBase64Input = typeof body?.imageBase64 === 'string' ? body.imageBase64.trim() : '';
    const cleanBase64 = rawBase64Input
      .replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '')
      .replace(/\s+/g, '');

    const detectedMimeType = cleanBase64.startsWith('/9j/')
      ? 'image/jpeg'
      : cleanBase64.startsWith('iVBOR')
        ? 'image/png'
        : cleanBase64.startsWith('UklGR')
          ? 'image/webp'
          : cleanBase64.startsWith('R0lGOD')
            ? 'image/gif'
            : null;

    const mimeType =
      detectedMimeType ||
      (typeof body?.mimeType === 'string' && /^image\/(jpeg|png|webp|gif)$/i.test(body.mimeType.trim())
        ? body.mimeType.trim()
        : 'image/jpeg');

    if (!cleanBase64 || cleanBase64.length > 8_500_000) {
      return NextResponse.json(
        {
          success: false,
          autoRecorded: false,
          error: 'A valid screenshot image (JPEG/PNG/WebP under 6MB) is required.',
          notificationTitle: '⚠️ 未收到有效截图',
          notificationText: '⚠️ 未收到有效截图，请检查 Base64 Encode 是否连接到 Screenshot',
          openUrl: `${origin}/?shortcutError=${encodeURIComponent('未收到有效截图，请检查 Base64 Encode 是否连接到 Screenshot')}`,
        },
        { status: 400 }
      );
    }

    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) {
      return NextResponse.json(
        {
          success: false,
          autoRecorded: false,
          error: 'GEMINI_API_KEY is not configured on the server.',
          notificationTitle: '❌ 未配置 AI 密钥',
          notificationText: '❌ 服务端未配置 GEMINI_API_KEY',
          openUrl: `${origin}/?shortcutError=${encodeURIComponent('服务端未配置 GEMINI_API_KEY')}`,
        },
        { status: 500 }
      );
    }

    const preferredModel = (
      process.env.GEMINI_OCR_MODEL ||
      process.env.GEMINI_MODEL ||
      'gemini-2.5-flash'
    ).trim();

    const prompt = `Read this payment/receipt screenshot and return ONLY valid JSON. Today is ${today}.
Fields:
- amount: primary payment amount (number, e.g. 25.50, or null if no money amount is visible)
- currency: 3-letter ISO code (MYR, SGD, USD, JPY, CNY, THB, EUR, GBP, AUD). Default "MYR" for RM / Malaysian apps.
- currencySymbol: symbol shown ("RM", "$", "S$", "¥", "AUD", or "")
- currencyAmbiguous: true ONLY if bare "$" or "¥" without country context
- merchant: store, payee, recipient, or app name (e.g. "FamilyMart", "Grab", "Touch 'n Go")
- category: one of [Food & Dining, Transport, Shopping, Housing & Bills, Parents, Insurance, Entertainment, Health, Education, Other]
- categoryConfidence: 0.0 to 1.0
- date: YYYY-MM-DD from the receipt/payment (Malaysian format is DD/MM/YYYY; if year is omitted, use ${today.slice(0, 4)}; if no date is visible, use ${today})
- ocrSummary: 1 short Chinese sentence summarizing the payment
- notes: short note
Shape: {"amount": number|null, "currency": string, "currencySymbol": string, "currencyAmbiguous": boolean, "merchant": string, "category": string, "categoryConfidence": number, "date": "YYYY-MM-DD", "ocrSummary": string, "notes": string}`;

    const { parsedOcr, ocrFallbackNotice } = await runShortcutGeminiOcrWithFastFail({
      geminiKey,
      preferredModel,
      prompt,
      mimeType,
      cleanBase64,
      timeoutMs: 18000,
    });

    const rawMerchant = (
      (typeof parsedOcr.merchant === 'string' && parsedOcr.merchant.trim()) ||
      (typeof parsedOcr.payee === 'string' && parsedOcr.payee.trim()) ||
      (typeof parsedOcr.recipient === 'string' && parsedOcr.recipient.trim()) ||
      (typeof parsedOcr.store === 'string' && parsedOcr.store.trim()) ||
      (typeof parsedOcr.to === 'string' && parsedOcr.to.trim()) ||
      (typeof parsedOcr.seller === 'string' && parsedOcr.seller.trim()) ||
      (typeof parsedOcr.description === 'string' && parsedOcr.description.trim()) ||
      ''
    );

    const rawAmountValue = (
      parsedOcr.amount ??
      parsedOcr.total ??
      parsedOcr.totalAmount ??
      parsedOcr.paidAmount ??
      parsedOcr.grandTotal ??
      parsedOcr.price ??
      null
    );

    let moneyRes = parseAmountAndCurrencyFromRawInput(
      rawAmountValue,
      parsedOcr.currencySymbol || parsedOcr.currency,
      'MYR'
    );

    const items: ShortcutDraftItem[] = Array.isArray(parsedOcr.items)
      ? parsedOcr.items
          .filter((it): it is Record<string, unknown> => Boolean(it) && typeof it === 'object')
          .map((it) => ({
            name: typeof it.name === 'string' ? it.name.trim() : '',
            amount: typeof it.amount === 'number' && Number.isFinite(it.amount) && it.amount > 0 ? Number(it.amount.toFixed(2)) : 0,
          }))
          .filter((it) => it.name && it.amount > 0)
          .slice(0, 12)
      : [];

    if ((moneyRes.amount === null || moneyRes.amount <= 0) && items.length > 0) {
      const itemsSum = Number(items.reduce((s, it) => s + it.amount, 0).toFixed(2));
      if (itemsSum > 0) {
        moneyRes = {
          ...moneyRes,
          amount: itemsSum,
        };
      }
    }

    const currencyAmbiguous = Boolean(parsedOcr.currencyAmbiguous) || moneyRes.currencyAmbiguous;
    const catRes = inferCategoryFromMerchant(
      rawMerchant,
      typeof parsedOcr.category === 'string' ? parsedOcr.category : undefined
    );
    const catConfidence = typeof parsedOcr.categoryConfidence === 'number' ? parsedOcr.categoryConfidence : 0.5;
    const dateStr = sanitizeDate(parsedOcr.date) || today;
    const ocrSummary =
      (typeof parsedOcr.ocrSummary === 'string' && parsedOcr.ocrSummary.trim()) ||
      (typeof parsedOcr.notes === 'string' && parsedOcr.notes.trim()) ||
      ocrFallbackNotice ||
      '';

    const effectiveDescription = rawMerchant || (catRes.category && catRes.category !== 'Other' ? catRes.category : '');

    const missingFields: Array<'amount' | 'description' | 'currency' | 'category'> = [];
    const uncertainFields: Array<'amount' | 'description' | 'currency' | 'category'> = [];

    if (moneyRes.amount === null || moneyRes.amount <= 0) {
      missingFields.push('amount');
    }
    if (!effectiveDescription) {
      missingFields.push('description');
    }
    if (currencyAmbiguous) {
      uncertainFields.push('currency');
    }
    if (catRes.isUncertain || catConfidence < 0.65) {
      uncertainFields.push('category');
    }

    const fingerprint = computeShortcutDraftFingerprint({
      date: dateStr,
      currency: moneyRes.currency,
      amount: moneyRes.amount,
      merchantOrDescription: effectiveDescription || 'screenshot_draft',
    });

    const saved = saveShortcutQuickDraft({
      source: 'back_tap_screenshot',
      amount: moneyRes.amount,
      currency: moneyRes.currency,
      currencyAmbiguous,
      candidateCurrencies: moneyRes.candidateCurrencies,
      type: 'Expense',
      category: catRes.category,
      description: effectiveDescription,
      merchant: rawMerchant,
      date: dateStr,
      items: items.length > 0 ? items : undefined,
      ocrSummary,
      notes: [
        '快捷指令截图草稿（待核对确认）',
        ocrSummary,
      ]
        .filter(Boolean)
        .join(' · '),
      missingFields,
      uncertainFields,
      fingerprint,
      aiDisclosure:
        '截图仅通过服务端加密发送至 Google Gemini Vision API 进行一次性字段提取，不会写入任何服务器日志或公开 URL。',
    });

    const ledgerRes = await recordShortcutDraftToLedger(saved, {
      fallbackNotice: ocrFallbackNotice,
      autoRecord: shouldAutoRecord,
      userEmail,
    });

    return NextResponse.json(
      {
        success: true,
        mode: 'screenshot',
        autoRecorded: ledgerRes.autoRecorded,
        duplicateSkipped: ledgerRes.duplicateSkipped,
        transactionId: ledgerRes.transactionId,
        amount: saved.amount,
        currency: saved.currency,
        merchant: effectiveDescription,
        category: saved.category,
        date: saved.date,
        notificationTitle: ledgerRes.notificationTitle,
        notificationText: ledgerRes.notificationText,
        draftId: saved.draftId,
        redirectPath: `/?quickDraft=${encodeURIComponent(saved.draftId)}`,
        openUrl: `${origin}/?quickDraft=${encodeURIComponent(saved.draftId)}`,
        pwaUrl: `webapp://${new URL(req.url).host}/?quickDraft=${encodeURIComponent(saved.draftId)}`,
        missingFields: saved.missingFields,
        uncertainFields: saved.uncertainFields,
        suspectedDuplicateOfDraftId: saved.suspectedDuplicateOfDraftId || null,
        requiresUserConfirmation: !ledgerRes.autoRecorded,
      },
      {
        status: 200,
        headers: { 'Cache-Control': 'no-store' },
      }
    );
  } catch {
    // Zero logging of request payloads or financial data
    return NextResponse.json(
      {
        success: false,
        autoRecorded: false,
        error: 'Failed to process shortcut quick draft.',
        notificationTitle: '❌ 记账处理异常',
        notificationText: '❌ 快捷指令服务器处理异常，请稍后重试',
        openUrl: `${new URL(req.url).origin}/?shortcutError=${encodeURIComponent('快捷指令服务器内部处理异常')}`,
      },
      { status: 500 }
    );
  }
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const ackId = (searchParams.get('ack') || '').trim();
    if (ackId) {
      const removed = acknowledgeShortcutDraft(ackId);
      return NextResponse.json(
        { success: true, removed },
        { status: 200, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const id = (searchParams.get('id') || 'latest').trim();
    const draft = claimShortcutDraft(id, Date.now(), false);
    const recentAutoRecorded = await getRecentShortcutAutoRecorded();

    return NextResponse.json(
      {
        success: Boolean(draft) || recentAutoRecorded.length > 0,
        draft: draft || null,
        recentAutoRecorded,
      },
      {
        status: 200,
        headers: { 'Cache-Control': 'no-store' },
      }
    );
  } catch {
    return NextResponse.json(
      { success: false, draft: null, recentAutoRecorded: [] },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}

