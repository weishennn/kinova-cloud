export const SETTINGS_UPDATED_EVENT = 'cashflow_cloud_settings_synced';

export interface MerchantCategoryRule {
  id: string;
  merchantPattern: string;
  category: string;
  subCategory?: string;
  createdAt: string;
  updatedAt: string;
}

const STORAGE_KEY = 'cashflow_merchant_category_rules';

// Pre-seeded well-known regional merchant defaults
export const DEFAULT_MERCHANT_RULES: MerchantCategoryRule[] = [
  {
    id: 'rule_shell',
    merchantPattern: 'Shell',
    category: 'Transport',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'rule_petronas',
    merchantPattern: 'Petronas',
    category: 'Transport',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'rule_jaya_grocer',
    merchantPattern: 'Jaya Grocer',
    category: 'Shopping',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

export const SYSTEM_OR_RECEIPT_NOISE_REGEX = /^(?:payment|kinova(?:\s*automation)?|automation|shortcuts?|screenshot|receipt(?:\s*expense)?|order(?:\s*details|\s*id.*)?|bill|expense|income|payment\s*successful?|payment\s*completed?|transaction\s*(?:successful?|details)|food\s*stall(?:\s*\([^)]*\))?|food\s*court|hawker\s*stall|shopeepay(?:\s*balance)?|ewallet(?:\s*balance)?|duitnow\s*qr|touch\s*'?\s*n\s*go(?:\s*ewallet)?)$/i;
export const ITEMIZED_RULE_TEXT_REGEX = /[（(][^）)]*[,、+][^）)]*[）)]|\+\s*\d+\s*more|^\s*\d+\s*[xX×]\s+|\s+[xX×]\s*\d+\s*$|(?:[^,、+]+[,、+]\s*){2,}[^,、+]+/i;
export const GENERIC_COMMODITY_TERM_REGEX = /^(?:(?:\d+\s*[xX×]?\s*)?(?:plates?|bowls?|cups?|pcs?|pieces?|盘|碟|碗|杯|份|个)?\s*)?(?:sushi|sashimi|ramen|udon|donburi|takoyaki|dim\s*sum|chicken\s*rice|nasi\s*lemak|roti\s*canai|mee\s*goreng|laksa|kopi|teh|coffee|latte|americano|matcha|boba|milk\s*tea|tea|water|juice|beer|wine|cake|bread|roti|dessert|ice\s*cream|breakfast|lunch|dinner|supper|brunch|meal|meals|food|drink|drinks|snack|snacks|makan|minum|groceries|grocery|petrol|fuel|gas|diesel|ron95|ron97|parking|toll|rfid|grab|taxi|ride|train|mrt|lrt|bus|flight|shopping|clothes|shoes|medicine|panadol|clinic|movie|movies|cinema|ticket|gift|gifts|present|utilities|electricity|bill|bills|rent|insurance|早餐|早饭|午餐|午饭|晚餐|晚饭|宵夜|夜宵|早茶|下午茶|寿司|刺身|拉面|乌冬|杂饭|经济饭|鸡饭|炒饭|炒面|咖啡|拿铁|奶茶|饮料|甜品|豆花|面包|蛋糕|零食|买菜|超市|餐饮|吃饭|美食|外卖|添油|加油|汽油|油费|打车|停车|泊车|过路费|电费|水费|网费|房租|话费|购物|买衣服|看病|买药|电影|礼物|红包)$/i;
const MAX_RULE_PATTERN_LEN = 36;

export function hasEmbeddedAmountOrPrice(input: string): boolean {
  const clean = normalizePattern(input);
  if (!clean) return false;
  if (/(?:rm|myr|sgd|usd|s\$|cny|rmb|¥|\$|€|£)\s*\d+(?:\.\d{1,2})?/i.test(clean)) return true;
  if (
    /[a-z\u4e00-\u9fa5]\s+\d+(?:\.\d{1,2})?$/i.test(clean) &&
    !/\b(?:lot|no|unit|block|blk|level|lvl|floor|phase|seksyen|section|jalan|jln|ss)\s+\d+$/i.test(clean)
  ) {
    return true;
  }
  return false;
}

export function isPollutedMerchantRulePattern(pattern: string): boolean {
  const clean = normalizePattern(pattern);
  if (!clean || clean.length < 2 || clean.length > MAX_RULE_PATTERN_LEN) return true;
  if (SYSTEM_OR_RECEIPT_NOISE_REGEX.test(clean)) return true;
  if (ITEMIZED_RULE_TEXT_REGEX.test(pattern) || ITEMIZED_RULE_TEXT_REGEX.test(clean)) return true;
  if (GENERIC_COMMODITY_TERM_REGEX.test(clean)) return true;
  if (hasEmbeddedAmountOrPrice(pattern)) return true;
  return false;
}

