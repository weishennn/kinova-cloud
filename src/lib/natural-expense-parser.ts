import { getLocalDateString, getRelativeDateString, getDaysInMonth } from './date-helper.ts';
import { evaluateMoneyExpression } from './money-calculator-helper.ts';
import { matchMerchantCategoryRule } from './merchant-rules.ts';
import { matchHabitMemory, type HabitMatchVia } from './habit-memory-engine.ts';

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
    matchedVia?: HabitMatchVia;
    matchedToken?: string;
  };
}

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  'Food & Dining': [
    'lunch', 'dinner', 'breakfast', 'brunch', 'supper', 'mamak', 'mcd', 'mcdonald', 'kfc',
    'starbucks', 'coffee', 'cafe', 'teh', 'kopi', 'roti', 'nasi', 'mee', 'rice', 'noodle',
    'burger', 'pizza', 'sushi', 'ramen', 'boba', 'tea', 'bakery', 'bread', 'food', 'makan',
    'restaurant', 'grabfood', 'foodpanda', 'shopeefood', 'subway', 'mixue', 'chagee',
    'village park', 'oriental kopi', 'tea garden', 'groceries', 'grocery', 'supermarket',
    'market', 'pasar', 'jaya grocer', 'village grocer', 'lotus', 'giant', 'aeon', 'econsave',
    'mydin', 'nsk', 'zapfan', 'chap fan', '买菜', '超市', '早餐', '午餐', '晚餐', '宵夜', '杂饭', '咖啡', '奶茶'
  ],
  'Transport': [
    'petrol', 'fuel', 'gas', 'shell', 'petronas', 'caltex', 'bhp', 'petron', 'grab', 'grabcar', 'ride',
    'taxi', 'toll', 'plus', 'tng', 'touch n go', 'rfid', 'parking', 'train', 'lrt', 'mrt',
    'monorail', 'ktm', 'bus', 'flight', 'airasia', 'malaysia airlines', 'car wash', 'car service',
    '打车', '汽油', '添油', '停车', '泊车', '过路费'
  ],
  'Shopping': [
    'shopee', 'lazada', 'taobao', 'amazon', 'uniqlo', 'zara', 'h&m', 'clothes', 'shoes',
    'bag', 'shopping', 'buy', 'mall', 'mid valley', 'pavilion', 'sunway', 'ikea', 'decathlon',
    'gadget', 'phone', 'laptop', 'ipad', 'electronics', '购物', '淘宝', '买衣服'
  ],
  'Housing & Bills': [
    'unifi', 'time internet', 'maxis', 'celcom', 'digi', 'umobile', 'wifi', 'internet',
    'electric', 'electricity', 'tnb', 'water', 'air selangor', 'sada', 'rent', 'rental',
    'maintenance', 'cukai', 'indah water', 'bill', 'utilities', 'management fee', 'aircond service',
    '水电', '电费', '水费', '网费', '房租', '话费'
  ],
  'Parents': [
    'parent', 'parents', 'mom', 'mother', 'dad', 'father', 'mama', 'papa', 'family allowance', 'allowance',
    '父母', '家用', '给妈妈', '给爸爸'
  ],
  'Insurance': [
    'insurance', 'takaful', 'prudential', 'prulife', 'great eastern', 'aia', 'allianz', 'zurich',
    'etiqa', 'manulife', 'medical card', 'life insurance', '保险', '保费', '医药卡'
  ],
  'Health': [
    'clinic', 'doctor', 'hospital', 'pharmacy', 'medicine', 'panadol', 'watsons', 'guardian',
    'caring', 'dentist', 'dental', 'teeth', 'optical', 'glasses', 'supplement', 'vitamin',
    '看病', '诊所', '买药', '洗牙', '牙医'
  ],
  'Entertainment': [
    'movie', 'cinema', 'tgv', 'gsc', 'netflix', 'spotify', 'youtube', 'disney', 'game',
    'steam', 'playstation', 'nintendo', 'concert', 'ticket', 'karaoke', 'ktv', '电影', '娱乐', '唱k'
  ],
  'Education': [
    'course', 'tuition', 'class', 'book', 'books', 'exam', 'udemy', 'coursera', 'school', 'university',
    '学费', '课程', '买书', '补习'
  ],
  'Sport': [
    'badminton', 'gym', 'fitness', 'workout', 'running', 'sport', 'sports', 'court',
    'shuttlecock', 'racket', 'yonex', 'anytime fitness', 'celebrity fitness', 'pickleball',
    'swimming', 'swim', 'yoga', 'pilates', 'football', 'futsal', 'tennis', '羽毛球', '健身', '运动', '跑步'
  ],
  'Gift': [
    'gift', 'present', 'presents', 'birthday gift', 'anniversary gift', 'souvenir',
    'angpow', 'angpao', 'red packet', 'duit raya', '礼物', '送礼', '红包', '礼金', '手信', '生日礼物'
  ],
  'Salary': [
    'salary', 'gaji', 'paycheck', 'payroll', '薪水', '工资', '出粮'
  ],
  'Investment Return': [
    'dividend', 'interest', 'asnb dividend', 'profit', 'capital gain', 'crypto profit', '股息', '分红'
  ],
  'Freelance': [
    'freelance', 'client', 'project', 'consulting', 'gig', '兼职', '外包'
  ],
  'Gift & Bonus': [
    'bonus', 'reward', 'cashback', '花红', '奖金'
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

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Matches a keyword against lowercased input text using word boundaries for ASCII keywords
 * so short keywords like "bus", "tea", "gas", "buy" never match inside unrelated words
 * like "business", "teacher", "gastric", or "buyer".
 */
function matchesKeywordWithBoundary(textLower: string, keyword: string): boolean {
  const kw = keyword.toLowerCase().trim();
  if (!kw) return false;
  if (/[\u4e00-\u9fa5]/.test(kw)) {
    return textLower.includes(kw);
  }
  const regex = new RegExp(`(?:^|[^a-z0-9])${escapeRegex(kw)}(?:$|[^a-z0-9])`, 'i');
  return regex.test(textLower);
}

function extractDateFromNaturalText(text: string, todayStr: string): { date: string; matchText: string } {
  const currentYear = parseInt(todayStr.slice(0, 4), 10);

  const relMatch = text.match(/\b(yesterday|semalam)\b|(昨天|昨日)/i);
  if (relMatch) {
    return { date: getRelativeDateString(-1), matchText: relMatch[0] };
  }

  const beforeYesterdayMatch = text.match(/(前天|kelmarin)/i);
  if (beforeYesterdayMatch) {
    return { date: getRelativeDateString(-2), matchText: beforeYesterdayMatch[0] };
  }

  const todayMatch = text.match(/\b(today|hari ini)\b|(今天|今日)/i);
  if (todayMatch) {
    return { date: todayStr, matchText: todayMatch[0] };
  }

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

  const slashMatch = text.match(/\b(\d{1,2})[\/](\d{1,2})(?:[\/](\d{4}))?\b/);
  if (slashMatch) {
    const first = parseInt(slashMatch[1], 10);
    const second = parseInt(slashMatch[2], 10);
    const y = slashMatch[3] ? parseInt(slashMatch[3], 10) : currentYear;

    let m = 0;
    let d = 0;
    if (first <= 12 && second > 12) {
      m = first;
      d = second;
    } else if (second <= 12 && first > 12) {
      d = first;
      m = second;
    } else if (second <= 12 && first <= 12) {
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

function hasUnparsedTemporalContext(text: string, matchedDateText: string): boolean {
  const unparsedText = matchedDateText ? text.replace(matchedDateText, ' ') : text;
  return UNPARSED_TEMPORAL_CONTEXT_PATTERNS.some((pattern) => pattern.test(unparsedText));
}

const UNPARSED_CALCULATION_PATTERNS = [
  /\b(?:percent|percentage|peratus|tax|taxes|sst|gst|service\s*charge|service\s*tax|cukai|svc|vat|discount|diskaun|rebate|voucher|kupon|税|折扣|服务费)\b/i,
  /\b(?:each|per\s*(?:item|piece|person|pax|one|head|plate|bowl)|split\s*(?:by|between)|divided\s*by|分摊|平摊|均摊|每份|每个|每个人|per\s*orang)\b/i,
];

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

  // 1. Detect and protect date expression
  const { date: targetDate, matchText: dateMatchText } = extractDateFromNaturalText(text, todayStr);
  const hasUnresolvedTemporalContext = hasUnparsedTemporalContext(text, dateMatchText);
  let textForAmount = dateMatchText ? text.replace(dateMatchText, ' ') : text;

  // 1b. Detect installment & explicit interest rate
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

  const naturalTaxRegex = /(?:(?:RM|MYR|USD|\$|SGD|S\$|CNY|RMB|¥|EUR|€|GBP|£)\s*)?(\d+(?:,\d{3})*(?:\.\d+)?)\s*(?:\+|plus|with|witrh|w\/|and|&|加|含|dengan)\s*(\d+(?:\.\d+)?)\s*%\s*(?:tax|taxes|sst|gst|service\s*tax|service\s*charge|svc|cukai|税)?(?!\s*(?:discount|off|diskaun|rebate|less|折))(?:\s*(?:RM|MYR|USD|SGD|CNY|RMB|EUR|GBP))?/i;
  const naturalDiscountRegex = /(?:(?:RM|MYR|USD|\$|SGD|S\$|CNY|RMB|¥|EUR|€|GBP|£)\s*)?(\d+(?:,\d{3})*(?:\.\d+)?)\s*(?:-|less|minus|with|witrh|w\/)?\s*(\d+(?:\.\d+)?)\s*%\s*(?:discount|off|diskaun|rebate|折)(?:\s*(?:RM|MYR|USD|SGD|CNY|RMB|EUR|GBP))?/i;
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

  // 4. Category & Type Detection (with word-boundary safety)
  let detectedCategory = 'Food & Dining';
  let detectedType: 'Expense' | 'Income' = 'Expense';
  let highestScore = 0;
  let habitMatchMeta: {
    rawPattern: string;
    alias: string;
    confidence: number;
    isAlias: boolean;
    matchedVia?: HabitMatchVia;
    matchedToken?: string;
  } | undefined;

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
      matchedVia: habitMatch.matchedVia,
      matchedToken: habitMatch.matchedToken,
    };
  } else {
    const userRule = matchMerchantCategoryRule(text);
    if (userRule) {
      detectedCategory = userRule.category;
      detectedType = INCOME_CATEGORIES.includes(userRule.category) ? 'Income' : 'Expense';
      highestScore = 999;
    } else {
      for (const [catName, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
        for (const kw of keywords) {
          if (matchesKeywordWithBoundary(lower, kw)) {
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

  if (highestScore === 0) {
    if (matchesKeywordWithBoundary(lower, 'income') || matchesKeywordWithBoundary(lower, 'masuk') || matchesKeywordWithBoundary(lower, 'claim')) {
      detectedType = 'Income';
      detectedCategory = 'Claim Allowance';
    } else {
      detectedCategory = 'Other';
    }
  }

  // 5. Clean Description
  let cleanedDesc = text.replace(matchedToken, ' ');
  if (dateMatchText) {
    cleanedDesc = cleanedDesc.replace(dateMatchText, ' ');
  }
  if (isInstallment && interestMatchText) {
    cleanedDesc = cleanedDesc.replace(interestMatchText, ' ');
  }
  cleanedDesc = cleanedDesc
    .replace(/\b(yesterday|today|semalam)\b|(昨天|昨日|前天|今天|今日)/gi, '')
    .replace(/\b(installment|epp|\d+\s*(?:months|m|bln))\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (
    habitMatchMeta &&
    (habitMatchMeta.isAlias ||
      habitMatchMeta.matchedVia === 'keyword' ||
      habitMatchMeta.matchedVia === 'compact' ||
      habitMatchMeta.matchedVia === 'stem')
  ) {
    cleanedDesc = habitMatchMeta.alias;
  } else if (!cleanedDesc || cleanedDesc.length < 2) {
    cleanedDesc = detectedCategory;
  } else {
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
