import { getLocalDateString, getRelativeDateString, getDaysInMonth } from './date-helper.ts';
import { evaluateMoneyExpression } from './money-calculator-helper.ts';
import { matchMerchantCategoryRule } from './merchant-rules.ts';
import { matchHabitMemory, type HabitMemoryMatch } from './habit-memory-engine.ts';

export interface ParsedExpense {
  amount: number;
  currency: string;
  category: string;
  type: 'Expense' | 'Income';
  description: string;
  date: string; // YYYY-MM-DD
  /** True when the input contains relative date language this parser did not resolve. */
  hasUnparsedTemporalContext: boolean;
  hasUnparsedCalculationContext?: boolean;
  isInstallment?: boolean;
  installmentMonths?: number;
  interestRate?: number;
  subtotal?: number;
  taxAmount?: number;
  taxRate?: number;
  taxLabel?: string;
  discountAmount?: number;
  formula?: string;
  habitMatch?: {
    rawPattern: string;
    alias: string;
    confidence: number;
    isAlias: boolean;
  };
}

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  'Food & Dining': [
    'lunch', 'dinner', 'breakfast', 'brunch', 'supper', 'mamak', 'mcd', 'mcdonald', 'kfc',
    'starbucks', 'coffee', 'cafe', 'teh', 'kopi', 'roti', 'nasi', 'mee', 'rice', 'noodle',
    'burger', 'pizza', 'sushi', 'ramen', 'boba', 'tea', 'bakery', 'bread', 'food', 'makan',
    'restaurant', 'cafe', 'grabfood', 'foodpanda', 'shopeefood', 'subway', 'mixue', 'chagee',
    'village park', 'oriental kopi', 'tea garden', 'groceries', 'grocery', 'supermarket',
    'market', 'pasar', 'jaya grocer', 'village grocer', 'lotus', 'giant', 'aeon', 'econsave',
    'mydin', 'nsk', '买菜', '超市'
  ],
  'Transport': [
    'petrol', 'fuel', 'gas', 'shell', 'petronas', 'caltex', 'bhp', 'petron', 'grab', 'ride',
    'taxi', 'toll', 'plus', 'tng', 'touch n go', 'rfid', 'parking', 'train', 'lrt', 'mrt',
    'monorail', 'ktm', 'bus', 'flight', 'airasia', 'malaysia airlines', 'car wash', 'service'
  ],
  'Shopping': [
    'shopee', 'lazada', 'taobao', 'amazon', 'uniqlo', 'zara', 'h&m', 'clothes', 'shoes',
    'bag', 'shopping', 'buy', 'mall', 'mid valley', 'pavilion', 'sunway', 'ikea', 'decathlon',
    'gadget', 'phone', 'laptop', 'ipad', 'electronics', 'books'
  ],
  'Housing & Bills': [
    'unifi', 'time internet', 'maxis', 'celcom', 'digi', 'umobile', 'wifi', 'internet',
    'electric', 'electricity', 'tnb', 'water', 'air selangor', 'sada', 'rent', 'rental',
    'maintenance', 'cukai', 'indah water', 'bill', 'utilities', 'management fee'
  ],
  'Parents': [
    'parent', 'parents', 'mom', 'mother', 'dad', 'father', 'mama', 'papa', 'family allowance', 'allowance'
  ],
  'Insurance': [
    'insurance', 'takaful', 'prudential', 'prulife', 'great eastern', 'aia', 'allianz', 'zurich',
    'etiqa', 'manulife', 'medical card', 'life insurance'
  ],
  'Health': [
    'clinic', 'doctor', 'hospital', 'pharmacy', 'medicine', 'panadol', 'watsons', 'guardian',
    'caring', 'dentist', 'dental', 'teeth', 'optical', 'glasses', 'supplement', 'vitamin'
  ],
  'Entertainment': [
    'movie', 'cinema', 'tgv', 'gsc', 'netflix', 'spotify', 'youtube', 'disney', 'game',
    'steam', 'playstation', 'nintendo', 'concert', 'ticket', 'karaoke', 'ktv'
  ],
  'Education': [
    'course', 'tuition', 'class', 'book', 'exam', 'udemy', 'coursera', 'school', 'university'
  ],
  'Sport': [
    'badminton', 'gym', 'fitness', 'workout', 'running', 'sport', 'sports', 'court',
    'shuttlecock', 'racket', 'yonex', 'decathlon', 'anytime fitness', 'celebrity fitness',
    'swimming', 'swim', 'yoga', 'pilates', 'football', 'futsal', 'tennis', '羽毛球', '健身', '运动', '跑步'
  ],
  'Gift': [
    'gift', 'present', 'presents', 'birthday gift', 'anniversary gift', 'souvenir',
    'angpow', 'angpao', 'red packet', 'duit raya', '礼物', '送礼', '红包', '礼金', '手信', '生日礼物'
  ],
  'Salary': [
    'salary', 'gaji', 'paycheck', 'payroll'
  ],
  'Investment Return': [
    'dividend', 'interest', 'asnb dividend', 'profit', 'capital gain', 'crypto profit'
  ],
  'Freelance': [
    'freelance', 'client', 'project', 'consulting', 'gig'
  ],
  'Gift & Bonus': [
    'bonus', 'angpow', 'angpao', 'gift', 'reward', 'cashback'
  ],
};

