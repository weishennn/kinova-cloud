const CASHFLOW_BACKUP_FOLDER = 'CashFlow Backups';
const CASHFLOW_BACKUP_LAST_AT = 'CASHFLOW_LAST_BACKUP_AT';
const CASHFLOW_BACKUP_LAST_FILE = 'CASHFLOW_LAST_BACKUP_FILE';
const CASHFLOW_BACKUP_LAST_NAME = 'CASHFLOW_LAST_BACKUP_NAME';

const RETENTION_WEEKLY_LIMIT = 12;
const RETENTION_MIGRATION_LIMIT = 10;
const STALE_BACKUP_THRESHOLD_MS = 8 * 24 * 60 * 60 * 1000; // 8 days

/** Installs or refreshes the weekly Sunday 03:00 snapshot trigger. */
function installCashFlowWeeklyBackup() {
  ScriptApp.getProjectTriggers()
    .filter(function(trigger) { return trigger.getHandlerFunction() === 'createCashFlowBackup'; })
    .forEach(function(trigger) { ScriptApp.deleteTrigger(trigger); });
  ScriptApp.newTrigger('createCashFlowBackup')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY)
    .atHour(3)
    .inTimezone('Asia/Kuala_Lumpur')
    .create();
  return Object.assign(
    { installed: true, cadence: 'weekly', timezone: 'Asia/Kuala_Lumpur' },
    getCashFlowBackupStatus()
  );
}

/** Ensures the weekly trigger is active and creates a verified backup if missing or stale. */
function ensureCashFlowWeeklyBackup() {
  const status = getCashFlowBackupStatus();
  if (!status.triggerInstalled) {
    installCashFlowWeeklyBackup();
  }
  if (!status.lastBackupFileId || !status.lastBackupVerified || status.lastBackupStale) {
    createCashFlowBackup();
  }
  return getCashFlowBackupStatus();
}

/** Creates one immutable spreadsheet copy per calendar week; never edits the source. */
function createCashFlowBackup() {
  const spreadsheet = getSpreadsheet();
  const folder = getOrCreateCashFlowBackupFolder();
  const week = Utilities.formatDate(new Date(), 'Asia/Kuala_Lumpur', "yyyy-'W'ww");
  const name = 'CashFlow Backup ' + week;
  const existing = folder.getFilesByName(name);
  if (existing.hasNext()) {
    const file = existing.next();
    const recorded = recordBackupStatus(file);
    pruneCashFlowBackups();
    return recorded;
  }

  const source = DriveApp.getFileById(spreadsheet.getId());
  const copy = source.makeCopy(name, folder);
  const recorded = recordBackupStatus(copy);
  pruneCashFlowBackups();
  return recorded;
}

/** Creates an on-demand, dated source copy before a migration, restore, or manual snapshot. */
function createCashFlowMigrationBackup() {
  const spreadsheet = getSpreadsheet();
  const folder = getOrCreateCashFlowBackupFolder();
  const stamp = Utilities.formatDate(new Date(), 'Asia/Kuala_Lumpur', 'yyyy-MM-dd HHmmss');
  const copy = DriveApp.getFileById(spreadsheet.getId()).makeCopy('CashFlow Migration Backup ' + stamp, folder);
  const recorded = recordBackupStatus(copy);
  pruneCashFlowBackups();
  return recorded;
}

/**
 * Deeply verifies that a backup file exists in Drive, opens as a valid Spreadsheet,
 * and contains expected core tabs and non-empty headers.
 */
