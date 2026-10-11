/**
 * Malaysia LHDN (Hasil) Personal Income Tax Relief Assistant & Tracker
 *
 * Provides:
 * 1. Official Malaysia LHDN Individual Tax Relief categories & annual RM caps (YA 2024/2025/2026)
 * 2. Real-time smart eligibility & non-qualifying item detection when recording purchases
 * 3. Live annual quota calculation (used, claimable, remaining limit) per category
 * 4. Receipt tracking (attached vs. missing receipts) so users never lose tax-deductible receipts
 */

import type { Transaction } from '@/hooks/useTransactions';
import { getAmountInBaseCurrency } from './currency';
import { saveSettingWithCloudSync } from './cloud-settings-sync';

export const LHDN_TAX_CAPS_STORAGE_KEY = 'cashflow_lhdn_tax_caps';
export const LHDN_TAX_RATE_STORAGE_KEY = 'cashflow_lhdn_tax_rate';
export const LHDN_TAX_PROFILE_STORAGE_KEY = 'cashflow_lhdn_tax_profile';

/** Automatic Individual & Dependent Relatives Relief (Pelepasan Individu & Saudara Tanggungan) */
export const LHDN_INDIVIDUAL_BASE_RELIEF = 9000;
export const LHDN_STATUTORY_REBATE_LIMIT = 35000;
export const LHDN_STATUTORY_REBATE_AMOUNT = 400;
export const LHDN_MANDATORY_EPF_SUBLIMIT = 4000;
export const LHDN_LIFE_INSURANCE_SUBLIMIT = 3000;
export const LHDN_SOCSO_LIMIT = 350;

export interface LhdnTaxCategory {
  id: string;
  name: string;
  shortName: string;
  malayName: string;
  icon: string;
  defaultLimit: number;
  qualifies: string;
  excludes: string;
  examples: string[];
  /** CashFlow categories where this relief commonly applies */
  relatedAppCategories: string[];
  /** Auto-match keywords in description/notes (lowercase) */
  keywords: string[];
}

