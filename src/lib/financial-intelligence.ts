import { getLocalDateString, getDaysInMonth, parseLocalDate, getTransactionRecordedInfo } from './date-helper.ts';
import { getAmountInBaseCurrency } from './currency.ts';
import { CANONICAL_EXPENSE_CATEGORIES } from './canonical-categories.ts';
import {
  isLumpSumExpense,
  isTripQuarantinedExpense,
  isDividendOrDistributionTransaction,
  getSavedCategoryCaps,
  resolveCategoryCapValue,
} from './category-budget-helper.ts';

export interface RecurringCommitmentItem {
  id: string;
  name: string;
  category: string;
  subCategory?: string;
  dayOfMonth: number;
  amount: number;
  effectiveFrom?: string;
  history?: Array<{ effectiveFrom?: string; amount?: number }>;
  notes?: string;
}

export interface SavedInstallmentItem {
  id: string;
  name: string;
  currency?: string;
  startDate?: string;
  endDate?: string;
  tripTag?: string;
  monthlyPayment?: number;
  monthlyAmount?: number;
  remainingMonths?: number;
}

function isRecurringActiveInMonth(comm: RecurringCommitmentItem, monthStr: string): boolean {
  if (!/^\d{4}-\d{2}$/.test(monthStr)) return true;
  const validHistory = Array.isArray(comm?.history)
    ? comm.history
        .map((h) => (typeof h?.effectiveFrom === 'string' ? h.effectiveFrom.slice(0, 7) : ''))
        .filter((m) => /^\d{4}-\d{2}$/.test(m))
    : [];
  const fallback = typeof comm?.effectiveFrom === 'string' ? comm.effectiveFrom.slice(0, 7) : '';
  const earliest = validHistory.length > 0 ? validHistory.sort()[0] : (/^\d{4}-\d{2}$/.test(fallback) ? fallback : '');
  return !earliest || monthStr >= earliest;
}

function getRecurringAmountForMonth(comm: RecurringCommitmentItem, monthStr: string): number {
  if (Array.isArray(comm?.history) && comm.history.length > 0) {
    const valid = comm.history.filter((h) => typeof h?.effectiveFrom === 'string' && h.effectiveFrom.length >= 7);
    if (valid.length > 0) {
      const sorted = [...valid].sort((a, b) => String(b.effectiveFrom).localeCompare(String(a.effectiveFrom)));
      const matched = sorted.find((h) => String(h.effectiveFrom).slice(0, 7) <= monthStr);
      const chosen = matched || sorted[sorted.length - 1];
      return Number(chosen?.amount) || 0;
    }
  }
  return Number(comm?.amount) || 0;
}

function getActiveInstallmentMonthlyMyr(inst: SavedInstallmentItem, monthStr: string): number {
  if (inst?.tripTag && isTripQuarantinedExpense({ tripTag: inst.tripTag })) return 0;
  if (typeof inst?.remainingMonths === 'number' && inst.remainingMonths <= 0) return 0;
  if (monthStr && /^\d{4}-\d{2}$/.test(monthStr)) {
    if (inst?.startDate && inst.startDate.slice(0, 7) > monthStr) return 0;
    if (inst?.endDate && inst.endDate.slice(0, 7) < monthStr) return 0;
  }
  const raw = Number(inst?.monthlyPayment ?? inst?.monthlyAmount ?? 0) || 0;
  if (raw <= 0) return 0;
  return getAmountInBaseCurrency(raw, inst?.currency || 'MYR');
}

