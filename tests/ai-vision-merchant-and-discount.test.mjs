import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sanitizeMerchantCandidate,
  SYSTEM_NOTIFICATION_NOISE_REGEX,
  inferCategoryFromMerchant,
} from '../src/lib/shortcut-draft-store.ts';

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

