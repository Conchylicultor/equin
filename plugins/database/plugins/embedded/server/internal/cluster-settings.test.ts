/**
 * The cluster-wide session settings reach a database created after them, and
 * applying them concurrently cannot conflict.
 *
 * Runs `applyClusterSettings` against the live cluster — the same idempotent
 * write the start script makes on every cluster start, with the same values,
 * so it changes nothing a gateway start would not — once, then from several
 * sessions at once, then creates a database and opens a fresh session on it.
 *
 * Run: `./equin test plugins/database/plugins/embedded`.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "pg";
import { z } from "zod";
import { queryOne } from "@plugins/database/plugins/sql-rows/core";
import {
  applyClusterSettings,
  CLUSTER_SESSION_SETTINGS,
  IDLE_IN_TRANSACTION_TIMEOUT_MS,
  RETIRED_CLUSTER_SETTINGS,
} from "../../shared/internal/cluster-settings";
import { PG_PORT, PG_SOCKET_DIR, PG_USER } from "../../shared";

// Raw superuser sessions on the cluster's own socket, as the start script
// opens them: this plugin sits below the admin pool and the test-db fixture
// (both reach it through `database/connection`), so it cannot use them.
async function withSession<T>(
  database: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({
    host: PG_SOCKET_DIR,
    port: PG_PORT,
    user: PG_USER,
    database,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const testDb = `cluster_settings_test_${process.pid}_${Date.now().toString(36)}`;
// A database left with its own copy of a cluster setting — what the first,
// per-database version of the idle-in-transaction timeout left behind. A copy
// would override the cluster's value there. (Only settings a database may carry:
// `log_connections` is read at connection start and refuses one.)
const legacyDb = `${testDb}_legacy`;
const LEGACY_COPIES: Readonly<Record<string, string>> = {
  idle_in_transaction_session_timeout: "1min",
  client_connection_check_interval: "1min",
  ...Object.fromEntries(RETIRED_CLUSTER_SETTINGS.map((name) => [name, "1min"])),
};

beforeAll(async () => {
  await withSession("postgres", async (c) => {
    await c.query(`CREATE DATABASE "${legacyDb}"`);
    for (const [name, value] of Object.entries(LEGACY_COPIES)) {
      await c.query(`ALTER DATABASE "${legacyDb}" SET ${name} = '${value}'`);
    }
  });
  // One application resets every retired copy (a catalog write per database
  // carrying one); after it, concurrent applications — each on its own
  // session — have no catalog row left to write, and all succeed.
  await withSession("postgres", applyClusterSettings);
  await Promise.all(
    Array.from({ length: 4 }, () =>
      withSession("postgres", applyClusterSettings),
    ),
  );
  // Created after them: a database nobody ever set anything on.
  await withSession("postgres", (c) => c.query(`CREATE DATABASE "${testDb}"`));
});

afterAll(async () => {
  await withSession("postgres", (c) =>
    c.query(`DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`),
  );
  await withSession("postgres", (c) =>
    c.query(`DROP DATABASE IF EXISTS "${legacyDb}" WITH (FORCE)`),
  );
});

test("a new session carries every setting from the cluster's file — on a database created after them, and on one that had its own copy", async () => {
  for (const database of [testDb, legacyDb])
    await withSession(database, async (client) => {
      for (const [name, value] of Object.entries(CLUSTER_SESSION_SETTINGS)) {
        const row = await queryOne(client, {
          sql: "SELECT setting, unit, source FROM pg_settings WHERE name = $1",
          params: [name],
          row: z.object({
            setting: z.string(),
            unit: z.string().nullable(),
            source: z.string(),
          }),
        });
        expect(`${row.setting}${row.unit ?? ""}`).toBe(value);
        // The cluster's file, not a per-database override.
        expect(row.source).toBe("configuration file");
      }
    });
});

test("the idle-in-transaction timeout is the cluster's bound", () => {
  expect(CLUSTER_SESSION_SETTINGS.idle_in_transaction_session_timeout).toBe(
    `${IDLE_IN_TRANSACTION_TIMEOUT_MS}ms`,
  );
});

// None is retired today: the test runs again the day one is.
test.skipIf(RETIRED_CLUSTER_SETTINGS.length === 0)(
  "a retired setting is gone: from the cluster's file and from a database's own copy",
  async () => {
    for (const database of [testDb, legacyDb]) {
      await withSession(database, async (client) => {
        for (const name of RETIRED_CLUSTER_SETTINGS) {
          const row = await queryOne(client, {
            sql: "SELECT source FROM pg_settings WHERE name = $1",
            params: [name],
            row: z.object({ source: z.string() }),
          });
          expect(row.source).toBe("default");
        }
      });
    }
  },
);
