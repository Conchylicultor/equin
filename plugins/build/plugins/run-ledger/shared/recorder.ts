import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Namespace } from "@plugins/infra/plugins/namespace/core";
import { settleDeadInflightRun } from "./stale-holder";
import { buildRunIdKind } from "../core";

// NEVER IMPORT THE `build_runs` TABLE HERE. Every statement in this file and
// `stale-holder.ts` is hand-written SQL naming only the columns it touches, for
// two reasons that are one fact:
//
// - The CLI runs NEW code against the schema the PREVIOUS build left behind
//   (see `insertRow`), so it must never bind to the current table definition.
// - The table is a `defineEntity` (server/internal/tables.ts), which loads the
//   field-storage codegen manifest — and the regenerating `./singularity build`
//   process may not load one (`cli:codegen-manifests-not-frozen`).
//
// The detached `./singularity build` CLI records build_runs rows directly, from
// the CLI process — which declares NO runtime namespace (a terminal build is
// namespace-less) and so cannot use the namespace-bound `db` from
// `@plugins/database/server`. The recorder therefore opens ONE short-lived pool
// against the database of the namespace it is told to write to — the BUILDING
// CHECKOUT's own namespace, which is where a build's row, transcript and profile
// all live — and stamps every row with that namespace. This module must stay
// side-effect-free at eval (the CLI imports it early) — the pool is not opened
// until createBuildRunRecorder() is called.
//
// Eval-safety is the whole reason this lives in the run-ledger leaf, not the heavy
// build/server barrel: its import graph is drizzle + database/admin/server +
// namespace/core + supervised-job/core + paths/core (both db-free, jobs-free: the
// claim-time settle in `stale-holder.ts`) — NO config_v2 / notifications /
// namespace-bound db / jobs queue / events.
// Never add an import here that pulls any of those into an env-less CLI process.

/** The columns the CLI supplies when it mints its own row. */
export interface InsertRunRow {
  id: string;
  targets: string[];
  trigger: "manual" | "auto";
  commitHash: string | null;
  pid: number;
}

export interface BuildRunRecorder {
  /**
   * Claim this namespace's in-flight row for a terminal build (a direct
   * `./singularity build`, where no backend minted the row first). Returns
   * "lost" when a LIVE build holds this namespace's slot, and "unavailable" when
   * the namespace has no ledger yet — no database, or no `build_runs` table in
   * it.
   *
   * A holder whose build has already ended — it exited early, threw, was
   * signalled or SIGKILLed without closing its row — does not make this "lost":
   * on the index violation the holder is settled from its own terminal record
   * (`settleDeadInflightRun`) and the insert is retried once.
   *
   * "unavailable" is a real outcome, not an error: a fresh checkout that has
   * never been deployed can still run `build --composition sonata`, and its own
   * DB fork may not exist; on a machine's very first build the database exists
   * and its tables do not. A missing ledger must degrade to a note, never fail
   * the build it is only observing.
   *
   * `targets` is WHICH COMPOSITIONS this one invocation builds — `{singularity}`
   * for a plain build, the requested ids for a `build --composition a b`. One
   * invocation is one row with N targets, so this is an array, not a scalar.
   */
  insertRun(r: InsertRunRow): Promise<"claimed" | "lost" | "unavailable">;
  /** Stamp a run terminal, first-writer-wins (guarded `where(isNull(finishedAt))`). */
  closeRun(id: string, exitCode: number): Promise<void>;
  /** Release the pool. */
  close(): Promise<void>;
}

/** The index the claiming INSERT contends on — see `server/internal/tables.ts`. */
const INFLIGHT_UQ = "build_runs_inflight_uniq";

// node-postgres surfaces a unique_violation as SQLSTATE 23505 plus the offending
// constraint. The constraint is checked, not just the code: `build_runs` also has
// a primary key, and an id collision read as "a build is already in flight" would
// be a plausible-looking lie about a different fault.
function isInflightViolation(err: unknown): boolean {
  const pg = err as { code?: string; constraint?: string } | null;
  return pg?.code === "23505" && pg.constraint === INFLIGHT_UQ;
}

// "There is no ledger here yet" — the two ways Postgres says it:
//
//   3D000 (invalid_catalog_name) — no database at all. The checkout has never
//          been deployed, so nothing has ever forked it one.
//   42P01 (undefined_table)      — the database is there and `build_runs` is
//          not. That is a FIRST build: the base database is created empty when
//          the cluster starts, and the schema arrives only when the backend
//          restarts and migrates at the end of this very build. The ordering
//          note above says the same thing generally — the CLI always runs new
//          code against the schema the PREVIOUS build left behind, and on a
//          first build there is no previous schema at all.
//
// Both are the same fact, so both degrade to the "unavailable" outcome; every
// other error is a genuine fault and rethrows. (`fork-schema-drift.ts` and
// `orphaned-tables.ts` read 42P01 the same way: the migration runner never ran
// on this DB.)
function isMissingLedger(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "3D000" || code === "42P01";
}

