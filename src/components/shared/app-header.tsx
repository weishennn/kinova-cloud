'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { RefreshCw, Check, LoaderCircle } from 'lucide-react';
import { useSyncAndRefresh } from '@/hooks/useSyncAndRefresh';
import { useSyncStatus } from '@/hooks/useSyncStatus';
import { ThemeToggle } from './theme-toggle';
import { useAppStore } from '@/stores/app-store';

function getRouteContextTitle(pathname: string): string {
  if (pathname === '/') return 'Overview';
  if (pathname.startsWith('/transactions')) return 'Cash Flow';
  if (pathname.startsWith('/investments/binance')) return 'Binance Portfolio';
  if (pathname.startsWith('/investments')) return 'Investments';
  if (pathname.startsWith('/budget')) return 'Budget & Envelopes';
  if (pathname.startsWith('/invoices')) return 'Invoices & Tax';
  if (pathname.startsWith('/analytics')) return 'Analytics';
  if (pathname.startsWith('/trips')) return 'Trips';
  if (pathname.startsWith('/settings')) return 'Settings';
  return 'Kinova';
}

export function AppHeader() {
  const pathname = usePathname();
  const setKinovaAIOpen = useAppStore((s) => s.setKinovaAIOpen);
  const { isRefreshing, justRefreshed, syncAndRefresh } = useSyncAndRefresh();
  const { isOnline, hasCloudEndpoint, isConnected, pendingCount, formattedLastSync, lastSyncError, isReady } = useSyncStatus();

  const routeTitle = getRouteContextTitle(pathname || '/');

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
            <img src="/kinova-header-logo.png" alt="Kinova" className="h-8 w-auto object-contain block" />
          </Link>
          <span className="cockpit-topbar-page-title">{routeTitle}</span>
          {pendingCount > 0 ? (
            <Link
              href="/settings"
              className={`cockpit-sync-state ${statusClass}`}
              title={lastSyncError || 'Click to view or clear pending sync items in Settings'}
            >
              <i aria-hidden="true" />
              <span>{statusLabel}</span>
            </Link>
          ) : (
            <span className={`cockpit-sync-state ${statusClass}`} title={lastSyncError || statusLabel}>
              <i aria-hidden="true" />
              <span>{statusLabel}</span>
            </span>
          )}
        </div>

        <div className="cockpit-topbar-actions" aria-live="polite">
          <button
            type="button"
            onClick={() => setKinovaAIOpen(true)}
            className="cockpit-ask-btn"
            title="Ask Kinova AI (Ctrl+K / Cmd+K)"
            aria-label="Open Kinova AI"
          >
            <span className="cockpit-ask-dot" aria-hidden="true" />
            <span className="hidden sm:inline whitespace-nowrap">Ask Kinova</span>
            <span className="sm:hidden">Ask</span>
            <kbd className="cockpit-ask-kbd">⌘K</kbd>
          </button>
          <ThemeToggle className="cockpit-icon-button" />
          <button
            type="button"
            onClick={() => void syncAndRefresh()}
            disabled={isRefreshing}
            className="cockpit-icon-button"
            title="Sync with cloud database and refresh all latest data"
            aria-label={isRefreshing ? 'Syncing data with cloud' : justRefreshed ? 'Data synced' : 'Sync and refresh data'}
          >
            {isRefreshing ? (
              <LoaderCircle className="spin" size={16} />
            ) : justRefreshed ? (
              <Check size={16} />
            ) : (
              <RefreshCw size={16} />
            )}
          </button>
        </div>
      </div>
    </header>
  );
}
