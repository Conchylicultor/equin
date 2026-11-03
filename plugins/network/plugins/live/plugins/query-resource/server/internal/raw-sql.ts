import {
  and,
  Column,
  is,
  sql,
  type DriverValueDecoder,
  type SQL,
} from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { JoinPlan, ReadColumn } from "./joins";
import type { RoutedBase } from "./routes";

// The SQL helpers every raw-SQL shape shares (step 16b.1 of
// research/2026-10-06-global-scoped-change-routing-p8-v3.md, C6): the union
// window renders its arms through them, the join routes' reverse probes take
// their id lists from `anyOf`, and the `all` compiler (`./compile-alias`,
// `./grouped`) renders its shapes and CTEs with the same pieces. One home, so the two `= ANY` spellings that grew apart
// — one failing the statement on a bad id, the other dropping it — are one
// helper whose caller must say which it means.

// ── SQL types ───────────────────────────────────────────────────────────────

/** Postgres's spellings of one type, folded to one (what `getSQLType()` and a cast may each say). */
const TYPE_ALIASES: Readonly<Record<string, string>> = {
  timestamptz: "timestamp with time zone",
  timestamp: "timestamp without time zone",
  int: "integer",
  int4: "integer",
  int8: "bigint",
  int2: "smallint",
  float8: "double precision",
  float4: "real",
  bool: "boolean",
  varchar: "character varying",
};

/** A type name, canonical: lower case, single spaces, aliases folded. */
export function canonicalSqlType(sqlType: string): string {
  const t = sqlType.trim().toLowerCase().replace(/\s+/g, " ");
  const array = t.endsWith("[]");
  const base = array ? t.slice(0, -2) : t;
  return (TYPE_ALIASES[base] ?? base) + (array ? "[]" : "");
}

/** `NULL::<type>` — the projection a shape without the value carries. */
export function nullOf(sqlType: string): SQL {
  return sql.raw(`NULL::${sqlType}`);
}

/** The decoder a rendered read carries: a column's own, or its expression's `.mapWith()`. */
export function decoderOfRead(
  read: ReadColumn,
): DriverValueDecoder<unknown, unknown> {
  if (is(read, Column)) return read as PgColumn;
  // drizzle keeps `.mapWith()`'s decoder on the SQL object (a runtime field
  // its typings do not declare); an unmapped expression's is the identity.
  return (read as unknown as { decoder: DriverValueDecoder<unknown, unknown> })
    .decoder;
}

// ── Clauses ─────────────────────────────────────────────────────────────────

/** The conjunction of the parts present, or `undefined` when none is. */
export function allOf(parts: readonly (SQL | undefined)[]): SQL | undefined {
  const present = parts.filter((p): p is SQL => p !== undefined);
  return present.length === 0 ? undefined : and(...present);
}

/**
 * `FROM <base> [joins]` — the joins a tuple includes, in declaration order,
 * each `INNER` (a required lookup) or `LEFT` and rendered under its alias;
 * then the family members it includes, LEFT, in alias order (a stable
 * statement per member set, as `JoinPlan.apply`). An included relation that
 * is neither throws, naming `label`.
 */
export function fromSql(
  base: RoutedBase,
  plan: JoinPlan,
  included: ReadonlySet<string>,
  label: string,
): SQL {
  const parts: SQL[] = [sql`${base.table}`];
  for (const j of plan.joins) {
    if (!included.has(j.alias)) continue;
    parts.push(
      sql`${sql.raw(j.inner ? "INNER JOIN" : "LEFT JOIN")} ${j.table} ${sql.identifier(j.alias)} ON ${j.on}`,
    );
  }
  const members = [...included]
    .filter((alias) => !plan.joins.some((j) => j.alias === alias))
    .sort();
  for (const alias of members) {
    const m = plan.memberJoin(alias);
    if (m === undefined) {
      throw new Error(
        `${label}: the tuple includes relation "${alias}", which neither a join nor a join family of the plan declares.`,
      );
    }
    parts.push(sql`LEFT JOIN ${m.table} ${sql.identifier(m.alias)} ON ${m.on}`);
  }
  return sql.join(parts, sql` `);
}

