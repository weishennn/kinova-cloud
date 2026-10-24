import { getLocalDateString, getDaysInMonth, parseLocalDate } from './date-helper.ts';
import { getAmountInBaseCurrency } from './currency.ts';

export interface RecurringCommitmentItem {
  id: string;
  name: string;
  category: string;
  subCategory?: string;
  dayOfMonth: number;
  amount: number;
  effectiveFrom?: string;
  notes?: string;
}

export interface SavedInstallmentItem {
  id: string;
  name: string;
  monthlyPayment: number;
  remainingMonths?: number;
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

export interface MinimalTransactionRecord {
  id: string;
  date: string;
  amount: number;
  type: string;
  category?: string;
  subCategory?: string;
  description?: string;
  merchant?: string;
  notes?: string;
  currency?: string;
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
  monthlyBudgetCap?: number;
  baselineIncome?: number;
  emergencyFundBalance?: number;
  referenceDateStr?: string;
}): FinancialHealthReport {
  const {
    transactions,
    monthlyBudgetCap,
    baselineIncome,
    emergencyFundBalance = 0,
    referenceDateStr,
  } = params;

  const todayStr = referenceDateStr || getLocalDateString();
  const currentMonthStr = todayStr.slice(0, 7);

  // Month-to-date income and expenses
  const currentExpenses = transactions.filter(
    (t) => t.type === 'expense' && t.date?.startsWith(currentMonthStr) && t.amount > 0
  );
  const currentIncome = transactions.filter(
    (t) => t.type === 'income' && t.date?.startsWith(currentMonthStr) && t.amount > 0
  );

  const totalExpense = currentExpenses.reduce(
    (sum, t) => sum + getAmountInBaseCurrency(t.amount, t.currency),
    0
  );
  const actualIncome = currentIncome.reduce(
    (sum, t) => sum + getAmountInBaseCurrency(t.amount, t.currency),
    0
  );

  const effectiveIncome = actualIncome > 0 ? actualIncome : (baselineIncome && baselineIncome > 0 ? baselineIncome : 0);

  // Dimension 1: Savings Rate (储蓄率: 30分)
  // Benchmark: >= 30% -> 30pts, 20-30% -> 24-29pts, 10-20% -> 15-23pts, 0-10% -> 5-14pts, Negative -> 0pts
  let savingsRateScore = 20; // default baseline
  let savingsRatePct = 0;
  let savingsStatus: HealthDimension['status'] = 'good';
  let savingsDetails = '本月尚未录入收入，参考基础收入评估';

  if (effectiveIncome > 0) {
    const netSavings = effectiveIncome - totalExpense;
    savingsRatePct = Math.round((netSavings / effectiveIncome) * 100);
    if (savingsRatePct >= 30) {
      savingsRateScore = 30;
      savingsStatus = 'excellent';
      savingsDetails = `本月储蓄率达 ${savingsRatePct}%（优秀，远超 20% 标准）`;
    } else if (savingsRatePct >= 20) {
      savingsRateScore = 25;
      savingsStatus = 'good';
      savingsDetails = `本月储蓄率达 ${savingsRatePct}%（健康，达到 20% 标准）`;
    } else if (savingsRatePct >= 10) {
      savingsRateScore = 18;
      savingsStatus = 'warning';
      savingsDetails = `本月储蓄率为 ${savingsRatePct}%（略偏低，建议控制弹性开支）`;
    } else if (savingsRatePct >= 0) {
      savingsRateScore = 10;
      savingsStatus = 'warning';
      savingsDetails = `本月接近收支平衡（储蓄率 ${savingsRatePct}%），注意控制支出`;
    } else {
      savingsRateScore = 0;
      savingsStatus = 'critical';
      savingsDetails = `本月支出已超出收入 ${Math.abs(savingsRatePct)}%（出现财务赤字）`;
    }
  }

  // Dimension 2: Budget Adherence / Pacing (预算执行度: 25分)
  let budgetScore = 20;
  let budgetStatus: HealthDimension['status'] = 'good';
  let budgetDetails = '未设定月度预算，按日常消费节奏平稳进行';
  const dayOfMonth = Math.max(1, parseInt(todayStr.slice(8, 10), 10) || 1);
  const totalDays = getDaysInMonth(parseInt(todayStr.slice(0, 4), 10) || 2026, parseInt(todayStr.slice(5, 7), 10) || 10);

  if (monthlyBudgetCap && monthlyBudgetCap > 0) {
    const dailyPace = totalExpense / dayOfMonth;
    const projectedEnd = dailyPace * totalDays;
    const paceRatio = projectedEnd / monthlyBudgetCap;

    if (paceRatio <= 0.9) {
      budgetScore = 25;
      budgetStatus = 'excellent';
      budgetDetails = `预计月底消耗预算 ${Math.round(paceRatio * 100)}%，预算节余充裕`;
    } else if (paceRatio <= 1.05) {
      budgetScore = 22;
      budgetStatus = 'good';
      budgetDetails = `预计月底刚好达成预算（${Math.round(paceRatio * 100)}%），执行力优秀`;
    } else if (paceRatio <= 1.2) {
      budgetScore = 14;
      budgetStatus = 'warning';
      budgetDetails = `按当前进度月底预计超支 ${Math.round((paceRatio - 1) * 100)}%，需适度紧缩`;
    } else {
      budgetScore = 5;
      budgetStatus = 'critical';
      budgetDetails = `按当前进度月底预计严重超支 >${Math.round((paceRatio - 1) * 100)}%，请暂停非必要消费`;
    }
  }

  // Dimension 3: Fixed-Cost Burden (固定支出与负债负担率: 25分)
  // Includes recurring commitments & monthly installment plans
  const commitments = getStoredCommitments();
  const installments = getStoredInstallments();

  const fixedMonthlyBurn = commitments.reduce((s, c) => s + (c.amount || 0), 0) +
    installments.reduce((s, i) => s + (i.monthlyPayment || 0), 0);

  let fixedScore = 22;
  let fixedStatus: HealthDimension['status'] = 'good';
  let fixedDetails = `固定扣款与分期共约 RM ${fixedMonthlyBurn.toFixed(0)}/月`;

  if (effectiveIncome > 0 && fixedMonthlyBurn > 0) {
    const fixedRatio = (fixedMonthlyBurn / effectiveIncome) * 100;
    if (fixedRatio <= 35) {
      fixedScore = 25;
      fixedStatus = 'excellent';
      fixedDetails = `固定支出占收入 ${Math.round(fixedRatio)}%（结构极佳，抗风险能力强）`;
    } else if (fixedRatio <= 50) {
      fixedScore = 20;
      fixedStatus = 'good';
      fixedDetails = `固定支出占收入 ${Math.round(fixedRatio)}%（符合 50% 安全基准线）`;
    } else if (fixedRatio <= 65) {
      fixedScore = 12;
      fixedStatus = 'warning';
      fixedDetails = `固定支出占收入 ${Math.round(fixedRatio)}%（负担偏重，自由现金流受压）`;
    } else {
      fixedScore = 5;
      fixedStatus = 'critical';
      fixedDetails = `固定支出占收入 ${Math.round(fixedRatio)}%（严重过载，面临现金流断裂风险）`;
    }
  }

  // Dimension 4: Cash & Emergency Buffer (应急安全垫: 20分)
  let bufferScore = 15;
  let bufferStatus: HealthDimension['status'] = 'good';
  let bufferDetails = '储备金充足或处于健康积累期';

  const monthlyBurnBaseline = Math.max(totalExpense, fixedMonthlyBurn, 1000);
  if (emergencyFundBalance > 0) {
    const monthsCovered = emergencyFundBalance / monthlyBurnBaseline;
    if (monthsCovered >= 6) {
      bufferScore = 20;
      bufferStatus = 'excellent';
      bufferDetails = `应急备用金可覆盖 ${monthsCovered.toFixed(1)} 个月日常开支（护城河稳固）`;
    } else if (monthsCovered >= 3) {
      bufferScore = 16;
      bufferStatus = 'good';
      bufferDetails = `应急备用金可覆盖 ${monthsCovered.toFixed(1)} 个月（达到推荐的 3-6 个月标准）`;
    } else {
      bufferScore = 8;
      bufferStatus = 'warning';
      bufferDetails = `应急备用金仅覆盖 ${monthsCovered.toFixed(1)} 个月（建议优先补充至 3 个月）`;
    }
  }

  const totalScore = Math.min(100, Math.max(0, savingsRateScore + budgetScore + fixedScore + bufferScore));

  let grade: FinancialHealthReport['grade'] = 'A';
  let gradeLabel = '财务健康良好';
  let summary = '各项财务指标运行平稳，自由现金流充沛。';

  if (totalScore >= 90) {
    grade = 'S';
    gradeLabel = '卓越稳健 (Top Tier)';
    summary = '储蓄率与预算控制均处于极佳状态，财务护城河非常深厚。';
  } else if (totalScore >= 75) {
    grade = 'A';
    gradeLabel = '健康良好 (Healthy)';
    summary = '收支平衡控制得当，固定成本与日常弹性支出比例合理。';
  } else if (totalScore >= 60) {
    grade = 'B';
    gradeLabel = '稳中向好 (Moderate)';
    summary = '基本保持收支平衡，建议优化非必要订阅或适度提高每月储蓄比。';
  } else if (totalScore >= 45) {
    grade = 'C';
    gradeLabel = '稍显吃紧 (Tight)';
    summary = '预算执行或固定扣款负担较重，需注意防范月底现金流缺口。';
  } else {
    grade = 'D';
    gradeLabel = '需要关注 (Attention Needed)';
    summary = '支出增速高于资金供给，建议立即检查闲置扣款并暂停大额非必要开支。';
  }

  // Recommendations generator
  const recommendations: string[] = [];
  if (savingsStatus === 'critical' || savingsStatus === 'warning') {
    recommendations.push('本月储蓄偏弱：建议优先削减餐饮与娱乐等弹性开销，锁定每月基本积蓄。');
  }
  if (fixedStatus === 'warning' || fixedStatus === 'critical') {
    recommendations.push('固定负担偏高：建议全面审视订阅服务与分期计划，清理长期不用的扣费。');
  }
  if (budgetStatus === 'warning' || budgetStatus === 'critical') {
    recommendations.push('进度有超支风险：距月底还有部分时日，可设置单日消费上限以拉平总进度。');
  }
  if (recommendations.length === 0) {
    recommendations.push('当前财务运转非常健康！可考虑将节余资金按计划转入应急储蓄或低风险理财。');
    recommendations.push('继续保持记账习惯，良好的资金透明度是实现资产增长的最佳护城河。');
  }

  return {
    totalScore,
    grade,
    gradeLabel,
    summary,
    dimensions: {
      savingsRate: {
        name: '储蓄与节余率',
        score: savingsRateScore,
        maxScore: 30,
        percentage: Math.round((savingsRateScore / 30) * 100),
        status: savingsStatus,
        details: savingsDetails,
      },
      budgetDiscipline: {
        name: '预算执行力',
        score: budgetScore,
        maxScore: 25,
        percentage: Math.round((budgetScore / 25) * 100),
        status: budgetStatus,
        details: budgetDetails,
      },
      fixedCostBurden: {
        name: '固定成本负债比',
        score: fixedScore,
        maxScore: 25,
        percentage: Math.round((fixedScore / 25) * 100),
        status: fixedStatus,
        details: fixedDetails,
      },
      cashBuffer: {
        name: '现金与应急缓冲',
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
  commitmentsOverride?: RecurringCommitmentItem[];
  installmentsOverride?: SavedInstallmentItem[];
  referenceDateStr?: string;
}): CashflowForecastResult {
  const {
    transactions,
    startingCash = 5000,
    baselineMonthlyIncome = 4500,
    commitmentsOverride,
    installmentsOverride,
    referenceDateStr,
  } = params;

  const todayStr = referenceDateStr || getLocalDateString();
  const today = parseLocalDate(todayStr);

  // 1. Calculate historical daily discretionary burn rate from recent 60 days
  const sixtyDaysAgo = new Date(today);
  sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
  const sixtyDaysAgoStr = getLocalDateString(sixtyDaysAgo);

  const recentExpenses = transactions.filter(
    (t) => t.type === 'expense' && t.date >= sixtyDaysAgoStr && t.amount > 0
  );

  const totalRecentExpense = recentExpenses.reduce(
    (sum, t) => sum + getAmountInBaseCurrency(t.amount, t.currency),
    0
  );

  // Exclude large one-off expenses (> RM 1,500) to avoid skewing daily living pace
  const normalizedExpenses = recentExpenses.filter((t) => t.amount <= 1500);
  const normalizedTotal = normalizedExpenses.reduce(
    (sum, t) => sum + getAmountInBaseCurrency(t.amount, t.currency),
    0
  );

  const dailyDiscretionaryBurn = Math.max(
    15,
    Number((normalizedTotal > 0 ? normalizedTotal / 60 : 35).toFixed(2))
  );

  // 2. Load fixed commitments
  const commitments: RecurringCommitmentItem[] = commitmentsOverride || getStoredCommitments();
  const installments: SavedInstallmentItem[] = installmentsOverride || getStoredInstallments();

  const totalMonthlyFixed = commitments.reduce((s, c) => s + (c.amount || 0), 0) +
    installments.reduce((s, i) => s + (i.monthlyPayment || 0), 0);

  // 3. Project day by day for 90 days
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
    const dayOfMonth = curDate.getDate();

    let dayInflow = 0;
    let dayOutflow = dailyDiscretionaryBurn;
    const noteItems: string[] = [];

    // Monthly Salary/Income typically arrives on day 25 or 28
    if (dayOfMonth === 25 && baselineMonthlyIncome > 0) {
      dayInflow += baselineMonthlyIncome;
      noteItems.push(`预计收入入账: +${baselineMonthlyIncome}`);
    }

    // Check commitments due today
    for (const comm of commitments) {
      if (comm.dayOfMonth === dayOfMonth && comm.amount > 0) {
        dayOutflow += comm.amount;
        noteItems.push(`${comm.name}: -${comm.amount}`);
      }
    }

    // Check installments due on day 1
    if (dayOfMonth === 1 && installments.length > 0) {
      const instSum = installments.reduce((s, i) => s + (i.monthlyPayment || 0), 0);
      dayOutflow += instSum;
      noteItems.push(`分期还款合集: -${instSum}`);
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
  let insightMessage = '未来 90 天现金流充裕，收支结构稳固，无流动性风险。';

  if (lowestPoint.balance < 0) {
    status = 'deficit_warning';
    insightMessage = `⚠️ 预警：预计在第 ${lowestPoint.dayOffset} 天（${lowestPoint.dateStr}）可能出现资金缺口（约 RM ${lowestPoint.balance.toFixed(0)}），请提前预留资金。`;
  } else if (lowestPoint.balance < 1200) {
    status = 'tight';
    insightMessage = `💡 提示：第 ${lowestPoint.dayOffset} 天（${lowestPoint.dateStr}）余额将降至低位（RM ${lowestPoint.balance.toFixed(0)}），需注意缓冲。`;
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

  // Group expenses by normalized merchant or clean description
  const groups = new Map<string, {
    canonicalName: string;
    category: string;
    records: Array<{ date: string; amount: number; day: number; month: string }>;
  }>();

  for (const tx of allTransactions) {
    if (!tx || tx.type === 'income' || !tx.amount || tx.amount <= 0 || !tx.date) continue;

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
      amount: getAmountInBaseCurrency(tx.amount, tx.currency),
      day,
      month,
    });
  }

  const discovered: DiscoveredRecurringCandidate[] = [];

  for (const [key, data] of groups.entries()) {
    // Unique months count
    const uniqueMonths = new Set(data.records.map((r) => r.month));
    if (uniqueMonths.size < 2) continue; // Must occur in at least 2 distinct months

    // Check amount variance: recurring items (subscriptions, bills) typically have very similar amounts
    const amounts = data.records.map((r) => r.amount);
    const avgAmount = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const maxAmount = Math.max(...amounts);
    const minAmount = Math.min(...amounts);

    // If amounts vary wildly by > 35%, probably not a fixed subscription (e.g. random dining)
    const amountVarianceRatio = (maxAmount - minAmount) / Math.max(1, avgAmount);
    if (amountVarianceRatio > 0.35 && uniqueMonths.size < 3) continue;

    // Detect typical day of month (e.g. median day)
    const days = data.records.map((r) => r.day).sort((a, b) => a - b);
    const medianDay = days[Math.floor(days.length / 2)];

    // Check if already tracked
    const isAlreadyTracked = existingNames.has(key) ||
      Array.from(existingNames).some((en) => en.includes(key) || key.includes(en));

    // Sort records descending by date
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

  // Prioritize untracked items with high confidence and distinct monthly recurrence
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
  timeSlotTag: string; // e.g. "🍱 工作日午餐" | "🍲 晚餐" | "☕ 早餐" | "🌙 宵夜"
  dayTypeTag: '工作日' | '周末';
  natureTag: '固定/周期' | '日常弹性';
  holidayTag?: string; // e.g. "🎉 元旦" | "🧧 农历新年" | "🇲🇾 国庆节"
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
  currentHour?: number
): ContextualTagInfo {
  const dateObj = parseLocalDate(txDate);
  const dayOfWeek = Number.isNaN(dateObj.getTime()) ? 1 : dateObj.getDay(); // 0 = Sun, 6 = Sat
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

  // Derive hour if not provided
  let hour = typeof currentHour === 'number' ? currentHour : 12;
  const descLower = (description || '').toLowerCase();
  const catLower = (category || '').toLowerCase();

  // If description has explicit food markers
  if (descLower.includes('breakfast') || descLower.includes('kopi') || descLower.includes('toast') || descLower.includes('早餐')) {
    hour = 8;
  } else if (descLower.includes('dinner') || descLower.includes('晚餐') || descLower.includes('hotpot') || descLower.includes('bbq')) {
    hour = 19;
  } else if (descLower.includes('supper') || descLower.includes('宵夜') || descLower.includes('mamak')) {
    hour = 23;
  }

  let timeSlotTag = '☀️ 白天消费';
  if (hour >= 6 && hour < 11) {
    timeSlotTag = '☕ 早餐时段';
  } else if (hour >= 11 && hour < 15) {
    timeSlotTag = isWeekend ? '🍱 周末午餐' : '🍱 工作日午餐';
  } else if (hour >= 15 && hour < 18) {
    timeSlotTag = '🧋 下午茶';
  } else if (hour >= 18 && hour < 22) {
    timeSlotTag = '🍲 晚餐聚餐';
  } else {
    timeSlotTag = '🌙 深夜/宵夜';
  }

  // Expense Nature
  const isFixedCategory = catLower.includes('bill') || catLower.includes('housing') ||
    catLower.includes('insurance') || catLower.includes('rental') || catLower.includes('unifi') ||
    catLower.includes('sub');
  const natureTag = isFixedCategory ? '固定/周期' : '日常弹性';

  // Holiday check (MM-DD)
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
  periodLabel: string; // e.g. "2026年10月度深度简报"
  totalSpending: number;
  topCategoryName: string;
  topCategoryAmount: number;
  topCategoryRatio: number; // e.g. 35%
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
  budgetCap?: number
): FinancialBriefingResult {
  const currentMonth = targetMonthStr || getLocalDateString().slice(0, 7);
  const monthExpenses = (transactions || []).filter(
    (t) => t.type === 'expense' && t.date?.startsWith(currentMonth) && t.amount > 0
  );

  const totalSpending = Number(
    monthExpenses
      .reduce((sum, t) => sum + getAmountInBaseCurrency(t.amount, t.currency), 0)
      .toFixed(2)
  );

  // Category breakdown
  const catMap = new Map<string, number>();
  for (const t of monthExpenses) {
    const cat = t.category || 'Other';
    catMap.set(cat, (catMap.get(cat) || 0) + getAmountInBaseCurrency(t.amount, t.currency));
  }

  let topCategoryName = '无支出';
  let topCategoryAmount = 0;
  for (const [cat, amt] of catMap.entries()) {
    if (amt > topCategoryAmount) {
      topCategoryAmount = amt;
      topCategoryName = cat;
    }
  }

  const topCategoryRatio = totalSpending > 0
    ? Math.round((topCategoryAmount / totalSpending) * 100)
    : 0;

  // Largest expense
  let largestExpense: FinancialBriefingResult['largestExpense'] = null;
  const sortedByAmt = [...monthExpenses].sort((a, b) => b.amount - a.amount);
  if (sortedByAmt.length > 0) {
    largestExpense = {
      description: sortedByAmt[0].description || sortedByAmt[0].category || '大额支出',
      amount: sortedByAmt[0].amount,
      date: sortedByAmt[0].date,
    };
  }

  // Highlights
  const highlights: string[] = [];
  if (totalSpending > 0) {
    highlights.push(`累计记录支出 ${monthExpenses.length} 笔，总开销 RM ${totalSpending.toLocaleString('en-MY', { minimumFractionDigits: 2 })}。`);
  }
  if (topCategoryAmount > 0) {
    highlights.push(`主要支出集中在「${topCategoryName}」，共消费 RM ${topCategoryAmount.toFixed(2)}（占比 ${topCategoryRatio}%）。`);
  }
  if (largestExpense) {
    highlights.push(`单笔最大支出为「${largestExpense.description}」RM ${largestExpense.amount.toFixed(2)}（${largestExpense.date}）。`);
  }

  // Risk alerts
  const riskAlerts: string[] = [];
  if (budgetCap && budgetCap > 0 && totalSpending > budgetCap * 0.85) {
    riskAlerts.push(`本月支出已达到设定预算的 ${Math.round((totalSpending / budgetCap) * 100)}%，余下天数需控制节奏。`);
  }

  const commitments = getStoredCommitments();
  const upcomingCommitmentsTotal = commitments.reduce((s, c) => s + (c.amount || 0), 0);

  const actionableTip = totalSpending > 2500
    ? '智能管家提示：大额消费后建议适度保持 3-5 天的轻量消费周期，快速平抑月度开销均线。'
    : '智能管家提示：当前消费节奏稳健可控，周末如有社交活动可放心体验，资金储备充足。';

  return {
    periodLabel: `${currentMonth} 财务深度简报`,
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
