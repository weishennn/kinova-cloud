import { convertCurrency, getCachedRatesToMyr } from '@/lib/currency';

export interface SplitwiseTripMember {
  id: string;
  display_name: string;
}

export interface SplitwiseExpense {
  id: string;
  title: string;
  amount: number;
  currency: string;
  base_amount: number;
  fx_rate?: number;
  rate_source?: string;
  expense_date: string;
  category: string;
  paid_by_member_id: string;
  is_settlement: boolean;
  splits: Record<string, number>;
}

export interface SplitwiseTripSnapshot {
  trip: { id: string; name: string; base_currency: string; invite_code: string };
  members: SplitwiseTripMember[];
  expenses: SplitwiseExpense[];
}

export interface SplitwiseNativeCurrencyBucket {
  currency: string;
  groupTotal: number;
  memberShare: number;
  memberPaid: number;
  netBalance: number;
}

export interface SplitwiseMemberSummary {
  groupTotal: number;
  memberShare: number;
  memberPaid: number;
  netBalance: number;
  categories: Array<{ key: string; name: string; amount: number }>;
  nativeByCurrency: SplitwiseNativeCurrencyBucket[];
}

export interface SavedSplitwiseConnection {
  inviteCode: string;
  memberId: string;
  includeInBudget?: boolean;
}

const CUSTOM_APP_URL_KEY = 'cashflow:splitwise-app-url';
const SNAPSHOT_CACHE_PREFIX = 'cashflow:splitwise-snapshot:';
const LOCAL_SPLITWISE_SNAPSHOT_PREFIX = 'splitwise:snapshot:';
const LOCAL_SPLITWISE_DB_KEY = 'splitwise:local-db:v1';

/**
 * Unified category mapping between Trixpense and Kinova.
 * Every Trixpense category maps 1-to-1 to a Kinova category name.
 */
const CATEGORY_LABELS: Record<string, string> = {
  food: 'Food & Dining',
  'food & dining': 'Food & Dining',
  drink: 'Food & Dining',
  'drinks & cafe': 'Food & Dining',
  trans: 'Transport',
  transport: 'Transport',
  hotel: 'Stay & Hotel',
  stay: 'Stay & Hotel',
  'stay & hotel': 'Stay & Hotel',
  flight: 'Flights',
  flights: 'Flights',
  shop: 'Shopping',
  shopping: 'Shopping',
  entertainment: 'Entertainment',
  activity: 'Entertainment',
  activities: 'Entertainment',
  health: 'Health',
  other: 'Other',
  misc: 'Other',
};

export function formatSplitwiseCategory(category: string): string {
  const key = String(category || '').trim().toLowerCase();
  if (CATEGORY_LABELS[key]) return CATEGORY_LABELS[key];
  if (!category) return 'Other';
  return category.charAt(0).toUpperCase() + category.slice(1);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function currencyScale(currency: string): number {
  try {
    const digits =
      new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2;
    return 10 ** digits;
  } catch {
    return 100;
  }
}

function amountToMinorUnits(amount: unknown, scale: number): number {
  const value = Number(amount);
  if (!Number.isFinite(value)) throw new Error('Trixpense returned an invalid expense amount.');
  const minor = Math.round(value * scale);
  if (!Number.isSafeInteger(minor)) throw new Error('This trip is too large to total precisely.');
  return minor;
}

/**
 * Reconstructs each member's exact minor-unit share in the expense's ORIGINAL paid currency
 * (`expense.currency`) so sums of member shares equal `expense.amount` to the exact cent.
 * Prevents round-trip FX drift (e.g. MYR -> CNY -> MYR across different daily rates).
 */
export function getOriginalCurrencySplitsMinor(
  expense: SplitwiseExpense,
  baseCurrency: string,
): Record<string, number> {
  const origCurr = String(expense.currency || baseCurrency || 'MYR').toUpperCase();
  const baseCurr = String(baseCurrency || 'MYR').toUpperCase();
  const origScale = currencyScale(origCurr);
  const baseScale = currencyScale(baseCurr);

  const entries = Object.entries(expense.splits || {}).filter(([, val]) => Number(val) > 0);
  if (!entries.length) return {};

  const origTotalMinor = amountToMinorUnits(expense.amount ?? expense.base_amount ?? 0, origScale);
  const baseTotalMinor = amountToMinorUnits(expense.base_amount ?? expense.amount ?? 0, baseScale);

  if (origCurr === baseCurr || baseTotalMinor <= 0 || origTotalMinor <= 0) {
    const direct: Record<string, number> = {};
    for (const [memberId, val] of entries) {
      direct[memberId] = amountToMinorUnits(val, origScale);
    }
    return direct;
  }

  const rawQuotas = entries.map(([memberId, val]) => {
    const shareBaseMinor = amountToMinorUnits(val, baseScale);
    const exactQuota = (origTotalMinor * shareBaseMinor) / baseTotalMinor;
    const floored = Math.floor(exactQuota);
    return {
      memberId,
      floored,
      remainder: exactQuota - floored,
    };
  });

  const sumFloored = rawQuotas.reduce((acc, item) => acc + item.floored, 0);
  const leftover = Math.max(0, origTotalMinor - sumFloored);

  rawQuotas.sort((a, b) => {
    if (b.remainder !== a.remainder) return b.remainder - a.remainder;
    return a.memberId.localeCompare(b.memberId);
  });

  const allocated: Record<string, number> = {};
  rawQuotas.forEach((item, idx) => {
    allocated[item.memberId] = item.floored + (idx < leftover ? 1 : 0);
  });
  return allocated;
}

export function getCustomSplitwiseAppUrl(): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(CUSTOM_APP_URL_KEY)?.trim() || '';
  } catch {
    return '';
  }
}

