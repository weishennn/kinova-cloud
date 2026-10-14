'use client';

import Link from 'next/link';
import { useMemo, useState, type FormEvent } from 'react';
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
  isPulling?: boolean;
}

interface OnlineSource {
  title: string;
  uri: string;
}

type OnlineResult =
  | { status: 'loading' }
  | { status: 'ready'; summary: string; sources: OnlineSource[] }
  | { status: 'error'; message: string };

interface ReceiptPriceMatch {
  transaction: Transaction;
  item: StoredReceiptItem;
  itemIndex: number;
  score: number;
}

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
  const [selectedTx, setSelectedTx] = useState<Transaction | null>(null);

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

  const searchableTransactions = useMemo(() => {
    const byId = new Map<string, Transaction>();
    for (const transaction of [...(historyQuery.data || []), ...transactions]) {
      if (transaction.type !== 'expense' || !transaction.receiptItems?.length) continue;
      const existing = byId.get(transaction.id);
      if (!existing || (transaction.receiptItems.length > (existing.receiptItems?.length || 0))) {
        byId.set(transaction.id, transaction);
      }
    }
    return Array.from(byId.values());
  }, [historyQuery.data, transactions]);

  const matches = useMemo<ReceiptPriceMatch[]>(() => {
    const cleanQuery = query.trim();
    if (cleanQuery.length < 2) return [];

    return searchableTransactions
      .flatMap((transaction) => (transaction.receiptItems || []).map((item, itemIndex) => ({
        transaction,
        item,
        itemIndex,
        score: scoreReceiptItemQuery(item, cleanQuery),
      })))
      .filter((match) => match.score >= 60)
      .sort((left, right) =>
        right.score - left.score || right.transaction.date.localeCompare(left.transaction.date),
      )
      .slice(0, 30);
  }, [query, searchableTransactions]);

  const suggestions = useMemo(() => {
    const labels = new Set<string>();
    const recentTransactions = [...searchableTransactions].sort((left, right) => right.date.localeCompare(left.date));

    for (const transaction of recentTransactions) {
      for (const item of transaction.receiptItems || []) {
        const label = item.brand || item.productType || item.name;
        if (label && label.length >= 2) labels.add(label);
        if (labels.size >= 4) break;
      }
      if (labels.size >= 4) break;
    }

    const defaultPrompts = ['洗发水 (Shampoo)', '鸡蛋 (Eggs)', '牛奶 (Milk)', '咖啡 (Coffee)'];
    const dynamicList = Array.from(labels).map((label) => `How much was ${label}?`);
    return dynamicList.length > 0 ? dynamicList : defaultPrompts;
  }, [searchableTransactions]);

  const askAboutPrice = (value: string) => {
    const cleanValue = value.trim();
    if (!cleanValue) return;
    setDraftQuery(cleanValue);
    setQuery(cleanValue);
  };

  const handleAskSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    askAboutPrice(draftQuery);
  };

  const handleClear = () => {
    setDraftQuery('');
    setQuery('');
  };

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
    <div className="relative min-h-screen w-full flex flex-col justify-between text-white overflow-x-hidden selection:bg-indigo-500/40 bg-gradient-to-b from-[#12132d] via-[#0c0d1e] to-[#070814]">
      {/* Ambient background glows for luxury Ryt-bank feel */}
      <div 
        className="pointer-events-none absolute inset-x-0 top-0 h-[480px] bg-[radial-gradient(ellipse_80%_60%_at_50%_-10%,rgba(99,102,241,0.32),transparent_70%)]" 
        aria-hidden="true" 
      />
      <div 
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[360px] bg-[radial-gradient(circle_at_50%_100%,rgba(139,92,246,0.18),transparent_60%)]" 
        aria-hidden="true" 
      />

      <div className="relative z-10 w-full max-w-2xl mx-auto flex-1 flex flex-col px-4 sm:px-6 pt-safe">
        {/* Top Navigation */}
        <header className="h-14 sm:h-16 flex items-center justify-between gap-3 pt-2">
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

          {/* Ryt-Bank style center pill badge */}
          <div className="flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-white/10 border border-white/15 backdrop-blur-md shadow-inner">
            <Sparkles size={14} className="text-indigo-400" />
            <span className="font-semibold text-sm tracking-tight text-white">Kinova AI</span>
            <span className="px-1.5 py-0.5 rounded-md bg-indigo-500/30 text-indigo-300 font-mono text-[10px] uppercase font-bold tracking-wider">
              beta
            </span>
          </div>

          {/* Right action button */}
          {query.trim().length > 0 ? (
            <button
              type="button"
              onClick={handleClear}
              className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 border border-white/15 backdrop-blur-md flex items-center justify-center text-white/80 hover:text-white transition-all cursor-pointer"
              title="Reset query"
              aria-label="Reset search"
            >
              <RotateCcw size={16} />
            </button>
          ) : (
            <div className="w-10 h-10" aria-hidden="true" />
          )}
        </header>

        {/* Content Area */}
        <main className="flex-1 flex flex-col justify-center py-6">
          {query.trim().length === 0 ? (
            /* Welcome / Hero State (Inspired by Ryt AI) */
            <div className="flex-1 flex flex-col items-center justify-center text-center max-w-md mx-auto py-8">
              <div className="w-16 h-16 rounded-3xl bg-indigo-500/20 border border-indigo-400/30 backdrop-blur-xl flex items-center justify-center text-indigo-300 shadow-[0_0_32px_rgba(99,102,241,0.35)] mb-6 animate-pulse">
                <Sparkles size={32} strokeWidth={1.8} />
              </div>
              <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-white mb-2">
                Where do we start?
              </h1>
              <p className="text-sm text-white/60 max-w-xs sm:max-w-sm mb-8 leading-relaxed">
                Ask about any product or price from your saved receipts.
              </p>

              {/* Dynamic suggestion chips */}
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

              {searchableTransactions.length === 0 && !historyQuery.isFetching && (
                <div className="text-xs text-white/40 bg-white/5 border border-white/10 rounded-xl px-4 py-2.5">
                  💡 扫描小票并保存明细后，Kinova AI 将自动记住每件商品的物价。
                </div>
              )}
            </div>
          ) : (
            /* Search Conversation & Results State */
            <div className="flex-1 flex flex-col gap-4 py-2">
              {/* User Query Bubble */}
              <div className="self-end max-w-[85%] rounded-2xl rounded-br-sm bg-gradient-to-r from-indigo-600 to-violet-600 text-white px-4 py-2.5 text-sm font-medium shadow-lg backdrop-blur-md border border-white/15">
                {query}
              </div>

              {/* Assistant Answer Header */}
              <div className="flex items-center gap-2 text-xs font-semibold text-white/80 pt-1">
                <div className="w-6 h-6 rounded-lg bg-indigo-500/30 border border-indigo-400/40 flex items-center justify-center text-indigo-300">
                  <Sparkles size={14} />
                </div>
                <span>From your receipts</span>
                {matches.length > 0 && (
                  <span className="px-2 py-0.5 rounded-full bg-white/10 text-white/70 text-[11px] font-mono">
                    {matches.length} {matches.length === 1 ? 'match' : 'matches'}
                  </span>
                )}
                {historyQuery.isFetching && (
                  <LoaderCircle size={14} className="animate-spin text-indigo-400 ml-auto" />
                )}
              </div>

              {/* Match Results List */}
              {matches.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 px-4 rounded-3xl bg-white/[0.04] border border-white/10 text-center text-white/60">
                  <PackageSearch size={32} className="text-white/40 mb-3" />
                  <div className="text-base font-semibold text-white mb-1">
                    {historyQuery.isFetching ? 'Still searching history…' : 'No saved price found'}
                  </div>
                  <p className="text-xs text-white/50 max-w-xs">
                    Try searching for a simpler brand name, e.g. shampoo, milk, Sunsilk, or eggs.
                  </p>
                </div>
              ) : (
                <div className="grid gap-3 overflow-y-auto max-h-[calc(100dvh-280px)] pr-1 pb-4">
                  {matches.map(({ transaction, item, itemIndex }) => {
                    const key = stableItemKey(item);
                    const online = onlineResults[key];
                    const merchant = transaction.description || transaction.category || 'Receipt purchase';

                    return (
                      <article
                        key={`${transaction.id}-${itemIndex}`}
                        className="rounded-2xl bg-white/[0.06] hover:bg-white/[0.09] border border-white/10 hover:border-white/20 backdrop-blur-xl p-4 sm:p-5 transition-all shadow-lg flex flex-col gap-3"
                      >
                        {/* Header: Item name + Brand tag + Unit Price */}
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

                        {/* Metadata Row: Store, Date, Quantity */}
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

                        {/* Footer: Line Total & Action Buttons */}
                        <div className="flex items-center justify-between gap-3 pt-2 border-t border-white/10">
                          <div className="text-xs text-white/60">
                            Line total: <span className="font-semibold text-white font-mono">{formatPrice(transaction.currency, item.amount)}</span>
                          </div>

                          <div className="flex items-center gap-2">
                            {/* Open Transaction Detail Modal */}
                            <button
                              type="button"
                              onClick={() => setSelectedTx(transaction)}
                              className="px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/20 active:scale-95 text-white/90 text-xs font-semibold border border-white/15 transition-all flex items-center gap-1.5 cursor-pointer"
                              title="View receipt transaction details"
                            >
                              <ReceiptText size={13} />
                              <span>View receipt</span>
                            </button>

                            {/* Compare Online Button */}
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

                        {/* Online Comparison Expanded Drawer */}
                        {online?.status === 'ready' && (
                          <div className="rounded-xl bg-emerald-500/10 border border-emerald-400/25 p-3.5 mt-1 flex flex-col gap-2">
                            <div className="flex items-center gap-1.5 text-xs font-bold text-emerald-300">
                              <Sparkles size={13} />
                              <span>Current market online listings</span>
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

        {/* Bottom Floating Composer (Matches Ryt AI Input) */}
        <footer className="sticky bottom-0 z-20 pb-safe pt-2">
          <form
            onSubmit={handleAskSubmit}
            className="flex items-center gap-2.5 px-4 py-2 rounded-2xl bg-white/[0.09] hover:bg-white/[0.12] focus-within:bg-white/[0.14] border border-white/20 focus-within:border-indigo-400/60 backdrop-blur-2xl shadow-[0_12px_40px_rgba(0,0,0,0.5)] transition-all"
          >
            <Sparkles size={18} className="text-indigo-400 shrink-0" />
            <input
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

          {/* Bottom Ryt-Bank Chevron Return Handle */}
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              className="w-full py-2.5 flex flex-col items-center justify-center gap-0.5 text-white/50 hover:text-white/90 active:scale-95 transition-all cursor-pointer group"
              aria-label="Return to home dashboard"
            >
              <ChevronUp size={18} className="text-indigo-400 group-hover:-translate-y-0.5 transition-transform animate-bounce" />
              <span className="text-[10px] font-medium tracking-wide uppercase">Swipe up or tap to return</span>
            </button>
          ) : (
            <div className="py-2 text-center text-[10px] text-white/40">
              ✨ Kinova AI · Powered by Gemini & Smart Receipt Memory
            </div>
          )}
        </footer>
      </div>

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
