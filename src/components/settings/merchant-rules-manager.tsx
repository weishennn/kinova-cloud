'use client';

import React, { useState, useEffect, useMemo } from 'react';
import {
  Trash2,
  Plus,
  Search,
  Sparkles,
  Check,
  Brain,
  ArrowRight,
  Wand2,
  Loader2,
  Tag,
  X,
  Merge,
} from 'lucide-react';
import {
  getHabitMemories,
  getHabitCandidates,
  learnOrStrengthenHabit,
  deleteHabitMemory,
  clearNonManualHabits,
  updateHabitKeywords,
  saveAllHabitMemories,
  saveAllHabitCandidates,
  type HabitCandidateRecord,
  type HabitMemoryItem,
} from '@/lib/habit-memory-engine';
import {
  summarizeLedgerPatternsForHabitOptimization,
  applyHabitOptimizationPlan,
  type ValidatedHabitOptimizationPlan,
} from '@/lib/habit-optimizer';
import { useTransactions } from '@/hooks/useTransactions';
import { getUserMoneyProfile } from '@/lib/user-money-profile';
import { SETTINGS_UPDATED_EVENT } from '@/lib/cloud-settings-sync';
import { confirmAction } from '@/stores/confirm-dialog-store';
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
  'Sport',
  'Gift',
  'Other',
];