export function setCustomSplitwiseAppUrl(url: string): void {
  if (typeof window === 'undefined') return;
  const clean = url.trim().replace(/\/+$/, '');
  try {
    if (!clean) {
      window.localStorage.removeItem(CUSTOM_APP_URL_KEY);
      return;
    }
    const parsed = new URL(clean);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('URL must start with https:// or http://');
    }
    window.localStorage.setItem(CUSTOM_APP_URL_KEY, parsed.toString().replace(/\/+$/, ''));
  } catch (error) {
    throw error instanceof Error
      ? error
      : new Error('Enter a valid Trixpense URL (e.g. https://your-trixpense.vercel.app).');
  }
}

const DEFAULT_TRIXPENSE_APP_URL = 'https://trixpense.vercel.app';
const DEFAULT_TRIXPENSE_SUPABASE_URL = 'https://ohsbcsbymzsnowfgkblb.supabase.co';
const DEFAULT_TRIXPENSE_SUPABASE_ANON_KEY = 'sb_publishable_UBYTr5hVoD-A_ACmMhhoCA_pa5huwgn';

function stripZeroWidth(value: string): string {
  return String(value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
}

export function getSplitwiseAppBaseUrl(): URL | null {
  const customUrl = getCustomSplitwiseAppUrl();
  const envUrl =
    process.env.NEXT_PUBLIC_TRIXPENSE_APP_URL?.trim() ||
    process.env.NEXT_PUBLIC_SPLITWISE_APP_URL?.trim() ||
    DEFAULT_TRIXPENSE_APP_URL;
  const candidate = customUrl || envUrl;
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url;
  } catch {
    return null;
  }
}

export function hasSplitwiseCloudConfig(): boolean {
  return true;
}

function parseSnapshotPayload(payload: unknown, fallbackInviteCode: string): SplitwiseTripSnapshot {
  const payloadRecord = asRecord(payload);
  const rawTrip = asRecord(payloadRecord?.trip);
  const rawMembers = payloadRecord?.members;
  const rawExpenses = payloadRecord?.expenses;
  if (!rawTrip?.id || !Array.isArray(rawMembers) || !Array.isArray(rawExpenses)) {
    throw new Error('That invite code was not found, or Trixpense returned incomplete trip data.');
  }

  const trip: SplitwiseTripSnapshot['trip'] = {
    id: String(rawTrip.id),
    name: String(rawTrip.name || 'Trip'),
    base_currency: String(rawTrip.base_currency || 'MYR').toUpperCase(),
    invite_code: String(rawTrip.invite_code || fallbackInviteCode).toUpperCase(),
  };
  const members = rawMembers.flatMap(value => {
    const member = asRecord(value);
    return member?.id && member.display_name
      ? [{ id: String(member.id), display_name: stripZeroWidth(String(member.display_name)) }]
      : [];
  });
  const expenses = rawExpenses.flatMap(value => {
    const expense = asRecord(value);
    if (!expense?.id) return [];
    const rawSplits = asRecord(expense.splits) || {};
    const fxRateNum = Number(expense.fx_rate);
    return [
      {
        id: String(expense.id),
        title: String(expense.title || expense.category || 'Expense'),
        amount: Number(expense.amount ?? 0),
        currency: String(expense.currency || trip.base_currency).toUpperCase(),
        base_amount: Number(expense.base_amount ?? 0),
        fx_rate: Number.isFinite(fxRateNum) && fxRateNum > 0 ? fxRateNum : undefined,
        rate_source: expense.rate_source ? String(expense.rate_source) : undefined,
        expense_date: String(expense.expense_date || ''),
        category: String(expense.category || 'other'),
        paid_by_member_id: String(expense.paid_by_member_id || ''),
        is_settlement: Boolean(expense.is_settlement),
        splits: Object.fromEntries(
          Object.entries(rawSplits).map(([id, amount]) => [id, Number(amount)]),
        ),
      },
    ];
  });

  return { trip, members, expenses };
}

