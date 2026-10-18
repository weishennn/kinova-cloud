'use client';

import React, { useState, useEffect, useMemo } from 'react';
import {
  Tag,
  Trash2,
  Plus,
  Search,
  Sparkles,
  Check,
  RotateCcw,
} from 'lucide-react';
import {
  getMerchantCategoryRules,
  saveMerchantCategoryRule,
  deleteMerchantCategoryRule,
  MerchantCategoryRule,
} from '@/lib/merchant-rules';
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
  const [rules, setRules] = useState<MerchantCategoryRule[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [newMerchant, setNewMerchant] = useState('');
  const [newCategory, setNewCategory] = useState('Food & Dining');
  const [isAdding, setIsAdding] = useState(false);

  const loadRules = () => {
    setRules(getMerchantCategoryRules());
  };

  useEffect(() => {
    loadRules();
    window.addEventListener(SETTINGS_UPDATED_EVENT, loadRules);
    return () => window.removeEventListener(SETTINGS_UPDATED_EVENT, loadRules);
  }, []);

  const filteredRules = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return rules;
    return rules.filter(
      (r) =>
        r.merchantPattern.toLowerCase().includes(q) ||
        r.category.toLowerCase().includes(q)
    );
  }, [rules, searchQuery]);

  const handleAddRule = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMerchant.trim()) {
      toast.error('请输入商户或消费名称');
      return;
    }
    const created = saveMerchantCategoryRule(newMerchant, newCategory);
    if (created) {
      toast.success(`已记住：以后「${created.merchantPattern}」默认归类为「${created.category}」`);
      setNewMerchant('');
      setIsAdding(false);
      loadRules();
    } else {
      toast.error('规则添加失败，请确认商户名有效');
    }
  };

  const handleDeleteRule = (rule: MerchantCategoryRule) => {
    const success = deleteMerchantCategoryRule(rule.id);
    if (success) {
      toast.success(`已撤销「${rule.merchantPattern}」的分类记忆规则`);
      loadRules();
    }
  };

  return (
    <div className="rounded-3xl border border-slate-200 dark:border-white/[0.08] bg-card/60 p-6 backdrop-blur-2xl shadow-xl space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-2xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center text-white shadow-lg shadow-orange-500/25 shrink-0">
            <Tag className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-base font-bold text-slate-950 dark:text-white tracking-tight flex items-center gap-2">
              <span>商户分类记忆规则 (Merchant Memory)</span>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30">
                {rules.length} 条已记住
              </span>
            </h2>
            <p className="text-xs text-slate-600 dark:text-zinc-400">
              你在记账时改过的商户分类将自动沉淀为记忆规则。下次录入或扫描时，优先匹配你的个人习惯。
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setIsAdding((v) => !v)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-indigo-500 hover:bg-indigo-600 text-white text-xs font-semibold shadow-sm transition-colors cursor-pointer"
        >
          <Plus className="h-3.5 w-3.5" />
          <span>{isAdding ? '取消' : '添加新规则'}</span>
        </button>
      </div>

      {/* Add New Rule Form */}
      {isAdding && (
        <form
          onSubmit={handleAddRule}
          className="p-4 rounded-2xl bg-slate-50 dark:bg-zinc-900/90 border border-slate-200 dark:border-white/10 space-y-3"
        >
          <div className="text-xs font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
            <Sparkles className="h-4 w-4 text-indigo-500" />
            <span>新建商户与分类记忆映射</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] text-slate-600 dark:text-zinc-400 font-medium block mb-1">
                商户/店铺名称关键字 (e.g. 四夕豆花, Shell, Jaya Grocer)
              </label>
              <input
                type="text"
                value={newMerchant}
                onChange={(e) => setNewMerchant(e.target.value)}
                placeholder="例如：四夕豆花"
                className="w-full px-3 py-2 rounded-xl bg-white dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 text-xs text-slate-950 dark:text-white outline-none focus:border-indigo-500"
                autoFocus
              />
            </div>
            <div>
              <label className="text-[11px] text-slate-600 dark:text-zinc-400 font-medium block mb-1">
                默认归属分类
              </label>
              <select
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                className="w-full px-3 py-2 rounded-xl bg-white dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 text-xs text-slate-950 dark:text-white outline-none focus:border-indigo-500"
              >
                {AVAILABLE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
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
              className="px-4 py-1.5 rounded-xl bg-indigo-500 hover:bg-indigo-600 text-white text-xs font-semibold transition-colors cursor-pointer flex items-center gap-1"
            >
              <Check className="h-3.5 w-3.5" />
              <span>保存记忆规则</span>
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
            placeholder="搜索商户名或分类..."
            className="w-full pl-9 pr-3.5 py-2 rounded-xl bg-slate-50 dark:bg-zinc-900/60 border border-slate-200 dark:border-white/[0.08] text-xs text-slate-950 dark:text-white outline-none"
          />
        </div>

        {filteredRules.length > 0 ? (
          <div className="divide-y divide-slate-100 dark:divide-zinc-800/60 border border-slate-200 dark:border-white/[0.08] rounded-2xl overflow-hidden bg-white/70 dark:bg-zinc-900/40">
            {filteredRules.map((rule) => (
              <div
                key={rule.id}
                className="flex items-center justify-between p-3 hover:bg-slate-50 dark:hover:bg-zinc-800/40 transition-colors text-xs"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="font-semibold text-slate-900 dark:text-white truncate">
                    {rule.merchantPattern}
                  </span>
                  <span className="text-slate-400 dark:text-zinc-500">➔</span>
                  <span className="px-2 py-0.5 rounded-md bg-indigo-50 dark:bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-500/30 text-[11px] font-medium shrink-0">
                    {rule.category}
                  </span>
                  {rule.createdAt && (
                    <span className="text-[10px] text-slate-400 dark:text-zinc-500 hidden sm:inline">
                      ({rule.createdAt.slice(0, 10)})
                    </span>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => handleDeleteRule(rule)}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-500/10 transition-colors cursor-pointer shrink-0"
                  title="撤销/删除此记忆规则"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-8 text-xs text-slate-500 dark:text-zinc-400 space-y-1">
            <p>暂无匹配的商户分类规则</p>
            <p className="text-[11px] text-slate-400 dark:text-zinc-500">
              在修改账单分类时勾选“记住分类”，规则就会自动出现在这里。
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
