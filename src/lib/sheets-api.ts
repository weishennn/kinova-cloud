/**
 * API client for communicating with Google Apps Script backend.
 * All data flows through the Apps Script web app URL.
 * When no Apps Script URL is set (or when working offline), it transparently
 * uses local browser storage with ZERO dummy data so everything saved persists.
 */

import { getLocalDateString, getLocalMonthString } from './date-helper';
import { CACHE_MAX_AGE_MS, isMonthInRollingWindow, LOCAL_ONLY_ENDPOINT_SENTINEL, setLastSyncError, setLastSyncedAt, SYNC_STATUS_EVENT } from './cache-manager';
import type { RecurringCommitment } from './recurring-helper';
import type { StoredInstallmentPlan } from './installment-helper';

export const DEFAULT_APPS_SCRIPT_URL = '';
export const DEFAULT_APPS_SCRIPT_API_KEY = '';

const RETIRED_APPS_SCRIPT_IDS = [
  'AKfycbwvl06peRO7qqseyvUcbbb51JQ8fBdktCi8VHvgORA4i7_1I2HsbLLLCjFplTJ_j3XJ',
  'AKfycbxyjQHejJTr4h3BDwXa7Agwl9G9d-oe3WFhOyB-0_9Ad8cYX_0HFQIV0BxQqBXJsSiL',
];

export function isRetiredAppsScriptUrl(url: string): boolean {
  return RETIRED_APPS_SCRIPT_IDS.some((id) => url.includes(id));
}

export function getApiUrl(): string {
  if (typeof window !== 'undefined') {
    const customUrl = localStorage.getItem('cashflow_apps_script_url');
    if (customUrl === LOCAL_ONLY_ENDPOINT_SENTINEL) return '';

    // If user is signed in via Google OAuth, route through our /api/sheets Google Drive bridge
    if (localStorage.getItem('cashflow_google_authenticated') === 'true') {
      return `${window.location.origin}/api/sheets`;
    }

    if (customUrl) {
      const trimmed = customUrl.trim();
      if (isRetiredAppsScriptUrl(trimmed)) {
        localStorage.removeItem('cashflow_apps_script_url');
      } else if (trimmed.startsWith('https://script.google.com/macros/s/')) {
        return trimmed;
      }
    }
  }
  const envUrl = (process.env.NEXT_PUBLIC_APPS_SCRIPT_URL || '').trim();
  if (envUrl && !isRetiredAppsScriptUrl(envUrl)) {
    return envUrl;
  }
  return '';
}

export function setCustomApiUrl(url: string) {
  if (typeof window !== 'undefined') {
    const trimmed = url.trim();
    if (trimmed) {
      localStorage.setItem('cashflow_apps_script_url', trimmed);
    } else {
      localStorage.setItem('cashflow_apps_script_url', LOCAL_ONLY_ENDPOINT_SENTINEL);
    }
    localStorage.removeItem('cashflow_last_sync_error');
    localStorage.removeItem('cashflow_last_sync_error_at');
    window.dispatchEvent(new Event('cashflow_api_url_changed'));
    window.dispatchEvent(new CustomEvent(SYNC_STATUS_EVENT));
  }
}

export function getApiKey(): string {
  if (typeof window !== 'undefined') {
    const customKey = (localStorage.getItem('cashflow_api_key') || '').trim();
    if (customKey && customKey !== 'cashflow_secret_key_2026' && customKey.length >= 32) {
      return customKey;
    }
  }
  const envKey = (process.env.NEXT_PUBLIC_APPS_SCRIPT_API_KEY || '').trim();
  if (envKey && envKey !== 'cashflow_secret_key_2026' && envKey.length >= 32) {
    return envKey;
  }
  return DEFAULT_APPS_SCRIPT_API_KEY;
}

export function setCustomApiKey(key: string) {
  if (typeof window !== 'undefined') {
    if (key) {
      localStorage.setItem('cashflow_api_key', key.trim());
    } else {
      localStorage.removeItem('cashflow_api_key');
    }
  }
}

export function getServerProxyToken(): string {
  if (typeof window === 'undefined') return '';
  return (localStorage.getItem('cashflow_server_proxy_token') || '').trim();
}

export function setServerProxyToken(token: string): void {
  if (typeof window === 'undefined') return;
  if (token.trim()) localStorage.setItem('cashflow_server_proxy_token', token.trim());
  else localStorage.removeItem('cashflow_server_proxy_token');
}

export function getUseServerProxy(): boolean {
  if (typeof window === 'undefined') return false;
  if (localStorage.getItem('cashflow_google_authenticated') === 'true') {
    return true;
  }
  const pref = localStorage.getItem('cashflow_use_server_proxy');
  return pref === 'true';
}

export function setUseServerProxy(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem('cashflow_use_server_proxy', enabled ? 'true' : 'false');
}

export interface SecurityPosture {
  useServerProxy: boolean;
  hasClientSideKey: boolean;
  isPublicAppsScriptEndpoint: boolean;
  warnings: string[];
}

export function getSecurityPosture(): SecurityPosture {
  const useServerProxy = getUseServerProxy();
  const hasClientSideKey = Boolean(getApiKey());
  const apiUrl = getApiUrl();
  const isPublicAppsScriptEndpoint = apiUrl.includes('script.google.com/macros/s/');

  return {
    useServerProxy,
    hasClientSideKey,
    isPublicAppsScriptEndpoint,
    warnings: [],
  };
}

interface ApiRequestOptions {
  action: string;
  params?: Record<string, unknown>;
  method?: 'GET' | 'POST';
  /** Require a live server read instead of serving cached/local data. */
  fresh?: boolean;
}

// Local Storage Fallback Store (ZERO dummy data, purely real user inputs)
interface LocalStore {
  transactions: Record<string, unknown>[];
  portfolio: Record<string, unknown>[];
  trades: Record<string, unknown>[];
  trips: Record<string, unknown>[];
  invoices: Record<string, unknown>[];
  settings: Record<string, string>;
}

