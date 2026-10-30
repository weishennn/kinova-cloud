import { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { sheetsApi, getApiUrl, getSwrCachedEntry, setSwrCachedData, clearAllSwrCache } from '@/lib/sheets-api';
import { syncAllGoogleSheets } from '@/lib/sync-engine';
import { sheetsData, collectLocallyKnownMonths } from '@/lib/sheets-data';
import { isRecordTombstoned } from '@/lib/data-integrity';

export function shouldUseGoogleSheets(): boolean {
  return !!getApiUrl();
}

export async function getUnifiedSheetData(sheetName: string, selectedPeriod?: string) {
  if (sheetName === 'Transactions') {
    return sheetsData.getAllTransactions(selectedPeriod);
  }
  return sheetsData.getSheetData(sheetName);
}

export async function getUnifiedSheetSchema(sheetName: string) {
  const res = await sheetsApi.getSheetSchema(sheetName);
  return res.data || { headers: [], rowCount: 0 };
}

export async function getUnifiedAllSheetNames(): Promise<string[]> {
  const res = await sheetsApi.getAllSheetNames();
  return res.data || [];
}

export async function getUnifiedMonthList(): Promise<string[]> {
  return sheetsData.getMonthList();
}

export function useMonthList() {
  const initial = getSwrCachedEntry<{ success: boolean; data: string[] }>('getMonthList', {});
  const localMonths = collectLocallyKnownMonths();
  const rawMonths: string[] = Array.isArray(initial?.data)
    ? initial.data
    : Array.isArray(initial?.data?.data)
      ? initial.data.data
      : [];
  const initialMonths = rawMonths.length > 0 || localMonths.length > 0
    ? Array.from(new Set([...rawMonths, ...localMonths])).sort((a, b) => b.localeCompare(a))
    : undefined;
  return useQuery({
    queryKey: ['months'],
    queryFn: getUnifiedMonthList,
    staleTime: 10 * 1000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    initialData: initialMonths,
    initialDataUpdatedAt: initial?.savedAt || 0,
  });
}

export async function addUnifiedRow(sheetName: string, rowData: Record<string, unknown>) {
  return sheetsData.addRow(sheetName, rowData);
}

export async function updateUnifiedRow(sheetName: string, rowIndex: number, rowData: Record<string, unknown>) {
  if (sheetName === 'Trades') {
    return sheetsData.updateTrade(rowIndex, rowData);
  }
  const targetSheetName = sheetName === 'Transactions' && typeof rowData._month === 'string'
    ? rowData._month
    : sheetName;
  return sheetsData.updateRow(targetSheetName, rowIndex, rowData);
}

export async function deleteUnifiedRow(sheetName: string, rowIndex?: number, id?: string) {
  return sheetsData.deleteRow(sheetName, rowIndex, id);
}

export async function getUnifiedSettings(): Promise<Record<string, string>> {
  const res = await sheetsApi.getSettings();
  return res.data || {};
}

export async function updateUnifiedSettings(key: string, value: string) {
  return sheetsApi.updateSettings(key, value);
}

// React Query Hooks with SWR Caching for Zero-Delay Loading
export function useAllSheetNames() {
  return useQuery({
    queryKey: ['sheets'],
    queryFn: getUnifiedAllSheetNames,
    staleTime: 5 * 60 * 1000,
  });
}

export function useSheetData(sheetName: string, selectedPeriod?: string) {
  const initial = sheetName === 'Transactions'
    ? sheetsData.getInitialTransactions(selectedPeriod)
    : sheetsData.getInitialSheetData(sheetName);

  return useQuery({
    queryKey: ['sheet', sheetName, selectedPeriod || 'active'],
    queryFn: () => getUnifiedSheetData(sheetName, selectedPeriod),
    enabled: !!sheetName,
    staleTime: 10 * 1000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    initialData: initial?.data,
    initialDataUpdatedAt: initial?.savedAt,
  });
}

export function usePortfolio() {
  const queryClient = useQueryClient();
  const initialEntry = getSwrCachedEntry<Record<string, unknown>[] | { success: boolean; data: Record<string, unknown>[] }>('getPortfolio', {});
  const initialHoldings = Array.isArray(initialEntry?.data)
    ? initialEntry.data
    : initialEntry?.data && 'data' in initialEntry.data
      ? initialEntry.data.data
      : undefined;

  return useQuery({
    queryKey: ['portfolio'],
    staleTime: 5 * 1000, // 5s freshness so deletions/updates reflect immediately
    gcTime: 15 * 60 * 1000,
    refetchOnMount: true,
    initialData: initialHoldings,
    initialDataUpdatedAt: initialEntry?.savedAt,
    queryFn: async () => {
      let holdingsList: Record<string, unknown>[] = [];

      // 1. Compute holdings directly from fresh logged Trades and keep React Query cache in sync
      const tradesRes = await getUnifiedSheetData('Trades');
      const existingTradesQuery = queryClient.getQueryData<any>(['sheet', 'Trades', 'active']);
      const existingRows = Array.isArray(existingTradesQuery)
        ? existingTradesQuery
        : existingTradesQuery?.rows || [];

      if (tradesRes && Array.isArray(tradesRes.rows) && tradesRes.rows.length > 0) {
        queryClient.setQueryData(['sheet', 'Trades', 'active'], tradesRes);
      } else if (existingRows.length > 0 && (!tradesRes || !tradesRes.rows || tradesRes.rows.length === 0)) {
        if (!tradesRes.rows) tradesRes.rows = [];
        tradesRes.rows = existingRows;
      }
      const holdings: Record<string, Record<string, unknown>> = {};
      const sortedTrades = [...(tradesRes.rows || [])].sort((a, b) => {
        const dateA = String(a.Date || a.date || '');
        const dateB = String(b.Date || b.date || '');
        if (dateA !== dateB) return dateA.localeCompare(dateB);
        const actA = String(a.Action || a.action || 'BUY').toUpperCase();
        const actB = String(b.Action || b.action || 'BUY').toUpperCase();
        if (actA === 'SELL' && actB !== 'SELL') return 1;
        if (actA !== 'SELL' && actB === 'SELL') return -1;
        return 0;
      });
      sortedTrades.forEach((row) => {
        const ticker = String(row.Ticker || row.ticker || '').trim().toUpperCase();
        const action = String(row.Action || row.action || 'BUY').toUpperCase();
        const quantity = Number(row.Quantity || row.quantity || 0) || 0;
        const price = Number(row.Price || row.price || 0) || 0;
        const fees = Number(row.Fees || row.fees || 0) || 0;
        if (!ticker || quantity <= 0) return;

        const current = holdings[ticker] || {
          Ticker: ticker,
          ticker,
          'Asset Name': String(row['Asset Name'] || row.AssetName || row.name || ticker),
          name: String(row['Asset Name'] || row.AssetName || row.name || ticker),
          Type: String(row.Type || row.type || 'Stock'),
          type: String(row.Type || row.type || 'Stock'),
          Currency: String(row.Currency || row.currency || 'USD'),
          currency: String(row.Currency || row.currency || 'USD'),
          'Units Held': 0,
          units: 0,
          'Total Cost': 0,
          totalCost: 0,
          'Total Cost MYR': 0,
          totalCostMyr: 0,
          'Live Price': price,
          livePrice: price,
        };
        const units = Number(current['Units Held'] || current.units) || 0;
        const totalCost = Number(current['Total Cost'] || current.totalCost) || 0;
        const totalCostMyr = Number(current['Total Cost MYR'] || current.totalCostMyr) || 0;
        const tradeCostMyr = Number(row.CostInMyr || row.costInMyr || 0) || (current.Currency === 'MYR' ? (quantity * price + fees) : 0);
        const tradeRateToMyr = Number(row.RateToMyr || row.rateToMyr || 0);

        current['Live Price'] = price || current['Live Price'];
        current.livePrice = price || current.livePrice;

        const rowNotes = String(row.Notes || row.notes || '').toLowerCase();
        const isReinvested = Boolean(row.isReinvested || row.IsReinvested || action === 'REINVEST' || (action === 'DIVIDEND' && (rowNotes.includes('reinvest') || rowNotes.includes('drip'))));

        if (action === 'BUY' || isReinvested) {
          const nextU = units + quantity;
          const nextTC = totalCost + quantity * price + fees;
          const nextTCM = totalCostMyr + tradeCostMyr;
          current['Units Held'] = nextU;
          current.units = nextU;
          current['Total Cost'] = nextTC;
          current.totalCost = nextTC;
          current['Total Cost MYR'] = nextTCM;
          current.totalCostMyr = nextTCM;
          if (tradeRateToMyr > 0) current['RateToMyr'] = tradeRateToMyr;
        } else if (action === 'SELL') {
          const averageCost = units > 0 ? totalCost / units : 0;
          const averageCostMyr = units > 0 ? totalCostMyr / units : 0;
          const nextU = Math.max(0, units - quantity);
          const nextTC = Math.max(0, totalCost - quantity * averageCost);
          const nextTCM = Math.max(0, totalCostMyr - quantity * averageCostMyr);
          current['Units Held'] = nextU;
          current.units = nextU;
          current['Total Cost'] = nextTC;
          current.totalCost = nextTC;
          current['Total Cost MYR'] = nextTCM;
          current.totalCostMyr = nextTCM;
        }
        const nextUnits = Number(current['Units Held'] || current.units) || 0;
        const avgCost = nextUnits > 0 ? Number(current['Total Cost']) / nextUnits : 0;
        const avgCostMyr = nextUnits > 0 && Number(current['Total Cost MYR']) > 0 ? Number(current['Total Cost MYR']) / nextUnits : 0;
        const marketValue = nextUnits * (Number(current['Live Price']) || 0);

        current['Avg Cost'] = avgCost;
        current.avgCost = avgCost;
        current['Avg Cost MYR'] = avgCostMyr;
        current.avgCostMyr = avgCostMyr;
        current['Market Value'] = marketValue;
        current.marketValue = marketValue;
        holdings[ticker] = current;
      });

      holdingsList = Object.values(holdings).filter(row => Number(row['Units Held'] || row.units) > 0);

      // Fallback and reconcile with raw Portfolio tab so holdings (like SPCX) never disappear unless explicitly deleted
      try {
        const res = await sheetsApi.getPortfolio();
        const sheetHoldings = Array.isArray(res?.data) ? res.data : [];
        if (holdingsList.length === 0 && sheetHoldings.length > 0) {
          holdingsList = sheetHoldings.filter((sh) => {
            const sym = String(sh.ticker || sh.Ticker || '').trim().toUpperCase();
            return !isRecordTombstoned(sym) && !isRecordTombstoned(`moo_holding_${sym.toLowerCase()}_0`);
          });
        } else if (sheetHoldings.length > 0) {
          const existingTickers = new Set(
            holdingsList.map((h) => String(h.Ticker || h.ticker || '').trim().toUpperCase())
          );
          for (const sh of sheetHoldings) {
            const sym = String(sh.ticker || sh.Ticker || '').trim().toUpperCase();
            if (sym && !existingTickers.has(sym) && !isRecordTombstoned(sym) && !isRecordTombstoned(`moo_holding_${sym.toLowerCase()}_0`)) {
              holdingsList.push(sh);
              existingTickers.add(sym);
            }
          }
        }
      } catch (err) {
        console.warn('Portfolio fallback notice:', err);
      }

      // Enrich with real-time live quotes with generous 6s timeout and sheets fallback
      try {
        const tickersToFetch = holdingsList
          .map(h => String(h.Ticker || h.ticker || '').trim().toUpperCase())
          .filter(Boolean);

        if (tickersToFetch.length > 0) {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 6000);
          const quoteRes = await fetch(`/api/stocks/quote?tickers=${encodeURIComponent(tickersToFetch.join(','))}`, {
            signal: controller.signal,
          }).catch(() => null);
          clearTimeout(timeoutId);

          if (quoteRes && quoteRes.ok) {
            const quoteData = await quoteRes.json();
            if (quoteData.success && quoteData.quotes) {
              holdingsList = holdingsList.map(item => {
                const sym = String(item.Ticker || item.ticker || '').trim().toUpperCase();
                const live = quoteData.quotes[sym];
                if (live && typeof live.price === 'number' && live.price > 0) {
                  const units = Number(item['Units Held'] || item.units || 0);
                  const avgCost = Number(item['Avg Cost'] || item.avgCost || 0);
                  const totalCost = Number(item['Total Cost'] || item.totalCost || (units * avgCost));
                  const marketValue = units * live.price;
                  const pnl = marketValue - totalCost;
                  const returnPercent = totalCost > 0 ? (pnl / totalCost) * 100 : 0;

                  return {
                    ...item,
                    'Live Price': live.price,
                    livePrice: live.price,
                    'Market Value': marketValue,
                    marketValue: marketValue,
                    'Profit / Loss': pnl,
                    pnl: pnl,
                    'Return %': returnPercent,
                    returnPercent: returnPercent,
                  };
                }
                return item;
              });
            }
          }
        }
      } catch (err) {
        console.warn('Could not enrich portfolio with live quotes:', err);
      }

      // Secondary fallback: if any holding is still missing a true live price, check Google Sheets Portfolio
      try {
        const needsFallback = holdingsList.some(item => !item.livePrice || item.livePrice === item.avgCost);
        if (needsFallback) {
          const sheetPortRes = await sheetsApi.getPortfolio();
          const sheetRows = Array.isArray(sheetPortRes?.data) ? sheetPortRes.data : [];
          if (sheetRows.length > 0) {
            holdingsList = holdingsList.map(item => {
              const sym = String(item.Ticker || item.ticker || '').trim().toUpperCase();
              const sheetMatch = sheetRows.find((r: any) => String(r.ticker || r.Ticker || '').trim().toUpperCase() === sym);
              if (sheetMatch && typeof sheetMatch.livePrice === 'number' && sheetMatch.livePrice > 0) {
                const units = Number(item['Units Held'] || item.units || 0);
                const avgCost = Number(item['Avg Cost'] || item.avgCost || 0);
                const totalCost = Number(item['Total Cost'] || item.totalCost || (units * avgCost));
                const marketValue = units * sheetMatch.livePrice;
                const pnl = marketValue - totalCost;
                const returnPercent = totalCost > 0 ? (pnl / totalCost) * 100 : 0;

                return {
                  ...item,
                  'Live Price': sheetMatch.livePrice,
                  livePrice: sheetMatch.livePrice,
                  'Market Value': marketValue,
                  marketValue: marketValue,
                  'Profit / Loss': pnl,
                  pnl: pnl,
                  'Return %': returnPercent,
                  returnPercent: returnPercent,
                };
              }
              return item;
            });
          }
        }
      } catch (sheetErr) {
        console.warn('Google Sheets fallback portfolio notice:', sheetErr);
      }

      // Update SWR local cache with fresh values
      setSwrCachedData('getPortfolio', {}, holdingsList);

      return holdingsList;
    },
  });
}