export const LHDN_TAX_CATEGORIES: LhdnTaxCategory[] = [
  {
    id: 'lifestyle',
    name: 'Lifestyle (Tech, Books & WiFi)',
    shortName: 'Lifestyle',
    malayName: 'Gaya Hidup',
    icon: '💻',
    defaultLimit: 2500,
    qualifies:
      'Smartphone, Laptop/PC, Tablet (personal use), Books/E-books/Magazines, Home & Mobile Internet bills (under your name), and Self-Enhancement Skill Courses.',
    excludes:
      'Does NOT cover smartwatches, earbuds/headphones, standalone monitors, mouse/keyboard, phone cases, or gaming consoles (PS5/Switch).',
    examples: ['iPhone / Samsung Phone', 'MacBook / Laptop / iPad', 'Unifi / TIME / Maxis Fibre Bill', 'Popular / Kinokuniya Books'],
    relatedAppCategories: ['Shopping', 'Housing & Bills', 'Education'],
    keywords: [
      'iphone', 'ipad', 'macbook', 'imac', 'laptop', 'notebook pc', 'desktop pc', 'Surface Pro', 'galaxy tab',
      'samsung s2', 'samsung z', 'xiaomi phone', 'smartphone', 'handphone', 'tablet',
      'book', 'bookstore', 'popular bookstore', 'kinokuniya', 'mph book', 'eslite', 'tsutaya', 'bookxcess',
      'ebook', 'kindle', 'magazine', 'newspaper', 'journal',
      'unifi', 'time internet', 'time fibre', 'maxis fibre', 'celcomdigi fibre', 'astro fibre', 'starlink',
      'wifi bill', 'internet bill', 'broadband', 'home fibre', 'fibre internet',
      'udemy', 'coursera', 'skillshare', 'masterclass', 'coding course', 'language class',
    ],
  },
  {
    id: 'sports',
    name: 'Sports Equipment, Court & Gym',
    shortName: 'Sports & Gym',
    malayName: 'Gaya Hidup Tambahan (Sukan)',
    icon: '🏸',
    defaultLimit: 1000,
    qualifies:
      'Sports equipment (badminton racket, shuttlecocks, running/court shoes, gym gear), court/facility booking fees, gym memberships, sports training & competition registration fees.',
    excludes:
      'Does NOT cover casual fashion/streetwear clothing or motorized bicycles/e-scooters.',
    examples: ['Badminton Racket / Shuttlecock', 'Court Booking (Badminton / Futsal / Pickleball)', 'Gym Membership', 'Decathlon / Running Shoes'],
    relatedAppCategories: ['Shopping', 'Health', 'Entertainment'],
    keywords: [
      'badminton', 'racket', 'racquet', 'yonex', 'victor', 'li-ning', 'shuttlecock', 'stringing',
      'pickleball', 'paddle', 'futsal', 'tennis', 'squash', 'basketball', 'football', 'ping pong', 'table tennis',
      'gym', 'fitness', 'anytime fitness', 'celebrity fitness', 'chi fitness', 'true fitness', 'babel', 'f45',
      'pilates', 'yoga mat', 'dumbbell', 'kettlebell', 'treadmill',
      'decathlon', 'sports direct', 'jd sports', 'al-ikhsan', 'running shoes', 'court shoes', 'cleats',
      'swimming pool', 'court booking', 'court rental', 'marathon', 'fun run', 'sports tournament',
    ],
  },
  {
    id: 'medical',
    name: 'Medical, Dental, Vaccine & Checkup',
    shortName: 'Medical & Dental',
    malayName: 'Perubatan, Pergigian & Pemeriksaan',
    icon: '🏥',
    defaultLimit: 10000,
    qualifies:
      'Serious illness & fertility treatment; Complete medical checkup/blood test, vaccinations & mental health consultation (sub-limit RM 1,000); Non-cosmetic dental exam, scaling & extraction (sub-limit RM 1,000).',
    excludes:
      'Does NOT cover cosmetic dental (teeth whitening/veneers/braces), optical glasses/contact lenses, or non-prescribed retail supplements.',
    examples: ['Full Blood Test / Health Screening', 'Dental Scaling / Filling / Extraction', 'Flu / HPV / Pneumococcal Vaccine', 'Hospital / Specialist Treatment'],
    relatedAppCategories: ['Health'],
    keywords: [
      'dental', 'dentist', 'pergigian', 'klinik pergigian', 'scaling', 'tooth', 'filling', 'extraction', 'wisdom tooth', 'root canal',
      'health screening', 'medical checkup', 'medical check-up', 'full body check', 'blood test', 'pathlab', 'bp healthcare', 'gribbles', 'innoquest',
      'vaccine', 'vaccination', 'immunisation', 'flu shot', 'influenza', 'hpv', 'pneumococcal', 'typhoid', 'meningococcal',
      'psychiatrist', 'psychologist', 'mental health', 'counselling', 'therapy session',
      'hospital', 'gleneagles', 'sunway medical', 'pantai hospital', 'kpj', 'columbia asia', 'thomson hospital', 'prince court', 'subang jaya medical', 'ijN',
      'fertility', 'ivf', 'specialist clinic', 'surgery', 'operation', 'ward', 'mri', 'ct scan', 'x-ray', 'ultrasound',
    ],
  },
  {
    id: 'parents',
    name: 'Parents Medical, Dental & Care',
    shortName: 'Parents Care',
    malayName: 'Perubatan & Penjagaan Ibu Bapa',
    icon: '👨‍👩‍👧',
    defaultLimit: 8000,
    qualifies:
      'Medical & dental treatment for parents/grandparents, special needs equipment (wheelchair, hearing aid), carer/nursing home expenses, and full medical checkup for parents (sub-limit RM 1,000).',
    excludes:
      'Cash pocket money/allowance given to parents is NOT tax-deductible — only medical, dental, special needs & registered care receipts qualify.',
    examples: ['Parents Hospital / Clinic Bill', 'Parents Dental Treatment', 'Parents Health Checkup', 'Wheelchair / Medical Equipment for Parents'],
    relatedAppCategories: ['Parents', 'Health'],
    keywords: [
      'parent medical', 'parents medical', 'mum medical', 'mom medical', 'dad medical', 'mother medical', 'father medical',
      'parent clinic', 'parents clinic', 'parent hospital', 'parents hospital', 'parent dental', 'parents dental',
      'parent checkup', 'parents checkup', 'parent blood test', 'nursing home', 'old folks', 'carer', 'wheelchair', 'hearing aid',
      'ibu bapa', 'ayah hospital', 'ibu hospital',
    ],
  },
  {
    id: 'medical_insurance',
    name: 'Medical & Education Insurance',
    shortName: 'Med/Edu Insurance',
    malayName: 'Insurans Pendidikan & Perubatan',
    icon: '🛡️',
    defaultLimit: 4000,
    qualifies:
      'Medical card (hospitalization & surgical) insurance/takaful premiums and Education insurance policies for yourself, spouse, or child (Limit RM 4,000/yr).',
    excludes:
      'Does NOT cover motor/car insurance, travel insurance, or home fire insurance.',
    examples: ['AIA / Prudential / Great Eastern Medical Card', 'Allianz / Etiqa Takaful Medical Plan', 'Child Education Insurance Policy'],
    relatedAppCategories: ['Insurance'],
    keywords: [
      'medical card', 'health insurance', 'medical insurance', 'hospitalisation', 'surgical policy',
      'education insurance', 'education takaful', 'aia medical', 'prudential medical', 'pruhealth', 'prumed',
      'great eastern medical', 'allianz medical', 'etiqa medical', 'zurich medical', 'manulife medical', 'fwd medical',
      'insurance', 'takaful', 'aia', 'prudential', 'great eastern', 'allianz', 'etiqa', 'manulife', 'zurich', 'sun life', 'tokiomarine',
    ],
  },
  {
    id: 'epf_life',
    name: 'EPF / KWSP & Life Insurance',
    shortName: 'EPF & Life Ins.',
    malayName: 'KWSP & Insurans Hayat',
    icon: '🏛️',
    defaultLimit: 7000,
    qualifies:
      'EPF/KWSP contributions (sub-limit RM 4,000) AND Life Insurance / Family Takaful premiums (sub-limit RM 3,000) — combined RM 7,000 limit.',
    excludes:
      'General savings or FD deposits do not qualify; EPF alone is capped at RM 4,000 and Life Insurance at RM 3,000.',
    examples: ['EPF / KWSP Contribution (up to RM 4,000)', 'Life Insurance / Hibah Takaful Premium (up to RM 3,000)'],
    relatedAppCategories: ['EPF / KWSP', 'Insurance'],
    keywords: [
      'epf', 'kwsp', 'i-saraan', 'isaraan', 'akaun persaraan', 'akaun sejahtera', 'akaun fleksibel',
      'life insurance', 'insurans hayat', 'hibah', 'family takaful', 'term life', 'whole life',
    ],
  },
  {
    id: 'education',
    name: 'Self Education & Upskilling Fees',
    shortName: 'Self Education',
    malayName: 'Yuran Pengajian Sendiri',
    icon: '📚',
    defaultLimit: 7000,
    qualifies:
      'Masters/PhD (any field), Degree/Diploma (Law, Accounting, Islamic Finance, Technical, Vocational, Industrial, Scientific or Tech) at recognized Malaysian institutions, plus upskilling courses (sub-limit RM 2,000).',
    excludes:
      'Does NOT cover overseas university tuition or children’s school tuition fees.',
    examples: ['University / College Tuition Fee', 'Masters / MBA / PhD Fee', 'ACCA / CFA / Professional Exam Fee', 'Approved Upskilling Course'],
    relatedAppCategories: ['Education'],
    keywords: [
      'university', 'college', 'tuition fee', 'semester fee', 'degree', 'master', 'mba', 'phd', 'diploma',
      'utar', 'tarc', 'tar umt', 'taylors', 'monash', 'sunway university', 'apu', 'inti', 'segi', 'ucsi', 'mmu', 'uniten', 'utp',
      'um ', 'ukm', 'upm', 'usm', 'utm', 'uitm', 'uia', 'uum', 'unimas', 'ums',
      'acca', 'cfa', 'cpa', 'mia', 'micpa', 'professional exam', 'upskilling', 'hrd corp',
    ],
  },
  {
    id: 'ev_green',
    name: 'EV Charging & Eco Composting',
    shortName: 'EV & Green Tech',
    malayName: 'Pengecasan EV & Mesin Kompos',
    icon: '⚡',
    defaultLimit: 2500,
    qualifies:
      'Installation, rental, purchase (including hire-purchase) of Electric Vehicle (EV) home charger or EV charging subscription fees, plus domestic food waste composting machines.',
    excludes:
      'Does NOT cover petrol (RON95/RON97), Touch n Go toll, regular car servicing, or buying the EV car itself.',
    examples: ['EV Home Wallbox Charger Installation', 'ChargEV / Gentari / JomCharge Subscription', 'Home Food Waste Composter'],
    relatedAppCategories: ['Transport', 'Housing & Bills', 'Shopping'],
    keywords: [
      'ev charger', 'ev charging', 'wallbox', 'chargev', 'gentari', 'jomcharge', 'shell recharge', 'dc handal', 'tesla wall connector',
      'compost machine', 'food composter', 'food waste machine',
    ],
  },
  {
    id: 'childcare_sspn',
    name: 'Childcare (Taska/Tadika) & SSPN',
    shortName: 'Childcare & SSPN',
    malayName: 'Taska/Tadika & Simpan SSPN',
    icon: '👶',
    defaultLimit: 8000,
    qualifies:
      'Simpan SSPN net deposit for child education (up to RM 8,000/yr), registered childcare (Taska) or kindergarten (Tadika) fees for child ≤6 yrs (up to RM 3,000/yr), and breastfeeding equipment (up to RM 1,000).',
    excludes:
      'Primary/secondary school tuition centres (pusat tuisyen) do not qualify under Taska/Tadika.',
    examples: ['Simpan SSPN Prime / Plus Deposit', 'Registered Taska / Tadika Monthly Fee', 'Breast Pump / Breastfeeding Kit'],
    relatedAppCategories: ['Education', 'Other Savings', 'Shopping'],
    keywords: [
      'sspn', 'simpan sspn', 'ptptn sspn', 'taska', 'tadika', 'kindergarten', 'nursery', 'preschool', 'childcare', 'daycare',
      'q-dees', 'smart reader', 'brainy bunch', 'little caliphs', 'real kids', 'breast pump', 'breastfeeding',
    ],
  },
  {
    id: 'prs_socso',
    name: 'Private Retirement Scheme (PRS)',
    shortName: 'PRS Retirement',
    malayName: 'Skim Persaraan Swasta (PRS)',
    icon: '📈',
    defaultLimit: 3000,
    qualifies:
      'Approved Private Retirement Scheme (PRS) & Deferred Annuity contributions (up to RM 3,000/yr).',
    excludes:
      'Regular stocks, crypto, FD, or non-PRS unit trusts (ASNB/ASM/ASB) do not qualify for PRS tax relief.',
    examples: ['Principal / Kenanga / Public Mutual PRS', 'FSMOne PRS Top-Up'],
    relatedAppCategories: ['ASNB / Unit Trust', 'Other Savings'],
    keywords: [
      'prs', 'private retirement scheme', 'private retirement', 'skim persaraan swasta',
    ],
  },
  {
    id: 'socso_eis',
    name: 'SOCSO / PERKESO & EIS',
    shortName: 'SOCSO / PERKESO',
    malayName: 'Caruman PERKESO & SIP',
    icon: '👷',
    defaultLimit: 350,
    qualifies:
      'Employee contributions to SOCSO / PERKESO (Employee Social Security Act 1969) and EIS / SIP (Employment Insurance System Act 2017) — limit RM 350/yr.',
    excludes:
      'Employer portion of SOCSO/EIS does not count; only the employee contribution (capped at RM 350/yr).',
    examples: ['Monthly Payslip SOCSO & EIS Deduction', 'Self-Employed PERKESO Contribution'],
    relatedAppCategories: ['Insurance', 'Other'],
    keywords: [
      'socso', 'perkeso', 'eis contribution', 'sip perkeso', 'pertubuhan keselamatan sosial',
    ],
  },
];

