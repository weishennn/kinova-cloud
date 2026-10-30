/**
 * Local Intent Router for Kinova.
 *
 * Runs completely locally with 0ms latency and 0 API cost for:
 * 1. Session control commands: "undo", "撤回", "记错了", "padam", "tak jadi"
 * 2. Repeats: "same again", "一样", "跟昨天一样", "sama macam semalam"
 * 3. Corrections: "not 15, 18", "不是15是18", "bukan 15, 18", "that was food not transport"
 * 4. User preferences: "payday is the 28th", "预算 3000", "call abc zapfan"
 * 5. Page navigation: "go to budget", "打开投资", "what kinova knows"
 * 6. Fast-path expenses: single amount + unambiguous merchant ("Shell 60", "午餐 15")
 *
 * Returns null whenever the query requires intelligence, advice, complex extraction,
 * or questions, which transparently fall through to the Gemini Assistant.
 */

import { parseNaturalExpense } from './natural-expense-parser.ts';
import { normalizeToCanonicalCategory } from './canonical-categories.ts';
import type { RecentAction, UserMoneyProfile } from './user-money-profile.ts';
import type { AiCommand } from '../types/ai-command.ts';

export type LocalRouteResult =
  | {
      mode: 'undo';
      actionToUndo: RecentAction | null;
      message: string;
    }
  | {
      mode: 'repeat';
      baseAction: RecentAction | null;
      targetDate: string;
      message: string;
    }
  | {
      mode: 'correct';
      baseAction: RecentAction | null;
      patch: Record<string, unknown>;
      message: string;
    }
  | {
      mode: 'set_preference';
      preference: {
        key: 'paydayDay' | 'monthlyBudgetCap' | 'language' | 'alias';
        value: unknown;
        label: string;
      };
      message: string;
    }
  | {
      mode: 'navigate';
      path: string;
      label: string;
      message: string;
    }
  | {
      mode: 'quick_parse';
      command: AiCommand;
      label: string;
    };

const QUESTION_OR_ADVICE_WORDS = [
  '?', '？', 'should i', 'can i', 'how much', '怎么看', '能不能', '贵不贵', '值得',
  'worth it', 'afford', 'over budget', '超支', '税', 'sst', 'tax', 'relief',
  '扣税', '减税', 'compare', '比较', '哪家便宜', 'cheaper', 'mana murah',
  'bila', 'boleh ke', 'kenapa', 'why', 'what is', 'analysis', '分析',
];

const EXTENDED_REASONING_HINTS = [
  'should i', 'can i afford', 'how much', 'how many', 'worth it', 'afford', 'over budget', 'budget',
  'expense history', 'transaction history', 'what did i spend', 'what have i spent', 'my spending',
  'my expenses', 'my ledger', 'show me', 'list my', 'summary', 'summarize', 'summarise',
  'trend', 'forecast', 'compare', 'cheaper', 'cheapest', 'which store', 'expensive', 'too much',
  'tax', 'sst', 'relief', 'analysis', 'analyze', 'analyse', 'recommend', 'advice',
  'portfolio performance', 'stock analysis', 'investment advice',
  'what about', 'how about', '怎么看', '能不能', '贵不贵', '值得', '超支', '扣税', '减税',
  '比较', '哪家', '多少', '预算', '税务', '建议', '分析', '统计', '总结', '旅行预算',
  '分期预算', '股票分析', '投资建议', 'pelaburan mana bagus', 'berapa', 'bajet', 'cukai', 'banding',
];

/**
 * Checks if the text asks a question or requests advice/analysis.
 */
export function isQuestionOrAdviceRequest(text: string): boolean {
  const lower = text.toLowerCase().trim();
  return QUESTION_OR_ADVICE_WORDS.some((w) => lower.includes(w));
}

/** Use extended model reasoning only when the message calls for financial judgment or analysis. */
export function requiresExtendedReasoning(text: string, hasImage = false): boolean {
  if (hasImage) return true;
  const lower = text.toLowerCase().trim();
  return EXTENDED_REASONING_HINTS.some((hint) => lower.includes(hint));
}

/**
 * Route user input locally. Returns LocalRouteResult or null (fallback to Gemini).
 */
