import { InvestmentsSubnav } from '@/components/investments/investments-subnav';
import { BinanceDashboard } from '@/components/investments/binance-dashboard';

export default function BinanceInvestmentsPage() {
  return (
    <div className="space-y-4">
      <InvestmentsSubnav />
      <BinanceDashboard />
    </div>
  );
}