export const DEFAULT_LHDN_TAX_CAPS: Record<string, number> = Object.fromEntries(
  LHDN_TAX_CATEGORIES.map((c) => [c.id, c.defaultLimit])
);

/**
 * Common items Malaysians buy that look like they might qualify, but LHDN explicitly rejects.
 */
const NON_QUALIFYING_WARNINGS: Array<{
  keywords: string[];
  warning: string;
}> = [
  {
    keywords: [
      'apple watch', 'galaxy watch', 'garmin', 'smartwatch', 'smart watch', 'fitbit', 'mi band',
      'airpods', 'earbuds', 'earphone', 'headphone', 'sony wh', 'sony wf', 'bose', 'speaker',
      'monitor', 'computer screen', 'keyboard', 'mouse', 'logitech', 'webcam', 'printer', 'hard disk', 'ssd', 'powerbank', 'phone case', 'casetify',
      'ps5', 'playstation', 'nintendo', 'switch', 'xbox', 'steam deck',
    ],
    warning:
      'LHDN Lifestyle Relief only covers Smartphones, Tablets, and Laptops/PCs. It explicitly excludes smartwatches, earbuds/headphones, standalone monitors, accessories (mouse/keyboard/case), printers, and gaming consoles.',
  },
  {
    keywords: [
      'spectacles', 'eyeglasses', 'contact lens', 'sunglasses', 'owndays', 'focus point', 'mog ', 'optical', 'lasik',
    ],
    warning:
      'Optical spectacles, contact lenses, and LASIK eye surgery are NOT tax-deductible under LHDN Lifestyle or Medical relief.',
  },
  {
    keywords: [
      'teeth whitening', 'veneer', 'invisalign', 'braces', 'botox', 'facial', 'aesthetic', 'laser facial', 'skincare', 'sephora',
    ],
    warning:
      'LHDN Dental & Medical relief only covers non-cosmetic dental treatment (scaling, filling, extraction up to RM 1,000) and medical care. Cosmetic dental (whitening/braces/veneers) and aesthetic treatments do not qualify.',
  },
  {
    keywords: [
      'car insurance', 'motor insurance', 'road tax', 'roadtax', 'auto insurance', 'travel insurance', 'takaful ikhlas motor',
    ],
    warning:
      'Motor/car insurance, road tax, and travel insurance are NOT tax-deductible. Only Life Insurance and Medical/Education Insurance qualify.',
  },
  {
    keywords: [
      'petrol', 'ron95', 'ron97', 'shell', 'petronas', 'petron', 'caltex', 'bhp', 'touch n go', 'tng reload', 'rfid', 'parking', 'grab',
    ],
    warning:
      'Everyday petrol, toll, parking, and Grab rides are not tax-deductible for personal income tax (only EV home charger installation/subscriptions qualify under EV relief).',
  },
  {
    keywords: [
      'uniqlo', 'zara', 'h&m', 'padini', 'cotton on', 'shein', 'shirt', 'jeans', 'dress', 'handbag',
    ],
    warning:
      'Regular clothing, fashion, and bags are not eligible for LHDN tax relief (only dedicated sports equipment/shoes qualify under Sports Lifestyle).',
  },
];

export function getTaxCategoryById(id?: string | null): LhdnTaxCategory | null {
  if (!id) return null;
  const clean = id.trim().toLowerCase();
  return LHDN_TAX_CATEGORIES.find((c) => c.id === clean || c.shortName.toLowerCase() === clean) || null;
}

export function getSavedLhdnTaxCaps(): Record<string, number> {
  if (typeof window === 'undefined') return { ...DEFAULT_LHDN_TAX_CAPS };
  try {
    const raw = localStorage.getItem(LHDN_TAX_CAPS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_LHDN_TAX_CAPS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_LHDN_TAX_CAPS, ...parsed };
  } catch {
    return { ...DEFAULT_LHDN_TAX_CAPS };
  }
}

export const getSavedTaxCaps = getSavedLhdnTaxCaps;

export function saveLhdnTaxCaps(caps: Record<string, number>): void {
  saveSettingWithCloudSync(LHDN_TAX_CAPS_STORAGE_KEY, JSON.stringify(caps));
}

export const saveTaxCaps = saveLhdnTaxCaps;

export function getSavedEstimatedTaxRate(): number {
  if (typeof window === 'undefined') return 11;
  try {
    const raw = localStorage.getItem(LHDN_TAX_RATE_STORAGE_KEY);
    if (!raw) return 11;
    const parsed = parseFloat(raw);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 30 ? parsed : 11;
  } catch {
    return 11;
  }
}

export const getSavedTaxRate = getSavedEstimatedTaxRate;

export function saveEstimatedTaxRate(rate: number): void {
  saveSettingWithCloudSync(LHDN_TAX_RATE_STORAGE_KEY, String(rate));
}

export const saveTaxRate = saveEstimatedTaxRate;

/**
 * Extracts an explicit LHDN tax tag from a transaction's Notes or SubCategory.
 * Returns:
 * - `'none'` if user explicitly unchecked tax relief (`[No Tax Relief]` or `TAX:none`)
 * - `<categoryId>` if explicitly tagged (`[LHDN Tax Relief: lifestyle]` or `LHDN: Lifestyle`)
 * - `null` if no explicit tag is present
 */
export function extractExplicitTaxCategoryId(tx: {
  notes?: string;
  subCategory?: string;
}): string | 'none' | null {
  const notes = String(tx.notes || '');
  const sub = String(tx.subCategory || '').trim();

  if (/\[No Tax Relief\]/i.test(notes) || /^TAX:none$/i.test(sub)) {
    return 'none';
  }

  // Match [LHDN Tax Relief: id] or [LHDN Tax Relief: id - ...]
  const noteMatch = notes.match(/\[LHDN Tax Relief:\s*([a-z0-9_]+)/i);
  if (noteMatch?.[1]) {
    const found = getTaxCategoryById(noteMatch[1]);
    if (found) return found.id;
  }

  // Match SubCategory "TAX:lifestyle" or "LHDN: Lifestyle"
  const subMatch = sub.match(/^(?:TAX|LHDN):\s*(.+)$/i);
  if (subMatch?.[1]) {
    const found = getTaxCategoryById(subMatch[1]);
    if (found) return found.id;
  }

  return null;
}

/**
 * Embeds or removes the LHDN tax relief tag in Notes and SubCategory.
 * Supports both:
 * - `applyTaxReliefTag(taxCategoryId, notes)` (2-arg convenience)
 * - `applyTaxReliefTag(notes, subCategory, taxCategoryId, explicitOptOut)` (4-arg full)
 */
export function applyTaxReliefTag(
  arg1: string | null | undefined,
  arg2?: string | null,
  arg3?: string | null,
  explicitOptOut: boolean = false
): { notes: string; subCategory: string } {
  let notes = '';
  let subCategory = '';
  let taxCategoryId: string | null = null;
  let optOut = explicitOptOut;

  // Detect 2-argument call: applyTaxReliefTag(taxCategoryId, notes)
  if (arg3 === undefined && (arg1 === 'none' || getTaxCategoryById(arg1) !== null)) {
    taxCategoryId = arg1 === 'none' ? null : String(arg1 || '');
    notes = String(arg2 || '');
    subCategory = '';
    optOut = arg1 === 'none';
  } else {
    notes = String(arg1 || '');
    subCategory = String(arg2 || '');
    taxCategoryId = arg3 === 'none' ? null : arg3 || null;
    optOut = explicitOptOut || arg3 === 'none';
  }

  // Strip any existing LHDN tax tags from notes
  let cleanedNotes = notes
    .replace(/\s*\[LHDN Tax Relief:[^\]]*\]/gi, '')
    .replace(/\s*\[No Tax Relief\]/gi, '')
    .trim();

  let cleanedSub = subCategory.trim();
  if (/^(?:TAX|LHDN):/i.test(cleanedSub)) {
    cleanedSub = '';
  }

  const taxCat = getTaxCategoryById(taxCategoryId);
  if (taxCat) {
    const tag = `[LHDN Tax Relief: ${taxCat.id} (${taxCat.shortName})]`;
    cleanedNotes = cleanedNotes ? `${cleanedNotes}\n${tag}` : tag;
    if (!cleanedSub) {
      cleanedSub = `LHDN: ${taxCat.shortName}`;
    }
  } else if (optOut) {
    const tag = `[No Tax Relief]`;
    cleanedNotes = cleanedNotes ? `${cleanedNotes}\n${tag}` : tag;
  }

  return { notes: cleanedNotes, subCategory: cleanedSub };
}

