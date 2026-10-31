/**
 * Canonical Categories and Strict Normalization Helper
 * Single source of truth for categories in CashFlow.
 * Prevents AI models (Gemini / OCR) from inventing non-existent categories.
 */

export const CANONICAL_EXPENSE_CATEGORIES = [
  'Food & Dining',
  'Transport',
  'Shopping',
  'Housing & Bills',
  'Parents',
  'Insurance',
  'Entertainment',
  'Health',
  'Education',
  'Sport',
  'Gift',
  'Other',
] as const;

export type CanonicalExpenseCategory = (typeof CANONICAL_EXPENSE_CATEGORIES)[number];

export const CANONICAL_INCOME_CATEGORIES = [
  'Salary',
  'Claim Allowance',
  'Freelance',
  'Investment Return',
  'Gift & Bonus',
  'Other',
] as const;

export type CanonicalIncomeCategory = (typeof CANONICAL_INCOME_CATEGORIES)[number];

export const CANONICAL_INVESTMENT_CATEGORIES = [
  'Fixed Deposit',
  'ASNB / Unit Trust',
  'EPF / KWSP',
  'Emergency Savings',
  'Other Savings',
  'Stocks & Crypto',
] as const;

export type CanonicalInvestmentCategory = (typeof CANONICAL_INVESTMENT_CATEGORIES)[number];

export const CANONICAL_TRIP_EXPENSE_CATEGORIES = [
  'Food & Dining',
  'Transport',
  'Stay & Hotel',
  'Flights',
  'Shopping',
  'Entertainment',
  'Health',
  'Insurance',
  'Education',
  'Sport',
  'Gift',
  'Other',
] as const;

/**
 * Common variations, synonyms, and subcategories mapped back to canonical categories.
 */
