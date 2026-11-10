/**
 * What one trigger table needs to hold exactly `wanted` (the contributions'
 * rows) given `stored` (its rows the sync owns: every declared row, and every
 * row of a declared job): a stored row equal to a wanted one is kept (its id
 * too), every other stored row is deleted, every wanted row with no equal
 * stored row is inserted. Unchanged code plans no write at all.
 *
 * Equal means equal over every column a contribution sets — `declared`
 * included, so a runtime row of a declared job is never "the same row" — plus
 * `enabled`, which a contribution's row always starts as: a declared trigger
 * disabled by hand is re-enabled, as the projection always did. Duplicates
 * pair one to one.
 */
export function planTriggerSync(
  stored: readonly Record<string, unknown>[],
  wanted: readonly Record<string, unknown>[],
): { deletes: string[]; inserts: Record<string, unknown>[] } {
  const keys =
    wanted[0] === undefined ? [] : [...Object.keys(wanted[0]), "enabled"];
  const unmatched = new Map<string, string[]>();
  for (const row of stored) {
    if (typeof row.id !== "string") {
      throw new Error(
        `[events] a stored trigger row has no string id: ${JSON.stringify(row)}`,
      );
    }
    const signature = rowSignature(row, keys);
    const ids = unmatched.get(signature);
    if (ids) ids.push(row.id);
    else unmatched.set(signature, [row.id]);
  }
  const inserts = wanted.filter((values) => {
    const ids = unmatched.get(rowSignature({ ...values, enabled: true }, keys));
    return ids === undefined || ids.pop() === undefined;
  });
  return { deletes: [...unmatched.values()].flat(), inserts };
}

/**
 * A trigger row's content over `keys`, equal for a stored row and the
 * contribution it came from: object keys sorted (the stored `job_with` is
 * jsonb, which keeps no key order), dates as instants, absent as null.
 */
function rowSignature(
  row: Record<string, unknown>,
  keys: readonly string[],
): string {
  const canonical = (v: unknown): unknown => {
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map(canonical);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(keys.map((k) => canonical(row[k] ?? null)));
}