function getStoredCommitments(): RecurringCommitmentItem[] {
  if (typeof window === 'undefined' && typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem('cashflow_recurring_commitments');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getStoredInstallments(): SavedInstallmentItem[] {
  if (typeof window === 'undefined' && typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem('cashflow_installment_plans');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function resolveIntelligenceLanguage(lang?: string): 'zh' | 'en' | 'ms' {
  if (lang === 'zh' || lang === 'en' || lang === 'ms') return lang;
  if (typeof window !== 'undefined') {
    try {
      const stored = localStorage.getItem('cashflow_preferred_language');
      if (stored === 'zh' || stored === 'en' || stored === 'ms') return stored;
      if (typeof navigator !== 'undefined') {
        const nav = (navigator.language || '').toLowerCase();
        if (nav.startsWith('ms') || nav.startsWith('id')) return 'ms';
        if (nav.startsWith('en')) return 'en';
      }
    } catch {}
  }
  return 'zh';
}

export interface MinimalTransactionRecord {
  id: string;
  date: string;
  amount: number;
  baseAmount?: number;
  type: string;
  category?: string;
  subCategory?: string;
  description?: string;
  merchant?: string;
  notes?: string;
  currency?: string;
  tripTag?: string;
  tripId?: string;
}

// -------------------------------------------------------------
// 1. 📊 AI 财务健康评分 (Financial Health Score Engine)
// -------------------------------------------------------------
export interface HealthDimension {
  name: string;
  score: number;
  maxScore: number;
  percentage: number;
  status: 'excellent' | 'good' | 'warning' | 'critical';
  details: string;
}

export interface FinancialHealthReport {
  totalScore: number; // 0 - 100
  grade: 'S' | 'A' | 'B' | 'C' | 'D';
  gradeLabel: string;
  summary: string;
  hasSufficientData?: boolean;
  dimensions: {
    savingsRate: HealthDimension;
    budgetDiscipline: HealthDimension;
    fixedCostBurden: HealthDimension;
    cashBuffer: HealthDimension;
  };
  recommendations: string[];
}

export function calculateFinancialHealthScore(params: {
  transactions: MinimalTransactionRecord[];
  allLedgerTransactions?: MinimalTransactionRecord[];
  monthlyBudgetCap?: number;
  baselineIncome?: number;
  emergencyFundBalance?: number;
  referenceDateStr?: string;
  targetMonthStr?: string;
  language?: 'zh' | 'en' | 'ms' | 'auto';
}): FinancialHealthReport {
  const {
    transactions,
    monthlyBudgetCap,
    baselineIncome,
    emergencyFundBalance = 0,
    referenceDateStr,
    targetMonthStr,
    language,
  } = params;

  const effLang = resolveIntelligenceLanguage(language);

  const todayStr = referenceDateStr || getLocalDateString();
  const currentMonthStr = targetMonthStr || todayStr.slice(0, 7);

  const currentExpenses = transactions.filter(
    (t) => String(t.type || '').toLowerCase() === 'expense' && t.date?.startsWith(currentMonthStr) && t.amount > 0
  );
  const currentIncome = transactions.filter(
    (t) =>
      String(t.type || '').toLowerCase() === 'income' &&
      t.date?.startsWith(currentMonthStr) &&
      t.amount > 0 &&
      !isDividendOrDistributionTransaction(t)
  );

  let totalExpense = 0;
  let lumpSumExpense = 0;
  let dailyVariableExpense = 0;

  for (const t of currentExpenses) {
    const amt = getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount);
    // Quarantine foreign/trip-tagged expenses from distorting domestic monthly budget pacing
    if (isTripQuarantinedExpense(t)) {
      lumpSumExpense += amt;
      totalExpense += amt;
      continue;
    }
    totalExpense += amt;
    if (isLumpSumExpense(t.category || 'Other', amt, t)) {
      lumpSumExpense += amt;
    } else {
      dailyVariableExpense += amt;
    }
  }

  const actualIncome = currentIncome.reduce(
    (sum, t) => sum + getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount),
    0
  );

  const effectiveIncome = actualIncome > 0 ? actualIncome : baselineIncome && baselineIncome > 0 ? baselineIncome : 0;

  // Dimension 1: Savings Rate (储蓄率: 30分)
  let savingsRateScore = 15;
  let savingsRatePct = 0;
  let savingsStatus: HealthDimension['status'] = 'warning';
  let savingsDetails =
    effLang === 'en'
      ? 'No income or baseline salary recorded yet (log income for accurate assessment)'
      : effLang === 'ms'
      ? 'Tiada pendapatan atau gaji asas direkodkan (rekod pendapatan untuk penilaian tepat)'
      : '尚未记录本月收入或基准月薪（建议记录收入以精准评估）';

  if (effectiveIncome > 0) {
    const netSavings = effectiveIncome - totalExpense;
    savingsRatePct = Math.round((netSavings / effectiveIncome) * 100);
    if (savingsRatePct >= 30) {
      savingsRateScore = 30;
      savingsStatus = 'excellent';
      savingsDetails =
        effLang === 'en'
          ? `Savings rate at ${savingsRatePct}% (excellent, well above 20% benchmark)`
          : effLang === 'ms'
          ? `Kadar simpanan ${savingsRatePct}% (cemerlang, jauh melebihi penanda aras 20%)`
          : `本月储蓄率达 ${savingsRatePct}%（优秀，远超 20% 标准）`;
    } else if (savingsRatePct >= 20) {
      savingsRateScore = 25;
      savingsStatus = 'good';
      savingsDetails =
        effLang === 'en'
          ? `Savings rate at ${savingsRatePct}% (healthy, meets 20% benchmark)`
          : effLang === 'ms'
          ? `Kadar simpanan ${savingsRatePct}% (sihat, mencapai penanda aras 20%)`
          : `本月储蓄率达 ${savingsRatePct}%（健康，达到 20% 标准）`;
    } else if (savingsRatePct >= 10) {
      savingsRateScore = 18;
      savingsStatus = 'warning';
      savingsDetails =
        effLang === 'en'
          ? `Savings rate at ${savingsRatePct}% (slightly low, consider trimming discretionary spending)`
          : effLang === 'ms'
          ? `Kadar simpanan ${savingsRatePct}% (agak rendah, kawal perbelanjaan budi bicara)`
          : `本月储蓄率为 ${savingsRatePct}%（略偏低，建议控制弹性开支）`;
    } else if (savingsRatePct >= 0) {
      savingsRateScore = 10;
      savingsStatus = 'warning';
      savingsDetails =
        effLang === 'en'
          ? `Near break-even this month (savings rate ${savingsRatePct}%), monitor spending closely`
          : effLang === 'ms'
          ? `Hampir pulang modal (kadar simpanan ${savingsRatePct}%), pantau perbelanjaan`
          : `本月接近收支平衡（储蓄率 ${savingsRatePct}%），注意控制支出`;
    } else {
      savingsRateScore = 0;
      savingsStatus = 'critical';
      savingsDetails =
        effLang === 'en'
          ? `Expenses exceeded income by ${Math.abs(savingsRatePct)}% this month (cashflow deficit)`
          : effLang === 'ms'
          ? `Perbelanjaan melebihi pendapatan sebanyak ${Math.abs(savingsRatePct)}% (defisit aliran tunai)`
          : `本月支出已超出收入 ${Math.abs(savingsRatePct)}%（出现财务赤字）`;
    }
  }

  // Dimension 2: Budget Adherence / Pacing (预算执行度: 25分)
  let budgetScore = 20;
  let budgetStatus: HealthDimension['status'] = 'good';
  let budgetDetails =
    effLang === 'en'
      ? 'No monthly budget set, tracking baseline spending pace'
      : effLang === 'ms'
      ? 'Tiada bajet bulanan ditetapkan, memantau perbelanjaan harian'
      : '未设定月度预算，按日常消费节奏平稳进行';

  const dayOfMonth = Math.max(1, parseInt(todayStr.slice(8, 10), 10) || 1);
  const totalDays = getDaysInMonth(
    parseInt(todayStr.slice(0, 4), 10) || 2026,
    parseInt(todayStr.slice(5, 7), 10) || 10
  );
  const daysRemaining = Math.max(0, totalDays - dayOfMonth);

  const savedCaps = getSavedCategoryCaps();
  const categoryCapsSum = CANONICAL_EXPENSE_CATEGORIES.reduce(
    (s, cat) => s + resolveCategoryCapValue(cat, savedCaps, 0),
    0
  );
  const effectiveBudgetCap =
    monthlyBudgetCap && monthlyBudgetCap > 0 ? monthlyBudgetCap : categoryCapsSum > 0 ? categoryCapsSum : 0;

  if (effectiveBudgetCap > 0) {
    const dailyVariablePace = dailyVariableExpense / dayOfMonth;
    const projectedEnd = lumpSumExpense + dailyVariableExpense + dailyVariablePace * daysRemaining;
    const paceRatio = projectedEnd / effectiveBudgetCap;

    if (paceRatio <= 0.9) {
      budgetScore = 25;
      budgetStatus = 'excellent';
      budgetDetails =
        effLang === 'en'
          ? `Projected to use ${Math.round(paceRatio * 100)}% of budget by month-end, buffer ample`
          : effLang === 'ms'
          ? `Dijangka menggunakan ${Math.round(paceRatio * 100)}% bajet menjelang akhir bulan, baki mencukupi`
          : `预计月底消耗预算 ${Math.round(paceRatio * 100)}%，预算节余充裕`;
    } else if (paceRatio <= 1.05) {
      budgetScore = 22;
      budgetStatus = 'good';
      budgetDetails =
        effLang === 'en'
          ? `Projected on-target at ${Math.round(paceRatio * 100)}% of budget by month-end, great execution`
          : effLang === 'ms'
          ? `Dijangka menepati bajet pada ${Math.round(paceRatio * 100)}% menjelang akhir bulan`
          : `预计月底刚好达成预算（${Math.round(paceRatio * 100)}%），执行力优秀`;
    } else if (paceRatio <= 1.2) {
      budgetScore = 14;
      budgetStatus = 'warning';
      budgetDetails =
        effLang === 'en'
          ? `Projected to exceed budget by ${Math.round((paceRatio - 1) * 100)}% at current pace, tighten spending`
          : effLang === 'ms'
          ? `Dijangka melebihi bajet sebanyak ${Math.round((paceRatio - 1) * 100)}% mengikut kadar semasa`
          : `按当前进度月底预计超支 ${Math.round((paceRatio - 1) * 100)}%，需适度紧缩`;
    } else {
      budgetScore = 5;
      budgetStatus = 'critical';
      budgetDetails =
        effLang === 'en'
          ? `Projected severe budget overrun >${Math.round((paceRatio - 1) * 100)}%, pause non-essential purchases`
          : effLang === 'ms'
          ? `Amaran: Dijangka terlebih belanja >${Math.round((paceRatio - 1) * 100)}%, henti belanja bukan keperluan`
          : `按当前进度月底预计严重超支 >${Math.round((paceRatio - 1) * 100)}%，请暂停非必要消费`;
    }
  }

  // Dimension 3: Fixed-Cost Burden (固定支出与负债负担率: 25分)
  const commitments = getStoredCommitments();
  const installments = getStoredInstallments();

  const fixedMonthlyBurn =
    commitments.reduce(
      (s, c) => s + (isRecurringActiveInMonth(c, currentMonthStr) ? getRecurringAmountForMonth(c, currentMonthStr) : 0),
      0
    ) +
    installments.reduce((s, i) => s + getActiveInstallmentMonthlyMyr(i, currentMonthStr), 0);

  let fixedScore = 22;
  let fixedStatus: HealthDimension['status'] = 'good';
  let fixedDetails =
    effLang === 'en'
      ? `Fixed commitments & installments ~RM ${fixedMonthlyBurn.toFixed(0)}/mo`
      : effLang === 'ms'
      ? `Komitmen tetap & ansuran ~RM ${fixedMonthlyBurn.toFixed(0)}/bln`
      : `固定扣款与分期共约 RM ${fixedMonthlyBurn.toFixed(0)}/月`;

  if (effectiveIncome > 0 && fixedMonthlyBurn > 0) {
    const fixedRatio = (fixedMonthlyBurn / effectiveIncome) * 100;
    if (fixedRatio <= 35) {
      fixedScore = 25;
      fixedStatus = 'excellent';
      fixedDetails =
        effLang === 'en'
          ? `Fixed costs are ${Math.round(fixedRatio)}% of income (excellent structure, resilient)`
          : effLang === 'ms'
          ? `Kos tetap adalah ${Math.round(fixedRatio)}% daripada pendapatan (struktur sangat baik)`
          : `固定支出占收入 ${Math.round(fixedRatio)}%（结构极佳，抗风险能力强）`;
    } else if (fixedRatio <= 50) {
      fixedScore = 20;
      fixedStatus = 'good';
      fixedDetails =
        effLang === 'en'
          ? `Fixed costs are ${Math.round(fixedRatio)}% of income (within safe 50% guideline)`
          : effLang === 'ms'
          ? `Kos tetap adalah ${Math.round(fixedRatio)}% daripada pendapatan (dalam penanda aras 50%)`
          : `固定支出占收入 ${Math.round(fixedRatio)}%（符合 50% 安全基准线）`;
    } else if (fixedRatio <= 65) {
      fixedScore = 12;
      fixedStatus = 'warning';
      fixedDetails =
        effLang === 'en'
          ? `Fixed costs are ${Math.round(fixedRatio)}% of income (heavy burden, cashflow pressure)`
          : effLang === 'ms'
          ? `Kos tetap adalah ${Math.round(fixedRatio)}% daripada pendapatan (bebanan agak tinggi)`
          : `固定支出占收入 ${Math.round(fixedRatio)}%（负担偏重，自由现金流受压）`;
    } else {
      fixedScore = 5;
      fixedStatus = 'critical';
      fixedDetails =
        effLang === 'en'
          ? `Fixed costs are ${Math.round(fixedRatio)}% of income (critical overload, liquidity risk)`
          : effLang === 'ms'
          ? `Kos tetap adalah ${Math.round(fixedRatio)}% daripada pendapatan (risiko kecairan)`
          : `固定支出占收入 ${Math.round(fixedRatio)}%（严重过载，面临现金流断裂风险）`;
    }
  }

  // Dimension 4: Cash & Emergency Buffer (应急安全垫: 20分)
  let bufferScore = 6;
  let bufferStatus: HealthDimension['status'] = 'warning';
  let bufferDetails =
    effLang === 'en'
      ? 'No emergency reserve recorded (recommended: 3-6 months living expenses)'
      : effLang === 'ms'
      ? 'Tiada rizab kecemasan direkodkan (cadangan: 3-6 bulan perbelanjaan hidup)'
      : '尚未记录应急储备金（建议设定或积累 3-6 个月生活备用金）';

  const monthlyBurnBaseline = Math.max(totalExpense, fixedMonthlyBurn, 500);
  if (emergencyFundBalance > 0) {
    const monthsCovered = emergencyFundBalance / monthlyBurnBaseline;
    if (monthsCovered >= 6) {
      bufferScore = 20;
      bufferStatus = 'excellent';
      bufferDetails =
        effLang === 'en'
          ? `Emergency fund covers ${monthsCovered.toFixed(1)} months of expenses (robust moat)`
          : effLang === 'ms'
          ? `Dana kecemasan menampung ${monthsCovered.toFixed(1)} bulan perbelanjaan (sangat kukuh)`
          : `应急备用金可覆盖 ${monthsCovered.toFixed(1)} 个月日常开支（护城河稳固）`;
    } else if (monthsCovered >= 3) {
      bufferScore = 16;
      bufferStatus = 'good';
      bufferDetails =
        effLang === 'en'
          ? `Emergency fund covers ${monthsCovered.toFixed(1)} months (meets 3-6 month standard)`
          : effLang === 'ms'
          ? `Dana kecemasan menampung ${monthsCovered.toFixed(1)} bulan (mencapai piawaian 3-6 bulan)`
          : `应急备用金可覆盖 ${monthsCovered.toFixed(1)} 个月（达到推荐的 3-6 个月标准）`;
    } else {
      bufferScore = 10;
      bufferStatus = 'warning';
      bufferDetails =
        effLang === 'en'
          ? `Emergency fund covers ${monthsCovered.toFixed(1)} months (aim for 3+ months)`
          : effLang === 'ms'
          ? `Dana kecemasan menampung ${monthsCovered.toFixed(1)} bulan (cadang tambah ke 3+ bulan)`
          : `应急备用金可覆盖 ${monthsCovered.toFixed(1)} 个月（建议补充至 3 个月以上）`;
    }
  }

  const hasSufficientData = effectiveIncome > 0 && emergencyFundBalance > 0;
  const totalScore = Math.min(100, Math.max(0, savingsRateScore + budgetScore + fixedScore + bufferScore));

  let grade: FinancialHealthReport['grade'] = 'A';
  let gradeLabel = '财务健康良好';
  let summary = '各项财务指标运行平稳，自由现金流充沛。';

  if (!hasSufficientData) {
    grade = 'D';
    gradeLabel = effLang === 'en' ? 'Insufficient Data' : effLang === 'ms' ? 'Data Tidak Mencukupi' : '数据不足，暂不评分';
    summary =
      effLang === 'en'
        ? 'No baseline income or emergency reserve recorded. Add them in Settings to unlock your financial health score.'
        : effLang === 'ms'
        ? 'Tiada rekod pendapatan asas atau dana kecemasan. Tambah dalam Tetapan untuk mendapatkan skor kesihatan kewangan.'
        : '暂无基准月收入或应急储备记录。在偏好设置中补充收入与应急金后，即可解锁精准评分。';
  } else if (totalScore >= 90) {
    grade = 'S';
    gradeLabel = effLang === 'en' ? 'Top Tier (Exceptional)' : effLang === 'ms' ? 'Cemerlang Teguh (Top Tier)' : '卓越稳健 (Top Tier)';
    summary =
      effLang === 'en'
        ? 'Savings rate and budget control are outstanding, with a deep financial safety moat.'
        : effLang === 'ms'
        ? 'Kadar simpanan dan kawalan bajet berada dalam keadaan cemerlang dengan benteng kewangan kukuh.'
        : '储蓄率与预算控制均处于极佳状态，财务护城河非常深厚。';
  } else if (totalScore >= 75) {
    grade = 'A';
    gradeLabel = effLang === 'en' ? 'Healthy' : effLang === 'ms' ? 'Sihat' : '健康良好 (Healthy)';
    summary =
      effLang === 'en'
        ? 'Income and expenses are well balanced, with a sound ratio between fixed and discretionary spending.'
        : effLang === 'ms'
        ? 'Imbangan pendapatan dan perbelanjaan terkawal dengan nisbah kos yang munasabah.'
        : '收支平衡控制得当，固定成本与日常弹性支出比例合理。';
  } else if (totalScore >= 60) {
    grade = 'B';
    gradeLabel = effLang === 'en' ? 'Moderate' : effLang === 'ms' ? 'Sederhana' : '稳中向好 (Moderate)';
    summary =
      effLang === 'en'
        ? 'Breaking even comfortably. Consider trimming unused subscriptions or boosting your savings rate.'
        : effLang === 'ms'
        ? 'Mengekalkan imbangan. Pertimbangkan untuk memotong langganan terbiar atau meningkatkan simpanan bulanan.'
        : '基本保持收支平衡，建议优化非必要订阅或适度提高每月储蓄比。';
  } else if (totalScore >= 45) {
    grade = 'C';
    gradeLabel = effLang === 'en' ? 'Tight' : effLang === 'ms' ? 'Ketat' : '稍显吃紧 (Tight)';
    summary =
      effLang === 'en'
        ? 'Budget or fixed cost burden is heavy; watch out for month-end cashflow pinches.'
        : effLang === 'ms'
        ? 'Beban bajet atau komitmen agak berat, berhati-hati terhadap kekurangan tunai akhir bulan.'
        : '预算执行或固定扣款负担较重，需注意防范月底现金流缺口。';
  } else {
    grade = 'D';
    gradeLabel = effLang === 'en' ? 'Attention Needed' : effLang === 'ms' ? 'Perlu Perhatian' : '需要关注 (Attention Needed)';
    summary =
      effLang === 'en'
        ? 'Spending pace exceeds cash inflow. Review idle deductions and pause large discretionary expenses.'
        : effLang === 'ms'
        ? 'Kadar perbelanjaan melebihi aliran masuk tunai. Semak potongan terbiar dan tangguhkan belanja besar.'
        : '支出增速高于资金供给，建议立即检查闲置扣款并暂停大额非必要开支。';
  }

  const recommendations: string[] = [];
  if (savingsStatus === 'critical' || savingsStatus === 'warning') {
    recommendations.push(
      effLang === 'en'
        ? 'Low savings pace: Prioritize trimming discretionary dining and entertainment to lock in base monthly savings.'
        : effLang === 'ms'
        ? 'Simpanan rendah: Kurangkan perbelanjaan makanan luar dan hiburan untuk mengunci simpanan asas.'
        : '本月储蓄偏弱：建议优先削减餐饮与娱乐等弹性开销，锁定每月基本积蓄。'
    );
  }
  if (fixedStatus === 'warning' || fixedStatus === 'critical') {
    recommendations.push(
      effLang === 'en'
        ? 'High fixed burden: Audit recurring subscriptions and installment plans to eliminate unused monthly drains.'
        : effLang === 'ms'
        ? 'Beban tetap tinggi: Semak semula perkhidmatan langganan dan ansuran untuk membersihkan caj terbiar.'
        : '固定负担偏高：建议全面审视订阅服务与分期计划，清理长期不用的扣费。'
    );
  }
  if (budgetStatus === 'warning' || budgetStatus === 'critical') {
    recommendations.push(
      effLang === 'en'
        ? 'Budget overrun risk: Set a daily spending cap for the remaining days to keep your total within limits.'
        : effLang === 'ms'
        ? 'Risiko belanja lebih: Tetapkan had perbelanjaan harian untuk hari-hari berbaki bulan ini.'
        : '进度有超支风险：距月底还有部分时日，可设置单日消费上限以拉平总进度。'
    );
  }
  if (recommendations.length === 0) {
    recommendations.push(
      effLang === 'en'
        ? 'Finances are operating very smoothly! Consider routing surplus cash into emergency savings or low-risk assets.'
        : effLang === 'ms'
        ? 'Kewangan berjalan dengan sangat lancar! Pertimbangkan untuk menyalurkan lebihan ke dana kecemasan.'
        : '当前财务运转非常健康！可考虑将节余资金按计划转入应急储蓄或低风险理财。'
    );
    recommendations.push(
      effLang === 'en'
        ? 'Keep logging regularly; continuous financial visibility is the foundation of long-term wealth.'
        : effLang === 'ms'
        ? 'Teruskan tabiat mencatat; ketelusan aliran tunai adalah benteng terbaik pertumbuhan aset.'
        : '继续保持记账习惯，良好的资金透明度是实现资产增长的最佳护城河。'
    );
  }

  const dimensionLabels =
    effLang === 'en'
      ? { savings: 'Savings & Cash Retention', budget: 'Budget Discipline', fixed: 'Fixed Burden Ratio', buffer: 'Emergency Buffer' }
      : effLang === 'ms'
      ? { savings: 'Kadar Simpanan & Baki', budget: 'Disiplin Bajet', fixed: 'Nisbah Beban Tetap', buffer: 'Penampan Kecemasan' }
      : { savings: '储蓄与节余率', budget: '预算执行力', fixed: '固定成本负债比', buffer: '现金与应急缓冲' };

  return {
    totalScore: hasSufficientData ? totalScore : 0,
    hasSufficientData,
    grade,
    gradeLabel,
    summary,
    dimensions: {
      savingsRate: {
        name: dimensionLabels.savings,
        score: savingsRateScore,
        maxScore: 30,
        percentage: Math.round((savingsRateScore / 30) * 100),
        status: savingsStatus,
        details: savingsDetails,
      },
      budgetDiscipline: {
        name: dimensionLabels.budget,
        score: budgetScore,
        maxScore: 25,
        percentage: Math.round((budgetScore / 25) * 100),
        status: budgetStatus,
        details: budgetDetails,
      },
      fixedCostBurden: {
        name: dimensionLabels.fixed,
        score: fixedScore,
        maxScore: 25,
        percentage: Math.round((fixedScore / 25) * 100),
        status: fixedStatus,
        details: fixedDetails,
      },
      cashBuffer: {
        name: dimensionLabels.buffer,
        score: bufferScore,
        maxScore: 20,
        percentage: Math.round((bufferScore / 20) * 100),
        status: bufferStatus,
        details: bufferDetails,
      },
    },
    recommendations: recommendations.slice(0, 3),
  };
}

// -------------------------------------------------------------
// 2. 🔮 预测性现金流预报 (Predictive Cashflow Trajectory)
// -------------------------------------------------------------
export interface CashflowForecastPoint {
  dayOffset: number;
  dateStr: string;
  projectedBalance: number;
  projectedOutflow: number;
  projectedInflow: number;
  notes?: string;
}

export interface CashflowForecastResult {
  currentCashEstimate: number;
  dailyBurnRate: number;
  fixedMonthlyCommitments: number;
  forecast30Days: CashflowForecastPoint[];
  forecast60DaysBalance: number;
  forecast90DaysBalance: number;
  lowestProjectedPoint: {
    dateStr: string;
    balance: number;
    dayOffset: number;
  };
  status: 'safe' | 'tight' | 'deficit_warning';
  insightMessage: string;
}

export function predictCashflowTrajectory(params: {
  transactions: MinimalTransactionRecord[];
  startingCash?: number;
  baselineMonthlyIncome?: number;
  paydayDay?: number | null;
  commitmentsOverride?: RecurringCommitmentItem[];
  installmentsOverride?: SavedInstallmentItem[];
  referenceDateStr?: string;
  isStartingCashConfigured?: boolean;
  language?: 'zh' | 'en' | 'ms' | 'auto';
}): CashflowForecastResult {
  const {
    transactions,
    startingCash = 0,
    baselineMonthlyIncome = 0,
    paydayDay,
    commitmentsOverride,
    installmentsOverride,
    referenceDateStr,
    isStartingCashConfigured = false,
    language,
  } = params;

  const effLang = resolveIntelligenceLanguage(language);

  const todayStr = referenceDateStr || getLocalDateString();
  const today = parseLocalDate(todayStr);

  const sixtyDaysAgo = new Date(today);
  sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
  const sixtyDaysAgoStr = getLocalDateString(sixtyDaysAgo);

  const recentExpenses = (transactions || []).filter(
    (t) => String(t.type || '').toLowerCase() === 'expense' && t.date >= sixtyDaysAgoStr && t.amount > 0
  );

  const totalRecentExpense = recentExpenses.reduce(
    (sum, t) => sum + getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount),
    0
  );

  // Exclude large one-off expenses (> RM 1,500), fixed bills, AND quarantined trip expenses
  const normalizedExpenses = recentExpenses.filter(
    (t) =>
      getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount) <= 1500 &&
      !isLumpSumExpense(t.category || 'Other', getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount), t) &&
      !isTripQuarantinedExpense(t)
  );
  const normalizedTotal = normalizedExpenses.reduce(
    (sum, t) => sum + getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount),
    0
  );

  const dailyDiscretionaryBurn =
    normalizedTotal > 0
      ? Number((normalizedTotal / 60).toFixed(2))
      : totalRecentExpense > 0
      ? Number((totalRecentExpense / 60).toFixed(2))
      : 0;

  const commitments: RecurringCommitmentItem[] = commitmentsOverride || getStoredCommitments();
  const installments: SavedInstallmentItem[] = installmentsOverride || getStoredInstallments();
  const currentMonthStr = todayStr.slice(0, 7);

  const totalMonthlyFixed =
    commitments.reduce(
      (s, c) => s + (isRecurringActiveInMonth(c, currentMonthStr) ? getRecurringAmountForMonth(c, currentMonthStr) : 0),
      0
    ) +
    installments.reduce((s, i) => s + getActiveInstallmentMonthlyMyr(i, currentMonthStr), 0);

  let runningBalance = startingCash;
  const forecastPoints: CashflowForecastPoint[] = [];
  let lowestPoint = {
    dateStr: todayStr,
    balance: runningBalance,
    dayOffset: 0,
  };

  let forecast60Bal = runningBalance;
  let forecast90Bal = runningBalance;

  for (let offset = 1; offset <= 90; offset++) {
    const curDate = new Date(today);
    curDate.setDate(curDate.getDate() + offset);
    const curDateStr = getLocalDateString(curDate);
    const curMonthStr = curDateStr.slice(0, 7);
    const dayOfMonth = curDate.getDate();

    let dayInflow = 0;
    let dayOutflow = dailyDiscretionaryBurn;
    const noteItems: string[] = [];

    if (
      typeof paydayDay === 'number' &&
      paydayDay >= 1 &&
      paydayDay <= 31 &&
      dayOfMonth === paydayDay &&
      baselineMonthlyIncome > 0
    ) {
      dayInflow += baselineMonthlyIncome;
      noteItems.push(`预计收入入账: +${baselineMonthlyIncome}`);
    }

    for (const comm of commitments) {
      if (!isRecurringActiveInMonth(comm, curMonthStr)) continue;
      const commAmt = getRecurringAmountForMonth(comm, curMonthStr);
      if (comm.dayOfMonth === dayOfMonth && commAmt > 0) {
        dayOutflow += commAmt;
        noteItems.push(`${comm.name}: -${commAmt.toFixed(2)}`);
      }
    }

    if (dayOfMonth === 1 && installments.length > 0) {
      const instSum = installments.reduce((s, i) => s + getActiveInstallmentMonthlyMyr(i, curMonthStr), 0);
      if (instSum > 0) {
        dayOutflow += instSum;
        noteItems.push(`分期还款合集: -${instSum.toFixed(2)}`);
      }
    }

    runningBalance = Number((runningBalance + dayInflow - dayOutflow).toFixed(2));

    if (offset <= 30) {
      forecastPoints.push({
        dayOffset: offset,
        dateStr: curDateStr,
        projectedBalance: runningBalance,
        projectedOutflow: Number(dayOutflow.toFixed(2)),
        projectedInflow: Number(dayInflow.toFixed(2)),
        notes: noteItems.length > 0 ? noteItems.join(', ') : undefined,
      });
    }

    if (offset === 60) forecast60Bal = runningBalance;
    if (offset === 90) forecast90Bal = runningBalance;

    if (runningBalance < lowestPoint.balance) {
      lowestPoint = {
        dateStr: curDateStr,
        balance: runningBalance,
        dayOffset: offset,
      };
    }
  }

  let status: CashflowForecastResult['status'] = 'safe';
  let insightMessage =
    effLang === 'en'
      ? 'Cash flow is healthy for the next 90 days with no liquidity risks.'
      : effLang === 'ms'
      ? 'Aliran tunai kukuh untuk 90 hari akan datang tanpa risiko kecairan.'
      : '未来 90 天现金流充裕，收支结构稳固，无流动性风险。';

  if (startingCash <= 0 && baselineMonthlyIncome <= 0 && totalMonthlyFixed === 0 && dailyDiscretionaryBurn === 0) {
    status = 'tight';
    insightMessage =
      effLang === 'en'
        ? 'Few transactions recorded. Log your daily expenses or set starting cash to generate a forecast.'
        : effLang === 'ms'
        ? 'Transaksi masih sedikit. Rekod perbelanjaan atau tetapkan baki tunai permulaan.'
        : '账本流水尚少，请先记录日常开支或设定流动资金以生成预测。';
  } else if (!isStartingCashConfigured && startingCash <= 0) {
    status = 'tight';
    insightMessage =
      effLang === 'en'
        ? `Starting from net ledger balance (RM ${startingCash.toFixed(0)}). Add initial cash in Settings for a more accurate trajectory.`
        : effLang === 'ms'
        ? `Bermula dari baki bersih lejar (RM ${startingCash.toFixed(0)}). Tambah baki tunai dalam Tetapan untuk unjuran lebih tepat.`
        : `当前以账本累计净结余（RM ${startingCash.toFixed(0)}）起算，建议在备用金或设置中补充初始资金，获得更准确走势。`;
  } else if (lowestPoint.balance < 0) {
    status = 'deficit_warning';
    insightMessage =
      effLang === 'en'
        ? `⚠️ Warning: Projected cash deficit of ~RM ${Math.abs(lowestPoint.balance).toFixed(0)} on day ${lowestPoint.dayOffset} (${lowestPoint.dateStr}). Reserve funds in advance.`
        : effLang === 'ms'
        ? `⚠️ Amaran: Unjuran kekurangan tunai ~RM ${Math.abs(lowestPoint.balance).toFixed(0)} pada hari ke-${lowestPoint.dayOffset} (${lowestPoint.dateStr}). Sediakan dana lebih awal.`
        : `⚠️ 预警：预计在第 ${lowestPoint.dayOffset} 天（${lowestPoint.dateStr}）可能出现资金缺口（约 RM ${Math.abs(lowestPoint.balance).toFixed(0)}），请提前预留资金。`;
  } else if (lowestPoint.balance < (startingCash > 0 ? startingCash * 0.2 : 500)) {
    status = 'tight';
    insightMessage =
      effLang === 'en'
        ? `💡 Tip: Balance will dip to a low of RM ${lowestPoint.balance.toFixed(0)} on day ${lowestPoint.dayOffset} (${lowestPoint.dateStr}). Maintain buffer.`
        : effLang === 'ms'
        ? `💡 Tip: Baki akan menyusut ke paras rendah RM ${lowestPoint.balance.toFixed(0)} pada hari ke-${lowestPoint.dayOffset} (${lowestPoint.dateStr}).`
        : `💡 提示：第 ${lowestPoint.dayOffset} 天（${lowestPoint.dateStr}）余额将降至低位（RM ${lowestPoint.balance.toFixed(0)}），需注意缓冲。`;
  }

  if (paydayDay == null && baselineMonthlyIncome > 0) {
    const note =
      effLang === 'en'
        ? ' (Payday not set; projected income is not booked. Set payday in Settings to include salary)'
        : effLang === 'ms'
        ? ' (Hari gaji belum ditetapkan; unjuran gaji belum dimasukkan. Tetapkan hari gaji dalam Tetapan)'
        : '（发薪日未指定，预测暂未计入薪水入账，可在设置中补充发薪日以完善预测）';
    insightMessage = `${insightMessage}${note}`;
  }

  return {
    currentCashEstimate: startingCash,
    dailyBurnRate: dailyDiscretionaryBurn,
    fixedMonthlyCommitments: totalMonthlyFixed,
    forecast30Days: forecastPoints,
    forecast60DaysBalance: forecast60Bal,
    forecast90DaysBalance: forecast90Bal,
    lowestProjectedPoint: lowestPoint,
    status,
    insightMessage,
  };
}