function getLocalStore(): LocalStore {
  if (typeof window === 'undefined') {
    return { transactions: [], portfolio: [], trades: [], trips: [], invoices: [], settings: { currency: 'MYR' } };
  }
  let raw: string | null;
  try {
    raw = localStorage.getItem('cashflow_local_store');
  } catch {
    throw new Error('Local database is unavailable in this browser. No data was changed.');
  }
  const emptyStore: LocalStore = {
    transactions: [],
    portfolio: [],
    trades: [],
    trips: [],
    invoices: [],
    settings: { currency: 'MYR' }
  };
  if (raw === null) return emptyStore;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Local database could not be read. It was left untouched; restore from a backup before writing locally.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Local database has an invalid format. It was left untouched; restore from a backup before writing locally.');
  }

  const stored = parsed as Record<string, unknown>;
  const listKeys = ['transactions', 'portfolio', 'trades', 'trips', 'invoices'] as const;
  for (const key of listKeys) {
    if (stored[key] !== undefined && !Array.isArray(stored[key])) {
      throw new Error(`Local database section "${key}" is invalid. The original data was left untouched.`);
    }
  }
  if (stored.settings !== undefined && (typeof stored.settings !== 'object' || stored.settings === null || Array.isArray(stored.settings))) {
    throw new Error('Local database settings are invalid. The original data was left untouched.');
  }

  // Fill fields introduced in newer app versions without discarding older records.
  return {
    transactions: (stored.transactions as LocalStore['transactions'] | undefined) || [],
    portfolio: (stored.portfolio as LocalStore['portfolio'] | undefined) || [],
    trades: (stored.trades as LocalStore['trades'] | undefined) || [],
    trips: (stored.trips as LocalStore['trips'] | undefined) || [],
    invoices: (stored.invoices as LocalStore['invoices'] | undefined) || [],
    settings: (stored.settings as LocalStore['settings'] | undefined) || { currency: 'MYR' },
  };
}

function saveLocalStore(store: LocalStore) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem('cashflow_local_store', JSON.stringify(store));
  } catch (e) {
    console.error('Failed to save local store', e);
    throw new Error('The local save failed because browser storage is full or unavailable. The change was not saved; free temporary cache space or reconnect to Google Sheets and try again.');
  }
}

