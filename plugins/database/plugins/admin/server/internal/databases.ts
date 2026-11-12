import { queryOne, queryRows } from "@plugins/database/plugins/sql-rows/core";
import { NAMESPACE_RE } from "@plugins/infra/plugins/namespace/core";
import { z } from "zod";
import { getAdminPool } from "./pool";
import { runDatabaseDdl } from "./database-ddl";
import { withPoolerHeld } from "./pooler-hold";

/**
 * Scratch databases the cluster mints for itself, as opposed to an app's.
 *
 * Two producers, both of which build the whole name out of hex/base-36 and
 * underscores, and both of which end the name with the suffix that names the
 * sweep responsible for reclaiming it: `forkTempName`
 * (`f_<sha8>_<rand8>__forking`, swept by `database.fork-temp-sweep`) and
 * `mintTestDbName` (`<prefix>_<pid>_<base36>__testdb`, swept by
 * `database.test-db-sweep`). A scratch database that no sweep can recognise is
 * one nothing ever reclaims, so the suffix is not decoration — it is the whole
 * of each sweeper's admission test. Capped at 63 like a namespace, and for the
 * same reason — Postgres truncates `datname` at 63 bytes silently, so a longer
 * name addresses a database other than the one it spells.
 *
 * A separate arm rather than a widened single regex: these are not namespaces
 * and must never be routable as one, and keeping them apart is what lets the app
 * arm below BE `NAMESPACE_RE` rather than a superset of it.
 */
const INTERNAL_DB_RE = /^[a-z0-9][a-z0-9_]{0,62}$/;

/**
 * The SQL-identifier boundary: every `CREATE`/`DROP DATABASE "${name}"` below
 * interpolates the name, so this is what stands between a caller-supplied string
 * and the cluster.
 *
 * An explicit allowlist of the two things a database in this cluster can BE —
 * never a `.*` with the dangerous characters subtracted, which is the spelling
 * that misses the next one.
 *
 * The app arm is literally `NAMESPACE_RE`, not a lookalike. A namespace IS the
 * database name (see `@plugins/infra/plugins/namespace/core`), so the two rules
 * are one rule with one owner and cannot drift — which is what the old
 * `/^[a-zA-Z0-9_-]+$/` could not say: it had already drifted, rejecting the
 * dotted `<composition>.<checkout>` namespaces the elision rule mints.
 */
function assertSafeName(name: string): void {
  if (NAMESPACE_RE.test(name) || INTERNAL_DB_RE.test(name)) return;
  throw new Error(`Unsafe database name: ${name}`);
}

export async function listDatabases(): Promise<string[]> {
  const rows = await queryRows(await getAdminPool(), {
    // `datname` is a `name`, not `text`; the cast keeps the column's decoded
    // type the one the schema below declares.
    sql: `SELECT datname::text AS datname FROM pg_database
     WHERE datname NOT IN ('template0', 'template1', 'postgres')
     ORDER BY datname`,
    row: z.object({ datname: z.string() }),
  });
  return rows.map((r) => r.datname);
}

export async function databaseExists(name: string): Promise<boolean> {
  assertSafeName(name);
  const result = await (
    await getAdminPool()
  ).query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  return result.rowCount !== null && result.rowCount > 0;
}

export async function dropDatabase(name: string): Promise<void> {
  assertSafeName(name);
  // Terminates the database's sessions, waits for them to exit, then removes
  // all of its files: the database-DDL bound, not the 60 s default.
  await runDatabaseDdl(
    `DROP DATABASE ${name} WITH (FORCE): terminates its sessions and removes its files`,
    `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`,
  );
}

// Create `name` if it does not already exist. `CREATE DATABASE` cannot run in a
// transaction and Postgres has no `IF NOT EXISTS` for databases, so the
// `databaseExists` guard is the idempotency mechanism; the `42P04`
// (duplicate_database) catch closes the TOCTOU window when a concurrent creator
// wins the race. Any other error is re-thrown loudly.
export async function ensureDatabase(name: string): Promise<void> {
  assertSafeName(name);
  if (await databaseExists(name)) return;
  try {
    // Copies the template database and waits on the database-object lock: the
    // database-DDL bound, not the 60 s default.
    await runDatabaseDdl(
      `CREATE DATABASE ${name}: copies the template database`,
      `CREATE DATABASE "${name}"`,
    );
  } catch (err) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as { code?: string }).code === "42P04"
    ) {
      return;
    }
    throw err;
  }
}

/**
 * Drop `name` and create it empty — one step as every client of the pooler
 * sees it: no login reaches the database while it is missing, so none can fail
 * and leave PgBouncer refusing the recreated database from its cached error
 * (see `withPoolerHeld`). A reset-to-empty must use this, never
 * `dropDatabase` then `ensureDatabase`.
 */
export async function recreateDatabase(name: string): Promise<void> {
  assertSafeName(name);
  await withPoolerHeld(name, async () => {
    await dropDatabase(name);
    await ensureDatabase(name);
  });
}

// On-disk size of `name` in bytes. For a sweep that is about to DROP a database
// this is the last moment the number exists, and "how much was this costing" is
// most of why anyone reads the report afterwards.
export async function databaseSizeBytes(name: string): Promise<number> {
  assertSafeName(name);
  // `pg_database_size` errors on a missing database rather than returning null,
  // which is the right shape: a caller asking the size of something that is not
  // there has a broken assumption, not a zero-byte database.
  const { bytes } = await queryOne(await getAdminPool(), {
    sql: "SELECT pg_database_size($1)::bigint::double precision AS bytes",
    params: [name],
    row: z.object({ bytes: z.number() }),
  });
  return bytes;
}

// Number of active backend connections to `name` (via pg_stat_activity). Used
// by the fork-temp sweep to avoid dropping a temp that an in-flight fork's
// pg_restore still holds a connection to.
export async function countActiveConnections(name: string): Promise<number> {
  // A bare aggregate always returns exactly one row, so an absent row is a
  // broken assumption rather than "no connections" — `queryOne` says so.
  const { n } = await queryOne(await getAdminPool(), {
    sql: "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1",
    params: [name],
    row: z.object({ n: z.number() }),
  });
  return n;
}