export function useTrades() {
  const query = useSheetData('Trades');
  const portfolioQuery = usePortfolio();

  return useMemo(() => {
    const rawData = query.data;
    const rawRows = Array.isArray(rawData)
      ? rawData
      : Array.isArray(rawData?.rows)
        ? rawData.rows
        : [];

    if (rawRows.length > 0) {
      return query;
    }

    // Defensive check: persistent trades saved from Moomoo sync
    if (typeof window !== 'undefined') {
      try {
        const stored = localStorage.getItem('cashflow_persistent_trades');
        if (stored) {
          const parsed = JSON.parse(stored);
          if (Array.isArray(parsed) && parsed.length > 0) {
            const valid = parsed.filter((t: any) => {
              const tId = String(t.Id || t.id || '');
              const sym = String(t.Ticker || t.ticker || '').trim().toUpperCase();
              return !isRecordTombstoned(tId) && !isRecordTombstoned(sym);
            });
            if (valid.length > 0) {
              return {
                ...query,
                data: {
                  headers: [
                    'Id', 'Date', 'Action', 'Ticker', 'Asset Name',
                    'Quantity', 'Price', 'Fees', 'Net Total', 'Currency', 'Notes',
                  ],
                  rows: valid,
                },
              };
            }
          }
        }
      } catch {
        // ignore
      }
    }

    // Defensive fallback: if Trades query returned 0 rows but Portfolio has active holdings
    const holdings = Array.isArray(portfolioQuery.data)
      ? portfolioQuery.data.filter((h: any) => {
          const sym = String(h.Ticker || h.ticker || '').trim().toUpperCase();
          return !isRecordTombstoned(sym) && !isRecordTombstoned(`moo_holding_${sym.toLowerCase()}_0`);
        })
      : [];
    if (holdings.length > 0) {
      const fallbackTrades = holdings.map((h: any, idx: number) => {
        const ticker = String(h.Ticker || h.ticker || '').trim().toUpperCase();
        const units = Number(h['Units Held'] || h.units || 0);
        const avgCost = Number(h['Avg Cost'] || h.avgCost || 0);
        const name = String(h['Asset Name'] || h.name || ticker);
        const currency = String(h.Currency || h.currency || 'USD');
        const netTotal = Number(h['Total Cost'] || h.totalCost || (units * avgCost));
        const tradeDate = String(h.Date || h.date || h.open_date || '').trim().split('T')[0] || new Date().toISOString().split('T')[0];
        return {
          Id: `moo_holding_${ticker.toLowerCase()}_${idx}`,
          Date: tradeDate,
          Action: 'BUY',
          Ticker: ticker,
          'Asset Name': name,
          Quantity: units,
          Price: avgCost,
          Fees: 0.50,
          'Net Total': netTotal,
          Currency: currency,
          Notes: `Moomoo Auto-Sync Holding (${ticker})`,
        };
      });

      return {
        ...query,
        data: {
          headers: [
            'Id', 'Date', 'Action', 'Ticker', 'Asset Name',
            'Quantity', 'Price', 'Fees', 'Net Total', 'Currency', 'Notes',
          ],
          rows: fallbackTrades,
        },
      };
    }

    return query;
  }, [query, portfolioQuery.data]);
}