const EXPENSE_SYNONYMS: Record<string, CanonicalExpenseCategory> = {
  // Food & Dining
  food: 'Food & Dining',
  dining: 'Food & Dining',
  diningout: 'Food & Dining',
  eatingout: 'Food & Dining',
  fooddining: 'Food & Dining',
  foodanddining: 'Food & Dining',
  foodandbeverage: 'Food & Dining',
  foodandbeverages: 'Food & Dining',
  foodbeverage: 'Food & Dining',
  foodbeverages: 'Food & Dining',
  foodanddrink: 'Food & Dining',
  foodanddrinks: 'Food & Dining',
  fooddrink: 'Food & Dining',
  fooddrinks: 'Food & Dining',
  fb: 'Food & Dining',
  fandb: 'Food & Dining',
  fnb: 'Food & Dining',
  restaurant: 'Food & Dining',
  restaurants: 'Food & Dining',
  restoran: 'Food & Dining',
  cafe: 'Food & Dining',
  cafes: 'Food & Dining',
  eatery: 'Food & Dining',
  kopitiam: 'Food & Dining',
  foodcourt: 'Food & Dining',
  hawker: 'Food & Dining',
  hawkercentre: 'Food & Dining',
  canteen: 'Food & Dining',
  cafeteria: 'Food & Dining',
  bistro: 'Food & Dining',
  bakery: 'Food & Dining',
  catering: 'Food & Dining',
  dessert: 'Food & Dining',
  desserts: 'Food & Dining',
  fastfood: 'Food & Dining',
  seafood: 'Food & Dining',
  steamboat: 'Food & Dining',
  hotpot: 'Food & Dining',
  bbq: 'Food & Dining',
  barbecue: 'Food & Dining',
  groceries: 'Food & Dining',
  grocery: 'Food & Dining',
  grocer: 'Food & Dining',
  supermarket: 'Food & Dining',
  supermarkets: 'Food & Dining',
  market: 'Food & Dining',
  pasar: 'Food & Dining',
  meals: 'Food & Dining',
  meal: 'Food & Dining',
  lunch: 'Food & Dining',
  dinner: 'Food & Dining',
  breakfast: 'Food & Dining',
  beverage: 'Food & Dining',
  beverages: 'Food & Dining',
  drinks: 'Food & Dining',
  coffee: 'Food & Dining',
  snack: 'Food & Dining',
  snacks: 'Food & Dining',
  makan: 'Food & Dining',
  minum: 'Food & Dining',
  warung: 'Food & Dining',
  gerai: 'Food & Dining',
  kedaimakan: 'Food & Dining',
  kedaikopi: 'Food & Dining',

  // Transport
  transportation: 'Transport',
  travel: 'Transport',
  fuel: 'Transport',
  petrol: 'Transport',
  gas: 'Transport',
  parking: 'Transport',
  toll: 'Transport',
  grab: 'Transport',
  taxi: 'Transport',
  transit: 'Transport',
  train: 'Transport',
  mrt: 'Transport',
  lrt: 'Transport',
  car: 'Transport',
  vehicle: 'Transport',

  // Sport
  sport: 'Sport',
  sports: 'Sport',
  gym: 'Sport',
  fitness: 'Sport',
  workout: 'Sport',
  exercise: 'Sport',
  badminton: 'Sport',
  tennis: 'Sport',
  swimming: 'Sport',
  running: 'Sport',
  yoga: 'Sport',
  pilates: 'Sport',
  court: 'Sport',
  athletics: 'Sport',

  // Gift
  gift: 'Gift',
  gifts: 'Gift',
  present: 'Gift',
  presents: 'Gift',
  donation: 'Gift',
  donations: 'Gift',
  charity: 'Gift',
  souvenir: 'Gift',
  souvenirs: 'Gift',
  angpow: 'Gift',
  angpao: 'Gift',
  hongbao: 'Gift',
  redpacket: 'Gift',

  // Housing & Bills
  housing: 'Housing & Bills',
  bills: 'Housing & Bills',
  bill: 'Housing & Bills',
  utilities: 'Housing & Bills',
  utility: 'Housing & Bills',
  electricity: 'Housing & Bills',
  water: 'Housing & Bills',
  wifi: 'Housing & Bills',
  internet: 'Housing & Bills',
  rent: 'Housing & Bills',
  rental: 'Housing & Bills',
  maintenance: 'Housing & Bills',
  telecom: 'Housing & Bills',
  phone: 'Housing & Bills',

  // Shopping
  shopping: 'Shopping',
  retail: 'Shopping',
  clothing: 'Shopping',
  clothes: 'Shopping',
  apparel: 'Shopping',
  fashion: 'Shopping',
  shoes: 'Shopping',
  electronics: 'Shopping',
  gadgets: 'Shopping',
  technology: 'Shopping',
  personal: 'Shopping',
  beauty: 'Shopping',
  cosmetics: 'Shopping',

  // Health
  health: 'Health',
  medical: 'Health',
  healthcare: 'Health',
  doctor: 'Health',
  clinic: 'Health',
  hospital: 'Health',
  pharmacy: 'Health',
  medicine: 'Health',
  dental: 'Health',
  dentist: 'Health',
  optical: 'Health',
  wellness: 'Health',

  // Entertainment
  entertainment: 'Entertainment',
  leisure: 'Entertainment',
  movies: 'Entertainment',
  movie: 'Entertainment',
  cinema: 'Entertainment',
  games: 'Entertainment',
  gaming: 'Entertainment',
  subscription: 'Entertainment',
  subscriptions: 'Entertainment',
  streaming: 'Entertainment',
  netflix: 'Entertainment',
  spotify: 'Entertainment',
  hobbies: 'Entertainment',
  hobby: 'Entertainment',

  // Education
  education: 'Education',
  learning: 'Education',
  school: 'Education',
  university: 'Education',
  college: 'Education',
  tuition: 'Education',
  course: 'Education',
  courses: 'Education',
  books: 'Education',
  training: 'Education',

  // Insurance
  insurance: 'Insurance',
  takaful: 'Insurance',
  policy: 'Insurance',
  premium: 'Insurance',

  // Parents
  parents: 'Parents',
  family: 'Parents',
  parentsallowance: 'Parents',
  allowance: 'Parents',
};

const INCOME_SYNONYMS: Record<string, CanonicalIncomeCategory> = {
  salary: 'Salary',
  wage: 'Salary',
  wages: 'Salary',
  payroll: 'Salary',
  paycheck: 'Salary',
  claim: 'Claim Allowance',
  claims: 'Claim Allowance',
  allowance: 'Claim Allowance',
  reimbursement: 'Claim Allowance',
  freelance: 'Freelance',
  sidehustle: 'Freelance',
  consulting: 'Freelance',
  project: 'Freelance',
  dividend: 'Investment Return',
  dividends: 'Investment Return',
  interest: 'Investment Return',
  capitalgain: 'Investment Return',
  investment: 'Investment Return',
  bonus: 'Gift & Bonus',
  gift: 'Gift & Bonus',
  angpow: 'Gift & Bonus',
  hongbao: 'Gift & Bonus',
  redpacket: 'Gift & Bonus',
  award: 'Gift & Bonus',
};

