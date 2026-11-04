/**
 * The shapes a SQL client must have to be usable here — declared
 * **structurally**, never imported.
 *
 * `pg` and `drizzle-orm` are both server-only, and the callers of this plugin
 * span three runtimes (server plugins, `check/` files, `cli/`). Naming those
 * packages — even with a type-only import — would make `core` stop being a
 * leaf.
 *
 * ## That the real types satisfy these was compiled, not asserted
 *
 * Structural typing is the whole bet here, so it was checked against the real
 * packages rather than reasoned about. Under the repo's `strict` +
 * `noUncheckedIndexedAccess`, all six front doors typecheck with **no cast** on:
 *
 * - `pg.Pool`, `pg.PoolClient`, `pg.Client` → `SqlQueryable`. `pg`'s `query` is
 *   overloaded; the one that matches resolves to
 *   `(text: string, values?: any[]) => Promise<QueryResult<any>>`, whose
 *   `rows: any[]` is assignable to `rows: unknown[]` — which is why plain
 *   `unknown[]` works and no `readonly` widening was needed. `pg.FieldDef` has
 *   more members than {@link SqlField}, which assignability allows.
 * - drizzle's `NodePgDatabase` → `SqlExecutable<SQL>`. Note `db.execute()`
 *   returns a `PgRaw<T>`, not a `Promise` — it satisfies `Promise<SqlResult>`
 *   structurally, since drizzle's `QueryPromise implements Promise<T>`.
 * - `pg.QueryResult` and drizzle's raw result are both `SqlResult`, and `T`
 *   infers from the caller's schema through every door.
 *
 * The check itself was a throwaway file, deleted rather than kept: keeping it
 * would have meant importing `pg` and `drizzle-orm` into `core/`, which is the
 * exact property this header is about. The standing proof is the call sites.
 */

/** One column of a result, as Postgres described it on the wire. */
export interface SqlField {
  name: string;
  /**
   * The Postgres type OID of the column. This is the number that explains a
   * mismatch: `pg` decodes a column with the parser registered for its OID, and
   * for an OID it does not know (`name[]` = 1003) the column arrives as its raw
   * Postgres literal — a string. See {@link SqlRowError}.
   */
  dataTypeID: number;
}

/**
 * A query result. `rows` is `unknown[]` on purpose: it is what actually came
 * back, which nothing has checked yet.
 */
export interface SqlResult {
  rows: unknown[];
  rowCount: number | null;
  /**
   * Optional because not every driver surface carries it, but pg and drizzle
   * both do — and it is what turns "this column is wrong" into "this column is
   * OID 1003, cast it".
   */
  fields?: SqlField[];
}

/**
 * What one call can answer with: one result, or — for SQL holding several
 * statements sent without params (pg's simple-query protocol) — one result
 * per statement. `pg`'s own types claim a single `QueryResult` either way; this
 * union is the runtime truth, so no reader can take `.rows` off an array.
 */
export type SqlAnswer = SqlResult | SqlResult[];

/** Anything shaped like a `pg` Pool / PoolClient / Client. */
export interface SqlQueryable {
  query(sql: string, params?: unknown[]): Promise<SqlAnswer>;
}

/**
 * Anything shaped like a drizzle db, through its raw `execute` escape hatch.
 * `Q` is the query object type (drizzle's `SQL`), left generic so this file
 * never has to name drizzle.
 */
export interface SqlExecutable<Q> {
  execute(query: Q): Promise<SqlAnswer>;
}

/**
 * A result whose rows have been parsed, for the callers that legitimately need
 * more than the rows.
 *
 * The MCP `query_db` tool runs agent-authored arbitrary SQL and needs `fields`
 * to name the columns; other callers report `rowCount`. Without this shape those
 * callers would have to go back to the raw `.query()` form — so the guardrail
 * would leak at exactly the sites that read the most unpredictable SQL. `rows`
 * is still `T[]`, parsed: this widens what you can see, never what you can skip.
 */
export interface ParsedResult<T> {
  rows: T[];
  rowCount: number | null;
  /** `[]` when the driver did not supply them, so there is no absent case. */
  fields: SqlField[];
}
