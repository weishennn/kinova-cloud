export interface RawReconcilableReceiptItem {
  name: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  brand?: string;
  productType?: string;
  qtyReconciled?: string;
  category?: string;
}

export interface ReconcileReceiptTotalsContext {
  amount?: number | null;
  subtotal?: number | null;
  billAmount?: number | null;
  discountAmount?: number | null;
  taxAmount?: number | null;
  taxRate?: number | null;
  taxIncluded?: boolean;
}

const NON_DISCRETE_UNIT_REGEX =
  /\b(?:litres?|liters?|ltrs?|kgs?|grams?|kilograms?|ml|mg|oz|lbs?|fuel|petrol|diesel|gasoline|ron\s*\d+|primax|fuelsave|v-power)\b|\d+(?:\.\d+)?\s*(?:l|g|kg|ml|mg)\b/i;

/**
 * Extracts explicit quantity multipliers embedded in OCR item names
 * (e.g. "3x Salmon Sushi", "Salmon Sushi x3", "Salmon Sushi (×3)", "Qty 3 Sushi")
 * while avoiding model numbers or weights/volumes like "RON 95" or "500ml".
 */
export function extractQuantityFromItemName(rawName: string): {
  cleanName: string;
  parsedQty: number | null;
} {
  const trimmed = String(rawName || '').trim();
  if (!trimmed) return { cleanName: '', parsedQty: null };

  const patterns: Array<{ regex: RegExp; qtyGroup: number; nameGroup: number }> = [
    { regex: /^(\d{1,2})\s*[xX×]\s+(.+)$/, qtyGroup: 1, nameGroup: 2 },
    { regex: /^[Qq]ty\s*:?\s*(\d{1,2})\s+(.+)$/, qtyGroup: 1, nameGroup: 2 },
    { regex: /^(.+?)\s+[xX×]\s*(\d{1,2})$/, qtyGroup: 2, nameGroup: 1 },
    { regex: /^(.+?)\s*\(\s*[xX×]\s*(\d{1,2})\s*\)$/, qtyGroup: 2, nameGroup: 1 },
    { regex: /^(.+?)\s*\(\s*(\d{1,2})\s*[xX×]\s*\)$/, qtyGroup: 2, nameGroup: 1 },
  ];

  for (const { regex, qtyGroup, nameGroup } of patterns) {
    const match = trimmed.match(regex);
    if (!match) continue;
    const parsed = Number(match[qtyGroup]);
    const cleanName = match[nameGroup].trim();
    if (cleanName && Number.isInteger(parsed) && parsed >= 2 && parsed <= 50) {
      return { cleanName, parsedQty: parsed };
    }
  }

  return { cleanName: trimmed, parsedQty: null };
}

export function isDiscreteMultiQtyItem(item: {
  name?: string;
  quantity?: number;
  unitPrice?: number | string;
}): boolean {
  const qty = Number(item.quantity);
  if (!Number.isInteger(qty) || qty <= 1 || qty > 50) return false;
  if (NON_DISCRETE_UNIT_REGEX.test(`${item.name || ''} ${item.unitPrice ?? ''}`)) {
    return false;
  }
  return true;
}

/**
 * Computes candidate expected pre-tax / pre-discount item sums ordered by reliability.
 */
