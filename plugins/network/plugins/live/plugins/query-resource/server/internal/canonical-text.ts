// The canonical text of a key column's value: Postgres's own `col::text`,
// the spelling the change feed carries a key in. A route matches a tuple's
// param against that text, so a param is admitted only in it — one value,
// one spelling (a scoped `all` set's `by`, a follow's `{ ids }`).

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INT_RE = /^(0|-?[1-9][0-9]*)$/;
const INT_BOUNDS: Readonly<Record<string, readonly [bigint, bigint]>> = {
  smallint: [-(2n ** 15n), 2n ** 15n - 1n],
  integer: [-(2n ** 31n), 2n ** 31n - 1n],
  bigint: [-(2n ** 63n), 2n ** 63n - 1n],
};

/**
 * The key types and what their canonical text is: Postgres's own
 * `col::text` of a value, so a param equal to it is the feed's key exactly
 * (`col = $param` ⇔ `col::text = $param`) — a check answering `null` for a
 * canonical value, else what it must be. Any other type is `null` (refused):
 * a timestamp's or a float's text depends on settings and rounding.
 */
export function canonicalTextOf(
  sqlType: string,
): ((value: string) => string | null) | null {
  if (/^(text|character varying|varchar)(\(\d+\))?$/.test(sqlType)) {
    return () => null;
  }
  if (sqlType === "uuid") {
    return (v) =>
      UUID_RE.test(v) ? null : "a uuid in canonical form (lower-case hex)";
  }
  const bounds = INT_BOUNDS[sqlType];
  if (bounds !== undefined) {
    return (v) =>
      INT_RE.test(v) && BigInt(v) >= bounds[0] && BigInt(v) <= bounds[1]
        ? null
        : `the canonical decimal text of a ${sqlType}`;
  }
  return null;
}

/**
 * Which ids a point read over `sqlType` (canonicalised, as `canonicalSqlType`
 * spells it) matches under their own spelling alone: an id that IS the key
 * column's canonical text equals a row's `col::text` — the key the row is
 * served under — or no row's. So a batched point read that returned no row
 * for such an id proves the row absent (resource-runtime's
 * `PointBatch.exactId`). Any other id (an upper-case uuid, `"007"` for an
 * integer key) may still match a row served under another spelling, and so
 * does every id of a type with no canonical text (`false` throughout).
 */
export function exactIdOf(sqlType: string): (id: string) => boolean {
  const canonical = canonicalTextOf(sqlType);
  if (canonical === null) return () => false;
  return (id) => canonical(id) === null;
}