function verifyCashFlowBackup(fileId) {
  if (!fileId) return { exists: false, verified: false };
  try {
    const file = DriveApp.getFileById(String(fileId));
    if (file.isTrashed()) return { exists: false, verified: false };
    let inBackupFolder = false;
    const parents = file.getParents();
    while (parents.hasNext()) {
      if (parents.next().getName() === CASHFLOW_BACKUP_FOLDER && /^CashFlow (Migration )?Backup /.test(file.getName())) {
        inBackupFolder = true;
        break;
      }
    }
    if (!inBackupFolder) return { exists: false, verified: false };

    // Open the backup spreadsheet and inspect its sheets, headers, and row counts
    const backupSs = SpreadsheetApp.openById(String(fileId));
    const sheets = backupSs.getSheets();
    if (!sheets || sheets.length === 0) {
      return { exists: true, verified: false, name: file.getName(), reason: 'Backup contains 0 sheets' };
    }

    let totalRows = 0;
    let hasOverview = false;
    let hasSettings = false;
    let validHeaders = true;

    for (let i = 0; i < sheets.length; i++) {
      const sh = sheets[i];
      const shName = sh.getName();
      const rows = sh.getLastRow();
      totalRows += rows;
      if (shName === 'Overview') hasOverview = true;
      if (shName === 'Settings') hasSettings = true;
      if (rows > 0 && sh.getLastColumn() === 0) {
        validHeaders = false;
      }
    }

    const createdDate = file.getDateCreated();
    const ageMs = Date.now() - createdDate.getTime();
    const isVerified = validHeaders && sheets.length > 0 && (hasOverview || hasSettings || totalRows > 0);

    return {
      exists: true,
      verified: isVerified,
      fileId: file.getId(),
      name: file.getName(),
      createdAt: createdDate.toISOString(),
      ageHours: Math.round(ageMs / (1000 * 60 * 60)),
      stale: ageMs > STALE_BACKUP_THRESHOLD_MS,
      sheetCount: sheets.length,
      totalRows: totalRows,
      hasOverview: hasOverview,
      hasSettings: hasSettings,
    };
  } catch (e) {
    return { exists: false, verified: false, error: e.message || String(e) };
  }
}

function getCashFlowBackupStatus() {
  const props = PropertiesService.getScriptProperties();
  let triggerInstalled = false;
  try {
    triggerInstalled = ScriptApp.getProjectTriggers()
      .some(function(trigger) { return trigger.getHandlerFunction() === 'createCashFlowBackup'; });
  } catch (e) {}

  const lastBackupFileId = props.getProperty(CASHFLOW_BACKUP_LAST_FILE) || null;
  let lastBackupName = props.getProperty(CASHFLOW_BACKUP_LAST_NAME) || null;
  let lastBackupAt = props.getProperty(CASHFLOW_BACKUP_LAST_AT) || null;
  let lastBackupVerified = false;
  let lastBackupStale = false;
  let sheetCount = 0;
  let totalRows = 0;

  if (lastBackupFileId) {
    let usedCachedMeta = false;
    try {
      const rawMeta = props.getProperty('CASHFLOW_LAST_BACKUP_META');
      if (rawMeta) {
        const meta = JSON.parse(rawMeta);
        if (meta && meta.fileId === lastBackupFileId && meta.verified) {
          const file = DriveApp.getFileById(String(lastBackupFileId));
          if (!file.isTrashed()) {
            const createdDate = file.getDateCreated();
            const ageMs = Date.now() - createdDate.getTime();
            lastBackupVerified = true;
            lastBackupName = file.getName() || meta.name || lastBackupName;
            lastBackupAt = createdDate.toISOString();
            lastBackupStale = ageMs > STALE_BACKUP_THRESHOLD_MS;
            sheetCount = Number(meta.sheetCount) || 0;
            totalRows = Number(meta.totalRows) || 0;
            usedCachedMeta = true;
          }
        }
      }
    } catch (e) {}

    if (!usedCachedMeta) {
      const check = verifyCashFlowBackup(lastBackupFileId);
      if (check && check.exists) {
        lastBackupVerified = Boolean(check.verified);
        lastBackupName = check.name || lastBackupName;
        lastBackupAt = check.createdAt || lastBackupAt;
        lastBackupStale = Boolean(check.stale);
        sheetCount = check.sheetCount || 0;
        totalRows = check.totalRows || 0;
        if (lastBackupVerified) {
          props.setProperty('CASHFLOW_LAST_BACKUP_META', JSON.stringify({
            fileId: lastBackupFileId,
            verified: true,
            name: lastBackupName,
            createdAt: lastBackupAt,
            sheetCount: sheetCount,
            totalRows: totalRows,
          }));
        }
      }
    }
  } else if (lastBackupAt) {
    const ageMs = Date.now() - new Date(lastBackupAt).getTime();
    lastBackupStale = ageMs > STALE_BACKUP_THRESHOLD_MS;
  }

  let backupHealth = 'missing';
  if (lastBackupFileId) {
    if (!lastBackupVerified) {
      backupHealth = 'unverified';
    } else if (lastBackupStale || !triggerInstalled) {
      backupHealth = 'stale';
    } else {
      backupHealth = 'healthy';
    }
  }

  return {
    triggerInstalled: triggerInstalled,
    lastBackupAt: lastBackupAt,
    lastBackupFileId: lastBackupFileId,
    lastBackupName: lastBackupName,
    lastBackupVerified: lastBackupVerified,
    lastBackupStale: lastBackupStale,
    sheetCount: sheetCount,
    totalRows: totalRows,
    backupHealth: backupHealth,
    retentionPolicy: {
      weeklyKeep: RETENTION_WEEKLY_LIMIT,
      migrationKeep: RETENTION_MIGRATION_LIMIT,
      maxWeekly: RETENTION_WEEKLY_LIMIT,
      maxMigration: RETENTION_MIGRATION_LIMIT,
    },
  };
}

