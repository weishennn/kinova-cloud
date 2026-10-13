'use client';

import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Globe2, LoaderCircle, PackageSearch, Search, Sparkles } from 'lucide-react';
import { CockpitModal, CockpitModalHeader } from '@/components/money-cockpit/cockpit-modal';
import { normalizeTransaction, useTransactions, type Transaction } from '@/hooks/useTransactions';
import { getUnifiedSheetData } from '@/hooks/useSheets';
import { getActiveUserCacheScope } from '@/lib/sheets-api';
import { scoreReceiptItemQuery, type StoredReceiptItem } from '@/lib/receipt-items';

interface ReceiptPriceSearchProps {
  isOpen: boolean;
  onClose: () => void;
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

export function ReceiptPriceSearch({ isOpen, onClose }: ReceiptPriceSearchProps) {
  const [query, setQuery] = useState('');
  const [onlineResults, setOnlineResults] = useState<Record<string, OnlineResult>>({});
  const [loadingKey, setLoadingKey] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const { transactions = [] } = useTransactions();
  const cacheScope = getActiveUserCacheScope();

  const historyQuery = useQuery({
    queryKey: ['receipt-price-history', cacheScope],
    queryFn: async () => {
      const result = await getUnifiedSheetData('Transactions', 'all');
      return (result.rows || []).map((row) => normalizeTransaction(row));
    },
    enabled: isOpen,
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

  const resetAndClose = () => {
    setQuery('');
    onClose();
  };

  return (
    <CockpitModal
      isOpen={isOpen}
      onClose={resetAndClose}
      labelledBy="receipt-price-search-title"
      describedBy="receipt-price-search-description"
      size="wide"
      className="receipt-price-search-modal"
    >
      <CockpitModalHeader
        title="Ask what you paid"
        titleId="receipt-price-search-title"
        description="Search item prices from your saved receipts. Online checks are optional."
        descriptionId="receipt-price-search-description"
        icon={<PackageSearch size={20} />}
        onClose={resetAndClose}
        closeLabel="Close price search"
      />

      <div className="space-y-4 pt-4">
        <div>
          <label htmlFor="receipt-price-query" className="mb-1.5 block text-xs font-semibold text-slate-700 dark:text-zinc-200">
            Product, brand or size
          </label>
          <div className="relative">
            <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500 dark:text-zinc-400" aria-hidden="true" />
            <input
              ref={inputRef}
              id="receipt-price-query"
              type="search"
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Try “Sunsilk shampoo 800 ml” or “Dove”"
              className="min-h-12 w-full rounded-2xl border border-slate-200 bg-white/90 py-3 pl-10 pr-4 text-sm text-slate-950 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 dark:border-white/10 dark:bg-zinc-900/80 dark:text-white"
            />
          </div>
        </div>

        <div className="flex min-h-5 items-center justify-between gap-3 text-[11px] text-slate-500 dark:text-zinc-400" aria-live="polite">
          <span>Saved receipt matches appear first.</span>
          {historyQuery.isFetching ? (
            <span className="inline-flex shrink-0 items-center gap-1.5">
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Searching older receipts…
            </span>
          ) : historyQuery.isError ? (
            <button type="button" onClick={() => void historyQuery.refetch()} className="min-h-11 rounded-lg px-2 font-semibold text-indigo-700 hover:bg-indigo-500/10 focus-visible:outline-2 focus-visible:outline-indigo-500 dark:text-indigo-300">
              Retry older history
            </button>
          ) : historyQuery.isSuccess ? (
              <span className="shrink-0">Full history loaded</span>
          ) : null}
        </div>

        {historyQuery.isError && (
          <p className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200" role="status">
            Older records could not load. Showing receipt matches already on this device.
          </p>
        )}

        {query.trim().length < 2 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50/80 px-4 py-7 text-center dark:border-white/10 dark:bg-zinc-900/35">
            <Search className="mx-auto h-5 w-5 text-indigo-600 dark:text-indigo-300" aria-hidden="true" />
            <p className="mt-2 text-sm font-semibold text-slate-800 dark:text-zinc-200">Search a brand or product</p>
            <p className="mt-1 text-xs text-slate-500 dark:text-zinc-400">For example: “Dove body wash” or “Sunsilk 800 ml”.</p>
          </div>
        ) : matches.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50/80 px-4 py-7 text-center dark:border-white/10 dark:bg-zinc-900/35">
            <PackageSearch className="mx-auto h-5 w-5 text-slate-500 dark:text-zinc-400" aria-hidden="true" />
            <p className="mt-2 text-sm font-semibold text-slate-800 dark:text-zinc-200">
              {historyQuery.isFetching ? 'Checking the rest of your history…' : 'No matching receipt items yet'}
            </p>
            <p className="mt-1 text-xs text-slate-500 dark:text-zinc-400">
              New receipt scans save product names, sizes, quantities, and prices here.
            </p>
          </div>
        ) : (
          <div className="max-h-[min(54dvh,520px)] space-y-2 overflow-y-auto overscroll-contain pr-1" aria-label={`${matches.length} saved receipt price matches`}>
            {matches.map(({ transaction, item, itemIndex }) => {
              const key = stableItemKey(item);
              const online = onlineResults[key];
              const merchant = transaction.description || transaction.category || 'Receipt purchase';
              return (
                <article key={`${transaction.id}-${itemIndex}`} className="rounded-2xl border border-slate-200 bg-white/90 p-3 dark:border-white/[0.08] dark:bg-zinc-900/55">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <h3 className="break-words text-sm font-semibold text-slate-950 dark:text-white">{item.name}</h3>
                      <p className="mt-1 text-xs text-slate-500 dark:text-zinc-400">
                        {merchant} · {transaction.date}
                      </p>
                      <p className="mt-1 text-[11px] text-slate-600 dark:text-zinc-300">
                        {item.quantity} × {formatPrice(transaction.currency, item.unitPrice)} each
                        {item.includedInExpense === false ? ' · not included in this expense total' : ''}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="font-mono text-base font-bold text-slate-950 dark:text-white">
                        {formatPrice(transaction.currency, item.unitPrice)}
                      </p>
                      {item.quantity > 1 && (
                        <p className="mt-0.5 text-[10px] text-slate-500 dark:text-zinc-400">
                          line total {formatPrice(transaction.currency, item.amount)}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-slate-200 pt-2 dark:border-white/[0.06]">
                    <button
                      type="button"
                      onClick={() => void compareOnline(item)}
                      disabled={Boolean(loadingKey) || online?.status === 'loading' || online?.status === 'ready'}
                      className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-indigo-500/25 bg-indigo-500/10 px-3 text-xs font-semibold text-indigo-800 transition hover:bg-indigo-500/15 focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:cursor-not-allowed disabled:opacity-60 dark:text-indigo-200"
                    >
                      {online?.status === 'loading' ? (
                        <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      ) : (
                        <Globe2 className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                      {online?.status === 'ready' ? 'Online check complete' : 'Compare online'}
                    </button>
                    <span className="text-[10px] text-slate-500 dark:text-zinc-400">Optional · uses configured Gemini API</span>
                  </div>

                  {online?.status === 'error' && (
                    <p className="mt-2 rounded-lg bg-rose-500/10 px-2.5 py-2 text-xs text-rose-800 dark:text-rose-200" role="alert">
                      {online.message}
                    </p>
                  )}
                  {online?.status === 'ready' && (
                    <div className="mt-2 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3">
                      <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-emerald-800 dark:text-emerald-300">
                        <Sparkles className="h-3 w-3" aria-hidden="true" /> Current web listings
                      </p>
                      <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-slate-700 dark:text-zinc-200">{online.summary}</p>
                      {online.sources.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {online.sources.map((source) => (
                            <a
                              key={source.uri}
                              href={source.uri}
                              target="_blank"
                              rel="noreferrer"
                              aria-label={`${source.title} (opens in a new tab)`}
                              className="inline-flex min-h-11 max-w-full items-center gap-1 rounded-lg border border-slate-200 bg-white/80 px-2 text-[10px] font-medium text-indigo-800 hover:border-indigo-300 focus-visible:outline-2 focus-visible:outline-indigo-500 dark:border-white/10 dark:bg-zinc-950/50 dark:text-indigo-200"
                            >
                              <span className="truncate">{source.title}</span>
                              <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
                            </a>
                          ))}
                        </div>
                      )}
                      <p className="mt-2 text-[10px] text-slate-500 dark:text-zinc-400">Online listings change; check the retailer page before buying.</p>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>
    </CockpitModal>
  );
}