// -------------------------------------------------------------
// 3. 🔄 自动发现周期性消费 (Auto-Discover Recurring Expenses)
// -------------------------------------------------------------
export interface DiscoveredRecurringCandidate {
  id: string;
  name: string;
  category: string;
  detectedDayOfMonth: number;
  averageAmount: number;
  occurrencesCount: number;
  lastDate: string;
  isAlreadyTracked: boolean;
  confidence: number;
}

export function discoverUnmarkedRecurringExpenses(
  allTransactions: MinimalTransactionRecord[],
  existingCommitments?: RecurringCommitmentItem[]
): DiscoveredRecurringCandidate[] {
  if (!Array.isArray(allTransactions) || allTransactions.length < 3) return [];

  const existingNames = new Set(
    (existingCommitments || []).map((c) => c.name.trim().toLowerCase())
  );

  const groups = new Map<string, {
    canonicalName: string;
    category: string;
    records: Array<{ date: string; amount: number; day: number; month: string }>;
  }>();

  for (const tx of allTransactions) {
    if (!tx || String(tx.type || '').toLowerCase() === 'income' || !tx.amount || tx.amount <= 0 || !tx.date) continue;

    const rawName = (tx.description || tx.merchant || '').trim();
    if (!rawName || rawName.length < 2) continue;

    const cleanKey = rawName.toLowerCase().replace(/\s+/g, ' ');
    const txDate = tx.date.slice(0, 10);
    const day = parseInt(txDate.slice(8, 10), 10);
    const month = txDate.slice(0, 7);

    if (!groups.has(cleanKey)) {
      groups.set(cleanKey, {
        canonicalName: rawName,
        category: tx.category || 'Other',
        records: [],
      });
    }

    groups.get(cleanKey)!.records.push({
      date: txDate,
      amount: getAmountInBaseCurrency(tx.amount, tx.currency, tx.baseAmount),
      day,
      month,
    });
  }

  const discovered: DiscoveredRecurringCandidate[] = [];

  for (const [key, data] of groups.entries()) {
    const uniqueMonths = new Set(data.records.map((r) => r.month));
    if (uniqueMonths.size < 2) continue;

    const amounts = data.records.map((r) => r.amount);
    const avgAmount = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const maxAmount = Math.max(...amounts);
    const minAmount = Math.min(...amounts);

    const amountVarianceRatio = (maxAmount - minAmount) / Math.max(1, avgAmount);
    if (amountVarianceRatio > 0.35 && uniqueMonths.size < 3) continue;

    const days = data.records.map((r) => r.day).sort((a, b) => a - b);
    const medianDay = days[Math.floor(days.length / 2)];

    const isAlreadyTracked =
      existingNames.has(key) ||
      Array.from(existingNames).some((en) => en.includes(key) || key.includes(en));

    const sortedRecords = [...data.records].sort((a, b) => b.date.localeCompare(a.date));
    const lastDate = sortedRecords[0].date;

    const confidence = Math.min(
      0.98,
      Number((0.6 + uniqueMonths.size * 0.1 - amountVarianceRatio * 0.2).toFixed(2))
    );

    discovered.push({
      id: `discovered_${key.replace(/[^a-z0-9]/g, '_')}`,
      name: data.canonicalName,
      category: data.category,
      detectedDayOfMonth: medianDay,
      averageAmount: Number(avgAmount.toFixed(2)),
      occurrencesCount: data.records.length,
      lastDate,
      isAlreadyTracked,
      confidence,
    });
  }

  return discovered.sort((a, b) => {
    if (a.isAlreadyTracked !== b.isAlreadyTracked) {
      return a.isAlreadyTracked ? 1 : -1;
    }
    return b.occurrencesCount - a.occurrencesCount;
  });
}

