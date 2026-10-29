import { sheetsApi } from '@/lib/sheets-api';
import { sheetsData } from '@/lib/sheets-data';
import { isRecordTombstoned } from '@/lib/data-integrity';

export interface SyncResult {
  success: boolean;
  portfolioSynced: boolean;
  overviewSynced: boolean;
  pendingFlushedCount: number;
  holdingsCount: number;
  monthsCount: number;
  message: string;
}

/**
 * Reconciles the 'Portfolio' tab in Google Sheets from all logged 'Trades'.
 * Preserves live GOOGLEFINANCE and P&L formulas in columns G:K.
 */
export async function syncGoogleSheetPortfolio(): Promise<{ success: boolean; count: number }> {
  try {
    const res = await sheetsApi.syncPortfolio();
    if (res.success) {
      return { success: true, count: 1 };
    }
    return { success: false, count: 0 };
  } catch (err) {
    console.warn('Portfolio sheet sync warning:', err);
    return { success: false, count: 0 };
  }
}

/**
 * Reconciles the 'Overview' tab in Google Sheets with live dynamic formulas.
 * Populates target month or current active month with self-updating formulas.
 */
export async function syncGoogleSheetOverview(targetMonth?: string): Promise<{ success: boolean; count: number }> {
  try {
    const res = await sheetsApi.syncOverview(targetMonth);
    if (res.success) {
      return { success: true, count: targetMonth ? 1 : 3 };
    }
    return { success: false, count: 0 };
  } catch (err) {
    console.warn('Overview sheet sync warning:', err);
    return { success: false, count: 0 };
  }
}

/**
 * Master sync function: Flushes offline queue, syncs Portfolio and Overview with Google Sheets.
 */
export async function syncAllGoogleSheets(): Promise<SyncResult> {
  // 1. Flush any pending offline queue to Google Sheets
  const flushRes = await sheetsData.flushPendingQueue().catch((err) => {
    console.warn('Pending queue flush notice:', err);
    return { total: 0, succeeded: 0, failed: 0 };
  });

  // 2. Proactively ensure persistent trades are synced to Google Sheets
  if (typeof window !== 'undefined') {
    try {
      const stored = localStorage.getItem('cashflow_persistent_trades');
      if (stored) {
        const trades = JSON.parse(stored);
        if (Array.isArray(trades) && trades.length > 0) {
          const validTrades = trades.filter((t: any) => {
            const tId = String(t.Id || t.id || '');
            const sym = String(t.Ticker || t.ticker || '').trim().toUpperCase();
            return !isRecordTombstoned(tId) && !isRecordTombstoned(sym);
          });
          if (validTrades.length > 0) {
            await sheetsApi.batchSyncTrades(validTrades).catch(() => null);
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // 3. Proactively sanitize all categories across Google Sheets so legacy groceries/food are merged into Food & Dining
  await sheetsApi.sanitizeCategories().catch((err) => {
    console.warn('Category sanitization notice:', err);
    return null;
  });

  // 4. Run atomic server-side Portfolio + Overview sync in a single LockService pass
  try {
    const allRes = await sheetsApi.syncAllSheets();
    if (allRes.success) {
      return {
        success: true,
        portfolioSynced: true,
        overviewSynced: true,
        pendingFlushedCount: flushRes.succeeded,
        holdingsCount: 1,
        monthsCount: allRes.data?.overviewMonthsSynced || 3,
        message: `Synchronized with Google Sheets${flushRes.succeeded > 0 ? ` and flushed ${flushRes.succeeded} offline changes` : ''}.`,
      };
    }
  } catch (err) {
    console.warn('syncAllSheets fallback notice:', err);
  }

  // Fallback to sequential Portfolio + Overview sync
  const portfolioRes = await syncGoogleSheetPortfolio();
  const overviewRes = await syncGoogleSheetOverview();

  const success = portfolioRes.success && overviewRes.success;
  return {
    success,
    portfolioSynced: portfolioRes.success,
    overviewSynced: overviewRes.success,
    pendingFlushedCount: flushRes.succeeded,
    holdingsCount: portfolioRes.count,
    monthsCount: overviewRes.count,
    message: success
      ? `Synchronized with Google Sheets${flushRes.succeeded > 0 ? ` and flushed ${flushRes.succeeded} offline changes` : ''}.`
      : 'Sync completed with warnings. Check your connection to Google Sheets.',
  };
}