function readLocalBrowserSplitwiseSnapshot(inviteCode: string): SplitwiseTripSnapshot | null {
  if (typeof window === 'undefined') return null;
  const code = inviteCode.trim().toUpperCase();

  try {
    const directRaw = window.localStorage.getItem(`${LOCAL_SPLITWISE_SNAPSHOT_PREFIX}${code}`);
    if (directRaw) {
      return parseSnapshotPayload(JSON.parse(directRaw), code);
    }

    const localDbRaw = window.localStorage.getItem(LOCAL_SPLITWISE_DB_KEY);
    if (localDbRaw) {
      const db = JSON.parse(localDbRaw);
      const trip = Array.isArray(db?.trips)
        ? db.trips.find((t: any) => String(t?.invite_code || '').toUpperCase() === code)
        : null;
      if (trip) {
        const members = (Array.isArray(db?.trip_members) ? db.trip_members : []).filter(
          (m: any) => m?.trip_id === trip.id,
        );
        const rawExpenses = (Array.isArray(db?.expenses) ? db.expenses : []).filter(
          (e: any) => e?.trip_id === trip.id,
        );
        const allSplits = Array.isArray(db?.expense_splits) ? db.expense_splits : [];
        const expenses = rawExpenses.map((e: any) => {
          const splits: Record<string, number> = {};
          allSplits
            .filter((s: any) => s?.expense_id === e.id)
            .forEach((s: any) => {
              splits[String(s.member_id)] = Number(s.share_amount);
            });
          return { ...e, splits };
        });
        return parseSnapshotPayload({ trip, members, expenses }, code);
      }
    }
  } catch {
    // Ignore local storage read errors
  }
  return null;
}

export function getCachedSplitwiseSnapshot(inviteCode: string): SplitwiseTripSnapshot | null {
  if (typeof window === 'undefined') return null;
  const code = inviteCode.trim().toUpperCase();
  if (!/^[A-Z0-9]{8}$/.test(code)) return null;
  const localBrowser = readLocalBrowserSplitwiseSnapshot(code);
  if (localBrowser) return localBrowser;
  try {
    const raw = window.localStorage.getItem(`${SNAPSHOT_CACHE_PREFIX}${code}`);
    if (!raw) return null;
    return parseSnapshotPayload(JSON.parse(raw), code);
  } catch {
    return null;
  }
}

function saveCachedSplitwiseSnapshot(snapshot: SplitwiseTripSnapshot): void {
  if (typeof window === 'undefined') return;
  try {
    const code = snapshot.trip.invite_code.trim().toUpperCase();
    window.localStorage.setItem(`${SNAPSHOT_CACHE_PREFIX}${code}`, JSON.stringify(snapshot));
    window.dispatchEvent(new Event('trixpense-sync-updated'));
  } catch {
    // Ignore quota errors
  }
}

