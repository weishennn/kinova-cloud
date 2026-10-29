export const MOOMOO_SYNC_STATE_KEY = 'moomoo_sync_state_v2';
export const MOOMOO_FULL_SYNC_START_MS = Date.UTC(2000, 0, 1);
export const MOOMOO_SYNC_OVERLAP_MS = 48 * 60 * 60 * 1000;

const ENABLE_MARKET_TO_TRD_MARKET: Record<number, string> = {
  1: 'HK',
  2: 'US',
  4: 'HKCC',
  5: 'FUTURES',
  6: 'SG',
  8: 'AU',
  9: 'FOREX',
  11: 'MY',
  12: 'CA',
  15: 'JP',
  17: 'PREDICTION',
  18: 'KR',
};

export interface MoomooSyncState {
  version: 2;
  lastSyncAt: string;
  accountLastSyncAt: Record<string, string>;
  flowSyncVersion?: 1;
}

/**
 * Resolves only real trading account IDs returned by authorized_trd_accs.
 * Universal-account card numbers and Moomoo user IDs are not account IDs.
 */
export function selectMoomooAuthorizedAccounts<T extends Record<string, unknown>>(
  accounts: T[],
  configuredAccountId?: string
): T[] {
  const withAccountId = accounts.filter((account) => String(account.account_id ?? '').trim());
  const requestedId = String(configuredAccountId || '').trim();
  if (!requestedId) return withAccountId;

  const selected = withAccountId.filter((account) => String(account.account_id).trim() === requestedId);
  if (selected.length === 0) {
    throw new Error(
      'MOOMOO_ACCOUNT_ID did not match an authorized account_id. Use the full account_id from Moomoo OpenAPI; a Universal Account card number or Moomoo user ID is not the trading account ID.'
    );
  }
  return selected;
}

/** Resolves the trd_market values required by Moomoo order-history requests. */
export function getMoomooTradingMarkets(account: Record<string, unknown>): string[] {
  const enabledMarkets = Array.isArray(account.enable_market) ? account.enable_market : [];
  return [...new Set(enabledMarkets
    .map((value) => ENABLE_MARKET_TO_TRD_MARKET[Number(value)])
    .filter((market): market is string => Boolean(market)))];
}

function asFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseMoomooDate(value: unknown): string {
  if (value === null || value === undefined || String(value).trim() === '') return '';
  if (typeof value === 'number' || /^\d+$/.test(String(value).trim())) {
    const numeric = Number(value);
    const milliseconds = numeric > 1e14 ? numeric / 1000 : numeric > 1e11 ? numeric : numeric > 1e8 ? numeric * 1000 : NaN;
    if (Number.isFinite(milliseconds)) {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kuala_Lumpur',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(new Date(milliseconds));
      const datePart = (type: string) => parts.find((part) => part.type === type)?.value || '';
      return `${datePart('year')}-${datePart('month')}-${datePart('day')}`;
    }
  }

  const text = String(value).trim();
  const isoDate = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoDate) return isoDate[1];
  const slashDate = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (slashDate) {
    return `${slashDate[3]}-${slashDate[1].padStart(2, '0')}-${slashDate[2].padStart(2, '0')}`;
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return '';
  return parseMoomooDate(parsed.getTime());
}

export function parseMoomooSyncState(value: unknown): MoomooSyncState | null {
  let raw: unknown = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== 'object') return null;
  const state = raw as Record<string, unknown>;
  if (state.version !== 2) return null;
  const lastSyncAt = typeof state.lastSyncAt === 'string' ? state.lastSyncAt : '';
  const accountLastSyncAt = state.accountLastSyncAt && typeof state.accountLastSyncAt === 'object'
    ? Object.fromEntries(
        Object.entries(state.accountLastSyncAt as Record<string, unknown>)
          .filter(([, timestamp]) => typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp)))
          .map(([accountId, timestamp]) => [accountId, timestamp as string])
      )
    : {};
  if (!lastSyncAt && Object.keys(accountLastSyncAt).length === 0) return null;
  return {
    version: 2,
    lastSyncAt,
    accountLastSyncAt,
    ...(Number(state.flowSyncVersion) === 1 ? { flowSyncVersion: 1 as const } : {}),
  };
}