// -------------------------------------------------------------
// 4. 🏷️ 上下文智能标签 (Contextual Smart Tags)
// -------------------------------------------------------------
export interface ContextualTagInfo {
  timeSlotTag: string;
  dayTypeTag: '工作日' | '周末';
  natureTag: '固定/周期' | '日常弹性';
  holidayTag?: string;
}

const PUBLIC_HOLIDAYS_MY: Record<string, string> = {
  '01-01': '元旦 (New Year)',
  '02-01': '联邦直辖区日',
  '05-01': '劳动节 (Labour Day)',
  '08-31': '马来西亚国庆 (Merdeka)',
  '09-16': '马来西亚日 (Malaysia Day)',
  '12-25': '圣诞节 (Christmas)',
};

export function getContextualSmartTag(
  txDate: string,
  category?: string,
  description?: string,
  currentHour?: number,
  txIdOrNotes?: string,
  subCategory?: string
): ContextualTagInfo {
  const dateObj = parseLocalDate(txDate);
  const dayOfWeek = Number.isNaN(dateObj.getTime()) ? 1 : dateObj.getDay();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const catLower = (category || '').toLowerCase();
  const subLower = (subCategory || '').toLowerCase();

  let detectedHour = typeof currentHour === 'number' ? currentHour : null;

  if (detectedHour === null && txIdOrNotes) {
    const recorded = getTransactionRecordedInfo({ id: txIdOrNotes, date: txDate });
    if (recorded?.timestampMs) {
      detectedHour = new Date(recorded.timestampMs).getHours();
    }
  }

  if (detectedHour === null) {
    const combinedStr = `${description || ''} ${txIdOrNotes || ''}`;
    const timeMatch = combinedStr.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
    if (timeMatch) {
      detectedHour = parseInt(timeMatch[1], 10);
    }
  }

  const isFoodCategory =
    catLower.includes('food') ||
    catLower.includes('dining') ||
    catLower.includes('餐饮') ||
    catLower.includes('吃');

  let timeSlotTag = isWeekend ? '✨ 周末支出' : '✨ 工作日支出';

  if (isFoodCategory) {
    if (detectedHour !== null) {
      if (detectedHour >= 5 && detectedHour < 11) {
        timeSlotTag = '☕ 早餐时段';
      } else if (detectedHour >= 11 && detectedHour < 15) {
        timeSlotTag = isWeekend ? '🍱 周末午餐' : '🍱 工作日午餐';
      } else if (detectedHour >= 15 && detectedHour < 18) {
        timeSlotTag = '🧋 下午茶';
      } else if (detectedHour >= 18 && detectedHour < 22) {
        timeSlotTag = '🍲 晚餐聚餐';
      } else {
        timeSlotTag = '🌙 深夜/宵夜';
      }
    } else if (subLower.includes('breakfast') || subLower.includes('早餐')) {
      timeSlotTag = '☕ 早餐时段';
    } else if (subLower.includes('lunch') || subLower.includes('午餐')) {
      timeSlotTag = isWeekend ? '🍱 周末午餐' : '🍱 工作日午餐';
    } else if (subLower.includes('tea') || subLower.includes('下午茶')) {
      timeSlotTag = '🧋 下午茶';
    } else if (subLower.includes('dinner') || subLower.includes('晚餐')) {
      timeSlotTag = '🍲 晚餐聚餐';
    } else if (subLower.includes('supper') || subLower.includes('宵夜') || subLower.includes('夜宵')) {
      timeSlotTag = '🌙 深夜/宵夜';
    } else {
      timeSlotTag = isWeekend ? '🍽️ 周末餐饮' : '🍽️ 日常餐饮';
    }
  } else {
    const activeSub = subCategory?.trim() || '';
    if (catLower.includes('sport') || catLower.includes('健身') || catLower.includes('运动')) {
      timeSlotTag = activeSub ? `🏸 ${activeSub}` : isWeekend ? '🏅 周末运动' : '🏅 运动健身';
    } else if (catLower.includes('transport') || catLower.includes('交通') || catLower.includes('出行')) {
      timeSlotTag = activeSub ? `🚗 ${activeSub}` : '🚗 交通出行';
    } else if (catLower.includes('shopping') || catLower.includes('购物') || catLower.includes('消费')) {
      timeSlotTag = activeSub ? `🛍️ ${activeSub}` : '🛍️ 日常消费';
    } else if (catLower.includes('entertain') || catLower.includes('娱乐')) {
      timeSlotTag = activeSub ? `🎮 ${activeSub}` : '🎮 休闲娱乐';
    } else if (catLower.includes('health') || catLower.includes('医疗') || catLower.includes('健康')) {
      timeSlotTag = activeSub ? `💊 ${activeSub}` : '💊 医疗健康';
    } else if (catLower.includes('housing') || catLower.includes('bill') || catLower.includes('居家') || catLower.includes('水电')) {
      timeSlotTag = activeSub ? `🏠 ${activeSub}` : '🏠 居家日常';
    } else if (catLower.includes('educat') || catLower.includes('学习') || catLower.includes('教育')) {
      timeSlotTag = activeSub ? `📚 ${activeSub}` : '📚 学习进修';
    } else if (catLower.includes('gift') || catLower.includes('人情') || catLower.includes('礼物')) {
      timeSlotTag = activeSub ? `🎁 ${activeSub}` : '🎁 人情往来';
    } else {
      timeSlotTag = isWeekend ? '✨ 周末支出' : '✨ 工作日支出';
    }
  }

  const isFixedCategory =
    catLower.includes('bill') ||
    catLower.includes('housing') ||
    catLower.includes('insurance') ||
    catLower.includes('rental') ||
    catLower.includes('sub') ||
    catLower.includes('fixed') ||
    catLower.includes('固定');
  const natureTag = isFixedCategory ? '固定/周期' : '日常弹性';

  const monthDay = txDate.slice(5, 10);
  const holidayTag = PUBLIC_HOLIDAYS_MY[monthDay];

  return {
    timeSlotTag,
    dayTypeTag: isWeekend ? '周末' : '工作日',
    natureTag,
    holidayTag,
  };
}

