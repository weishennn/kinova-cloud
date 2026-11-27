'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useRef, useEffect, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowUp,
  Award,
  Bot,
  CalendarDays,
  Check,
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
import { addUnifiedRow, applyOptimisticAddToQueryCache, getUnifiedSheetData } from '@/hooks/useSheets';
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
import { getUserMoneyProfile, recordRecentAction, updateUserMoneyProfile } from '@/lib/user-money-profile';
import { getLocalDateString } from '@/lib/date-helper';
import {
  runKinovaTurn,
  updateAssistantConversation,
  type AssistantApiResponse,
  type AssistantPendingContext,
  type AssistantTurnMessage,
} from '@/lib/kinova-assistant';
import {
  isQuestionOrAdviceRequest,
  isRebalanceBudgetRequest,
  requiresExtendedReasoning,
  routeLocalIntent,
} from '@/lib/intent-router';
import { parseNaturalExpense } from '@/lib/natural-expense-parser';
import { saveCategoryCaps } from '@/lib/category-budget-helper';
import { broadcastCrossTabEvent } from '@/lib/cache-manager';
import { toast } from 'sonner';

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
  reasoning?: string;
  mode?: AssistantApiResponse['mode'];
  type?: 'price_ladder' | 'analytics' | 'market_benchmark' | 'conversational';
  timeframe?: string;
  matchedCount?: number;
  exactTotalSpent?: number;
  isFoundInPersonalLedger?: boolean;
  showLedgerAbsenceNotice?: boolean;
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
  proposedAction?: AssistantApiResponse['proposedAction'];
  proposedActionApplied?: boolean;
  clarification?: AssistantApiResponse['clarification'];
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
    return new Intl.NumberFormat('en-MY', {
      style: 'currency',
      currency: normalizedCurrency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
      .format(amount)
      .replace(/ /g, '\u00A0');
  } catch {
    return `${normalizedCurrency}\u00A0${amount.toFixed(2)}`;
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
  const router = useRouter();
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

  // Kinova Copilot state (multi-turn + actionable buttons)
  const [copilotState, setCopilotState] = useState<CopilotResult>({ status: 'idle' });
  const [showCopilotMatchingTxs, setShowCopilotMatchingTxs] = useState(false);
  const [applyingAction, setApplyingAction] = useState(false);
  const [conversationHistory, setConversationHistory] = useState<Array<{ role: 'user' | 'assistant'; text: string }>>([]);
  const sessionTurnsRef = useRef<AssistantTurnMessage[]>([]);
  const pendingContextRef = useRef<AssistantPendingContext | null>(null);

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
  const wasOpenRef = useRef(false);

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

  // Automatically refresh latest ledger entries ONCE when Kinova AI transitions from closed -> open
  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      wasOpenRef.current = true;
      void historyQuery.refetch();
      void refetchTransactions();
      void queryClient.invalidateQueries({ queryKey: ['sheet'] });
    } else if (!isOpen) {
      wasOpenRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

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

  // Use the same thinking assistant + multi-turn memory as the home command bar.
  const fetchCopilot = async (userQuery: string) => {
    setCopilotState({ status: 'loading' });
    setShowCopilotMatchingTxs(false);
    try {
      const todayStr = getLocalDateString();
      const profile = getUserMoneyProfile(allTransactions);
      const deterministicFacts = computeDeterministicLedgerFacts(userQuery, allTransactions);
      const turn = await runKinovaTurn({
        text: userQuery,
        today: todayStr,
        profile,
        transactions: allTransactions,
        sessionTurns: sessionTurnsRef.current,
        pendingContext: pendingContextRef.current,
        forceAssistant: true,
        factQuery: userQuery,
        signal: AbortSignal.timeout(35_000),
      });

      if (turn.source === 'local') {
        const localRes = turn.localResult;
        if (localRes.mode === 'navigate' && localRes.path) {
          onClose?.();
          router.push(localRes.path);
          return;
        }
        const answerText = 'message' in localRes ? localRes.message : localRes.label || 'Done.';
        pendingContextRef.current = null;
        sessionTurnsRef.current = [
          ...sessionTurnsRef.current,
          { role: 'user' as const, text: userQuery },
          { role: 'assistant' as const, text: answerText },
        ].slice(-6);
        setConversationHistory((prev) => [
          ...prev.slice(-4),
          { role: 'user', text: userQuery },
          { role: 'assistant', text: answerText },
        ]);
        setCopilotState({
          status: 'ready',
          headline: 'Kinova Instant Answer',
          answer: answerText,
          type: 'conversational',
          mode: localRes.mode === 'set_preference' ? 'set_preference' : 'advise',
          timeframe: deterministicFacts.timeframeLabel,
          matchedCount: deterministicFacts.transactionCount,
          exactTotalSpent: deterministicFacts.exactTotalSpent,
          isFoundInPersonalLedger: deterministicFacts.isFoundInPersonalLedger,
          showLedgerAbsenceNotice: false,
          matchingTransactionIds: deterministicFacts.matchingTransactionIds,
          priceLadder: deterministicFacts.priceLadder,
          deterministicFacts,
        });
        return;
      }

      const result = turn.assistantResult;
      const answerParts = [result.answer, result.reasoning]
        .map((part) => part.trim())
        .filter(Boolean);
      const combinedAnswer = answerParts.join('\n');

      const conversation = updateAssistantConversation(sessionTurnsRef.current, userQuery, result);
      sessionTurnsRef.current = conversation.turns;
      pendingContextRef.current = conversation.pendingContext;
      setConversationHistory((prev) => [
        ...prev.slice(-4),
        { role: 'user', text: userQuery },
        { role: 'assistant', text: result.answer || result.clarification?.question || '' },
      ]);

      // Only show "个人账本暂无此消费记录" when user is specifically looking up an item/store price
      // and no records matched, NOT on general financial advice / budget / goal / greeting queries.
      const isSpecificItemOrStoreLookup =
        (deterministicFacts.queryType === 'item_lookup' ||
          deterministicFacts.queryType === 'merchant_lookup') &&
        !['advise', 'rebalance', 'clarify', 'unknown', 'record', 'set_preference'].includes(result.mode);

      setCopilotState({
        status: 'ready',
        headline:
          result.mode === 'rebalance'
            ? '预算与资金行动建议'
            : result.mode === 'clarify'
              ? '需要确认细节'
              : result.mode === 'record'
                ? '记账准备就绪'
                : 'Kinova Assistant',
        answer: combinedAnswer,
        mode: result.mode,
        type: 'conversational',
        timeframe: deterministicFacts.timeframeLabel,
        matchedCount: deterministicFacts.transactionCount,
        exactTotalSpent: deterministicFacts.exactTotalSpent,
        isFoundInPersonalLedger: deterministicFacts.isFoundInPersonalLedger,
        showLedgerAbsenceNotice:
          !deterministicFacts.isFoundInPersonalLedger && isSpecificItemOrStoreLookup,
        matchingTransactionIds: deterministicFacts.matchingTransactionIds,
        priceLadder: deterministicFacts.priceLadder,
        proposedAction: result.proposedAction ?? null,
        proposedActionApplied: false,
        clarification: result.clarification ?? null,
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

  // Execute interactive action suggested by Kinova AI inside the pull-down overlay
  const handleExecuteProposedAction = async (
    action: NonNullable<CopilotResult['proposedAction']>
  ) => {
    if (applyingAction || copilotState.proposedActionApplied) return;
    setApplyingAction(true);
    try {
      const payload = (action.payload || {}) as Record<string, any>;
      if (action.type === 'navigate') {
        const target =
          typeof payload.path === 'string' && payload.path.startsWith('/')
            ? payload.path
            : '/budget';
        onClose?.();
        router.push(target);
        return;
      }

      if (action.type === 'rebalance_caps') {
        const rawCaps = (payload.updatedCaps || payload.rebalancedCaps) as Record<string, number> | undefined;
        if (rawCaps && typeof rawCaps === 'object') {
          saveCategoryCaps(rawCaps);
          broadcastCrossTabEvent('CATEGORY_CAPS_UPDATED', { caps: rawCaps });
          void queryClient.invalidateQueries({ queryKey: ['sheet'] });
          void queryClient.invalidateQueries({ queryKey: ['overview'] });
          void queryClient.invalidateQueries({ queryKey: ['budget'] });
          recordRecentAction({
            actionType: 'edit',
            targetType: 'preference',
            summary: `Rebalanced category caps: ${payload.summaryText || payload.donorSummary || action.label}`,
            payload: { caps: rawCaps },
          });
          toast.success(payload.summaryText || payload.donorSummary || '已重新分配分类预算上限');
        }
      } else if (action.type === 'set_preference') {
        const key = String(payload.key || '').trim();
        const value = payload.value;
        if (key === 'paydayDay' && Number(value) >= 1 && Number(value) <= 31) {
          updateUserMoneyProfile({ paydayDay: Math.round(Number(value)) });
          broadcastCrossTabEvent('SETTINGS_UPDATED');
          toast.success(`已设置发薪日为每月 ${Math.round(Number(value))} 日`);
        } else if (key === 'monthlyBudgetCap' && Number(value) > 0) {
          updateUserMoneyProfile({ monthlyBudgetCap: Number(value) });
          broadcastCrossTabEvent('SETTINGS_UPDATED');
          toast.success(`已更新月度预算上限为 ${formatPrice('MYR', Number(value))}`);
        } else if (key === 'baselineIncome' && Number(value) > 0) {
          updateUserMoneyProfile({ baselineIncome: Number(value) });
          broadcastCrossTabEvent('SETTINGS_UPDATED');
          toast.success(`已更新月均基线收入为 ${formatPrice('MYR', Number(value))}`);
        } else if (key === 'emergencyReserve' && Number(value) >= 0) {
          updateUserMoneyProfile({ emergencyReserve: Number(value) });
          broadcastCrossTabEvent('SETTINGS_UPDATED');
          toast.success(`已更新应急储备金为 ${formatPrice('MYR', Number(value))}`);
        } else if (key === 'goal' && typeof payload.name === 'string') {
          const currentProfile = getUserMoneyProfile(allTransactions);
          const nextGoals = [...currentProfile.goals];
          const existingIdx = nextGoals.findIndex(
            (g) => g.name.toLowerCase() === String(payload.name).toLowerCase()
          );
          const targetAmt = Number(payload.targetAmount || (existingIdx >= 0 ? nextGoals[existingIdx].targetAmount : 0)) || 0;
          const currentAmt = Number(payload.currentAmount ?? payload.savedAmount ?? (existingIdx >= 0 ? nextGoals[existingIdx].currentAmount : 0)) || 0;
          if (existingIdx >= 0) {
            nextGoals[existingIdx] = {
              ...nextGoals[existingIdx],
              name: String(payload.name),
              targetAmount: targetAmt,
              currentAmount: currentAmt,
            };
          } else {
            nextGoals.push({
              id: `goal_${Date.now()}`,
              name: String(payload.name),
              targetAmount: targetAmt,
              currentAmount: currentAmt,
            });
          }
          updateUserMoneyProfile({ goals: nextGoals });
          broadcastCrossTabEvent('SETTINGS_UPDATED');
          toast.success(`已更新理财目标: ${String(payload.name)}`);
        }
      } else if (action.type === 'save_transaction') {
        const amount = Number(payload.amount || 0);
        if (amount > 0) {
          const rawType = String(payload.type || 'Expense').trim().toLowerCase();
          const normalizedType =
            rawType === 'income'
              ? 'Income'
              : rawType === 'savings' || rawType === 'saving'
                ? 'Savings'
                : rawType === 'investment' || rawType === 'invest'
                  ? 'Investment'
                  : 'Expense';
          const txDate =
            typeof payload.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(payload.date)
              ? payload.date
              : getLocalDateString();
          const monthStr = txDate.slice(0, 7);
          const newId = `tx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const currency = String(payload.currency || 'MYR').toUpperCase();
          const category = String(payload.category || 'Food & Dining');
          const description = String(payload.description || payload.category || 'Kinova AI Entry');
          const notes = String(payload.notes || '[Kinova Assistant]');
          const rowPayload: Record<string, any> = {
            Id: newId,
            id: newId,
            Date: txDate,
            date: txDate,
            Type: normalizedType.toLowerCase(),
            type: normalizedType.toLowerCase(),
            Category: category,
            category,
            SubCategory: '',
            subCategory: '',
            Description: description,
            description,
            Amount: amount,
            amount,
            Currency: currency,
            currency,
            TripTag: '',
            tripTag: '',
            ReceiptUrl: '',
            receiptUrl: '',
            Notes: notes,
            notes,
            _month: monthStr,
            _rowIndex: 2,
          };
          applyOptimisticAddToQueryCache(queryClient, monthStr, rowPayload);
          await addUnifiedRow(monthStr, {
            Id: newId,
            id: newId,
            Date: txDate,
            Type: normalizedType,
            Category: category,
            SubCategory: '',
            Description: description,
            Amount: amount,
            Currency: currency,
            TripTag: '',
            ReceiptUrl: '',
            Notes: notes,
          });
          pendingContextRef.current = null;
          recordRecentAction({
            actionType: 'record',
            targetType: 'transaction',
            summary: `Recorded ${currency} ${amount.toFixed(2)} for ${description}`,
            payload: { id: newId, amount, category, description, date: txDate, monthStr },
          });
          toast.success(`已记录: ${description} (${formatPrice(currency, amount)})`);
        }
      } else if (action.type === 'allocate_payday_envelope') {
        const transfers = Array.isArray(payload.transfers) ? (payload.transfers as Array<Record<string, any>>) : [];
        const todayStr = getLocalDateString();
        const monthStr = todayStr.slice(0, 7);
        for (const t of transfers) {
          const tempId = t.id || `tx_envelope_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          const amt = Number(t.amount) || 0;
          if (amt <= 0) continue;
          const rowData: Record<string, any> = {
            Id: tempId,
            id: tempId,
            Date: t.date || todayStr,
            date: t.date || todayStr,
            Type: 'investment',
            type: 'investment',
            Category: String(t.category || 'Emergency Savings'),
            category: String(t.category || 'Emergency Savings'),
            SubCategory: t.subCategory || 'Payday Auto-Envelope',
            subCategory: t.subCategory || 'Payday Auto-Envelope',
            Description: String(t.description || 'Payday Envelope Allocation'),
            description: String(t.description || 'Payday Envelope Allocation'),
            Amount: amt,
            amount: amt,
            Currency: String(t.currency || 'MYR'),
            currency: String(t.currency || 'MYR'),
            TripTag: '',
            tripTag: '',
            ReceiptUrl: '',
            receiptUrl: '',
            Notes: String(t.notes || '[Payday Auto-Envelope]'),
            notes: String(t.notes || '[Payday Auto-Envelope]'),
            _month: monthStr,
            _rowIndex: 2,
          };
          applyOptimisticAddToQueryCache(queryClient, monthStr, rowData);
          void addUnifiedRow(monthStr, rowData);
        }
        toast.success(action.label || '已执行发薪日资金分配');
      }

      setCopilotState((prev) =>
        prev.status === 'ready' ? { ...prev, proposedActionApplied: true } : prev
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作执行失败，请稍后重试');
    } finally {
      setApplyingAction(false);
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

    // 0. If user is answering a multi-turn clarification, stay in Kinova Copilot
    if (pendingContextRef.current) {
      setActiveIntent('copilot');
      setAnalyticsResult(null);
      void fetchCopilot(clean);
      return;
    }

    // 1. Check Stock / Investment Intent
    if (STOCK_INTENT_REGEX.test(clean)) {
      setActiveIntent('stock');
      setAnalyticsResult(null);
      void fetchStockAdvisory(clean);
      return;
    }

    // 2. Check Pure Spending Analytics Intent (excludes budget/advice/goal/complex queries)
    if (isSpendingAnalyticsQuery(clean)) {
      setActiveIntent('analytics');
      const result = computeSpendingAnalytics(clean, allTransactions);
      setAnalyticsResult(result);
      return;
    }

    // 3. Check Deterministic Local Intents (budget cap queries, paydays, rebalance, navigation, settings, natural expense)
    const todayStr = getLocalDateString();
    const localRoute = routeLocalIntent(clean, getUserMoneyProfile(allTransactions), todayStr);
    const parsedNaturalExpense = parseNaturalExpense(clean);

    // 4. Route natural questions, advice, rebalance, greetings, budget/goals, or action commands to Kinova Copilot
    const hasPriceItemIntent =
      /(\bprice\b|多少钱|单价|卖多少|哪里买|哪家买|买过|收据|小票|receipt)/i.test(clean);
    const isShortProductLookup =
      !isQuestionOrAdviceRequest(clean) &&
      !requiresExtendedReasoning(clean) &&
      !isRebalanceBudgetRequest(clean) &&
      !localRoute &&
      !parsedNaturalExpense &&
      clean.length <= 36 &&
      !/[?？]/.test(clean) &&
      !/^(hi|hello|hey|你好|嗨|哈喽|早|晚安)/i.test(clean);

    const isConversational =
      Boolean(localRoute) ||
      Boolean(parsedNaturalExpense) ||
      isQuestionOrAdviceRequest(clean) ||
      requiresExtendedReasoning(clean) ||
      isRebalanceBudgetRequest(clean) ||
      /(吃了什么|买过什么|吃什么|最便宜|最贵|省了多少|补贴|对比|哪家|哪间|比较|值得|分析|为什么|怎么样|预算|目标|储蓄|存款|现金流|大额|建议|总结|多少|怎么|可以买|能买|how much|where was|cheapest|most expensive|compare|budget|goal|save|afford|summary|advice|recommend)/i.test(clean);

    if ((isConversational || !isShortProductLookup) && !(hasPriceItemIntent && isShortProductLookup)) {
      setActiveIntent('copilot');
      setAnalyticsResult(null);
      void fetchCopilot(clean);
      return;
    }

    // 5. Fallback: Instant Receipt Item Price Recall
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
    setConversationHistory([]);
    sessionTurnsRef.current = [];
    pendingContextRef.current = null;
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
    <div className="fixed inset-0 z-30 flex flex-col justify-between text-[#F5F4EF] overflow-hidden bg-gradient-to-b from-[#0C1210] via-[#090D0C] to-[#060807]">
      {/* Atelier Emerald & Warm Gold Ambient Glow */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-[400px] bg-[radial-gradient(ellipse_80%_60%_at_50%_-10%,rgba(45,212,160,0.22),transparent_70%)]"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[300px] bg-[radial-gradient(circle_at_50%_100%,rgba(229,184,92,0.12),transparent_60%)]"
        aria-hidden="true"
      />

      {/* Top Header */}
      <header className="relative z-10 shrink-0 h-14 sm:h-16 flex items-center justify-between px-4 sm:px-6 pt-safe border-b border-white/10 bg-[#0C1210]/85 backdrop-blur-xl">
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
        <div className="flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-white/[0.06] border border-white/12 backdrop-blur-md shadow-inner">
          <Sparkles size={14} className="text-emerald-400" />
          <span className="font-semibold text-sm tracking-tight text-white">Kinova AI</span>
          <span className="px-1.5 py-0.5 rounded-md bg-emerald-500/20 text-emerald-300 font-mono text-[10px] uppercase font-bold tracking-wider">
            Atelier
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
            <div className="w-16 h-16 rounded-2xl bg-[#11221D] border border-emerald-400/30 backdrop-blur-xl flex items-center justify-center text-emerald-300 shadow-[0_0_32px_rgba(45,212,160,0.22)] mb-5">
              <Sparkles size={28} strokeWidth={1.8} />
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
            <div className="self-end max-w-[85%] rounded-2xl rounded-br-sm bg-gradient-to-r from-[#0D6E52] to-[#118C68] text-white px-4 py-2.5 text-sm font-medium shadow-lg border border-emerald-400/25">
              {query}
            </div>

            {/* 1. Spending Analytics Result Card */}
            {activeIntent === 'analytics' && analyticsResult && (
              <div className="rounded-3xl bg-white/[0.05] border border-white/12 backdrop-blur-2xl p-5 sm:p-6 shadow-2xl flex flex-col gap-5">
                {/* Header */}
                <div className="flex items-center justify-between gap-3 border-b border-white/10 pb-4">
                  <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-xl bg-emerald-500/20 border border-emerald-400/30 flex items-center justify-center text-emerald-300">
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
                <div className="p-3.5 rounded-2xl bg-emerald-500/12 border border-emerald-400/25 text-xs sm:text-sm text-emerald-100 leading-relaxed">
                  {analyticsResult.conversationalSummary}
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
                          className="text-[11px] text-emerald-300 hover:text-white flex items-center gap-1 cursor-pointer"
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
                            <div className="text-[10px] text-emerald-300 flex items-center gap-0.5 justify-end mt-0.5">
                              <ReceiptText size={10} />
                              <span>详情</span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="pt-2 border-t border-white/10 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[11px] text-white/50">想要结合预算目标深度分析这笔开支？</span>
                  <button
                    type="button"
                    onClick={() => {
                      setActiveIntent('copilot');
                      void fetchCopilot(query);
                    }}
                    className="px-3.5 py-2 rounded-xl bg-emerald-500/25 hover:bg-emerald-500/40 border border-emerald-400/35 text-xs font-semibold text-emerald-100 inline-flex items-center gap-1.5 cursor-pointer transition-all"
                  >
                    <Sparkles size={13} />
                    <span>让 Kinova AI 给建议</span>
                  </button>
                </div>
              </div>
            )}

            {/* 2. Stock / Investment Advisory Card */}
            {activeIntent === 'stock' && (
              <div className="rounded-3xl bg-white/[0.05] border border-white/12 backdrop-blur-2xl p-5 sm:p-6 shadow-2xl flex flex-col gap-4">
                {/* Header */}
                <div className="flex items-center justify-between border-b border-white/10 pb-3">
                  <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-xl bg-amber-500/20 border border-amber-400/30 flex items-center justify-center text-amber-300">
                      <TrendingUp size={18} />
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-white/60">Kinova 市场研究与投资洞察</div>
                      <div className="text-sm font-bold text-white tracking-tight">AI 智能投顾分析</div>
                    </div>
                  </div>

                  <span className="px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-400/30 text-[10px] font-bold uppercase tracking-wider">
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
                    <LoaderCircle size={28} className="animate-spin text-emerald-400" />
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
                              className="rounded-2xl bg-amber-500/12 border border-amber-400/30 p-3.5 text-amber-100 font-medium text-xs sm:text-sm leading-relaxed shadow-sm"
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
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/20 border border-white/15 text-emerald-200 text-[11px] font-medium transition-colors"
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
              <div className="rounded-3xl bg-white/[0.05] border border-white/12 backdrop-blur-2xl p-5 sm:p-6 shadow-2xl flex flex-col gap-5">
                {/* Assistant Header */}
                <div className="flex items-center justify-between gap-3 border-b border-white/10 pb-4">
                  <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-[#0D6E52] to-[#2DD4A0] border border-emerald-400/30 flex items-center justify-center text-white shadow-md">
                      <Sparkles size={18} />
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-emerald-300">Kinova Assistant · 个性化财务助手</div>
                      <div className="text-sm font-bold text-white tracking-tight">
                        {copilotState.headline || '深度财务与小票推理'}
                      </div>
                    </div>
                  </div>
                  <span className="px-2.5 py-1 rounded-full bg-emerald-500/20 text-emerald-200 border border-emerald-400/30 text-[10px] font-bold uppercase tracking-wider">
                    Kinova AI
                  </span>
                </div>

                {/* Loading */}
                {copilotState.status === 'loading' && (
                  <div className="flex flex-col items-center justify-center py-10 gap-3">
                    <LoaderCircle size={28} className="animate-spin text-emerald-400" />
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
                      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-xl bg-white/[0.06] border border-white/10 text-xs text-white/90 font-medium whitespace-nowrap">
                        <span>📊</span>
                        <span>匹配记录: {copilotState.matchedCount ?? copilotState.deterministicFacts?.transactionCount ?? 0} 笔</span>
                      </span>
                      {(copilotState.exactTotalSpent != null && copilotState.exactTotalSpent > 0) && (
                        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-xl bg-emerald-500/20 border border-emerald-400/30 text-xs text-emerald-200 font-mono font-bold whitespace-nowrap tabular-nums">
                          <span>💰</span>
                          <span>账本确切总计: {formatPrice('MYR', copilotState.exactTotalSpent)}</span>
                        </span>
                      )}
                    </div>

                    {/* Multi-turn context trail (previous turns if continuing conversation) */}
                    {conversationHistory.length > 2 && (
                      <div className="space-y-1.5 max-h-36 overflow-y-auto px-3 py-2 rounded-2xl bg-black/25 border border-white/10 text-[11px] text-white/70">
                        <div className="text-[10px] uppercase tracking-wider text-emerald-300 font-semibold">Earlier context</div>
                        {conversationHistory.slice(0, -2).map((turn, idx) => (
                          <div key={idx} className={turn.role === 'user' ? 'text-emerald-200 font-medium' : 'text-white/65'}>
                            {turn.role === 'user' ? `You: ${turn.text}` : `Kinova: ${turn.text}`}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Personal Ledger Absence Distinction (only for explicit item/store lookups) */}
                    {copilotState.showLedgerAbsenceNotice && (
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

                    {/* Interactive Clarification Quick Replies */}
                    {copilotState.clarification && copilotState.clarification.options?.length ? (
                      <div className="flex flex-wrap gap-2">
                        {copilotState.clarification.options.map((opt) => (
                          <button
                            key={opt}
                            type="button"
                            onClick={() => submitInquiry(opt)}
                            className="px-3 py-1.5 rounded-xl bg-emerald-500/20 hover:bg-emerald-500/35 border border-emerald-400/35 text-emerald-100 text-xs font-semibold cursor-pointer transition-all"
                          >
                            {opt}
                          </button>
                        ))}
                      </div>
                    ) : null}

                    {/* Interactive Proposed Action Button */}
                    {copilotState.proposedAction && (
                      <div className="flex flex-wrap items-center justify-between gap-2.5 p-3.5 rounded-2xl bg-amber-500/12 border border-amber-400/30 text-amber-100 text-xs">
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <span className="text-base shrink-0">💡</span>
                          <span className="leading-snug">{copilotState.proposedAction.label}</span>
                        </div>
                        <button
                          type="button"
                          disabled={applyingAction || Boolean(copilotState.proposedActionApplied)}
                          onClick={() => void handleExecuteProposedAction(copilotState.proposedAction!)}
                          className={`shrink-0 px-3.5 py-2 rounded-xl font-semibold text-xs inline-flex items-center gap-1.5 transition-all cursor-pointer ${
                            copilotState.proposedActionApplied
                              ? 'bg-emerald-500/25 border border-emerald-400/40 text-emerald-200'
                              : 'bg-[#0D6E52] hover:bg-[#118C68] text-white shadow-md'
                          } disabled:opacity-60`}
                        >
                          {applyingAction ? (
                            <LoaderCircle size={13} className="animate-spin" />
                          ) : copilotState.proposedActionApplied ? (
                            <Check size={13} />
                          ) : (
                            <Sparkles size={13} />
                          )}
                          <span>{copilotState.proposedActionApplied ? '已执行' : '一键执行'}</span>
                        </button>
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
                            <ReceiptText size={14} className="text-emerald-400" />
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

                    {/* Action Tip (only if not already shown as interactive proposedAction) */}
                    {copilotState.actionTip && !copilotState.proposedAction && (
                      <div className="p-3.5 rounded-2xl bg-amber-500/12 border border-amber-400/25 text-amber-100 text-xs flex items-center gap-2.5">
                        <Sparkles size={14} className="text-amber-300 shrink-0" />
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
                  <div className="w-6 h-6 rounded-lg bg-emerald-500/25 border border-emerald-400/35 flex items-center justify-center text-emerald-300">
                    <Sparkles size={14} />
                  </div>
                  <span>小票与支出记录查询结果</span>
                  {matches.length > 0 && (
                    <span className="px-2 py-0.5 rounded-full bg-white/10 text-white/70 text-[11px] font-mono">
                      {matches.length} 笔匹配
                    </span>
                  )}
                  {historyQuery.isFetching && (
                    <LoaderCircle size={14} className="animate-spin text-emerald-400 ml-auto" />
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
                              <div className="font-mono font-black text-sm sm:text-base text-emerald-400 whitespace-nowrap tabular-nums">
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
                        className="px-4 py-2.5 rounded-xl bg-[#0D6E52] hover:bg-[#118C68] active:scale-95 text-white font-semibold text-xs flex items-center gap-2 shadow-lg cursor-pointer transition-all disabled:opacity-50"
                      >
                        {isGeneralLoading ? (
                          <LoaderCircle size={15} className="animate-spin" />
                        ) : (
                          <Globe2 size={15} />
                        )}
                        <span>全网参考价格</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setActiveIntent('copilot');
                          void fetchCopilot(query);
                        }}
                        className="px-4 py-2.5 rounded-xl bg-white/10 hover:bg-white/15 active:scale-95 text-emerald-300 font-semibold text-xs flex items-center gap-2 border border-white/15 cursor-pointer transition-all"
                      >
                        <Sparkles size={15} />
                        <span>Ask Kinova Assistant</span>
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
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/20 border border-white/15 text-emerald-200 text-[11px] font-medium transition-colors"
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
                            <span className="inline-block px-2 py-0.5 rounded-md bg-emerald-500/20 border border-emerald-400/30 text-emerald-200 text-[11px] font-semibold mb-1">
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
                          <Store size={14} className="text-emerald-400 shrink-0" />
                          <span className="truncate max-w-[150px]">{merchant}</span>
                        </span>
                        <span className="flex items-center gap-1.5">
                          <CalendarDays size={14} className="text-emerald-400 shrink-0" />
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
                          className="px-3 py-1.5 rounded-xl bg-emerald-500/25 hover:bg-emerald-500/40 active:scale-95 text-emerald-200 hover:text-white text-xs font-semibold border border-emerald-400/30 transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-60 disabled:cursor-wait"
                        >
                          {online?.status === 'loading' ? (
                            <LoaderCircle size={13} className="animate-spin text-emerald-300" />
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
                                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/20 border border-white/15 text-emerald-200 text-[11px] font-medium transition-colors"
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

      {/* Bottom Floating Composer & Swipe Up Dock */}
      <footer className="relative z-20 shrink-0 flex flex-col border-t border-white/10 bg-[#090D0C]/95 backdrop-blur-2xl">
        <div className="w-full max-w-2xl mx-auto px-4 sm:px-6 pt-3 pb-2">
          <form
            onSubmit={handleAskSubmit}
            className="flex items-center gap-2.5 px-4 py-2 rounded-2xl bg-white/[0.08] hover:bg-white/[0.11] focus-within:bg-white/[0.13] border border-white/15 focus-within:border-emerald-400/50 backdrop-blur-2xl shadow-xl transition-all"
          >
            <Sparkles size={18} className="text-emerald-400 shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={draftQuery}
              onChange={(e) => setDraftQuery(e.target.value)}
              placeholder="问价格、预算、账单或投资…"
              className="min-w-0 flex-1 bg-transparent text-white placeholder:text-white/45 text-sm outline-none py-1.5"
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
              className="w-9 h-9 rounded-xl bg-[#0D6E52] hover:bg-[#118C68] active:scale-95 text-white flex items-center justify-center transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-md shrink-0 cursor-pointer"
              aria-label="Send query"
            >
              <ArrowUp size={18} />
            </button>
          </form>
        </div>

        {/* Bottom Swipe-Up Dock */}
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
            <ChevronUp size={18} className="text-emerald-400 group-hover:-translate-y-1 transition-transform animate-bounce" />
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
