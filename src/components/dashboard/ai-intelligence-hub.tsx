'use client';

import React, { useState, useMemo, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Activity,
  TrendingUp,
  Sparkles,
  ShieldCheck,
  Check,
  Plus,
  AlertTriangle,
  Calendar,
  Layers,
  ChevronRight,
  Info,
  ArrowRight,
  RefreshCw,
  Wallet,
} from 'lucide-react';
import {
  calculateFinancialHealthScore,
  predictCashflowTrajectory,
  discoverUnmarkedRecurringExpenses,
  generateAiFinancialBriefing,
  type FinancialHealthReport,
  type CashflowForecastResult,
  type DiscoveredRecurringCandidate,
  type FinancialBriefingResult,
} from '@/lib/financial-intelligence';
import { useTransactions, type Transaction } from '@/hooks/useTransactions';
import { getAmountInBaseCurrency } from '@/lib/currency';
import {
  getSavedCommitments,
  saveCommitmentsToStorage,
  type RecurringCommitment,
} from '@/lib/recurring-helper';
import { SETTINGS_UPDATED_EVENT } from '@/lib/cloud-settings-sync';
import { toast } from 'sonner';

interface AiIntelligenceHubProps {
  userBudgetCap?: number;
  allTransactions?: Transaction[];
  selectedMonthTransactions?: Transaction[];
  selectedMonth?: string;
  liveIncome?: number;
  liveExpense?: number;
  liveInvested?: number;
}

