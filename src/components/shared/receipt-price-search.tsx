'use client';

import Link from 'next/link';
import { useMemo, useState, useRef, useEffect, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowUp,
  Award,
  Bot,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Globe2,
  LoaderCircle,
  Mic,
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
import {
  scoreReceiptItemQuery,
  extractCleanItemKeyword,
  stripReceiptItemsFromNotes,
  type StoredReceiptItem,
} from '@/lib/receipt-items';
import { TransactionDetailModal } from '@/components/shared/transaction-detail-modal';
import {
  computeSpendingAnalytics,
  isSpendingAnalyticsQuery,
  type SpendingAnalyticsResult,
} from '@/lib/spending-analytics';
import {
  computeDeterministicLedgerFacts,
  type DeterministicLedgerFacts,
} from '@/lib/copilot-ledger-facts';
import { getUserMoneyProfile } from '@/lib/user-money-profile';
import { getLocalDateString } from '@/lib/date-helper';
import { runKinovaTurn } from '@/lib/kinova-assistant';

interface ReceiptPriceSearchProps {
  returnTo?: string;
  onClose?: () => void;
  isOpen?: boolean;
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

interface CopilotResult {
  status: 'idle' | 'loading' | 'ready' | 'error';
  headline?: string;
  answer?: string;
  type?: 'price_ladder' | 'analytics' | 'market_benchmark' | 'conversational';
  timeframe?: string;
  matchedCount?: number;
  exactTotalSpent?: number;
  isFoundInPersonalLedger?: boolean;
  matchingTransactionIds?: string[];
  priceLadder?: Array<{
    store: string;
    unitPrice: number;
    unit: string;
    date: string;
    isLowest: boolean;
  }>;
  savingsSummary?: {
    totalSaved: number;
    details: string;
  } | null;
  actionTip?: string | null;
  message?: string;
  deterministicFacts?: DeterministicLedgerFacts;
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

function formatAiErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) {
    if (
      err.name === 'AbortError' ||
      err.name === 'TimeoutError' ||
      /abort|aborted|timeout|timed out|cancelled/i.test(err.message) ||
      /abort|timeout/i.test(err.name)
    ) {
      return 'AI 联网搜索耗时较长（已超过等待时限），可能是网络波动或 Google 服务响应延迟，请点击重试。';
    }
    return err.message;
  }
  return fallback;
}

function renderMarkdownInline(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={i} className="font-bold text-white">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return part;
  });
}