function handleLocalRequest(action: string, params: Record<string, unknown> = {}): unknown {
  const store = getLocalStore();

  switch (action) {
    case 'getSheetData': {
      const sheetName = String(params.sheetName || 'Transactions');
      if (sheetName === 'Transactions' || /^\d{4}-\d{2}$/.test(sheetName)) {
        let rows = store.transactions;
        if (/^\d{4}-\d{2}$/.test(sheetName)) {
          rows = rows.filter(r => String(r.Date || r.date || '').startsWith(sheetName));
        }
        return {
          success: true,
          data: {
            headers: ['Id', 'Date', 'Type', 'Category', 'SubCategory', 'Description', 'Amount', 'Currency', 'TripTag', 'ReceiptUrl', 'Notes'],
            rows
          }
        };
      }
      if (sheetName === 'Portfolio') {
        return {
          success: true,
          data: {
            headers: ['Ticker', 'Asset Name', 'Type', 'Currency', 'Units Held', 'Avg Cost', 'Total Cost', 'Live Price', 'Market Value', 'Profit / Loss', 'Return %'],
            rows: store.portfolio
          }
        };
      }
      if (sheetName === 'Trades') {
        return {
          success: true,
          data: {
            headers: ['Id', 'Date', 'Action', 'Ticker', 'Asset Name', 'Quantity', 'Price', 'Fees', 'Net Total', 'Currency', 'Notes'],
            rows: store.trades.map((row, index) => ({ ...row, _rowIndex: index + 2 }))
          }
        };
      }
      if (sheetName === 'Trips') {
        return {
          success: true,
          data: {
            headers: ['Id', 'TripName', 'Destination', 'StartDate', 'EndDate', 'Budget', 'Currency', 'Status'],
            rows: store.trips
          }
        };
      }
      if (sheetName === 'Invoices') {
        return {
          success: true,
          data: {
            headers: ['Id', 'Date', 'Vendor', 'Amount', 'Currency', 'Url', 'Status', 'Notes'],
            rows: store.invoices
          }
        };
      }
      if (sheetName === 'Recurring') {
        let list = [];
        try {
          const raw = typeof window !== 'undefined' ? localStorage.getItem('cashflow_recurring_commitments') : null;
          list = raw ? JSON.parse(raw) : [];
        } catch {}
        return {
          success: true,
          data: {
            headers: ['Id', 'Name', 'Category', 'SubCategory', 'DayOfMonth', 'Amount', 'Currency', 'EffectiveFrom', 'AutoRecord', 'LastAutoRecordedMonth', 'Notes', 'History'],
            rows: list
          }
        };
      }
      if (sheetName === 'Installments') {
        let list = [];
        try {
          const raw = typeof window !== 'undefined' ? localStorage.getItem('cashflow_installment_plans') : null;
          list = raw ? JSON.parse(raw) : [];
        } catch {}
        return {
          success: true,
          data: {
            headers: ['Id', 'Name', 'Category', 'Currency', 'TotalPrincipal', 'TenureMonths', 'AnnualInterestRate', 'MonthlyAmount', 'TotalPayable', 'StartDate', 'EndDate', 'AutoRecord', 'TripTag', 'Notes'],
            rows: list
          }
        };
      }
      return { success: true, data: { headers: [], rows: [] } };
    }

    case 'getAllTransactions': {
      return {
        success: true,
        data: {
          headers: ['Id', 'Date', 'Type', 'Category', 'SubCategory', 'Description', 'Amount', 'Currency', 'TripTag', 'ReceiptUrl', 'Notes'],
          rows: store.transactions
        }
      };
    }

    case 'getMonthList': {
      const months = Array.from(new Set(
        store.transactions.map(t => String(t.Date || t.date || '').substring(0, 7)).filter(m => /^\d{4}-\d{2}$/.test(m))
      )).sort().reverse();
      const currentMonth = getLocalMonthString();
      if (!months.includes(currentMonth)) months.unshift(currentMonth);
      return { success: true, data: months };
    }

    case 'addRow': {
      const sheetName = String(params.sheetName || 'Transactions');
      const rowData = (params.rowData as Record<string, unknown>) || {};
      
      if (sheetName === 'Trips') {
        store.trips.unshift({ Id: `tr_${Date.now()}`, ...rowData });
      } else if (sheetName === 'Invoices') {
        store.invoices.unshift({ Id: `inv_${Date.now()}`, ...rowData });
      } else if (sheetName === 'Trades') {
        store.trades.unshift({ Id: `trade_${Date.now()}`, ...rowData });
      } else {
        // Month sheet or Transactions
        const id = String(rowData.Id || rowData.id || `tx_${Date.now()}`);
        const row = {
          Id: id,
          ...rowData,
          _month: sheetName
        };
        const existingIndex = store.transactions.findIndex((item) => String(item.Id || item.id || '') === id);
        if (existingIndex >= 0) {
          store.transactions[existingIndex] = { ...store.transactions[existingIndex], ...row };
        } else {
          store.transactions.unshift(row);
        }
      }
      saveLocalStore(store);
      return { success: true, data: { rowIndex: 2 } };
    }

    case 'addTrade': {
      const tradeData = (params.tradeData as Record<string, unknown>) || {};
      const tradeId = String(tradeData.Id || tradeData.id || `trade_${Date.now()}`);
      if (store.trades.some((row) => String(row.Id || row.id || '') === tradeId)) {
        return { success: true, data: { tradeId, idempotentReplay: true } };
      }
      const rawTicker = String(tradeData.Ticker || tradeData.ticker || '').toUpperCase();
      const rawAction = String(tradeData.Action || tradeData.action || 'BUY').toUpperCase();
      const rawQty = parseFloat(String(tradeData.Quantity || tradeData.quantity || 0)) || 0;
      const rawPrice = parseFloat(String(tradeData.Price || tradeData.price || 0)) || 0;
      const rawFees = parseFloat(String(tradeData.Fees || tradeData.fees || 0)) || 0;
      const rawTotal = parseFloat(String(tradeData.NetTotal || tradeData.total || (rawQty * rawPrice + (rawAction === 'BUY' ? rawFees : -rawFees)))) || (rawQty * rawPrice);
      const rawCurrency = String(tradeData.Currency || tradeData.currency || 'USD');
      const rawName = String(tradeData.AssetName || tradeData.assetName || tradeData.name || rawTicker);
      const rawDate = String(tradeData.Date || tradeData.date || getLocalDateString());
      const rawNotes = String(tradeData.Notes || tradeData.notes || '');
      const rawRateToMyr = parseFloat(String(tradeData.RateToMyr || tradeData.rateToMyr || 0)) || 0;
      const rawCostInMyr = parseFloat(String(tradeData.CostInMyr || tradeData.costInMyr || 0)) || (rawCurrency === 'MYR' ? rawTotal : (rawRateToMyr > 0 ? rawTotal * rawRateToMyr : 0));

      const newTrade = {
        Id: tradeId,
        id: tradeId,
        Date: rawDate,
        date: rawDate,
        Action: rawAction,
        action: rawAction,
        Ticker: rawTicker,
        ticker: rawTicker,
        'Asset Name': rawName,
        AssetName: rawName,
        name: rawName,
        Quantity: rawQty,
        quantity: rawQty,
        Price: rawPrice,
        price: rawPrice,
        Fees: rawFees,
        fees: rawFees,
        'Net Total': rawTotal,
        NetTotal: rawTotal,
        total: rawTotal,
        Currency: rawCurrency,
        currency: rawCurrency,
        RateToMyr: rawRateToMyr,
        rateToMyr: rawRateToMyr,
        CostInMyr: rawCostInMyr,
        costInMyr: rawCostInMyr,
        Notes: rawNotes,
        notes: rawNotes,
        Type: String(tradeData.Type || tradeData.type || 'Stock'),
      };
      store.trades.unshift(newTrade);

      // Update or insert into Portfolio holdings
      const ticker = String(tradeData.Ticker || tradeData.ticker || '').toUpperCase();
      const actionType = String(tradeData.Action || tradeData.action || 'BUY').toUpperCase();
      const qty = parseFloat(String(tradeData.Quantity || tradeData.quantity || 0)) || 0;
      const price = parseFloat(String(tradeData.Price || tradeData.price || 0)) || 0;
      const currency = String(tradeData.Currency || tradeData.currency || 'USD');
      const assetName = String(tradeData.AssetName || tradeData.assetName || ticker);

      if (ticker && qty > 0) {
        const existingIdx = store.portfolio.findIndex(p => String(p.Ticker || p.ticker || '').toUpperCase() === ticker);
        if (existingIdx !== -1) {
          const current = store.portfolio[existingIdx];
          const curUnits = parseFloat(String(current['Units Held'] || current.unitsHeld || 0)) || 0;
          const curAvgCost = parseFloat(String(current['Avg Cost'] || current.avgCost || 0)) || 0;
          
          if (actionType === 'BUY') {
            const newUnits = curUnits + qty;
            const newTotalCost = (curUnits * curAvgCost) + (qty * price);
            const newAvgCost = newUnits > 0 ? newTotalCost / newUnits : price;
            store.portfolio[existingIdx] = {
              ...current,
              'Units Held': newUnits,
              'Avg Cost': newAvgCost,
              'Total Cost': newTotalCost,
              'Live Price': price,
              'Market Value': newUnits * price,
              'Profit / Loss': 0,
              'Return %': 0
            };
          } else if (actionType === 'SELL') {
            const newUnits = Math.max(0, curUnits - qty);
            const newTotalCost = newUnits * curAvgCost;
            store.portfolio[existingIdx] = {
              ...current,
              'Units Held': newUnits,
              'Total Cost': newTotalCost,
              'Live Price': price,
              'Market Value': newUnits * price,
              'Profit / Loss': (price - curAvgCost) * qty,
              'Return %': curAvgCost > 0 ? ((price - curAvgCost) / curAvgCost) * 100 : 0
            };
          }
        } else if (actionType === 'BUY') {
          store.portfolio.push({
            Ticker: ticker,
            'Asset Name': assetName,
            Type: 'Stock',
            Currency: currency,
            'Units Held': qty,
            'Avg Cost': price,
            'Total Cost': qty * price,
            'Live Price': price,
            'Market Value': qty * price,
            'Profit / Loss': 0,
            'Return %': 0
          });
        }
      }
      saveLocalStore(store);
      return { success: true, data: { tradeId } };
    }

    case 'getPortfolio': {
      return { success: true, data: store.portfolio };
    }

    case 'getTrades': {
      return {
        success: true,
        data: {
          headers: ['Id', 'Date', 'Action', 'Ticker', 'Asset Name', 'Quantity', 'Price', 'Fees', 'Net Total', 'Currency', 'Notes'],
          rows: store.trades
        }
      };
    }

    case 'getOverview': {
      return { success: true, data: [] };
    }

    case 'updateRow': {
      const sheetName = String(params.sheetName || 'Transactions');
      const rowIndex = Number(params.rowIndex);
      const rowData = (params.rowData as Record<string, unknown>) || {};
      const id = String(rowData.Id || rowData.id || '');

      if (sheetName === 'Transactions' || /^\d{4}-\d{2}$/.test(sheetName)) {
        let txIdx = id ? store.transactions.findIndex(t => String(t.Id || t.id) === id) : -1;
        if (txIdx === -1 && rowIndex >= 2 && rowIndex - 2 < store.transactions.length) {
          txIdx = rowIndex - 2;
        } else if (txIdx === -1 && rowIndex >= 0 && rowIndex < store.transactions.length) {
          txIdx = rowIndex;
        }
        if (txIdx >= 0 && txIdx < store.transactions.length) {
          store.transactions[txIdx] = { ...store.transactions[txIdx], ...rowData };
          saveLocalStore(store);
        }
      } else if (sheetName === 'Trades') {
        const tradeIndex = id
          ? store.trades.findIndex(t => String(t.Id || t.id) === id)
          : (rowIndex > 1 ? rowIndex - 2 : rowIndex);
        if (tradeIndex >= 0 && tradeIndex < store.trades.length) {
          store.trades[tradeIndex] = { ...store.trades[tradeIndex], ...rowData };
          store.portfolio = [];
          saveLocalStore(store);
        }
      } else if (sheetName === 'Trips') {
        const tripIndex = id
          ? store.trips.findIndex(t => String(t.Id || t.id) === id || String(t.Name || t.name) === String(rowData.Name || rowData.name))
          : (rowIndex > 1 ? rowIndex - 2 : rowIndex);
        if (tripIndex >= 0 && tripIndex < store.trips.length) {
          store.trips[tripIndex] = { ...store.trips[tripIndex], ...rowData };
          saveLocalStore(store);
        }
      } else if (sheetName === 'Invoices') {
        const invIndex = id
          ? store.invoices.findIndex(inv => String(inv.Id || inv.id) === id)
          : (rowIndex > 1 ? rowIndex - 2 : rowIndex);
        if (invIndex >= 0 && invIndex < store.invoices.length) {
          store.invoices[invIndex] = { ...store.invoices[invIndex], ...rowData };
          saveLocalStore(store);
        }
      }
      return { success: true };
    }

    case 'deleteRow': {
      const sheetName = String(params.sheetName || 'Transactions');
      const id = String(params.id || '');
      const rowIndex = typeof params.rowIndex === 'number' ? params.rowIndex : -1;

      // Delete by ID across stores
      if (id) {
        const txIdx = store.transactions.findIndex(t => String(t.Id || t.id) === id);
        if (txIdx !== -1) {
          store.transactions.splice(txIdx, 1);
          saveLocalStore(store);
          return { success: true };
        }
        const tradeIdx = store.trades.findIndex(t => String(t.Id || t.id) === id);
        if (tradeIdx !== -1) {
          store.trades.splice(tradeIdx, 1);
          store.portfolio = [];
          saveLocalStore(store);
          return { success: true };
        }
        const tripIdx = store.trips.findIndex(t => String(t.Id || t.id) === id);
        if (tripIdx !== -1) {
          store.trips.splice(tripIdx, 1);
          saveLocalStore(store);
          return { success: true };
        }
        const invIdx = store.invoices.findIndex(t => String(t.Id || t.id) === id);
        if (invIdx !== -1) {
          store.invoices.splice(invIdx, 1);
          saveLocalStore(store);
          return { success: true };
        }
        // Never fall back to rowIndex when an explicit ID was provided
        return { success: true };
      }

      if (sheetName === 'Transactions' || /^\d{4}-\d{2}$/.test(sheetName)) {
        if (rowIndex >= 0 && rowIndex < store.transactions.length) {
          store.transactions.splice(rowIndex, 1);
          saveLocalStore(store);
        }
      } else if (sheetName === 'Trades') {
        if (rowIndex >= 0 && rowIndex < store.trades.length) {
          store.trades.splice(rowIndex, 1);
          store.portfolio = [];
          saveLocalStore(store);
        }
      } else if (sheetName === 'Trips') {
        if (rowIndex >= 0 && rowIndex < store.trips.length) {
          store.trips.splice(rowIndex, 1);
          saveLocalStore(store);
        }
      } else if (sheetName === 'Invoices') {
        if (rowIndex >= 0 && rowIndex < store.invoices.length) {
          store.invoices.splice(rowIndex, 1);
          saveLocalStore(store);
        }
      }
      return { success: true };
    }

    case 'getSettings':
      return { success: true, data: store.settings };

    case 'updateSettings': {
      const key = String(params.key);
      const value = String(params.value);
      store.settings[key] = value;
      saveLocalStore(store);
      return { success: true };
    }

    case 'uploadFile': {
      const base64Data = String(params.base64Data || '');
      const mimeType = String(params.mimeType || 'image/jpeg');
      const fileUrl = base64Data ? `data:${mimeType};base64,${base64Data}` : '';
      return {
        success: true,
        data: {
          fileId: `file_${Date.now()}`,
          url: fileUrl
        }
      };
    }

    case 'getFiles':
      return { success: true, data: [] };

    case 'deleteFile':
      return { success: true };

    case 'getRecurringCommitments': {
      let list = [];
      try {
        const raw = typeof window !== 'undefined' ? localStorage.getItem('cashflow_recurring_commitments') : null;
        list = raw ? JSON.parse(raw) : [];
      } catch {}
      return { success: true, data: list };
    }

    case 'saveRecurringCommitments': {
      const list = params.commitments || [];
      if (typeof window !== 'undefined') {
        localStorage.setItem('cashflow_recurring_commitments', JSON.stringify(list));
      }
      return { success: true, data: { saved: Array.isArray(list) ? list.length : 0 } };
    }

    case 'getInstallmentPlans': {
      let list = [];
      try {
        const raw = typeof window !== 'undefined' ? localStorage.getItem('cashflow_installment_plans') : null;
        list = raw ? JSON.parse(raw) : [];
      } catch {}
      return { success: true, data: list };
    }

    case 'saveInstallmentPlans': {
      const list = params.plans || [];
      if (typeof window !== 'undefined') {
        localStorage.setItem('cashflow_installment_plans', JSON.stringify(list));
      }
      return { success: true, data: { saved: Array.isArray(list) ? list.length : 0 } };
    }

    case 'setupRecurringAndInstallments':
      return { success: true, message: 'Local storage configured' };

    default:
      return { success: true, data: [] };
  }
}