export async function fetchSplitwiseTripSnapshot(inviteCode: string): Promise<SplitwiseTripSnapshot> {
  const normalizedCode = inviteCode.trim().toUpperCase();
  if (!/^[A-Z0-9]{8}$/.test(normalizedCode)) {
    throw new Error('Enter the 8-character Trixpense invite code.');
  }

  const localSnapshot = readLocalBrowserSplitwiseSnapshot(normalizedCode);

  const appUrl = getSplitwiseAppBaseUrl();
  const directSupabaseUrl = (
    process.env.NEXT_PUBLIC_TRIXPENSE_SUPABASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_SPLITWISE_SUPABASE_URL?.trim() ||
    DEFAULT_TRIXPENSE_SUPABASE_URL
  ).replace(/\/+$/, '');
  const directSupabaseKey = (
    process.env.NEXT_PUBLIC_TRIXPENSE_SUPABASE_ANON_KEY?.trim() ||
    process.env.NEXT_PUBLIC_SPLITWISE_SUPABASE_ANON_KEY?.trim() ||
    process.env.NEXT_PUBLIC_SPLITWISE_SUPABASE_KEY?.trim() ||
    DEFAULT_TRIXPENSE_SUPABASE_ANON_KEY
  );

  // 1. Try Trixpense /api/trip-snapshot first
  if (appUrl) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(new URL('/api/trip-snapshot', appUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ inviteCode: normalizedCode }),
        signal: controller.signal,
        cache: 'no-store',
      });
      const payload: unknown = await response.json().catch(() => null);
      if (response.ok && payload) {
        const snapshot = parseSnapshotPayload(payload, normalizedCode);
        saveCachedSplitwiseSnapshot(snapshot);
        return snapshot;
      }
      if (response.status === 404 && asRecord(payload)?.error) {
        throw new Error(String(asRecord(payload)?.error));
      }
    } catch (err) {
      if (err instanceof Error && /not found/i.test(err.message)) {
        throw err;
      }
      // Fall through to direct Supabase RPC
    } finally {
      window.clearTimeout(timeout);
    }
  }

  // 2. Fallback: Query Supabase RPC get_trip_snapshot_by_invite directly
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10_000);
  try {
    const rpcUrl = `${directSupabaseUrl}/rest/v1/rpc/get_trip_snapshot_by_invite`;
    const headers: Record<string, string> = {
      apikey: directSupabaseKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (directSupabaseKey.startsWith('eyJ')) {
      headers.Authorization = `Bearer ${directSupabaseKey}`;
    }
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ p_invite_code: normalizedCode }),
      signal: controller.signal,
      cache: 'no-store',
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      if (localSnapshot) {
        saveCachedSplitwiseSnapshot(localSnapshot);
        return localSnapshot;
      }
      const message = asRecord(payload)?.error || asRecord(payload)?.message;
      throw new Error(typeof message === 'string' && message ? message : `Trixpense returned an error (${response.status}).`);
    }
    const snapshot = parseSnapshotPayload(payload, normalizedCode);
    saveCachedSplitwiseSnapshot(snapshot);
    return snapshot;
  } catch (error) {
    if (localSnapshot) {
      saveCachedSplitwiseSnapshot(localSnapshot);
      return localSnapshot;
    }
    if (error instanceof Error) throw error;
    throw new Error('Could not reach Trixpense. Check your network connection.');
  } finally {
    window.clearTimeout(timeout);
  }
}

export function summarizeSplitwiseMember(
  snapshot: SplitwiseTripSnapshot,
  memberId: string,
): SplitwiseMemberSummary {
  const baseCurr = snapshot.trip.base_currency || 'MYR';
  const scale = currencyScale(baseCurr);
  const expenses = snapshot.expenses.filter(
    expense => !expense.is_settlement && expense.category !== '__deleted__',
  );
  let groupTotalMinor = 0;
  let memberShareMinor = 0;
  let memberPaidMinor = 0;
  const categories = new Map<string, number>();

  // Native paid-currency buckets (no FX conversion applied)
  const nativeBuckets = new Map<
    string,
    { groupMinor: number; shareMinor: number; paidMinor: number; scale: number }
  >();

  for (const expense of expenses) {
    const baseMinor = amountToMinorUnits(expense.base_amount, scale);
    groupTotalMinor += baseMinor;
    if (expense.paid_by_member_id === memberId) memberPaidMinor += baseMinor;
    const shareMinor = amountToMinorUnits(expense.splits[memberId] || 0, scale);
    memberShareMinor += shareMinor;
    const normalizedCatName = formatSplitwiseCategory(expense.category);
    if (shareMinor > 0) {
      categories.set(normalizedCatName, (categories.get(normalizedCatName) || 0) + shareMinor);
    }

    // Also record in the exact currency originally paid
    const origCurr = String(expense.currency || baseCurr).toUpperCase();
    const origScale = currencyScale(origCurr);
    const origTotalMinor = amountToMinorUnits(expense.amount ?? expense.base_amount ?? 0, origScale);
    const origSplitsMinor = getOriginalCurrencySplitsMinor(expense, baseCurr);
    const origMemberShareMinor = origSplitsMinor[memberId] || 0;

    let bucket = nativeBuckets.get(origCurr);
    if (!bucket) {
      bucket = { groupMinor: 0, shareMinor: 0, paidMinor: 0, scale: origScale };
      nativeBuckets.set(origCurr, bucket);
    }
    bucket.groupMinor += origTotalMinor;
    bucket.shareMinor += origMemberShareMinor;
    if (expense.paid_by_member_id === memberId) {
      bucket.paidMinor += origTotalMinor;
    }
  }

  const netBalanceMinor = memberPaidMinor - memberShareMinor;

  for (const value of [
    groupTotalMinor,
    memberShareMinor,
    memberPaidMinor,
    netBalanceMinor,
    ...categories.values(),
  ]) {
    if (!Number.isSafeInteger(value)) throw new Error('This trip is too large to total precisely.');
  }

  const nativeByCurrency: SplitwiseNativeCurrencyBucket[] = [...nativeBuckets.entries()].map(
    ([curr, b]) => ({
      currency: curr,
      groupTotal: b.groupMinor / b.scale,
      memberShare: b.shareMinor / b.scale,
      memberPaid: b.paidMinor / b.scale,
      netBalance: (b.paidMinor - b.shareMinor) / b.scale,
    }),
  );

  return {
    groupTotal: groupTotalMinor / scale,
    memberShare: memberShareMinor / scale,
    memberPaid: memberPaidMinor / scale,
    netBalance: netBalanceMinor / scale,
    categories: [...categories.entries()]
      .map(([name, amount]) => ({
        key: name,
        name,
        amount: amount / scale,
      }))
      .sort((a, b) => b.amount - a.amount),
    nativeByCurrency,
  };
}

