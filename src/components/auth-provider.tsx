'use client';

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { ShieldAlert, ShieldCheck, LogOut, HardDrive, Smartphone, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import {
  LOCAL_ONLY_ENDPOINT_SENTINEL,
  SYNC_STATUS_EVENT,
  backupPendingQueuesForAccount,
  restorePendingQueuesForAccount,
  getPendingQueueSummary,
  getPendingQueueOwnerScope,
  backupLocalStoreForLocalMode,
  restoreLocalStoreForLocalMode,
} from '@/lib/cache-manager';
import { clearInFlightOptimisticRows, sheetsData } from '@/lib/sheets-data';

export interface GoogleAccountProfile {
  email: string;
  name: string;
  picture?: string;
  isAdmin: boolean;
  spreadsheetId?: string;
  spreadsheetUrl?: string;
}

interface AuthContextType {
  authenticated: boolean;
  isTrustedDevice: boolean;
  lockApp: () => void;
  untrustDevice: () => void;
  changePin: (newPin: string) => boolean;
  currentPin: string;
  googleUser: GoogleAccountProfile | null;
  isLocalMode: boolean;
  signOutGoogle: () => Promise<boolean | void>;
  exitLocalMode: () => void;
  refreshGoogleSession: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  authenticated: false,
  isTrustedDevice: true,
  lockApp: () => {},
  untrustDevice: () => {},
  changePin: () => true,
  currentPin: '0000',
  googleUser: null,
  isLocalMode: false,
  signOutGoogle: async () => false,
  exitLocalMode: () => {},
  refreshGoogleSession: async () => {},
});

/**
 * Completely wipes all cached sheet data, settings, plans, and pending queues from localStorage
 * and in-memory optimistic caches whenever switching accounts or signing out so two accounts can NEVER see each other's data.
 */
function wipeAccountStorage(includeLocalStore = true, wipePendingQueues = true) {
  if (typeof window === 'undefined') return;
  try {
    clearInFlightOptimisticRows();
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (
        k.startsWith('cashflow_swr_') ||
        k.startsWith('swr:') ||
        k.startsWith('cashflow_month_') ||
        k.startsWith('cashflow_cache_') ||
        k.startsWith('cashflow_pre_sync_') ||
        k.startsWith('cashflow_sync_') ||
        k.startsWith('kinova_synced_shortcut_tx_ids')
      ) {
        keysToRemove.push(k);
      }
    }
    keysToRemove.forEach((k) => localStorage.removeItem(k));

    const explicitKeys = [
      'cashflow_installment_plans',
      'cashflow_recurring_commitments',
      'cashflow_category_caps',
      'cashflow_lhdn_tax_caps',
      'cashflow_lhdn_tax_rate',
      'cashflow_lhdn_tax_profile',
      'cashflow_monthly_budget',
      'cashflow_baseline_income',
      'cashflow_emergency_reserve',
      'cashflow_currency',
      ...(wipePendingQueues
        ? [
            'cashflow_pending_queue',
            'cashflow_pending_plan_mutations_v2',
            'cashflow_pending_settings_mutations',
          ]
        : []),
      'cashflow_deleted_tombstones_v1',
      'cashflow_sync_conflicts_v1',
      'cashflow_integrity_baseline_v1',
      'cashflow_plan_versions_v1',
      'cashflow_pre_migration_backup_done_v1',
      'cashflow_last_backup_check_at',
      'cashflow_last_synced_at',
      'cashflow_last_sync_error',
      'cashflow_last_sync_error_at',
      'cashflow_apps_script_url',
      'cashflow_api_key',
      'cashflow_server_proxy_token',
      'cashflow_trusted_device',
    ];
    explicitKeys.forEach((k) => localStorage.removeItem(k));

    if (includeLocalStore) {
      localStorage.removeItem('cashflow_local_store');
    }
    try {
      sessionStorage.removeItem('kinova_last_claimed_draft');
    } catch {
      // ignore
    }
  } catch (e) {
    console.warn('Failed to wipe account storage:', e);
  }
}

