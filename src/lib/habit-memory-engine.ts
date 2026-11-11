import { normalizeToCanonicalCategory } from './canonical-categories.ts';
import {
  type MerchantCategoryRule,
  getMerchantCategoryRules,
  normalizePattern,
  SETTINGS_UPDATED_EVENT,
  SYSTEM_OR_RECEIPT_NOISE_REGEX,
  ITEMIZED_RULE_TEXT_REGEX,
  GENERIC_COMMODITY_TERM_REGEX,
  hasEmbeddedAmountOrPrice,
  isPollutedMerchantRulePattern,
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
  keywords?: string[]; // Partial wording / shorthand triggers ("字眼"), e.g. ["四夕", "tanchinhong"]
  aiNote?: string; // Concise note written when curated/optimized by AI
  frequency: number; // How many times user confirmed or used this habit
  confidence: number; // 0.0 to 1.0
  learnedSource: 'auto_learned' | 'user_confirmed' | 'manual';
  createdAt: string;
  updatedAt: string;
}

export type HabitMatchVia = 'exact' | 'pattern' | 'alias' | 'compact' | 'keyword' | 'stem';

export interface HabitMemoryMatch {
  matchedItem: HabitMemoryItem;
  resolvedDescription: string;
  resolvedCategory: string;
  matchedPattern: string;
  matchedVia: HabitMatchVia;
  matchedToken?: string;
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

export interface HabitCandidateRecord {
  key: string;
  rawPattern: string;
  preferredAlias: string;
  category: string;
  subCategory?: string;
  count: number;
  lastAmount?: number;
  timeSlot: 'breakfast' | 'lunch' | 'dinner' | 'any';
  firstSeenAt: string;
  lastSeenAt: string;
}

const HABIT_STORAGE_KEY = 'cashflow_habit_memory';
const HABIT_CANDIDATES_STORAGE_KEY = 'cashflow_habit_candidates';
const LEGACY_RULES_STORAGE_KEY = 'cashflow_merchant_category_rules';
const MAX_AUTO_RAW_PATTERN_LEN = 36;
const MAX_AUTO_ALIAS_LEN = 48;
const MAX_CANDIDATE_RECORDS = 60;
const CANDIDATE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const PROMOTE_THRESHOLD = 2;

export function isGenericCommodityTerm(input: string): boolean {
  const cleaned = cleanPayeeOrMerchantPattern(input);
  if (!cleaned) return false;
  return GENERIC_COMMODITY_TERM_REGEX.test(cleaned);
}

export function isEligibleHabitMerchant(input: string): boolean {
  const raw = String(input || '').trim();
  const clean = cleanPayeeOrMerchantPattern(raw);
  if (!clean || clean.length < 2 || clean.length > MAX_AUTO_RAW_PATTERN_LEN) return false;
  if (SYSTEM_OR_RECEIPT_NOISE_REGEX.test(clean)) return false;
  if (ITEMIZED_RULE_TEXT_REGEX.test(raw) || ITEMIZED_RULE_TEXT_REGEX.test(clean)) return false;
  if (isGenericCommodityTerm(clean)) return false;
  if (hasEmbeddedAmountOrPrice(raw) || hasEmbeddedAmountOrPrice(clean)) return false;
  return true;
}

export function isRedundantCategoryMapping(
  rawPattern: string,
  preferredAlias: string,
  category: string
): boolean {
  const rawClean = cleanPayeeOrMerchantPattern(rawPattern);
  const aliasClean = String(preferredAlias || '').trim();
  const catClean = String(category || '').trim();
  if (!rawClean || !catClean) return false;
  if (aliasClean && rawClean.toLowerCase() !== aliasClean.toLowerCase()) {
    return false;
  }
  const builtInPredicted = normalizeToCanonicalCategory('', 'Expense', rawClean);
  return builtInPredicted !== 'Other' && builtInPredicted.toLowerCase() === catClean.toLowerCase();
}

export function isAllowedAutoLearnedPair(rawPattern: string, preferredAlias: string): boolean {
  const rawClean = cleanPayeeOrMerchantPattern(rawPattern);
  const aliasClean = String(preferredAlias || '').trim();
  if (!rawClean || rawClean.length < 2 || !aliasClean || aliasClean.length < 1) return false;
  if (rawClean.length > MAX_AUTO_RAW_PATTERN_LEN || aliasClean.length > MAX_AUTO_ALIAS_LEN) return false;
  if (SYSTEM_OR_RECEIPT_NOISE_REGEX.test(rawClean) || SYSTEM_OR_RECEIPT_NOISE_REGEX.test(aliasClean)) return false;
  if (ITEMIZED_RULE_TEXT_REGEX.test(rawPattern) || ITEMIZED_RULE_TEXT_REGEX.test(rawClean) || ITEMIZED_RULE_TEXT_REGEX.test(aliasClean)) return false;
  if (isGenericCommodityTerm(rawClean)) return false;
  if (hasEmbeddedAmountOrPrice(rawPattern) || hasEmbeddedAmountOrPrice(rawClean)) return false;
  if (rawClean.toLowerCase() === aliasClean.toLowerCase()) return false;
  return true;
}

export function isPollutedHabitEntry(item: Partial<HabitMemoryItem> | null | undefined): boolean {
  if (!item || typeof item !== 'object') return false;
  const rawRaw = String(item.rawPattern || '').trim();
  const rawClean = cleanPayeeOrMerchantPattern(rawRaw);
  const aliasRaw = String(item.preferredAlias || '').trim();
  const aliasClean = aliasRaw || rawClean;

  if (!rawClean || rawClean.length < 2) return true;
  if (SYSTEM_OR_RECEIPT_NOISE_REGEX.test(rawClean)) return true;
  if (ITEMIZED_RULE_TEXT_REGEX.test(rawRaw) || ITEMIZED_RULE_TEXT_REGEX.test(aliasRaw)) return true;

  if (item.learnedSource === 'auto_learned') {
    return !isAllowedAutoLearnedPair(rawRaw, aliasClean);
  }

  if (item.learnedSource === 'user_confirmed') {
    if (rawClean.length > MAX_AUTO_RAW_PATTERN_LEN || aliasClean.length > MAX_AUTO_ALIAS_LEN) {
      return true;
    }
    if (hasEmbeddedAmountOrPrice(rawRaw) || hasEmbeddedAmountOrPrice(rawClean)) {
      return true;
    }
    if (rawClean.toLowerCase() === aliasClean.toLowerCase()) {
      if (isGenericCommodityTerm(rawClean)) return true;
      const freq = typeof item.frequency === 'number' ? item.frequency : 1;
      if (freq <= 1 && isRedundantCategoryMapping(rawClean, aliasClean, String(item.category || ''))) {
        return true;
      }
    }
    return false;
  }

  // Migrated legacy rules copied from cashflow_merchant_category_rules in earlier builds
  if (item.learnedSource === 'manual' && String(item.id || '').startsWith('habit_rule_')) {
    return isPollutedMerchantRulePattern(rawRaw);
  }

  return false;
}

export function isPollutedAutoHabit(item: Partial<HabitMemoryItem> | null | undefined): boolean {
  return isPollutedHabitEntry(item);
}

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

const GENERIC_KEYWORD_STOPWORDS = new Set([
  'store', 'shop', 'mart', 'mini mart', 'minimart', 'market', 'station', 'sdn', 'bhd', 'sdn bhd',
  'enterprise', 'trading', 'restaurant', 'restoran', 'cafe', 'coffee', 'kitchen', 'house',
  'center', 'centre', 'express', 'malaysia', 'online', 'service', 'services', 'company',
  'payment', 'transfer', 'duitnow', 'bill', 'order', 'receipt', 'branch', 'outlet',
]);

const GENERIC_CJK_SHOP_SUFFIXES = [
  '茶餐室', '美食中心', '经济饭', '云吞面', '肉骨茶',
  '豆花', '鸡饭', '杂饭', '烧腊', '茶室', '餐室', '咖啡', '拉面', '寿司',
  '火锅', '面包', '蛋糕', '奶茶', '甜品', '点心', '面馆', '小厨', '餐厅',
  '饭店', '超市', '药房', '书店', '诊所', '油站',
];

const GENERIC_CJK_TIME_OR_PRONOUN_PREFIXES = new Set([
  '今天', '今日', '昨天', '昨日', '前天', '明天', '刚刚', '刚才', '每天',
  '早餐', '早饭', '午餐', '午饭', '晚餐', '晚饭', '宵夜', '夜宵', '下午茶',
  '朋友', '老板', '同事', '自己', '我们', '家人', '公司', '附近',
]);

export function toCompactHabitToken(input: string): string {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
}

export function extractDistinctiveCjkStems(phrase: string): string[] {
  const clean = String(phrase || '').trim();
  if (!clean) return [];
  const runs = clean.match(/[\u4e00-\u9fa5]{4,}/g) || [];
  const stems: string[] = [];
  for (const run of runs) {
    for (const suffix of GENERIC_CJK_SHOP_SUFFIXES) {
      if (run.endsWith(suffix) && run.length > suffix.length + 1) {
        const stem = run.slice(0, run.length - suffix.length);
        if (
          stem.length >= 2 &&
          !GENERIC_CJK_TIME_OR_PRONOUN_PREFIXES.has(stem) &&
          !GENERIC_COMMODITY_TERM_REGEX.test(stem)
        ) {
          stems.push(stem);
        }
      }
    }
  }
  return Array.from(new Set(stems));
}

export function sanitizeHabitKeywords(
  keywords: unknown,
  options: {
    source?: 'ai' | 'auto' | 'manual';
    rawPattern?: string;
    preferredAlias?: string;
  } = {}
): string[] {
  if (!Array.isArray(keywords)) return [];
  const source = options.source || 'ai';
  const rawLower = cleanPayeeOrMerchantPattern(options.rawPattern || '').toLowerCase();
  const aliasLower = String(options.preferredAlias || '').trim().toLowerCase();
  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of keywords) {
    if (typeof item !== 'string') continue;
    const kw = cleanPayeeOrMerchantPattern(item);
    if (!kw || kw.length < 2 || kw.length > 24) continue;
    if (/^\d+(?:\.\d+)?$/.test(kw)) continue;
    if (SYSTEM_OR_RECEIPT_NOISE_REGEX.test(kw)) continue;
    if (ITEMIZED_RULE_TEXT_REGEX.test(kw)) continue;
    if (hasEmbeddedAmountOrPrice(kw)) continue;

    const lower = kw.toLowerCase();
    // No need to duplicate exact rawPattern or exact preferredAlias inside keywords
    if (lower === rawLower || lower === aliasLower) continue;

    if (source !== 'manual') {
      if (GENERIC_KEYWORD_STOPWORDS.has(lower)) continue;
      if (GENERIC_COMMODITY_TERM_REGEX.test(kw)) continue;
    }

    if (!seen.has(lower)) {
      seen.add(lower);
      result.push(kw);
      if (result.length >= 10) break;
    }
  }

