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
    category: 'Shopping',
    subCategory: 'Groceries',
    timeSlot: 'any',
    frequency: 2,
    confidence: 1.0,
    learnedSource: 'manual',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

/**
 * Retrieves all stored habit memories, seamlessly bootstrapping with defaults and
 * incorporating existing merchant category rules.
 */
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

    // Merge with legacy merchant rules if they exist and aren't represented yet
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

/**
 * Saves habit memories locally and syncs to Google Sheets Settings in the cloud.
 */
function persistHabitMemories(memories: HabitMemoryItem[]): void {
  if (typeof window === 'undefined' && typeof localStorage === 'undefined') return;
  try {
    const serialized = JSON.stringify(memories);
    localStorage.setItem(HABIT_STORAGE_KEY, serialized);

    // Also mirror to legacy merchant rules for backwards compatibility
    const legacyRules: MerchantCategoryRule[] = memories.map((m) => ({
      id: m.id,
      merchantPattern: m.rawPattern,
      category: m.category,
      subCategory: m.subCategory,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    }));
    localStorage.setItem('cashflow_merchant_category_rules', JSON.stringify(legacyRules));

    // Cloud settings sync
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
 * e.g. "DuitNow Transfer to abc" -> "abc", "Payment to TAN CHIN HONG" -> "TAN CHIN HONG"
 */
export function cleanPayeeOrMerchantPattern(input: string): string {
  let cleaned = normalizePattern(input);
  cleaned = cleaned.replace(/^(?:duitnow\s*(?:transfer|qr)?\s*(?:to)?|transfer\s*to|paid\s*to|payment\s*to|send\s*money\s*to|bill\s*to)\s+/i, '');
  cleaned = cleaned.replace(/^(?:转给|转账给|付给|支付给|付款给)\s+/i, '');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  return cleaned;
}

/**
 * Matches input text against learned habit memories.
 * Evaluates both rawPattern and preferredAlias. Longer, high-confidence patterns match first.
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

  // Sort descending by pattern length and confidence so specific habits take precedence
  const sorted = memories.slice().sort((a, b) => {
    const lenA = a.rawPattern.length;
    const lenB = b.rawPattern.length;
    if (lenA !== lenB) return lenB - lenA;
    return (b.confidence || 0.5) - (a.confidence || 0.5);
  });

  for (const memory of sorted) {
    const patLower = memory.rawPattern.toLowerCase();
    const aliasLower = memory.preferredAlias.toLowerCase();

    // Check exact or containment matches
    const isExactRaw = textLower === patLower || cleanedText === patLower;
    const isContainsRaw = textLower.includes(patLower) || (patLower.length >= 3 && cleanedText.includes(patLower));
    const isExactAlias = textLower === aliasLower || cleanedText === aliasLower;
    const isContainsAlias = textLower.includes(aliasLower) || (aliasLower.length >= 3 && cleanedText.includes(aliasLower));

    if (isExactRaw || isContainsRaw || isExactAlias || isContainsAlias) {
      const isAlias = memory.rawPattern.toLowerCase() !== memory.preferredAlias.toLowerCase();
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

/**
 * Learns or strengthens a habit dynamically.
 * e.g. User pays "abc", but enters "zapfan", category "Food & Dining".
 * This records/updates the habit: abc -> zapfan, Food & Dining.
 */
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

/**
 * Deletes a habit memory by ID or pattern.
 */
export function deleteHabitMemory(idOrPattern: string): boolean {
  if (typeof window === 'undefined' && typeof localStorage === 'undefined') return false;
  const memories = getHabitMemories();
  const lower = idOrPattern.toLowerCase();
  const filtered = memories.filter((m) => m.id !== idOrPattern && m.rawPattern.toLowerCase() !== lower);

  if (filtered.length === memories.length) return false;

  persistHabitMemories(filtered);
  return true;
}

/**
 * Mines historical ledger transactions to automatically discover repeat transfer habits.
 * Detects patterns like notes containing "[转账给: abc]" or raw merchant "abc" consistently
 * mapped to description "zapfan" or category "Food & Dining".
 */
export function mineHabitsFromLedger(transactions: MinimalLedgerRecord[]): HabitMemoryItem[] {
  if (!Array.isArray(transactions) || transactions.length === 0) return [];

  // Map: rawPayee -> Map<alias, count>
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

    // Check if notes contains raw transfer payee info like "[转账给: abc]" or "转账给: abc"
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

  for (const [_, data] of candidateMap.entries()) {
    // Pick top alias
    let topAlias = '';
    let topAliasCount = 0;
    for (const [alias, count] of data.aliasCounts.entries()) {
      if (count > topAliasCount) {
        topAliasCount = count;
        topAlias = alias;
      }
    }

    // Pick top category
    let topCat = 'Food & Dining';
    let topCatCount = 0;
    for (const [cat, count] of data.categoryCounts.entries()) {
      if (count > topCatCount) {
        topCatCount = count;
        topCat = cat;
      }
    }

    // Require at least 2 occurrences or strong agreement
    if (topAlias && topAliasCount >= 2) {
      const avgAmount = data.amounts.length > 0
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
