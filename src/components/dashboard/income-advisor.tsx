'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { motion } from 'framer-motion';
import { 
  Sparkles, ShieldCheck, TrendingUp, Edit3, Check, ArrowUpRight, Plus, X, Wallet
} from 'lucide-react';
import { Transaction } from '@/hooks/useTransactions';
import { useAppStore } from '@/stores/app-store';
import { getAmountInBaseCurrency } from '@/lib/currency';
import { saveSettingWithCloudSync, SETTINGS_UPDATED_EVENT } from '@/lib/cloud-settings-sync';

interface IncomeAdvisorProps {
  liveIncome: number;
  liveExpense: number;
  transactions: Transaction[];
  monthLabel?: string;
}

export function IncomeAdvisor({ liveIncome, liveExpense, transactions, monthLabel }: IncomeAdvisorProps) {
  const { setQuickAddOpen, setEditTransaction } = useAppStore();
  const [customIncome, setCustomIncome] = useState<string>('');
  const [isEditing, setIsEditing] = useState(false);
  const [effectiveIncome, setEffectiveIncome] = useState<number>(0);

  const [currentReserve, setCurrentReserve] = useState<number>(0);
  const [reserveInput, setReserveInput] = useState<string>('');
  const [isEditingReserve, setIsEditingReserve] = useState(false);

  useEffect(() => {
    const loadReserve = () => {
      const savedReserve = localStorage.getItem('cashflow_emergency_reserve');
      if (savedReserve && parseFloat(savedReserve) >= 0) {
        setCurrentReserve(parseFloat(savedReserve));
        setReserveInput(savedReserve);
      }
    };
    loadReserve();
    window.addEventListener(SETTINGS_UPDATED_EVENT, loadReserve);
    return () => window.removeEventListener(SETTINGS_UPDATED_EVENT, loadReserve);
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

  // Actual monthly figures from transactions
  const actualInvested = useMemo(() => {
    return transactions
      .filter(t => t.type === 'investment')
      .reduce((sum, t) => sum + getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount), 0);
  }, [transactions]);

  // Actual net saved cash (Income - Expenses - Invested)
  const actualSavedCash = Math.max(0, liveIncome - liveExpense - actualInvested);

  // Suggested Targets: 20% Emergency Savings, 20% Investments
  const emergencyTarget = effectiveIncome * 0.20;
  const investmentTarget = effectiveIncome * 0.20;

  // Transactions explicitly logged under 'Emergency Savings' or 'Fixed Deposit'
  const emergencyDeposits = useMemo(() => {
    return transactions
      .filter(t => t.category === 'Emergency Savings' || t.category === 'Fixed Deposit')
      .reduce((sum, t) => sum + getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount), 0);
  }, [transactions]);

  // Total accumulated emergency reserve (baseline + recorded deposits)
  const totalEmergencyReserve = currentReserve + emergencyDeposits;

  // Emergency reserve target is six months of actual spending. Do not mix an
  // arbitrary income fallback into a value presented as a six-month goal.
  const emergencyReserveGoal = liveExpense * 6;
  const reserveGoalProgress = emergencyReserveGoal > 0 ? Math.min((totalEmergencyReserve / emergencyReserveGoal) * 100, 100) : 0;

  const emergencyProgress = emergencyTarget > 0 ? Math.min((actualSavedCash / emergencyTarget) * 100, 100) : 0;
  const investmentProgress = investmentTarget > 0 ? Math.min((actualInvested / investmentTarget) * 100, 100) : 0;

  return (
    <div className="rounded-3xl border border-slate-200 dark:border-white/[0.08] bg-card/60 p-6 backdrop-blur-2xl shadow-xl space-y-6">
      {/* Header with Monthly Income Baseline */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white dark:text-white shadow-lg shadow-indigo-500/25 shrink-0">
            <Sparkles className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-base md:text-lg font-bold text-slate-950 dark:text-white tracking-tight">
              Income Advisory • Emergency & Investment
            </h2>
            <p className="text-xs text-slate-600 dark:text-zinc-400">
              Personalized monthly savings and investment targets {monthLabel ? `for ${monthLabel}` : 'based on your income'}
            </p>
          </div>
        </div>

        {/* Income Selector / Modifier */}
        <div className="flex items-center gap-2">
          {!isEditing ? (
            <div className="flex items-center gap-2 bg-white/90 dark:bg-zinc-900/80 px-3.5 py-1.5 rounded-2xl border border-slate-200 dark:border-white/[0.08] shadow-sm">
              <span className="text-xs text-slate-700 dark:text-zinc-300">Monthly Income:</span>
              <span className="text-xs font-bold text-emerald-800 dark:text-emerald-400 font-mono tabular-nums">
                RM {effectiveIncome.toLocaleString('en-MY', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
              </span>
              <button
                onClick={() => setIsEditing(true)}
                className="p-1.5 rounded-lg text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                title="Change monthly income"
              >
                <Edit3 className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <form onSubmit={handleSaveIncome} className="flex items-center gap-1.5">
              <div className="flex items-center bg-white dark:bg-zinc-950 px-2.5 py-1 rounded-xl border border-slate-300 dark:border-zinc-700 text-xs">
                <span className="text-slate-500 dark:text-zinc-400 mr-1 font-bold">RM</span>
                <input
                  type="number"
                  value={customIncome}
                  onChange={(e) => setCustomIncome(e.target.value)}
                  className="w-24 bg-transparent text-slate-950 dark:text-white font-mono outline-none"
                  autoFocus
                />
              </div>
              <button
                type="submit"
                className="p-1.5 rounded-xl bg-indigo-500 hover:bg-indigo-600 text-white dark:text-white cursor-pointer"
              >
                <Check className="h-4 w-4" />
              </button>
            </form>
          )}
        </div>
      </div>

      {/* Two Pillars Grid: Emergency Savings & Investment */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* 1. Emergency Savings Card */}
        <div className="group relative overflow-hidden p-5 rounded-3xl border border-indigo-500/20 bg-gradient-to-br from-indigo-950/20 via-slate-100 dark:via-zinc-900/60 to-white dark:to-zinc-950 backdrop-blur-xl flex flex-col justify-between space-y-4 specular-card hover:border-indigo-500/40 transition-all duration-300 shadow-lg">
          <div className="absolute -right-6 -top-6 h-28 w-28 rounded-full bg-indigo-500/10 blur-2xl pointer-events-none group-hover:bg-indigo-500/20 transition-all" />
          <div className="space-y-3 relative z-10">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="p-2.5 rounded-2xl bg-indigo-500/15 text-indigo-800 dark:text-indigo-400 border border-indigo-500/25 shadow-sm group-hover:scale-105 transition-transform">
                  <ShieldCheck className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-950 dark:text-white tracking-tight">Emergency Savings</h3>
                  <span className="text-xs text-indigo-800 dark:text-indigo-400 font-semibold">Suggested: 20% of Income</span>
                </div>
              </div>
              <span className="text-xs font-mono font-bold px-2.5 py-1 rounded-xl bg-indigo-500/15 text-indigo-800 dark:text-indigo-300 border border-indigo-500/30 shadow-sm">
                20%
              </span>
            </div>

            {/* Current Accumulated Emergency Reserve */}
            <div className="p-3.5 rounded-2xl bg-white/90 dark:bg-zinc-900/70 border border-indigo-500/20 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-600 dark:text-zinc-400 font-medium">Total Emergency Reserve:</span>
                {!isEditingReserve ? (
                  <div className="flex items-center gap-1.5">
                    <span className="font-bold text-slate-950 dark:text-white font-mono text-sm">
                      RM {totalEmergencyReserve.toLocaleString('en-MY', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setReserveInput(currentReserve > 0 ? currentReserve.toString() : '');
                        setIsEditingReserve(true);
                      }}
                      className="p-1 rounded-md text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                      title="Set/Update Current Emergency Fund Balance"
                    >
                      <Edit3 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : (
                  <form onSubmit={handleSaveReserve} className="flex items-center gap-1">
                    <div className="flex items-center bg-white dark:bg-zinc-950 px-2 py-0.5 rounded-lg border border-slate-300 dark:border-zinc-700 text-xs">
                      <span className="text-slate-500 dark:text-zinc-400 mr-1 font-bold">RM</span>
                      <input
                        type="number"
                        value={reserveInput}
                        onChange={(e) => setReserveInput(e.target.value)}
                        placeholder="0"
                        className="w-20 bg-transparent text-slate-950 dark:text-white font-mono outline-none text-xs"
                        autoFocus
                      />
                    </div>
                    <button
                      type="submit"
                      className="p-1 rounded-lg bg-indigo-500 hover:bg-indigo-600 text-white dark:text-white cursor-pointer"
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsEditingReserve(false)}
                      className="p-1 rounded-lg text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white cursor-pointer"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </form>
                )}
              </div>

              {/* Progress towards 6-Month Safety Net Goal */}
              <div className="space-y-1">
                <div className="flex items-center justify-between text-[11px] text-slate-600 dark:text-zinc-400">
                  <span>6-Month Goal (RM {emergencyReserveGoal.toLocaleString('en-MY', { maximumFractionDigits: 0 })}):</span>
                  <span className="font-semibold text-indigo-800 dark:text-indigo-400 font-mono">{reserveGoalProgress.toFixed(0)}% Funded</span>
                </div>
                <div className="h-2 w-full rounded-full bg-slate-100 dark:bg-zinc-800/90 overflow-hidden p-0.5 border border-slate-300 dark:border-zinc-700/40">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-indigo-500 transition-all duration-500 shadow-sm"
                    style={{ width: `${reserveGoalProgress}%` }}
                  />
                </div>
              </div>
            </div>

            {/* Monthly Target and Savings */}
            <div>
              <div className="flex items-baseline gap-2">
                <span className="text-xl md:text-2xl font-black text-slate-950 dark:text-white font-mono">
                  RM {emergencyTarget.toLocaleString('en-MY', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                </span>
                <span className="text-xs text-slate-600 dark:text-zinc-400">/ month target</span>
              </div>
              <p className="text-[11px] text-slate-600 dark:text-zinc-400 mt-1">
                Keep in liquid cash (Versa Cash, KDI Save, GXBank, Rize, Maybank MAE) for unexpected bills.
              </p>
            </div>

            {/* Progress bar for monthly savings */}
            <div className="space-y-1.5 pt-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-600 dark:text-zinc-400">
                  Saved this month: <strong className="text-slate-950 dark:text-white">RM {actualSavedCash.toFixed(2)}</strong>
                </span>
                <span className="text-indigo-800 dark:text-indigo-400 font-semibold">{emergencyProgress.toFixed(0)}%</span>
              </div>
              <div className="h-2 w-full rounded-full bg-slate-100 dark:bg-zinc-800/90 overflow-hidden p-0.5 border border-slate-300 dark:border-zinc-700/40">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-cyan-400 transition-all duration-500 shadow-sm"
                  style={{ width: `${emergencyProgress}%` }}
                />
              </div>
            </div>
          </div>

          <div className="pt-2.5 border-t border-slate-200 dark:border-zinc-800/80 flex items-center justify-between text-xs relative z-10">
            <button
              type="button"
              onClick={() => {
                setEditTransaction(null);
                setQuickAddOpen(true);
              }}
              className="text-xs font-semibold text-indigo-800 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 transition-colors flex items-center gap-1 cursor-pointer"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Record Savings Deposit</span>
            </button>
            <span className="text-[11px] text-slate-500 dark:text-zinc-400 font-mono">
              6M: RM {emergencyReserveGoal.toLocaleString('en-MY', { maximumFractionDigits: 0 })}
            </span>
          </div>
        </div>

        {/* 2. Investment Card */}
        <div className="group relative overflow-hidden p-5 rounded-3xl border border-indigo-500/20 bg-gradient-to-br from-indigo-950/20 via-slate-100 dark:via-zinc-900/60 to-white dark:to-zinc-950 backdrop-blur-xl flex flex-col justify-between space-y-4 specular-card hover:border-indigo-500/40 transition-all duration-300 shadow-lg">
          <div className="absolute -right-6 -top-6 h-28 w-28 rounded-full bg-indigo-500/10 blur-2xl pointer-events-none group-hover:bg-indigo-500/20 transition-all" />
          <div className="space-y-3 relative z-10">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="p-2.5 rounded-2xl bg-indigo-500/15 text-indigo-800 dark:text-indigo-400 border border-indigo-500/25 shadow-sm group-hover:scale-105 transition-transform">
                  <TrendingUp className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-950 dark:text-white tracking-tight">Wealth & Investments</h3>
                  <span className="text-xs text-indigo-800 dark:text-indigo-400 font-semibold">Suggested: 20% of Income</span>
                </div>
              </div>
              <span className="text-xs font-mono font-bold px-2.5 py-1 rounded-xl bg-indigo-500/15 text-indigo-800 dark:text-indigo-300 border border-indigo-500/30 shadow-sm">
                20%
              </span>
            </div>

            <div>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl md:text-3xl font-black text-slate-950 dark:text-white font-mono">
                  RM {investmentTarget.toLocaleString('en-MY', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                </span>
                <span className="text-xs text-slate-600 dark:text-zinc-400">/ month</span>
              </div>
              <p className="text-xs text-slate-600 dark:text-zinc-400 mt-1">
                Auto-DCA into broad market ETFs (S&P 500 VOO/CSPX, Bursa Blue Chips), EPF self-contribution, or dividend stocks.
              </p>
            </div>

            {/* Progress bar */}
            <div className="space-y-1.5 pt-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-600 dark:text-zinc-400">
                  Invested this month: <strong className="text-slate-950 dark:text-white">RM {actualInvested.toFixed(2)}</strong>
                </span>
                <span className="text-indigo-800 dark:text-indigo-400 font-semibold">{investmentProgress.toFixed(0)}%</span>
              </div>
              <div className="h-2 w-full rounded-full bg-slate-100 dark:bg-zinc-800/90 overflow-hidden p-0.5 border border-slate-300 dark:border-zinc-700/40">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-all duration-500 shadow-sm"
                  style={{ width: `${investmentProgress}%` }}
                />
              </div>
            </div>
          </div>

          <div className="pt-3 border-t border-slate-200 dark:border-zinc-800/80 flex items-center justify-between text-xs text-slate-600 dark:text-zinc-400 relative z-10">
            <span>Status:</span>
            <span className={`font-semibold ${actualInvested >= investmentTarget && investmentTarget > 0 ? 'text-emerald-800 dark:text-emerald-400' : 'text-slate-700 dark:text-zinc-300'}`}>
              {actualInvested >= investmentTarget && investmentTarget > 0 ? 'Target Reached! 🚀' : `${((actualInvested / (investmentTarget || 1)) * 100).toFixed(0)}% of monthly goal`}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
