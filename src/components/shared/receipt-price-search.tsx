'use client';

import Link from 'next/link';
import { useMemo, useState, useRef, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowUp,
  CalendarDays,
  ChevronUp,
  ExternalLink,
  Globe2,
  LoaderCircle,
  PackageSearch,
  ReceiptText,
  RotateCcw,
  Sparkles,
  Store,
  X,
} from 'lucide-react';
import { normalizeTransaction, useTransactions, type Transaction } from '@/hooks/useTransactions';
import { getUnifiedSheetData } from '@/hooks/useSheets';
import { getActiveUserCacheScope } from '@/lib/sheets-api';
import { scoreReceiptItemQuery, type StoredReceiptItem } from '@/lib/receipt-items';
import { TransactionDetailModal } from '@/components/shared/transaction-detail-modal';

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

interface SearchableItemEntry {
  transaction: Transaction;
  item: StoredReceiptItem;
  isDetailed: boolean;
}

const COMMON_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'bought', 'buy', 'can', 'cost', 'could', 'did', 'do', 'does', 'find',
  'for', 'have', 'how', 'i', 'is', 'item', 'items', 'last', 'much', 'my', 'of', 'paid', 'pay',
  'price', 'show', 'tell', 'the', 'this', 'was', 'what', 'when', 'where', '多少', '多少钱', '价格', '请问', '查'
]);

