/**
 * The cluster-wide session settings reach a database created after them, and
 * applying them concurrently cannot conflict.
 *
 * Runs `applyClusterSettings` against the live cluster — the same idempotent
 * write the start script makes on every cluster start, with the same values,
 * so it changes nothing a gateway start would not — from several sessions at
 * once, then creates a database and opens a fresh session on it.
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

beforeAll(async () => {
  // Concurrent applications, each on its own session: all succeed.
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
});

test("a new session on a database created after them carries every setting", async () => {
  await withSession(testDb, async (client) => {
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