/**
 * Normalizes any category string (from Gemini, OCR, or user input) into an exact
 * canonical category. If invalid, maps to the closest valid category or 'Other'.
 */
export function normalizeToCanonicalCategory(
  rawCategory: string | null | undefined,
  type: string = 'Expense',
  contextDescription?: string
): string {
  const normType = String(type || 'Expense').toLowerCase();

  // 1. Check Income
  if (normType === 'income') {
    if (!rawCategory) return 'Other';
    const clean = rawCategory.trim();
    const matched = CANONICAL_INCOME_CATEGORIES.find(
      (c) => c.toLowerCase() === clean.toLowerCase()
    );
    if (matched) return matched;

    const key = clean.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (INCOME_SYNONYMS[key]) return INCOME_SYNONYMS[key];

    const lower = clean.toLowerCase();
    if (/salary|gaji|payroll|paycheck/i.test(lower)) return 'Salary';
    if (/claim|reimbursement|allowance/i.test(lower)) return 'Claim Allowance';
    if (/freelance|gig|side|project|consulting/i.test(lower)) return 'Freelance';
    if (/dividend|interest|investment|crypto profit|capital gain/i.test(lower)) return 'Investment Return';
    if (/bonus|gift|angpow|hongbao|reward/i.test(lower)) return 'Gift & Bonus';
    return 'Other';
  }

  // 2. Check Investment
  if (normType === 'investment') {
    if (!rawCategory) return 'Emergency Savings';
    const clean = rawCategory.trim();
    const matched = CANONICAL_INVESTMENT_CATEGORIES.find(
      (c) => c.toLowerCase() === clean.toLowerCase()
    );
    if (matched) return matched;
    return 'Emergency Savings';
  }

  // 3. Check Expense (default)
  if (!rawCategory) {
    if (contextDescription) {
      return inferExpenseCategoryFromContext(contextDescription);
    }
    return 'Food & Dining';
  }

  const clean = rawCategory.trim();
  const matched = CANONICAL_EXPENSE_CATEGORIES.find(
    (c) => c.toLowerCase() === clean.toLowerCase()
  );
  if (matched) return matched;

  // Check synonym map
  const key = clean.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (EXPENSE_SYNONYMS[key]) {
    return EXPENSE_SYNONYMS[key];
  }

  // Check if rawCategory itself contains key patterns
  const directInferred = inferExpenseCategoryFromContext(clean);
  if (directInferred !== 'Other') {
    return directInferred;
  }

  // Fallback: check context description or fallback to 'Other'
  if (contextDescription) {
    const contextual = inferExpenseCategoryFromContext(contextDescription);
    if (contextual !== 'Other') return contextual;
  }

  return 'Other';
}