function getOrCreateCashFlowBackupFolder() {
  const folders = DriveApp.getFoldersByName(CASHFLOW_BACKUP_FOLDER);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(CASHFLOW_BACKUP_FOLDER);
}

function recordBackupStatus(file) {
  const props = PropertiesService.getScriptProperties();
  const createdIso = file.getDateCreated().toISOString();
  props.setProperty(CASHFLOW_BACKUP_LAST_AT, createdIso);
  props.setProperty(CASHFLOW_BACKUP_LAST_FILE, file.getId());
  props.setProperty(CASHFLOW_BACKUP_LAST_NAME, file.getName());
  const verification = verifyCashFlowBackup(file.getId());
  if (verification && verification.verified) {
    props.setProperty('CASHFLOW_LAST_BACKUP_META', JSON.stringify({
      fileId: file.getId(),
      verified: true,
      name: file.getName(),
      createdAt: createdIso,
      sheetCount: verification.sheetCount || 0,
      totalRows: verification.totalRows || 0,
    }));
  }
  let triggerInstalled = false;
  try {
    triggerInstalled = ScriptApp.getProjectTriggers()
      .some(function(trigger) { return trigger.getHandlerFunction() === 'createCashFlowBackup'; });
  } catch (e) {}
  return {
    created: Boolean(verification && verification.exists && verification.verified),
    verified: Boolean(verification && verification.verified),
    fileId: file.getId(),
    name: file.getName(),
    createdAt: createdIso,
    sheetCount: verification ? verification.sheetCount : 0,
    totalRows: verification ? verification.totalRows : 0,
    triggerInstalled: triggerInstalled,
  };
}

/**
 * Enforces backup retention policy:
 * Keeps latest 12 weekly backups and 10 migration/safety snapshots.
 * Never prunes unless at least 2 newest backups exist.
 */
function pruneCashFlowBackups() {
  try {
    const folder = getOrCreateCashFlowBackupFolder();
    const files = folder.getFiles();
    const weekly = [];
    const migration = [];

    while (files.hasNext()) {
      const file = files.next();
      if (file.isTrashed()) continue;
      const name = file.getName();
      const item = { file: file, createdAt: file.getDateCreated().getTime() };
      if (/^CashFlow Backup /.test(name)) {
        weekly.push(item);
      } else if (/^CashFlow Migration Backup /.test(name)) {
        migration.push(item);
      }
    }

    weekly.sort(function(a, b) { return b.createdAt - a.createdAt; });
    migration.sort(function(a, b) { return b.createdAt - a.createdAt; });

    let prunedCount = 0;
    if (weekly.length > RETENTION_WEEKLY_LIMIT && weekly.length >= 2) {
      weekly.slice(RETENTION_WEEKLY_LIMIT).forEach(function(entry) {
        entry.file.setTrashed(true);
        prunedCount++;
      });
    }
    if (migration.length > RETENTION_MIGRATION_LIMIT && migration.length >= 2) {
      migration.slice(RETENTION_MIGRATION_LIMIT).forEach(function(entry) {
        entry.file.setTrashed(true);
        prunedCount++;
      });
    }
    return { prunedCount: prunedCount };
  } catch (e) {
    console.warn('Backup retention prune notice:', e);
    return { prunedCount: 0 };
  }
}