export function getMoomooSyncStartMs(lastSyncAt: string | undefined): number {
  if (!lastSyncAt || !Number.isFinite(Date.parse(lastSyncAt))) return MOOMOO_FULL_SYNC_START_MS;
  return Math.max(MOOMOO_FULL_SYNC_START_MS, Date.parse(lastSyncAt) - MOOMOO_SYNC_OVERLAP_MS);
}

export function makeMoomooTradeId(accountId: string, orderId: string): string {
  return `moo_${accountId}_${orderId}`;
}

export function findMoomooOrderTradeIndex(
  rows: Array<Record<string, unknown>>,
  accountId: string,
  orderId: string
): number {
  const stableId = makeMoomooTradeId(accountId, orderId);
  return rows.findIndex((row) => {
    const id = String(row.Id || row.id || '');
    if (id === stableId) return true;
    const notes = String(row.Notes || row.notes || '');
    const notedOrderId = notes.match(/\bOrder:\s*([^;\s)]+)/i)?.[1] || '';
    const notedAccountId = notes.match(/\bAccount:\s*([^;\s)]+)/i)?.[1] || '';
    if (id === `moo_${orderId}`) return !notedAccountId || notedAccountId === accountId;
    return Boolean(orderId && notedOrderId === orderId && notedAccountId === accountId);
  });
}

export function calculateMoomooNetTotal(action: string, quantity: number, price: number, fees: number): number {
  const gross = quantity * price;
  return Number((action === 'SELL' ? gross - fees : gross + fees).toFixed(2));
}

export function normalizeMoomooOrder(
  order: Record<string, unknown>,
  accountId: string,
  feeInfo?: { totalFee?: unknown; currency?: unknown; items?: Array<{ type?: unknown; amount?: unknown }> }
): Record<string, unknown> | null {
  const orderId = String(order.order_id || order.orderId || '').trim();
  const ticker = String(order.code || order.symbol || '').replace(/^(US\.|HK\.|MY\.|SG\.|JP\.|AU\.)/i, '').trim().toUpperCase();
  const quantity = asFiniteNumber(order.dealt_qty ?? order.dealtQty ?? order.filled_qty ?? order.filledQty) ?? 0;
  const price = asFiniteNumber(order.dealt_avg_price ?? order.dealtAvgPrice ?? order.avg_price ?? order.avgPrice) ?? 0;
  const rawSide = String(order.side || order.trd_side || order.action || '').toUpperCase();
  const action = rawSide.includes('SELL') ? 'SELL' : rawSide.includes('BUY') ? 'BUY' : '';
  const date = parseMoomooDate(order.dealt_time || order.deal_time || order.updated_time || order.update_time || order.create_time || order.time);
  if (!orderId || !ticker || !action || quantity <= 0 || price <= 0 || !date) return null;

  const feeValue = asFiniteNumber(feeInfo?.totalFee);
  const fallbackFee = asFiniteNumber(order.dealt_fee ?? order.fee ?? order.fees ?? order.total_fee ?? order.commission);
  const fees = Math.abs(feeValue ?? fallbackFee ?? 0);
  const currency = String(order.currency || feeInfo?.currency || 'USD').trim().toUpperCase();
  const feeItems = (feeInfo?.items || [])
    .map((item) => {
      const type = String(item.type || '').trim();
      const amount = asFiniteNumber(item.amount);
      return type && amount !== null ? `${type} ${Math.abs(amount).toFixed(2)}` : '';
    })
    .filter(Boolean);
  const feeNote = feeItems.length > 0 ? `; Fee breakdown: ${feeItems.join(', ')}` : '';
  const feeSyncNote = feeInfo && (feeValue !== null || feeItems.length > 0) ? '; Fee sync: confirmed' : '';
  const accountNote = accountId ? `Account: ${accountId}; ` : '';

  return {
    Id: makeMoomooTradeId(accountId, orderId),
    Date: date,
    Action: action,
    Ticker: ticker,
    'Asset Name': String(order.stock_name || order.name || ticker),
    Quantity: quantity,
    Price: price,
    Fees: fees,
    'Net Total': calculateMoomooNetTotal(action, quantity, price, fees),
    Currency: currency,
    Notes: `Moomoo Auto-Sync (${accountNote}Order: ${orderId}${feeSyncNote}${feeNote})`,
  };
}

