export type PendingMutationDisposition = 'acknowledged' | 'unconfirmed';

/** Keep failed writes on startup; a retry marker is not proof the server saved them. */
export function shouldKeepPendingMutationOnStartup(
  value: unknown,
  isRecordTombstoned: (id: string) => boolean,
): boolean {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  const rowId = String(item.rowId || item.entityId || '').trim();
  const isDelete = item.type === 'delete' || item.action === 'delete';

  // A local delete supersedes a stale add/update for that same entity.
  return !(rowId && isRecordTombstoned(rowId) && !isDelete);
}

/** Only a verified server result is allowed to remove an offline mutation. */
export function getPendingMutationDisposition(verified: boolean): PendingMutationDisposition {
  return verified ? 'acknowledged' : 'unconfirmed';
}