  return result;
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
    keywords: ['fuelsave'],
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
    keywords: ['primax'],
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
    keywords: ['jaya', 'jayagrocer'],
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
    const rawLegacy = localStorage.getItem(LEGACY_RULES_STORAGE_KEY);
    const items: HabitMemoryItem[] = [];
    const pollutedIds = new Set<string>();
    const pollutedPatternsLower = new Set<string>();
    let hadPolluted = false;

    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (isPollutedHabitEntry(entry)) {
            hadPolluted = true;
            if (entry?.id) pollutedIds.add(String(entry.id));
            if (entry?.rawPattern) pollutedPatternsLower.add(String(entry.rawPattern).toLowerCase().trim());
          } else if (entry && typeof entry === 'object' && entry.rawPattern) {
            items.push(entry as HabitMemoryItem);
          }
        }
      }
    }

    const legacyRules = getMerchantCategoryRules();
    const existingPatterns = new Set(items.map((it) => String(it.rawPattern || '').toLowerCase()));
    let legacyChanged = false;

    for (const legacy of legacyRules) {
      const patLower = String(legacy.merchantPattern || '').toLowerCase().trim();
      const keptItemMatchesLegacy = items.some(
        (it) =>
          it.id === legacy.id ||
          String(it.rawPattern || '').toLowerCase().trim() === patLower
      );
      const isBuiltInStarter = legacy.id === 'rule_shell' || legacy.id === 'rule_petronas' || legacy.id === 'rule_jaya_grocer';
      const wasPollutedCopy =
        pollutedIds.has(legacy.id) ||
        pollutedPatternsLower.has(patLower) ||
        (!keptItemMatchesLegacy && !isBuiltInStarter && isPollutedMerchantRulePattern(legacy.merchantPattern));

      if (wasPollutedCopy) {
        legacyChanged = true;
        continue;
      }

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

    if (hadPolluted || legacyChanged) {
      try {
        const serializedHabits = JSON.stringify(items);
        localStorage.setItem(HABIT_STORAGE_KEY, serializedHabits);
        const nextLegacy: MerchantCategoryRule[] = items.map((m) => ({
          id: m.id,
          merchantPattern: m.rawPattern,
          category: m.category,
          subCategory: m.subCategory,
          createdAt: m.createdAt,
          updatedAt: m.updatedAt,
        }));
        const serializedLegacy = JSON.stringify(nextLegacy);
        localStorage.setItem(LEGACY_RULES_STORAGE_KEY, serializedLegacy);
        if (typeof window !== 'undefined') {
          import('./cloud-settings-sync')
            .then((m) => {
              m.saveSettingWithCloudSync(HABIT_STORAGE_KEY, serializedHabits);
              m.saveSettingWithCloudSync(LEGACY_RULES_STORAGE_KEY, serializedLegacy);
            })
            .catch(() => {});
        }
      } catch {
        // Ignore storage write issues during passive cleanup
      }
    }

    if (items.length === 0 && raw === null && rawLegacy === null) {
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
    localStorage.setItem(LEGACY_RULES_STORAGE_KEY, JSON.stringify(legacyRules));

    if (typeof window !== 'undefined') {
      import('./cloud-settings-sync')
        .then((m) => {
          m.saveSettingWithCloudSync(HABIT_STORAGE_KEY, serialized);
          m.saveSettingWithCloudSync(LEGACY_RULES_STORAGE_KEY, JSON.stringify(legacyRules));
        })
        .catch(() => {});

      window.dispatchEvent(new Event(SETTINGS_UPDATED_EVENT));
    }
  } catch (err) {
    console.warn('[HabitMemoryEngine] Failed to persist habit memories:', err);
  }
}

