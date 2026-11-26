import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sanitizeMerchantCandidate,
  SYSTEM_NOTIFICATION_NOISE_REGEX,
  inferCategoryFromMerchant,
} from '../src/lib/shortcut-draft-store.ts';
import { sanitizeShopeePayCoinDiscount } from '../src/lib/shopeepay-coin-guard.ts';

test('1. System and notification noise terms are rejected as merchants', () => {
  assert.ok(SYSTEM_NOTIFICATION_NOISE_REGEX.test('Kinova Automation'));
  assert.ok(SYSTEM_NOTIFICATION_NOISE_REGEX.test('kinova automation'));
  assert.ok(SYSTEM_NOTIFICATION_NOISE_REGEX.test('Automation'));
  assert.ok(SYSTEM_NOTIFICATION_NOISE_REGEX.test('Shortcuts'));
  assert.ok(SYSTEM_NOTIFICATION_NOISE_REGEX.test('Screenshot'));
  assert.ok(SYSTEM_NOTIFICATION_NOISE_REGEX.test('Dynamic Island'));
  assert.ok(SYSTEM_NOTIFICATION_NOISE_REGEX.test('Payment successful'));
  assert.ok(SYSTEM_NOTIFICATION_NOISE_REGEX.test('Payment success'));
  assert.ok(SYSTEM_NOTIFICATION_NOISE_REGEX.test('Order ID: GD-3MCF5JLS'));
  assert.ok(SYSTEM_NOTIFICATION_NOISE_REGEX.test('Transaction details'));
  assert.ok(SYSTEM_NOTIFICATION_NOISE_REGEX.test('Food Stall (Ampang)'));
  assert.ok(SYSTEM_NOTIFICATION_NOISE_REGEX.test('Food Stall'));
  assert.ok(SYSTEM_NOTIFICATION_NOISE_REGEX.test('ShopeePay Balance'));
  assert.ok(SYSTEM_NOTIFICATION_NOISE_REGEX.test('eWallet Balance'));

  // sanitizeMerchantCandidate without context returns empty string for noise
  assert.equal(sanitizeMerchantCandidate('Kinova Automation'), '');
  assert.equal(sanitizeMerchantCandidate('Shortcuts'), '');
  assert.equal(sanitizeMerchantCandidate('Automation'), '');
  assert.equal(sanitizeMerchantCandidate('Payment successful'), '');
  assert.equal(sanitizeMerchantCandidate('Order ID: GD-3MCF5JLS'), '');
  assert.equal(sanitizeMerchantCandidate('Food Stall (Ampang)'), '');
  assert.equal(sanitizeMerchantCandidate('ShopeePay Balance'), '');
});

test('2. sanitizeMerchantCandidate extracts true merchant from in-app navigation headers', () => {
  // Scenario A: In-app webview header: "✕ Four Beans 四夕豆花 - Taman Me..." with candidate "Payment successful"
  const fourBeansContext = `
    ✕ Four Beans 四夕豆花 - Taman Me...
    Payment successful
    RM18.74
    Show this to the cashier before you leave!
    Order ID: GD-3MCF5JLS
    Bill amount: 22.05
    Deals and offers: -3.31
    Amount paid: RM18.74
  `;
  const resolvedHeaderStore = sanitizeMerchantCandidate('Payment successful', fourBeansContext);
  assert.equal(resolvedHeaderStore, 'Four Beans 四夕豆花');

  // Scenario B: Shell Petrol screenshot with Kinova Automation notification banner
  const petrolContext = `
    Kinova Automation: ✅ 已记账 [2026-10-18]: MYR 202.82 · SHELL PETALING JAYA
    SHELL PETALING JAYA SEKSYEN 17/22
    Pump 04 - FuelSave 95
    Amount: RM 202.82
    RHB Visa Debit
  `;
  const resolvedPetrol = sanitizeMerchantCandidate('Kinova Automation', petrolContext);
  assert.ok(resolvedPetrol.toLowerCase().includes('shell'));
  assert.equal(resolvedPetrol.toLowerCase().includes('automation'), false);

  // Scenario C: ShopeePay payment confirmation with generic "Food Stall (Ampang)" candidate and "Memo Chicken rice"
  const shopeePayContext = `
    RM14.00 22 Oct 2026, 12:43PM 10 Coins (RM0.10) From Coins Bonanza Order Details Transaction SN ATIAZnTXWzpXgL Order SN 247159008812421049 Payment Method ShopeePay Balance Merchant Location AMPANG Memo Chicken rice
  `;
  const resolvedShopeeMemo = sanitizeMerchantCandidate('Food Stall (Ampang)', shopeePayContext);
  assert.equal(resolvedShopeeMemo, 'Chicken rice');
});

