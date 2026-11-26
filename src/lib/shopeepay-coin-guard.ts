export interface ShopeePayCoinGuardInput {
  amount: number | null;
  subtotal?: number | null;
  billAmount?: number | null;
  discountAmount?: number | null;
  dealsDescription?: string | null;
  paymentMethod?: string | null;
  ocrSummary?: string | null;
  notes?: string | null;
  merchant?: string | null;
  description?: string | null;
  itemsSum?: number | null;
}

export interface ShopeePayCoinGuardResult {
  isShopeePay: boolean;
  suppressedCoinDiscount: boolean;
  restoredAmountFromBill: boolean;
  adjustedAmountForCoinRedemption: boolean;
  amount: number | null;
  billAmount: number | null;
  discountAmount: number | null;
  dealsDescription: string | null;
  notes: string;
}

const SHOPEEPAY_PAYMENT_REGEX = /\bshopee\s*pay(?:\s*(?:balance|wallet|account|qr))?\b/i;

const COIN_TERM_REGEX =
  /(?:\b\d+(?:\.\d+)?\s*coins?\b|\bcoins?\b|\bcoins?\s*(?:bonanza|cashback|earned|reward|reverted?|returned?|back|redeemed|used)\b|\bshopee\s*coins?\b|虾币|金币|回扣币|\bkoin\b)/i;

const COIN_CASHBACK_REVERT_REGEX =
  /(?:\bfrom\s+coins?\s+bonanza\b|\bcoins?\s*(?:bonanza|cashback|earned|reward|reverted?|returned?|back)\b|\b(?:earned|earn|revert(?:ed)?|return(?:ed)?|cashback|reward|bonanza)\b[^.\n]{0,40}\bcoins?\b|\bcoins?\b[^.\n]{0,40}\b(?:earned|earn|revert(?:ed)?|return(?:ed)?|cashback|reward|bonanza)\b|\+\s*\d+(?:\.\d+)?\s*coins?\b|返还|回扣|获得.*?(?:虾币|金币))/i;

const COIN_REDEEMED_REGEX =
  /(?:\bcoins?\s*(?:redeemed|used|applied|deducted|spent|offset)\b|\b(?:redeemed|used|deducted|paid\s*(?:with|using))\s+(?:\d+(?:\.\d+)?\s+)?coins?\b|抵扣.*?(?:虾币|金币)|使用.*?(?:虾币|金币))/i;

const GENERIC_DEAL_DESC_REGEX =
  /^(?:deals?\s*(?:&|and)?\s*offers?|discount|rebate|cashback|reward|promotion|promo|coins?|shopee\s*pay\s*(?:discount|cashback|reward))$/i;

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function finitePositive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? round2(value) : null;
}

function textHasPrintedAmountNear(text: string, target: number): boolean {
  if (!text || !(target > 0)) return false;
  // Strip parenthesized coin values like "(RM0.10)" or "(-RM0.10)" so we match the main payment amount.
  const stripped = text.replace(/\([^)]*\bcoins?[^)]*\)|\(\s*-?\s*(?:RM|MYR)\s*\d+(?:\.\d+)?\s*\)/gi, ' ');
  const rx = /(?:RM|MYR|\$)\s*(\d+(?:,\d{3})*(?:\.\d{1,2})?)/gi;
  let match: RegExpExecArray | null;
  while ((match = rx.exec(stripped)) !== null) {
    const parsed = Number(match[1].replace(/,/g, ''));
    if (Number.isFinite(parsed) && Math.abs(parsed - target) <= 0.02) {
      return true;
    }
  }
  return false;
}

function stripCoinDiscountTagFromNotes(notes: string): string {
  if (!notes) return '';
  const cleanedParts = notes
    .split(/\s*·\s*/)
    .map((part) => part.trim())
    .filter((part) => {
      if (!part) return false;
      if (/^\[优惠抵扣:[^\]]*\]$/i.test(part) && COIN_TERM_REGEX.test(part)) {
        return false;
      }
      return true;
    });
  return cleanedParts.join(' · ');
}

/**
 * Limits handling strictly to ShopeePay payments: prevents ShopeePay coin rewards / cashback /
 * coin reverts (e.g. "10 Coins (RM0.10) From Coins Bonanza") and coin deductions from being
 * recorded as a `-0.10` discount in Kinova or subtracted from the out-of-pocket payment amount.
 */