export function parseCurrencyAmount(val: unknown): number {
  if (typeof val === 'number') return isNaN(val) ? 0 : val;
  if (!val) return 0;
  const str = String(val).trim();
  const cleaned = str.replace(/[^0-9.-]+/g, '');
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? 0 : parsed;
}

export function getActiveUserCacheScope(): string {
  if (typeof window === 'undefined') return 'anon';
  try {
    const email = (localStorage.getItem('cashflow_google_user_email') || '').trim().toLowerCase();
    if (email && localStorage.getItem('cashflow_google_authenticated') === 'true') {
      return `u:${email}`;
    }
    const customUrl = (localStorage.getItem('cashflow_apps_script_url') || '').trim();
    if (customUrl === LOCAL_ONLY_ENDPOINT_SENTINEL) return 'local_only';
    if (customUrl) return `script:${customUrl.slice(-16)}`;
  } catch {}
  return 'anon';
}

export function getSwrCacheKey(action: string, params: Record<string, unknown> = {}): string {
  const scope = getActiveUserCacheScope();
  const sortedParams = Object.keys(params).sort().reduce((acc, key) => {
    acc[key] = params[key];
    return acc;
  }, {} as Record<string, unknown>);
  return `cashflow_swr_${scope}_${action}_${JSON.stringify(sortedParams)}`;
}

