import { PRODUCT_NAME } from "@plugins/framework/plugins/product-name/core";
// The closed set of backend database connections. Every pool and standalone
// client built through `createDbPool` / `createDbClient` names itself with one
// of these, and every deadline report names the pool it came from. A closed
// list both runtimes read (the server labels, the reports UI displays), so it
// is plain data rather than a slot.

/** Every backend connection's name, in no particular order. */
export const DB_POOL_NAMES = [
  /** The app pool behind `db` (through pgbouncer): the interactive lane, and context-less work (boot, migrations). */
  "app",
  /** The app's background-lane pool (through pgbouncer, as the background lane's own login role and server pool). */
  "app-background",
  /** graphile-worker's job-running pool. */
  "jobs-runner",
  /** graphile-worker's `WorkerUtils` pool (`addJob` and friends). */
  "jobs-enqueue",
  /** The boot-time job-queue schema installer. */
  "jobs-schema",
  /** The advisory-lock pool behind `withJobLock`. */
  "job-lock",
  /** The admin pool (maintenance database: fork, drop, list). */
  "admin",
  /** One-off admin clients opened and closed around a single operation. */
  "admin-short-lived",
  /**
   * The lock watch's held session (`database/lock-watch`): opened once and
   * kept, so a look still runs while new connections to the cluster stall.
   */
  "lock-watch",
  /**
   * The session holding a DB fork's temp lease (`database/admin`): the fork
   * holds it from before its temp exists to after the rename; the temp sweep
   * tries it before dropping a temp.
   */
  "fork-lease",
  /** The change-feed LISTEN client. */
  "change-feed",
  /**
   * The session holding this process's schema-generation lock, on which a
   * deferred contract waits out older code (`database#machine`).
   */
  "schema-generation",
  /**
   * The events-test harness's stand-in worker sessions: one dedicated client per
   * scenario run, holding a job's advisory lock until the scenario kills its
   * socket to simulate a crash.
   */
  "events-test",
] as const;

export type DbPoolName = (typeof DB_POOL_NAMES)[number];

/**
 * The pools that reach Postgres through pgbouncer — the app's two lanes. Every
 * other pool dials Postgres's own socket, so the other end of its socket (and
 * of a stray close) is in Postgres's log, not pgbouncer's.
 */
export const DB_POOLS_THROUGH_PGBOUNCER: ReadonlySet<DbPoolName> = new Set([
  "app",
  "app-background",
]);

/**
 * The two calls a deadline bounds: opening a connection (`connect`) and a
 * statement on an open one (`query`).
 */
export const DB_CALL_PHASES = ["connect", "query"] as const;

export type DbCallPhase = (typeof DB_CALL_PHASES)[number];

/**
 * Where a connection stood in a transaction as of its last reply from the
 * server (the ReadyForQuery status byte: `I` idle, `T` open, `E` failed). A
 * call lost on a connection whose state is `open` or `failed` was sent inside
 * a transaction: if the server has it, that transaction — and every row lock
 * it took — stays open until the session ends.
 */
export const DB_TX_STATES = ["idle", "open", "failed"] as const;

export type DbTxState = (typeof DB_TX_STATES)[number];

/** Whether a connection in `state` was inside a transaction (open or failed). */
export function isInTransaction(state: DbTxState | null): boolean {
  return state === "open" || state === "failed";
}

/**
 * How many other in-flight calls a missed deadline names, beside the total. The
 * oldest are kept: in a lock chain the head is the oldest waiter, and a report
 * is read for the head.
 */
export const IN_FLIGHT_REPORT_MAX = 10;

const APPLICATION_NAME_PREFIX = `${PRODUCT_NAME}:`;
const CLI_APPLICATION_NAME_PREFIX = `${PRODUCT_NAME}-cli:`;

/**
 * The `application_name` every connection built by `createDbPool` /
 * `createDbClient` logs in with: `equin:<pool>` from a process that reports
 * the end of its own sessions (a backend, serving or exec: it has a runtime
 * namespace and drains `idleTransactionEndedSink`), `equin-cli:<pool>` from
 * one that cannot (a CLI process: stderr only). It marks the session in
 * `pg_stat_activity` as one whose idle-in-transaction end its own client
 * reports — so the lock watch leaves it to that client — as opposed to any
 * other session (a CLI's, a psql shell's), which only the database side can
 * report.
 *
 * It survives PgBouncer: a client's STARTUP `application_name` is one of the
 * parameters PgBouncer re-applies to whichever server session it links the
 * client to (a `SET` would not survive transaction pooling). Every client of
 * one pool carries the same value, so it never churns. It names the
 * connection, never the caller: that is the origin comment's
 * (`tagSqlWithOrigin`).
 */
export function dbApplicationName(
  pool: DbPoolName,
  reportsOwnEnds: boolean,
): string {
  return `${reportsOwnEnds ? APPLICATION_NAME_PREFIX : CLI_APPLICATION_NAME_PREFIX}${pool}`;
}

/** Whether a session's `application_name` says its own client reports its end (`dbApplicationName(pool, true)`). */
export function isDbApplicationName(applicationName: string): boolean {
  return (
    applicationName.startsWith(APPLICATION_NAME_PREFIX) &&
    (DB_POOL_NAMES as readonly string[]).includes(
      applicationName.slice(APPLICATION_NAME_PREFIX.length),
    )
  );
}