function splitKeywordInput(raw: string): string[] {
  return raw
    .split(/[,，、;；\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function MerchantRulesManager() {
  const { transactions = [] } = useTransactions();
  const [habits, setHabits] = useState<HabitMemoryItem[]>([]);
  const [candidates, setCandidates] = useState<HabitCandidateRecord[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [rawPattern, setRawPattern] = useState('');
  const [preferredAlias, setPreferredAlias] = useState('');
  const [keywordsInput, setKeywordsInput] = useState('');
  const [category, setCategory] = useState('Food & Dining');
  const [timeSlot, setTimeSlot] = useState<'lunch' | 'dinner' | 'breakfast' | 'any'>('lunch');
  const [isAdding, setIsAdding] = useState(false);

  // Inline keyword editor state for existing habit rows
  const [editingKeywordsId, setEditingKeywordsId] = useState<string | null>(null);
  const [editingKeywordsText, setEditingKeywordsText] = useState('');

  // AI Optimizer state
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [pendingPlan, setPendingPlan] = useState<{
    plan: ValidatedHabitOptimizationPlan;
    model?: string;
  } | null>(null);
  const [excludedOpKeys, setExcludedOpKeys] = useState<Set<string>>(new Set());

  const loadData = () => {
    setHabits(getHabitMemories());
    setCandidates(getHabitCandidates());
  };

  useEffect(() => {
    const syncId = window.setTimeout(loadData, 0);
    window.addEventListener(SETTINGS_UPDATED_EVENT, loadData);
    return () => {
      window.clearTimeout(syncId);
      window.removeEventListener(SETTINGS_UPDATED_EVENT, loadData);
    };
  }, []);

  const filteredHabits = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return habits;
    return habits.filter((h) => {
      const kwMatch = Array.isArray(h.keywords)
        ? h.keywords.some((k) => k.toLowerCase().includes(q))
        : false;
      return (
        h.rawPattern.toLowerCase().includes(q) ||
        h.preferredAlias.toLowerCase().includes(q) ||
        h.category.toLowerCase().includes(q) ||
        kwMatch
      );
    });
  }, [habits, searchQuery]);

  const handleAddHabit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanRaw = rawPattern.trim();
    if (!cleanRaw) {
      toast.error('请输入转账接收人或商户名（如 abc）');
      return;
    }

    const cleanAlias = preferredAlias.trim() || cleanRaw;
    const parsedKeywords = splitKeywordInput(keywordsInput);
    const created = learnOrStrengthenHabit({
      rawInputOrMerchant: cleanRaw,
      aliasOrDescription: cleanAlias,
      category,
      timeSlot,
      keywords: parsedKeywords,
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
      setKeywordsInput('');
      setIsAdding(false);
      loadData();
    } else {
      toast.error('规则添加失败，请确认输入有效且不含长小票明细');
    }
  };

  const handleSaveInlineKeywords = (item: HabitMemoryItem) => {
    const parsed = splitKeywordInput(editingKeywordsText);
    const updated = updateHabitKeywords(item.id, parsed);
    if (updated) {
      toast.success(`已更新「${item.preferredAlias}」的触发字眼`);
      setEditingKeywordsId(null);
      setEditingKeywordsText('');
      loadData();
    }
  };

  const handleDeleteHabit = (item: HabitMemoryItem) => {
    const success = deleteHabitMemory(item.id);
    if (success) {
      toast.success(`已撤销「${item.rawPattern}」的习惯记忆规则`);
      loadData();
    }
  };

  const nonManualCount = useMemo(
    () => habits.filter((h) => h.learnedSource !== 'manual').length,
    [habits]
  );

  const handleClearAutoHabits = async () => {
    if (nonManualCount <= 0) return;
    const confirmed = await confirmAction({
      title: '清理自动学习记忆',
      description: `将清除 ${nonManualCount} 条自动学习 / 对话确认产生的规则，并保留你在设置中手动添加的固定规则。确认继续吗？`,
      confirmText: '确认清理',
      cancelText: '取消',
      variant: 'warning',
      icon: 'trash',
    });
    if (!confirmed) return;

    const { removed } = clearNonManualHabits();
    loadData();
    toast.success(
      removed > 0
        ? `已清理 ${removed} 条自动生成的记忆规则（手动规则已保留）`
        : '当前没有可清理的自动规则'
    );
  };

  const handleRunAiOptimize = async () => {
    if (isOptimizing) return;
    setIsOptimizing(true);
    try {
      const currentHabits = getHabitMemories();
      const currentCandidates = getHabitCandidates();
      const recentPatterns = summarizeLedgerPatternsForHabitOptimization(
        transactions,
        currentHabits
      );
      const profile = getUserMoneyProfile(transactions);

      const res = await fetch('/api/ai/optimize-habits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          habits: currentHabits,
          candidates: currentCandidates,
          recentPatterns,
          language: profile.language || 'zh',
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success || !json.data) {
        throw new Error(json?.error || `AI 优化请求失败 (${res.status})`);
      }

      const plan = json.data as ValidatedHabitOptimizationPlan;
      const safePlan: ValidatedHabitOptimizationPlan = {
        summary: plan.summary || '',
        drops: Array.isArray(plan.drops) ? plan.drops : [],
        merges: Array.isArray(plan.merges) ? plan.merges : [],
        updates: Array.isArray(plan.updates) ? plan.updates : [],
        additions: Array.isArray(plan.additions) ? plan.additions : [],
        clearCandidateKeys: Array.isArray(plan.clearCandidateKeys) ? plan.clearCandidateKeys : [],
        hasChanges: Boolean(
          plan.hasChanges ||
            (plan.drops?.length || 0) +
              (plan.merges?.length || 0) +
              (plan.updates?.length || 0) +
              (plan.additions?.length || 0) >
              0
        ),
      };
      setExcludedOpKeys(new Set());
      setPendingPlan({ plan: safePlan, model: json.model });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'AI 优化记忆失败，请稍后重试');
    } finally {
      setIsOptimizing(false);
    }
  };

  const toggleOpSelection = (opKey: string) => {
    setExcludedOpKeys((prev) => {
      const next = new Set(prev);
      if (next.has(opKey)) next.delete(opKey);
      else next.add(opKey);
      return next;
    });
  };

  const selectedPlanCount = useMemo(() => {
    if (!pendingPlan) return 0;
    const p = pendingPlan.plan;
    let count = 0;
    p.drops.forEach((d) => {
      if (!excludedOpKeys.has(`drop:${d.id}`)) count += 1;
    });
    p.merges.forEach((m) => {
      if (!excludedOpKeys.has(`merge:${m.keepId}`)) count += 1;
    });
    p.updates.forEach((u) => {
      if (!excludedOpKeys.has(`update:${u.id}`)) count += 1;
    });
    p.additions.forEach((a) => {
      if (!excludedOpKeys.has(`add:${a.rawPattern}`)) count += 1;
    });
    return count;
  }, [pendingPlan, excludedOpKeys]);

  const handleApplyAiPlan = () => {
    if (!pendingPlan) return;
    const rawPlan = pendingPlan.plan;
    const filteredPlan: ValidatedHabitOptimizationPlan = {
      ...rawPlan,
      drops: rawPlan.drops.filter((d) => !excludedOpKeys.has(`drop:${d.id}`)),
      merges: rawPlan.merges.filter((m) => !excludedOpKeys.has(`merge:${m.keepId}`)),
      updates: rawPlan.updates.filter((u) => !excludedOpKeys.has(`update:${u.id}`)),
      additions: rawPlan.additions.filter((a) => !excludedOpKeys.has(`add:${a.rawPattern}`)),
      hasChanges: selectedPlanCount > 0,
    };

    const currentHabits = getHabitMemories();
    const currentCandidates = getHabitCandidates();
    const { nextHabits, nextCandidates, stats } = applyHabitOptimizationPlan(
      currentHabits,
      currentCandidates,
      filteredPlan
    );

    saveAllHabitMemories(nextHabits);
    saveAllHabitCandidates(nextCandidates);
    setPendingPlan(null);
    setExcludedOpKeys(new Set());
    loadData();

    toast.success(
      `✨ 已应用 AI 优化：移除 ${stats.dropped} · 合并 ${stats.merged} · 补充字眼/更新 ${stats.updated} · 新提炼 ${stats.added}`
    );
  };

  return (
    <div className="rounded-3xl border border-slate-200 dark:border-white/[0.08] bg-card/60 p-4 sm:p-6 backdrop-blur-2xl shadow-xl space-y-5 min-w-0 overflow-hidden">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0 sm:flex-1">
          <div className="h-10 w-10 rounded-2xl bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center text-white shadow-lg shadow-purple-500/25 shrink-0">
            <Brain className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-bold text-slate-950 dark:text-white tracking-tight flex flex-wrap items-center gap-2">
              <span>Gemini 习惯记忆与智能体规则中心</span>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-700 dark:text-purple-300 border border-purple-500/30 shrink-0">
                {habits.length} 项已记住
              </span>
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-600 dark:text-zinc-400">
              不会全盘乱记。支持<strong>触发字眼 / 简称</strong>（如只打 <strong>四夕</strong>、<strong>zanmai</strong>、<strong>tanchinhong</strong>），也可让 Gemini 智能去杂、合并同类项与提炼常用字眼。
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0 sm:pt-0.5">
          <button
            type="button"
            onClick={() => void handleRunAiOptimize()}
            disabled={isOptimizing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 disabled:opacity-60 text-white text-xs font-semibold shadow-sm transition-all cursor-pointer"
          >
            {isOptimizing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Wand2 className="h-3.5 w-3.5" />
            )}
            <span>{isOptimizing ? 'AI 审查优化中...' : 'AI 优化记忆'}</span>
          </button>

          {nonManualCount > 0 && (
            <button
              type="button"
              onClick={() => void handleClearAutoHabits()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white/80 dark:bg-zinc-900/70 hover:border-rose-300 hover:bg-rose-50 dark:hover:bg-rose-500/15 hover:text-rose-600 dark:hover:text-rose-400 text-slate-700 dark:text-zinc-300 text-xs font-medium transition-colors cursor-pointer"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>清理自动记忆 ({nonManualCount})</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => setIsAdding((v) => !v)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-purple-600 hover:bg-purple-700 text-white text-xs font-semibold shadow-sm transition-colors cursor-pointer"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>{isAdding ? '取消' : '添加习惯映射'}</span>
          </button>
        </div>
      </div>

      {/* Staged candidates hint */}
      {candidates.length > 0 && !pendingPlan && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 rounded-2xl bg-indigo-50/80 dark:bg-indigo-500/10 border border-indigo-200/80 dark:border-indigo-500/25 text-xs text-indigo-900 dark:text-indigo-200">
          <span>
            💡 当前有 <strong>{candidates.length}</strong> 条消费词正在观察区待筛选，可点击「<strong>AI 优化记忆</strong>」让 Gemini 筛选真正值得记住的模式与字眼。
          </span>
        </div>
      )}

      {/* Pending AI Optimization Plan Diff Card */}
      {pendingPlan && (
        <div className="p-4 rounded-2xl border border-indigo-300 dark:border-indigo-500/40 bg-indigo-50/70 dark:bg-indigo-950/30 space-y-3 min-w-0">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="space-y-1 min-w-0 flex-1">
              <div className="text-xs font-bold text-indigo-950 dark:text-indigo-200 flex flex-wrap items-center gap-1.5">
                <Sparkles className="h-4 w-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
                <span>Gemini 记忆审查与优化建议</span>
                {pendingPlan.model && (
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/80 dark:bg-zinc-900 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-500/30">
                    {pendingPlan.model}
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-700 dark:text-zinc-300 leading-relaxed break-words">
                {pendingPlan.plan.summary}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setPendingPlan(null)}
              className="p-1 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-white cursor-pointer shrink-0"
              title="关闭建议"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {!pendingPlan.plan.hasChanges ? (
            <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/30 text-xs text-emerald-900 dark:text-emerald-200 flex items-center justify-between gap-2">
              <span>✅ 当前习惯记忆已经很精简且触发字眼合理，暂无需清理或调整。</span>
              <button
                type="button"
                onClick={() => setPendingPlan(null)}
                className="px-2.5 py-1 rounded-lg bg-emerald-600 text-white text-[11px] font-semibold cursor-pointer shrink-0"
              >
                好的
              </button>
            </div>
          ) : (
            <div className="space-y-2.5">
              {/* Drops */}
              {pendingPlan.plan.drops.map((d) => {
                const key = `drop:${d.id}`;
                const checked = !excludedOpKeys.has(key);
                return (
                  <label
                    key={key}
                    className="flex items-start gap-2.5 p-2.5 rounded-xl bg-rose-50/90 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/30 text-xs cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleOpSelection(key)}
                      className="mt-0.5 rounded accent-rose-600 shrink-0"
                    />
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="font-semibold text-rose-900 dark:text-rose-200 flex flex-wrap items-center gap-1.5">
                        <span className="px-1.5 py-0.5 rounded bg-rose-500/20 text-[10px]">建议移除</span>
                        <span className="line-through break-words">{d.rawPattern}</span>
                        {d.preferredAlias !== d.rawPattern && (
                          <span className="text-slate-600 dark:text-zinc-400">({d.preferredAlias})</span>
                        )}
                      </div>
                      <p className="text-[11px] text-rose-800/80 dark:text-rose-300/80 break-words">
                        原因：{d.reason}
                      </p>
                    </div>
                  </label>
                );
              })}

              {/* Merges */}
              {pendingPlan.plan.merges.map((m) => {
                const key = `merge:${m.keepId}`;
                const checked = !excludedOpKeys.has(key);
                return (
                  <label
                    key={key}
                    className="flex items-start gap-2.5 p-2.5 rounded-xl bg-amber-50/90 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 text-xs cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleOpSelection(key)}
                      className="mt-0.5 rounded accent-amber-600 shrink-0"
                    />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="font-semibold text-amber-950 dark:text-amber-200 flex flex-wrap items-center gap-1.5">
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/20 text-[10px]">
                          <Merge className="h-3 w-3" />
                          合并规则
                        </span>
                        <span className="break-words">
                          {m.rawPattern} → {m.preferredAlias} ({m.category})
                        </span>
                      </div>
                      {m.keywords.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {m.keywords.map((kw) => (
                            <span
                              key={kw}
                              className="px-1.5 py-0.5 rounded bg-white/80 dark:bg-zinc-900 border border-amber-300/70 dark:border-amber-500/30 text-[10px] font-medium text-amber-900 dark:text-amber-300"
                            >
                              字眼: {kw}
                            </span>
                          ))}
                        </div>
                      )}
                      <p className="text-[11px] text-amber-900/80 dark:text-amber-300/80 break-words">
                        {m.reason}
                      </p>
                    </div>
                  </label>
                );
              })}

              {/* Updates */}
              {pendingPlan.plan.updates.map((u) => {
                const key = `update:${u.id}`;
                const checked = !excludedOpKeys.has(key);
                return (
                  <label
                    key={key}
                    className="flex items-start gap-2.5 p-2.5 rounded-xl bg-white/90 dark:bg-zinc-900/80 border border-indigo-200 dark:border-indigo-500/30 text-xs cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleOpSelection(key)}
                      className="mt-0.5 rounded accent-indigo-600 shrink-0"
                    />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="font-semibold text-slate-900 dark:text-white flex flex-wrap items-center gap-1.5">
                        <span className="px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-700 dark:text-indigo-300 text-[10px]">
                          优化字眼/别名
                        </span>
                        <span className="break-words">{u.rawPattern}</span>
                        <ArrowRight className="h-3 w-3 text-indigo-500 shrink-0" />
                        <span className="text-indigo-700 dark:text-indigo-300 break-words">
                          {u.preferredAlias} ({u.category})
                        </span>
                      </div>
                      {u.keywords.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {u.keywords.map((kw) => (
                            <span
                              key={kw}
                              className="px-1.5 py-0.5 rounded bg-indigo-500/10 border border-indigo-500/25 text-[10px] font-medium text-indigo-800 dark:text-indigo-200"
                            >
                              字眼: {kw}
                            </span>
                          ))}
                        </div>
                      )}
                      <p className="text-[11px] text-slate-600 dark:text-zinc-400 break-words">
                        {u.reason}
                      </p>
                    </div>
                  </label>
                );
              })}

              {/* Additions */}
              {pendingPlan.plan.additions.map((a) => {
                const key = `add:${a.rawPattern}`;
                const checked = !excludedOpKeys.has(key);
                return (
                  <label
                    key={key}
                    className="flex items-start gap-2.5 p-2.5 rounded-xl bg-emerald-50/90 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/30 text-xs cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleOpSelection(key)}
                      className="mt-0.5 rounded accent-emerald-600 shrink-0"
                    />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="font-semibold text-emerald-950 dark:text-emerald-200 flex flex-wrap items-center gap-1.5">
                        <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-[10px]">
                          AI 提炼新增
                        </span>
                        <span className="break-words">{a.rawPattern}</span>
                        {a.preferredAlias !== a.rawPattern && (
                          <>
                            <ArrowRight className="h-3 w-3 text-emerald-500 shrink-0" />
                            <span className="break-words">{a.preferredAlias}</span>
                          </>
                        )}
                        <span className="text-[11px] font-normal">({a.category})</span>
                      </div>
                      {a.keywords.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {a.keywords.map((kw) => (
                            <span
                              key={kw}
                              className="px-1.5 py-0.5 rounded bg-white/80 dark:bg-zinc-900 border border-emerald-300/70 dark:border-emerald-500/30 text-[10px] font-medium text-emerald-800 dark:text-emerald-300"
                            >
                              字眼: {kw}
                            </span>
                          ))}
                        </div>
                      )}
                      <p className="text-[11px] text-emerald-900/80 dark:text-emerald-300/80 break-words">
                        {a.reason}
                      </p>
                    </div>
                  </label>
                );
              })}

              <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setPendingPlan(null)}
                  className="px-3 py-1.5 rounded-xl border border-slate-300 dark:border-zinc-700 text-xs font-medium text-slate-700 dark:text-zinc-300 hover:bg-white/80 dark:hover:bg-zinc-800 cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={selectedPlanCount === 0}
                  onClick={handleApplyAiPlan}
                  className="px-4 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-1.5 shadow-sm cursor-pointer"
                >
                  <Check className="h-3.5 w-3.5" />
                  <span>确认应用优化 ({selectedPlanCount} 项)</span>
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Add New Rule Form */}
      {isAdding && (
        <form
          onSubmit={handleAddHabit}
          className="p-4 rounded-2xl bg-slate-50 dark:bg-zinc-900/90 border border-slate-200 dark:border-white/10 space-y-3"
        >
          <div className="text-xs font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
            <Sparkles className="h-4 w-4 text-purple-500" />
            <span>新建转账接收人 ➔ 日常别名、触发字眼与分类记忆</span>
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
                placeholder="例如：zapfan 或 四夕豆花"
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
                onChange={(e) =>
                  setTimeSlot(e.target.value as 'lunch' | 'dinner' | 'breakfast' | 'any')
                }
                className="w-full px-3 py-2 rounded-xl bg-white dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 text-xs text-slate-950 dark:text-white outline-none focus:border-purple-500"
              >
                <option value="lunch">午餐 (11:30 - 14:30)</option>
                <option value="dinner">晚餐 (17:30 - 21:00)</option>
                <option value="breakfast">早餐 (06:00 - 11:00)</option>
                <option value="any">全天通用</option>
              </select>
            </div>
          </div>

          <div>
            <label className="text-[11px] text-slate-600 dark:text-zinc-400 font-medium block mb-1">
              日常简称 / 触发字眼（可选，逗号分隔）
            </label>
            <input
              type="text"
              value={keywordsInput}
              onChange={(e) => setKeywordsInput(e.target.value)}
              placeholder="例如：四夕, tanchinhong, tnh（以后记账时只打这些字眼也能命中）"
              className="w-full px-3 py-2 rounded-xl bg-white dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 text-xs text-slate-950 dark:text-white outline-none focus:border-purple-500"
            />
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
            placeholder="搜索收款人、别名、触发字眼或分类..."
            className="w-full pl-9 pr-3.5 py-2 rounded-xl bg-slate-50 dark:bg-zinc-900/60 border border-slate-200 dark:border-white/[0.08] text-xs text-slate-950 dark:text-white outline-none"
          />
        </div>

        {filteredHabits.length > 0 ? (
          <div className="divide-y divide-slate-100 dark:divide-zinc-800/60 border border-slate-200 dark:border-white/[0.08] rounded-2xl overflow-hidden bg-white/70 dark:bg-zinc-900/40">
            {filteredHabits.map((item) => {
              const isAlias = item.rawPattern.toLowerCase() !== item.preferredAlias.toLowerCase();
              const isEditingThisKeywords = editingKeywordsId === item.id;
              return (
                <div
                  key={item.id}
                  className="p-3 hover:bg-slate-50 dark:hover:bg-zinc-800/40 transition-colors text-xs min-w-0 space-y-1.5"
                >
                  <div className="flex items-start justify-between gap-2 min-w-0">
                    <div className="flex flex-wrap items-center gap-2 min-w-0 flex-1">
                      <span className="font-semibold text-slate-900 dark:text-white break-words max-w-full">
                        {item.rawPattern}
                      </span>

                      {isAlias ? (
                        <>
                          <ArrowRight className="h-3.5 w-3.5 text-purple-500 shrink-0" />
                          <span className="font-bold text-purple-700 dark:text-purple-300 px-2 py-0.5 rounded-md bg-purple-500/15 border border-purple-500/30 break-words max-w-full">
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

                      <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-mono shrink-0">
                        {item.learnedSource === 'auto_learned'
                          ? '🤖 自动习得'
                          : item.learnedSource === 'user_confirmed'
                            ? '✨ 对话确认'
                            : '👤 手动规则'}
                      </span>

                      {item.frequency > 1 && (
                        <span className="text-[10px] text-slate-500 dark:text-zinc-400 font-mono px-1.5 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 shrink-0">
                          命中 {item.frequency} 次
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => {
                          if (isEditingThisKeywords) {
                            setEditingKeywordsId(null);
                          } else {
                            setEditingKeywordsId(item.id);
                            setEditingKeywordsText((item.keywords || []).join(', '));
                          }
                        }}
                        className="px-2 py-1 rounded-lg text-[10px] font-medium text-indigo-600 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-500/15 transition-colors cursor-pointer flex items-center gap-1"
                        title="编辑触发字眼 / 简称"
                      >
                        <Tag className="h-3 w-3" />
                        <span>字眼</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleDeleteHabit(item)}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-500/10 transition-colors cursor-pointer"
                        title="撤销/删除此记忆规则"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>

                  {/* Keywords badges & AI note */}
                  {((Array.isArray(item.keywords) && item.keywords.length > 0) || item.aiNote) && !isEditingThisKeywords && (
                    <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                      {Array.isArray(item.keywords) &&
                        item.keywords.map((kw) => (
                          <span
                            key={kw}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-100 dark:bg-zinc-800 text-[10px] font-medium text-slate-700 dark:text-zinc-300 border border-slate-200 dark:border-zinc-700"
                          >
                            <Tag className="h-2.5 w-2.5 text-purple-500" />
                            <span>{kw}</span>
                          </span>
                        ))}
                      {item.aiNote && (
                        <span className="text-[10px] text-slate-500 dark:text-zinc-400 break-words">
                          · {item.aiNote}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Inline keyword editor */}
                  {isEditingThisKeywords && (
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <input
                        type="text"
                        value={editingKeywordsText}
                        onChange={(e) => setEditingKeywordsText(e.target.value)}
                        placeholder="逗号分隔触发字眼（如：四夕, tanchinhong）"
                        className="flex-1 min-w-[160px] px-2.5 py-1.5 rounded-xl bg-white dark:bg-zinc-950 border border-indigo-300 dark:border-indigo-500/40 text-xs text-slate-900 dark:text-white outline-none"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleSaveInlineKeywords(item);
                          } else if (e.key === 'Escape') {
                            setEditingKeywordsId(null);
                          }
                        }}
                        autoFocus
                      />
                      <button
                        type="button"
                        onClick={() => handleSaveInlineKeywords(item)}
                        className="px-2.5 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-[11px] font-semibold cursor-pointer"
                      >
                        保存字眼
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingKeywordsId(null)}
                        className="px-2 py-1.5 rounded-xl border border-slate-200 dark:border-zinc-700 text-slate-600 dark:text-zinc-300 text-[11px] cursor-pointer"
                      >
                        取消
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-center py-8 text-xs text-slate-500 dark:text-zinc-400 space-y-1">
            <p>暂无匹配的习惯记忆</p>
            <p className="text-[11px] text-slate-400 dark:text-zinc-500">
              当你连续 2 次以上使用同一收款人别名或非默认分类，或点击「AI 优化记忆」时，高价值习惯才会沉淀到这里。
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
