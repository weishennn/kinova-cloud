'use client';

import Link from 'next/link';
import { useMemo, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowUp,
  CalendarDays,
  ExternalLink,
  Globe2,
  LoaderCircle,
  PackageSearch,
  ReceiptText,
  Sparkles,
  Store,
  X,
} from 'lucide-react';
import { ThemeToggle } from './theme-toggle';
import { normalizeTransaction, useTransactions, type Transaction } from '@/hooks/useTransactions';
import { getUnifiedSheetData } from '@/hooks/useSheets';
import { getActiveUserCacheScope } from '@/lib/sheets-api';
import { scoreReceiptItemQuery, type StoredReceiptItem } from '@/lib/receipt-items';

interface ReceiptPriceSearchProps {
  returnTo: string;
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

export function ReceiptPriceSearch({ returnTo, onClose }: ReceiptPriceSearchProps) {
  const [draftQuery, setDraftQuery] = useState('');
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

  const suggestions = useMemo(() => {
    const labels = new Set<string>();
    const recentTransactions = [...searchableTransactions].sort((left, right) => right.date.localeCompare(left.date));

    for (const transaction of recentTransactions) {
      for (const item of transaction.receiptItems || []) {
        const label = item.brand || item.productType || item.name;
        if (label) labels.add(label);
        if (labels.size >= 3) break;
      }
      if (labels.size >= 3) break;
    }

    return Array.from(labels).map((label) => `How much was ${label}?`);
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
          {onClose ? (
            <button type="button" onClick={onClose} className="receipt-price-back" aria-label="Close price search">
              <X size={19} aria-hidden="true" />
            </button>
          ) : (
            <Link href={returnTo} className="receipt-price-back" aria-label="Close price search">
              <X size={19} aria-hidden="true" />
            </Link>
          )}
          <span className="receipt-price-nav-title">
            <Sparkles size={16} aria-hidden="true" />
            Kinova AI <span className="receipt-price-beta">Receipts</span>
          </span>
          <ThemeToggle className="receipt-price-theme-toggle" />
        </header>

        {query.trim().length === 0 ? (
          <section className="receipt-price-welcome" aria-labelledby="receipt-price-heading">
            <div className="receipt-price-welcome-eyebrow"><span className="receipt-price-welcome-mark" aria-hidden="true"><Sparkles size={17} strokeWidth={1.7} /></span> Your purchase memory</div>
            <h1 id="receipt-price-heading">What did you pay<br className="receipt-price-desktop-break" /> for it?</h1>
            <p>Ask about a product and Kinova will find its price in your saved receipts.</p>
            <div className="receipt-price-history-status" aria-live="polite">
              {historyQuery.isFetching && <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />}
              <span>{historyStatus}</span>
            </div>
            {historyQuery.isError && (
              <div className="receipt-price-history-error" role="status">
                <span>Using receipt items already saved on this device.</span>
                <button type="button" onClick={() => void historyQuery.refetch()}>Retry</button>
              </div>
            )}
            <div className="receipt-price-suggestions-area">
              <div className="receipt-price-suggestions-heading"><span>Try asking</span><span>Search your own receipts</span></div>
              <div className="receipt-price-suggestions" aria-label="Suggested questions">
                {(suggestions.length > 0 ? suggestions : ['Find shampoo', 'Find Sunsilk']).map((suggestion) => (
                  <button key={suggestion} type="button" onClick={() => askAboutPrice(suggestion)}>
                    <ReceiptText size={16} aria-hidden="true" />
                    <span>{suggestion}</span>
                  </button>
                ))}
              </div>
            </div>
            {searchableTransactions.length === 0 && !historyQuery.isFetching && (
              <p className="receipt-price-start-note">Scan a receipt with item details and Kinova will remember its prices.</p>
            )}
          </section>
        ) : (
          <section className="receipt-price-conversation" aria-label="Receipt price answer" aria-live="polite">
            <div className="receipt-price-user-message">{query}</div>
            <div className="receipt-price-answer-heading">
              <div className="receipt-price-answer-mark" aria-hidden="true"><Sparkles size={15} /></div>
              <span>From your receipts</span>
              {historyQuery.isFetching && <LoaderCircle size={14} className="animate-spin" aria-label="Checking older receipts" />}
            </div>
            <p className="receipt-price-answer-copy">
              {matches.length > 0
                ? `I found ${matches.length} ${matches.length === 1 ? 'match' : 'matches'} in your saved receipt items.`
                : historyQuery.isFetching
                  ? 'Checking recent items first. Older receipt history is loading in the background.'
                  : 'I couldn’t find that item in your saved receipt history.'}
            </p>
            {historyQuery.isError && matches.length === 0 && (
              <div className="receipt-price-history-error" role="status">
                <span>Older receipts could not load.</span>
                <button type="button" onClick={() => void historyQuery.refetch()}>Retry</button>
              </div>
            )}
            {matches.length === 0 ? (
              <div className="receipt-price-empty">
                {historyQuery.isFetching ? <LoaderCircle size={21} className="animate-spin" aria-hidden="true" /> : <PackageSearch size={21} aria-hidden="true" />}
                <h2>{historyQuery.isFetching ? 'Still searching' : 'No saved price yet'}</h2>
                <p>{historyQuery.isError ? 'Retry to check older receipts, or try a shorter brand or product name.' : 'Try a shorter product name or brand, such as Sunsilk, Dove or shampoo.'}</p>
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
                          <h2>{item.name}</h2>
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

        <footer className="receipt-price-composer-wrap">
          <form className="receipt-price-composer" onSubmit={handleAskSubmit}>
            <Sparkles size={19} aria-hidden="true" />
            <input
              id="receipt-price-query"
              type="search"
              value={draftQuery}
              onChange={(event) => setDraftQuery(event.target.value)}
              placeholder="Ask about a product price…"
              aria-label="Ask about a product price"
              autoComplete="off"
            />
            <button type="submit" disabled={!draftQuery.trim()} aria-label="Search saved receipt prices">
              <ArrowUp size={18} aria-hidden="true" />
            </button>
          </form>
          <p className="receipt-price-composer-note">Your receipts are searched first. Online comparisons are optional.</p>
        </footer>
      </div>
    </div>
  );
}