export function routeLocalIntent(
  text: string,
  profile: UserMoneyProfile,
  today: string
): LocalRouteResult | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();

  // 1. UNDO INTENT
  // "undo", "撤回", "删掉上一笔", "记错了", "padam", "tak jadi", "cancel last"
  if (
    /^(?:undo|撤回|撤销|删掉上一笔|删掉刚刚那笔|删掉刚才那笔|记错了|cancel\s*(?:last|that)?|padam|tak\s*jadi|buang|hapus)$/i.test(
      lower
    )
  ) {
    const lastAction = profile.recentActions?.[0] || null;
    return {
      mode: 'undo',
      actionToUndo: lastAction,
      message: lastAction
        ? `撤回上一笔操作: ${lastAction.summary || '确认撤销'}`
        : '没有可撤销的近期操作。',
    };
  }

  // 2. REPEAT INTENT
  // "same again", "一样", "跟昨天一样", "再来一笔", "sama macam semalam", "repeat"
  if (
    /^(?:same(?:\s+again)?|一样|跟上一笔一样|跟昨天一样|再来一笔|repeat(?:\s+last)?|sama(?:\s+macam\s+semalam)?|lagi\s*satu)$/i.test(
      lower
    )
  ) {
    const lastAction = profile.recentActions?.find((a) => a.actionType === 'record') || null;
    return {
      mode: 'repeat',
      baseAction: lastAction,
      targetDate: today,
      message: lastAction
        ? `重复上一笔记录: ${lastAction.summary || '今日记录'}`
        : '没有可重复的近期记录。',
    };
  }

  // 3. CORRECTION INTENT (e.g. "not 15, 18", "不是15是18", "bukan 15, 18", "那是餐饮不是交通")
  // Amount correction: "not 15, 18" or "不是15是18"
  const amountCorrectionMatch =
    trimmed.match(/(?:not|bukan|不是)\s*(?:RM|MYR)?\s*(\d+(?:\.\d+)?)(?:[,\s，]+(?:tapi|to|是)?\s*|[,\s，]*是\s*|[,\s，]+)(?:RM|MYR)?\s*(\d+(?:\.\d+)?)/i) ||
    trimmed.match(/(?:改(?:成|为|去)|change to|tukar ke)\s*(?:RM|MYR)?\s*(\d+(?:\.\d+)?)/i);

  if (amountCorrectionMatch) {
    const newAmount = parseFloat(amountCorrectionMatch[2] || amountCorrectionMatch[1]);
    if (Number.isFinite(newAmount) && newAmount > 0) {
      const lastAction = profile.recentActions?.find((a) => a.actionType === 'record' || a.actionType === 'edit') || null;
      return {
        mode: 'correct',
        baseAction: lastAction,
        patch: { amount: newAmount },
        message: `将金额修改为 RM ${newAmount.toFixed(2)}`,
      };
    }
  }

  // Category correction: "that was food not transport" or "那是餐饮不是交通"
  const catCorrectionMatch =
    trimmed.match(/(?:that was|那是|itu|tukar ke)\s*([\u4e00-\u9fa5\w\s&]+?)\s*(?:not|不是|bukan)\s*([\u4e00-\u9fa5\w\s&]+)/i) ||
    trimmed.match(/(?:改去|换去|change category to|tukar kategori ke)\s*([\u4e00-\u9fa5\w\s&]+)/i);

  if (catCorrectionMatch) {
    const rawCat = catCorrectionMatch[1].trim();
    const normalizedCat = normalizeToCanonicalCategory(rawCat);
    if (normalizedCat && normalizedCat !== 'Other') {
      const lastAction = profile.recentActions?.find((a) => a.actionType === 'record' || a.actionType === 'edit') || null;
      return {
        mode: 'correct',
        baseAction: lastAction,
        patch: { category: normalizedCat },
        message: `将分类更正为 「${normalizedCat}」`,
      };
    }
  }

  // 4. USER PREFERENCE INTENTS
  // Payday preference: "payday is the 28th", "发薪日28号", "gaji 28 hb", "payday 28"
  const paydayMatch =
    trimmed.match(/(?:payday|pay\s*day|发薪日|出粮日|发工资|hari\s*gaji|gaji)(?:\s*(?:is|on|pada|在|是|：|:))?\s*(?:the\s*)?(\d{1,2})(?:th|st|nd|rd|号|日|hb)?/i) ||
    trimmed.match(/(\d{1,2})(?:th|st|nd|rd|号|日|hb)?\s*(?:是|is)?\s*(?:payday|发薪日|出粮日|gaji)/i);

  if (paydayMatch) {
    const day = parseInt(paydayMatch[1], 10);
    if (day >= 1 && day <= 31) {
      return {
        mode: 'set_preference',
        preference: {
          key: 'paydayDay',
          value: day,
          label: `每月 ${day} 号发薪`,
        },
        message: `已将你的每月发薪日设置为 ${day} 号。`,
      };
    }
  }

  // Monthly budget preference: "budget 3000", "预算 3000", "bajet 3000"
  const budgetMatch =
    trimmed.match(/(?:monthly\s*)?budget(?:\s*(?:cap|is|set|to|：|:|\s))\s*(?:rm|myr)?\s*(\d+(?:\.\d+)?)/i) ||
    trimmed.match(/(?:每月)?预算(?:\s*(?:是|设为|：|:|\s))\s*(?:rm|myr)?\s*(\d+(?:\.\d+)?)/i) ||
    trimmed.match(/bajet(?:\s*(?:adalah|sebanyak|：|:|\s))\s*(?:rm|myr)?\s*(\d+(?:\.\d+)?)/i);

  if (budgetMatch) {
    const amount = parseFloat(budgetMatch[1]);
    if (Number.isFinite(amount) && amount > 0) {
      return {
        mode: 'set_preference',
        preference: {
          key: 'monthlyBudgetCap',
          value: amount,
          label: `每月预算 RM ${amount.toFixed(2)}`,
        },
        message: `已设置每月总支出预算为 RM ${amount.toFixed(2)}。`,
      };
    }
  }

  // Merchant alias: "call abc zapfan", "call abc as zapfan", "把 abc 叫做 杂饭"
  const aliasMatch =
    trimmed.match(/^(?:call|alias|nickname)\s+([a-zA-Z0-9\u4e00-\u9fa5]+)(?:\s+(?:as|called|panggil))?\s+([a-zA-Z0-9\u4e00-\u9fa5]+)$/i) ||
    trimmed.match(/^(?:把|将)\s*([a-zA-Z0-9\u4e00-\u9fa5]+)\s*(?:叫做|叫作|称作|设为别名)\s*([a-zA-Z0-9\u4e00-\u9fa5]+)$/i);

  if (aliasMatch) {
    const rawPattern = aliasMatch[1].trim();
    const alias = aliasMatch[2].trim();
    if (rawPattern.length >= 2 && alias.length >= 1) {
      return {
        mode: 'set_preference',
        preference: {
          key: 'alias',
          value: { rawPattern, alias },
          label: `将「${rawPattern}」记忆为「${alias}」`,
        },
        message: `已记住：以后遇到「${rawPattern}」将自动记为「${alias}」。`,
      };
    }
  }

  // 5. NAVIGATION INTENTS
  if (/(?:go\s*to\s*budget|open\s*budget|打开预算|看预算|buka\s*bajet)/i.test(trimmed)) {
    return { mode: 'navigate', path: '/budget', label: '预算与限额', message: '正在前往预算设置页面...' };
  }
  if (/(?:go\s*to\s*(?:investments?|stocks?)|open\s*investments?|看股票|打开投资|投资组合|portfolio|buka\s*pelaburan)/i.test(trimmed)) {
    return { mode: 'navigate', path: '/investments', label: '投资与持仓', message: '正在前往投资组合页面...' };
  }
  if (/(?:go\s*to\s*trips?|open\s*trips?|旅行记账|旅游记账|buka\s*trip)/i.test(trimmed)) {
    return { mode: 'navigate', path: '/trips', label: '旅行账本', message: '正在前往旅行账本页面...' };
  }
  if (/(?:go\s*to\s*(?:tax|invoices?)|open\s*tax|看税|报税|lhdn|tax\s*relief|buka\s*cukai)/i.test(trimmed)) {
    return { mode: 'navigate', path: '/invoices', label: '发票与税务', message: '正在前往税务及发票管理页面...' };
  }
  if (/(?:what\s*kinova\s*knows|kinova\s*memory|查看记忆|了解我|助手记忆)/i.test(trimmed)) {
    return { mode: 'navigate', path: '/settings#kinova-knows', label: 'Kinova 助手记忆', message: '正在打开 Kinova 个人画像与偏好记忆...' };
  }
  if (/(?:go\s*to\s*settings|open\s*settings|打开设置|系统设置|tetapan)/i.test(trimmed)) {
    return { mode: 'navigate', path: '/settings', label: '系统设置', message: '正在前往设置页面...' };
  }

  // 6. FAST PATH FOR EXPENSES (Instant local parse, 0ms, NO GEMINI CALL)
  // Only use it when the parser resolved any relative date language in the input.
  // Otherwise let the assistant interpret the complete request instead of silently
  // treating an unrecognized date phrase as today.
  if (!isQuestionOrAdviceRequest(trimmed)) {
    const localParsed = parseNaturalExpense(trimmed);
    if (
      localParsed &&
      localParsed.amount > 0 &&
      localParsed.category &&
      localParsed.category !== 'Other' &&
      localParsed.description &&
      !localParsed.hasUnparsedTemporalContext
    ) {
      const command: AiCommand = {
        intent: 'transaction',
        confidence: 0.9,
        data: {
          amount: localParsed.amount,
          currency: localParsed.currency || 'MYR',
          type: localParsed.type || 'Expense',
          category: localParsed.category,
          description: localParsed.description,
          date: localParsed.date || today,
        },
      };
      return {
        mode: 'quick_parse',
        command,
        label: 'Quick parse',
      };
    }
  }

  // Fallback to Gemini Assistant for judgment, advice, or questions
  return null;
}
