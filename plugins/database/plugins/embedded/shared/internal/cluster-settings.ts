/**
 * How long Postgres lets a session sit idle inside an open transaction before
 * it terminates it (rolling back and releasing its locks) — the server-side
 * twin of the connection plugin's query deadline. An abandoned connection
 * (`database/connection`'s `abandon.ts`) is never closed and never sent a
 * ROLLBACK, so a transaction it was in stays open with its row locks for as
 * long as the process lives — on 2026-11-03 one such transaction blocked every
 * usage-sync writer, then the whole app pool, for five hours. Generous: no live
 * code sits idle in a transaction for minutes (long holders use session-level
 * advisory locks, which this does not touch; `pg_dump` / `pg_restore` set their
 * own 0).
 *
 * Interim: a bound around the abandon rule's flaw, removed once a lost
 * connection is closed instead of abandoned
 * (research/2026-11-04-global-db-connection-failure-vision.md, task 2).
 */
export const IDLE_IN_TRANSACTION_TIMEOUT_MS = 5 * 60_000;

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
  log_connections: LOG_CONNECTIONS,
};

/** The one call `applyClusterSettings` needs of a `pg` client. */
export interface ClusterSettingsClient {
  query(text: string): Promise<unknown>;
}

/**
 * Write `CLUSTER_SESSION_SETTINGS` to the cluster's `postgresql.auto.conf`
 * (`ALTER SYSTEM`) and reload it, so every session — new ones, and existing
 * ones that never `SET` the name themselves — takes them without a restart.
 * Idempotent; run by the start script on every start, reattach included, so a
 * running cluster picks up a changed value on the next gateway start. ALTER
 * SYSTEM writes a file under its own lock, not a catalog row, so even
 * concurrent callers cannot conflict. Superuser (the cluster's own user).
 */
export async function applyClusterSettings(
  client: ClusterSettingsClient,
): Promise<void> {
  for (const [name, value] of Object.entries(CLUSTER_SESSION_SETTINGS)) {
    await client.query(`ALTER SYSTEM SET ${name} = '${value}'`);
  }
  await client.query("SELECT pg_reload_conf()");
}