export function useOverview() {
  return useQuery({
    queryKey: ['overview'],
    staleTime: 60 * 1000,
    queryFn: async () => {
      const res = await sheetsApi.getOverview();
      return res.data || [];
    },
  });
}

export function useSyncGoogleSheets() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => syncAllGoogleSheets(),
    onSuccess: () => {
      queryClient.invalidateQueries();
    },
  });
}

export function useAddTrade() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (tradeData: Record<string, unknown>) => sheetsData.addTrade(tradeData),
    onSuccess: async () => {
      clearAllSwrCache();
      await queryClient.invalidateQueries({ queryKey: ['sheet'] });
      await queryClient.invalidateQueries({ queryKey: ['trades'] });
      await queryClient.invalidateQueries({ queryKey: ['portfolio'] });
      await queryClient.invalidateQueries({ queryKey: ['overview'] });
    },
  });
}

export function useSheetSchema(sheetName: string) {
  return useQuery({
    queryKey: ['schema', sheetName],
    queryFn: () => getUnifiedSheetSchema(sheetName),
    enabled: !!sheetName,
  });
}

export function applyOptimisticAddToQueryCache(
  queryClient: QueryClient,
  sheetName: string,
  rowData: Record<string, unknown>,
) {
  const normalizedRow = sheetsData.optimisticAddRow(sheetName, rowData);
  const rowId = String(normalizedRow.Id || normalizedRow.id || '');
  const targetMonth = String(normalizedRow._month || (/^\d{4}-\d{2}$/.test(sheetName) ? sheetName : ''));
  const isTxSheet = sheetName === 'Transactions' || /^\d{4}-\d{2}$/.test(sheetName);

  if (targetMonth && /^\d{4}-\d{2}$/.test(targetMonth)) {
    queryClient.setQueryData(['months'], (old: string[] | undefined) => {
      const prev = Array.isArray(old) ? old : [];
      if (prev.includes(targetMonth)) return prev;
      return Array.from(new Set([...prev, targetMonth])).sort((a, b) => b.localeCompare(a));
    });
  }

  const prependRow = (old: unknown) => {
    if (!old || typeof old !== 'object') return old;
    const sheetData = old as { headers?: string[]; rows?: Record<string, unknown>[] };
    if (!Array.isArray(sheetData.rows)) {
      if (Array.isArray(sheetData.headers)) {
        return { ...sheetData, rows: [normalizedRow] };
      }
      return old;
    }
    const filtered = sheetData.rows.filter((r) => String(r?.Id || r?.id || '') !== rowId);
    return { ...sheetData, rows: [normalizedRow, ...filtered] };
  };

  if (isTxSheet) {
    queryClient.setQueriesData({ queryKey: ['sheet', 'Transactions'] }, prependRow);
    if (targetMonth) {
      queryClient.setQueriesData({ queryKey: ['sheet', targetMonth] }, prependRow);
    }
    void queryClient.invalidateQueries({ queryKey: ['receipt-price-history'] });
  } else {
    queryClient.setQueriesData({ queryKey: ['sheet', sheetName] }, prependRow);
  }
}

