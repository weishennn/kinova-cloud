'use client';

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { motion } from 'framer-motion';
import { ShieldAlert, ShieldCheck, LogOut, KeyRound, HardDrive } from 'lucide-react';
import { toast } from 'sonner';
import { saveSettingWithCloudSync, SETTINGS_UPDATED_EVENT } from '@/lib/cloud-settings-sync';
import { getApiUrl, sheetsApi } from '@/lib/sheets-api';
import { getPendingSettingMutations, LOCAL_ONLY_ENDPOINT_SENTINEL, SYNC_STATUS_EVENT } from '@/lib/cache-manager';

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
  signOutGoogle: () => Promise<void>;
  refreshGoogleSession: () => Promise<void>;
}

const DEFAULT_PIN = '0000';

const AuthContext = createContext<AuthContextType>({
  authenticated: false,
  isTrustedDevice: false,
  lockApp: () => {},
  untrustDevice: () => {},
  changePin: () => false,
  currentPin: DEFAULT_PIN,
  googleUser: null,
  signOutGoogle: async () => {},
  refreshGoogleSession: async () => {},
});

function readStoredActivePin(): string {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const customPin = localStorage.getItem('cashflow_custom_pin');
      if (customPin && /^\d{1,4}$/.test(customPin.trim())) {
        return customPin.trim().padStart(4, '0');
      }
    }
  } catch (e) {
    console.warn('Storage read warning:', e);
  }
  return process.env.NEXT_PUBLIC_APP_PIN || DEFAULT_PIN;
}