/**
 * Computes a member's Trixpense summary in ANY target currency (e.g. 'MYR' or `trip.currency`)
 * WITHOUT round-tripping expenses that were already paid in `targetCurrency`.
 *
 * Example:
 * - Day 1: Paid 100 MYR (rate 1.60 -> 160 CNY)
 * - Day 2: Paid 10 MYR (rate 1.66 -> 16.60 CNY)
 * When `targetCurrency === 'MYR'`, those two expenses evaluate to exact `110.00 MYR`
 * instead of converting 176.60 CNY back to MYR at a different rate!
 */
export function resolveSplitwiseSummaryInCurrency(
  snapshot: SplitwiseTripSnapshot,
  memberId: string,
  targetCurrency: string,
  tripCurrency?: string,
  tripRateToMyr?: number,
): {
  groupTotal: number;
  memberShare: number;
  memberPaid: number;
  netBalance: number;
  categories: Array<{ key: string; name: string; amount: number }>;
} {
  const target = String(targetCurrency || 'MYR').trim().toUpperCase();
  const baseCurr = String(snapshot.trip.base_currency || 'MYR').trim().toUpperCase();
  const targetScale = currencyScale(target);
  const expenses = snapshot.expenses.filter(
    expense => !expense.is_settlement && expense.category !== '__deleted__',
  );

  let groupTotalMinor = 0;
  let memberShareMinor = 0;
  let memberPaidMinor = 0;
  const categories = new Map<string, number>();

  for (const expense of expenses) {
    const origCurr = String(expense.currency || baseCurr).trim().toUpperCase();
    const origScale = currencyScale(origCurr);

    let expGroupInTargetMinor = 0;
    let expShareInTargetMinor = 0;

    if (origCurr === target) {
      // Exact native paid currency! Zero FX conversion drift.
      expGroupInTargetMinor = amountToMinorUnits(expense.amount ?? expense.base_amount ?? 0, targetScale);
      const origSplits = getOriginalCurrencySplitsMinor(expense, baseCurr);
      expShareInTargetMinor = origSplits[memberId] || 0;
    } else if (baseCurr === target) {
      // Stored base_amount is already in targetCurrency
      expGroupInTargetMinor = amountToMinorUnits(expense.base_amount, targetScale);
      expShareInTargetMinor = amountToMinorUnits(expense.splits[memberId] || 0, targetScale);
    } else {
      // Convert from original currency into targetCurrency
      const origSplits = getOriginalCurrencySplitsMinor(expense, baseCurr);
      const origShare = (origSplits[memberId] || 0) / origScale;
      const origTotal = Number(expense.amount ?? 0);
      const convertedTotal = convertSplitwiseAmount(origTotal, origCurr, target, tripCurrency, tripRateToMyr);
      const convertedShare = convertSplitwiseAmount(origShare, origCurr, target, tripCurrency, tripRateToMyr);
      expGroupInTargetMinor = amountToMinorUnits(convertedTotal, targetScale);
      expShareInTargetMinor = amountToMinorUnits(convertedShare, targetScale);
    }

    groupTotalMinor += expGroupInTargetMinor;
    memberShareMinor += expShareInTargetMinor;
    if (expense.paid_by_member_id === memberId) {
      memberPaidMinor += expGroupInTargetMinor;
    }
    const catName = formatSplitwiseCategory(expense.category);
    if (expShareInTargetMinor > 0) {
      categories.set(catName, (categories.get(catName) || 0) + expShareInTargetMinor);
    }
  }

  return {
    groupTotal: groupTotalMinor / targetScale,
    memberShare: memberShareMinor / targetScale,
    memberPaid: memberPaidMinor / targetScale,
    netBalance: (memberPaidMinor - memberShareMinor) / targetScale,
    categories: [...categories.entries()]
      .map(([name, minor]) => ({
        key: name,
        name,
        amount: minor / targetScale,
      }))
      .sort((a, b) => b.amount - a.amount),
  };
}

