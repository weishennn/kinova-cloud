import { getLocalDateString, parseLocalDate } from './date-helper.ts';
import { isChipRejected, type RejectedChip } from './user-money-profile.ts';

export interface HabitSuggestionItem {
  label: string;
  text: string;
  isPersonalized?: boolean;
  actionPayload?: {
    amount: number;
    currency: string;
    category: string;
    description: string;
    type: 'Expense';
  };
}

export interface MinimalTransaction {
  id: string;
  date: string;
  amount: number;
  type: string;
  category?: string;
  description?: string;
  currency?: string;
}

function getMedian(numbers: number[]): number {
  if (!Array.isArray(numbers) || numbers.length === 0) return 0;
  const sorted = numbers.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function getMerchantEmoji(merchant: string, category: string): string {
  const m = merchant.toLowerCase();
  const c = category.toLowerCase();

  if (m.includes('petrol') || m.includes('shell') || m.includes('petronas') || m.includes('caltex') || c.includes('transport')) return '⛽';
  if (m.includes('kopi') || m.includes('coffee') || m.includes('starbucks') || m.includes('zus')) return '☕';
  if (m.includes('tea') || m.includes('boba') || m.includes('chagee') || m.includes('tealive')) return '🧋';
  if (m.includes('dessert') || m.includes('甜品') || m.includes('ice cream')) return '🍨';
  if (m.includes('mamak') || m.includes('roti') || m.includes('nasi lemak')) return '🍳';
  if (m.includes('grocer') || m.includes('speedmart') || m.includes('lotus') || m.includes('market') || m.includes('买菜')) return '🛒';
  if (m.includes('tng') || m.includes('touch n go') || m.includes('toll')) return '🚗';
  if (m.includes('grab') || m.includes('taxi')) return '🚕';
  if (m.includes('bread') || m.includes('bakery') || m.includes('cake')) return '🍰';
  if (m.includes('bill') || m.includes('tnb') || m.includes('unifi') || m.includes('water')) return '💡';
  if (c.includes('food') || c.includes('dining')) return '🍱';
  if (c.includes('shopping')) return '🛍️';
  return '💳';
}

function cleanMerchantName(desc: string, cat: string): string {
  let cleaned = desc.trim();
  // Remove trailing amounts or parenthesis
  cleaned = cleaned.replace(/\s*\(.*?\)\s*/g, ' ');
  cleaned = cleaned.replace(/\s*(?:rm|myr|\$)\s*[0-9]+(?:\.[0-9]{1,2})?/gi, ' ');
  cleaned = cleaned.replace(/^(?:payment to|purchase at|paid to)\s+/i, '');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  if (!cleaned || cleaned.length < 2) {
    return cat || 'Expense';
  }
  return cleaned;
}

/**
 * Mines user's past 90-day transactions to generate truly personalized, habit-driven suggestions.
 * Enforces:
 * - 90-day weekday/weekend + hour bucket
 * - Median amount
 * - Hiding rejected chips for 30 days
 * - NO default habits once 3+ real expenses exist
 * - Action payload for 1-tap logging
 */
export function mineUserHabitSuggestions(
  transactions: MinimalTransaction[],
  currentHour?: number,
  isWeekendDay?: boolean,
  rejectedChips?: RejectedChip[],
  nowMs: number = Date.now()
): HabitSuggestionItem[] {
  const hour = typeof currentHour === 'number' ? currentHour : new Date(nowMs).getHours();
  const isWeekend = typeof isWeekendDay === 'boolean'
    ? isWeekendDay
    : [0, 6].includes(new Date(nowMs).getDay());

  // Curated clean fallbacks for brand new users (fewer than 3 real expenses)
  const defaultFallback: HabitSuggestionItem[] =
    hour >= 6 && hour < 11
      ? [
          { label: '☕ 早餐 12', text: 'Breakfast 12' },
          { label: '⛽ 加油 50', text: 'Petrol 50' },
          { label: '🛒 早市买菜 40', text: 'Pasar 40' },
          { label: '☕ 咖啡 10', text: 'Coffee 10' },
        ]
      : hour >= 11 && hour < 15
      ? [
          { label: '🍱 午餐 15', text: 'Lunch 15' },
          { label: '🛵 外卖 25', text: 'Food delivery 25' },
          { label: '☕ 饮品 5', text: 'Drink 5' },
          { label: '🏪 便利店 15', text: 'Convenience store 15' },
        ]
      : hour >= 15 && hour < 18
      ? [
          { label: '🧋 下午茶 12', text: 'Tea & snack 12' },
          { label: '🍰 面包点心 15', text: 'Bakery 15' },
          { label: '🚗 交通出行 20', text: 'Transport 20' },
        ]
      : hour >= 18 && hour < 22
      ? [
          { label: '🍲 晚餐 35', text: 'Dinner 35' },
          { label: '🛒 超市采购 60', text: 'Supermarket 60' },
          { label: '⛽ 加油 50', text: 'Petrol 50' },
          { label: '🍨 甜品小吃 15', text: 'Dessert 15' },
        ]
      : [
          { label: '🌙 宵夜 15', text: 'Supper 15' },
          { label: '🏪 便利店 20', text: 'Convenience store 20' },
          { label: '🚕 打车 25', text: 'Ride 25' },
        ];

  const allRealExpenses = (transactions || []).filter(
    (t) => String(t.type || '').toLowerCase() === 'expense' && Number(t.amount) > 0
  );

  // If user has fewer than 3 expenses in their ledger, return default fallback (filtered by rejection)
  if (allRealExpenses.length < 3) {
    return defaultFallback.filter((item) => !isChipRejected(item.text, rejectedChips, nowMs));
  }

  // User has >= 3 real expenses: STRICT RULE: DO NOT SHOW DEFAULT FALLBACK!
  // Filter expenses from past 90 days, or use all real expenses if older
  const ninetyDaysAgo = new Date(nowMs - 90 * 24 * 60 * 60 * 1000);
  const cutoffDate = getLocalDateString(ninetyDaysAgo);

  const past90Expenses = allRealExpenses.filter((t) => t.date && t.date >= cutoffDate);
  const candidateExpenses = past90Expenses.length >= 3 ? past90Expenses : allRealExpenses;

  // Group by cleaned merchant name
  const merchantMap = new Map<
    string,
    {
      merchant: string;
      category: string;
      amounts: number[];
      count: number;
      weekendCount: number;
      weekdayCount: number;
    }
  >();

  for (const t of candidateExpenses) {
    const rawDesc = t.description || t.category || '';
    const merchant = cleanMerchantName(rawDesc, t.category || '');
    const key = merchant.toLowerCase();

    const txDate = parseLocalDate(t.date || '');
    const isTxWeekend = !Number.isNaN(txDate.getTime()) && (txDate.getDay() === 0 || txDate.getDay() === 6);

    const existing = merchantMap.get(key);
    if (existing) {
      existing.amounts.push(t.amount);
      existing.count += 1;
      if (isTxWeekend) existing.weekendCount += 1;
      else existing.weekdayCount += 1;
    } else {
      merchantMap.set(key, {
        merchant,
        category: t.category || 'Other',
        amounts: [t.amount],
        count: 1,
        weekendCount: isTxWeekend ? 1 : 0,
        weekdayCount: isTxWeekend ? 0 : 1,
      });
    }
  }

  // Time-of-day category preferences
  const isMorning = hour >= 6 && hour < 11;
  const isLunch = hour >= 11 && hour < 15;
  const isAfternoon = hour >= 15 && hour < 18;
  const isDinner = hour >= 18 && hour < 22;

  const scoredMerchants = Array.from(merchantMap.values()).map((item) => {
    let timeRelevance = 1;
    const cat = item.category.toLowerCase();
    const name = item.merchant.toLowerCase();

    if (isMorning) {
      if (cat.includes('food') || name.includes('kopi') || name.includes('toast') || name.includes('breakfast')) timeRelevance += 3;
      if (cat.includes('transport') || name.includes('petrol') || name.includes('shell')) timeRelevance += 2;
    } else if (isLunch) {
      if (cat.includes('food') || name.includes('rice') || name.includes('noodle') || name.includes('lunch')) timeRelevance += 3;
    } else if (isAfternoon) {
      if (name.includes('tea') || name.includes('coffee') || name.includes('boba') || name.includes('bakery')) timeRelevance += 3;
    } else if (isDinner) {
      if (cat.includes('food') || cat.includes('dining') || name.includes('dinner')) timeRelevance += 3;
      if (cat.includes('shopping') || name.includes('grocer') || name.includes('speedmart')) timeRelevance += 2;
      if (cat.includes('transport') || name.includes('petrol') || name.includes('shell')) timeRelevance += 1.5;
    } else {
      if (name.includes('mamak') || name.includes('familymart') || name.includes('supper') || cat.includes('food')) timeRelevance += 3;
    }

    // Weekday vs weekend weight
    const dayAffinity = isWeekend
      ? 1 + (item.weekendCount / Math.max(1, item.count)) * 0.8
      : 1 + (item.weekdayCount / Math.max(1, item.count)) * 0.8;

    const score = item.count * timeRelevance * dayAffinity;
    return { ...item, score };
  });

  scoredMerchants.sort((a, b) => b.score - a.score);

  const personalized: HabitSuggestionItem[] = [];

  for (const item of scoredMerchants) {
    if (personalized.length >= 4) break;

    const medianAmt = getMedian(item.amounts);
    const roundedAmt = medianAmt % 1 === 0 ? medianAmt.toString() : medianAmt.toFixed(2);
    const emoji = getMerchantEmoji(item.merchant, item.category);
    const chipText = `${item.merchant} ${roundedAmt}`;

    // Suppress if user rejected this chip within last 30 days
    if (isChipRejected(chipText, rejectedChips, nowMs) || isChipRejected(item.merchant, rejectedChips, nowMs)) {
      continue;
    }

    personalized.push({
      label: `${emoji} ${item.merchant} ${roundedAmt}`,
      text: chipText,
      isPersonalized: true,
      actionPayload: {
        amount: Number(medianAmt.toFixed(2)),
        currency: 'MYR',
        category: item.category,
        description: item.merchant,
        type: 'Expense',
      },
    });
  }

  // When user has >= 3 real expenses, NEVER show default fake habits!
  return personalized;
}
