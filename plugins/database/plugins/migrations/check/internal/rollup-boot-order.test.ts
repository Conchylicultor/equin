/**
 * The boot-layer writer-order oracle (C12 / D25). During a hot swap the old
 * backend keeps writing the rollup source tables while the new one's schema
 * layer — ONE transaction — installs their triggers, and a lock it takes is
 * held until that transaction commits. The layer therefore installs the source
 * tables one savepoint each, in a FIXED order (by name), and only the tables
 * whose triggers changed.
 *
 *  - a writer taking the tables in that same order never deadlocks with it:
 *    the layer waits for the writer, then completes;
 *  - unchanged triggers take no source lock at all: a writer holding one open
 *    cannot even delay the layer;
 *  - a writer in the opposite order closes a cycle; Postgres aborts the layer,
 *    which fails LOUDLY naming the table — never a hang, never a silent skip.
 *
 * Two synthetic rollups over `conversations` and `pushes` stand in for the real
 * ones (the same two source tables).
 *
 * It sits in migrations/check/ (beside the schema-layer suites) rather than in
 * derived-tables: derived-tables is upstream of `database`, so a suite there
 * importing db-test-fixture (→ admin → database → migrations → derived-tables)
 * would close an import cycle.
 *
 * Requires the running embedded cluster (`./equin build` first).
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { Client } from "pg";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import {
  ATTEMPT_CONV_AGG_TABLE,
  ATTEMPT_PUSH_AGG_TABLE,
  DERIVED_TABLE_OBJECT_STATE_TABLE,
} from "@plugins/database/plugins/derived-views/core";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { defineRollup } from "@plugins/database/plugins/derived-tables/core";
import { rebuildDerivedTables } from "@plugins/database/plugins/derived-tables/server";

const conversations = pgTable("conversations", {
  id: text("id").primaryKey(),
  attemptId: text("attempt_id").notNull(),
  status: text("status").notNull(),
});
const pushes = pgTable("pushes", {
  id: text("id").primaryKey(),
  attemptId: text("attempt_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
const convAgg = pgTable(ATTEMPT_CONV_AGG_TABLE, {
  attemptId: text("attempt_id").primaryKey(),
  hasConv: boolean("has_conv").notNull(),
});
const pushAgg = pgTable(ATTEMPT_PUSH_AGG_TABLE, {
  attemptId: text("attempt_id").primaryKey(),
  hasPush: boolean("has_push").notNull(),
});

const rollups = [
  defineRollup({
    table: convAgg,
    key: convAgg.attemptId,
    select: (scope) =>
      `SELECT c.attempt_id, true AS has_conv FROM conversations c WHERE ${scope("c.attempt_id")} GROUP BY c.attempt_id`,
    sources: [
      {
        table: conversations,
        carry: conversations.attemptId,
        reads: [conversations.status],
      },
    ],
  }),
  defineRollup({
    table: pushAgg,
    key: pushAgg.attemptId,
    select: (scope) =>
      `SELECT p.attempt_id, true AS has_push FROM pushes p WHERE ${scope("p.attempt_id")} GROUP BY p.attempt_id`,
    sources: [
      { table: pushes, carry: pushes.attemptId, reads: [pushes.createdAt] },
    ],
  }),
];

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "rollup_boot_order" });
  await t.db.execute(
    sql.raw(
      `CREATE TABLE conversations (id text PRIMARY KEY, attempt_id text NOT NULL, status text NOT NULL)`,
    ),
  );
  await t.db.execute(
    sql.raw(
      `CREATE TABLE pushes (id text PRIMARY KEY, attempt_id text NOT NULL, created_at timestamptz NOT NULL)`,
    ),
  );
  await t.db.execute(
    sql.raw(`INSERT INTO conversations VALUES ('c1', 'a1', 'working')`),
  );
});

afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  await rebuildDerivedTables(t.db, rollups);
});

// Make the next layer reinstall every source table's triggers, as a boot with
// a changed rollup definition would.
async function forgetTriggerSignatures(): Promise<void> {
  await t.db.execute(
    sql.raw(
      `DELETE FROM "${DERIVED_TABLE_OBJECT_STATE_TABLE}" WHERE name LIKE 'triggers:%'`,
    ),
  );
}

async function connect(): Promise<{ client: Client; pid: number }> {
  const client = new Client({ connectionString: t.connectionString });
  await client.connect();
  const pid = (
    await client.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)
  ).rows[0]!.pid;
  return { client, pid };
}

// The schema layer: the rollup install inside ONE transaction on its own
// connection, as `applySchemaLayer` runs it.
function runLayer(client: Client): Promise<unknown> {
  return drizzle(client).transaction((tx) => rebuildDerivedTables(tx, rollups));
}

async function waitUntilBlocked(pid: number): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const rows = await executeRows(t.db, {
      query: sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}`,
      row: z.object({ wait_event_type: z.string().nullable() }),
    });
    if (rows[0]?.wait_event_type === "Lock") return;
    await Bun.sleep(10);
  }
  throw new Error(`backend ${pid} never blocked on a lock`);
}

describe("boot layer vs a hot-swap writer", () => {
  test("a writer in the fixed order (conversations, then pushes) never deadlocks: the layer waits, then completes", async () => {
    await forgetTriggerSignatures();
    const writer = await connect();
    const layer = await connect();
    try {
      await writer.client.query("BEGIN");
      await writer.client.query(
        `UPDATE conversations SET status = 'waiting' WHERE id = 'c1'`,
      );
      const done = runLayer(layer.client);
      await waitUntilBlocked(layer.pid); // on conversations, behind the writer
      await writer.client.query(
        `INSERT INTO pushes VALUES ('p1', 'a1', now())`,
      ); // pushes is not held by the layer yet
      await writer.client.query("COMMIT");
      await done;
    } finally {
      await writer.client.end();
      await layer.client.end();
    }
  });

  test("unchanged triggers take no source lock: an open writer cannot delay the layer", async () => {
    const writer = await connect();
    const layer = await connect();
    try {
      await writer.client.query("BEGIN");
      await writer.client.query(
        `UPDATE conversations SET status = 'done' WHERE id = 'c1'`,
      );
      await writer.client.query(
        `INSERT INTO pushes VALUES ('p2', 'a1', now())`,
      );
      // Any source lock would wait on the writer and trip this.
      await layer.client.query(`SET lock_timeout = '500ms'`);
      await runLayer(layer.client);
      await writer.client.query("COMMIT");
    } finally {
      await writer.client.end();
      await layer.client.end();
    }
  });

  test("a writer in the opposite order fails the layer loudly, naming the table", async () => {
    await forgetTriggerSignatures();
    const writer = await connect();
    const layer = await connect();
    try {
      await writer.client.query("BEGIN");
      await writer.client.query(
        `INSERT INTO pushes VALUES ('p3', 'a1', now())`,
      );
      const done = runLayer(layer.client).then(
        () => null,
        (e: unknown) => e,
      );
      // The layer takes conversations, then waits on pushes behind the writer.
      await waitUntilBlocked(layer.pid);
      // The writer now waits on conversations behind the layer: a cycle.
      const writerDone = writer.client.query(
        `UPDATE conversations SET status = 'gone' WHERE id = 'c1'`,
      );
      const err = await done;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(
        /installing the rollup triggers on "pushes" failed/,
      );
      expect((err as Error).message).toMatch(/deadlock/);
      await writerDone;
      await writer.client.query("COMMIT");
    } finally {
      await writer.client.end();
      await layer.client.end();
    }
  }, 20_000);
});
