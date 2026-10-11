type MutableLock = { current: boolean };

/** Acquire synchronously so two submit events in the same render cannot both save. */
export function acquireSubmitLock(lock: MutableLock): boolean {
  if (lock.current) return false;
  lock.current = true;
  return true;
}

export function releaseSubmitLock(lock: MutableLock): void {
  lock.current = false;
}
