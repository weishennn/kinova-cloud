import { sheetsApi } from '@/lib/sheets-api';
import { sheetsData } from '@/lib/sheets-data';

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

  // 2. Proactively sanitize all categories across Google Sheets so legacy groceries/food are merged into Food & Dining
  await sheetsApi.sanitizeCategories().catch((err) => {
    console.warn('Category sanitization notice:', err);
    return null;
  });

  // 3. Run server-side Portfolio, Moomoo Flow, and Overview reconciliation.
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
