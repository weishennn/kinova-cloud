import { getLocalDateString } from './date-helper.ts';
import {
  type MerchantCategoryRule,
  getMerchantCategoryRules,
  saveMerchantCategoryRule,
  normalizePattern,
  SETTINGS_UPDATED_EVENT,
} from './merchant-rules.ts';

export interface HabitMemoryItem {
  id: string;
  rawPattern: string; // The raw payee/merchant name, e.g. "abc", "TAN CHIN HONG", "0123456789"
  preferredAlias: string; // The user's preferred shorthand/name, e.g. "zapfan", "四夕豆花"
  category: string; // e.g. "Food & Dining"
  subCategory?: string; // e.g. "Lunch", "Breakfast"
  defaultItemName?: string; // e.g. "杂饭 / 午餐"
  typicalAmount?: number; // e.g. 13.50
  timeSlot?: 'breakfast' | 'lunch' | 'dinner' | 'any';
  frequency: number; // How many times user confirmed or used this habit
  confidence: number; // 0.0 to 1.0
  learnedSource: 'auto_learned' | 'user_confirmed' | 'manual';
  createdAt: string;
  updatedAt: string;
}

export interface HabitMemoryMatch {
  matchedItem: HabitMemoryItem;
  resolvedDescription: string;
  resolvedCategory: string;
  matchedPattern: string;
  isAlias: boolean; // true if rawPattern !== preferredAlias (e.g. abc -> zapfan)
}

export interface MinimalLedgerRecord {
  id?: string;
  date?: string;
  amount: number;
  type?: string;
  category?: string;
  description?: string;
  merchant?: string;
  notes?: string;
  currency?: string;
}

const HABIT_STORAGE_KEY = 'cashflow_habit_memory';

/**
 * Malaysian & Southeast Asian time-of-day contextual time slots
 */
export function getCurrentTimeSlot(currentHour?: number): 'breakfast' | 'lunch' | 'dinner' | 'any' {
  const hour = typeof currentHour === 'number' ? currentHour : new Date().getHours();
  if (hour >= 6 && hour < 11) return 'breakfast';
  if (hour >= 11 && hour < 15) return 'lunch';
  if (hour >= 17 && hour < 22) return 'dinner';
  return 'any';
}

/**
 * Built-in Malaysian merchant & habit starter baselines
 */
export const DEFAULT_HABIT_MEMORIES: HabitMemoryItem[] = [
  {
    id: 'habit_shell',
    rawPattern: 'Shell',
    preferredAlias: 'Shell 汽油',
    category: 'Transport',
    subCategory: 'Petrol',
    defaultItemName: 'FuelSave 95',
    timeSlot: 'any',
    frequency: 3,
    confidence: 1.0,
    learnedSource: 'manual',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'habit_petronas',
    rawPattern: 'Petronas',
    preferredAlias: 'Petronas 汽油',
    category: 'Transport',
    subCategory: 'Petrol',
    defaultItemName: 'Primax 95',
    timeSlot: 'any',
    frequency: 3,
    confidence: 1.0,
    learnedSource: 'manual',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'habit_jaya_grocer',
    rawPattern: 'Jaya Grocer',
    preferredAlias: 'Jaya Grocer 超市',
    category: 'Food & Dining',
    subCategory: 'Supermarket',
    timeSlot: 'any',
    frequency: 2,
    confidence: 1.0,
    learnedSource: 'manual',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

export function getHabitMemories(): HabitMemoryItem[] {
  if (typeof window === 'undefined' && typeof localStorage === 'undefined') return DEFAULT_HABIT_MEMORIES;

  try {
    const raw = localStorage.getItem(HABIT_STORAGE_KEY);
    let items: HabitMemoryItem[] = [];
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        items = parsed;
      }
    }

    const legacyRules = getMerchantCategoryRules();
    const existingPatterns = new Set(items.map((it) => it.rawPattern.toLowerCase()));

    for (const legacy of legacyRules) {
      const patLower = legacy.merchantPattern.toLowerCase();
      if (!existingPatterns.has(patLower)) {
        items.push({
          id: legacy.id.startsWith('rule_') ? legacy.id.replace('rule_', 'habit_') : `habit_${legacy.id}`,
          rawPattern: legacy.merchantPattern,
          preferredAlias: legacy.merchantPattern,
          category: legacy.category,
          subCategory: legacy.subCategory,
          frequency: 3,
          confidence: 0.9,
          learnedSource: 'manual',
          createdAt: legacy.createdAt,
          updatedAt: legacy.updatedAt,
        });
        existingPatterns.add(patLower);
      }
    }

    if (items.length === 0) {
      return DEFAULT_HABIT_MEMORIES;
    }

    return items;
  } catch (err) {
    console.warn('[HabitMemoryEngine] Failed to load habit memories:', err);
    return DEFAULT_HABIT_MEMORIES;
  }
}

