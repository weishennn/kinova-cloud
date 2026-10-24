import { NextRequest, NextResponse } from 'next/server';
import { getLocalDateString, normalizeDateString } from '@/lib/date-helper';
import { normalizeToCanonicalCategory } from '@/lib/canonical-categories';
import { getValidGoogleSession } from '@/lib/google-auth';
import { recordUserAiCall } from '@/lib/admin-registry';
import { getLoadBalancedGeminiKeys, reportGeminiKeyFailure } from '@/lib/gemini-key-pool';

const VALID_CURRENCIES = new Set(['MYR', 'USD', 'SGD', 'EUR', 'GBP', 'JPY', 'AUD', 'IDR', 'THB', 'CNY', 'HKD']);

function sanitizeDate(value: unknown, maxDateStr?: string): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = normalizeDateString(trimmed);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
  if (maxDateStr && /^\d{4}-\d{2}-\d{2}$/.test(maxDateStr) && normalized > maxDateStr) {
    return maxDateStr;
  }
  return normalized;
}

interface RawKinovaReceiptItem {
  name: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  brand?: string;
  productType?: string;
  qtyReconciled?: string;
  category?: string;
}

function reconcileKinovaReceiptItems(
  rawItems: RawKinovaReceiptItem[],
  expectedSubtotal: number | null,
): RawKinovaReceiptItem[] {
  if (!rawItems.length) return [];

  const prepared = rawItems.map((raw) => {
    let name = raw.name.trim();
    let qty = Math.max(1, Math.round(raw.quantity || 1));
    const prefixMatch = name.match(/^(\d{1,2})\s*[xX×]\s+(.+)$/) || name.match(/^[Qq]ty\s*:?\s*(\d{1,2})\s+(.+)$/);
    if (prefixMatch) {
      const parsedQty = Number(prefixMatch[1]);
      if (qty === 1 && parsedQty > 1 && parsedQty <= 50) {
        qty = parsedQty;
      }
      name = prefixMatch[2].trim();
    }
    const rawUnit = raw.unitPrice > 0 ? Number(raw.unitPrice.toFixed(2)) : 0;
    let rawAmt = raw.amount > 0 ? Number(raw.amount.toFixed(2)) : 0;
    if (rawAmt <= 0 && rawUnit > 0) {
      rawAmt = Number((rawUnit * qty).toFixed(2));
    }
    return {
      ...raw,
      name,
      quantity: qty,
      amount: rawAmt,
      unitPrice: rawUnit > 0 ? rawUnit : (qty > 1 ? Number((rawAmt / qty).toFixed(2)) : rawAmt),
      qtyReconciled: 'as_is',
    };
  });

  if (expectedSubtotal == null || expectedSubtotal <= 0) {
    return prepared;
  }

  const expectedMinor = Math.round(expectedSubtotal * 100);
  const multiIndices = prepared
    .map((it, idx) => (it.quantity > 1 && it.amount > 0 ? idx : -1))
    .filter((idx) => idx >= 0);

  if (multiIndices.length === 0 || multiIndices.length > 10) {
    return prepared;
  }

  const fixedMinor = prepared.reduce(
    (sum, it, idx) => (multiIndices.includes(idx) ? sum : sum + Math.round(it.amount * 100)),
    0,
  );

  const candidatesPerMulti = multiIndices.map((idx) => {
    const it = prepared[idx];
    const asIsMinor = Math.round(it.amount * 100);
    const multMinor = Math.round(it.amount * it.quantity * 100);
    const divMinor = Math.round((it.amount / it.quantity) * 100);
    return [
      { mode: 'as_is', minor: asIsMinor },
      { mode: 'multiplied_unit_price', minor: multMinor },
      { mode: 'divided_overmultiplied_total', minor: divMinor },
    ];
  });

  const defaultSumMinor = fixedMinor + candidatesPerMulti.reduce((s, c) => s + c[0].minor, 0);
  const defaultDiff = Math.abs(defaultSumMinor - expectedMinor);

  if (defaultDiff <= 15) {
    return prepared;
  }

  let bestDiff = defaultDiff;
  let bestCombo = candidatesPerMulti.map(() => 'as_is');
  let bestChanges = 0;

  const search = (pos: number, runningMinor: number, combo: string[], changes: number) => {
    if (pos === multiIndices.length) {
      const diff = Math.abs(runningMinor - expectedMinor);
      if (diff < bestDiff - 5 || (Math.abs(diff - bestDiff) <= 5 && changes < bestChanges)) {
        bestDiff = diff;
        bestCombo = [...combo];
        bestChanges = changes;
      }
      return;
    }
    for (const cand of candidatesPerMulti[pos]) {
      combo.push(cand.mode);
      search(pos + 1, runningMinor + cand.minor, combo, changes + (cand.mode === 'as_is' ? 0 : 1));
      combo.pop();
    }
  };

  search(0, fixedMinor, [], 0);

  const toleranceMinor = Math.max(25, Math.round(expectedMinor * 0.02));
  if (bestDiff <= toleranceMinor && bestDiff < defaultDiff * 0.5) {
    multiIndices.forEach((itemIdx, mPos) => {
      const mode = bestCombo[mPos];
      const it = prepared[itemIdx];
      if (mode === 'multiplied_unit_price') {
        it.unitPrice = it.amount;
        it.amount = Number((it.amount * it.quantity).toFixed(2));
        it.qtyReconciled = mode;
      } else if (mode === 'divided_overmultiplied_total') {
        it.amount = Number((it.amount / it.quantity).toFixed(2));
        it.unitPrice = Number((it.amount / it.quantity).toFixed(2));
        it.qtyReconciled = mode;
      }
    });
  }

  return prepared;
}