const INCOME_CATEGORIES = ['Salary', 'Claim Allowance', 'Freelance', 'Investment Return', 'Gift & Bonus'];

const MONTH_MAP: Record<string, number> = {
  jan: 1, january: 1, januari: 1,
  feb: 2, february: 2, februari: 2,
  mar: 3, march: 3, mac: 3,
  apr: 4, april: 4,
  may: 5, mei: 5,
  jun: 6, june: 6,
  jul: 7, july: 7, julai: 7,
  aug: 8, august: 8, ogos: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, oktober: 10,
  nov: 11, november: 11,
  dec: 12, december: 12, disember: 12,
};

const MONTH_NAMES_PATTERN = Object.keys(MONTH_MAP).sort((a, b) => b.length - a.length).join('|');

function extractDateFromNaturalText(text: string, todayStr: string): { date: string; matchText: string } {
  const currentYear = parseInt(todayStr.slice(0, 4), 10);

  // 1. Relative keywords
  const relMatch = text.match(/\b(yesterday|semalam)\b/i);
  if (relMatch) {
    return { date: getRelativeDateString(-1), matchText: relMatch[0] };
  }

  const todayMatch = text.match(/\b(today|hari ini)\b/i);
  if (todayMatch) {
    return { date: todayStr, matchText: todayMatch[0] };
  }

  // 2. Month Name + Day: e.g. 'october 12', 'oct 12th', 'october 12 2026'
  const monthDayRegex = new RegExp(
    `(?:\\bon\\s+)?\\b(${MONTH_NAMES_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*,?\\s*(\\d{4}))?\\b`,
    'i'
  );
  const m1 = text.match(monthDayRegex);
  if (m1) {
    const month = MONTH_MAP[m1[1].toLowerCase()];
    const day = parseInt(m1[2], 10);
    const year = m1[3] ? parseInt(m1[3], 10) : currentYear;
    if (month && day >= 1) {
      const maxDays = getDaysInMonth(year, month);
      const safeDay = Math.min(day, maxDays);
      const formatted = `${year}-${String(month).padStart(2, '0')}-${String(safeDay).padStart(2, '0')}`;
      return { date: formatted, matchText: m1[0] };
    }
  }

  // 3. Day + Month Name: e.g. '12 october', '12th oct', '12th of oct 2026'
  const dayMonthRegex = new RegExp(
    `(?:\\bon\\s+)?\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_NAMES_PATTERN})(?:\\s*,?\\s*(\\d{4}))?\\b`,
    'i'
  );
  const m2 = text.match(dayMonthRegex);
  if (m2) {
    const day = parseInt(m2[1], 10);
    const month = MONTH_MAP[m2[2].toLowerCase()];
    const year = m2[3] ? parseInt(m2[3], 10) : currentYear;
    if (month && day >= 1) {
      const maxDays = getDaysInMonth(year, month);
      const safeDay = Math.min(day, maxDays);
      const formatted = `${year}-${String(month).padStart(2, '0')}-${String(safeDay).padStart(2, '0')}`;
      return { date: formatted, matchText: m2[0] };
    }
  }

  // 4. ISO format YYYY-MM-DD
  const isoMatch = text.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (isoMatch) {
    const y = parseInt(isoMatch[1], 10);
    const m = parseInt(isoMatch[2], 10);
    const d = parseInt(isoMatch[3], 10);
    if (m >= 1 && m <= 12 && d >= 1) {
      const maxDays = getDaysInMonth(y, m);
      const safeDay = Math.min(d, maxDays);
      return { date: `${y}-${String(m).padStart(2, '0')}-${String(safeDay).padStart(2, '0')}`, matchText: isoMatch[0] };
    }
  }

  // 5. Slash format DD/MM, MM/DD or with year (e.g. 9/31 -> Sept 30, 31/9 -> Sept 30)
  const slashMatch = text.match(/\b(\d{1,2})[\/](\d{1,2})(?:[\/](\d{4}))?\b/);
  if (slashMatch) {
    const first = parseInt(slashMatch[1], 10);
    const second = parseInt(slashMatch[2], 10);
    const y = slashMatch[3] ? parseInt(slashMatch[3], 10) : currentYear;

    let m = 0;
    let d = 0;
    if (first <= 12 && second > 12) {
      // MM/DD format: e.g. 9/31
      m = first;
      d = second;
    } else if (second <= 12 && first > 12) {
      // DD/MM format: e.g. 31/9
      d = first;
      m = second;
    } else if (second <= 12 && first <= 12) {
      // Default to DD/MM
      d = first;
      m = second;
    }

    if (m >= 1 && m <= 12 && d >= 1) {
      const maxDays = getDaysInMonth(y, m);
      const safeDay = Math.min(d, maxDays);
      return { date: `${y}-${String(m).padStart(2, '0')}-${String(safeDay).padStart(2, '0')}`, matchText: slashMatch[0] };
    }
  }

  return { date: todayStr, matchText: '' };
}