export function getSwrCachedEntry<T>(action: string, params: Record<string, unknown> = {}): { data: T; savedAt: number } | null {
  if (typeof window === 'undefined') return null;
  try {
    const key = getSwrCacheKey(action, params);
    const raw = localStorage.getItem(key);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (!parsed) return null;

    // Check envelope timestamp constraints
    if (parsed && typeof parsed === 'object' && parsed.__swrVersion === 1) {
      const savedAt = typeof parsed.savedAt === 'number' ? parsed.savedAt : 0;
      if (Date.now() - savedAt > CACHE_MAX_AGE_MS) {
        localStorage.removeItem(key);
        return null;
      }
      return { data: parsed.data as T, savedAt };
    }

    // Backwards compatibility for legacy unwrapped cache items
    return { data: parsed as T, savedAt: Date.now() - 65_000 };
  } catch {
    // ignore
  }
  return null;
}

export function getSwrCachedData<T>(action: string, params: Record<string, unknown> = {}): T | null {
  const entry = getSwrCachedEntry<T>(action, params);
  return entry ? entry.data : null;
}

export function setSwrCachedData(action: string, params: Record<string, unknown>, data: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    // Do not cache full multi-year history dumps in persistent local storage
    if (action === 'getAllTransactions' && Boolean(params.all)) return;

    // Determine target month if this is a sheet query
    const targetMonth = typeof params.sheetName === 'string' && /^\d{4}-\d{2}$/.test(params.sheetName)
      ? params.sheetName
      : typeof params.month === 'string' && /^\d{4}-\d{2}$/.test(params.month)
        ? params.month
        : undefined;

    const key = getSwrCacheKey(action, params);
    const envelope = {
      __swrVersion: 1,
      savedAt: Date.now(),
      action,
      month: targetMonth,
      data,
    };
    localStorage.setItem(key, JSON.stringify(envelope));
  } catch {
    // ignore
  }
}

export function clearAllSwrCache(): void {
  if (typeof window === 'undefined') return;
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && (key.startsWith('cashflow_swr_') || key.startsWith('swr:'))) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((k) => localStorage.removeItem(k));
  } catch (e) {
    console.warn('Failed to clear SWR cache', e);
  }
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = 25000): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    return res;
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  }
}

let mutatingRequestQueue: Promise<unknown> = Promise.resolve();

function enqueueMutatingRequest<T>(task: () => Promise<T>): Promise<T> {
  const next = mutatingRequestQueue.then(task, task);
  mutatingRequestQueue = next.catch(() => {});
  return next;
}

export async function apiRequest<T>(options: ApiRequestOptions): Promise<T> {
  const { action, params = {}, method = 'GET', fresh = false } = options;
  // Automated UI checks run in a disposable browser profile. Keep every read
  // and write on its local test store so they can never touch the configured
  // live Apps Script endpoint, including background sync and backup actions.
  if (typeof window !== 'undefined' && localStorage.getItem('cashflow_test_mode') === 'true') {
    return handleLocalRequest(action, params) as T;
  }
  const isMutating = method === 'POST';
  const apiUrl = getApiUrl();

  if (!apiUrl || !apiUrl.startsWith('http')) {
    // Transparent Local Storage Persistence
    return handleLocalRequest(action, params) as T;
  }

  if (isMutating) {
    return enqueueMutatingRequest(() => executeApiRequest<T>({ action, params, method, fresh }));
  }

  return executeApiRequest<T>({ action, params, method, fresh });
}

