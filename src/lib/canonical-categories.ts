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
  fooddining: 'Food & Dining',
  foodanddining: 'Food & Dining',
  restaurant: 'Food & Dining',
  cafe: 'Food & Dining',
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
  if (/badminton|gym|fitness|workout|running|court|nike|adidas|decathlon|运动|羽毛球|健身|跑步|球拍|瑜伽/i.test(lower)) {
    return 'Sport';
  }
  if (/gift|present|birthday|souvenir|angpow|angpao|red packet|礼物|送礼|红包|礼金|手信/i.test(lower)) {
    return 'Gift';
  }
  if (/shell|petronas|caltex|bhpetrol|petron|grab|parking|toll|fuel|petrol|ron95|ron97|diesel|交通|打车|加油|汽油|油费|停车|过路费/i.test(lower)) {
    return 'Transport';
  }
  if (/food|rice|noodle|makan|kopi|coffee|cafe|restaurant|tea|burger|chicken|zapfan|bak kut|hawker|dining|grocer|groceries|supermarket|market|pasar|lotus|giant|aeon|jaya grocer|village grocer|econsave|mydin|cold storage|nsk|买菜|超市|餐饮|吃饭|餐馆|饮食|外卖|午餐|晚餐|早餐|零食|饮料|奶茶/i.test(lower)) {
    return 'Food & Dining';
  }
  if (/doctor|clinic|pharmacy|hospital|panadol|watson|guardian|dental|医疗|看病|医院|诊所|药房|买药/i.test(lower)) {
    return 'Health';
  }
  if (/netflix|spotify|cinema|movie|gsc|tgv|game|steam|娱乐|电影|游戏|唱歌|追剧/i.test(lower)) {
    return 'Entertainment';
  }
  if (/tnb|electric|water|syabas|air selangor|unifi|maxis|celcom|digi|rental|maintenance|住房|房租|水电|账单|话费|宽带|物业/i.test(lower)) {
    return 'Housing & Bills';
  }
  if (/parents|family|父母|家用|孝顺/i.test(lower)) {
    return 'Parents';
  }
  if (/insurance|takaful|保险|保单|保费/i.test(lower)) {
    return 'Insurance';
  }
  if (/education|school|tuition|教育|学费|培训|课程|买书/i.test(lower)) {
    return 'Education';
  }
  if (/shopping|clothes|fashion|shoes|mall|购物|衣服|数码|买东西|网购/i.test(lower)) {
    return 'Shopping';
  }
  return 'Other';
}
