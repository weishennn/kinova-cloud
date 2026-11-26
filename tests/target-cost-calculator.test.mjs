import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateTargetCostBuyPrice } from '../src/lib/target-cost-calculator.ts';

test('calculates exact limit buy price when averaging down without fees', () => {
  const res = calculateTargetCostBuyPrice({
    currentQty: 1,
    currentAvgCost: 100000,
    currentMarketPrice: 90000,
    targetAvgCost: 90000,
    investAmountUsd: 45000,
    feeRatePct: 0,
  });

  assert.equal(res.status, 'limit_below_market');
  assert.ok(res.requiredLimitPrice !== null);
  assert.ok(Math.abs(res.requiredLimitPrice - 73636.363636) < 0.01);
  assert.ok(Math.abs((res.resultingAvgCost ?? 0) - 90000) < 0.001);
});

test('calculates fee-adjusted limit buy price accurately for 0.1% Binance Spot fee', () => {
  const res = calculateTargetCostBuyPrice({
    currentQty: 2,
    currentAvgCost: 3000,
    currentMarketPrice: 2400,
    targetAvgCost: 2500,
    investAmountUsd: 2000,
    feeRatePct: 0.1,
  });

  assert.equal(res.status, 'limit_below_market');
  assert.ok(res.requiredLimitPrice !== null);
  // Verify forward check: (Q0*C0 + A) / (Q0 + A*(1-f)/P) === targetAvgCost
  const f = 0.001;
  const unitsBought = (2000 * (1 - f)) / res.requiredLimitPrice;
  const verifiedAvg = (2 * 3000 + 2000) / (2 + unitsBought);
  assert.ok(Math.abs(verifiedAvg - 2500) < 1e-6);
});

test('flags market_achieves_target when current market price already meets target cost', () => {
  const res = calculateTargetCostBuyPrice({
    currentQty: 10,
    currentAvgCost: 200,
    currentMarketPrice: 120,
    targetAvgCost: 160,
    investAmountUsd: 2000,
    feeRatePct: 0,
  });

  // Limit price needed = 160*2000 / (10*(200-160)+2000) = 320000 / 2400 = 133.33 > market 120!
  assert.equal(res.status, 'market_achieves_target');
  assert.equal(res.marketBuyPreview?.achievesOrBeatsTarget, true);
});

test('detects mathematically unreachable averaging-up budget and reports invalid inputs', () => {
  const unreachable = calculateTargetCostBuyPrice({
    currentQty: 10,
    currentAvgCost: 100,
    currentMarketPrice: 150,
    targetAvgCost: 130,
    investAmountUsd: 200,
    feeRatePct: 0,
  });
  assert.equal(unreachable.status, 'unreachable');
  assert.equal(unreachable.requiredLimitPrice, null);

  const invalid = calculateTargetCostBuyPrice({
    currentQty: 1,
    currentAvgCost: 100,
    currentMarketPrice: 90,
    targetAvgCost: 0,
    investAmountUsd: 500,
  });
  assert.equal(invalid.status, 'invalid');
});

test('handles zero starting position cleanly', () => {
  const res = calculateTargetCostBuyPrice({
    currentQty: 0,
    currentAvgCost: 0,
    currentMarketPrice: 100,
    targetAvgCost: 90,
    investAmountUsd: 900,
    feeRatePct: 0.1,
  });

  assert.equal(res.status, 'limit_below_market');
  assert.ok(Math.abs((res.requiredLimitPrice ?? 0) - 90 * 0.999) < 1e-6);
  assert.ok(Math.abs((res.resultingAvgCost ?? 0) - 90) < 1e-6);
});
