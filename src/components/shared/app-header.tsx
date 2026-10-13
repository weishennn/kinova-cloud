'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { RefreshCw, Check, LoaderCircle, Search } from 'lucide-react';
import { useSyncAndRefresh } from '@/hooks/useSyncAndRefresh';
import { useSyncStatus } from '@/hooks/useSyncStatus';
import { ThemeToggle } from './theme-toggle';
import { receiptPriceSearchHref } from '@/lib/receipt-price-search-route';

export function AppHeader() {
  const pathname = usePathname();
  const { isRefreshing, justRefreshed, syncAndRefresh } = useSyncAndRefresh();
  const { isOnline, hasCloudEndpoint, isConnected, pendingCount, formattedLastSync, lastSyncError, isReady } = useSyncStatus();

  const statusLabel = !isReady
    ? 'Checking sync…'
    : pendingCount > 0
    ? `${pendingCount} pending`
    : !isOnline
      ? 'Offline'
      : !hasCloudEndpoint
        ? 'Local only'
        : lastSyncError
          ? 'Sync needs attention'
          : isConnected && formattedLastSync !== 'Never'
            ? `Synced ${formattedLastSync}`
            : isConnected
              ? 'Connected'
              : `Cached · ${formattedLastSync}`;
  const statusClass = !isReady
    ? ''
    : pendingCount > 0 || !isOnline || lastSyncError
      ? 'is-warning'
      : isConnected
        ? 'is-healthy'
        : '';

  return (
    <header className="cockpit-topbar">
      <div className="cockpit-topbar-inner">
        <div className="cockpit-topbar-brand">
          <Link href="/" className="cockpit-wordmark" aria-label="Kinova home">
            <img src="/kinova-header-logo.png" alt="Kinova" className="h-9 w-auto object-contain block" />
          </Link>
          {pendingCount > 0 ? (
            <Link
              href="/settings"
              className={`cockpit-sync-state ${statusClass}`}
              title={lastSyncError || 'Click to view or clear pending sync items in Settings'}
            >
              <i aria-hidden="true" />{statusLabel}
            </Link>
          ) : (
            <span className={`cockpit-sync-state ${statusClass}`} title={lastSyncError || statusLabel}>
              <i aria-hidden="true" />{statusLabel}
            </span>
          )}
        </div>

        <div className="cockpit-topbar-actions" aria-live="polite">
          <ThemeToggle className="cockpit-icon-button" />
          <Link
            href={receiptPriceSearchHref(pathname)}
            className="cockpit-icon-button"
            title="Find a past receipt price"
            aria-label="Find a past receipt price"
          >
            <Search size={17} />
          </Link>
          <button
            type="button"
            onClick={() => void syncAndRefresh()}
            disabled={isRefreshing}
            className="cockpit-icon-button"
            title="Sync with cloud database and refresh all latest data"
            aria-label={isRefreshing ? 'Syncing data with cloud' : justRefreshed ? 'Data synced' : 'Sync and refresh data'}
          >
            {isRefreshing ? (
              <LoaderCircle className="spin" size={17} />
            ) : justRefreshed ? (
              <Check size={17} />
            ) : (
              <RefreshCw size={17} />
            )}
          </button>
        </div>
      </div>
    </header>
  );
}