export function computeCandidateExpectedSubtotals(
  ctxOrSubtotal: number | null | undefined | ReconcileReceiptTotalsContext
): number[] {
  if (typeof ctxOrSubtotal === 'number') {
    return Number.isFinite(ctxOrSubtotal) && ctxOrSubtotal > 0
      ? [Number(ctxOrSubtotal.toFixed(2))]
      : [];
  }
  if (!ctxOrSubtotal) return [];

  const candidates: number[] = [];
  const pushCandidate = (val: number | null | undefined) => {
    if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0) return;
    const rounded = Number(val.toFixed(2));
    if (!candidates.some((existing) => Math.abs(existing - rounded) <= 0.01)) {
      candidates.push(rounded);
    }
  };

  const explicitSubtotal =
    typeof ctxOrSubtotal.subtotal === 'number' && ctxOrSubtotal.subtotal > 0
      ? Number(ctxOrSubtotal.subtotal.toFixed(2))
      : null;
  const billAmount =
    typeof ctxOrSubtotal.billAmount === 'number' && ctxOrSubtotal.billAmount > 0
      ? Number(ctxOrSubtotal.billAmount.toFixed(2))
      : null;
  const amount =
    typeof ctxOrSubtotal.amount === 'number' && ctxOrSubtotal.amount > 0
      ? Number(ctxOrSubtotal.amount.toFixed(2))
      : null;
  const discount =
    typeof ctxOrSubtotal.discountAmount === 'number' && ctxOrSubtotal.discountAmount > 0
      ? Number(ctxOrSubtotal.discountAmount.toFixed(2))
      : 0;
  const taxAmt =
    typeof ctxOrSubtotal.taxAmount === 'number' && ctxOrSubtotal.taxAmount > 0
      ? Number(ctxOrSubtotal.taxAmount.toFixed(2))
      : 0;
  const taxRate =
    typeof ctxOrSubtotal.taxRate === 'number' && ctxOrSubtotal.taxRate > 0 && ctxOrSubtotal.taxRate <= 50
      ? Number(ctxOrSubtotal.taxRate)
      : 0;

  if (explicitSubtotal !== null) {
    pushCandidate(explicitSubtotal);
    if (discount > 0 && billAmount === null) {
      pushCandidate(explicitSubtotal + discount);
    }
  }

  if (billAmount !== null) {
    if (ctxOrSubtotal.taxIncluded) {
      pushCandidate(billAmount);
      if (taxAmt > 0 && billAmount > taxAmt) pushCandidate(billAmount - taxAmt);
      if (taxRate > 0) pushCandidate(billAmount / (1 + taxRate / 100));
    } else {
      if (taxAmt > 0 && billAmount > taxAmt) pushCandidate(billAmount - taxAmt);
      if (taxRate > 0) pushCandidate(billAmount / (1 + taxRate / 100));
      pushCandidate(billAmount);
    }
  }

  if (amount !== null) {
    const grossPaidBeforeDiscount = discount > 0 ? Number((amount + discount).toFixed(2)) : amount;
    if (ctxOrSubtotal.taxIncluded) {
      pushCandidate(grossPaidBeforeDiscount);
      if (taxAmt > 0 && grossPaidBeforeDiscount > taxAmt) pushCandidate(grossPaidBeforeDiscount - taxAmt);
      if (taxRate > 0) pushCandidate(grossPaidBeforeDiscount / (1 + taxRate / 100));
    } else {
      if (taxAmt > 0 && grossPaidBeforeDiscount > taxAmt) pushCandidate(grossPaidBeforeDiscount - taxAmt);
      if (taxRate > 0) pushCandidate(grossPaidBeforeDiscount / (1 + taxRate / 100));
      pushCandidate(grossPaidBeforeDiscount);
    }
  }

  return candidates;
}

/**
 * Deterministically reconciles receipt line items so every discrete multi-quantity item's
 * `amount` equals `quantity * unitPrice` (extended line total) and aligns cleanly with
 * printed receipt totals (including tax-exclusive / tax-inclusive / discounted receipts).
 */
