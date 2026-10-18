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

// Pre-seeded well-known Malaysian merchant defaults
export const DEFAULT_MERCHANT_RULES: MerchantCategoryRule[] = [
  {
    id: 'rule_four_beans',
    merchantPattern: '四夕豆花',
    category: 'Food & Dining',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
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

const NOISE_TERMS_REGEX = /^(?:payment|kinova|automation|shortcut|receipt|order|bill|expense|income)$/i;

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
  if (!cleanPattern || cleanPattern.length < 2 || NOISE_TERMS_REGEX.test(cleanPattern)) {
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