export function normalizePattern(input: string): string {
  let cleaned = input.trim();
  cleaned = cleaned.replace(/\s*\(.*?\)\s*/g, ' ');
  cleaned = cleaned.replace(/^(?:payment to|purchase at|paid to)\s+/i, '');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  return cleaned;
}

export function getMerchantCategoryRules(): MerchantCategoryRule[] {
  if (typeof window === 'undefined') return DEFAULT_MERCHANT_RULES;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_MERCHANT_RULES;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_MERCHANT_RULES;
    return parsed;
  } catch {
    return DEFAULT_MERCHANT_RULES;
  }
}

export function saveMerchantCategoryRule(
  merchantPattern: string,
  category: string,
  subCategory?: string
): MerchantCategoryRule | null {
  const cleanPattern = normalizePattern(merchantPattern);
  if (!cleanPattern || isPollutedMerchantRulePattern(merchantPattern)) {
    return null;
  }

  const cleanCategory = category.trim();
  if (!cleanCategory) return null;

  const currentRules = getMerchantCategoryRules();
  const patternLower = cleanPattern.toLowerCase();

  const now = new Date().toISOString();
  let updatedRule: MerchantCategoryRule;

  const existingIndex = currentRules.findIndex(
    (r) => r.merchantPattern.toLowerCase() === patternLower
  );

  if (existingIndex >= 0) {
    updatedRule = {
      ...currentRules[existingIndex],
      merchantPattern: cleanPattern,
      category: cleanCategory,
      subCategory: subCategory?.trim() || undefined,
      updatedAt: now,
    };
    currentRules[existingIndex] = updatedRule;
  } else {
    updatedRule = {
      id: `rule_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      merchantPattern: cleanPattern,
      category: cleanCategory,
      subCategory: subCategory?.trim() || undefined,
      createdAt: now,
      updatedAt: now,
    };
    currentRules.unshift(updatedRule);
  }

  if (typeof window !== 'undefined') {
    try {
      const serialized = JSON.stringify(currentRules);
      localStorage.setItem(STORAGE_KEY, serialized);
      import('./cloud-settings-sync')
        .then((m) => m.saveSettingWithCloudSync(STORAGE_KEY, serialized))
        .catch(() => {});
      window.dispatchEvent(new Event(SETTINGS_UPDATED_EVENT));
    } catch (err) {
      console.warn('[MerchantRules] Failed to save rule:', err);
    }
  }

  return updatedRule;
}

export function deleteMerchantCategoryRule(id: string): boolean {
  if (typeof window === 'undefined') return false;
  const currentRules = getMerchantCategoryRules();
  const filtered = currentRules.filter((r) => r.id !== id && r.merchantPattern !== id);
  if (filtered.length === currentRules.length) return false;

  try {
    const serialized = JSON.stringify(filtered);
    localStorage.setItem(STORAGE_KEY, serialized);
    import('./cloud-settings-sync')
      .then((m) => m.saveSettingWithCloudSync(STORAGE_KEY, serialized))
      .catch(() => {});
    window.dispatchEvent(new Event(SETTINGS_UPDATED_EVENT));
    return true;
  } catch (err) {
    console.warn('[MerchantRules] Failed to delete rule:', err);
    return false;
  }
}

/**
 * Matches a merchant name or description against user-remembered rules.
 * Prioritizes user rules before generic regex/AI guessing.
 */
export function matchMerchantCategoryRule(
  merchantOrDesc: string,
  rulesOverride?: MerchantCategoryRule[]
): MerchantCategoryRule | null {
  const text = String(merchantOrDesc || '').trim();
  if (!text || text.length < 2) return null;

  const rawRules = rulesOverride || getMerchantCategoryRules();
  const rules = Array.isArray(rawRules) ? rawRules : [];
  if (rules.length === 0) return null;

  // Sort longest pattern first so specific matches take precedence over broad ones
  const sorted = rules.slice().sort(
    (a, b) => b.merchantPattern.length - a.merchantPattern.length
  );

  const textLower = text.toLowerCase();

  for (const rule of sorted) {
    const patLower = rule.merchantPattern.toLowerCase();
    if (patLower === textLower || textLower.includes(patLower)) {
      return rule;
    }
  }

  return null;
}
