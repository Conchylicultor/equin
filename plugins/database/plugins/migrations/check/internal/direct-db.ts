import { Pool } from "pg";
// Connect via the database CORE barrel, not admin/server: the admin pool module
// throws at import time if the retired worktree variable is unset, which is the norm in a
// tooling/check subprocess. The core barrel exposes exactly the config→connstring
// helpers for non-backend consumers and is import-safe by design.
import {
  buildConnectionString,
  readDatabaseConfig,
} from "@plugins/database/core";

// The one connect bound for every direct DB connection a check opens.
//
// It is a wall-clock timer, and it counts on the CHECK PROCESS's own event loop
// — the single JS thread a full check pass shares between ~100 concurrently
// started checks. That thread stays saturated for the first 8–16 s of a pass
// (observed 2026-09-10: not even the most trivial check finished before 7.5 s),
// so a 5 s bound expired against a healthy Postgres that had answered in
// milliseconds: the process simply could not read the answer before its own
// timer fired, and the check aborted the whole run.
//
// 60 s equals Postgres's own `authentication_timeout`: past it the server has
// already dropped a connection that sent nothing, so a longer client bound buys
// nothing. It also bounds the checks that previously had no connect timeout at
// all and could hang forever.
// See research/2026-09-11-global-check-db-connect-timeout-aborts-run.md.
export const DIRECT_CONNECT_TIMEOUT_MS = 60_000;

// What a check gets back from a direct DB connection. Every arm is a distinct
// fact the check must map to its own verdict:
//   - ok          — connected; `value` is what `fn` returned.
//   - unreachable — could not open a connection at all (cluster down, socket
//                   missing, connect timeout, …). `cause` names why and how
//                   long the attempt took.
//   - no-database — the cluster answered, but the database does not exist
//                   (3D000), e.g. a worktree whose DB was never forked.
export type DirectDbResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "unreachable"; cause: string }
  | { kind: "no-database" };

// Run `fn` against a direct (non-pgbouncer) max:1 pool on `database` in the
// configured cluster. See withDirectConnection for the classification contract.
export async function withDirectDb<T>(
  database: string,
  fn: (pool: Pool) => Promise<T>,
): Promise<DirectDbResult<T>> {
  return withDirectConnection(
    buildConnectionString(readDatabaseConfig().connection, database),
    fn,
  );
}

// The connection-string form behind withDirectDb, kept separate so a test can
// point it at a cluster that does not exist. Checks call withDirectDb.
//
// Classification is STRUCTURAL, never a guess from error codes: one client is
// opened and released BEFORE `fn` runs, and only an error from that probe is
// classified (`no-database` for 3D000, `unreachable` for anything else). Every
// error `fn` throws propagates unchanged — the query is what the check is
// about, so its failure is the check's to report, not a connectivity verdict.
export async function withDirectConnection<T>(
  connectionString: string,
  fn: (pool: Pool) => Promise<T>,
): Promise<DirectDbResult<T>> {
  const pool = new Pool({
    connectionString,
    max: 1,
    idleTimeoutMillis: 1_000,
    connectionTimeoutMillis: DIRECT_CONNECT_TIMEOUT_MS,
  });
  // Short-lived check pool: an idle-client reset AFTER the verdict is computed
  // (e.g. the socket dropping during teardown) must not crash the check
  // process via an unhandled 'error' event. This hides no verdict-affecting
  // failure — the probe below classifies every connect error, and every error
  // from `fn` propagates to the caller.
  pool.on("error", () => {
    /* ignore post-verdict idle-client errors on this disposable pool */
  });
  try {
    const started = performance.now();
    try {
      const client = await pool.connect();
      client.release();
    } catch (e) {
      if ((e as { code?: unknown }).code === "3D000") {
        return { kind: "no-database" };
      }
      const elapsedMs = Math.round(performance.now() - started);
      const message = e instanceof Error ? e.message : String(e);
      return {
        kind: "unreachable",
        cause: `${message} (after ${elapsedMs} ms)`,
      };
    }
    return { kind: "ok", value: await fn(pool) };
  } finally {
    await pool.end();
  }
}