function inferExpenseCategoryFromContext(text: string): CanonicalExpenseCategory {
  const lower = text.toLowerCase();
  if (/\b(?:badminton|gym|fitness|workout|exercise|running|run|climbing|climb|court|swimming|swim|tennis|yoga|pilates|athletics|nike|adidas|decathlon)\b|运动|羽毛球|健身|跑步|球拍|瑜伽|球场/i.test(lower)) {
    return 'Sport';
  }
  if (/\b(?:gift|gifts|present|presents|birthday|souvenir|souvenirs|angpow|angpao|hongbao|red\s*packet|donation|donations|charity)\b|礼物|送礼|红包|礼金|手信|捐款/i.test(lower)) {
    return 'Gift';
  }
  if (/\b(?:shell|petronas|caltex|bhpetrol|petron|grab|parking|toll|fuel|petrol|ron95|ron97|diesel|fuelsave|stesen\s*minyak|transit|train|mrt|lrt|ktm|erl|bus|taxi|cab|uber|airline|airasia|flight|budi\s*madani|touch\s*n\s*go|tng|rapidkl)\b|交通|打车|加油|汽油|油费|停车|过路费|车费|地铁|公交|机票/i.test(lower)) {
    return 'Transport';
  }
  if (/\b(?:f\s*&?\s*and\s*b|f\s*&\s*b|fnb|fb|food|dining|restaurant|restoran|resto|kopitiam|food\s*court|hawker|canteen|cafeteria|bistro|cafe|coffee|kopi|tea|bakery|bakeshop|bake|roti|cake|bread|pastry|dessert|rice|noodles?|nasi|mee|laksa|burger|pizza|sushi|ramen|chicken|steamboat|hotpot|bbq|barbecue|zapfan|chap\s*fan|economy\s*rice|dim\s*sum|s11|makan|minum|warung|gerai|grocer|groceries|supermarket|market|pasar|hypermarket|catering|bar|pub|boba|eatery|takeaway|kitchen)\b|餐饮|吃饭|餐馆|饮食|外卖|午餐|晚餐|早餐|买菜|超市|零食|饮料|奶茶|茶室|酒楼|食堂|档口|美食|快餐|海鲜|火锅|杂饭|小吃|甜品|面馆|饭店/i.test(lower)) {
    return 'Food & Dining';
  }
  if (/\b(?:doctor|clinic|klinik|pharmacy|farmasi|hospital|panadol|watson|guardian|dental|dentist|optical|optometry|medical|medicine|healthcare)\b|医疗|看病|医院|诊所|药房|买药|看牙|牙医/i.test(lower)) {
    return 'Health';
  }
  if (/\b(?:netflix|spotify|cinema|movie|movies|film|gsc|tgv|game|games|gaming|steam|playstation|nintendo|karaoke|ktv|concert)\b|娱乐|电影|游戏|唱歌|追剧|影院/i.test(lower)) {
    return 'Entertainment';
  }
  if (/\b(?:tnb|electric|electricity|water|syabas|air\s*selangor|indah\s*water|unifi|maxis|celcom|digi|umobile|yes\s*5g|astro|telecom|telco|internet|broadband|rental|maintenance|management\s*fee)\b|住房|房租|水电|账单|话费|宽带|物业|电费|水费/i.test(lower)) {
    return 'Housing & Bills';
  }
  if (/\b(?:parents|parent|family|allowance|parentsallowance)\b|父母|家用|孝顺/i.test(lower)) {
    return 'Parents';
  }
  if (/\b(?:insurance|takaful|assurance|policy|premium|aia|prudential|great\s*eastern|allianz|zurich|etiqa)\b|保险|保单|保费/i.test(lower)) {
    return 'Insurance';
  }
  if (/\b(?:education|school|tuition|university|college|academy|training|course|courses|books?|bookstore)\b|教育|学费|培训|课程|买书/i.test(lower)) {
    return 'Education';
  }
  if (/\b(?:shopping|retail|mall|store|mart|diy|hardware\s*store|convenience|furniture|appliances?|stationery|clothes|clothing|fashion|shoes|apparel|electronics|gadget|gadgets|uniqlo|zara|shopee|lazada|taobao|ikea)\b|购物|衣服|数码|买东西|网购|商场|五金/i.test(lower)) {
    return 'Shopping';
  }
  return 'Other';
}

/**
 * Detects whether a category string is a legacy food/grocery label that
 * must be converted to 'Food & Dining'.
 * Covers English, Malay, Chinese, and mixed forms like "groceries", "food",
 * "groceries / food", "Food and Dining", "买菜", "食品", "餐饮", etc.
 */
export function isLegacyFoodOrGrocery(rawVal: string | null | undefined): boolean {
  if (!rawVal) return false;
  const clean = String(rawVal).trim();
  if (clean === 'Food & Dining') return false;
  const lower = clean.toLowerCase();
  const normalized = lower.replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');

  if (
    /^(groceries|grocery|grocer|food|dining|fooddining|foodanddining|foodndining|foodandbeverage|foodbeverage|foodanddrink|fooddrink|fandb|fb|fnb|supermarket|supermarkets|foodbeverage|fooddrink|meals|meal|lunch|dinner|breakfast|makan|kopitiam|foodcourt|hawker|canteen|cafeteria|bistro|bakery|dessert|restaurant|restoran|cafe|fastfood|seafood|买菜|食品|餐饮|饮食|食物|外卖|午餐|晚餐|早餐|零食|饮料|奶茶|超市|茶室|酒楼|档口|美食|快餐|海鲜|火锅|杂饭)$/i.test(
      normalized
    )
  ) {
    return true;
  }
  if (normalized.includes('grocer') || normalized.includes('supermarket') || normalized.includes('买菜')) {
    return true;
  }
  if (
    normalized.includes('food') ||
    normalized.includes('dining') ||
    normalized.includes('fandb') ||
    normalized.includes('fnb') ||
    normalized.includes('kopitiam')
  ) {
    return true;
  }
  return normalizeToCanonicalCategory(clean, 'Expense') === 'Food & Dining';
}

