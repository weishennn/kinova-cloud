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

export interface ConflictResolutionUpdate {
  sheetName: string;
  rowIndex: number;
  rowData: Record<string, unknown>;
}

/** Keep an update retryable until its deleted-row conflict is durably saved. */
export function persistConflictBeforeTombstone(
  persistConflict: () => boolean,
  clearDisposableCaches: () => void,
  recordTombstone: () => void
): boolean {
  let saved = persistConflict();
  if (!saved) {
    clearDisposableCaches();
    saved = persistConflict();
  }
  if (!saved) return false;
  recordTombstone();
  return true;
}

/** Build an update against the latest server snapshot when a user keeps their edit. */
export function buildConflictResolutionUpdate(
  clientRecord: Record<string, unknown>,
  serverRecord: Record<string, unknown>,
  entityId: string
): ConflictResolutionUpdate | null {
  if (serverRecord.status === 'deleted_on_server' || serverRecord._deleted === true) return null;

  const serverDate = String(serverRecord.Date || serverRecord.date || '');
  const serverMonth = String(
    serverRecord._month || serverRecord.sheetName || (/^\d{4}-\d{2}/.test(serverDate) ? serverDate.slice(0, 7) : '')
  );
  const id = entityId.trim();
  if (!serverMonth || !id) return null;

  const rowData = { ...clientRecord };
  delete rowData._baseData;
  return {
    sheetName: serverMonth,
    rowIndex: Number(serverRecord._rowIndex) > 1 ? Number(serverRecord._rowIndex) : 2,
    rowData: {
      ...rowData,
      Id: id,
      id,
      _baseData: { ...serverRecord },
    },
  };
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
    (k) => !k.startsWith('_') && k.toLowerCase() !== 'id' && Object.prototype.hasOwnProperty.call(currentServer, k)
  );

  for (const field of fieldsToCheck) {
    const baseVal = normalizeConflictValue(field, originalBase[field]);
    const serverVal = normalizeConflictValue(field, currentServer[field]);
    const clientVal = normalizeConflictValue(field, clientUpdate[field]);

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

/**
 * Builds the sheet-shaped snapshot used as the edit base for transaction OCC.
 * Transaction lists expose normalized lower-case fields, while Google Sheets
 * stores title-cased column names. Keeping this mapping in one place prevents
 * false conflicts caused only by the UI's normalized model.
 */
export function buildTransactionBaseRecord(transaction: Record<string, unknown>): Record<string, unknown> {
  const value = (...keys: string[]) => {
    for (const key of keys) {
      if (transaction[key] !== undefined && transaction[key] !== null) return transaction[key];
    }
    return '';
  };
  const rawType = String(value('Type', 'type') || 'Expense').toLowerCase();

  return {
    Id: value('Id', 'id'),
    Date: value('Date', 'date'),
    Type: rawType === 'income' ? 'Income' : rawType === 'investment' ? 'Investment' : 'Expense',
    Category: value('Category', 'category'),
    SubCategory: value('SubCategory', 'subCategory'),
    Description: value('Description', 'description'),
    Amount: value('Amount', 'amount'),
    Currency: value('Currency', 'currency'),
    BaseAmount: value('BaseAmount', 'baseAmount'),
    BaseCurrency: value('BaseCurrency', 'baseCurrency'),
    FxRateToBase: value('FxRateToBase', 'fxRateToBase'),
    TripTag: value('TripTag', 'tripTag', 'tripId'),
    ReceiptUrl: value('ReceiptUrl', 'receiptUrl'),
    Notes: value('Notes', 'notes'),
  };
}

function normalizeConflictValue(field: string, value: unknown): string {
  if (value === undefined || value === null) return '';

  if (field.toLowerCase() === 'date') {
    if (value instanceof Date && Number.isFinite(value.getTime())) {
      return value.toISOString().slice(0, 10);
    }
    const text = String(value).trim();
    const isoDate = text.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
    if (isoDate) return isoDate;
    const parsed = new Date(text);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString().slice(0, 10);
    return text;
  }

  const numericFields = new Set(['amount', 'baseamount', 'fxratetobase']);
  if (numericFields.has(field.toLowerCase()) && (typeof value === 'number' || (typeof value === 'string' && value.trim() !== ''))) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return `number:${numeric}`;
  }

  return String(value).trim();
}