function resetLocalCacheForAccountSwitch(newEmail: string) {
  try {
    const prevEmail = localStorage.getItem('cashflow_google_user_email');
    if (prevEmail && prevEmail !== newEmail) {
      // Clear cached sheet data when switching between two different Google accounts
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        if (
          k.startsWith('cashflow_swr_') ||
          k.startsWith('cashflow_month_') ||
          k.startsWith('cashflow_cache_') ||
          k === 'cashflow_installment_plans' ||
          k === 'cashflow_recurring_commitments' ||
          k === 'cashflow_category_caps' ||
          k === 'cashflow_monthly_budget'
        ) {
          keysToRemove.push(k);
        }
      }
      keysToRemove.forEach((k) => localStorage.removeItem(k));
    }
    localStorage.setItem('cashflow_google_user_email', newEmail);
  } catch {}
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [authenticated, setAuthenticated] = useState(false);
  const [isTrustedDevice, setIsTrustedDevice] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pinInput, setPinInput] = useState('');
  const [trustThisDevice, setTrustThisDevice] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  const [activePin, setActivePin] = useState<string>(DEFAULT_PIN);
  const [googleUser, setGoogleUser] = useState<GoogleAccountProfile | null>(null);
  const [accountBlocked, setAccountBlocked] = useState(false);
  const [manualLocked, setManualLocked] = useState(false);
  const [showPinFallback, setShowPinFallback] = useState(false);

  const getActivePin = () => readStoredActivePin();

  const refreshGoogleSession = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/google/session', {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!res.ok) return;
      const data = await res.json();

      if (data.blocked) {
        setAccountBlocked(true);
        setGoogleUser(data.user || null);
        setAuthenticated(false);
        localStorage.removeItem('cashflow_google_authenticated');
        return;
      }

      setAccountBlocked(false);

      if (data.authenticated && data.user?.email) {
        resetLocalCacheForAccountSwitch(data.user.email);
        localStorage.setItem('cashflow_google_authenticated', 'true');
        localStorage.setItem('cashflow_use_server_proxy', 'true');
        if (localStorage.getItem('cashflow_apps_script_url') === LOCAL_ONLY_ENDPOINT_SENTINEL) {
          localStorage.removeItem('cashflow_apps_script_url');
        }
        setGoogleUser(data.user);
        setAuthenticated(true);
        window.dispatchEvent(new Event('cashflow_api_url_changed'));
        window.dispatchEvent(new CustomEvent(SYNC_STATUS_EVENT));
      } else {
        localStorage.removeItem('cashflow_google_authenticated');
        setGoogleUser(null);
      }
    } catch (err) {
      console.warn('Google session check notice:', err);
    }
  }, []);

  const signOutGoogle = useCallback(async () => {
    try {
      await fetch('/api/auth/google/logout', { method: 'POST', credentials: 'same-origin' });
    } catch {}
    localStorage.removeItem('cashflow_google_authenticated');
    localStorage.removeItem('cashflow_google_user_email');
    localStorage.removeItem('cashflow_trusted_device');
    setGoogleUser(null);
    setAccountBlocked(false);
    setAuthenticated(false);
    window.dispatchEvent(new Event('cashflow_api_url_changed'));
    toast.success('Signed out of Google Account');
  }, []);

  useEffect(() => {
    let mounted = true;

    const initAuth = async () => {
      try {
        setActivePin(readStoredActivePin());
        await refreshGoogleSession();

        if (typeof window !== 'undefined' && window.localStorage) {
          const isGoogleAuthed = localStorage.getItem('cashflow_google_authenticated') === 'true';
          const isTrusted = localStorage.getItem('cashflow_trusted_device') === 'true';
          const hasCustomScript = Boolean(
            localStorage.getItem('cashflow_apps_script_url')?.startsWith('https://script.google.com/macros/s/')
          );

          if (isGoogleAuthed) {
            setAuthenticated(true);
          } else if (isTrusted && hasCustomScript) {
            setIsTrustedDevice(true);
            setAuthenticated(true);
          }
        }
      } catch (e) {
        console.warn('Storage read warning:', e);
      } finally {
        if (mounted) setLoading(false);
      }
    };

    void initAuth();

    const refreshPinState = () => {
      setActivePin(readStoredActivePin());
    };
    const onAccountBlocked = () => {
      setAccountBlocked(true);
      setAuthenticated(false);
    };
    window.addEventListener(SETTINGS_UPDATED_EVENT, refreshPinState);
    window.addEventListener('storage', refreshPinState);
    window.addEventListener('cashflow_account_blocked', onAccountBlocked);

    const apiUrl = getApiUrl();
    if (apiUrl && apiUrl.startsWith('http')) {
      sheetsApi
        .getSettings(true)
        .then((res) => {
          if (!res.success || !res.data) return;
          const hasPendingPinEdit = getPendingSettingMutations().some((m) => m.key === 'cashflow_custom_pin');
          if (hasPendingPinEdit) return;
          const rawCloudPin = res.data['cashflow_custom_pin'];
          if (rawCloudPin !== undefined && rawCloudPin !== null && /^\d{1,4}$/.test(String(rawCloudPin).trim())) {
            const normalizedPin = String(rawCloudPin).trim().padStart(4, '0');
            localStorage.setItem('cashflow_custom_pin', normalizedPin);
            setActivePin(normalizedPin);
          }
        })
        .catch(() => {});
    }

    return () => {
      mounted = false;
      window.removeEventListener(SETTINGS_UPDATED_EVENT, refreshPinState);
      window.removeEventListener('storage', refreshPinState);
      window.removeEventListener('cashflow_account_blocked', onAccountBlocked);
    };
  }, [refreshGoogleSession]);

  // Allow public access to /privacy for Google OAuth verification
  if (pathname === '/privacy') {
    return <>{children}</>;
  }

  const handleUnlock = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const correctPin = getActivePin();

    if (pinInput.trim() === correctPin.trim()) {
      setErrorMsg('');
      setManualLocked(false);
      setAuthenticated(true);

      if (trustThisDevice) {
        try {
          if (typeof window !== 'undefined' && window.localStorage) {
            localStorage.setItem('cashflow_trusted_device', 'true');
          }
        } catch (e) {
          console.warn('Storage write warning:', e);
        }
        setIsTrustedDevice(true);
        toast.success('Unlocked and trusted on this device');
      } else {
        toast.success('Unlocked for this session');
      }
    } else {
      setErrorMsg('Incorrect PIN. Please try again.');
      setPinInput('');
    }
  };

  const handleLocalOnlyStart = () => {
    localStorage.setItem('cashflow_apps_script_url', LOCAL_ONLY_ENDPOINT_SENTINEL);
    setManualLocked(false);
    setAuthenticated(true);
    window.dispatchEvent(new Event('cashflow_api_url_changed'));
    toast.info('Entered Local Device Mode (not synced to Google Drive)');
  };

  const lockApp = () => {
    setManualLocked(true);
    setAuthenticated(false);
    setPinInput('');
    setErrorMsg('');
  };

  const untrustDevice = () => {
    localStorage.removeItem('cashflow_trusted_device');
    setIsTrustedDevice(false);
    setManualLocked(true);
    setAuthenticated(false);
    toast.info('Device trust revoked.');
  };

  const changePin = (newPin: string) => {
    const cleaned = newPin.trim();
    if (!/^\d{4}$/.test(cleaned)) {
      toast.error('PIN must be exactly 4 digits');
      return false;
    }
    setActivePin(cleaned);
    saveSettingWithCloudSync('cashflow_custom_pin', cleaned);
    toast.success(`4-digit Master PIN updated to ${cleaned} and synced!`);
    return true;
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-black text-slate-950 dark:text-white">
        <div className="flex flex-col items-center gap-3">
          <div className="h-14 w-14 flex items-center justify-center animate-pulse drop-shadow-lg">
            <img src="/kinova-mark.png" alt="Kinova" className="h-14 w-14 object-contain" />
          </div>
          <p className="text-xs text-slate-500 dark:text-zinc-400 font-mono">Connecting to Kinova Cloud...</p>
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

  // Login / Unlock screen
  if (!authenticated || manualLocked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-black p-4 text-slate-950 dark:text-white selection:bg-indigo-500/30">
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 15 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="w-full max-w-sm rounded-3xl border border-slate-200 dark:border-zinc-800/80 bg-white dark:bg-zinc-950 p-6 md:p-8 shadow-2xl space-y-6"
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
              Sign in with your Google account to automatically save all transactions and receipts in your own Google Drive.
            </p>
          </div>

          {/* Primary Action: Sign in with Google */}
          <div className="space-y-3">
            <a
              href="/api/auth/google/login"
              className="min-h-[48px] w-full py-3.5 px-4 rounded-2xl bg-gradient-to-r from-indigo-500 via-indigo-600 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white font-semibold text-sm shadow-xl shadow-indigo-500/25 transition-all flex items-center justify-center gap-3 cursor-pointer hover:scale-[1.01] active:scale-[0.99]"
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

            <div className="rounded-2xl bg-indigo-500/5 border border-indigo-500/15 p-3 text-[11px] text-slate-600 dark:text-zinc-400 space-y-1">
              <p className="font-semibold text-indigo-700 dark:text-indigo-300 flex items-center gap-1.5">
                <HardDrive className="h-3.5 w-3.5" />
                <span>Zero-Setup Personal Cloud</span>
              </p>
              <p>
                Creates a private <code>Kinova CashFlow</code> sheet & receipt folder directly in your own Google Drive.
              </p>
            </div>
          </div>

          {/* Optional PIN / Local Mode Toggle */}
          <div className="pt-2 border-t border-slate-200 dark:border-zinc-800/60 space-y-3">
            <button
              type="button"
              onClick={() => setShowPinFallback((v) => !v)}
              className="w-full text-center text-[11px] font-medium text-slate-500 dark:text-zinc-400 hover:text-indigo-500 dark:hover:text-indigo-400 flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <KeyRound className="h-3.5 w-3.5" />
              <span>{showPinFallback ? 'Hide PIN / Offline Options' : 'Unlock with App PIN or Offline Mode'}</span>
            </button>

            {showPinFallback && (
              <form onSubmit={handleUnlock} className="space-y-3 pt-1">
                <input
                  type="password"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={4}
                  placeholder="Enter 4-digit PIN (default 0000)"
                  value={pinInput}
                  onChange={(e) => {
                    const digitsOnly = e.target.value.replace(/\D/g, '').slice(0, 4);
                    setPinInput(digitsOnly);
                    if (errorMsg) setErrorMsg('');
                  }}
                  className={`min-h-[44px] w-full text-center py-2.5 px-4 rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/60 text-slate-950 dark:text-white outline-none focus:border-indigo-500 transition-colors ${
                    pinInput.length > 0
                      ? 'tracking-[0.4em] pl-[0.4em] text-lg font-bold'
                      : 'tracking-normal text-xs font-medium'
                  }`}
                />

                {errorMsg && (
                  <p role="alert" className="text-xs text-rose-600 dark:text-rose-400 text-center font-medium">
                    {errorMsg}
                  </p>
                )}

                <div className="flex gap-2">
                  <button
                    type="submit"
                    className="flex-1 py-2.5 rounded-xl bg-slate-900 dark:bg-zinc-800 hover:bg-slate-800 text-white text-xs font-semibold cursor-pointer"
                  >
                    Unlock with PIN
                  </button>
                  <button
                    type="button"
                    onClick={handleLocalOnlyStart}
                    className="flex-1 py-2.5 rounded-xl border border-slate-200 dark:border-zinc-800 hover:bg-slate-100 dark:hover:bg-zinc-900 text-slate-700 dark:text-zinc-300 text-xs font-semibold cursor-pointer"
                  >
                    Local Mode Only
                  </button>
                </div>
              </form>
            )}
          </div>

          <div className="text-center pt-1">
            <span className="text-[11px] text-slate-500 dark:text-zinc-400 flex items-center justify-center gap-1">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
              <span>100% private • stored in your own Google Drive</span>
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
        isTrustedDevice,
        lockApp,
        untrustDevice,
        changePin,
        currentPin: activePin,
        googleUser,
        signOutGoogle,
        refreshGoogleSession,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
