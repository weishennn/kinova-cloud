'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  CalendarDays,
  ExternalLink,
  Globe2,
  LoaderCircle,
  PackageSearch,
  ReceiptText,
  Search,
  Sparkles,
  Store,
  X,
} from 'lucide-react';
import { normalizeTransaction, useTransactions, type Transaction } from '@/hooks/useTransactions';
import { getUnifiedSheetData } from '@/hooks/useSheets';
import { getActiveUserCacheScope } from '@/lib/sheets-api';
import { scoreReceiptItemQuery, type StoredReceiptItem } from '@/lib/receipt-items';

interface ReceiptPriceSearchProps {
  returnTo: string;
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

export function ReceiptPriceSearch({ returnTo }: ReceiptPriceSearchProps) {
  const [query, setQuery] = useState('');
  const [onlineResults, setOnlineResults] = useState<Record<string, OnlineResult>>({});
  const [loadingKey, setLoadingKey] = useState('');
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

  const historyStatus = historyQuery.isFetching
    ? 'Checking older receipts…'
    : historyQuery.isError
      ? 'Older receipts could not load'
      : historyQuery.isSuccess
        ? 'All receipt history loaded'
        : 'Searching saved receipts';

  return (
    <div className="receipt-price-page">
      <div className="receipt-price-page-inner">
        <header className="receipt-price-page-nav">
          <Link href={returnTo} className="receipt-price-back">
            <ArrowLeft size={18} aria-hidden="true" />
            <span>Back</span>
          </Link>
          <span className="receipt-price-nav-title">Price history</span>
          <span className="receipt-price-nav-spacer" aria-hidden="true" />
        </header>

        <section className="receipt-price-hero" aria-labelledby="receipt-price-heading">
          <div className="receipt-price-hero-copy">
            <p className="receipt-price-hero-kicker">Your receipts, remembered</p>
            <h1 id="receipt-price-heading">What did you pay?</h1>
            <p>Find a product, brand or size across your saved receipts.</p>
          </div>
          <div className="receipt-price-hero-icon" aria-hidden="true">
            <ReceiptText size={26} strokeWidth={1.8} />
          </div>
        </section>

        <section className="receipt-price-search-panel" aria-labelledby="receipt-price-search-label">
          <label id="receipt-price-search-label" htmlFor="receipt-price-query">Search your receipts</label>
          <div className="receipt-price-search-field">
            <Search size={19} aria-hidden="true" />
            <input
              id="receipt-price-query"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Try Sunsilk shampoo or Dove"
              aria-describedby="receipt-price-search-help"
              autoComplete="off"
            />
            {query && (
              <button
                type="button"
                className="receipt-price-clear"
                onClick={() => setQuery('')}
                aria-label="Clear search"
              >
                <X size={18} aria-hidden="true" />
              </button>
            )}
          </div>
          <div className="receipt-price-search-status" aria-live="polite">
            <span id="receipt-price-search-help">Saved receipt matches appear first.</span>
            <span className="receipt-price-history-status">
              {historyQuery.isFetching && <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />}
              {historyStatus}
            </span>
          </div>
          {historyQuery.isError && (
            <div className="receipt-price-history-error" role="status">
              <span>Showing receipt items already saved on this device.</span>
              <button type="button" onClick={() => void historyQuery.refetch()}>Retry</button>
            </div>
          )}
        </section>

        {query.trim().length === 0 ? (
          <section className="receipt-price-start" aria-labelledby="receipt-price-start-title">
            <div className="receipt-price-section-heading">
              <div>
                <h2 id="receipt-price-start-title">Find an item</h2>
                <p>Search by product, brand or pack size.</p>
              </div>
              <PackageSearch size={21} aria-hidden="true" />
            </div>
            <div className="receipt-price-suggestions" aria-label="Example searches">
              {['Sunsilk', 'Dove', 'Shampoo'].map((suggestion) => (
                <button key={suggestion} type="button" onClick={() => setQuery(suggestion)}>
                  <Search size={14} aria-hidden="true" />
                  {suggestion}
                </button>
              ))}
            </div>
            <p className="receipt-price-start-note">Product names and prices are saved from your receipt scans.</p>
          </section>
        ) : query.trim().length < 2 ? (
          <div className="receipt-price-empty" role="status">
            <Search size={21} aria-hidden="true" />
            <h2>Keep typing</h2>
            <p>Enter at least 2 letters to search your receipt items.</p>
          </div>
        ) : (
          <section className="receipt-price-results" aria-label={`${matches.length} receipt price matches`}>
            <div className="receipt-price-results-heading">
              <div>
                <h2>{matches.length ? 'Found in your receipts' : historyQuery.isFetching ? 'Searching older receipts' : 'No saved price found'}</h2>
                <p>
                  {matches.length
                    ? `Showing ${matches.length} ${matches.length === 1 ? 'match' : 'matches'} for “${query.trim()}”.`
                    : historyQuery.isFetching
                      ? 'Your recent records are searched first. Older ones are loading in the background.'
                      : `Try another brand, product name or size.`}
                </p>
              </div>
              {matches.length > 0 && <span className="receipt-price-result-count">{matches.length}</span>}
            </div>

            {matches.length === 0 ? (
              <div className="receipt-price-empty">
                {historyQuery.isFetching ? <LoaderCircle size={21} className="animate-spin" aria-hidden="true" /> : <PackageSearch size={21} aria-hidden="true" />}
                <h2>{historyQuery.isFetching ? 'Checking the rest of your history…' : 'Try a different search'}</h2>
                <p>{historyQuery.isError ? 'Older receipts could not be checked. Retry the history search above.' : 'For example, search for Sunsilk, Dove or a product size.'}</p>
              </div>
            ) : (
              <div className="receipt-price-result-list">
                {matches.map(({ transaction, item, itemIndex }) => {
                  const key = stableItemKey(item);
                  const online = onlineResults[key];
                  const merchant = transaction.description || transaction.category || 'Receipt purchase';

                  return (
                    <article key={`${transaction.id}-${itemIndex}`} className="receipt-price-result">
                      <div className="receipt-price-result-main">
                        <div className="receipt-price-result-product">
                          {item.brand && <p className="receipt-price-result-brand">{item.brand}</p>}
                          <h3>{item.name}</h3>
                        </div>
                        <div className="receipt-price-result-price">
                          <span>Unit price</span>
                          <strong>{formatPrice(transaction.currency, item.unitPrice)}</strong>
                        </div>
                      </div>

                      <div className="receipt-price-result-meta">
                        <span><Store size={15} aria-hidden="true" />{merchant}</span>
                        <span><CalendarDays size={15} aria-hidden="true" /><time dateTime={transaction.date}>{transaction.date}</time></span>
                        <span>{item.quantity} {item.quantity === 1 ? 'item' : 'items'}</span>
                        {item.includedInExpense === false && <span>Not included in expense total</span>}
                      </div>

                      <div className="receipt-price-result-footer">
                        <p className="receipt-price-line-total">
                          <span>Line total</span>
                          <strong>{formatPrice(transaction.currency, item.amount)}</strong>
                        </p>
                        <button
                          type="button"
                          className="receipt-price-compare"
                          onClick={() => void compareOnline(item)}
                          disabled={Boolean(loadingKey) || online?.status === 'loading' || online?.status === 'ready'}
                        >
                          {online?.status === 'loading' ? <LoaderCircle size={16} className="animate-spin" aria-hidden="true" /> : <Globe2 size={16} aria-hidden="true" />}
                          {online?.status === 'ready' ? 'Compared online' : 'Compare online'}
                        </button>
                      </div>

                      {online?.status === 'error' && (
                        <p className="receipt-price-online-error" role="alert">{online.message} You can try again.</p>
                      )}
                      {online?.status === 'ready' && (
                        <div className="receipt-price-online-result">
                          <p className="receipt-price-online-heading"><Sparkles size={14} aria-hidden="true" />Current web listings</p>
                          <p className="receipt-price-online-summary">{online.summary}</p>
                          {online.sources.length > 0 && (
                            <div className="receipt-price-online-sources">
                              {online.sources.map((source) => (
                                <a
                                  key={source.uri}
                                  href={source.uri}
                                  target="_blank"
                                  rel="noreferrer"
                                  aria-label={`${source.title} (opens in a new tab)`}
                                >
                                  <span>{source.title}</span>
                                  <ExternalLink size={13} aria-hidden="true" />
                                </a>
                              ))}
                            </div>
                          )}
                          <p className="receipt-price-online-note">Online listings can change. Check the retailer before buying.</p>
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
