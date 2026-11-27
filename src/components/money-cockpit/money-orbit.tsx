import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
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
  const savingsRate = income > 0 ? Math.round(((income - spending) / income) * 100) : null;
  const safeDiscretionary =
    typeof userBudgetCap === 'number' && userBudgetCap > 0
      ? Math.max(0, userBudgetCap - budgetSpent - unpaidCommittedReserve)
      : 0;

  return (
    <section className="cockpit-orbit-section" aria-labelledby="orbit-title">
      <div className="cockpit-summary-primary">
        <div className="cockpit-vault-eyebrow">
          <span>Net Cash Flow</span>
          {savingsRate !== null ? (
            <span className={`cockpit-vault-badge ${netCashflow < 0 ? 'is-negative' : ''}`}>
              {netCashflow >= 0 ? `+${savingsRate}% retained` : `${savingsRate}%`}
            </span>
          ) : (
            <span className={`cockpit-vault-badge ${netCashflow < 0 ? 'is-negative' : ''}`}>
              {netCashflow < 0 ? 'Outflow' : 'Live Ledger'}
            </span>
          )}
        </div>
        <h2 id="orbit-title" className={netCashflow < 0 ? 'is-negative' : ''}>
          <AnimatedNumber value={netCashflow} formatValue={formatMoney} animateOnMount />
        </h2>
        <p>Income minus expenses for this period</p>
      </div>

      <dl className="cockpit-summary-details" aria-label="Cash flow totals">
        <div>
          <Link href="/transactions?type=income" className="block" title="View all income transactions">
            <dt>Income</dt>
            <dd className="income"><AnimatedNumber value={income} formatValue={formatMoney} animateOnMount /></dd>
          </Link>
        </div>
        <div>
          <Link href="/transactions?type=expense" className="block" title="View all expense transactions">
            <dt>Expenses</dt>
            <dd className="expense"><AnimatedNumber value={spending} formatValue={formatMoney} animateOnMount /></dd>
          </Link>
        </div>
        <div>
          <Link href="/transactions?type=investment" className="block" title="Click to view all investment transactions this month">
            <dt className="inline-flex items-center gap-1">
              <span>Invested</span>
              <ArrowUpRight size={11} className="opacity-65" aria-hidden="true" />
            </dt>
            <dd><AnimatedNumber value={invested} formatValue={formatMoney} animateOnMount /></dd>
          </Link>
        </div>
      </dl>

      {/* Unpaid Committed Bills Reserve & Safe Discretionary Runway Bar */}
      {typeof userBudgetCap === 'number' && userBudgetCap > 0 && (
        <div className="cockpit-vault-runway">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-white/70">
            <span className="whitespace-nowrap">
              Monthly Cap: <strong className="tabular-nums text-white font-semibold">RM{'\u00A0'}{userBudgetCap.toLocaleString()}</strong>
            </span>
            <span className="font-semibold whitespace-nowrap tabular-nums">
              {budgetSpent > userBudgetCap ? (
                <span className="text-rose-300">Over Budget by RM{'\u00A0'}{(budgetSpent - userBudgetCap).toFixed(0)}</span>
              ) : (
                <span className="text-emerald-300">RM{'\u00A0'}{safeDiscretionary.toFixed(0)} safe to spend</span>
              )}
            </span>
          </div>
          <div className="h-2 w-full rounded-full bg-white/10 overflow-hidden flex">
            <div
              className="h-full bg-emerald-400 transition-all duration-500"
              style={{ width: `${Math.min(100, (budgetSpent / userBudgetCap) * 100)}%` }}
              title={`Spent: RM ${budgetSpent.toFixed(2)}`}
            />
            {unpaidCommittedReserve > 0 && (
              <div
                className="h-full bg-amber-400/85 bg-[repeating-linear-gradient(45deg,transparent,transparent_4px,rgba(0,0,0,0.18)_4px,rgba(0,0,0,0.18)_8px)] transition-all duration-500"
                style={{ width: `${Math.min(Math.max(0, 100 - (budgetSpent / userBudgetCap) * 100), (unpaidCommittedReserve / userBudgetCap) * 100)}%` }}
                title={`Upcoming Bills: RM ${unpaidCommittedReserve.toFixed(2)}`}
              />
            )}
            <div
              className="h-full bg-emerald-300/20"
              style={{ width: `${Math.max(0, 100 - ((budgetSpent + unpaidCommittedReserve) / userBudgetCap) * 100)}%` }}
              title={`Safe Discretionary: RM ${safeDiscretionary.toFixed(2)}`}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-[10.5px] text-white/55">
            <span className="whitespace-nowrap tabular-nums">Spent: RM{'\u00A0'}{budgetSpent.toFixed(0)}</span>
            {unpaidCommittedReserve > 0 && (
              <span className="text-amber-300/90 font-medium whitespace-nowrap tabular-nums">Upcoming bills: RM{'\u00A0'}{unpaidCommittedReserve.toFixed(0)}</span>
            )}
            <span className="text-emerald-300/90 font-medium whitespace-nowrap tabular-nums">Remaining buffer: RM{'\u00A0'}{safeDiscretionary.toFixed(0)}</span>
          </div>
        </div>
      )}
    </section>
  );
}