export function formatSplitwiseMoney(amount: number, currency: string): string {
  const code = String(currency || 'MYR').trim().toUpperCase();
  try {
    return new Intl.NumberFormat('en-MY', {
      style: 'currency',
      currency: code,
      currencyDisplay: 'code',
    }).format(amount);
  } catch {
    return `${code} ${Number(amount || 0).toFixed(2)}`;
  }
}

/**
 * Converts an amount from Trixpense's `fromCurrency` into `targetCurrency`,
 * respecting the Kinova trip's custom `tripRateToMyr` when `tripCurrency` is involved.
 */
export function convertSplitwiseAmount(
  amount: number,
  fromCurrency: string,
  targetCurrency: string,
  tripCurrency?: string,
  tripRateToMyr?: number,
): number {
  if (!Number.isFinite(amount) || amount === 0) return 0;
  const from = String(fromCurrency || 'MYR').trim().toUpperCase();
  const to = String(targetCurrency || 'MYR').trim().toUpperCase();
  if (from === to) return amount;

  const tCurr = String(tripCurrency || '').trim().toUpperCase();
  const tRate = Number(tripRateToMyr || 0);

  let amountInMyr: number;
  if (from === 'MYR') {
    amountInMyr = amount;
  } else if (from === tCurr && tRate > 0) {
    amountInMyr = amount * tRate;
  } else {
    amountInMyr = convertCurrency(amount, from, 'MYR', getCachedRatesToMyr());
  }

  if (to === 'MYR') return amountInMyr;
  if (to === tCurr && tRate > 0) {
    return amountInMyr / tRate;
  }
  return convertCurrency(amountInMyr, 'MYR', to, getCachedRatesToMyr());
}

export function getSavedSplitwiseConnection(tripId: string): SavedSplitwiseConnection | null {
  if (typeof window === 'undefined') return null;
  const storageKey = `cashflow:splitwise-link:${encodeURIComponent(tripId)}`;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.inviteCode === 'string' &&
      /^[A-Z0-9]{8}$/.test(parsed.inviteCode) &&
      typeof parsed.memberId === 'string'
    ) {
      return {
        inviteCode: parsed.inviteCode,
        memberId: parsed.memberId,
        includeInBudget: parsed.includeInBudget !== false,
      };
    }
  } catch {
    // ignore
  }
  return null;
}

export function saveSplitwiseConnection(
  tripId: string,
  connection: SavedSplitwiseConnection | null,
): boolean {
  if (typeof window === 'undefined') return false;
  const storageKey = `cashflow:splitwise-link:${encodeURIComponent(tripId)}`;
  try {
    if (connection) {
      window.localStorage.setItem(
        storageKey,
        JSON.stringify({
          inviteCode: connection.inviteCode.trim().toUpperCase(),
          memberId: connection.memberId,
          includeInBudget: connection.includeInBudget !== false,
        }),
      );
    } else {
      window.localStorage.removeItem(storageKey);
    }
    window.dispatchEvent(new Event('trixpense-sync-updated'));
    return true;
  } catch {
    return false;
  }
}

export interface SplitwiseSyncedTransactionRow {
  id: string;
  date: string;
  amount: number;
  type: 'expense';
  category: string;
  subCategory: string;
  description: string;
  account: string;
  currency: string;
  baseAmount: number;
  baseCurrency: string;
  fxRateToBase: number;
  notes: string;
  tripTag: string;
  tripId: string;
}

/**
 * Builds virtual Transaction rows for the user's personal share of all linked Trixpense trips
 * so that Flow (/transactions), Overview (/), and Budget (/budget) automatically include them.
 */
