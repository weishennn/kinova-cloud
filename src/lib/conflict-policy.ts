/**
 * Multi-device conflict resolution policies for CashFlow / Kinova.
 *
 * Prevents phantom record resurrection, documents concurrent modification handling,
 * and preserves conflicting edits in the Sync Conflict store.
 */

export interface NotFoundConflictResult {
  action: 'discard_and_tombstone' | 'force_restore';
  reason: string;
}

/**
 * Resolves the conflict policy when an update mutation targets a row that is not found on Google Sheets.
 *
 * CRITICAL INVARIANT:
 * When a row is absent from the server during an update, it was deleted by another device or user.
 * The system MUST NOT unilaterally convert the update into an addRow with _forceRestore: true.
 * Doing so resurrects deleted rows across devices.
 *
 * Only an explicit user restore action (_forceRestore: true on the client payload) may re-add the row.
 * Otherwise, the missing row is tombstoned and logged in the Conflict Store for user inspection.
 */
export function resolveNotFoundUpdatePolicy(
  rowId: string,
  isTombstoned: boolean,
  isExplicitForceRestore: boolean
): NotFoundConflictResult {
  if (isTombstoned) {
    return {
      action: 'discard_and_tombstone',
      reason: 'Record is already tombstoned as deleted.',
    };
  }
  if (isExplicitForceRestore) {
    return {
      action: 'force_restore',
      reason: 'User explicitly requested a record restore.',
    };
  }
  return {
    action: 'discard_and_tombstone',
    reason: 'Record was deleted on the server. Update is discarded and logged to avoid resurrecting deleted record.',
  };
}

/**
 * Detects whether a server record has been modified by another device since the client read it.
 */
export function detectConcurrentFieldConflict(
  originalBase: Record<string, unknown> | null | undefined,
  currentServer: Record<string, unknown>,
  clientUpdate: Record<string, unknown>
): { hasConflict: boolean; conflictingFields: string[] } {
  if (!originalBase) {
    return { hasConflict: false, conflictingFields: [] };
  }

  const conflictingFields: string[] = [];
  const fieldsToCheck = Object.keys(clientUpdate).filter(
    (k) => !k.startsWith('_') && k.toLowerCase() !== 'id'
  );

  for (const field of fieldsToCheck) {
    const baseVal = String(originalBase[field] ?? '').trim();
    const serverVal = String(currentServer[field] ?? '').trim();
    const clientVal = String(clientUpdate[field] ?? '').trim();

    // If server changed the value away from base, and client also changed it to something different:
    if (serverVal !== baseVal && clientVal !== serverVal) {
      conflictingFields.push(field);
    }
  }

  return {
    hasConflict: conflictingFields.length > 0,
    conflictingFields,
  };
}
