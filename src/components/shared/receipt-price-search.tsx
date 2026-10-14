'use client';

import Link from 'next/link';
import { useMemo, useState, useRef, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowUp,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Globe2,
  LoaderCircle,
  PackageSearch,
  PieChart,
  ReceiptText,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  Store,
  TrendingDown,
  TrendingUp,
  Wallet,
  X,
} from 'lucide-react';
import { normalizeTransaction, useTransactions, type Transaction } from '@/hooks/useTransactions';
import { getUnifiedSheetData } from '@/hooks/useSheets';
import { getActiveUserCacheScope } from '@/lib/sheets-api';
import { scoreReceiptItemQuery, type StoredReceiptItem } from '@/lib/receipt-items';
import { TransactionDetailModal } from '@/components/shared/transaction-detail-modal';
import {
  computeSpendingAnalytics,
  isSpendingAnalyticsQuery,
  type SpendingAnalyticsResult,
} from '@/lib/spending-analytics';

interface ReceiptPriceSearchProps {
  returnTo?: string;
  onClose?: () => void;
}

interface OnlineSource {
  title: string;
  uri: string;
}

type OnlineResult =
  | { status: 'loading' }
  | { status: 'ready'; summary: string; sources: OnlineSource[] }
  | { status: 'error'; message: string };

interface StockInsightState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  summary?: string;
  sources?: OnlineSource[];
  quote?: {
    ticker: string;
    name: string;
    price: number;
    currency: string;
    changePercent: number;
  } | null;
  message?: string;
}

interface SearchableItemEntry {
  transaction: Transaction;
  item: StoredReceiptItem;
  isDetailed: boolean;
}

const STOCK_INTENT_REGEX = /(股票|买什么|值得买|值得卖|推荐.*股|美股|马股|港股|大盘|走势|财报|估值|股息|分红|牛市|熊市|stock|shares|invest|dividend|etf|nvda|tsla|aapl|msft|goog|amzn|meta|baba|spy|qqq|voo)/i;