const RELATIVE_TIME_UNITS = '(?:days?|weeks?|fortnights?|months?|quarters?|years?)';
const NUMBER_WORDS = '(?:\\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|few|several)';
const UNPARSED_TEMPORAL_CONTEXT_PATTERNS = [
  new RegExp(
    `\\b(?:(?:last|previous|prior|this|current|next|coming|upcoming|past|recent|within)\\s+(?:(?:the|last|past)\\s+)?(?:${NUMBER_WORDS}\\s+)?${RELATIVE_TIME_UNITS}|(?:for|during|over|in|since|from)\\s+(?:(?:the|last|past)\\s+)?(?:${NUMBER_WORDS}\\s+)?${RELATIVE_TIME_UNITS})\\b`,
    'i'
  ),
  new RegExp(`\\b${NUMBER_WORDS}\\s+${RELATIVE_TIME_UNITS}\\s+(?:ago|earlier|later|from now)\\b`, 'i'),
  /\b(?:tomorrow|esok)\b/i,
  /\b(?:last|this|next|coming|upcoming)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /\b(?:hari|minggu|bulan|tahun)\s+(?:lepas|lalu|ini|depan|akan datang)\b/i,
  /\b(?:lepas|lalu|depan|akan datang)\s+(?:(?:\d+|satu|dua|tiga|empat|lima)\s+)?(?:hari|minggu|bulan|tahun)\b/i,
  /(?:上|这|本|下|过去|最近|未来)\s*(?:个|一)?\s*(?:天|周|星期|月|季度|年)/u,
  /(?:\d+|[零一二三四五六七八九十百]+)\s*(?:天|周|星期|个?月|季度|年)\s*(?:前|后)/u,
];