function persistHabitMemories(memories: HabitMemoryItem[]): void {
  if (typeof window === 'undefined' && typeof localStorage === 'undefined') return;
  try {
    const serialized = JSON.stringify(memories);
    localStorage.setItem(HABIT_STORAGE_KEY, serialized);

    const legacyRules: MerchantCategoryRule[] = memories.map((m) => ({
      id: m.id,
      merchantPattern: m.rawPattern,
      category: m.category,
      subCategory: m.subCategory,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    }));
    localStorage.setItem('cashflow_merchant_category_rules', JSON.stringify(legacyRules));

    import('./cloud-settings-sync')
      .then((m) => {
        m.saveSettingWithCloudSync(HABIT_STORAGE_KEY, serialized);
        m.saveSettingWithCloudSync('cashflow_merchant_category_rules', JSON.stringify(legacyRules));
      })
      .catch(() => {});

    window.dispatchEvent(new Event(SETTINGS_UPDATED_EVENT));
  } catch (err) {
    console.warn('[HabitMemoryEngine] Failed to persist habit memories:', err);
  }
}

/**
 * Cleans bank transfer noise, DuitNow prefixes, and recipient markers.
 */
export function cleanPayeeOrMerchantPattern(input: string): string {
  let cleaned = normalizePattern(input);
  cleaned = cleaned.replace(/^(?:duitnow\s*(?:transfer|qr)?\s*(?:to)?|transfer\s*to|paid\s*to|payment\s*to|send\s*money\s*to|bill\s*to)\s+/i, '');
  cleaned = cleaned.replace(/^(?:转给|转账给|付给|支付给|付款给)\s+/i, '');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  return cleaned;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Safe pattern matcher that prevents short ASCII aliases (e.g. "abc") from matching inside
 * unrelated English words (e.g. "gr[abc]ar").
 * - CJK patterns match via substring (>=2 chars).
 * - ASCII patterns < 6 chars MUST match on word boundaries (`\bpattern\b`).
 * - ASCII patterns >= 6 chars can match via word boundary or substring.
 */
function matchesPatternSafely(haystackLower: string, patternLower: string): boolean {
  const pat = patternLower.trim();
  if (!pat || pat.length < 2) return false;
  if (haystackLower === pat) return true;

  const hasCjk = /[\u4e00-\u9fa5]/.test(pat);
  if (hasCjk) {
    return haystackLower.includes(pat);
  }

  const wordBoundaryRegex = new RegExp(`(?:^|[^a-z0-9])${escapeRegex(pat)}(?:$|[^a-z0-9])`, 'i');
  if (wordBoundaryRegex.test(haystackLower)) {
    return true;
  }

  // Only allow substring containment without word boundaries for longer multi-char patterns (>= 6 chars)
  return pat.length >= 6 && haystackLower.includes(pat);
}

/**
 * Matches input text against learned habit memories.
 * Evaluates both rawPattern and preferredAlias with word-boundary protection.
 */
export function matchHabitMemory(
  textOrPayee: string,
  memoriesOverride?: HabitMemoryItem[]
): HabitMemoryMatch | null {
  const text = String(textOrPayee || '').trim();
  if (!text || text.length < 2) return null;

  const rawMemories = memoriesOverride || getHabitMemories();
  const memories = Array.isArray(rawMemories) ? rawMemories : [];
  if (memories.length === 0) return null;

  const textLower = text.toLowerCase();
  const cleanedText = cleanPayeeOrMerchantPattern(text).toLowerCase();

  const sorted = memories.slice().sort((a, b) => {
    const lenA = a.rawPattern.length;
    const lenB = b.rawPattern.length;
    if (lenA !== lenB) return lenB - lenA;
    return (b.confidence || 0.5) - (a.confidence || 0.5);
  });

  for (const memory of sorted) {
    const patLower = memory.rawPattern.toLowerCase().trim();
    const aliasLower = memory.preferredAlias.toLowerCase().trim();

    const matchedRaw =
      matchesPatternSafely(textLower, patLower) || matchesPatternSafely(cleanedText, patLower);
    const matchedAlias =
      matchesPatternSafely(textLower, aliasLower) || matchesPatternSafely(cleanedText, aliasLower);

    if (matchedRaw || matchedAlias) {
      const isAlias = patLower !== aliasLower;
      return {
        matchedItem: memory,
        resolvedDescription: memory.preferredAlias,
        resolvedCategory: memory.category,
        matchedPattern: memory.rawPattern,
        isAlias,
      };
    }
  }

  return null;
}

export function learnOrStrengthenHabit(params: {
  rawInputOrMerchant: string;
  aliasOrDescription: string;
  category: string;
  subCategory?: string;
  amount?: number;
  timeSlot?: 'breakfast' | 'lunch' | 'dinner' | 'any';
  source?: 'auto_learned' | 'user_confirmed' | 'manual';
}): HabitMemoryItem | null {
  const rawClean = cleanPayeeOrMerchantPattern(params.rawInputOrMerchant);
  const aliasClean = params.aliasOrDescription.trim();
  const categoryClean = params.category.trim();

  if (!rawClean || rawClean.length < 2 || !aliasClean || !categoryClean) {
    return null;
  }

  const memories = getHabitMemories();
  const rawLower = rawClean.toLowerCase();
  const now = new Date().toISOString();
  const timeSlot = params.timeSlot || getCurrentTimeSlot();

  const existingIndex = memories.findIndex(
    (m) => m.rawPattern.toLowerCase() === rawLower
  );

  let updatedItem: HabitMemoryItem;

  if (existingIndex >= 0) {
    const existing = memories[existingIndex];
    const newFrequency = (existing.frequency || 1) + 1;
    const newConfidence = Math.min(1.0, (existing.confidence || 0.7) + 0.1);

    updatedItem = {
      ...existing,
      rawPattern: rawClean,
      preferredAlias: aliasClean,
      category: categoryClean,
      subCategory: params.subCategory?.trim() || existing.subCategory,
      typicalAmount: typeof params.amount === 'number' && params.amount > 0 ? params.amount : existing.typicalAmount,
      timeSlot: existing.timeSlot === timeSlot ? timeSlot : 'any',
      frequency: newFrequency,
      confidence: newConfidence,
      learnedSource: params.source || (existing.learnedSource === 'manual' ? 'manual' : 'user_confirmed'),
      updatedAt: now,
    };
    memories[existingIndex] = updatedItem;
  } else {
    updatedItem = {
      id: `habit_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      rawPattern: rawClean,
      preferredAlias: aliasClean,
      category: categoryClean,
      subCategory: params.subCategory?.trim() || undefined,
      typicalAmount: typeof params.amount === 'number' && params.amount > 0 ? params.amount : undefined,
      timeSlot,
      frequency: params.source === 'manual' ? 3 : 1,
      confidence: params.source === 'manual' ? 1.0 : 0.75,
      learnedSource: params.source || 'auto_learned',
      createdAt: now,
      updatedAt: now,
    };
    memories.unshift(updatedItem);
  }

  persistHabitMemories(memories);
  return updatedItem;
}

export function deleteHabitMemory(idOrPattern: string): boolean {
  if (typeof window === 'undefined' && typeof localStorage === 'undefined') return false;
  const memories = getHabitMemories();
  const lower = idOrPattern.toLowerCase();
  const filtered = memories.filter((m) => m.id !== idOrPattern && m.rawPattern.toLowerCase() !== lower);

  if (filtered.length === memories.length) return false;

  persistHabitMemories(filtered);
  return true;
}

export function mineHabitsFromLedger(transactions: MinimalLedgerRecord[]): HabitMemoryItem[] {
  if (!Array.isArray(transactions) || transactions.length === 0) return [];

  const candidateMap = new Map<string, {
    raw: string;
    aliasCounts: Map<string, number>;
    categoryCounts: Map<string, number>;
    amounts: number[];
  }>();

  for (const tx of transactions) {
    if (!tx || tx.type === 'income') continue;

    const desc = (tx.description || '').trim();
    const merchant = (tx.merchant || '').trim();
    const notes = (tx.notes || '').trim();
    const cat = (tx.category || '').trim();

    let rawPayee = '';
    const noteMatch = notes.match(/(?:\[转账给:\s*|转账给:\s*|DuitNow to:\s*|Payment to:\s*)([^\]\n]+)/i);
    if (noteMatch && noteMatch[1]) {
      rawPayee = cleanPayeeOrMerchantPattern(noteMatch[1]);
    } else if (merchant && desc && merchant.toLowerCase() !== desc.toLowerCase()) {
      rawPayee = cleanPayeeOrMerchantPattern(merchant);
    }

    if (!rawPayee || rawPayee.length < 2) continue;

    const key = rawPayee.toLowerCase();
    if (!candidateMap.has(key)) {
      candidateMap.set(key, {
        raw: rawPayee,
        aliasCounts: new Map(),
        categoryCounts: new Map(),
        amounts: [],
      });
    }

    const entry = candidateMap.get(key)!;
    const targetAlias = desc || merchant || cat;
    if (targetAlias) {
      entry.aliasCounts.set(targetAlias, (entry.aliasCounts.get(targetAlias) || 0) + 1);
    }
    if (cat) {
      entry.categoryCounts.set(cat, (entry.categoryCounts.get(cat) || 0) + 1);
    }
    if (typeof tx.amount === 'number' && tx.amount > 0) {
      entry.amounts.push(tx.amount);
    }
  }

  const minedHabits: HabitMemoryItem[] = [];
  const now = new Date().toISOString();

  for (const [, data] of candidateMap.entries()) {
    let topAlias = '';
    let topAliasCount = 0;
    for (const [alias, count] of data.aliasCounts.entries()) {
      if (count > topAliasCount) {
        topAliasCount = count;
        topAlias = alias;
      }
    }

    let topCat = 'Food & Dining';
    let topCatCount = 0;
    for (const [cat, count] of data.categoryCounts.entries()) {
      if (count > topCatCount) {
        topCatCount = count;
        topCat = cat;
      }
    }

    if (topAlias && topAliasCount >= 2) {
      const avgAmount =
        data.amounts.length > 0
          ? Number((data.amounts.reduce((a, b) => a + b, 0) / data.amounts.length).toFixed(2))
          : undefined;

      minedHabits.push({
        id: `mined_${data.raw.toLowerCase()}`,
        rawPattern: data.raw,
        preferredAlias: topAlias,
        category: topCat,
        typicalAmount: avgAmount,
        frequency: topAliasCount,
        confidence: Math.min(0.95, 0.6 + topAliasCount * 0.1),
        learnedSource: 'auto_learned',
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  return minedHabits;
}