export interface PurchaseTaxAnalysis {
  isEligible: boolean;
  matchedCategory: LhdnTaxCategory | null;
  category: LhdnTaxCategory | null;
  confidence: 'explicit' | 'keyword' | 'category' | 'none';
  matchReason: string;
  reason: string;
  nonQualifyingWarning: string | null;
  warningMessage: string | null;
  possibleCategories: LhdnTaxCategory[];
}

function buildAnalysisResult(raw: {
  isEligible: boolean;
  matchedCategory: LhdnTaxCategory | null;
  confidence: 'explicit' | 'keyword' | 'category' | 'none';
  matchReason: string;
  nonQualifyingWarning: string | null;
  possibleCategories: LhdnTaxCategory[];
}): PurchaseTaxAnalysis {
  return {
    ...raw,
    category: raw.matchedCategory,
    reason: raw.matchReason,
    warningMessage: raw.nonQualifyingWarning,
  };
}

/**
 * Smart real-time detector for whether a purchase can deduct Malaysia LHDN income tax.
 */
export function analyzePurchaseForTaxRelief(input: {
  type?: string;
  category?: string;
  description?: string;
  notes?: string;
  subCategory?: string;
}): PurchaseTaxAnalysis {
  const rawType = String(input.type || 'expense').toLowerCase();
  const appCat = String(input.category || '').trim();
  const desc = String(input.description || '').trim();
  const notes = String(input.notes || '').trim();
  const subCategory = String(input.subCategory || '').trim();

  // Income transactions are not tax relief purchases
  if (rawType === 'income') {
    return buildAnalysisResult({
      isEligible: false,
      matchedCategory: null,
      confidence: 'none',
      matchReason: '',
      nonQualifyingWarning: null,
      possibleCategories: [],
    });
  }

  // 1. Check explicit tag first
  const explicitId = extractExplicitTaxCategoryId({ notes, subCategory });
  if (explicitId === 'none') {
    return buildAnalysisResult({
      isEligible: false,
      matchedCategory: null,
      confidence: 'explicit',
      matchReason: 'Marked as non-deductible',
      nonQualifyingWarning: null,
      possibleCategories: LHDN_TAX_CATEGORIES.filter((c) => c.relatedAppCategories.includes(appCat)),
    });
  }
  if (explicitId) {
    const cat = getTaxCategoryById(explicitId);
    if (cat) {
      return buildAnalysisResult({
        isEligible: true,
        matchedCategory: cat,
        confidence: 'explicit',
        matchReason: `Tagged under LHDN ${cat.name}`,
        nonQualifyingWarning: null,
        possibleCategories: LHDN_TAX_CATEGORIES,
      });
    }
  }

  if (rawType !== 'investment' && appCat === 'Food & Dining') {
    return buildAnalysisResult({
      isEligible: false,
      matchedCategory: null,
      confidence: 'none',
      matchReason: '',
      nonQualifyingWarning: null,
      possibleCategories: [],
    });
  }

  const cleanedNotesForTax = notes
    .replace(/(?:iphone\s*)?背面轻点截图草稿(?:（待核对确认）)?/gi, ' ')
    .replace(/apple\s*pay\s*快捷指令草稿(?:（待核对确认）)?/gi, ' ')
    .replace(/快捷指令截图草稿(?:（待核对确认）)?/gi, ' ');
  const combinedText = `${desc} ${cleanedNotesForTax}`.toLowerCase();

  // 2. Check investment category (only EPF / KWSP or PRS qualifies)
  if (rawType === 'investment') {
    if (appCat === 'EPF / KWSP' || combinedText.includes('epf') || combinedText.includes('kwsp')) {
      const epfCat = getTaxCategoryById('epf_life')!;
      return buildAnalysisResult({
        isEligible: true,
        matchedCategory: epfCat,
        confidence: 'category',
        matchReason: 'EPF / KWSP contributions qualify for up to RM 4,000 (within RM 7,000 EPF + Life Insurance limit)',
        nonQualifyingWarning: null,
        possibleCategories: [epfCat, getTaxCategoryById('prs_socso')!],
      });
    }
    if (combinedText.includes('prs') || combinedText.includes('private retirement')) {
      const prsCat = getTaxCategoryById('prs_socso')!;
      return buildAnalysisResult({
        isEligible: true,
        matchedCategory: prsCat,
        confidence: 'keyword',
        matchReason: 'Private Retirement Scheme (PRS) contributions qualify for up to RM 3,000/year',
        nonQualifyingWarning: null,
        possibleCategories: [prsCat],
      });
    }
    if (combinedText.includes('sspn')) {
      const sspnCat = getTaxCategoryById('childcare_sspn')!;
      return buildAnalysisResult({
        isEligible: true,
        matchedCategory: sspnCat,
        confidence: 'keyword',
        matchReason: 'Simpan SSPN net deposits qualify for up to RM 8,000/year',
        nonQualifyingWarning: null,
        possibleCategories: [sspnCat],
      });
    }
    return buildAnalysisResult({
      isEligible: false,
      matchedCategory: null,
      confidence: 'none',
      matchReason: '',
      nonQualifyingWarning:
        appCat === 'Fixed Deposit' || appCat === 'ASNB / Unit Trust'
          ? 'Fixed Deposits and regular ASNB/Unit Trusts are tax-exempt on dividends, but deposits do not deduct taxable income (only EPF/KWSP, PRS & Simpan SSPN qualify).'
          : null,
      possibleCategories: [getTaxCategoryById('epf_life')!, getTaxCategoryById('prs_socso')!, getTaxCategoryById('childcare_sspn')!],
    });
  }

  const matchesKeyword = (text: string, kw: string): boolean => {
    const cleanKw = kw.trim().toLowerCase();
    if (!cleanKw) return false;
    const escaped = cleanKw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
  };

  // 3. Check if description matches a known NON-QUALIFYING lookalike item first
  let nonQualifyingWarning: string | null = null;
  if (combinedText.trim().length > 0) {
    for (const rule of NON_QUALIFYING_WARNINGS) {
      if (rule.keywords.some((kw) => matchesKeyword(combinedText, kw))) {
        nonQualifyingWarning = rule.warning;
        break;
      }
    }
  }

  // 4. Check specific keyword matches across LHDN categories
  // Prioritize Parents if both 'parent' and medical words appear
  if (
    (appCat === 'Parents' || /\b(parent|parents|mum|mom|dad|mother|father|ibu|ayah)\b/i.test(combinedText)) &&
    /\b(medical|clinic|klinik|hospital|dental|dentist|checkup|check-up|blood test|doctor|medicine|nursing|wheelchair|care)\b/i.test(combinedText)
  ) {
    const parentsCat = getTaxCategoryById('parents')!;
    return buildAnalysisResult({
      isEligible: true,
      matchedCategory: parentsCat,
      confidence: 'keyword',
      matchReason: 'Parents medical, dental & care expenses qualify for up to RM 8,000/year',
      nonQualifyingWarning: null,
      possibleCategories: [parentsCat],
    });
  }

  if (!nonQualifyingWarning && combinedText.trim().length > 0) {
    for (const taxCat of LHDN_TAX_CATEGORIES) {
      const matchedKw = taxCat.keywords.find((kw) => matchesKeyword(combinedText, kw));
      if (matchedKw) {
        return buildAnalysisResult({
          isEligible: true,
          matchedCategory: taxCat,
          confidence: 'keyword',
          matchReason: `Matched "${matchedKw}" → qualifies under LHDN ${taxCat.name}`,
          nonQualifyingWarning: null,
          possibleCategories: LHDN_TAX_CATEGORIES.filter((c) => c.relatedAppCategories.includes(appCat)),
        });
      }
    }
  }

  // 5. Category-based automatic or suggested match when no conflicting warning exists
  if (!nonQualifyingWarning) {
    if (appCat === 'Insurance') {
      const isLife = /\b(life|hayat|hibah|family takaful)\b/i.test(combinedText);
      const target = getTaxCategoryById(isLife ? 'epf_life' : 'medical_insurance')!;
      return buildAnalysisResult({
        isEligible: true,
        matchedCategory: target,
        confidence: 'category',
        matchReason: `${appCat} qualifies under LHDN ${target.name}`,
        nonQualifyingWarning: null,
        possibleCategories: [getTaxCategoryById('medical_insurance')!, getTaxCategoryById('epf_life')!],
      });
    }

    if (appCat === 'Health') {
      const target = getTaxCategoryById('medical')!;
      return buildAnalysisResult({
        isEligible: true,
        matchedCategory: target,
        confidence: 'category',
        matchReason: 'Medical checkups, vaccinations, dental scaling & treatments qualify under LHDN Medical Relief',
        nonQualifyingWarning: null,
        possibleCategories: [target, getTaxCategoryById('parents')!, getTaxCategoryById('sports')!],
      });
    }

    if (appCat === 'Education') {
      const target = getTaxCategoryById('education')!;
      return buildAnalysisResult({
        isEligible: true,
        matchedCategory: target,
        confidence: 'category',
        matchReason: 'Tertiary education & recognized upskilling courses qualify under LHDN Education Relief',
        nonQualifyingWarning: null,
        possibleCategories: [target, getTaxCategoryById('lifestyle')!, getTaxCategoryById('childcare_sspn')!],
      });
    }

    if (appCat === 'Parents') {
      // Only medical/care for parents is tax-deductible, cash allowance is not
      const parentsCat = getTaxCategoryById('parents')!;
      if (!desc) {
        return buildAnalysisResult({
          isEligible: false,
          matchedCategory: null,
          confidence: 'none',
          matchReason: '',
          nonQualifyingWarning: null,
          possibleCategories: [parentsCat],
        });
      }
    }
  }

  const possibleCategories = LHDN_TAX_CATEGORIES.filter((c) => c.relatedAppCategories.includes(appCat));

  return buildAnalysisResult({
    isEligible: false,
    matchedCategory: null,
    confidence: 'none',
    matchReason: '',
    nonQualifyingWarning,
    possibleCategories: possibleCategories.length > 0 ? possibleCategories : LHDN_TAX_CATEGORIES.slice(0, 4),
  });
}