function formatPrice(currency: string | undefined, amount: number): string {
  const normalizedCurrency = (currency && /^[A-Z]{3}$/.test(currency)) ? currency : 'MYR';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: normalizedCurrency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${normalizedCurrency} ${amount.toFixed(2)}`;
  }
}

function stableItemKey(item: StoredReceiptItem): string {
  return `${item.brand || ''} ${item.name} ${item.productType || ''}`
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function ReceiptPriceSearch({ returnTo = '/', onClose }: ReceiptPriceSearchProps) {
  const [draftQuery, setDraftQuery] = useState('');
  const [query, setQuery] = useState('');
  const [activeIntent, setActiveIntent] = useState<'none' | 'price' | 'analytics' | 'stock'>('none');

  // Analytics state
  const [analyticsResult, setAnalyticsResult] = useState<SpendingAnalyticsResult<Transaction> | null>(null);
  const [showAllAnalyticsTx, setShowAllAnalyticsTx] = useState(false);

  // Stock insight state
  const [stockInsight, setStockInsight] = useState<StockInsightState>({ status: 'idle' });

  // Online item price search states
  const [onlineResults, setOnlineResults] = useState<Record<string, OnlineResult>>({});
  const [loadingKey, setLoadingKey] = useState('');
  const [generalOnlineResult, setGeneralOnlineResult] = useState<OnlineResult | null>(null);
  const [isGeneralLoading, setIsGeneralLoading] = useState(false);

  // Modal inspection
  const [selectedTx, setSelectedTx] = useState<Transaction | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const bottomTouchStartRef = useRef<number | null>(null);

  const { transactions = [] } = useTransactions();
  const cacheScope = getActiveUserCacheScope();

  const historyQuery = useQuery({
    queryKey: ['receipt-price-history', cacheScope],
    queryFn: async () => {
      const result = await getUnifiedSheetData('Transactions', 'all');
      return (result.rows || []).map((row) => normalizeTransaction(row));
    },
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  const allTransactions = useMemo(() => {
    const combined = [...(historyQuery.data || []), ...transactions];
    const seen = new Set<string>();
    return combined.filter((t) => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });
  }, [historyQuery.data, transactions]);

  // Index expense transactions for item price checks:
  // CRITICAL FIX: If a transaction has receipt items, index ONLY the receipt items!
  // Never synthesize a duplicate entry for transaction.description when receipt items already exist!
  const searchableEntries = useMemo<SearchableItemEntry[]>(() => {
    const entries: SearchableItemEntry[] = [];
    const seenTx = new Set<string>();

    for (const transaction of allTransactions) {
      if (transaction.type !== 'expense') continue;
      if (seenTx.has(transaction.id)) continue;
      seenTx.add(transaction.id);

      if (transaction.receiptItems && transaction.receiptItems.length > 0) {
        // Detailed receipt breakdown
        for (const item of transaction.receiptItems) {
          entries.push({ transaction, item, isDetailed: true });
        }
      } else {
        // Direct expense without receipt itemization
        const desc = (transaction.description || transaction.category || '').trim();
        if (desc) {
          entries.push({
            transaction,
            item: {
              name: desc,
              quantity: 1,
              unitPrice: transaction.amount,
              amount: transaction.amount,
              brand: transaction.description && transaction.category !== transaction.description ? transaction.category : undefined,
              productType: transaction.category,
            },
            isDetailed: false,
          });
        }
      }
    }
    return entries;
  }, [allTransactions]);

  // Fast & strict item matching
  const matches = useMemo(() => {
    if (activeIntent !== 'price') return [];
    const rawQuery = query.trim().toLowerCase();
    if (rawQuery.length < 2) return [];

    return searchableEntries
      .map(({ transaction, item, isDetailed }) => {
        const score = scoreReceiptItemQuery(item, rawQuery);
        return { transaction, item, score, isDetailed };
      })
      .filter((m) => m.score >= 70)
      .sort((a, b) => b.score - a.score || b.transaction.date.localeCompare(a.transaction.date))
      .slice(0, 30);
  }, [activeIntent, query, searchableEntries]);

  // Dynamic quick suggestions
  const suggestions = useMemo(() => [
    { text: '这个月在餐饮 Food 花了多少？', type: 'analytics', icon: '📊' },
    { text: '我买过鸡饭多少钱？', type: 'price', icon: '🍗' },
    { text: '现在有什么美股/ETF值得买？', type: 'stock', icon: '📈' },
    { text: '查上个月交通与汽油总支出', type: 'analytics', icon: '🚗' },
    { text: 'NVDA 现在可以买吗？走势如何', type: 'stock', icon: '💻' },
    { text: '查鸡蛋/牛奶公开发售参考价', type: 'price', icon: '🛒' },
  ], []);

  // Fetch stock advisory from AI
  const fetchStockAdvisory = async (stockQuery: string) => {
    setStockInsight({ status: 'loading' });
    try {
      const res = await fetch('/api/ai/stock-insights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: stockQuery }),
        signal: AbortSignal.timeout(18_000),
      });
      const data = await res.json();
      if (!res.ok || !data.success || !data.summary) {
        throw new Error(data.error || 'AI 市场分析暂时无法连接，请稍后再试');
      }
      setStockInsight({
        status: 'ready',
        summary: data.summary,
        sources: Array.isArray(data.sources) ? data.sources : [],
        quote: data.quote || null,
      });
    } catch (err) {
      setStockInsight({
        status: 'error',
        message: err instanceof Error ? err.message : '获取行情与分析超时，请重试',
      });
    }
  };

  // Main inquiry dispatcher
  const submitInquiry = (rawText: string) => {
    const clean = rawText.trim();
    if (!clean) return;

    // Immediately clear composer input!
    setDraftQuery('');
    setQuery(clean);
    setGeneralOnlineResult(null);
    setShowAllAnalyticsTx(false);

    // Auto blur input so virtual keyboard closes and view is clear
    if (typeof document !== 'undefined') {
      const activeEl = document.activeElement as HTMLElement | null;
      activeEl?.blur?.();
    }

    // 1. Check Spending Analytics Intent
    if (isSpendingAnalyticsQuery(clean)) {
      setActiveIntent('analytics');
      const result = computeSpendingAnalytics(clean, allTransactions);
      setAnalyticsResult(result);
      return;
    }

    // 2. Check Stock / Investment Intent
    if (STOCK_INTENT_REGEX.test(clean)) {
      setActiveIntent('stock');
      setAnalyticsResult(null);
      void fetchStockAdvisory(clean);
      return;
    }

    // 3. Fallback: Receipt Item Price Recall
    setActiveIntent('price');
    setAnalyticsResult(null);
  };

  const handleAskSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draftQuery.trim()) return;
    submitInquiry(draftQuery);
  };

  const handleClear = () => {
    setDraftQuery('');
    setQuery('');
    setActiveIntent('none');
    setAnalyticsResult(null);
    setStockInsight({ status: 'idle' });
    setGeneralOnlineResult(null);
  };

  // Online general search for market price via Google Grounding
  const searchMarketPriceOnline = async (productKeyword: string) => {
    const cleanKeyword = productKeyword.trim();
    if (!cleanKeyword || isGeneralLoading) return;

    setIsGeneralLoading(true);
    setGeneralOnlineResult({ status: 'loading' });
    try {
      const response = await fetch('/api/ai/compare-item-price', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          itemName: cleanKeyword,
          currency: 'MYR',
          country: 'Malaysia',
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const payload = await response.json();
      if (!response.ok || !payload?.success || typeof payload.summary !== 'string') {
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'Online comparison is unavailable right now.');
      }
      const sources = Array.isArray(payload.sources)
        ? payload.sources.filter((source: unknown): source is OnlineSource => {
            if (!source || typeof source !== 'object') return false;
            const candidate = source as Record<string, unknown>;
            return typeof candidate.title === 'string' && typeof candidate.uri === 'string' && /^https?:\/\//i.test(candidate.uri);
          }).slice(0, 5)
        : [];
      setGeneralOnlineResult({ status: 'ready', summary: payload.summary, sources });
    } catch (error) {
      setGeneralOnlineResult({
        status: 'error',
        message: error instanceof Error ? error.message : 'Online market lookup is unavailable right now.',
      });
    } finally {
      setIsGeneralLoading(false);
    }
  };

  // Compare online for a specific saved item
  const compareOnline = async (item: StoredReceiptItem) => {
    const key = stableItemKey(item);
    if (!key || onlineResults[key]?.status === 'ready' || loadingKey) return;

    setLoadingKey(key);
    setOnlineResults((current) => ({ ...current, [key]: { status: 'loading' } }));
    try {
      const response = await fetch('/api/ai/compare-item-price', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          itemName: item.name,
          brand: item.brand,
          productType: item.productType,
          currency: 'MYR',
          country: 'Malaysia',
        }),
        signal: AbortSignal.timeout(13_000),
      });
      const payload = await response.json();
      if (!response.ok || !payload?.success || typeof payload.summary !== 'string') {
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'Online comparison is unavailable right now.');
      }
      const sources = Array.isArray(payload.sources)
        ? payload.sources.filter((source: unknown): source is OnlineSource => {
            if (!source || typeof source !== 'object') return false;
            const candidate = source as Record<string, unknown>;
            return typeof candidate.title === 'string' && typeof candidate.uri === 'string' && /^https?:\/\//i.test(candidate.uri);
          }).slice(0, 5)
        : [];
      setOnlineResults((current) => ({
        ...current,
        [key]: { status: 'ready', summary: payload.summary, sources },
      }));
    } catch (error) {
      setOnlineResults((current) => ({
        ...current,
        [key]: {
          status: 'error',
          message: error instanceof Error ? error.message : 'Online comparison is unavailable right now.',
        },
      }));
    } finally {
      setLoadingKey('');
    }
  };

  return (
    <div className="fixed inset-0 z-30 flex flex-col justify-between text-white overflow-hidden bg-gradient-to-b from-[#12132d] via-[#0c0d1e] to-[#070814]">
      {/* Ambient glowing radial gradients */}
      <div 
        className="pointer-events-none absolute inset-x-0 top-0 h-[400px] bg-[radial-gradient(ellipse_80%_60%_at_50%_-10%,rgba(99,102,241,0.3),transparent_70%)]" 
        aria-hidden="true" 
      />
      <div 
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[300px] bg-[radial-gradient(circle_at_50%_100%,rgba(139,92,246,0.18),transparent_60%)]" 
        aria-hidden="true" 
      />

      {/* Top Header */}
      <header className="relative z-10 shrink-0 h-14 sm:h-16 flex items-center justify-between px-4 sm:px-6 pt-safe border-b border-white/10 bg-[#12132d]/80 backdrop-blur-xl">
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 border border-white/15 backdrop-blur-md flex items-center justify-center text-white transition-all cursor-pointer shadow-lg"
            aria-label="Close Kinova AI"
          >
            <X size={18} aria-hidden="true" />
          </button>
        ) : (
          <Link
            href={returnTo}
            className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 border border-white/15 backdrop-blur-md flex items-center justify-center text-white transition-all cursor-pointer shadow-lg"
            aria-label="Close Kinova AI"
          >
            <X size={18} aria-hidden="true" />
          </Link>
        )}

        {/* Center Pill Badge */}
        <div className="flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-white/10 border border-white/15 backdrop-blur-md shadow-inner">
          <Sparkles size={14} className="text-indigo-400" />
          <span className="font-semibold text-sm tracking-tight text-white">Kinova AI</span>
          <span className="px-1.5 py-0.5 rounded-md bg-indigo-500/30 text-indigo-300 font-mono text-[10px] uppercase font-bold tracking-wider">
            intelligence
          </span>
        </div>

        {/* Right Action */}
        {query.trim().length > 0 ? (
          <button
            type="button"
            onClick={handleClear}
            className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 border border-white/15 backdrop-blur-md flex items-center justify-center text-white/80 hover:text-white transition-all cursor-pointer"
            title="Clear and ask another question"
            aria-label="Clear query"
          >
            <RotateCcw size={16} />
          </button>
        ) : (
          <div className="w-10 h-10" aria-hidden="true" />
        )}
      </header>

      {/* Main Content Scroll Area */}
      <main className="relative z-10 flex-1 overflow-y-auto px-4 sm:px-6 py-4 flex flex-col justify-start">
        {query.trim().length === 0 ? (
          /* Welcome Screen */
          <div className="flex-1 flex flex-col items-center justify-center text-center max-w-md mx-auto py-8">
            <div className="w-16 h-16 rounded-3xl bg-indigo-500/20 border border-indigo-400/30 backdrop-blur-xl flex items-center justify-center text-indigo-300 shadow-[0_0_32px_rgba(99,102,241,0.35)] mb-5 animate-pulse">
              <Sparkles size={32} strokeWidth={1.8} />
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white mb-2">
              有什么可以帮你的？
            </h1>
            <p className="text-xs sm:text-sm text-white/60 max-w-xs sm:max-w-sm mb-6 leading-relaxed">
              随时问小票单价、月度消费分析、或获取最新股票与投资市场洞察。
            </p>

            {/* Quick Suggestion Chips */}
            <div className="w-full grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-left mb-6">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion.text}
                  type="button"
                  onClick={() => submitInquiry(suggestion.text)}
                  className="p-3.5 rounded-2xl bg-white/[0.07] hover:bg-white/[0.13] active:scale-[0.98] border border-white/10 hover:border-white/25 backdrop-blur-md transition-all flex items-center gap-3 text-white/90 text-xs sm:text-sm font-medium cursor-pointer shadow-sm group"
                >
                  <span className="text-base shrink-0 group-hover:scale-125 transition-transform">
                    {suggestion.icon}
                  </span>
                  <span className="truncate flex-1">{suggestion.text}</span>
                </button>
              ))}
            </div>

            <div className="text-[11px] text-white/45 bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 leading-relaxed">
              💡 支持小票单价核对、税费细项辨析、月度开销统计，以及基于 Google Search Grounding 的实时投资资讯。
            </div>
          </div>
        ) : (
          /* Inquiry Results Area */
          <div className="w-full max-w-2xl mx-auto flex flex-col gap-4 py-2">
            {/* User Query Bubble */}
            <div className="self-end max-w-[85%] rounded-2xl rounded-br-sm bg-gradient-to-r from-indigo-600 to-violet-600 text-white px-4 py-2.5 text-sm font-medium shadow-lg backdrop-blur-md border border-white/15">
              {query}
            </div>

            {/* 1. Spending Analytics Result Card */}
            {activeIntent === 'analytics' && analyticsResult && (
              <div className="rounded-3xl bg-white/[0.07] border border-white/15 backdrop-blur-2xl p-5 sm:p-6 shadow-2xl flex flex-col gap-5">
                {/* Header */}
                <div className="flex items-center justify-between gap-3 border-b border-white/10 pb-4">
                  <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-xl bg-indigo-500/25 border border-indigo-400/30 flex items-center justify-center text-indigo-300">
                      <PieChart size={18} />
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-white/60">支出统计分析</div>
                      <div className="text-sm font-bold text-white tracking-tight">
                        {analyticsResult.timeframe.label} {analyticsResult.categoryLabel ? `· ${analyticsResult.categoryLabel}` : ''}
                      </div>
                    </div>
                  </div>

                  <span className="px-2.5 py-1 rounded-full bg-white/10 text-white/80 font-mono text-xs font-semibold">
                    {analyticsResult.transactionCount} 笔账单
                  </span>
                </div>

                {/* Big Total Hero */}
                <div className="flex flex-col gap-1">
                  <span className="text-xs uppercase tracking-wider text-white/50 font-semibold">总共支出 Total Spent</span>
                  <div className="text-3xl sm:text-4xl font-black font-mono tracking-tight text-emerald-400 flex items-baseline gap-2">
                    <span>{formatPrice(analyticsResult.currency, analyticsResult.totalSpent)}</span>
                    {analyticsResult.percentageChange !== null && (
                      <span className={`text-xs sm:text-sm font-bold px-2 py-0.5 rounded-lg flex items-center gap-0.5 ${
                        analyticsResult.percentageChange > 0
                          ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                          : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                      }`}>
                        {analyticsResult.percentageChange > 0 ? (
                          <>
                            <TrendingUp size={13} />
                            <span>+{analyticsResult.percentageChange}% vs 上期</span>
                          </>
                        ) : (
                          <>
                            <TrendingDown size={13} />
                            <span>{analyticsResult.percentageChange}% vs 上期</span>
                          </>
                        )}
                      </span>
                    )}
                  </div>
                </div>

                {/* Stats Grid */}
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 text-xs">
                  <div className="rounded-xl bg-white/5 border border-white/10 p-3">
                    <span className="text-white/50 block mb-1">日均支出</span>
                    <span className="text-sm font-bold font-mono text-white">
                      {formatPrice(analyticsResult.currency, analyticsResult.dailyAverage)}
                    </span>
                  </div>

                  <div className="rounded-xl bg-white/5 border border-white/10 p-3">
                    <span className="text-white/50 block mb-1">单笔最高</span>
                    <span className="text-sm font-bold font-mono text-white truncate block">
                      {analyticsResult.largestExpense
                        ? formatPrice(analyticsResult.currency, analyticsResult.largestExpense.amount)
                        : '-'}
                    </span>
                  </div>

                  <div className="col-span-2 sm:col-span-1 rounded-xl bg-white/5 border border-white/10 p-3">
                    <span className="text-white/50 block mb-1">最高消费项目</span>
                    <span className="text-xs font-semibold text-white/90 truncate block">
                      {analyticsResult.largestExpense?.description || analyticsResult.largestExpense?.category || '无'}
                    </span>
                  </div>
                </div>

                {/* Category breakdown (if user asked for general spending) */}
                {analyticsResult.categoryBreakdown && analyticsResult.categoryBreakdown.length > 0 && (
                  <div className="flex flex-col gap-2 pt-2 border-t border-white/10">
                    <span className="text-xs font-semibold text-white/70">主要分类支出构成</span>
                    <div className="flex flex-col gap-1.5">
                      {analyticsResult.categoryBreakdown.map((item) => (
                        <div key={item.category} className="flex items-center justify-between text-xs">
                          <span className="text-white/80">{item.category}</span>
                          <span className="font-mono text-white/90 font-semibold">
                            {formatPrice(analyticsResult.currency, item.amount)} ({item.percentage}%)
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Natural language summary */}
                <div className="p-3.5 rounded-2xl bg-indigo-500/15 border border-indigo-400/25 text-xs sm:text-sm text-indigo-100 leading-relaxed">
                  💬 {analyticsResult.conversationalSummary}
                </div>

                {/* Matching Transactions Preview */}
                {analyticsResult.matchingTransactions.length > 0 && (
                  <div className="flex flex-col gap-2 pt-2 border-t border-white/10">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-white/70">相关支出账单 ({analyticsResult.matchingTransactions.length})</span>
                      {analyticsResult.matchingTransactions.length > 4 && (
                        <button
                          type="button"
                          onClick={() => setShowAllAnalyticsTx(!showAllAnalyticsTx)}
                          className="text-[11px] text-indigo-300 hover:text-white flex items-center gap-1 cursor-pointer"
                        >
                          <span>{showAllAnalyticsTx ? '收起' : '展开全部'}</span>
                          {showAllAnalyticsTx ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                        </button>
                      )}
                    </div>

                    <div className="flex flex-col gap-1.5">
                      {(showAllAnalyticsTx
                        ? analyticsResult.matchingTransactions
                        : analyticsResult.matchingTransactions.slice(0, 4)
                      ).map((tx) => (
                        <div
                          key={tx.id}
                          onClick={() => setSelectedTx(tx)}
                          className="p-3 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] active:scale-[0.99] border border-white/5 hover:border-white/15 transition-all flex items-center justify-between cursor-pointer"
                        >
                          <div className="min-w-0 flex-1 pr-2">
                            <div className="text-xs font-bold text-white truncate">
                              {tx.description || tx.category}
                            </div>
                            <div className="text-[10px] text-white/50 flex items-center gap-2 mt-0.5">
                              <span>{tx.date}</span>
                              <span>·</span>
                              <span>{tx.category}</span>
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            <div className="text-xs font-bold font-mono text-emerald-400">
                              {formatPrice(tx.currency, tx.amount)}
                            </div>
                            <div className="text-[10px] text-indigo-300 flex items-center gap-0.5 justify-end mt-0.5">
                              <ReceiptText size={10} />
                              <span>详情</span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* 2. Stock / Investment Advisory Card */}
            {activeIntent === 'stock' && (
              <div className="rounded-3xl bg-white/[0.07] border border-white/15 backdrop-blur-2xl p-5 sm:p-6 shadow-2xl flex flex-col gap-4">
                {/* Header */}
                <div className="flex items-center justify-between border-b border-white/10 pb-3">
                  <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-xl bg-violet-500/25 border border-violet-400/30 flex items-center justify-center text-violet-300">
                      <TrendingUp size={18} />
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-white/60">Kinova 市场研究与投资洞察</div>
                      <div className="text-sm font-bold text-white tracking-tight">AI 智能投顾分析</div>
                    </div>
                  </div>

                  <span className="px-2 py-0.5 rounded-full bg-violet-500/20 text-violet-300 border border-violet-400/30 text-[10px] font-bold uppercase tracking-wider">
                    Google Grounded
                  </span>
                </div>

                {/* Real-time Ticker Badge if detected */}
                {stockInsight.quote && (
                  <div className="p-3.5 rounded-2xl bg-white/[0.05] border border-white/10 flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-sm sm:text-base text-white font-mono">
                          {stockInsight.quote.ticker}
                        </span>
                        <span className="text-xs text-white/60 truncate max-w-[160px]">
                          {stockInsight.quote.name}
                        </span>
                      </div>
                      <span className="text-[10px] text-white/40 block mt-0.5">Yahoo Finance 实时行情</span>
                    </div>

                    <div className="text-right">
                      <div className="text-base sm:text-lg font-black font-mono text-white">
                        {formatPrice(stockInsight.quote.currency, stockInsight.quote.price)}
                      </div>
                      <div className={`text-xs font-bold font-mono ${
                        stockInsight.quote.changePercent >= 0 ? 'text-emerald-400' : 'text-rose-400'
                      }`}>
                        {stockInsight.quote.changePercent >= 0 ? '+' : ''}
                        {stockInsight.quote.changePercent.toFixed(2)}%
                      </div>
                    </div>
                  </div>
                )}

                {/* Loading State */}
                {stockInsight.status === 'loading' && (
                  <div className="flex flex-col items-center justify-center py-10 gap-3">
                    <LoaderCircle size={28} className="animate-spin text-indigo-400" />
                    <span className="text-xs text-white/70 font-medium animate-pulse">
                      正在通过 Google 搜索全球实时市场研报与估值数据...
                    </span>
                  </div>
                )}

                {/* Ready Analysis Content */}
                {stockInsight.status === 'ready' && stockInsight.summary && (
                  <div className="flex flex-col gap-3">
                    <div className="text-xs sm:text-sm text-white/90 leading-relaxed whitespace-pre-wrap font-sans">
                      {stockInsight.summary}
                    </div>

                    {/* Sources */}
                    {stockInsight.sources && stockInsight.sources.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 pt-3 border-t border-white/10">
                        <span className="text-[10px] text-white/50 block w-full mb-0.5">参考公开资讯与权威研报:</span>
                        {stockInsight.sources.map((src) => (
                          <a
                            key={src.uri}
                            href={src.uri}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/20 border border-white/15 text-indigo-200 text-[11px] font-medium transition-colors"
                          >
                            <span className="truncate max-w-[150px]">{src.title}</span>
                            <ExternalLink size={11} className="shrink-0" />
                          </a>
                        ))}
                      </div>
                    )}

                    {/* Regulatory Disclaimer */}
                    <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-400/25 flex items-start gap-2 text-[11px] text-amber-200/90 leading-relaxed">
                      <ShieldAlert size={15} className="text-amber-400 shrink-0 mt-0.5" />
                      <span>
                        免责声明：以上内容仅供公开信息整理与参考，不构成任何投资建议。金融投资受市场宏观波动影响，决策需独立审慎。
                      </span>
                    </div>
                  </div>
                )}

                {/* Error State */}
                {stockInsight.status === 'error' && (
                  <div className="p-4 rounded-xl bg-rose-500/15 border border-rose-400/25 text-xs text-rose-200">
                    {stockInsight.message}
                  </div>
                )}
              </div>
            )}

            {/* 3. Item & Receipt Price Search Result */}
            {activeIntent === 'price' && (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2 text-xs font-semibold text-white/80 pt-1">
                  <div className="w-6 h-6 rounded-lg bg-indigo-500/30 border border-indigo-400/40 flex items-center justify-center text-indigo-300">
                    <Sparkles size={14} />
                  </div>
                  <span>小票与支出记录查询结果</span>
                  {matches.length > 0 && (
                    <span className="px-2 py-0.5 rounded-full bg-white/10 text-white/70 text-[11px] font-mono">
                      {matches.length} 笔匹配
                    </span>
                  )}
                  {historyQuery.isFetching && (
                    <LoaderCircle size={14} className="animate-spin text-indigo-400 ml-auto" />
                  )}
                </div>

                {/* No Matches Found in Ledger -> Prompt 1-Click Online Price Grounding */}
                {matches.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-8 px-4 rounded-3xl bg-white/[0.04] border border-white/10 text-center">
                    <PackageSearch size={32} className="text-white/40 mb-3" />
                    <div className="text-base font-bold text-white mb-1">
                      你的个人账本中暂无「{query}」的记录
                    </div>
                    <p className="text-xs text-white/60 max-w-sm mb-5 leading-relaxed">
                      历史账单和小票中未查到此商品。想让 Kinova AI 使用 Google 搜索查询当前公开发售参考价吗？
                    </p>

                    <button
                      type="button"
                      onClick={() => void searchMarketPriceOnline(query)}
                      disabled={isGeneralLoading}
                      className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-400 hover:to-violet-500 active:scale-95 text-white font-semibold text-xs flex items-center gap-2 shadow-lg cursor-pointer transition-all disabled:opacity-50"
                    >
                      {isGeneralLoading ? (
                        <LoaderCircle size={15} className="animate-spin" />
                      ) : (
                        <Globe2 size={15} />
                      )}
                      <span>🌐 立即全网查询「{query}」参考价格</span>
                    </button>
                  </div>
                )}

                {/* General Online Search Result */}
                {generalOnlineResult?.status === 'ready' && (
                  <div className="rounded-2xl bg-emerald-500/10 border border-emerald-400/30 p-4 sm:p-5 flex flex-col gap-2.5 shadow-xl">
                    <div className="flex items-center gap-2 text-xs font-bold text-emerald-300">
                      <Globe2 size={15} />
                      <span>当前市场公开发售参考价格 (Google Search Grounding)</span>
                    </div>
                    <p className="text-xs sm:text-sm text-white/90 leading-relaxed whitespace-pre-wrap">
                      {generalOnlineResult.summary}
                    </p>
                    {generalOnlineResult.sources.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 pt-2 border-t border-emerald-400/20">
                        {generalOnlineResult.sources.map((source) => (
                          <a
                            key={source.uri}
                            href={source.uri}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/20 border border-white/15 text-indigo-200 text-[11px] font-medium transition-colors"
                          >
                            <span className="truncate max-w-[150px]">{source.title}</span>
                            <ExternalLink size={11} className="shrink-0" />
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {generalOnlineResult?.status === 'error' && (
                  <div className="rounded-xl bg-rose-500/15 border border-rose-400/25 p-3 text-xs text-rose-200">
                    {generalOnlineResult.message}
                  </div>
                )}

                {/* Matched Items with Crystal-Clear Unit Price vs Total Bill Details */}
                {matches.map(({ transaction, item, isDetailed }, idx) => {
                  const key = stableItemKey(item);
                  const online = onlineResults[key];
                  const merchant = transaction.description || transaction.category || 'Purchase';
                  const hasBillDiscrepancy = Math.abs(transaction.amount - item.amount) > 0.05;

                  return (
                    <article
                      key={`${transaction.id}-${idx}`}
                      className="rounded-2xl bg-white/[0.06] hover:bg-white/[0.09] border border-white/10 hover:border-white/20 backdrop-blur-xl p-4 sm:p-5 transition-all shadow-lg flex flex-col gap-3"
                    >
                      {/* Item name + Brand + Unit Price */}
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          {item.brand && (
                            <span className="inline-block px-2 py-0.5 rounded-md bg-indigo-500/25 border border-indigo-400/30 text-indigo-200 text-[11px] font-semibold mb-1">
                              {item.brand}
                            </span>
                          )}
                          <h2 className="text-base sm:text-lg font-bold text-white tracking-tight leading-snug break-words">
                            {item.name}
                          </h2>
                          <div className="text-[11px] text-white/50 mt-0.5">
                            {isDetailed ? '小票明细商品' : '整笔记账支出'}
                          </div>
                        </div>

                        <div className="text-right shrink-0">
                          <span className="block text-[10px] text-white/50 uppercase tracking-wider font-semibold">
                            {isDetailed ? '单价 Unit Price' : '支出金额 Total'}
                          </span>
                          <span className="text-xl sm:text-2xl font-black font-mono text-emerald-400">
                            {formatPrice(transaction.currency, item.unitPrice)}
                          </span>
                        </div>
                      </div>

                      {/* Line subtotal & Whole transaction bill comparison */}
                      <div className="p-3 rounded-xl bg-white/[0.04] border border-white/5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                        <div className="flex items-center gap-2">
                          <span className="text-white/60">购买数量:</span>
                          <span className="font-bold text-white">{item.quantity}</span>
                          <span className="text-white/40">·</span>
                          <span className="text-white/60">该项小计:</span>
                          <span className="font-bold text-white font-mono">
                            {formatPrice(transaction.currency, item.amount)}
                          </span>
                        </div>

                        {hasBillDiscrepancy && (
                          <div className="flex items-center gap-1.5 text-[11px] text-amber-300/90 font-medium">
                            <span>整单总计:</span>
                            <span className="font-bold font-mono text-amber-200">
                              {formatPrice(transaction.currency, transaction.amount)}
                            </span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/30">
                              含税费/服务费或多项
                            </span>
                          </div>
                        )}
                      </div>

                      {/* Metadata Row */}
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-white/65 pt-2 border-t border-white/10">
                        <span className="flex items-center gap-1.5">
                          <Store size={14} className="text-indigo-400 shrink-0" />
                          <span className="truncate max-w-[150px]">{merchant}</span>
                        </span>
                        <span className="flex items-center gap-1.5">
                          <CalendarDays size={14} className="text-indigo-400 shrink-0" />
                          <time dateTime={transaction.date}>{transaction.date}</time>
                        </span>
                      </div>

                      {/* Footer Actions */}
                      <div className="flex items-center justify-end gap-2 pt-2 border-t border-white/10">
                        <button
                          type="button"
                          onClick={() => setSelectedTx(transaction)}
                          className="px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/20 active:scale-95 text-white/90 text-xs font-semibold border border-white/15 transition-all flex items-center gap-1.5 cursor-pointer"
                        >
                          <ReceiptText size={13} />
                          <span>查看完整小票</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => void compareOnline(item)}
                          disabled={Boolean(loadingKey) || online?.status === 'loading' || online?.status === 'ready'}
                          className="px-3 py-1.5 rounded-xl bg-indigo-500/30 hover:bg-indigo-500/50 active:scale-95 text-indigo-200 hover:text-white text-xs font-semibold border border-indigo-400/30 transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-60 disabled:cursor-wait"
                        >
                          {online?.status === 'loading' ? (
                            <LoaderCircle size={13} className="animate-spin text-indigo-300" />
                          ) : (
                            <Globe2 size={13} />
                          )}
                          <span>{online?.status === 'ready' ? '已全网比价' : '全网比价'}</span>
                        </button>
                      </div>

                      {/* Specific Item Online Comparison */}
                      {online?.status === 'ready' && (
                        <div className="rounded-xl bg-emerald-500/10 border border-emerald-400/25 p-3.5 mt-1 flex flex-col gap-2">
                          <div className="flex items-center gap-1.5 text-xs font-bold text-emerald-300">
                            <Sparkles size={13} />
                            <span>当前在线市场参考</span>
                          </div>
                          <p className="text-xs text-white/90 leading-relaxed whitespace-pre-wrap">
                            {online.summary}
                          </p>
                          {online.sources.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 pt-1">
                              {online.sources.map((source) => (
                                <a
                                  key={source.uri}
                                  href={source.uri}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/20 border border-white/15 text-indigo-200 text-[11px] font-medium transition-colors"
                                >
                                  <span className="truncate max-w-[140px]">{source.title}</span>
                                  <ExternalLink size={11} className="shrink-0" />
                                </a>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                      {online?.status === 'error' && (
                        <div className="rounded-xl bg-rose-500/15 border border-rose-400/25 p-2.5 text-xs text-rose-200">
                          {online.message}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </main>

      {/* Bottom Floating Composer & Ryt-Bank Swipe Up Dock */}
      <footer className="relative z-20 shrink-0 flex flex-col border-t border-white/10 bg-[#0c0d1e]/95 backdrop-blur-2xl">
        <div className="w-full max-w-2xl mx-auto px-4 sm:px-6 pt-3 pb-2">
          <form
            onSubmit={handleAskSubmit}
            className="flex items-center gap-2.5 px-4 py-2 rounded-2xl bg-white/[0.09] hover:bg-white/[0.12] focus-within:bg-white/[0.14] border border-white/20 focus-within:border-indigo-400/60 backdrop-blur-2xl shadow-xl transition-all"
          >
            <Sparkles size={18} className="text-indigo-400 shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={draftQuery}
              onChange={(e) => setDraftQuery(e.target.value)}
              placeholder="问价格、本月消费分析、或股票投资洞察…"
              className="flex-1 bg-transparent text-white placeholder:text-white/45 text-sm outline-none py-1.5"
              autoComplete="off"
            />
            <button
              type="submit"
              disabled={!draftQuery.trim()}
              className="w-9 h-9 rounded-xl bg-indigo-500 hover:bg-indigo-400 active:scale-95 text-white flex items-center justify-center transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-md shrink-0 cursor-pointer"
              aria-label="Send query"
            >
              <ArrowUp size={18} />
            </button>
          </form>
        </div>

        {/* Bottom Swipe-Up Dock (Inspired by Ryt Bank) */}
        {onClose && (
          <div
            onClick={onClose}
            onTouchStart={(e) => {
              bottomTouchStartRef.current = e.touches[0].clientY;
            }}
            onTouchEnd={(e) => {
              if (bottomTouchStartRef.current === null) return;
              const diff = e.changedTouches[0].clientY - bottomTouchStartRef.current;
              if (diff < -20) {
                bottomTouchStartRef.current = null;
                onClose();
              }
            }}
            className="w-full py-3 pb-safe flex flex-col items-center justify-center gap-1 cursor-pointer select-none bg-black/40 hover:bg-black/60 active:bg-black/80 border-t border-white/5 transition-all group"
          >
            <ChevronUp size={18} className="text-indigo-400 group-hover:-translate-y-1 transition-transform animate-bounce" />
            <span className="text-[11px] font-semibold text-white/80 tracking-wider">
              向上轻划或点击返回主页 (Swipe up to return)
            </span>
          </div>
        )}
      </footer>

      {/* Transaction Detail Modal if user clicks "查看完整小票" */}
      {selectedTx && (
        <TransactionDetailModal
          transaction={selectedTx}
          onClose={() => setSelectedTx(null)}
        />
      )}
    </div>
  );
}
