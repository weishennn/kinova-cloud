'use client';

import React, { useState, useEffect } from 'react';
import { Sparkles, Calendar, DollarSign, Target, Globe, Plus, Trash2, Check, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import {
  getUserMoneyProfile,
  updateUserMoneyProfile,
  type UserMoneyProfile,
  type UserGoal,
} from '@/lib/user-money-profile';
import { useTransactions } from '@/hooks/useTransactions';

export function WhatKinovaKnows() {
  const { transactions: allTransactions = [] } = useTransactions();
  const [profile, setProfile] = useState<UserMoneyProfile>(() => getUserMoneyProfile(allTransactions));
  const [newGoalName, setNewGoalName] = useState('');
  const [newGoalAmount, setNewGoalAmount] = useState('');

  useEffect(() => {
    setProfile(getUserMoneyProfile(allTransactions));
  }, [allTransactions]);

  const handleLanguageChange = (lang: UserMoneyProfile['language']) => {
    updateUserMoneyProfile({ language: lang });
    setProfile((prev) => ({ ...prev, language: lang }));
    toast.success('已更新语言偏好');
  };

  const handlePaydayChange = (dayStr: string) => {
    const val = dayStr ? parseInt(dayStr, 10) : null;
    const cleanDay = val && val >= 1 && val <= 31 ? val : null;
    updateUserMoneyProfile({ paydayDay: cleanDay });
    setProfile((prev) => ({ ...prev, paydayDay: cleanDay }));
    toast.success(cleanDay ? `已将每月发薪日设置为 ${cleanDay} 号` : '已清除发薪日');
  };

  const handleAcceptSuggestedPayday = () => {
    if (profile.suggestedPayday) {
      handlePaydayChange(String(profile.suggestedPayday));
    }
  };

  const handleBudgetChange = (budgetStr: string) => {
    const val = budgetStr ? parseFloat(budgetStr) : null;
    updateUserMoneyProfile({ monthlyBudgetCap: val });
    setProfile((prev) => ({ ...prev, monthlyBudgetCap: val }));
  };

  const handleIncomeChange = (incomeStr: string) => {
    const val = incomeStr ? parseFloat(incomeStr) : null;
    updateUserMoneyProfile({ baselineIncome: val });
    setProfile((prev) => ({ ...prev, baselineIncome: val }));
  };

  const handleReserveChange = (reserveStr: string) => {
    const val = reserveStr ? parseFloat(reserveStr) : null;
    updateUserMoneyProfile({ emergencyReserve: val });
    setProfile((prev) => ({ ...prev, emergencyReserve: val }));
  };

  const handleAddGoal = () => {
    const name = newGoalName.trim();
    const amount = parseFloat(newGoalAmount);
    if (!name || !Number.isFinite(amount) || amount <= 0) {
      toast.error('请输入有效的目标名称与目标金额');
      return;
    }
    if (profile.goals.length >= 3) {
      toast.error('最多可设置 3 个理财目标');
      return;
    }
    const newGoal: UserGoal = {
      id: `goal_${Date.now()}`,
      name,
      targetAmount: amount,
      currentAmount: 0,
    };
    const updatedGoals = [...profile.goals, newGoal];
    updateUserMoneyProfile({ goals: updatedGoals });
    setProfile((prev) => ({ ...prev, goals: updatedGoals }));
    setNewGoalName('');
    setNewGoalAmount('');
    toast.success(`已添加目标：「${name}」`);
  };

  const handleRemoveGoal = (id: string) => {
    const updated = profile.goals.filter((g) => g.id !== id);
    updateUserMoneyProfile({ goals: updated });
    setProfile((prev) => ({ ...prev, goals: updated }));
    toast.success('已删除目标');
  };

  const handleUnrejectChip = (text: string) => {
    const updated = profile.rejectedChips.filter((c) => c.text !== text);
    updateUserMoneyProfile({ rejectedChips: updated });
    setProfile((prev) => ({ ...prev, rejectedChips: updated }));
    toast.success(`已恢复「${text}」建议`);
  };

  return (
    <section id="kinova-knows" className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-indigo-500" />
          <h2 className="text-xs font-semibold text-slate-600 dark:text-zinc-400 uppercase tracking-wider">
            What Kinova Knows / 助手个人画像与偏好记忆
          </h2>
        </div>
      </div>

      <div className="rounded-2xl border border-indigo-500/20 bg-white/80 dark:bg-zinc-900/60 backdrop-blur-md p-4 sm:p-5 space-y-5 text-sm shadow-sm">
        <p className="text-xs text-slate-600 dark:text-zinc-400 leading-relaxed">
          这些是 Kinova 在为你思考建议、预测资金流走向及判断开支合理性时所引用的真实基准事实。编辑以下内容会立即更新下一次 AI 上下文与建议行为。
        </p>

        {/* 1. Language Preference */}
        <div className="space-y-2 border-b border-slate-200/80 dark:border-white/[0.06] pb-4">
          <label className="flex items-center gap-2 text-xs font-bold text-slate-800 dark:text-zinc-200">
            <Globe className="h-3.5 w-3.5 text-indigo-500" />
            回答语言风格 (Response Language)
          </label>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {[
              { id: 'auto', label: '自动跟随提问 (Auto)' },
              { id: 'zh', label: '中文 (Chinese)' },
              { id: 'en', label: 'English (MY)' },
              { id: 'ms', label: 'Bahasa Melayu' },
            ].map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => handleLanguageChange(opt.id as any)}
                className={`py-2 px-3 rounded-xl text-xs font-medium border text-center transition-all cursor-pointer ${
                  profile.language === opt.id
                    ? 'bg-indigo-500/15 border-indigo-500/40 text-indigo-900 dark:text-indigo-200 font-semibold'
                    : 'bg-slate-50 dark:bg-zinc-800/50 border-slate-200 dark:border-zinc-700/60 text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* 2. Payday */}
        <div className="space-y-2 border-b border-slate-200/80 dark:border-white/[0.06] pb-4">
          <label className="flex items-center gap-2 text-xs font-bold text-slate-800 dark:text-zinc-200">
            <Calendar className="h-3.5 w-3.5 text-indigo-500" />
            每月发薪日 (Payday)
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-600 dark:text-zinc-400">每月</span>
              <input
                type="number"
                min="1"
                max="31"
                value={profile.paydayDay ?? ''}
                onChange={(e) => handlePaydayChange(e.target.value)}
                placeholder="例如 28"
                className="w-24 px-3 py-1.5 text-xs rounded-xl border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <span className="text-xs text-slate-600 dark:text-zinc-400">号发薪</span>
            </div>

            {profile.suggestedPayday && !profile.paydayDay && (
              <button
                type="button"
                onClick={handleAcceptSuggestedPayday}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-900 dark:text-amber-200 text-xs font-medium hover:bg-amber-500/25 cursor-pointer"
              >
                <span>💡 历史检测发现每月 {profile.suggestedPayday} 号有稳定收入，点击采纳</span>
                <Check className="h-3 w-3" />
              </button>
            )}
          </div>
          {!profile.paydayDay && (
            <p className="text-[11px] text-amber-700 dark:text-amber-300/90">
              当前未设定发薪日。资金流预测不会虚构 25 号发薪，设定后即可在预测中准确计入预计入账。
            </p>
          )}
        </div>

        {/* 3. Budget & Baseline Income */}
        <div className="space-y-3 border-b border-slate-200/80 dark:border-white/[0.06] pb-4">
          <label className="flex items-center gap-2 text-xs font-bold text-slate-800 dark:text-zinc-200">
            <DollarSign className="h-3.5 w-3.5 text-indigo-500" />
            财务基准数字 (Deterministic Baselines)
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <span className="block text-[11px] text-slate-500 dark:text-zinc-400 mb-1">每月支出预算限额</span>
              <input
                type="number"
                value={profile.monthlyBudgetCap ?? ''}
                onChange={(e) => handleBudgetChange(e.target.value)}
                placeholder="例如 3000"
                className="w-full px-3 py-1.5 text-xs rounded-xl border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <span className="block text-[11px] text-slate-500 dark:text-zinc-400 mb-1">基准月收入 (Baseline Income)</span>
              <input
                type="number"
                value={profile.baselineIncome ?? ''}
                onChange={(e) => handleIncomeChange(e.target.value)}
                placeholder="例如 5000"
                className="w-full px-3 py-1.5 text-xs rounded-xl border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <span className="block text-[11px] text-slate-500 dark:text-zinc-400 mb-1">应急储备备用金 (Reserve)</span>
              <input
                type="number"
                value={profile.emergencyReserve ?? ''}
                onChange={(e) => handleReserveChange(e.target.value)}
                placeholder="例如 15000"
                className="w-full px-3 py-1.5 text-xs rounded-xl border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>
        </div>

        {/* 4. Financial Goals */}
        <div className="space-y-3 border-b border-slate-200/80 dark:border-white/[0.06] pb-4">
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-xs font-bold text-slate-800 dark:text-zinc-200">
              <Target className="h-3.5 w-3.5 text-indigo-500" />
              理财目标 (最多 3 个)
            </label>
            <span className="text-[11px] text-slate-500">{profile.goals.length} / 3</span>
          </div>

          <div className="space-y-2">
            {profile.goals.map((g) => (
              <div
                key={g.id}
                className="flex items-center justify-between gap-3 p-2.5 rounded-xl bg-slate-50 dark:bg-zinc-800/40 border border-slate-200/70 dark:border-zinc-700/50"
              >
                <div>
                  <div className="text-xs font-semibold text-slate-900 dark:text-zinc-100">{g.name}</div>
                  <div className="text-[11px] text-slate-500 dark:text-zinc-400">
                    目标金额: RM {g.targetAmount.toFixed(2)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleRemoveGoal(g.id)}
                  className="p-1 rounded-lg text-slate-400 hover:text-rose-500 cursor-pointer"
                  title="删除目标"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}

            {profile.goals.length < 3 && (
              <div className="flex items-center gap-2 pt-1">
                <input
                  type="text"
                  placeholder="目标名称 (如: 日本旅游基金)"
                  value={newGoalName}
                  onChange={(e) => setNewGoalName(e.target.value)}
                  className="flex-1 px-3 py-1.5 text-xs rounded-xl border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <input
                  type="number"
                  placeholder="目标金额 RM"
                  value={newGoalAmount}
                  onChange={(e) => setNewGoalAmount(e.target.value)}
                  className="w-28 px-3 py-1.5 text-xs rounded-xl border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <button
                  type="button"
                  onClick={handleAddGoal}
                  className="px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold flex items-center gap-1 cursor-pointer shrink-0"
                >
                  <Plus className="h-3.5 w-3.5" />
                  添加
                </button>
              </div>
            )}
          </div>
        </div>

        {/* 5. Suppressed Rejected Chips */}
        {profile.rejectedChips.length > 0 && (
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-xs font-bold text-slate-800 dark:text-zinc-200">
              <RefreshCw className="h-3.5 w-3.5 text-slate-500" />
              已屏蔽的快捷习惯 (30天内不重复推荐)
            </label>
            <div className="flex flex-wrap gap-2">
              {profile.rejectedChips.map((c) => (
                <span
                  key={c.text}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-zinc-300 border border-slate-200 dark:border-zinc-700"
                >
                  <span>{c.text}</span>
                  <button
                    type="button"
                    onClick={() => handleUnrejectChip(c.text)}
                    className="text-slate-400 hover:text-indigo-600 font-bold ml-1 cursor-pointer"
                    title="恢复此建议"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
