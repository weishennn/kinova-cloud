import { NextRequest, NextResponse } from 'next/server';
import { getLocalDateString, normalizeDateString } from '@/lib/date-helper';
import { normalizeToCanonicalCategory } from '@/lib/canonical-categories';
import { getValidGoogleSession } from '@/lib/google-auth';
import { recordUserAiCall } from '@/lib/admin-registry';
import { generateGeminiContent } from '@/lib/gemini-key-pool';
import { getReceiptReasoningReasons } from '@/lib/receipt-reasoning';
import { reconcileKinovaReceiptItems, type RawReconcilableReceiptItem } from '@/lib/receipt-item-reconciler';

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

function parseReceiptJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    try {
      return JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
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
    const rawImage = typeof body?.imageBase64 === 'string' ? body.imageBase64 : '';
    const imageBase64 = rawImage.replace(/^data:image\/\w+;base64,/, '').trim();
    const mimeType = typeof body?.mimeType === 'string' ? body.mimeType : 'image/jpeg';
    const today = sanitizeDate(body?.today) || getLocalDateString();

    if (!imageBase64 || imageBase64.length > 8_000_000 || !/^image\/(jpeg|png|webp|gif)$/i.test(mimeType)) {
      return NextResponse.json({ success: false, error: 'A valid JPEG, PNG, or WebP receipt image is required' }, { status: 400 });
    }

    const prompt = `You are an intelligent financial OCR and receipt analysis AI.
Analyze this receipt or payment confirmation screenshot and return ONLY valid JSON.
Today is ${today}.

CRITICAL INSTRUCTIONS:
1. NOTIFICATION BANNER / UI CHROME FILTERING:
   - Screenshots often have mobile UI chrome: status bar (time, battery, network), Dynamic Island, or NOTIFICATION BANNERS at the top.
   - NEVER use system app names, shortcut titles, or notification text as the merchant, store, or item name!
   - NEVER use generic screen status titles like "Payment successful", "Payment completed", "Order details", or "Order ID" as the merchant name!
   - Look UNDERNEATH or PAST any notification banner to find the ACTUAL store or merchant name.

2. APP HEADER & PAYMENT SUMMARY EXTRACTION:
   - On payment screens (e.g. e-wallets, mini-programs, webviews), the store name is often located at the top navigation bar next to a close button '✕' or '<' (e.g. '✕ Store Name - Branch...').
   - You MUST extract the merchant name from this top bar if it is not inside the card body.
   - Clean branch suffixes or trailing truncation dots.
   - If the payment confirmation does not list individual dishes/items (e.g. only shows Order ID, Bill amount, Deals and offers), generate a single line item using the merchant name or payment note as the item description, with quantity 1 and amount equal to the net payment.

2.5. E-WALLET & BANK TRANSFER CONFIRMATIONS (DuitNow QR, e-Wallets, Mobile Banking):
   - PAYMENT METHOD IS NOT THE MERCHANT: Payment channels/methods (e.g. "Touch 'n Go eWallet", "ShopeePay", "DuitNow QR", "MAE", "Card") are NEVER the merchant/store name!
   - MERCHANT LOCATION IS NOT THE STORE NAME: Location fields or city names are locations, NOT the merchant name. NEVER invent generic names like "Food Stall (Location)"!
   - EXTRACT "MEMO" / "REMARK" / "RECIPIENT REFERENCE": Look specifically for "Memo", "Remark", "Recipient Reference", "Payment Details", or "Note". When no separate shop brand is shown, the Memo/Remark text IS the primary description or stall name! Extract it as "description" and include it in "items".

3. FUEL / PETROL & SUBSIDY DEDUCTIONS:
   - Gas and petrol stations belong to category "Transport".
   - Extract purchased fuel line items into "items" with litres and unit price when printed.
   - DEDUCTION & NET CHARGE AUDIT: Receipts and fuel pumps often display an unsubsidized gross amount, government subsidies, loyalty vouchers, or member discounts alongside the actual customer payment. "amount" MUST ALWAYS BE THE ACTUAL NET OUT-OF-POCKET AMOUNT CHARGED.

4. TAX, SERVICE CHARGE & ROUNDING:
   - Calculate or extract net subtotal, SST, and service charges.
   - Do not mistake cash rounding adjustments (e.g. 1-5 cents) for tax.
   - Distinguish tax already included in item prices from tax added after the subtotal. If tax is printed separately, capture each tax/service-charge amount and whether it is included in the total.
5. MULTI-QUANTITY & LINE TOTAL ACCURACY (CRITICAL):
   - Extract the merchant/store name, each visible item name, quantity, unit price, and EXTENDED LINE AMOUNT.
   - For any item with quantity > 1 (e.g. "3x Salmon Sushi @ 6.00", "3  Sushi  6.00  18.00", or 3 plates):
     * "quantity" MUST be the count (e.g. 3).
     * "unitPrice" MUST be the per-unit price (e.g. 6.00).
     * "amount" MUST ALWAYS BE THE EXTENDED LINE TOTAL (quantity * unitPrice, e.g. 18.00), NEVER the single-unit price!
     * Verify sum(items[].amount) matches the receipt Subtotal (or Net Paid + Discounts - Taxes) before returning JSON.
6. CONFIDENCE AND ITEM AUDIT:
   - Check that item totals, subtotal, discounts, separate taxes/service charges, and final amount paid reconcile. Do not force totals to match by changing a printed value.
   - Set "needsReasoning" to true only when visual evidence or conflicting receipt arithmetic leaves a material field uncertain (merchant, item name, quantity, line amount, tax inclusion/separation, or amount paid). Multiple clearly printed tax lines alone do not require reasoning.
   - When needsReasoning is true, list concise uncertainty types in "ambiguities". Otherwise return an empty array. Do not guess; preserve the best candidate values for the review pass.

Return ONLY this JSON shape:
{
  "merchant": string,
  "date": "YYYY-MM-DD",
  "amount": number,
  "currency": string,
  "category": string,
  "description": string,
  "subtotal": number | null,
  "taxAmount": number | null,
  "taxRate": number | null,
  "taxIncluded": boolean,
  "taxLabel": string,
  "items": [{"name": string, "quantity": number, "unitPrice": number, "amount": number, "brand": string | null, "productType": string | null, "category": string}],
  "needsReasoning": boolean,
  "ambiguities": string[],
  "notes": string
}`;

    let usedModel = process.env.GEMINI_MODEL?.trim() || 'gemini-3.5-flash';
    let parsed: Record<string, unknown> | null = null;
    let fastPassError: unknown = null;
    let fastResult: Awaited<ReturnType<typeof generateGeminiContent>> | null = null;
    try {
      fastResult = await generateGeminiContent({
        prompt,
        imageBase64,
        mimeType,
        responseMimeType: 'application/json',
        thinking: false,
        thinkingBudget: 0,
        temperature: 0.1,
        maxOutputTokens: 4096,
        timeoutMs: 8_000,
        totalTimeoutMs: 10_000,
      });
      parsed = parseReceiptJson(fastResult.text);
      if (!parsed) fastPassError = new Error('Gemini OCR returned invalid JSON');
      else usedModel = fastResult.model;
    } catch (err: unknown) {
      fastPassError = err;
    }

    const initialReasoningReasons = parsed ? getReceiptReasoningReasons(parsed) : ['fast_ocr_unavailable'];
    let finalReasoningReasons = initialReasoningReasons;
    const reasoningAttempted = !parsed || initialReasoningReasons.length > 0;
    let reasoningUsed = false;
    let reasoningFallback = false;

    // If the fast OCR call itself fails, try one bounded reasoning-enabled read
    // so a difficult photo can still produce a usable draft.
    if (!parsed) {
      const recoveryPrompt = `${prompt}\n\nRECOVERY READ:\nThe fast OCR extraction did not return usable JSON. Read the image carefully and produce the best evidence-based transaction draft. Pay special attention to the merchant, quantities, item line totals, and whether tax is included or added separately. Set needsReasoning=true and describe any details that remain unclear. Do not expose private chain-of-thought.`;
      let recovered: Awaited<ReturnType<typeof generateGeminiContent>>;
      try {
        recovered = await generateGeminiContent({
          prompt: recoveryPrompt,
          imageBase64,
          mimeType,
          responseMimeType: 'application/json',
          thinking: true,
          thinkingBudget: 128,
          temperature: 0.1,
          maxOutputTokens: 4096,
          timeoutMs: 5_000,
          totalTimeoutMs: 5_000,
          preferredKeySlot: 0,
          onlyPreferredKey: true,
          models: [process.env.GEMINI_MODEL?.trim() || 'gemini-3.5-flash'],
        });
      } catch (err: unknown) {
        try {
          recovered = await generateGeminiContent({
            prompt: recoveryPrompt,
            imageBase64,
            mimeType,
            responseMimeType: 'application/json',
            thinking: true,
            thinkingBudget: 128,
            temperature: 0.1,
            maxOutputTokens: 4096,
            timeoutMs: 8_000,
            totalTimeoutMs: 10_000,
          });
        } catch (fallbackErr: unknown) {
          const errorMsg = fallbackErr instanceof Error
            ? fallbackErr.message
            : (err instanceof Error ? err.message : (fastPassError instanceof Error ? fastPassError.message : 'Gemini OCR failed'));
          return NextResponse.json({ success: false, error: errorMsg }, { status: 502 });
        }
      }
      parsed = parseReceiptJson(recovered.text);
      if (!parsed) {
        return NextResponse.json({ success: false, error: 'Gemini OCR returned invalid JSON' }, { status: 502 });
      }
      usedModel = recovered.model;
      reasoningUsed = true;
      finalReasoningReasons = getReceiptReasoningReasons(parsed);
    }

    if (reasoningAttempted) {
      const reasoningPrompt = !reasoningUsed && parsed && fastResult
        ? `Review the attached receipt image against this first-pass candidate. Re-read the merchant name, each item name and quantity, unit price versus extended line amount, subtotal, discount, tax/service-charge lines, and final paid amount. The first pass flagged: ${initialReasoningReasons.join(', ')}.

Treat the candidate as unverified. Correct a field only when the image supports it. Ensure each item's "amount" is its EXTENDED LINE TOTAL (quantity * unitPrice, e.g. 3 plates * 6.00 = 18.00, NEVER 6.00) and reconciles with printed Subtotal and final paid totals. Decide from the receipt whether tax is included in the listed prices or added after the subtotal. If a detail remains unreadable, retain the best candidate and list the uncertainty; do not invent a value. Do not provide chain-of-thought.

Return only valid JSON with this exact structure:
{"merchant":string,"date":"YYYY-MM-DD","amount":number,"currency":string,"category":string,"description":string,"subtotal":number|null,"taxAmount":number|null,"taxRate":number|null,"taxIncluded":boolean,"taxLabel":string,"items":[{"name":string,"quantity":number,"unitPrice":number,"amount":number,"brand":string|null,"productType":string|null,"category":string}],"needsReasoning":boolean,"ambiguities":string[],"notes":string}

Candidate to verify:
${JSON.stringify(parsed)}`
        : '';
      if (reasoningPrompt) {
        try {
          const reviewed = await generateGeminiContent({
            prompt: reasoningPrompt,
            imageBase64,
            mimeType,
            responseMimeType: 'application/json',
            thinking: true,
            thinkingBudget: 128,
            temperature: 0.1,
            maxOutputTokens: 4096,
            timeoutMs: 8_000,
            totalTimeoutMs: 8_000,
            preferredKeySlot: fastResult?.keySlot,
            onlyPreferredKey: true,
          });
          const reviewedJson = parseReceiptJson(reviewed.text);
          if (!reviewedJson) {
            reasoningFallback = true;
          } else {
            parsed = reviewedJson;
            usedModel = reviewed.model;
            reasoningUsed = true;
            finalReasoningReasons = getReceiptReasoningReasons(parsed);
          }
        } catch {
          // Keep the fast result usable if the optional deep review times out or fails.
          reasoningFallback = true;
        }
      }
    }

    if (!parsed) {
      return NextResponse.json({ success: false, error: 'Gemini OCR returned invalid JSON' }, { status: 502 });
    }

      try {
        const rawParsedItems: RawReconcilableReceiptItem[] = Array.isArray(parsed.items)
          ? parsed.items
            .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
            .map((item) => {
              const qty = typeof item.quantity === 'number' && Number.isFinite(item.quantity) && item.quantity > 0
                ? Number(item.quantity.toFixed(3))
                : 1;
              const unitPrice = typeof item.unitPrice === 'number' && Number.isFinite(item.unitPrice) && item.unitPrice > 0
                ? Number(item.unitPrice.toFixed(2))
                : 0;
              const explicitAmt = typeof item.amount === 'number' && Number.isFinite(item.amount) && item.amount > 0
                ? Number(item.amount.toFixed(2))
                : 0;
              const amt = explicitAmt > 0
                ? explicitAmt
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

        let isTaxIncluded = Boolean(parsed.taxIncluded ?? parsed.tax_included);
        let amount = typeof parsed.amount === 'number' && Number.isFinite(parsed.amount) && parsed.amount > 0
          ? Number(parsed.amount.toFixed(2))
          : null;
        let subtotal = typeof parsed.subtotal === 'number' && Number.isFinite(parsed.subtotal) && parsed.subtotal > 0
          ? Number(parsed.subtotal.toFixed(2))
          : null;

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

        // Parse multi-tax array if returned by Gemini (e.g. Service Charge 10% + SST 6%)
        // Strictly exclude Rounding / Pelarasan Genapan lines BEFORE item qty reconciliation so totals align cleanly.
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

        const rawTaxAmtForReconcile = taxAmount != null && taxAmount > 0 ? taxAmount : 0;
        const rawItemsSum = Number(rawParsedItems.reduce((sum, it) => sum + it.amount, 0).toFixed(2));

        const items = reconcileKinovaReceiptItems(rawParsedItems, {
          amount,
          subtotal,
          billAmount,
          discountAmount,
          taxAmount: rawTaxAmtForReconcile,
          taxRate,
          taxIncluded: isTaxIncluded,
        });
        const itemsSum = Number(items.reduce((sum, it) => sum + it.amount, 0).toFixed(2));

        // If Gemini mistakenly returned unmultiplied `rawItemsSum` as `amount` despite a printed larger subtotal, align `amount`.
        if (
          amount != null &&
          subtotal != null &&
          (!discountAmount || discountAmount <= 0) &&
          Math.abs(amount - rawItemsSum) <= 0.05 &&
          itemsSum > rawItemsSum + 0.05 &&
          Math.abs(itemsSum - subtotal) <= 0.15
        ) {
          amount = isTaxIncluded
            ? itemsSum
            : Number((itemsSum + rawTaxAmtForReconcile).toFixed(2));
        }

        // Mathematical Tax Regime Invariant (runs AFTER multi-qty item reconciliation):
        // Test whether reconciled items sum matches the gross paid total (Inclusive) or needs tax added on top (Exclusive)
        const grossPaidForTaxCheck =
          amount != null && discountAmount != null && discountAmount > 0
            ? Number((amount + discountAmount).toFixed(2))
            : (amount ?? subtotal ?? itemsSum);
        if (grossPaidForTaxCheck > 0 && itemsSum > 0) {
          const diffInclusive = Math.abs(itemsSum - grossPaidForTaxCheck);
          const diffExclusive = Math.abs((itemsSum + rawTaxAmtForReconcile) - grossPaidForTaxCheck);

          if (diffInclusive <= 0.15) {
            // Proven tax-inclusive: items already sum to gross total
            isTaxIncluded = true;
          } else if (diffExclusive <= 0.15 && diffInclusive > 0.15) {
            // Proven tax-exclusive: items sum to base and tax is added on top
            isTaxIncluded = false;
          }
        }

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
          description = items.map((i) => i.name).slice(0, 2).join(', ');
        }
        if (!description) {
          description = 'Receipt Expense';
        }

        // If items are empty, but description is available, add a single item
        if (items.length === 0 && amount != null && amount > 0) {
          if (description && description !== 'Receipt Expense') {
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

        // Mathematical cross-check: if tax is NOT inclusive, and receipt has a subtotal (or itemsSum) and a larger final amount,
        // ensure taxRate and taxAmount reflect the FULL surcharge (e.g. 10% Service Charge + 6% SST = 16%),
        // even if Gemini only recognized one of the two taxes (e.g. 6%)!
        // Differences <= 0.05 are purely rounding adjustments (1 to 5 sen in Malaysia), NOT tax!
        // IMPORTANT: Never infer tax if the difference is caused by discounts/deals or if tax is already included!
        const referenceBase = itemsSum > 0 ? itemsSum : subtotal;
        if (
          !isTaxIncluded &&
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

        const taxIncluded = isTaxIncluded;

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
            ocrReasoning: {
              attempted: reasoningAttempted,
              used: reasoningUsed,
              reasons: initialReasoningReasons,
              unresolved: finalReasoningReasons,
              fallback: reasoningFallback,
            },
          },
          model: usedModel,
        });
      } catch {
        return NextResponse.json({ success: false, error: 'Gemini OCR returned invalid JSON' }, { status: 502 });
      }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Receipt OCR failed';
    console.error('[ReceiptOCR] Uncaught error in route:', err);
    return NextResponse.json({ success: false, error: `Receipt OCR failed (${errorMsg})` }, { status: 500 });
  }
}