export async function POST(req: NextRequest) {
  try {
    const { session } = await getValidGoogleSession(req);
    if (!session) {
      return NextResponse.json(
        { success: false, error: 'Please sign in with your Google Account to use AI receipt OCR.' },
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
    const imageBase64 = typeof body?.imageBase64 === 'string' ? body.imageBase64 : '';
    const mimeType = typeof body?.mimeType === 'string' ? body.mimeType : 'image/jpeg';
    const today = sanitizeDate(body?.today) || getLocalDateString();

    if (!imageBase64 || imageBase64.length > 8_000_000 || !/^image\/(jpeg|png|webp|gif)$/i.test(mimeType)) {
      return NextResponse.json({ success: false, error: 'A valid JPEG, PNG, or WebP receipt image is required' }, { status: 400 });
    }

    const apiKeys = getLoadBalancedGeminiKeys();
    if (apiKeys.length === 0) {
      return NextResponse.json({ success: false, error: 'GEMINI_API_KEY is not configured in environment' }, { status: 500 });
    }

    const preferredModel = (process.env.GEMINI_OCR_MODEL || process.env.GEMINI_MODEL || 'gemini-flash-latest').trim();
    const models = [preferredModel, 'gemini-flash-latest', 'gemini-3.8-flash', 'gemini-2.5-flash'].filter((v, i, a) => Boolean(v) && a.indexOf(v) === i);

    const prompt = `You are an intelligent financial OCR and receipt analysis AI.
Analyze this receipt or payment confirmation screenshot and return ONLY valid JSON.
Today is ${today}.

CRITICAL INSTRUCTIONS:
1. NOTIFICATION BANNER / UI CHROME FILTERING:
   - Screenshots often have mobile UI chrome: iOS status bar (time, 5G, battery), Dynamic Island, or NOTIFICATION BANNERS at the top (e.g. from "Kinova Automation", "Shortcuts", "Automation", "Screenshot", "now", notification icons).
   - NEVER EVER use "Kinova Automation", "Kinova", "Shortcuts", or any system app/shortcut name as the merchant, store, or item name!
   - NEVER use generic screen status titles like "Payment successful", "Payment success", "Order details", or "Order ID" as the merchant name!
   - Look UNDERNEATH or PAST any notification banner to find the ACTUAL store/merchant (e.g. Shell, Petronas, Four Beans 四夕豆花, etc.).

2. APP HEADER & WEBH5 SHOP NAME EXTRACTION:
   - On payment success screens (e.g. Touch 'n Go, GrabPay, WeChat mini-programs, food order webviews), the shop name is often located at the top navigation bar next to a close button '✕' or '<' (e.g. '✕ Four Beans 四夕豆花 - Taman Me...').
   - You MUST extract the merchant name from this top bar if it is not inside the card body!
   - Clean branch suffixes or trailing truncation dots: e.g. "Four Beans 四夕豆花".
   - FOOD INFERENCE: If the payment confirmation does not list individual dishes (e.g. only shows Order ID, Bill amount, Deals and offers), extract the signature food from the merchant name into 'items' (e.g. for 'Four Beans 四夕豆花', extract { "name": "四夕豆花 / 甜品", "quantity": 1, "unitPrice": 18.74, "amount": 18.74, "category": "Food & Dining" }).

2.5. E-WALLET & BANK TRANSFER CONFIRMATIONS (ShopeePay, Touch 'n Go, GrabPay, MAE, DuitNow QR):
   - PAYMENT METHOD IS NOT THE MERCHANT: "ShopeePay", "ShopeePay Balance", "Touch 'n Go eWallet", "eWallet Balance", "DuitNow QR", "MAE" are payment channels/methods, NEVER the merchant/store name!
   - MERCHANT LOCATION IS NOT THE STORE NAME: "Merchant Location: AMPANG", "Location: ...", or city names are locations, NOT the merchant name! NEVER invent generic names like "Food Stall (Ampang)" or "Shop (Location)"!
   - EXTRACT "MEMO" / "REMARK" / "RECIPIENT REFERENCE": Look specifically for "Memo", "Remark", "Recipient Reference", "Payment Details", or "Note" (e.g. "Memo: Chicken rice"). When no separate shop brand is shown, the Memo/Remark text IS the primary dish/food or stall name! Extract it as "description" and include it in "items": [{ "name": "Chicken rice", "quantity": 1, "unitPrice": 14.00, "amount": 14.00, "category": "Food & Dining" }].

3. FUEL / PETROL RECEIPTS (CRITICAL PRICE EXTRACTION):
   - Gas stations (Shell, Petronas, Caltex, Petron, BHPetrol) belong to category "Transport".
   - Extract purchased fuel line items into "items": e.g. "FuelSave 95", "RON95", "RON97", "Diesel", with litres and unit price per litre.
   - CRITICAL PRICE RULE: Petrol receipts frequently show an unsubsidized pump gross total (e.g. "Total Paid RM 202.82") alongside Government Subsidies (e.g. "Subsidy (BUDI MADANI) RM 115.46"), Loyalty Vouchers (e.g. "Loyalty Voucher RM 5.00"), and the actual user card debit (e.g. "VISA Shell App - RHB Visa Debit RM 82.36").
   - "amount" MUST BE THE NET OUT-OF-POCKET AMOUNT CHARGED TO THE USER'S CARD OR PAID IN CASH (e.g. 82.36)! NEVER use the unsubsidized pump total (202.82) when government subsidy or vouchers paid for part of the fuel!
   - Set "billAmount": 202.82 (gross pump price), "discountAmount": 120.46 (115.46 subsidy + 5.00 voucher), and "dealsDescription": "Subsidy (BUDI MADANI) RM 115.46 + Loyalty Voucher RM 5.00".

4. NET AMOUNT PAID VS PRE-DISCOUNT BILL:
   - "amount" MUST ALWAYS BE THE ACTUAL NET OUT-OF-POCKET AMOUNT PAID (e.g. 18.74 for Four Beans, 82.36 for Shell).
   - NEVER record the pre-discount bill amount as the expense "amount".
   - Extract "billAmount" (e.g. 22.05), "discountAmount" (e.g. 3.31), and "dealsDescription" (e.g. "Deals and offers -RM3.31 (10% off bill -2.21, 5% off bill -1.10)").

5. DATE RECOGNITION:
   - Malaysian receipts standardly use DD/MM/YYYY or DD-MM-YYYY (e.g. "05/10/2026" is 5th October 2026).
   - If a 2-digit year is printed (e.g. "05/10/26"), expand to 2026.
   - NEVER confuse transaction date with expiry dates ("EXP", "Best Before"). Fallback to ${today} if missing.

6. TAXES & ROUNDING:
   - Taxes: array of ALL tax and service charge lines printed, e.g. [{"label": "Service Charge 10%", "rate": 10, "amount": 3.02}, {"label": "SST 6%", "rate": 6, "amount": 1.81}].
   - CRITICAL FOR ROUNDING: NEVER include "Rounding", "Rounding Adjustment", "Pelarasan", "Pelarasan Genapan", or "Genap" in taxes or taxAmount! Rounding (±0.01 to ±0.05) is NOT a tax!

7. ITEMS:
   - Array of every purchased line with { "name": string, "quantity": number, "unitPrice": number, "amount": number, "brand": string|null, "productType": string|null, "category": string }.
   - If "2 Laksa 18.00" is already the line total, set quantity: 2, unitPrice: 9.00, amount: 18.00 (do NOT multiply again).
   - "amount" MUST ALWAYS be pre-tax line total. Exclude subtotal, tax, service charge, roundings, discounts, or change rows.

8. CATEGORIES (STRICT PREDEFINED LIST):
   - "category" and item "category" MUST be chosen ONLY from:
     [Food & Dining, Transport, Shopping, Housing & Bills, Parents, Insurance, Entertainment, Health, Education, Sport, Gift, Other].
   - NEVER invent custom category names (e.g. do NOT use "Groceries", "Beverages", "Dining Out", "Electronics", "Utilities", "Coffee"). Map them to the list above!

Return JSON shape:
{
  "amount": number,
  "currency": "MYR",
  "category": string,
  "description": string,
  "date": "YYYY-MM-DD",
  "subtotal": number | null,
  "billAmount": number | null,
  "discountAmount": number | null,
  "dealsDescription": string | null,
  "taxes": [{"label": string, "rate": number | null, "amount": number | null}],
  "taxAmount": number | null,
  "taxRate": number | null,
  "taxIncluded": boolean,
  "taxLabel": string,
  "items": [{"name": string, "quantity": number, "unitPrice": number, "amount": number, "brand": string | null, "productType": string | null, "category": string}],
  "notes": string
}`;

    for (const model of models) {
      let res: Response | null = null;
      let shouldTryNextModel = false;

      for (let keyIdx = 0; keyIdx < apiKeys.length; keyIdx += 1) {
        const apiKey = apiKeys[keyIdx];
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify({
            contents: [{
              role: 'user',
              parts: [
                { text: prompt },
                { inline_data: { mime_type: mimeType, data: imageBase64 } },
              ],
            }],
            generationConfig: {
              responseMimeType: 'application/json',
              temperature: 0.1,
              maxOutputTokens: 4096,
            },
          }),
          signal: AbortSignal.timeout(20000),
        });

        // Transient 503 / 500 handling: 1 quick retry with backoff if server is temporarily overloaded
        if (res && (res.status === 503 || res.status === 500)) {
          await new Promise((resolve) => setTimeout(resolve, 800));
          try {
            res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey,
              },
              body: JSON.stringify({
                contents: [{
                  role: 'user',
                  parts: [
                    { text: prompt },
                    { inline_data: { mime_type: mimeType, data: imageBase64 } },
                  ],
                }],
                generationConfig: {
                  responseMimeType: 'application/json',
                  temperature: 0.1,
                  maxOutputTokens: 4096,
                },
              }),
              signal: AbortSignal.timeout(20000),
            });
          } catch {
            // Keep original res
          }
        }

        if (res.ok) break;

        if (res.status === 429 || res.status === 401 || res.status === 403 || res.status >= 500) {
          reportGeminiKeyFailure(apiKey, res.status);
          if (keyIdx + 1 < apiKeys.length) {
            continue; // Failover to next configured API key
          }
        }
        if ((res.status === 404 || res.status >= 500) && model !== models[models.length - 1]) {
          shouldTryNextModel = true;
          break;
        }
        break;
      }

      if (shouldTryNextModel) continue;

      if (!res || !res.ok) {
        const status = res?.status ?? 502;
        const userMessage = status === 429
          ? 'Gemini quota is temporarily exhausted across all configured keys. Try again in a moment.'
          : status === 503
            ? 'Gemini 服务暂时繁忙 (HTTP 503 Overloaded)，已自动重试及切换备用模型，请稍等 2-3 秒后再试。'
            : status === 401 || status === 403
              ? 'Gemini rejected the API key. Check GEMINI_API_KEY in environment.'
              : `Gemini OCR failed (${status}). Please try a clearer receipt image.`;
        return NextResponse.json({ success: false, error: userMessage }, { status: 502 });
      }

      const responseData = await res.json();
      const rawJson = responseData.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawJson) return NextResponse.json({ success: false, error: 'Gemini OCR returned no text result' }, { status: 502 });

      try {
        let cleanJson = rawJson.trim();
        const blockMatch = cleanJson.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (blockMatch) {
          cleanJson = blockMatch[1].trim();
        }

        const parsed = JSON.parse(cleanJson) as Record<string, unknown>;

        let amount = typeof parsed.amount === 'number' && Number.isFinite(parsed.amount) && parsed.amount > 0
          ? Number(parsed.amount.toFixed(2))
          : null;
        let subtotal = typeof parsed.subtotal === 'number' && Number.isFinite(parsed.subtotal) && parsed.subtotal > 0
          ? Number(parsed.subtotal.toFixed(2))
          : null;
        const rawTaxAmtForReconcile = typeof parsed.taxAmount === 'number' && Number.isFinite(parsed.taxAmount) && parsed.taxAmount > 0
          ? Number(parsed.taxAmount.toFixed(2))
          : 0;
        const expectedItemsSubtotal = subtotal ?? (amount != null && amount > rawTaxAmtForReconcile ? Number((amount - rawTaxAmtForReconcile).toFixed(2)) : null);

        const rawParsedItems: RawKinovaReceiptItem[] = Array.isArray(parsed.items)
          ? parsed.items
            .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
            .map((item) => {
              const qty = typeof item.quantity === 'number' && Number.isFinite(item.quantity) && item.quantity >= 1
                ? Math.round(item.quantity)
                : 1;
              const unitPrice = typeof item.unitPrice === 'number' && Number.isFinite(item.unitPrice) && item.unitPrice > 0
                ? Number(item.unitPrice.toFixed(2))
                : 0;
              const amt = typeof item.amount === 'number' && Number.isFinite(item.amount) && item.amount > 0
                ? Number(item.amount.toFixed(2))
                : (unitPrice > 0 ? Number((unitPrice * qty).toFixed(2)) : 0);
              return {
                name: typeof item.name === 'string' ? item.name.trim() : '',
                quantity: qty,
                unitPrice,
                amount: amt,
                brand: typeof item.brand === 'string' ? item.brand.trim() : undefined,
                productType: typeof item.productType === 'string' ? item.productType.trim() : undefined,
                category: typeof item.category === 'string'
                  ? normalizeToCanonicalCategory(item.category, 'Expense', typeof item.name === 'string' ? item.name : undefined)
                  : undefined,
              };
            })
            .filter((item) => item.name && item.amount > 0)
            .slice(0, 40)
          : [];

        const items = reconcileKinovaReceiptItems(rawParsedItems, expectedItemsSubtotal);
        const itemsSum = Number(items.reduce((sum, it) => sum + it.amount, 0).toFixed(2));

        const discountAmount =
          typeof parsed.discountAmount === 'number' && Number.isFinite(parsed.discountAmount) && parsed.discountAmount > 0
            ? Number(parsed.discountAmount.toFixed(2))
            : null;
        let billAmount =
          typeof parsed.billAmount === 'number' && Number.isFinite(parsed.billAmount) && parsed.billAmount > 0
            ? Number(parsed.billAmount.toFixed(2))
            : null;
        const dealsDescription =
          typeof parsed.dealsDescription === 'string' && parsed.dealsDescription.trim()
            ? parsed.dealsDescription.trim()
            : null;

        // If amount was not extracted, fallback to itemsSum or billAmount
        if (amount == null) {
          if (billAmount != null && discountAmount != null && billAmount > discountAmount) {
            amount = Number((billAmount - discountAmount).toFixed(2));
          } else if (items.length > 0) {
            amount = discountAmount && discountAmount > 0 && itemsSum > discountAmount
              ? Number((itemsSum - discountAmount).toFixed(2))
              : itemsSum;
          }
        }

        // If amount equals the pre-discount gross (billAmount or itemsSum), subtract discountAmount to get true net payment
        const grossCandidate = billAmount ?? (itemsSum > 0 ? itemsSum : null);
        if (
          grossCandidate != null &&
          discountAmount != null &&
          amount != null &&
          Math.abs(amount - grossCandidate) < 0.15 &&
          grossCandidate > discountAmount
        ) {
          amount = Number((grossCandidate - discountAmount).toFixed(2));
        }

        // When there is only 1 main item and a discount/subsidy was applied, align item.amount to net paid
        if (items.length === 1 && amount != null && amount > 0 && items[0].amount > amount) {
          items[0].amount = amount;
          if (items[0].quantity > 0) {
            items[0].unitPrice = Number((amount / items[0].quantity).toFixed(2));
          }
        }

        const currency = typeof parsed.currency === 'string' && VALID_CURRENCIES.has(parsed.currency.toUpperCase())
          ? parsed.currency.toUpperCase()
          : 'MYR';

        const date = sanitizeDate(parsed.date, today) || today;

        // Sanitize description: NEVER allow "Kinova Automation" or generic status phrases
        let description = typeof parsed.description === 'string' && parsed.description.trim()
          ? parsed.description.trim()
          : (typeof parsed.merchant === 'string' && parsed.merchant.trim() ? parsed.merchant.trim() : '');
        if (/^(?:kinova(?:\s*automation)?|shortcuts?|screenshot|automation|now|payment\s*successful?|payment\s*success|payment\s*completed?|transaction\s*successful?|transaction\s*details|order\s*details|order\s*id(?::\s*[A-Z0-9_-]+)?|successful|receipt|food\s*stall(?:\s*\([^)]*\))?|food\s*court|hawker\s*stall|shopeepay(?:\s*balance)?|ewallet(?:\s*balance)?)$/i.test(description)) {
          description = '';
        }

        // If description is empty or generic, check parsed memo or notes
        if (!description && typeof parsed.memo === 'string' && parsed.memo.trim()) {
          description = parsed.memo.trim();
        }
        if (!description && typeof parsed.notes === 'string') {
          const memoM = parsed.notes.match(/\b(?:memo|remark|recipient\s*reference)\s*[:：]?\s*([A-Za-z0-9\u4e00-\u9fa5\s&'/+-]+?)(?=\s*(?:Order\s*SN|Transaction\s*SN|Payment\s*Method|Merchant\s*Location|RM|\d{1,2}:\d{2}|$|\n))/i);
          if (memoM && memoM[1]) {
            description = memoM[1].trim();
          }
        }

        // Clean trailing truncated dots (e.g. "Four Beans 四夕豆花 - Taman Me...")
        description = description.replace(/\s*-\s*[A-Za-z0-9\s]*\.\.\.$/, '').trim();

        // Check if items or context reveals the true merchant if description was empty/filtered
        if (!description && items.length > 0) {
          const firstItem = items[0].name;
          if (/fuelsave|ron95|ron97|diesel/i.test(firstItem)) {
            description = 'Shell';
          } else {
            description = items.map((i) => i.name).slice(0, 2).join(', ');
          }
        }
        if (!description) {
          description = 'Receipt Expense';
        }

        // If items are empty, but merchant is a food establishment or specific dish/stall, add signature food item
        if (items.length === 0 && amount != null && amount > 0) {
          if (/豆花|four\s*beans/i.test(description)) {
            items.push({
              name: '四夕豆花 / 甜品',
              quantity: 1,
              unitPrice: amount,
              amount,
              category: 'Food & Dining',
            });
          } else if (description && description !== 'Receipt Expense' && !/^(?:shell|petronas|caltex|bhpetrol)/i.test(description)) {
            items.push({
              name: description,
              quantity: 1,
              unitPrice: amount,
              amount,
              category: 'Food & Dining',
            });
          }
        }

        let category = typeof parsed.category === 'string' && parsed.category.trim()
          ? normalizeToCanonicalCategory(parsed.category, 'Expense', description)
          : '';
        if (
          /shell|petronas|caltex|bhpetrol|petron|fuelsave|ron95|ron97|diesel/i.test(description) ||
          items.some((it) => /fuelsave|ron95|ron97|diesel/i.test(it.name))
        ) {
          category = 'Transport';
        } else if (/four\s*beans|豆花/i.test(description)) {
          category = 'Food & Dining';
        }
        if (!category) {
          category = normalizeToCanonicalCategory('', 'Expense', description);
        }

        if (discountAmount != null && discountAmount > 0 && amount != null) {
          if (subtotal != null && subtotal > amount) {
            if (billAmount == null) billAmount = subtotal;
            subtotal = rawTaxAmtForReconcile > 0 && amount > rawTaxAmtForReconcile
              ? Number((amount - rawTaxAmtForReconcile).toFixed(2))
              : amount;
          }
        }

        if (subtotal == null && itemsSum > 0 && amount != null && amount >= itemsSum) {
          subtotal = itemsSum;
        }

        // Parse multi-tax array if returned by Gemini (e.g. Service Charge 10% + SST 6%)
        // Strictly exclude Rounding / Pelarasan Genapan lines
        const ROUNDING_LABEL_REGEX = /rounding|round|pelarasan|genap/i;
        const rawTaxes = Array.isArray(parsed.taxes)
          ? parsed.taxes
              .filter((t): t is Record<string, unknown> => Boolean(t) && typeof t === 'object')
              .map((t) => {
                let r = typeof t.rate === 'number' && Number.isFinite(t.rate) && t.rate >= 0 ? t.rate : null;
                if (r !== null && r > 0 && r <= 1) r = Number((r * 100).toFixed(1));
                const amt = typeof t.amount === 'number' && Number.isFinite(t.amount) && t.amount >= 0 ? Number(t.amount.toFixed(2)) : null;
                const lbl = typeof t.label === 'string' ? t.label.trim() : '';
                return { label: lbl, rate: r, amount: amt };
              })
              .filter((t) => !ROUNDING_LABEL_REGEX.test(t.label))
              .filter((t) => t.label || (t.rate != null && t.rate > 0) || (t.amount != null && t.amount > 0))
          : [];

        let taxAmount = typeof parsed.taxAmount === 'number' && Number.isFinite(parsed.taxAmount) && parsed.taxAmount >= 0 ? Number(parsed.taxAmount.toFixed(2)) : null;
        let taxRate = typeof parsed.taxRate === 'number' && Number.isFinite(parsed.taxRate) && parsed.taxRate >= 0 ? parsed.taxRate : null;
        if (taxRate !== null && taxRate > 0 && taxRate <= 1) {
          taxRate = Number((taxRate * 100).toFixed(1));
        }
        let taxLabel = typeof parsed.taxLabel === 'string' && parsed.taxLabel.trim() ? parsed.taxLabel.trim() : undefined;

        if (taxLabel && ROUNDING_LABEL_REGEX.test(taxLabel)) {
          taxLabel = undefined;
          taxAmount = null;
          taxRate = null;
        }

        if (rawTaxes.length > 0) {
          const sumRates = Number(rawTaxes.reduce((s, t) => s + (t.rate || 0), 0).toFixed(2));
          const sumAmts = Number(rawTaxes.reduce((s, t) => s + (t.amount || 0), 0).toFixed(2));
          const combinedLabels = rawTaxes
            .map((t) => {
              if (t.label && t.rate != null && !t.label.includes('%')) return `${t.label} ${t.rate}%`;
              if (t.label) return t.label;
              if (t.rate != null) return `${t.rate}%`;
              return '';
            })
            .filter(Boolean)
            .join(' + ');

          if (sumRates > 0 && (taxRate == null || taxRate < sumRates)) {
            taxRate = sumRates;
          }
          if (sumAmts > 0 && (taxAmount == null || taxAmount < sumAmts)) {
            taxAmount = sumAmts;
          }
          if (combinedLabels && (rawTaxes.length > 1 || !taxLabel)) {
            taxLabel = combinedLabels;
          }
        }

        // Mathematical cross-check: if the receipt has a subtotal (or itemsSum) and a larger final amount,
        // ensure taxRate and taxAmount reflect the FULL surcharge (e.g. 10% Service Charge + 6% SST = 16%),
        // even if Gemini only recognized one of the two taxes (e.g. 6%)!
        // Differences <= 0.05 are purely rounding adjustments (1 to 5 sen in Malaysia), NOT tax!
        // IMPORTANT: Never infer tax if the difference is caused by discounts/deals!
        const referenceBase = itemsSum > 0 ? itemsSum : subtotal;
        if (
          (!discountAmount || discountAmount <= 0) &&
          referenceBase != null && referenceBase > 0 && amount != null && amount > referenceBase + 0.05
        ) {
          const impliedTaxAmount = Number((amount - referenceBase).toFixed(2));
          const impliedRatePct = (impliedTaxAmount / referenceBase) * 100;

          // Only infer tax if implied rate is at least 3% (e.g. SST 6%, 8%, Service Charge 10%, 16%)
          if (impliedRatePct >= 3 && impliedRatePct <= 35) {
            const COMMON_COMBINED_RATES = [6, 8, 10, 16, 18, 7, 9, 15, 17, 19];
            let snappedRate = Number(impliedRatePct.toFixed(2));
            for (const std of COMMON_COMBINED_RATES) {
              if (Math.abs(impliedRatePct - std) <= 0.65) {
                snappedRate = std;
                break;
              }
            }

            const expectedTotalWithCurrentRate = taxRate != null
              ? referenceBase * (1 + taxRate / 100)
              : referenceBase;
            const rateMismatch = taxRate == null || Math.abs(expectedTotalWithCurrentRate - amount) > 0.25;

            if (rateMismatch) {
              taxRate = snappedRate;
              taxAmount = impliedTaxAmount;
              subtotal = referenceBase;
              if (snappedRate === 16 && (!taxLabel || !/10%|service|svc/i.test(taxLabel))) {
                taxLabel = 'Service Charge 10% + SST 6%';
              } else if (snappedRate === 18 && (!taxLabel || !/10%|service|svc/i.test(taxLabel))) {
                taxLabel = 'Service Charge 10% + SST 8%';
              }
            } else if (taxAmount == null || Math.abs(taxAmount - impliedTaxAmount) > 0.25) {
              taxAmount = impliedTaxAmount;
              subtotal = referenceBase;
            }
          }
        }

        const taxIncluded = typeof parsed.taxIncluded === 'boolean' ? parsed.taxIncluded : undefined;

        if (!amount) {
          return NextResponse.json({ success: false, error: 'Could not detect the receipt total amount. Please enter manually.' }, { status: 422 });
        }

        let finalNotes = typeof parsed.notes === 'string' ? parsed.notes.trim() : '';
        if (discountAmount && discountAmount > 0) {
          const discountNote = `[优惠抵扣: -${currency} ${discountAmount.toFixed(2)}${dealsDescription ? ` (${dealsDescription})` : ''}]`;
          if (!finalNotes.includes(discountNote)) {
            finalNotes = finalNotes ? `${discountNote} · ${finalNotes}` : discountNote;
          }
        }

        return NextResponse.json({
          success: true,
          data: {
            intent: 'transaction',
            confidence: 0.85,
            data: {
              amount,
              currency,
              type: 'Expense',
              category,
              description,
              date,
              subtotal,
              billAmount,
              discountAmount,
              dealsDescription,
              taxAmount,
              taxRate,
              taxIncluded,
              taxLabel,
              taxes: rawTaxes.length > 0 ? rawTaxes : undefined,
              notes: finalNotes || (description ? `Scanned from ${description}` : 'Scanned receipt'),
            },
            items,
          },
          model,
        });
      } catch {
        return NextResponse.json({ success: false, error: 'Gemini OCR returned invalid JSON' }, { status: 502 });
      }
    }

    return NextResponse.json({ success: false, error: 'No OCR model was available' }, { status: 502 });
  } catch {
    return NextResponse.json({ success: false, error: 'Receipt OCR failed' }, { status: 500 });
  }
}
