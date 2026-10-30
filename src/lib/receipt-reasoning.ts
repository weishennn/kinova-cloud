type ReceiptItemCandidate = Record<string, unknown>;

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizedText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function near(left: number, right: number, tolerance = 0.15): boolean {
  return Math.abs(left - right) <= Math.max(tolerance, Math.abs(right) * 0.005);
}

/**
 * Decide whether a fast receipt read needs a second, reasoning-enabled look.
 * The model can flag visual uncertainty; these checks independently catch
 * merchant, quantity, item-total, and tax arithmetic inconsistencies.
 */
export function getReceiptReasoningReasons(parsed: Record<string, unknown>): string[] {
  const reasons = new Set<string>();

  if (parsed.needsReasoning === true) reasons.add('model_flagged_uncertainty');
  if (Array.isArray(parsed.ambiguities) && parsed.ambiguities.some((entry) => normalizedText(entry))) {
    reasons.add('model_flagged_uncertainty');
  }

  const merchant = normalizedText(parsed.merchant) || normalizedText(parsed.description);
  if (
    !merchant ||
    merchant.includes('?') ||
    /^(?:unknown|unclear|illegible|unreadable|merchant|store|receipt|payment\s+(?:successful|completed)|order\s+details|transaction\s+details|ewallet|food\s+stall)$/i.test(merchant)
  ) {
    reasons.add('merchant_unclear');
  }

  const uncertaintyText = [parsed.notes, parsed.taxLabel, parsed.description, parsed.merchant]
    .map(normalizedText)
    .join(' ');
  if (/(?:unclear|uncertain|unreadable|illegible|blurry|blurred|cropped|not visible|cannot determine|can't determine|hard to read|ambiguous|看不清|不清楚|不确定|难以辨认|tak jelas|kabur)/i.test(uncertaintyText)) {
    reasons.add('ocr_text_uncertain');
  }

  const items = Array.isArray(parsed.items)
    ? parsed.items.filter((item): item is ReceiptItemCandidate => Boolean(item) && typeof item === 'object')
    : [];
  let itemsSum = 0;
  let hasUsableItemAmounts = false;

  for (const item of items) {
    const quantity = finiteNumber(item.quantity);
    const amount = finiteNumber(item.amount);
    const unitPrice = finiteNumber(item.unitPrice);
    if (amount != null && amount > 0) {
      itemsSum += amount;
      hasUsableItemAmounts = true;
    }

    if (quantity == null || quantity <= 0) {
      reasons.add('quantity_unclear');
    } else if (Math.abs(quantity - 1) > 0.0001 && amount != null && amount > 0 && unitPrice != null && unitPrice > 0 && !near(amount, quantity * unitPrice, 0.05)) {
      reasons.add('quantity_line_total_mismatch');
    }

    const itemName = normalizedText(item.name);
    if (!itemName || itemName.includes('?')) reasons.add('item_name_unclear');
  }

  const amount = finiteNumber(parsed.amount);
  const subtotal = finiteNumber(parsed.subtotal);
  const taxAmount = finiteNumber(parsed.taxAmount);
  const discountAmount = finiteNumber(parsed.discountAmount);
  const expectedItemTotals = [amount, subtotal]
    .filter((value): value is number => value != null && value > 0);
  if (discountAmount != null && discountAmount > 0) {
    if (amount != null && amount > 0) expectedItemTotals.push(amount + discountAmount);
    if (subtotal != null && subtotal > 0) expectedItemTotals.push(subtotal + discountAmount);
  }
  if (taxAmount != null && taxAmount > 0) {
    if (amount != null && amount > taxAmount) expectedItemTotals.push(amount - taxAmount);
    if (subtotal != null && subtotal > 0) expectedItemTotals.push(subtotal + taxAmount);
  }

  if (hasUsableItemAmounts && expectedItemTotals.length > 0 && !expectedItemTotals.some((expected) => near(itemsSum, expected))) {
    reasons.add('items_total_mismatch');
  }

  const taxes = Array.isArray(parsed.taxes) ? parsed.taxes : [];
  const taxRate = finiteNumber(parsed.taxRate);
  const taxLabel = normalizedText(parsed.taxLabel);
  const hasTaxEvidence = (taxAmount != null && taxAmount > 0) || (taxRate != null && taxRate > 0) || Boolean(taxLabel) || taxes.length > 0;
  if (taxLabel.includes('?')) reasons.add('tax_math_unclear');
  if (hasTaxEvidence && amount != null && amount > 0 && subtotal != null && subtotal > 0) {
    const discount = discountAmount != null && discountAmount > 0 ? discountAmount : 0;
    const tax = taxAmount != null && taxAmount > 0 ? taxAmount : 0;
    const clearTaxTotals = [subtotal, subtotal + tax, subtotal + tax - discount, subtotal - discount];
    if (!clearTaxTotals.some((candidate) => near(amount, candidate))) {
      reasons.add('tax_math_unclear');
    }
  } else if (
    !hasTaxEvidence &&
    (discountAmount == null || discountAmount <= 0) &&
    amount != null && amount > 0 &&
    subtotal != null && subtotal > 0 &&
    Math.abs(amount - subtotal) > 0.05
  ) {
    reasons.add('tax_math_unclear');
  } else if (hasTaxEvidence && amount != null && amount > 0 && hasUsableItemAmounts) {
    const tax = taxAmount != null && taxAmount > 0 ? taxAmount : 0;
    const clearTaxTotals = [itemsSum, itemsSum + tax, itemsSum - (discountAmount || 0)];
    if (!clearTaxTotals.some((candidate) => near(amount, candidate))) {
      reasons.add('tax_math_unclear');
    }
  }

  return [...reasons];
}
