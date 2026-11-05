import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

// A rollup is a trigger-maintained materialized aggregate table — a
// "hand-rolled IVM" for an aggregate too expensive to recompute from scratch on
// every live-state load, yet not expressible as a plain derived view. It is
// DERIVED state: fully recomputable from its source tables, created imperatively
// on boot (never a drizzle migration), kept current by STATEMENT-level triggers
// on each source, and diffed against its sources on every boot.
//
// A rollup is DATA (`defineRollup`): the owner declares its table, its key, the
// one query that computes its rows, and the source tables whose writes move it.
// Every piece of SQL — the table, a maintain function and three triggers PER
// SOURCE, and the reconcile — is generated from that declaration, so the
// trigger set, the columns a trigger diffs and the source list the routing
// layer reads (`rollupSources()`) cannot disagree.

/** The statement kinds a source's triggers fire on. */
export type RollupOp = "insert" | "update" | "delete";

/**
 * Carry values → rollup keys through one hop. `match` and `key` are columns of
 * `table`; the maintain function resolves `SELECT key FROM table WHERE match =
 * ANY(<carried>)`. The hop table is read at trigger time, so a write that
 * moves or removes the hop row (`UPDATE … SET key`, an RI cascade) resolves
 * only its new keys: the hop table must then be a source of its own whose
 * `carry` is the key, that keys on or reads `match`, and that fires on update
 * and delete. A reader's plan refuses a rollup without it at compile (A35,
 * query-resource's `compileAllJoins`).
 */
export interface RollupVia {
  table: PgTable;
  match: PgColumn;
  key: PgColumn;
}

/** One source table of a rollup: a write to it re-aggregates the keys it carries. */
export interface RollupSourceSpec {
  /** The source table (a drizzle handle; its primary key is read off it). */
  table: PgTable;
  /**
   * The source column that names the rollup row a source row contributes to —
   * the rollup key itself, or (with `via`) a value the hop maps to it.
   */
  carry: PgColumn;
  via?: RollupVia;
  /**
   * Every other source column the aggregate reads. An UPDATE re-aggregates only
   * the rows where `carry` or one of these moved (C1: the trigger has no column
   * list, because Postgres refuses transition tables on one — the diff is done
   * inside the maintain function over `old_rows FULL JOIN new_rows`).
   */
  reads: readonly PgColumn[];
  /** The statement kinds that can move the aggregate. Defaults to all three. */
  ops?: readonly RollupOp[];
}

/**
 * A rollup over a TRANSITIVE relation: a key's row reads the rows of its
 * ancestors over `edges` (`child` → `parent`, repeatedly), so a write that
 * moves one key's facts moves every key below it. Every maintain function then
 * EXPANDS the keys it resolved to their transitive dependents (the keys
 * reachable by walking the edges from `parent` back to `child`) before it
 * re-aggregates.
 *
 * `edges` must be a source carrying `child` (a new or dropped edge moves its
 * child's ancestor set, and so every node below it). An edge write also locks
 * — but does not re-aggregate — the `parent` it names: a concurrent write to
 * that parent's facts, which expands to its dependents, then either commits
 * before this edge is aggregated or sees it when it expands (see the maintain
 * function's lock loop).
 */
export interface RollupClosure {
  edges: PgTable;
  child: PgColumn;
  parent: PgColumn;
}

export interface RollupSpec<T extends PgTable = PgTable> {
  /**
   * The rollup's drizzle READ handle. It lives in a non-glob file (never
   * `tables.ts` / `schema.ts`), and its name must be an IMPERATIVE_PUBLIC_TABLES
   * value (asserted at eval). Its columns are the table's DDL. The minted
   * `Rollup` carries it as `handle`, so a reader joins the rollup through the
   * rollup itself and cannot pair one rollup's sources with another's table.
   */
  table: T;
  /** The rollup's single-column primary key. */
  key: PgColumn;
  /**
   * The rows of the rollup: a SELECT returning exactly the table's columns, by
   * name. `scope(keyExpr)` is the predicate restricting it to the keys being
   * maintained — call it once, on the expression the rows' key is computed
   * from. The reconcile's drift scan renders it as `true`; a maintain function
   * and the reconcile's write as `<keyExpr> = ANY(<the keys>)`. Plain SQL text,
   * no parameters.
   *
   * Asserted by the boot layer whenever it installs the rollup's functions
   * (the select compiled as a temp view): its output columns are exactly the
   * table's, and every column it reads is declared — on a source table, its
   * primary key, `carry` or a `reads` entry; on a via table, `match` or `key`.
   * A read no declaration names would be a write no trigger re-aggregates.
   */
  select: (scope: (keyExpr: string) => string) => string;
  sources: readonly RollupSourceSpec[];
  /** Expand every maintained key to its transitive dependents (see `RollupClosure`). */
  closure?: RollupClosure;
  /**
   * The rollup table is ON the change feed: its readers are routed by its own
   * rows (a row I / U / D is a change to the key it names), not by its
   * sources. What a materialized aggregate needs (query-resource's
   * `materializeJoin`): its readers join it like any side table, and a guarded
   * upsert means they hear of a key exactly when its value changed — even
   * when the change reached it through a closure no source route could
   * follow. Absent: the rollup is feed-exempt and read through its sources.
   */
  fed?: true;
}

