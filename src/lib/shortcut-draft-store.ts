import crypto from 'crypto';

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
  items?: ShortcutDraftItem[];
  ocrSummary?: string;
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
    regex: /\b(grab|airasia|shell|petronas|petron|caltex|touch\s*n\s*go|tng|rapidkl|mrt|lrt|ktm|erl|parking|toll|beam|socars|uber|taxi)\b/i,
    category: 'Transport',
  },
  {
    regex: /\b(starbucks|zus|tealive|chagee|mcdonald|kfc|nando|pelita|kopitiam|cafe|coffee|bakery|ramen|sushi|bistro|restaurant|restoran|mamak|foodpanda|grabfood|dining|kitchen|hotpot|barbecue|bbq)\b/i,
    category: 'Food & Dining',
  },
  {
    regex: /\b(uniqlo|zara|shopee|lazada|taobao|ikea|decathlon|aeon|jaya\s*grocer|village\s*grocer|99\s*speedmart|lotus|mydin|giant|watson|guardian|sephora|apple\s*store|machines|switch|harvey\s*norman)\b/i,
    category: 'Shopping',
  },
  {
    regex: /\b(tnb|tenaga|syabas|air\s*selangor|indah\s*water|time\s*dotcom|unifi|maxis|celcom|digi|umobile|yes\s*5g|astro|coway|cuckoo)\b/i,
    category: 'Housing & Bills',
  },
  {
    regex: /\b(gsc|tgv|cinema|netflix|spotify|youtube|disney|steam|playstation|nintendo|genting|karaoke)\b/i,
    category: 'Entertainment',
  },
  {
    regex: /\b(clinic|klinik|hospital|gleneagles|sunway\s*medical|pantai|kpj|pharmacy|farmasi|caring|big\s*pharmacy|aa\s*pharmacy|dental|dentist)\b/i,
    category: 'Health',
  },
  {
    regex: /\b(aia|prudential|great\s*eastern|allianz|zurich|etiqa|takaful|manulife|fwd)\b/i,
    category: 'Insurance',
  },
];

declare global {
  // eslint-disable-next-line no-var
  var __kinovaShortcutDraftMap: Map<string, ShortcutQuickDraft> | undefined;
  // eslint-disable-next-line no-var
  var __kinovaAckedShortcutDraftSet: Set<string> | undefined;
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
    return { category: explicitCategory.trim(), isUncertain: false };
  }
  const text = String(merchantOrDesc || '').trim();
  if (!text) {
    return { category: 'Food & Dining', isUncertain: true };
  }
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
 */