/**
 * Resolves the effective LHDN Tax Category for an existing saved transaction.
 */
export function getTransactionTaxCategory(tx: {
  type?: string;
  category?: string;
  description?: string;
  notes?: string;
  subCategory?: string;
} | null | undefined): LhdnTaxCategory | null {
  if (!tx) return null;
  const analysis = analyzePurchaseForTaxRelief({
    type: tx.type,
    category: tx.category,
    description: tx.description,
    notes: tx.notes,
    subCategory: tx.subCategory,
  });
  return analysis.isEligible ? analysis.matchedCategory : null;
}

export const getTransactionTaxRelief = getTransactionTaxCategory;

export interface YearlyTaxProfileOverride {
  /** Optional manual annual gross taxable income override (MYR) for this Assessment Year */
  annualIncomeOverride?: number | null;
  /** Optional manual total PCB / MTD paid override (MYR) for this Assessment Year */
  pcbPaidOverride?: number | null;
  /** Optional manual employee EPF (KWSP) deducted from salary override (MYR, sub-limit RM 4,000) */
  epfFromSalaryOverride?: number | null;
  /** Optional manual employee SOCSO & EIS (PERKESO) deducted from salary override (MYR, limit RM 350) */
  socsoFromSalaryOverride?: number | null;
  /** Optional additional LHDN reliefs not tracked by purchase categories (e.g., Spouse RM 4,000, Child relief, Disabled relief, Approved Donations) */
  additionalReliefsOverride?: number | null;
  /** Optional additional LHDN tax rebates (e.g., Zakat/Fitrah, Spouse Rebate RM 400 when Chargeable Income <= RM 35,000) */
  additionalRebatesOverride?: number | null;
}

