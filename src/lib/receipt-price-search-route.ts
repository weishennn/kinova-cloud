export const RECEIPT_PRICE_SEARCH_PATH = '/receipt-prices';

export function receiptPriceSearchHref(fromPath: string): string {
  const safeFromPath = fromPath.startsWith('/') && !fromPath.startsWith('//') && !fromPath.includes('\\')
    ? fromPath
    : '/';
  return `${RECEIPT_PRICE_SEARCH_PATH}?from=${encodeURIComponent(safeFromPath)}`;
}

export function receiptPriceSearchReturnPath(fromPath: string | undefined): string {
  if (!fromPath || !fromPath.startsWith('/') || fromPath.startsWith('//') || fromPath.includes('\\')) {
    return '/';
  }

  try {
    const parsed = new URL(fromPath, 'https://kinova.invalid');
    if (parsed.origin !== 'https://kinova.invalid') return '/';
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return '/';
  }
}