export function getLatestFreshShortcutDraft(maxAgeMs = 180_000, nowMs = Date.now()): ShortcutQuickDraft | null {
  pruneExpiredShortcutDrafts(nowMs);
  const store = getDraftStore();
  const acked = getAckedDraftSet();
  let latest: ShortcutQuickDraft | null = null;
  for (const draft of store.values()) {
    if (acked.has(draft.draftId)) continue;
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
 */
export function claimShortcutDraft(
  draftId?: string | null,
  nowMs = Date.now(),
  deleteNow = false
): ShortcutQuickDraft | null {
  const cleanId = String(draftId || '').trim();
  let draft: ShortcutQuickDraft | null = null;

  if (!cleanId || cleanId === 'latest') {
    draft = getLatestFreshShortcutDraft(180_000, nowMs);
  } else {
    draft = getShortcutQuickDraft(cleanId, nowMs);
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
 * Executes Gemini Vision OCR with strict retry discipline:
 * - Stops immediately on timeout or network error (never waits across multiple models).
 * - Only tries at most 1 fallback model (max 2 attempts total) when the primary model explicitly returns 404 or unsupported model.
 * - Fails fast on 429, 503, and invalid JSON responses, returning a human-readable fallback notice so the user can manually complete the draft.
 * - Never logs screenshots, transaction details, or API keys.
 */
export async function runShortcutGeminiOcrWithFastFail(options: {
  geminiKey: string;
  preferredModel?: string;
  prompt: string;
  mimeType: string;
  cleanBase64: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<{
  parsedOcr: Record<string, unknown>;
  ocrFallbackNotice: string;
  attempts: number;
  modelUsed: string | null;
}> {
  const fetchFn = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs ?? 18000;
  const preferred = (options.preferredModel || 'gemini-2.5-flash').trim();
  const candidateModels = [
    preferred,
    'gemini-2.5-flash',
    'gemini-flash-lite-latest',
  ]
    .filter((v, i, a) => Boolean(v) && a.indexOf(v) === i)
    .slice(0, 2);

  let parsedOcr: Record<string, unknown> = {};
  let ocrFallbackNotice = '';
  let attempts = 0;
  let modelUsed: string | null = null;

  for (let idx = 0; idx < candidateModels.length; idx += 1) {
    const model = candidateModels[idx];
    attempts += 1;
    try {
      const geminiRes = await fetchFn(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': options.geminiKey,
          },
          body: JSON.stringify({
            contents: [
              {
                role: 'user',
                parts: [
                  { text: options.prompt },
                  { inline_data: { mime_type: options.mimeType, data: options.cleanBase64 } },
                ],
              },
            ],
            generationConfig: {
              responseMimeType: 'application/json',
              temperature: 0.1,
              maxOutputTokens: 512,
              thinkingConfig: {
                thinkingBudget: 0,
              },
            },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        }
      );

      if (geminiRes.ok) {
        const geminiData = await geminiRes.json();
        const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const cleaned = String(rawText).replace(/```(?:json)?\s*([\s\S]*?)\s*```/, '$1').trim();
        if (!cleaned) {
          ocrFallbackNotice = '云端 AI 未返回有效识别内容，请直接手动补充金额与商户';
          break;
        }
        try {
          const rawParsed = JSON.parse(cleaned);
          const unwrapped = Array.isArray(rawParsed) ? rawParsed[0] : rawParsed;
          if (unwrapped && typeof unwrapped === 'object') {
            parsedOcr = unwrapped as Record<string, unknown>;
            modelUsed = model;
          } else {
            ocrFallbackNotice = '云端 AI 返回格式无效，请直接手动补充金额与商户';
          }
        } catch {
          ocrFallbackNotice = '云端 AI 响应无法解析，请直接手动补充金额与商户';
        }
        break;
      }

      // Only try the 1 fallback model if the current model explicitly does not exist / is not supported
      if (geminiRes.status === 404) {
        if (idx + 1 < candidateModels.length) {
          continue;
        }
        ocrFallbackNotice = '配置的 AI 识别模型不存在或暂不可用 (HTTP 404)，请直接手动补充金额与商户';
        break;
      }

      if (geminiRes.status === 400) {
        let isModelNotSupported = false;
        try {
          const errBody = await geminiRes.json();
          const errMsg = String(errBody?.error?.message || '').toLowerCase();
          if (errMsg.includes('not found') || errMsg.includes('not supported')) {
            isModelNotSupported = true;
          }
        } catch {
          // ignore parse errors
        }
        if (isModelNotSupported && idx + 1 < candidateModels.length) {
          continue;
        }
        ocrFallbackNotice = 'AI 识别请求参数或模型不受支持，请直接手动补充金额与商户';
        break;
      }

      // Fast fail on 429 (Quota/Rate limit) and 503/5xx (Service Unavailable): DO NOT retry other models
      if (geminiRes.status === 429) {
        ocrFallbackNotice = '云端 AI 识别配额繁忙 (HTTP 429)，已为您生成可补充草稿，请直接手动填写';
        break;
      }
      if (geminiRes.status === 503 || geminiRes.status >= 500) {
        ocrFallbackNotice = `云端 AI 服务暂时繁忙 (HTTP ${geminiRes.status})，已为您生成可补充草稿，请直接手动填写`;
        break;
      }

      ocrFallbackNotice = `云端 AI 识别未完成 (HTTP ${geminiRes.status})，请直接手动补充金额与商户`;
      break;
    } catch (err: unknown) {
      // Immediately stop on timeout or network error — never stack multiple timeouts across models
      const isTimeout =
        err instanceof Error &&
        (err.name === 'TimeoutError' || err.name === 'AbortError' || /timeout|aborted/i.test(err.message));
      ocrFallbackNotice = isTimeout
        ? '云端 AI 识别超时，已为您生成可补充草稿，请直接手动填写金额与商户'
        : '连接云端 AI 网络异常，已为您生成可补充草稿，请直接手动填写金额与商户';
      break;
    }
  }

  return {
    parsedOcr,
    ocrFallbackNotice,
    attempts,
    modelUsed,
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

/**
 * Directly records a validated shortcut transaction to Google Sheets when amount > 0
 * and no duplicate fingerprint is detected, returning a concise notification string for iOS Shortcuts.
 */
export async function recordShortcutDraftToLedger(
  draft: ShortcutQuickDraft,
  options: {
    fallbackNotice?: string;
    fetchImpl?: typeof fetch;
    autoRecord?: boolean;
  } = {}
): Promise<{
  autoRecorded: boolean;
  duplicateSkipped: boolean;
  transactionId: string | null;
  sheetName: string | null;
  notificationTitle: string;
  notificationText: string;
}> {
  const label = draft.description || draft.merchant || draft.category || '消费记录';
  const curr = (draft.currency || 'MYR').toUpperCase();

  if (options.autoRecord === false) {
    return {
      autoRecorded: false,
      duplicateSkipped: false,
      transactionId: null,
      sheetName: null,
      notificationTitle: '📋 已生成待确认草稿',
      notificationText:
        draft.amount && draft.amount > 0
          ? `📋 待确认：${curr} ${draft.amount.toFixed(2)} · ${label}`
          : '📋 已生成待补充草稿，请打开 Kinova 确认',
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

  const fetchFn = options.fetchImpl || fetch;
  const { url, apiKey } = resolveShortcutSheetsEndpoint();
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

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetchFn(`${url}?apiKey=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          action: 'addRow',
          sheetName,
          rowData,
          mutationId,
          key: apiKey,
          apiKey,
        }),
        cache: 'no-store',
        signal: AbortSignal.timeout(20000),
      });

      if (res.ok) {
        const json = await res.json();
        if (json?.data?.deduplicated) {
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
        const isSuccess = Boolean(json?.success || json?.status === 'success' || json?.data?.success);
        const isAdded = json?.data?.added !== false && !json?.data?.tombstoned;
        if (isSuccess && isAdded) {
          // Acknowledge draft so opening Kinova later won't pop open the draft modal for an already-recorded transaction
          acknowledgeShortcutDraft(draft.draftId);
          return {
            autoRecorded: true,
            duplicateSkipped: false,
            transactionId: txId,
            sheetName,
            notificationTitle: `✅ 已记账 ${curr} ${draft.amount.toFixed(2)} (${targetDate})`,
            notificationText: `✅ 已记账 [${targetDate}]：${curr} ${draft.amount.toFixed(2)} · ${label} (${draft.category})`,
          };
        }
        if (attempt === 0 && String(json?.message || '').toLowerCase().includes('lock')) {
          await new Promise((r) => setTimeout(r, 1200));
          continue;
        }
      }
    } catch {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
    }
  }

  return {
    autoRecorded: false,
    duplicateSkipped: false,
    transactionId: null,
    sheetName: null,
    notificationTitle: '⚠️ 自动入账超时',
    notificationText: `⚠️ 已识别 [${targetDate}] ${curr} ${draft.amount.toFixed(2)} · ${label}，但写入云端超时，打开 Kinova 即可确认保存`,
  };
}


