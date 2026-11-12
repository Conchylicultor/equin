import type { MirroredTable } from "./define";

// The SQL fragments every reader and the triggers share, generated from a
// mirrored table's declaration. Every table and column name is spelled
// through `ident` — quoted, since a plain lower-case name can still be a
// reserved word (collect's `analytics_visits.returning`).

const PLAIN_IDENT_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * A table or column name as SQL spells it: double-quoted. Names are plain
 * lower-case identifiers (asserted by `defineMirrorSet`), so the quoted form
 * names exactly the same object — and a reserved word (`returning`, `user`)
 * still parses as a name.
 */
export function ident(name: string): string {
  if (!PLAIN_IDENT_RE.test(name)) {
    throw new Error(
      `table-mirror: "${name}" is not a plain lower-case identifier`,
    );
  }
  return `"${name}"`;
}

/** A string as a SQL literal. */
export function lit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** A text[] literal. */
export function textArray(values: readonly string[]): string {
  return `ARRAY[${values.map(lit).join(", ")}]::text[]`;
}

/** The row's key as the log spells it: `jsonb_build_object('id', a.id, …)`. */
export function pkJson(t: MirroredTable, alias: string): string {
  return `jsonb_build_object(${t.pk.map((c) => `${lit(c.name)}, ${alias}.${ident(c.name)}`).join(", ")})`;
}

/**
 * The row's content as it leaves the source: `to_jsonb(row)` restricted to
 * `columns` (every column that leaves the source when null). Keys are sorted
 * in jsonb's text form, so the text is canonical.
 */
export function rowJson(
  t: MirroredTable,
  alias: string,
  columns: readonly string[] | null,
): string {
  const all = `to_jsonb(${alias})`;
  if (columns === null) {
    return t.omit.length === 0 ? all : `(${all} - ${textArray(t.omit)})`;
  }
  const dropped = t.columns.filter((c) => !columns.includes(c));
  const removed = [...t.omit, ...dropped];
  return removed.length === 0 ? all : `(${all} - ${textArray(removed)})`;
}

/** The row hash over a row json expression. */
export function rowHash(json: string): string {
  return `md5((${json})::text)`;
}

/** `a.c1 COLLATE "C", a.c2` — the key order every keyset walk uses, on both sides. */
export function pkOrder(t: MirroredTable, alias: string): string {
  return t.pk
    .map(
      (c) => `${alias}.${ident(c.name)}${c.collatable ? ` COLLATE "C"` : ""}`,
    )
    .join(", ");
}

/** `(a.c1, a.c2) = (k.c1, k.c2)`: the row whose key a typed record holds. */
export function pkMatch(
  t: MirroredTable,
  alias: string,
  keyAlias: string,
): string {
  return t.pk
    .map((c) => `${alias}.${ident(c.name)} = ${keyAlias}.${ident(c.name)}`)
    .join(" AND ");
}

/**
 * A jsonb key, typed as the table's row: `jsonb_populate_record(NULL::s.t,
 * <json>)` — `public` on the source; a replica types it by its own copy.
 */
export function typedKey(
  t: MirroredTable,
  json: string,
  schema = "public",
): string {
  return `jsonb_populate_record(NULL::${schema}.${ident(t.name)}, ${json})`;
}

/**
 * `ROW(a.c1 COLLATE "C", a.c2) > ROW(k.c1 COLLATE "C", k.c2)`: the keyset
 * predicate after a typed key.
 */
export function pkAfter(
  t: MirroredTable,
  alias: string,
  keyAlias: string,
): string {
  return `ROW(${pkOrder(t, alias)}) > ROW(${pkOrder(t, keyAlias)})`;
}

/**
 * The fragments a replica spells the same way as the source (the key, the key
 * order, the row hash), so the two halves cannot drift apart: one definition,
 * read by both.
 */
export const mirrorSql = {
  ident,
  lit,
  textArray,
  pkJson,
  pkOrder,
  pkMatch,
  pkAfter,
  typedKey,
  rowHash,
} as const;
