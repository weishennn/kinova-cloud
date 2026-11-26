export interface TargetCostInput {
  currentQty: number;
  currentAvgCost: number;
  currentMarketPrice: number;
  targetAvgCost: number;
  investAmountUsd: number;
  feeRatePct?: number;
}

export type TargetCostStatus =
  | 'limit_below_market'
  | 'market_achieves_target'
  | 'limit_above_market'
  | 'unreachable'
  | 'invalid';

export interface TargetCostResult {
  status: TargetCostStatus;
  reason?: string;
  requiredLimitPrice: number | null;
  pctDiffFromMarket: number | null;
  unitsToBuy: number | null;
  feePaidUsd: number | null;
  resultingTotalUnits: number | null;
  resultingTotalCostUsd: number | null;
  resultingAvgCost: number | null;
  marketBuyPreview: {
    unitsToBuy: number;
    resultingTotalUnits: number;
    resultingTotalCostUsd: number;
    resultingAvgCost: number;
    achievesOrBeatsTarget: boolean;
  } | null;
  minBudgetAtMarketUsd: number | null;
}

/**
 * Solves the exact limit buy price required so that investing `investAmountUsd`
 * moves an existing holding's average cost basis from `currentAvgCost` to `targetAvgCost`.
 */
export function calculateTargetCostBuyPrice(input: TargetCostInput): TargetCostResult {
  const Q0 = Number(input.currentQty);
  const C0 = Number(input.currentAvgCost);
  const Pmkt = Number(input.currentMarketPrice);
  const Ctarget = Number(input.targetAvgCost);
  const A = Number(input.investAmountUsd);
  const feePct = Math.max(0, Math.min(10, Number(input.feeRatePct ?? 0)));
  const f = feePct / 100;

  if (!Number.isFinite(Q0) || Q0 < 0 || !Number.isFinite(C0) || C0 < 0 || !Number.isFinite(Ctarget) || Ctarget <= 0 || !Number.isFinite(A) || A <= 0) {
    return {
      status: 'invalid',
      reason: 'Enter positive target cost price and USD investment amount.',
      requiredLimitPrice: null,
      pctDiffFromMarket: null,
      unitsToBuy: null,
      feePaidUsd: null,
      resultingTotalUnits: null,
      resultingTotalCostUsd: null,
      resultingAvgCost: null,
      marketBuyPreview: null,
      minBudgetAtMarketUsd: null,
    };
  }

  const B0 = Q0 * C0;
  const effectiveTargetUnit = Ctarget * (1 - f);
  const marketBuyPreview = Number.isFinite(Pmkt) && Pmkt > 0
    ? (() => {
        const unitsAtMkt = (A * (1 - f)) / Pmkt;
        const totalUnitsAtMkt = Q0 + unitsAtMkt;
        const totalCostAtMkt = B0 + A;
        const avgAtMkt = totalUnitsAtMkt > 0 ? totalCostAtMkt / totalUnitsAtMkt : 0;
        const isAveragingDown = Q0 === 0 || Ctarget <= C0;
        const achievesOrBeatsTarget = isAveragingDown
          ? avgAtMkt <= Ctarget + 1e-9
          : avgAtMkt >= Ctarget - 1e-9;
        return {
          unitsToBuy: unitsAtMkt,
          resultingTotalUnits: totalUnitsAtMkt,
          resultingTotalCostUsd: totalCostAtMkt,
          resultingAvgCost: avgAtMkt,
          achievesOrBeatsTarget,
        };
      })()
    : null;

  let minBudgetAtMarketUsd: number | null = null;
  if (Number.isFinite(Pmkt) && Pmkt > 0 && Q0 > 0) {
    if (Ctarget < C0 && Pmkt < effectiveTargetUnit) {
      minBudgetAtMarketUsd = (Q0 * (C0 - Ctarget)) / ((effectiveTargetUnit / Pmkt) - 1);
    } else if (Ctarget > C0 && Pmkt > effectiveTargetUnit) {
      minBudgetAtMarketUsd = (Q0 * (Ctarget - C0)) / (1 - (effectiveTargetUnit / Pmkt));
    }
  }

  const denominator = Q0 * (C0 - Ctarget) + A;
  if (denominator <= 1e-12) {
    return {
      status: 'unreachable',
      reason: Q0 > 0 && Ctarget > C0
        ? `Even at any positive buy price, $${A.toFixed(2)} is too small to raise your average from $${C0.toFixed(4)} to $${Ctarget.toFixed(4)}. You need more than $${(Q0 * (Ctarget - C0)).toFixed(2)}.`
        : 'Target cost price cannot be reached with this investment budget.',
      requiredLimitPrice: null,
      pctDiffFromMarket: null,
      unitsToBuy: null,
      feePaidUsd: null,
      resultingTotalUnits: null,
      resultingTotalCostUsd: null,
      resultingAvgCost: null,
      marketBuyPreview,
      minBudgetAtMarketUsd,
    };
  }

  const requiredLimitPrice = (Ctarget * A * (1 - f)) / denominator;
  if (!Number.isFinite(requiredLimitPrice) || requiredLimitPrice <= 0) {
    return {
      status: 'unreachable',
      reason: 'Calculated buy price is not positive.',
      requiredLimitPrice: null,
      pctDiffFromMarket: null,
      unitsToBuy: null,
      feePaidUsd: null,
      resultingTotalUnits: null,
      resultingTotalCostUsd: null,
      resultingAvgCost: null,
      marketBuyPreview,
      minBudgetAtMarketUsd,
    };
  }

  const unitsToBuy = (A * (1 - f)) / requiredLimitPrice;
  const feePaidUsd = A * f;
  const resultingTotalUnits = Q0 + unitsToBuy;
  const resultingTotalCostUsd = B0 + A;
  const resultingAvgCost = resultingTotalUnits > 0 ? resultingTotalCostUsd / resultingTotalUnits : 0;

  const pctDiffFromMarket = Number.isFinite(Pmkt) && Pmkt > 0
    ? ((requiredLimitPrice - Pmkt) / Pmkt) * 100
    : null;

  let status: TargetCostStatus = 'limit_below_market';
  if (Number.isFinite(Pmkt) && Pmkt > 0) {
    const isAveragingDown = Q0 === 0 || Ctarget <= C0;
    if (isAveragingDown) {
      status = requiredLimitPrice >= Pmkt ? 'market_achieves_target' : 'limit_below_market';
    } else {
      status = requiredLimitPrice <= Pmkt ? 'market_achieves_target' : 'limit_above_market';
    }
  }

  return {
    status,
    requiredLimitPrice,
    pctDiffFromMarket,
    unitsToBuy,
    feePaidUsd,
    resultingTotalUnits,
    resultingTotalCostUsd,
    resultingAvgCost,
    marketBuyPreview,
    minBudgetAtMarketUsd,
  };
}