// ── Id lists ────────────────────────────────────────────────────────────────

/**
 * What an id list does with an id that is not valid input for the column's
 * type (`"x"` against a uuid or an integer pk) — a choice every caller states,
 * since the right answer depends on where the ids came from:
 *
 * - `"throws"` — the ids are VOUCHED FOR: they came out of the database (a
 *   change's keys, the hosts a probe read, a snapshot's ids). A bad one is a
 *   broken invariant, and Postgres's cast fails the statement loudly.
 * - `"absent"` — the ids are untrusted text (a `kind:raw` key a client sent,
 *   which nothing checked against the arm's pk type). A bad one matches no row,
 *   exactly like an unknown id: a point read answers it absent, never an
 *   invalid-input error that fails the whole load.
 */
export type InvalidIdPolicy = "throws" | "absent";

/**
 * `col = ANY(<ids>)` over text values: ONE array param whatever the count,
 * compared in the column's own type so Postgres compares the key it stored and
 * the column's index serves the probe. `invalid` is the policy for an id the
 * type cannot hold (see `InvalidIdPolicy`):
 *
 * - `"throws"`: `col = ANY($1::<type>[])` — the cast fails on a bad id.
 * - `"absent"`: on a text column the same comparison (no id is invalid text);
 *   otherwise each id is checked with `pg_input_is_valid` and only the valid
 *   ones are cast — `col = ANY(ARRAY(SELECT x::<type> FROM unnest($1::text[])
 *   AS x WHERE pg_input_is_valid(x, <type>)))`.
 */
export function anyOf(
  col: PgColumn,
  ids: readonly string[],
  opts: { invalid: InvalidIdPolicy },
): SQL {
  return anyOfExpr(col, col.getSQLType(), ids, opts);
}

/**
 * {@link anyOf} over any expression of a known SQL type — a CTE's output
 * column (`__d.__n`), which carries no column object to read the type off.
 */
export function anyOfExpr(
  col: PgColumn | SQL,
  type: string,
  ids: readonly string[],
  opts: { invalid: InvalidIdPolicy },
): SQL {
  if (opts.invalid === "throws") {
    return sql`${col} = ANY(${sql.param([...ids])}::${sql.raw(type)}[])`;
  }
  const param = sql`${sql.param([...ids])}::text[]`;
  if (canonicalSqlType(type) === "text") return sql`${col} = ANY(${param})`;
  return sql`${col} = ANY(ARRAY(SELECT x::${sql.raw(type)} FROM unnest(${param}) AS x WHERE pg_input_is_valid(x, ${type})))`;
}

/**
 * `(c1, …, cn) IN (SELECT * FROM unnest($1::t1[], …, $n::tn[]))` — a
 * composite key's membership test over `tuples` (each one value per column,
 * in column order): ONE array param per column whatever the count, each cast
 * to its column's type, so Postgres compares the keys it stored and the
 * primary key's index serves the probe. The tuples are VOUCHED FOR — every
 * part valid input for its column (the caller checks untrusted ids first): a
 * bad one fails the cast, loudly.
 */
export function tupleIn(
  cols: readonly PgColumn[],
  tuples: readonly (readonly string[])[],
): SQL {
  for (const t of tuples) {
    if (t.length !== cols.length) {
      throw new Error(
        `tupleIn: a tuple of ${t.length} parts for ${cols.length} columns`,
      );
    }
  }
  const arrays = cols.map(
    (col, i) =>
      sql`${sql.param(tuples.map((t) => t[i]!))}::${sql.raw(col.getSQLType())}[]`,
  );
  return sql`(${sql.join(
    cols.map((c) => sql`${c}`),
    sql`, `,
  )}) IN (SELECT * FROM unnest(${sql.join(arrays, sql`, `)}))`;
}
