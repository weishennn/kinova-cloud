import { AnimatedNumber } from '@/components/shared/animated-number';

interface MoneySummaryProps {
  income: number;
  spending: number;
  invested: number;
  netCashflow: number;
  formatMoney: (amount: number) => string;
}

export function MoneyOrbit({ income, spending, invested, netCashflow, formatMoney }: MoneySummaryProps) {
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
          <dt>Income</dt>
          <dd className="income"><AnimatedNumber value={income} formatValue={formatMoney} animateOnMount /></dd>
        </div>
        <div>
          <dt>Expenses</dt>
          <dd className="expense"><AnimatedNumber value={spending} formatValue={formatMoney} animateOnMount /></dd>
        </div>
        <div>
          <dt>Invested</dt>
          <dd><AnimatedNumber value={invested} formatValue={formatMoney} animateOnMount /></dd>
        </div>
      </dl>
    </section>
  );
}