/** Lists up to 15 recent backup snapshots in the CashFlow Backups Drive folder. */
function listCashFlowBackups() {
  const folder = getOrCreateCashFlowBackupFolder();
  const files = folder.getFiles();
  const list = [];
  while (files.hasNext()) {
    const file = files.next();
    if (file.isTrashed()) continue;
    const name = file.getName();
    if (!/^CashFlow (Migration )?Backup /.test(name)) continue;
    const isMigration = /^CashFlow Migration Backup /.test(name);
    list.push({
      id: file.getId(),
      name: name,
      createdAt: file.getDateCreated().toISOString(),
      url: file.getUrl(),
      type: isMigration ? 'safety' : 'weekly',
      kind: isMigration ? 'migration_or_safety' : 'scheduled_weekly',
    });
  }
  list.sort(function(a, b) {
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
  return list.slice(0, 15);
}

/**
 * Safely restores a backup spreadsheet into the active CashFlow spreadsheet using
 * a two-phase staged copy with automatic rollback if any validation fails.
 */
function restoreCashFlowBackup(fileId) {
  if (!fileId) {
    throw new Error('Backup fileId is required for restore.');
  }

  // 1. Deep-verify source backup before doing anything
  const sourceCheck = verifyCashFlowBackup(fileId);
  if (!sourceCheck || !sourceCheck.exists || !sourceCheck.verified) {
    throw new Error('Selected backup failed integrity verification and cannot be restored.');
  }

  // 2. Create and deep-verify a safety snapshot of the current live spreadsheet first
  const safetySnapshot = createCashFlowMigrationBackup();
  if (!safetySnapshot || !safetySnapshot.created || !safetySnapshot.verified) {
    throw new Error('Could not verify pre-restore safety snapshot. Restore aborted to protect live data.');
  }

  const targetSs = getSpreadsheet();
  const sourceSs = SpreadsheetApp.openById(String(fileId));
  const sourceSheets = sourceSs.getSheets();
  if (!sourceSheets || sourceSheets.length === 0) {
    throw new Error('Selected backup spreadsheet contains no sheets.');
  }

  const existingSheets = targetSs.getSheets();
  const restoreStamp = new Date().getTime();
  const stagePrefix = '__STAGE_' + restoreStamp + '_';
  const oldPrefix = '__OLD_' + restoreStamp + '_';
  const stagedEntries = [];

  try {
    // 3. Stage all sheets from backup under temporary names while keeping original tabs untouched
    for (let i = 0; i < sourceSheets.length; i++) {
      const srcSheet = sourceSheets[i];
      const targetName = srcSheet.getName();
      const expectedRows = srcSheet.getLastRow();
      const expectedCols = srcSheet.getLastColumn();
      const expectedHeaders = (expectedRows > 0 && expectedCols > 0)
        ? srcSheet.getRange(1, 1, 1, expectedCols).getValues()[0].map(function(h) { return String(h).trim(); })
        : [];
      const idColumnIndex = expectedHeaders.findIndex(function(h) { return h.toLowerCase() === 'id'; });
      const expectedIds = idColumnIndex >= 0 && expectedRows > 1
        ? srcSheet.getRange(2, idColumnIndex + 1, expectedRows - 1, 1).getDisplayValues().map(function(r) { return String(r[0]).trim(); })
        : null;
      const expectedOverviewFormulas = targetName === 'Overview' && expectedRows > 0 && expectedCols > 0
        ? srcSheet.getDataRange().getFormulas()
        : null;

      const copied = srcSheet.copyTo(targetSs);
      const stageName = stagePrefix + i;
      stagedEntries.push({
        stagedSheet: copied,
        stageName: stageName,
        targetName: targetName,
        expectedRows: expectedRows,
        expectedCols: expectedCols,
        expectedHeaders: expectedHeaders,
        expectedIds: expectedIds,
        expectedOverviewFormulas: expectedOverviewFormulas,
      });
      copied.setName(stageName);
    }

    SpreadsheetApp.flush();

    // 4. Verify every staged sheet's row count and headers before replacing any active tab
    if (stagedEntries.length !== sourceSheets.length) {
      throw new Error('Staged sheet count mismatch (' + stagedEntries.length + ' vs ' + sourceSheets.length + ').');
    }

    for (let i = 0; i < stagedEntries.length; i++) {
      const entry = stagedEntries[i];
      const stSheet = entry.stagedSheet;
      const actualRows = stSheet.getLastRow();
      if (actualRows !== entry.expectedRows) {
        throw new Error('Row count mismatch in staged tab "' + entry.targetName + '" (expected ' + entry.expectedRows + ', got ' + actualRows + ').');
      }
      if (entry.expectedHeaders.length > 0) {
        const actualHeaders = stSheet.getRange(1, 1, 1, entry.expectedCols).getValues()[0].map(function(h) { return String(h).trim(); });
        if (JSON.stringify(actualHeaders) !== JSON.stringify(entry.expectedHeaders)) {
          throw new Error('Header mismatch in staged tab "' + entry.targetName + '".');
        }
      }
      if (entry.expectedIds) {
        const actualIds = stSheet.getRange(2, entry.expectedHeaders.findIndex(function(h) { return h.toLowerCase() === 'id'; }) + 1, Math.max(1, actualRows - 1), 1)
          .getDisplayValues().slice(0, Math.max(0, actualRows - 1)).map(function(r) { return String(r[0]).trim(); });
        if (JSON.stringify(actualIds) !== JSON.stringify(entry.expectedIds)) {
          throw new Error('Stable ID mismatch in staged tab "' + entry.targetName + '".');
        }
      }
      if (entry.expectedOverviewFormulas && JSON.stringify(stSheet.getDataRange().getFormulas()) !== JSON.stringify(entry.expectedOverviewFormulas)) {
        throw new Error('Overview formula mismatch in staged tab.');
      }
    }
  } catch (stageErr) {
    // Roll back: delete any staged tabs and leave original tabs completely untouched!
    stagedEntries.forEach(function(entry) {
      try {
        targetSs.deleteSheet(entry.stagedSheet);
      } catch (e) {}
    });
    SpreadsheetApp.flush();
    throw new Error('Restore failed validation and was safely rolled back without modifying live data: ' + (stageErr.message || String(stageErr)));
  }

  // 5. Commit swap: rename original tabs to __OLD_, rename __STAGE_ tabs to canonical names, then delete __OLD_
  const renamedOriginals = [];
  try {
    for (let i = 0; i < existingSheets.length; i++) {
      const orig = existingSheets[i];
      const originalName = orig.getName();
      orig.setName(oldPrefix + i);
      renamedOriginals.push({ sheet: orig, originalName: originalName });
    }

    for (let i = 0; i < stagedEntries.length; i++) {
      stagedEntries[i].stagedSheet.setName(stagedEntries[i].targetName);
    }

    SpreadsheetApp.flush();
  } catch (swapErr) {
    // Emergency rollback if rename fails mid-swap
    const rollbackFailures = [];
    stagedEntries.forEach(function(entry) {
      try { targetSs.deleteSheet(entry.stagedSheet); } catch (e) { rollbackFailures.push('could not remove staged tab ' + entry.targetName); }
    });
    renamedOriginals.slice().reverse().forEach(function(entry) {
      try {
        entry.sheet.setName(entry.originalName);
      } catch (e) { rollbackFailures.push('could not restore original tab name ' + entry.originalName); }
    });
    try { SpreadsheetApp.flush(); } catch (e) { rollbackFailures.push('could not flush rollback changes'); }
    const rollbackStatus = rollbackFailures.length === 0
      ? 'Original tabs were restored.'
      : 'Rollback was incomplete (' + rollbackFailures.join('; ') + '). Use the verified safety snapshot: ' + safetySnapshot.name + '.';
    throw new Error('Restore swap failed. ' + rollbackStatus + ' ' + (swapErr.message || String(swapErr)));
  }

  // 6. Read-back verification while originals are still present for rollback
  let totalRowsRestored = 0;
  const restoredSheetNames = [];
  try {
    for (let i = 0; i < stagedEntries.length; i++) {
      const expected = stagedEntries[i];
      const liveSheet = targetSs.getSheetByName(expected.targetName);
      if (!liveSheet) {
        throw new Error('Post-restore read-back failed: missing tab "' + expected.targetName + '".');
      }
      const liveRows = liveSheet.getLastRow();
      if (liveRows !== expected.expectedRows) {
        throw new Error('Post-restore read-back row mismatch on tab "' + expected.targetName + '".');
      }
      if (expected.expectedHeaders.length > 0) {
        const liveHeaders = liveSheet.getRange(1, 1, 1, expected.expectedCols).getValues()[0].map(function(h) { return String(h).trim(); });
        if (JSON.stringify(liveHeaders) !== JSON.stringify(expected.expectedHeaders)) {
          throw new Error('Post-restore header mismatch on tab "' + expected.targetName + '".');
        }
      }
      if (expected.expectedIds) {
        const idCol = expected.expectedHeaders.findIndex(function(h) { return h.toLowerCase() === 'id'; }) + 1;
        const liveIds = liveSheet.getRange(2, idCol, Math.max(1, liveRows - 1), 1).getDisplayValues()
          .slice(0, Math.max(0, liveRows - 1)).map(function(r) { return String(r[0]).trim(); });
        if (JSON.stringify(liveIds) !== JSON.stringify(expected.expectedIds)) {
          throw new Error('Post-restore stable ID mismatch on tab "' + expected.targetName + '".');
        }
      }
      if (expected.expectedOverviewFormulas && JSON.stringify(liveSheet.getDataRange().getFormulas()) !== JSON.stringify(expected.expectedOverviewFormulas)) {
        throw new Error('Post-restore Overview formula mismatch.');
      }
      totalRowsRestored += Math.max(0, liveRows - 1);
      restoredSheetNames.push(expected.targetName);
    }
  } catch (verifyErr) {
    // Keep the safety snapshot as an independent recovery point, and restore the
    // original tabs before returning an error to the caller.
    const rollbackFailures = [];
    stagedEntries.forEach(function(entry) {
      try { targetSs.deleteSheet(entry.stagedSheet); } catch (e) { rollbackFailures.push('could not remove staged tab ' + entry.targetName); }
    });
    renamedOriginals.slice().reverse().forEach(function(entry) {
      try { entry.sheet.setName(entry.originalName); } catch (e) { rollbackFailures.push('could not restore original tab name ' + entry.originalName); }
    });
    try { SpreadsheetApp.flush(); } catch (e) { rollbackFailures.push('could not flush rollback changes'); }
    const rollbackStatus = rollbackFailures.length === 0
      ? 'Original tabs were restored.'
      : 'Rollback was incomplete (' + rollbackFailures.join('; ') + '). Use the verified safety snapshot: ' + safetySnapshot.name + '.';
    throw new Error('Final restore verification failed. ' + rollbackStatus + ' ' + (verifyErr.message || String(verifyErr)));
  }

  // Delete originals only after the replacement passed all final checks. A cleanup
  // failure leaves harmless __OLD_ tabs and must not turn a verified restore into a false failure.
  renamedOriginals.forEach(function(entry) {
    try { targetSs.deleteSheet(entry.sheet); } catch (e) {}
  });
  SpreadsheetApp.flush();

  return {
    restored: true,
    verified: true,
    restoredFromId: String(fileId),
    restoredFromName: sourceCheck.name,
    safetyBackupId: safetySnapshot.fileId,
    safetyBackupName: safetySnapshot.name,
    sheetsRestored: restoredSheetNames.length,
    restoredSheetNames: restoredSheetNames,
    totalRowsRestored: totalRowsRestored,
  };
}

/**
 * Proves the restore process using a separate temporary test Spreadsheet in Google Drive.
 * Never touches live financial records. Compares tabs, headers, record IDs, row counts, and Overview formulas.
 */
function testRestoreCashFlowBackup(fileId) {
  if (!fileId) {
    throw new Error('Backup fileId is required for dry-run restore test.');
  }
  const sourceCheck = verifyCashFlowBackup(fileId);
  if (!sourceCheck || !sourceCheck.exists || !sourceCheck.verified) {
    throw new Error('Selected backup failed initial verification.');
  }

  const sourceSs = SpreadsheetApp.openById(String(fileId));
  const sourceSheets = sourceSs.getSheets();
  const stamp = Utilities.formatDate(new Date(), 'Asia/Kuala_Lumpur', 'yyyy-MM-dd HHmmss');
  const testSs = SpreadsheetApp.create('CashFlow Restore DryRun ' + stamp);
  const testSsId = testSs.getId();

  let tabsCompared = 0;
  let totalRowsCompared = 0;
  let idsMatched = 0;
  let formulasVerified = 0;
  const issues = [];

  try {
    // Copy all backup tabs into the isolated test spreadsheet
    const copiedSheets = [];
    for (let i = 0; i < sourceSheets.length; i++) {
      const srcSheet = sourceSheets[i];
      const copied = srcSheet.copyTo(testSs);
      copied.setName('__TEST_' + srcSheet.getName());
      copiedSheets.push({ src: srcSheet, test: copied, name: srcSheet.getName() });
    }
    SpreadsheetApp.flush();

    // Compare tabs, headers, record IDs, counts, and Overview formulas
    for (let i = 0; i < copiedSheets.length; i++) {
      const item = copiedSheets[i];
      const srcRows = item.src.getLastRow();
      const testRows = item.test.getLastRow();
      const srcCols = item.src.getLastColumn();
      const testCols = item.test.getLastColumn();
      tabsCompared++;

      if (srcRows !== testRows || srcCols !== testCols) {
        issues.push('Dimension mismatch on ' + item.name + ': ' + srcRows + 'x' + srcCols + ' vs ' + testRows + 'x' + testCols);
        continue;
      }

      if (srcRows > 0 && srcCols > 0) {
        const srcHeaders = item.src.getRange(1, 1, 1, srcCols).getValues()[0].map(function(h) { return String(h).trim(); });
        const testHeaders = item.test.getRange(1, 1, 1, testCols).getValues()[0].map(function(h) { return String(h).trim(); });
        if (JSON.stringify(srcHeaders) !== JSON.stringify(testHeaders)) {
          issues.push('Header mismatch on ' + item.name);
        }

        const idColIdx = srcHeaders.findIndex(function(h) { return h.toLowerCase() === 'id'; });
        if (idColIdx >= 0 && srcRows > 1) {
          const srcIds = item.src.getRange(2, idColIdx + 1, srcRows - 1, 1).getValues().map(function(r) { return String(r[0]).trim(); });
          const testIds = item.test.getRange(2, idColIdx + 1, testRows - 1, 1).getValues().map(function(r) { return String(r[0]).trim(); });
          if (JSON.stringify(srcIds) !== JSON.stringify(testIds)) {
            issues.push('Record ID mismatch on ' + item.name);
          } else {
            idsMatched += srcIds.filter(Boolean).length;
          }
        }
      }

      if (item.name === 'Overview' && testRows >= 14) {
        const testFormulas = item.test.getRange(2, 2, 13, 6).getFormulas();
        for (let r = 0; r < testFormulas.length; r++) {
          for (let c = 0; c < testFormulas[r].length; c++) {
            if (testFormulas[r][c] && testFormulas[r][c].indexOf('=') === 0) {
              formulasVerified++;
            }
          }
        }
      }

      totalRowsCompared += Math.max(0, testRows - 1);
    }
  } finally {
    // Always clean up the temporary test spreadsheet so Drive stays clean
    try {
      DriveApp.getFileById(testSsId).setTrashed(true);
    } catch (e) {}
  }

  return {
    passed: issues.length === 0,
    testedAt: new Date().toISOString(),
    testedFileId: String(fileId),
    sourceFileId: String(fileId),
    testedName: sourceCheck.name,
    sourceName: sourceCheck.name,
    tabsCompared: tabsCompared,
    sheetsTested: tabsCompared,
    totalRowsCompared: totalRowsCompared,
    totalRowsVerified: totalRowsCompared,
    idsMatched: idsMatched,
    formulasVerified: formulasVerified,
    overviewFormulaMatches: formulasVerified,
    issues: issues,
    discrepancies: issues,
  };
}
