type TransactionRow = Record<string, unknown>;

function validMonth(value: unknown): string {
  const month = String(value || '');
  return /^\d{4}-\d{2}$/.test(month) ? month : '';
}

/**
 * Applies an optimistic transaction edit to one cached period. The sheet name
 * is the source period used by the server update; the edited date determines
 * the destination period shown in the local cache.
 */
export function applyPendingTransactionUpdate(
  rows: TransactionRow[],
  targetSheet: string | undefined,
  sourceSheet: string,
  rowId: string,
  rowData: TransactionRow,
  pending = false,
): TransactionRow[] {
  if (!rowId) return rows;

  const date = String(rowData.Date || rowData.date || '');
  const destinationMonth = /^\d{4}-\d{2}/.test(date)
    ? date.slice(0, 7)
    : validMonth(rowData._month) || validMonth(sourceSheet);
  const sourceMonth = validMonth(sourceSheet) || validMonth(rowData._month) || destinationMonth;

  if (targetSheet && targetSheet !== 'Transactions' && targetSheet !== 'all') {
    if (targetSheet.startsWith('year-')) {
      const targetYear = targetSheet.slice(5);
      const sourceYear = sourceMonth.slice(0, 4);
      const destinationYear = destinationMonth.slice(0, 4);
      if (targetYear !== sourceYear && targetYear !== destinationYear) return rows;
      if (sourceYear !== destinationYear && targetYear === sourceYear) {
        return rows.filter((row) => String(row.Id || row.id || '') !== rowId);
      }
    } else if (/^\d{4}-\d{2}$/.test(targetSheet)) {
      if (targetSheet === sourceMonth && sourceMonth !== destinationMonth) {
        return rows.filter((row) => String(row.Id || row.id || '') !== rowId);
      }
      if (targetSheet !== destinationMonth && targetSheet !== sourceMonth) return rows;
    } else {
      return rows;
    }
  }

  const updatedRow: TransactionRow = {
    ...rowData,
    Id: rowId,
    id: rowId,
    ...(destinationMonth ? { _month: destinationMonth } : {}),
    ...(pending ? { _pendingSync: true } : {}),
  };
  let found = false;
  const updatedRows = rows.map((row) => {
    if (String(row.Id || row.id || '') !== rowId) return row;
    found = true;
    return { ...row, ...updatedRow };
  });

  // A moved row is no longer present in the destination sheet snapshot. Keep
  // its edited version visible there until the queued update reaches Sheets.
  if (!found) updatedRows.unshift(updatedRow);
  return updatedRows;
}
