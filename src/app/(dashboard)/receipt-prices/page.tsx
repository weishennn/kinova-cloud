import type { Metadata } from 'next';
import { ReceiptPriceSearch } from '@/components/shared/receipt-price-search';
import { receiptPriceSearchReturnPath } from '@/lib/receipt-price-search-route';

export const metadata: Metadata = {
  title: 'Receipt price history | Kinova',
};

interface ReceiptPricesPageProps {
  searchParams: Promise<{ from?: string | string[] }>;
}

export default async function ReceiptPricesPage({ searchParams }: ReceiptPricesPageProps) {
  const params = await searchParams;
  const from = Array.isArray(params.from) ? params.from[0] : params.from;

  return <ReceiptPriceSearch returnTo={receiptPriceSearchReturnPath(from)} />;
}
