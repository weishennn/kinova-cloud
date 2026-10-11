'use client';

import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { Check, ExternalLink, Link2, RefreshCw, Settings2, Unlink } from 'lucide-react';
import { getCategoryEmoji } from '@/lib/design-tokens';
import {
  convertSplitwiseAmount,
  fetchSplitwiseTripSnapshot,
  formatSplitwiseCategory,
  formatSplitwiseMoney,
  getCachedSplitwiseSnapshot,
  getCustomSplitwiseAppUrl,
  getSavedSplitwiseConnection,
  getSplitwiseOpenUrl,
  hasSplitwiseCloudConfig,
  pingTrixpenseKeepAlive,
  resolveSplitwiseSummaryInCurrency,
  saveSplitwiseConnection,
  setCustomSplitwiseAppUrl,
  summarizeSplitwiseMember,
  type SavedSplitwiseConnection,
  type SplitwiseTripSnapshot,
} from '@/lib/splitwise';

interface SplitwiseTripPanelProps {
  tripId: string;
  tripName: string;
  tripCurrency?: string;
  tripRateToMyr?: number;
  onSyncUpdate?: () => void;
}

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

export function SplitwiseTripPanel({
  tripId,
  tripName,
  tripCurrency = 'MYR',
  tripRateToMyr = 1,
  onSyncUpdate,
}: SplitwiseTripPanelProps) {
  const domKey = tripId.replace(/[^a-zA-Z0-9_-]/g, '-');
  const [connection, setConnection] = useState<SavedSplitwiseConnection | null>(null);
  const [codeDraft, setCodeDraft] = useState('');
  const [snapshot, setSnapshot] = useState<SplitwiseTripSnapshot | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [storageWarning, setStorageWarning] = useState(false);

  // Custom Trixpense URL configuration state
  const [showUrlSettings, setShowUrlSettings] = useState(false);
  const [appUrlDraft, setAppUrlDraft] = useState('');
  const [urlSavedNotice, setUrlSavedNotice] = useState(false);

  useEffect(() => {
    void pingTrixpenseKeepAlive();
    setAppUrlDraft(
      getCustomSplitwiseAppUrl() ||
        process.env.NEXT_PUBLIC_TRIXPENSE_APP_URL ||
        process.env.NEXT_PUBLIC_SPLITWISE_APP_URL ||
        '',
    );
    if (!hasSplitwiseCloudConfig()) {
      setShowUrlSettings(true);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const timeoutId = window.setTimeout(() => {
      const saved = getSavedSplitwiseConnection(tripId);
      if (saved) {
        setConnection(saved);
        setCodeDraft(saved.inviteCode);
        const cached = getCachedSplitwiseSnapshot(saved.inviteCode);
        if (cached) {
          setSnapshot(cached);
          setLoadState('ready');
        } else {
          setLoadState('loading');
        }

        void fetchSplitwiseTripSnapshot(saved.inviteCode)
          .then(data => {
            if (!active) return;
            const validMember = data.members.find(member => member.id === saved.memberId);
            const preferredMember =
              validMember ||
              data.members.find(m => /wei\s*shen/i.test(m.display_name)) ||
              data.members[0];
            const autoMemberId = preferredMember?.id || '';
            const nextConnection: SavedSplitwiseConnection = {
              inviteCode: saved.inviteCode,
              memberId: autoMemberId,
              includeInBudget: saved.includeInBudget !== false,
            };
            setSnapshot(data);
            setConnection(nextConnection);
            setStorageWarning(!saveSplitwiseConnection(tripId, nextConnection));
            setLoadState('ready');
            setErrorMessage('');
            onSyncUpdate?.();
          })
          .catch(error => {
            if (!active) return;
            setLoadState(cached ? 'ready' : 'error');
            setErrorMessage(
              error instanceof Error ? error.message : 'Could not load the linked Trixpense trip.',
            );
          });
      }
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timeoutId);
    };
  }, [tripId]);

  const selectedMemberId = connection?.memberId || '';
  const summaryResult = useMemo(() => {
    if (!snapshot || !selectedMemberId) return { value: null, error: '' };
    try {
      return { value: summarizeSplitwiseMember(snapshot, selectedMemberId), error: '' };
    } catch (error) {
      return {
        value: null,
        error: error instanceof Error ? error.message : 'Could not total the linked trip.',
      };
    }
  }, [selectedMemberId, snapshot]);
  const memberSummary = summaryResult.value;
  const linkToTrixpense = connection ? getSplitwiseOpenUrl(connection.inviteCode) : null;

  const normalizedTripCurr = (tripCurrency || 'MYR').toUpperCase();
  const splitwiseBase = snapshot?.trip.base_currency || 'MYR';

  // Exact native-aware summaries in Kinova's trip currency and MYR (no MYR -> CNY -> MYR drift!)
  const resolvedInTripCurrency = useMemo(() => {
    if (!snapshot || !selectedMemberId) return null;
    try {
      return resolveSplitwiseSummaryInCurrency(
        snapshot,
        selectedMemberId,
        normalizedTripCurr,
        normalizedTripCurr,
        tripRateToMyr,
      );
    } catch {
      return null;
    }
  }, [snapshot, selectedMemberId, normalizedTripCurr, tripRateToMyr]);

  const resolvedInMyr = useMemo(() => {
    if (!snapshot || !selectedMemberId) return null;
    try {
      return resolveSplitwiseSummaryInCurrency(
        snapshot,
        selectedMemberId,
        'MYR',
        normalizedTripCurr,
        tripRateToMyr,
      );
    } catch {
      return null;
    }
  }, [snapshot, selectedMemberId, normalizedTripCurr, tripRateToMyr]);

  const memberNameMap = useMemo(() => {
    const map = new Map<string, string>();
    snapshot?.members.forEach(m => map.set(m.id, m.display_name));
    return map;
  }, [snapshot]);

  const handleSaveAppUrl = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      setCustomSplitwiseAppUrl(appUrlDraft);
      setErrorMessage('');
      setUrlSavedNotice(true);
      window.setTimeout(() => setUrlSavedNotice(false), 2500);
      setShowUrlSettings(false);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Invalid Trixpense App URL.');
    }
  };

  const connect = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const inviteCode = codeDraft.trim().toUpperCase();
    setLoadState('loading');
    setErrorMessage('');
    try {
      const data = await fetchSplitwiseTripSnapshot(inviteCode);
      const preferredMember =
        data.members.find(member => member.id === connection?.memberId) ||
        data.members.find(m => /wei\s*shen/i.test(m.display_name)) ||
        data.members[0];
      const memberId = preferredMember?.id || '';
      setSnapshot(data);
      const nextConnection: SavedSplitwiseConnection = {
        inviteCode,
        memberId,
        includeInBudget: connection?.includeInBudget !== false,
      };
      setConnection(nextConnection);
      setStorageWarning(!saveSplitwiseConnection(tripId, nextConnection));
      setLoadState('ready');
      onSyncUpdate?.();
    } catch (error) {
      setLoadState(connection ? 'ready' : 'error');
      setErrorMessage(
        error instanceof Error ? error.message : 'Could not connect to that Trixpense trip.',
      );
    }
  };

  const refresh = async () => {
    if (!connection) return;
    setLoadState('loading');
    setErrorMessage('');
    try {
      const data = await fetchSplitwiseTripSnapshot(connection.inviteCode);
      setSnapshot(data);
      if (!data.members.some(member => member.id === connection.memberId)) {
        const fallback =
          data.members.find(m => /wei\s*shen/i.test(m.display_name)) || data.members[0];
        const nextConnection: SavedSplitwiseConnection = {
          ...connection,
          memberId: fallback?.id || '',
        };
        setConnection(nextConnection);
        setStorageWarning(!saveSplitwiseConnection(tripId, nextConnection));
      }
      setLoadState('ready');
      onSyncUpdate?.();
    } catch (error) {
      setLoadState('error');
      setErrorMessage(
        error instanceof Error ? error.message : 'Could not refresh the linked Trixpense trip.',
      );
    }
  };

  const disconnect = () => {
    setConnection(null);
    setSnapshot(null);
    setCodeDraft('');
    setStorageWarning(!saveSplitwiseConnection(tripId, null));
    setLoadState('idle');
    setErrorMessage('');
    onSyncUpdate?.();
  };

  const recentExpenses =
    snapshot?.expenses
      .filter(expense => !expense.is_settlement && expense.category !== '__deleted__')
      .slice()
      .sort((a, b) => b.expense_date.localeCompare(a.expense_date))
      .slice(0, 8) || [];

  const renderSecondaryEquivalent = (
    field: 'groupTotal' | 'memberShare' | 'memberPaid' | 'netBalance',
    fallbackAmountInSwBase: number,
  ) => {
    if (!Number.isFinite(fallbackAmountInSwBase) && !resolvedInTripCurrency && !resolvedInMyr) {
      return null;
    }
    const parts: string[] = [];
    if (splitwiseBase !== normalizedTripCurr && resolvedInTripCurrency) {
      const val =
        field === 'netBalance'
          ? Math.abs(resolvedInTripCurrency.netBalance)
          : resolvedInTripCurrency[field];
      if (Math.abs(val) > 0.005) {
        parts.push(`≈ ${formatSplitwiseMoney(val, normalizedTripCurr)}`);
      }
    }
    if (splitwiseBase !== 'MYR' && normalizedTripCurr !== 'MYR' && resolvedInMyr) {
      const val =
        field === 'netBalance' ? Math.abs(resolvedInMyr.netBalance) : resolvedInMyr[field];
      if (Math.abs(val) > 0.005) {
        parts.push(`RM ${val.toFixed(2)}`);
      }
    }
    if (!parts.length) return null;
    return (
      <p className="mt-0.5 text-[11px] font-mono tabular-nums text-indigo-800 dark:text-indigo-300">
        {parts.join(' · ')}
      </p>
    );
  };

  return (
    <section
      className="rounded-3xl border border-indigo-300/50 dark:border-indigo-400/15 bg-indigo-50/65 dark:bg-indigo-500/[0.045] p-4 sm:p-5 space-y-4"
      aria-labelledby={`splitwise-heading-${domKey}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-indigo-500/10 text-indigo-700 dark:text-indigo-300">
            <Link2 className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h3
                id={`splitwise-heading-${domKey}`}
                className="text-sm font-bold text-slate-950 dark:text-white"
              >
                Trixpense Shared Trip
              </h3>
              {connection && (
                <>
                  <span className="text-[10px] font-mono font-semibold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border border-emerald-500/25">
                    Linked · {connection.inviteCode}
                  </span>
                  {connection.includeInBudget !== false && (
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-indigo-500/15 text-indigo-800 dark:text-indigo-300 border border-indigo-500/25">
                      ✓ Synced to Flow &amp; Overview
                    </span>
                  )}
                </>
              )}
            </div>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-slate-700 dark:text-zinc-300">
              Sync group totals, exact paid currencies, and your personal share in real time. Your
              personal share is automatically included in Kinova Flow, Overview, and Trip Budget.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setShowUrlSettings(prev => !prev)}
            title="Configure Trixpense App URL"
            className="inline-flex min-h-9 items-center gap-1.5 rounded-xl border border-slate-300 dark:border-white/10 px-2.5 text-xs font-semibold text-slate-700 dark:text-zinc-300 hover:bg-white/70 dark:hover:bg-white/[0.06]"
          >
            <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">App URL</span>
          </button>
          {connection && (
            <>
              <button
                type="button"
                onClick={() => void refresh()}
                disabled={loadState === 'loading'}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-xl border border-slate-300 dark:border-white/10 px-3 text-xs font-semibold text-slate-800 dark:text-zinc-200 hover:bg-white/70 dark:hover:bg-white/[0.06] disabled:opacity-50"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${loadState === 'loading' ? 'animate-spin' : ''}`}
                  aria-hidden="true"
                />
                Refresh
              </button>
              <button
                type="button"
                onClick={disconnect}
                disabled={loadState === 'loading'}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-xl border border-slate-300 dark:border-white/10 px-3 text-xs font-semibold text-slate-700 dark:text-zinc-300 hover:bg-white/70 dark:hover:bg-white/[0.06]"
              >
                <Unlink className="h-3.5 w-3.5" aria-hidden="true" />
                Unlink
              </button>
            </>
          )}
        </div>
      </div>

      {showUrlSettings && (
        <form
          onSubmit={handleSaveAppUrl}
          className="rounded-2xl border border-indigo-300/60 dark:border-white/10 bg-white/80 dark:bg-zinc-950/60 p-3.5 space-y-2"
        >
          <div className="flex items-center justify-between gap-2">
            <label
              htmlFor={`splitwise-url-${domKey}`}
              className="block text-xs font-semibold text-slate-800 dark:text-zinc-200"
            >
              Trixpense App URL (Vercel deployment)
            </label>
            {urlSavedNotice && (
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
                <Check className="h-3 w-3" /> Saved
              </span>
            )}
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              id={`splitwise-url-${domKey}`}
              type="url"
              value={appUrlDraft}
              onChange={e => setAppUrlDraft(e.target.value)}
              placeholder="https://your-trixpense.vercel.app"
              className="h-10 flex-1 rounded-xl border border-slate-300 dark:border-white/10 bg-white dark:bg-zinc-900 px-3 text-xs font-mono text-slate-950 dark:text-white outline-none focus:border-indigo-500/70"
            />
            <button
              type="submit"
              className="h-10 rounded-xl bg-slate-900 dark:bg-indigo-600 px-4 text-xs font-semibold text-white hover:opacity-90"
            >
              Save URL
            </button>
          </div>
          <p className="text-[11px] text-slate-600 dark:text-zinc-400">
            Paste your deployed Trixpense URL once (saved on this device).
          </p>
        </form>
      )}

      <form onSubmit={connect} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div>
          <label
            htmlFor={`splitwise-code-${domKey}`}
            className="mb-1.5 block text-xs font-semibold text-slate-800 dark:text-zinc-200"
          >
            Trixpense 8-character invite code for {tripName}
          </label>
          <input
            id={`splitwise-code-${domKey}`}
            value={codeDraft}
            onChange={event =>
              setCodeDraft(
                event.target.value
                  .replace(/[^a-z0-9]/gi, '')
                  .slice(0, 8)
                  .toUpperCase(),
              )
            }
            placeholder="e.g. A1B2C3D4"
            autoComplete="off"
            maxLength={8}
            aria-describedby={`splitwise-help-${domKey}`}
            className="h-11 w-full rounded-xl border border-slate-300 dark:border-white/10 bg-white dark:bg-zinc-950/50 px-3.5 text-sm font-mono uppercase tracking-widest text-slate-950 dark:text-white outline-none focus:border-indigo-500/70 focus:ring-2 focus:ring-indigo-500/20"
          />
          <p
            id={`splitwise-help-${domKey}`}
            className="mt-1.5 text-[11px] text-slate-600 dark:text-zinc-400"
          >
            Copy the 8-character invite code from your Trixpense trip header or gateway card.
          </p>
        </div>
        <button
          type="submit"
          disabled={loadState === 'loading' || codeDraft.trim().length !== 8}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loadState === 'loading' ? (
            <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Link2 className="h-4 w-4" aria-hidden="true" />
          )}
          {connection ? 'Reconnect / Sync' : 'Connect Trip'}
        </button>
      </form>

      {loadState === 'loading' && !snapshot && (
        <p className="text-xs text-slate-600 dark:text-zinc-400" role="status">
          Loading shared trip…
        </p>
      )}
      {errorMessage && (
        <p
          className="rounded-xl border border-rose-500/20 bg-rose-500/5 px-3 py-2.5 text-xs text-rose-800 dark:text-rose-300"
          role="alert"
        >
          {errorMessage}
          {connection ? ' Showing last synced snapshot.' : ''}
        </p>
      )}
      {summaryResult.error && (
        <p className="text-xs text-rose-800 dark:text-rose-300" role="alert">
          {summaryResult.error}
        </p>
      )}
      {storageWarning && (
        <p className="text-xs text-amber-800 dark:text-amber-300" role="status">
          Browser storage is unavailable, so this link may not be remembered after closing the app.
        </p>
      )}

      {snapshot && connection && (
        <div className="space-y-4 border-t border-indigo-300/40 dark:border-white/[0.08] pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-bold text-slate-950 dark:text-white">
                {snapshot.trip.name}
              </p>
              <p className="text-[11px] text-slate-600 dark:text-zinc-400">
                Trixpense base currency: <strong>{snapshot.trip.base_currency}</strong> ·{' '}
                {snapshot.members.length} member{snapshot.members.length === 1 ? '' : 's'} ·{' '}
                {snapshot.expenses.filter(e => !e.is_settlement && e.category !== '__deleted__').length} shared expense
                {snapshot.expenses.filter(e => !e.is_settlement && e.category !== '__deleted__').length === 1 ? '' : 's'}
              </p>
            </div>
            {linkToTrixpense && (
              <a
                href={linkToTrixpense}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-indigo-500/25 bg-white/70 dark:bg-white/[0.04] px-3 text-xs font-semibold text-indigo-800 dark:text-indigo-300 hover:bg-white dark:hover:bg-white/[0.08]"
              >
                Open in Trixpense <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2 sm:items-end">
            <div>
              <label
                htmlFor={`splitwise-member-${domKey}`}
                className="mb-1.5 block text-xs font-semibold text-slate-800 dark:text-zinc-200"
              >
                Who are you in this Trixpense trip?
              </label>
              <select
                id={`splitwise-member-${domKey}`}
                value={connection.memberId}
                onChange={event => {
                  const nextConnection: SavedSplitwiseConnection = {
                    ...connection,
                    memberId: event.target.value,
                  };
                  setConnection(nextConnection);
                  setStorageWarning(!saveSplitwiseConnection(tripId, nextConnection));
                  onSyncUpdate?.();
                }}
                className="h-11 w-full rounded-xl border border-slate-300 dark:border-white/10 bg-white dark:bg-zinc-950/50 px-3.5 text-sm text-slate-950 dark:text-white outline-none focus:border-indigo-500/70 focus:ring-2 focus:ring-indigo-500/20"
              >
                <option value="">Select your name…</option>
                {snapshot.members.map(member => (
                  <option key={member.id} value={member.id}>
                    {member.display_name}
                  </option>
                ))}
              </select>
            </div>

            <label className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-xl border border-slate-200/90 dark:border-white/10 bg-white/75 dark:bg-zinc-950/40 px-3.5 py-2 text-xs font-medium text-slate-800 dark:text-zinc-200">
              <input
                type="checkbox"
                checked={connection.includeInBudget !== false}
                onChange={event => {
                  const nextConnection: SavedSplitwiseConnection = {
                    ...connection,
                    includeInBudget: event.target.checked,
                  };
                  setConnection(nextConnection);
                  setStorageWarning(!saveSplitwiseConnection(tripId, nextConnection));
                  onSyncUpdate?.();
                }}
                className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
              />
              <span>Include my share in Trip Budget progress</span>
            </label>
          </div>

          {memberSummary && (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <div className="rounded-2xl border border-slate-200 dark:border-white/[0.08] bg-white/75 dark:bg-zinc-950/40 p-3">
                  <p className="text-[11px] font-medium text-slate-600 dark:text-zinc-400">
                    Group total
                  </p>
                  <p className="mt-1 font-mono text-sm sm:text-base font-bold tabular-nums text-slate-950 dark:text-white">
                    {formatSplitwiseMoney(memberSummary.groupTotal, splitwiseBase)}
                  </p>
                  {renderSecondaryEquivalent('groupTotal', memberSummary.groupTotal)}
                </div>

                <div className="rounded-2xl border border-indigo-500/30 bg-indigo-500/[0.08] dark:bg-indigo-500/[0.12] p-3">
                  <p className="text-[11px] font-semibold text-indigo-900 dark:text-indigo-200">
                    Your share
                  </p>
                  <p className="mt-1 font-mono text-sm sm:text-base font-bold tabular-nums text-indigo-950 dark:text-white">
                    {formatSplitwiseMoney(memberSummary.memberShare, splitwiseBase)}
                  </p>
                  {renderSecondaryEquivalent('memberShare', memberSummary.memberShare)}
                </div>

                <div className="rounded-2xl border border-slate-200 dark:border-white/[0.08] bg-white/75 dark:bg-zinc-950/40 p-3">
                  <p className="text-[11px] font-medium text-slate-600 dark:text-zinc-400">
                    Paid by you
                  </p>
                  <p className="mt-1 font-mono text-sm sm:text-base font-bold tabular-nums text-slate-950 dark:text-white">
                    {formatSplitwiseMoney(memberSummary.memberPaid, splitwiseBase)}
                  </p>
                  {renderSecondaryEquivalent('memberPaid', memberSummary.memberPaid)}
                </div>

                <div className="rounded-2xl border border-slate-200 dark:border-white/[0.08] bg-white/75 dark:bg-zinc-950/40 p-3">
                  <p className="text-[11px] font-medium text-slate-600 dark:text-zinc-400">
                    {memberSummary.netBalance > 0.005
                      ? 'Friends owe you'
                      : memberSummary.netBalance < -0.005
                        ? 'You owe group'
                        : 'Net balance'}
                  </p>
                  <p
                    className={`mt-1 font-mono text-sm sm:text-base font-bold tabular-nums ${
                      memberSummary.netBalance > 0.005
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : memberSummary.netBalance < -0.005
                          ? 'text-rose-700 dark:text-rose-400'
                          : 'text-slate-950 dark:text-white'
                    }`}
                  >
                    {memberSummary.netBalance > 0.005 ? '+' : ''}
                    {formatSplitwiseMoney(memberSummary.netBalance, splitwiseBase)}
                  </p>
                  {renderSecondaryEquivalent('netBalance', Math.abs(memberSummary.netBalance))}
                </div>
              </div>

              {/* Exact Paid Currency Breakdown (Zero FX Conversion Drift) */}
              {memberSummary.nativeByCurrency.length > 0 && (
                <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.06] dark:bg-emerald-500/[0.08] p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="text-[11px] font-bold text-emerald-950 dark:text-emerald-200">
                      💱 Exact Paid Currency Breakdown (Zero FX Conversion Error)
                    </span>
                    <span className="text-[10px] font-mono text-emerald-800 dark:text-emerald-300">
                      Recorded in exact paid currency
                    </span>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {memberSummary.nativeByCurrency.map(bucket => (
                      <div
                        key={bucket.currency}
                        className="rounded-xl border border-slate-200/80 dark:border-white/10 bg-white/80 dark:bg-zinc-950/60 p-2.5 text-xs space-y-1"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-mono font-bold text-indigo-800 dark:text-indigo-300">
                            Paid in {bucket.currency}
                          </span>
                          <span className="font-mono font-semibold text-slate-900 dark:text-white">
                            Group: {formatSplitwiseMoney(bucket.groupTotal, bucket.currency)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-[11px] text-slate-600 dark:text-zinc-400 font-mono">
                          <span>Your share: {formatSplitwiseMoney(bucket.memberShare, bucket.currency)}</span>
                          <span>You paid: {formatSplitwiseMoney(bucket.memberPaid, bucket.currency)}</span>
                        </div>
                        <div className="flex items-center justify-between text-[11px] font-mono pt-1 border-t border-slate-200/60 dark:border-white/[0.06]">
                          <span className="text-slate-600 dark:text-zinc-400">
                            {bucket.netBalance > 0.005
                              ? `Owed to you (${bucket.currency})`
                              : bucket.netBalance < -0.005
                                ? `You owe (${bucket.currency})`
                                : `Settled (${bucket.currency})`}
                          </span>
                          <span
                            className={`font-bold ${
                              bucket.netBalance > 0.005
                                ? 'text-emerald-700 dark:text-emerald-400'
                                : bucket.netBalance < -0.005
                                  ? 'text-rose-700 dark:text-rose-400'
                                  : 'text-slate-700 dark:text-zinc-300'
                            }`}
                          >
                            {bucket.netBalance > 0.005 ? '+' : ''}
                            {formatSplitwiseMoney(bucket.netBalance, bucket.currency)}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <p className="text-[11px] text-slate-600 dark:text-zinc-400">
                Your share is your portion of shared purchases. “Paid by you” is what you fronted
                for the group. MYR expenses stay exact in MYR and CNY expenses stay exact in CNY.
              </p>

              {memberSummary.categories.length > 0 && (
                <div>
                  <h4 className="mb-2 text-xs font-bold text-slate-800 dark:text-zinc-200">
                    Your share by category (synced with Kinova)
                  </h4>
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {memberSummary.categories.map(category => (
                      <div
                        key={category.key}
                        className="flex items-center justify-between gap-3 rounded-xl bg-white/65 dark:bg-white/[0.025] px-3 py-2 text-xs"
                      >
                        <span className="break-words leading-snug font-medium text-slate-700 dark:text-zinc-300">
                          {getCategoryEmoji(category.name)} {category.name}
                        </span>
                        <div className="shrink-0 text-right">
                          <span className="font-mono font-semibold tabular-nums text-slate-950 dark:text-white">
                            {formatSplitwiseMoney(category.amount, splitwiseBase)}
                          </span>
                          {splitwiseBase !== normalizedTripCurr && (
                            <span className="ml-1.5 text-[10px] font-mono text-indigo-800 dark:text-indigo-300">
                              (≈{' '}
                              {formatSplitwiseMoney(
                                convertSplitwiseAmount(
                                  category.amount,
                                  splitwiseBase,
                                  normalizedTripCurr,
                                  normalizedTripCurr,
                                  tripRateToMyr,
                                ),
                                normalizedTripCurr,
                              )}
                              )
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <h4 className="mb-2 text-xs font-bold text-slate-800 dark:text-zinc-200">
                  Recent shared expenses
                </h4>
                {recentExpenses.length ? (
                  <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
                    {recentExpenses.map(expense => {
                      const myShareBase = expense.splits[connection.memberId] || 0;
                      const payerName =
                        memberNameMap.get(expense.paid_by_member_id) || 'Group member';
                      const isForeignExpense = expense.currency !== splitwiseBase;
                      const catName = formatSplitwiseCategory(expense.category);
                      return (
                        <div
                          key={expense.id}
                          className="flex items-center justify-between gap-3 rounded-xl bg-white/50 dark:bg-white/[0.02] px-3 py-2.5 hover:bg-white/80 dark:hover:bg-white/[0.04]"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-xs font-semibold text-slate-900 dark:text-zinc-100">
                              {getCategoryEmoji(catName)} {expense.title}
                            </p>
                            <p className="text-[10px] text-slate-600 dark:text-zinc-400">
                              {expense.expense_date} · {catName} · Paid by {payerName} (
                              {formatSplitwiseMoney(expense.amount, expense.currency)})
                            </p>
                            {isForeignExpense && (
                              <p className="mt-0.5 text-[10px] font-mono text-indigo-800 dark:text-indigo-300">
                                Paid: {formatSplitwiseMoney(expense.amount, expense.currency)} →{' '}
                                {formatSplitwiseMoney(expense.base_amount, splitwiseBase)}
                              </p>
                            )}
                          </div>
                          <div className="shrink-0 text-right">
                            <p className="text-xs font-mono font-semibold tabular-nums text-slate-900 dark:text-zinc-100">
                              {formatSplitwiseMoney(myShareBase, splitwiseBase)}
                            </p>
                            {splitwiseBase !== normalizedTripCurr && myShareBase > 0 && (
                              <p className="text-[10px] font-mono tabular-nums text-indigo-800 dark:text-indigo-300">
                                ≈{' '}
                                {formatSplitwiseMoney(
                                  convertSplitwiseAmount(
                                    myShareBase,
                                    splitwiseBase,
                                    normalizedTripCurr,
                                    normalizedTripCurr,
                                    tripRateToMyr,
                                  ),
                                  normalizedTripCurr,
                                )}
                              </p>
                            )}
                            <p className="text-[10px] text-slate-500 dark:text-zinc-400">
                              your share
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="rounded-xl bg-white/60 dark:bg-white/[0.025] px-3 py-4 text-center text-xs text-slate-600 dark:text-zinc-400">
                    No shared expenses yet.
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