export function AiIntelligenceHub({
  userBudgetCap,
  allTransactions: passedAllTxs,
  selectedMonthTransactions: passedMonthTxs,
  selectedMonth,
  liveIncome = 0,
  liveExpense = 0,
  liveInvested = 0,
}: AiIntelligenceHubProps) {
  const { transactions: hookAllTxs = [] } = useTransactions({ period: 'all' });
  const allTransactions = passedAllTxs && passedAllTxs.length > 0 ? passedAllTxs : hookAllTxs;
  const monthTransactions = passedMonthTxs && passedMonthTxs.length > 0 ? passedMonthTxs : allTransactions;

  const [activeTab, setActiveTab] = useState<'health' | 'forecast' | 'recurring' | 'briefing'>('health');
  const [commitments, setCommitments] = useState<RecurringCommitment[]>([]);
  const [isAddingRecurring, setIsAddingRecurring] = useState<string | null>(null);
  const [configuredIncome, setConfiguredIncome] = useState<number>(0);
  const [configuredReserve, setConfiguredReserve] = useState<number>(0);

  const loadCommitmentsAndSettings = () => {
    setCommitments(getSavedCommitments());
    try {
      const inc = localStorage.getItem('cashflow_baseline_income');
      if (inc && parseFloat(inc) > 0) setConfiguredIncome(parseFloat(inc));
      else setConfiguredIncome(0);

      const res = localStorage.getItem('cashflow_emergency_reserve');
      if (res && parseFloat(res) > 0) setConfiguredReserve(parseFloat(res));
      else setConfiguredReserve(0);
    } catch {}
  };

  useEffect(() => {
    loadCommitmentsAndSettings();
    window.addEventListener(SETTINGS_UPDATED_EVENT, loadCommitmentsAndSettings);
    return () => window.removeEventListener(SETTINGS_UPDATED_EVENT, loadCommitmentsAndSettings);
  }, []);

  // 1. Calculate Real Income Stats from Transactions & Settings
  const realIncomeStats = useMemo(() => {
    const incomeTxs = allTransactions.filter((t) => t.type === 'income' && t.amount > 0);
    const monthMap = new Map<string, number>();
    for (const t of incomeTxs) {
      if (!t.date || t.date.length < 7) continue;
      const m = t.date.slice(0, 7);
      monthMap.set(m, (monthMap.get(m) || 0) + getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount));
    }
    const monthValues = Array.from(monthMap.values());
    const avgHistorical = monthValues.length > 0
      ? monthValues.reduce((a, b) => a + b, 0) / monthValues.length
      : 0;

    const effectiveIncome = configuredIncome > 0
      ? configuredIncome
      : (liveIncome > 0 ? liveIncome : avgHistorical);

    return {
      effectiveIncome,
      configuredIncome,
      avgHistorical,
      hasRecordedIncome: incomeTxs.length > 0 || liveIncome > 0 || configuredIncome > 0,
    };
  }, [allTransactions, configuredIncome, liveIncome]);

  // 2. Calculate Real Cash Reserve & Net Ledger Cash Balance
  const realCashStats = useMemo(() => {
    const emergencyDeposits = allTransactions
      .filter((t) => (t.category === 'Emergency Savings' || t.category === 'Fixed Deposit') && t.amount > 0)
      .reduce((sum, t) => sum + getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount), 0);

    const totalEmergencyFund = configuredReserve + emergencyDeposits;

    let totalInc = 0;
    let totalExp = 0;
    let totalInv = 0;
    for (const t of allTransactions) {
      const amt = getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount);
      if (t.type === 'income') totalInc += amt;
      else if (t.type === 'expense') totalExp += amt;
      else if (t.type === 'investment') totalInv += amt;
    }

    const cumulativeNetCash = totalInc - totalExp - totalInv;
    const startingLiquidCash = configuredReserve > 0
      ? Math.max(0, configuredReserve + cumulativeNetCash)
      : Math.max(0, cumulativeNetCash);

    return {
      configuredReserve,
      emergencyDeposits,
      totalEmergencyFund,
      cumulativeNetCash,
      startingLiquidCash,
      isConfigured: configuredReserve > 0,
    };
  }, [allTransactions, configuredReserve]);

  // 3. Real Health Score Report
  const healthReport: FinancialHealthReport = useMemo(() => {
    return calculateFinancialHealthScore({
      transactions: monthTransactions,
      allLedgerTransactions: allTransactions,
      monthlyBudgetCap: userBudgetCap,
      baselineIncome: realIncomeStats.effectiveIncome,
      emergencyFundBalance: realCashStats.totalEmergencyFund,
      targetMonthStr: selectedMonth && /^\d{4}-\d{2}$/.test(selectedMonth) ? selectedMonth : undefined,
    });
  }, [monthTransactions, allTransactions, userBudgetCap, realIncomeStats.effectiveIncome, realCashStats.totalEmergencyFund, selectedMonth]);

  // 4. Real Cashflow Forecast
  const forecastResult: CashflowForecastResult = useMemo(() => {
    return predictCashflowTrajectory({
      transactions: allTransactions,
      startingCash: realCashStats.startingLiquidCash,
      baselineMonthlyIncome: realIncomeStats.effectiveIncome,
      commitmentsOverride: commitments,
      isStartingCashConfigured: realCashStats.isConfigured,
    });
  }, [allTransactions, realCashStats.startingLiquidCash, realIncomeStats.effectiveIncome, commitments, realCashStats.isConfigured]);

  // 5. Discovered Subscriptions from Real Transactions
  const discoveredSubscriptions: DiscoveredRecurringCandidate[] = useMemo(() => {
    return discoverUnmarkedRecurringExpenses(allTransactions, commitments);
  }, [allTransactions, commitments]);

  const untrackedCandidates = useMemo(() => {
    return discoveredSubscriptions.filter((d) => !d.isAlreadyTracked);
  }, [discoveredSubscriptions]);

  // 6. Real Financial Briefing
  const briefing: FinancialBriefingResult = useMemo(() => {
    return generateAiFinancialBriefing(
      monthTransactions,
      selectedMonth && /^\d{4}-\d{2}$/.test(selectedMonth) ? selectedMonth : undefined,
      userBudgetCap
    );
  }, [monthTransactions, selectedMonth, userBudgetCap]);

  // Handle 1-click add discovered recurring expense
  const handleAddDiscoveredToCommitments = (item: DiscoveredRecurringCandidate) => {
    setIsAddingRecurring(item.id);
    try {
      const current = getSavedCommitments();
      const nowMonth = new Date().toISOString().slice(0, 7);
      const newCommitment: RecurringCommitment = {
        id: `comm_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        name: item.name,
        category: item.category || 'Housing & Bills',
        dayOfMonth: item.detectedDayOfMonth,
        amount: item.averageAmount,
        effectiveFrom: nowMonth,
        history: [{ effectiveFrom: nowMonth, amount: item.averageAmount }],
        autoRecord: false,
        notes: `AI 智能体自动发现的周期扣款（过去出现 ${item.occurrencesCount} 次）`,
      };

      const updated = [...current, newCommitment];
      saveCommitmentsToStorage(updated);
      setCommitments(updated);
      toast.success(`已将「${item.name}」(RM ${item.averageAmount.toFixed(2)}) 加入定期支出追踪！`);
    } catch (err) {
      toast.error('添加失败，请稍后重试');
    } finally {
      setIsAddingRecurring(null);
    }
  };

  return (
    <div className="rounded-3xl border border-slate-200 dark:border-white/[0.08] bg-card/75 dark:bg-zinc-900/60 p-4 sm:p-6 backdrop-blur-2xl shadow-xl space-y-4">
      {/* Header and Switcher */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 dark:border-white/[0.06] pb-3.5">
        <div className="flex items-center gap-2.5">
          <div className="h-8 w-8 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white shadow-md shadow-indigo-500/20 shrink-0">
            <Sparkles className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-slate-950 dark:text-white tracking-tight flex items-center gap-2">
              <span>Gemini 智能管家中枢 (AI Intelligence Hub)</span>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border border-emerald-500/30">
                实时守护中
              </span>
            </h2>
          </div>
        </div>

        {/* Tab Buttons */}
        <div className="flex items-center gap-1 p-1 rounded-2xl bg-slate-100 dark:bg-zinc-800/80 text-xs font-medium">
          <button
            type="button"
            onClick={() => setActiveTab('health')}
            className={`px-3 py-1.5 rounded-xl transition-all cursor-pointer ${
              activeTab === 'health'
                ? 'bg-white dark:bg-zinc-900 text-slate-950 dark:text-white shadow-sm font-bold'
                : 'text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            📊 财务健康 ({healthReport.totalScore}分)
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('forecast')}
            className={`px-3 py-1.5 rounded-xl transition-all cursor-pointer ${
              activeTab === 'forecast'
                ? 'bg-white dark:bg-zinc-900 text-slate-950 dark:text-white shadow-sm font-bold'
                : 'text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            🔮 90天预报
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('recurring')}
            className={`px-3 py-1.5 rounded-xl transition-all cursor-pointer relative ${
              activeTab === 'recurring'
                ? 'bg-white dark:bg-zinc-900 text-slate-950 dark:text-white shadow-sm font-bold'
                : 'text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            <span>🔄 发现定期扣款</span>
            {untrackedCandidates.length > 0 && (
              <span className="ml-1 px-1.5 py-0.2 rounded-full bg-rose-500 text-white text-[9px] font-bold animate-pulse">
                {untrackedCandidates.length}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('briefing')}
            className={`px-3 py-1.5 rounded-xl transition-all cursor-pointer ${
              activeTab === 'briefing'
                ? 'bg-white dark:bg-zinc-900 text-slate-950 dark:text-white shadow-sm font-bold'
                : 'text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            📋 月度简报
          </button>
        </div>
      </div>

      {/* Tab 1: Financial Health Score */}
      {activeTab === 'health' && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-4"
        >
          {!realIncomeStats.hasRecordedIncome && (
            <div className="p-3 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-900 dark:text-amber-300 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Info className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
                <span>尚未录入月收入或设定基准月薪（AI 当前完全基于你的真实日常支出进行体检）</span>
              </div>
              <button
                type="button"
                onClick={() => {
                  const el = document.getElementById('income-advisor');
                  if (el) el.scrollIntoView({ behavior: 'smooth' });
                }}
                className="font-bold underline text-amber-800 dark:text-amber-400 hover:opacity-80 shrink-0 cursor-pointer"
              >
                前往设定月薪 ➔
              </button>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            {/* Score Card */}
            <div className="p-4 rounded-2xl bg-gradient-to-br from-indigo-500/10 via-purple-500/10 to-transparent border border-indigo-500/20 flex flex-col justify-between">
              <div>
                <span className="text-[11px] font-semibold text-slate-600 dark:text-zinc-400 uppercase tracking-wider block">
                  AI 综合健康分
                </span>
                <div className="mt-2 flex items-baseline gap-2">
                  <span className="text-3xl sm:text-4xl font-extrabold text-indigo-600 dark:text-indigo-400 font-mono">
                    {healthReport.totalScore}
                  </span>
                  <span className="text-xs text-slate-500 dark:text-zinc-400 font-bold">/ 100</span>
                  <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-indigo-500/20 text-indigo-700 dark:text-indigo-300">
                    等级 {healthReport.grade}
                  </span>
                </div>
              </div>
              <p className="text-xs text-slate-700 dark:text-zinc-300 font-medium mt-3 leading-relaxed">
                {healthReport.gradeLabel} · {healthReport.summary}
              </p>
            </div>

            {/* 4 Dimensions */}
            <div className="md:col-span-3 grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {Object.entries(healthReport.dimensions).map(([key, dim]) => (
                <div
                  key={key}
                  className="p-3 rounded-2xl bg-slate-50 dark:bg-zinc-900/50 border border-slate-100 dark:border-white/[0.06] flex flex-col justify-between"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-900 dark:text-white">
                      {dim.name}
                    </span>
                    <span className="text-xs font-mono font-bold text-slate-600 dark:text-zinc-400">
                      {dim.score}/{dim.maxScore} 分
                    </span>
                  </div>
                  {/* Progress Bar */}
                  <div className="w-full h-1.5 rounded-full bg-slate-200 dark:bg-zinc-800 my-2 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${
                        dim.status === 'excellent'
                          ? 'bg-emerald-500'
                          : dim.status === 'good'
                          ? 'bg-indigo-500'
                          : dim.status === 'warning'
                          ? 'bg-amber-500'
                          : 'bg-rose-500'
                      }`}
                      style={{ width: `${dim.percentage}%` }}
                    />
                  </div>
                  <span className="text-[11px] text-slate-500 dark:text-zinc-400 truncate">
                    {dim.details}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* AI Actionable Recommendations */}
          <div className="p-3.5 rounded-2xl bg-slate-50 dark:bg-zinc-900/40 border border-slate-100 dark:border-white/[0.06] space-y-2">
            <span className="text-xs font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
              <ShieldCheck className="h-4 w-4 text-emerald-500" />
              <span>智能财务改善建议</span>
            </span>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-slate-700 dark:text-zinc-300">
              {healthReport.recommendations.map((rec, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span className="text-indigo-500 font-bold shrink-0">•</span>
                  <span>{rec}</span>
                </div>
              ))}
            </div>
          </div>
        </motion.div>
      )}

      {/* Tab 2: Predictive Cashflow Forecast */}
      {activeTab === 'forecast' && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-4"
        >
          {/* Key Metrics */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="p-3.5 rounded-2xl bg-slate-50 dark:bg-zinc-900/50 border border-slate-100 dark:border-white/[0.06]">
              <span className="text-[11px] text-slate-500 dark:text-zinc-400 block font-medium">起算流动资金</span>
              <span className="text-lg font-bold font-mono text-slate-900 dark:text-white mt-1 block">
                RM {forecastResult.currentCashEstimate.toLocaleString('en-MY', { minimumFractionDigits: 2 })}
              </span>
              <span className="text-[10px] text-slate-400 dark:text-zinc-500 truncate block">
                {realCashStats.isConfigured ? '备用金 + 账本净结余' : (realCashStats.cumulativeNetCash > 0 ? '历史账本累计净结余' : '账本以 RM 0 起算')}
              </span>
            </div>

            <div className="p-3.5 rounded-2xl bg-slate-50 dark:bg-zinc-900/50 border border-slate-100 dark:border-white/[0.06]">
              <span className="text-[11px] text-slate-500 dark:text-zinc-400 block font-medium">日常可支配日均支出</span>
              <span className="text-lg font-bold font-mono text-slate-900 dark:text-white mt-1 block">
                RM {forecastResult.dailyBurnRate.toFixed(2)} / 天
              </span>
              <span className="text-[10px] text-slate-400 dark:text-zinc-500 truncate block">
                {forecastResult.dailyBurnRate > 0 ? '基于历史平稳消费推算' : '尚无日常支出流水'}
              </span>
            </div>

            <div className="p-3.5 rounded-2xl bg-slate-50 dark:bg-zinc-900/50 border border-slate-100 dark:border-white/[0.06]">
              <span className="text-[11px] text-slate-500 dark:text-zinc-400 block font-medium">60 天后预计结余</span>
              <span className={`text-lg font-bold font-mono mt-1 block ${
                forecastResult.forecast60DaysBalance >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'
              }`}>
                RM {forecastResult.forecast60DaysBalance.toLocaleString('en-MY', { minimumFractionDigits: 2 })}
              </span>
              <span className="text-[10px] text-slate-400 dark:text-zinc-500 truncate block">已扣减预计固定扣款与分期</span>
            </div>

            <div className="p-3.5 rounded-2xl bg-slate-50 dark:bg-zinc-900/50 border border-slate-100 dark:border-white/[0.06]">
              <span className="text-[11px] text-slate-500 dark:text-zinc-400 block font-medium">90 天后预计结余</span>
              <span className={`text-lg font-bold font-mono mt-1 block ${
                forecastResult.forecast90DaysBalance >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'
              }`}>
                RM {forecastResult.forecast90DaysBalance.toLocaleString('en-MY', { minimumFractionDigits: 2 })}
              </span>
              <span className="text-[10px] text-slate-400 dark:text-zinc-500 truncate block">全周期真实收支走势</span>
            </div>
          </div>

          {/* 30-Day Step Preview */}
          <div className="p-4 rounded-2xl bg-gradient-to-r from-purple-500/10 via-indigo-500/10 to-transparent border border-purple-500/20 flex items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-purple-600 dark:text-purple-400 shrink-0" />
              <span className="text-slate-800 dark:text-zinc-200 font-medium">
                {forecastResult.insightMessage}
              </span>
            </div>
            <span className="px-2.5 py-1 rounded-full bg-purple-500/20 text-purple-700 dark:text-purple-300 font-bold shrink-0 text-[11px]">
              {forecastResult.status === 'safe' ? '🟢 资金充裕' : forecastResult.status === 'tight' ? '🟡 需备缓冲' : '🔴 缺口预警'}
            </span>
          </div>
        </motion.div>
      )}

      {/* Tab 3: Discovered Subscriptions */}
      {activeTab === 'recurring' && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-3"
        >
          {untrackedCandidates.length > 0 ? (
            <div className="space-y-2">
              <div className="text-xs text-slate-600 dark:text-zinc-400 flex items-center justify-between">
                <span>智能体扫描历史账本，发现了以下未登记为「定期支出」的规律扣费：</span>
                <span className="font-semibold text-purple-700 dark:text-purple-400">{untrackedCandidates.length} 项待确认</span>
              </div>
              <div className="divide-y divide-slate-100 dark:divide-zinc-800 border border-slate-200 dark:border-white/[0.08] rounded-2xl overflow-hidden bg-white/70 dark:bg-zinc-900/40">
                {untrackedCandidates.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between p-3 hover:bg-slate-50 dark:hover:bg-zinc-800/40 transition-colors text-xs"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="h-8 w-8 rounded-xl bg-purple-500/15 text-purple-700 dark:text-purple-400 flex items-center justify-center font-bold text-xs shrink-0">
                        {item.detectedDayOfMonth}日
                      </div>
                      <div>
                        <div className="font-bold text-slate-900 dark:text-white flex items-center gap-2">
                          <span>{item.name}</span>
                          <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-100 dark:bg-zinc-800 text-slate-500 dark:text-zinc-400">
                            {item.category}
                          </span>
                        </div>
                        <span className="text-[11px] text-slate-500 dark:text-zinc-400">
                          约每月 {item.detectedDayOfMonth} 号扣费 · 历史出现 {item.occurrencesCount} 次 · 最近 {item.lastDate}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-3 shrink-0">
                      <span className="font-mono font-bold text-slate-950 dark:text-white text-sm">
                        RM {item.averageAmount.toFixed(2)}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleAddDiscoveredToCommitments(item)}
                        disabled={isAddingRecurring === item.id}
                        className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-purple-600 hover:bg-purple-700 text-white font-semibold text-xs transition-colors shadow-sm cursor-pointer disabled:opacity-50"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        <span>一键加入追踪</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-center py-8 text-xs text-slate-500 dark:text-zinc-400 space-y-1">
              <Check className="h-6 w-6 text-emerald-500 mx-auto mb-1" />
              <p className="font-medium text-slate-700 dark:text-zinc-300">所有周期性扣费均已纳入追踪</p>
              <p className="text-[11px] text-slate-400 dark:text-zinc-500">
                当您有新的周期性账单（如新订阅、新话费套餐）连续出现 2 次以上时，智能体会自动在此处提醒您。
              </p>
            </div>
          )}
        </motion.div>
      )}

      {/* Tab 4: AI Monthly Briefing */}
      {activeTab === 'briefing' && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-3.5"
        >
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="p-3.5 rounded-2xl bg-slate-50 dark:bg-zinc-900/50 border border-slate-100 dark:border-white/[0.06]">
              <span className="text-[11px] text-slate-500 dark:text-zinc-400 block font-medium">本月累计总支出</span>
              <span className="text-lg font-bold font-mono text-slate-900 dark:text-white mt-1 block">
                RM {briefing.totalSpending.toLocaleString('en-MY', { minimumFractionDigits: 2 })}
              </span>
            </div>
            <div className="p-3.5 rounded-2xl bg-slate-50 dark:bg-zinc-900/50 border border-slate-100 dark:border-white/[0.06]">
              <span className="text-[11px] text-slate-500 dark:text-zinc-400 block font-medium">最大开销分类</span>
              <span className="text-lg font-bold text-slate-900 dark:text-white mt-1 block">
                {briefing.topCategoryName} ({briefing.topCategoryRatio}%)
              </span>
            </div>
            <div className="p-3.5 rounded-2xl bg-slate-50 dark:bg-zinc-900/50 border border-slate-100 dark:border-white/[0.06]">
              <span className="text-[11px] text-slate-500 dark:text-zinc-400 block font-medium">单笔最大单据</span>
              <span className="text-lg font-bold font-mono text-slate-900 dark:text-white mt-1 block truncate">
                {briefing.largestExpense ? `RM ${briefing.largestExpense.amount.toFixed(2)}` : '无大额单据'}
              </span>
            </div>
          </div>

          {/* Highlights & Tips */}
          <div className="p-4 rounded-2xl bg-slate-50 dark:bg-zinc-900/40 border border-slate-100 dark:border-white/[0.06] space-y-2.5 text-xs">
            <span className="font-bold text-slate-900 dark:text-white block">📌 关键开支洞察</span>
            <div className="space-y-1.5 text-slate-700 dark:text-zinc-300">
              {briefing.highlights.map((h, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span className="text-indigo-500 font-bold">•</span>
                  <span>{h}</span>
                </div>
              ))}
            </div>

            <div className="mt-3 pt-3 border-t border-slate-200 dark:border-zinc-800 text-indigo-700 dark:text-indigo-300 font-medium leading-relaxed">
              {briefing.actionableTip}
            </div>
          </div>
        </motion.div>
      )}
    </div>
  );
}