export function sanitizeShopeePayCoinDiscount(input: ShopeePayCoinGuardInput): ShopeePayCoinGuardResult {
  const amount = finitePositive(input.amount);
  const subtotal = finitePositive(input.subtotal);
  const billAmount = finitePositive(input.billAmount);
  const discountAmount = finitePositive(input.discountAmount);
  const itemsSum = finitePositive(input.itemsSum);
  const dealsDescription =
    typeof input.dealsDescription === 'string' && input.dealsDescription.trim()
      ? input.dealsDescription.trim()
      : null;
  const rawNotes = typeof input.notes === 'string' ? input.notes.trim() : '';
  const rawSummary = typeof input.ocrSummary === 'string' ? input.ocrSummary.trim() : '';

  const shopeePayContext = [
    input.paymentMethod,
    rawSummary,
    rawNotes,
    dealsDescription,
    input.merchant,
    input.description,
  ]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .join(' ');

  const isShopeePay = SHOPEEPAY_PAYMENT_REGEX.test(shopeePayContext);
  if (!isShopeePay) {
    return {
      isShopeePay: false,
      suppressedCoinDiscount: false,
      restoredAmountFromBill: false,
      adjustedAmountForCoinRedemption: false,
      amount,
      billAmount,
      discountAmount,
      dealsDescription,
      notes: rawNotes,
    };
  }

  const summaryAndNotes = [rawSummary, rawNotes].filter(Boolean).join(' ');
  const combinedDealAndNotes = [dealsDescription, rawSummary, rawNotes].filter(Boolean).join(' ');

  const dealsMentionsCoin = Boolean(dealsDescription && COIN_TERM_REGEX.test(dealsDescription));
  const dealsIsGeneric = Boolean(!dealsDescription || GENERIC_DEAL_DESC_REGEX.test(dealsDescription));
  const notesMentionCoin = COIN_TERM_REGEX.test(summaryAndNotes);

  const isCoinDiscount =
    discountAmount !== null &&
    (dealsMentionsCoin || (dealsIsGeneric && notesMentionCoin));

  if (!isCoinDiscount) {
    // Still strip any stray coin-only [优惠抵扣: ...] tag Gemini may have placed in notes.
    const cleanedDeals = dealsMentionsCoin ? null : dealsDescription;
    const cleanedNotes = stripCoinDiscountTagFromNotes(rawNotes);
    return {
      isShopeePay: true,
      suppressedCoinDiscount: Boolean(dealsMentionsCoin || cleanedNotes !== rawNotes),
      restoredAmountFromBill: false,
      adjustedAmountForCoinRedemption: false,
      amount,
      billAmount,
      discountAmount,
      dealsDescription: cleanedDeals,
      notes: cleanedNotes,
    };
  }

  const isCashbackOrRevert = COIN_CASHBACK_REVERT_REGEX.test(combinedDealAndNotes);
  const isExplicitRedemption =
    !isCashbackOrRevert && COIN_REDEEMED_REGEX.test(combinedDealAndNotes);

  let nextAmount = amount;
  let restoredAmountFromBill = false;
  let adjustedAmountForCoinRedemption = false;

  if (isExplicitRedemption) {
    // User spent coins at checkout: never record coins as expense; keep/align to net ShopeePay cash paid.
    const grossCandidate = billAmount ?? subtotal ?? itemsSum;
    if (
      nextAmount !== null &&
      grossCandidate !== null &&
      Math.abs(nextAmount - grossCandidate) <= 0.02 &&
      grossCandidate > discountAmount
    ) {
      nextAmount = round2(grossCandidate - discountAmount);
      adjustedAmountForCoinRedemption = true;
    }
  } else if (nextAmount !== null) {
    // Coin cashback / reward / revert (e.g. "10 Coins (RM0.10) From Coins Bonanza"):
    // If Gemini already subtracted the coin value from the printed bill/payment, restore the full paid amount.
    const expectedGross = round2(nextAmount + discountAmount);
    const grossCandidates = [billAmount, subtotal, itemsSum].filter(
      (v): v is number => v !== null
    );
    const matchedGross = grossCandidates.find((v) => Math.abs(v - expectedGross) <= 0.02);
    if (matchedGross !== undefined) {
      nextAmount = matchedGross;
      restoredAmountFromBill = true;
    } else if (textHasPrintedAmountNear(summaryAndNotes, expectedGross)) {
      nextAmount = expectedGross;
      restoredAmountFromBill = true;
    }
  }

  return {
    isShopeePay: true,
    suppressedCoinDiscount: true,
    restoredAmountFromBill,
    adjustedAmountForCoinRedemption,
    amount: nextAmount,
    billAmount: null,
    discountAmount: null,
    dealsDescription: null,
    notes: stripCoinDiscountTagFromNotes(rawNotes),
  };
}
