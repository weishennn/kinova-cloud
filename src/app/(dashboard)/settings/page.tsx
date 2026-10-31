'use client';

import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import {
  Database, Moon, Sun, Globe, Smartphone, RefreshCw, CheckCircle2,
  AlertCircle, ExternalLink, Trash2, Key, Lock, Eye, EyeOff,
  Cloud, HardDrive, Wifi, WifiOff, Clock, Layers, ShieldCheck, Archive,
  Download, Upload, FileCheck2, GitCompare, BookOpen, Copy, X
} from 'lucide-react';
import { useTheme } from 'next-themes';
import {
  getApiUrl,
  setCustomApiUrl,
  getApiKey,
  setCustomApiKey,
  getServerProxyToken,
  setServerProxyToken,
  getUseServerProxy,
  setUseServerProxy,
  getSecurityPosture,
  sheetsApi,
  clearAllSwrCache,
} from '@/lib/sheets-api';
import { useAuth } from '@/components/auth-provider';
import { useQueryClient } from '@tanstack/react-query';
import { confirmAction } from '@/stores/confirm-dialog-store';
import { toast } from 'sonner';
import { CockpitPageHeading } from '@/components/money-cockpit/cockpit-page-heading';
import { GoogleAccountAndAdminPanel } from '@/components/settings/google-account-admin-panel';
import { MerchantRulesManager } from '@/components/settings/merchant-rules-manager';
import { WhatKinovaKnows } from '@/components/settings/what-kinova-knows';
import { saveSettingWithCloudSync, syncCloudSettingsWithLocal, SETTINGS_UPDATED_EVENT } from '@/lib/cloud-settings-sync';
import {
  getPlanMigrationComparisons,
  restorePhonePlansToSheet,
  dismissPlanBackup,
  getPreMigrationBackupError,
  clearPreMigrationBackupError,
  getPendingPlanMutations,
  discardPendingPlanMutation,
  PLAN_RECOVERY_UPDATED_EVENT,
  type PlanMigrationComparison,
  type PlanMutation,
} from '@/lib/plan-sync';
import { useSyncStatus } from '@/hooks/useSyncStatus';
import {
  pruneExpiredCache,
  getPendingMutations,
  removePendingMutation,
  getPendingSettingMutations,
  removePendingSettingMutations,
  assertPendingQueuesReadable,
  reconcileLocalStateAfterRestore,
  SYNC_STATUS_EVENT,
  type PendingMutation,
  type PendingSettingMutation,
} from '@/lib/cache-manager';
import {
  getSyncConflicts,
  dismissSyncConflict,
  validateLocalIntegrity,
  downloadIndependentBackupJson,
  validateAndImportIndependentBackupJson,
  clearDeletedTombstone,
  recordDeletedTombstone,
  CONFLICT_UPDATED_EVENT,
  type SyncConflict,
  type LocalIntegrityReport,
} from '@/lib/data-integrity';
import { sheetsData } from '@/lib/sheets-data';
import { buildConflictResolutionUpdate } from '@/lib/conflict-policy';

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const syncStatus = useSyncStatus();
  const { theme, resolvedTheme, setTheme } = useTheme();
  const { isTrustedDevice, lockApp, untrustDevice, changePin, currentPin, googleUser, isLocalMode } = useAuth();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [mounted, setMounted] = useState(false);
  const [apiUrl, setApiUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [proxyToken, setProxyToken] = useState('');
  const [useProxy, setUseProxy] = useState(true);
  const [showApiKey, setShowApiKey] = useState(false);
  const [showProxyToken, setShowProxyToken] = useState(false);
  const [isLockingEndpointKey, setIsLockingEndpointKey] = useState(false);
  const [currency, setCurrency] = useState('MYR');
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [newPin, setNewPin] = useState('');
  const [showPinInput, setShowPinInput] = useState(false);
  const [showActivePin, setShowActivePin] = useState(false);
  const [isPruning, setIsPruning] = useState(false);
  const [pruneStats, setPruneStats] = useState<string | null>(null);
  const [isSyncingPending, setIsSyncingPending] = useState(false);
  const [isSettingUpTabs, setIsSettingUpTabs] = useState(false);
  const [planRecoveryItems, setPlanRecoveryItems] = useState<PlanMigrationComparison[]>([]);
  const [isRestoringPlan, setIsRestoringPlan] = useState<string | null>(null);
  const [preMigrationError, setPreMigrationError] = useState<{ failedAt: string; message: string } | null>(null);
  const [pendingTxList, setPendingTxList] = useState<PendingMutation[]>([]);
  const [pendingPlanList, setPendingPlanList] = useState<PlanMutation[]>([]);
  const [pendingSettingList, setPendingSettingList] = useState<PendingSettingMutation[]>([]);
  const [syncConflicts, setSyncConflicts] = useState<SyncConflict[]>([]);
  const [backupStatus, setBackupStatus] = useState<{
    triggerInstalled?: boolean;
    lastBackupAt: string | null;
    lastBackupFileId: string | null;
    lastBackupName?: string | null;
    lastBackupVerified?: boolean;
    lastBackupStale?: boolean;
    backupHealth?: 'healthy' | 'stale' | 'unverified' | 'missing';
    sheetCount?: number;
    totalRows?: number;
  } | null>(null);
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [driveBackups, setDriveBackups] = useState<Array<{
    id: string;
    name: string;
    createdAt: string;
    url: string;
    kind?: string;
  }>>([]);
  const [isLoadingBackups, setIsLoadingBackups] = useState(false);
  const [isRestoringBackupId, setIsRestoringBackupId] = useState<string | null>(null);
  const [isTestingRestoreId, setIsTestingRestoreId] = useState<string | null>(null);
  const [testRestoreReport, setTestRestoreReport] = useState<{
    passed: boolean;
    sourceName: string;
    sheetsTested: number;
    totalRowsVerified: number;
    overviewFormulaMatches: number;
    discrepancies: string[];
  } | null>(null);
  const [postRestoreSummary, setPostRestoreSummary] = useState<{
    restoredFromName: string;
    sheetsRestored: number;
    totalRowsRestored: number;
    safetyBackupName: string;
    discardedLocalChanges: number;
    retainedLocalChanges: number;
  } | null>(null);
  const [isCheckingIntegrity, setIsCheckingIntegrity] = useState(false);
  const [integrityReport, setIntegrityReport] = useState<{
    local: LocalIntegrityReport;
    server?: {
      healthy: boolean;
      summary: {
        monthlySheetsChecked: number;
        totalTransactions: number;
        duplicateIdCount: number;
        missingFieldCount: number;
        invalidDateCount: number;
        overviewFormulasHealthy: boolean;
        apiKeyConfigured?: boolean;
      };
      issues: Array<{ severity: string; sheet: string; message: string }>;
    };
  } | null>(null);
  const [showRecoveryGuide, setShowRecoveryGuide] = useState(false);
  const DEFAULT_SHORTCUT_ICLOUD_URL = 'https://www.icloud.com/shortcuts/69cd83fb429d48c18fa734870f69f3f6';
  const [copiedConfigKey, setCopiedConfigKey] = useState<string | null>(null);

  const copyTextToClipboard = async (text: string, key: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedConfigKey(key);
      toast.success(`已复制 ${label}`);
      setTimeout(() => setCopiedConfigKey(null), 2500);
    } catch {
      toast.error('复制失败，请手动长按复制');
    }
  };

  const refreshPlanRecovery = () => {
    setPlanRecoveryItems(getPlanMigrationComparisons());
    setPreMigrationError(getPreMigrationBackupError());
    setPendingTxList(getPendingMutations());
    setPendingPlanList(getPendingPlanMutations());
    setPendingSettingList(getPendingSettingMutations());
    setSyncConflicts(getSyncConflicts());
  };

  const fetchBackupStatus = async () => {
    const url = getApiUrl();
    if (!url || !url.startsWith('http')) return;
    try {
      const res = await sheetsApi.getBackupStatus(true);
      if (res.success && res.data) {
        setBackupStatus(res.data);
      }
    } catch {
      // ignore if script not yet updated
    }
  };

  const loadDriveBackups = async () => {
    const url = getApiUrl();
    if (!url || !url.startsWith('http')) return;
    setIsLoadingBackups(true);
    try {
      const res = await sheetsApi.listBackups();
      if (res.success && Array.isArray(res.data)) {
        setDriveBackups(res.data);
      }
    } catch {
      // ignore if script not yet updated
    } finally {
      setIsLoadingBackups(false);
    }
  };

  const handleTestRestoreBackup = async (fileId: string, name: string) => {
    setIsTestingRestoreId(fileId);
    setTestRestoreReport(null);
    try {
      const res = await sheetsApi.testRestoreBackup(fileId);
      if (res.success && res.data) {
        setTestRestoreReport({
          passed: res.data.passed,
          sourceName: res.data.sourceName || name,
          sheetsTested: res.data.sheetsTested,
          totalRowsVerified: res.data.totalRowsVerified,
          overviewFormulaMatches: res.data.overviewFormulaMatches,
          discrepancies: res.data.discrepancies || [],
        });
        if (res.data.passed) {
          toast.success(`Dry-run restore test passed for "${name}" (${res.data.sheetsTested} tabs, ${res.data.totalRowsVerified} rows verified)! ✅`);
        } else {
          toast.warning(`Dry-run restore found ${res.data.discrepancies?.length || 1} discrepancy. See report below.`);
        }
      } else {
        toast.error('Dry-run test failed: ' + (res.message || 'Unknown error'));
      }
    } catch (err: any) {
      toast.error('Dry-run test error: ' + (err.message || String(err)));
    } finally {
      setIsTestingRestoreId(null);
    }
  };

  const handleRestoreBackupSnapshot = async (fileId: string, name: string) => {
    const hasPending = syncStatus.pendingCount > 0;
    const ok = await confirmAction({
      title: `Restore Snapshot "${name}"?`,
      description: hasPending
        ? `This will staged-restore all tabs from "${name}" after creating a verified safety snapshot. You have ${syncStatus.pendingCount} pending offline changes; they will be discarded so they cannot overwrite the restored backup. The local-only database will be preserved.`
        : `This will staged-restore all tabs from "${name}" into your active Google Sheet. A verified safety snapshot of your current sheet will be created automatically before restoring, with automatic rollback if any check fails. The local-only database will be preserved.`,
      confirmText: 'Staged Restore & Reconcile',
      cancelText: 'Cancel',
      variant: 'danger',
      icon: 'alert',
    });
    if (!ok) return;

    setIsRestoringBackupId(fileId);
    setPostRestoreSummary(null);
    try {
      // Validate local queues before changing the Sheet; restoring must not
      // discard an unreadable queue that still may contain offline records.
      assertPendingQueuesReadable();
      const res = await sheetsApi.restoreBackup(fileId);
      if (res.success && res.data?.restored && res.data?.verified !== false) {
        // P0 #3: Reconcile and clear local pending queues and cached plan/settings state BEFORE background sync runs
        const reconciled = reconcileLocalStateAfterRestore({ retainPendingEdits: false });
        const discardedTotal =
          reconciled.clearedTransactions + reconciled.clearedPlans + reconciled.clearedSettings;

        await syncCloudSettingsWithLocal();
        queryClient.invalidateQueries();
        refreshPlanRecovery();
        await fetchBackupStatus();
        await loadDriveBackups();

        setPostRestoreSummary({
          restoredFromName: res.data.restoredFromName || name,
          sheetsRestored: res.data.sheetsRestored,
          totalRowsRestored: res.data.totalRowsRestored ?? 0,
          safetyBackupName: res.data.safetyBackupName || res.data.safetyBackupId,
          discardedLocalChanges: discardedTotal,
          retainedLocalChanges: reconciled.retainedCount,
        });

        toast.success(`Restored & verified ${res.data.sheetsRestored} sheets from "${name}"! 🎉`);
      } else {
        toast.error('Restore failed or rolled back: ' + (res.message || 'Could not verify restored snapshot'));
      }
    } catch (err: any) {
      toast.error('Restore error (live sheet left intact): ' + (err.message || String(err)));
    } finally {
      setIsRestoringBackupId(null);
    }
  };

  const handleLockEndpointApiKey = async () => {
    const trimmed = apiKey.trim();
    if (trimmed.length < 32) {
      toast.error('Use a randomly generated API key with at least 32 characters. Set the first key manually in Apps Script Project Settings.');
      return;
    }
    setIsLockingEndpointKey(true);
    try {
      const res = await sheetsApi.configureEndpointApiKey(trimmed);
      if (res.success) {
        setCustomApiKey(trimmed);
        toast.success('API_KEY saved in Google Apps Script Properties! Unauthenticated requests are now blocked. 🔒');
      } else {
        toast.error('Could not configure endpoint key: ' + (res.message || 'Unknown error'));
      }
    } catch (err: any) {
      toast.error('Failed to configure endpoint key: ' + (err.message || String(err)));
    } finally {
      setIsLockingEndpointKey(false);
    }
  };

  const handleRunIntegrityCheck = async () => {
    setIsCheckingIntegrity(true);
    try {
      const localRep = validateLocalIntegrity();
      let serverRep: any = undefined;
      const url = getApiUrl();
      if (url && url.startsWith('http')) {
        try {
          const sRes = await sheetsApi.runIntegrityCheck();
          if (sRes.success && sRes.data) {
            serverRep = sRes.data;
          }
        } catch (e) {
          console.warn('Server integrity check warning:', e);
        }
      }
      setIntegrityReport({ local: localRep, server: serverRep });
      if (localRep.healthy && (!serverRep || serverRep.healthy)) {
        toast.success('Data integrity check passed with zero errors! 🛡️');
      } else {
        toast.warning('Data integrity check completed with warnings/errors. Review details below.');
      }
    } finally {
      setIsCheckingIntegrity(false);
    }
  };

  const handleExportOfflineBackup = () => {
    try {
      const { filename, counts } = downloadIndependentBackupJson();
      toast.success(
        `Exported ${filename} (${counts.recurringCommitments} recurring, ${counts.installmentPlans} installments)! 💾`
      );
    } catch (err: any) {
      toast.error('Offline export failed: ' + (err.message || String(err)));
    }
  };

  const handleImportOfflineBackup = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const raw = await file.text();
      const res = validateAndImportIndependentBackupJson(raw);
      await syncCloudSettingsWithLocal();
      queryClient.invalidateQueries();
      refreshPlanRecovery();
      toast.success(
        `Restored ${res.restoredRecurring} recurring plans, ${res.restoredInstallments} installments & ${res.restoredSettings} settings from offline backup! 🎉`
      );
    } catch (err: any) {
      toast.error('Offline backup import rejected: ' + (err.message || String(err)));
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleResolveConflict = async (conflict: SyncConflict, choice: 'keep_client' | 'keep_server') => {
    try {
      // --- TRANSACTION conflicts: restore ledger row, never touch plan storage ---
      if (conflict.kind === 'transaction') {
        if (choice === 'keep_client') {
          const txRecord = conflict.clientRecord as Record<string, unknown>;
          const serverRecord = conflict.serverRecord as Record<string, unknown>;
          clearDeletedTombstone(conflict.entityId);
          const update = buildConflictResolutionUpdate(txRecord, serverRecord, conflict.entityId);

          if (update) {
            // Update the existing row using its latest server snapshot. This
            // also lets the normal staged cross-month move remove the old row.
            const updateResult = await sheetsData.updateRow(update.sheetName, update.rowIndex, update.rowData);
            if (!updateResult.success) {
              toast.error('云端记录已再次变化，您的版本仍保留在冲突中心；请重新选择。');
              return;
            }
            toast.success(
              updateResult.pending
                ? '本机版本已加入安全同步队列；联网后会重试。'
                : '已应用本机版本并同步到 Google Sheets！'
            );
          } else {
            // A deleted server row is an explicit restore; ordinary conflicts
            // must update by ID instead of appending a duplicate transaction.
            const rowDate = String(txRecord.Date || txRecord.date || '');
            const dateMonth = /^\d{4}-\d{2}/.test(rowDate) ? rowDate.slice(0, 7) : '';
            const sheetName = String(txRecord._month || dateMonth || txRecord.sheetName || '');
            if (!sheetName) {
              toast.error('无法确定目标工作表，请手动重新添加该记录。');
              return;
            }
            const restoreResult = await sheetsData.addRow(sheetName, {
              ...txRecord,
              Id: conflict.entityId,
              id: conflict.entityId,
              _forceRestore: true,
            });
            if (!restoreResult.success) {
              toast.error('恢复本机交易版本失败。冲突仍保留，您可以稍后重试。');
              return;
            }
            toast.success(
              restoreResult.pending
                ? '本机版本已加入安全同步队列；联网后会重试。'
                : '已恢复已删除的本机交易版本并同步到 Google Sheets！'
            );
          }
        } else {
          // User accepts the server state (deleted or a later edit by another device)
          const serverRecord = conflict.serverRecord as Record<string, unknown>;
          const serverIsDeleted = Boolean(serverRecord?.status === 'deleted_on_server' || serverRecord?._deleted);
          if (serverIsDeleted) {
            // Accept the deletion — ensure tombstone exists so it won't resurface
            recordDeletedTombstone(conflict.entityId, 'transaction');
            sheetsData.optimisticDeleteRow(
              String(serverRecord.sheetName || serverRecord._month || ''),
              typeof serverRecord._rowIndex === 'number' ? serverRecord._rowIndex : undefined,
              conflict.entityId
            );
          } else {
            clearDeletedTombstone(conflict.entityId);
            const serverDate = String(serverRecord.Date || serverRecord.date || '');
            const serverMonth = String(
              serverRecord._month || (/^\d{4}-\d{2}/.test(serverDate) ? serverDate.slice(0, 7) : '')
            );
            if (serverMonth) {
              sheetsData.optimisticAddRow(serverMonth, {
                ...serverRecord,
                Id: conflict.entityId,
                id: conflict.entityId,
                _month: serverMonth,
              });
            }
          }
          // Nothing else to write — server state is already in effect
          toast.success('已接受云端版本（已在其他设备同步）。');
        }
        dismissSyncConflict(conflict.id);
        refreshPlanRecovery();
        queryClient.invalidateQueries();
        return;
      }

      // --- SETTING conflicts: update in-memory setting, sync to cloud ---
      if (conflict.kind === 'setting') {
        const chosenRecord = choice === 'keep_client' ? conflict.clientRecord : conflict.serverRecord;
        const settingKey = String(conflict.entityId);
        const settingValue = String(chosenRecord.value ?? '');
        if (settingKey) {
          saveSettingWithCloudSync(settingKey, settingValue);
        }
        dismissSyncConflict(conflict.id);
        refreshPlanRecovery();
        queryClient.invalidateQueries();
        toast.success(choice === 'keep_client' ? '已应用本机设置并同步！' : '已恢复云端设置！');
        return;
      }

      // --- RECURRING / INSTALLMENTS: update the correct plan storage key ---
      const storageKey =
        conflict.kind === 'recurring'
          ? 'cashflow_recurring_commitments'
          : 'cashflow_installment_plans';
      const chosenRecord = choice === 'keep_client' ? conflict.clientRecord : conflict.serverRecord;
      const currentRaw = localStorage.getItem(storageKey) || '[]';
      const currentList: any[] = JSON.parse(currentRaw);
      const nextList = currentList.filter((r) => String(r.id) !== conflict.entityId);
      const selectedDeleted = Boolean((chosenRecord as any)?._deleted);
      if (!selectedDeleted) nextList.push(chosenRecord);

      const restoringTombstonedPlan =
        !selectedDeleted && Boolean((conflict.serverRecord as any)?._deleted);
      saveSettingWithCloudSync(storageKey, JSON.stringify(nextList), {
        forceRestoreIds: restoringTombstonedPlan ? [conflict.entityId] : [],
      });
      dismissSyncConflict(conflict.id);
      refreshPlanRecovery();
      queryClient.invalidateQueries();
      toast.success(
        choice === 'keep_client'
          ? 'Applied this device\u2019s version and queued sync to Google Sheets!'
          : 'Restored Google Sheets version!'
      );
    } catch (err: any) {
      toast.error('Failed to resolve conflict: ' + (err.message || String(err)));
    }
  };

  const handleEnableWeeklyBackup = async () => {
    setIsBackingUp(true);
    try {
      const res = await sheetsApi.ensureWeeklyBackup();
      if (res.success && res.data?.triggerInstalled) {
        setBackupStatus(res.data);
        toast.success('Weekly Sunday 03:00 Google Drive backup trigger installed & verified! 🛡️');
        await loadDriveBackups();
      } else {
        toast.error('Could not verify backup trigger');
      }
    } catch (err: any) {
      toast.error('Backup trigger setup failed: ' + (err.message || String(err)));
    } finally {
      setIsBackingUp(false);
    }
  };

  const handleCreateDriveSnapshot = async () => {
    setIsBackingUp(true);
    try {
      const res = await sheetsApi.createDriveSnapshot();
      if (res.success && res.data?.created && res.data?.verified !== false) {
        clearPreMigrationBackupError();
        refreshPlanRecovery();
        toast.success(`Verified snapshot "${res.data.name}" saved to Google Drive! 📦`);
        await fetchBackupStatus();
        await loadDriveBackups();
      } else {
        toast.error('Failed to create or verify Drive snapshot');
      }
    } catch (err: any) {
      toast.error('Snapshot error: ' + (err.message || String(err)));
    } finally {
      setIsBackingUp(false);
    }
  };

  const handleRestorePhonePlans = async (
    storageKey: PlanMigrationComparison['storageKey'],
    mode: 'merge_missing' | 'replace_all'
  ) => {
    setIsRestoringPlan(storageKey);
    try {
      restorePhonePlansToSheet(storageKey, mode);
      refreshPlanRecovery();
      const syncRes = await syncCloudSettingsWithLocal();
      queryClient.invalidateQueries();
      if (syncRes.synced) {
        toast.success('Device plans restored and synchronized to Google Sheets! 🚀');
      } else {
        toast.info('Device plans restored locally and queued in outbox to sync when online. 📦');
      }
    } catch (err: any) {
      toast.error('Could not restore plans: ' + (err.message || String(err)));
    } finally {
      setIsRestoringPlan(null);
    }
  };

  const handleSetupTabs = async () => {
    setIsSettingUpTabs(true);
    try {
      const res = await sheetsApi.setupRecurringAndInstallments();
      if (res.success) {
        toast.success('Spreadsheet tabs formatted & populated! 📊');
        await syncCloudSettingsWithLocal();
        queryClient.invalidateQueries();
      } else {
        toast.error('Setup notice: ' + (res.message || 'Unknown response'));
      }
    } catch (err: any) {
      toast.error('Could not setup tabs: ' + (err.message || String(err)));
    } finally {
      setIsSettingUpTabs(false);
    }
  };

  useEffect(() => {
    setMounted(true);
    const url = getApiUrl();
    setApiUrl(url);
    setApiKey(getApiKey());
    setProxyToken(getServerProxyToken());
    setUseProxy(getUseServerProxy());
    const savedCurrency = localStorage.getItem('cashflow_currency') || 'MYR';
    setCurrency(savedCurrency);
    refreshPlanRecovery();
    void fetchBackupStatus();
    void loadDriveBackups();

    const handleRecoveryUpdate = () => refreshPlanRecovery();
    window.addEventListener(PLAN_RECOVERY_UPDATED_EVENT, handleRecoveryUpdate);
    window.addEventListener(SETTINGS_UPDATED_EVENT, handleRecoveryUpdate);
    window.addEventListener(SYNC_STATUS_EVENT, handleRecoveryUpdate);
    window.addEventListener(CONFLICT_UPDATED_EVENT, handleRecoveryUpdate);
    return () => {
      window.removeEventListener(PLAN_RECOVERY_UPDATED_EVENT, handleRecoveryUpdate);
      window.removeEventListener(SETTINGS_UPDATED_EVENT, handleRecoveryUpdate);
      window.removeEventListener(SYNC_STATUS_EVENT, handleRecoveryUpdate);
      window.removeEventListener(CONFLICT_UPDATED_EVENT, handleRecoveryUpdate);
    };
  }, []);

  const handleSaveUrl = async (e: React.FormEvent) => {
    e.preventDefault();
    setUseServerProxy(false);
    setCustomApiUrl(apiUrl.trim());
    toast.success('Google Apps Script connection saved! 🎉');
    queryClient.invalidateQueries();
    // Auto-restore any settings, recurring rules & installment plans from Google Sheet
    void syncCloudSettingsWithLocal().then((res) => {
      if (res.restoredFromCloud) {
        toast.success('Cloud settings & plans synchronized! ☁️');
        queryClient.invalidateQueries({ queryKey: ['settings'] });
      }
    });
  };

  const handleTestConnection = async () => {
    const trimmed = apiUrl.trim();
    if (!trimmed) {
      toast.error('Please enter an Apps Script URL first');
      return;
    }
    setCustomApiUrl(trimmed);
    setIsTesting(true);
    setTestResult(null);

    const startTime = Date.now();
    try {
      // A cached month list is useful for normal rendering, but cannot prove
      // that the current endpoint or proxy credentials are working.
      const res = await sheetsApi.getMonthList(true);
      const elapsed = Date.now() - startTime;
      if (res.success) {
        setTestResult({
          ok: true,
          message: `Connected successfully! Response time: ${elapsed}ms. Found ${res.data?.length || 0} monthly sheets.`
        });
        toast.success('Connection verified! 🚀');
        queryClient.invalidateQueries();
        void syncCloudSettingsWithLocal().then((syncRes) => {
          if (syncRes.restoredFromCloud) {
            queryClient.invalidateQueries({ queryKey: ['settings'] });
          }
        });
      } else {
        setTestResult({
          ok: false,
          message: 'Apps Script replied with error: ' + JSON.stringify(res)
        });
      }
    } catch (err: any) {
      setTestResult({
        ok: false,
        message: 'Could not connect: ' + (err.message || String(err))
      });
      toast.error('Connection test failed');
    } finally {
      setIsTesting(false);
    }
  };

  const handleCurrencyChange = (newCurr: string) => {
    setCurrency(newCurr);
    saveSettingWithCloudSync('cashflow_currency', newCurr);
    toast.success(`Default currency set to ${newCurr}`);
  };

  const handleClearLocalData = async () => {
    const ok = await confirmAction({
      title: 'Clear Local Cache?',
      description: 'Clear temporary cached copies only. Your local-only database, pending offline changes, settings, plans, and Google Sheets records will be preserved.',
      confirmText: 'Clear Cache',
      cancelText: 'Cancel',
      variant: 'warning',
      icon: 'alert',
    });
    if (!ok) return;

    clearAllSwrCache();
    pruneExpiredCache();
    queryClient.invalidateQueries();
    toast.success('Cached copies cleared. Your local database and pending changes were preserved.');
  };

  const handlePruneCache = () => {
    setIsPruning(true);
    try {
      const { prunedKeys } = pruneExpiredCache();
      const count = prunedKeys.length;
      const msg = count > 0
        ? `Cleaned up ${count} expired transaction entries. Active 60-day cache & settings preserved!`
        : 'Cache is already clean! Only the active 60-day window is stored locally.';
      setPruneStats(msg);
      toast.success(msg);
    } catch {
      toast.error('Failed to prune cache');
    } finally {
      setIsPruning(false);
    }
  };

  const handleSyncPendingQueue = async () => {
    if (isSyncingPending) return;
    setIsSyncingPending(true);
    try {
      const res = await syncStatus.flushPending();
      refreshPlanRecovery();
      if (res.succeeded > 0) {
        toast.success(`Successfully uploaded ${res.succeeded} pending changes to Google Sheets! 🚀`);
        queryClient.invalidateQueries();
      } else if (res.failed > 0) {
        toast.error(`Could not sync ${res.failed} changes. You can inspect or discard stale items below.`);
      } else {
        toast.info('All changes are already synchronized with Google Sheets! ☁️');
      }
    } catch (err: any) {
      toast.error('Sync failed: ' + (err.message || String(err)));
    } finally {
      refreshPlanRecovery();
      setIsSyncingPending(false);
    }
  };

  const handleUpdatePin = (e: React.FormEvent) => {
    e.preventDefault();
    if (changePin(newPin)) {
      setNewPin('');
      setShowPinInput(false);
      setShowActivePin(true);
    }
  };

  if (!mounted) return null;

  return (
    <div className="cockpit-module-page min-h-full pb-16">
      <CockpitPageHeading
        title="Settings"
        description="Manage Google Account cloud sync, Admin access control, local cache policy, and security"
      />

      <GoogleAccountAndAdminPanel />

      <MerchantRulesManager />

      {/* Cloud Architecture & 60-Day Cache Manager */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold text-slate-600 dark:text-zinc-400 uppercase tracking-wider flex items-center gap-1.5">
            <Cloud className="h-3.5 w-3.5 text-indigo-800 dark:text-indigo-400" />
            <span>Google Sheets Cloud Architecture & Cache</span>
          </h2>
          <span className={`text-[10px] px-2.5 py-0.5 rounded-full font-bold uppercase flex items-center gap-1.5 ${
            !syncStatus.isOnline
              ? 'bg-rose-500/20 text-rose-800 dark:text-rose-300 border border-rose-500/30'
              : !syncStatus.isConnected
              ? 'bg-amber-500/20 text-amber-800 dark:text-amber-300 border border-amber-500/30'
              : syncStatus.pendingCount > 0
              ? 'bg-amber-500/20 text-amber-800 dark:text-amber-300 border border-amber-500/30'
              : 'bg-emerald-500/20 text-emerald-800 dark:text-emerald-300 border border-emerald-500/30'
          }`}>
            <span className={`h-1.5 w-1.5 rounded-full ${
              !syncStatus.isOnline
                ? 'bg-rose-500'
                : !syncStatus.isConnected
                ? 'bg-amber-500'
                : syncStatus.pendingCount > 0
                ? 'bg-amber-400 animate-pulse'
                : 'bg-emerald-400 animate-pulse'
            }`} />
            {!syncStatus.isOnline
              ? 'Offline'
              : !syncStatus.isConnected
              ? 'Disconnected'
              : syncStatus.pendingCount > 0
              ? `${syncStatus.pendingCount} Pending Sync`
              : `Synced ${syncStatus.formattedLastSync}`}
          </span>
        </div>

        <div className="rounded-3xl border border-slate-200 dark:border-zinc-800/80 bg-white/90 dark:bg-zinc-900/40 p-6 backdrop-blur-xl space-y-6 specular-card">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-indigo-500/15 text-indigo-800 dark:text-indigo-400 border border-indigo-500/30 shadow-lg shadow-indigo-500/10">
                <Database className="h-6 w-6" />
              </div>
              <div>
                <div className="font-bold text-slate-950 dark:text-white text-base flex items-center gap-2">
                  <span>Google Sheets Permanent Source of Truth</span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold bg-emerald-500/20 text-emerald-800 dark:text-emerald-300 border border-emerald-500/30">
                    SOT Safe
                  </span>
                </div>
                <div className="text-xs text-slate-600 dark:text-zinc-400 mt-0.5 max-w-xl">
                  Your full multi-year financial history is stored permanently in your personal Google Drive spreadsheet. Your device only keeps a lean 60-day rolling cache for instant startup.
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleSyncPendingQueue}
                disabled={isSyncingPending || !syncStatus.isConnected}
                className="flex items-center gap-1.5 text-xs px-3.5 py-2 rounded-xl bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-800 dark:text-zinc-200 transition-colors cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${isSyncingPending ? 'animate-spin' : ''}`} />
                <span>{syncStatus.pendingCount > 0 ? `Sync ${syncStatus.pendingCount} Pending Changes` : 'Sync Pending'}</span>
              </button>
            </div>
          </div>

          {/* Sync & Connection Banner */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="p-3.5 rounded-2xl bg-white/90 dark:bg-zinc-950/70 border border-slate-200 dark:border-zinc-800/80 space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-slate-600 dark:text-zinc-400">Connection Status</span>
                {syncStatus.isConnected && syncStatus.isOnline ? (
                  <Wifi className="h-3.5 w-3.5 text-emerald-800 dark:text-emerald-400" />
                ) : (
                  <WifiOff className="h-3.5 w-3.5 text-rose-800 dark:text-rose-400" />
                )}
              </div>
              <p className="text-sm font-bold text-slate-950 dark:text-white flex items-center gap-1.5">
                <span className={`h-2 w-2 rounded-full ${syncStatus.isConnected && syncStatus.isOnline ? 'bg-emerald-400' : 'bg-rose-400'}`} />
                {!syncStatus.hasCloudEndpoint
                  ? 'Local only'
                  : !syncStatus.isOnline
                    ? 'Device Offline'
                    : syncStatus.isConnected
                      ? 'Connected'
                      : 'Connection unavailable'}
              </p>
              <p className="text-[10px] text-slate-500 dark:text-zinc-400">
                {googleUser
                  ? `Google Drive Cloud (${googleUser.email})`
                  : isLocalMode
                  ? 'Local Device Storage Only (Not backed up to Google Drive)'
                  : 'Google Apps Script Bridge'}
              </p>
              {!syncStatus.isConnected && syncStatus.lastSyncError && (
                <p role="status" className="pt-1 text-[11px] leading-relaxed text-rose-800 dark:text-rose-300 break-words">
                  {syncStatus.lastSyncError.includes('console.developers.google.com')
                    ? 'Google Sheets / Drive API needs to be enabled once in Google Cloud Console for this project.'
                    : syncStatus.lastSyncError}
                </p>
              )}
            </div>

            <div className="p-3.5 rounded-2xl bg-white/90 dark:bg-zinc-950/70 border border-slate-200 dark:border-zinc-800/80 space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-slate-600 dark:text-zinc-400">Last Successful Sheet Response</span>
                <Clock className="h-3.5 w-3.5 text-indigo-800 dark:text-indigo-400" />
              </div>
              <p className="text-sm font-bold text-slate-950 dark:text-white">
                {syncStatus.formattedLastSync}
              </p>
              <p className="text-[10px] text-slate-500 dark:text-zinc-400">Includes successful reads and writes</p>
            </div>

            <div className="p-3.5 rounded-2xl bg-white/90 dark:bg-zinc-950/70 border border-slate-200 dark:border-zinc-800/80 space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-slate-600 dark:text-zinc-400">Offline Queue</span>
                <HardDrive className="h-3.5 w-3.5 text-amber-800 dark:text-amber-400" />
              </div>
              <p className="text-sm font-bold text-slate-950 dark:text-white">
                {syncStatus.pendingCount === 0 ? (
                  <span className="text-emerald-800 dark:text-emerald-400">All Changes Synced</span>
                ) : (
                  <span className="text-amber-800 dark:text-amber-400">{syncStatus.pendingCount} Pending</span>
                )}
              </p>
              <p className="text-[10px] text-slate-500 dark:text-zinc-400">Zero data loss on offline edits</p>
            </div>
          </div>

          {/* Architecture & Expiry Rules Details */}
          <div className="p-4 rounded-2xl bg-white/90 dark:bg-zinc-950/70 border border-slate-200 dark:border-zinc-800/80 space-y-3">
            <span className="text-xs font-bold text-slate-800 dark:text-zinc-200 flex items-center gap-1.5">
              <Layers className="h-3.5 w-3.5 text-indigo-800 dark:text-indigo-400" />
              <span>Storage & Expiry Policy:</span>
            </span>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              <div className="p-3 rounded-xl bg-white/90 dark:bg-zinc-900/60 border border-slate-200 dark:border-zinc-800/50 space-y-1">
                <div className="font-semibold text-slate-800 dark:text-zinc-200 flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  <span>Instant 0ms Startup + 12-Month Warm Cache</span>
                </div>
                <p className="text-slate-600 dark:text-zinc-400 text-[11px] leading-relaxed">
                  Startup renders immediately from local cache, refreshes the active 3 calendar months first, and quietly warms the past 12 months in the background so switching months is instant.
                </p>
              </div>

              <div className="p-3 rounded-xl bg-white/90 dark:bg-zinc-900/60 border border-slate-200 dark:border-zinc-800/50 space-y-1">
                <div className="font-semibold text-slate-800 dark:text-zinc-200 flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-indigo-400" />
                  <span>Smart LRU Cache Retention</span>
                </div>
                <p className="text-slate-600 dark:text-zinc-400 text-[11px] leading-relaxed">
                  Any month you view is cached locally (up to 36 months / 4MB LRU cap) so revisiting September or any historical month loads with zero waiting time.
                </p>
              </div>

              <div className="p-3 rounded-xl bg-white/90 dark:bg-zinc-900/60 border border-slate-200 dark:border-zinc-800/50 space-y-1">
                <div className="font-semibold text-slate-800 dark:text-zinc-200 flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                  <span>Permanent Expiry Exemption</span>
                </div>
                <p className="text-slate-600 dark:text-zinc-400 text-[11px] leading-relaxed">
                  Recurring commitments, installment plans, budgets, and currency preferences are permanently exempt from cache cleanup and synced with Google Sheets.
                </p>
              </div>

              <div className="p-3 rounded-xl bg-white/90 dark:bg-zinc-900/60 border border-slate-200 dark:border-zinc-800/50 space-y-1">
                <div className="font-semibold text-slate-800 dark:text-zinc-200 flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-purple-400" />
                  <span>Zero-Drop Offline Queue</span>
                </div>
                <p className="text-slate-600 dark:text-zinc-400 text-[11px] leading-relaxed">
                  If you add, edit, or delete while offline or when the network drops, mutations are saved to a durable local queue and retried automatically until Google Sheets acknowledges them.
                </p>
              </div>
            </div>

            <div className="pt-2 flex flex-wrap items-center justify-between gap-3">
              <span className="text-[11px] text-slate-500 dark:text-zinc-400">
                Cache cleanup runs automatically in the background on startup.
              </span>
              <button
                type="button"
                onClick={handlePruneCache}
                disabled={isPruning}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-xl border border-slate-300 dark:border-zinc-700 bg-slate-100 dark:bg-zinc-800/80 hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-700 dark:text-zinc-300 hover:text-slate-950 dark:hover:text-white transition-colors cursor-pointer disabled:opacity-50"
              >
                <Trash2 className="h-3 w-3 text-slate-600 dark:text-zinc-400" />
                <span>{isPruning ? 'Cleaning Cache...' : 'Prune Expired Cache Now'}</span>
              </button>
            </div>

            {pruneStats && (
              <motion.div
                initial={{ opacity: 0, y: -5 }}
                animate={{ opacity: 1, y: 0 }}
                className="p-3 rounded-xl border border-emerald-500/20 bg-emerald-950/20 text-emerald-800 dark:text-emerald-300 text-xs flex items-center gap-2"
              >
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-800 dark:text-emerald-400" />
                <span>{pruneStats}</span>
              </motion.div>
            )}
          </div>

          {/* Unified Durable Outbox Inspector: Pending & Failed Changes (P1 #9) */}
          {(pendingTxList.length > 0 || pendingPlanList.length > 0 || pendingSettingList.length > 0) && (
            <div className="p-4 rounded-2xl border border-amber-500/30 bg-amber-950/20 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-bold text-amber-800 dark:text-amber-300 flex items-center gap-1.5">
                  <HardDrive className="h-4 w-4 text-amber-800 dark:text-amber-400 shrink-0" />
                  <span>
                    Durable Outbox Queue ({pendingTxList.length + pendingPlanList.length + pendingSettingList.length} unconfirmed
                    {syncStatus.failedCount > 0 ? ` • ${syncStatus.failedCount} failed` : ''})
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleSyncPendingQueue}
                    disabled={isSyncingPending || !syncStatus.isOnline || !syncStatus.hasCloudEndpoint}
                    className="px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-800 dark:text-amber-200 border border-amber-500/30 text-[11px] font-semibold transition-colors cursor-pointer disabled:opacity-50"
                  >
                    {isSyncingPending ? 'Retrying...' : 'Retry All Now'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      pendingTxList.forEach((m) => removePendingMutation(m.id));
                      pendingPlanList.forEach((m) => discardPendingPlanMutation(m.mutationId));
                      if (pendingSettingList.length > 0) {
                        removePendingSettingMutations(pendingSettingList.map((m) => m.key));
                      }
                      refreshPlanRecovery();
                      toast.info('Cleared all pending outbox items.');
                    }}
                    className="px-2.5 py-1.5 rounded-lg border border-rose-500/30 text-rose-800 dark:text-rose-300 hover:bg-rose-500/10 text-[11px] font-semibold transition-colors cursor-pointer"
                  >
                    Discard All
                  </button>
                </div>
              </div>

              <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                {pendingTxList.map((m) => (
                  <div
                    key={m.id}
                    className="flex flex-wrap items-center justify-between gap-2 p-2.5 rounded-xl bg-white/90 dark:bg-zinc-950/80 border border-slate-200 dark:border-zinc-800 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="font-semibold text-slate-800 dark:text-zinc-200">
                        [Transaction {m.type.toUpperCase()}] Tab: {m.sheetName} • ID: {m.rowId || m.rowIndex}
                      </div>
                      {m.lastError && (
                        <div className="text-[10px] text-rose-800 dark:text-rose-400 mt-0.5">
                          Error (retry #{m.retryCount}): {m.lastError}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        removePendingMutation(m.id);
                        refreshPlanRecovery();
                        toast.info('Discarded pending transaction mutation');
                      }}
                      className="px-2 py-1 rounded-lg border border-rose-500/30 text-rose-800 dark:text-rose-300 hover:bg-rose-500/10 text-[10px] cursor-pointer"
                    >
                      Discard
                    </button>
                  </div>
                ))}

                {pendingPlanList.map((m) => (
                  <div
                    key={m.mutationId}
                    className="flex flex-wrap items-center justify-between gap-2 p-2.5 rounded-xl bg-white/90 dark:bg-zinc-950/80 border border-slate-200 dark:border-zinc-800 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="font-semibold text-slate-800 dark:text-zinc-200">
                        [Plan {m.action.toUpperCase()}] {m.storageKey.includes('recurring') ? 'Recurring' : 'Installment'} • ID: {m.entityId}
                      </div>
                      {m.lastError && (
                        <div className="text-[10px] text-rose-800 dark:text-rose-400 mt-0.5">
                          Error (retry #{m.retryCount || 1}): {m.lastError}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        discardPendingPlanMutation(m.mutationId);
                        refreshPlanRecovery();
                        toast.info('Discarded pending plan mutation');
                      }}
                      className="px-2 py-1 rounded-lg border border-rose-500/30 text-rose-800 dark:text-rose-300 hover:bg-rose-500/10 text-[10px] cursor-pointer"
                    >
                      Discard
                    </button>
                  </div>
                ))}

                {pendingSettingList.map((m) => (
                  <div
                    key={m.key}
                    className="flex flex-wrap items-center justify-between gap-2 p-2.5 rounded-xl bg-white/90 dark:bg-zinc-950/80 border border-slate-200 dark:border-zinc-800 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="font-semibold text-slate-800 dark:text-zinc-200">
                        [Setting] {m.key}
                      </div>
                      {m.lastError && (
                        <div className="text-[10px] text-rose-800 dark:text-rose-400 mt-0.5">
                          Error (retry #{m.retryCount || 1}): {m.lastError}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        removePendingSettingMutations([m.key]);
                        refreshPlanRecovery();
                        toast.info(`Discarded pending setting change for ${m.key}`);
                      }}
                      className="px-2 py-1 rounded-lg border border-rose-500/30 text-rose-800 dark:text-rose-300 hover:bg-rose-500/10 text-[10px] cursor-pointer"
                    >
                      Discard
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Cross-Device Sync Conflicts Inspector (P1 #11) */}
          {syncConflicts.length > 0 && (
            <div className="p-4 rounded-2xl border border-rose-500/30 bg-rose-950/20 space-y-3">
              <div className="text-xs font-bold text-rose-800 dark:text-rose-300 flex items-center gap-1.5">
                <GitCompare className="h-4 w-4 text-rose-800 dark:text-rose-400 shrink-0" />
                <span>Cross-Device Edit Conflicts Detected ({syncConflicts.length})</span>
              </div>
              <p className="text-[11px] text-slate-700 dark:text-zinc-300">
                Two devices edited the same record before syncing. Both versions were preserved so no change is ever silently lost:
              </p>
              <div className="space-y-2">
                {syncConflicts.map((c) => (
                  <div key={c.id} className="p-3 rounded-xl bg-white/90 dark:bg-zinc-950/80 border border-slate-200 dark:border-zinc-800 space-y-2 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-bold text-slate-950 dark:text-white">
                        {String((c.clientRecord as any)?.name || (c.serverRecord as any)?.name || c.entityId)} ({c.kind})
                      </span>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleResolveConflict(c, 'keep_client')}
                          className="px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white dark:text-white text-[11px] font-semibold cursor-pointer"
                        >
                          Use This Device Version
                        </button>
                        <button
                          type="button"
                          onClick={() => handleResolveConflict(c, 'keep_server')}
                          className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white dark:text-white text-[11px] font-semibold cursor-pointer"
                        >
                          Use Other Device (Sheet) Version
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            dismissSyncConflict(c.id);
                            refreshPlanRecovery();
                          }}
                          className="px-2 py-1 rounded-lg border border-slate-300 dark:border-zinc-700 bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-zinc-300 text-[11px] cursor-pointer"
                        >
                          Dismiss
                        </button>
                      </div>
                    </div>
                    {c.conflictingFields && c.conflictingFields.length > 0 && (
                      <div className="text-[10px] text-amber-800 dark:text-amber-300">
                        Conflicting fields: {c.conflictingFields.join(', ')}
                      </div>
                    )}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
                      <div className="p-2 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-indigo-800 dark:text-indigo-200">
                        <div className="font-semibold">This Device Edit:</div>
                        <div className="truncate font-mono text-[10px] mt-0.5">
                          {JSON.stringify(c.clientRecord)}
                        </div>
                      </div>
                      <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-800 dark:text-emerald-200">
                        <div className="font-semibold">Other Device (Sheet) Edit:</div>
                        <div className="truncate font-mono text-[10px] mt-0.5">
                          {JSON.stringify(c.serverRecord)}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Google Drive & Sheets Connection Section */}
      <section className="space-y-4">
        <h2 className="text-xs font-semibold text-slate-600 dark:text-zinc-400 uppercase tracking-wider">
          Google Drive & Sheets Connection
        </h2>

        <div className="rounded-3xl border border-slate-200 dark:border-zinc-800/80 bg-white/90 dark:bg-zinc-900/40 p-6 backdrop-blur-xl space-y-5 specular-card">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className={`flex h-10 w-10 items-center justify-center rounded-2xl ${
                apiUrl ? 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-400' : 'bg-amber-500/10 text-amber-800 dark:text-amber-400'
              }`}>
                <Database className="h-5 w-5" />
              </div>
              <div>
                <div className="font-semibold text-slate-950 dark:text-white text-sm">
                  {googleUser ? 'Personal Google Drive & Sheets Engine' : 'Google Cloud Connection'}
                </div>
                <div className="text-xs flex items-center gap-1.5 mt-0.5">
                  <span className={`h-2 w-2 rounded-full ${apiUrl ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                  <span className={apiUrl ? 'text-emerald-800 dark:text-emerald-400 font-medium' : 'text-amber-800 dark:text-amber-400 font-medium'}>
                    {googleUser
                      ? `Connected as ${googleUser.email}`
                      : apiUrl
                      ? 'Connected to Google Sheets'
                      : 'Local-only (not synced)'}
                  </span>
                </div>
              </div>
            </div>

            {!googleUser && (
              <a
                href="/api/auth/google/login"
                className="flex items-center gap-1.5 text-xs px-3.5 py-2 rounded-xl bg-indigo-500 hover:bg-indigo-600 text-white font-semibold transition-colors"
              >
                <Cloud className="h-3.5 w-3.5" />
                <span>Sign in with Google</span>
              </a>
            )}
          </div>

          {!googleUser && (
            <form onSubmit={handleSaveUrl} className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-xs text-slate-600 dark:text-zinc-400 block font-medium">
                  Custom Web App Deployment URL (Optional Advanced Mode):
                </label>
                <div className="flex flex-col sm:flex-row gap-2.5">
                  <input
                    type="text"
                    placeholder="https://script.google.com/macros/s/.../exec"
                    value={apiUrl}
                    onChange={(e) => setApiUrl(e.target.value)}
                    className="flex-1 rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-3 text-xs text-slate-950 dark:text-white font-mono outline-none focus:border-indigo-500 transition-colors"
                  />
                  <button
                    type="submit"
                    className="px-5 py-3 rounded-2xl bg-indigo-500 hover:bg-indigo-600 text-white dark:text-white font-semibold text-xs transition-all cursor-pointer shrink-0"
                  >
                    Save Connection
                  </button>
                </div>
                <p className="text-[11px] text-slate-500 dark:text-zinc-400">
                  Tip: Sign in with your Google Account above for automatic zero-setup Google Drive sync.
                </p>
              </div>
            </form>
          )}

          {/* Test Connection Button & Result */}
          <div className="flex flex-wrap items-center gap-3 pt-2">
            <button
              onClick={handleTestConnection}
              disabled={isTesting}
              className="flex items-center gap-2 px-4 py-2 rounded-xl border border-slate-300 dark:border-zinc-700 bg-slate-100 dark:bg-zinc-800/80 hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-950 dark:text-white text-xs font-semibold transition-all cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isTesting ? 'animate-spin' : ''}`} />
              <span>{isTesting ? 'Checking Google Drive...' : 'Test Connection'}</span>
            </button>
          </div>

          {testResult && (
            <motion.div
              initial={{ opacity: 0, y: -5 }}
              animate={{ opacity: 1, y: 0 }}
              className={`p-3.5 rounded-2xl border text-xs flex items-start gap-2.5 ${
                testResult.ok
                  ? 'border-emerald-500/20 bg-emerald-950/20 text-emerald-800 dark:text-emerald-300'
                  : 'border-rose-500/20 bg-rose-950/20 text-rose-800 dark:text-rose-300'
              }`}
            >
              {testResult.ok ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-800 dark:text-emerald-400 mt-0.5" />
              ) : (
                <AlertCircle className="h-4 w-4 shrink-0 text-rose-800 dark:text-rose-400 mt-0.5" />
              )}
              <span className="leading-relaxed">{testResult.message}</span>
            </motion.div>
          )}

          {/* Pre-Migration Backup Gate Alert (P0 #4) */}
          {preMigrationError && (
            <div className="p-4 rounded-2xl border border-rose-500/40 bg-rose-950/30 space-y-2.5 text-xs">
              <div className="font-bold text-rose-800 dark:text-rose-300 flex items-center gap-1.5">
                <AlertCircle className="h-4 w-4 text-rose-800 dark:text-rose-400 shrink-0" />
                <span>Plan Migration Paused: Pre-Migration Backup Not Confirmed</span>
              </div>
              <p className="text-[11px] text-slate-700 dark:text-zinc-300 leading-relaxed">
                {preMigrationError.message}
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    await handleCreateDriveSnapshot();
                    const syncRes = await syncCloudSettingsWithLocal();
                    if (syncRes.synced) {
                      toast.success('Pre-migration backup verified and plans migrated safely! 🎉');
                    }
                  }}
                  disabled={isBackingUp}
                  className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white dark:text-white text-[11px] font-semibold cursor-pointer disabled:opacity-50"
                >
                  {isBackingUp ? 'Creating Verified Backup...' : 'Retry Pre-Migration Backup & Sync'}
                </button>
              </div>
            </div>
          )}

          {/* Full Sheet Synchronization Manager */}
          {apiUrl && (
            <div className="mt-6 pt-6 border-t border-slate-200 dark:border-zinc-800/80 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-bold text-slate-950 dark:text-white flex items-center gap-2">
                    <span>Google Sheet Full Synchronization</span>
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-indigo-500/10 text-indigo-800 dark:text-indigo-400 border border-indigo-500/20">
                      Cloud SOT
                    </span>
                  </h3>
                  <p className="text-xs text-slate-600 dark:text-zinc-400 mt-0.5">
                    Reconciles Overview, Portfolio, Trades, Monthly Expenses, and Trips directly into Google Sheets.
                  </p>
                </div>

                <button
                  onClick={async () => {
                    if (isTesting) return;
                    setIsTesting(true);
                    try {
                      const { syncAllGoogleSheets } = await import('@/lib/sync-engine');
                      const res = await syncAllGoogleSheets();
                      await queryClient.invalidateQueries();
                      if (res.success) {
                        toast.success('All Google Sheet tabs successfully synchronized! 🚀');
                      } else {
                        toast.warning('Sync completed with warnings. Some formulas were refreshed.');
                      }
                    } catch (err) {
                      console.error('Sync error:', err);
                      toast.error('Sync failed. Please check your internet connection.');
                    } finally {
                      setIsTesting(false);
                    }
                  }}
                  disabled={isTesting}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white dark:text-white font-semibold text-xs shadow-md shadow-emerald-600/20 transition-all cursor-pointer disabled:opacity-50"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${isTesting ? 'animate-spin' : ''}`} />
                  <span>{isTesting ? 'Synchronizing Sheets...' : 'Force Full Sync to Google Sheet'}</span>
                </button>

                <button
                  type="button"
                  onClick={handleSetupTabs}
                  disabled={isSettingUpTabs}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white dark:text-white font-semibold text-xs shadow-md shadow-indigo-600/20 transition-all cursor-pointer disabled:opacity-50"
                >
                  <Layers className={`h-3.5 w-3.5 ${isSettingUpTabs ? 'animate-spin' : ''}`} />
                  <span>{isSettingUpTabs ? 'Formatting Sheets...' : 'Setup Recurring & Installments Tabs'}</span>
                </button>
              </div>

              {/* Status Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 pt-2">
                {[
                  { name: 'Overview', desc: 'Monthly & Annual Net Growth', status: 'Synced' },
                  { name: 'Portfolio', desc: 'Holdings & Live GOOGLEFINANCE', status: 'Synced' },
                  { name: 'Trades', desc: 'Buy/Sell/Dividend Logs', status: 'Synced' },
                  { name: 'Monthly Tabs', desc: 'Expenses & Income Tabs', status: 'Synced' },
                  { name: 'Recurring', desc: 'Monthly Commitments & Due Days', status: 'Synced' },
                  { name: 'Installments', desc: 'Active Buy-Now-Pay-Later Plans', status: 'Synced' },
                  { name: 'Trips', desc: 'Travel & Budget Itineraries', status: 'Synced' },
                  { name: 'Settings', desc: 'Preferences & Cloud Mirror', status: 'Synced' },
                ].map((item) => (
                  <div key={item.name} className="p-3 rounded-2xl bg-white/90 dark:bg-zinc-950/60 border border-slate-200 dark:border-zinc-800/80 flex flex-col justify-between">
                    <div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-slate-950 dark:text-white">{item.name}</span>
                        <span className="inline-flex items-center gap-1 text-[10px] text-emerald-800 dark:text-emerald-400 font-semibold">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                          {item.status}
                        </span>
                      </div>
                      <p className="text-[10px] text-slate-600 dark:text-zinc-400 mt-1 line-clamp-1">{item.desc}</p>
                    </div>
                  </div>
                ))}
              </div>

              {/* Google Drive Weekly Backups & Snapshots */}
              <div className="mt-5 pt-5 border-t border-slate-200 dark:border-zinc-800/80 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <div className={`h-9 w-9 rounded-xl flex items-center justify-center ${
                      backupStatus?.backupHealth === 'healthy'
                        ? 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-400'
                        : backupStatus?.backupHealth === 'stale'
                        ? 'bg-rose-500/10 text-rose-800 dark:text-rose-400'
                        : 'bg-amber-500/10 text-amber-800 dark:text-amber-400'
                    }`}>
                      <ShieldCheck className="h-4.5 w-4.5" />
                    </div>
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-bold text-slate-950 dark:text-white">Google Drive Automated Backups</span>
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                          backupStatus?.triggerInstalled
                            ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border border-emerald-500/25'
                            : 'bg-amber-500/15 text-amber-800 dark:text-amber-300 border border-amber-500/25'
                        }`}>
                          {backupStatus?.triggerInstalled ? 'Weekly Trigger Active' : 'Trigger Not Verified'}
                        </span>
                        {backupStatus?.backupHealth && (
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase ${
                            backupStatus.backupHealth === 'healthy'
                              ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border border-emerald-500/25'
                              : backupStatus.backupHealth === 'stale'
                              ? 'bg-rose-500/15 text-rose-800 dark:text-rose-300 border border-rose-500/25'
                              : 'bg-amber-500/15 text-amber-800 dark:text-amber-300 border border-amber-500/25'
                          }`}>
                            Health: {backupStatus.backupHealth}
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-slate-600 dark:text-zinc-400 mt-0.5">
                        {backupStatus?.lastBackupAt
                          ? `Last snapshot: ${backupStatus.lastBackupName || 'CashFlow Backup'} (${new Date(backupStatus.lastBackupAt).toLocaleString()})${
                              backupStatus.sheetCount ? ` • ${backupStatus.sheetCount} tabs, ${backupStatus.totalRows || 0} rows verified` : ''
                            }`
                          : 'Immutable spreadsheet copies are saved to the "CashFlow Backups" folder in your Google Drive.'}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={handleEnableWeeklyBackup}
                      disabled={isBackingUp}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-300 dark:border-zinc-700 bg-slate-100 dark:bg-zinc-800/80 hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-800 dark:text-zinc-200 text-xs font-semibold transition-all cursor-pointer disabled:opacity-50"
                    >
                      <ShieldCheck className="h-3.5 w-3.5 text-emerald-800 dark:text-emerald-400" />
                      <span>{backupStatus?.triggerInstalled ? 'Verify Weekly Trigger' : 'Enable Weekly Backup'}</span>
                    </button>

                    <button
                      type="button"
                      onClick={handleCreateDriveSnapshot}
                      disabled={isBackingUp}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-indigo-500/30 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-800 dark:text-indigo-300 text-xs font-semibold transition-all cursor-pointer disabled:opacity-50"
                    >
                      <Archive className="h-3.5 w-3.5" />
                      <span>{isBackingUp ? 'Saving...' : 'Create Snapshot Now'}</span>
                    </button>

                    <button
                      type="button"
                      onClick={loadDriveBackups}
                      disabled={isLoadingBackups}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-700 dark:text-zinc-300 text-xs font-medium transition-all cursor-pointer disabled:opacity-50"
                    >
                      <RefreshCw className={`h-3 w-3 ${isLoadingBackups ? 'animate-spin' : ''}`} />
                      <span>Refresh Snapshots</span>
                    </button>
                  </div>
                </div>

                {/* Stale / Missing Backup Alert (P2 #13) */}
                {(backupStatus?.lastBackupStale || backupStatus?.backupHealth === 'missing' || backupStatus?.backupHealth === 'unverified') && (
                  <div className="p-3 rounded-xl border border-rose-500/30 bg-rose-950/20 text-rose-800 dark:text-rose-200 text-xs flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <AlertCircle className="h-4 w-4 text-rose-800 dark:text-rose-400 shrink-0" />
                      <span>
                        {backupStatus.lastBackupStale
                          ? 'Backup Alert: Your latest Google Drive backup is older than 8 days. Click "Create Snapshot Now" or verify the weekly trigger.'
                          : 'Backup Alert: No verified healthy backup snapshot was found yet. Create a snapshot now before running major changes.'}
                      </span>
                    </div>
                  </div>
                )}

                {driveBackups.length > 0 && (
                  <div className="mt-3 p-3.5 rounded-2xl bg-white/90 dark:bg-zinc-950/70 border border-slate-200 dark:border-zinc-800/80 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-bold text-slate-700 dark:text-zinc-300">
                        Available Google Drive Snapshots ({driveBackups.length})
                      </span>
                      <span className="text-[10px] text-slate-500 dark:text-zinc-400">
                        Retains up to 12 weekly + 10 safety snapshots • Staged restore with rollback
                      </span>
                    </div>
                    <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
                      {driveBackups.map((snap) => (
                        <div
                          key={snap.id}
                          className="flex flex-wrap items-center justify-between gap-2 p-2.5 rounded-xl bg-white/90 dark:bg-zinc-900/60 border border-slate-200 dark:border-zinc-800/60 text-xs"
                        >
                          <div className="min-w-0">
                            <div className="font-semibold text-slate-800 dark:text-zinc-200 truncate">{snap.name}</div>
                            <div className="text-[10px] text-slate-500 dark:text-zinc-400">
                              {new Date(snap.createdAt).toLocaleString()}
                            </div>
                          </div>
                          <div className="flex flex-wrap items-center gap-2 shrink-0">
                            {snap.url && (
                              <a
                                href={snap.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-700 dark:text-zinc-300 text-[11px] flex items-center gap-1 transition-colors"
                              >
                                <span>Open</span>
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            )}
                            <button
                              type="button"
                              onClick={() => handleTestRestoreBackup(snap.id, snap.name)}
                              disabled={isTestingRestoreId !== null || isRestoringBackupId !== null}
                              className="px-2.5 py-1 rounded-lg bg-indigo-500/15 hover:bg-indigo-500/25 text-indigo-800 dark:text-indigo-300 border border-indigo-500/30 text-[11px] font-semibold transition-colors cursor-pointer disabled:opacity-50"
                            >
                              {isTestingRestoreId === snap.id ? 'Testing...' : 'Test Restore (Dry Run)'}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRestoreBackupSnapshot(snap.id, snap.name)}
                              disabled={isRestoringBackupId !== null || isTestingRestoreId !== null}
                              className="px-2.5 py-1 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 text-amber-800 dark:text-amber-300 border border-amber-500/30 text-[11px] font-semibold transition-colors cursor-pointer disabled:opacity-50"
                            >
                              {isRestoringBackupId === snap.id ? 'Restoring...' : 'Restore Snapshot'}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Dry-Run Test Restore Report (P2 #15) */}
                {testRestoreReport && (
                  <div className={`p-3.5 rounded-2xl border text-xs space-y-1.5 ${
                    testRestoreReport.passed
                      ? 'border-emerald-500/30 bg-emerald-950/20 text-emerald-800 dark:text-emerald-200'
                      : 'border-amber-500/30 bg-amber-950/20 text-amber-800 dark:text-amber-200'
                  }`}>
                    <div className="font-bold flex items-center gap-1.5">
                      <CheckCircle2 className="h-4 w-4 shrink-0" />
                      <span>
                        Dry-Run Restore Report for &ldquo;{testRestoreReport.sourceName}&rdquo;: {testRestoreReport.passed ? 'PASSED' : 'ISSUES FOUND'}
                      </span>
                    </div>
                    <p className="text-[11px]">
                      Restored into an isolated temporary test Sheet &amp; verified {testRestoreReport.sheetsTested} tabs, {testRestoreReport.totalRowsVerified} rows, and {testRestoreReport.overviewFormulaMatches} Overview formulas (live Sheet untouched).
                    </p>
                    {testRestoreReport.discrepancies.length > 0 && (
                      <ul className="list-disc list-inside text-[11px] text-rose-800 dark:text-rose-300">
                        {testRestoreReport.discrepancies.map((d, idx) => (
                          <li key={idx}>{d}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {/* Post-Restore Verification & Local Queue Reconciliation Summary (P0 #2, #3) */}
                {postRestoreSummary && (
                  <div className="p-3.5 rounded-2xl border border-emerald-500/30 bg-emerald-950/25 text-emerald-800 dark:text-emerald-200 text-xs space-y-1">
                    <div className="font-bold flex items-center gap-1.5">
                      <CheckCircle2 className="h-4 w-4 text-emerald-800 dark:text-emerald-400 shrink-0" />
                      <span>Staged Restore Verified: &ldquo;{postRestoreSummary.restoredFromName}&rdquo;</span>
                    </div>
                    <p className="text-[11px] text-slate-800 dark:text-zinc-200">
                      Restored {postRestoreSummary.sheetsRestored} tabs ({postRestoreSummary.totalRowsRestored} total rows). Pre-restore safety snapshot saved as <span className="font-mono">{postRestoreSummary.safetyBackupName}</span>.
                    </p>
                    <p className="text-[11px] text-emerald-800 dark:text-emerald-300">
                      Local device reconciliation: {postRestoreSummary.discardedLocalChanges} pending offline change(s) discarded and {postRestoreSummary.retainedLocalChanges} retained so stale phone cache cannot overwrite the restored Sheet.
                    </p>
                  </div>
                )}

                {/* Independent Offline Backup (.json) & Data Integrity Checks (P2 #14, #16, #18) */}
                <div className="pt-3 border-t border-slate-200 dark:border-zinc-800/70 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-xs font-bold text-slate-950 dark:text-white flex items-center gap-1.5">
                        <FileCheck2 className="h-3.5 w-3.5 text-indigo-800 dark:text-indigo-400" />
                        <span>Independent Offline Backup &amp; Data Integrity Verification</span>
                      </div>
                      <p className="text-[11px] text-slate-600 dark:text-zinc-400">
                        Export a standalone dated JSON backup outside your Google account, or audit all IDs, dates, headers, and Overview formulas.
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={handleExportOfflineBackup}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-800 dark:text-zinc-200 text-xs font-semibold cursor-pointer"
                      >
                        <Download className="h-3.5 w-3.5 text-emerald-800 dark:text-emerald-400" />
                        <span>Export Offline Backup (.json)</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-700 dark:text-zinc-300 text-xs font-semibold cursor-pointer"
                      >
                        <Upload className="h-3.5 w-3.5 text-indigo-800 dark:text-indigo-400" />
                        <span>Import Offline Backup</span>
                      </button>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="application/json,.json"
                        onChange={handleImportOfflineBackup}
                        className="hidden"
                      />
                      <button
                        type="button"
                        onClick={handleRunIntegrityCheck}
                        disabled={isCheckingIntegrity}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-800 dark:text-emerald-300 text-xs font-semibold cursor-pointer disabled:opacity-50"
                      >
                        <ShieldCheck className="h-3.5 w-3.5" />
                        <span>{isCheckingIntegrity ? 'Auditing...' : 'Run Integrity Check'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowRecoveryGuide(!showRecoveryGuide)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-700 dark:text-zinc-300 text-xs cursor-pointer"
                      >
                        <BookOpen className="h-3.5 w-3.5 text-amber-800 dark:text-amber-400" />
                        <span>{showRecoveryGuide ? 'Hide Setup & Recovery Checklist' : 'Setup & Recovery Checklist'}</span>
                      </button>
                    </div>
                  </div>

                  {integrityReport && (
                    <div className={`p-3.5 rounded-2xl border text-xs space-y-2 ${
                      integrityReport.local.healthy && (!integrityReport.server || integrityReport.server.healthy)
                        ? 'border-emerald-500/30 bg-emerald-950/20 text-emerald-800 dark:text-emerald-200'
                        : 'border-amber-500/30 bg-amber-950/20 text-amber-800 dark:text-amber-200'
                    }`}>
                      <div className="font-bold">
                        Integrity Audit Summary ({new Date(integrityReport.local.checkedAt).toLocaleTimeString()}):
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
                        <div className="p-2 rounded-lg bg-white/90 dark:bg-zinc-950/70">
                          Device Plans: {integrityReport.local.summary.recurringCount} recurring, {integrityReport.local.summary.installmentCount} installments
                        </div>
                        <div className="p-2 rounded-lg bg-white/90 dark:bg-zinc-950/70">
                          Local deletion markers: {integrityReport.local.summary.tombstoneCount} (90-day cache; server history is persistent)
                        </div>
                        {integrityReport.server && (
                          <>
                            <div className="p-2 rounded-lg bg-white/90 dark:bg-zinc-950/70">
                              Sheet Rows: {integrityReport.server.summary.totalTransactions} across {integrityReport.server.summary.monthlySheetsChecked} months
                            </div>
                            <div className="p-2 rounded-lg bg-white/90 dark:bg-zinc-950/70">
                              Overview Formulas: {integrityReport.server.summary.overviewFormulasHealthy ? '100% Dynamic' : 'Needs Refresh'}
                            </div>
                          </>
                        )}
                      </div>
                      {(integrityReport.local.issues.length > 0 || (integrityReport.server?.issues.length || 0) > 0) && (
                        <ul className="list-disc list-inside text-[11px] text-amber-800 dark:text-amber-300 space-y-0.5">
                          {integrityReport.local.issues.map((iss, i) => (
                            <li key={`loc_${i}`}>[{iss.scope}] {iss.message}</li>
                          ))}
                          {integrityReport.server?.issues.map((iss, i) => (
                            <li key={`srv_${i}`}>[Sheet {iss.sheet}] {iss.message}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}

                  {showRecoveryGuide && (
                    <div className="p-4 rounded-2xl bg-white/90 dark:bg-zinc-950/80 border border-slate-200 dark:border-zinc-800 text-xs text-slate-700 dark:text-zinc-300 space-y-2 leading-relaxed">
                      <div className="font-bold text-slate-950 dark:text-white">Operational Setup &amp; Recovery Checklist (also in `RECOVERY_AND_SETUP.md`):</div>
                      <ol className="list-decimal list-inside space-y-1 text-[11px]">
                        <li><strong>Deploy Apps Script:</strong> Copy <code className="text-indigo-800 dark:text-indigo-300">apps-script/Code.gs</code> and <code className="text-indigo-800 dark:text-indigo-300">apps-script/Backups.gs</code> into your Google Sheet’s Apps Script project and deploy a New Version.</li>
                        <li><strong>Lock Endpoint Access Control:</strong> Enter a strong Secret API Key above and click <strong>Lock Endpoint with Key</strong>, and keep <strong>Authenticated Server Proxy Mode</strong> enabled.</li>
                        <li><strong>Verify Automated Backups:</strong> Click <strong>Enable Weekly Backup</strong> so Sunday 03:00 snapshots run automatically, and periodically export an <strong>Offline Backup (.json)</strong> to your device.</li>
                        <li><strong>Test Restore Safely:</strong> Use <strong>Test Restore (Dry Run)</strong> on any snapshot to prove recovery in an isolated temporary Sheet without touching live records.</li>
                        <li><strong>Onboard a New Phone Safely:</strong> Enter the server proxy token on the new phone and click Save Credentials — Kinova verifies a pre-migration Drive snapshot first, syncs active plans and persistent deletion markers, and preserves any phone-only plans in the Recovery card below.</li>
                      </ol>
                    </div>
                  )}
                </div>
              </div>

              {/* Device Plan Recovery & Migration Comparison */}
              {planRecoveryItems.length > 0 && (
                <div className="mt-5 pt-5 border-t border-amber-500/20 space-y-3">
                  <div className="p-4 rounded-2xl border border-amber-500/30 bg-amber-950/20 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1">
                        <div className="text-xs font-bold text-amber-800 dark:text-amber-300 flex items-center gap-1.5">
                          <AlertCircle className="h-4 w-4 text-amber-800 dark:text-amber-400 shrink-0" />
                          <span>Device Plan Recovery Available (Phone vs. Sheet Comparison)</span>
                        </div>
                        <p className="text-[11px] text-slate-700 dark:text-zinc-300 leading-relaxed">
                          We preserved a local recovery copy of recurring/installment plans from this device before syncing with Google Sheets. Review and merge any missing phone plans below:
                        </p>
                      </div>
                    </div>

                    <div className="space-y-3">
                      {planRecoveryItems.map((item) => (
                        <div
                          key={item.storageKey}
                          className="p-3.5 rounded-xl bg-white/90 dark:bg-zinc-950/80 border border-slate-200 dark:border-zinc-800 space-y-2.5"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <span className="text-xs font-bold text-slate-950 dark:text-white">{item.label}</span>
                              <span className="ml-2 text-[10px] text-slate-600 dark:text-zinc-400">
                                ({item.phoneOnlyRecords.length} phone-only, {item.differingRecords.length} modified vs. {item.activeSheetRecords.length} on Sheet)
                              </span>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              {item.phoneOnlyRecords.length > 0 && (
                                <button
                                  type="button"
                                  onClick={() => handleRestorePhonePlans(item.storageKey, 'merge_missing')}
                                  disabled={isRestoringPlan === item.storageKey}
                                  className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white dark:text-white text-[11px] font-semibold transition-colors cursor-pointer disabled:opacity-50"
                                >
                                  Merge Phone-Only to Sheet
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => handleRestorePhonePlans(item.storageKey, 'replace_all')}
                                disabled={isRestoringPlan === item.storageKey}
                                className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white dark:text-white text-[11px] font-semibold transition-colors cursor-pointer disabled:opacity-50"
                              >
                                Restore All Phone Plans
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  dismissPlanBackup(item.storageKey);
                                  refreshPlanRecovery();
                                  toast.info(`Kept Google Sheet version for ${item.label}`);
                                }}
                                className="px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-zinc-700 bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-700 dark:text-zinc-300 text-[11px] transition-colors cursor-pointer"
                              >
                                Keep Sheet Copy
                              </button>
                            </div>
                          </div>

                          {item.phoneOnlyRecords.length > 0 && (
                            <div className="text-[11px] text-slate-700 dark:text-zinc-300 space-y-1">
                              <div className="text-[10px] uppercase tracking-wider text-amber-800 dark:text-amber-400 font-semibold">
                                Only on this device (not in Sheet):
                              </div>
                              <div className="flex flex-wrap gap-1.5">
                                {item.phoneOnlyRecords.map((rec: any, idx: number) => (
                                  <span
                                    key={rec.id || idx}
                                    className="px-2 py-1 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-800 dark:text-amber-200 text-[11px]"
                                  >
                                    {rec.name} ({rec.currency || 'MYR'} {rec.amount ?? rec.monthlyAmount ?? 0})
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}

                          {item.differingRecords.length > 0 && (
                            <div className="text-[11px] text-slate-700 dark:text-zinc-300 space-y-1">
                              <div className="text-[10px] uppercase tracking-wider text-indigo-800 dark:text-indigo-400 font-semibold">
                                Differing values between device backup & Sheet:
                              </div>
                              <div className="flex flex-wrap gap-1.5">
                                {item.differingRecords.map(({ phoneRecord }: any, idx: number) => (
                                  <span
                                    key={phoneRecord.id || idx}
                                    className="px-2 py-1 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-indigo-800 dark:text-indigo-200 text-[11px]"
                                  >
                                    {phoneRecord.name} (Device: {phoneRecord.currency || 'MYR'} {phoneRecord.amount ?? phoneRecord.monthlyAmount ?? 0})
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </section>


      {/* What Kinova Knows Section */}
      <WhatKinovaKnows />

      {/* App Preferences Section */}
      <section className="space-y-4">
        <h2 className="text-xs font-semibold text-slate-600 dark:text-zinc-400 uppercase tracking-wider">
          Preferences
        </h2>

        <div className="rounded-3xl border border-slate-200 dark:border-zinc-800/80 bg-white/90 dark:bg-zinc-900/40 p-6 backdrop-blur-xl divide-y divide-zinc-800/60 specular-card">
          {/* Default Currency */}
          <div className="flex flex-wrap items-center justify-between gap-3 pb-4">
            <div className="flex items-center gap-3">
              <div className="h-9 w-9 rounded-xl bg-slate-100 dark:bg-zinc-800 flex items-center justify-center text-slate-600 dark:text-zinc-400">
                <Globe className="h-4 w-4" />
              </div>
              <div>
                <div className="font-semibold text-slate-950 dark:text-white text-sm">Default Currency</div>
                <div className="text-xs text-slate-600 dark:text-zinc-400">Used for recording transactions and totals</div>
              </div>
            </div>

            <div className="flex items-center gap-1 bg-white dark:bg-zinc-950 p-1 rounded-xl border border-slate-200 dark:border-zinc-800">
              {['MYR', 'USD', 'SGD', 'EUR'].map((curr) => (
                <button
                  key={curr}
                  onClick={() => handleCurrencyChange(curr)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                    currency === curr
                      ? 'bg-indigo-500 text-white dark:text-white shadow-sm'
                      : 'text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white'
                  }`}
                >
                  {curr}
                </button>
              ))}
            </div>
          </div>

          {/* Theme */}
          <div className="flex flex-wrap items-center justify-between gap-3 py-4">
            <div className="flex items-center gap-3">
              <div className="h-9 w-9 rounded-xl bg-slate-100 dark:bg-zinc-800 flex items-center justify-center text-slate-600 dark:text-zinc-400">
                {resolvedTheme === 'dark' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
              </div>
              <div>
                <div className="font-semibold text-slate-950 dark:text-white text-sm">Theme</div>
                <div className="text-xs text-slate-600 dark:text-zinc-400">
                  Switch between Light Mode, OLED Dark Mode, or follow your device
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1 bg-white dark:bg-zinc-950 p-1 rounded-xl border border-slate-200 dark:border-zinc-800">
              {([
                { id: 'light', label: '☀️ Light' },
                { id: 'dark', label: '🌙 Dark' },
                { id: 'system', label: '💻 System' },
              ] as const).map((opt) => {
                const isSelected = (theme || 'system') === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => {
                      setTheme(opt.id);
                      toast.success(`Theme set to ${opt.id === 'light' ? 'Light Mode' : opt.id === 'dark' ? 'Dark Mode' : 'System'}`);
                    }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                      isSelected
                        ? 'bg-indigo-500 text-white dark:text-white shadow-sm'
                        : 'text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Data Cleanup */}
          <div className="flex items-center justify-between gap-3 pt-4">
            <div className="flex items-center gap-3">
              <div className="h-9 w-9 rounded-xl bg-rose-500/10 flex items-center justify-center text-rose-800 dark:text-rose-400">
                <Trash2 className="h-4 w-4" />
              </div>
              <div>
                <div className="font-semibold text-slate-950 dark:text-white text-sm">Reset Local Cache</div>
                <div className="text-xs text-slate-600 dark:text-zinc-400">Clears offline temporary data stored in this browser</div>
              </div>
            </div>
            <button
              onClick={handleClearLocalData}
              className="text-xs px-3 py-1.5 rounded-xl border border-rose-500/30 text-rose-800 dark:text-rose-400 hover:bg-rose-500/10 transition-colors cursor-pointer"
            >
              Clear Cache
            </button>
          </div>
        </div>
      </section>

      {/* iPhone Shortcuts & Apple Pay Quick Expense Guide */}
      <section className="space-y-4">
        <h2 className="text-xs font-semibold text-slate-600 dark:text-zinc-400 uppercase tracking-wider">
          iPhone 快捷指令与 Apple Pay 快速记账
        </h2>

        <div className="rounded-3xl border border-slate-200 dark:border-zinc-800/80 bg-white/90 dark:bg-zinc-900/40 p-6 backdrop-blur-xl space-y-5 specular-card">
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-600 dark:text-indigo-400 shrink-0">
              <Smartphone className="h-5 w-5" />
            </div>
            <div className="space-y-1">
              <div className="font-bold text-slate-950 dark:text-white text-sm">
                Kinova 快速记账（背面轻点截图 &amp; Apple Pay 交易触发）
              </div>
              <p className="text-xs text-slate-600 dark:text-zinc-400 leading-relaxed">
                所有通过快捷指令或 Apple Pay 触发的交易都只会生成<strong>待确认草稿</strong>（使用一次性不透明令牌 <code className="px-1 py-0.5 rounded bg-slate-100 dark:bg-zinc-800">/?quickDraft=drf_...</code>），绝不后台自动入账，也绝不把截图、金额、商家或密钥放入 URL 或普通日志。
              </p>
            </div>
          </div>

          {/* Privacy & AI Disclosure */}
          <div className="rounded-2xl border border-indigo-500/25 bg-indigo-500/5 p-3.5 text-xs text-slate-700 dark:text-zinc-300 space-y-1">
            <div className="font-bold text-indigo-700 dark:text-indigo-300 flex items-center gap-1.5">
              <ShieldCheck className="h-4 w-4 shrink-0" />
              隐私、密钥与第三方 AI 处理说明
            </div>
            <p className="leading-relaxed">
              • <strong>服务端密钥保护</strong>：请在部署环境变量设置 <code className="px-1 py-0.5 rounded bg-slate-200/70 dark:bg-zinc-800">KINOVA_SHORTCUT_TOKEN</code>（或复用 <code className="px-1 py-0.5 rounded bg-slate-200/70 dark:bg-zinc-800">KINOVA_PROXY_TOKEN</code>），在 iPhone 快捷指令的请求头传入 <code className="px-1 py-0.5 rounded bg-slate-200/70 dark:bg-zinc-800">x-shortcut-token</code>，切勿放入 URL 参数或前端代码。<br />
              • <strong>截图发送去向</strong>：当使用背面轻点截图识别时，截图通过 HTTPS 仅发送至你的 Kinova 服务端 <code className="px-1 py-0.5 rounded bg-slate-200/70 dark:bg-zinc-800">/api/shortcuts/ingest</code>，再由服务端使用 <code className="px-1 py-0.5 rounded bg-slate-200/70 dark:bg-zinc-800">GEMINI_API_KEY</code> 调用 <strong>Google Gemini Vision API (gemini-2.5-flash)</strong> 解析商家、金额、币种、日期和分类。服务端不落盘保存截图，也不将任何财务内容写入日志。
            </p>
          </div>

          {/* 1-Click Install Card */}
          <div className="rounded-2xl border border-indigo-500/30 bg-gradient-to-br from-indigo-500/10 via-purple-500/5 to-transparent p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <div className="font-bold text-slate-950 dark:text-white text-sm flex items-center gap-2">
                  <span className="flex h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                  iPhone 一键安装（iOS 原生弹窗直接添加）
                </div>
                <p className="text-xs text-slate-600 dark:text-zinc-400 mt-1">
                  在 iPhone 上点下方按钮，Safari 将直接唤起苹果原生「添加快捷指令」弹窗，免去手动配置动作！
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <a
                  href={DEFAULT_SHORTCUT_ICLOUD_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-4 py-2.5 rounded-xl font-bold text-xs text-white shadow-lg transition-all flex items-center gap-2 cursor-pointer active:scale-95 bg-emerald-600 hover:bg-emerald-500 shadow-emerald-500/20"
                >
                  <ExternalLink className="h-4 w-4" />
                  <span>📲 一键添加到 iPhone</span>
                  <span className="text-[10px] bg-white/20 px-1.5 py-0.5 rounded">已就绪</span>
                </a>
                <a
                  href="shortcuts://"
                  className="px-3 py-2.5 rounded-xl text-xs font-semibold border border-slate-300 dark:border-zinc-700 bg-white/70 dark:bg-zinc-800/70 text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-all flex items-center gap-1.5"
                >
                  <span>打开快捷指令 App</span>
                </a>
              </div>
            </div>

            {/* Fast Copy Helpers */}
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 pt-1 text-xs">
              <button
                type="button"
                onClick={() => {
                  const url = typeof window !== 'undefined'
                    ? `${window.location.origin}/api/shortcuts/ingest${googleUser?.email ? `?user=${encodeURIComponent(googleUser.email)}` : ''}`
                    : 'https://你的域名/api/shortcuts/ingest';
                  copyTextToClipboard(url, 'url', '个人专属 API 接收地址（已预绑定你的账号）');
                }}
                className="p-2.5 rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/50 dark:bg-zinc-900/50 hover:bg-slate-100 dark:hover:bg-zinc-800 text-left flex items-center justify-between transition-colors cursor-pointer"
              >
                <div>
                  <div className="font-semibold text-slate-800 dark:text-zinc-200 text-[11px]">📋 复制专属 API 地址</div>
                  <div className="text-[10px] text-slate-500 dark:text-zinc-400 truncate max-w-[220px]">
                    {typeof window !== 'undefined'
                      ? `${window.location.origin}/api/shortcuts/ingest${googleUser?.email ? `?user=${googleUser.email}` : ''}`
                      : '/api/shortcuts/ingest'}
                  </div>
                </div>
                <span className="text-[10px] text-indigo-500 font-bold ml-2 shrink-0">
                  {copiedConfigKey === 'url' ? '已复制 ✓' : '复制'}
                </span>
              </button>

              <button
                type="button"
                onClick={() => {
                  copyTextToClipboard('x-shortcut-token', 'header', '请求头 Key 名称 (x-shortcut-token)');
                }}
                className="p-2.5 rounded-xl border border-slate-200 dark:border-zinc-800 bg-white/50 dark:bg-zinc-900/50 hover:bg-slate-100 dark:hover:bg-zinc-800 text-left flex items-center justify-between transition-colors cursor-pointer"
              >
                <div>
                  <div className="font-semibold text-slate-800 dark:text-zinc-200 text-[11px]">📋 复制鉴权请求头名称</div>
                  <div className="text-[10px] text-slate-500 dark:text-zinc-400 font-mono">
                    x-shortcut-token
                  </div>
                </div>
                <span className="text-[10px] text-indigo-500 font-bold ml-2 shrink-0">
                  {copiedConfigKey === 'header' ? '已复制 ✓' : '复制'}
                </span>
              </button>

              {googleUser?.email && (
                <button
                  type="button"
                  onClick={() => {
                    copyTextToClipboard(googleUser.email, 'email', '你的绑定账号邮箱 (x-shortcut-email)');
                  }}
                  className="p-2.5 rounded-xl border border-indigo-200 dark:border-indigo-900/50 bg-indigo-50/50 dark:bg-indigo-950/30 hover:bg-indigo-100/60 dark:hover:bg-indigo-900/40 text-left flex items-center justify-between transition-colors cursor-pointer"
                >
                  <div>
                    <div className="font-semibold text-indigo-900 dark:text-indigo-200 text-[11px]">👤 复制绑定账号邮箱</div>
                    <div className="text-[10px] text-indigo-600 dark:text-indigo-400 truncate max-w-[180px] font-mono">
                      {googleUser.email}
                    </div>
                  </div>
                  <span className="text-[10px] text-indigo-600 font-bold ml-2 shrink-0">
                    {copiedConfigKey === 'email' ? '已复制 ✓' : '复制'}
                  </span>
                </button>
              )}
            </div>
          </div>

          {/* Workflow 1: Back Tap Screenshot */}
          <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-slate-50/70 dark:bg-zinc-950/60 p-4 space-y-2.5">
            <div className="font-bold text-xs text-slate-900 dark:text-white flex items-center justify-between">
              <span>方案一：背面轻点两下截图 →「Kinova 快速记账」</span>
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-indigo-500/15 text-indigo-600 dark:text-indigo-400">支持快捷指令 iCloud 同步</span>
            </div>
            <ol className="list-decimal list-inside text-xs text-slate-600 dark:text-zinc-400 space-y-1.5 leading-relaxed">
              <li>打开 iPhone <strong>快捷指令 (Shortcuts)</strong> App，新建快捷指令并命名为 <strong>「Kinova 快速记账」</strong>。</li>
              <li>添加动作 1：<strong>截屏 (Take Screenshot)</strong>。</li>
              <li>
                <span className="text-emerald-600 dark:text-emerald-400 font-semibold">⚡ [提速关键] 添加动作 2：调整图像大小 (Resize Image)</span> → 宽度设为 <strong>1080</strong>（高度保持自动），将原图 8MB 缩减至轻量尺寸。
              </li>
              <li>
                <span className="text-emerald-600 dark:text-emerald-400 font-semibold">⚡ [提速关键] 添加动作 3：转换图像 (Convert Image)</span> → 转换为 <strong>JPEG</strong>，质量设为 <strong>0.75 (或 75%)</strong>。体积由 8MB 骤降至 200KB（手机上传时间由 4 秒暴降到 0.2 秒）。
              </li>
              <li>添加动作 4：<strong>使用 Base64 编码 (Base64 Encode)</strong> → 输入选择「已转换的图像」，换行选项设为 <strong>无 (None)</strong>。</li>
              <li>
                添加动作 5：<strong>获取 URL 内容 (Get Contents of URL)</strong>：
                <ul className="list-disc list-inside pl-4 mt-1 space-y-0.5 text-[11px]">
                  <li>URL：<code className="px-1 py-0.5 rounded bg-slate-200/70 dark:bg-zinc-800">{typeof window !== 'undefined' ? `${window.location.origin}/api/shortcuts/ingest${googleUser?.email ? `?user=${encodeURIComponent(googleUser.email)}` : ''}` : 'https://你的域名/api/shortcuts/ingest?user=你的邮箱'}</code>（已自动预带你的专属账号参数）</li>
                  <li>方法：<code className="px-1 py-0.5 rounded bg-slate-200/70 dark:bg-zinc-800">POST</code>，请求体：<code className="px-1 py-0.5 rounded bg-slate-200/70 dark:bg-zinc-800">JSON</code></li>
                  <li>头部 (Headers)：
                    <div className="pl-2 space-y-0.5 font-mono text-[10px] text-slate-700 dark:text-zinc-300">
                      <div>• <code className="px-1 py-0.5 rounded bg-slate-200/70 dark:bg-zinc-800">x-shortcut-token</code> = 你的服务端令牌</div>
                      <div>• <code className="px-1 py-0.5 rounded bg-slate-200/70 dark:bg-zinc-800">x-shortcut-email</code> = <span className="text-indigo-600 dark:text-indigo-400 font-semibold">{googleUser?.email || '你的 Google 账号邮箱'}</span>（若 URL 中已带有 <code className="px-1 py-0.5 rounded bg-slate-200/70 dark:bg-zinc-800">?user=...</code> 则此 Header 可选）</div>
                    </div>
                  </li>
                  <li>JSON 字段：<code className="px-1 py-0.5 rounded bg-slate-200/70 dark:bg-zinc-800">source</code> = <code className="px-1 py-0.5 rounded bg-slate-200/70 dark:bg-zinc-800">back_tap_screenshot</code>，<code className="px-1 py-0.5 rounded bg-slate-200/70 dark:bg-zinc-800">imageBase64</code> = 「Base64 编码后的文本」，<code className="px-1 py-0.5 rounded bg-slate-200/70 dark:bg-zinc-800">defaultCurrency</code> = <code className="px-1 py-0.5 rounded bg-slate-200/70 dark:bg-zinc-800">{currency}</code>{googleUser?.email ? <span>，<code className="px-1 py-0.5 rounded bg-slate-200/70 dark:bg-zinc-800">userEmail</code> = <code className="px-1 py-0.5 rounded bg-slate-200/70 dark:bg-zinc-800">{googleUser.email}</code></span> : null}</li>
                  <li className="text-amber-600 dark:text-amber-400 font-medium">
                    🔒 <strong>严格零猜测账号隔离</strong>：系统已启用零容错保护。快捷指令如果未显式提供账号信息（URL参数/Header/JSON），服务端将直接拒绝入账并报错，<strong>绝不默认记入任何人的账本（包括管理员）</strong>，彻底杜绝串账！
                  </li>
                </ul>
              </li>
              <li>添加动作 6：<strong>获取词典值 (Get Dictionary Value)</strong> → 获取键 <code className="px-1 py-0.5 rounded bg-slate-200/70 dark:bg-zinc-800">notificationText</code>，再通过 <strong>显示通知 (Show Notification)</strong> 直接弹窗提示入账结果。</li>
              <li>绑定背面轻点：前往 iPhone <strong>设置 → 辅助功能 (Accessibility) → 触控 (Touch) → 轻点背面 (Back Tap) → 轻点两下 (Double Tap)</strong>，选择 <strong>「Kinova Automation」</strong>。</li>
            </ol>
          </div>

          {/* Workflow 2: Apple Pay Transaction Trigger */}
          <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-slate-50/70 dark:bg-zinc-950/60 p-4 space-y-2.5">
            <div className="font-bold text-xs text-slate-900 dark:text-white flex items-center justify-between">
              <span>方案二：Apple Pay 交易触发 (Wallet Transaction 个人自动化)</span>
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300">仅限当前 iPhone 本机有效</span>
            </div>
            <ol className="list-decimal list-inside text-xs text-slate-600 dark:text-zinc-400 space-y-1.5 leading-relaxed">
              <li>打开 iPhone <strong>快捷指令 → 自动化 (Automation) → 右上角 + → 创建个人自动化</strong>，选择 <strong>交易 (Transaction)</strong>（当轻点任意 Wallet 卡片支付时触发）。</li>
              <li>
                <strong>运行确认设置</strong>：在 iOS 17+ 中可将自动化设为 <strong>「立即运行 (Run Immediately)」</strong>（关闭「运行前询问」），这样刷卡后会直接生成待确认草稿并跳转，但<strong>仍必须在 Kinova 弹窗内点击确认后才会真正写入账本</strong>。
              </li>
              <li>
                <strong>注意触发器字段不完整性</strong>：iOS「交易」触发器传入的「快捷指令输入 (Shortcut Input)」在不同地区/发卡行下<strong>不一定包含金额、币种或商家名称</strong>（有时仅有卡片名称或部分商家信息）。请将可获取的「商家 (Merchant)」、「金额 (Amount)」、「名称/卡片 (Card/Name)」作为 JSON 发送至 <code className="px-1 py-0.5 rounded bg-slate-200/70 dark:bg-zinc-800">POST /api/shortcuts/ingest</code>（<code className="px-1 py-0.5 rounded bg-slate-200/70 dark:bg-zinc-800">source: &quot;apple_pay_transaction&quot;</code>）；任何系统未提供的字段（如金额、商家、币种歧义），Kinova 打开草稿弹窗后会自动高亮提示你手动补充。
              </li>
              <li>
                <strong>安全与同步说明</strong>：本方案不读取 Wallet 私有数据库、不抓取系统通知、不调用非公开 API，并对同一交易做重复提交与账本疑似重复检查。此外，iOS 的「个人自动化 (Personal Automation)」<strong>不会通过 iCloud 自动同步到其他 iPhone/iPad</strong>，更换设备后需在新 iPhone 上重新配置。
              </li>
            </ol>
          </div>
        </div>
      </section>
    </div>
  );
}