async function executeApiRequest<T>(options: ApiRequestOptions): Promise<T> {
  const { action, params = {}, method = 'GET', fresh = false } = options;
  const isMutating = method === 'POST';
  const apiUrl = getApiUrl();
  const useProxy = typeof window !== 'undefined' && getUseServerProxy();
  const requestStartedAt = Date.now();

  try {
    const apiKey = getApiKey();
    const proxyToken = getServerProxyToken();

    const isInternalProxyUrl = !apiUrl.includes('script.google.com/macros/s/');

    if (useProxy || isInternalProxyUrl) {
      try {
        const proxyHeaders: Record<string, string> = {};
        if (proxyToken) {
          proxyHeaders['x-cashflow-proxy-token'] = proxyToken;
        }

        if (method === 'GET') {
          const proxyUrl = new URL('/api/sheets', window.location.origin);
          proxyUrl.searchParams.set('action', action);
          proxyUrl.searchParams.set('_t', String(Date.now()));
          if (fresh) proxyUrl.searchParams.set('_fresh', String(Date.now()));
          Object.entries(params).forEach(([key, value]) => {
            if (value === undefined) return;
            proxyUrl.searchParams.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
          });

          const proxyRes = await fetchWithTimeout(proxyUrl.toString(), {
            method: 'GET',
            headers: proxyHeaders,
            credentials: 'same-origin',
            cache: 'no-store',
          }, 25000);

          const data = await proxyRes.json().catch(() => null);
          if (proxyRes.status === 403 && data?.blocked) {
            window.dispatchEvent(new Event('cashflow_account_blocked'));
            throw new Error(data.message || 'Account restricted by administrator.');
          }
          if (proxyRes.ok && data) {
            recordCloudResponse(data, requestStartedAt, action);
            if (data.success && !fresh) {
              setSwrCachedData(action, params, data);
            }
            return data;
          }
          if (isInternalProxyUrl) {
            throw new Error(data?.message || `Google Drive sync HTTP ${proxyRes.status}`);
          }
        } else {
          const proxyRes = await fetchWithTimeout('/api/sheets', {
            method: 'POST',
            headers: {
              ...proxyHeaders,
              'Content-Type': 'application/json',
            },
            credentials: 'same-origin',
            body: JSON.stringify({ action, ...params }),
          }, 25000);

          const data = await proxyRes.json().catch(() => null);
          if (proxyRes.status === 403 && data?.blocked) {
            window.dispatchEvent(new Event('cashflow_account_blocked'));
            throw new Error(data.message || 'Account restricted by administrator.');
          }
          if (proxyRes.ok && data) {
            recordCloudResponse(data, requestStartedAt, action);
            return data;
          }
          if (isInternalProxyUrl) {
            throw new Error(data?.message || `Google Drive sync HTTP ${proxyRes.status}`);
          }
        }
      } catch (proxyErr) {
        if (isInternalProxyUrl) {
          throw proxyErr;
        }
        console.warn(`[SheetsAPI] Proxy request failed for ${action}, falling back to direct Apps Script:`, proxyErr);
      }
    }

    // Direct Apps Script call (default 1-hop fast path & automatic fallback)
    const runDirectRequest = async (targetEndpointUrl: string, activeKey: string) => {
      const url = new URL(targetEndpointUrl);
      url.searchParams.set('apiKey', activeKey);
      if (method === 'GET') {
        url.searchParams.set('action', action);
        if (!('key' in params)) {
          url.searchParams.set('key', activeKey);
        }
        url.searchParams.set('_t', String(Date.now()));
        if (fresh) url.searchParams.set('_fresh', String(Date.now()));
        Object.entries(params).forEach(([key, value]) => {
          if (value === undefined) return;
          url.searchParams.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
        });
        const response = await fetchWithTimeout(url.toString(), { method: 'GET', cache: 'no-store' }, 25000);
        if (!response.ok) throw new Error(`API Error: ${response.status}`);
        return await response.json();
      } else {
        // Mutating POST request — place apiKey after ...params so params.key (e.g. updateSettings) never overwrites apiKey
        const response = await fetchWithTimeout(url.toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ action, key: activeKey, ...params, apiKey: activeKey }),
        }, 25000);
        if (!response.ok) throw new Error(`API Error: ${response.status}`);
        return await response.json();
      }
    };

    const runDirectWithRetry = async (targetEndpointUrl: string, activeKey: string) => {
      try {
        const firstRes = await runDirectRequest(targetEndpointUrl, activeKey);
        if (
          isMutating &&
          firstRes &&
          firstRes.success === false &&
          String(firstRes.message || '').toLowerCase().includes('lock timeout')
        ) {
          await new Promise((r) => setTimeout(r, 1200));
          return await runDirectRequest(targetEndpointUrl, activeKey);
        }
        return firstRes;
      } catch (firstErr) {
        if (isMutating) {
          await new Promise((r) => setTimeout(r, 1200));
          return await runDirectRequest(targetEndpointUrl, activeKey);
        }
        throw firstErr;
      }
    };

    let data = await runDirectWithRetry(apiUrl, apiKey);
    if (
      data &&
      data.success === false &&
      String(data.message || '').includes('Invalid API Key') &&
      DEFAULT_APPS_SCRIPT_API_KEY &&
      apiKey !== DEFAULT_APPS_SCRIPT_API_KEY
    ) {
      if (typeof window !== 'undefined') {
        localStorage.removeItem('cashflow_api_key');
      }
      data = await runDirectWithRetry(apiUrl, DEFAULT_APPS_SCRIPT_API_KEY);
    }

    if (
      data &&
      data.success === false &&
      String(data.message || '').includes('Unknown action') &&
      DEFAULT_APPS_SCRIPT_URL &&
      apiUrl !== DEFAULT_APPS_SCRIPT_URL
    ) {
      if (typeof window !== 'undefined') {
        localStorage.setItem('cashflow_apps_script_url', DEFAULT_APPS_SCRIPT_URL);
      }
      data = await runDirectWithRetry(DEFAULT_APPS_SCRIPT_URL, DEFAULT_APPS_SCRIPT_API_KEY);
    }

    recordCloudResponse(data, requestStartedAt, action);
    if (method === 'GET' && data && data.success && !fresh) {
      setSwrCachedData(action, params, data);
    }
    return data;
  } catch (netErr: unknown) {
    const errorMsg = netErr instanceof Error ? netErr.message : String(netErr);
    setLastSyncError(errorMsg);
    if (isMutating) {
      console.error(`[Cloud Sync Failed] ${action}: ${errorMsg}`);
      throw new Error(`Google Sheets write failed or timed out. Check the sheet before retrying. (${errorMsg})`);
    }

    if (fresh) {
      throw new Error(`Google Sheets could not be reached for a fresh ${action} read. (${errorMsg})`);
    }

    // On GET error/timeout: check if we have cached data first so UI doesn't blank out
    const cached = getSwrCachedData<T>(action, params);
    if (cached) {
      console.warn(`[Cloud Sync Network Issue] ${action}: ${errorMsg}. Serving persistent SWR cache.`);
      return cached;
    }

    // Do not silently mix the separate local-only database into a cloud read.
    // If the Sheet is unavailable and no cached response exists, surface the
    // failure so the UI cannot present another data source as Sheet data.
    console.warn(`[Cloud Sync Failed] ${action}: ${errorMsg}. No cached response is available.`);
    throw new Error(`Google Sheets could not load ${action}, and no cached copy is available. Check the connection and retry. (${errorMsg})`);
  }
}

function recordCloudResponse(response: unknown, requestStartedAt: number, action?: string): void {
  if (!response || typeof response !== 'object') {
    setLastSyncError('The server returned an invalid response.');
    return;
  }
  const result = response as { success?: unknown; message?: unknown };
  if (result.success === true) {
    setLastSyncedAt(Date.now(), requestStartedAt);
  } else {
    const msg = typeof result.message === 'string' ? result.message : 'The server rejected the request.';
    if (
      msg.includes('Unknown action') ||
      ((action === 'deleteRow' || action === 'updateRow') &&
        (msg.includes('not found') || msg.includes('No valid ID or rowIndex') || msg.includes('Invalid row index')))
    ) {
      setLastSyncedAt(Date.now(), requestStartedAt);
      return;
    }
    setLastSyncError(msg);
  }
}