/**
 * The quick parser only understands specific dates and single-day relatives such as
 * "today" and "yesterday". Catch broader date ranges and relative dates that still
 * need interpretation so the assistant can resolve them instead of defaulting to today.
 */
function hasUnparsedTemporalContext(text: string, matchedDateText: string): boolean {
  const unparsedText = matchedDateText ? text.replace(matchedDateText, ' ') : text;
  return UNPARSED_TEMPORAL_CONTEXT_PATTERNS.some((pattern) => pattern.test(unparsedText));
}

/**
 * Parses natural language input string into structured expense data.
 * Examples:
 * - "Mamak lunch RM 18" -> Amount: 18, Category: Food & Dining, Description: Mamak lunch
 * - "Mamak lunch RM12 october 12" -> Amount: 12, Date: 2026-10-12, Description: Mamak lunch
 * - "Shell petrol 60" -> Amount: 60, Category: Transport, Description: Shell petrol
 * - "Salary 6500" -> Amount: 6500, Category: Salary, Type: Income
 * - "Macbook 3600 12m" -> Amount: 3600, Category: Shopping, isInstallment: true, installmentMonths: 12
 */
const UNPARSED_CALCULATION_PATTERNS = [
  /\b(?:percent|percentage|peratus|tax|taxes|sst|gst|service\s*charge|service\s*tax|cukai|svc|vat|discount|diskaun|rebate|voucher|kupon|税|折扣|服务费)\b/i,
  /\b(?:each|per\s*(?:item|piece|person|pax|one|head|plate|bowl)|split\s*(?:by|between)|divided\s*by|分摊|平摊|均摊|每份|每个|每个人|per\s*orang)\b/i,
];

/**
 * Returns true when the input contains calculation, tax, discount, or quantity phrases
 * that were not fully evaluated into a resolved formula/amount by the local parser.
 * This signals to the intent router to delegate to Gemini Assistant rather than
 * pretending to know the final amount with a naive single-number regex match.
 */