export function buildSplitwiseTransactionsFromTrips(
  tripsRows: Array<Record<string, unknown>> = [],
): SplitwiseSyncedTransactionRow[] {
  if (typeof window === 'undefined') return [];

  const results: SplitwiseSyncedTransactionRow[] = [];
  const seenExpenseKeys = new Set<string>();

  // 1. Match against Kinova Trips rows first (preserves custom tripTag and tripRateToMyr)
  for (let idx = 0; idx < tripsRows.length; idx++) {
    const row = tripsRows[idx] || {};
    const name = String(
      row.TripName || row.tripName || row.Name || row.name || `Trip #${idx + 1}`,
    ).trim();
    const id = String(row.Id || row.id || name).trim();
    const tripCurrency = String(row.Currency || row.currency || 'MYR').trim().toUpperCase();
    const notesRaw = String(row.Notes || row.notes || '');
    const notesRateMatch = notesRaw.match(/rateToMyr\s*[=:]\s*([0-9.]+)/i);
    const parsedNotesRate = notesRateMatch?.[1] ? parseFloat(notesRateMatch[1]) : NaN;
    const rateToMyr =
      (!isNaN(parsedNotesRate) && parsedNotesRate > 0 ? parsedNotesRate : 0) ||
      Number(
        row.ExchangeRateToMyr ||
          row.exchangeRateToMyr ||
          row.ExchangeRate ||
          row.exchangeRate ||
          0,
      ) ||
      (tripCurrency === 'MYR' ? 1 : getCachedRatesToMyr()[tripCurrency] || 1);
    const defaultStartDate = String(
      row.StartDate || row.startDate || row.start_date || '',
    ).trim();

    const connection =
      getSavedSplitwiseConnection(id) ||
      (name !== id ? getSavedSplitwiseConnection(name) : null);
    if (!connection || connection.includeInBudget === false) continue;

    const snapshot = getCachedSplitwiseSnapshot(connection.inviteCode);
    if (!snapshot) continue;

    appendSnapshotMemberTransactions(
      snapshot,
      connection.memberId,
      name,
      id,
      tripCurrency,
      rateToMyr,
      defaultStartDate,
      seenExpenseKeys,
      results,
    );
  }

  // 2. Also scan any other cashflow:splitwise-link:* keys in localStorage
  try {
    const prefix = 'cashflow:splitwise-link:';
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(prefix)) continue;
      const tripId = decodeURIComponent(key.slice(prefix.length));
      const connection = getSavedSplitwiseConnection(tripId);
      if (!connection || connection.includeInBudget === false) continue;
      const snapshot = getCachedSplitwiseSnapshot(connection.inviteCode);
      if (!snapshot) continue;
      appendSnapshotMemberTransactions(
        snapshot,
        connection.memberId,
        snapshot.trip.name || tripId,
        tripId,
        snapshot.trip.base_currency || 'MYR',
        undefined,
        '',
        seenExpenseKeys,
        results,
      );
    }
  } catch {
    // Ignore storage enumeration errors
  }

  return results;
}