// Sheet operations
export const sheetsApi = {
  getSheetData: (sheetName: string, params: Record<string, unknown> = {}) =>
    apiRequest<{ success: boolean; data: { headers: string[]; rows: Record<string, unknown>[] } }>(
      { action: 'getSheetData', params: { sheetName, ...params } }
    ),

  getAllTransactions: (options: boolean | { all?: boolean; limitMonths?: number; year?: string } = false) => {
    const params: Record<string, unknown> =
      typeof options === 'boolean'
        ? options ? { all: true } : {}
        : {
            ...(options.all ? { all: true } : {}),
            ...(options.limitMonths ? { limitMonths: options.limitMonths } : {}),
            ...(options.year ? { year: options.year } : {}),
          };
    return apiRequest<{ success: boolean; data: { headers: string[]; rows: Record<string, unknown>[] } }>(
      { action: 'getAllTransactions', params }
    );
  },

  getMonthList: (fresh = false) =>
    apiRequest<{ success: boolean; data: string[] }>({ action: 'getMonthList', fresh }),

  getSheetSchema: (sheetName: string) =>
    apiRequest<{ success: boolean; data: { headers: string[]; rowCount: number } }>(
      { action: 'getSheetSchema', params: { sheetName } }
    ),

  getAllSheetNames: () =>
    apiRequest<{ success: boolean; data: string[] }>({ action: 'getAllSheetNames' }),

  addRow: (sheetName: string, rowData: Record<string, unknown>, mutationId?: string) =>
    apiRequest<{
      success: boolean;
      data?: {
        rowIndex: number;
        sheet: string;
        verified?: boolean;
        verifiedId?: string;
        deduplicated?: boolean;
      };
      message?: string;
    }>(
      { action: 'addRow', params: { sheetName, rowData, mutationId }, method: 'POST' }
    ),

  addTrade: (tradeData: Record<string, unknown>) =>
    apiRequest<{ success: boolean; data: { tradeId?: string } }>(
      {
        action: 'addTrade',
        params: {
          tradeData,
          mutationId: tradeData.Id || tradeData.id ? `add_trade_${String(tradeData.Id || tradeData.id)}` : undefined,
        },
        method: 'POST',
      }
    ),

  getPortfolio: () =>
    apiRequest<{ success: boolean; data: Record<string, unknown>[] }>(
      { action: 'getPortfolio' }
    ),

  getTrades: () =>
    apiRequest<{ success: boolean; data: { headers: string[]; rows: Record<string, unknown>[] } }>(
      { action: 'getTrades' }
    ),

  getOverview: () =>
    apiRequest<{ success: boolean; data: Record<string, unknown>[] }>(
      { action: 'getOverview' }
    ),

  updateRow: (sheetName: string, rowIndex: number, rowData: Record<string, unknown>, mutationId?: string) =>
    apiRequest<{
      success: boolean;
      data?: {
        rowIndex: number;
        sheet: string;
        movedFrom?: string;
        movedTo?: string;
        verified?: boolean;
        verifiedId?: string;
        deduplicated?: boolean;
      };
      message?: string;
    }>(
      { action: 'updateRow', params: { sheetName, rowIndex, rowData, mutationId }, method: 'POST' }
    ),

  deleteRow: (sheetName: string, rowIndex?: number, id?: string, mutationId?: string) =>
    apiRequest<{
      success: boolean;
      data?: {
        rowIndex: number;
        sheet: string;
        alreadyDeleted?: boolean;
        verified?: boolean;
        verifiedId?: string;
        deduplicated?: boolean;
      };
      message?: string;
    }>(
      { action: 'deleteRow', params: { sheetName, rowIndex, id, mutationId }, method: 'POST' }
    ),

  getFilteredData: (sheetName: string, filters: Record<string, unknown>) =>
    apiRequest<{ success: boolean; data: { headers: string[]; rows: Record<string, unknown>[] } }>(
      { action: 'getFilteredData', params: { sheetName, filters } }
    ),

  getSettings: (fresh = false) =>
    apiRequest<{ success: boolean; data: Record<string, string> }>({ action: 'getSettings', fresh }),

  updateSettings: (key: string, value: string, mutationId?: string) =>
    apiRequest<{
      success: boolean;
      data?: {
        key: string;
        updated: boolean;
        verified?: boolean;
        deduplicated?: boolean;
      };
      message?: string;
    }>(
      { action: 'updateSettings', params: { key, value, mutationId }, method: 'POST' }
    ),

  getRecurringCommitments: (fresh = false) =>
    apiRequest<{ success: boolean; data: RecurringCommitment[] }>({ action: 'getRecurringCommitments', fresh }),

  saveRecurringCommitments: (commitments: RecurringCommitment[]) =>
    apiRequest<{ success: boolean; data: { saved: number } }>(
      { action: 'saveRecurringCommitments', params: { commitments }, method: 'POST' }
    ),

  getInstallmentPlans: (fresh = false) =>
    apiRequest<{ success: boolean; data: StoredInstallmentPlan[] }>({ action: 'getInstallmentPlans', fresh }),

  saveInstallmentPlans: (plans: StoredInstallmentPlan[]) =>
    apiRequest<{ success: boolean; data: { saved: number } }>(
      { action: 'saveInstallmentPlans', params: { plans }, method: 'POST' }
    ),

  setupRecurringAndInstallments: () =>
    apiRequest<{ success: boolean; message: string }>({ action: 'setupRecurringAndInstallments' }),

  getBackupStatus: (fresh = false) =>
    apiRequest<{
      success: boolean;
      data: {
        triggerInstalled?: boolean;
        lastBackupAt: string | null;
        lastBackupFileId: string | null;
        lastBackupName?: string | null;
        lastBackupVerified?: boolean;
        lastBackupStale?: boolean;
        backupHealth?: 'healthy' | 'stale' | 'unverified' | 'missing';
        sheetCount?: number;
        totalRows?: number;
        retentionPolicy?: { maxWeekly: number; maxMigration: number };
      };
      message?: string;
    }>({ action: 'getBackupStatus', fresh }),

  installWeeklyBackup: () =>
    apiRequest<{
      success: boolean;
      data: {
        installed: boolean;
        cadence: string;
        timezone: string;
        triggerInstalled?: boolean;
        lastBackupAt?: string | null;
        lastBackupFileId?: string | null;
        lastBackupName?: string | null;
      };
      message?: string;
    }>({ action: 'installWeeklyBackup', method: 'POST' }),

  ensureWeeklyBackup: () =>
    apiRequest<{
      success: boolean;
      data: {
        triggerInstalled: boolean;
        lastBackupAt: string | null;
        lastBackupFileId: string | null;
        lastBackupName?: string | null;
        lastBackupVerified?: boolean;
        lastBackupStale?: boolean;
        backupHealth?: 'healthy' | 'stale' | 'unverified' | 'missing';
      };
      message?: string;
    }>({ action: 'ensureWeeklyBackup', method: 'POST' }),

  createDriveSnapshot: () =>
    apiRequest<{
      success: boolean;
      data: {
        created: boolean;
        fileId: string;
        name: string;
        createdAt: string;
        verified?: boolean;
        sheetCount?: number;
        totalRows?: number;
        triggerInstalled?: boolean;
      };
      message?: string;
    }>({ action: 'createDriveSnapshot', method: 'POST' }),

  listBackups: () =>
    apiRequest<{
      success: boolean;
      data: Array<{
        id: string;
        name: string;
        createdAt: string;
        url: string;
        sizeBytes?: number;
        kind?: 'migration_or_safety' | 'scheduled_weekly';
      }>;
      message?: string;
    }>({ action: 'listBackups', fresh: true }),

  verifyBackup: (fileId: string) =>
    apiRequest<{
      success: boolean;
      data: {
        exists: boolean;
        verified: boolean;
        fileId?: string;
        name?: string;
        createdAt?: string;
        ageMs?: number;
        isStale?: boolean;
        sheetCount?: number;
        totalRows?: number;
        verifiedSheets?: Array<{ name: string; rowCount: number; headerValid: boolean }>;
      };
      message?: string;
    }>({ action: 'verifyCashFlowBackup', params: { fileId }, method: 'POST' }),

  restoreBackup: (fileId: string) =>
    apiRequest<{
      success: boolean;
      data: {
        restored: boolean;
        verified?: boolean;
        restoredFromId: string;
        restoredFromName: string;
        safetyBackupId: string;
        safetyBackupName?: string;
        sheetsRestored: number;
        totalRowsRestored?: number;
        sheetSummaries?: Array<{ name: string; rows: number }>;
      };
      message?: string;
    }>({ action: 'restoreBackup', params: { fileId }, method: 'POST' }),

  testRestoreBackup: (fileId: string) =>
    apiRequest<{
      success: boolean;
      data: {
        passed: boolean;
        testedAt: string;
        sourceFileId: string;
        sourceName: string;
        sheetsTested: number;
        totalRowsVerified: number;
        overviewFormulaMatches: number;
        discrepancies: string[];
        sheetReports: Array<{
          name: string;
          rows: number;
          headersMatch: boolean;
          rowCountMatch: boolean;
          idsMatch: boolean;
        }>;
      };
      message?: string;
    }>({ action: 'testRestoreBackup', params: { fileId }, method: 'POST' }),

  runIntegrityCheck: () =>
    apiRequest<{
      success: boolean;
      data: {
        healthy: boolean;
        checkedAt: string;
        summary: {
          monthlySheetsChecked: number;
          totalTransactions: number;
          duplicateIdCount: number;
          missingFieldCount: number;
          invalidDateCount: number;
          overviewFormulasHealthy: boolean;
          apiKeyConfigured?: boolean;
        };
        issues: Array<{
          severity: 'error' | 'warning';
          sheet: string;
          row?: number;
          type: string;
          message: string;
        }>;
      };
      message?: string;
    }>({ action: 'runIntegrityCheck', fresh: true }),

  configureEndpointApiKey: (newKey: string) =>
    apiRequest<{
      success: boolean;
      data: {
        configured: boolean;
        updatedAt: string;
      };
      message?: string;
    }>({ action: 'configureEndpointApiKey', params: { newKey }, method: 'POST' }),

  syncAllSheets: () =>
    apiRequest<{
      success: boolean;
      data?: {
        portfolioSynced?: boolean;
        overviewMonthsSynced?: number;
      };
      message?: string;
    }>({ action: 'syncAll', method: 'POST' }),

  syncPortfolio: () =>
    apiRequest<{ success: boolean; data?: { synced: boolean; sheet: string }; message?: string }>({
      action: 'syncPortfolio',
      method: 'POST',
    }),

  syncOverview: (month?: string) =>
    apiRequest<{ success: boolean; data?: { synced: boolean; sheet: string }; message?: string }>({
      action: 'syncOverview',
      params: month ? { month } : {},
      method: 'POST',
    }),

  reconcilePlans: (kind: 'recurring' | 'installments', mutations: unknown[], initialRecords?: unknown[]) =>
    apiRequest<{
      success: boolean;
      data: {
        success: boolean;
        verified?: boolean;
        kind: string;
        envelope: {
          version: 1;
          entries: Array<{ id: string; changedAt: number; version?: number; deleted: boolean; record?: unknown }>;
        };
        activeRecords: unknown[];
        activeCount?: number;
        tombstoneCount?: number;
        conflicts?: Array<{
          entityId: string;
          kind: string;
          serverChangedAt: number;
          clientMutationChangedAt: number;
          serverRecord: unknown;
          clientRecord: unknown;
          resolution: string;
        }>;
      };
      message?: string;
    }>({ action: 'reconcilePlans', params: { kind, mutations, initialRecords }, method: 'POST' }),
};

// Drive operations
export const driveApi = {
  uploadFile: (fileName: string, mimeType: string, base64Data: string, folderId?: string) =>
    apiRequest<{ success: boolean; data: { fileId: string; url: string } }>(
      { action: 'uploadFile', params: { fileName, mimeType, base64Data, folderId }, method: 'POST' }
    ),

  getFiles: (folderId?: string, filters?: Record<string, unknown>) =>
    apiRequest<{ success: boolean; data: Array<{ id: string; name: string; mimeType: string; url: string; thumbnailUrl: string; createdTime: string }> }>(
      { action: 'getFiles', params: { folderId, filters } }
    ),

  deleteFile: (fileId: string) =>
    apiRequest<{ success: boolean }>(
      { action: 'deleteFile', params: { fileId }, method: 'POST' }
    ),
};