export function ReceiptPriceSearch({ returnTo = '/', onClose, isOpen }: ReceiptPriceSearchProps) {
  const [draftQuery, setDraftQuery] = useState('');
  const [query, setQuery] = useState('');
  const [activeIntent, setActiveIntent] = useState<'none' | 'price' | 'analytics' | 'stock' | 'copilot'>('none');

  const displayItemName = useMemo(() => {
    return extractCleanItemKeyword(query) || query;
  }, [query]);

  // Analytics state
  const [analyticsResult, setAnalyticsResult] = useState<SpendingAnalyticsResult<Transaction> | null>(null);
  const [showAllAnalyticsTx, setShowAllAnalyticsTx] = useState(false);

  // Stock insight state
  const [stockInsight, setStockInsight] = useState<StockInsightState>({ status: 'idle' });

  // Kinova Copilot state
  const [copilotState, setCopilotState] = useState<CopilotResult>({ status: 'idle' });
  const [showCopilotMatchingTxs, setShowCopilotMatchingTxs] = useState(false);

  // Voice speech-to-text state
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<any>(null);

  // Online item price search states
  const [onlineResults, setOnlineResults] = useState<Record<string, OnlineResult>>({});
  const [loadingKey, setLoadingKey] = useState('');
  const [generalOnlineResult, setGeneralOnlineResult] = useState<OnlineResult | null>(null);
  const [isGeneralLoading, setIsGeneralLoading] = useState(false);

  // Modal inspection
  const [selectedTx, setSelectedTx] = useState<Transaction | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const bottomTouchStartRef = useRef<number | null>(null);

  const queryClient = useQueryClient();
  const { transactions = [], refetch: refetchTransactions } = useTransactions();
  const cacheScope = getActiveUserCacheScope();

  // Scoped under dedicated queryKey so general sheet cache invalidation does not clobber array shape
  const historyQuery = useQuery({
    queryKey: ['receipt-price-history', cacheScope],
    queryFn: async () => {
      const result = await getUnifiedSheetData('Transactions', 'all');
      return (result.rows || []).map((row) => normalizeTransaction(row));
    },
    staleTime: 30 * 1000,
    retry: 1,
  });

  // Automatically refresh latest ledger entries as soon as the user pulls down Kinova AI
  useEffect(() => {
    if (isOpen) {
      void historyQuery.refetch();
      void refetchTransactions();
      void queryClient.invalidateQueries({ queryKey: ['sheet'] });
    }
  }, [isOpen, historyQuery, refetchTransactions, queryClient]);

  const historyList = useMemo<Transaction[]>(() => {
    if (Array.isArray(historyQuery.data)) {
      return historyQuery.data;
    }
    if (
      historyQuery.data &&
      typeof historyQuery.data === 'object' &&
      Array.isArray((historyQuery.data as any).rows)
    ) {
      return (historyQuery.data as any).rows.map((row: any) => normalizeTransaction(row));
    }
    return [];
  }, [historyQuery.data]);

  const activeTransactions = useMemo<Transaction[]>(() => {
    return Array.isArray(transactions) ? transactions : [];
  }, [transactions]);

  const allTransactions = useMemo(() => {
    // Put current active transactions first so optimistic mutations win over older cached history
    const combined = [...activeTransactions, ...historyList];
    const seen = new Set<string>();
    return combined.filter((t) => {
      if (!t || !t.id || seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });
  }, [activeTransactions, historyList]);

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
        const cleanNotes = stripReceiptItemsFromNotes(transaction.notes || '').trim();
        const desc = (transaction.description || cleanNotes || transaction.category || '').trim();
        if (desc) {
          const brandParts = [
            transaction.category && transaction.category !== desc ? transaction.category : '',
            cleanNotes && cleanNotes !== desc ? cleanNotes : '',
          ].filter(Boolean);

          entries.push({
            transaction,
            item: {
              name: desc,
              quantity: 1,
              unitPrice: transaction.amount,
              amount: transaction.amount,
              brand: brandParts.length > 0 ? brandParts.join(' ') : undefined,
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

  // Visual Price Ladder across stores/merchants
  const storePriceLadder = useMemo(() => {
    if (activeIntent !== 'price' || matches.length < 2) return [];
    const storeMap = new Map<string, { store: string; minUnitPrice: number; latestDate: string; count: number; currency: string }>();
    for (const m of matches) {
      const store = (m.transaction.description || m.transaction.category || 'Store').trim();
      const existing = storeMap.get(store);
      const curr = m.transaction.currency || 'MYR';
      if (!existing) {
        storeMap.set(store, { store, minUnitPrice: m.item.unitPrice, latestDate: m.transaction.date, count: 1, currency: curr });
      } else {
        if (m.item.unitPrice < existing.minUnitPrice) {
          existing.minUnitPrice = m.item.unitPrice;
        }
        if (m.transaction.date > existing.latestDate) {
          existing.latestDate = m.transaction.date;
        }
        existing.count += 1;
      }
    }
    return Array.from(storeMap.values()).sort((a, b) => a.minUnitPrice - b.minUnitPrice);
  }, [activeIntent, matches]);

  // Dynamic quick suggestions from user's actual top merchants, categories, and goals
  const suggestions = useMemo(() => {
    const list: Array<{ text: string; type: string; icon: string }> = [];
    const profile = getUserMoneyProfile(allTransactions);

    if (profile.goals && profile.goals.length > 0) {
      const topGoal = profile.goals[0];
      list.push({
        text: `距离「${topGoal.name}」目标还差多少？`,
        type: 'copilot',
        icon: '🎯',
      });
    }

    const merchantCounts = new Map<string, number>();
    const categoryCounts = new Map<string, number>();
    for (const t of allTransactions) {
      if (t.type?.toLowerCase() === 'expense' && t.amount > 0) {
        if (t.description && t.description.length >= 2) {
          merchantCounts.set(t.description, (merchantCounts.get(t.description) || 0) + 1);
        }
        if (t.category) {
          categoryCounts.set(t.category, (categoryCounts.get(t.category) || 0) + 1);
        }
      }
    }

    const topMerchants = Array.from(merchantCounts.entries()).sort((a, b) => b[1] - a[1]);
    const topCategories = Array.from(categoryCounts.entries()).sort((a, b) => b[1] - a[1]);

    if (topMerchants.length > 0) {
      list.push({
        text: `我在 ${topMerchants[0][0]} 一共消费了多少？`,
        type: 'copilot',
        icon: '🏪',
      });
    }

    if (topCategories.length > 0) {
      list.push({
        text: `这个月在 ${topCategories[0][0]} 花了多少？`,
        type: 'analytics',
        icon: '📊',
      });
    }

    const hasTransport = topCategories.some(([c]) => c.toLowerCase().includes('transport'));
    if (hasTransport) {
      list.push({
        text: '今年我在哪里打汽油最便宜？',
        type: 'copilot',
        icon: '⛽',
      });
    } else {
      list.push({
        text: '查上个月整体支出总额',
        type: 'analytics',
        icon: '💳',
      });
    }

    list.push({ text: '我这个月预算还剩多少？', type: 'analytics', icon: '💰' });
    list.push({ text: '最近有什么大额开支？', type: 'analytics', icon: '📊' });

    return list.slice(0, 8);
  }, [allTransactions]);

  const copilotMatchingTransactions = useMemo(() => {
    const ids = copilotState.matchingTransactionIds || copilotState.deterministicFacts?.matchingTransactionIds;
    if (!ids || ids.length === 0) return [];
    const idSet = new Set(ids);
    return allTransactions.filter((t) => idSet.has(t.id));
  }, [allTransactions, copilotState.matchingTransactionIds, copilotState.deterministicFacts]);

  // Use the same thinking assistant as the home command bar for open-ended questions.
  const fetchCopilot = async (userQuery: string) => {
    setCopilotState({ status: 'loading' });
    setShowCopilotMatchingTxs(false);
    try {
      const deterministicFacts = computeDeterministicLedgerFacts(userQuery, allTransactions);
      const turn = await runKinovaTurn({
        text: userQuery,
        today: getLocalDateString(),
        profile: getUserMoneyProfile(allTransactions),
        transactions: allTransactions,
        forceAssistant: true,
        factQuery: userQuery,
        signal: AbortSignal.timeout(35_000),
      });
      if (turn.source !== 'assistant') {
        throw new Error('Kinova Assistant 暂时无法回答，请重试');
      }
      const result = turn.assistantResult;
      setCopilotState({
        status: 'ready',
        headline: 'Kinova Assistant',
        answer: [result.answer, result.reasoning].map((part) => part.trim()).filter(Boolean).join('\n'),
        type: 'conversational',
        timeframe: deterministicFacts.timeframeLabel,
        matchedCount: deterministicFacts.transactionCount,
        exactTotalSpent: deterministicFacts.exactTotalSpent,
        isFoundInPersonalLedger: deterministicFacts.isFoundInPersonalLedger,
        matchingTransactionIds: deterministicFacts.matchingTransactionIds,
        priceLadder: deterministicFacts.priceLadder,
        actionTip: result.proposedAction?.label || null,
        deterministicFacts,
      });
    } catch (err) {
      setCopilotState({
        status: 'error',
        message: formatAiErrorMessage(err, 'AI 思考超时，请稍后重试'),
      });
    }
  };

  // Toggle voice speech-to-text dictation
  const toggleListening = () => {
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }
    const SpeechRecognition =
      typeof window !== 'undefined'
        ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
        : null;
    if (!SpeechRecognition) {
      alert('Your browser does not support Web Speech recognition.');
      return;
    }
    try {
      const recognition = new SpeechRecognition();
      recognition.lang = typeof navigator !== 'undefined' && navigator.language?.includes('zh') ? 'zh-CN' : 'en-US';
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.onstart = () => setIsListening(true);
      recognition.onend = () => setIsListening(false);
      recognition.onerror = () => setIsListening(false);
      recognition.onresult = (event: any) => {
        const text = event.results?.[0]?.[0]?.transcript;
        if (text) {
          setDraftQuery(text);
          submitInquiry(text);
        }
      };
      recognitionRef.current = recognition;
      recognition.start();
    } catch {
      setIsListening(false);
    }
  };

  // Fetch stock advisory from AI
  const fetchStockAdvisory = async (stockQuery: string) => {
    setStockInsight({ status: 'loading' });
    try {
      const res = await fetch('/api/ai/stock-insights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: stockQuery }),
        signal: AbortSignal.timeout(45_000),
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
        message: formatAiErrorMessage(err, '获取行情与分析超时，请重试'),
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

    // 3. Check Conversational / Complex Inquiries
    const isConversational =
      /(吃了什么|买过什么|吃什么|最便宜|最贵|省了多少|补贴|对比|哪家|哪间|比较|值得|分析|为什么|怎么样|how much did i|where was|cheapest|more on|compare)/i.test(clean);

    if (isConversational) {
      setActiveIntent('copilot');
      setAnalyticsResult(null);
      void fetchCopilot(clean);
      return;
    }

    // 4. Fallback: Receipt Item Price Recall
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
    setCopilotState({ status: 'idle' });
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
        signal: AbortSignal.timeout(45_000),
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
        message: formatAiErrorMessage(error, '全网比价服务暂时不可用，请稍后重试。'),
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
        signal: AbortSignal.timeout(45_000),
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
          message: formatAiErrorMessage(error, '全网比价服务暂时不可用，请稍后重试。'),
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
                      正在综合实时行情与大模型，为您整理极简通俗建议...
                    </span>
                  </div>
                )}

                {/* Ready Analysis Content */}
                {stockInsight.status === 'ready' && stockInsight.summary && (
                  <div className="flex flex-col gap-3">
                    <div className="text-xs sm:text-sm text-white/90 leading-relaxed space-y-2.5 font-sans">
                      {stockInsight.summary.split('\n\n').map((paragraph, pIdx) => {
                        const trimmed = paragraph.trim();
                        if (!trimmed) return null;

                        const isMainConclusion = trimmed.startsWith('🎯') || trimmed.includes('核心态度') || trimmed.includes('核心结论');
                        const isActionTip = trimmed.startsWith('🛠️') || trimmed.includes('小白实操') || trimmed.includes('实操建议');
                        const isDisclaimer = trimmed.startsWith('⚠️') || trimmed.includes('免责声明') || trimmed.includes('投资有风险');

                        if (isMainConclusion) {
                          return (
                            <div
                              key={pIdx}
                              className="rounded-2xl bg-emerald-500/15 border border-emerald-400/30 p-3.5 text-emerald-100 font-medium text-xs sm:text-sm leading-relaxed shadow-sm"
                            >
                              {trimmed.split('\n').map((line, lIdx) => (
                                <p key={lIdx} className={lIdx > 0 ? 'mt-1' : ''}>
                                  {renderMarkdownInline(line)}
                                </p>
                              ))}
                            </div>
                          );
                        }

                        if (isActionTip) {
                          return (
                            <div
                              key={pIdx}
                              className="rounded-2xl bg-indigo-500/15 border border-indigo-400/30 p-3.5 text-indigo-100 font-medium text-xs sm:text-sm leading-relaxed shadow-sm"
                            >
                              {trimmed.split('\n').map((line, lIdx) => (
                                <p key={lIdx} className={lIdx > 0 ? 'mt-1' : ''}>
                                  {renderMarkdownInline(line)}
                                </p>
                              ))}
                            </div>
                          );
                        }

                        if (isDisclaimer) {
                          return (
                            <p key={pIdx} className="text-[11px] text-white/40 italic pt-1">
                              {renderMarkdownInline(trimmed)}
                            </p>
                          );
                        }

                        return (
                          <div key={pIdx} className="space-y-1.5 p-3 rounded-2xl bg-white/[0.04] border border-white/10">
                            {trimmed.split('\n').map((line, lIdx) => (
                              <p
                                key={lIdx}
                                className={
                                  line.startsWith('•') || line.startsWith('-') || line.startsWith('*')
                                    ? 'pl-2 text-white/90 text-xs sm:text-sm'
                                    : 'font-semibold text-white text-xs sm:text-sm'
                                }
                              >
                                {renderMarkdownInline(line)}
                              </p>
                            ))}
                          </div>
                        );
                      })}
                    </div>

                    {/* Sources */}
                    {stockInsight.sources && stockInsight.sources.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 pt-2 border-t border-white/10">
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
                  </div>
                )}

                {/* Error State with Quick Retry */}
                {stockInsight.status === 'error' && (
                  <div className="p-4 rounded-2xl bg-rose-500/15 border border-rose-400/25 flex flex-col gap-2.5 text-xs text-rose-200">
                    <p>{stockInsight.message}</p>
                    <button
                      type="button"
                      onClick={() => void fetchStockAdvisory(query)}
                      className="self-start px-3 py-1.5 rounded-lg bg-rose-500/25 hover:bg-rose-500/40 text-rose-100 font-medium text-xs transition-colors cursor-pointer"
                    >
                      🔄 点击重新查询
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Kinova Assistant conversational reasoning */}
            {activeIntent === 'copilot' && (
              <div className="rounded-3xl bg-white/[0.07] border border-white/15 backdrop-blur-2xl p-5 sm:p-6 shadow-2xl flex flex-col gap-5">
                {/* Assistant Header */}
                <div className="flex items-center justify-between gap-3 border-b border-white/10 pb-4">
                  <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-indigo-500 to-violet-500 border border-indigo-400/30 flex items-center justify-center text-white shadow-md">
                      <Sparkles size={18} />
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-indigo-300">Kinova Assistant · 个性化财务助手</div>
                      <div className="text-sm font-bold text-white tracking-tight">
                        {copilotState.headline || '深度财务与小票推理'}
                      </div>
                    </div>
                  </div>
                  <span className="px-2.5 py-1 rounded-full bg-indigo-500/20 text-indigo-200 border border-indigo-400/30 text-[10px] font-bold uppercase tracking-wider">
                    Kinova AI
                  </span>
                </div>

                {/* Loading */}
                {copilotState.status === 'loading' && (
                  <div className="flex flex-col items-center justify-center py-10 gap-3">
                    <LoaderCircle size={28} className="animate-spin text-indigo-400" />
                    <span className="text-xs text-white/70 font-medium animate-pulse">
                      Kinova 正在结合你的账本和个人设置思考...
                    </span>
                  </div>
                )}

                {/* Ready Content */}
                {copilotState.status === 'ready' && (
                  <div className="flex flex-col gap-4">
                    {/* Statistical Timeframe & Deterministic Badges */}
                    <div className="flex flex-wrap items-center gap-2">
                      {(copilotState.timeframe || copilotState.deterministicFacts?.timeframeLabel) && (
                        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-xl bg-white/[0.06] border border-white/10 text-xs text-white/90 font-medium">
                          <span>📅</span>
                          <span>统计期间: {copilotState.timeframe || copilotState.deterministicFacts?.timeframeLabel}</span>
                        </span>
                      )}
                      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-xl bg-white/[0.06] border border-white/10 text-xs text-white/90 font-medium">
                        <span>📊</span>
                        <span>匹配记录: {copilotState.matchedCount ?? copilotState.deterministicFacts?.transactionCount ?? 0} 笔</span>
                      </span>
                      {(copilotState.exactTotalSpent != null && copilotState.exactTotalSpent > 0) && (
                        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-xl bg-emerald-500/20 border border-emerald-400/30 text-xs text-emerald-200 font-mono font-bold">
                          <span>💰</span>
                          <span>账本确切总计: {formatPrice('MYR', copilotState.exactTotalSpent)}</span>
                        </span>
                      )}
                    </div>

                    {/* Personal Ledger Absence Distinction */}
                    {copilotState.isFoundInPersonalLedger === false && (
                      <div className="flex items-start gap-3 p-3.5 rounded-2xl bg-amber-500/15 border border-amber-400/30 text-amber-200 text-xs">
                        <span className="text-lg">ℹ️</span>
                        <div>
                          <div className="font-bold text-amber-300">个人账本暂无此消费记录</div>
                          <div className="text-[11px] text-amber-200/90 mt-0.5">
                            你的个人账本中暂无匹配记录。记录相关开支后，Kinova 即可基于你的真实账目提供个性化分析与对比。
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Answer text */}
                    {copilotState.answer && (
                      <div className="text-xs sm:text-sm text-white/90 leading-relaxed space-y-2 p-4 rounded-2xl bg-white/[0.04] border border-white/10 font-sans">
                        {copilotState.answer.split('\n').map((line, idx) => (
                          <p key={idx}>{renderMarkdownInline(line)}</p>
                        ))}
                      </div>
                    )}

                    {/* Savings Summary Banner */}
                    {copilotState.savingsSummary && (
                      <div className="flex items-start gap-3 p-3.5 rounded-2xl bg-emerald-500/15 border border-emerald-400/30 text-emerald-100 text-xs">
                        <span className="text-lg">🎉</span>
                        <div>
                          <div className="font-bold text-emerald-300">
                            节省总额: {formatPrice('MYR', copilotState.savingsSummary.totalSaved)}
                          </div>
                          <div className="text-[11px] text-emerald-200/90 mt-0.5">
                            {copilotState.savingsSummary.details}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Personal ledger price ladder */}
                    {Array.isArray(copilotState.priceLadder) && copilotState.priceLadder.length > 0 && (
                      <div className="p-4 rounded-2xl bg-white/[0.04] border border-white/10 flex flex-col gap-2.5">
                        <div className="text-xs font-bold text-white flex items-center gap-1.5">
                          <Award size={14} className="text-amber-400" />
                          <span>商家单价对比排行榜</span>
                        </div>
                        {copilotState.priceLadder.map((item, idx) => (
                          <div key={idx} className="flex items-center justify-between p-2 rounded-xl bg-white/[0.03] text-xs">
                            <div className="flex items-center gap-2">
                              <span className={`w-5 h-5 rounded-full flex items-center justify-center font-bold text-[10px] ${
                                item.isLowest ? 'bg-amber-400 text-slate-950' : 'bg-white/10 text-white/70'
                              }`}>
                                {idx + 1}
                              </span>
                              <span className="font-semibold text-white">{item.store}</span>
                              {item.date && <span className="text-[10px] text-white/40">({item.date})</span>}
                            </div>
                            <div className="text-right">
                              <span className="font-mono font-bold text-emerald-400">
                                {formatPrice('MYR', item.unitPrice)}{item.unit || ''}
                              </span>
                              {item.isLowest && <span className="block text-[10px] text-amber-300 font-bold">🏆 最划算</span>}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Expandable Matching Transactions Section */}
                    {copilotMatchingTransactions.length > 0 && (
                      <div className="rounded-2xl bg-white/[0.03] border border-white/10 overflow-hidden">
                        <button
                          type="button"
                          onClick={() => setShowCopilotMatchingTxs((v) => !v)}
                          className="w-full flex items-center justify-between p-3.5 text-xs font-semibold text-white/90 hover:bg-white/[0.06] transition-colors cursor-pointer"
                        >
                          <div className="flex items-center gap-2">
                            <ReceiptText size={14} className="text-indigo-400" />
                            <span>查看相关账目记录 ({copilotMatchingTransactions.length} 笔)</span>
                          </div>
                          <ChevronDown size={14} className={`text-white/60 transition-transform ${showCopilotMatchingTxs ? 'rotate-180' : ''}`} />
                        </button>
                        {showCopilotMatchingTxs && (
                          <div className="p-2 space-y-1.5 border-t border-white/5 max-h-64 overflow-y-auto">
                            {copilotMatchingTransactions.map((tx) => (
                              <button
                                key={tx.id}
                                type="button"
                                onClick={() => setSelectedTx(tx)}
                                className="w-full flex items-center justify-between p-2.5 rounded-xl bg-white/[0.02] hover:bg-white/[0.06] text-xs transition-colors text-left cursor-pointer"
                              >
                                <div className="flex flex-col pr-2 min-w-0">
                                  <span className="font-medium text-white/95 truncate">
                                    {tx.description || tx.category}
                                  </span>
                                  <span className="text-[10px] text-white/40">
                                    {tx.date} · {tx.category}
                                    {tx.account ? ` · ${tx.account}` : ''}
                                  </span>
                                </div>
                                <span className="font-mono font-bold text-white shrink-0">
                                  {formatPrice(tx.currency, tx.amount)}
                                </span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Action Tip */}
                    {copilotState.actionTip && (
                      <div className="p-3.5 rounded-2xl bg-indigo-500/15 border border-indigo-400/30 text-indigo-100 text-xs flex items-center gap-2.5">
                        <span className="text-base">💡</span>
                        <span>{copilotState.actionTip}</span>
                      </div>
                    )}
                  </div>
                )}

                {/* Error */}
                {copilotState.status === 'error' && (
                  <div className="p-4 rounded-2xl bg-rose-500/15 border border-rose-400/25 text-xs text-rose-200">
                    <p>{copilotState.message}</p>
                    <button
                      type="button"
                      onClick={() => void fetchCopilot(query)}
                      className="mt-2 px-3 py-1.5 rounded-lg bg-rose-500/25 hover:bg-rose-500/40 text-rose-100 font-medium text-xs transition-colors cursor-pointer"
                    >
                      🔄 点击重新查询
                    </button>
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

                {/* Visual Store Price Ladder (when 2+ stores match) */}
                {storePriceLadder.length >= 2 && (
                  <div className="rounded-2xl bg-white/[0.06] border border-white/15 p-4 sm:p-5 flex flex-col gap-3 shadow-xl backdrop-blur-xl">
                    <div className="flex items-center justify-between border-b border-white/10 pb-2.5">
                      <div className="flex items-center gap-2">
                        <Award size={16} className="text-amber-400" />
                        <span className="text-xs font-bold text-white uppercase tracking-wider">
                          🏪 商家单价排行榜 (Store Price Ladder)
                        </span>
                      </div>
                      <span className="text-[10px] text-white/50">按最低单价排序</span>
                    </div>

                    <div className="flex flex-col gap-2">
                      {storePriceLadder.map((ladderItem, ladderIdx) => {
                        const isLowest = ladderIdx === 0;
                        const priceDiff = ladderItem.minUnitPrice - storePriceLadder[0].minUnitPrice;
                        return (
                          <div
                            key={ladderItem.store}
                            className={`flex items-center justify-between p-3 rounded-xl border text-xs transition-all ${
                              isLowest
                                ? 'bg-amber-400/10 border-amber-400/30 text-white'
                                : 'bg-white/[0.04] border-white/5 text-white/90'
                            }`}
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              <span
                                className={`w-6 h-6 rounded-full flex items-center justify-center font-bold text-xs shrink-0 ${
                                  isLowest
                                    ? 'bg-amber-400 text-slate-950 shadow-md font-mono'
                                    : 'bg-white/10 text-white/70 font-mono'
                                }`}
                              >
                                {ladderIdx + 1}
                              </span>
                              <div className="truncate min-w-0">
                                <span className="font-bold text-white block truncate text-xs sm:text-sm">
                                  {ladderItem.store}
                                </span>
                                <span className="text-[10px] text-white/50 block mt-0.5">
                                  共消费 {ladderItem.count} 笔 · 最近购买于 {ladderItem.latestDate}
                                </span>
                              </div>
                            </div>

                            <div className="text-right shrink-0">
                              <div className="font-mono font-black text-sm sm:text-base text-emerald-400">
                                {formatPrice(ladderItem.currency, ladderItem.minUnitPrice)}
                              </div>
                              {isLowest ? (
                                <span className="inline-block text-[10px] font-bold text-amber-300">
                                  🏆 历史最优单价
                                </span>
                              ) : priceDiff > 0 ? (
                                <span className="inline-block text-[10px] text-rose-300/80 font-mono">
                                  +{formatPrice(ladderItem.currency, priceDiff)}
                                </span>
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* No Matches Found in Ledger -> Prompt 1-Click Online Price Grounding or Assistant */}
                {matches.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-8 px-4 rounded-3xl bg-white/[0.04] border border-white/10 text-center">
                    <PackageSearch size={32} className="text-white/40 mb-3" />
                    <div className="text-base font-bold text-white mb-1">
                      你的个人账本中暂无「{displayItemName}」的记录
                    </div>
                    <p className="text-xs text-white/60 max-w-sm mb-5 leading-relaxed">
                      历史账单和小票中未查到此商品。你可以使用 Google 搜索查询当前公开发售参考价，或让 Kinova Assistant 结合你的账本继续分析。
                    </p>

                    <div className="flex flex-wrap items-center justify-center gap-2.5">
                      <button
                        type="button"
                        onClick={() => void searchMarketPriceOnline(displayItemName)}
                        disabled={isGeneralLoading}
                        className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-400 hover:to-violet-500 active:scale-95 text-white font-semibold text-xs flex items-center gap-2 shadow-lg cursor-pointer transition-all disabled:opacity-50"
                      >
                        {isGeneralLoading ? (
                          <LoaderCircle size={15} className="animate-spin" />
                        ) : (
                          <Globe2 size={15} />
                        )}
                        <span>🌐 全网参考价格</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setActiveIntent('copilot');
                          void fetchCopilot(query);
                        }}
                        className="px-4 py-2.5 rounded-xl bg-white/10 hover:bg-white/15 active:scale-95 text-indigo-300 font-semibold text-xs flex items-center gap-2 border border-white/15 cursor-pointer transition-all"
                      >
                        <Sparkles size={15} />
                        <span>✨ Ask Kinova Assistant</span>
                      </button>
                    </div>
                  </div>
                )}

                {/* General Online Search Result */}
                {generalOnlineResult?.status === 'ready' && (
                  <div className="rounded-2xl bg-emerald-500/10 border border-emerald-400/30 p-4 sm:p-5 flex flex-col gap-2.5 shadow-xl">
                    <div className="flex items-center gap-2 text-xs font-bold text-emerald-300">
                      <Globe2 size={15} />
                      <span>当前市场公开发售参考价格 (Google Search Grounding)</span>
                    </div>
                    <div className="text-xs sm:text-sm text-white/90 leading-relaxed space-y-1">
                      {generalOnlineResult.summary.split('\n').map((line, lIdx) => (
                        <p key={lIdx}>{renderMarkdownInline(line)}</p>
                      ))}
                    </div>
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
              type="button"
              onClick={toggleListening}
              className={`w-9 h-9 rounded-xl flex items-center justify-center transition-all cursor-pointer shrink-0 ${
                isListening
                  ? 'bg-rose-500 text-white animate-pulse shadow-lg shadow-rose-500/50'
                  : 'text-white/60 hover:text-white hover:bg-white/10'
              }`}
              title={isListening ? '停止语音识别' : '语音提问'}
              aria-label={isListening ? '停止语音识别' : '语音提问'}
            >
              <Mic size={17} />
            </button>
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