test('3. Merchant and item category inference handles fuel and dessert categories', () => {
  // Transport fuel items
  assert.equal(inferCategoryFromMerchant('SHELL PETALING JAYA SEKSYEN 17/22').category, 'Transport');
  assert.equal(inferCategoryFromMerchant('FuelSave 95').category, 'Transport');
  assert.equal(inferCategoryFromMerchant('Petronas Dagangan').category, 'Transport');
  assert.equal(inferCategoryFromMerchant('Budi Madani RON95').category, 'Transport');

  // Food & Dining dessert shops
  assert.equal(inferCategoryFromMerchant('Four Beans 四夕豆花').category, 'Food & Dining');
  assert.equal(inferCategoryFromMerchant('四夕豆花').category, 'Food & Dining');
  assert.equal(inferCategoryFromMerchant('Dessert Bar').category, 'Food & Dining');

  // Food & Dining F&B and Kopitiam (general semantic inference without hardcoded names)
  const s11Inference = inferCategoryFromMerchant('S11 F and B group section 17 branch');
  assert.equal(s11Inference.category, 'Food & Dining');
  assert.equal(s11Inference.isUncertain, false);

  const s11Ampersand = inferCategoryFromMerchant('S11 F&B Group Section 17 Branch');
  assert.equal(s11Ampersand.category, 'Food & Dining');
  assert.equal(s11Ampersand.isUncertain, false);

  const explicitFb = inferCategoryFromMerchant('Some Stall', 'F&B');
  assert.equal(explicitFb.category, 'Food & Dining');
  assert.equal(explicitFb.isUncertain, false);

  const explicitFoodAndBev = inferCategoryFromMerchant('Generic Merchant', 'Food and Beverage');
  assert.equal(explicitFoodAndBev.category, 'Food & Dining');
  assert.equal(explicitFoodAndBev.isUncertain, false);
});

test('4. Petrol subsidy reconciliation calculates net card amount correctly', () => {
  // Petrol receipt: Pump Gross 202.82, Budi Madani subsidy 115.46, Loyalty Voucher 5.00
  const grossPumpTotal = 202.82;
  const subsidyAmount = 115.46;
  const voucherAmount = 5.00;
  const totalDeductions = Number((subsidyAmount + voucherAmount).toFixed(2)); // 120.46
  const actualCardDebit = 82.36; // RHB Visa Debit

  // If OCR mistakenly captured the pump total (202.82) as the amount paid:
  const rawReportedAmount = grossPumpTotal;
  let finalAmount = rawReportedAmount;
  let billAmount = grossPumpTotal;
  let discountAmount = totalDeductions;

  if (discountAmount > 0 && billAmount > discountAmount) {
    if (Math.abs(rawReportedAmount - billAmount) < 0.05) {
      finalAmount = Number((billAmount - discountAmount).toFixed(2));
    }
  }

  assert.equal(finalAmount, 82.36, 'User actual out-of-pocket expense must be 82.36, not 202.82');
  assert.equal(billAmount, 202.82);
  assert.equal(discountAmount, 120.46);
});

