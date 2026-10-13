/**
 * Exposed columns against a REAL Postgres: what the recording `QueryDb` of
 * `serve-collection-exposed.test.ts` cannot tell — that the SQL runs. A
 * grouping over an exposed column groups by a `COALESCE(col, $absent)`
 * expression; it is named by its ordinal in GROUP BY / ORDER BY, so its bound
 * `absent` renders once and Postgres reads one expression. Checked for a base
 * exposure (number, absent 0) and a related one (text through the `task`
 * lookup, absent "main"), and a window filter on the absent value.
 *
 * createTestDb() throws loudly when the database is unreachable.
 * Run: `./singularity test plugins/network/plugins/live`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { Client } from "pg";
import { z } from "zod";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { enumTextField } from "@plugins/fields/plugins/text/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import type { LookupJoin } from "@plugins/infra/plugins/query-resource/core";
import type { QueryDb } from "@plugins/infra/plugins/query-resource/server";
import { compileWindowQuery } from "@plugins/infra/plugins/query-resource/server/testing";
import {
  exposedColumns,
  liveCollection,
  LIVE_COLUMNS_KEY,
} from "@plugins/network/plugins/live/core";
import { compileCollection } from "./serve-collection";

const tasks = pgTable("xpdb_tasks", {
  id: text("id").primaryKey(),
});
const attempts = pgTable("xpdb_attempts", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
});
const conversations = pgTable("xpdb_conversations", {
  id: text("id").primaryKey(),
  attemptId: text("attempt_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
const tasksRef = entityRef("xpdb_tasks");
const conversationsRef = entityRef("xpdb_conversations");

const track = defineExtension(
  tasks,
  "track",
  defineExtensionShape({
    key: "taskId",
    fields: { track: enumTextField(["sidequest"] as const) },
    exposes: {
      parent: tasksRef,
      name: "track",
      fields: { track: { label: "Track", absent: "main" } },
    },
  }),
);
const usage = defineExtension(
  conversations,
  "usage",
  defineExtensionShape({
    key: "conversationId",
    fields: { cost: intField() },
    exposes: {
      parent: conversationsRef,
      name: "usage",
      fields: { cost: { label: "Cost", absent: 0 } },
    },
  }),
  { columns: { cost: { default: 0 } } },
);

const ownerJoins = [
  {
    kind: "lookup",
    alias: "attempt",
    table: attempts,
    pk: attempts.id,
    on: { from: "base", col: conversations.attemptId },
    required: true,
  } satisfies LookupJoin<"attempt", typeof attempts>,
  {
    kind: "lookup",
    alias: "task",
    table: tasks,
    pk: tasks.id,
    on: { from: "attempt", col: attempts.taskId },
    required: true,
  } satisfies LookupJoin<"task", typeof tasks>,
] as const;

const list = liveCollection("test.live.exposed-db", {
  row: z.object({ id: z.string(), createdAt: z.date() }),
  id: "id",
  filterable: {},
  sortable: ["createdAt"],
  default: { orderBy: [["createdAt", "desc"]], limit: 10 },
  maxLimit: 30,
  exposes: { base: conversationsRef, task: tasksRef },
});
const TRACK = "xpdb_tasks_ext_track.track";
const COST = "xpdb_conversations_ext_usage.cost";
const columns = [
  exposedColumns(track.exposure),
  exposedColumns(usage.exposure),
];

let testDb: TestDb;
let client: Client;
let db: NodePgDatabase;

beforeAll(async () => {
  testDb = await createTestDb({ prefix: "live_exposed_db_test" });
  client = new Client({ connectionString: testDb.connectionString });
  await client.connect();
  db = drizzle(client);
  // Three tasks — one sidequest, two main (no track row) — one conversation
  // each, the sidequest's and one main's with a usage row.
  await db.execute(
    sql.raw(
      `CREATE TABLE xpdb_tasks (id text PRIMARY KEY);
       CREATE TABLE xpdb_attempts (id text PRIMARY KEY, task_id text NOT NULL);
       CREATE TABLE xpdb_conversations (id text PRIMARY KEY, attempt_id text NOT NULL,
                                        created_at timestamptz NOT NULL);
       CREATE TABLE xpdb_tasks_ext_track (parent_id text PRIMARY KEY, track text NOT NULL,
         created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
       CREATE TABLE xpdb_conversations_ext_usage (parent_id text PRIMARY KEY, cost integer NOT NULL DEFAULT 0,
         created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
       INSERT INTO xpdb_tasks VALUES ('t1'), ('t2'), ('t3');
       INSERT INTO xpdb_attempts VALUES ('a1', 't1'), ('a2', 't2'), ('a3', 't3');
       INSERT INTO xpdb_conversations VALUES
         ('c1', 'a1', '2026-10-12T10:00:00Z'),
         ('c2', 'a2', '2026-10-12T11:00:00Z'),
         ('c3', 'a3', '2026-10-12T12:00:00Z');
       INSERT INTO xpdb_tasks_ext_track (parent_id, track) VALUES ('t1', 'sidequest');
       INSERT INTO xpdb_conversations_ext_usage (parent_id, cost) VALUES ('c1', 7), ('c2', 7);`,
    ),
  );
});

afterAll(async () => {
  await client?.end();
  await testDb?.drop();
});

const compiled = () =>
  compileCollection(
    list,
    { from: conversations, joins: ownerJoins, db: db as unknown as QueryDb },
    [],
    [],
    [track, usage],
  );

describe("exposed columns on a real database", () => {
  test("a grouping on a related exposure counts the absent value as its own group", async () => {
    const specs = compiled();
    const params = list.groups.groups.encode({
      groupBy: TRACK as never,
      columns,
    });
    expect(await specs.groups.loader(params)).toEqual([
      { value: "main", count: 2 },
      { value: "sidequest", count: 1 },
    ]);
  });

  test("a grouping on a base exposure, under a filter on the related one", async () => {
    const specs = compiled();
    expect(
      await specs.groups.loader(
        list.groups.groups.encode({ groupBy: COST as never, columns }),
      ),
    ).toEqual([
      { value: 7, count: 2 },
      { value: 0, count: 1 },
    ]);
    expect(
      await specs.groups.loader(
        list.groups.groups.encode({
          groupBy: COST as never,
          where: { [TRACK]: "main" } as never,
          columns,
        }),
      ),
    ).toEqual([
      { value: 0, count: 1 },
      { value: 7, count: 1 },
    ]);
  });

  test("a window filtered on the absent value lists the rows with no side row", async () => {
    const specs = compiled();
    const window = compileWindowQuery(list.window, specs.window).serverOpts;
    const rows = (await window.loader(
      list.window.window.encode({
        where: { [TRACK]: "main" } as never,
        columns,
      }),
    )) as Record<string, unknown>[];
    // The loader hands rows out folded: `$columns[<slice>][<field>]`.
    expect(rows.map((r) => [r.id, r[LIVE_COLUMNS_KEY]])).toEqual([
      [
        "c3",
        {
          xpdb_conversations_ext_usage: { cost: 0 },
          xpdb_tasks_ext_track: { track: "main" },
        },
      ],
      [
        "c2",
        {
          xpdb_conversations_ext_usage: { cost: 7 },
          xpdb_tasks_ext_track: { track: "main" },
        },
      ],
    ]);
  });
});