/** One rollup column, as the generated DDL declares it. */
export interface RollupColumn {
  name: string;
  sqlType: string;
  notNull: boolean;
}

/** One generated trigger on a source table. */
export interface RollupTrigger {
  name: string;
  op: RollupOp;
  /** `CREATE OR REPLACE TRIGGER …` */
  ddl: string;
}

/** One source, compiled. */
export interface CompiledRollupSource {
  /** The source table's name. */
  table: string;
  /** The source table's primary-key columns. */
  pk: readonly string[];
  carry: string;
  /**
   * The carry column's SQL type — `via.match`'s too (asserted), else the
   * rollup key's. What a reader routing this source's changed carry values
   * (a reverse probe over them) casts them to.
   */
  carryType: string;
  via?: { table: string; match: string; key: string };
  reads: readonly string[];
  ops: readonly RollupOp[];
  functionName: string;
  /** `CREATE OR REPLACE FUNCTION …` */
  functionDdl: string;
  triggers: readonly RollupTrigger[];
}

/**
 * The brand only `defineRollup` sets. Not exported from the barrel, so no other
 * module can spell a `Rollup` literal.
 */
export const ROLLUP: unique symbol = Symbol("derived-tables.rollup");

/**
 * A compiled rollup. Only `defineRollup` mints one (the brand), so every rollup
 * the boot layer installs went through its eval-time asserts.
 */
export interface Rollup<T extends PgTable = PgTable> {
  readonly [ROLLUP]: true;
  /** The rollup table's name. */
  readonly table: string;
  /**
   * The rollup table's drizzle read handle (`RollupSpec.table`). What a
   * collection joining the rollup reads — taken from here, never declared
   * beside the rollup, so the table read and the sources routed are one
   * rollup's by construction.
   */
  readonly handle: T;
  /** The key column's name. */
  readonly key: string;
  /** Every column, key first. */
  readonly columns: readonly RollupColumn[];
  readonly sources: readonly CompiledRollupSource[];
  /** Whether the rollup table is on the change feed (`RollupSpec.fed`). */
  readonly fed: boolean;
  /** The closure its keys expand over (`RollupSpec.closure`), by table and column name. */
  readonly closure?: { table: string; child: string; parent: string };
  /** `CREATE TABLE IF NOT EXISTS …` */
  readonly createTableDdl: string;
  /**
   * The `select` with its scope rendered as a no-op that still names the key
   * expression — what the boot layer compiles as a temp view to check its
   * output columns and the source columns it reads against the declaration.
   */
  readonly selectCheckSql: string;
  /**
   * The reconcile's read-only drift scan: one row `{keys}`, the keys (as text,
   * in the key type's order — the maintain functions' lock order) whose row
   * differs from the aggregate, is missing, or has no aggregate.
   */
  readonly driftSql: string;
  /**
   * Takes the A34 advisory lock of each of `keys` (the drift scan's output),
   * in their order — the same lock a maintain function takes per key.
   */
  readonly lockSql: (keys: readonly string[]) => string;
  /**
   * The reconcile's write, over `keys` only, run after `lockSql` in a fresh
   * statement: re-aggregates them and writes only a row that differs, returning
   * one row `{upserted, deleted}`.
   */
  readonly reconcileSql: (keys: readonly string[]) => string;
}

/** What one boot's reconcile did to one rollup. */
export interface RollupReconcile {
  table: string;
  /** Rows inserted or updated because they differed from the aggregate. */
  upserted: number;
  /** Rows deleted because the aggregate no longer has their key. */
  deleted: number;
  /** The table, a maintain function or a source's triggers were (re)installed. */
  definitionChanged: boolean;
}
