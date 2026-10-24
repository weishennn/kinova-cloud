'use client';

import React, { useState, useEffect, useMemo } from 'react';
import {
  Tag,
  Trash2,
  Plus,
  Search,
  Sparkles,
  Check,
  Brain,
  ArrowRight,
  Clock,
  ShieldCheck,
} from 'lucide-react';
import {
  getHabitMemories,
  learnOrStrengthenHabit,
  deleteHabitMemory,
  type HabitMemoryItem,
} from '@/lib/habit-memory-engine';
import { SETTINGS_UPDATED_EVENT } from '@/lib/cloud-settings-sync';
import { toast } from 'sonner';

const AVAILABLE_CATEGORIES = [
  'Food & Dining',
  'Transport',
  'Shopping',
  'Housing & Bills',
  'Parents',
  'Insurance',
  'Health',
  'Entertainment',
  'Education',
  'Other',
];

export function MerchantRulesManager() {
  const [habits, setHabits] = useState<HabitMemoryItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [rawPattern, setRawPattern] = useState('');
  const [preferredAlias, setPreferredAlias] = useState('');
  const [category, setCategory] = useState('Food & Dining');
  const [timeSlot, setTimeSlot] = useState<'lunch' | 'dinner' | 'breakfast' | 'any'>('lunch');
  const [isAdding, setIsAdding] = useState(false);

  const loadData = () => {
    setHabits(getHabitMemories());
  };

  useEffect(() => {
    loadData();
    window.addEventListener(SETTINGS_UPDATED_EVENT, loadData);
    return () => window.removeEventListener(SETTINGS_UPDATED_EVENT, loadData);
  }, []);

  const filteredHabits = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return habits;
    return habits.filter(
      (h) =>
        h.rawPattern.toLowerCase().includes(q) ||
        h.preferredAlias.toLowerCase().includes(q) ||
        h.category.toLowerCase().includes(q)
    );
  }, [habits, searchQuery]);

  const handleAddHabit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanRaw = rawPattern.trim();
    if (!cleanRaw) {
      toast.error('请输入转账接收人或商户名（如 abc）');
      return;
    }

    const cleanAlias = preferredAlias.trim() || cleanRaw;
    const created = learnOrStrengthenHabit({
      rawInputOrMerchant: cleanRaw,
      aliasOrDescription: cleanAlias,
      category,
      timeSlot,
      source: 'manual',
    });

    if (created) {
      toast.success(
        cleanRaw.toLowerCase() !== cleanAlias.toLowerCase()
          ? `已记住：以后转给「${cleanRaw}」自动识别为「${cleanAlias}」(${category})`
          : `已记住：以后「${cleanRaw}」默认归类为「${category}」`
      );
      setRawPattern('');
      setPreferredAlias('');
      setIsAdding(false);
      loadData();
    } else {
      toast.error('规则添加失败，请确认输入有效');
    }
  };

  const handleDeleteHabit = (item: HabitMemoryItem) => {
    const success = deleteHabitMemory(item.id);
    if (success) {
      toast.success(`已撤销「${item.rawPattern}」的习惯记忆规则`);
      loadData();
    }
  };

  return (
    <div className="rounded-3xl border border-slate-200 dark:border-white/[0.08] bg-card/60 p-6 backdrop-blur-2xl shadow-xl space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-2xl bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center text-white shadow-lg shadow-purple-500/25 shrink-0">
            <Brain className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-base font-bold text-slate-950 dark:text-white tracking-tight flex items-center gap-2">
              <span>Gemini 习惯记忆与智能体规则中心</span>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-700 dark:text-purple-300 border border-purple-500/30">
                {habits.length} 项已记住
              </span>
            </h2>
            <p className="text-xs text-slate-600 dark:text-zinc-400">
              智能体在后台持续学习你的转账与命名习惯（如转给 <strong>abc</strong> 自动换成 <strong>zapfan</strong> 餐饮），并在快捷指令、快速输入与记账弹窗中主动为你匹配。
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setIsAdding((v) => !v)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-purple-600 hover:bg-purple-700 text-white text-xs font-semibold shadow-sm transition-colors cursor-pointer"
        >
          <Plus className="h-3.5 w-3.5" />
          <span>{isAdding ? '取消' : '添加习惯映射'}</span>
        </button>
      </div>

      {/* Add New Rule Form */}
      {isAdding && (
        <form
          onSubmit={handleAddHabit}
          className="p-4 rounded-2xl bg-slate-50 dark:bg-zinc-900/90 border border-slate-200 dark:border-white/10 space-y-3"
        >
          <div className="text-xs font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
            <Sparkles className="h-4 w-4 text-purple-500" />
            <span>新建转账接收人 ➔ 日常别名与分类记忆</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label className="text-[11px] text-slate-600 dark:text-zinc-400 font-medium block mb-1">
                原始接收人 / 商户名 (e.g. abc)
              </label>
              <input
                type="text"
                value={rawPattern}
                onChange={(e) => setRawPattern(e.target.value)}
                placeholder="例如：abc 或 TAN CHIN HONG"
                className="w-full px-3 py-2 rounded-xl bg-white dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 text-xs text-slate-950 dark:text-white outline-none focus:border-purple-500"
                autoFocus
              />
            </div>
            <div>
              <label className="text-[11px] text-slate-600 dark:text-zinc-400 font-medium block mb-1">
                日常记账别名 (e.g. zapfan)
              </label>
              <input
                type="text"
                value={preferredAlias}
                onChange={(e) => setPreferredAlias(e.target.value)}
                placeholder="例如：zapfan 或 杂饭午餐"
                className="w-full px-3 py-2 rounded-xl bg-white dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 text-xs text-slate-950 dark:text-white outline-none focus:border-purple-500"
              />
            </div>
            <div>
              <label className="text-[11px] text-slate-600 dark:text-zinc-400 font-medium block mb-1">
                默认分类
              </label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full px-3 py-2 rounded-xl bg-white dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 text-xs text-slate-950 dark:text-white outline-none focus:border-purple-500"
              >
                {AVAILABLE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[11px] text-slate-600 dark:text-zinc-400 font-medium block mb-1">
                时段偏好
              </label>
              <select
                value={timeSlot}
                onChange={(e) => setTimeSlot(e.target.value as any)}
                className="w-full px-3 py-2 rounded-xl bg-white dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 text-xs text-slate-950 dark:text-white outline-none focus:border-purple-500"
              >
                <option value="lunch">午餐 (11:30 - 14:30)</option>
                <option value="dinner">晚餐 (17:30 - 21:00)</option>
                <option value="breakfast">早餐 (06:00 - 11:00)</option>
                <option value="any">全天通用</option>
              </select>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setIsAdding(false)}
              className="px-3 py-1.5 rounded-xl border border-slate-200 dark:border-zinc-800 text-slate-700 dark:text-zinc-300 text-xs hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            >
              取消
            </button>
            <button
              type="submit"
              className="px-4 py-1.5 rounded-xl bg-purple-600 hover:bg-purple-700 text-white text-xs font-semibold transition-colors cursor-pointer flex items-center gap-1"
            >
              <Check className="h-3.5 w-3.5" />
              <span>保存习惯记忆</span>
            </button>
          </div>
        </form>
      )}

      {/* Search & List */}
      <div className="space-y-2.5">
        <div className="relative">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400 dark:text-zinc-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索收款人、别名或分类..."
            className="w-full pl-9 pr-3.5 py-2 rounded-xl bg-slate-50 dark:bg-zinc-900/60 border border-slate-200 dark:border-white/[0.08] text-xs text-slate-950 dark:text-white outline-none"
          />
        </div>

        {filteredHabits.length > 0 ? (
          <div className="divide-y divide-slate-100 dark:divide-zinc-800/60 border border-slate-200 dark:border-white/[0.08] rounded-2xl overflow-hidden bg-white/70 dark:bg-zinc-900/40">
            {filteredHabits.map((item) => {
              const isAlias = item.rawPattern.toLowerCase() !== item.preferredAlias.toLowerCase();
              return (
                <div
                  key={item.id}
                  className="flex items-center justify-between p-3 hover:bg-slate-50 dark:hover:bg-zinc-800/40 transition-colors text-xs"
                >
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    <span className="font-semibold text-slate-900 dark:text-white truncate">
                      {item.rawPattern}
                    </span>

                    {isAlias ? (
                      <>
                        <ArrowRight className="h-3.5 w-3.5 text-purple-500 shrink-0" />
                        <span className="font-bold text-purple-700 dark:text-purple-300 px-2 py-0.5 rounded-md bg-purple-500/15 border border-purple-500/30">
                          {item.preferredAlias}
                        </span>
                      </>
                    ) : (
                      <span className="text-slate-400 dark:text-zinc-500">➔</span>
                    )}

                    <span className="px-2 py-0.5 rounded-md bg-indigo-50 dark:bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-500/30 text-[11px] font-medium shrink-0">
                      {item.category}
                    </span>

                    {item.timeSlot && item.timeSlot !== 'any' && (
                      <span className="text-[10px] text-slate-500 dark:text-zinc-400 px-1.5 py-0.5 rounded bg-slate-100 dark:bg-zinc-800">
                        {item.timeSlot === 'lunch' ? '🍱 午餐' : item.timeSlot === 'dinner' ? '🍲 晚餐' : '☕ 早餐'}
                      </span>
                    )}

                    <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-mono hidden sm:inline">
                      {item.learnedSource === 'auto_learned' ? '🤖 自动学习' : '👤 用户设定'}
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={() => handleDeleteHabit(item)}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-500/10 transition-colors cursor-pointer shrink-0"
                    title="撤销/删除此记忆规则"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-center py-8 text-xs text-slate-500 dark:text-zinc-400 space-y-1">
            <p>暂无匹配的习惯记忆</p>
            <p className="text-[11px] text-slate-400 dark:text-zinc-500">
              在修改账单名称或接收人时，Gemini 智能体会自动学习并沉淀在习惯库中。
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
