import { getLocalDateString } from './date-helper.ts';

export interface HabitSuggestionItem {
  label: string;
  text: string;
  isPersonalized?: boolean;
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
 * Follows time-of-day contextual habits with intelligent fallback.
 */
export function mineUserHabitSuggestions(
  transactions: MinimalTransaction[],
  currentHour?: number
): HabitSuggestionItem[] {
  const hour = typeof currentHour === 'number' ? currentHour : new Date().getHours();

  // Curated clean fallbacks for new users
  const defaultFallback: HabitSuggestionItem[] =
    hour >= 6 && hour < 11
      ? [
          { label: '☕ 早餐 12', text: 'Breakfast 12' },
          { label: '⛽ 加油 50', text: 'Petrol 50' },
          { label: '🛒 早市买菜 40', text: 'Groceries 40' },
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

  if (!Array.isArray(transactions) || transactions.length < 3) {
    return defaultFallback;
  }

  // Filter 90-day expenses
  const now = new Date();
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const cutoffDate = getLocalDateString(ninetyDaysAgo);

  const recentExpenses = transactions.filter(
    (t) => t.type === 'expense' && t.date >= cutoffDate && t.amount > 0
  );

  if (recentExpenses.length < 3) {
    return defaultFallback;
  }

  // Group by cleaned merchant name
  const merchantMap = new Map<
    string,
    {
      merchant: string;
      category: string;
      amounts: number[];
      count: number;
    }
  >();

  for (const t of recentExpenses) {
    const rawDesc = t.description || t.category || '';
    const merchant = cleanMerchantName(rawDesc, t.category || '');
    const key = merchant.toLowerCase();

    const existing = merchantMap.get(key);
    if (existing) {
      existing.amounts.push(t.amount);
      existing.count += 1;
    } else {
      merchantMap.set(key, {
        merchant,
        category: t.category || 'Other',
        amounts: [t.amount],
        count: 1,
      });
    }
  }

  // Define category preference according to current time of day
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

    const score = item.count * timeRelevance;
    return { ...item, score };
  });

  scoredMerchants.sort((a, b) => b.score - a.score);

  const personalized: HabitSuggestionItem[] = scoredMerchants.slice(0, 4).map((item) => {
    const medianAmt = getMedian(item.amounts);
    const roundedAmt = medianAmt % 1 === 0 ? medianAmt.toString() : medianAmt.toFixed(2);
    const emoji = getMerchantEmoji(item.merchant, item.category);
    return {
      label: `${emoji} ${item.merchant} ${roundedAmt}`,
      text: `${item.merchant} ${roundedAmt}`,
      isPersonalized: true,
    };
  });

  return personalized.length >= 2 ? personalized : defaultFallback;
}
