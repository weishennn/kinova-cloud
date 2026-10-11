/**
 * Transaction amounts are entered to cents. Reject values whose minor units
 * cannot be represented safely by JavaScript's number type instead of storing
 * a value that the ledger may round or convert to Infinity/NaN.
 */
export function isSafeTransactionAmount(value: unknown): boolean {
  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return false;

  const cents = amount * 100;
  const roundedCents = Math.round(cents);
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(cents)) * 2;
  return roundedCents > 0 &&
    Number.isSafeInteger(roundedCents) &&
    Math.abs(cents - roundedCents) <= tolerance;
}

export function isSafeTransactionConversion(
  amount: number,
  baseAmount: number,
  baseRate: number,
): boolean {
  return isSafeTransactionAmount(amount) &&
    Number.isFinite(baseAmount) &&
    Number.isFinite(baseRate) &&
    baseRate > 0;
}