export function getSavedAllTaxProfiles(): Record<string, YearlyTaxProfileOverride> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(LHDN_TAX_PROFILE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function getSavedTaxProfile(year: string): YearlyTaxProfileOverride {
  const all = getSavedAllTaxProfiles();
  return all[year] || {};
}

export function saveTaxProfileForYear(year: string, patch: Partial<YearlyTaxProfileOverride>): YearlyTaxProfileOverride {
  const all = getSavedAllTaxProfiles();
  const updatedForYear: YearlyTaxProfileOverride = {
    ...(all[year] || {}),
    ...patch,
  };
  const nextAll = {
    ...all,
    [year]: updatedForYear,
  };
  saveSettingWithCloudSync(LHDN_TAX_PROFILE_STORAGE_KEY, JSON.stringify(nextAll));
  return updatedForYear;
}

/**
 * Extracts optional payslip deductions (`[PCB: RM X]`, `[EPF: RM Y]`, and `[SOCSO: RM Z]`) embedded in an Income transaction's Notes.
 */
export function extractPayslipDeductionsFromNotes(notes?: string | null): {
  pcbAmount: number;
  epfAmount: number;
  socsoAmount: number;
} {
  const text = String(notes || '');
  const pcbMatch = text.match(/\[PCB:\s*(?:RM\s*)?(\d+(?:\.\d+)?)\]/i);
  const epfMatch = text.match(/\[EPF:\s*(?:RM\s*)?(\d+(?:\.\d+)?)\]/i);
  const socsoMatch = text.match(/\[SOCSO:\s*(?:RM\s*)?(\d+(?:\.\d+)?)\]/i);
  const pcbAmount = pcbMatch?.[1] ? parseFloat(pcbMatch[1]) || 0 : 0;
  const epfAmount = epfMatch?.[1] ? parseFloat(epfMatch[1]) || 0 : 0;
  const socsoAmount = socsoMatch?.[1] ? parseFloat(socsoMatch[1]) || 0 : 0;
  return { pcbAmount, epfAmount, socsoAmount };
}

/**
 * Embeds or updates `[PCB: RM X.XX]`, `[EPF: RM Y.YY]`, and `[SOCSO: RM Z.ZZ]` tags in an Income transaction's Notes.
 */
export function applyPayslipDeductionsTag(
  notes: string | null | undefined,
  pcbAmount?: number | null,
  epfAmount?: number | null,
  socsoAmount?: number | null
): string {
  let cleaned = String(notes || '')
    .replace(/\s*\[PCB:\s*(?:RM\s*)?\d+(?:\.\d+)?\]/gi, '')
    .replace(/\s*\[EPF:\s*(?:RM\s*)?\d+(?:\.\d+)?\]/gi, '')
    .replace(/\s*\[SOCSO:\s*(?:RM\s*)?\d+(?:\.\d+)?\]/gi, '')
    .trim();

  const tags: string[] = [];
  if (typeof pcbAmount === 'number' && Number.isFinite(pcbAmount) && pcbAmount > 0) {
    tags.push(`[PCB: RM ${pcbAmount.toFixed(2)}]`);
  }
  if (typeof epfAmount === 'number' && Number.isFinite(epfAmount) && epfAmount > 0) {
    tags.push(`[EPF: RM ${epfAmount.toFixed(2)}]`);
  }
  if (typeof socsoAmount === 'number' && Number.isFinite(socsoAmount) && socsoAmount > 0) {
    tags.push(`[SOCSO: RM ${socsoAmount.toFixed(2)}]`);
  }

  if (tags.length > 0) {
    const tagLine = tags.join(' ');
    cleaned = cleaned ? `${cleaned}\n${tagLine}` : tagLine;
  }
  return cleaned;
}

export interface MalaysiaProgressiveTaxResult {
  chargeableIncome: number;
  grossTax: number;
  rebate: number;
  netTax: number;
  marginalRate: number;
  effectiveRate: number;
  bracketLabel: string;
}

/**
 * Official Malaysia LHDN Resident Individual Progressive Income Tax Schedule (YA 2024 / 2025 / 2026)
 * Includes the statutory RM 400 Individual Tax Rebate (Section 6A(2)(a)) when Chargeable Income <= RM 35,000.
 */
export function calculateMalaysiaProgressiveTax(rawChargeableIncome: number): MalaysiaProgressiveTaxResult {
  const chargeable = Math.max(0, Number.isFinite(rawChargeableIncome) ? rawChargeableIncome : 0);

  const brackets: Array<{
    min: number;
    max: number;
    rate: number;
    baseTax: number;
    label: string;
  }> = [
    { min: 0, max: 5000, rate: 0, baseTax: 0, label: 'RM 0 – RM 5,000 (0%)' },
    { min: 5000, max: 20000, rate: 1, baseTax: 0, label: 'RM 5,001 – RM 20,000 (1%)' },
    { min: 20000, max: 35000, rate: 3, baseTax: 150, label: 'RM 20,001 – RM 35,000 (3%)' },
    { min: 35000, max: 50000, rate: 6, baseTax: 600, label: 'RM 35,001 – RM 50,000 (6%)' },
    { min: 50000, max: 70000, rate: 11, baseTax: 1500, label: 'RM 50,001 – RM 70,000 (11%)' },
    { min: 70000, max: 100000, rate: 19, baseTax: 3700, label: 'RM 70,001 – RM 100,000 (19%)' },
    { min: 100000, max: 400000, rate: 25, baseTax: 9400, label: 'RM 100,001 – RM 400,000 (25%)' },
    { min: 400000, max: 600000, rate: 26, baseTax: 84400, label: 'RM 400,001 – RM 600,000 (26%)' },
    { min: 600000, max: 2000000, rate: 28, baseTax: 136400, label: 'RM 600,001 – RM 2,000,000 (28%)' },
    { min: 2000000, max: Infinity, rate: 30, baseTax: 528400, label: 'Above RM 2,000,000 (30%)' },
  ];

  let matched = brackets[0];
  for (const b of brackets) {
    if (chargeable > b.min) {
      matched = b;
    } else {
      break;
    }
  }

  const taxableInBracket = Math.max(0, chargeable - matched.min);
  const grossTax = matched.baseTax + taxableInBracket * (matched.rate / 100);
  const rebate = chargeable > 0 && chargeable <= LHDN_STATUTORY_REBATE_LIMIT ? LHDN_STATUTORY_REBATE_AMOUNT : 0;
  const netTax = Math.max(0, grossTax - rebate);
  const effectiveRate = chargeable > 0 ? (netTax / chargeable) * 100 : 0;

  return {
    chargeableIncome: chargeable,
    grossTax,
    rebate,
    netTax,
    marginalRate: matched.rate,
    effectiveRate,
    bracketLabel: matched.label,
  };
}

export interface LhdnCategoryProgress {
  category: LhdnTaxCategory;
  limit: number;
  totalSpent: number;
  claimableAmount: number;
  remainingQuota: number;
  remainingLimit: number;
  overAmount: number;
  percentUsed: number;
  isMaxedOut: boolean;
  transactions: Transaction[];
  withReceiptCount: number;
  attachedReceiptCount: number;
  missingReceiptCount: number;
  missingReceiptTransactions: Transaction[];
}

export interface YearlyTaxReliefSummary {
  year: string;
  categories: LhdnCategoryProgress[];
  byCategoryId: Record<string, LhdnCategoryProgress>;
  totalSpentAllCategories: number;
  totalEligibleSpent: number;
  totalClaimableRelief: number;
  totalClaimable: number;
  estimatedTaxRate: number;
  estimatedTaxSaved: number;
  totalTaxTransactions: number;
  totalWithReceipts: number;
  attachedReceiptCount: number;
  totalMissingReceipts: number;
  missingReceiptCount: number;
  allTaxTransactions: Array<{ tx: Transaction; taxCategory: LhdnTaxCategory }>;
  allMissingReceiptTransactions: Array<{ tx: Transaction; taxCategory: LhdnTaxCategory }>;

  // Malaysia LHDN Form BE Income, Reliefs, Rebates, PCB & Estimated Settlement Breakdown
  recordedTaxableIncome: number;
  annualTaxableIncome: number;
  isIncomeOverridden: boolean;
  incomeTransactionCount: number;
  recordedPayslipEpf: number;
  effectivePayslipEpf: number;
  recordedPayslipSocso: number;
  effectivePayslipSocso: number;
  individualBaseRelief: number;
  additionalReliefs: number;
  recordedZakatRebate: number;
  additionalRebates: number;
  totalTaxRebates: number;
  chargeableIncomeBeforeReliefs: number;
  chargeableIncome: number;
  grossTaxBeforeRebate: number;
  statutoryRebate: number;
  taxWithoutReliefs: number;
  actualTaxPayable: number;
  estimatedTaxPayable: number;
  effectiveMarginalTaxRate: number;
  bracketLabel: string;
  recordedPcbPaid: number;
  totalPcbPaid: number;
  isPcbOverridden: boolean;
  /** Positive means estimated LHDN tax refund; negative means estimated extra tax payable */
  netTaxDifference: number;
  refundAmount: number;
  extraTaxToPay: number;
  settlementStatus: 'refund' | 'pay_extra' | 'settled';
}

function isEpfContributionTx(tx: Transaction): boolean {
  const rawType = String(tx.type || '').toLowerCase();
  const cat = String(tx.category || '').trim();
  const cleanNotes = String(tx.notes || '').replace(/\[LHDN Tax Relief:[^\]]*\]/gi, '');
  const cleanSub = String(tx.subCategory || '').replace(/^LHDN:\s*.+$/gi, '');
  const text = `${tx.description || ''} ${cleanNotes} ${cleanSub}`.toLowerCase();
  if (/\b(life insurance|insurans hayat|hibah|family takaful|term life|whole life|prudential|great eastern|aia|allianz|etiqa|zurich|manulife)\b/i.test(text)) {
    return false;
  }
  return (
    rawType === 'investment' ||
    cat === 'EPF / KWSP' ||
    /\b(epf|kwsp|i-saraan|isaraan|akaun persaraan|akaun sejahtera|akaun fleksibel)\b/i.test(text)
  );
}

function isVoluntaryEpfTx(tx: Transaction): boolean {
  const cleanNotes = String(tx.notes || '').replace(/\[LHDN Tax Relief:[^\]]*\]/gi, '');
  const cleanSub = String(tx.subCategory || '').replace(/^LHDN:\s*.+$/gi, '');
  const text = `${tx.description || ''} ${cleanNotes} ${cleanSub}`.toLowerCase();
  return /\b(voluntary|top-?up|i-?saraan|isaraan|i-?simpan|isimpan|i-?suri|isuri|sukarela|self[- ]?contribution|caruman sendiri|caruman pilihan|additional|extra|ad-?hoc)\b/i.test(
    text
  );
}

function isVoluntarySocsoTx(tx: Transaction): boolean {
  const cleanNotes = String(tx.notes || '').replace(/\[LHDN Tax Relief:[^\]]*\]/gi, '');
  const cleanSub = String(tx.subCategory || '').replace(/^LHDN:\s*.+$/gi, '');
  const text = `${tx.description || ''} ${cleanNotes} ${cleanSub}`.toLowerCase();
  return /\b(voluntary|top-?up|self[- ]?employed|skssr|sps|pekerja sendiri|sukarela|housewife|suri rumah|additional|extra|ad-?hoc)\b/i.test(
    text
  );
}

function isExplicitPayslipDeductionTx(tx: Transaction): boolean {
  const cleanNotes = String(tx.notes || '').replace(/\[LHDN Tax Relief:[^\]]*\]/gi, '');
  const cleanSub = String(tx.subCategory || '').replace(/^LHDN:\s*.+$/gi, '');
  const text = `${tx.description || ''} ${cleanNotes} ${cleanSub}`.toLowerCase();
  return /\b(payslip|salary deduction|potongan gaji|mandatory epf|employee epf|employee socso)\b/i.test(text);
}

/**
 * Computes the Malaysia LHDN Tax Relief & Estimated Form BE Assessment for a given Assessment Year (e.g. "2026").
 */
