import { z } from "zod";
import {
  queryRows,
  type SqlQueryable,
} from "@plugins/database/plugins/sql-rows/core";

/**
 * How often Postgres checks, while a statement runs, that its client is still
 * there — and cancels the statement if not. Without it a session whose client
 * went away keeps executing (or waiting on a lock) until the statement
 * finishes, and notices only when it tries to send the result.
 *
 * Why: a call that misses its deadline has its connection CLOSED
 * (`database/connection`), so the server ends the session, rolls its
 * transaction back and frees its locks. An idle session sees the close at
 * once; one mid-statement — waiting on a row lock behind another transaction,
 * or still running — would otherwise go on holding what it already took,
 * possibly for as long as it waits. A check is a poll() of the session's
 * socket between steps of execution, negligible against a statement that has
 * run this long.
 */
export const CLIENT_CONNECTION_CHECK_INTERVAL_MS = 10_000;

/**
 * What Postgres logs about each new connection (PG 18's list form of
 * `log_connections`): `receipt` when the postmaster accepts the socket, and
 * `setup_durations` once the backend is ready — total setup, fork and
 * authentication times. Read at session start, so it is a session setting too.
 *
 * Why: on 2026-11-04 every new direct connection on the cluster went
 * unanswered for about a minute while open sessions kept answering, and
 * Postgres's log said nothing: there was no telling whether the postmaster
 * never accepted the sockets or the backends were slow to start. With both, the
 * next stall shows which: a connection with no `connection received` line was
 * never accepted; one received but slow to be ready names the phase.
 *
 * Not `authentication` / `authorization`: under `trust` they add two lines per
 * connection that `setup_durations` already times.
 */
export const LOG_CONNECTIONS = "receipt,setup_durations";

/**
 * How long a session may sit idle INSIDE a transaction — between two of its
 * statements, nothing pending — before Postgres ends it (rolling the
 * transaction back, releasing its locks and its PgBouncer slot).
 *
 * A BOUND around app code that stalls, not a fix for anything. The client-side
 * deadline (`database/connection`) bounds a call in flight; nothing on the
 * client bounds the time between two statements of a transaction whose code is
 * alive but waiting on something else, or wedged. Such a transaction holds its
 * row locks — every write to those rows fails its own deadline, every minute —
 * and one lane slot (8 interactive / 10 background per database), and while
 * it holds them (both measured 2026-11-04):
 *   - a migration altering a table it touched, even only read, waits on it —
 *     and queues every other statement on that table behind its own lock
 *     request; 5 min stays well inside boot DDL's 15 min bound;
 *   - if it wrote, its xid pins `pg_snapshot_xmin` — the live-update
 *     watermark — for EVERY database of the cluster (xids are cluster-wide),
 *     so watermark-confirmed optimistic ops wait and L2's changelog cannot be
 *     pruned until it ends.
 *
 * Every session it ends is reported, naming the code: the session's own client
 * sees the server end it (`database/connection`'s `idleTransactionEndedSink`)
 * and the lock watch sees it vanish (`database/lock-watch`) — a reap is never
 * silent. 5 min: far past any transaction the app means to hold (the lock
 * watch names one idle past 60 s), well inside the boot DDL bound.
 *
 * History: first an interim backstop for connections ABANDONED on a missed
 * deadline (2026-11-04, unreported), retired when lost connections began to
 * be closed, restored the same day as this bound, reported.
 */
export const IDLE_IN_TRANSACTION_TIMEOUT_MS = 5 * 60_000;

/**
 * The session settings every session on every database of the cluster starts
 * with. A CLUSTER setting, owned by the one act that brings the cluster up:
 * set per database it would need a writer per database — and the writer was
 * every process that booted the DB layer, whose concurrent `ALTER DATABASE`
 * updates of the same `pg_db_role_setting` row failed one boot with
 * `tuple concurrently updated` (2026-11-04). It would also miss every fork
 * until its first backend booted: a database's own settings are not part of
 * what a fork copies (pg_dump without `--create`).
 */