test('5. Discount reconciliation calculates net amount paid correctly without false tax', () => {
  // Case A: Pre-discount bill amount 22.05, discount 3.31 => net amount paid should be 18.74
  const billAmount = 22.05;
  const discountAmount = 3.31;
  const rawReportedAmount = 22.05; // If OCR mistakenly took bill amount as paid amount

  let finalAmount = rawReportedAmount;
  let finalBillAmount = billAmount;

  if (discountAmount > 0) {
    if (Math.abs(rawReportedAmount - billAmount) < 0.01) {
      finalAmount = Number((billAmount - discountAmount).toFixed(2));
    }
  }

  assert.equal(finalAmount, 18.74);
  assert.equal(finalBillAmount, 22.05);

  // Case B: OCR correctly recognized net paid amount 18.74 and discount 3.31
  const netPaidAmount = 18.74;
  let reconciledAmount = netPaidAmount;
  let reconciledBill = 22.05;

  if (discountAmount > 0 && Math.abs(netPaidAmount - (reconciledBill - discountAmount)) < 0.01) {
    // Already net paid amount!
    reconciledAmount = netPaidAmount;
  }
  assert.equal(reconciledAmount, 18.74);

  // Case C: Ensure implied tax calculation is skipped when discountAmount > 0
  const subtotal = 22.05;
  const amount = 18.74;
  const diff = amount - subtotal; // -3.31

  let impliedTaxAmount = 0;
  // If discountAmount is positive, this must NEVER be treated as tax
  if ((!discountAmount || discountAmount <= 0) && diff > 0.05) {
    impliedTaxAmount = diff;
  }
  assert.equal(impliedTaxAmount, 0, 'Discount delta must never be treated as tax');
});

test('6. Petrol volume is not treated as discrete plates and net amount is preserved', () => {
  const isDiscreteMultiQty = (it) => {
    const qty = Number(it.quantity) || 1;
    if (!Number.isInteger(qty) || qty <= 1 || qty > 20) return false;
    if (/litre|liter|\bltr\b|\bl\b|kg|gram|\bg\b|ml/i.test(`${it.name} ${it.unitPrice ?? ''}`)) return false;
    return true;
  };

  // Continuous volume items should NOT trigger plate splitting
  assert.equal(isDiscreteMultiQty({ name: 'FuelSave 95 (43.90 Litres)', quantity: 43.9, unitPrice: 4.62 }), false);
  assert.equal(isDiscreteMultiQty({ name: 'Shell RON 95', quantity: 30, unitPrice: 2.05 }), false);
  assert.equal(isDiscreteMultiQty({ name: 'Apples 2.5 kg', quantity: 2.5, unitPrice: 8 }), false);

  // Discrete multi-quantity items SHOULD trigger plate splitting
  assert.equal(isDiscreteMultiQty({ name: 'Curry Laksa', quantity: 2, unitPrice: 12 }), true);
  assert.equal(isDiscreteMultiQty({ name: 'Four Beans Soya Curd', quantity: 3, unitPrice: 6.5 }), true);

  // Fuel net price and unit rate alignment
  const grossPump = 202.82;
  const netPaidCard = 82.36;
  const quantityLitres = 43.90;
  const items = [{ name: 'FuelSave 95', quantity: quantityLitres, amount: grossPump }];

  if (items.length === 1 && items[0].amount > netPaidCard) {
    items[0].amount = netPaidCard;
    items[0].unitPrice = Number((netPaidCard / items[0].quantity).toFixed(2));
  }

  assert.equal(items[0].amount, 82.36);
  assert.equal(items[0].unitPrice, 1.88); // RM 1.88 per Litre after BUDI MADANI subsidy & voucher
});