/** One attempt at the claiming INSERT. */
async function insertRow(
  db: NodePgDatabase,
  namespace: Namespace,
  r: InsertRunRow,
): Promise<void> {
  // HAND-WRITTEN INSERT, NAMING ONLY THE COLUMNS THE CLI SUPPLIES.
  // Do NOT "modernise" this back to `db.insert(_buildRuns).values({…})`.
  //
  // The reason is a hard ordering fact plus a drizzle behaviour that
  // together make the ORM form structurally unusable HERE:
  //
  //   1. This row is minted by the `./singularity build` CLI
  //      (bin/commands/build.ts, just before `generateAppSources`), which
  //      GENERATES the migration; the migration is not APPLIED until the
  //      backend restarts at the very end of the build. So the CLI always
  //      runs NEW code against the schema the PREVIOUS build left behind.
  //
  //   2. `db.insert(table).values({…})` names EVERY column in the drizzle
  //      table definition and passes DEFAULT for the ones the caller
  //      omitted. Measured with `.toSQL()`:
  //
  //        insert into "build_runs"
  //          ("id","trigger","commit_hash","namespace","targets",
  //           "started_at","finished_at","exit_code","pid")
  //        values ($1,$2,$3,$4,$5,default,default,default,$6)
  //
  //      Omitting a field does NOT keep its column out of the statement.
  //
  // So the rule is about the TABLE, not the field: the CLI cannot use the
  // ORM insert on a table whose drizzle definition has gained ANY column
  // the deployed schema lacks. The next column added here would break this
  // write again the moment it is added — the statement below cannot, because
  // it names its own columns and grows only when a human adds one, one
  // release AFTER the migration that creates it has been applied. That
  // ordering is the whole discipline: add the column, deploy, then name it.
  // (`targets` is the column that taught us this, at the cost of two failed
  // builds; it is deployed now, so it is named.)
  //
  // Parameterised (drizzle's `sql` template emits $n placeholders), never
  // concatenated.
  //
  // `targets` MUST go through `sql.param()`. An array interpolated bare
  // into a `sql` template is drizzle's `in (…)` list form — it expands to
  // one placeholder PER ELEMENT wrapped in parens, so `${r.targets}` emits
  // `($5, $6)`, a row expression, and Postgres rejects it with
  // `42804 column "targets" is of type text[] but expression is of type
  // record`. `sql.param()` binds the whole array as ONE parameter, which
  // node-postgres serialises to a Postgres array literal; the placeholder's
  // type is then inferred from the target column, so no `::text[]` cast is
  // needed. Both forms were measured with `.toSQL()` and round-tripped
  // against the deployed table.
  await db.execute(sql`
    insert into "build_runs" ("id", "trigger", "commit_hash", "namespace", "targets", "pid")
    values (${r.id}, ${r.trigger}, ${r.commitHash}, ${namespace}, ${sql.param(r.targets)}, ${r.pid})
  `);
}

/**
 * The claim itself, over any drizzle handle — the recorder's own short-lived
 * pool in production, a throwaway fixture DB in the tests.
 *
 * `"claimed"` or `"lost"`; every other error (including a missing database)
 * propagates for the caller to classify. On a `build_runs_inflight_uniq`
 * violation the holder is settled (`settleDeadInflightRun`): if its build
 * provably ended the row is closed from the build's own terminal record and the
 * insert is retried ONCE — the index still decides that retry, so losing it to a
 * concurrent claimant is an ordinary "lost". A live holder is "lost" at once.
 */
export async function claimInflightRun(
  db: NodePgDatabase,
  namespace: Namespace,
  r: InsertRunRow,
): Promise<"claimed" | "lost"> {
  try {
    await insertRow(db, namespace, r);
    return "claimed";
  } catch (err) {
    if (!isInflightViolation(err)) throw err;
  }
  if (!(await settleDeadInflightRun(db, namespace))) return "lost";
  try {
    await insertRow(db, namespace, r);
    return "claimed";
  } catch (err) {
    if (isInflightViolation(err)) return "lost";
    throw err;
  }
}

/**
 * `insertRun`'s body over any drizzle handle — the recorder's own short-lived
 * pool in production, a throwaway fixture DB in the tests. The classification
 * `claimInflightRun` deliberately does NOT make: a ledger that is not there is
 * the named outcome `"unavailable"`, every other error propagates.
 */
export async function insertRunOn(
  db: NodePgDatabase,
  namespace: Namespace,
  r: InsertRunRow,
): Promise<"claimed" | "lost" | "unavailable"> {
  try {
    return await claimInflightRun(db, namespace, r);
  } catch (err) {
    if (isMissingLedger(err)) return "unavailable";
    throw err;
  }
}

/**
 * `closeRun`'s body over any drizzle handle. First-writer-wins: the CLI's stamp
 * is authoritative for the run it owns. The backend's `proc.exited` writer and
 * the orphan reconciler are late fallbacks guarded by the same
 * `isNull(finishedAt)` predicate, so a row closed here is never re-stamped by
 * them.
 *
 * A namespace with no ledger — no database, or a database whose schema this
 * build has not created yet — never had a row to close (`insertRunOn` answered
 * "unavailable"), so the same tolerance applies here.
 *
 * Hand SQL, like the insert: it names only the two columns it stamps.
 */
export async function closeRunOn(
  db: NodePgDatabase,
  id: string,
  exitCode: number,
): Promise<void> {
  try {
    await db.execute(sql`
      update "build_runs" set "finished_at" = ${new Date()}, "exit_code" = ${exitCode}
      where "id" = ${buildRunIdKind.key(id)} and "finished_at" is null
    `);
  } catch (err) {
    if (!isMissingLedger(err)) throw err;
  }
}
