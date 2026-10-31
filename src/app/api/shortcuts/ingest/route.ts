import crypto from 'crypto';
import { NextRequest, NextResponse, after } from 'next/server';
import { getLocalDateString, parseLocalDate } from '@/lib/date-helper';
import { getValidGoogleSession } from '@/lib/google-auth';
import { getActiveShortcutOwnerEmail, setActiveShortcutOwner } from '@/lib/admin-registry';
import {
  classifyMerchantWithGemini,
  getLoadBalancedGeminiKeys,
  reportGeminiKeyFailure,
} from '@/lib/gemini-key-pool';
import { matchHabitMemory } from '@/lib/habit-memory-engine';
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
  sanitizeMerchantCandidate,
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

function getRequestOrigin(req: NextRequest): string {
  const envAppUrl = (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || '').replace(/\/$/, '');
  const forwardedHost = req.headers.get('x-forwarded-host');
  const host = forwardedHost || req.headers.get('host');
  const forwardedProto = req.headers.get('x-forwarded-proto') || 'https';
  if (host && !host.startsWith('localhost') && !host.startsWith('127.0.0.1')) {
    const proto = forwardedHost ? forwardedProto : (host.startsWith('192.168.') || host.startsWith('10.') || host.startsWith('172.') ? 'http' : 'https');
    return `${proto}://${host}`;
  }
  if (envAppUrl) return envAppUrl;
  return new URL(req.url).origin;
}

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const origin = getRequestOrigin(req);

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
    const urlParamEmail = (
      req.nextUrl.searchParams.get('email') ||
      req.nextUrl.searchParams.get('user') ||
      req.nextUrl.searchParams.get('u') ||
      ''
    ).trim().toLowerCase();
    const explicitEmail = (
      req.headers.get('x-shortcut-email') ||
      urlParamEmail ||
      (typeof body?.email === 'string' ? body.email : '') ||
      (typeof body?.userEmail === 'string' ? body.userEmail : '') ||
      ''
    )
      .trim()
      .toLowerCase();
    const { session } = await getValidGoogleSession(req);
    const userEmail = (
      explicitEmail ||
      session?.email ||
      ''
    )
      .trim()
      .toLowerCase();

    // Strict zero-guess policy: In a multi-user deployment, unauthenticated shortcuts MUST explicitly
    // specify their user email to guarantee 100% account isolation. Never guess and never default!
    if (!userEmail) {
      return NextResponse.json(
        {
          success: false,
          autoRecorded: false,
          error: 'Missing user email in shortcut request. To ensure strict account isolation, you must provide your email via x-shortcut-email header, ?user=email in URL, or userEmail in body.',
          notificationTitle: '⚠️ 记账未绑定账号',
          notificationText: '⚠️ 快捷指令未指定用户账号，本次未记账。请在快捷指令中添加 x-shortcut-email 或在 URL 添加 ?user=你的邮箱',
          openUrl: `${origin}/?shortcutError=${encodeURIComponent('快捷指令未指定用户账号，已拒绝入账以保护数据隐私')}`,
        },
        { status: 400 }
      );
    }

    const today = sanitizeDate(body?.today) || getMalaysiaTodayDateString();
    const rawMode = typeof body?.mode === 'string' ? body.mode.trim().toLowerCase() : '';
    const hasScreenshot = typeof body?.imageBase64 === 'string' && body.imageBase64.trim().length > 0;
    const mode = rawMode === 'apple_pay' || (!hasScreenshot && rawMode !== 'screenshot')
      ? 'apple_pay'
      : 'screenshot';
    // Auto-record policy: By default, when all required fields (amount, merchant) are cleanly identified,
    // automatically record directly to the ledger (Google Sheets) and return a success notification.
    // Only fall back to pending draft mode when fields are missing/ambiguous, or if explicitly requested.
    const explicitAutoRecordParam = req.nextUrl.searchParams.get('autoRecord');
    const requestedAutoRecord =
      explicitAutoRecordParam !== null
        ? explicitAutoRecordParam === 'true' || explicitAutoRecordParam === '1'
        : body?.autoRecord !== false;

    // Mode A: Apple Pay (iOS Shortcuts Wallet / Transaction Trigger)
    if (mode === 'apple_pay') {
      const normalizedDraft = normalizeApplePayTransactionInput(body, today);

      // AI Brain Reasoning: If category is uncertain or 'Other', use Gemini LLM to reason over
      // the merchant/description (e.g. "Omakase", "Izakaya", niche boutiques) rather than defaulting to uncertain
      if (
        (normalizedDraft.uncertainFields.includes('category') || normalizedDraft.category === 'Other') &&
        (normalizedDraft.merchant || normalizedDraft.description)
      ) {
        const queryText = normalizedDraft.merchant || normalizedDraft.description || '';
        try {
          const aiCategory = await classifyMerchantWithGemini(queryText);
          if (aiCategory && aiCategory !== 'Other') {
            normalizedDraft.category = aiCategory;
            normalizedDraft.uncertainFields = normalizedDraft.uncertainFields.filter((f) => f !== 'category');
          }
        } catch (err) {
          console.warn('[Shortcut Ingest] Gemini text classification in Mode A skipped:', err);
        }
      }

      const saved = saveShortcutQuickDraft({
        ...normalizedDraft,
        ownerEmail: userEmail || undefined,
      });

      const canAutoRecord =
        requestedAutoRecord &&
        normalizedDraft.amount !== null &&
        normalizedDraft.amount > 0 &&
        Boolean(normalizedDraft.merchant || normalizedDraft.description);

      const isExplicitSync = req.nextUrl.searchParams.get('sync') === 'true';

      let ledgerRes: {
        autoRecorded: boolean;
        duplicateSkipped: boolean;
        transactionId: string | null;
        sheetName: string | null;
        notificationTitle: string;
        notificationText: string;
      };

      if (canAutoRecord && !isExplicitSync) {
        const label = saved.description || saved.merchant || saved.category || '消费记录';
        const rawCurr = (saved.currency || 'MYR').toUpperCase().trim();
        const curr = rawCurr === 'RM' || !rawCurr ? 'MYR' : rawCurr;
        const targetDate = String(saved.date || '').trim().slice(0, 10);

        ledgerRes = {
          autoRecorded: true,
          duplicateSkipped: false,
          transactionId: saved.draftId,
          sheetName: targetDate.slice(0, 7),
          notificationTitle: `✅ 已记账 ${curr} ${saved.amount!.toFixed(2)} (${targetDate})`,
          notificationText: `✅ 已记账 [${targetDate}]：${curr} ${saved.amount!.toFixed(2)} · ${label} (${saved.category})`,
        };

        after(async () => {
          try {
            await recordShortcutDraftToLedger(saved, {
              autoRecord: true,
              userEmail,
            });
          } catch (err) {
            console.error('[Shortcut Ingest ApplePay] Background Google Sheets write error:', err);
          }
        });
      } else {
        ledgerRes = await recordShortcutDraftToLedger(saved, {
          autoRecord: canAutoRecord,
          userEmail,
        });
      }

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

    const geminiKeys = getLoadBalancedGeminiKeys();
    if (geminiKeys.length === 0) {
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

    const rawModel = (
      process.env.GEMINI_OCR_MODEL ||
      process.env.GEMINI_MODEL ||
      'gemini-3.5-flash'
    ).trim();
    // Defensive sanitization: Automatically remap deprecated model to prevent 404 even if remote server env is stale
    const preferredModel = rawModel === 'gemini-2.5-flash' ? 'gemini-3.5-flash' : rawModel;

    const prompt = `You are an intelligent financial OCR and receipt analysis AI.
Analyze this payment / receipt / transaction screenshot carefully and return ONLY valid JSON.
Today is ${today}.

CRITICAL INSTRUCTIONS:
1. NOTIFICATION BANNER / UI CHROME FILTERING:
   - Screenshots often have mobile UI chrome: iOS status bar (time, 5G, battery), Dynamic Island, or NOTIFICATION BANNERS at the top (e.g. from "Kinova Automation", "Shortcuts", "Automation", "Screenshot", "now", notification icons).
   - NEVER EVER use "Kinova Automation", "Kinova", "Shortcuts", or any system app/shortcut name as the merchant, store, or item name!
   - NEVER use generic screen status titles like "Payment successful", "Payment success", "Order details", or "Order ID" as the merchant name!
   - Look UNDERNEATH or PAST any notification banner to find the ACTUAL store/merchant name (e.g. restaurant brand, petrol station, store, stall).

2. APP HEADER & WEBH5 SHOP NAME EXTRACTION:
   - On payment success screens (e.g. Touch 'n Go, GrabPay, WeChat mini-programs, food order webviews), the shop name is often located at the top navigation bar next to a close button '✕' or '<' (e.g. '✕ Store Name - Branch...').
   - You MUST extract the merchant name from this top bar if it is not inside the card body!
   - Clean branch suffixes or trailing truncation dots.
   - LINE ITEMS INFERENCE: If the payment confirmation does not list individual dishes or items, generate a single line item using the merchant name or description.

2.5. E-WALLET & BANK TRANSFER CONFIRMATIONS (ShopeePay, Touch 'n Go, GrabPay, MAE, DuitNow QR):
   - PAYMENT METHOD IS NOT THE MERCHANT: "ShopeePay", "ShopeePay Balance", "Touch 'n Go eWallet", "eWallet Balance", "DuitNow QR", "MAE" are payment channels/methods, NEVER the merchant/store name!
   - MERCHANT LOCATION IS NOT THE STORE NAME: "Merchant Location: AMPANG", "Location: ...", or city names are locations, NOT the merchant/store name! NEVER invent generic names like "Food Stall (Ampang)" or "Shop (Location)"!
   - EXTRACT "MEMO" / "REMARK" / "RECIPIENT REFERENCE": In e-wallet receipts, look carefully for "Memo", "Remark", "Recipient Reference", "Payment Details", or "Note".
   - When no specific restaurant or shop brand is printed, the "Memo" or "Remark" text IS the primary purchased item, dish, or stall name! Set "merchant" to this value, include it in "items", and classify it under "Food & Dining" (or appropriate category)!

3. FUEL / PETROL RECEIPTS (CRITICAL PRICE EXTRACTION):
   - Gas stations (Shell, Petronas, Caltex, Petron, BHPetrol) belong to category "Transport".
   - Extract purchased fuel line items into "items": e.g. "FuelSave 95", "RON95", "RON97", "Diesel", with litres and unit price per litre.
   - CRITICAL PRICE RULE: Petrol receipts frequently show an unsubsidized pump gross total alongside Government Subsidies, Loyalty Vouchers, and the actual user card debit.
   - "amount" MUST BE THE NET OUT-OF-POCKET AMOUNT CHARGED TO THE USER'S CARD OR PAID IN CASH! NEVER use the unsubsidized pump total when government subsidy or vouchers paid for part of the fuel!
   - Set "billAmount" (gross pump price), "discountAmount" (subsidy + voucher), and "dealsDescription".

4. NET AMOUNT PAID VS PRE-DISCOUNT BILL:
   - "amount" MUST ALWAYS BE THE ACTUAL NET OUT-OF-POCKET AMOUNT PAID.
   - NEVER record the pre-discount bill amount as the expense "amount".
   - Extract "billAmount", "discountAmount", and "dealsDescription".

5. CATEGORIES:
   - [Food & Dining, Transport, Shopping, Housing & Bills, Parents, Insurance, Entertainment, Health, Education, Sport, Gift, Other].
   - CRITICAL: category MUST be selected ONLY from this list. NEVER invent custom category names.
   - CATEGORY REASONING:
     * Food & Dining: All restaurants, kopitiams, food courts, F&B groups/companies, hawker stalls, cafes, bakeries, bars, catering, meals, drinks, desserts, and groceries MUST strictly be "Food & Dining". Any business with "F&B", "F and B", "Food & Beverage", "Catering", "Kopitiam", "Food Court", "Restoran", "Cafe", etc., is Food & Dining.
     * Transport: Petrol/fuel stations, transit, train, MRT, LRT, bus, taxi, Grab, tolls, parking, flights.
     * Shopping: Retail stores, clothing, supermarkets, marts, electronics, department stores.

Return JSON shape:
{
  "amount": number,
  "currency": "MYR",
  "currencySymbol": "RM",
  "currencyAmbiguous": false,
  "merchant": string,
  "category": string,
  "categoryConfidence": number,
  "date": "YYYY-MM-DD",
  "billAmount": number | null,
  "discountAmount": number | null,
  "dealsDescription": string | null,
  "items": [
    { "name": string, "quantity": number, "unitPrice": number, "amount": number }
  ],
  "paymentMethod": string | null,
  "ocrSummary": string,
  "notes": string
}`;

    const { parsedOcr, ocrFallbackNotice } = await runShortcutGeminiOcrWithFastFail({
      geminiKeys,
      onKeyFailure: reportGeminiKeyFailure,
      preferredModel,
      prompt,
      mimeType,
      cleanBase64,
      timeoutMs: 30000,
    });

    const ocrSummary =
      (typeof parsedOcr.ocrSummary === 'string' && parsedOcr.ocrSummary.trim()) ||
      (typeof parsedOcr.notes === 'string' && parsedOcr.notes.trim()) ||
      ocrFallbackNotice ||
      '';

    const candidateMerchantText = (
      (typeof parsedOcr.merchant === 'string' && parsedOcr.merchant.trim()) ||
      (typeof parsedOcr.store === 'string' && parsedOcr.store.trim()) ||
      (typeof parsedOcr.payee === 'string' && parsedOcr.payee.trim()) ||
      (typeof parsedOcr.recipient === 'string' && parsedOcr.recipient.trim()) ||
      (typeof parsedOcr.to === 'string' && parsedOcr.to.trim()) ||
      (typeof parsedOcr.seller === 'string' && parsedOcr.seller.trim()) ||
      (typeof parsedOcr.description === 'string' && parsedOcr.description.trim()) ||
      ''
    );

    const rawMerchant = sanitizeMerchantCandidate(
      candidateMerchantText,
      `${ocrSummary} ${typeof parsedOcr.notes === 'string' ? parsedOcr.notes : ''}`
    );

    let rawAmountValue = (
      parsedOcr.amount ??
      parsedOcr.total ??
      parsedOcr.totalAmount ??
      parsedOcr.paidAmount ??
      parsedOcr.grandTotal ??
      parsedOcr.price ??
      null
    );

    // If Gemini mistakenly returned pre-discount bill amount when discount was present, enforce net amount paid
    const discountAmount =
      typeof parsedOcr.discountAmount === 'number' && Number.isFinite(parsedOcr.discountAmount) && parsedOcr.discountAmount > 0
        ? Number(parsedOcr.discountAmount.toFixed(2))
        : null;
    const billAmount =
      typeof parsedOcr.billAmount === 'number' && Number.isFinite(parsedOcr.billAmount) && parsedOcr.billAmount > 0
        ? Number(parsedOcr.billAmount.toFixed(2))
        : null;
    const dealsDescription =
      typeof parsedOcr.dealsDescription === 'string' && parsedOcr.dealsDescription.trim()
        ? parsedOcr.dealsDescription.trim()
        : null;

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

    const itemsSum = items.length > 0 ? Number(items.reduce((s, it) => s + it.amount, 0).toFixed(2)) : 0;
    const grossCandidate = billAmount ?? (itemsSum > 0 ? itemsSum : null);

    if (
      grossCandidate != null &&
      discountAmount != null &&
      typeof rawAmountValue === 'number' &&
      Math.abs(rawAmountValue - grossCandidate) < 0.15 &&
      grossCandidate > discountAmount
    ) {
      rawAmountValue = Number((grossCandidate - discountAmount).toFixed(2));
    }

    let moneyRes = parseAmountAndCurrencyFromRawInput(
      rawAmountValue,
      parsedOcr.currencySymbol || parsedOcr.currency,
      'MYR'
    );

    if ((moneyRes.amount === null || moneyRes.amount <= 0) && grossCandidate != null) {
      const net = discountAmount && discountAmount > 0 && grossCandidate > discountAmount
        ? Number((grossCandidate - discountAmount).toFixed(2))
        : grossCandidate;
      moneyRes = {
        ...moneyRes,
        amount: net,
      };
    }

    // Align single item amount to net amount paid if discount/subsidy was applied
    if (items.length === 1 && moneyRes.amount != null && moneyRes.amount > 0 && items[0].amount > moneyRes.amount) {
      items[0].amount = moneyRes.amount;
    }

    // Fallback: If receipt items list is empty, generate single line item using merchant / description
    if (items.length === 0 && moneyRes.amount != null && moneyRes.amount > 0) {
      const fallbackItemName = rawMerchant || (typeof parsedOcr.description === 'string' && parsedOcr.description.trim() ? parsedOcr.description.trim() : '');
      if (fallbackItemName) {
        items.push({ name: fallbackItemName, amount: moneyRes.amount });
      }
    }

    const currencyAmbiguous = Boolean(parsedOcr.currencyAmbiguous) || moneyRes.currencyAmbiguous;
    const habitMatch = matchHabitMemory(rawMerchant || (items.length > 0 ? items[0].name : ''));
    const catRes = inferCategoryFromMerchant(
      rawMerchant || (items.length > 0 ? items[0].name : ''),
      typeof parsedOcr.category === 'string' ? parsedOcr.category : undefined
    );
    const hasExplicitCategory = typeof parsedOcr.category === 'string' && catRes.category !== 'Other';
    const catConfidence = typeof parsedOcr.categoryConfidence === 'number'
      ? parsedOcr.categoryConfidence
      : (hasExplicitCategory ? 0.95 : 0.5);
    const dateStr = sanitizeDate(parsedOcr.date) || today;

    let effectiveDescription = rawMerchant || (catRes.category && catRes.category !== 'Other' ? catRes.category : '');
    let effectiveCategory = catRes.category;
    let habitNotice = '';

    // If Gemini Vision did not classify category or returned Other, but we have an extracted merchant or item,
    // trigger Gemini AI text classification to intelligently reason over the merchant name
    if (
      (catRes.isUncertain || effectiveCategory === 'Other') &&
      effectiveDescription &&
      !habitMatch
    ) {
      try {
        const aiCategory = await classifyMerchantWithGemini(effectiveDescription);
        if (aiCategory && aiCategory !== 'Other') {
          effectiveCategory = aiCategory;
          catRes.category = aiCategory;
          catRes.isUncertain = false;
        }
      } catch (err) {
        console.warn('[Shortcut Ingest] Gemini classification fallback in Mode B skipped:', err);
      }
    }

    if (habitMatch) {
      effectiveCategory = habitMatch.resolvedCategory;
      if (habitMatch.isAlias) {
        effectiveDescription = habitMatch.resolvedDescription;
        habitNotice = `[习惯识别: 转给 ${habitMatch.matchedPattern} ➔ ${habitMatch.resolvedDescription}]`;
      }
      if (items.length === 0 && habitMatch.matchedItem.defaultItemName && moneyRes.amount != null && moneyRes.amount > 0) {
        items.push({ name: habitMatch.matchedItem.defaultItemName, amount: moneyRes.amount });
      }
    }

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
    if ((catRes.isUncertain && !habitMatch) || (typeof parsedOcr.categoryConfidence === 'number' && parsedOcr.categoryConfidence < 0.65)) {
      uncertainFields.push('category');
    }

    const fingerprint = computeShortcutDraftFingerprint({
      date: dateStr,
      currency: moneyRes.currency,
      amount: moneyRes.amount,
      merchantOrDescription: effectiveDescription || 'screenshot_draft',
    });

    const proposedActionLabel = moneyRes.amount != null && moneyRes.amount > 0
      ? `Save ${moneyRes.currency} ${moneyRes.amount.toFixed(2)} (${effectiveCategory})`
      : 'Review and Confirm Draft';

    // The client runs the same thinking-based receipt review as the camera flow
    // when the user opens this draft; OCR results alone are not an AI assessment.
    const assistantAdvice = '';

    const saved = saveShortcutQuickDraft({
      ownerEmail: userEmail || undefined,
      source: 'back_tap_screenshot',
      amount: moneyRes.amount,
      currency: moneyRes.currency,
      currencyAmbiguous,
      candidateCurrencies: moneyRes.candidateCurrencies,
      type: 'Expense',
      category: effectiveCategory,
      description: effectiveDescription,
      merchant: effectiveDescription || rawMerchant,
      date: dateStr,
      discountAmount,
      dealsDescription,
      billAmount,
      items: items.length > 0 ? items : undefined,
      ocrSummary,
      assistantAdvice,
      proposedActionLabel,
      notes: [
        '快捷指令截图草稿（待核对确认）',
        habitNotice,
        assistantAdvice,
        discountAmount && discountAmount > 0
          ? `[优惠抵扣: -${moneyRes.currency} ${discountAmount.toFixed(2)}${dealsDescription ? ` (${dealsDescription})` : ''}]`
          : '',
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

    const canAutoRecord =
      requestedAutoRecord &&
      moneyRes.amount !== null &&
      moneyRes.amount > 0 &&
      Boolean(effectiveDescription) &&
      missingFields.length === 0;

    const isExplicitSync = req.nextUrl.searchParams.get('sync') === 'true';

    let ledgerRes: {
      autoRecorded: boolean;
      duplicateSkipped: boolean;
      transactionId: string | null;
      sheetName: string | null;
      notificationTitle: string;
      notificationText: string;
    };

    if (canAutoRecord && !isExplicitSync) {
      const label = effectiveDescription || saved.category || '消费记录';
      const rawCurr = (saved.currency || 'MYR').toUpperCase().trim();
      const curr = rawCurr === 'RM' || !rawCurr ? 'MYR' : rawCurr;
      const targetDate = String(saved.date || '').trim().slice(0, 10);

      ledgerRes = {
        autoRecorded: true,
        duplicateSkipped: false,
        transactionId: saved.draftId,
        sheetName: targetDate.slice(0, 7),
        notificationTitle: `✅ 已记账 ${curr} ${saved.amount!.toFixed(2)} (${targetDate})`,
        notificationText: `✅ 已记账 [${targetDate}]：${curr} ${saved.amount!.toFixed(2)} · ${label} (${saved.category})`,
      };

      // Optimistic response: return immediately to iPhone, write to Google Sheets in background
      after(async () => {
        try {
          await recordShortcutDraftToLedger(saved, {
            fallbackNotice: ocrFallbackNotice,
            autoRecord: true,
            userEmail,
          });
        } catch (err) {
          console.error('[Shortcut Ingest] Background Google Sheets write error:', err);
        }
      });
    } else {
      ledgerRes = await recordShortcutDraftToLedger(saved, {
        fallbackNotice: ocrFallbackNotice,
        autoRecord: canAutoRecord,
        userEmail,
      });
    }

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
        redirectPath: ledgerRes.autoRecorded ? '/' : `/?quickDraft=${encodeURIComponent(saved.draftId)}`,
        openUrl: ledgerRes.autoRecorded ? `${origin}/` : `${origin}/?quickDraft=${encodeURIComponent(saved.draftId)}`,
        pwaUrl: `${origin}/`,
        missingFields: saved.missingFields,
        uncertainFields: saved.uncertainFields,
        assistantAdvice: saved.assistantAdvice,
        proposedActionLabel: saved.proposedActionLabel,
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
        openUrl: `${getRequestOrigin(req)}/?shortcutError=${encodeURIComponent('快捷指令服务器内部处理异常')}`,
      },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
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

    const { session } = await getValidGoogleSession(req);
    const callerEmail = (session?.email || '').trim().toLowerCase();
    if (!callerEmail) {
      return NextResponse.json(
        { success: false, draft: null, recentAutoRecorded: [] },
        { status: 200, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    void setActiveShortcutOwner(callerEmail, req.headers.get('user-agent')).catch(() => {});

    const id = (searchParams.get('id') || 'latest').trim();
    const draft = claimShortcutDraft(id, Date.now(), false, callerEmail);
    const recentAutoRecorded = await getRecentShortcutAutoRecorded(callerEmail);

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

