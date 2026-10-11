import { describe, it, expect } from 'vitest';
import {
  analyzePurchaseForTaxRelief,
  calculateYearlyTaxReliefSummary,
  calculateMalaysiaProgressiveTax,
  applyPayslipDeductionsTag,
  extractPayslipDeductionsFromNotes,
  applyTaxReliefTag,
  getTransactionTaxRelief,
} from '../lhdn-tax-helper';

describe('Malaysia LHDN Personal Tax Relief Engine', () => {
  it('auto-detects Lifestyle relief items (books, smartphone, laptop, internet)', () => {
    const bookCheck = analyzePurchaseForTaxRelief({
      description: 'Kinokuniya Python Book',
      category: 'Shopping',
    });
    expect(bookCheck.isEligible).toBe(true);
    expect(bookCheck.category?.id).toBe('lifestyle');

    const phoneCheck = analyzePurchaseForTaxRelief({
      description: 'iPhone 16 Pro Max',
      category: 'Shopping',
    });
    expect(phoneCheck.isEligible).toBe(true);
    expect(phoneCheck.category?.id).toBe('lifestyle');

    const wifiCheck = analyzePurchaseForTaxRelief({
      description: 'TM Unifi Home Fibre Bill',
      category: 'Housing & Bills',
    });
    expect(wifiCheck.isEligible).toBe(true);
    expect(wifiCheck.category?.id).toBe('lifestyle');
  });

  it('auto-detects Sports & Gym relief items', () => {
    const badmintonCheck = analyzePurchaseForTaxRelief({
      description: 'Yonex Badminton Racket & Court Booking',
      category: 'Entertainment',
    });
    expect(badmintonCheck.isEligible).toBe(true);
    expect(badmintonCheck.category?.id).toBe('sports');
  });

  it('warns when recording common non-qualifying lookalike items (smartwatch, spectacles, petrol)', () => {
    const watchCheck = analyzePurchaseForTaxRelief({
      description: 'Apple Watch Series 10',
      category: 'Shopping',
    });
    expect(watchCheck.isEligible).toBe(false);
    expect(watchCheck.warningMessage?.toLowerCase()).toContain('smartwatches');

    const glassesCheck = analyzePurchaseForTaxRelief({
      description: 'Owndays Spectacles Optical',
      category: 'Health',
    });
    expect(glassesCheck.isEligible).toBe(false);
    expect(glassesCheck.warningMessage?.toLowerCase()).toContain('spectacles');
  });

  it('persists and extracts explicit LHDN tax tags via SubCategory and Notes', () => {
    const tagged = applyTaxReliefTag('medical', 'Dental scaling at clinic');
    expect(tagged.subCategory).toBe('LHDN: Medical & Dental');
    expect(tagged.notes).toContain('[LHDN Tax Relief: medical (Medical & Dental)]');

    const extracted = getTransactionTaxRelief({
      type: 'expense',
      description: 'Some clinic',
      category: 'Other',
      subCategory: tagged.subCategory,
      notes: tagged.notes,
    });
    expect(extracted?.id).toBe('medical');

    const optedOut = applyTaxReliefTag('none', tagged.notes);
    expect(optedOut.subCategory).toBe('');
    expect(optedOut.notes).toContain('[No Tax Relief]');

    const extractedAfterOptOut = getTransactionTaxRelief({
      type: 'expense',
      description: 'iPhone 16 (bought for company claim)',
      category: 'Shopping',
      subCategory: optedOut.subCategory,
      notes: optedOut.notes,
    });
    expect(extractedAfterOptOut).toBeNull();
  });

  it('calculates Assessment Year quotas, remaining limits, and missing receipt counts accurately', () => {
    const mockTransactions: any[] = [
      {
        id: 'tx_1',
        date: '2026-03-15',
        type: 'expense',
        category: 'Shopping',
        subCategory: 'LHDN: Lifestyle',
        description: 'iPad Air',
        amount: 2200,
        currency: 'MYR',
        receiptUrl: 'https://drive.google.com/file/d/abc123/view',
        notes: '[LHDN Tax Relief: lifestyle (Lifestyle)]',
      },
      {
        id: 'tx_2',
        date: '2026-06-10',
        type: 'expense',
        category: 'Shopping',
        subCategory: 'LHDN: Lifestyle',
        description: 'MPH Bookstore',
        amount: 500,
        currency: 'MYR',
        receiptUrl: '', // Missing receipt!
        notes: '[LHDN Tax Relief: lifestyle (Lifestyle)]',
      },
    ];

    const summary = calculateYearlyTaxReliefSummary(mockTransactions, '2026');
    const lifestyle = summary.categories.find((c) => c.category.id === 'lifestyle')!;

    expect(lifestyle.totalSpent).toBe(2700);
    expect(lifestyle.limit).toBe(2500);
    expect(lifestyle.claimableAmount).toBe(2500); // capped at RM 2,500
    expect(lifestyle.remainingLimit).toBe(0);
    expect(lifestyle.isMaxedOut).toBe(true);
    expect(lifestyle.attachedReceiptCount).toBe(1);
    expect(lifestyle.missingReceiptCount).toBe(1);
    expect(summary.totalClaimable).toBe(2500);
    expect(summary.missingReceiptCount).toBe(1);
  });

  it('calculates official Malaysia LHDN progressive tax brackets and RM 400 statutory rebate accurately', () => {
    // Chargeable income RM 30,000 -> Gross tax = 150 + (10,000 * 3%) = 450; minus RM 400 statutory rebate = RM 50
    const lowBracket = calculateMalaysiaProgressiveTax(30000);
    expect(lowBracket.grossTax).toBe(450);
    expect(lowBracket.rebate).toBe(400);
    expect(lowBracket.netTax).toBe(50);
    expect(lowBracket.marginalRate).toBe(3);

    // Chargeable income RM 52,000 -> First 50,000 = 1,500 + (2,000 * 11%) = 1,720; no RM 400 rebate (>35k)
    const midBracket = calculateMalaysiaProgressiveTax(52000);
    expect(midBracket.grossTax).toBe(1720);
    expect(midBracket.rebate).toBe(0);
    expect(midBracket.netTax).toBe(1720);
    expect(midBracket.marginalRate).toBe(11);
  });

  it('enforces separate EPF (RM 4,000 sub-limit), Life Insurance (RM 3,000 sub-limit), and SOCSO (RM 350 limit) caps and calculates Form BE settlement', () => {
    const notesWithPayslip = applyPayslipDeductionsTag('Monthly salary', 2160, 5000, 450);
    const parsedPayslip = extractPayslipDeductionsFromNotes(notesWithPayslip);
    expect(parsedPayslip.pcbAmount).toBe(2160);
    expect(parsedPayslip.epfAmount).toBe(5000);
    expect(parsedPayslip.socsoAmount).toBe(450);

    const mockYearTxs: any[] = [
      {
        id: 'sal_1',
        date: '2026-01-28',
        type: 'income',
        category: 'Salary',
        description: 'Annual Salary Total',
        amount: 72000,
        currency: 'MYR',
        notes: notesWithPayslip,
      },
      {
        id: 'claim_1',
        date: '2026-02-10',
        type: 'income',
        category: 'Claim Allowance',
        description: 'Company Travel Reimbursement (Tax Exempt)',
        amount: 3000,
        currency: 'MYR',
        notes: '',
      },
      {
        id: 'exp_life',
        date: '2026-02-20',
        type: 'expense',
        category: 'Insurance',
        description: 'AIA Family Takaful Life Insurance',
        amount: 3000,
        currency: 'MYR',
        receiptUrl: 'https://drive.google.com/file/d/life/view',
        notes: '[LHDN Tax Relief: epf_life (EPF & Life Insurance)]',
      },
      {
        id: 'exp_1',
        date: '2026-03-15',
        type: 'expense',
        category: 'Shopping',
        description: 'MacBook Air M3',
        amount: 2500,
        currency: 'MYR',
        receiptUrl: 'https://drive.google.com/file/d/macbook/view',
        notes: '[LHDN Tax Relief: lifestyle (Lifestyle)]',
      },
      {
        id: 'exp_2',
        date: '2026-04-10',
        type: 'expense',
        category: 'Health',
        description: 'Dental Scaling & Full Blood Test',
        amount: 1150,
        currency: 'MYR',
        receiptUrl: 'https://drive.google.com/file/d/dental/view',
        notes: '[LHDN Tax Relief: medical (Medical & Dental)]',
      },
    ];

    const summary = calculateYearlyTaxReliefSummary(mockYearTxs, '2026');
    // Taxable income excludes 'Claim Allowance' (3000), so annualTaxableIncome = 72,000
    expect(summary.annualTaxableIncome).toBe(72000);

    // EPF (5,000 payslip capped at RM 4,000 sub-limit) + Life Insurance (3,000 capped at RM 3,000 sub-limit) = RM 7,000
    const epfLifeCat = summary.categories.find((c) => c.category.id === 'epf_life')!;
    expect(epfLifeCat.claimableAmount).toBe(7000);

    // SOCSO (450 payslip capped at RM 350 separate limit) = RM 350
    const socsoCat = summary.categories.find((c) => c.category.id === 'socso_eis')!;
    expect(socsoCat.claimableAmount).toBe(350);

    // Total Claimable Reliefs = EPF+Life (7,000) + SOCSO (350) + Lifestyle (2,500) + Medical (1,150) = 11,000
    expect(summary.totalClaimableRelief).toBe(11000);
    // Chargeable income = 72,000 - 9,000 (Auto Self Relief) - 11,000 = 52,000
    expect(summary.chargeableIncome).toBe(52000);
    // Estimated LHDN tax on 52,000 = RM 1,720
    expect(summary.actualTaxPayable).toBe(1720);
    // Tax without reliefs (Chargeable = 72,000 - 9,000 = 63,000) -> 1,500 + 13,000*11% = 2,930
    expect(summary.taxWithoutReliefs).toBe(2930);
    // Tax saved by reliefs = 2,930 - 1,720 = 1,210
    expect(summary.estimatedTaxSaved).toBe(1210);
    // Total PCB paid = 2,160 -> Refund = 2,160 - 1,720 = RM 440.00!
    expect(summary.totalPcbPaid).toBe(2160);
    expect(summary.settlementStatus).toBe('refund');
    expect(summary.refundAmount).toBe(440);
    expect(summary.extraTaxToPay).toBe(0);

    // If user only paid RM 1,000 PCB via manual override -> Extra Tax to Pay = 1,720 - 1,000 = RM 720.00
    const underpaidSummary = calculateYearlyTaxReliefSummary(mockYearTxs, '2026', undefined, 11, {
      pcbPaidOverride: 1000,
    });
    expect(underpaidSummary.settlementStatus).toBe('pay_extra');
    expect(underpaidSummary.extraTaxToPay).toBe(720);
    expect(underpaidSummary.refundAmount).toBe(0);
  });

  it('prevents double-counting when EPF or SOCSO is recorded both on a payslip and as a standalone transaction', () => {
    const txsWithDuplicateEpfAndSocso: any[] = [
      {
        id: 'sal_jan',
        date: '2026-01-28',
        type: 'income',
        category: 'Salary',
        description: 'January Salary',
        amount: 6000,
        currency: 'MYR',
        notes: applyPayslipDeductionsTag('Jan salary', 150, 660, 29.65),
      },
      {
        id: 'standalone_epf_jan',
        date: '2026-01-28',
        type: 'expense',
        category: 'Savings',
        description: 'KWSP EPF Contribution Jan',
        amount: 660,
        currency: 'MYR',
        notes: '[LHDN Tax Relief: epf_life (EPF & Life Insurance)]',
      },
      {
        id: 'standalone_socso_jan',
        date: '2026-01-28',
        type: 'expense',
        category: 'Insurance',
        description: 'PERKESO SOCSO & EIS Jan',
        amount: 29.65,
        currency: 'MYR',
        notes: '[LHDN Tax Relief: socso_eis (SOCSO & EIS (PERKESO))]',
      },
    ];

    const summary = calculateYearlyTaxReliefSummary(txsWithDuplicateEpfAndSocso, '2026');
    const epfLifeCat = summary.categories.find((c) => c.category.id === 'epf_life')!;
    const socsoCat = summary.categories.find((c) => c.category.id === 'socso_eis')!;

    // Must count 660 once (not 1,320) and 29.65 once (not 59.30)
    expect(epfLifeCat.totalSpent).toBe(660);
    expect(epfLifeCat.claimableAmount).toBe(660);
    expect(socsoCat.totalSpent).toBe(29.65);
    expect(socsoCat.claimableAmount).toBe(29.65);
  });

  it('preserves mandatory payslip EPF and SOCSO when a voluntary top-up or separate contribution is recorded in the same month', () => {
    const txsWithVoluntaryTopUp: any[] = [
      {
        id: 'sal_feb',
        date: '2026-02-28',
        type: 'income',
        category: 'Salary',
        description: 'February Salary',
        amount: 6000,
        currency: 'MYR',
        notes: applyPayslipDeductionsTag('Feb salary', 150, 660, 29.65),
      },
      {
        id: 'voluntary_epf_diff_amt',
        date: '2026-02-15',
        type: 'expense',
        category: 'Savings',
        description: 'KWSP Self Contribution',
        amount: 1000,
        currency: 'MYR',
        notes: '[LHDN Tax Relief: epf_life (EPF & Life Insurance)]',
      },
      {
        id: 'voluntary_epf_same_amt',
        date: '2026-02-20',
        type: 'expense',
        category: 'Savings',
        description: 'Voluntary EPF Top-Up (i-Saraan)',
        amount: 660,
        currency: 'MYR',
        notes: '[LHDN Tax Relief: epf_life (EPF & Life Insurance)]',
      },
      {
        id: 'voluntary_socso_feb',
        date: '2026-02-22',
        type: 'expense',
        category: 'Insurance',
        description: 'PERKESO Self-Employed SPS Contribution',
        amount: 150,
        currency: 'MYR',
        notes: '[LHDN Tax Relief: socso_eis (SOCSO & EIS (PERKESO))]',
      },
    ];

    const summary = calculateYearlyTaxReliefSummary(txsWithVoluntaryTopUp, '2026');
    const epfLifeCat = summary.categories.find((c) => c.category.id === 'epf_life')!;
    const socsoCat = summary.categories.find((c) => c.category.id === 'socso_eis')!;

    // Payslip EPF (660) + Voluntary 1,000 + Voluntary 660 = 2,320 (none omitted!)
    expect(summary.recordedPayslipEpf).toBe(660);
    expect(epfLifeCat.totalSpent).toBe(2320);
    expect(epfLifeCat.claimableAmount).toBe(2320);

    // Payslip SOCSO (29.65) + Voluntary SPS SOCSO (150) = 179.65 (none omitted!)
    expect(summary.recordedPayslipSocso).toBe(29.65);
    expect(socsoCat.totalSpent).toBe(179.65);
    expect(socsoCat.claimableAmount).toBe(179.65);
  });

  it('applies additional Form BE reliefs (Spouse/Child/Donations) and Zakat/Spouse tax rebates accurately', () => {
    const txs: any[] = [
      {
        id: 'sal_year',
        date: '2026-06-28',
        type: 'income',
        category: 'Salary',
        description: 'Annual Salary',
        amount: 65000,
        currency: 'MYR',
        notes: applyPayslipDeductionsTag('', 1200, 0, 0),
      },
      {
        id: 'zakat_tx',
        date: '2026-04-05',
        type: 'expense',
        category: 'Charity',
        description: 'Zakat Pendapatan PPZ',
        amount: 500,
        currency: 'MYR',
        notes: '',
      },
    ];

    // Gross 65,000 - Self Relief 9,000 - Additional Reliefs (Spouse 4,000 + Child 2,000 = 6,000) = Chargeable 50,000
    // Gross tax on 50,000 = RM 1,500
    // Minus auto-detected Zakat Rebate (RM 500) = Net Tax Payable RM 1,000
    // PCB paid (1,200) - Net Tax (1,000) = RM 200 Refund
    const summary = calculateYearlyTaxReliefSummary(txs, '2026', undefined, 8, {
      additionalReliefsOverride: 6000,
    });

    expect(summary.additionalReliefs).toBe(6000);
    expect(summary.chargeableIncome).toBe(50000);
    expect(summary.additionalRebates).toBe(500);
    expect(summary.actualTaxPayable).toBe(1000);
    expect(summary.refundAmount).toBe(200);
  });
});