// -------------------------------------------------------------
// 5. 📋 AI 智能简报 (Weekly & Monthly Financial Briefing)
// -------------------------------------------------------------
export interface FinancialBriefingResult {
  periodLabel: string;
  totalSpending: number;
  topCategoryName: string;
  topCategoryAmount: number;
  topCategoryRatio: number;
  largestExpense: {
    description: string;
    amount: number;
    date: string;
  } | null;
  highlights: string[];
  riskAlerts: string[];
  upcomingCommitmentsTotal: number;
  actionableTip: string;
}

export function generateAiFinancialBriefing(
  transactions: MinimalTransactionRecord[],
  targetMonthStr?: string,
  budgetCap?: number,
  userLanguage?: 'zh' | 'en' | 'ms' | 'auto'
): FinancialBriefingResult {
  const effLang = resolveIntelligenceLanguage(userLanguage);
  const currentMonth = targetMonthStr || getLocalDateString().slice(0, 7);
  const monthExpenses = (transactions || []).filter(
    (t) => String(t.type || '').toLowerCase() === 'expense' && t.date?.startsWith(currentMonth) && t.amount > 0
  );

  const totalSpending = Number(
    monthExpenses
      .reduce((sum, t) => sum + getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount), 0)
      .toFixed(2)
  );

  const catMap = new Map<string, number>();
  for (const t of monthExpenses) {
    const cat = t.category || 'Other';
    catMap.set(cat, (catMap.get(cat) || 0) + getAmountInBaseCurrency(t.amount, t.currency, t.baseAmount));
  }

  let topCategoryName = effLang === 'en' ? 'No spending' : effLang === 'ms' ? 'Tiada perbelanjaan' : '无支出';
  let topCategoryAmount = 0;
  for (const [cat, amt] of catMap.entries()) {
    if (amt > topCategoryAmount) {
      topCategoryAmount = amt;
      topCategoryName = cat;
    }
  }

  const topCategoryRatio = totalSpending > 0 ? Math.round((topCategoryAmount / totalSpending) * 100) : 0;

  let largestExpense: FinancialBriefingResult['largestExpense'] = null;
  const sortedByAmt = [...monthExpenses].sort(
    (a, b) =>
      getAmountInBaseCurrency(b.amount, b.currency, b.baseAmount) -
      getAmountInBaseCurrency(a.amount, a.currency, a.baseAmount)
  );
  if (sortedByAmt.length > 0) {
    const topTx = sortedByAmt[0];
    largestExpense = {
      description:
        topTx.description ||
        topTx.category ||
        (effLang === 'en' ? 'Large Expense' : effLang === 'ms' ? 'Belanja Besar' : '大额支出'),
      amount: Number(getAmountInBaseCurrency(topTx.amount, topTx.currency, topTx.baseAmount).toFixed(2)),
      date: topTx.date,
    };
  }

  const highlights: string[] = [];
  if (totalSpending > 0) {
    highlights.push(
      effLang === 'en'
        ? `Recorded ${monthExpenses.length} expenses totaling RM ${totalSpending.toLocaleString('en-MY', { minimumFractionDigits: 2 })}.`
        : effLang === 'ms'
        ? `Merekodkan ${monthExpenses.length} perbelanjaan berjumlah RM ${totalSpending.toLocaleString('en-MY', { minimumFractionDigits: 2 })}.`
        : `累计记录支出 ${monthExpenses.length} 笔，总开销 RM ${totalSpending.toLocaleString('en-MY', { minimumFractionDigits: 2 })}。`
    );
  }
  if (topCategoryAmount > 0) {
    highlights.push(
      effLang === 'en'
        ? `Primary spending in "${topCategoryName}", totaling RM ${topCategoryAmount.toFixed(2)} (${topCategoryRatio}%).`
        : effLang === 'ms'
        ? `Perbelanjaan utama dalam "${topCategoryName}", berjumlah RM ${topCategoryAmount.toFixed(2)} (${topCategoryRatio}%).`
        : `主要支出集中在「${topCategoryName}」，共消费 RM ${topCategoryAmount.toFixed(2)}（占比 ${topCategoryRatio}%）。`
    );
  }
  if (largestExpense) {
    highlights.push(
      effLang === 'en'
        ? `Largest single expense: "${largestExpense.description}" RM ${largestExpense.amount.toFixed(2)} (${largestExpense.date}).`
        : effLang === 'ms'
        ? `Perbelanjaan tunggal terbesar: "${largestExpense.description}" RM ${largestExpense.amount.toFixed(2)} (${largestExpense.date}).`
        : `单笔最大支出为「${largestExpense.description}」RM ${largestExpense.amount.toFixed(2)}（${largestExpense.date}）。`
    );
  }

  const riskAlerts: string[] = [];
  if (budgetCap && budgetCap > 0 && totalSpending > budgetCap * 0.85) {
    const pct = Math.round((totalSpending / budgetCap) * 100);
    riskAlerts.push(
      effLang === 'en'
        ? `Spending reached ${pct}% of monthly budget; pace yourself for the remaining days.`
        : effLang === 'ms'
        ? `Perbelanjaan mencapai ${pct}% daripada bajet bulanan; kawal perbelanjaan untuk baki hari.`
        : `本月支出已达到设定预算的 ${pct}%，余下天数需控制节奏。`
    );
  }

  const commitments = getStoredCommitments();
  const upcomingCommitmentsTotal = commitments.reduce(
    (s, c) => s + (isRecurringActiveInMonth(c, currentMonth) ? getRecurringAmountForMonth(c, currentMonth) : 0),
    0
  );

  const remainingBudgetText =
    budgetCap && budgetCap > 0
      ? effLang === 'en'
        ? `RM ${(budgetCap - totalSpending).toFixed(2)} remaining until monthly budget cap.`
        : effLang === 'ms'
        ? `Baki RM ${(budgetCap - totalSpending).toFixed(2)} sebelum mencapai had bajet.`
        : `当前距离预算上限还剩 RM ${(budgetCap - totalSpending).toFixed(2)}。`
      : effLang === 'en'
      ? 'No monthly budget cap set.'
      : effLang === 'ms'
      ? 'Tiada had bajet bulanan ditetapkan.'
      : '暂未设定月度预算上限。';

  const actionableTip =
    totalSpending > 0
      ? effLang === 'en'
        ? `Assistant insight: Month-to-date spending is RM ${totalSpending.toFixed(2)}, with "${topCategoryName}" taking ${topCategoryRatio}% (RM ${topCategoryAmount.toFixed(2)}). ${remainingBudgetText}`
        : effLang === 'ms'
        ? `Pandangan Pembantu: Perbelanjaan bulan ini RM ${totalSpending.toFixed(2)}, "${topCategoryName}" merangkumi ${topCategoryRatio}% (RM ${topCategoryAmount.toFixed(2)}). ${remainingBudgetText}`
        : `智能管家依据：本月累计已支出 RM ${totalSpending.toFixed(2)}，其中「${topCategoryName}」占比 ${topCategoryRatio}%（RM ${topCategoryAmount.toFixed(2)}）。${remainingBudgetText}`
      : effLang === 'en'
      ? 'No expenses recorded this month. Continue logging to build personalized analysis.'
      : effLang === 'ms'
      ? 'Tiada rekod perbelanjaan bulan ini. Teruskan mencatat untuk membentuk analisis peribadi.'
      : '本月暂无支出记录，保持记账以形成个性化财务分析。';

  const periodLabel =
    effLang === 'en'
      ? `${currentMonth} Financial Briefing`
      : effLang === 'ms'
      ? `Taklimat Kewangan ${currentMonth}`
      : `${currentMonth} 财务深度简报`;

  return {
    periodLabel,
    totalSpending,
    topCategoryName,
    topCategoryAmount: Number(topCategoryAmount.toFixed(2)),
    topCategoryRatio,
    largestExpense,
    highlights,
    riskAlerts,
    upcomingCommitmentsTotal: Number(upcomingCommitmentsTotal.toFixed(2)),
    actionableTip,
  };
}