export function applyOptimisticUpdateToQueryCache(
  queryClient: QueryClient,
  sheetName: string,
  rowIndex: number | undefined,
  rowData: Record<string, unknown>,
) {
  const cacheRowData = { ...rowData };
  delete cacheRowData._baseData;
  const updatedRow = sheetsData.optimisticUpdateRow(sheetName, rowIndex, cacheRowData);
  const rowId = String(updatedRow.Id || updatedRow.id || '');
  const targetMonth = String(updatedRow._month || (/^\d{4}-\d{2}$/.test(sheetName) ? sheetName : ''));

  if (targetMonth && /^\d{4}-\d{2}$/.test(targetMonth)) {
    queryClient.setQueryData(['months'], (old: string[] | undefined) => {
      const prev = Array.isArray(old) ? old : [];
      if (prev.includes(targetMonth)) return prev;
      return Array.from(new Set([...prev, targetMonth])).sort((a, b) => b.localeCompare(a));
    });
  }

  queryClient.setQueriesData({ queryKey: ['sheet'] }, (old: unknown) => {
    const prev = old as { headers?: string[]; rows?: Record<string, unknown>[] } | undefined;
    if (!prev || !Array.isArray(prev.rows)) return old;
    let changed = false;
    const nextRows = prev.rows.map((r) => {
      const rId = String(r.Id || r.id || '');
      const matchById = Boolean(rowId && rId === rowId);
      const matchByIndex = !rowId && typeof rowIndex === 'number' && r._rowIndex === rowIndex && (!r._month || r._month === (targetMonth || sheetName));
      if (matchById || matchByIndex) {
        changed = true;
        return { ...r, ...updatedRow };
      }
      return r;
    });
    return changed ? { ...prev, rows: nextRows } : old;
  });
}

