import crypto from 'crypto';
import { matchMerchantCategoryRule } from './merchant-rules.ts';
import { normalizeToCanonicalCategory } from './canonical-categories.ts';

export type ShortcutTriggerSource = 'back_tap_screenshot' | 'apple_pay_wallet';

export interface ShortcutDraftItem {
  name: string;
  amount: number;
  category?: string;
}

export interface ShortcutQuickDraft {
  draftId: string;
  source: ShortcutTriggerSource;
  createdAt: string;
  expiresAtMs: number;
  ownerEmail?: string;
  amount: number | null;
  currency: string;
  currencyAmbiguous: boolean;
  candidateCurrencies: string[];
  type: 'Expense' | 'Income' | 'Investment';
  category: string;
  description: string;
  merchant: string;
  cardOrPass?: string;
  date: string;
  subtotal?: number | null;
  taxAmount?: number | null;
  taxRate?: number | null;
  taxIncluded?: boolean;
  taxLabel?: string;
  discountAmount?: number | null;
  dealsDescription?: string | null;
  billAmount?: number | null;
  items?: ShortcutDraftItem[];
  ocrSummary?: string;
  assistantAdvice?: string;
  proposedActionLabel?: string;
  notes: string;
  missingFields: Array<'amount' | 'description' | 'currency' | 'category'>;
  uncertainFields: Array<'amount' | 'description' | 'currency' | 'category'>;
  fingerprint: string;
  suspectedDuplicateOfDraftId?: string | null;
  aiDisclosure: string;
}

export interface LedgerTransactionSummary {
  id: string;
  date: string;
  amount: number;
  currency?: string;
  description: string;
  category: string;
  type?: string;
}

export const SHORTCUT_DRAFT_TTL_MS = 15 * 60 * 1000; // 15 minutes

const VALID_CURRENCIES = new Set([
  'MYR', 'USD', 'SGD', 'EUR', 'GBP', 'JPY', 'AUD', 'IDR', 'THB', 'CNY', 'HKD', 'TWD', 'KRW',
]);

const AMBIGUOUS_SYMBOLS: Record<string, string[]> = {
  '$': ['MYR', 'SGD', 'USD', 'AUD', 'HKD', 'TWD'],
  '¥': ['JPY', 'CNY'],
  '￥': ['JPY', 'CNY'],
};

const UNAMBIGUOUS_SYMBOL_MAP: Array<{ pattern: RegExp; currency: string }> = [
  { pattern: /\bRM\b/i, currency: 'MYR' },
  { pattern: /\bMYR\b/i, currency: 'MYR' },
  { pattern: /\bSGD\b|S\$/i, currency: 'SGD' },
  { pattern: /\bUSD\b|US\$/i, currency: 'USD' },
  { pattern: /\bAUD\b|A\$/i, currency: 'AUD' },
  { pattern: /\bHKD\b|HK\$/i, currency: 'HKD' },
  { pattern: /\bTWD\b|NT\$/i, currency: 'TWD' },
  { pattern: /\bJPY\b/i, currency: 'JPY' },
  { pattern: /\bCNY\b|\bRMB\b/i, currency: 'CNY' },
  { pattern: /\bTHB\b|฿/i, currency: 'THB' },
  { pattern: /\bIDR\b|\bRp\b/i, currency: 'IDR' },
  { pattern: /\bEUR\b|€/i, currency: 'EUR' },
  { pattern: /\bGBP\b|£/i, currency: 'GBP' },
];

const MERCHANT_CATEGORY_RULES: Array<{ regex: RegExp; category: string }> = [
  {
    regex: /\b(grab|airasia|shell|petronas|petron|caltex|bhpetrol|touch\s*n\s*go|tng|rapidkl|mrt|lrt|ktm|erl|parking|toll|beam|socars|uber|taxi|fuelsave|ron95|ron97|diesel|petrol|stesen\s*minyak|budi\s*madani|transit|transport|travel|flight|airline|train|bus)\b/i,
    category: 'Transport',
  },
  {
    regex: /\b(f\s*&?\s*and\s*b|f\s*&\s*b|fnb|fb|starbucks|zus|tealive|chagee|mcdonald|kfc|nando|pelita|kopitiam|cafe|coffee|bakery|bakeshop|bake|roti|pastry|ramen|sushi|bistro|restaurant|restoran|resto|mamak|foodpanda|grabfood|dining|kitchen|hotpot|barbecue|bbq|steamboat|food\s*court|hawker|canteen|cafeteria|catering|eatery|s11|dessert|tea|boba|noodles?|rice|nasi|mee|dim\s*sum|cake|bread|makan|minum|warung|gerai|omakase|izakaya|kaiseki|kappo|buffet|boulangerie|patisserie|trattoria|pizzeria|taqueria|gelato|yakitori|udon|soba|donburi|teppanyaki|shabu)\b|餐饮|吃饭|餐馆|饮食|外卖|午餐|晚餐|早餐|买菜|超市|零食|饮料|奶茶|茶室|酒楼|食堂|档口|美食|快餐|海鲜|火锅|杂饭|小吃|甜品|面馆|饭店|日料|居酒屋|自助餐|烧烤|烤肉|串串|大排档/i,
    category: 'Food & Dining',
  },
  {
    regex: /\b(uniqlo|zara|shopee|lazada|taobao|ikea|decathlon|aeon|jaya\s*grocer|village\s*grocer|99\s*speedmart|lotus|mydin|giant|watson|guardian|sephora|apple\s*store|machines|switch|harvey\s*norman|shopping|supermarket|hypermarket|grocer|grocery|market|pasar|mall|retail|store|hardware|diy|convenience|furniture|appliances?|stationery|clothes|clothing|fashion|shoes)\b/i,
    category: 'Shopping',
  },
  {
    regex: /\b(tnb|tenaga|syabas|air\s*selangor|indah\s*water|time\s*dotcom|unifi|maxis|celcom|digi|umobile|yes\s*5g|astro|coway|cuckoo|bill|bills|utility|utilities|electric|electricity|water|telecom|telco|internet|broadband|rental|maintenance)\b/i,
    category: 'Housing & Bills',
  },
  {
    regex: /\b(gsc|tgv|cinema|netflix|spotify|youtube|disney|steam|playstation|nintendo|genting|karaoke|ktv|movie|movies|film|entertainment|concert)\b/i,
    category: 'Entertainment',
  },
  {
    regex: /\b(clinic|klinik|hospital|gleneagles|sunway\s*medical|pantai|kpj|pharmacy|farmasi|caring|big\s*pharmacy|aa\s*pharmacy|dental|dentist|doctor|medical|medicine|healthcare|wellness)\b/i,
    category: 'Health',
  },
  {
    regex: /\b(aia|prudential|great\s*eastern|allianz|zurich|etiqa|takaful|manulife|fwd|insurance|assurance|policy|premium)\b/i,
    category: 'Insurance',
  },
];

/**
 * System and notification noise terms that must NEVER be accepted as merchant names.
 */
export const SYSTEM_NOTIFICATION_NOISE_REGEX =
  /^(?:kinova(?:\s*automation)?|automation|shortcuts?|screenshot|dynamic\s*island|notification|back\s*tap|now|payment\s*successful?|payment\s*success|payment\s*completed?|transaction\s*successful?|transaction\s*details|order\s*details|order\s*id(?::\s*[A-Z0-9_-]+)?|successful|receipt|food\s*stall(?:\s*\([^)]*\))?|food\s*court|hawker\s*stall|shopeepay(?:\s*balance)?|ewallet(?:\s*balance)?|balance)$/i;

/**
 * Sanitizes candidate merchant names, stripping notification titles or extracting
 * the true merchant from contextual OCR text, in-app navigation headers, or e-wallet Memos.
 */
