import { getActiveUserCacheScope } from '@/lib/sheets-api';

export interface InvestmentRollupSnapshot {
  source: 'stocks' | 'binance';
  totalValueMyr: number;
  totalValueUsd: number;
  unrealizedPnlMyr: number;
  unrealizedPnlUsd: number;
  realizedPnlMyr: number;
  realizedPnlUsd: number;
  updatedAt: string;
}

const ROLLUP_EVENT = 'kinova:investment-rollup-updated';

export function getBinanceSnapshotKey(): string {
  return `cashflow_binance_snapshot_v1_${getActiveUserCacheScope()}`;
}

export function getInvestmentRollupKey(source: 'stocks' | 'binance'): string {
  return `cashflow_binance_rollup_${source}_v1_${getActiveUserCacheScope()}`;
}

export function saveInvestmentRollup(snapshot: InvestmentRollupSnapshot): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(getInvestmentRollupKey(snapshot.source), JSON.stringify(snapshot));
    window.dispatchEvent(new CustomEvent(ROLLUP_EVENT));
  } catch {
    // ignore storage quota failures
  }
}

export function readInvestmentRollup(source: 'stocks' | 'binance'): InvestmentRollupSnapshot | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(getInvestmentRollupKey(source));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as InvestmentRollupSnapshot;
    if (!parsed || typeof parsed.totalValueMyr !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

export const INVESTMENT_ROLLUP_EVENT = ROLLUP_EVENT;