export function applyOptimisticDeleteToQueryCache(
  queryClient: QueryClient,
  sheetName: string,
  rowIndex?: number,
  id?: string,
) {
  sheetsData.optimisticDeleteRow(sheetName, rowIndex, id);

  queryClient.setQueriesData({ queryKey: ['sheet'] }, (old: unknown) => {
    const prev = old as { headers?: string[]; rows?: Record<string, unknown>[] } | undefined;
    if (!prev || !Array.isArray(prev.rows)) return old;
    const nextRows = prev.rows.filter((r) => {
      const rId = String(r.Id || r.id || '');
      if (id && rId) return rId !== id;
      if (!id && typeof rowIndex === 'number' && (!r._month || r._month === sheetName)) {
        return r._rowIndex !== rowIndex;
      }
      return true;
    });
    return nextRows.length !== prev.rows.length ? { ...prev, rows: nextRows } : old;
  });
}

export function useAddRow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sheetName, rowData }: { sheetName: string; rowData: Record<string, unknown> }) =>
      addUnifiedRow(sheetName, rowData),
    onMutate: ({ sheetName, rowData }) => {
      const tempId = String(rowData.Id || rowData.id || `tx_${Date.now()}`);
      rowData.Id = tempId;
      rowData.id = tempId;
      applyOptimisticAddToQueryCache(queryClient, sheetName, rowData);
    },
    onSuccess: (_res, { sheetName }) => {
      const isTxSheet = sheetName === 'Transactions' || /^\d{4}-\d{2}$/.test(sheetName);
      if (!isTxSheet) {
        queryClient.invalidateQueries({ queryKey: ['sheet', sheetName] });
      }
      queryClient.invalidateQueries({ queryKey: ['months'] });
      queryClient.invalidateQueries({ queryKey: ['overview'] });
    },
  });
}

