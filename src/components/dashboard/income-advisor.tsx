'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { motion } from 'framer-motion';
import { 
  Sparkles, ShieldCheck, TrendingUp, Edit3, Check, ArrowUpRight, Plus, X, Wallet, Settings
} from 'lucide-react';
import { Transaction } from '@/hooks/useTransactions';
import { useAppStore } from '@/stores/app-store';
import { getAmountInBaseCurrency } from '@/lib/currency';
import { saveSettingWithCloudSync, SETTINGS_UPDATED_EVENT } from '@/lib/cloud-settings-sync';

import { getLocalDateString } from '@/lib/date-helper';

interface IncomeAdvisorProps {
  liveIncome: number;
  liveExpense: number;
  liveInvested?: number;
  transactions?: Transaction[];
  monthTransactions?: Transaction[];
  allTransactions?: Transaction[];
  monthLabel?: string;
}

export function IncomeAdvisor({
  liveIncome,
  liveExpense,
  liveInvested,
  transactions = [],
  monthTransactions,
  allTransactions,
  monthLabel,
}: IncomeAdvisorProps) {
  const { setQuickAddOpen, setEditTransaction } = useAppStore();
  const [customIncome, setCustomIncome] = useState<string>('');
  const [isEditing, setIsEditing] = useState(false);
  const [effectiveIncome, setEffectiveIncome] = useState<number>(0);

  const [currentReserve, setCurrentReserve] = useState<number>(0);
  const [reserveInput, setReserveInput] = useState<string>('');
  const [isEditingReserve, setIsEditingReserve] = useState(false);

  // User customizable targets
  const [savingsTargetPct, setSavingsTargetPct] = useState<number>(20);
  const [investmentTargetPct, setInvestmentTargetPct] = useState<number>(20);
  const [emergencyMonthsGoal, setEmergencyMonthsGoal] = useState<number>(6);
  const [isCustomizingGoals, setIsCustomizingGoals] = useState(false);

  const historyTxs = allTransactions && allTransactions.length > 0 ? allTransactions : transactions;
  const currentMonthTxs = monthTransactions && monthTransactions.length > 0 ? monthTransactions : transactions;

  useEffect(() => {
    const loadSettings = () => {
      const savedReserve = localStorage.getItem('cashflow_emergency_reserve');
      if (savedReserve && parseFloat(savedReserve) >= 0) {
        setCurrentReserve(parseFloat(savedReserve));
        setReserveInput(savedReserve);
      }
      const s = localStorage.getItem('cashflow_savings_target_pct');
      if (s && !isNaN(parseFloat(s))) setSavingsTargetPct(parseFloat(s));
      const i = localStorage.getItem('cashflow_investment_target_pct');
      if (i && !isNaN(parseFloat(i))) setInvestmentTargetPct(parseFloat(i));
      const m = localStorage.getItem('cashflow_emergency_months_goal');
      if (m && !isNaN(parseInt(m, 10))) setEmergencyMonthsGoal(parseInt(m, 10));
    };
    loadSettings();
    window.addEventListener(SETTINGS_UPDATED_EVENT, loadSettings);
    return () => window.removeEventListener(SETTINGS_UPDATED_EVENT, loadSettings);
  }, []);

  const handleSaveReserve = (e: React.FormEvent) => {
    e.preventDefault();
    const val = parseFloat(reserveInput);
    if (!isNaN(val) && val >= 0) {
      setCurrentReserve(val);
      saveSettingWithCloudSync('cashflow_emergency_reserve', val.toString());
      setIsEditingReserve(false);
    }
  };

  // Load custom baseline income if saved
  useEffect(() => {
    const saved = localStorage.getItem('cashflow_baseline_income');
    if (saved && parseFloat(saved) > 0) {
      setCustomIncome(saved);
      setEffectiveIncome(parseFloat(saved));
    } else if (liveIncome > 0) {
      setEffectiveIncome(liveIncome);
      setCustomIncome(liveIncome.toString());
    } else {
      setEffectiveIncome(0);
      setCustomIncome('');
    }
  }, [liveIncome]);

  const handleSaveIncome = (e: React.FormEvent) => {
    e.preventDefault();
    const val = parseFloat(customIncome);
    if (!isNaN(val) && val > 0) {
      setEffectiveIncome(val);
      saveSettingWithCloudSync('cashflow_baseline_income', val.toString());
      setIsEditing(false);
    }
  };

  // 1. Compute historical rolling monthly average expense & income volatility
  const { rollingMonthlyExpense, incomeVolatility, completedMonthsCount } = useMemo(() => {
    const currentMonthPrefix = getLocalDateString().slice(0, 7);
    const monthExpenses = new Map<string, number>();
    const monthIncomes = new Map<string, number>();

    const safeTxs = Array.isArray(historyTxs) ? historyTxs : [];
    for (const t of safeTxs) {
      if (!t.date || t.date.length < 7) continue;
      const m = t.date.slice(0, 7);
      if (m === currentMonthPrefix) continue; // Skip current incomplete month

      const baseAmt = getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount);
      if (t.type === 'expense') {
        monthExpenses.set(m, (monthExpenses.get(m) || 0) + baseAmt);
      } else if (t.type === 'income') {
        monthIncomes.set(m, (monthIncomes.get(m) || 0) + baseAmt);
      }
    }

    const expValues = Array.from(monthExpenses.values()).filter((v) => v > 0);
    const completedMonthsCount = expValues.length;

    let rollingMonthlyExpense = liveExpense;
    if (expValues.length > 0) {
      const recentExp = expValues.slice(0, 6);
      rollingMonthlyExpense = recentExp.reduce((a, b) => a + b, 0) / recentExp.length;
    } else if (effectiveIncome > 0 && liveExpense === 0) {
      rollingMonthlyExpense = effectiveIncome * 0.5;
    } else {
      rollingMonthlyExpense = Math.max(liveExpense, 1);
    }

    // Income volatility (CV = stdDev / mean)
    const incValues = Array.from(monthIncomes.values()).filter((v) => v > 0);
    let incomeVolatility: number | null = null;
    if (incValues.length >= 2) {
      const mean = incValues.reduce((a, b) => a + b, 0) / incValues.length;
      if (mean > 0) {
        const variance = incValues.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / incValues.length;
        incomeVolatility = Math.sqrt(variance) / mean;
      }
    }

    return { rollingMonthlyExpense, incomeVolatility, completedMonthsCount };
  }, [historyTxs, liveExpense, effectiveIncome]);

  // Actual monthly figures from transactions (respects liveInvested from cockpit to ensure 100% sync)
  const actualInvested = useMemo(() => {
    if (typeof liveInvested === 'number') {
      return liveInvested;
    }
    const safeTxs = Array.isArray(currentMonthTxs) ? currentMonthTxs : [];
    return safeTxs.reduce((sum, t) => {
      if (t.type !== 'investment') return sum;
      const isCashSavings = t.category === 'Emergency Savings' || t.category === 'Fixed Deposit' || t.category === 'Other Savings';
      if (isCashSavings) return sum;
      const amt = getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount);
      const sub = (t.subCategory || '').toUpperCase();
      const desc = (t.description || '').toUpperCase();
      const isSell = sub === 'SELL' || desc.includes('SELL') || desc.includes('卖出');
      return isSell ? sum - amt : sum + amt;
    }, 0);
  }, [liveInvested, currentMonthTxs]);

  // Transactions explicitly logged under 'Emergency Savings' or 'Fixed Deposit' this month
  const monthEmergencyDeposits = useMemo(() => {
    const safeTxs = Array.isArray(currentMonthTxs) ? currentMonthTxs : [];
    return safeTxs
      .filter((t) => (t.category === 'Emergency Savings' || t.category === 'Fixed Deposit') && t.amount > 0)
      .reduce((sum, t) => sum + getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount), 0);
  }, [currentMonthTxs]);

  // Actual net saved cash (explicit savings deposits or unallocated monthly cashflow surplus)
  const unallocatedCashSurplus = Math.max(0, liveIncome - liveExpense - actualInvested);
  const actualSavedCash = monthEmergencyDeposits > 0 ? monthEmergencyDeposits : unallocatedCashSurplus;

  // Suggested Targets: customizable percentage of income
  const emergencyTarget = effectiveIncome * (savingsTargetPct / 100);
  const investmentTarget = effectiveIncome * (investmentTargetPct / 100);

  // Total accumulated emergency reserve across history (baseline + all recorded deposits)
  const totalEmergencyDeposits = useMemo(() => {
    const safeTxs = Array.isArray(historyTxs) ? historyTxs : [];
    return safeTxs
      .filter((t) => (t.category === 'Emergency Savings' || t.category === 'Fixed Deposit') && t.amount > 0)
      .reduce((sum, t) => sum + getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount), 0);
  }, [historyTxs]);

  const totalEmergencyReserve = currentReserve + totalEmergencyDeposits;

  // Emergency reserve goal is based on rolling monthly expense * target months
  const emergencyReserveGoal = rollingMonthlyExpense * emergencyMonthsGoal;
  const reserveGoalProgress = emergencyReserveGoal > 0 ? Math.min((totalEmergencyReserve / emergencyReserveGoal) * 100, 100) : 0;

  const emergencyProgress = emergencyTarget > 0 ? Math.min((actualSavedCash / emergencyTarget) * 100, 100) : 0;
  const investmentProgress = investmentTarget > 0 ? Math.min((actualInvested / investmentTarget) * 100, 100) : 0;

  return (
    <div className="rounded-[22px] border border-black/[0.08] dark:border-white/[0.08] bg-card p-5 sm:p-6 shadow-[0_1px_2px_rgba(17,20,24,0.03)] space-y-5">
      {/* Header with Monthly Income Baseline */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-black/[0.06] dark:border-white/[0.06] pb-4">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-xl bg-[#0E1513] border border-emerald-500/30 flex items-center justify-center text-emerald-400 shadow-sm shrink-0">
            <Sparkles className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-sm sm:text-base font-semibold text-foreground tracking-tight">
              Income Advisory · Emergency & Investment
            </h2>
            <p className="text-xs text-muted-foreground">
              Personalized monthly savings and investment targets {monthLabel ? `for ${monthLabel}` : 'based on your income'}
            </p>
          </div>
        </div>

        {/* Controls: Income & Customize Targets */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Customize Targets Button */}
          <button
            type="button"
            onClick={() => setIsCustomizingGoals((v) => !v)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-amber-500/10 hover:bg-amber-500/15 text-amber-800 dark:text-amber-300 border border-amber-500/25 text-xs font-semibold transition-colors cursor-pointer"
            title="自定义储蓄/投资比例与应急金月数"
          >
            <Settings className="h-3.5 w-3.5" />
            <span>目标: {savingsTargetPct}% / {investmentTargetPct}% / {emergencyMonthsGoal}M</span>
          </button>

          {/* Income Selector / Modifier */}
          {!isEditing ? (
            <div className="flex items-center gap-2 bg-black/[0.025] dark:bg-white/[0.03] px-3 py-1.5 rounded-xl border border-black/[0.08] dark:border-white/[0.08]">
              <span className="text-xs text-muted-foreground">Monthly Income:</span>
              <span className="text-xs font-bold text-emerald-700 dark:text-emerald-400 font-mono tabular-nums">
                RM {effectiveIncome.toLocaleString('en-MY', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
              </span>
              <button
                onClick={() => setIsEditing(true)}
                className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-black/[0.05] dark:hover:bg-white/[0.06] transition-colors cursor-pointer"
                title="Change monthly income"
              >
                <Edit3 className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <form onSubmit={handleSaveIncome} className="flex items-center gap-1.5">
              <div className="flex items-center bg-background px-2.5 py-1 rounded-xl border border-black/[0.12] dark:border-white/[0.15] text-xs">
                <span className="text-muted-foreground mr-1 font-bold">RM</span>
                <input
                  type="number"
                  value={customIncome}
                  onChange={(e) => setCustomIncome(e.target.value)}
                  className="w-24 bg-transparent text-foreground font-mono outline-none"
                  autoFocus
                />
              </div>
              <button
                type="submit"
                className="p-1.5 rounded-xl bg-[#0D6E52] hover:bg-[#0A5740] dark:bg-emerald-600 dark:hover:bg-emerald-500 text-white cursor-pointer"
              >
                <Check className="h-4 w-4" />
              </button>
            </form>
          )}
        </div>
      </div>

      {/* Target Customizer Panel */}
      {isCustomizingGoals && (
        <div className="p-4 rounded-xl bg-black/[0.025] dark:bg-white/[0.03] border border-black/[0.07] dark:border-white/[0.07] space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold text-foreground flex items-center gap-1.5">
              <Settings className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
              <span>个性化财务目标偏好配置</span>
            </h4>
            <button
              type="button"
              onClick={() => setIsCustomizingGoals(false)}
              className="p-1 rounded-lg text-muted-foreground hover:text-foreground cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {/* Savings % */}
            <div className="space-y-1.5">
              <label className="text-[11px] text-muted-foreground font-medium">储蓄目标比例 (Savings):</label>
              <div className="flex items-center gap-1">
                {[10, 15, 20, 25, 30].map((pct) => (
                  <button
                    key={pct}
                    type="button"
                    onClick={() => {
                      setSavingsTargetPct(pct);
                      saveSettingWithCloudSync('cashflow_savings_target_pct', pct.toString());
                    }}
                    className={`px-2 py-1 rounded-lg text-xs font-mono font-semibold transition-colors cursor-pointer ${
                      savingsTargetPct === pct
                        ? 'bg-[#0D6E52] dark:bg-emerald-600 text-white'
                        : 'bg-card text-foreground border border-black/[0.08] dark:border-white/[0.08] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]'
                    }`}
                  >
                    {pct}%
                  </button>
                ))}
              </div>
            </div>
            {/* Investment % */}
            <div className="space-y-1.5">
              <label className="text-[11px] text-muted-foreground font-medium">投资目标比例 (Invest):</label>
              <div className="flex items-center gap-1">
                {[10, 15, 20, 25, 30].map((pct) => (
                  <button
                    key={pct}
                    type="button"
                    onClick={() => {
                      setInvestmentTargetPct(pct);
                      saveSettingWithCloudSync('cashflow_investment_target_pct', pct.toString());
                    }}
                    className={`px-2 py-1 rounded-lg text-xs font-mono font-semibold transition-colors cursor-pointer ${
                      investmentTargetPct === pct
                        ? 'bg-[#B8862D] dark:bg-amber-500 text-white dark:text-zinc-950'
                        : 'bg-card text-foreground border border-black/[0.08] dark:border-white/[0.08] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]'
                    }`}
                  >
                    {pct}%
                  </button>
                ))}
              </div>
            </div>
            {/* Emergency Months */}
            <div className="space-y-1.5">
              <label className="text-[11px] text-muted-foreground font-medium">应急金覆盖月数 (Tenure):</label>
              <div className="flex items-center gap-1">
                {[3, 6, 9, 12].map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      setEmergencyMonthsGoal(m);
                      saveSettingWithCloudSync('cashflow_emergency_months_goal', m.toString());
                    }}
                    className={`px-2 py-1 rounded-lg text-xs font-mono font-semibold transition-colors cursor-pointer ${
                      emergencyMonthsGoal === m
                        ? 'bg-[#0D6E52] dark:bg-emerald-600 text-white'
                        : 'bg-card text-foreground border border-black/[0.08] dark:border-white/[0.08] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]'
                    }`}
                  >
                    {m}M
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Income Volatility Awareness Banner */}
      {incomeVolatility !== null && incomeVolatility >= 0.25 && (
        <div className="flex items-start gap-3 p-3.5 rounded-xl bg-amber-500/[0.07] border border-amber-500/20 border-l-[3px] border-l-amber-600 dark:border-l-amber-400 text-xs">
          <TrendingUp className="h-4 w-4 text-amber-700 dark:text-amber-400 shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold text-amber-900 dark:text-amber-300">
              收入波动感知 (波动率约 {Math.round(incomeVolatility * 100)}%)
            </div>
            <div className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
              检测到你的历史月收入存在起伏。对于弹性收入者，建议将应急金储备目标设定为 6-9 个月（基于往期月均支出 RM{'\u00A0'}{rollingMonthlyExpense.toFixed(0)} 测算），以保障低谷月份的财务韧性。
            </div>
          </div>
        </div>
      )}

      {/* Two Pillars Grid: Emergency Savings & Investment */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* 1. Emergency Savings Card */}
        <div className="p-5 rounded-2xl border border-black/[0.07] dark:border-white/[0.08] bg-black/[0.015] dark:bg-white/[0.02] flex flex-col justify-between space-y-4 hover:border-emerald-500/30 transition-colors">
          <div className="space-y-3.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="h-9 w-9 rounded-xl bg-emerald-500/12 text-emerald-700 dark:text-emerald-400 border border-emerald-500/25 flex items-center justify-center shrink-0">
                  <ShieldCheck className="h-4.5 w-4.5" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-foreground tracking-tight">Emergency Savings</h3>
                  <span className="text-xs text-emerald-700 dark:text-emerald-400 font-medium">Suggested: {savingsTargetPct}% of Income</span>
                </div>
              </div>
              <span className="text-xs font-mono font-bold px-2.5 py-1 rounded-lg bg-emerald-500/12 text-emerald-800 dark:text-emerald-300 border border-emerald-500/20">
                {savingsTargetPct}%
              </span>
            </div>

            <div>
              <div className="flex items-baseline gap-2">
                <span className="text-xl md:text-2xl font-extrabold text-foreground font-mono tabular-nums">
                  RM {emergencyTarget.toLocaleString('en-MY', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                </span>
                <span className="text-xs text-muted-foreground">/ month target ({savingsTargetPct}%)</span>
              </div>
              <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
                Keep in liquid high-yield cash (GXBank, Versa, KDI Save, Boost, Rize) for unexpected bills.
              </p>
            </div>

            {/* Progress bar for monthly savings */}
            <div className="space-y-1.5 pt-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">
                  Saved this month: <strong className="text-foreground font-mono">RM{'\u00A0'}{actualSavedCash.toFixed(2)}</strong>
                </span>
                <span className="text-emerald-700 dark:text-emerald-400 font-semibold font-mono">{emergencyProgress.toFixed(0)}%</span>
              </div>
              <div className="h-2 w-full rounded-full bg-black/[0.08] dark:bg-white/[0.08] overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-[#0D6E52] to-[#2DD4A0] transition-all duration-500"
                  style={{ width: `${emergencyProgress}%` }}
                />
              </div>
            </div>

            {/* Total Accumulated Emergency Safety Net — flat hairline subsection */}
            <div className="pt-3 border-t border-black/[0.06] dark:border-white/[0.06] space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground font-medium flex items-center gap-1.5">
                  <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  <span>长期应急总储备池 (Total Reserve):</span>
                </span>
                {!isEditingReserve ? (
                  <div className="flex items-center gap-1.5">
                    <span className="font-bold text-foreground font-mono text-sm tabular-nums">
                      RM {totalEmergencyReserve.toLocaleString('en-MY', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setReserveInput(currentReserve > 0 ? currentReserve.toString() : '');
                        setIsEditingReserve(true);
                      }}
                      className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-black/[0.05] dark:hover:bg-white/[0.06] transition-colors cursor-pointer"
                      title="设定/更新银行长期应急存款总额"
                    >
                      <Edit3 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : (
                  <form onSubmit={handleSaveReserve} className="flex items-center gap-1">
                    <div className="flex items-center bg-background px-2 py-0.5 rounded-lg border border-black/[0.12] dark:border-white/[0.15] text-xs">
                      <span className="text-muted-foreground mr-1 font-bold">RM</span>
                      <input
                        type="number"
                        value={reserveInput}
                        onChange={(e) => setReserveInput(e.target.value)}
                        placeholder="0"
                        className="w-20 bg-transparent text-foreground font-mono outline-none text-xs"
                        autoFocus
                      />
                    </div>
                    <button
                      type="submit"
                      className="p-1 rounded-lg bg-[#0D6E52] hover:bg-[#0A5740] dark:bg-emerald-600 dark:hover:bg-emerald-500 text-white cursor-pointer"
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsEditingReserve(false)}
                      className="p-1 rounded-lg text-muted-foreground hover:text-foreground cursor-pointer"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </form>
                )}
              </div>

              {/* Progress towards Safety Net Goal */}
              <div className="space-y-1">
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>{emergencyMonthsGoal}个月开支防线 (RM {emergencyReserveGoal.toLocaleString('en-MY', { maximumFractionDigits: 0 })}):</span>
                  <span className="font-semibold text-emerald-700 dark:text-emerald-400 font-mono">{reserveGoalProgress.toFixed(0)}% 备齐</span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-black/[0.08] dark:bg-white/[0.08] overflow-hidden">
                  <div
                    className="h-full rounded-full bg-emerald-600 dark:bg-emerald-400 transition-all duration-500"
                    style={{ width: `${reserveGoalProgress}%` }}
                  />
                </div>
                <div className="flex items-center justify-between text-[10px] text-muted-foreground pt-0.5">
                  <span>基于{completedMonthsCount > 0 ? `月均支出 RM ${rollingMonthlyExpense.toFixed(0)}` : '月度基准支出'}</span>
                  <span className="text-emerald-700 dark:text-emerald-400 font-medium">上方追踪本月存入，此处监控长期总池</span>
                </div>
              </div>
            </div>
          </div>

          <div className="pt-3 border-t border-black/[0.06] dark:border-white/[0.06] flex items-center justify-between text-xs">
            <button
              type="button"
              onClick={() => {
                setEditTransaction(null);
                setQuickAddOpen(true);
              }}
              className="text-xs font-semibold text-emerald-700 dark:text-emerald-400 hover:underline transition-colors flex items-center gap-1 cursor-pointer"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Record Savings Deposit</span>
            </button>
            <span className="text-[11px] text-muted-foreground font-mono">
              {emergencyMonthsGoal}M: RM {emergencyReserveGoal.toLocaleString('en-MY', { maximumFractionDigits: 0 })}
            </span>
          </div>
        </div>

        {/* 2. Investment Card */}
        <div className="p-5 rounded-2xl border border-black/[0.07] dark:border-white/[0.08] bg-black/[0.015] dark:bg-white/[0.02] flex flex-col justify-between space-y-4 hover:border-amber-500/35 transition-colors">
          <div className="space-y-3.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="h-9 w-9 rounded-xl bg-amber-500/12 text-amber-700 dark:text-amber-400 border border-amber-500/25 flex items-center justify-center shrink-0">
                  <TrendingUp className="h-4.5 w-4.5" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-foreground tracking-tight">Wealth & Investments</h3>
                  <span className="text-xs text-amber-700 dark:text-amber-400 font-medium">Suggested: {investmentTargetPct}% of Income</span>
                </div>
              </div>
              <span className="text-xs font-mono font-bold px-2.5 py-1 rounded-lg bg-amber-500/12 text-amber-800 dark:text-amber-300 border border-amber-500/20">
                {investmentTargetPct}%
              </span>
            </div>

            <div>
              <div className="flex items-baseline gap-2">
                <span className="text-xl md:text-2xl font-extrabold text-foreground font-mono tabular-nums">
                  RM {investmentTarget.toLocaleString('en-MY', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                </span>
                <span className="text-xs text-muted-foreground">/ month ({investmentTargetPct}%)</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                Auto-DCA into broad market ETFs (S&P 500 VOO/CSPX, Bursa Blue Chips), EPF self-contribution, or dividend stocks.
              </p>
            </div>

            {/* Progress bar */}
            <div className="space-y-1.5 pt-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">
                  Invested this month: <strong className="text-foreground font-mono">RM{'\u00A0'}{actualInvested.toFixed(2)}</strong>
                </span>
                <span className="text-amber-700 dark:text-amber-400 font-semibold font-mono">{investmentProgress.toFixed(0)}%</span>
              </div>
              <div className="h-2 w-full rounded-full bg-black/[0.08] dark:bg-white/[0.08] overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-[#B8862D] to-[#E5B85C] transition-all duration-500"
                  style={{ width: `${investmentProgress}%` }}
                />
              </div>
            </div>
          </div>

          <div className="pt-3 border-t border-black/[0.06] dark:border-white/[0.06] flex items-center justify-between text-xs text-muted-foreground">
            <span>Status:</span>
            <span className={`font-semibold ${actualInvested >= investmentTarget && investmentTarget > 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-foreground'}`}>
              {actualInvested >= investmentTarget && investmentTarget > 0 ? 'Target Reached' : `${((actualInvested / (investmentTarget || 1)) * 100).toFixed(0)}% of monthly goal`}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
