import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  ensureDatabase,
  dropDatabase,
  openShortLivedClient,
} from "@plugins/database/plugins/admin/server";
import {
  buildConnectionString,
  readDatabaseConfig,
} from "@plugins/database/core";
import { mintTestDbName } from "../../core/internal/scratch-name";

// A throwaway, isolated database on the ALREADY-RUNNING gateway-owned cluster,
// for DB-backed test suites. The whole value of these tests is running the REAL
// SQL (triggers, NOTIFY, xid8 monotonicity, ON CONFLICT upsert, text[] round-trip,
// replay ordering) against a real Postgres — a fake `db` would prove nothing — so
// we provision an isolated database via admin's public barrel (the same primitives
// forkDatabase / the backup sources use), hand back a drizzle handle plus a raw
// libpq connection string, and drop the database after.
//
// `drop()` is the FAST path, not the guarantee. It runs in the suite's `afterAll`
// and so reclaims the database on every path the process survives — and on no
// other. The backstop for a killed run is the name itself: it is minted through
// `mintTestDbName`, which stamps it disposable and dated, and the
// `database.test-db-sweep` job (db-test-fixture/plugins/sweep) reclaims what a
// dead process left behind. See `../../core/internal/scratch-name.ts`.
export interface TestDb {
  db: NodePgDatabase;
  /**
   * Raw libpq connection string to THIS test database, for suites that open their
   * own `new Client({ connectionString })` (e.g. a dedicated LISTEN connection).
   * Same format `openShortLivedClient` uses internally, so a raw pg.Client
   * connects with it identically.
   */
  connectionString: string;
  drop(): Promise<void>;
}

export interface CreateTestDbOptions {
  /**
   * Short prefix for the generated database name so it stays identifiable in
   * Postgres logs / `\l` output (e.g. `"cf_test"` for the change-feed suite).
   * Defaults to `"db_test"`.
   */
  prefix?: string;
}

/** Provision a throwaway database on the running cluster: a drizzle handle, its connection string, and `drop()` for the suite's `afterAll`. */
export async function createTestDb(
  options: CreateTestDbOptions = {},
): Promise<TestDb> {
  const prefix = options.prefix ?? "db_test";
  // Unique per run: pid disambiguates parallel test processes, the base-36
  // timestamp disambiguates repeated runs within one process. `Date.now()` /
  // `process.pid` are available under bun:test (the `Date.now` ban is a
  // Workflow-script constraint only). Both facts, and the disposable-marker
  // suffix, are composed by the one module the sweep reads them back with.
  const name = mintTestDbName(prefix, process.pid, Date.now());

  try {
    await ensureDatabase(name);
  } catch (err) {
    // Loud, actionable failure — never a silent skip. If the cluster isn't up,
    // ensureDatabase can't reach `postgres` to CREATE the throwaway database.
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `createTestDb: could not provision throwaway database "${name}". ` +
        `These tests require a running embedded Postgres cluster — run ./equin build first. (${detail})`,
    );
  }

  const pool = openShortLivedClient(name);
  const db = drizzle(pool);
  const connectionString = buildConnectionString(
    readDatabaseConfig().connection,
    name,
  );

  return {
    db,
    connectionString,
    async drop() {
      await pool.end();
      await dropDatabase(name);
    },
  };
}
