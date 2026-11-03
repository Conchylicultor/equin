import { withQueryDeadline } from "@plugins/database/plugins/connection/server";
import { getAdminPool } from "./pool";

/**
 * The bound a whole-database DDL statement runs under, in place of the
 * connection plugin's 60 s default.
 *
 * These statements do work proportional to a DATABASE, not to a row, and some
 * of it is waiting nobody here controls:
 *
 * - `CREATE DATABASE` copies its template block by block, and waits for the
 *   lock on the database object behind any other create / drop / rename.
 * - `DROP DATABASE … WITH (FORCE)` terminates the database's sessions and waits
 *   for them to exit, then removes every file of a database that can be
 *   gigabytes (a fork, a composition's data).
 * - `ALTER DATABASE … RENAME` waits for that same database-object lock.
 *
 * Under a loaded host (a build, forks and restores running at once) each can
 * legitimately outlast a minute. Ten minutes still turns a truly silent
 * connection into a report instead of a fork job that holds its slot for hours.
 */
export const DATABASE_DDL_QUERY_DEADLINE_MS = 10 * 60_000;

/**
 * Run one whole-database DDL statement on the admin pool under the database-DDL
 * bound, naming `what` on any deadline report.
 *
 * The statement runs on a client checked out with `await pool.connect()`, not
 * through `pool.query`. The bound is read from an `AsyncLocalStorage` scope at
 * the moment the statement is issued, and pg-pool's own `query` issues it from
 * its checkout callback — which, when the one-connection admin pool is busy,
 * runs later in the context of whoever released the connection, so the scope
 * would be lost and the 60 s default applied. An awaited checkout resumes in
 * this scope.
 */
export async function runDatabaseDdl(what: string, sql: string): Promise<void> {
  await withQueryDeadline(
    { ms: DATABASE_DDL_QUERY_DEADLINE_MS, reason: what },
    async () => {
      const client = await getAdminPool().connect();
      try {
        await client.query(sql);
      } finally {
        client.release();
      }
    },
  );
}
