/**
 * Canonical structural equality helpers for Recurring Commitments & Installment Plans.
 * Avoids false sync diffs caused by key reordering, undefined properties,
 * or auto-stamped `lastAutoRecordedMonth` changes.
 */

export function canonicalizePlanValue(value: unknown, ignoreVolatile = false): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizePlanValue(item, ignoreVolatile));
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      if (obj[key] === undefined) continue;
      if (ignoreVolatile && key === 'lastAutoRecordedMonth') continue;
      sorted[key] = canonicalizePlanValue(obj[key], ignoreVolatile);
    }
    return sorted;
  }
  return value;
}

export function arePlanRecordsEquivalent(
  a: unknown,
  b: unknown,
  options: { ignoreVolatile?: boolean } = {}
): boolean {
  const ignoreVolatile = Boolean(options.ignoreVolatile);
  return (
    JSON.stringify(canonicalizePlanValue(a, ignoreVolatile)) ===
    JSON.stringify(canonicalizePlanValue(b, ignoreVolatile))
  );
}
