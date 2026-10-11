/**
 * Malaysia Tax Calculation Engine (YA 2024/2025/2026)
 */

export interface TaxBracket {
  min: number;
  max: number;
  rate: number;
  baseTax: number;
}

// Reference progressive tax brackets for residents. Verify the applicable YA
// before relying on this estimate; Malaysian tax rules can change by year.
export const taxBrackets: TaxBracket[] = [
  { min: 0, max: 5000, rate: 0, baseTax: 0 },
  { min: 5000, max: 20000, rate: 0.01, baseTax: 0 },
  { min: 20000, max: 35000, rate: 0.03, baseTax: 150 },
  { min: 35000, max: 50000, rate: 0.06, baseTax: 600 },
  { min: 50000, max: 70000, rate: 0.11, baseTax: 1500 },
  { min: 70000, max: 100000, rate: 0.19, baseTax: 3700 },
  { min: 100000, max: 400000, rate: 0.25, baseTax: 9400 },
  { min: 400000, max: 600000, rate: 0.26, baseTax: 84400 },
  { min: 600000, max: 2000000, rate: 0.28, baseTax: 136400 },
  { min: 2000000, max: Infinity, rate: 0.30, baseTax: 528400 },
];

export interface TaxRelief {
  id: string;
  name: string;
  maxLimit: number;
  category: 'individual' | 'lifestyle' | 'medical' | 'insurance' | 'family';
}

export const commonTaxReliefs: TaxRelief[] = [
  { id: 'individual', name: 'Individual and dependent relatives', maxLimit: 9000, category: 'individual' },
  { id: 'medical_parents', name: 'Medical treatment, special needs for parents', maxLimit: 8000, category: 'medical' },
  { id: 'lifestyle', name: 'Lifestyle (books, PC, sports, broadband)', maxLimit: 2500, category: 'lifestyle' },
  { id: 'lifestyle_sports', name: 'Lifestyle - Sports equipment/facilities', maxLimit: 500, category: 'lifestyle' },
  { id: 'medical_self', name: 'Medical expenses for self/spouse/child', maxLimit: 10000, category: 'medical' },
  { id: 'epf_insurance', name: 'Life insurance and EPF', maxLimit: 7000, category: 'insurance' }, // Pensionable max 7000, non-pensionable EPF 4000 + Life 3000
  { id: 'education_insurance', name: 'Education and medical insurance', maxLimit: 3000, category: 'insurance' },
  { id: 'socso', name: 'SOCSO', maxLimit: 350, category: 'insurance' },
  { id: 'spouse', name: 'Husband / Wife / Alimony', maxLimit: 4000, category: 'family' },
  { id: 'child_under_18', name: 'Child under 18 years old', maxLimit: 2000, category: 'family' }, // Per child
  { id: 'child_tertiary', name: 'Child in tertiary education', maxLimit: 8000, category: 'family' }, // Per child
];

export interface TaxCalculationResult {
  chargeableIncome: number;
  baseTax: number;
  progressiveTax: number;
  totalTax: number;
  effectiveRate: number;
  monthlyPCB: number; // Approximate PCB (Potongan Cukai Berjadual)
}

/**
 * Calculates progressive tax payable
 * @param chargeableIncome Income after deducting all reliefs
 */
export function calculateTax(chargeableIncome: number): TaxCalculationResult {
  if (chargeableIncome <= 0) {
    return { chargeableIncome: 0, baseTax: 0, progressiveTax: 0, totalTax: 0, effectiveRate: 0, monthlyPCB: 0 };
  }

  let baseTax = 0;
  let progressiveTax = 0;
  let currentRate = 0;

  for (let i = taxBrackets.length - 1; i >= 0; i--) {
    const bracket = taxBrackets[i];
    if (chargeableIncome >= bracket.min) {
      baseTax = bracket.baseTax;
      currentRate = bracket.rate;
      const taxableAtRate = chargeableIncome - bracket.min;
      progressiveTax = taxableAtRate * currentRate;
      break;
    }
  }

  const totalTax = baseTax + progressiveTax;
  // Rebates for chargeable income < 35000 (Individual RM400)
  let taxAfterRebate = totalTax;
  if (chargeableIncome <= 35000 && totalTax > 0) {
    taxAfterRebate = Math.max(0, totalTax - 400);
  }

  return {
    chargeableIncome,
    baseTax,
    progressiveTax,
    totalTax: taxAfterRebate,
    effectiveRate: (taxAfterRebate / chargeableIncome) * 100,
    monthlyPCB: taxAfterRebate / 12,
  };
}

/**
 * Calculates total chargeable income
 * @param annualIncome Total annual gross income
 * @param claimedReliefs Record of relief ID to claimed amount
 */
export function calculateChargeableIncome(
  annualIncome: number,
  claimedReliefs: Record<string, number>
): number {
  let totalReliefs = 0;
  
  for (const relief of commonTaxReliefs) {
    const claimedAmount = claimedReliefs[relief.id] || 0;
    // Cap at max limit for each relief
    const eligibleAmount = Math.max(0, Math.min(claimedAmount, relief.maxLimit));
    totalReliefs += eligibleAmount;
  }

  return Math.max(0, annualIncome - totalReliefs);
}