function preserveActivePendingQueues(): { success: boolean; error?: string } {
  const summary = getPendingQueueSummary();
  if (summary.total === 0) return { success: true };
  const ownerScope = getPendingQueueOwnerScope(
    localStorage.getItem('cashflow_active_account_scope'),
    localStorage.getItem('cashflow_google_user_email'),
    localStorage.getItem('cashflow_local_mode_chosen') === 'true'
  );
  if (!ownerScope) return { success: false, error: 'Previous account scope is unknown' };
  const backup = backupPendingQueuesForAccount(ownerScope);
  if (!backup.success || backup.backedUp !== summary.total) {
    return { success: false, error: backup.error || 'Queue count did not match the active outbox' };
  }
  return { success: true };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const [authenticated, setAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [googleUser, setGoogleUser] = useState<GoogleAccountProfile | null>(null);
  const [isLocalMode, setIsLocalMode] = useState(false);
  const [accountBlocked, setAccountBlocked] = useState(false);

  const refreshGoogleSession = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/google/session', {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!res.ok) return;
      const data = await res.json();

      if (data.blocked) {
        const queueBackup = preserveActivePendingQueues();
        const localStoreBackup = backupLocalStoreForLocalMode();
        wipeAccountStorage(localStoreBackup.success, queueBackup.success);
        if (!queueBackup.success) {
          toast.error(`账号已被限制，未同步队列仍保留在本机，但无法写入账号备份（${queueBackup.error}）。`, {
            duration: 10000,
          });
        }
        queryClient.clear();
        setAccountBlocked(true);
        setGoogleUser(data.user || null);
        setIsLocalMode(false);
        setAuthenticated(false);
        localStorage.removeItem('cashflow_google_authenticated');
        localStorage.removeItem('cashflow_google_user_email');
        localStorage.removeItem('cashflow_active_account_scope');
        return;
      }

      setAccountBlocked(false);

      if (data.authenticated && data.user?.email) {
        const normalizedEmail = String(data.user.email).trim().toLowerCase();
        const targetScope = `google:${normalizedEmail}`;
        const prevScope = localStorage.getItem('cashflow_active_account_scope');

        // Preserve the current account's outbox before changing the active account scope.
        if (prevScope !== targetScope) {
          const prevEmail = localStorage.getItem('cashflow_google_user_email');
          const summary = getPendingQueueSummary();
          if (summary.total > 0) {
            const ownerScope = getPendingQueueOwnerScope(
              prevScope,
              prevEmail,
              localStorage.getItem('cashflow_local_mode_chosen') === 'true'
            );
            const backupRes = ownerScope
              ? backupPendingQueuesForAccount(ownerScope)
              : { success: false, backedUp: 0, error: 'Previous account scope is unknown' };
            if (!backupRes.success || backupRes.backedUp !== summary.total) {
              const reason = backupRes.error || 'Queue count did not match the active outbox';
              console.error('Failed to preserve pending queues during account switch:', reason);
              try {
                await fetch('/api/auth/google/logout', { method: 'POST', credentials: 'same-origin' });
              } catch {}
              queryClient.clear();
              localStorage.removeItem('cashflow_google_authenticated');
              setGoogleUser(null);
              setIsLocalMode(false);
              setAuthenticated(false);
              window.dispatchEvent(new Event('cashflow_api_url_changed'));
              toast.error(
                `账号切换已中止，因为未同步队列无法安全备份（${reason}）。原队列已保留；请使用原账号重新登录并同步后再切换。`,
                { duration: 10000 }
              );
              return;
            }
          }
          const localStoreBackup = backupLocalStoreForLocalMode();
          if (!localStoreBackup.success) {
            const reason = localStoreBackup.error || 'Local-only database backup failed';
            console.error('Failed to preserve local-only database during account switch:', reason);
            try {
              await fetch('/api/auth/google/logout', { method: 'POST', credentials: 'same-origin' });
            } catch {}
            queryClient.clear();
            localStorage.removeItem('cashflow_google_authenticated');
            setGoogleUser(null);
            setIsLocalMode(false);
            setAuthenticated(false);
            window.dispatchEvent(new Event('cashflow_api_url_changed'));
            toast.error(
              `账号切换已中止，因为本地模式数据库无法安全备份（${reason}）。原数据已保留，请释放本机存储空间后重试。`,
              { duration: 10000 }
            );
            return;
          }
          wipeAccountStorage(true, true);
          queryClient.clear();
          localStorage.setItem('cashflow_active_account_scope', targetScope);
        }

        localStorage.removeItem('cashflow_local_mode_chosen');
        localStorage.removeItem('cashflow_apps_script_url');
        localStorage.setItem('cashflow_google_user_email', normalizedEmail);
        localStorage.setItem('cashflow_google_authenticated', 'true');
        localStorage.setItem('cashflow_use_server_proxy', 'true');
        if (data.user.spreadsheetId) {
          localStorage.setItem(`cashflow_sheet_id_${normalizedEmail}`, String(data.user.spreadsheetId));
        }

        // Restore any offline pending mutations that were queued specifically for this user
        const { restored } = restorePendingQueuesForAccount(normalizedEmail);
        if (restored > 0) {
          void sheetsData.flushPendingQueue();
          toast.info(`已为您恢复此账号上次未同步的 ${restored} 笔离线记录，正在同步...`);
        }

        setGoogleUser(data.user);
        setIsLocalMode(false);
        setAuthenticated(true);
        window.dispatchEvent(new Event('cashflow_api_url_changed'));
        window.dispatchEvent(new CustomEvent(SYNC_STATUS_EVENT));
      } else {
        const prevEmail = localStorage.getItem('cashflow_google_user_email');
        const prevScope = localStorage.getItem('cashflow_active_account_scope');
        localStorage.removeItem('cashflow_google_authenticated');
        localStorage.removeItem('cashflow_google_user_email');
        setGoogleUser(null);

        // Check if user explicitly opted into Local Storage Only mode
        if (localStorage.getItem('cashflow_local_mode_chosen') === 'true') {
          if (prevScope !== 'local_only') {
            const summary = getPendingQueueSummary();
            if (summary.total > 0) {
              const ownerScope = getPendingQueueOwnerScope(
                prevScope,
                prevEmail,
                localStorage.getItem('cashflow_local_mode_chosen') === 'true'
              );
              const backupRes = ownerScope
                ? backupPendingQueuesForAccount(ownerScope)
                : { success: false, backedUp: 0, error: 'Previous account scope is unknown' };
              if (!backupRes.success || backupRes.backedUp !== summary.total) {
                if (prevEmail) localStorage.setItem('cashflow_google_user_email', prevEmail);
                setIsLocalMode(false);
                setAuthenticated(false);
                toast.error(
                  `无法切换到本地模式，因为未同步队列无法安全备份（${backupRes.error || '队列数量不一致'}）。队列已保留。`,
                  { duration: 10000 }
                );
                return;
              }
            }
            const localStoreBackup = backupLocalStoreForLocalMode();
            if (!localStoreBackup.success) {
              if (prevEmail) localStorage.setItem('cashflow_google_user_email', prevEmail);
              setIsLocalMode(false);
              setAuthenticated(false);
              toast.error(
                `无法切换到本地模式，因为本地数据库无法安全备份（${localStoreBackup.error || '存储写入失败'}）。原数据已保留。`,
                { duration: 10000 }
              );
              return;
            }
            wipeAccountStorage(true, true);
            queryClient.clear();
            localStorage.setItem('cashflow_active_account_scope', 'local_only');
          }
          const localStoreRestore = restoreLocalStoreForLocalMode();
          if (!localStoreRestore.success) {
            setIsLocalMode(false);
            setAuthenticated(false);
            toast.error(
              `本地数据库已安全保留，但暂时无法恢复（${localStoreRestore.error || '存储写入失败'}）。请释放本机存储空间后重试。`,
              { duration: 10000 }
            );
            return;
          }
          const { restored } = restorePendingQueuesForAccount('local_only');
          if (restored > 0) void sheetsData.flushPendingQueue();
          localStorage.setItem('cashflow_apps_script_url', LOCAL_ONLY_ENDPOINT_SENTINEL);
          setIsLocalMode(true);
          setAuthenticated(true);
        } else {
          setIsLocalMode(false);
          setAuthenticated(false);
        }
      }
    } catch (err) {
      console.warn('Google session check notice:', err);
    }
  }, [queryClient]);

  const signOutGoogle = useCallback(async (): Promise<boolean> => {
    const currentEmail = (googleUser?.email || localStorage.getItem('cashflow_google_user_email') || '')
      .trim()
      .toLowerCase();

    // 1. Try to sync pending offline mutations before signing out
    try {
      await sheetsData.flushPendingQueue();
    } catch {}

    // 2. If any mutations remain unsynced (e.g. offline), backup to account-scoped storage
    const summary = getPendingQueueSummary();
    if (summary.total > 0) {
      if (!currentEmail) {
        toast.error('无法确认当前账号身份，无法安全备份未同步的离线记录。已中止登出以防止数据丢失，请恢复网络连接并同步后再试。', {
          duration: 8000,
        });
        return false;
      }
      const backupRes = backupPendingQueuesForAccount(currentEmail);
      if (!backupRes.success) {
        toast.error(
          `备份未同步记录失败 (${backupRes.error || '写入存储失败'})。已中止登出以防止数据丢失，请稍后重试。`,
          { duration: 8000 }
        );
        return false;
      }
      toast.warning(
        `您有 ${summary.total} 笔离线记录尚未同步。已为您安全保存在此设备中，下次登录 ${currentEmail} 时将自动恢复并同步。`,
        { duration: 8000 }
      );
    }

    const localStoreBackup = backupLocalStoreForLocalMode();
    if (!localStoreBackup.success) {
      toast.error(
        `无法安全登出：本地模式数据库备份失败（${localStoreBackup.error || '存储写入失败'}）。原数据已保留，请释放存储空间后重试。`,
        { duration: 8000 }
      );
      return false;
    }

    try {
      await fetch('/api/auth/google/logout', { method: 'POST', credentials: 'same-origin' });
    } catch {}
    wipeAccountStorage(true, true);
    queryClient.clear();
    localStorage.removeItem('cashflow_google_authenticated');
    localStorage.removeItem('cashflow_google_user_email');
    localStorage.removeItem('cashflow_active_account_scope');
    localStorage.removeItem('cashflow_local_mode_chosen');
    setGoogleUser(null);
    setIsLocalMode(false);
    setAccountBlocked(false);
    setAuthenticated(false);
    window.dispatchEvent(new Event('cashflow_api_url_changed'));
    toast.success('Signed out cleanly');
    return true;
  }, [googleUser, queryClient]);

  const exitLocalMode = useCallback(() => {
    localStorage.removeItem('cashflow_local_mode_chosen');
    setIsLocalMode(false);
    setAuthenticated(false);
  }, []);

  useEffect(() => {
    let mounted = true;

    const initAuth = async () => {
      try {
        await refreshGoogleSession();
      } finally {
        if (mounted) setLoading(false);
      }
    };

    void initAuth();

    const onAccountBlocked = () => {
      const queueBackup = preserveActivePendingQueues();
      const localStoreBackup = backupLocalStoreForLocalMode();
      wipeAccountStorage(localStoreBackup.success, queueBackup.success);
      if (!queueBackup.success) {
        toast.error(`账号已被限制，未同步队列仍保留在本机，但无法写入账号备份（${queueBackup.error}）。`, {
          duration: 10000,
        });
      }
      queryClient.clear();
      setAccountBlocked(true);
      setAuthenticated(false);
    };
    window.addEventListener('cashflow_account_blocked', onAccountBlocked);

    return () => {
      mounted = false;
      window.removeEventListener('cashflow_account_blocked', onAccountBlocked);
    };
  }, [refreshGoogleSession, queryClient]);

  // Allow public access to /privacy for Google OAuth verification
  if (pathname === '/privacy') {
    return <>{children}</>;
  }

  const handleChooseLocalMode = () => {
    const prevScope = localStorage.getItem('cashflow_active_account_scope');
    const prevEmail = localStorage.getItem('cashflow_google_user_email');
    const summary = getPendingQueueSummary();
    if (summary.total > 0) {
      const ownerScope = getPendingQueueOwnerScope(
        prevScope,
        prevEmail,
        localStorage.getItem('cashflow_local_mode_chosen') === 'true'
      );
      const backupRes = ownerScope
        ? backupPendingQueuesForAccount(ownerScope)
        : { success: false, backedUp: 0, error: 'Previous account scope is unknown' };
      if (!backupRes.success || backupRes.backedUp !== summary.total) {
        toast.error(
          `无法切换到本地模式，因为未同步队列无法安全备份（${backupRes.error || '队列数量不一致'}）。原队列已保留。`,
          { duration: 10000 }
        );
        return;
      }
    }

    if (prevScope && prevScope !== 'local_only') {
      const localStoreBackup = backupLocalStoreForLocalMode();
      if (!localStoreBackup.success) {
        toast.error(
          `无法切换到本地模式，因为本地数据库无法安全备份（${localStoreBackup.error || '存储写入失败'}）。原数据已保留。`,
          { duration: 10000 }
        );
        return;
      }
      // Wipe the previous account's caches only after its durable local data is preserved.
      wipeAccountStorage(true);
      queryClient.clear();
    } else {
      wipeAccountStorage(false);
      queryClient.clear();
    }
    const localStoreRestore = restoreLocalStoreForLocalMode();
    if (!localStoreRestore.success) {
      toast.error(
        `本地数据库已安全保留，但暂时无法恢复（${localStoreRestore.error || '存储写入失败'}）。请释放本机存储空间后重试。`,
        { duration: 10000 }
      );
      return;
    }
    const { restored } = restorePendingQueuesForAccount('local_only');
    if (restored > 0) void sheetsData.flushPendingQueue();
    localStorage.setItem('cashflow_active_account_scope', 'local_only');
    localStorage.setItem('cashflow_local_mode_chosen', 'true');
    localStorage.setItem('cashflow_apps_script_url', LOCAL_ONLY_ENDPOINT_SENTINEL);
    localStorage.removeItem('cashflow_google_authenticated');
    localStorage.removeItem('cashflow_google_user_email');
    setGoogleUser(null);
    setIsLocalMode(true);
    setAuthenticated(true);
    window.dispatchEvent(new Event('cashflow_api_url_changed'));
    window.dispatchEvent(new CustomEvent(SYNC_STATUS_EVENT));
    toast.info('Using Local Storage Mode — data is stored only on this browser.');
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-black text-slate-950 dark:text-white">
        <div className="flex flex-col items-center gap-3">
          <div className="h-14 w-14 flex items-center justify-center animate-pulse drop-shadow-lg">
            <img src="/kinova-mark.png" alt="Kinova" className="h-14 w-14 object-contain" />
          </div>
          <p className="text-xs text-slate-500 dark:text-zinc-400 font-mono">Loading your workspace...</p>
        </div>
      </div>
    );
  }

  // Blocked account screen
  if (accountBlocked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-black p-4 text-slate-950 dark:text-white">
        <div className="w-full max-w-sm rounded-3xl border border-rose-500/30 bg-white dark:bg-zinc-950 p-6 md:p-8 shadow-2xl space-y-5 text-center">
          <div className="h-16 w-16 rounded-2xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center mx-auto">
            <ShieldAlert className="h-8 w-8 text-rose-500" />
          </div>
          <div className="space-y-1.5">
            <h1 className="text-lg font-bold text-slate-900 dark:text-white">Access Restricted</h1>
            <p className="text-xs text-slate-600 dark:text-zinc-400">
              Your Google account ({googleUser?.email || 'current account'}) has been restricted by the administrator.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void signOutGoogle()}
            className="w-full py-3 rounded-2xl bg-slate-900 dark:bg-zinc-800 hover:bg-slate-800 dark:hover:bg-zinc-700 text-white text-xs font-semibold flex items-center justify-center gap-2 cursor-pointer transition-colors"
          >
            <LogOut className="h-4 w-4" />
            <span>Sign out & Switch Account</span>
          </button>
        </div>
      </div>
    );
  }

  // Welcome / Login Choice Screen (No PIN required)
  if (!authenticated) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-black p-4 text-slate-950 dark:text-white selection:bg-indigo-500/30">
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 15 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="w-full max-w-md rounded-3xl border border-slate-200 dark:border-zinc-800/80 bg-white dark:bg-zinc-950 p-6 md:p-8 shadow-2xl space-y-6"
        >
          {/* Header */}
          <div className="text-center space-y-2">
            <div className="h-20 w-20 flex items-center justify-center mx-auto drop-shadow-xl">
              <img src="/kinova-mark.png" alt="Kinova" className="h-20 w-20 object-contain" />
            </div>
            <h1 className="text-xl font-extrabold text-slate-950 dark:text-white tracking-tight">
              Welcome to Kinova
            </h1>
            <p className="text-xs text-slate-600 dark:text-zinc-400 leading-relaxed">
              Choose how you want to store your financial records:
            </p>
          </div>

          {/* Option 1: Sign in with Google (Recommended) */}
          <div className="rounded-2xl border border-indigo-500/30 bg-indigo-500/[0.04] p-4 space-y-3">
            <div className="flex items-start gap-2.5">
              <HardDrive className="h-4 w-4 text-indigo-500 shrink-0 mt-0.5" />
              <div className="text-xs space-y-0.5">
                <div className="font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <span>Google Drive Cloud Sync</span>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-500/15 text-indigo-600 dark:text-indigo-300">
                    Recommended
                  </span>
                </div>
                <p className="text-[11px] text-slate-600 dark:text-zinc-400 leading-relaxed">
                  Automatically creates and saves your ledger & receipts inside your own personal Google Drive. Unlocks AI receipt scanning & syncs across devices.
                </p>
              </div>
            </div>

            <a
              href="/api/auth/google/login"
              className="min-h-[48px] w-full py-3 px-4 rounded-xl bg-gradient-to-r from-indigo-500 via-indigo-600 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white font-semibold text-sm shadow-lg shadow-indigo-500/25 transition-all flex items-center justify-center gap-3 cursor-pointer hover:scale-[1.01] active:scale-[0.99]"
            >
              <svg className="h-5 w-5 bg-white rounded-full p-0.5 shrink-0" viewBox="0 0 24 24">
                <path
                  fill="#4285F4"
                  d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17z"
                />
                <path
                  fill="#34A853"
                  d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14z"
                />
                <path
                  fill="#EA4335"
                  d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96z"
                />
              </svg>
              <span>Continue with Google</span>
            </a>
          </div>

          {/* Option 2: Local Browser Storage Only (with Data Loss Warning) */}
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/[0.04] p-4 space-y-3">
            <div className="flex items-start gap-2.5">
              <Smartphone className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
              <div className="text-xs space-y-1">
                <div className="font-bold text-slate-900 dark:text-white">
                  Local Device Storage Only (No Login)
                </div>
                <p className="text-[11px] text-amber-700 dark:text-amber-300/90 leading-relaxed flex items-start gap-1">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-amber-500" />
                  <span>
                    Warning: Data is saved only on this browser/phone. You will <strong>lose all data</strong> if you change phones, clear browser data, or uninstall.
                  </span>
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={handleChooseLocalMode}
              className="min-h-[42px] w-full py-2.5 px-4 rounded-xl border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-800 dark:text-zinc-200 text-xs font-semibold transition-colors cursor-pointer"
            >
              Use Local Storage Only
            </button>
          </div>

          <div className="text-center pt-1">
            <span className="text-[11px] text-slate-500 dark:text-zinc-400 flex items-center justify-center gap-1">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
              <span>100% isolated per account • zero shared data</span>
            </span>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <AuthContext.Provider
      value={{
        authenticated,
        isTrustedDevice: true,
        lockApp: () => void signOutGoogle(),
        untrustDevice: () => void signOutGoogle(),
        changePin: () => true,
        currentPin: '0000',
        googleUser,
        isLocalMode,
        signOutGoogle,
        exitLocalMode,
        refreshGoogleSession,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