function formatPrice(currency: string, amount: number): string {
  const normalizedCurrency = /^[A-Z]{3}$/.test(currency) ? currency : 'MYR';
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
  const [onlineResults, setOnlineResults] = useState<Record<string, OnlineResult>>({});
  const [loadingKey, setLoadingKey] = useState('');
  const [generalOnlineResult, setGeneralOnlineResult] = useState<OnlineResult | null>(null);
  const [isGeneralLoading, setIsGeneralLoading] = useState(false);
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

  // Index ALL expense transactions: both detailed receipt items AND regular expenses (e.g. "Chicken rice RM 9")
  const searchableEntries = useMemo<SearchableItemEntry[]>(() => {
    const entries: SearchableItemEntry[] = [];
    const seenTx = new Set<string>();

    for (const transaction of [...(historyQuery.data || []), ...transactions]) {
      if (transaction.type !== 'expense') continue;
      if (seenTx.has(transaction.id)) continue;
      seenTx.add(transaction.id);

      // 1. Detailed items parsed from receipts
      if (transaction.receiptItems && transaction.receiptItems.length > 0) {
        for (const item of transaction.receiptItems) {
          entries.push({ transaction, item, isDetailed: true });
        }
      }

      // 2. Synthesized entry from transaction description/category
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
    return entries;
  }, [historyQuery.data, transactions]);

  // Intelligent matching against query
  const matches = useMemo(() => {
    const rawQuery = query.trim().toLowerCase();
    if (rawQuery.length < 2) return [];

    // Filter stop words to find core product keywords (e.g. "how much is chicken rice" -> ["chicken", "rice"])
    const words = rawQuery
      .split(/[\s,，、]+/)
      .map((w) => w.trim())
      .filter((w) => w.length >= 2 && !COMMON_STOP_WORDS.has(w));
    const effectiveKeywords = words.length > 0 ? words : [rawQuery];

    return searchableEntries
      .map(({ transaction, item, isDetailed }) => {
        let score = scoreReceiptItemQuery(item, rawQuery);
        const nameLower = item.name.toLowerCase();
        const brandLower = (item.brand || '').toLowerCase();
        const fullText = `${nameLower} ${brandLower}`;

        // 1. Exact or partial substring match
        if (nameLower.includes(rawQuery) || rawQuery.includes(nameLower)) {
          score = Math.max(score, 95);
        }

        // 2. Multi-word keyword match (e.g. user typed "chicken rice" and transaction is "Hainanese Chicken Rice")
        if (effectiveKeywords.every((kw) => fullText.includes(kw))) {
          score = Math.max(score, 90);
        } else if (effectiveKeywords.some((kw) => fullText.includes(kw))) {
          score = Math.max(score, 65);
        }

        return { transaction, item, score, isDetailed };
      })
      .filter((m) => m.score >= 55)
      .sort((a, b) => b.score - a.score || b.transaction.date.localeCompare(a.transaction.date))
      .slice(0, 30);
  }, [query, searchableEntries]);

  // Dynamic suggestions from past history + popular defaults
  const suggestions = useMemo(() => {
    const labels = new Set<string>();
    const recent = [...searchableEntries].sort((a, b) => b.transaction.date.localeCompare(a.transaction.date));

    for (const { item } of recent) {
      const label = item.brand || item.productType || item.name;
      if (label && label.length >= 2 && label.length <= 25) {
        labels.add(label);
        if (labels.size >= 4) break;
      }
    }

    const defaultPrompts = ['鸡饭 (Chicken rice)', '洗发水 (Shampoo)', '鸡蛋 (Eggs)', '咖啡 (Coffee)'];
    const dynamicList = Array.from(labels).map((label) => `How much was ${label}?`);
    return dynamicList.length >= 2 ? dynamicList : defaultPrompts;
  }, [searchableEntries]);

  const askAboutPrice = (value: string) => {
    const cleanValue = value.trim();
    if (!cleanValue) return;
    setQuery(cleanValue);
    setDraftQuery(''); // Immediately clear input box!
    setGeneralOnlineResult(null); // Reset general online state for new query
    // Auto blur input so virtual keyboard closes and results are visible
    if (typeof document !== 'undefined') {
      const activeEl = document.activeElement as HTMLElement | null;
      activeEl?.blur?.();
    }
  };

  const handleAskSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draftQuery.trim()) return;
    askAboutPrice(draftQuery);
  };

  const handleClear = () => {
    setDraftQuery('');
    setQuery('');
    setGeneralOnlineResult(null);
  };

  // Online general search (used when no saved item is found in ledger or user wants current market price)
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
            beta
          </span>
        </div>

        {/* Right Action */}
        {query.trim().length > 0 ? (
          <button
            type="button"
            onClick={handleClear}
            className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 border border-white/15 backdrop-blur-md flex items-center justify-center text-white/80 hover:text-white transition-all cursor-pointer"
            title="Clear and search another product"
            aria-label="Clear search"
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
          /* Welcome Hero */
          <div className="flex-1 flex flex-col items-center justify-center text-center max-w-md mx-auto py-8">
            <div className="w-16 h-16 rounded-3xl bg-indigo-500/20 border border-indigo-400/30 backdrop-blur-xl flex items-center justify-center text-indigo-300 shadow-[0_0_32px_rgba(99,102,241,0.35)] mb-6 animate-pulse">
              <Sparkles size={32} strokeWidth={1.8} />
            </div>
            <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-white mb-2">
              Where do we start?
            </h1>
            <p className="text-sm text-white/60 max-w-xs sm:max-w-sm mb-8 leading-relaxed">
              Ask about any product or price from your receipts & expenses.
            </p>

            {/* Quick Suggestion Chips */}
            <div className="w-full grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-left mb-6">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => askAboutPrice(suggestion)}
                  className="p-3.5 rounded-2xl bg-white/[0.07] hover:bg-white/[0.13] active:scale-[0.98] border border-white/10 hover:border-white/25 backdrop-blur-md transition-all flex items-center gap-3 text-white/90 text-xs sm:text-sm font-medium cursor-pointer shadow-sm group"
                >
                  <div className="w-8 h-8 rounded-xl bg-indigo-500/20 text-indigo-300 flex items-center justify-center shrink-0 group-hover:scale-110 transition-transform">
                    <ReceiptText size={16} />
                  </div>
                  <span className="truncate flex-1">{suggestion}</span>
                </button>
              ))}
            </div>

            <div className="text-xs text-white/40 bg-white/5 border border-white/10 rounded-xl px-4 py-2.5">
              💡 涵盖所有支出记录与小票明细，如未记录也可点击全网查询实时市价。
            </div>
          </div>
        ) : (
          /* Conversation & Results */
          <div className="w-full max-w-2xl mx-auto flex flex-col gap-4 py-2">
            {/* User Query Bubble */}
            <div className="self-end max-w-[85%] rounded-2xl rounded-br-sm bg-gradient-to-r from-indigo-600 to-violet-600 text-white px-4 py-2.5 text-sm font-medium shadow-lg backdrop-blur-md border border-white/15">
              {query}
            </div>

            {/* Assistant Header */}
            <div className="flex items-center gap-2 text-xs font-semibold text-white/80 pt-1">
              <div className="w-6 h-6 rounded-lg bg-indigo-500/30 border border-indigo-400/40 flex items-center justify-center text-indigo-300">
                <Sparkles size={14} />
              </div>
              <span>From your saved ledger & receipts</span>
              {matches.length > 0 && (
                <span className="px-2 py-0.5 rounded-full bg-white/10 text-white/70 text-[11px] font-mono">
                  {matches.length} {matches.length === 1 ? 'match' : 'matches'}
                </span>
              )}
              {historyQuery.isFetching && (
                <LoaderCircle size={14} className="animate-spin text-indigo-400 ml-auto" />
              )}
            </div>

            {/* If No Matches in Ledger -> Provide instant Gemini Online Price Lookup */}
            {matches.length === 0 && (
              <div className="flex flex-col items-center justify-center py-8 px-4 rounded-3xl bg-white/[0.04] border border-white/10 text-center">
                <PackageSearch size={32} className="text-white/40 mb-3" />
                <div className="text-base font-bold text-white mb-1">
                  你的个人账本中暂无「{query}」的记录
                </div>
                <p className="text-xs text-white/60 max-w-sm mb-5 leading-relaxed">
                  历史账单和小票中暂未找到此商品。想让 Kinova AI 使用 Google 搜索查询马来西亚当前的公开发售/平均市价吗？
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

            {/* General Online Search Result (Displayed when user triggered market search) */}
            {generalOnlineResult?.status === 'ready' && (
              <div className="rounded-2xl bg-emerald-500/10 border border-emerald-400/30 p-4 sm:p-5 flex flex-col gap-2.5 shadow-xl">
                <div className="flex items-center gap-2 text-xs font-bold text-emerald-300">
                  <Globe2 size={15} />
                  <span>马来西亚当前市场参考价格 (Google Search Grounding)</span>
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

            {/* List of Matched Items from Ledger */}
            {matches.map(({ transaction, item, isDetailed }, idx) => {
              const key = stableItemKey(item);
              const online = onlineResults[key];
              const merchant = transaction.description || transaction.category || 'Purchase';

              return (
                <article
                  key={`${transaction.id}-${idx}`}
                  className="rounded-2xl bg-white/[0.06] hover:bg-white/[0.09] border border-white/10 hover:border-white/20 backdrop-blur-xl p-4 sm:p-5 transition-all shadow-lg flex flex-col gap-3"
                >
                  {/* Item name + Brand tag + Price */}
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
                    </div>
                    <div className="text-right shrink-0">
                      <span className="block text-[10px] text-white/50 uppercase tracking-wider font-semibold">Unit price</span>
                      <span className="text-xl sm:text-2xl font-bold font-mono text-emerald-400">
                        {formatPrice(transaction.currency, item.unitPrice)}
                      </span>
                    </div>
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
                    <span className="flex items-center gap-1.5">
                      <PackageSearch size={14} className="text-indigo-400 shrink-0" />
                      <span>{item.quantity} {item.quantity === 1 ? 'item' : 'items'}</span>
                    </span>
                  </div>

                  {/* Footer Actions */}
                  <div className="flex items-center justify-between gap-3 pt-2 border-t border-white/10">
                    <div className="text-xs text-white/60">
                      Line total: <span className="font-semibold text-white font-mono">{formatPrice(transaction.currency, item.amount)}</span>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setSelectedTx(transaction)}
                        className="px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/20 active:scale-95 text-white/90 text-xs font-semibold border border-white/15 transition-all flex items-center gap-1.5 cursor-pointer"
                        title="View transaction receipt details"
                      >
                        <ReceiptText size={13} />
                        <span>View receipt</span>
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
                        <span>{online?.status === 'ready' ? 'Compared' : 'Compare online'}</span>
                      </button>
                    </div>
                  </div>

                  {/* Specific Online Comparison Result */}
                  {online?.status === 'ready' && (
                    <div className="rounded-xl bg-emerald-500/10 border border-emerald-400/25 p-3.5 mt-1 flex flex-col gap-2">
                      <div className="flex items-center gap-1.5 text-xs font-bold text-emerald-300">
                        <Sparkles size={13} />
                        <span>Current online market listings</span>
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
              placeholder="Ask Kinova AI about prices or receipts…"
              className="flex-1 bg-transparent text-white placeholder:text-white/45 text-sm outline-none py-1.5"
              autoComplete="off"
            />
            <button
              type="submit"
              disabled={!draftQuery.trim()}
              className="w-9 h-9 rounded-xl bg-indigo-500 hover:bg-indigo-400 active:scale-95 text-white flex items-center justify-center transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-md shrink-0 cursor-pointer"
              aria-label="Send search query"
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

      {/* Transaction Detail Modal if user clicks "View receipt" */}
      {selectedTx && (
        <TransactionDetailModal
          transaction={selectedTx}
          onClose={() => setSelectedTx(null)}
        />
      )}
    </div>
  );
}
