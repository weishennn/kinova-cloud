'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  ShieldCheck,
  ShieldAlert,
  Users,
  Ban,
  CheckCircle2,
  RefreshCw,
  LogOut,
  ExternalLink,
  Sparkles,
  Clock,
  UserX,
  Plus,
} from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/components/auth-provider';

interface AdminUserEntry {
  email: string;
  name: string;
  picture?: string;
  role: 'admin' | 'user';
  status: 'active' | 'blocked';
  firstSeenAt: string;
  lastActiveAt: string;
  loginCount: number;
  aiCallCount: number;
  spreadsheetId?: string;
  blockedAt?: string;
  blockedReason?: string;
}

export function GoogleAccountAndAdminPanel() {
  const { googleUser, signOutGoogle } = useAuth();
  const [users, setUsers] = useState<AdminUserEntry[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [actionEmail, setActionEmail] = useState<string | null>(null);
  const [manualBlockEmail, setManualBlockEmail] = useState('');

  const fetchAdminUsers = useCallback(async () => {
    if (!googleUser?.isAdmin) return;
    setLoadingUsers(true);
    try {
      const res = await fetch('/api/admin/users', {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.success && Array.isArray(data.users)) {
        setUsers(data.users);
      }
    } catch (err) {
      console.warn('Failed to load admin user list:', err);
    } finally {
      setLoadingUsers(false);
    }
  }, [googleUser?.isAdmin]);

  useEffect(() => {
    if (googleUser?.isAdmin) {
      void fetchAdminUsers();
    }
  }, [googleUser?.isAdmin, fetchAdminUsers]);

  const handleToggleBlock = async (email: string, block: boolean) => {
    setActionEmail(email);
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          action: block ? 'block' : 'unblock',
          email,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        toast.error(data.message || 'Operation failed');
        return;
      }
      if (Array.isArray(data.users)) {
        setUsers(data.users);
      }
      toast.success(
        block
          ? `Blacklisted ${email} — access & Gemini AI disabled`
          : `Unblocked ${email} — access restored`
      );
    } catch {
      toast.error('Network error while updating user status');
    } finally {
      setActionEmail(null);
    }
  };

  const handleManualBlockSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = manualBlockEmail.trim().toLowerCase();
    if (!cleaned || !cleaned.includes('@')) {
      toast.error('Please enter a valid Google email address');
      return;
    }
    await handleToggleBlock(cleaned, true);
    setManualBlockEmail('');
  };

  return (
    <div className="space-y-6">
      {/* Google Account Status Card */}
      <div className="rounded-3xl border border-slate-200 dark:border-zinc-800/80 bg-white dark:bg-zinc-900/50 p-6 shadow-sm space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            {googleUser?.picture ? (
              <img
                src={googleUser.picture}
                alt={googleUser.name}
                className="h-12 w-12 rounded-2xl object-cover border border-slate-200 dark:border-zinc-700"
              />
            ) : (
              <div className="h-12 w-12 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-500 font-bold text-lg">
                {googleUser?.name ? googleUser.name.charAt(0).toUpperCase() : 'G'}
              </div>
            )}

            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-base font-bold text-slate-900 dark:text-white">
                  {googleUser ? googleUser.name : 'Google Drive Account'}
                </h2>
                {googleUser?.isAdmin ? (
                  <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30">
                    Admin Owner
                  </span>
                ) : googleUser ? (
                  <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">
                    Google Drive Connected
                  </span>
                ) : (
                  <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-slate-500/15 text-slate-600 dark:text-zinc-400">
                    Not Signed In
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-500 dark:text-zinc-400 mt-0.5">
                {googleUser
                  ? `${googleUser.email} • Automatically syncing to your personal Google Drive`
                  : 'Sign in with your Google Account to automatically save transactions & receipts in your own Google Drive.'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {googleUser?.spreadsheetUrl && (
              <a
                href={googleUser.spreadsheetUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3.5 py-2 rounded-xl border border-slate-200 dark:border-zinc-800 hover:bg-slate-100 dark:hover:bg-zinc-800 text-xs font-semibold text-slate-700 dark:text-zinc-200 flex items-center gap-1.5 transition-colors"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                <span>Open My Google Sheet</span>
              </a>
            )}

            {googleUser ? (
              <button
                type="button"
                onClick={() => void signOutGoogle()}
                className="px-3.5 py-2 rounded-xl border border-rose-500/30 bg-rose-500/10 hover:bg-rose-500/20 text-xs font-semibold text-rose-600 dark:text-rose-400 flex items-center gap-1.5 cursor-pointer transition-colors"
              >
                <LogOut className="h-3.5 w-3.5" />
                <span>Sign Out</span>
              </button>
            ) : (
              <a
                href="/api/auth/google/login?returnTo=/settings"
                className="px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold flex items-center gap-2 shadow-lg shadow-indigo-500/20 transition-all"
              >
                <span>Sign in with Google</span>
              </a>
            )}
          </div>
        </div>
      </div>

      {/* Admin User Registry & Blacklist Panel (Only visible to Admin) */}
      {googleUser?.isAdmin && (
        <div className="rounded-3xl border border-amber-500/30 bg-gradient-to-b from-amber-500/[0.04] to-transparent dark:bg-zinc-900/60 p-6 shadow-sm space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 dark:border-zinc-800 pb-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-2xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-500">
                <Users className="h-5 w-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-bold text-slate-900 dark:text-white">
                    Admin User Monitor & Blacklist
                  </h3>
                  <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-slate-200 dark:bg-zinc-800 text-slate-700 dark:text-zinc-300">
                    {users.length} {users.length === 1 ? 'user' : 'users'}
                  </span>
                </div>
                <p className="text-xs text-slate-500 dark:text-zinc-400">
                  See everyone using your Kinova app & Gemini API key. Block unrecognized accounts with one click.
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => void fetchAdminUsers()}
              disabled={loadingUsers}
              className="px-3.5 py-2 rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:bg-slate-50 dark:hover:bg-zinc-800 text-xs font-semibold text-slate-700 dark:text-zinc-200 flex items-center gap-1.5 cursor-pointer self-start sm:self-auto"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loadingUsers ? 'animate-spin' : ''}`} />
              <span>Refresh List</span>
            </button>
          </div>

          {/* Pre-block any email form */}
          <form onSubmit={handleManualBlockSubmit} className="flex flex-col sm:flex-row gap-2">
            <input
              type="email"
              placeholder="Enter Google email to blacklist directly (e.g. stranger@gmail.com)..."
              value={manualBlockEmail}
              onChange={(e) => setManualBlockEmail(e.target.value)}
              className="flex-1 rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-3.5 py-2 text-xs text-slate-900 dark:text-white outline-none focus:border-amber-500"
            />
            <button
              type="submit"
              className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer shrink-0"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Add to Blacklist</span>
            </button>
          </form>

          {/* Users Table / Cards */}
          <div className="space-y-2.5">
            {users.length === 0 ? (
              <div className="text-center py-8 text-xs text-slate-500 dark:text-zinc-400">
                {loadingUsers ? 'Loading registered users...' : 'No users recorded yet.'}
              </div>
            ) : (
              users.map((u) => {
                const isBlocked = u.status === 'blocked';
                const isSelfAdmin = u.role === 'admin';
                return (
                  <div
                    key={u.email}
                    className={`flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-2xl border transition-colors ${
                      isBlocked
                        ? 'border-rose-500/30 bg-rose-500/[0.04]'
                        : 'border-slate-200 dark:border-zinc-800/80 bg-white/80 dark:bg-zinc-950/60'
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      {u.picture ? (
                        <img
                          src={u.picture}
                          alt={u.name}
                          className="h-10 w-10 rounded-xl object-cover border border-slate-200 dark:border-zinc-800 shrink-0"
                        />
                      ) : (
                        <div className="h-10 w-10 rounded-xl bg-slate-200 dark:bg-zinc-800 flex items-center justify-center text-xs font-bold text-slate-700 dark:text-zinc-300 shrink-0">
                          {u.name ? u.name.charAt(0).toUpperCase() : '?'}
                        </div>
                      )}

                      <div className="min-w-0 space-y-0.5">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-bold text-slate-900 dark:text-white truncate">
                            {u.name}
                          </span>
                          <span className="text-[11px] text-slate-500 dark:text-zinc-400 font-mono truncate">
                            {u.email}
                          </span>
                          {isSelfAdmin ? (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-600 dark:text-amber-400">
                              You (Admin)
                            </span>
                          ) : isBlocked ? (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-500/15 text-rose-600 dark:text-rose-400 flex items-center gap-1">
                              <ShieldAlert className="h-3 w-3" />
                              Blacklisted
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                              <ShieldCheck className="h-3 w-3" />
                              Active
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-3 text-[11px] text-slate-500 dark:text-zinc-400 flex-wrap">
                          <span className="flex items-center gap-1">
                            <Sparkles className="h-3 w-3 text-indigo-400" />
                            AI Calls: <strong className="text-slate-700 dark:text-zinc-200">{u.aiCallCount || 0}</strong>
                          </span>
                          <span>Logins: {u.loginCount || 0}</span>
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            Last active: {u.lastActiveAt ? new Date(u.lastActiveAt).toLocaleString() : 'Never'}
                          </span>
                        </div>
                      </div>
                    </div>

                    {!isSelfAdmin && (
                      <div className="flex items-center gap-2 shrink-0">
                        {isBlocked ? (
                          <button
                            type="button"
                            disabled={actionEmail === u.email}
                            onClick={() => void handleToggleBlock(u.email, false)}
                            className="px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
                          >
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            <span>Unblock</span>
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={actionEmail === u.email}
                            onClick={() => void handleToggleBlock(u.email, true)}
                            className="px-3 py-1.5 rounded-xl border border-rose-500/40 bg-rose-500/10 hover:bg-rose-600 hover:text-white disabled:opacity-50 text-rose-600 dark:text-rose-400 text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-colors"
                          >
                            <Ban className="h-3.5 w-3.5" />
                            <span>Block / 拉黑</span>
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
