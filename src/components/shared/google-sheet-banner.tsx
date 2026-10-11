'use client';

import React, { useState, useSyncExternalStore } from 'react';
import { Link2, ExternalLink, X, CloudAlert } from 'lucide-react';
import { getApiUrl, setCustomApiUrl } from '@/lib/sheets-api';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useSyncStatus } from '@/hooks/useSyncStatus';
import { confirmAction } from '@/stores/confirm-dialog-store';

const getClientHydrationSnapshot = () => true;
const getServerHydrationSnapshot = () => false;
const getServerApiUrlSnapshot = () => '';
const subscribeToNothing = () => () => {};
const subscribeToHydration = (callback: () => void) => {
  window.addEventListener('storage', callback);
  window.addEventListener('cashflow_api_url_changed', callback);
  window.addEventListener('cashflow_banner_state_changed', callback);
  return () => {
    window.removeEventListener('storage', callback);
    window.removeEventListener('cashflow_api_url_changed', callback);
    window.removeEventListener('cashflow_banner_state_changed', callback);
  };
};
const getDismissedSnapshot = () => localStorage.getItem('cashflow_banner_dismissed') === 'true';
const getServerDismissedSnapshot = () => false;

export function GoogleSheetBanner() {
  const queryClient = useQueryClient();
  const { isOnline, isConnected, pendingCount, failedCount, formattedLastSync, lastSyncError } = useSyncStatus();
  const apiUrl = useSyncExternalStore(subscribeToHydration, getApiUrl, getServerApiUrlSnapshot);
  const [inputUrl, setInputUrl] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const mounted = useSyncExternalStore(subscribeToNothing, getClientHydrationSnapshot, getServerHydrationSnapshot);
  const isDismissed = useSyncExternalStore(subscribeToHydration, getDismissedSnapshot, getServerDismissedSnapshot);

  const handleDismiss = () => {
    localStorage.setItem('cashflow_banner_dismissed', 'true');
    window.dispatchEvent(new Event('cashflow_banner_state_changed'));
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputUrl.trim()) {
      toast.error('Please enter your Google Apps Script URL');
      return;
    }

    setCustomApiUrl(inputUrl.trim());
    setIsEditing(false);
    toast.success('Saved Google Sheets connection settings.');
    queryClient.invalidateQueries({ queryKey: ['sheet'] });
  };

  const handleDisconnect = async () => {
    const ok = await confirmAction({
      title: 'Switch to Local-only Mode?',
      description: 'This browser will stop reading from Google Sheets. Sheet records are not copied into the separate local database, and new local records will not sync to other devices. Reconnect to see your Sheet data again.',
      confirmText: 'Switch to Local-only',
      cancelText: 'Stay Connected',
      variant: 'warning',
      icon: 'alert',
    });
    if (!ok) return;
    setCustomApiUrl('');
    setInputUrl('');
    toast.info('Local-only mode is on. New records stay in this browser until you reconnect.');
    queryClient.invalidateQueries({ queryKey: ['sheet'] });
  };

  if (!mounted || (isDismissed && apiUrl)) return null;

  const isFullySynced = isOnline && pendingCount === 0;
  const statusMessage = !isOnline
    ? pendingCount > 0
      ? `Offline · ${pendingCount} change${pendingCount === 1 ? '' : 's'} queued to sync`
      : `Offline · viewing cached data (last sync ${formattedLastSync})`
    : pendingCount > 0
      ? `Syncing ${pendingCount} pending change${pendingCount === 1 ? '' : 's'} to Google Sheets...`
      : `Connected to your Google Sheet · Synced (${formattedLastSync})`;

  return (
    <div className="w-full mb-6">
      {apiUrl ? (
        <div className={`flex flex-wrap items-center justify-between gap-3 p-3.5 rounded-2xl border backdrop-blur-xl ${isFullySynced ? 'border-emerald-500/20 bg-emerald-950/20 text-emerald-800 dark:text-emerald-300' : 'border-amber-500/25 bg-amber-950/20 text-amber-800 dark:text-amber-300'}`}>
          <div className="flex min-w-0 items-center gap-2.5" title={lastSyncError || undefined}>
            {isFullySynced
              ? <span className="flex h-2.5 w-2.5 rounded-full bg-emerald-400 animate-pulse" />
              : <CloudAlert className="h-4 w-4" />}
            <span className="text-xs md:text-sm font-medium">
              {statusMessage}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <a
              href="https://drive.google.com"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 transition-colors"
            >
              <span>Open in Drive</span>
              <ExternalLink className="h-3 w-3" />
            </a>
            <button
              onClick={() => { setInputUrl(apiUrl); setIsEditing(true); }}
              className="text-xs px-2 py-1 text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white"
            >
              Change
            </button>
            <button
              onClick={handleDismiss}
              className="p-1 rounded-lg text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white transition-colors"
              title="Dismiss banner"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ) : (
        // Not Connected State
        <div className="p-4 rounded-2xl border border-indigo-500/30 bg-gradient-to-r from-indigo-950/40 via-purple-950/30 to-black backdrop-blur-xl">
          {!isEditing ? (
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-indigo-800 dark:text-indigo-400 font-semibold text-sm">
                  <Link2 className="h-4 w-4" />
                  <span>Local-only mode</span>
                </div>
                <p className="text-xs text-slate-600 dark:text-zinc-400">
                  New records are stored only in this browser and do not sync. Your Google Sheet data is separate and will appear again when you reconnect.
                </p>
              </div>
              <button
                onClick={() => setIsEditing(true)}
                className="px-4 py-2 rounded-xl bg-indigo-500 hover:bg-indigo-600 text-white dark:text-white font-medium text-xs shadow-md transition-colors cursor-pointer"
              >
                Connect Google Sheets
              </button>
            </div>
          ) : (
            <form onSubmit={handleSave} className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-950 dark:text-white">Paste your Google Apps Script Web App URL:</span>
                <button
                  type="button"
                  onClick={() => setIsEditing(false)}
                  className="text-slate-500 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="flex gap-2">
                <input
                  type="url"
                  required
                  placeholder="https://script.google.com/macros/s/.../exec"
                  value={inputUrl}
                  onChange={(e) => setInputUrl(e.target.value)}
                  className="flex-1 rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-2 text-xs text-slate-950 dark:text-white placeholder-zinc-600 outline-none focus:border-indigo-500"
                />
                <button
                  type="submit"
                  className="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white dark:text-white text-xs font-semibold"
                >
                  Save & Connect
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {/* Edit modal when already connected */}
      {isEditing && apiUrl && (
        <form onSubmit={handleSave} className="mt-2 p-3 rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 space-y-2">
          <input
            type="url"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            placeholder="https://script.google.com/macros/s/.../exec"
            className="w-full rounded-lg border border-slate-300 dark:border-zinc-700 bg-slate-50 dark:bg-black px-3 py-1.5 text-xs text-slate-950 dark:text-white outline-none"
          />
          <div className="flex justify-between items-center">
            <button
              type="button"
              onClick={handleDisconnect}
              className="text-xs text-rose-800 dark:text-rose-400 hover:underline"
            >
              Switch to Local-only mode
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setIsEditing(false)}
                className="px-3 py-1 text-xs text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-3 py-1 rounded-lg bg-indigo-500 text-white dark:text-white text-xs font-medium"
              >
                Update URL
              </button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}