export function sanitizeMerchantCandidate(rawName: string, contextText?: string): string {
  let cleaned = String(rawName || '').trim();
  if (!cleaned || SYSTEM_NOTIFICATION_NOISE_REGEX.test(cleaned)) {
    cleaned = '';
  }

  // If candidate was noise or empty, try extracting known merchants from context text
  if (!cleaned && contextText) {
    const text = contextText.trim();
    // 1. Try extracting merchant from in-app navigation title bars (e.g. "✕ Four Beans 四夕豆花 - Taman Me...")
    const headerMatch = text.match(/(?:^|\n|\s)(?:[✕\u2715\u274c\u00d7<〈‹]|X\s+)\s*([A-Za-z0-9\u4e00-\u9fa5\s&'-]+?)(?:\s*-\s*[A-Za-z0-9\s]*\.\.\.|\s*-\s*[A-Za-z0-9\s]+|\n|$)/i);
    if (headerMatch && headerMatch[1] && !SYSTEM_NOTIFICATION_NOISE_REGEX.test(headerMatch[1].trim())) {
      cleaned = headerMatch[1].trim();
    }

    // 2. Check general merchant patterns in text (F&B groups, restaurants, petrol stations, etc.)
    if (!cleaned) {
      const generalEntityMatch = text.match(/\b([A-Za-z0-9\u4e00-\u9fa5\s&'-]+?\s+(?:F\s*&?\s*and\s*B|F\s*&\s*B|FNB|Food\s*Court|Kopitiam|Restaurant|Restoran|Cafe|Bakery|Bistro|Group|Branch|Store|Mart|Trading))\b/i);
      if (generalEntityMatch && generalEntityMatch[1] && !SYSTEM_NOTIFICATION_NOISE_REGEX.test(generalEntityMatch[1].trim())) {
        cleaned = generalEntityMatch[1].trim();
      }
    }

    // 3. Check known major retail/station brands
    if (!cleaned) {
      const brandMatches = [
        /\b(SHELL(?:\s+[A-Z0-9\s/]+)?)\b/i,
        /\b(PETRONAS(?:\s+[A-Z0-9\s/]+)?)\b/i,
        /\b(CALTEX(?:\s+[A-Z0-9\s/]+)?)\b/i,
        /\b(BHPETROL(?:\s+[A-Z0-9\s/]+)?)\b/i,
        /\b(MCDONALD'?S?)\b/i,
        /\b(KFC)\b/i,
        /\b(STARBUCKS)\b/i,
        /\b(FAMILYMART)\b/i,
        /\b(7-ELEVEN)\b/i,
        /\b(TOUCH\s*'N\s*GO|TNG)\b/i,
        /\b(GRAB(?:\s*FOOD)?)\b/i,
      ];
      for (const rx of brandMatches) {
        const m = text.match(rx);
        if (m && m[1] && !SYSTEM_NOTIFICATION_NOISE_REGEX.test(m[1].trim())) {
          cleaned = m[1].trim();
          break;
        }
      }
    }

    // 3. Check e-wallet Memo / Remark / Recipient Reference (e.g. ShopeePay "Memo: Chicken rice", "Memo Chicken rice", TNG "Remark: Laksa")
    if (!cleaned) {
      const memoMatch = text.match(/\b(?:memo|remark|recipient\s*reference|payment\s*details)\s*[:：]?\s*([A-Za-z0-9\u4e00-\u9fa5\s&'/+-]+?)(?=\s*(?:Order\s*SN|Transaction\s*SN|Payment\s*Method|Merchant\s*Location|RM|\d{1,2}:\d{2}|$|\n))/i);
      if (memoMatch && memoMatch[1]) {
        const candMemo = memoMatch[1].trim();
        if (candMemo && !SYSTEM_NOTIFICATION_NOISE_REGEX.test(candMemo) && !/^(?:RM|MYR|\d+)/i.test(candMemo)) {
          cleaned = candMemo;
        }
      }
    }
  }

  // Clean trailing truncated UI text (e.g. "Four Beans 四夕豆花 - Taman Me...")
  cleaned = cleaned.replace(/\s*-\s*[A-Za-z0-9\s]*\.\.\.$/, '').trim();
  return cleaned;
}


export interface ShortcutAutoRecordedEntry {
  transactionId: string;
  ownerEmail: string;
  sheetName: string;
  recordedAt: string;
  rowData: Record<string, unknown>;
}

export interface AutoHealShortcutRecord {
  healId: string;
  ownerEmail: string;
  sheetName: string;
  mutationId: string;
  rowData: Record<string, unknown>;
  createdAt: string;
  attempts: number;
  lastAttemptAt?: string;
  lastError?: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __kinovaShortcutDraftMap: Map<string, ShortcutQuickDraft> | undefined;
  // eslint-disable-next-line no-var
  var __kinovaAckedShortcutDraftSet: Set<string> | undefined;
  // eslint-disable-next-line no-var
  var __kinovaRecentAutoRecordedMap: Map<string, ShortcutAutoRecordedEntry> | undefined;
  // eslint-disable-next-line no-var
  var __kinovaShortcutAutoHealMap: Map<string, AutoHealShortcutRecord> | undefined;
  // eslint-disable-next-line no-var
  var __kinovaAckedAutoHealSet: Set<string> | undefined;
}

function getDraftStore(): Map<string, ShortcutQuickDraft> {
  if (!globalThis.__kinovaShortcutDraftMap) {
    globalThis.__kinovaShortcutDraftMap = new Map<string, ShortcutQuickDraft>();
  }
  return globalThis.__kinovaShortcutDraftMap;
}

function getAckedDraftSet(): Set<string> {
  if (!globalThis.__kinovaAckedShortcutDraftSet) {
    globalThis.__kinovaAckedShortcutDraftSet = new Set<string>();
  }
  return globalThis.__kinovaAckedShortcutDraftSet;
}

function getRecentAutoRecordedStore(): Map<string, ShortcutAutoRecordedEntry> {
  if (!globalThis.__kinovaRecentAutoRecordedMap) {
    globalThis.__kinovaRecentAutoRecordedMap = new Map<string, ShortcutAutoRecordedEntry>();
  }
  return globalThis.__kinovaRecentAutoRecordedMap;
}

function getAutoHealStore(): Map<string, AutoHealShortcutRecord> {
  if (!globalThis.__kinovaShortcutAutoHealMap) {
    globalThis.__kinovaShortcutAutoHealMap = new Map<string, AutoHealShortcutRecord>();
  }
  return globalThis.__kinovaShortcutAutoHealMap;
}

function getAckedAutoHealSet(): Set<string> {
  if (!globalThis.__kinovaAckedAutoHealSet) {
    globalThis.__kinovaAckedAutoHealSet = new Set<string>();
  }
  return globalThis.__kinovaAckedAutoHealSet;
}

export function isShortcutDraftAcknowledged(draftId?: string | null): boolean {
  const cleanId = String(draftId || '').trim();
  if (!cleanId) return false;
  return getAckedDraftSet().has(cleanId);
}

export function pruneExpiredShortcutDrafts(nowMs = Date.now()): void {
  const store = getDraftStore();
  for (const [id, draft] of store.entries()) {
    if (draft.expiresAtMs <= nowMs) {
      store.delete(id);
    }
  }
}

export function normalizeMerchantForFingerprint(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(sdn\.?\s*bhd\.?|pte\.?\s*ltd\.?|plt|inc|llc|corp)\b/gi, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function computeShortcutDraftFingerprint(input: {
  date: string;
  currency: string;
  amount: number | null;
  merchantOrDescription: string;
}): string {
  const datePart = String(input.date || '').trim().slice(0, 10);
  const currPart = String(input.currency || 'MYR').trim().toUpperCase();
  const amtPart =
    typeof input.amount === 'number' && Number.isFinite(input.amount) && input.amount > 0
      ? Math.round(input.amount * 100).toString()
      : 'missing_amt';
  const merchPart = normalizeMerchantForFingerprint(input.merchantOrDescription) || 'missing_merchant';
  const raw = `${datePart}|${currPart}|${amtPart}|${merchPart}`;
  const hash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16);
  return `kfp_${hash}`;
}

/**
 * Parses a raw amount/currency input from iOS Shortcuts `Transaction` (Wallet / Apple Pay) trigger.
 * Never assumes the trigger always provides amount, currency, or merchant.
 */
export function parseAmountAndCurrencyFromRawInput(
  rawAmount: unknown,
  rawCurrency?: unknown,
  defaultCurrency = 'MYR'
): {
  amount: number | null;
  currency: string;
  currencyProvided: boolean;
  currencyAmbiguous: boolean;
  candidateCurrencies: string[];
} {
  let explicitCurrency = typeof rawCurrency === 'string' ? rawCurrency.trim().toUpperCase() : '';
  let currencyProvided = false;
  let currencyAmbiguous = false;
  let candidateCurrencies: string[] = [defaultCurrency];

  if (explicitCurrency && VALID_CURRENCIES.has(explicitCurrency)) {
    currencyProvided = true;
    candidateCurrencies = [explicitCurrency];
  } else if (explicitCurrency && AMBIGUOUS_SYMBOLS[explicitCurrency]) {
    currencyAmbiguous = true;
    candidateCurrencies = AMBIGUOUS_SYMBOLS[explicitCurrency];
    explicitCurrency = defaultCurrency;
  } else if (explicitCurrency) {
    let matchedSymbol = false;
    for (const rule of UNAMBIGUOUS_SYMBOL_MAP) {
      if (rule.pattern.test(explicitCurrency)) {
        explicitCurrency = rule.currency;
        currencyProvided = true;
        candidateCurrencies = [rule.currency];
        matchedSymbol = true;
        break;
      }
    }
    if (!matchedSymbol) {
      explicitCurrency = '';
    }
  }

  if (typeof rawAmount === 'number' && Number.isFinite(rawAmount) && rawAmount > 0) {
    return {
      amount: Number(rawAmount.toFixed(2)),
      currency: explicitCurrency || defaultCurrency,
      currencyProvided,
      currencyAmbiguous,
      candidateCurrencies,
    };
  }

  if (typeof rawAmount === 'string' && rawAmount.trim()) {
    const str = rawAmount.trim();
    if (!currencyProvided) {
      for (const rule of UNAMBIGUOUS_SYMBOL_MAP) {
        if (rule.pattern.test(str)) {
          explicitCurrency = rule.currency;
          currencyProvided = true;
          candidateCurrencies = [rule.currency];
          break;
        }
      }
      if (!currencyProvided) {
        if (/(?<![A-Z])\$(?!\s*[A-Z])/i.test(str)) {
          currencyAmbiguous = true;
          candidateCurrencies = AMBIGUOUS_SYMBOLS['$'];
        } else if (/[¥￥]/.test(str)) {
          currencyAmbiguous = true;
          candidateCurrencies = AMBIGUOUS_SYMBOLS['¥'];
        }
      }
    }

    const numericCleaned = str.replace(/,/g, '').match(/(\d+(?:\.\d{1,2})?)/);
    if (numericCleaned) {
      const parsedNum = parseFloat(numericCleaned[1]);
      if (Number.isFinite(parsedNum) && parsedNum > 0) {
        return {
          amount: Number(parsedNum.toFixed(2)),
          currency: explicitCurrency || defaultCurrency,
          currencyProvided,
          currencyAmbiguous,
          candidateCurrencies,
        };
      }
    }
  }

  return {
    amount: null,
    currency: explicitCurrency || defaultCurrency,
    currencyProvided,
    currencyAmbiguous,
    candidateCurrencies,
  };
}

export function inferCategoryFromMerchant(merchantOrDesc: string, explicitCategory?: string): {
  category: string;
  isUncertain: boolean;
} {
  if (explicitCategory && explicitCategory.trim()) {
    const normalized = normalizeToCanonicalCategory(explicitCategory, 'Expense', merchantOrDesc);
    if (normalized !== 'Other') {
      return { category: normalized, isUncertain: false };
    }
  }
  const text = String(merchantOrDesc || '').trim();
  if (!text) {
    return { category: 'Food & Dining', isUncertain: true };
  }

  // 1. Prioritize user remembered merchant category rules
  const userRule = matchMerchantCategoryRule(text);
  if (userRule) {
    return { category: userRule.category, isUncertain: false };
  }

  // 2. Single source of truth: canonical category context inference
  const canonicalInferred = normalizeToCanonicalCategory(undefined, 'Expense', text);
  if (canonicalInferred && canonicalInferred !== 'Other') {
    return { category: canonicalInferred, isUncertain: false };
  }

  // 3. Predefined pattern rules
  for (const rule of MERCHANT_CATEGORY_RULES) {
    if (rule.regex.test(text)) {
      return { category: rule.category, isUncertain: false };
    }
  }
  return { category: 'Food & Dining', isUncertain: true };
}

/**
 * Normalizes an Apple Pay (iOS Shortcuts Wallet Transaction trigger) payload into a pending draft.
 * Critically:
 * - Does NOT assume amount, currency, or merchant are always present.
 * - Flags any missing or uncertain fields so the user is prompted to complete them before saving.
 */
export function normalizeApplePayTransactionInput(
  payload: Record<string, unknown>,
  todayDate: string
): Omit<ShortcutQuickDraft, 'draftId' | 'createdAt' | 'expiresAtMs' | 'suspectedDuplicateOfDraftId'> {
  const rawMerchant =
    typeof payload.merchant === 'string' && payload.merchant.trim()
      ? payload.merchant.trim()
      : typeof payload.description === 'string' && payload.description.trim()
        ? payload.description.trim()
        : typeof payload.name === 'string' && payload.name.trim()
          ? payload.name.trim()
          : '';

  const cardOrPass =
    typeof payload.cardOrPass === 'string' && payload.cardOrPass.trim()
      ? payload.cardOrPass.trim()
      : typeof payload.card === 'string' && payload.card.trim()
        ? payload.card.trim()
        : typeof payload.pass === 'string' && payload.pass.trim()
          ? payload.pass.trim()
          : undefined;

  const parsedMoney = parseAmountAndCurrencyFromRawInput(
    payload.amount ?? payload.transactionAmount ?? payload.value,
    payload.currency ?? payload.currencyCode,
    'MYR'
  );

  const rawDate = typeof payload.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(payload.date.trim())
    ? payload.date.trim()
    : todayDate;

  const catInference = inferCategoryFromMerchant(
    rawMerchant,
    typeof payload.category === 'string' ? payload.category : undefined
  );

  const missingFields: Array<'amount' | 'description' | 'currency' | 'category'> = [];
  const uncertainFields: Array<'amount' | 'description' | 'currency' | 'category'> = [];

  if (parsedMoney.amount === null || parsedMoney.amount <= 0) {
    missingFields.push('amount');
  }
  if (!rawMerchant) {
    missingFields.push('description');
  }
  if (parsedMoney.currencyAmbiguous) {
    uncertainFields.push('currency');
  } else if (!parsedMoney.currencyProvided && parsedMoney.amount !== null) {
    uncertainFields.push('currency');
  }
  if (catInference.isUncertain) {
    uncertainFields.push('category');
  }

  const fingerprint = computeShortcutDraftFingerprint({
    date: rawDate,
    currency: parsedMoney.currency,
    amount: parsedMoney.amount,
    merchantOrDescription: rawMerchant || cardOrPass || 'apple_pay',
  });

  const noteParts = [
    'Apple Pay 快捷指令草稿（待核对确认）',
    cardOrPass ? `支付卡/凭证: ${cardOrPass}` : '',
    typeof payload.notes === 'string' ? payload.notes.trim() : '',
  ].filter(Boolean);

  return {
    source: 'apple_pay_wallet',
    amount: parsedMoney.amount,
    currency: parsedMoney.currency,
    currencyAmbiguous: parsedMoney.currencyAmbiguous,
    candidateCurrencies: parsedMoney.candidateCurrencies,
    type: 'Expense',
    category: catInference.category,
    description: rawMerchant,
    merchant: rawMerchant,
    cardOrPass,
    date: rawDate,
    notes: noteParts.join(' · '),
    missingFields,
    uncertainFields,
    fingerprint,
    aiDisclosure: '此草稿由您 iPhone 上的 Apple Pay 个人自动化传入，未调用后台自动记账，需您核对并点击保存后才会写入账本。',
  };
}

/**
 * Stores a quick draft in the server's ephemeral memory store and checks for recent duplicate drafts.
 */
export function saveShortcutQuickDraft(
  draftInput: Omit<ShortcutQuickDraft, 'draftId' | 'createdAt' | 'expiresAtMs' | 'suspectedDuplicateOfDraftId'>,
  nowMs = Date.now()
): ShortcutQuickDraft {
  pruneExpiredShortcutDrafts(nowMs);
  const store = getDraftStore();

  let suspectedDuplicateOfDraftId: string | null = null;
  for (const existing of store.values()) {
    const ageMs = nowMs - new Date(existing.createdAt).getTime();
    if (
      ageMs <= 15_000 &&
      existing.fingerprint === draftInput.fingerprint &&
      draftInput.amount !== null &&
      draftInput.amount > 0
    ) {
      suspectedDuplicateOfDraftId = existing.draftId;
      break;
    }
  }

  const rawRandomId = `drf_${crypto.randomBytes(8).toString('hex')}`;
  const fullDraft: ShortcutQuickDraft = {
    ...draftInput,
    draftId: rawRandomId,
    createdAt: new Date(nowMs).toISOString(),
    expiresAtMs: nowMs + SHORTCUT_DRAFT_TTL_MS,
    suspectedDuplicateOfDraftId,
  };

  // Generate a stateless, tamper-proof encrypted ticket so it works across any serverless instance
  const encryptedId = encodeOpaqueDraftTicket(fullDraft);
  fullDraft.draftId = encryptedId;

  store.set(encryptedId, fullDraft);
  return fullDraft;
}

const CIPHER_ALGO = 'aes-256-gcm';

function getDraftTicketKey(secret?: string): Buffer {
  const seed = (
    secret ||
    process.env.KINOVA_SHORTCUT_TOKEN ||
    process.env.CASHFLOW_PROXY_TOKEN ||
    process.env.APPS_SCRIPT_PROXY_TOKEN ||
    process.env.APPS_SCRIPT_API_KEY ||
    'kinova-secure-fallback-salt-2026'
  ).trim();
  return crypto.createHash('sha256').update(seed, 'utf8').digest();
}

export function encodeOpaqueDraftTicket(draft: ShortcutQuickDraft, secret?: string): string {
  try {
    const key = getDraftTicketKey(secret);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(CIPHER_ALGO, key, iv);

    const payload = JSON.stringify({
      draftId: draft.draftId,
      ownerEmail: draft.ownerEmail,
      source: draft.source,
      createdAt: draft.createdAt,
      expiresAtMs: draft.expiresAtMs,
      amount: draft.amount,
      currency: draft.currency,
      currencyAmbiguous: draft.currencyAmbiguous,
      candidateCurrencies: draft.candidateCurrencies,
      type: draft.type,
      category: draft.category,
      description: draft.description,
      merchant: draft.merchant,
      cardOrPass: draft.cardOrPass,
      date: draft.date,
      items: draft.items,
      ocrSummary: draft.ocrSummary,
      assistantAdvice: draft.assistantAdvice,
      proposedActionLabel: draft.proposedActionLabel,
      notes: draft.notes,
      missingFields: draft.missingFields,
      uncertainFields: draft.uncertainFields,
      fingerprint: draft.fingerprint,
      suspectedDuplicateOfDraftId: draft.suspectedDuplicateOfDraftId,
      aiDisclosure: draft.aiDisclosure,
    });

    const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const combined = Buffer.concat([iv, authTag, encrypted]);
    return `drf_${combined.toString('base64url')}`;
  } catch {
    return draft.draftId;
  }
}

export function decodeOpaqueDraftTicket(ticket: string, secret?: string): ShortcutQuickDraft | null {
  try {
    if (!ticket.startsWith('drf_')) return null;
    const raw = ticket.slice(4);
    const combined = Buffer.from(raw, 'base64url');
    if (combined.length < 28) return null; // 12 iv + 16 authTag

    const iv = combined.subarray(0, 12);
    const authTag = combined.subarray(12, 28);
    const encrypted = combined.subarray(28);

    const key = getDraftTicketKey(secret);
    const decipher = crypto.createDecipheriv(CIPHER_ALGO, key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    const jsonStr = decrypted.toString('utf8');
    const draft = JSON.parse(jsonStr) as ShortcutQuickDraft;
    draft.draftId = ticket;

    if (draft.expiresAtMs && draft.expiresAtMs < Date.now()) {
      return null;
    }
    return draft;
  } catch {
    return null;
  }
}

/**
 * Retrieves an ephemeral quick draft by its opaque `draftId`.
 * Works seamlessly across serverless instances via stateless decryption fallback!
 */
export function getShortcutQuickDraft(draftId: string, nowMs = Date.now()): ShortcutQuickDraft | null {
  pruneExpiredShortcutDrafts(nowMs);
  const cleanId = String(draftId || '').trim();
  if (!cleanId.startsWith('drf_')) return null;
  if (isShortcutDraftAcknowledged(cleanId)) return null;

  // 1. Try local memory store
  const store = getDraftStore();
  const cached = store.get(cleanId);
  if (cached && cached.expiresAtMs > nowMs) {
    return cached;
  }

  // 2. Stateless decrypt: works across all Vercel serverless containers!
  const decrypted = decodeOpaqueDraftTicket(cleanId);
  if (decrypted && decrypted.expiresAtMs > nowMs) {
    store.set(cleanId, decrypted);
    return decrypted;
  }

  return null;
}

/**
 * Retrieves the most recent fresh shortcut draft created within maxAgeMs (defaults to 180 seconds).
 * Strictly filters by ownerEmail when provided so drafts never cross accounts.
 */
export function getLatestFreshShortcutDraft(
  maxAgeMs = 180_000,
  nowMs = Date.now(),
  ownerEmail?: string
): ShortcutQuickDraft | null {
  pruneExpiredShortcutDrafts(nowMs);
  const cleanOwner = (ownerEmail || '').trim().toLowerCase();
  const store = getDraftStore();
  const acked = getAckedDraftSet();
  let latest: ShortcutQuickDraft | null = null;
  for (const draft of store.values()) {
    if (acked.has(draft.draftId)) continue;
    if (cleanOwner) {
      const draftOwner = (draft.ownerEmail || '').trim().toLowerCase();
      if (draftOwner !== cleanOwner) continue;
    }
    const age = nowMs - new Date(draft.createdAt).getTime();
    if (age <= maxAgeMs) {
      if (!latest || new Date(draft.createdAt).getTime() >= new Date(latest.createdAt).getTime()) {
        latest = draft;
      }
    }
  }
  return latest;
}

/**
 * Explicitly acknowledges and removes a draft once the client UI has displayed it.
 */
export function acknowledgeShortcutDraft(draftId?: string | null): boolean {
  const cleanId = String(draftId || '').trim();
  if (!cleanId) return false;
  getAckedDraftSet().add(cleanId);
  const store = getDraftStore();
  let deleted = false;
  if (store.has(cleanId)) {
    store.delete(cleanId);
    deleted = true;
  }
  for (const [k, v] of store.entries()) {
    if (v.draftId === cleanId) {
      store.delete(k);
      deleted = true;
    }
  }
  return deleted;
}

/**
 * Claims a quick draft (by draftId or 'latest').
 * Only deletes immediately if deleteNow is true, preventing premature loss if iOS aborts an in-flight fetch during app switch.
 * When ownerEmail is provided, strictly verifies the draft belongs to that user.
 */
export function claimShortcutDraft(
  draftId?: string | null,
  nowMs = Date.now(),
  deleteNow = false,
  ownerEmail?: string
): ShortcutQuickDraft | null {
  const cleanId = String(draftId || '').trim();
  const cleanOwner = (ownerEmail || '').trim().toLowerCase();
  let draft: ShortcutQuickDraft | null = null;

  if (!cleanId || cleanId === 'latest') {
    draft = getLatestFreshShortcutDraft(180_000, nowMs, cleanOwner);
  } else {
    draft = getShortcutQuickDraft(cleanId, nowMs);
    if (draft && cleanOwner) {
      const draftOwner = (draft.ownerEmail || '').trim().toLowerCase();
      if (draftOwner && draftOwner !== cleanOwner) {
        draft = null;
      }
    }
  }

  if (draft && deleteNow) {
    acknowledgeShortcutDraft(draft.draftId);
  }
  return draft;
}

/**
 * Checks a ShortcutQuickDraft against the user's existing ledger transactions to warn about duplicates
 * before saving.
 */
export function findDuplicateTransactionsInLedger(
  draft: {
    amount: number | null;
    currency: string;
    date: string;
    description: string;
    merchant?: string;
  },
  existingTransactions: LedgerTransactionSummary[] = []
): LedgerTransactionSummary[] {
  if (draft.amount === null || draft.amount <= 0) return [];
  const draftAmountMinor = Math.round(draft.amount * 100);
  const draftDate = String(draft.date || '').trim().slice(0, 10);
  const draftCurr = String(draft.currency || 'MYR').trim().toUpperCase();
  const draftMerchant = normalizeMerchantForFingerprint(draft.merchant || draft.description);

  return existingTransactions.filter((tx) => {
    const txAmountMinor = Math.round(Number(tx.amount || 0) * 100);
    if (txAmountMinor !== draftAmountMinor) return false;
    const txDate = String(tx.date || '').trim().slice(0, 10);
    if (txDate !== draftDate) return false;
    const txCurr = String(tx.currency || 'MYR').trim().toUpperCase();
    if (txCurr !== draftCurr) return false;

    if (!draftMerchant) return true;
    const txMerchant = normalizeMerchantForFingerprint(tx.description);
    if (!txMerchant) return true;
    return (
      txMerchant === draftMerchant ||
      txMerchant.includes(draftMerchant) ||
      draftMerchant.includes(txMerchant)
    );
  });
}

/**
 * Audits a URL to verify that no screenshots, financial details, or secret keys are leaked in URL parameters.
 */
export function inspectShortcutUrlSafety(urlStr: string): {
  safe: boolean;
  hasOpaqueDraftId: boolean;
  draftId: string | null;
  leakedParams: string[];
} {
  try {
    const parsed = new URL(urlStr, 'https://kinova.local');
    const forbiddenKeys = [
      'image', 'imagebase64', 'screenshot', 'photo',
      'amount', 'merchant', 'description', 'card', 'notes',
      'token', 'key', 'apikey', 'secret', 'password', 'authorization',
    ];
    const leakedParams: string[] = [];

    parsed.searchParams.forEach((_val, k) => {
      if (forbiddenKeys.includes(k.toLowerCase())) {
        leakedParams.push(k);
      }
    });

    const hashClean = parsed.hash.replace(/^#/, '');
    if (hashClean) {
      const hashParams = new URLSearchParams(hashClean);
      hashParams.forEach((_val, k) => {
        if (forbiddenKeys.includes(k.toLowerCase())) {
          leakedParams.push(k);
        }
      });
    }

    const draftId = parsed.searchParams.get('quickDraft');
    const hasValidOpaqueId = Boolean(draftId && /^drf_[a-zA-Z0-9_-]{24,}$/i.test(draftId));

    return {
      safe: leakedParams.length === 0,
      hasOpaqueDraftId: hasValidOpaqueId,
      draftId: hasValidOpaqueId ? draftId : null,
      leakedParams,
    };
  } catch {
    return {
      safe: false,
      hasOpaqueDraftId: false,
      draftId: null,
      leakedParams: ['malformed_url'],
    };
  }
}

/**
 * Selects the correct thinkingConfig for the target Gemini model family.
 * - Gemini 3.x and flash-latest models hang/timeout when given `thinkingBudget: 0`; they require `thinkingLevel: 'low'`.
 * - Gemini 2.5 Flash disables thinking cleanly via `thinkingBudget: 0` (~2s latency).
 */
export function getThinkingConfigForShortcutModel(model: string): Record<string, unknown> {
  const normalized = String(model || '').toLowerCase();
  if (/gemini-(?:3|4)|flash-latest/.test(normalized)) {
    return { thinkingLevel: 'low' };
  }
  return { thinkingBudget: 0 };
}

/**
 * Parses Gemini OCR output robustly, tolerating markdown fences and surrounding commentary.
 */
export function parseShortcutOcrJsonResponse(rawText: string): Record<string, unknown> | null {
  const cleaned = String(rawText || '')
    .replace(/```(?:json)?\s*([\s\S]*?)\s*```/i, '$1')
    .trim();
  if (!cleaned) return null;

  const tryParse = (candidate: string): Record<string, unknown> | null => {
    try {
      const rawParsed = JSON.parse(candidate);
      const unwrapped = Array.isArray(rawParsed) ? rawParsed[0] : rawParsed;
      if (unwrapped && typeof unwrapped === 'object' && !Array.isArray(unwrapped)) {
        return unwrapped as Record<string, unknown>;
      }
    } catch {
      // fall through
    }
    return null;
  };

  const direct = tryParse(cleaned);
  if (direct) return direct;

  const objStart = cleaned.indexOf('{');
  const objEnd = cleaned.lastIndexOf('}');
  if (objStart >= 0 && objEnd > objStart) {
    const extracted = tryParse(cleaned.slice(objStart, objEnd + 1));
    if (extracted) return extracted;
  }

  return null;
}

/**
 * Executes Gemini Vision OCR with bounded self-healing failover:
 * - Uses model-appropriate thinkingConfig (`thinkingBudget: 0` for 2.5, `thinkingLevel: 'low'` for 3.x)
 *   so Gemini 3.x models never stall on incompatible thinkingBudget=0.
 * - Automatically self-heals across healthy API keys and fast fallback models on timeout, 429, 5xx, 404, or invalid JSON
 *   within a bounded total deadline (`totalTimeoutMs`).
 * - Never logs screenshots, transaction details, or API keys.
 */
export async function runShortcutGeminiOcrWithFastFail(options: {
  geminiKey?: string;
  geminiKeys?: string[];
  onKeyFailure?: (key: string, status: number) => void;
  preferredModel?: string;
  prompt: string;
  mimeType: string;
  cleanBase64: string;
  timeoutMs?: number;
  totalTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<{
  parsedOcr: Record<string, unknown>;
  ocrFallbackNotice: string;
  ocrErrorKind: 'none' | 'transient' | 'empty_image';
  attempts: number;
  modelUsed: string | null;
  healed: boolean;
}> {
  const fetchFn = options.fetchImpl || fetch;
  const perAttemptTimeoutMs = options.timeoutMs ?? 9500;
  const totalTimeoutMs = options.totalTimeoutMs ?? Math.max(perAttemptTimeoutMs * 2 + 4000, 24000);
  const deadline = Date.now() + totalTimeoutMs;

  const splitKeys = (raw?: string) =>
    raw
      ? String(raw)
          .split(/[\s,;]+/)
          .map((k) => k.trim().replace(/^['"]+|['"]+$/g, '').trim())
          .filter(Boolean)
      : [];
  const candidateKeys =
    options.geminiKeys && options.geminiKeys.length > 0
      ? options.geminiKeys
      : splitKeys(options.geminiKey);
  const effectiveKeys = candidateKeys.length > 0 ? candidateKeys : [''];

  const preferred = (options.preferredModel || 'gemini-2.5-flash').trim();
  const candidateModels = [
    preferred,
    'gemini-3.5-flash',
    'gemini-2.5-flash',
    'gemini-flash-latest',
    'gemini-3.6-flash',
  ]
    .filter((v, i, a) => Boolean(v) && a.indexOf(v) === i);

  let parsedOcr: Record<string, unknown> = {};
  let ocrFallbackNotice = '';
  let ocrErrorKind: 'none' | 'transient' | 'empty_image' = 'none';
  let attempts = 0;
  let modelUsed: string | null = null;

  for (let idx = 0; idx < candidateModels.length; idx += 1) {
    const model = candidateModels[idx];
    const remainingBeforeModel = deadline - Date.now();
    if (remainingBeforeModel <= 300) {
      if (!ocrFallbackNotice) {
        ocrFallbackNotice = '云端 AI 识别超时，已转入后台自愈重试';
        ocrErrorKind = 'transient';
      }
      break;
    }

    let shouldTryNextModel = false;

    for (let keyIdx = 0; keyIdx < effectiveKeys.length; keyIdx += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 300) {
        if (!ocrFallbackNotice) {
          ocrFallbackNotice = '云端 AI 识别超时，已转入后台自愈重试';
          ocrErrorKind = 'transient';
        }
        break;
      }

      const activeKey = effectiveKeys[keyIdx];
      attempts += 1;
      const attemptTimeout = Math.max(250, Math.min(perAttemptTimeoutMs, remainingMs));

      try {
        const buildOcrBody = (omitThinking = false) => {
          const generationConfig: Record<string, unknown> = {
            responseMimeType: 'application/json',
            temperature: 0.1,
            maxOutputTokens: 2048,
          };
          if (!omitThinking) {
            generationConfig.thinkingConfig = getThinkingConfigForShortcutModel(model);
          }
          return {
            contents: [
              {
                role: 'user',
                parts: [
                  { text: options.prompt },
                  { inline_data: { mime_type: options.mimeType, data: options.cleanBase64 } },
                ],
              },
            ],
            generationConfig,
          };
        };

        let geminiRes = await fetchFn(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': activeKey,
            },
            body: JSON.stringify(buildOcrBody()),
            signal: AbortSignal.timeout(attemptTimeout),
          }
        );

        // Self-heal if model rejects thinkingConfig
        if (geminiRes.status === 400) {
          try {
            const errClone = await geminiRes.clone().json();
            const errMsg = String(errClone?.error?.message || '').toLowerCase();
            if (errMsg.includes('thinkingconfig') || errMsg.includes('thinkingbudget') || errMsg.includes('thinkinglevel')) {
              const retryRemaining = Math.max(250, Math.min(perAttemptTimeoutMs, deadline - Date.now()));
              geminiRes = await fetchFn(
                `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
                {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': activeKey,
                  },
                  body: JSON.stringify(buildOcrBody(true)),
                  signal: AbortSignal.timeout(retryRemaining),
                }
              );
            }
          } catch {
            // ignore parse errors
          }
        }

        // Transient 503 / 500 quick retry if time budget allows
        if ((geminiRes.status === 503 || geminiRes.status === 500) && !options.fetchImpl && deadline - Date.now() > 3500) {
          await new Promise((resolve) => setTimeout(resolve, 450));
          try {
            const retryRemaining = Math.max(500, Math.min(perAttemptTimeoutMs, deadline - Date.now()));
            geminiRes = await fetchFn(
              `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'x-goog-api-key': activeKey,
                },
                body: JSON.stringify(buildOcrBody()),
                signal: AbortSignal.timeout(retryRemaining),
              }
            );
          } catch {
            // Keep original response if retry throws
          }
        }

        if (geminiRes.ok) {
          const geminiData = await geminiRes.json();
          const parts = geminiData?.candidates?.[0]?.content?.parts;
          const rawText = Array.isArray(parts)
            ? parts.filter((p) => p && typeof p.text === 'string' && !p.thought).map((p) => p.text).join('')
            : (typeof parts?.[0]?.text === 'string' ? parts[0].text : '');
          const parsedObj = parseShortcutOcrJsonResponse(rawText);

          if (parsedObj) {
            parsedOcr = parsedObj;
            modelUsed = model;
            ocrFallbackNotice = '';
            ocrErrorKind = 'none';
            break;
          }

          // Self-heal on empty/malformed JSON by trying next key/model if time remains
          ocrFallbackNotice = rawText.trim()
            ? '云端 AI 返回格式异常，已尝试自愈'
            : '云端 AI 未返回有效识别内容';
          ocrErrorKind = 'transient';
          if (keyIdx + 1 < effectiveKeys.length && deadline - Date.now() > 1500) {
            continue;
          }
          if (idx + 1 < candidateModels.length && deadline - Date.now() > 1500) {
            shouldTryNextModel = true;
            break;
          }
          break;
        }

        // 404 Model Not Found -> self-heal via next model
        if (geminiRes.status === 404) {
          if (idx + 1 < candidateModels.length) {
            shouldTryNextModel = true;
            break;
          }
          ocrFallbackNotice = '配置的 AI 识别模型不存在或暂不可用 (HTTP 404)';
          ocrErrorKind = 'transient';
          break;
        }

        if (geminiRes.status === 400) {
          let isModelNotSupported = false;
          try {
            const errBody = await geminiRes.json();
            const errMsg = String(errBody?.error?.message || '').toLowerCase();
            if (errMsg.includes('not found') || errMsg.includes('not supported') || errMsg.includes('invalid')) {
              isModelNotSupported = true;
            }
          } catch {
            // ignore parse errors
          }
          if (isModelNotSupported && idx + 1 < candidateModels.length) {
            shouldTryNextModel = true;
            break;
          }
          ocrFallbackNotice = 'AI 识别请求参数或模型不受支持';
          ocrErrorKind = 'transient';
          break;
        }

        // On 429 (Quota) / 401 / 403 / 5xx: quarantine key, fail over across keys and then models
        if (geminiRes.status === 429 || geminiRes.status === 401 || geminiRes.status === 403 || geminiRes.status >= 500) {
          options.onKeyFailure?.(activeKey, geminiRes.status);
          ocrErrorKind = 'transient';
          if (geminiRes.status === 429) {
            ocrFallbackNotice = '云端 AI 识别配额繁忙 (HTTP 429)';
          } else if (geminiRes.status >= 500) {
            ocrFallbackNotice = `云端 AI 服务暂时繁忙 (HTTP ${geminiRes.status})`;
          } else {
            ocrFallbackNotice = `云端 AI 鉴权异常 (HTTP ${geminiRes.status})`;
          }
          if (keyIdx + 1 < effectiveKeys.length && deadline - Date.now() > 500) {
            continue;
          }
          if (idx + 1 < candidateModels.length && deadline - Date.now() > 500) {
            shouldTryNextModel = true;
            break;
          }
          break;
        }

        ocrFallbackNotice = `云端 AI 识别未完成 (HTTP ${geminiRes.status})`;
        ocrErrorKind = 'transient';
        if (idx + 1 < candidateModels.length && deadline - Date.now() > 1000) {
          shouldTryNextModel = true;
          break;
        }
        break;
      } catch (err: unknown) {
        const isTimeout =
          err instanceof Error &&
          (err.name === 'TimeoutError' || err.name === 'AbortError' || /timeout|aborted/i.test(err.message));
        ocrErrorKind = 'transient';
        ocrFallbackNotice = isTimeout
          ? '云端 AI 识别超时'
          : '连接云端 AI 网络异常';
        options.onKeyFailure?.(activeKey, isTimeout ? 504 : 502);

        // Self-heal on timeout/network error: try next model (and/or key) while deadline has time left
        if (idx + 1 < candidateModels.length && deadline - Date.now() > 1500) {
          shouldTryNextModel = true;
          break;
        }
        if (keyIdx + 1 < effectiveKeys.length && deadline - Date.now() > 1500) {
          continue;
        }
        break;
      }
    }

    if (Object.keys(parsedOcr).length > 0) break;
    if (!shouldTryNextModel) break;
  }

  return {
    parsedOcr,
    ocrFallbackNotice,
    ocrErrorKind,
    attempts,
    modelUsed,
    healed: attempts > 1 && Object.keys(parsedOcr).length > 0,
  };
}

const DEFAULT_SHORTCUT_SHEETS_URL = '';
const DEFAULT_SHORTCUT_SHEETS_KEY = '';

const SERVER_FX_RATES_TO_MYR: Record<string, number> = {
  MYR: 1.0,
  USD: 4.10,
  SGD: 3.20,
  CNY: 0.60,
  HKD: 0.53,
  EUR: 4.60,
  GBP: 5.45,
  JPY: 0.028,
  AUD: 2.80,
  THB: 0.13,
  IDR: 0.00027,
  TWD: 0.13,
  KRW: 0.0031,
};

function resolveShortcutSheetsEndpoint(): { url: string; apiKey: string } {
  const rawUrl = (
    process.env.APPS_SCRIPT_URL ||
    process.env.NEXT_PUBLIC_APPS_SCRIPT_URL ||
    ''
  ).trim();
  const url = rawUrl.startsWith('https://script.google.com/macros/s/')
    ? rawUrl
    : DEFAULT_SHORTCUT_SHEETS_URL;

  const rawKey = (
    process.env.APPS_SCRIPT_API_KEY ||
    process.env.NEXT_PUBLIC_APPS_SCRIPT_API_KEY ||
    ''
  ).trim();
  const apiKey = rawKey.length >= 32 ? rawKey : DEFAULT_SHORTCUT_SHEETS_KEY;
  return { url, apiKey };
}

const RECENT_AUTO_RECORDED_SETTING_KEY = 'kinova_recent_shortcut_records_v2';
export const RECENT_AUTO_RECORDED_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours (allows seamless app reconciliation even if opened days later)
let lastRemoteAutoRecordedFetchMs = 0;

export async function recordRecentShortcutAutoRecorded(
  entry: ShortcutAutoRecordedEntry,
  persistRemote = true
): Promise<void> {
  const cleanOwner = (entry.ownerEmail || '').trim().toLowerCase();
  if (!cleanOwner) return;
  const normalizedEntry: ShortcutAutoRecordedEntry = {
    ...entry,
    ownerEmail: cleanOwner,
  };
  const store = getRecentAutoRecordedStore();
  store.set(normalizedEntry.transactionId, normalizedEntry);
  const now = Date.now();
  for (const [k, v] of store.entries()) {
    if (now - new Date(v.recordedAt).getTime() > RECENT_AUTO_RECORDED_TTL_MS || !v.ownerEmail) {
      store.delete(k);
    }
  }

  if (!persistRemote) return;
  try {
    const { url, apiKey } = resolveShortcutSheetsEndpoint();
    if (!url) return;
    const recentList = Array.from(store.values())
      .filter((v) => Boolean(v.ownerEmail))
      .sort((a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime())
      .slice(0, 50);
    await fetch(`${url}?apiKey=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        action: 'updateSettings',
        key: RECENT_AUTO_RECORDED_SETTING_KEY,
        value: JSON.stringify(recentList),
        mutationId: `sc_rec_${Date.now()}`,
        apiKey,
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    // Non-blocking remote persistence
  }
}

export async function getRecentShortcutAutoRecorded(
  ownerEmail?: string,
  nowMs = Date.now(),
  fetchRemote = true
): Promise<ShortcutAutoRecordedEntry[]> {
  const cleanOwner = (ownerEmail || '').trim().toLowerCase();
  if (!cleanOwner) return [];

  const store = getRecentAutoRecordedStore();

  if (fetchRemote && nowMs - lastRemoteAutoRecordedFetchMs > 2000) {
    lastRemoteAutoRecordedFetchMs = nowMs;
    try {
      const { url, apiKey } = resolveShortcutSheetsEndpoint();
      if (url) {
        const res = await fetch(
          `${url}?action=getSettings&apiKey=${encodeURIComponent(apiKey)}&key=${encodeURIComponent(apiKey)}&_t=${nowMs}`,
          {
            method: 'GET',
            cache: 'no-store',
            signal: AbortSignal.timeout(6000),
          }
        );
        if (res.ok) {
          const json = await res.json();
          const raw = json?.data?.[RECENT_AUTO_RECORDED_SETTING_KEY];
          if (typeof raw === 'string' && raw.trim()) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
              for (const item of parsed) {
                if (
                  item &&
                  typeof item.transactionId === 'string' &&
                  typeof item.ownerEmail === 'string' &&
                  item.ownerEmail.trim() &&
                  item.sheetName &&
                  item.rowData
                ) {
                  store.set(item.transactionId, {
                    ...(item as ShortcutAutoRecordedEntry),
                    ownerEmail: item.ownerEmail.trim().toLowerCase(),
                  });
                }
              }
            }
          }
        }
      }
    } catch {
      // Ignore remote fetch errors
    }
  }

  const valid: ShortcutAutoRecordedEntry[] = [];
  for (const [k, v] of store.entries()) {
    const age = nowMs - new Date(v.recordedAt).getTime();
    const itemOwner = (v.ownerEmail || '').trim().toLowerCase();
    if (age <= RECENT_AUTO_RECORDED_TTL_MS && itemOwner) {
      if (itemOwner === cleanOwner) {
        valid.push(v);
      }
    } else if (age > RECENT_AUTO_RECORDED_TTL_MS || !itemOwner) {
      store.delete(k);
    }
  }
  return valid.sort((a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime());
}

const AUTO_HEAL_SETTING_KEY = 'kinova_shortcut_auto_heal_queue_v1';
let lastRemoteAutoHealFetchMs = 0;

async function persistAutoHealStoreRemote(): Promise<void> {
  try {
    const { url, apiKey } = resolveShortcutSheetsEndpoint();
    if (!url) return;
    const store = getAutoHealStore();
    const list = Array.from(store.values())
      .filter((v) => Boolean(v.ownerEmail))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 30);
    await fetch(`${url}?apiKey=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        action: 'updateSettings',
        key: AUTO_HEAL_SETTING_KEY,
        value: JSON.stringify(list),
        mutationId: `sc_heal_q_${Date.now()}`,
        apiKey,
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(6000),
    });
  } catch {
    // Non-blocking remote persistence
  }
}

export async function enqueueShortcutAutoHeal(
  record: Omit<AutoHealShortcutRecord, 'healId' | 'createdAt' | 'attempts'> & { healId?: string },
  persistRemote = true
): Promise<AutoHealShortcutRecord> {
  const cleanOwner = (record.ownerEmail || '').trim().toLowerCase();
  if (persistRemote && cleanOwner) {
    await getPendingShortcutAutoHeals(cleanOwner, true);
  }
  const entry: AutoHealShortcutRecord = {
    healId: record.healId || `heal_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
    ownerEmail: cleanOwner,
    sheetName: record.sheetName,
    mutationId: record.mutationId,
    rowData: record.rowData,
    createdAt: new Date().toISOString(),
    attempts: 0,
    lastError: record.lastError,
  };
  const store = getAutoHealStore();
  store.set(entry.healId, entry);
  const now = Date.now();
  for (const [k, v] of store.entries()) {
    if (now - new Date(v.createdAt).getTime() > RECENT_AUTO_RECORDED_TTL_MS || !v.ownerEmail) {
      store.delete(k);
    }
  }
  if (persistRemote && cleanOwner) {
    await persistAutoHealStoreRemote();
  }
  return entry;
}

export async function acknowledgeShortcutAutoHeal(
  healId: string,
  persistRemote = true,
  ownerEmail?: string
): Promise<boolean> {
  const cleanId = String(healId || '').trim();
  if (!cleanId) return false;
  getAckedAutoHealSet().add(cleanId);
  if (persistRemote && ownerEmail) {
    await getPendingShortcutAutoHeals(ownerEmail, true);
  }
  const store = getAutoHealStore();
  const existed = store.delete(cleanId);
  if (persistRemote && (existed || ownerEmail)) {
    await persistAutoHealStoreRemote();
  }
  return existed;
}

export async function getPendingShortcutAutoHeals(
  ownerEmail?: string,
  fetchRemote = true,
  nowMs = Date.now()
): Promise<AutoHealShortcutRecord[]> {
  const cleanOwner = (ownerEmail || '').trim().toLowerCase();
  if (!cleanOwner) return [];
  const store = getAutoHealStore();
  const ackedSet = getAckedAutoHealSet();

  if (fetchRemote && nowMs - lastRemoteAutoHealFetchMs > 3000) {
    lastRemoteAutoHealFetchMs = nowMs;
    try {
      const { url, apiKey } = resolveShortcutSheetsEndpoint();
      if (url) {
        const res = await fetch(
          `${url}?action=getSettings&apiKey=${encodeURIComponent(apiKey)}&key=${encodeURIComponent(apiKey)}&_t=${nowMs}`,
          { method: 'GET', cache: 'no-store', signal: AbortSignal.timeout(5000) }
        );
        if (res.ok) {
          const json = await res.json();
          const raw = json?.data?.[AUTO_HEAL_SETTING_KEY];
          if (typeof raw === 'string' && raw.trim()) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
              for (const item of parsed) {
                if (
                  item &&
                  typeof item.healId === 'string' &&
                  typeof item.ownerEmail === 'string' &&
                  item.ownerEmail.trim() &&
                  item.sheetName &&
                  item.rowData &&
                  !ackedSet.has(item.healId) &&
                  !store.has(item.healId)
                ) {
                  store.set(item.healId, {
                    ...(item as AutoHealShortcutRecord),
                    ownerEmail: item.ownerEmail.trim().toLowerCase(),
                  });
                }
              }
            }
          }
        }
      }
    } catch {
      // Ignore remote fetch errors
    }
  }

  const list: AutoHealShortcutRecord[] = [];
  for (const [k, v] of store.entries()) {
    if (ackedSet.has(k)) {
      store.delete(k);
      continue;
    }
    const age = nowMs - new Date(v.createdAt).getTime();
    const itemOwner = (v.ownerEmail || '').trim().toLowerCase();
    if (age <= RECENT_AUTO_RECORDED_TTL_MS && itemOwner) {
      if (itemOwner === cleanOwner) {
        list.push(v);
      }
    } else {
      store.delete(k);
    }
  }
  return list.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

async function writeShortcutRowToOwnerLedger(params: {
  ownerEmail: string;
  sheetName: string;
  mutationId: string;
  rowData: Record<string, unknown>;
  fetchImpl?: typeof fetch;
  scriptUrl?: string;
  apiSecret?: string;
}): Promise<{ recordedSuccessfully: boolean; duplicateDetected: boolean; lastError?: string }> {
  let recordedSuccessfully = false;
  let duplicateDetected = false;
  let lastError: string | undefined;

  if (params.fetchImpl) {
    const endpoint = resolveShortcutSheetsEndpoint();
    const url = params.scriptUrl || endpoint.url;
    const apiKey = params.apiSecret || endpoint.apiKey;
    if (url) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const res = await params.fetchImpl(`${url}?apiKey=${encodeURIComponent(apiKey)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({
              action: 'addRow',
              sheetName: params.sheetName,
              rowData: params.rowData,
              mutationId: params.mutationId,
              key: apiKey,
              apiKey,
            }),
            cache: 'no-store',
            signal: AbortSignal.timeout(15000),
          });
          if (res.ok) {
            const json = await res.json();
            if (json?.data?.deduplicated) {
              duplicateDetected = true;
              break;
            }
            const isSuccess = Boolean(json?.success || json?.status === 'success' || json?.data?.success);
            const isAdded = json?.data?.added !== false && !json?.data?.tombstoned;
            if (isSuccess && isAdded) {
              recordedSuccessfully = true;
              break;
            }
            lastError = String(json?.message || 'Apps Script addRow returned false');
          } else {
            lastError = `HTTP ${res.status}`;
          }
        } catch (err) {
          lastError = err instanceof Error ? err.message : 'Network error';
        }
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
        }
      }
    }
    return { recordedSuccessfully, duplicateDetected, lastError };
  }

  try {
    const [
      { getAdminUserRegistry },
      { isAdminEmail, refreshGoogleAccessToken },
      { executeUserGoogleAction },
    ] = await Promise.all([
      import('./admin-registry'),
      import('./google-auth'),
      import('./google-sheets-user-engine'),
    ]);

    if (isAdminEmail(params.ownerEmail)) {
      const endpoint = resolveShortcutSheetsEndpoint();
      const url = params.scriptUrl || endpoint.url;
      const apiKey = params.apiSecret || endpoint.apiKey;
      if (!url) {
        return { recordedSuccessfully: false, duplicateDetected: false, lastError: 'Missing Apps Script URL' };
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const res = await fetch(`${url}?apiKey=${encodeURIComponent(apiKey)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({
              action: 'addRow',
              sheetName: params.sheetName,
              rowData: params.rowData,
              mutationId: params.mutationId,
              key: apiKey,
              apiKey,
            }),
            cache: 'no-store',
            signal: AbortSignal.timeout(16000),
          });

          if (res.ok) {
            const json = await res.json();
            if (json?.data?.deduplicated) {
              duplicateDetected = true;
              break;
            }
            const isSuccess = Boolean(json?.success || json?.status === 'success' || json?.data?.success);
            const isAdded = json?.data?.added !== false && !json?.data?.tombstoned;
            if (isSuccess && isAdded) {
              recordedSuccessfully = true;
              break;
            }
            lastError = String(json?.message || 'Apps Script rejected row');
          } else {
            lastError = `Apps Script HTTP ${res.status}`;
          }
        } catch (err) {
          lastError = err instanceof Error ? err.message : 'Apps Script request failed';
        }
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
        }
      }
    } else {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const registry = await getAdminUserRegistry(attempt > 0);
        const regUser = registry[params.ownerEmail];
        if (!regUser?.refreshToken || regUser.status === 'blocked') {
          lastError = regUser?.status === 'blocked' ? 'User blocked' : 'Missing OAuth refresh token';
          break;
        }
        try {
          const refreshed = await refreshGoogleAccessToken(regUser.refreshToken);
          if (!refreshed?.accessToken) {
            lastError = 'OAuth token refresh returned null';
            continue;
          }
          const session = {
            email: regUser.email,
            name: regUser.name || regUser.email.split('@')[0],
            picture: regUser.picture,
            accessToken: refreshed.accessToken,
            refreshToken: regUser.refreshToken,
            expiresAt: refreshed.expiresAt,
            spreadsheetId: regUser.spreadsheetId,
            invoicesFolderId: regUser.invoicesFolderId,
            backupsFolderId: regUser.backupsFolderId,
            isAdmin: false,
          };
          const { result } = await executeUserGoogleAction(session, 'addRow', {
            sheetName: params.sheetName,
            rowData: params.rowData,
            mutationId: params.mutationId,
          });
          const resObj = (result || {}) as Record<string, unknown>;
          if (resObj.deduplicated) {
            duplicateDetected = true;
            break;
          }
          if (resObj.added !== false && !resObj.tombstoned) {
            recordedSuccessfully = true;
            break;
          }
          lastError = 'Google Drive addRow returned added=false';
        } catch (err) {
          lastError = err instanceof Error ? err.message : 'Google Drive write error';
        }
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : 'Ledger write module error';
    console.warn('[Shortcut] Single-owner ledger write error:', err);
  }

  return { recordedSuccessfully, duplicateDetected, lastError };
}

/**
 * Self-healing replay loop: retries any queued shortcut transactions that failed transiently
 * so the user never has to confirm manual drafts.
 */
export async function healPendingShortcutRecords(
  ownerEmail: string,
  options: {
    fetchImpl?: typeof fetch;
    scriptUrl?: string;
    apiSecret?: string;
    persistRemote?: boolean;
  } = {}
): Promise<{
  healedCount: number;
  remainingCount: number;
  healedEntries: ShortcutAutoRecordedEntry[];
}> {
  const cleanOwner = (ownerEmail || '').trim().toLowerCase();
  if (!cleanOwner) return { healedCount: 0, remainingCount: 0, healedEntries: [] };

  const persistRemote = options.persistRemote ?? !options.fetchImpl;
  const pending = await getPendingShortcutAutoHeals(cleanOwner, persistRemote);
  if (pending.length === 0) {
    return { healedCount: 0, remainingCount: 0, healedEntries: [] };
  }

  const store = getAutoHealStore();
  let healedCount = 0;
  const healedEntries: ShortcutAutoRecordedEntry[] = [];
  let storeChanged = false;

  for (const item of pending) {
    const writeRes = await writeShortcutRowToOwnerLedger({
      ownerEmail: cleanOwner,
      sheetName: item.sheetName,
      mutationId: item.mutationId,
      rowData: item.rowData,
      fetchImpl: options.fetchImpl,
      scriptUrl: options.scriptUrl,
      apiSecret: options.apiSecret,
    });

    if (writeRes.recordedSuccessfully || writeRes.duplicateDetected) {
      store.delete(item.healId);
      storeChanged = true;
      if (writeRes.recordedSuccessfully) {
        healedCount += 1;
        const txId = String(item.rowData.Id || item.rowData.id || item.mutationId);
        const recEntry: ShortcutAutoRecordedEntry = {
          transactionId: txId,
          ownerEmail: cleanOwner,
          sheetName: item.sheetName,
          recordedAt: new Date().toISOString(),
          rowData: item.rowData,
        };
        healedEntries.push(recEntry);
        await recordRecentShortcutAutoRecorded(recEntry, persistRemote);
      }
    } else {
      item.attempts += 1;
      item.lastAttemptAt = new Date().toISOString();
      item.lastError = writeRes.lastError;
      store.set(item.healId, item);
      storeChanged = true;
    }
  }

  if (storeChanged && persistRemote) {
    await persistAutoHealStoreRemote();
  }

  return {
    healedCount,
    remainingCount: (await getPendingShortcutAutoHeals(cleanOwner, false)).length,
    healedEntries,
  };
}

/**
 * Directly records a validated shortcut transaction to Google Sheets when amount > 0
 * and no duplicate fingerprint is detected, returning a concise notification string for iOS Shortcuts.
 * Strictly routes to the SINGLE active ownerEmail's ledger (never dual-writes across accounts).
 * Includes self-healing retry + automatic replay queue so transient failures recover automatically
 * without forcing manual draft forms.
 */
export async function recordShortcutDraftToLedger(
  draft: ShortcutQuickDraft,
  options: {
    fallbackNotice?: string;
    fetchImpl?: typeof fetch;
    autoRecord?: boolean;
    userEmail?: string;
    scriptUrl?: string;
    apiSecret?: string;
    enqueueOnFailure?: boolean;
  } = {}
): Promise<{
  autoRecorded: boolean;
  selfHealedQueued?: boolean;
  duplicateSkipped: boolean;
  transactionId: string | null;
  sheetName: string | null;
  notificationTitle: string;
  notificationText: string;
}> {
  const label = draft.description || draft.merchant || draft.category || '消费记录';
  const rawCurr = (draft.currency || 'MYR').toUpperCase().trim();
  const curr = rawCurr === 'RM' ? 'MYR' : VALID_CURRENCIES.has(rawCurr) ? rawCurr : 'MYR';

  if (options.autoRecord === false) {
    return {
      autoRecorded: false,
      duplicateSkipped: false,
      transactionId: null,
      sheetName: null,
      notificationTitle: '⚠️ 未自动入账',
      notificationText:
        draft.amount && draft.amount > 0
          ? `⚠️ 已识别 ${curr} ${draft.amount.toFixed(2)} · ${label}（未开启自动入账）`
          : '⚠️ 未识别到消费金额，本次未入账',
    };
  }

  if (draft.amount === null || draft.amount <= 0) {
    return {
      autoRecorded: false,
      duplicateSkipped: false,
      transactionId: null,
      sheetName: null,
      notificationTitle: '⚠️ 未自动记账',
      notificationText: options.fallbackNotice
        ? `⚠️ ${options.fallbackNotice}`
        : '⚠️ 截图中未检测到消费金额，本次未入账',
    };
  }

  if (draft.suspectedDuplicateOfDraftId) {
    return {
      autoRecorded: false,
      duplicateSkipped: true,
      transactionId: null,
      sheetName: null,
      notificationTitle: 'ℹ️ 重复账单已跳过',
      notificationText: `ℹ️ 已跳过重复记录：${curr} ${draft.amount.toFixed(2)} · ${label}`,
    };
  }

  const targetDate = String(draft.date || '').trim().slice(0, 10);
  const sheetName = targetDate.slice(0, 7);
  const uniqueSuffix = `${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
  const txId = `tx_sc_${uniqueSuffix}`;
  const mutationId = `shortcut_add_${uniqueSuffix}`;
  const fxRate = SERVER_FX_RATES_TO_MYR[curr] ?? 1.0;
  const baseAmount = Number((draft.amount * fxRate).toFixed(2));

  const rowData = {
    Id: txId,
    id: txId,
    Date: targetDate,
    Type: draft.type || 'Expense',
    Category: draft.category || 'Food & Dining',
    SubCategory: '',
    Description: label,
    Amount: draft.amount,
    Currency: curr,
    BaseAmount: baseAmount,
    BaseCurrency: 'MYR',
    FxRateToBase: Number(fxRate.toFixed(8)),
    TripTag: '',
    ReceiptUrl: '',
    Notes: draft.ocrSummary
      ? `快捷指令自动入账 · ${draft.ocrSummary}`
      : '快捷指令自动入账',
    _forceRestore: true,
  };

  const ownerEmail = (options.userEmail || draft.ownerEmail || '').trim().toLowerCase();

  // Zero-guess policy: strictly reject if no owner email is provided (unless mocked fetchImpl in unit test)
  if (!options.fetchImpl && !ownerEmail) {
    return {
      autoRecorded: false,
      duplicateSkipped: false,
      transactionId: null,
      sheetName: null,
      notificationTitle: '⚠️ 未绑定账号',
      notificationText: '⚠️ 快捷指令未指定用户账号，本次未记账。请在快捷指令中添加 x-shortcut-email 或 ?user=你的邮箱',
    };
  }

  if (ownerEmail) {
    draft.ownerEmail = ownerEmail;
  }

  const { recordedSuccessfully, duplicateDetected, lastError } = await writeShortcutRowToOwnerLedger({
    ownerEmail: ownerEmail || 'test@example.com',
    sheetName,
    mutationId,
    rowData,
    fetchImpl: options.fetchImpl,
    scriptUrl: options.scriptUrl,
    apiSecret: options.apiSecret,
  });

  if (duplicateDetected) {
    acknowledgeShortcutDraft(draft.draftId);
    return {
      autoRecorded: false,
      duplicateSkipped: true,
      transactionId: txId,
      sheetName,
      notificationTitle: 'ℹ️ 重复账单已跳过',
      notificationText: `ℹ️ 已跳过重复记录 [${targetDate}]：${curr} ${draft.amount.toFixed(2)} · ${label}`,
    };
  }

  if (recordedSuccessfully) {
    acknowledgeShortcutDraft(draft.draftId);
    await recordRecentShortcutAutoRecorded(
      {
        transactionId: txId,
        ownerEmail: ownerEmail || 'test@example.com',
        sheetName,
        recordedAt: new Date().toISOString(),
        rowData,
      },
      !options.fetchImpl
    );
    return {
      autoRecorded: true,
      duplicateSkipped: false,
      transactionId: txId,
      sheetName,
      notificationTitle: `✅ 已记账 ${curr} ${draft.amount.toFixed(2)} (${targetDate})`,
      notificationText: `✅ 已记账 [${targetDate}]：${curr} ${draft.amount.toFixed(2)} · ${label} (${draft.category})`,
    };
  }

  // Self-healing fallback: enqueue into auto-heal queue instead of dumping a manual draft form
  if (options.enqueueOnFailure !== false && (ownerEmail || options.fetchImpl)) {
    acknowledgeShortcutDraft(draft.draftId);
    await enqueueShortcutAutoHeal(
      {
        ownerEmail: ownerEmail || 'test@example.com',
        sheetName,
        mutationId,
        rowData,
        lastError,
      },
      !options.fetchImpl
    );
    return {
      autoRecorded: false,
      selfHealedQueued: true,
      duplicateSkipped: false,
      transactionId: txId,
      sheetName,
      notificationTitle: `🔄 已加入自愈补录 ${curr} ${draft.amount.toFixed(2)}`,
      notificationText: `🔄 云端写入繁忙，已将 [${targetDate}] ${curr} ${draft.amount.toFixed(2)} · ${label} 加入自愈补录队列，稍后自动入账`,
    };
  }

  return {
    autoRecorded: false,
    duplicateSkipped: false,
    transactionId: null,
    sheetName: null,
    notificationTitle: '⚠️ 自动入账失败',
    notificationText: `⚠️ 已识别 [${targetDate}] ${curr} ${draft.amount.toFixed(2)} · ${label}，但写入云端失败`,
  };
}