// -------------------------------------------------------------
// 6. 📈 Pillar 3.2: 投资组合成本基准 (FIFO / 加权平均)、已实现盈亏与资产配置偏离引擎
// -------------------------------------------------------------
export interface TradeExecutionRecord {
  id: string;
  date: string;
  ticker: string;
  name?: string;
  assetType?: 'US Stock' | 'MY Stock' | 'Crypto' | 'ETF' | 'Unit Trust' | 'Fixed Deposit' | 'Cash' | 'Other';
  side: 'buy' | 'sell' | 'dividend' | 'reinvest';
  quantity: number;
  unitPrice: number;
  fee?: number;
  currency?: string;
  fxRateToMyr?: number;
}

export interface PositionCostBasisSummary {
  ticker: string;
  name: string;
  assetType: string;
  currency: string;
  openQuantity: number;
  fifoAvgCostNative: number;
  fifoCostBasisNative: number;
  fifoCostBasisMyr: number;
  weightedAvgCostNative: number;
  weightedCostBasisNative: number;
  weightedCostBasisMyr: number;
  realizedPnLFifoNative: number;
  realizedPnLFifoMyr: number;
  realizedPnLWeightedNative: number;
  realizedPnLWeightedMyr: number;
  cumulativeDividendsNative: number;
  cumulativeDividendsMyr: number;
  currentPriceNative: number;
  marketValueNative: number;
  marketValueMyr: number;
  unrealizedPnLFifoNative: number;
  unrealizedPnLFifoMyr: number;
  unrealizedPnLPctFifo: number;
  totalReturnWithDividendsMyr: number;
}