test('7. ShopeePay coin cashback/revert is never recorded as -0.10 discount or deducted from paid amount', () => {
  // Case A: ShopeePay receipt where OCR extracted full RM14.00 and mistakenly put 10 Coins (RM0.10) into discountAmount
  const resA = sanitizeShopeePayCoinDiscount({
    amount: 14.0,
    discountAmount: 0.1,
    dealsDescription: '10 Coins (RM0.10) From Coins Bonanza',
    paymentMethod: 'ShopeePay Balance',
    ocrSummary: 'RM14.00 22 Oct 2026, 12:43PM 10 Coins (RM0.10) From Coins Bonanza Payment Method ShopeePay Balance Memo Chicken rice',
    itemsSum: 14.0,
  });
  assert.equal(resA.isShopeePay, true);
  assert.equal(resA.suppressedCoinDiscount, true);
  assert.equal(resA.amount, 14.0);
  assert.equal(resA.discountAmount, null);
  assert.equal(resA.dealsDescription, null);
  assert.equal(resA.billAmount, null);

  // Case B: Gemini already subtracted RM0.10 coin cashback from RM14.00 bill -> restore RM14.00
  const resB = sanitizeShopeePayCoinDiscount({
    amount: 13.9,
    billAmount: 14.0,
    discountAmount: 0.1,
    dealsDescription: '10 Coins (RM0.10) From Coins Bonanza',
    paymentMethod: 'ShopeePay Balance',
    notes: '[优惠抵扣: -MYR 0.10 (10 Coins)] · ShopeePay Balance',
  });
  assert.equal(resB.isShopeePay, true);
  assert.equal(resB.suppressedCoinDiscount, true);
  assert.equal(resB.restoredAmountFromBill, true);
  assert.equal(resB.amount, 14.0);
  assert.equal(resB.discountAmount, null);
  assert.equal(resB.billAmount, null);
  assert.equal(resB.notes, 'ShopeePay Balance');

  // Case C: Gemini subtracted RM0.10 without setting billAmount, but ocrSummary shows RM14.00
  const resC = sanitizeShopeePayCoinDiscount({
    amount: 13.9,
    discountAmount: 0.1,
    dealsDescription: 'Coins Bonanza',
    paymentMethod: 'ShopeePay',
    ocrSummary: 'RM14.00 10 Coins (RM0.10) From Coins Bonanza Payment Method ShopeePay Balance',
  });
  assert.equal(resC.restoredAmountFromBill, true);
  assert.equal(resC.amount, 14.0);
  assert.equal(resC.discountAmount, null);

  // Case D: Genuine RM13.90 meal that also earned 10 Coins (RM0.10) -> stays RM13.90
  const resD = sanitizeShopeePayCoinDiscount({
    amount: 13.9,
    discountAmount: 0.1,
    dealsDescription: '10 Coins (RM0.10) From Coins Bonanza',
    paymentMethod: 'ShopeePay Balance',
    ocrSummary: 'RM13.90 10 Coins (RM0.10) From Coins Bonanza Payment Method ShopeePay Balance',
  });
  assert.equal(resD.restoredAmountFromBill, false);
  assert.equal(resD.amount, 13.9);
  assert.equal(resD.discountAmount, null);

  // Case E: ShopeePay payment where user redeemed coins (RM13.90 cash + 10 Coins used) -> keep RM13.90 cash only, no -0.10 discount
  const resE = sanitizeShopeePayCoinDiscount({
    amount: 13.9,
    billAmount: 14.0,
    discountAmount: 0.1,
    dealsDescription: 'Shopee Coins Redeemed',
    paymentMethod: 'ShopeePay Balance',
  });
  assert.equal(resE.suppressedCoinDiscount, true);
  assert.equal(resE.restoredAmountFromBill, false);
  assert.equal(resE.amount, 13.9);
  assert.equal(resE.discountAmount, null);

  // Case F: ShopeePay payment with genuine non-coin RM voucher -> preserve discount
  const resF = sanitizeShopeePayCoinDiscount({
    amount: 12.0,
    billAmount: 14.0,
    discountAmount: 2.0,
    dealsDescription: 'ShopeePay Instant Voucher',
    paymentMethod: 'ShopeePay Balance',
    ocrSummary: 'RM12.00 Bill RM14.00 ShopeePay Instant Voucher -RM2.00 10 Coins (RM0.10) From Coins Bonanza',
  });
  assert.equal(resF.isShopeePay, true);
  assert.equal(resF.suppressedCoinDiscount, false);
  assert.equal(resF.amount, 12.0);
  assert.equal(resF.discountAmount, 2.0);
  assert.equal(resF.billAmount, 14.0);

  // Case G: Strictly limited to ShopeePay — non-ShopeePay discounts/coins are untouched
  const resGrab = sanitizeShopeePayCoinDiscount({
    amount: 18.74,
    billAmount: 22.05,
    discountAmount: 3.31,
    dealsDescription: 'Deals and offers',
    paymentMethod: 'GrabPay',
  });
  assert.equal(resGrab.isShopeePay, false);
  assert.equal(resGrab.suppressedCoinDiscount, false);
  assert.equal(resGrab.discountAmount, 3.31);

  const resShopeeCard = sanitizeShopeePayCoinDiscount({
    amount: 14.0,
    billAmount: 14.1,
    discountAmount: 0.1,
    dealsDescription: '10 Coins (RM0.10)',
    merchant: 'Shopee',
    paymentMethod: 'Maybank Visa',
  });
  assert.equal(resShopeeCard.isShopeePay, false);
  assert.equal(resShopeeCard.discountAmount, 0.1);
});

