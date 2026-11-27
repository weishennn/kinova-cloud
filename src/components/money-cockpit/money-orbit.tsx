import Link from 'next/link';
import { AnimatedNumber } from '@/components/shared/animated-number';

interface MoneySummaryProps {
  income: number;
  spending: number;
  budgetSpending?: number;
  invested: number;
  netCashflow: number;
  formatMoney: (amount: number) => string;
  unpaidCommittedReserve?: number;
  userBudgetCap?: number;
}

export function MoneyOrbit({
  income,
  spending,
  budgetSpending,
  invested,
  netCashflow,
  formatMoney,
  unpaidCommittedReserve = 0,
  userBudgetCap,
}: MoneySummaryProps) {
  const budgetSpent = budgetSpending ?? spending;
  return (
    <section className="cockpit-orbit-section" aria-labelledby="orbit-title">
      <div className="cockpit-summary-primary">
        <p className="cockpit-eyebrow">NET CASH FLOW</p>
        <h2 id="orbit-title" className={netCashflow < 0 ? 'is-negative' : ''}>
          <AnimatedNumber value={netCashflow} formatValue={formatMoney} animateOnMount />
        </h2>
        <p>Income minus expenses for this period</p>
      </div>

      <dl className="cockpit-summary-details" aria-label="Cash flow totals">
        <div>
          <Link href="/transactions?type=income" className="block hover:opacity-85 transition-opacity" title="View all income transactions">
            <dt>Income</dt>
            <dd className="income"><AnimatedNumber value={income} formatValue={formatMoney} animateOnMount /></dd>
          </Link>
        </div>
        <div>
          <Link href="/transactions?type=expense" className="block hover:opacity-85 transition-opacity" title="View all expense transactions">
            <dt>Expenses</dt>
            <dd className="expense"><AnimatedNumber value={spending} formatValue={formatMoney} animateOnMount /></dd>
          </Link>
        </div>
        <div>
          <Link href="/transactions?type=investment" className="block hover:opacity-85 transition-opacity" title="Click to view all investment transactions this month">
            <dt>Invested ↗</dt>
            <dd><AnimatedNumber value={invested} formatValue={formatMoney} animateOnMount /></dd>
          </Link>
        </div>
      </dl>

      {/* Unpaid Committed Bills Reserve & Safe Discretionary Progress Bar */}
      {typeof userBudgetCap === 'number' && userBudgetCap > 0 && (
        <div className="col-span-full pt-4 border-t border-slate-200/80 dark:border-white/[0.06] space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-600 dark:text-zinc-400">
            <span className="whitespace-nowrap">Budget: <strong className="font-mono tabular-nums text-slate-900 dark:text-white">RM{'\u00A0'}{userBudgetCap.toLocaleString()}</strong></span>
            <span className="font-mono font-medium whitespace-nowrap tabular-nums">
              {budgetSpent > userBudgetCap ? (
                <span className="text-rose-600 dark:text-rose-400 font-bold">Over Budget</span>
              ) : (
                <span className="text-emerald-600 dark:text-emerald-400">RM{'\u00A0'}{Math.max(0, userBudgetCap - budgetSpent - unpaidCommittedReserve).toFixed(0)} safe to spend</span>
              )}
            </span>
          </div>
          <div className="h-2 w-full rounded-full bg-slate-200 dark:bg-zinc-800 overflow-hidden flex">
            <div
              className="h-full bg-indigo-500 transition-all duration-500"
              style={{ width: `${Math.min(100, (budgetSpent / userBudgetCap) * 100)}%` }}
              title={`Spent: RM ${budgetSpent.toFixed(2)}`}
            />
            {unpaidCommittedReserve > 0 && (
              <div
                className="h-full bg-amber-500/80 bg-[repeating-linear-gradient(45deg,transparent,transparent_4px,rgba(0,0,0,0.15)_4px,rgba(0,0,0,0.15)_8px)] transition-all duration-500"
                style={{ width: `${Math.min(Math.max(0, 100 - (budgetSpent / userBudgetCap) * 100), (unpaidCommittedReserve / userBudgetCap) * 100)}%` }}
                title={`Upcoming Bills: RM ${unpaidCommittedReserve.toFixed(2)}`}
              />
            )}
            <div
              className="h-full bg-emerald-500/40"
              style={{ width: `${Math.max(0, 100 - ((budgetSpent + unpaidCommittedReserve) / userBudgetCap) * 100)}%` }}
              title={`Safe Discretionary: RM ${Math.max(0, userBudgetCap - budgetSpent - unpaidCommittedReserve).toFixed(2)}`}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-slate-500 dark:text-zinc-400">
            <span className="whitespace-nowrap tabular-nums">Spent: RM{'\u00A0'}{budgetSpent.toFixed(0)}</span>
            {unpaidCommittedReserve > 0 && (
              <span className="text-amber-700 dark:text-amber-400 font-medium whitespace-nowrap tabular-nums">Bills: RM{'\u00A0'}{unpaidCommittedReserve.toFixed(0)}</span>
            )}
            <span className="text-emerald-700 dark:text-emerald-400 font-medium whitespace-nowrap tabular-nums">Safe: RM{'\u00A0'}{Math.max(0, userBudgetCap - budgetSpent - unpaidCommittedReserve).toFixed(0)}</span>
          </div>
        </div>
      )}
    </section>
  );
}