export interface AssetAllocationDriftItem {
  bucket: 'Stocks & ETFs' | 'Fixed Income / ASNB / FD' | 'Crypto' | 'Cash / Emergency';
  actualValueMyr: number;
  actualPct: number;
  targetPct: number;
  driftPct: number;
  rebalanceDeltaMyr: number;
  status: 'on_target' | 'overweight' | 'underweight';
  actionHint: string;
}

export interface PortfolioAnalyticsReport {
  positions: PositionCostBasisSummary[];
  totalCostBasisMyr: number;
  totalMarketValueMyr: number;
  totalUnrealizedPnLMyr: number;
  totalRealizedPnLFifoMyr: number;
  totalRealizedPnLWeightedMyr: number;
  totalDividendsMyr: number;
  allocationDrift: AssetAllocationDriftItem[];
  maxDriftPct: number;
  driftAlertMessage: string | null;
}

function mapAssetTypeToAllocationBucket(
  assetType?: string,
  ticker?: string
): AssetAllocationDriftItem['bucket'] {
  const t = (assetType || '').toLowerCase();
  const sym = (ticker || '').toLowerCase();
  if (t.includes('crypto') || ['btc', 'eth', 'sol'].includes(sym)) {
    return 'Crypto';
  }
  if (
    t.includes('fixed') ||
    t.includes('unit trust') ||
    t.includes('asnb') ||
    sym.includes('asm') ||
    sym.includes('asb') ||
    sym.includes('fd')
  ) {
    return 'Fixed Income / ASNB / FD';
  }
  if (t.includes('cash') || t.includes('emergency')) {
    return 'Cash / Emergency';
  }
  return 'Stocks & ETFs';
}

/**
 * Computes FIFO & Weighted-Average cost basis across partial share sales,
 * realized & unrealized P&L in native currency and MYR, dividend yield accrual,
 * and Asset Allocation Drift against target portfolio weights.
 */