function appendSnapshotMemberTransactions(
  snapshot: SplitwiseTripSnapshot,
  memberId: string,
  tripName: string,
  tripId: string,
  tripCurrency: string,
  tripRateToMyr: number | undefined,
  defaultDate: string,
  seenExpenseKeys: Set<string>,
  results: SplitwiseSyncedTransactionRow[],
): void {
  const baseCurr = String(snapshot.trip.base_currency || 'MYR').trim().toUpperCase();
  const member =
    snapshot.members.find((m) => m.id === memberId) ||
    snapshot.members.find((m) => /wei\s*shen/i.test(m.display_name)) ||
    snapshot.members[0];
  if (!member) return;
  const effectiveMemberId = member.id;
  const activeExpenses = snapshot.expenses.filter(
    (e) => !e.is_settlement && String(e.category || '').toLowerCase() !== '__deleted__',
  );

  for (const expense of activeExpenses) {
    const dedupeKey = `${snapshot.trip.invite_code}:${expense.id}`;
    if (seenExpenseKeys.has(dedupeKey)) continue;

    const origCurr = String(expense.currency || baseCurr || 'MYR').trim().toUpperCase();
    const origScale = currencyScale(origCurr);
    const origSplits = getOriginalCurrencySplitsMinor(expense, baseCurr);
    const shareMinor = origSplits[effectiveMemberId] || 0;
    if (shareMinor <= 0) continue;

    seenExpenseKeys.add(dedupeKey);
    const shareOrig = shareMinor / origScale;

    let shareMyr: number;
    if (origCurr === 'MYR') {
      shareMyr = shareOrig;
    } else if (baseCurr === 'MYR' && Number(expense.splits?.[effectiveMemberId]) > 0) {
      shareMyr = Number(expense.splits[effectiveMemberId]);
    } else {
      shareMyr = convertSplitwiseAmount(
        shareOrig,
        origCurr,
        'MYR',
        tripCurrency,
        tripRateToMyr,
      );
    }

    const fxRateToBase = shareOrig > 0 ? shareMyr / shareOrig : 1;
    const rawDate = String(expense.expense_date || '').trim();
    const validDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
      ? rawDate
      : /^\d{4}-\d{2}-\d{2}$/.test(defaultDate)
        ? defaultDate
        : new Date().toISOString().slice(0, 10);

    results.push({
      id: `trixpense_${snapshot.trip.invite_code}_${expense.id}`,
      date: validDate,
      amount: Number(shareOrig.toFixed(2)),
      type: 'expense',
      category: formatSplitwiseCategory(expense.category),
      subCategory: 'Trixpense Shared Bill',
      description: `${expense.title} (Trixpense)`,
      account: 'Trixpense',
      currency: origCurr,
      baseAmount: Number(shareMyr.toFixed(2)),
      baseCurrency: 'MYR',
      fxRateToBase: Number(fxRateToBase.toFixed(6)),
      notes: `Synced from Trixpense "${snapshot.trip.name}" (${snapshot.trip.invite_code})${
        member ? ` · My share (${member.display_name})` : ''
      } · Total bill: ${origCurr} ${Number(expense.amount || 0).toFixed(2)}`,
      tripTag: tripName,
      tripId,
    });
  }
}

export function getSplitwiseOpenUrl(inviteCode: string): string | null {
  const appUrl = getSplitwiseAppBaseUrl();
  if (!appUrl) return null;
  return `${appUrl.toString().replace(/\/+$/, '')}/index.html?join=${encodeURIComponent(inviteCode)}`;
}

const KEEPALIVE_PING_KEY = 'cashflow:trixpense-keepalive-at';

/**
 * Sends a silent background keep-alive heartbeat from Kinova to Trixpense / Supabase (`pbxbrdntwgoedjeumwrq`)
 * at most once every 12 hours so everyday use of Kinova prevents Supabase from pausing Trixpense between trips.
 */
export async function pingTrixpenseKeepAlive(): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    const lastRaw = window.localStorage.getItem(KEEPALIVE_PING_KEY);
    if (lastRaw) {
      const elapsed = Date.now() - new Date(lastRaw).getTime();
      if (Number.isFinite(elapsed) && elapsed < 12 * 60 * 60 * 1000) return;
    }

    const appUrl = getSplitwiseAppBaseUrl();
    if (appUrl) {
      const res = await fetch(new URL('/api/keep-alive', appUrl), {
        method: 'GET',
        cache: 'no-store',
      });
      if (res.ok) {
        window.localStorage.setItem(KEEPALIVE_PING_KEY, new Date().toISOString());
        return;
      }
    }

    const sbUrl = (
      process.env.NEXT_PUBLIC_TRIXPENSE_SUPABASE_URL?.trim() ||
      process.env.NEXT_PUBLIC_SPLITWISE_SUPABASE_URL?.trim() ||
      DEFAULT_TRIXPENSE_SUPABASE_URL
    ).replace(/\/+$/, '');
    const sbKey = (
      process.env.NEXT_PUBLIC_TRIXPENSE_SUPABASE_ANON_KEY?.trim() ||
      process.env.NEXT_PUBLIC_SPLITWISE_SUPABASE_ANON_KEY?.trim() ||
      process.env.NEXT_PUBLIC_SPLITWISE_SUPABASE_KEY?.trim() ||
      DEFAULT_TRIXPENSE_SUPABASE_ANON_KEY
    );
    if (!sbKey) return;
    const res = await fetch(`${sbUrl}/rest/v1/rpc/get_trip_snapshot_by_invite`, {
      method: 'POST',
      headers: {
        apikey: sbKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ p_invite_code: 'KEEPALIV' }),
      cache: 'no-store',
    });
    if (res.ok || res.status === 400 || res.status === 404) {
      window.localStorage.setItem(KEEPALIVE_PING_KEY, new Date().toISOString());
    }
  } catch {
    // Ignore background heartbeat network errors
  }
}
