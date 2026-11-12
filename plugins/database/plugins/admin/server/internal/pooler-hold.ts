import {
  PGBOUNCER_PORT,
  PGBOUNCER_SOCKET_DIR,
} from "@plugins/database/plugins/pgbouncer/server";
import { createDbClient } from "@plugins/database/plugins/connection/server";

/**
 * Run `work` while PgBouncer holds every login to database `name`.
 *
 * Why this exists: the pooler dials a database on its own (`min_pool_size`
 * refills a pool whose server connections a `DROP … WITH (FORCE)` just
 * terminated) and on every client's behalf. A login made while the database is
 * missing fails, and PgBouncer CACHES that failure for `server_login_retry`
 * (15 s): every client of the pool — the backend restarted onto the recreated
 * database included — is refused "server login has been failing, cached error:
 * database … does not exist" though the database exists again. That is how a
 * composition reset left its backend booted on no schema.
 *
 * `KILL <db>` drops the pool (its cached login failure with it) and pauses the
 * database, so no client and no refill dials it while `work` drops and
 * recreates it; `RESUME <db>` lets logins through again onto a fresh pool.
 * Connections a client held are cut — the caller restarts that backend anyway.
 *
 * The admin console is reached as the `pgbouncer` user over the Unix socket,
 * which PgBouncer admits for a client with its own uid (no `admin_users`
 * entry). It speaks the simple query protocol only, hence no parameters: the
 * name was validated by the caller and is quoted as an identifier.
 */
export async function withPoolerHeld<T>(
  name: string,
  work: () => Promise<T>,
): Promise<T> {
  const ident = `"${name.replaceAll('"', '""')}"`;
  const admin = createDbClient({
    name: "pgbouncer-admin",
    connectionString: `postgres://pgbouncer@/pgbouncer?host=${encodeURIComponent(PGBOUNCER_SOCKET_DIR)}&port=${PGBOUNCER_PORT}`,
  });
  await admin.connect();
  try {
    await admin.query(`KILL ${ident}`);
    try {
      return await work();
    } finally {
      await admin.query(`RESUME ${ident}`);
    }
  } finally {
    await admin.end();
  }
}