export function computePortfolioCostBasisAndDrift(params: {
  trades: TradeExecutionRecord[];
  livePrices?: Record<string, { priceNative: number; fxRateToMyr?: number }>;
  emergencyCashMyr?: number;
  fixedDepositAndAsnbMyr?: number;
  targetWeightsPct?: Partial<Record<AssetAllocationDriftItem['bucket'], number>>;
  driftThresholdPct?: number;
  language?: 'zh' | 'en' | 'ms' | 'auto';
}): PortfolioAnalyticsReport {
  const {
    trades = [],
    livePrices = {},
    emergencyCashMyr = 0,
    fixedDepositAndAsnbMyr = 0,
    targetWeightsPct = {},
    driftThresholdPct = 5,
    language,
  } = params;

  const effLang = resolveIntelligenceLanguage(language);

  const defaultTargets: Record<AssetAllocationDriftItem['bucket'], number> = {
    'Stocks & ETFs': targetWeightsPct['Stocks & ETFs'] ?? 50,
    'Fixed Income / ASNB / FD': targetWeightsPct['Fixed Income / ASNB / FD'] ?? 25,
    Crypto: targetWeightsPct['Crypto'] ?? 5,
    'Cash / Emergency': targetWeightsPct['Cash / Emergency'] ?? 20,
  };

  // Group trades by ticker and sort chronologically
  const byTicker = new Map<string, TradeExecutionRecord[]>();
  for (const trade of trades) {
    const ticker = String(trade.ticker || '').trim().toUpperCase();
    if (!ticker) continue;
    if (!byTicker.has(ticker)) byTicker.set(ticker, []);
    byTicker.get(ticker)!.push(trade);
  }

  const positions: PositionCostBasisSummary[] = [];

  for (const [ticker, tickerTrades] of byTicker.entries()) {
    const sorted = [...tickerTrades].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
    const first = sorted[0];
    const currency = String(first.currency || (ticker.endsWith('.KL') ? 'MYR' : 'USD')).toUpperCase();
    const assetType = first.assetType || (ticker.endsWith('.KL') ? 'MY Stock' : 'US Stock');
    const name = first.name || ticker;

    // FIFO queue of open lots: { qty, unitCostNative, fxRateToMyr }
    const fifoLots: Array<{ qty: number; unitCostNative: number; fxRate: number }> = [];

    // Weighted average state
    let weightedQty = 0;
    let weightedTotalCostNative = 0;
    let weightedTotalCostMyr = 0;

    let realizedFifoNative = 0;
    let realizedFifoMyr = 0;
    let realizedWeightedNative = 0;
    let realizedWeightedMyr = 0;
    let cumulativeDividendsNative = 0;
    let cumulativeDividendsMyr = 0;
    let lastKnownPriceNative = first.unitPrice || 0;
    let lastKnownFx = first.fxRateToMyr && first.fxRateToMyr > 0 ? first.fxRateToMyr : currency === 'MYR' ? 1 : 4.4;

    for (const tr of sorted) {
      const qty = Math.max(0, Number(tr.quantity) || 0);
      const price = Math.max(0, Number(tr.unitPrice) || 0);
      const fee = Math.max(0, Number(tr.fee) || 0);
      const fx = tr.fxRateToMyr && tr.fxRateToMyr > 0 ? tr.fxRateToMyr : lastKnownFx;
      if (price > 0) lastKnownPriceNative = price;
      lastKnownFx = fx;

      if (tr.side === 'dividend') {
        const divAmtNative = qty > 0 && price > 0 ? qty * price - fee : Math.max(0, price - fee);
        cumulativeDividendsNative += divAmtNative;
        cumulativeDividendsMyr += divAmtNative * fx;
        continue;
      }

      if (tr.side === 'buy' || tr.side === 'reinvest') {
        if (qty <= 0) continue;
        const totalBuyCostNative = qty * price + fee;
        const effectiveUnitCost = totalBuyCostNative / qty;
        fifoLots.push({ qty, unitCostNative: effectiveUnitCost, fxRate: fx });

        weightedQty += qty;
        weightedTotalCostNative += totalBuyCostNative;
        weightedTotalCostMyr += totalBuyCostNative * fx;

        if (tr.side === 'reinvest') {
          cumulativeDividendsNative += totalBuyCostNative;
          cumulativeDividendsMyr += totalBuyCostNative * fx;
        }
        continue;
      }

      if (tr.side === 'sell' && qty > 0) {
        const netProceedsNative = Math.max(0, qty * price - fee);
        const netProceedsPerShare = netProceedsNative / qty;

        // 1. FIFO lot consumption
        let remainingToSell = qty;
        let fifoCostSoldNative = 0;
        let fifoCostSoldMyr = 0;
        while (remainingToSell > 1e-8 && fifoLots.length > 0) {
          const head = fifoLots[0];
          const matched = Math.min(remainingToSell, head.qty);
          fifoCostSoldNative += matched * head.unitCostNative;
          fifoCostSoldMyr += matched * head.unitCostNative * head.fxRate;
          head.qty -= matched;
          remainingToSell -= matched;
          if (head.qty <= 1e-8) {
            fifoLots.shift();
          }
        }
        const matchedSellQty = qty - remainingToSell;
        const matchedProceedsNative = matchedSellQty * netProceedsPerShare;
        realizedFifoNative += matchedProceedsNative - fifoCostSoldNative;
        realizedFifoMyr += matchedProceedsNative * fx - fifoCostSoldMyr;

        // 2. Weighted Average consumption
        if (weightedQty > 1e-8) {
          const sellFraction = Math.min(1, qty / weightedQty);
          const wCostSoldNative = weightedTotalCostNative * sellFraction;
          const wCostSoldMyr = weightedTotalCostMyr * sellFraction;
          realizedWeightedNative += netProceedsNative - wCostSoldNative;
          realizedWeightedMyr += netProceedsNative * fx - wCostSoldMyr;

          weightedQty = Math.max(0, weightedQty - qty);
          weightedTotalCostNative = Math.max(0, weightedTotalCostNative - wCostSoldNative);
          weightedTotalCostMyr = Math.max(0, weightedTotalCostMyr - wCostSoldMyr);
        }
      }
    }

    const openQuantity = Number(fifoLots.reduce((s, l) => s + l.qty, 0).toFixed(6));
    const fifoCostBasisNative = Number(
      fifoLots.reduce((s, l) => s + l.qty * l.unitCostNative, 0).toFixed(2)
    );
    const fifoCostBasisMyr = Number(
      fifoLots.reduce((s, l) => s + l.qty * l.unitCostNative * l.fxRate, 0).toFixed(2)
    );
    const fifoAvgCostNative = openQuantity > 0 ? Number((fifoCostBasisNative / openQuantity).toFixed(4)) : 0;

    const weightedCostBasisNative = Number(weightedTotalCostNative.toFixed(2));
    const weightedCostBasisMyr = Number(weightedTotalCostMyr.toFixed(2));
    const weightedAvgCostNative =
      weightedQty > 0 ? Number((weightedTotalCostNative / weightedQty).toFixed(4)) : 0;

    const liveOverride = livePrices[ticker];
    const currentPriceNative = liveOverride?.priceNative ?? lastKnownPriceNative;
    const currentFx = liveOverride?.fxRateToMyr ?? lastKnownFx;

    const marketValueNative = Number((openQuantity * currentPriceNative).toFixed(2));
    const marketValueMyr = Number((marketValueNative * currentFx).toFixed(2));
    const unrealizedPnLFifoNative = Number((marketValueNative - fifoCostBasisNative).toFixed(2));
    const unrealizedPnLFifoMyr = Number((marketValueMyr - fifoCostBasisMyr).toFixed(2));
    const unrealizedPnLPctFifo =
      fifoCostBasisNative > 0 ? Number(((unrealizedPnLFifoNative / fifoCostBasisNative) * 100).toFixed(2)) : 0;

    const totalReturnWithDividendsMyr = Number(
      (unrealizedPnLFifoMyr + realizedFifoMyr + cumulativeDividendsMyr).toFixed(2)
    );

    positions.push({
      ticker,
      name,
      assetType,
      currency,
      openQuantity,
      fifoAvgCostNative,
      fifoCostBasisNative,
      fifoCostBasisMyr,
      weightedAvgCostNative,
      weightedCostBasisNative,
      weightedCostBasisMyr,
      realizedPnLFifoNative: Number(realizedFifoNative.toFixed(2)),
      realizedPnLFifoMyr: Number(realizedFifoMyr.toFixed(2)),
      realizedPnLWeightedNative: Number(realizedWeightedNative.toFixed(2)),
      realizedPnLWeightedMyr: Number(realizedWeightedMyr.toFixed(2)),
      cumulativeDividendsNative: Number(cumulativeDividendsNative.toFixed(2)),
      cumulativeDividendsMyr: Number(cumulativeDividendsMyr.toFixed(2)),
      currentPriceNative,
      marketValueNative,
      marketValueMyr,
      unrealizedPnLFifoNative,
      unrealizedPnLFifoMyr,
      unrealizedPnLPctFifo,
      totalReturnWithDividendsMyr,
    });
  }

  const totalCostBasisMyr = Number(positions.reduce((s, p) => s + p.fifoCostBasisMyr, 0).toFixed(2));
  const totalPositionsMarketValueMyr = positions.reduce((s, p) => s + p.marketValueMyr, 0);
  const totalMarketValueMyr = Number(
    (totalPositionsMarketValueMyr + Math.max(0, emergencyCashMyr) + Math.max(0, fixedDepositAndAsnbMyr)).toFixed(2)
  );
  const totalUnrealizedPnLMyr = Number(positions.reduce((s, p) => s + p.unrealizedPnLFifoMyr, 0).toFixed(2));
  const totalRealizedPnLFifoMyr = Number(positions.reduce((s, p) => s + p.realizedPnLFifoMyr, 0).toFixed(2));
  const totalRealizedPnLWeightedMyr = Number(positions.reduce((s, p) => s + p.realizedPnLWeightedMyr, 0).toFixed(2));
  const totalDividendsMyr = Number(positions.reduce((s, p) => s + p.cumulativeDividendsMyr, 0).toFixed(2));

  // Bucket actual values
  const bucketTotals: Record<AssetAllocationDriftItem['bucket'], number> = {
    'Stocks & ETFs': 0,
    'Fixed Income / ASNB / FD': Math.max(0, fixedDepositAndAsnbMyr),
    Crypto: 0,
    'Cash / Emergency': Math.max(0, emergencyCashMyr),
  };

  for (const pos of positions) {
    if (pos.marketValueMyr <= 0) continue;
    const bucket = mapAssetTypeToAllocationBucket(pos.assetType, pos.ticker);
    bucketTotals[bucket] += pos.marketValueMyr;
  }

  const bucketsOrder: AssetAllocationDriftItem['bucket'][] = [
    'Stocks & ETFs',
    'Fixed Income / ASNB / FD',
    'Crypto',
    'Cash / Emergency',
  ];

  const allocationDrift: AssetAllocationDriftItem[] = bucketsOrder.map((bucket) => {
    const actualValueMyr = Number(bucketTotals[bucket].toFixed(2));
    const actualPct = totalMarketValueMyr > 0 ? Number(((actualValueMyr / totalMarketValueMyr) * 100).toFixed(1)) : 0;
    const targetPct = defaultTargets[bucket];
    const driftPct = Number((actualPct - targetPct).toFixed(1));
    const targetValueMyr = (totalMarketValueMyr * targetPct) / 100;
    const rebalanceDeltaMyr = Number((targetValueMyr - actualValueMyr).toFixed(2));

    let status: AssetAllocationDriftItem['status'] = 'on_target';
    let actionHint =
      effLang === 'en'
        ? 'Within target band'
        : effLang === 'ms'
        ? 'Dalam julat sasaran'
        : '处于目标配置区间内';

    if (driftPct >= driftThresholdPct) {
      status = 'overweight';
      actionHint =
        effLang === 'en'
          ? `Overweight by +${driftPct.toFixed(1)}% · Trim or pause new buys (~RM ${Math.abs(rebalanceDeltaMyr).toFixed(0)})`
          : effLang === 'ms'
          ? `Melebihi sasaran +${driftPct.toFixed(1)}% · Kurangkan (~RM ${Math.abs(rebalanceDeltaMyr).toFixed(0)})`
          : `超配 +${driftPct.toFixed(1)}% · 建议暂停追高或减仓约 RM ${Math.abs(rebalanceDeltaMyr).toFixed(0)}`;
    } else if (driftPct <= -driftThresholdPct) {
      status = 'underweight';
      actionHint =
        effLang === 'en'
          ? `Underweight by ${driftPct.toFixed(1)}% · Top up ~RM ${Math.abs(rebalanceDeltaMyr).toFixed(0)}`
          : effLang === 'ms'
          ? `Kurang ${driftPct.toFixed(1)}% · Tambah ~RM ${Math.abs(rebalanceDeltaMyr).toFixed(0)}`
          : `低配 ${driftPct.toFixed(1)}% · 建议下次定投优先补仓约 RM ${Math.abs(rebalanceDeltaMyr).toFixed(0)}`;
    }

    return {
      bucket,
      actualValueMyr,
      actualPct,
      targetPct,
      driftPct,
      rebalanceDeltaMyr,
      status,
      actionHint,
    };
  });

  const maxDriftItem = [...allocationDrift].sort((a, b) => Math.abs(b.driftPct) - Math.abs(a.driftPct))[0];
  const maxDriftPct = maxDriftItem ? Number(Math.abs(maxDriftItem.driftPct).toFixed(1)) : 0;

  let driftAlertMessage: string | null = null;
  if (totalMarketValueMyr > 0 && maxDriftItem && Math.abs(maxDriftItem.driftPct) >= driftThresholdPct) {
    const overItem = allocationDrift.find((d) => d.status === 'overweight');
    const underItem = allocationDrift.find((d) => d.status === 'underweight');
    if (effLang === 'en') {
      driftAlertMessage = `Portfolio drift alert: ${
        overItem ? `${overItem.bucket} is +${overItem.driftPct.toFixed(1)}% overweight` : ''
      }${overItem && underItem ? ' while ' : ''}${
        underItem ? `${underItem.bucket} is ${underItem.driftPct.toFixed(1)}% underweight` : ''
      }. Direct your next monthly contribution to rebalance.`;
    } else if (effLang === 'ms') {
      driftAlertMessage = `Amaran sisihan portfolio: ${maxDriftItem.bucket} menyimpang ${maxDriftItem.driftPct > 0 ? '+' : ''}${maxDriftItem.driftPct.toFixed(1)}% daripada sasaran.`;
    } else {
      driftAlertMessage = `资产配置偏离提醒：${
        overItem ? `「${overItem.bucket}」较目标超配 +${overItem.driftPct.toFixed(1)}%` : ''
      }${overItem && underItem ? '，而' : ''}${
        underItem ? `「${underItem.bucket}」低配 ${underItem.driftPct.toFixed(1)}%（差额约 RM ${Math.abs(underItem.rebalanceDeltaMyr).toFixed(0)}）` : ''
      }，建议将下月新增定投优先拨入低配资产。`;
    }
  }

  return {
    positions,
    totalCostBasisMyr,
    totalMarketValueMyr,
    totalUnrealizedPnLMyr,
    totalRealizedPnLFifoMyr,
    totalRealizedPnLWeightedMyr,
    totalDividendsMyr,
    allocationDrift,
    maxDriftPct,
    driftAlertMessage,
  };
}

