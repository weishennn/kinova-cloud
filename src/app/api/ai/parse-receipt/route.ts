import { NextRequest, NextResponse } from 'next/server';
import { getLocalDateString, parseLocalDate } from '@/lib/date-helper';
import { getValidGoogleSession } from '@/lib/google-auth';
import { recordUserAiCall } from '@/lib/admin-registry';
import { getLoadBalancedGeminiKeys, reportGeminiKeyFailure } from '@/lib/gemini-key-pool';

const VALID_CURRENCIES = new Set(['MYR', 'USD', 'SGD', 'EUR', 'GBP', 'JPY', 'AUD', 'IDR', 'THB', 'CNY', 'HKD']);

function sanitizeDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const parsed = parseLocalDate(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return getLocalDateString(parsed);
}

interface RawKinovaReceiptItem {
  name: string;
  quantity: number;
  unitPrice: number;
  amount: number;
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

    const preferredModel = process.env.GEMINI_OCR_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const models = [preferredModel, 'gemini-3.5-flash-lite'].filter((v, i, a) => a.indexOf(v) === i);

    const prompt = `Read this receipt image and return ONLY valid JSON for a personal finance app. No markdown code blocks, just raw JSON.
Today is ${today}.
Extract:
- final amount paid (number, e.g. 35.00)
- currency (e.g. MYR, USD, SGD, CNY, AUD)
- merchant name or useful description (e.g. "Restoran Pelita")
- likely expense category (allowed: Food & Dining, Transport, Shopping, Housing & Bills, Parents, Insurance, Entertainment, Health, Education, Other)
- receipt date (YYYY-MM-DD; if not found or unreadable, use ${today})
- subtotal before tax/service charge if printed
- taxes: array of ALL tax and service charge lines printed on the receipt, e.g. [{"label": "Service Charge 10%", "rate": 10, "amount": 3.02}, {"label": "SST 6%", "rate": 6, "amount": 1.81}]. In Malaysia, receipts very commonly have BOTH Service Charge (10%) AND SST/Service Tax (6% or 8%). You MUST include every single one in this array!
- taxAmount: total combined numeric amount of ALL taxes + service charges (e.g. 3.02 + 1.81 = 4.83)
- taxRate: total combined numeric percentage of ALL taxes + service charges (e.g. if Service Charge is 10% and SST is 6%, taxRate MUST be 16; if 10% + 8%, taxRate MUST be 18)
- taxIncluded (boolean)
- taxLabel: combined label of all taxes/charges (e.g. "Service Charge 10% + SST 6%")
- items: array of purchased products/foods with { "name": string, "quantity": number, "unitPrice": number, "amount": number, "category": string }.
  IMPORTANT FOR QUANTITY > 1 (e.g. "2 Laksa 18.00" vs "2 Laksa 9.00"):
  Check the receipt's subtotal / total math!
  - If the receipt prints "2 Laksa 18.00" where 18.00 is ALREADY the total for 2 plates, set "quantity": 2, "unitPrice": 9.00, "amount": 18.00 (do NOT multiply 18.00 by 2 again).
  - If the receipt prints "2 Laksa 9.00" where 9.00 is a SINGLE plate price and the receipt subtotal/total actually charges 2 * 9.00 = 18.00, set "quantity": 2, "unitPrice": 9.00, "amount": 18.00!
  "amount" MUST ALWAYS be the pre-tax line total for all quantity units combined (quantity * unitPrice). Exclude subtotal, tax, service charge, roundings, discounts, or change rows.
- notes: any short helpful summary.

If the amount is unreadable, calculate from the sum of items plus taxes. If no items or amount are readable, set amount to null.
Shape: {"amount": number|null, "currency": string, "category": string, "description": string, "date": "YYYY-MM-DD", "subtotal": number|null, "taxes": [{"label": string, "rate": number|null, "amount": number|null}], "taxAmount": number|null, "taxRate": number|null, "taxIncluded": boolean, "taxLabel": string, "items": [{"name": string, "quantity": number, "unitPrice": number, "amount": number, "category": string}], "notes": string}`;

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
              thinkingConfig: {
                thinkingBudget: 0,
              },
            },
          }),
          signal: AbortSignal.timeout(20000),
        });

        if (res.ok) break;

        if (res.status === 429 || res.status === 401 || res.status === 403) {
          reportGeminiKeyFailure(apiKey, res.status);
          if (keyIdx + 1 < apiKeys.length) {
            continue; // Failover to next configured API key
          }
        }
        if (res.status === 404 && model !== models[models.length - 1]) {
          shouldTryNextModel = true;
        }
        break;
      }

      if (shouldTryNextModel) continue;

      if (!res || !res.ok) {
        const status = res?.status ?? 502;
        const userMessage = status === 429
          ? 'Gemini quota is temporarily exhausted across all configured keys. Try again in a moment.'
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
                category: typeof item.category === 'string' ? item.category.trim() : undefined,
              };
            })
            .filter((item) => item.name && item.amount > 0)
            .slice(0, 20)
          : [];

        const items = reconcileKinovaReceiptItems(rawParsedItems, expectedItemsSubtotal);
        const itemsSum = Number(items.reduce((sum, it) => sum + it.amount, 0).toFixed(2));

        if (amount == null && items.length > 0) {
          amount = itemsSum;
        }

        const currency = typeof parsed.currency === 'string' && VALID_CURRENCIES.has(parsed.currency.toUpperCase())
          ? parsed.currency.toUpperCase()
          : 'MYR';

        const date = sanitizeDate(parsed.date) || today;
        const description = typeof parsed.description === 'string' && parsed.description.trim()
          ? parsed.description.trim()
          : items.length > 0
            ? items.map((i) => i.name).slice(0, 2).join(', ')
            : 'Receipt Expense';

        const category = typeof parsed.category === 'string' && parsed.category.trim() ? parsed.category.trim() : 'Food & Dining';
        if (subtotal == null && itemsSum > 0 && amount != null && amount >= itemsSum) {
          subtotal = itemsSum;
        }

        // Parse multi-tax array if returned by Gemini (e.g. Service Charge 10% + SST 6%)
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
              .filter((t) => t.label || (t.rate != null && t.rate > 0) || (t.amount != null && t.amount > 0))
          : [];

        let taxAmount = typeof parsed.taxAmount === 'number' && Number.isFinite(parsed.taxAmount) && parsed.taxAmount >= 0 ? Number(parsed.taxAmount.toFixed(2)) : null;
        let taxRate = typeof parsed.taxRate === 'number' && Number.isFinite(parsed.taxRate) && parsed.taxRate >= 0 ? parsed.taxRate : null;
        if (taxRate !== null && taxRate > 0 && taxRate <= 1) {
          taxRate = Number((taxRate * 100).toFixed(1));
        }
        let taxLabel = typeof parsed.taxLabel === 'string' && parsed.taxLabel.trim() ? parsed.taxLabel.trim() : undefined;

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
        const referenceBase = itemsSum > 0 ? itemsSum : subtotal;
        if (referenceBase != null && referenceBase > 0 && amount != null && amount > referenceBase + 0.03) {
          const impliedTaxAmount = Number((amount - referenceBase).toFixed(2));
          const impliedRatePct = (impliedTaxAmount / referenceBase) * 100;

          if (impliedRatePct > 0 && impliedRatePct <= 35) {
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
              taxAmount,
              taxRate,
              taxIncluded,
              taxLabel,
              taxes: rawTaxes.length > 0 ? rawTaxes : undefined,
              notes: typeof parsed.notes === 'string' ? parsed.notes.trim() : '',
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