export function calculateYearlyTaxReliefSummary(
  transactions: Transaction[],
  year: string,
  customCaps?: Record<string, number>,
  estimatedTaxRate: number = 11,
  profileOverride?: YearlyTaxProfileOverride
): YearlyTaxReliefSummary {
  const caps = { ...DEFAULT_LHDN_TAX_CAPS, ...(customCaps || {}) };
  const profile = profileOverride || getSavedTaxProfile(year);

  const grouped = new Map<string, Transaction[]>();
  LHDN_TAX_CATEGORIES.forEach((c) => grouped.set(c.id, []));

  const allTaxTransactions: Array<{ tx: Transaction; taxCategory: LhdnTaxCategory }> = [];
  const allMissingReceiptTransactions: Array<{ tx: Transaction; taxCategory: LhdnTaxCategory }> = [];

  let recordedTaxableIncome = 0;
  let incomeTransactionCount = 0;
  let recordedPcbPaid = 0;
  let recordedZakatRebate = 0;

  const payslipEntriesByMonth: Array<{ month: string; epfAmount: number; socsoAmount: number }> = [];

  transactions.forEach((tx) => {
    if (!tx.date || tx.id === 'tx_sample') return;
    if (year !== 'all' && !tx.date.startsWith(year)) return;

    const rawType = String(tx.type || 'expense').toLowerCase();
    const amtMyr = getAmountInBaseCurrency(tx.amount, tx.currency, tx.baseAmount);
    const catName = String(tx.category || '').trim();
    const combinedText = `${tx.description || ''} ${tx.notes || ''} ${tx.subCategory || ''}`.toLowerCase();

    // 1. Track Annual Taxable Income & Payslip PCB/EPF/SOCSO tags from Income transactions
    if (rawType === 'income') {
      // Exclude non-taxable reimbursements ('Claim Allowance') and tax-exempt dividend/FD returns ('Investment Return')
      const isTaxExemptIncome =
        catName === 'Claim Allowance' ||
        catName === 'Investment Return' ||
        /\[No Tax Relief\]/i.test(String(tx.notes || ''));

      if (!isTaxExemptIncome && amtMyr > 0) {
        recordedTaxableIncome += amtMyr;
        incomeTransactionCount += 1;
      }

      const payslip = extractPayslipDeductionsFromNotes(tx.notes);
      if (payslip.pcbAmount > 0) {
        recordedPcbPaid += payslip.pcbAmount;
      }
      if (payslip.epfAmount > 0 || payslip.socsoAmount > 0) {
        payslipEntriesByMonth.push({
          month: tx.date.substring(0, 7),
          epfAmount: payslip.epfAmount,
          socsoAmount: payslip.socsoAmount,
        });
      }
      return;
    }

    // 2. Detect standalone PCB / MTD tax payment expenses
    if (
      rawType === 'expense' &&
      /\b(pcb|potongan cukai bulanan|mtd|monthly tax deduction|lhdn pcb|cp500)\b/i.test(combinedText)
    ) {
      recordedPcbPaid += amtMyr;
    }

    // 3. Detect Zakat / Fitrah expenses (eligible for 100% ringgit-for-ringgit LHDN tax rebate under Section 6A(3))
    if (rawType === 'expense' && /\b(zakat|fitrah)\b/i.test(combinedText)) {
      recordedZakatRebate += amtMyr;
    }

    // 4. Match LHDN Tax Relief Category
    const taxCat = getTransactionTaxCategory(tx);
    if (!taxCat) return;

    const list = grouped.get(taxCat.id) || [];
    list.push(tx);
    grouped.set(taxCat.id, list);

    allTaxTransactions.push({ tx, taxCategory: taxCat });
    if (!tx.receiptUrl) {
      allMissingReceiptTransactions.push({ tx, taxCategory: taxCat });
    }
  });

  // Separate EPF vs Life Insurance transactions and build 1-to-1 deduplication candidates
  // so recording the same payslip contribution twice is deduplicated while voluntary top-ups in the same month are preserved.
  interface StandaloneDeduplicationCandidate {
    month: string;
    amount: number;
    isVoluntary: boolean;
    isExplicitPayslip: boolean;
    consumed: boolean;
  }

  const epfLifeTxs = grouped.get('epf_life') || [];
  const standaloneEpfCandidates: StandaloneDeduplicationCandidate[] = [];
  let standaloneEpfTxSpent = 0;
  let standaloneLifeInsTxSpent = 0;

  epfLifeTxs.forEach((t) => {
    const amt = getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount);
    if (isEpfContributionTx(t)) {
      standaloneEpfTxSpent += amt;
      standaloneEpfCandidates.push({
        month: t.date ? t.date.substring(0, 7) : '',
        amount: amt,
        isVoluntary: isVoluntaryEpfTx(t),
        isExplicitPayslip: isExplicitPayslipDeductionTx(t),
        consumed: false,
      });
    } else {
      standaloneLifeInsTxSpent += amt;
    }
  });

  const socsoTxs = grouped.get('socso_eis') || [];
  const standaloneSocsoCandidates: StandaloneDeduplicationCandidate[] = [];
  let standaloneSocsoTxSpent = 0;
  socsoTxs.forEach((t) => {
    const amt = getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount);
    standaloneSocsoTxSpent += amt;
    standaloneSocsoCandidates.push({
      month: t.date ? t.date.substring(0, 7) : '',
      amount: amt,
      isVoluntary: isVoluntarySocsoTx(t),
      isExplicitPayslip: isExplicitPayslipDeductionTx(t),
      consumed: false,
    });
  });

  // Match each payslip EPF/SOCSO entry against at most one non-voluntary standalone transaction in the same month
  // that has the exact same amount (or is explicitly labeled as a payslip deduction).
  let recordedPayslipEpf = 0;
  let recordedPayslipSocso = 0;

  payslipEntriesByMonth.forEach((entry) => {
    if (entry.epfAmount > 0) {
      const exactMatch = standaloneEpfCandidates.find(
        (c) =>
          !c.consumed &&
          c.month === entry.month &&
          !c.isVoluntary &&
          Math.abs(c.amount - entry.epfAmount) < 0.01
      );
      const explicitMatch =
        exactMatch ||
        standaloneEpfCandidates.find(
          (c) => !c.consumed && c.month === entry.month && !c.isVoluntary && c.isExplicitPayslip
        );

      if (explicitMatch) {
        explicitMatch.consumed = true;
        recordedPayslipEpf += Math.max(0, entry.epfAmount - explicitMatch.amount);
      } else {
        recordedPayslipEpf += entry.epfAmount;
      }
    }

    if (entry.socsoAmount > 0) {
      const exactMatch = standaloneSocsoCandidates.find(
        (c) =>
          !c.consumed &&
          c.month === entry.month &&
          !c.isVoluntary &&
          Math.abs(c.amount - entry.socsoAmount) < 0.01
      );
      const explicitMatch =
        exactMatch ||
        standaloneSocsoCandidates.find(
          (c) => !c.consumed && c.month === entry.month && !c.isVoluntary && c.isExplicitPayslip
        );

      if (explicitMatch) {
        explicitMatch.consumed = true;
        recordedPayslipSocso += Math.max(0, entry.socsoAmount - explicitMatch.amount);
      } else {
        recordedPayslipSocso += entry.socsoAmount;
      }
    }
  });

  const duplicatePayslipEpfTxSpent = standaloneEpfCandidates
    .filter((c) => c.consumed || (!c.isVoluntary && c.isExplicitPayslip))
    .reduce((sum, c) => sum + c.amount, 0);

  const duplicatePayslipSocsoTxSpent = standaloneSocsoCandidates
    .filter((c) => c.consumed || (!c.isVoluntary && c.isExplicitPayslip))
    .reduce((sum, c) => sum + c.amount, 0);

  // If user sets a manual annual override for Salary EPF or Salary SOCSO, deduplicate only against standalone payslip-duplicate transactions
  const effectivePayslipEpf =
    profile.epfFromSalaryOverride != null && Number.isFinite(profile.epfFromSalaryOverride)
      ? Math.max(0, Number(profile.epfFromSalaryOverride) - duplicatePayslipEpfTxSpent)
      : recordedPayslipEpf;

  const effectivePayslipSocso =
    profile.socsoFromSalaryOverride != null && Number.isFinite(profile.socsoFromSalaryOverride)
      ? Math.max(0, Number(profile.socsoFromSalaryOverride) - duplicatePayslipSocsoTxSpent)
      : recordedPayslipSocso;

  let totalSpentAllCategories = 0;
  let totalClaimableRelief = 0;
  let totalWithReceipts = 0;
  let totalMissingReceipts = 0;

  const byCategoryId: Record<string, LhdnCategoryProgress> = {};
  const categories: LhdnCategoryProgress[] = LHDN_TAX_CATEGORIES.map((cat) => {
    const txs = grouped.get(cat.id) || [];
    const limit = caps[cat.id] !== undefined ? caps[cat.id] : cat.defaultLimit;
    const txSpent = txs.reduce(
      (sum, t) => sum + getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount),
      0
    );

    let totalSpent = txSpent;
    let claimableAmount = Math.min(txSpent, limit);

    if (cat.id === 'epf_life') {
      // LHDN separates EPF (sub-limit RM 4,000) and Life Insurance/Takaful (sub-limit RM 3,000) within the RM 7,000 combined cap
      const totalEpfPortion = standaloneEpfTxSpent + effectivePayslipEpf;
      const totalLifePortion = standaloneLifeInsTxSpent;
      totalSpent = totalEpfPortion + totalLifePortion;

      const epfSublimit = limit === cat.defaultLimit ? LHDN_MANDATORY_EPF_SUBLIMIT : Math.min(limit, Math.max(LHDN_MANDATORY_EPF_SUBLIMIT, limit - LHDN_LIFE_INSURANCE_SUBLIMIT));
      const lifeSublimit = limit === cat.defaultLimit ? LHDN_LIFE_INSURANCE_SUBLIMIT : limit;

      const claimableEpf = Math.min(totalEpfPortion, epfSublimit);
      const claimableLife = Math.min(totalLifePortion, lifeSublimit);
      claimableAmount = Math.min(limit, claimableEpf + claimableLife);
    } else if (cat.id === 'socso_eis') {
      // LHDN SOCSO / PERKESO & EIS relief (separate RM 350 limit)
      totalSpent = standaloneSocsoTxSpent + effectivePayslipSocso;
      claimableAmount = Math.min(totalSpent, limit);
    }

    const remainingQuota = Math.max(0, limit - claimableAmount);
    const overAmount = Math.max(0, totalSpent - claimableAmount);
    const percentUsed = limit > 0 ? Math.min(100, (claimableAmount / limit) * 100) : 0;
    const isMaxedOut = limit > 0 && claimableAmount >= limit;
    const missingReceiptTransactions = txs.filter((t) => !t.receiptUrl);
    const missingReceiptCount = missingReceiptTransactions.length;
    const withReceiptCount = txs.length - missingReceiptCount;

    totalSpentAllCategories += totalSpent;
    totalClaimableRelief += claimableAmount;
    totalWithReceipts += withReceiptCount;
    totalMissingReceipts += missingReceiptCount;

    const progress: LhdnCategoryProgress = {
      category: cat,
      limit,
      totalSpent,
      claimableAmount,
      remainingQuota,
      remainingLimit: remainingQuota,
      overAmount,
      percentUsed,
      isMaxedOut,
      transactions: txs,
      withReceiptCount,
      attachedReceiptCount: withReceiptCount,
      missingReceiptCount,
      missingReceiptTransactions,
    };
    byCategoryId[cat.id] = progress;
    return progress;
  });

  // Malaysia LHDN Form BE Income, Reliefs, Rebates & Progressive Tax Estimation
  const isIncomeOverridden =
    profile.annualIncomeOverride != null && Number.isFinite(profile.annualIncomeOverride);
  const annualTaxableIncome = isIncomeOverridden
    ? Math.max(0, Number(profile.annualIncomeOverride))
    : recordedTaxableIncome;

  const isPcbOverridden =
    profile.pcbPaidOverride != null && Number.isFinite(profile.pcbPaidOverride);
  const totalPcbPaid = isPcbOverridden
    ? Math.max(0, Number(profile.pcbPaidOverride))
    : recordedPcbPaid;

  const individualBaseRelief = LHDN_INDIVIDUAL_BASE_RELIEF;
  const additionalReliefs =
    profile.additionalReliefsOverride != null && Number.isFinite(profile.additionalReliefsOverride)
      ? Math.max(0, Number(profile.additionalReliefsOverride))
      : 0;

  const additionalRebates =
    profile.additionalRebatesOverride != null && Number.isFinite(profile.additionalRebatesOverride)
      ? Math.max(0, Number(profile.additionalRebatesOverride))
      : recordedZakatRebate;

  const chargeableIncomeBeforeReliefs = Math.max(
    0,
    annualTaxableIncome - individualBaseRelief - additionalReliefs
  );
  const chargeableIncome = Math.max(
    0,
    annualTaxableIncome - individualBaseRelief - additionalReliefs - totalClaimableRelief
  );

  const taxBeforeReliefsCalc = calculateMalaysiaProgressiveTax(chargeableIncomeBeforeReliefs);
  const taxAfterReliefsCalc = calculateMalaysiaProgressiveTax(chargeableIncome);

  const grossTaxBeforeRebate = taxAfterReliefsCalc.grossTax;
  const statutoryRebate = taxAfterReliefsCalc.rebate;
  const totalTaxRebates = Math.min(grossTaxBeforeRebate, statutoryRebate + additionalRebates);

  const taxWithoutReliefs = Math.max(0, taxBeforeReliefsCalc.netTax - additionalRebates);
  const estimatedTaxPayable = Math.max(0, grossTaxBeforeRebate - totalTaxRebates);
  const actualTaxPayable = estimatedTaxPayable;

  const effectiveMarginalTaxRate =
    annualTaxableIncome > 0 ? taxAfterReliefsCalc.marginalRate : estimatedTaxRate;

  // When income is known, compute estimated LHDN progressive tax saved by your reliefs;
  // otherwise fall back to flat bracket estimate so the relief gauge still shows savings before income is entered.
  const estimatedTaxSaved =
    annualTaxableIncome > 0
      ? Math.max(0, taxWithoutReliefs - estimatedTaxPayable)
      : totalClaimableRelief * (estimatedTaxRate / 100);

  const netTaxDifference = totalPcbPaid - estimatedTaxPayable;
  const refundAmount = Math.max(0, netTaxDifference);
  const extraTaxToPay = Math.max(0, -netTaxDifference);
  const settlementStatus: 'refund' | 'pay_extra' | 'settled' =
    refundAmount > 0.005 ? 'refund' : extraTaxToPay > 0.005 ? 'pay_extra' : 'settled';

  return {
    year,
    categories,
    byCategoryId,
    totalSpentAllCategories,
    totalEligibleSpent: totalSpentAllCategories,
    totalClaimableRelief,
    totalClaimable: totalClaimableRelief,
    estimatedTaxRate,
    estimatedTaxSaved,
    totalTaxTransactions: allTaxTransactions.length,
    totalWithReceipts,
    attachedReceiptCount: totalWithReceipts,
    totalMissingReceipts,
    missingReceiptCount: totalMissingReceipts,
    allTaxTransactions,
    allMissingReceiptTransactions,

    recordedTaxableIncome,
    annualTaxableIncome,
    isIncomeOverridden,
    incomeTransactionCount,
    recordedPayslipEpf,
    effectivePayslipEpf,
    recordedPayslipSocso,
    effectivePayslipSocso,
    individualBaseRelief,
    additionalReliefs,
    recordedZakatRebate,
    additionalRebates,
    totalTaxRebates,
    chargeableIncomeBeforeReliefs,
    chargeableIncome,
    grossTaxBeforeRebate,
    statutoryRebate,
    taxWithoutReliefs,
    actualTaxPayable,
    estimatedTaxPayable,
    effectiveMarginalTaxRate,
    bracketLabel: taxAfterReliefsCalc.bracketLabel,
    recordedPcbPaid,
    totalPcbPaid,
    isPcbOverridden,
    netTaxDifference,
    refundAmount,
    extraTaxToPay,
    settlementStatus,
  };
}


