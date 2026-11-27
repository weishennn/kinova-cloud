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
import { getUserMoneyProfile } from '@/lib/user-money-profile';
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
  const [configuredPaydayDay, setConfiguredPaydayDay] = useState<number | null>(null);

  const loadCommitmentsAndSettings = () => {
    setCommitments(getSavedCommitments());
    try {
      setConfiguredPaydayDay(getUserMoneyProfile().paydayDay);
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
      paydayDay: configuredPaydayDay,
      commitmentsOverride: commitments,
      isStartingCashConfigured: realCashStats.isConfigured,
    });
  }, [allTransactions, realCashStats.startingLiquidCash, realIncomeStats.effectiveIncome, configuredPaydayDay, commitments, realCashStats.isConfigured]);

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
    <div className="rounded-[22px] border border-black/[0.08] dark:border-white/[0.08] bg-card p-5 sm:p-6 shadow-[0_1px_2px_rgba(17,20,24,0.03)] space-y-5">
      {/* Header and Switcher */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-black/[0.06] dark:border-white/[0.06] pb-4">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-xl bg-[#0E1513] border border-emerald-500/30 flex items-center justify-center text-emerald-400 shadow-sm shrink-0">
            <Sparkles className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-foreground tracking-tight flex items-center gap-2">
              <span>Kinova Intelligence Hub</span>
              <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-800 dark:text-emerald-300 border border-emerald-500/25">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                实时守护
              </span>
            </h2>
          </div>
        </div>

        {/* Atelier Tab Buttons */}
        <div className="flex items-center gap-1 p-1 rounded-xl bg-black/[0.035] dark:bg-white/[0.04] border border-black/[0.06] dark:border-white/[0.06] text-xs font-medium overflow-x-auto no-scrollbar max-w-full">
          <button
            type="button"
            onClick={() => setActiveTab('health')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all cursor-pointer whitespace-nowrap shrink-0 ${
              activeTab === 'health'
                ? 'bg-card text-foreground shadow-sm font-semibold border border-black/[0.06] dark:border-white/[0.08]'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Activity className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
            <span>财务健康 ({healthReport.totalScore})</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('forecast')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all cursor-pointer whitespace-nowrap shrink-0 ${
              activeTab === 'forecast'
                ? 'bg-card text-foreground shadow-sm font-semibold border border-black/[0.06] dark:border-white/[0.08]'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <TrendingUp className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
            <span>90天预报</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('recurring')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all cursor-pointer relative whitespace-nowrap shrink-0 ${
              activeTab === 'recurring'
                ? 'bg-card text-foreground shadow-sm font-semibold border border-black/[0.06] dark:border-white/[0.08]'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <RefreshCw className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
            <span>发现定期扣款</span>
            {untrackedCandidates.length > 0 && (
              <span className="ml-0.5 px-1.5 py-0.2 rounded-full bg-rose-600 text-white text-[10px] font-bold">
                {untrackedCandidates.length}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('briefing')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all cursor-pointer whitespace-nowrap shrink-0 ${
              activeTab === 'briefing'
                ? 'bg-card text-foreground shadow-sm font-semibold border border-black/[0.06] dark:border-white/[0.08]'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Layers className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
            <span>月度简报</span>
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

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
            {/* Obsidian Radial Health Score Card */}
            <div className="lg:col-span-4 p-5 rounded-2xl bg-gradient-to-br from-[#0E1513] via-[#101C18] to-[#0A0F0D] border border-emerald-500/20 text-[#F5F4EF] flex flex-col justify-between gap-4 relative overflow-hidden">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <span className="text-[11px] font-semibold text-emerald-300/80 uppercase tracking-[0.12em] block">
                    Financial Health
                  </span>
                  <div className="mt-1.5 flex items-baseline gap-2">
                    <span className="text-3xl font-extrabold text-[#F5F4EF] font-mono tabular-nums">
                      {healthReport.totalScore}
                    </span>
                    <span className="text-xs text-[#9AA6A1] font-semibold">/ 100</span>
                    <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-400/15 text-emerald-300 border border-emerald-400/25">
                      等级 {healthReport.grade}
                    </span>
                  </div>
                </div>

                {/* SVG Radial Gauge */}
                <svg className="h-16 w-16 shrink-0 -rotate-90" viewBox="0 0 64 64" aria-hidden="true">
                  <circle
                    cx="32"
                    cy="32"
                    r="26"
                    fill="none"
                    stroke="rgba(255,255,255,0.1)"
                    strokeWidth="6"
                  />
                  <circle
                    cx="32"
                    cy="32"
                    r="26"
                    fill="none"
                    stroke={healthReport.totalScore >= 80 ? '#2DD4A0' : healthReport.totalScore >= 60 ? '#E5B85C' : '#F0706D'}
                    strokeWidth="6"
                    strokeLinecap="round"
                    strokeDasharray={2 * Math.PI * 26}
                    strokeDashoffset={2 * Math.PI * 26 * (1 - Math.max(0, Math.min(100, healthReport.totalScore)) / 100)}
                  />
                </svg>
              </div>
              <p className="text-xs text-[#C7D0CC] font-medium leading-relaxed">
                {healthReport.gradeLabel} · {healthReport.summary}
              </p>
            </div>

            {/* 4 Dimensions */}
            <div className="lg:col-span-8 grid grid-cols-1 sm:grid-cols-2 gap-3">
              {Object.entries(healthReport.dimensions).map(([key, dim]) => (
                <div
                  key={key}
                  className="p-3.5 rounded-xl bg-black/[0.025] dark:bg-white/[0.03] border border-black/[0.06] dark:border-white/[0.06] flex flex-col justify-between"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-foreground">
                      {dim.name}
                    </span>
                    <span className="text-xs font-mono font-bold text-muted-foreground tabular-nums">
                      {dim.score}/{dim.maxScore}
                    </span>
                  </div>
                  {/* Progress Bar */}
                  <div className="w-full h-1.5 rounded-full bg-black/[0.08] dark:bg-white/[0.08] my-2.5 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${
                        dim.status === 'excellent'
                          ? 'bg-emerald-600 dark:bg-emerald-400'
                          : dim.status === 'good'
                          ? 'bg-teal-600 dark:bg-teal-400'
                          : dim.status === 'warning'
                          ? 'bg-amber-600 dark:bg-amber-400'
                          : 'bg-rose-600 dark:bg-rose-400'
                      }`}
                      style={{ width: `${dim.percentage}%` }}
                    />
                  </div>
                  <span className="text-[11px] text-muted-foreground truncate">
                    {dim.details}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* AI Actionable Recommendations */}
          <div className="p-4 rounded-xl bg-black/[0.025] dark:bg-white/[0.03] border border-black/[0.06] dark:border-white/[0.06] space-y-2">
            <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
              <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              <span>智能财务改善建议</span>
            </span>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-muted-foreground">
              {healthReport.recommendations.map((rec, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span className="text-emerald-600 dark:text-emerald-400 font-bold shrink-0">•</span>
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
          {/* Key Metrics — unified hairline strip */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-black/[0.06] dark:divide-white/[0.06] rounded-xl bg-black/[0.025] dark:bg-white/[0.03] border border-black/[0.06] dark:border-white/[0.06]">
            <div className="p-4">
              <span className="text-[11px] text-muted-foreground block font-medium">起算流动资金</span>
              <span className="text-lg font-bold font-mono tabular-nums text-foreground mt-1 block">
                RM {forecastResult.currentCashEstimate.toLocaleString('en-MY', { minimumFractionDigits: 2 })}
              </span>
              <span className="text-[10px] text-muted-foreground truncate block mt-0.5">
                {realCashStats.isConfigured ? '备用金 + 账本净结余' : (realCashStats.cumulativeNetCash > 0 ? '历史账本累计净结余' : '账本以 RM 0 起算')}
              </span>
            </div>

            <div className="p-4">
              <span className="text-[11px] text-muted-foreground block font-medium">日常可支配日均支出</span>
              <span className="text-lg font-bold font-mono tabular-nums text-foreground mt-1 block">
                RM{'\u00A0'}{forecastResult.dailyBurnRate.toFixed(2)} / 天
              </span>
              <span className="text-[10px] text-muted-foreground truncate block mt-0.5">
                {forecastResult.dailyBurnRate > 0 ? '基于历史平稳消费推算' : '尚无日常支出流水'}
              </span>
            </div>

            <div className="p-4 min-w-0">
              <span className="text-[11px] text-muted-foreground block font-medium">60 天后预计结余</span>
              <span className={`text-lg font-bold font-mono tabular-nums whitespace-nowrap mt-1 block ${
                forecastResult.forecast60DaysBalance >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'
              }`}>
                RM{'\u00A0'}{forecastResult.forecast60DaysBalance.toLocaleString('en-MY', { minimumFractionDigits: 2 })}
              </span>
              <span className="text-[10px] text-muted-foreground truncate block mt-0.5">已扣减预计固定扣款与分期</span>
            </div>

            <div className="p-4 min-w-0">
              <span className="text-[11px] text-muted-foreground block font-medium">90 天后预计结余</span>
              <span className={`text-lg font-bold font-mono tabular-nums whitespace-nowrap mt-1 block ${
                forecastResult.forecast90DaysBalance >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'
              }`}>
                RM{'\u00A0'}{forecastResult.forecast90DaysBalance.toLocaleString('en-MY', { minimumFractionDigits: 2 })}
              </span>
              <span className="text-[10px] text-muted-foreground truncate block mt-0.5">全周期真实收支走势</span>
            </div>
          </div>

          {/* 30-Day Step Preview */}
          <div className="p-4 rounded-xl bg-amber-500/[0.06] dark:bg-amber-400/[0.06] border border-amber-500/20 border-l-[3px] border-l-amber-600 dark:border-l-amber-400 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2.5 min-w-0">
              <TrendingUp className="h-4 w-4 text-amber-700 dark:text-amber-400 shrink-0" />
              <span className="text-foreground font-medium">
                {forecastResult.insightMessage}
              </span>
            </div>
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full font-semibold shrink-0 text-[11px] border ${
              forecastResult.status === 'safe'
                ? 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-300 border-emerald-500/25'
                : forecastResult.status === 'tight'
                ? 'bg-amber-500/10 text-amber-800 dark:text-amber-300 border-amber-500/25'
                : 'bg-rose-500/10 text-rose-800 dark:text-rose-300 border-rose-500/25'
            }`}>
              <span className={`h-1.5 w-1.5 rounded-full ${
                forecastResult.status === 'safe' ? 'bg-emerald-500' : forecastResult.status === 'tight' ? 'bg-amber-500' : 'bg-rose-500'
              }`} />
              {forecastResult.status === 'safe' ? '资金充裕' : forecastResult.status === 'tight' ? '需备缓冲' : '缺口预警'}
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
              <div className="text-xs text-muted-foreground flex items-center justify-between">
                <span>智能体扫描历史账本，发现了以下未登记为「定期支出」的规律扣费：</span>
                <span className="font-semibold text-emerald-700 dark:text-emerald-400">{untrackedCandidates.length} 项待确认</span>
              </div>
              <div className="divide-y divide-black/[0.06] dark:divide-white/[0.06] border border-black/[0.06] dark:border-white/[0.06] rounded-xl overflow-hidden bg-black/[0.02] dark:bg-white/[0.02]">
                {untrackedCandidates.map((item) => (
                  <div
                    key={item.id}
                    className="flex flex-wrap sm:flex-nowrap items-center justify-between gap-2.5 p-3 hover:bg-black/[0.025] dark:hover:bg-white/[0.03] transition-colors text-xs"
                  >
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <div className="h-8 w-8 rounded-lg bg-emerald-500/12 text-emerald-800 dark:text-emerald-300 border border-emerald-500/20 flex items-center justify-center font-bold font-mono text-xs shrink-0">
                        {item.detectedDayOfMonth}日
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold text-foreground flex items-center gap-2 min-w-0">
                          <span className="truncate">{item.name}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-black/[0.05] dark:bg-white/[0.06] text-muted-foreground shrink-0">
                            {item.category}
                          </span>
                        </div>
                        <span className="text-[11px] text-muted-foreground block truncate">
                          约每月 {item.detectedDayOfMonth} 号扣费 · 历史出现 {item.occurrencesCount} 次 · 最近 {item.lastDate}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-3 shrink-0 ml-auto">
                      <span className="font-mono font-bold text-foreground text-sm whitespace-nowrap tabular-nums">
                        RM{'\u00A0'}{item.averageAmount.toFixed(2)}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleAddDiscoveredToCommitments(item)}
                        disabled={isAddingRecurring === item.id}
                        className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-[#0D6E52] hover:bg-[#0A5740] dark:bg-emerald-600 dark:hover:bg-emerald-500 text-white font-semibold text-xs transition-colors shadow-sm cursor-pointer disabled:opacity-50"
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
          <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-black/[0.06] dark:divide-white/[0.06] rounded-xl bg-black/[0.025] dark:bg-white/[0.03] border border-black/[0.06] dark:border-white/[0.06]">
            <div className="p-4">
              <span className="text-[11px] text-muted-foreground block font-medium">本月累计总支出</span>
              <span className="text-lg font-bold font-mono tabular-nums text-foreground mt-1 block">
                RM {briefing.totalSpending.toLocaleString('en-MY', { minimumFractionDigits: 2 })}
              </span>
            </div>
            <div className="p-4">
              <span className="text-[11px] text-muted-foreground block font-medium">最大开销分类</span>
              <span className="text-lg font-bold text-foreground mt-1 block">
                {briefing.topCategoryName} ({briefing.topCategoryRatio}%)
              </span>
            </div>
            <div className="p-4">
              <span className="text-[11px] text-muted-foreground block font-medium">单笔最大单据</span>
              <span className="text-lg font-bold font-mono tabular-nums text-foreground mt-1 block truncate">
                {briefing.largestExpense ? `RM ${briefing.largestExpense.amount.toFixed(2)}` : '无大额单据'}
              </span>
            </div>
          </div>

          {/* Highlights & Tips */}
          <div className="p-4 rounded-xl bg-black/[0.025] dark:bg-white/[0.03] border border-black/[0.06] dark:border-white/[0.06] space-y-2.5 text-xs">
            <span className="font-semibold text-foreground flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
              <span>关键开支洞察</span>
            </span>
            <div className="space-y-1.5 text-muted-foreground">
              {briefing.highlights.map((h, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span className="text-emerald-600 dark:text-emerald-400 font-bold">•</span>
                  <span>{h}</span>
                </div>
              ))}
            </div>

            <div className="mt-3 pt-3 border-t border-black/[0.06] dark:border-white/[0.06] text-emerald-800 dark:text-emerald-300 font-medium leading-relaxed">
              {briefing.actionableTip}
            </div>
          </div>
        </motion.div>
      )}
    </div>
  );
}