export function saveAllHabitMemories(memories: HabitMemoryItem[]): void {
  persistHabitMemories(memories);
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

function matchesCompactPattern(
  textCompact: string,
  cleanedCompact: string,
  compactTokens: Set<string>,
  targetCompact: string
): boolean {
  if (!targetCompact) return false;
  const hasCjk = /[\u4e00-\u9fa5]/.test(targetCompact);
  if (hasCjk) {
    return targetCompact.length >= 3 && (textCompact.includes(targetCompact) || cleanedCompact.includes(targetCompact));
  }
  if (targetCompact.length < 5) return false;
  if (compactTokens.has(targetCompact)) return true;
  // Require >= 6 collapsed chars before allowing substring match inside alphanumeric strings (e.g. "tanchinhong12")
  return targetCompact.length >= 6 && (textCompact.includes(targetCompact) || cleanedCompact.includes(targetCompact));
}

/**
 * Matches input text against learned habit memories.
 * Evaluates rawPattern, preferredAlias, explicit trigger keywords ("字眼"),
 * space-collapsed forms ("tanchinhong"), and distinctive CJK brand stems ("四夕").
 * Uses specificity scoring so longer / more exact rules always win.
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
  const textCompact = toCompactHabitToken(textLower);
  const cleanedCompact = toCompactHabitToken(cleanedText);
  const compactTokens = new Set<string>(
    textLower
      .split(/\s+/)
      .map((tok) => toCompactHabitToken(tok))
      .filter((tok) => tok.length >= 2)
  );
  // Also include whitespace tokens stripped of trailing numeric amounts (e.g. "tanchinhong12" -> "tanchinhong")
  for (const tok of Array.from(compactTokens)) {
    const alphaPrefix = tok.replace(/\d+(?:\.\d+)?$/, '');
    if (alphaPrefix && alphaPrefix !== tok && alphaPrefix.length >= 2) {
      compactTokens.add(alphaPrefix);
    }
  }

  let bestCandidate: {
    memory: HabitMemoryItem;
    matchedVia: HabitMatchVia;
    matchedToken: string;
    score: number;
  } | null = null;

  const consider = (
    memory: HabitMemoryItem,
    matchedVia: HabitMatchVia,
    matchedToken: string,
    tier: number
  ) => {
    const score =
      tier * 100_000 +
      matchedToken.length * 100 +
      memory.rawPattern.length * 10 +
      Math.round((memory.confidence || 0.5) * 10);
    if (!bestCandidate || score > bestCandidate.score) {
      bestCandidate = { memory, matchedVia, matchedToken, score };
    }
  };

  for (const memory of memories) {
    const patLower = String(memory.rawPattern || '').toLowerCase().trim();
    const aliasLower = String(memory.preferredAlias || '').toLowerCase().trim();
    if (!patLower) continue;

    // 1. Exact match on rawPattern or preferredAlias (or exact after DuitNow cleanup)
    if (textLower === patLower || cleanedText === patLower) {
      consider(memory, 'exact', memory.rawPattern, 5);
      continue;
    }

    // 2. Standard safe match on rawPattern
    if (matchesPatternSafely(textLower, patLower) || matchesPatternSafely(cleanedText, patLower)) {
      consider(memory, 'pattern', memory.rawPattern, 4);
      continue;
    }

    // 3. Safe match on preferredAlias (skip purely generic commodity aliases unless exact equals)
    const aliasIsGeneric = Boolean(aliasLower) && isGenericCommodityTerm(aliasLower);
    if (
      aliasLower &&
      (textLower === aliasLower ||
        cleanedText === aliasLower ||
        (!aliasIsGeneric &&
          (matchesPatternSafely(textLower, aliasLower) || matchesPatternSafely(cleanedText, aliasLower))))
    ) {
      consider(memory, textLower === aliasLower || cleanedText === aliasLower ? 'exact' : 'alias', memory.preferredAlias, 3);
      continue;
    }

    // 4. Explicit trigger keywords ("字眼")
    const keywords = Array.isArray(memory.keywords) ? memory.keywords : [];
    let matchedKeyword: string | null = null;
    for (const rawKw of keywords) {
      const kw = String(rawKw || '').trim();
      const kwLower = kw.toLowerCase();
      if (!kwLower || kwLower.length < 2) continue;
      if (
        matchesPatternSafely(textLower, kwLower) ||
        matchesPatternSafely(cleanedText, kwLower) ||
        matchesCompactPattern(textCompact, cleanedCompact, compactTokens, toCompactHabitToken(kwLower))
      ) {
        if (!matchedKeyword || kw.length > matchedKeyword.length) {
          matchedKeyword = kw;
        }
      }
    }
    if (matchedKeyword) {
      consider(memory, 'keyword', matchedKeyword, 2);
      continue;
    }

    // 5. Space/punctuation-collapsed match on rawPattern or non-generic alias ("tanchinhong" / "jayagrocer")
    const patCompact = toCompactHabitToken(patLower);
    if (matchesCompactPattern(textCompact, cleanedCompact, compactTokens, patCompact)) {
      consider(memory, 'compact', memory.rawPattern, 2);
      continue;
    }
    if (aliasLower && !aliasIsGeneric) {
      const aliasCompact = toCompactHabitToken(aliasLower);
      if (matchesCompactPattern(textCompact, cleanedCompact, compactTokens, aliasCompact)) {
        consider(memory, 'compact', memory.preferredAlias, 2);
        continue;
      }
    }

    // 6. Distinctive CJK brand stem (e.g. "四夕" extracted from "四夕豆花")
    const stems = extractDistinctiveCjkStems(`${memory.preferredAlias || ''} ${memory.rawPattern || ''}`);
    let matchedStem: string | null = null;
    for (const stem of stems) {
      const stemLower = stem.toLowerCase();
      if (textLower.includes(stemLower) || cleanedText.includes(stemLower)) {
        if (!matchedStem || stem.length > matchedStem.length) {
          matchedStem = stem;
        }
      }
    }
    if (matchedStem) {
      consider(memory, 'stem', matchedStem, 1);
    }
  }

  if (!bestCandidate) return null;

  const chosen = bestCandidate as {
    memory: HabitMemoryItem;
    matchedVia: HabitMatchVia;
    matchedToken: string;
    score: number;
  };
  const patLower = chosen.memory.rawPattern.toLowerCase().trim();
  const aliasLower = chosen.memory.preferredAlias.toLowerCase().trim();
  return {
    matchedItem: chosen.memory,
    resolvedDescription: chosen.memory.preferredAlias,
    resolvedCategory: chosen.memory.category,
    matchedPattern: chosen.memory.rawPattern,
    matchedVia: chosen.matchedVia,
    matchedToken: chosen.matchedToken,
    isAlias: patLower !== aliasLower,
  };
}

export function learnOrStrengthenHabit(params: {
  rawInputOrMerchant: string;
  aliasOrDescription: string;
  category: string;
  subCategory?: string;
  amount?: number;
  timeSlot?: 'breakfast' | 'lunch' | 'dinner' | 'any';
  keywords?: string[];
  replaceKeywords?: boolean;
  aiNote?: string;
  source?: 'auto_learned' | 'user_confirmed' | 'manual';
  initialFrequency?: number;
}): HabitMemoryItem | null {
  const rawClean = cleanPayeeOrMerchantPattern(params.rawInputOrMerchant);
  const aliasClean = params.aliasOrDescription.trim();
  const categoryClean = params.category.trim();
  const source = params.source || 'auto_learned';

  if (!rawClean || rawClean.length < 2 || !aliasClean || !categoryClean) {
    return null;
  }

  if (SYSTEM_OR_RECEIPT_NOISE_REGEX.test(rawClean)) {
    return null;
  }

  // Strictly block auto_learned habits for generic terms, identical pairs, or long itemized receipt strings
  if (source === 'auto_learned') {
    if (
      ITEMIZED_RULE_TEXT_REGEX.test(params.rawInputOrMerchant) ||
      !isAllowedAutoLearnedPair(params.rawInputOrMerchant, aliasClean)
    ) {
      return null;
    }
  } else if (source === 'user_confirmed') {
    if (
      ITEMIZED_RULE_TEXT_REGEX.test(params.rawInputOrMerchant) ||
      ITEMIZED_RULE_TEXT_REGEX.test(aliasClean) ||
      rawClean.length > MAX_AUTO_RAW_PATTERN_LEN ||
      aliasClean.length > MAX_AUTO_ALIAS_LEN ||
      hasEmbeddedAmountOrPrice(params.rawInputOrMerchant) ||
      (rawClean.toLowerCase() === aliasClean.toLowerCase() && isGenericCommodityTerm(rawClean))
    ) {
      return null;
    }
  } else if (source === 'manual') {
    if (
      ITEMIZED_RULE_TEXT_REGEX.test(params.rawInputOrMerchant) ||
      ITEMIZED_RULE_TEXT_REGEX.test(aliasClean)
    ) {
      return null;
    }
  }

  const memories = getHabitMemories();
  const rawLower = rawClean.toLowerCase();
  const now = new Date().toISOString();
  const timeSlot = params.timeSlot || getCurrentTimeSlot();
  const keywordSource = source === 'manual' ? 'manual' : 'auto';
  const incomingKeywords = params.keywords
    ? sanitizeHabitKeywords(params.keywords, {
        source: keywordSource,
        rawPattern: rawClean,
        preferredAlias: aliasClean,
      })
    : undefined;

  const existingIndex = memories.findIndex(
    (m) => m.rawPattern.toLowerCase() === rawLower
  );

  let updatedItem: HabitMemoryItem;

  if (existingIndex >= 0) {
    const existing = memories[existingIndex];
    const newFrequency = (existing.frequency || 1) + 1;
    const newConfidence = Math.min(1.0, (existing.confidence || 0.7) + 0.1);
    const resolvedSource =
      source === 'manual'
        ? 'manual'
        : existing.learnedSource === 'manual'
          ? 'manual'
          : params.source || 'user_confirmed';
    const nextAlias =
      existing.learnedSource === 'manual' && source === 'auto_learned'
        ? existing.preferredAlias
        : aliasClean;
    const mergedKeywords =
      params.replaceKeywords && incomingKeywords !== undefined
        ? incomingKeywords
        : sanitizeHabitKeywords(
            [...(existing.keywords || []), ...(incomingKeywords || [])],
            {
              source: resolvedSource === 'manual' ? 'manual' : 'auto',
              rawPattern: rawClean,
              preferredAlias: nextAlias,
            }
          );

    updatedItem = {
      ...existing,
      rawPattern: rawClean,
      preferredAlias: nextAlias,
      category: categoryClean,
      subCategory: params.subCategory?.trim() || existing.subCategory,
      typicalAmount: typeof params.amount === 'number' && params.amount > 0 ? params.amount : existing.typicalAmount,
      timeSlot: existing.timeSlot === timeSlot ? timeSlot : 'any',
      ...(mergedKeywords.length > 0 ? { keywords: mergedKeywords } : { keywords: undefined }),
      ...(params.aiNote ? { aiNote: params.aiNote.trim() } : {}),
      frequency: newFrequency,
      confidence: newConfidence,
      learnedSource: resolvedSource,
      updatedAt: now,
    };
    memories[existingIndex] = updatedItem;
  } else {
    const startFreq =
      typeof params.initialFrequency === 'number' && params.initialFrequency > 0
        ? Math.round(params.initialFrequency)
        : source === 'manual'
          ? 3
          : 1;
    updatedItem = {
      id: `habit_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      rawPattern: rawClean,
      preferredAlias: aliasClean,
      category: categoryClean,
      subCategory: params.subCategory?.trim() || undefined,
      typicalAmount: typeof params.amount === 'number' && params.amount > 0 ? params.amount : undefined,
      timeSlot,
      ...(incomingKeywords && incomingKeywords.length > 0 ? { keywords: incomingKeywords } : {}),
      ...(params.aiNote ? { aiNote: params.aiNote.trim() } : {}),
      frequency: startFreq,
      confidence: source === 'manual' ? 1.0 : Math.min(0.95, 0.7 + startFreq * 0.08),
      learnedSource: source,
      createdAt: now,
      updatedAt: now,
    };
    memories.unshift(updatedItem);
  }

  persistHabitMemories(memories);
  return updatedItem;
}

export function updateHabitKeywords(idOrPattern: string, rawKeywords: string[]): HabitMemoryItem | null {
  if (typeof window === 'undefined' && typeof localStorage === 'undefined') return null;
  const memories = getHabitMemories();
  const lower = idOrPattern.toLowerCase();
  const idx = memories.findIndex(
    (m) => m.id === idOrPattern || m.rawPattern.toLowerCase() === lower
  );
  if (idx < 0) return null;

  const existing = memories[idx];
  const nextKeywords = sanitizeHabitKeywords(rawKeywords, {
    source: 'manual',
    rawPattern: existing.rawPattern,
    preferredAlias: existing.preferredAlias,
  });

  const updated: HabitMemoryItem = {
    ...existing,
    keywords: nextKeywords.length > 0 ? nextKeywords : undefined,
    updatedAt: new Date().toISOString(),
  };
  memories[idx] = updated;
  persistHabitMemories(memories);
  return updated;
}

export function getHabitCandidates(nowMs: number = Date.now()): HabitCandidateRecord[] {
  return loadHabitCandidates(nowMs);
}

export function saveAllHabitCandidates(candidates: HabitCandidateRecord[]): void {
  saveHabitCandidates(candidates);
}

function loadHabitCandidates(nowMs: number = Date.now()): HabitCandidateRecord[] {
  if (typeof window === 'undefined' && typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(HABIT_CANDIDATES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c): c is HabitCandidateRecord => {
      if (!c || typeof c !== 'object' || typeof c.key !== 'string') return false;
      const lastMs = Date.parse(String(c.lastSeenAt || ''));
      if (Number.isFinite(lastMs) && nowMs - lastMs > CANDIDATE_TTL_MS) return false;
      return isEligibleHabitMerchant(String(c.rawPattern || ''));
    });
  } catch {
    return [];
  }
}

function saveHabitCandidates(candidates: HabitCandidateRecord[]): void {
  if (typeof window === 'undefined' && typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(
      HABIT_CANDIDATES_STORAGE_KEY,
      JSON.stringify(candidates.slice(0, MAX_CANDIDATE_RECORDS))
    );
  } catch {
    // Ignore storage errors for non-critical candidate cache
  }
}

/**
 * Intelligent 2-stage habit learner:
 * - Rejects generic single food/item words ("sushi", "lunch"), embedded prices ("Shell 60"),
 *   itemized receipt summaries, and redundant built-in category rules ("Sushi King -> Food & Dining").
 * - Stages new patterns silently in `cashflow_habit_candidates` on first occurrence (`count = 1`)
 *   so one-off edits NEVER clutter Settings.
 * - Promotes to permanent Habit Memory ONLY when a consistent payee->alias or non-obvious category
 *   mapping repeats (`>= 2` times), or strengthens an existing matching habit.
 */
export function observeHabitCandidate(params: {
  rawInputOrMerchant: string;
  aliasOrDescription: string;
  category: string;
  subCategory?: string;
  amount?: number;
  timeSlot?: 'breakfast' | 'lunch' | 'dinner' | 'any';
}): { promoted: boolean; habit: HabitMemoryItem | null; candidateCount: number } {
  const rawInput = String(params.rawInputOrMerchant || '').trim();
  const rawClean = cleanPayeeOrMerchantPattern(rawInput);
  const aliasClean = String(params.aliasOrDescription || '').trim();
  const categoryClean = String(params.category || '').trim();

  if (!rawClean || !aliasClean || !categoryClean) {
    return { promoted: false, habit: null, candidateCount: 0 };
  }

  if (!isEligibleHabitMerchant(rawInput) || !isEligibleHabitMerchant(rawClean)) {
    return { promoted: false, habit: null, candidateCount: 0 };
  }

  if (
    aliasClean.length > MAX_AUTO_ALIAS_LEN ||
    ITEMIZED_RULE_TEXT_REGEX.test(aliasClean) ||
    SYSTEM_OR_RECEIPT_NOISE_REGEX.test(aliasClean)
  ) {
    return { promoted: false, habit: null, candidateCount: 0 };
  }

  const isAliasTranslation = rawClean.toLowerCase() !== aliasClean.toLowerCase();
  const isRedundant = isRedundantCategoryMapping(rawClean, aliasClean, categoryClean);

  // Never learn redundant 1-to-1 rules where built-in keyword classification already gets it right
  if (!isAliasTranslation && isRedundant) {
    return { promoted: false, habit: null, candidateCount: 0 };
  }

  const key = rawClean.toLowerCase();
  const nowIso = new Date().toISOString();
  const slot = params.timeSlot || getCurrentTimeSlot();
  const memories = getHabitMemories();
  const existing = memories.find((m) => m.rawPattern.toLowerCase() === key);

  if (existing) {
    const sameAlias = existing.preferredAlias.toLowerCase().trim() === aliasClean.toLowerCase();
    const sameCategory = existing.category.toLowerCase().trim() === categoryClean.toLowerCase();

    // User confirmed an already learned habit -> strengthen cleanly
    if (sameAlias && sameCategory) {
      const updated = learnOrStrengthenHabit({
        rawInputOrMerchant: rawClean,
        aliasOrDescription: aliasClean,
        category: categoryClean,
        subCategory: params.subCategory,
        amount: params.amount,
        timeSlot: slot,
        source: existing.learnedSource === 'manual' ? 'manual' : existing.learnedSource,
      });
      return { promoted: false, habit: updated, candidateCount: updated?.frequency || existing.frequency };
    }

    // Do not overwrite an existing manual/established habit on a single divergent transaction
    if (existing.learnedSource === 'manual') {
      return { promoted: false, habit: null, candidateCount: 0 };
    }
  }

  const candidates = loadHabitCandidates();
  const idx = candidates.findIndex((c) => c.key === key);

  if (idx < 0) {
    candidates.unshift({
      key,
      rawPattern: rawClean,
      preferredAlias: aliasClean,
      category: categoryClean,
      subCategory: params.subCategory?.trim() || undefined,
      count: 1,
      lastAmount: typeof params.amount === 'number' && params.amount > 0 ? params.amount : undefined,
      timeSlot: slot,
      firstSeenAt: nowIso,
      lastSeenAt: nowIso,
    });
    saveHabitCandidates(candidates);
    return { promoted: false, habit: null, candidateCount: 1 };
  }

  const prev = candidates[idx];
  const consistentTarget =
    prev.preferredAlias.toLowerCase().trim() === aliasClean.toLowerCase() &&
    prev.category.toLowerCase().trim() === categoryClean.toLowerCase();

  if (!consistentTarget) {
    // Sporadic one-off override -> reset candidate instead of overfitting
    candidates[idx] = {
      ...prev,
      preferredAlias: aliasClean,
      category: categoryClean,
      subCategory: params.subCategory?.trim() || undefined,
      count: 1,
      lastAmount: typeof params.amount === 'number' && params.amount > 0 ? params.amount : prev.lastAmount,
      timeSlot: slot,
      lastSeenAt: nowIso,
    };
    saveHabitCandidates(candidates);
    return { promoted: false, habit: null, candidateCount: 1 };
  }

  const nextCount = (prev.count || 1) + 1;
  if (nextCount < PROMOTE_THRESHOLD) {
    candidates[idx] = {
      ...prev,
      count: nextCount,
      lastAmount: typeof params.amount === 'number' && params.amount > 0 ? params.amount : prev.lastAmount,
      lastSeenAt: nowIso,
    };
    saveHabitCandidates(candidates);
    return { promoted: false, habit: null, candidateCount: nextCount };
  }

  // Reached repeated confirmation threshold -> promote out of candidates into active Habit Memory
  candidates.splice(idx, 1);
  saveHabitCandidates(candidates);

  const promotedHabit = learnOrStrengthenHabit({
    rawInputOrMerchant: rawClean,
    aliasOrDescription: aliasClean,
    category: categoryClean,
    subCategory: params.subCategory,
    amount: params.amount,
    timeSlot: prev.timeSlot === slot ? slot : 'any',
    source: isAliasTranslation ? 'auto_learned' : 'user_confirmed',
    initialFrequency: nextCount,
  });

  return {
    promoted: Boolean(promotedHabit),
    habit: promotedHabit,
    candidateCount: nextCount,
  };
}

export function clearNonManualHabits(): { removed: number; remaining: HabitMemoryItem[] } {
  if (typeof window === 'undefined' && typeof localStorage === 'undefined') {
    return { removed: 0, remaining: DEFAULT_HABIT_MEMORIES };
  }
  const memories = getHabitMemories();
  const remaining = memories.filter((m) => m.learnedSource === 'manual');
  const removed = memories.length - remaining.length;
  if (removed > 0) {
    persistHabitMemories(remaining);
  }
  try {
    localStorage.removeItem(HABIT_CANDIDATES_STORAGE_KEY);
  } catch {
    // ignore
  }
  return { removed, remaining };
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

    if (!rawPayee || !isEligibleHabitMerchant(rawPayee)) continue;

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

    if (topAlias && topAliasCount >= 2 && isAllowedAutoLearnedPair(data.raw, topAlias)) {
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