function hasUnparsedCalculationContext(
  text: string,
  hasResolvedFormula: boolean,
  hasResolvedTax: boolean,
  hasResolvedDiscount: boolean
): boolean {
  if (hasResolvedFormula || hasResolvedTax || hasResolvedDiscount) return false;
  return UNPARSED_CALCULATION_PATTERNS.some((pattern) => pattern.test(text));
}
export function parseNaturalExpense(input: string): ParsedExpense | null {
  const text = input.trim();
  if (!text) return null;

  const todayStr = getLocalDateString();

  // 1. Detect and protect date expression so its numbers are not confused with expense amount
  const { date: targetDate, matchText: dateMatchText } = extractDateFromNaturalText(text, todayStr);
  const hasUnresolvedTemporalContext = hasUnparsedTemporalContext(text, dateMatchText);
  let textForAmount = dateMatchText ? text.replace(dateMatchText, ' ') : text;

  // 1b. Detect installment & explicit interest rate (e.g. "2.12% interest", "interest 2.12%", "2.12% p.a.")
  // Protect interest rate tokens so they are not mistaken for the principal amount
  let isInstallment = false;
  let installmentMonths = 12;
  const lower = text.toLowerCase();
  const instMatch = lower.match(/(?:installment|epp|\b(\d+)\s*(?:months|m|bln)\b)/i);
  if (instMatch) {
    isInstallment = true;
    if (instMatch[1]) {
      const parsedM = parseInt(instMatch[1], 10);
      if (parsedM > 1 && parsedM <= 120) installmentMonths = parsedM;
    }
  }

  let detectedInterestRate: number | undefined;
  let interestMatchText = '';
  const explicitInterestMatch =
    textForAmount.match(/(\d+(?:\.\d+)?)\s*%\s*(?:p\.?a\.?\s*)?(?:interest|int|rate)\b/i) ||
    textForAmount.match(/\b(?:interest|int|rate)\s*(?:of\s*|at\s*)?(\d+(?:\.\d+)?)\s*%?/i) ||
    (isInstallment ? textForAmount.match(/(?<![+\-*/×÷]\s*)(\d+(?:\.\d+)?)\s*%\s*(?:p\.?a\.?)?/i) : null);

  if (explicitInterestMatch && explicitInterestMatch[1]) {
    const rateVal = parseFloat(explicitInterestMatch[1]);
    if (Number.isFinite(rateVal) && rateVal >= 0 && rateVal <= 100) {
      detectedInterestRate = rateVal;
      interestMatchText = explicitInterestMatch[0];
      textForAmount = textForAmount.replace(interestMatchText, ' ');
    }
  }

  // 2. Amount & Currency Detection
  // Matches: RM 18, RM18.50, $25, 25 USD, 25.50, 18rm, etc.
  const currencyMatch = text.match(/(?:RM|MYR|USD|\$|SGD|S\$|CNY|RMB|¥|EUR|€|GBP|£)/i);
  let detectedCurrency = 'MYR';
  if (currencyMatch) {
    const rawCurr = currencyMatch[0].toUpperCase();
    if (rawCurr === '$' || rawCurr === 'USD') detectedCurrency = 'USD';
    else if (rawCurr === 'S$' || rawCurr === 'SGD') detectedCurrency = 'SGD';
    else if (rawCurr === '¥' || rawCurr === 'CNY' || rawCurr === 'RMB') detectedCurrency = 'CNY';
    else if (rawCurr === '€' || rawCurr === 'EUR') detectedCurrency = 'EUR';
    else if (rawCurr === '£' || rawCurr === 'GBP') detectedCurrency = 'GBP';
  }

  // Natural tax/service phrase: e.g. "14 with 6% tax", "14 witrh 6% tax", "14 + 6% sst", "14 plus 6% tax", "14含6%税", "14 with 10% service charge"
  const naturalTaxRegex = /(?:(?:RM|MYR|USD|\$|SGD|S\$|CNY|RMB|¥|EUR|€|GBP|£)\s*)?(\d+(?:,\d{3})*(?:\.\d+)?)\s*(?:\+|plus|with|witrh|w\/|and|&|加|含|dengan)\s*(\d+(?:\.\d+)?)\s*%\s*(?:tax|taxes|sst|gst|service\s*tax|service\s*charge|svc|cukai|税)?(?!\s*(?:discount|off|diskaun|rebate|less|折))(?:\s*(?:RM|MYR|USD|SGD|CNY|RMB|EUR|GBP))?/i;

  // Natural discount phrase: e.g. "100 with 10% discount", "200 20% off", "50 - 10% rebate"
  const naturalDiscountRegex = /(?:(?:RM|MYR|USD|\$|SGD|S\$|CNY|RMB|¥|EUR|€|GBP|£)\s*)?(\d+(?:,\d{3})*(?:\.\d+)?)\s*(?:-|less|minus|with|witrh|w\/)?\s*(\d+(?:\.\d+)?)\s*%\s*(?:discount|off|diskaun|rebate|折)(?:\s*(?:RM|MYR|USD|SGD|CNY|RMB|EUR|GBP))?/i;

  // Find math expression (e.g. "15 + 8.50", "50 + 6%", "120 / 3", "100 - 15 + 6%")
  const mathExprRegex = /(?:(?:RM|MYR|USD|\$|SGD|S\$|CNY|RMB|¥|EUR|€|GBP|£)\s*)?(\d+(?:,\d{3})*(?:\.\d+)?(?:\s*[+\-*/×÷]\s*\d+(?:,\d{3})*(?:\.\d+)?%?)+)(?:\s*(?:RM|MYR|USD|SGD|CNY|RMB|EUR|GBP))?/i;
  const amountRegex = /(?:(?:RM|MYR|USD|\$|SGD|S\$|CNY|RMB|¥|EUR|€|GBP|£)\s*)?(\d+(?:,\d{3})*(?:\.\d{1,2})?)(?!\s*%)(?:\s*(?:RM|MYR|USD|SGD|CNY|RMB|EUR|GBP))?/i;

  const taxMatch = textForAmount.match(naturalTaxRegex);
  const discMatch = textForAmount.match(naturalDiscountRegex);
  const mathMatch = textForAmount.match(mathExprRegex);
  const singleMatch = textForAmount.match(amountRegex) || text.match(amountRegex);

  let matchedToken = '';
  let parsedAmount = NaN;
  let detectedFormula: string | undefined;
  let detectedSubtotal: number | undefined;
  let detectedTaxAmount: number | undefined;
  let detectedTaxRate: number | undefined;
  let detectedTaxLabel: string | undefined;
  let detectedDiscountAmount: number | undefined;

  // Prefer multi-operator math expressions if longer than tax/discount match
  const chooseMath = Boolean(
    mathMatch &&
    mathMatch[1] &&
    (!taxMatch || mathMatch[0].length > taxMatch[0].length) &&
    (!discMatch || mathMatch[0].length > discMatch[0].length)
  );

  if (chooseMath && mathMatch && mathMatch[1]) {
    const evalRes = evaluateMoneyExpression(mathMatch[1]);
    if (evalRes.value !== null && evalRes.value > 0) {
      matchedToken = mathMatch[0];
      parsedAmount = evalRes.value;
      detectedFormula = mathMatch[1].trim();
    }
  } else if (discMatch && discMatch[1] && discMatch[2]) {
    const baseVal = parseFloat(discMatch[1].replace(/,/g, ''));
    const rateVal = parseFloat(discMatch[2]);
    if (Number.isFinite(baseVal) && baseVal > 0 && Number.isFinite(rateVal) && rateVal > 0 && rateVal <= 100) {
      const discAmt = Number(((baseVal * rateVal) / 100).toFixed(2));
      parsedAmount = Number((baseVal - discAmt).toFixed(2));
      matchedToken = discMatch[0];
      detectedSubtotal = baseVal;
      detectedDiscountAmount = discAmt;
      detectedFormula = `${baseVal} - ${rateVal}% = ${parsedAmount.toFixed(2)}`;
    }
  } else if (taxMatch && taxMatch[1] && taxMatch[2]) {
    const baseVal = parseFloat(taxMatch[1].replace(/,/g, ''));
    const rateVal = parseFloat(taxMatch[2]);
    if (Number.isFinite(baseVal) && baseVal > 0 && Number.isFinite(rateVal) && rateVal > 0 && rateVal <= 100) {
      const taxAmt = Number(((baseVal * rateVal) / 100).toFixed(2));
      parsedAmount = Number((baseVal + taxAmt).toFixed(2));
      matchedToken = taxMatch[0];
      detectedSubtotal = baseVal;
      detectedTaxRate = rateVal;
      detectedTaxAmount = taxAmt;
      const lowerToken = taxMatch[0].toLowerCase();
      const isSst = lowerToken.includes('sst') || lowerToken.includes('service') || lowerToken.includes('svc');
      detectedTaxLabel = isSst ? `SST (${rateVal}%)` : `Tax (${rateVal}%)`;
      detectedFormula = `${baseVal} + ${rateVal}% = ${parsedAmount.toFixed(2)}`;
    }
  } else if (mathMatch && mathMatch[1]) {
    const evalRes = evaluateMoneyExpression(mathMatch[1]);
    if (evalRes.value !== null && evalRes.value > 0) {
      matchedToken = mathMatch[0];
      parsedAmount = evalRes.value;
      detectedFormula = mathMatch[1].trim();
    }
  }

  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    if (!singleMatch || !singleMatch[1]) return null;
    matchedToken = singleMatch[0];
    const rawAmountStr = singleMatch[1].replace(/,/g, '');
    parsedAmount = parseFloat(rawAmountStr);
  }

  if (isNaN(parsedAmount) || parsedAmount <= 0) return null;

  // 4. Category & Type Detection
  let detectedCategory = 'Food & Dining'; // sensible default
  let detectedType: 'Expense' | 'Income' = 'Expense';
  let highestScore = 0;
  let habitMatchMeta: { rawPattern: string; alias: string; confidence: number; isAlias: boolean } | undefined;

  // 1. Proactive Habit Memory takes top precedence (learns aliases like abc -> zapfan)
  const habitMatch = matchHabitMemory(text);
  if (habitMatch) {
    detectedCategory = habitMatch.resolvedCategory;
    detectedType = INCOME_CATEGORIES.includes(habitMatch.resolvedCategory) ? 'Income' : 'Expense';
    highestScore = 1000;
    habitMatchMeta = {
      rawPattern: habitMatch.matchedPattern,
      alias: habitMatch.resolvedDescription,
      confidence: habitMatch.matchedItem.confidence,
      isAlias: habitMatch.isAlias,
    };
  } else {
    // 2. User-remembered merchant rules take next precedence
    const userRule = matchMerchantCategoryRule(text);
    if (userRule) {
      detectedCategory = userRule.category;
      detectedType = INCOME_CATEGORIES.includes(userRule.category) ? 'Income' : 'Expense';
      highestScore = 999;
    } else {
      for (const [catName, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
        for (const kw of keywords) {
          if (lower.includes(kw)) {
            // Longer keyword matches get higher priority (e.g. "grabfood" > "food")
            const score = kw.length;
            if (score > highestScore) {
              highestScore = score;
              detectedCategory = catName;
              detectedType = INCOME_CATEGORIES.includes(catName) ? 'Income' : 'Expense';
            }
          }
        }
      }
    }
  }

  // If no category matched but text has keywords like salary or income
  if (highestScore === 0) {
    if (lower.includes('income') || lower.includes('masuk') || lower.includes('claim')) {
      detectedType = 'Income';
      detectedCategory = 'Claim Allowance';
    } else {
      detectedCategory = 'Other';
    }
  }

  // 5. Clean Description
  // Remove the amount/expression, currency, and matched date text to leave the clean description
  let cleanedDesc = text
    .replace(matchedToken, ' ');
  if (dateMatchText) {
    cleanedDesc = cleanedDesc.replace(dateMatchText, ' ');
  }
  if (isInstallment && interestMatchText) {
    cleanedDesc = cleanedDesc.replace(interestMatchText, ' ');
  }
  cleanedDesc = cleanedDesc
    .replace(/\b(yesterday|today|semalam)\b/gi, '')
    .replace(/\b(installment|epp|\d+\s*(?:months|m|bln))\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  // If matched habit has a preferred alias (e.g. abc -> zapfan), use the alias
  if (habitMatchMeta && habitMatchMeta.isAlias) {
    cleanedDesc = habitMatchMeta.alias;
  } else if (!cleanedDesc || cleanedDesc.length < 2) {
    cleanedDesc = detectedCategory;
  } else {
    // Capitalize first letter
    cleanedDesc = cleanedDesc.charAt(0).toUpperCase() + cleanedDesc.slice(1);
  }

  return {
    amount: parsedAmount,
    currency: detectedCurrency,
    category: detectedCategory,
    type: detectedType,
    description: cleanedDesc,
    date: targetDate,
    hasUnparsedTemporalContext: hasUnresolvedTemporalContext,
    hasUnparsedCalculationContext: hasUnparsedCalculationContext(
      text,
      Boolean(detectedFormula),
      detectedTaxRate != null,
      detectedDiscountAmount != null
    ),
    isInstallment,
    installmentMonths,
    interestRate: detectedInterestRate,
    subtotal: detectedSubtotal,
    taxAmount: detectedTaxAmount,
    taxRate: detectedTaxRate,
    taxLabel: detectedTaxLabel,
    discountAmount: detectedDiscountAmount,
    formula: detectedFormula,
    habitMatch: habitMatchMeta,
  };
}