export const CLUSTER_SESSION_SETTINGS: Readonly<Record<string, string>> = {
  idle_in_transaction_session_timeout: `${IDLE_IN_TRANSACTION_TIMEOUT_MS}ms`,
  client_connection_check_interval: `${CLIENT_CONNECTION_CHECK_INTERVAL_MS}ms`,
  log_connections: LOG_CONNECTIONS,
};

/**
 * Settings this cluster once carried and must no longer: reset on every start,
 * in the cluster's file AND on every database still carrying its own copy.
 * None today.
 */
export const RETIRED_CLUSTER_SETTINGS: readonly string[] = [];

/** What `applyClusterSettings` needs of a `pg` client. */
export type ClusterSettingsClient = SqlQueryable;

/**
 * Write `CLUSTER_SESSION_SETTINGS` to the cluster's `postgresql.auto.conf`
 * (`ALTER SYSTEM`) and reload it, so every session — new ones, and existing
 * ones that never `SET` the name themselves — takes them without a restart.
 * Idempotent; run by the start script on every start, reattach included, so a
 * running cluster picks up a changed value on the next gateway start. ALTER
 * SYSTEM writes a file under its own lock, not a catalog row, so concurrent
 * callers cannot conflict on it; a per-database reset (of a cluster setting's
 * or a retired setting's copy) IS a catalog write, made only while a database
 * still carries one — once, by the one start script. Superuser (the
 * cluster's own user).
 */
export async function applyClusterSettings(
  client: ClusterSettingsClient,
): Promise<void> {
  for (const [name, value] of Object.entries(CLUSTER_SESSION_SETTINGS)) {
    await client.query(`ALTER SYSTEM SET ${name} = '${value}'`);
    // A per-database copy would override the cluster's value on that database:
    // the cluster owns it. (The first idle-in-transaction timeout was set per
    // database at boot; databases that booted that build still carry one.)
    await resetOnEveryDatabase(client, name);
  }
  for (const name of RETIRED_CLUSTER_SETTINGS) {
    await client.query(`ALTER SYSTEM RESET ${name}`);
    await resetOnEveryDatabase(client, name);
  }
  await client.query("SELECT pg_reload_conf()");
}

/**
 * `ALTER DATABASE … RESET name` on each database whose own settings carry
 * `name` — only those, so a start where none does writes no catalog row. A
 * session already open keeps the value it started with; every new one drops it.
 */
async function resetOnEveryDatabase(
  client: ClusterSettingsClient,
  name: string,
): Promise<void> {
  const rows = await queryRows(client, {
    sql:
      "SELECT d.datname FROM pg_db_role_setting s " +
      "JOIN pg_database d ON d.oid = s.setdatabase " +
      "WHERE s.setrole = 0 AND EXISTS " +
      "(SELECT 1 FROM unnest(s.setconfig) c WHERE split_part(c, '=', 1) = $1)",
    params: [name],
    row: z.object({ datname: z.string() }),
  });
  for (const { datname } of rows) {
    try {
      await client.query(
        `ALTER DATABASE "${datname.replaceAll('"', '""')}" RESET ${name}`,
      );
    } catch (err) {
      // A backend of a build from before the setting moved to the cluster
      // still `ALTER DATABASE … SET`s it at boot, and the same
      // `pg_db_role_setting` row updated by both at once fails one with this.
      // The cluster start must not fail on it: said on stderr (the start
      // script's log), and the next start resets it again.
      if (!isConcurrentRowUpdate(err)) throw err;
      process.stderr.write(
        `[cluster-settings] ${name} on database "${datname}" not reset: its ` +
          "settings row was updated concurrently; the next cluster start retries\n",
      );
    }
  }
}

function isConcurrentRowUpdate(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return code === "XX000" && err.message === "tuple concurrently updated";
}