export function useUpdateRow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sheetName, rowIndex, rowData }: { sheetName: string; rowIndex: number; rowData: Record<string, unknown> }) =>
      updateUnifiedRow(sheetName, rowIndex, rowData),
    onMutate: ({ sheetName, rowIndex, rowData }) => {
      applyOptimisticUpdateToQueryCache(queryClient, sheetName, rowIndex, rowData);
    },
    onSuccess: (_res, { sheetName }) => {
      const isTxSheet = sheetName === 'Transactions' || /^\d{4}-\d{2}$/.test(sheetName);
      if (!isTxSheet) {
        queryClient.invalidateQueries({ queryKey: ['sheet', sheetName] });
        if (sheetName === 'Trades') {
          queryClient.invalidateQueries({ queryKey: ['portfolio'] });
          queryClient.invalidateQueries({ queryKey: ['trades'] });
        }
      }
      queryClient.invalidateQueries({ queryKey: ['months'] });
      queryClient.invalidateQueries({ queryKey: ['overview'] });
    },
  });
}

export function useDeleteRow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sheetName, rowIndex, id }: { sheetName: string; rowIndex?: number; id?: string }) =>
      deleteUnifiedRow(sheetName, rowIndex, id),
    onMutate: ({ sheetName, rowIndex, id }) => {
      applyOptimisticDeleteToQueryCache(queryClient, sheetName, rowIndex, id);
    },
    onSuccess: async (_res, { sheetName }) => {
      clearAllSwrCache();
      const isTxSheet = sheetName === 'Transactions' || /^\d{4}-\d{2}$/.test(sheetName);
      if (!isTxSheet) {
        await queryClient.invalidateQueries({ queryKey: ['sheet', sheetName] });
        if (sheetName === 'Trades') {
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: ['portfolio'] }),
            queryClient.invalidateQueries({ queryKey: ['trades'] }),
            queryClient.refetchQueries({ queryKey: ['sheet', 'Trades', 'active'] }),
            queryClient.refetchQueries({ queryKey: ['portfolio'] }),
          ]);
        }
      }
      await queryClient.invalidateQueries({ queryKey: ['overview'] });
    },
  });
}

export function useSettings() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: getUnifiedSettings,
  });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) =>
      updateUnifiedSettings(key, value),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });
}
