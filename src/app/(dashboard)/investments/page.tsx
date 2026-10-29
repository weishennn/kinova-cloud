'use client';

import React, { useState, useMemo, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { 
  TrendingUp, TrendingDown, ArrowUpRight, ArrowDownRight,
  DollarSign, Activity, PieChart as PieChartIcon, History, X, Loader2, Sparkles, AlertCircle, Edit2, Trash2, Search, ChevronRight, RefreshCw,
  Camera, ScanLine, Upload
} from 'lucide-react';
import dynamic from 'next/dynamic';
import { useQueryClient } from '@tanstack/react-query';
import { usePortfolio, useTrades, useAddTrade, useUpdateRow, useDeleteRow } from '@/hooks/useSheets';
import { clearAllSwrCache, setSwrCachedData } from '@/lib/sheets-api';
import { 
  convertCurrency, 
  formatAssetCurrency, 
  formatPnl, 
  fetchLiveExchangeRates, 
  getCachedRatesToMyr, 
  DEFAULT_RATES_TO_MYR 
} from '@/lib/currency';
import { getLocalDateString } from '@/lib/date-helper';
import { useLockBodyScroll } from '@/hooks/useLockBodyScroll';
import { AnimatedNumber } from '@/components/shared/animated-number';
import { CockpitPageHeading } from '@/components/money-cockpit/cockpit-page-heading';
import { CockpitModal, CockpitModalHeader } from '@/components/money-cockpit/cockpit-modal';
import { MoneyCalculator } from '@/components/shared/money-calculator';
import { useAppStore } from '@/stores/app-store';
import { confirmAction } from '@/stores/confirm-dialog-store';
import { INVESTMENT_TRADE_REQUEST_EVENT } from '@/lib/investment-trade-events';
import { toast } from 'sonner';

const PieChart = dynamic(() => import('recharts').then(m => m.PieChart), { ssr: false });
const Pie = dynamic(() => import('recharts').then(m => m.Pie), { ssr: false });
const Cell = dynamic(() => import('recharts').then(m => m.Cell), { ssr: false });
const ResponsiveContainer = dynamic(() => import('recharts').then(m => m.ResponsiveContainer), { ssr: false });
const Tooltip = dynamic(() => import('recharts').then(m => m.Tooltip), { ssr: false });

const TYPE_COLORS: Record<string, string> = {
  'Stock': '#3b82f6',
  'US Stock': '#3b82f6',
  'MY Stock': '#10b981',
  'Crypto': '#f59e0b',
  'ETF': '#8b5cf6',
  'Unit Trust': '#ec4899',
  'Other': '#6b7280',
};

interface NormalizedTrade {
  id: string;
  date: string;
  action: string;
  ticker: string;
  name: string;
  quantity: number;
  price: number;
  fees: number;
  netTotal: number;
  currency: string;
  rateToMyr: number;
  costInMyr: number;
  notes: string;
  isReinvested: boolean;
  rowIndex?: number;
}

export default function InvestmentsPage() {
  const queryClient = useQueryClient();
  const { aiPrefill, setAiPrefill } = useAppStore();
  const [activeTab, setActiveTab] = useState<'holdings' | 'trades'>('holdings');
  const [isAddTradeOpen, setIsAddTradeOpen] = useState(false);
  const addTradeRequestRef = useRef<{ signature: string; id: string } | null>(null);
  const [selectedTrade, setSelectedTrade] = useState<any | null>(null);
  const [selectedHolding, setSelectedHolding] = useState<any | null>(null);
  const [fxRates, setFxRates] = useState<Record<string, number>>(getCachedRatesToMyr);

  useLockBodyScroll(isAddTradeOpen || Boolean(selectedTrade) || Boolean(selectedHolding));

  useEffect(() => {
    fetchLiveExchangeRates().then(rates => {
      if (rates) setFxRates(rates);
    });
  }, []);

  // Real data hooks
  const { data: rawPortfolio = [], isLoading: isPortfolioLoading } = usePortfolio();
  const { data: rawTradesData, isLoading: isTradesLoading } = useTrades();
  const addTradeMutation = useAddTrade();
  const updateTradeMutation = useUpdateRow();
  const deleteTradeMutation = useDeleteRow();

  // Normalize Trades
  const trades = useMemo<NormalizedTrade[]>(() => {
    let rawRows = Array.isArray(rawTradesData)
      ? rawTradesData
      : Array.isArray(rawTradesData?.rows)
        ? rawTradesData.rows
        : Array.isArray((rawTradesData as any)?.data?.rows)
          ? (rawTradesData as any).data.rows
          : Array.isArray((rawTradesData as any)?.data)
            ? (rawTradesData as any).data
            : [];

    if (rawRows.length === 0 && typeof window !== 'undefined') {
      try {
        const stored = localStorage.getItem('cashflow_persistent_trades');
        if (stored) {
          const parsed = JSON.parse(stored);
          if (Array.isArray(parsed) && parsed.length > 0) {
            rawRows = parsed;
          }
        }
      } catch {
        // ignore
      }
    }

    return (rawRows as any[]).map((r: any): NormalizedTrade => {
      const qty = Number(r.Quantity || r.quantity || r.Qty || r.qty || 0);
      const price = Number(r.Price || r.price || 0);
      const fees = Number(r.Fees || r.fees || 0);
      const netTotal = Number(r.NetTotal || r['Net Total'] || r.net_total || r.total) || (qty * price + fees);
      const currency = String(r.Currency || r.currency || 'USD').toUpperCase();
      const currentRate = fxRates[currency] || DEFAULT_RATES_TO_MYR[currency] || 1.0;
      const rateToMyr = Number(r.RateToMyr || r.rateToMyr || r.rate_to_myr || 0) || (currency === 'MYR' ? 1.0 : currentRate);
      const costInMyr = Number(r.CostInMyr || r.costInMyr || r.cost_in_myr || 0) || (currency === 'MYR' ? netTotal : netTotal * rateToMyr);

      const ticker = String(r.Ticker || r.ticker || r.Symbol || r.symbol || r.code || '').replace(/^(US\.|HK\.|MY\.)/, '').trim().toUpperCase();
      const date = String(r.Date || r.date || r.create_time || '').trim().split('T')[0].split(' ')[0];

      return {
        id: String(r.Id || r.id || `tr_${Math.random()}`),
        date,
        action: String(r.Action || r.action || r.side || 'BUY').toUpperCase(),
        ticker,
        name: String(r.AssetName || r['Asset Name'] || r.name || r.stock_name || ticker),
        quantity: qty,
        price: price,
        fees: fees,
        netTotal: netTotal,
        currency,
        rateToMyr,
        costInMyr,
        notes: String(r.Notes || r.notes || ''),
        isReinvested: Boolean(r.isReinvested || r.IsReinvested || String(r.Action || r.action || '').toUpperCase() === 'REINVEST' || String(r.Notes || r.notes || '').toLowerCase().includes('reinvest')),
        rowIndex: typeof r._rowIndex === 'number' ? r._rowIndex : undefined,
      };
    }).filter((t: NormalizedTrade) => Boolean(t.ticker && t.date));
  }, [rawTradesData, fxRates]);

  // Map historical MYR trade costs by ticker for 100% accurate cost basis
  const tradeCostByTicker = useMemo(() => {
    const costMap: Record<string, { units: number; totalMyr: number; rateToMyr: number }> = {};
    const chronologicalTrades = [...trades].sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      if (a.action === 'SELL' && b.action !== 'SELL') return 1;
      if (a.action !== 'SELL' && b.action === 'SELL') return -1;
      return 0;
    });
    chronologicalTrades.forEach(t => {
      const isReinv = t.action === 'REINVEST' || (t.action === 'DIVIDEND' && (t.isReinvested || t.notes.toLowerCase().includes('reinvest')));
      if (!costMap[t.ticker]) costMap[t.ticker] = { units: 0, totalMyr: 0, rateToMyr: t.rateToMyr };
      const entry = costMap[t.ticker];
      if (t.action === 'BUY' || isReinv) {
        entry.units += t.quantity;
        entry.totalMyr += t.costInMyr;
        if (t.rateToMyr > 0) entry.rateToMyr = t.rateToMyr;
      } else if (t.action === 'SELL') {
        const avgMyr = entry.units > 0 ? entry.totalMyr / entry.units : 0;
        entry.units = Math.max(0, entry.units - t.quantity);
        entry.totalMyr = Math.max(0, entry.totalMyr - t.quantity * avgMyr);
      }
    });
    return costMap;
  }, [trades]);

  // Normalize Portfolio Holdings with Real-Time FX and True Historical MYR Cost
  const holdings = useMemo(() => {
    if (!Array.isArray(rawPortfolio)) return [];
    return rawPortfolio.map((item: any) => {
      const ticker = String(item.ticker || item.Ticker || '').toUpperCase();
      const units = Number(item.units || item['Units Held'] || 0);
      const avgCost = Number(item.avgCost || item['Avg Cost'] || 0);
      const livePrice = Number(item.livePrice || item['Live Price'] || avgCost || 0);
      const totalCost = Number(item.totalCost || item['Total Cost'] || (units * avgCost));
      const marketValue = Number(item.marketValue || item['Market Value'] || (units * livePrice));
      const currency = String(item.currency || item.Currency || 'USD').toUpperCase();
      const currentFxRate = fxRates[currency] || DEFAULT_RATES_TO_MYR[currency] || 1.0;

      // 1. Real-time market valuation in MYR using live FX quote
      const marketValueBase = currency === 'MYR' ? marketValue : marketValue * currentFxRate;

      // 2. True historical cost basis in MYR (what the user actually spent)
      const historicalTradeCost = tradeCostByTicker[ticker]?.totalMyr;
      const totalCostMyrFromItem = Number(item.totalCostMyr || item['Total Cost MYR'] || 0);
      const itemRateToMyr = Number(item.rateToMyr || item['RateToMyr'] || tradeCostByTicker[ticker]?.rateToMyr || 0);

      const totalCostBase = historicalTradeCost && historicalTradeCost > 0
        ? historicalTradeCost
        : totalCostMyrFromItem > 0
        ? totalCostMyrFromItem
        : currency === 'MYR'
        ? totalCost
        : itemRateToMyr > 0
        ? totalCost * itemRateToMyr
        : totalCost * currentFxRate;

      const avgCostBase = units > 0 ? totalCostBase / units : 0;
      const pnlBase = marketValueBase - totalCostBase;
      const returnPercentBase = totalCostBase > 0 ? (pnlBase / totalCostBase) * 100 : 0;

      // Foreign currency P&L for stock-only performance
      const pnl = Number(item.pnl || item['Profit / Loss'] || (marketValue - totalCost));
      const returnPercent = totalCost > 0 ? (pnl / totalCost) * 100 : 0;

      return {
        ticker,
        name: String(item.name || item['Asset Name'] || item.ticker || ''),
        type: String(item.type || item.Type || 'Stock'),
        currency,
        units,
        avgCost,
        totalCost,
        livePrice,
        marketValue,
        currentFxRate,
        marketValueBase,
        totalCostBase,
        avgCostBase,
        pnlBase,
        returnPercentBase,
        pnl,
        returnPercent,
      };
    }).filter(h => h.ticker && h.units > 0);
  }, [rawPortfolio, fxRates, tradeCostByTicker]);

  // Google Sheets exposes the symbols already used by the portfolio and trade log.
  // Keep the picker lightweight and only suggest symbols matching the typed prefix.
  const tickerOptions = useMemo(() => {
    const symbols = new Set<string>();
    holdings.forEach(h => h.ticker && symbols.add(h.ticker));
    trades.forEach(t => t.ticker && symbols.add(t.ticker));
    return Array.from(symbols).sort();
  }, [holdings, trades]);

  // Portfolio Totals
  const totalMarketValue = useMemo(() => {
    return holdings.reduce((sum, h) => sum + h.marketValueBase, 0);
  }, [holdings]);

  const totalCostBasis = useMemo(() => {
    return holdings.reduce((sum, h) => sum + h.totalCostBase, 0);
  }, [holdings]);

  const totalPnl = totalMarketValue - totalCostBasis;
  const totalReturnPercent = totalCostBasis > 0 ? (totalPnl / totalCostBasis) * 100 : 0;

  // Realized cash earnings. Reinvested dividends increase holdings but are not
  // cash received, so they must not be counted as realized income here.
  const annualRealizedGain = useMemo(() => {
    const currentYear = new Date().getFullYear().toString();
    return trades
      .filter(t => t.date.startsWith(currentYear) && t.action === 'DIVIDEND')
      .reduce((sum, t) => sum + convertCurrency(t.netTotal, t.currency, 'MYR'), 0);
  }, [trades]);

  // Allocation Pie Chart Data
  const allocationData = useMemo(() => {
    const typeMap: Record<string, number> = {};
    holdings.forEach(h => {
      typeMap[h.type] = (typeMap[h.type] || 0) + h.marketValueBase;
    });
    return Object.entries(typeMap).map(([name, value]) => ({
      name,
      value,
      color: TYPE_COLORS[name] || '#6366f1'
    }));
  }, [holdings]);

  // Form State for Add Trade Modal
  const [tradeAction, setTradeAction] = useState<'BUY' | 'SELL' | 'DIVIDEND'>('BUY');
  const [ticker, setTicker] = useState('');
  const [assetName, setAssetName] = useState('');
  const [assetType, setAssetType] = useState('US Stock');
  const [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState('');
  const [fees, setFees] = useState('0');
  const [currency, setCurrency] = useState('USD');
  const [rateToMyr, setRateToMyr] = useState('4.07');
  const [costInMyr, setCostInMyr] = useState('');
  const [manualCostEdited, setManualCostEdited] = useState(false);
  const [date, setDate] = useState(() => getLocalDateString());
  const [notes, setNotes] = useState('');
  const [isReinvested, setIsReinvested] = useState(false);
  const [editingTrade, setEditingTrade] = useState<null | (typeof trades[number])>(null);
  const [isScanningTrade, setIsScanningTrade] = useState(false);
  const [isSyncingMoomoo, setIsSyncingMoomoo] = useState(false);
  const tradeFileInputRef = useRef<HTMLInputElement>(null);

  const handleSyncMoomoo = async () => {
    setIsSyncingMoomoo(true);
    try {
      const res = await fetch('/api/moomoo/sync', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.success) {
        toast.error(data.error || 'Failed to sync with Moomoo API');
        return;
      }

      // Clear any local tombstone entries and pending delete mutations for trades
      if (typeof window !== 'undefined') {
        try {
          const raw = localStorage.getItem('cashflow_deleted_tombstones');
          if (raw) {
            const tombstones = JSON.parse(raw);
            let modified = false;
            for (const key of Object.keys(tombstones)) {
              if (key.startsWith('moo_') || tombstones[key]?.sheetName === 'Trades') {
                delete tombstones[key];
                modified = true;
              }
            }
            if (modified) {
              localStorage.setItem('cashflow_deleted_tombstones', JSON.stringify(tombstones));
            }
          }
          const rawMut = localStorage.getItem('cashflow_pending_mutations');
          if (rawMut) {
            const muts = JSON.parse(rawMut);
            if (Array.isArray(muts)) {
              const cleaned = muts.filter((m: any) => m.sheetName !== 'Trades' && !String(m.rowId || '').startsWith('moo_'));
              localStorage.setItem('cashflow_pending_mutations', JSON.stringify(cleaned));
            }
          }
        } catch {
          // ignore
        }
      }

      const tradeHeaders = [
        'Id', 'Date', 'Action', 'Ticker', 'Asset Name',
        'Quantity', 'Price', 'Fees', 'Net Total', 'Currency', 'Notes'
      ];

      // Immediately seed cache with the freshly returned trades for 0ms instant display
      if (Array.isArray(data.trades) && data.trades.length > 0) {
        if (typeof window !== 'undefined') {
          try {
            localStorage.setItem('cashflow_persistent_trades', JSON.stringify(data.trades));
          } catch {
            // ignore
          }
        }
        setSwrCachedData('getSheetData', { sheetName: 'Trades' }, {
          success: true,
          data: {
            headers: tradeHeaders,
            rows: data.trades,
          },
        });
        queryClient.setQueryData(['sheet', 'Trades', 'active'], {
          headers: tradeHeaders,
          rows: data.trades,
        });
      }

      if (Array.isArray(data.portfolio) && data.portfolio.length > 0) {
        setSwrCachedData('getPortfolio', {}, data.portfolio);
        queryClient.setQueryData(['portfolio'], data.portfolio);
      }

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['months'] }),
        queryClient.refetchQueries({ queryKey: ['months'] }),
        queryClient.invalidateQueries({ queryKey: ['overview'] }),
      ]);

      // Switch to Trade History tab so the user immediately sees the trades table
      setActiveTab('trades');

      const parts = [];
      if (data.syncedTrades > 0) parts.push(`${data.syncedTrades} new trade${data.syncedTrades > 1 ? 's' : ''}`);
      if (data.syncedDeposits > 0) parts.push(`${data.syncedDeposits} cash deposit${data.syncedDeposits > 1 ? 's' : ''}`);

      if (parts.length === 0) {
        toast.success(
          `✨ Moomoo is fully up-to-date! Switched to Trade History (${data.trades?.length || trades.length} trades recorded).`
        );
      } else {
        toast.success(`✨ Synced from Moomoo: Added ${parts.join(' & ')}! Switched to Trade History.`);
      }
    } catch {
      toast.error('Network error connecting to Moomoo sync API');
    } finally {
      setIsSyncingMoomoo(false);
    }
  };

  const handleScanTradeFile = async (file: File) => {
    if (!file) return;
    setIsScanningTrade(true);
    try {
      const reader = new FileReader();
      const base64Promise = new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
      });
      reader.readAsDataURL(file);
      const dataUrl = await base64Promise;
      const imageBase64 = dataUrl.split(',')[1];
      const mimeType = file.type || 'image/jpeg';

      const res = await fetch('/api/ai/parse-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageBase64,
          mimeType,
          today: getLocalDateString(),
        }),
      });

      const json = await res.json();
      if (!res.ok || !json.success || !json.data) {
        throw new Error(json.error || 'Failed to extract trade details from image.');
      }

      const parsed = json.data;
      setEditingTrade(null);
      setTradeAction(parsed.action === 'REINVEST' ? 'DIVIDEND' : parsed.action);
      setIsReinvested(Boolean(parsed.isReinvested));
      setTicker(parsed.ticker);
      setAssetName(parsed.assetName || parsed.ticker);
      setAssetType(parsed.assetType || 'US Stock');
      setQuantity(parsed.quantity != null ? String(parsed.quantity) : '');
      setPrice(parsed.price != null ? String(parsed.price) : '');
      setFees(parsed.fees != null ? String(parsed.fees) : '0');
      setCurrency(parsed.currency || 'USD');
      setDate(parsed.date || getLocalDateString());
      setNotes(parsed.notes || '');

      const currentRate = fxRates[parsed.currency] || DEFAULT_RATES_TO_MYR[parsed.currency] || 1.0;
      setRateToMyr(parsed.currency === 'MYR' ? '1.0' : currentRate.toFixed(4));
      const computedCostMyr = parsed.currency === 'MYR'
        ? parsed.netTotal
        : (parsed.netTotal * currentRate);
      setCostInMyr(computedCostMyr > 0 ? computedCostMyr.toFixed(2) : '');
      setManualCostEdited(false);

      setIsAddTradeOpen(true);
      toast.success(`✨ Moomoo trade scanned! ${parsed.ticker} (${parsed.quantity} @ ${formatAssetCurrency(parsed.price, parsed.currency)}, Fees: ${formatAssetCurrency(parsed.fees, parsed.currency)})`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Trade scan failed. Please try a clearer screenshot.');
    } finally {
      setIsScanningTrade(false);
      if (tradeFileInputRef.current) {
        tradeFileInputRef.current.value = '';
      }
    }
  };

  useEffect(() => {
    const handleTradeRequest = (event: Event) => {
      const action = (event as CustomEvent<{ action?: string }>).detail?.action;
      if (action !== 'BUY' && action !== 'SELL') return;
      setEditingTrade(null);
      setTradeAction(action);
      setIsReinvested(false);
      setIsAddTradeOpen(true);
    };

    window.addEventListener(INVESTMENT_TRADE_REQUEST_EVENT, handleTradeRequest);
    return () => window.removeEventListener(INVESTMENT_TRADE_REQUEST_EVENT, handleTradeRequest);
  }, []);

  useEffect(() => {
    if (isAddTradeOpen && tradeAction === 'SELL' && !editingTrade && !ticker && holdings.length > 0) {
      selectHoldingForTrade(holdings[0], 'SELL');
    }
  }, [isAddTradeOpen, tradeAction, editingTrade, ticker, holdings]);

  // AI trade drafts open the existing trade form; no write happens until submit.
  useEffect(() => {
    if (aiPrefill?.kind !== 'trade') return;
    const draft = aiPrefill.data;
    const isReinvested = draft.action === 'REINVEST' || Boolean(draft.isReinvested);
    setEditingTrade(null);
    setTradeAction(isReinvested ? 'DIVIDEND' : (draft.action === 'REINVEST' ? 'DIVIDEND' : draft.action));
    setIsReinvested(isReinvested);
    setTicker(draft.ticker);
    setAssetName(draft.assetName || draft.ticker);
    setAssetType(draft.assetType || 'US Stock');
    setQuantity(draft.quantity == null ? '' : String(draft.quantity));
    setPrice(draft.price == null ? '' : String(draft.price));
    setFees(draft.fees == null ? '0' : String(draft.fees));
    setCurrency(draft.currency || 'USD');
    setDate(draft.date);
    setNotes(draft.notes || '');
    setManualCostEdited(false);
    setIsAddTradeOpen(true);
    setAiPrefill(null);
  }, [aiPrefill, setAiPrefill]);

  // Real-time stock search and quote state
  const [stockSearchResults, setStockSearchResults] = useState<Array<{ symbol: string; name: string; exchange: string; type: string }>>([]);
  const [isSearchingStock, setIsSearchingStock] = useState(false);
  const [isFetchingQuote, setIsFetchingQuote] = useState(false);
  const [showStockDropdown, setShowStockDropdown] = useState(false);

  // Auto-sync implied MYR cost when trade amounts or currency change
  useEffect(() => {
    const qtyNum = parseFloat(quantity) || 0;
    const priceNum = parseFloat(price) || 0;
    const feesNum = parseFloat(fees) || 0;
    const netTotal = qtyNum * priceNum + (tradeAction === 'BUY' ? feesNum : -feesNum);

    if (currency === 'MYR') {
      setRateToMyr('1.0');
      setCostInMyr(netTotal > 0 ? netTotal.toFixed(2) : '');
      return;
    }

    const defaultRate = fxRates[currency.toUpperCase()] || DEFAULT_RATES_TO_MYR[currency.toUpperCase()] || 4.10;
    if (!editingTrade) {
      if (!rateToMyr || parseFloat(rateToMyr) === 1.0) {
        setRateToMyr(defaultRate.toFixed(4));
      }
      const activeRate = parseFloat(rateToMyr) || defaultRate;
      if (!manualCostEdited && netTotal > 0) {
        setCostInMyr((netTotal * activeRate).toFixed(2));
      }
    }
  }, [quantity, price, fees, currency, tradeAction, fxRates, editingTrade, manualCostEdited, rateToMyr]);

  const handleRateChange = (val: string) => {
    setRateToMyr(val);
    const r = parseFloat(val);
    const qtyNum = parseFloat(quantity) || 0;
    const priceNum = parseFloat(price) || 0;
    const feesNum = parseFloat(fees) || 0;
    const netTotal = qtyNum * priceNum + (tradeAction === 'BUY' ? feesNum : -feesNum);
    if (!isNaN(r) && r > 0 && netTotal > 0) {
      setCostInMyr((netTotal * r).toFixed(2));
    }
  };

  const handleCostInMyrChange = (val: string) => {
    setCostInMyr(val);
    setManualCostEdited(true);
    const c = parseFloat(val);
    const qtyNum = parseFloat(quantity) || 0;
    const priceNum = parseFloat(price) || 0;
    const feesNum = parseFloat(fees) || 0;
    const netTotal = qtyNum * priceNum + (tradeAction === 'BUY' ? feesNum : -feesNum);
    if (!isNaN(c) && c > 0 && netTotal > 0) {
      setRateToMyr((c / netTotal).toFixed(4));
    }
  };

  const suppressStockSearchRef = useRef(false);

  // Debounced search when ticker changes
  useEffect(() => {
    if (suppressStockSearchRef.current) {
      suppressStockSearchRef.current = false;
      setIsSearchingStock(false);
      setShowStockDropdown(false);
      return;
    }
    const q = ticker.trim();
    if (!q || editingTrade) {
      setStockSearchResults([]);
      setShowStockDropdown(false);
      return;
    }

    const timer = setTimeout(async () => {
      setIsSearchingStock(true);
      try {
        const res = await fetch(`/api/stocks/search?q=${encodeURIComponent(q)}`);
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data.results)) {
            setStockSearchResults(data.results);
            setShowStockDropdown(true);
          }
        }
      } catch (err) {
        console.warn('Ticker search error:', err);
      } finally {
        setIsSearchingStock(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [ticker, editingTrade]);

  const selectStockItem = async (stock: { symbol: string; name: string; exchange: string; type: string }) => {
    suppressStockSearchRef.current = true;
    setTicker(stock.symbol);
    setAssetName(stock.name || stock.symbol);
    setShowStockDropdown(false);

    // Auto-detect asset type and currency
    let detectedCurr = 'USD';
    if (stock.exchange === 'KLSE' || stock.symbol.endsWith('.KL')) {
      setAssetType('MY Stock');
      detectedCurr = 'MYR';
      setCurrency('MYR');
    } else if (stock.type === 'Cryptocurrency' || stock.symbol.includes('-USD')) {
      setAssetType('Crypto');
      detectedCurr = 'USD';
      setCurrency('USD');
    } else if (stock.type === 'ETF') {
      setAssetType('ETF');
      detectedCurr = 'USD';
      setCurrency('USD');
    } else {
      setAssetType('US Stock');
      detectedCurr = 'USD';
      setCurrency('USD');
    }

    const liveFx = fxRates[detectedCurr] || DEFAULT_RATES_TO_MYR[detectedCurr] || 1.0;
    setRateToMyr(liveFx.toFixed(4));

    // Fetch real-time live price!
    setIsFetchingQuote(true);
    try {
      const res = await fetch(`/api/stocks/quote?ticker=${encodeURIComponent(stock.symbol)}`);
      if (res.ok) {
        const quote = await res.json();
        if (quote.price && quote.price > 0) {
          setPrice(String(quote.price));
          if (quote.currency) {
            setCurrency(quote.currency);
            const updatedFx = fxRates[quote.currency] || DEFAULT_RATES_TO_MYR[quote.currency] || 1.0;
            setRateToMyr(updatedFx.toFixed(4));
          }
          toast.success(`Live price for ${stock.symbol}: ${quote.currency || 'USD'} ${quote.price}`);
        }
      }
    } catch (err) {
      console.warn('Quote fetch failed:', err);
    } finally {
      setIsFetchingQuote(false);
    }
  };

  const handleAddTrade = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ticker.trim()) {
      toast.error('Please enter a ticker symbol (e.g. AAPL, KLSE:MAYBANK, BTC-USD)');
      return;
    }
    const qtyNum = parseFloat(quantity);
    const priceNum = parseFloat(price);
    if (isNaN(qtyNum) || qtyNum <= 0 || isNaN(priceNum) || priceNum <= 0) {
      toast.error('Please enter valid quantity and price');
      return;
    }

    try {
      const feesNum = parseFloat(fees) || 0;
      const totalNum = qtyNum * priceNum + (tradeAction === 'BUY' ? feesNum : -feesNum);
      const rateNum = currency === 'MYR' ? 1.0 : (parseFloat(rateToMyr) || fxRates[currency] || DEFAULT_RATES_TO_MYR[currency] || 1.0);
      const costMyrNum = currency === 'MYR' ? totalNum : (parseFloat(costInMyr) || (totalNum * rateNum));
      const submissionSignature = JSON.stringify([
        date, tradeAction, ticker.trim().toUpperCase(), assetName.trim(), qtyNum,
        priceNum, feesNum, totalNum, currency, rateNum, costMyrNum, notes.trim(), isReinvested,
      ]);
      const cachedRequest = addTradeRequestRef.current;
      const tradeId = editingTrade ? undefined : cachedRequest?.signature === submissionSignature
        ? cachedRequest.id
        : `tr_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`}`;
      if (tradeId) addTradeRequestRef.current = { signature: submissionSignature, id: tradeId };

      let finalNotes = notes.trim();
      const finalAction = (tradeAction === 'DIVIDEND' && isReinvested) ? 'REINVEST' : tradeAction;
      if (tradeAction === 'DIVIDEND' && isReinvested) {
        if (!finalNotes.includes('[Reinvested into Units]')) {
          finalNotes = finalNotes ? `${finalNotes} [Reinvested into Units]` : '[Reinvested into Units]';
        }
      }

      if (editingTrade) {
        await updateTradeMutation.mutateAsync({
          sheetName: 'Trades',
          rowIndex: editingTrade.rowIndex || 2,
          rowData: {
            Id: editingTrade.id,
            Date: date,
            Action: finalAction,
            Ticker: ticker.trim().toUpperCase(),
            'Asset Name': assetName.trim() || ticker.trim().toUpperCase(),
            Quantity: qtyNum,
            Price: priceNum,
            Fees: feesNum,
            'Net Total': totalNum,
            Currency: currency,
            RateToMyr: rateNum,
            rateToMyr: rateNum,
            CostInMyr: costMyrNum,
            costInMyr: costMyrNum,
            Notes: finalNotes,
            isReinvested,
          },
        });
      } else {
        // Keep this payload aligned with the deployed Apps Script addTrade() contract.
        await addTradeMutation.mutateAsync({
          Id: tradeId,
          date,
          action: finalAction,
          ticker: ticker.trim().toUpperCase(),
          name: assetName.trim() || ticker.trim().toUpperCase(),
          type: assetType,
          quantity: qtyNum,
          price: priceNum,
          fees: feesNum,
          total: totalNum,
          currency,
          rateToMyr: rateNum,
          costInMyr: costMyrNum,
          notes: finalNotes,
          isReinvested,
        });
      }

      const successMsg = editingTrade
        ? 'Trade updated'
        : isReinvested
        ? `Reinvested dividend of ${currency} ${totalNum.toFixed(2)} (+${qtyNum} units) recorded! 🎉`
        : `${tradeAction} of ${qtyNum} ${ticker.toUpperCase()} recorded! 🎉`;
      toast.success(successMsg);
      addTradeRequestRef.current = null;
      setIsAddTradeOpen(false);
      setEditingTrade(null);
      // Reset form
      setTicker('');
      setAssetName('');
      setQuantity('');
      setPrice('');
      setFees('0');
      setCostInMyr('');
      setManualCostEdited(false);
      setNotes('');
      setIsReinvested(false);
    } catch (err: any) {
      console.error(err);
      toast.error('Failed to add trade: ' + (err.message || 'Unknown error'));
    }
  };

  const openTradeEditor = (trade: typeof trades[number]) => {
    setEditingTrade(trade);
    const isReinv = trade.action === 'REINVEST' || trade.notes.toLowerCase().includes('reinvest') || Boolean(trade.isReinvested);
    setIsReinvested(isReinv);
    setTradeAction(isReinv ? 'DIVIDEND' : (trade.action as 'BUY' | 'SELL' | 'DIVIDEND'));
    setTicker(trade.ticker);
    setAssetName(trade.name);
    setQuantity(String(trade.quantity));
    setPrice(String(trade.price));
    setFees(String(trade.fees));
    setCurrency(trade.currency);
    setDate(trade.date);
    setNotes(trade.notes);
    const r = trade.rateToMyr || fxRates[trade.currency] || DEFAULT_RATES_TO_MYR[trade.currency] || 4.10;
    setRateToMyr(String(r));
    const c = trade.costInMyr || (trade.currency === 'MYR' ? trade.netTotal : trade.netTotal * r);
    setCostInMyr(c > 0 ? c.toFixed(2) : '');
    setManualCostEdited(true);
    setIsAddTradeOpen(true);
  };

  const handleDeleteTrade = async (trade: typeof trades[number]) => {
    const ok = await confirmAction({
      title: 'Delete Trade?',
      description: `Delete ${trade.action} trade for ${trade.ticker}? Holdings will be automatically recalculated.`,
      confirmText: 'Delete Trade',
      cancelText: 'Cancel',
      variant: 'danger',
      icon: 'trash',
    });
    if (!ok) return;

    try {
      await deleteTradeMutation.mutateAsync({ sheetName: 'Trades', id: trade.id, rowIndex: trade.rowIndex });
      clearAllSwrCache();

      if (typeof window !== 'undefined') {
        try {
          const rawP = localStorage.getItem('cashflow_persistent_trades');
          if (rawP) {
            const pTrades = JSON.parse(rawP);
            if (Array.isArray(pTrades)) {
              const updated = pTrades.filter((t: any) => String(t.Id || t.id || '') !== trade.id);
              localStorage.setItem('cashflow_persistent_trades', JSON.stringify(updated));
            }
          }
        } catch {
          // ignore
        }
      }

      // Optimistically remove deleted trade from local cache so it vanishes in 0ms
      queryClient.setQueryData(['sheet', 'Trades', 'active'], (old: any) => {
        const oldRows = Array.isArray(old) ? old : old?.rows || [];
        const nextRows = oldRows.filter((r: any) => {
          const rId = String(r.Id || r.id || '');
          if (trade.id && rId) return rId !== trade.id;
          if (typeof trade.rowIndex === 'number' && typeof r._rowIndex === 'number') {
            return r._rowIndex !== trade.rowIndex;
          }
          return true;
        });
        return Array.isArray(old) ? nextRows : { ...old, rows: nextRows };
      });

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['portfolio'] }),
        queryClient.refetchQueries({ queryKey: ['portfolio'] }),
      ]);
      toast.success('Trade deleted and holdings recalculated');
    } catch (error: any) {
      console.error(error);
      toast.error('Failed to delete trade: ' + (error?.message || 'Unknown error'));
    }
  };

  const selectHoldingForTrade = (h: typeof holdings[number], nextAction?: 'BUY' | 'SELL' | 'DIVIDEND') => {
    if (nextAction) {
      setTradeAction(nextAction);
      setIsReinvested(false);
    }
    suppressStockSearchRef.current = true;
    setTicker(h.ticker);
    setAssetName(h.name || h.ticker);
    setAssetType(h.type || 'US Stock');
    setCurrency(h.currency || 'USD');
    const r = h.currentFxRate || fxRates[h.currency] || DEFAULT_RATES_TO_MYR[h.currency] || 1.0;
    setRateToMyr(h.currency === 'MYR' ? '1.0' : r.toFixed(4));
    if (h.livePrice > 0) {
      setPrice(String(h.livePrice));
    }
    setManualCostEdited(false);
    setShowStockDropdown(false);
  };

  const closeTradeDialog = () => {
    setIsAddTradeOpen(false);
    setEditingTrade(null);
    window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.cockpit-dock-add')?.focus({ preventScroll: true }));
  };

  const activeHoldingForTicker = useMemo(() => {
    const clean = ticker.trim().toUpperCase();
    return holdings.find(h => h.ticker === clean) || null;
  }, [holdings, ticker]);

  return (
    <div className="cockpit-module-page">
      <CockpitPageHeading
        title="Investment Portfolio"
        description="Real-time stock & crypto tracker with automated Google Sheets formulas"
        action={(
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={isSyncingMoomoo}
              onClick={handleSyncMoomoo}
              className="min-h-[40px] px-3.5 py-2 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 active:scale-[0.97] text-white text-xs font-semibold shadow-lg shadow-emerald-500/20 flex items-center gap-1.5 transition-all cursor-pointer touch-manipulation disabled:opacity-50"
              title="Sync live trades, itemized fees, and cash deposits directly from Moomoo Cloud API"
            >
              {isSyncingMoomoo ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              <span>{isSyncingMoomoo ? 'Syncing...' : 'Sync Moomoo'}</span>
            </button>
            <button
              type="button"
              disabled={isScanningTrade}
              onClick={() => tradeFileInputRef.current?.click()}
              className="min-h-[40px] px-3.5 py-2 rounded-xl bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 active:scale-[0.97] text-white text-xs font-semibold shadow-lg shadow-orange-500/20 flex items-center gap-1.5 transition-all cursor-pointer touch-manipulation disabled:opacity-50"
              title="Scan Moomoo or broker trade confirmation to auto-extract trade and all hidden fees"
            >
              {isScanningTrade ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ScanLine className="h-3.5 w-3.5" />
              )}
              <span>{isScanningTrade ? 'Scanning...' : 'Scan Moomoo'}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setEditingTrade(null);
                setTradeAction('BUY');
                setIsReinvested(false);
                setIsAddTradeOpen(true);
              }}
              className="min-h-[40px] px-4 py-2 rounded-xl bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 active:scale-[0.97] text-white dark:text-white text-xs font-semibold shadow-lg shadow-indigo-500/20 flex items-center gap-1.5 transition-all cursor-pointer touch-manipulation"
            >
              <ArrowUpRight className="h-3.5 w-3.5" />
              <span>+ Buy</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setEditingTrade(null);
                setTradeAction('SELL');
                setIsReinvested(false);
                if (!ticker && holdings.length > 0) {
                  selectHoldingForTrade(holdings[0], 'SELL');
                }
                setIsAddTradeOpen(true);
              }}
              className="min-h-[40px] px-4 py-2 rounded-xl border border-rose-500/35 bg-rose-500/10 hover:bg-rose-500/20 active:scale-[0.97] text-rose-800 dark:text-rose-300 text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer touch-manipulation"
            >
              <ArrowDownRight className="h-3.5 w-3.5" />
              <span>Sell</span>
            </button>
          </div>
        )}
      />

      {/* Metric Cards Banner */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Total Market Value */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          whileHover={{ y: -4, scale: 1.01 }}
          transition={{ type: 'spring' as const, stiffness: 400, damping: 25 }}
          className="p-5 rounded-3xl border border-indigo-500/30 bg-gradient-to-br from-indigo-950/40 via-slate-100 dark:via-zinc-900/60 to-black backdrop-blur-xl shadow-lg hover:border-indigo-500/50 transition-colors specular-card"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs uppercase tracking-wider text-slate-600 dark:text-zinc-400 font-semibold">Portfolio Value</span>
            <div className="h-8 w-8 rounded-xl bg-indigo-500/10 flex items-center justify-center text-indigo-800 dark:text-indigo-400 border border-indigo-500/20 shadow-sm">
              <Activity className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-3">
            <div className="text-2xl md:text-3xl font-black tracking-tight text-slate-950 dark:text-white font-mono">
              <AnimatedNumber value={totalMarketValue} animateOnMount />
            </div>
            <p className="text-xs text-indigo-800/80 dark:text-indigo-400/80 mt-1 font-medium">Live market valuation</p>
          </div>
        </motion.div>

        {/* Total Return / Profit & Loss */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          whileHover={{ y: -4, scale: 1.01 }}
          transition={{ type: 'spring' as const, stiffness: 400, damping: 25 }}
          className="p-5 rounded-3xl border border-slate-200 dark:border-zinc-800/80 bg-white/90 dark:bg-zinc-900/40 backdrop-blur-xl shadow-lg hover:border-emerald-500/40 transition-colors specular-card"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs uppercase tracking-wider text-slate-600 dark:text-zinc-400 font-semibold">Unrealized Return</span>
            <div className={`h-8 w-8 rounded-xl flex items-center justify-center border ${
              totalPnl >= 0 ? 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-400 border-emerald-500/20 shadow-sm' : 'bg-rose-500/10 text-rose-800 dark:text-rose-400 border-rose-500/20 shadow-sm'
            }`}>
              {totalPnl >= 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
            </div>
          </div>
          <div className="mt-3">
            <div className={`text-2xl md:text-3xl font-black tracking-tight font-mono ${
              totalPnl >= 0 ? 'text-emerald-800 dark:text-emerald-400' : 'text-rose-800 dark:text-rose-400'
            }`}>
              <AnimatedNumber value={totalPnl} showPlus animateOnMount />
            </div>
            <p className="text-xs text-slate-600 dark:text-zinc-400 mt-1 font-medium">
              {totalReturnPercent >= 0 ? '+' : ''}{totalReturnPercent.toFixed(2)}% overall gain
            </p>
          </div>
        </motion.div>

        {/* Total Cost Basis */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          whileHover={{ y: -4, scale: 1.01 }}
          transition={{ type: 'spring' as const, stiffness: 400, damping: 25 }}
          className="p-5 rounded-3xl border border-slate-200 dark:border-zinc-800/80 bg-white/90 dark:bg-zinc-900/40 backdrop-blur-xl shadow-lg hover:border-purple-500/40 transition-colors specular-card"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs uppercase tracking-wider text-slate-600 dark:text-zinc-400 font-semibold">Total Invested</span>
            <div className="h-8 w-8 rounded-xl bg-purple-500/10 flex items-center justify-center text-violet-800 dark:text-purple-400 border border-purple-500/20 shadow-sm">
              <DollarSign className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-3">
            <div className="text-2xl md:text-3xl font-black tracking-tight text-slate-950 dark:text-white font-mono">
              <AnimatedNumber value={totalCostBasis} animateOnMount />
            </div>
            <p className="text-xs text-violet-800/80 dark:text-purple-400/80 mt-1 font-medium">Capital invested across assets</p>
          </div>
        </motion.div>

        {/* Dividends & Cash Earned */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          whileHover={{ y: -4, scale: 1.01 }}
          transition={{ type: 'spring' as const, stiffness: 400, damping: 25 }}
          className="p-5 rounded-3xl border border-slate-200 dark:border-zinc-800/80 bg-white/90 dark:bg-zinc-900/40 backdrop-blur-xl shadow-lg hover:border-amber-500/40 transition-colors specular-card"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs uppercase tracking-wider text-slate-600 dark:text-zinc-400 font-semibold">Annual Dividends</span>
            <div className="h-8 w-8 rounded-xl bg-amber-500/10 flex items-center justify-center text-amber-800 dark:text-amber-400 border border-amber-500/20 shadow-sm">
              <Sparkles className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-3">
            <div className="text-2xl md:text-3xl font-black tracking-tight text-amber-800 dark:text-amber-400 font-mono">
              <AnimatedNumber value={annualRealizedGain} animateOnMount />
            </div>
            <p className="text-xs text-amber-800/80 dark:text-amber-400/80 mt-1 font-medium">Dividends received in {new Date().getFullYear()}</p>
          </div>
        </motion.div>
      </div>

      {/* Tab Navigation: Holdings vs Trades with animated sliding indicator */}
      <div className="flex items-center justify-between border-b border-slate-200 dark:border-white/[0.08] pb-3.5">
        <div className="cockpit-segmented-control relative flex items-center gap-1.5 p-1 rounded-2xl bg-white/90 dark:bg-zinc-950/80 border border-slate-200 dark:border-white/[0.08] shadow-sm">
          <button
            onClick={() => setActiveTab('holdings')}
            className={`relative z-10 min-h-[40px] px-4 py-2 rounded-xl text-sm font-semibold transition-colors cursor-pointer touch-manipulation select-none active:scale-[0.96] ${
              activeTab === 'holdings'
                ? 'text-indigo-800 dark:text-indigo-200'
                : 'text-slate-600 dark:text-zinc-400 hover:text-slate-800 dark:hover:text-zinc-200'
            }`}
          >
            {activeTab === 'holdings' && (
              <motion.div
                layoutId="investment-tab-indicator"
                className="cockpit-segmented-pill absolute inset-0 rounded-xl border pointer-events-none"
                transition={{ type: 'spring' as const, stiffness: 450, damping: 32 }}
              />
            )}
            <span className="relative z-10 pointer-events-none">Holdings ({holdings.length})</span>
          </button>
          <button
            onClick={() => setActiveTab('trades')}
            className={`relative z-10 min-h-[40px] px-4 py-2 rounded-xl text-sm font-semibold transition-colors cursor-pointer touch-manipulation select-none active:scale-[0.96] ${
              activeTab === 'trades'
                ? 'text-indigo-800 dark:text-indigo-200'
                : 'text-slate-600 dark:text-zinc-400 hover:text-slate-800 dark:hover:text-zinc-200'
            }`}
          >
            {activeTab === 'trades' && (
              <motion.div
                layoutId="investment-tab-indicator"
                className="cockpit-segmented-pill absolute inset-0 rounded-xl border pointer-events-none"
                transition={{ type: 'spring' as const, stiffness: 450, damping: 32 }}
              />
            )}
            <span className="relative z-10 pointer-events-none">Trade History ({trades.length})</span>
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={async () => {
              await Promise.all([
                queryClient.invalidateQueries({ queryKey: ['sheet'] }),
                queryClient.invalidateQueries({ queryKey: ['portfolio'] }),
                queryClient.refetchQueries({ queryKey: ['sheet', 'Trades', 'active'] }),
                queryClient.refetchQueries({ queryKey: ['portfolio'] }),
              ]);
              toast.success('Holdings & live quotes refreshed! 📈');
            }}
            disabled={isPortfolioLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold text-slate-700 dark:text-zinc-300 hover:text-slate-950 dark:hover:text-white bg-white/90 dark:bg-zinc-900/90 hover:bg-slate-100 dark:hover:bg-zinc-800 border border-slate-200 dark:border-white/[0.08] shadow-sm transition-all active:scale-95 cursor-pointer touch-manipulation disabled:opacity-50"
            title="Force refresh live quotes"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isPortfolioLoading ? 'animate-spin text-indigo-800 dark:text-indigo-400' : 'text-slate-600 dark:text-zinc-400'}`} />
            <span>Refresh Live Quotes</span>
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      {activeTab === 'holdings' ? (
        <div className="space-y-6">
          {/* Holdings Allocation and Breakdown */}
          {holdings.length > 0 && allocationData.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="p-5 rounded-3xl border border-slate-200 dark:border-white/[0.08] bg-card/60 backdrop-blur-2xl shadow-xl flex flex-col items-center justify-center">
                <h3 className="text-xs uppercase font-semibold tracking-wider text-slate-700 dark:text-zinc-300 mb-2">Asset Allocation</h3>
                <div className="h-44 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={allocationData}
                        cx="50%"
                        cy="50%"
                        innerRadius={45}
                        outerRadius={65}
                        paddingAngle={4}
                        dataKey="value"
                        stroke="none"
                      >
                        {allocationData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={{ backgroundColor: '#0f172a', borderColor: 'rgba(255,255,255,0.12)', borderRadius: '16px', color: '#f8fafc', boxShadow: '0 10px 30px rgba(0,0,0,0.5)' }}
                        formatter={(val: any) => [`RM ${Number(val).toFixed(2)}`, 'Market Value']}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="md:col-span-2 p-5 rounded-3xl border border-slate-200 dark:border-white/[0.08] bg-card/60 backdrop-blur-2xl shadow-xl flex flex-col justify-center gap-3">
                <h3 className="text-xs uppercase font-semibold tracking-wider text-slate-600 dark:text-zinc-400">Class Distribution</h3>
                <div className="space-y-2.5">
                  {allocationData.map((item) => {
                    const percent = totalMarketValue > 0 ? (item.value / totalMarketValue) * 100 : 0;
                    return (
                      <div key={item.name} className="space-y-1">
                        <div className="flex items-center justify-between text-xs">
                          <div className="flex items-center gap-2">
                            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color }} />
                            <span className="text-slate-700 dark:text-zinc-300 font-medium">{item.name}</span>
                          </div>
                          <span className="text-slate-600 dark:text-zinc-400 font-mono">RM {item.value.toFixed(2)} ({percent.toFixed(1)}%)</span>
                        </div>
                        <div className="h-1.5 w-full bg-slate-100 dark:bg-zinc-800 rounded-full overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${percent}%`, backgroundColor: item.color }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* Holdings Table */}
          {holdings.length === 0 ? (
            <div className="py-16 text-center rounded-3xl border border-dashed border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/20 p-8">
              <div className="h-12 w-12 rounded-2xl bg-indigo-500/10 text-indigo-800 dark:text-indigo-400 mx-auto flex items-center justify-center mb-3">
                <TrendingUp className="h-6 w-6" />
              </div>
              <h3 className="text-base font-semibold text-slate-950 dark:text-white">No Investment Holdings Yet</h3>
              <p className="text-xs text-slate-600 dark:text-zinc-400 max-w-sm mx-auto mt-1">
                Use the Trade button at the bottom to record a purchase. Kinova will track your units, live prices, and returns automatically.
              </p>
            </div>
          ) : (
            <>
              {/* Mobile Cards View */}
              <div className="md:hidden space-y-3">
                {holdings.map((h) => {
                  const isProfit = h.pnlBase >= 0;
                  return (
                    <div 
                      key={h.ticker} 
                      onClick={() => setSelectedHolding(h)}
                      className="p-4 rounded-2xl border border-slate-200 dark:border-zinc-800/80 bg-white/90 dark:bg-zinc-900/40 hover:bg-slate-100 dark:hover:bg-zinc-800/50 hover:border-slate-300 dark:hover:border-zinc-700/80 transition-all cursor-pointer group active:scale-[0.99] space-y-3"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-base text-slate-950 dark:text-white group-hover:text-indigo-800 dark:group-hover:text-indigo-300 transition-colors">{h.ticker}</span>
                            <span className="px-2 py-0.5 rounded-md text-[10px] font-medium bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-zinc-300">
                              {h.type}
                            </span>
                          </div>
                          <div className="text-xs text-slate-600 dark:text-zinc-400 truncate max-w-[180px] mt-0.5">{h.name}</div>
                        </div>
                        <div className="flex items-center gap-2 text-right">
                          <div>
                            <div className="font-bold text-base text-slate-950 dark:text-white font-mono">
                              RM {h.marketValueBase.toFixed(2)}
                            </div>
                            {h.currency !== 'MYR' && (
                              <div className="text-[10px] text-slate-600 dark:text-zinc-400 font-mono">
                                {formatAssetCurrency(h.marketValue, h.currency)} @ {h.currentFxRate.toFixed(4)}
                              </div>
                            )}
                            <div className={`text-xs font-semibold font-mono ${isProfit ? 'text-emerald-800 dark:text-emerald-400' : 'text-rose-800 dark:text-rose-400'}`}>
                              {formatPnl(h.pnlBase, 'MYR')} ({isProfit ? '+' : ''}{h.returnPercentBase.toFixed(1)}%)
                            </div>
                            {h.currency !== 'MYR' && (
                              <div className="text-[10px] text-slate-500 dark:text-zinc-400 font-mono">
                                Asset: {formatPnl(h.pnl, h.currency)} ({h.pnl >= 0 ? '+' : ''}{h.returnPercent.toFixed(1)}%)
                              </div>
                            )}
                          </div>
                          <ChevronRight className="h-4 w-4 text-slate-600 dark:text-zinc-300 group-hover:text-slate-600 dark:group-hover:text-zinc-400 transition-colors shrink-0" />
                        </div>
                      </div>

                      <div className="grid grid-cols-3 gap-2 pt-2 border-t border-slate-200 dark:border-zinc-800/60 text-xs">
                        <div>
                          <span className="text-slate-500 dark:text-zinc-400 block text-[10px] uppercase">Units</span>
                          <span className="font-medium text-slate-800 dark:text-zinc-200 font-mono">{h.units.toLocaleString()}</span>
                        </div>
                        <div>
                          <span className="text-slate-500 dark:text-zinc-400 block text-[10px] uppercase">Avg Cost</span>
                          <span className="font-medium text-slate-700 dark:text-zinc-300 font-mono">{formatAssetCurrency(h.avgCost, h.currency)}</span>
                          {h.currency !== 'MYR' && (
                            <span className="text-[10px] text-slate-500 dark:text-zinc-400 block font-mono">RM {h.avgCostBase.toFixed(2)}</span>
                          )}
                        </div>
                        <div className="text-right">
                          <span className="text-slate-500 dark:text-zinc-400 block text-[10px] uppercase">Live Price</span>
                          <span className="font-medium text-slate-950 dark:text-white font-mono">{formatAssetCurrency(h.livePrice, h.currency)}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Desktop Table View */}
              <div className="hidden md:block overflow-x-auto rounded-3xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/30">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-zinc-800 text-xs uppercase tracking-wider text-slate-600 dark:text-zinc-400 bg-white/90 dark:bg-zinc-900/60">
                      <th className="p-4">Asset</th>
                      <th className="p-4">Type</th>
                      <th className="p-4 text-right">Units</th>
                      <th className="p-4 text-right">Avg Cost</th>
                      <th className="p-4 text-right">Live Price</th>
                      <th className="p-4 text-right">Market Value (MYR)</th>
                      <th className="p-4 text-right">Cost Basis (MYR)</th>
                      <th className="p-4 text-right">True Return (MYR)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/60">
                    {holdings.map((h) => {
                      const isProfit = h.pnlBase >= 0;
                      return (
                        <tr 
                          key={h.ticker} 
                          onClick={() => setSelectedHolding(h)}
                          className="hover:bg-slate-100 dark:hover:bg-zinc-800/40 transition-colors cursor-pointer group"
                        >
                          <td className="p-4">
                            <div className="font-bold text-slate-950 dark:text-white group-hover:text-indigo-800 dark:group-hover:text-indigo-300 transition-colors">{h.ticker}</div>
                            <div className="text-xs text-slate-600 dark:text-zinc-400 truncate max-w-[160px]">{h.name}</div>
                          </td>
                          <td className="p-4">
                            <span className="px-2 py-0.5 rounded-md text-[11px] font-medium bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-zinc-300">
                              {h.type}
                            </span>
                          </td>
                          <td className="p-4 text-right font-medium text-slate-800 dark:text-zinc-200">
                            {h.units.toLocaleString()}
                          </td>
                          <td className="p-4 text-right text-slate-600 dark:text-zinc-400 font-mono">
                            <div>{formatAssetCurrency(h.avgCost, h.currency)}</div>
                            {h.currency !== 'MYR' && (
                              <div className="text-[11px] text-slate-500 dark:text-zinc-400 font-mono">RM {h.avgCostBase.toFixed(2)}</div>
                            )}
                          </td>
                          <td className="p-4 text-right font-medium text-slate-950 dark:text-white font-mono">
                            {formatAssetCurrency(h.livePrice, h.currency)}
                          </td>
                          <td className="p-4 text-right font-bold text-slate-950 dark:text-white font-mono">
                            <div>RM {h.marketValueBase.toFixed(2)}</div>
                            {h.currency !== 'MYR' && (
                              <div className="text-[11px] text-slate-600 dark:text-zinc-400 font-normal">
                                {formatAssetCurrency(h.marketValue, h.currency)} @ {h.currentFxRate.toFixed(4)}
                              </div>
                            )}
                          </td>
                          <td className="p-4 text-right text-slate-700 dark:text-zinc-300 font-mono">
                            <div>RM {h.totalCostBase.toFixed(2)}</div>
                            {h.currency !== 'MYR' && (
                              <div className="text-[11px] text-slate-500 dark:text-zinc-400 font-normal">
                                {formatAssetCurrency(h.totalCost, h.currency)}
                              </div>
                            )}
                          </td>
                          <td className="p-4 text-right">
                            <div className={`font-bold font-mono ${isProfit ? 'text-emerald-800 dark:text-emerald-400' : 'text-rose-800 dark:text-rose-400'}`}>
                              {formatPnl(h.pnlBase, 'MYR')}
                            </div>
                            <div className={`text-xs font-mono ${isProfit ? 'text-emerald-700 dark:text-emerald-500' : 'text-rose-700 dark:text-rose-500'}`}>
                              {isProfit ? '+' : ''}{h.returnPercentBase.toFixed(2)}%
                            </div>
                            {h.currency !== 'MYR' && (
                              <div className="text-[10px] text-slate-500 dark:text-zinc-400 font-mono">
                                Stock: {formatPnl(h.pnl, h.currency)} ({h.pnl >= 0 ? '+' : ''}{h.returnPercent.toFixed(2)}%)
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      ) : (
        /* Trade History View */
        <div className="space-y-4">
          {trades.length === 0 ? (
            <div className="py-16 text-center rounded-3xl border border-dashed border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/20 p-8">
              <div className="h-12 w-12 rounded-2xl bg-indigo-500/10 text-indigo-800 dark:text-indigo-400 mx-auto flex items-center justify-center mb-3">
                <History className="h-6 w-6" />
              </div>
              <h3 className="text-base font-semibold text-slate-950 dark:text-white">No Trades Logged Yet</h3>
              <p className="text-xs text-slate-600 dark:text-zinc-400 max-w-sm mx-auto mt-1">
                Your Buy, Sell, and Dividend activity will appear here. Use the Trade button at the bottom to record your first entry.
              </p>
            </div>
          ) : (
            <>
              {/* Mobile Trades Card View */}
              <div className="md:hidden space-y-2.5">
                {trades.map((t) => (
                  <div 
                    key={t.id} 
                    onClick={() => setSelectedTrade(t)}
                    className="p-3.5 rounded-2xl border border-slate-200 dark:border-zinc-800/80 bg-white/90 dark:bg-zinc-900/40 hover:bg-slate-100 dark:hover:bg-zinc-800/50 hover:border-slate-300 dark:hover:border-zinc-700/80 transition-all cursor-pointer group flex items-center justify-between"
                  >
                    <div className="flex items-center gap-3">
                      <span className={`px-2.5 py-1 rounded-xl text-xs font-bold ${
                        t.action === 'BUY'
                          ? 'bg-indigo-500/20 text-indigo-800 dark:text-indigo-300'
                          : t.action === 'SELL'
                          ? 'bg-rose-500/20 text-rose-800 dark:text-rose-300'
                          : (t.action === 'REINVEST' || t.isReinvested || t.notes.toLowerCase().includes('reinvest'))
                          ? 'bg-cyan-500/20 text-cyan-800 dark:text-cyan-300'
                          : 'bg-emerald-500/20 text-emerald-800 dark:text-emerald-300'
                      }`}>
                        {t.action === 'REINVEST' || t.isReinvested || t.notes.toLowerCase().includes('reinvest') ? 'REINVEST' : t.action}
                      </span>
                      <div>
                        <div className="font-bold text-sm text-slate-950 dark:text-white group-hover:text-indigo-800 dark:group-hover:text-indigo-300 transition-colors">{t.ticker}</div>
                        <div className="text-[11px] text-slate-600 dark:text-zinc-400 font-mono">{t.date} • {t.quantity} @ {formatAssetCurrency(t.price, t.currency)}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 text-right">
                      <div>
                        <div className="font-bold text-sm text-slate-950 dark:text-white font-mono">{formatAssetCurrency(t.netTotal, t.currency)}</div>
                        {t.currency !== 'MYR' && (
                          <div className="text-[11px] text-indigo-800 dark:text-indigo-300 font-mono">RM {t.costInMyr.toFixed(2)}</div>
                        )}
                        {t.notes && <div className="text-[10px] text-slate-500 dark:text-zinc-400 truncate max-w-[100px]">{t.notes}</div>}
                      </div>
                      <ChevronRight className="h-4 w-4 text-slate-600 dark:text-zinc-300 group-hover:text-slate-600 dark:group-hover:text-zinc-400 transition-colors shrink-0" />
                    </div>
                  </div>
                ))}
              </div>

              {/* Desktop Trades Table */}
              <div className="hidden md:block overflow-x-auto rounded-3xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/30">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-zinc-800 text-xs uppercase tracking-wider text-slate-600 dark:text-zinc-400 bg-white/90 dark:bg-zinc-900/60">
                      <th className="p-4">Date</th>
                      <th className="p-4">Action</th>
                      <th className="p-4">Ticker</th>
                      <th className="p-4 text-right">Quantity</th>
                      <th className="p-4 text-right">Price</th>
                      <th className="p-4 text-right">Net Total</th>
                      <th className="p-4 text-right">Cost (MYR)</th>
                      <th className="p-4">Notes</th>
                      <th className="p-4" aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/60">
                    {trades.map((t) => (
                      <tr 
                        key={t.id} 
                        onClick={() => setSelectedTrade(t)}
                        className="hover:bg-slate-100 dark:hover:bg-zinc-800/40 transition-colors cursor-pointer group"
                      >
                        <td className="p-4 text-xs text-slate-600 dark:text-zinc-400">{t.date}</td>
                        <td className="p-4">
                          <span className={`px-2 py-0.5 rounded-md text-[11px] font-bold ${
                            t.action === 'BUY'
                              ? 'bg-indigo-500/20 text-indigo-800 dark:text-indigo-300'
                              : t.action === 'SELL'
                              ? 'bg-rose-500/20 text-rose-800 dark:text-rose-300'
                              : (t.action === 'REINVEST' || t.isReinvested || t.notes.toLowerCase().includes('reinvest'))
                              ? 'bg-cyan-500/20 text-cyan-800 dark:text-cyan-300'
                              : 'bg-emerald-500/20 text-emerald-800 dark:text-emerald-300'
                          }`}>
                            {t.action === 'REINVEST' || t.isReinvested || t.notes.toLowerCase().includes('reinvest') ? 'REINVEST' : t.action}
                          </span>
                        </td>
                        <td className="p-4 font-bold text-slate-950 dark:text-white">
                          <span className="group-hover:text-indigo-800 dark:group-hover:text-indigo-300 transition-colors">{t.ticker}</span>
                          {t.name && <span className="text-xs text-slate-600 dark:text-zinc-400 font-normal ml-2">{t.name}</span>}
                        </td>
                        <td className="p-4 text-right text-slate-800 dark:text-zinc-200 font-mono">{t.quantity}</td>
                        <td className="p-4 text-right text-slate-700 dark:text-zinc-300 font-mono">{formatAssetCurrency(t.price, t.currency)}</td>
                        <td className="p-4 text-right font-bold text-slate-950 dark:text-white font-mono">{formatAssetCurrency(t.netTotal, t.currency)}</td>
                        <td className="p-4 text-right font-mono text-slate-700 dark:text-zinc-300">
                          {t.currency === 'MYR' ? `RM ${t.netTotal.toFixed(2)}` : (
                            <div>
                              <div className="text-indigo-800 dark:text-indigo-300 font-semibold">RM {t.costInMyr.toFixed(2)}</div>
                              <div className="text-[10px] text-slate-500 dark:text-zinc-400 font-normal">Rate: {t.rateToMyr ? t.rateToMyr.toFixed(4) : '—'}</div>
                            </div>
                          )}
                        </td>
                        <td className="p-4 text-xs text-slate-600 dark:text-zinc-400">{t.notes || '—'}</td>
                        <td className="p-4 text-right">
                          <div className="flex justify-end gap-1">
                            <button type="button" title="Edit trade" onClick={(e) => { e.stopPropagation(); openTradeEditor(t); }} className="p-1.5 text-slate-500 dark:text-zinc-400 hover:text-indigo-800 dark:hover:text-indigo-400 cursor-pointer"><Edit2 className="h-4 w-4" /></button>
                            <button type="button" title="Delete trade" onClick={(e) => { e.stopPropagation(); void handleDeleteTrade(t); }} className="p-1.5 text-slate-500 dark:text-zinc-400 hover:text-rose-800 dark:hover:text-rose-400 cursor-pointer"><Trash2 className="h-4 w-4" /></button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* Add Trade Modal */}
      <CockpitModal
        isOpen={isAddTradeOpen}
        onClose={closeTradeDialog}
        labelledBy="investment-trade-title"
        describedBy="investment-trade-description"
        size="standard"
      >
        <CockpitModalHeader
          title={editingTrade ? 'Edit trade' : 'Record a trade'}
          titleId="investment-trade-title"
          description={editingTrade ? `Update the details for ${ticker || 'this trade'}.` : 'Add a buy, sell or dividend to your portfolio.'}
          descriptionId="investment-trade-description"
          icon={<TrendingUp size={20} aria-hidden="true" />}
          onClose={closeTradeDialog}
          closeLabel="Close trade dialog"
        />

        {/* Hidden file input for Moomoo / Broker screenshots */}
        <input
          ref={tradeFileInputRef}
          type="file"
          accept="image/*,application/pdf"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) {
              void handleScanTradeFile(file);
            }
          }}
        />

        {/* Auto-Scan Moomoo Prompt Card */}
        <div className="mt-4 p-3 rounded-2xl bg-gradient-to-r from-amber-500/10 via-orange-500/10 to-indigo-500/10 border border-amber-500/30 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="h-8 w-8 rounded-xl bg-orange-500/20 text-orange-800 dark:text-orange-400 flex items-center justify-center shrink-0">
              {isScanningTrade ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
            </div>
            <div className="min-w-0">
              <p className="text-xs font-bold text-slate-900 dark:text-white truncate">
                {isScanningTrade ? 'AI Analyzing Moomoo Trade...' : 'Auto-Fill from Moomoo'}
              </p>
              <p className="text-[11px] text-slate-600 dark:text-zinc-400 truncate">
                Upload screenshot to auto-extract trade & hidden fees
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={isScanningTrade}
            onClick={() => tradeFileInputRef.current?.click()}
            className="shrink-0 px-3 py-1.5 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 active:scale-[0.97] text-white font-semibold text-xs transition-all flex items-center gap-1 shadow-md shadow-orange-500/20 cursor-pointer disabled:opacity-50"
          >
            {isScanningTrade ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Upload className="h-3 w-3" />
            )}
            <span>{isScanningTrade ? 'Reading...' : 'Upload'}</span>
          </button>
        </div>

              <form onSubmit={handleAddTrade} className="mt-3.5 space-y-3.5">
                {/* Action Selector */}
                <div>
                  <div className="investment-action-label">Trade type</div>
                  <div className="grid grid-cols-3 gap-2 investment-action-choices">
                    {(['BUY', 'SELL', 'DIVIDEND'] as const).map(act => (
                      <button
                        key={act}
                        type="button"
                        aria-pressed={tradeAction === act}
                        onClick={() => {
                          setTradeAction(act);
                          if (act === 'DIVIDEND') {
                            if (assetType === 'Unit Trust' || assetType === 'ASNB' || ticker.includes('ASB') || ticker.includes('ASM')) {
                              setIsReinvested(true);
                              if (!price || parseFloat(price) <= 0) setPrice('1.00');
                            }
                          } else {
                            setIsReinvested(false);
                            if (act === 'SELL' && !ticker && holdings.length > 0 && !editingTrade) {
                              selectHoldingForTrade(holdings[0], 'SELL');
                            }
                          }
                        }}
                        className={`investment-action-choice is-${act.toLowerCase()} ${tradeAction === act ? 'is-selected' : ''}`}
                      >
                        <span className="investment-action-choice-title">{act === 'DIVIDEND' ? 'Dividend' : act === 'BUY' ? 'Buy' : 'Sell'}</span>
                        <span className="investment-action-choice-description">
                          {act === 'BUY' ? 'Add to holdings' : act === 'SELL' ? 'Reduce holdings' : 'Cash or reinvest'}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Quick Holding Selector Pills (especially helpful for SELL / DCA BUY) */}
                {holdings.length > 0 && !editingTrade && (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-600 dark:text-zinc-400">
                        {tradeAction === 'SELL' ? 'Select holding to sell' : 'Quick select from holdings'}
                      </span>
                      {activeHoldingForTicker && (
                        <span className="text-[11px] font-mono text-indigo-800 dark:text-indigo-300 font-semibold">
                          Held: {activeHoldingForTicker.units} units
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {holdings.map((h) => {
                        const isSelected = ticker.trim().toUpperCase() === h.ticker;
                        return (
                          <button
                            key={h.ticker}
                            type="button"
                            onClick={() => selectHoldingForTrade(h)}
                            className={`px-2.5 py-1 rounded-xl text-xs font-mono font-bold border transition-all cursor-pointer flex items-center gap-1.5 ${
                              isSelected
                                ? tradeAction === 'SELL'
                                  ? 'bg-rose-500/20 border-rose-500/50 text-rose-800 dark:text-rose-300'
                                  : 'bg-indigo-500/20 border-indigo-500/50 text-indigo-800 dark:text-indigo-300'
                                : 'bg-white/80 dark:bg-zinc-900/60 border-slate-200 dark:border-zinc-800 text-slate-700 dark:text-zinc-300 hover:border-indigo-500/40'
                            }`}
                          >
                            <span>{h.ticker}</span>
                            <span className="text-[10px] font-normal opacity-80">({h.units})</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Reinvestment Toggle & Helper for ASNB / Unit Trust / DRIP */}
                {tradeAction === 'DIVIDEND' && (
                  <div className="p-3 rounded-2xl bg-emerald-950/25 border border-emerald-500/30 space-y-2">
                    <label className="flex items-start gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={isReinvested}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setIsReinvested(checked);
                          if (checked && (!price || parseFloat(price) <= 0)) {
                            setPrice('1.00');
                          }
                        }}
                        className="h-4 w-4 mt-0.5 rounded accent-emerald-500 cursor-pointer"
                      />
                      <div className="flex-1">
                        <div className="text-xs font-bold text-emerald-800 dark:text-emerald-400 flex items-center gap-1.5">
                          <span>Reinvest Dividend into Units (e.g. ASNB, DRIP)</span>
                        </div>
                        <p className="text-[11px] text-slate-600 dark:text-zinc-400 mt-0.5 leading-relaxed">
                          When checked, the dividend automatically credits new units into your portfolio holding while tracking income in your annual earnings!
                        </p>
                      </div>
                    </label>

                    {isReinvested && (
                      <div className="flex items-center justify-between pt-2 border-t border-emerald-500/20 text-xs">
                        <span className="text-slate-600 dark:text-zinc-400 font-medium">Reinvested Dividend Total:</span>
                        <span className="font-bold font-mono text-emerald-800 dark:text-emerald-400">
                          {currency} {((parseFloat(quantity) || 0) * (parseFloat(price) || 0)).toFixed(2)}
                        </span>
                      </div>
                    )}
                  </div>
                )}

                {/* Ticker & Asset Type */}
                <div className="grid grid-cols-2 gap-2.5">
                  <div className="relative">
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs font-semibold text-slate-600 dark:text-zinc-400 uppercase tracking-wider block">
                        Ticker / Symbol
                      </label>
                      {isSearchingStock && (
                        <span className="text-[10px] text-indigo-800 dark:text-indigo-400 flex items-center gap-1">
                          <Loader2 className="h-3 w-3 animate-spin" />
                        </span>
                      )}
                    </div>
                    <div className="relative">
                      <input
                        type="text"
                        placeholder="e.g. AAPL, 1155.KL"
                        value={ticker}
                        onChange={(e) => {
                          setTicker(e.target.value.toUpperCase());
                          setShowStockDropdown(true);
                        }}
                        onFocus={() => {
                          if (stockSearchResults.length > 0) setShowStockDropdown(true);
                        }}
                        required
                        className="w-full rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/60 p-2.5 text-sm text-slate-950 dark:text-white font-mono uppercase outline-none focus:border-indigo-500"
                      />
                    </div>

                    {/* Worldwide Stock Dropdown */}
                    {showStockDropdown && stockSearchResults.length > 0 && (
                      <div className="absolute left-0 right-0 z-50 mt-1 max-h-56 w-[min(320px,85vw)] overflow-y-auto rounded-xl border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-1 shadow-2xl backdrop-blur-xl">
                        <div className="px-2 py-1 text-[10px] font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-wider flex items-center justify-between border-b border-slate-200 dark:border-zinc-800/80 mb-1">
                          <span>Worldwide Stock Search</span>
                          <button
                            type="button"
                            onClick={() => setShowStockDropdown(false)}
                            className="text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                        {stockSearchResults.map(item => (
                          <button
                            key={item.symbol}
                            type="button"
                            onClick={() => selectStockItem(item)}
                            className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left hover:bg-indigo-500/20 transition-colors group cursor-pointer"
                          >
                            <div className="min-w-0 pr-2">
                              <div className="flex items-center gap-1.5">
                                <span className="font-mono font-bold text-xs text-slate-950 dark:text-white group-hover:text-indigo-800 dark:group-hover:text-indigo-300">
                                  {item.symbol}
                                </span>
                                {item.exchange && (
                                  <span className="rounded px-1.5 py-0.5 bg-slate-100 dark:bg-zinc-800 text-[10px] text-slate-600 dark:text-zinc-400 font-mono">
                                    {item.exchange}
                                  </span>
                                )}
                              </div>
                              <p className="truncate text-[11px] text-slate-600 dark:text-zinc-400 group-hover:text-slate-800 dark:group-hover:text-zinc-200">
                                {item.name}
                              </p>
                            </div>
                            <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-zinc-800/60 text-slate-600 dark:text-zinc-400">
                              {item.type}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-slate-600 dark:text-zinc-400 uppercase tracking-wider block mb-1">Asset Type</label>
                    <select
                      value={assetType}
                      onChange={(e) => {
                        const val = e.target.value;
                        setAssetType(val);
                        if (val === 'ASNB') {
                          setCurrency('MYR');
                          setRateToMyr('1.0');
                          if (!price || parseFloat(price) <= 0) setPrice('1.00');
                        }
                      }}
                      className="w-full rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/60 p-2.5 text-sm text-slate-950 dark:text-white outline-none focus:border-indigo-500"
                    >
                      <option value="US Stock">US Stock</option>
                      <option value="MY Stock">MY Stock (Bursa)</option>
                      <option value="Crypto">Crypto</option>
                      <option value="ETF">ETF</option>
                      <option value="Unit Trust">Unit Trust</option>
                      <option value="ASNB">ASNB (Amanah Saham)</option>
                    </select>
                  </div>
                </div>

                {/* Asset Name */}
                <div>
                  <label className="text-xs font-semibold text-slate-600 dark:text-zinc-400 uppercase tracking-wider block mb-1">Asset Name / Company</label>
                  <input
                    type="text"
                    placeholder="e.g. Apple Inc. / Maybank"
                    value={assetName}
                    onChange={(e) => setAssetName(e.target.value)}
                    className="w-full rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/60 p-2.5 text-sm text-slate-950 dark:text-white outline-none focus:border-indigo-500"
                  />
                </div>

                {/* Quantity & Price */}
                <div className="grid grid-cols-2 gap-2.5">
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs font-semibold text-slate-600 dark:text-zinc-400 uppercase tracking-wider block">
                        {tradeAction === 'DIVIDEND'
                          ? isReinvested
                            ? 'Units Credited'
                            : 'Quantity'
                          : 'Quantity'}
                      </label>
                      {tradeAction === 'SELL' && activeHoldingForTicker && (
                        <button
                          type="button"
                          onClick={() => setQuantity(String(activeHoldingForTicker.units))}
                          className="text-[10px] font-mono font-bold text-rose-800 dark:text-rose-400 hover:underline cursor-pointer"
                        >
                          Max: {activeHoldingForTicker.units}
                        </button>
                      )}
                    </div>
                    <input
                      type="number"
                      step="any"
                      placeholder={tradeAction === 'DIVIDEND' && isReinvested ? '500' : '10'}
                      value={quantity}
                      onChange={(e) => setQuantity(e.target.value)}
                      required
                      className="w-full rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/60 p-2.5 text-sm text-slate-950 dark:text-white font-mono outline-none focus:border-indigo-500"
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs font-semibold text-slate-600 dark:text-zinc-400 uppercase tracking-wider block">
                        {tradeAction === 'DIVIDEND'
                          ? isReinvested
                            ? `Unit Price (${currency})`
                            : `Amount (${currency})`
                          : `Price (${currency})`}
                      </label>
                      {ticker && (
                        <button
                          type="button"
                          disabled={isFetchingQuote}
                          onClick={() => selectStockItem({ symbol: ticker, name: assetName, exchange: '', type: assetType })}
                          className="text-[10px] text-indigo-800 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 flex items-center gap-1 cursor-pointer disabled:opacity-50"
                        >
                          {isFetchingQuote ? <Loader2 className="h-3 w-3 animate-spin" /> : <Activity className="h-3 w-3" />}
                          <span>Live</span>
                        </button>
                      )}
                    </div>
                    <input
                      type="number"
                      step="any"
                      placeholder={tradeAction === 'DIVIDEND' && isReinvested ? '1.00' : '180.50'}
                      value={price}
                      onChange={(e) => setPrice(e.target.value)}
                      required
                      className="w-full rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/60 p-2.5 text-sm text-slate-950 dark:text-white font-mono outline-none focus:border-indigo-500"
                    />
                  </div>
                </div>
                <MoneyCalculator
                  value={price}
                  onChange={setPrice}
                  currency={currency}
                  compact
                />

                {/* Trading Fees & Net Total Calculation */}
                <div className="grid grid-cols-2 gap-2.5">
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs font-semibold text-slate-600 dark:text-zinc-400 uppercase tracking-wider block">
                        Trading Fees ({currency})
                      </label>
                      <span className="text-[10px] text-slate-500 dark:text-zinc-400 font-mono">
                        Comm, Platform, SEC
                      </span>
                    </div>
                    <input
                      type="number"
                      step="any"
                      placeholder="0.00"
                      value={fees}
                      onChange={(e) => setFees(e.target.value)}
                      className="w-full rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/60 p-2.5 text-sm text-slate-950 dark:text-white font-mono outline-none focus:border-indigo-500"
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs font-semibold text-slate-600 dark:text-zinc-400 uppercase tracking-wider block">
                        {tradeAction === 'BUY' ? `Net Total Paid (${currency})` : `Net Proceeds (${currency})`}
                      </label>
                    </div>
                    <div className="w-full rounded-xl border border-indigo-500/30 bg-indigo-500/10 dark:bg-indigo-950/20 p-2.5 text-sm text-indigo-900 dark:text-indigo-300 font-mono font-bold flex items-center justify-between">
                      <span>{currency}</span>
                      <span>
                        {(() => {
                          const q = parseFloat(quantity) || 0;
                          const p = parseFloat(price) || 0;
                          const f = parseFloat(fees) || 0;
                          const total = tradeAction === 'BUY' ? (q * p + f) : Math.max(0, q * p - f);
                          return total.toFixed(2);
                        })()}
                      </span>
                    </div>
                  </div>
                </div>

                {parseFloat(quantity) > 0 && parseFloat(price) > 0 && (
                  <div className="text-[11px] text-slate-500 dark:text-zinc-400 font-mono flex items-center justify-between px-1 -mt-1">
                    <span>Principal: {(parseFloat(quantity) * parseFloat(price)).toFixed(2)} {currency}</span>
                    <span>{tradeAction === 'BUY' ? `+ Fees: ${(parseFloat(fees) || 0).toFixed(2)}` : `- Fees: ${(parseFloat(fees) || 0).toFixed(2)}`}</span>
                  </div>
                )}

                {/* Currency & Date */}
                <div className="grid grid-cols-2 gap-2.5">
                  <div>
                    <label className="text-xs font-semibold text-slate-600 dark:text-zinc-400 uppercase tracking-wider block mb-1">Currency</label>
                    <select
                      value={currency}
                      onChange={(e) => {
                        const newCurr = e.target.value;
                        setCurrency(newCurr);
                        const r = fxRates[newCurr] || DEFAULT_RATES_TO_MYR[newCurr] || 1.0;
                        setRateToMyr(r.toFixed(4));
                        setManualCostEdited(false);
                      }}
                      className="w-full rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/60 p-2.5 text-sm text-slate-950 dark:text-white outline-none focus:border-indigo-500"
                    >
                      <option value="USD">USD ($)</option>
                      <option value="MYR">MYR (RM)</option>
                      <option value="SGD">SGD (S$)</option>
                      <option value="CNY">CNY (¥)</option>
                      <option value="HKD">HKD (HK$)</option>
                      <option value="EUR">EUR (€)</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-slate-600 dark:text-zinc-400 uppercase tracking-wider block mb-1">Trade Date</label>
                    <input
                      type="date"
                      value={date}
                      onChange={(e) => setDate(e.target.value)}
                      required
                      className="w-full rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/60 p-2.5 text-sm text-slate-950 dark:text-white outline-none focus:border-indigo-500"
                    />
                  </div>
                </div>

                {/* Real-time FX & MYR Historical Cost Basis */}
                {currency !== 'MYR' && (
                  <div className="p-3 rounded-2xl bg-indigo-950/30 border border-indigo-500/25 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-indigo-800 dark:text-indigo-300 flex items-center gap-1.5">
                        <Sparkles className="h-3.5 w-3.5 text-indigo-800 dark:text-indigo-400" />
                        Live FX & MYR {tradeAction === 'SELL' ? 'Proceeds' : 'Cost'}
                      </span>
                      <span className="text-[11px] text-slate-600 dark:text-zinc-400 font-mono">
                        1 {currency} = {fxRates[currency] ? fxRates[currency].toFixed(4) : (DEFAULT_RATES_TO_MYR[currency] || '4.10')} MYR
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-2.5">
                      <div>
                        <label className="text-[11px] font-medium text-slate-600 dark:text-zinc-400 block mb-1">
                          FX Rate ({currency}/MYR)
                        </label>
                        <input
                          type="number"
                          step="any"
                          placeholder="4.10"
                          value={rateToMyr}
                          onChange={(e) => handleRateChange(e.target.value)}
                          className="w-full rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/80 p-2.5 text-sm text-slate-950 dark:text-white font-mono outline-none focus:border-indigo-500"
                        />
                      </div>

                      <div>
                        <label className="text-[11px] font-medium text-slate-600 dark:text-zinc-400 block mb-1">
                          {tradeAction === 'SELL' ? 'Actual MYR Received' : 'Actual MYR Paid'}
                        </label>
                        <div className="relative">
                          <span className="absolute left-3 top-2.5 text-sm text-slate-600 dark:text-zinc-400 font-medium">RM</span>
                          <input
                            type="number"
                            step="any"
                            placeholder="0.00"
                            value={costInMyr}
                            onChange={(e) => handleCostInMyrChange(e.target.value)}
                            className="w-full rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/80 p-2.5 pl-10 text-sm text-slate-950 dark:text-white font-mono outline-none focus:border-indigo-500"
                          />
                        </div>
                      </div>
                    </div>
                    <MoneyCalculator
                      value={costInMyr}
                      onChange={handleCostInMyrChange}
                      currency="MYR"
                      compact
                      showQuickBarWhenClosed={false}
                    />
                  </div>
                )}

                {/* Notes */}
                <div>
                  <label className="text-xs font-semibold text-slate-600 dark:text-zinc-400 uppercase tracking-wider block mb-1">Notes</label>
                  <input
                    type="text"
                    placeholder="e.g. Dividend reinvestment / DCA"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    className="w-full rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/60 p-2.5 text-sm text-slate-950 dark:text-white outline-none focus:border-indigo-500"
                  />
                </div>

                {/* Submit */}
                <button
                  type="submit"
                  disabled={addTradeMutation.isPending || updateTradeMutation.isPending}
                  className="w-full py-3 rounded-2xl bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 text-white dark:text-white font-semibold text-sm shadow-lg shadow-indigo-500/25 transition-all flex items-center justify-center gap-2 cursor-pointer mt-2"
                >
                  {addTradeMutation.isPending || updateTradeMutation.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>{editingTrade ? 'Updating Trade...' : 'Recording Trade...'}</span>
                    </>
                  ) : (
                    <span>{editingTrade ? 'Save Trade Changes' : 'Save Trade & Update Sheet'}</span>
                  )}
                </button>
              </form>
      </CockpitModal>

      {/* Trade Detail Modal */}
      {selectedTrade && (
        <CockpitModal
          id="investment-trade-details-dialog"
          isOpen={Boolean(selectedTrade)}
          onClose={() => setSelectedTrade(null)}
          labelledBy="investment-trade-details-title"
          describedBy="investment-trade-details-description"
          size="standard"
          className="space-y-5"
        >
          <CockpitModalHeader
            title={selectedTrade.ticker}
            titleId="investment-trade-details-title"
            description={`${selectedTrade.action === 'REINVEST' || selectedTrade.isReinvested || selectedTrade.notes.toLowerCase().includes('reinvest') ? 'Reinvest' : selectedTrade.action} · ${selectedTrade.date}`}
            descriptionId="investment-trade-details-description"
            icon={<TrendingUp size={20} />}
            onClose={() => setSelectedTrade(null)}
            closeLabel="Close trade details"
          />

              {/* Amount Display */}
              <div className="text-center py-2">
                <div className={`text-3xl sm:text-4xl font-black font-mono tracking-tight ${
                  selectedTrade.action === 'BUY'
                    ? 'text-indigo-800 dark:text-indigo-400'
                    : selectedTrade.action === 'SELL'
                    ? 'text-rose-800 dark:text-rose-400'
                    : (selectedTrade.action === 'REINVEST' || selectedTrade.isReinvested || selectedTrade.notes.toLowerCase().includes('reinvest'))
                    ? 'text-cyan-800 dark:text-cyan-400'
                    : 'text-emerald-800 dark:text-emerald-400'
                }`}>
                  {formatAssetCurrency(selectedTrade.netTotal, selectedTrade.currency)}
                </div>
                {selectedTrade.currency !== 'MYR' && (
                  <p className="text-xs text-indigo-800 dark:text-indigo-300 font-mono mt-1 font-semibold">
                    Cost: RM {selectedTrade.costInMyr.toFixed(2)} (@ {selectedTrade.rateToMyr.toFixed(4)})
                  </p>
                )}
                <p className="text-xs text-slate-600 dark:text-zinc-400 mt-1 font-medium">{selectedTrade.date}</p>
              </div>

              {/* Details List */}
              <div className="space-y-3 rounded-2xl bg-white/90 dark:bg-zinc-900/40 border border-slate-200 dark:border-zinc-800/80 p-4 text-xs">
                <div>
                  <span className="text-slate-500 dark:text-zinc-400 block mb-0.5 font-medium">Asset & Ticker</span>
                  <p className="text-sm font-semibold text-slate-950 dark:text-white break-words">
                    {selectedTrade.ticker} {selectedTrade.name && selectedTrade.name !== selectedTrade.ticker ? `• ${selectedTrade.name}` : ''}
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-3 pt-2 border-t border-slate-200 dark:border-zinc-800/60">
                  <div>
                    <span className="text-slate-500 dark:text-zinc-400 block mb-0.5 font-medium">Quantity</span>
                    <span className="font-semibold text-slate-800 dark:text-zinc-200 font-mono">{selectedTrade.quantity} shares</span>
                  </div>
                  <div>
                    <span className="text-slate-500 dark:text-zinc-400 block mb-0.5 font-medium">Price per Share</span>
                    <span className="font-semibold text-slate-800 dark:text-zinc-200 font-mono">{formatAssetCurrency(selectedTrade.price, selectedTrade.currency)}</span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 pt-2 border-t border-slate-200 dark:border-zinc-800/60">
                  <div>
                    <span className="text-slate-500 dark:text-zinc-400 block mb-0.5 font-medium">Trading Fees</span>
                    <span className="font-semibold text-slate-800 dark:text-zinc-200 font-mono">{formatAssetCurrency(selectedTrade.fees, selectedTrade.currency)}</span>
                  </div>
                  <div>
                    <span className="text-slate-500 dark:text-zinc-400 block mb-0.5 font-medium">Currency</span>
                    <span className="font-semibold text-slate-800 dark:text-zinc-200">{selectedTrade.currency}</span>
                  </div>
                </div>

                {selectedTrade.currency !== 'MYR' && (
                  <div className="grid grid-cols-2 gap-3 pt-2 border-t border-slate-200 dark:border-zinc-800/60">
                    <div>
                      <span className="text-slate-500 dark:text-zinc-400 block mb-0.5 font-medium">Exchange Rate</span>
                      <span className="font-semibold text-slate-800 dark:text-zinc-200 font-mono">1 {selectedTrade.currency} = RM {selectedTrade.rateToMyr.toFixed(4)}</span>
                    </div>
                    <div>
                      <span className="text-slate-500 dark:text-zinc-400 block mb-0.5 font-medium">Total Cost (MYR)</span>
                      <span className="font-semibold text-indigo-800 dark:text-indigo-400 font-mono">RM {selectedTrade.costInMyr.toFixed(2)}</span>
                    </div>
                  </div>
                )}

                {selectedTrade.notes && (
                  <div className="pt-2 border-t border-slate-200 dark:border-zinc-800/60">
                    <span className="text-slate-500 dark:text-zinc-400 block mb-1 font-medium">Notes</span>
                    <p className="text-slate-700 dark:text-zinc-300 italic whitespace-pre-wrap leading-relaxed bg-white/90 dark:bg-zinc-950/60 p-2.5 rounded-xl border border-slate-200 dark:border-zinc-800/60">
                      {selectedTrade.notes}
                    </p>
                  </div>
                )}
              </div>

              {/* Action Buttons */}
              <div className="space-y-2 pt-1">
                <button
                  onClick={() => {
                    const tr = selectedTrade;
                    setSelectedTrade(null);
                    openTradeEditor(tr);
                  }}
                  className="w-full py-3 px-4 rounded-2xl bg-gradient-to-r from-indigo-500 via-indigo-600 to-purple-600 hover:from-indigo-600 hover:to-purple-700 active:scale-[0.98] text-white dark:text-white font-bold text-sm shadow-xl shadow-indigo-500/20 transition-all flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Edit2 className="h-4 w-4" />
                  <span>Edit Trade</span>
                </button>

                <button
                  onClick={async () => {
                    const tr = selectedTrade;
                    setSelectedTrade(null);
                    await handleDeleteTrade(tr);
                  }}
                  className="w-full py-2.5 px-4 rounded-2xl border border-rose-500/30 hover:bg-rose-500/10 active:scale-[0.98] text-rose-800 dark:text-rose-400 font-semibold text-xs transition-colors flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Trash2 className="h-4 w-4" />
                  <span>Delete Trade</span>
                </button>
              </div>
        </CockpitModal>
      )}

      {/* Holding Detail Modal */}
      {selectedHolding && (
        <CockpitModal
          id="investment-holding-details-dialog"
          isOpen={Boolean(selectedHolding)}
          onClose={() => setSelectedHolding(null)}
          labelledBy="investment-holding-details-title"
          describedBy="investment-holding-details-description"
          size="standard"
          className="space-y-5"
        >
          <CockpitModalHeader
            title={selectedHolding.ticker}
            titleId="investment-holding-details-title"
            description={`${selectedHolding.name || selectedHolding.ticker} · ${selectedHolding.type}`}
            descriptionId="investment-holding-details-description"
            icon={<Activity size={20} />}
            onClose={() => setSelectedHolding(null)}
            closeLabel="Close holding details"
          />

              {/* Market Value Display */}
              <div className="text-center py-2">
                <div className="text-3xl sm:text-4xl font-black font-mono tracking-tight text-slate-950 dark:text-white">
                  RM {selectedHolding.marketValueBase.toFixed(2)}
                </div>
                {selectedHolding.currency !== 'MYR' && (
                  <p className="text-xs text-slate-600 dark:text-zinc-400 font-mono mt-1">
                    {formatAssetCurrency(selectedHolding.marketValue, selectedHolding.currency)} (@ {selectedHolding.currentFxRate.toFixed(4)})
                  </p>
                )}
                <div className={`inline-flex items-center gap-1.5 mt-2 px-3 py-1 rounded-full text-xs font-bold font-mono border ${
                  selectedHolding.pnlBase >= 0
                    ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-400 border-emerald-500/30'
                    : 'bg-rose-500/15 text-rose-800 dark:text-rose-400 border-rose-500/30'
                }`}>
                  {formatPnl(selectedHolding.pnlBase, 'MYR')} ({selectedHolding.pnlBase >= 0 ? '+' : ''}{selectedHolding.returnPercentBase.toFixed(2)}%)
                </div>
              </div>

              {/* Details List */}
              <div className="space-y-3 rounded-2xl bg-white/90 dark:bg-zinc-900/40 border border-slate-200 dark:border-zinc-800/80 p-4 text-xs">
                <div>
                  <span className="text-slate-500 dark:text-zinc-400 block mb-0.5 font-medium">Asset Name</span>
                  <p className="text-sm font-semibold text-slate-950 dark:text-white break-words">
                    {selectedHolding.name || selectedHolding.ticker}
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-3 pt-2 border-t border-slate-200 dark:border-zinc-800/60">
                  <div>
                    <span className="text-slate-500 dark:text-zinc-400 block mb-0.5 font-medium">Units Held</span>
                    <span className="font-semibold text-slate-800 dark:text-zinc-200 font-mono">{selectedHolding.units.toLocaleString()}</span>
                  </div>
                  <div>
                    <span className="text-slate-500 dark:text-zinc-400 block mb-0.5 font-medium">Live Market Price</span>
                    <span className="font-semibold text-slate-950 dark:text-white font-mono">{formatAssetCurrency(selectedHolding.livePrice, selectedHolding.currency)}</span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 pt-2 border-t border-slate-200 dark:border-zinc-800/60">
                  <div>
                    <span className="text-slate-500 dark:text-zinc-400 block mb-0.5 font-medium">Average Cost</span>
                    <span className="font-semibold text-slate-700 dark:text-zinc-300 font-mono">{formatAssetCurrency(selectedHolding.avgCost, selectedHolding.currency)}</span>
                    {selectedHolding.currency !== 'MYR' && (
                      <span className="text-[10px] text-slate-500 dark:text-zinc-400 block font-mono">RM {selectedHolding.avgCostBase.toFixed(2)}</span>
                    )}
                  </div>
                  <div>
                    <span className="text-slate-500 dark:text-zinc-400 block mb-0.5 font-medium">Total Cost Basis</span>
                    <span className="font-semibold text-slate-700 dark:text-zinc-300 font-mono">RM {selectedHolding.totalCostBase.toFixed(2)}</span>
                  </div>
                </div>

                {selectedHolding.currency !== 'MYR' && (
                  <div className="grid grid-cols-2 gap-3 pt-2 border-t border-slate-200 dark:border-zinc-800/60">
                    <div>
                      <span className="text-slate-500 dark:text-zinc-400 block mb-0.5 font-medium">Asset Return</span>
                      <span className={`font-semibold font-mono ${selectedHolding.pnl >= 0 ? 'text-emerald-800 dark:text-emerald-400' : 'text-rose-800 dark:text-rose-400'}`}>
                        {formatPnl(selectedHolding.pnl, selectedHolding.currency)} ({selectedHolding.pnl >= 0 ? '+' : ''}{selectedHolding.returnPercent.toFixed(2)}%)
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-500 dark:text-zinc-400 block mb-0.5 font-medium">Live FX Rate</span>
                      <span className="font-semibold text-slate-700 dark:text-zinc-300 font-mono">1 {selectedHolding.currency} = RM {selectedHolding.currentFxRate.toFixed(4)}</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Action Buttons & Trade History Shortcut */}
              <div className="space-y-2 pt-1">
                <div className="grid grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    onClick={() => {
                      const h = selectedHolding;
                      setSelectedHolding(null);
                      setEditingTrade(null);
                      selectHoldingForTrade(h, 'BUY');
                      setIsAddTradeOpen(true);
                    }}
                    className="py-2.5 px-4 rounded-2xl bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 active:scale-[0.98] text-white dark:text-white font-semibold text-xs shadow-lg shadow-indigo-500/20 transition-all flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <ArrowUpRight className="h-4 w-4" />
                    <span>Buy More</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const h = selectedHolding;
                      setSelectedHolding(null);
                      setEditingTrade(null);
                      selectHoldingForTrade(h, 'SELL');
                      setIsAddTradeOpen(true);
                    }}
                    className="py-2.5 px-4 rounded-2xl border border-rose-500/35 bg-rose-500/10 hover:bg-rose-500/20 active:scale-[0.98] text-rose-800 dark:text-rose-300 font-semibold text-xs transition-all flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <ArrowDownRight className="h-4 w-4" />
                    <span>Sell {selectedHolding.ticker}</span>
                  </button>
                </div>
                <button
                  onClick={() => {
                    setSelectedHolding(null);
                    setActiveTab('trades');
                  }}
                  className="w-full py-2.5 px-4 rounded-2xl border border-slate-200 dark:border-zinc-800 hover:bg-white dark:hover:bg-zinc-900 active:scale-[0.98] text-slate-700 dark:text-zinc-300 font-semibold text-xs transition-colors flex items-center justify-center gap-2 cursor-pointer"
                >
                  <History className="h-4 w-4" />
                  <span>View Trade History</span>
                </button>
              </div>
        </CockpitModal>
      )}
    </div>
  );
}
