// The closed set of backend database connections. Every pool and standalone
// client built through `createDbPool` / `createDbClient` names itself with one
// of these, and every deadline report names the pool it came from. A closed
// list both runtimes read (the server labels, the reports UI displays), so it
// is plain data rather than a slot.

/** Every backend connection's name, in no particular order. */
export const DB_POOL_NAMES = [
  /** The app pool behind `db` (through pgbouncer). */
  "app",
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
 * The two calls a deadline bounds: opening a connection (`connect`) and a
 * statement on an open one (`query`).
 */
export const DB_CALL_PHASES = ["connect", "query"] as const;

export type DbCallPhase = (typeof DB_CALL_PHASES)[number];