export function reconcileKinovaReceiptItems(
  rawItems: RawReconcilableReceiptItem[],
  expectedSubtotalOrContext: number | null | undefined | ReconcileReceiptTotalsContext
): RawReconcilableReceiptItem[] {
  if (!rawItems.length) return [];

  const preparedMeta = rawItems.map((raw) => {
    const { cleanName, parsedQty } = extractQuantityFromItemName(raw.name);
    let qty =
      typeof raw.quantity === 'number' && Number.isFinite(raw.quantity) && raw.quantity > 0
        ? Number(raw.quantity.toFixed(3))
        : 1;
    if (qty === 1 && parsedQty !== null) {
      qty = parsedQty;
    }

    const explicitRawUnit =
      typeof raw.unitPrice === 'number' && Number.isFinite(raw.unitPrice) && raw.unitPrice > 0
        ? Number(raw.unitPrice.toFixed(2))
        : 0;
    const explicitRawAmt =
      typeof raw.amount === 'number' && Number.isFinite(raw.amount) && raw.amount > 0
        ? Number(raw.amount.toFixed(2))
        : 0;

    const initialAmt =
      explicitRawAmt > 0
        ? explicitRawAmt
        : explicitRawUnit > 0
        ? Number((explicitRawUnit * qty).toFixed(2))
        : 0;

    return {
      item: {
        ...raw,
        name: cleanName,
        quantity: qty,
        amount: initialAmt,
        unitPrice:
          explicitRawUnit > 0
            ? explicitRawUnit
            : qty > 1 && initialAmt > 0
            ? Number((initialAmt / qty).toFixed(2))
            : initialAmt,
        qtyReconciled: raw.qtyReconciled || 'as_is',
      } as RawReconcilableReceiptItem,
      explicitRawUnit,
      explicitRawAmt,
    };
  });

  const prepared = preparedMeta.map((m) => m.item);
  const candidateTargets = computeCandidateExpectedSubtotals(expectedSubtotalOrContext);

  const multiIndices = prepared
    .map((it, idx) => (isDiscreteMultiQtyItem(it) && it.amount > 0 ? idx : -1))
    .filter((idx) => idx >= 0);

  let appliedTargetReconciliation = false;

  if (candidateTargets.length > 0 && multiIndices.length > 0 && multiIndices.length <= 10) {
    const defaultSumMinor = prepared.reduce((s, it) => s + Math.round(it.amount * 100), 0);

    // If the unadjusted items sum ALREADY closely matches the primary expected target
    // (or exact subtotal + discount fallback), leave amounts untouched and only fix unitPrice below.
    const primaryTargetMinor = Math.round(candidateTargets[0] * 100);
    const primaryDefaultDiff = Math.abs(defaultSumMinor - primaryTargetMinor);

    if (primaryDefaultDiff > 15) {
      const fixedMinor = prepared.reduce(
        (sum, it, idx) => (multiIndices.includes(idx) ? sum : sum + Math.round(it.amount * 100)),
        0
      );

      const candidatesPerMulti = multiIndices.map((idx) => {
        const it = prepared[idx];
        const meta = preparedMeta[idx];
        const asIsMinor = Math.round(it.amount * 100);
        const multBase =
          meta.explicitRawUnit > 0 && Math.abs(meta.explicitRawUnit - it.amount) <= 0.01
            ? meta.explicitRawUnit
            : it.amount;
        const multMinor = Math.round(multBase * it.quantity * 100);
        const divMinor = Math.round((it.amount / it.quantity) * 100);
        return [
          { mode: 'as_is', minor: asIsMinor },
          { mode: 'multiplied_unit_price', minor: multMinor },
          { mode: 'divided_overmultiplied_total', minor: divMinor },
        ];
      });

      for (const target of candidateTargets) {
        const expectedMinor = Math.round(target * 100);
        const defaultDiff = Math.abs(defaultSumMinor - expectedMinor);
        if (defaultDiff <= 15) {
          // Items already match a valid candidate target as-is
          appliedTargetReconciliation = true;
          break;
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
        if (bestDiff <= toleranceMinor && bestDiff < defaultDiff * 0.5 && bestChanges > 0) {
          multiIndices.forEach((itemIdx, mPos) => {
            const mode = bestCombo[mPos];
            const it = prepared[itemIdx];
            const meta = preparedMeta[itemIdx];
            if (mode === 'multiplied_unit_price') {
              const unit =
                meta.explicitRawUnit > 0 && Math.abs(meta.explicitRawUnit - it.amount) <= 0.01
                  ? meta.explicitRawUnit
                  : it.amount;
              it.unitPrice = unit;
              it.amount = Number((unit * it.quantity).toFixed(2));
              it.qtyReconciled = mode;
            } else if (mode === 'divided_overmultiplied_total') {
              it.amount = Number((it.amount / it.quantity).toFixed(2));
              it.unitPrice = Number((it.amount / it.quantity).toFixed(2));
              it.qtyReconciled = mode;
            }
          });
          appliedTargetReconciliation = true;
          break;
        }
      }
    } else {
      appliedTargetReconciliation = true;
    }
  }

  // Fallback check when no target matched cleanly (e.g. missing subtotal/tax on receipt,
  // or OCR returned unitPrice === amount for a discrete multi-qty line item).
  if (!appliedTargetReconciliation) {
    const primaryTarget = candidateTargets[0] ?? null;
    for (let idx = 0; idx < prepared.length; idx += 1) {
      const it = prepared[idx];
      const meta = preparedMeta[idx];
      if (!isDiscreteMultiQtyItem(it)) continue;
      if (
        meta.explicitRawUnit > 0 &&
        meta.explicitRawAmt > 0 &&
        Math.abs(meta.explicitRawUnit - meta.explicitRawAmt) <= 0.01
      ) {
        const currentSum = prepared.reduce((s, x) => s + x.amount, 0);
        const multipliedLineTotal = Number((meta.explicitRawUnit * it.quantity).toFixed(2));
        const nextSum = currentSum - it.amount + multipliedLineTotal;

        // Apply unless a known expected target already matches unmultiplied better than multiplied
        const shouldSkipDueToTarget =
          primaryTarget !== null &&
          Math.abs(currentSum - primaryTarget) <= Math.abs(nextSum - primaryTarget);

        if (!shouldSkipDueToTarget) {
          it.unitPrice = meta.explicitRawUnit;
          it.amount = multipliedLineTotal;
          it.qtyReconciled = 'multiplied_unit_price';
        }
      }
    }
  }

  // Final consistency normalization: ensure displayed `unitPrice` for discrete multi-qty lines
  // always reflects `amount / quantity` rather than accidentally holding the line total (`@18.00 MYR 18.00`).
  for (const it of prepared) {
    if (!isDiscreteMultiQtyItem(it) || it.amount <= 0) continue;
    const expectedLineFromUnit = it.unitPrice * it.quantity;
    if (
      it.unitPrice <= 0 ||
      Math.abs(expectedLineFromUnit - it.amount) > Math.max(0.05, it.amount * 0.01)
    ) {
      it.unitPrice = Number((it.amount / it.quantity).toFixed(2));
    }
  }

  return prepared;
}
