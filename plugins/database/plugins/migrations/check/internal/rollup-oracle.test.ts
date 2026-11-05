/**
 * The define-rollup oracle: the SQL `defineRollup` generates, run against a
 * throwaway database, for a rollup shaped like step 21's
 * `task_latest_conversation` — a `conversations` source mapped to the task
 * through `attempts` (the via hop), plus an `attempts` source carrying the task
 * id itself (update + delete), which is what a hop read at trigger time needs
 * to survive an RI cascade (W8).
 *
 * At every step the rollup must equal the aggregate recomputed from scratch.
 * Pinned besides: a write to a column the rollup does not read, or one that
 * does not change the aggregate, leaves the rollup row untouched (its xmin);
 * a clean reconcile writes nothing; a drifted rollup is healed with exact
 * counts, and a heal racing a writer of the same key waits for it rather than
 * overwrite it from an older snapshot; two concurrent writers of one key never
 * lose an update (A34); the install (the one trigger installer, db-triggers)
 * reinstates a trigger dropped or altered out of band and a maintain function
 * replaced out of band, drops a stray trigger calling a maintain function, and
 * a sweep drops a rollup nobody declares any more; a select that reads an undeclared
 * column or table, or returns a column the table lacks, is refused; and the
 * older builds' one-row state table is emptied, never reshaped.
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
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import {
  DERIVED_TABLE_OBJECT_STATE_TABLE,
  DERIVED_TABLE_STATE_TABLE,
  TASK_LATEST_CONVERSATION_TABLE,
} from "@plugins/database/plugins/derived-views/core";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { sha256Hex } from "@plugins/packages/plugins/string-hash/core";
import { defineRollup } from "@plugins/database/plugins/derived-tables/core";
import { installRollups } from "@plugins/database/plugins/derived-tables/server/testing";
import { installDbTriggers } from "@plugins/database/plugins/db-triggers/server";

const attempts = pgTable("attempts", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
});
const conversations = pgTable("conversations", {
  id: text("id").primaryKey(),
  attemptId: text("attempt_id").notNull(),
  kind: text("kind").notNull(),
  title: text("title"),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  waitingFor: text("waiting_for"),
});
const latest = pgTable(TASK_LATEST_CONVERSATION_TABLE, {
  taskId: text("task_id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  title: text("title"),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

const SELECT_LATEST = (where: string) => `
  SELECT DISTINCT ON (a.task_id)
         a.task_id, c.id AS conversation_id, c.title, c.status, c.created_at
    FROM conversations c JOIN attempts a ON a.id = c.attempt_id
   WHERE c.kind <> 'system' AND ${where}
   ORDER BY a.task_id, c.created_at DESC, c.id DESC`;

const CONVERSATION_READS = [
  conversations.kind,
  conversations.title,
  conversations.status,
  conversations.createdAt,
];

function latestRollup({
  select = (scope: (k: string) => string) => SELECT_LATEST(scope("a.task_id")),
  reads = CONVERSATION_READS,
}: {
  select?: (scope: (k: string) => string) => string;
  reads?: typeof CONVERSATION_READS;
} = {}) {
  return defineRollup({
    table: latest,
    key: latest.taskId,
    select,
    sources: [
      {
        table: conversations,
        carry: conversations.attemptId,
        via: { table: attempts, match: attempts.id, key: attempts.taskId },
        reads,
      },
      {
        table: attempts,
        carry: attempts.taskId,
        reads: [],
        ops: ["update", "delete"],
      },
    ],
  });
}

const rollup = latestRollup();

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "define_rollup_oracle" });
});

afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  for (const name of [
    TASK_LATEST_CONVERSATION_TABLE,
    "conversations",
    "attempts",
    "tasks",
  ]) {
    await t.db.execute(sql.raw(`DROP TABLE IF EXISTS "${name}" CASCADE`));
  }
  await t.db.execute(sql.raw(`CREATE TABLE tasks (id text PRIMARY KEY)`));
  await t.db.execute(
    sql.raw(`CREATE TABLE attempts (
      id text PRIMARY KEY,
      task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE)`),
  );
  await t.db.execute(
    sql.raw(`CREATE TABLE conversations (
      id text PRIMARY KEY,
      attempt_id text NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
      kind text NOT NULL DEFAULT 'user',
      title text,
      status text NOT NULL,
      created_at timestamptz NOT NULL,
      waiting_for text)`),
  );
  await installRollups(t.db, [rollup]);
});

const Row = z.object({
  task_id: z.string(),
  conversation_id: z.string(),
  title: z.string().nullable(),
  status: z.string(),
});

async function rollupRows(): Promise<z.infer<typeof Row>[]> {
  return executeRows(t.db, {
    query: sql.raw(
      `SELECT task_id, conversation_id, title, status FROM ${TASK_LATEST_CONVERSATION_TABLE} ORDER BY task_id`,
    ),
    row: Row,
  });
}

async function truth(): Promise<z.infer<typeof Row>[]> {
  return executeRows(t.db, {
    query: sql.raw(
      `SELECT task_id, conversation_id, title, status FROM (${SELECT_LATEST("true")}) r ORDER BY task_id`,
    ),
    row: Row,
  });
}

async function expectConsistent(): Promise<void> {
  expect(await rollupRows()).toEqual(await truth());
}

async function xminOf(taskId: string): Promise<string> {
  const rows = await executeRows(t.db, {
    query: sql`SELECT xmin::text AS x FROM task_latest_conversation WHERE task_id = ${taskId}`,
    row: z.object({ x: z.string() }),
  });
  if (rows.length !== 1) throw new Error(`no rollup row for ${taskId}`);
  return rows[0]!.x;
}

async function run(text: string): Promise<void> {
  await t.db.execute(sql.raw(text));
}

// Two tasks: T1 with attempts A1 (c1 at 10:00, c2 at 11:00) and A2 (c3 at
// 12:00, the latest); T2 with A3 (c4).
async function seed(): Promise<void> {
  await run(`INSERT INTO tasks VALUES ('T1'), ('T2'), ('T3')`);
  await run(
    `INSERT INTO attempts VALUES ('A1','T1'), ('A2','T1'), ('A3','T2')`,
  );
  await run(`INSERT INTO conversations (id, attempt_id, title, status, created_at) VALUES
    ('c1','A1','one','done','2026-01-01T10:00Z'),
    ('c2','A1','two','working','2026-01-01T11:00Z'),
    ('c3','A2','three','waiting','2026-01-01T12:00Z'),
    ('c4','A3','four','working','2026-01-01T09:00Z')`);
}

describe("define-rollup oracle — maintain", () => {
  test("inserts keep the latest conversation per task", async () => {
    await seed();
    expect(
      (await rollupRows()).map((r) => [r.task_id, r.conversation_id]),
    ).toEqual([
      ["T1", "c3"],
      ["T2", "c4"],
    ]);
    await expectConsistent();
  });

  test("a system conversation never counts", async () => {
    await seed();
    await run(`INSERT INTO conversations (id, attempt_id, kind, status, created_at)
               VALUES ('sys','A1','system','working','2026-01-02T00:00Z')`);
    expect((await rollupRows())[0]!.conversation_id).toBe("c3");
    await expectConsistent();
  });

  test("a write to a column the rollup does not read leaves its row untouched", async () => {
    await seed();
    const before = await xminOf("T1");
    await run(`UPDATE conversations SET waiting_for = 'input' WHERE id = 'c3'`);
    expect(await xminOf("T1")).toBe(before);
    await expectConsistent();
  });

  test("a read column that does not move the aggregate leaves its row untouched", async () => {
    await seed();
    const before = await xminOf("T1");
    // c1 is not T1's latest: re-aggregated, same answer, no write.
    await run(`UPDATE conversations SET title = 'renamed' WHERE id = 'c1'`);
    expect(await xminOf("T1")).toBe(before);
    await expectConsistent();
  });

  test("a status flip of the latest conversation updates the row", async () => {
    await seed();
    await run(`UPDATE conversations SET status = 'done' WHERE id = 'c3'`);
    expect((await rollupRows())[0]!.status).toBe("done");
    await expectConsistent();
  });

  test("an attempt moved to another task moves its conversations (attempts source)", async () => {
    await seed();
    await run(`UPDATE attempts SET task_id = 'T3' WHERE id = 'A2'`);
    expect(
      (await rollupRows()).map((r) => [r.task_id, r.conversation_id]),
    ).toEqual([
      ["T1", "c2"],
      ["T2", "c4"],
      ["T3", "c3"],
    ]);
    await expectConsistent();
  });

  test("deleting the attempt holding the latest conversation falls back to the task's older one (W8)", async () => {
    await seed();
    await run(`DELETE FROM attempts WHERE id = 'A2'`);
    expect((await rollupRows())[0]).toMatchObject({
      task_id: "T1",
      conversation_id: "c2",
    });
    await expectConsistent();
  });

  test("deleting a task's last attempt deletes its row", async () => {
    await seed();
    await run(`DELETE FROM attempts WHERE id = 'A3'`);
    expect((await rollupRows()).map((r) => r.task_id)).toEqual(["T1"]);
    await expectConsistent();
  });

  test("deleting the task (cascade through attempts and conversations) deletes its row", async () => {
    await seed();
    await run(`DELETE FROM tasks WHERE id = 'T1'`);
    expect((await rollupRows()).map((r) => r.task_id)).toEqual(["T2"]);
    await expectConsistent();
  });

  test("a conversation reparented to another attempt moves between tasks", async () => {
    await seed();
    await run(`UPDATE conversations SET attempt_id = 'A3' WHERE id = 'c3'`);
    expect(
      (await rollupRows()).map((r) => [r.task_id, r.conversation_id]),
    ).toEqual([
      ["T1", "c2"],
      ["T2", "c3"],
    ]);
    await expectConsistent();
  });

  test("a multi-row statement across tasks", async () => {
    await seed();
    await run(
      `UPDATE conversations SET created_at = created_at + interval '1 day' WHERE id IN ('c1', 'c4')`,
    );
    await expectConsistent();
    await run(`DELETE FROM conversations WHERE id IN ('c2', 'c3', 'c4')`);
    await expectConsistent();
  });
});

describe("define-rollup oracle — reconcile", () => {
  test("a clean reconcile writes nothing", async () => {
    await seed();
    const before = await xminOf("T1");
    expect(await installRollups(t.db, [rollup])).toEqual([
      {
        table: TASK_LATEST_CONVERSATION_TABLE,
        upserted: 0,
        deleted: 0,
        definitionChanged: false,
      },
    ]);
    expect(await xminOf("T1")).toBe(before);
  });

  test("drift is healed, with exact counts", async () => {
    await seed();
    // One wrong row, one missing row, one row with no source.
    await run(
      `UPDATE task_latest_conversation SET title = 'stale' WHERE task_id = 'T1'`,
    );
    await run(`DELETE FROM task_latest_conversation WHERE task_id = 'T2'`);
    await run(
      `INSERT INTO task_latest_conversation VALUES ('T9', 'cx', null, 'done', now())`,
    );
    const [result] = await installRollups(t.db, [rollup]);
    expect(result).toMatchObject({ upserted: 2, deleted: 1 });
    await expectConsistent();
    const [again] = await installRollups(t.db, [rollup]);
    expect(again).toMatchObject({ upserted: 0, deleted: 0 });
  });

  // T1's row has drifted to status 'done' (its latest, c3, is 'waiting'). A
  // writer then sets c3 to 'done': its maintain takes T1's lock and finds the
  // row already equal to the new aggregate, so it writes nothing. A reconcile
  // whose drift scan predates that commit must not then write T1 from its own
  // snapshot ('waiting'): it takes T1's lock, waits for the writer, and
  // re-aggregates in a fresh statement.
  test("a heal racing a writer of the same key waits for it (A34)", async () => {
    await seed();
    await run(
      `UPDATE task_latest_conversation SET status = 'done' WHERE task_id = 'T1'`,
    );
    const a = new Client({ connectionString: t.connectionString });
    // The boot's own connection: `t.db` is a one-connection pool the waiter
    // below must stay free to poll on.
    const boot = new Client({ connectionString: t.connectionString });
    await a.connect();
    await boot.connect();
    try {
      await a.query("BEGIN");
      await a.query(`UPDATE conversations SET status = 'done' WHERE id = 'c3'`);
      const healed = installRollups(drizzle(boot), [rollup]);
      await waitUntilAdvisoryWaiter();
      await a.query("COMMIT");
      const [result] = await healed;
      expect(result).toMatchObject({ upserted: 0, deleted: 0 });
    } finally {
      await a.end();
      await boot.end();
    }
    expect((await rollupRows())[0]).toMatchObject({
      task_id: "T1",
      status: "done",
    });
    await expectConsistent();
  });
});

describe("define-rollup oracle — concurrency (A34)", () => {
  // T1's latest is c3 (A2). Writer A inserts a newer conversation c5; writer B,
  // concurrently, deletes c3. Without the per-key lock B aggregates without
  // A's uncommitted c5 and, once A commits, overwrites T1's row with c2 — a
  // lost update. With it, B waits for A and then sees c5.
  test("two writers of one key never lose an update", async () => {
    await seed();
    const a = new Client({ connectionString: t.connectionString });
    const b = new Client({ connectionString: t.connectionString });
    await a.connect();
    await b.connect();
    try {
      const bPid = (
        await b.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)
      ).rows[0]!.pid;
      await a.query("BEGIN");
      await a.query(`INSERT INTO conversations (id, attempt_id, title, status, created_at)
                     VALUES ('c5','A1','five','working','2026-01-01T13:00Z')`);
      await b.query("BEGIN");
      const bDone = b.query(`DELETE FROM conversations WHERE id = 'c3'`);
      await waitUntilBlocked(bPid);
      await a.query("COMMIT");
      await bDone;
      await b.query("COMMIT");
    } finally {
      await a.end();
      await b.end();
    }
    expect((await rollupRows())[0]).toMatchObject({
      task_id: "T1",
      conversation_id: "c5",
    });
    await expectConsistent();
  });
});

describe("define-rollup oracle — the installed trigger set", () => {
  test("a trigger dropped out of band is reinstated", async () => {
    await run(`DROP TRIGGER task_latest_conversation__attempts_d ON attempts`);
    const [result] = await installRollups(t.db, [rollup]);
    expect(result!.definitionChanged).toBe(true);
    await seed();
    await run(`DELETE FROM attempts WHERE id = 'A2'`);
    await expectConsistent();
  });

  test("a trigger altered out of band (a column list) is reinstalled, not refused", async () => {
    await run(`CREATE OR REPLACE TRIGGER task_latest_conversation__conversations_u
               AFTER UPDATE OF status ON conversations
               FOR EACH STATEMENT EXECUTE FUNCTION task_latest_conversation__conversations_maintain()`);
    const [result] = await installRollups(t.db, [rollup]);
    expect(result!.definitionChanged).toBe(true);
    const cols = await executeRows(t.db, {
      query: sql.raw(
        `SELECT cardinality(tgattr::int2[])::int AS n FROM pg_trigger WHERE tgname = 'task_latest_conversation__conversations_u'`,
      ),
      row: z.object({ n: z.number() }),
    });
    expect(cols).toEqual([{ n: 0 }]);
    await seed();
    await run(`UPDATE conversations SET title = 'retitled' WHERE id = 'c3'`);
    expect((await rollupRows())[0]!.title).toBe("retitled");
    await expectConsistent();
  });

  test("a stray trigger calling a rollup's maintain function is dropped", async () => {
    await run(`CREATE TRIGGER task_latest_conversation__conversations_x AFTER TRUNCATE ON conversations
               FOR EACH STATEMENT EXECUTE FUNCTION task_latest_conversation__conversations_maintain()`);
    await installRollups(t.db, [rollup]);
    const names = await executeRows(t.db, {
      query: sql.raw(
        `SELECT tgname::text AS n FROM pg_trigger WHERE tgrelid = 'conversations'::regclass AND NOT tgisinternal ORDER BY 1`,
      ),
      row: z.object({ n: z.string() }),
    });
    expect(names.map((r) => r.n)).toEqual([
      "task_latest_conversation__conversations_d",
      "task_latest_conversation__conversations_i",
      "task_latest_conversation__conversations_u",
    ]);
  });

  // An older build booting on a fork re-runs its own CREATE OR REPLACE
  // FUNCTION, which keeps the OID and with it this build's stamp: only the
  // catalog definition in the stamp tells the two apart.
  test("a maintain function replaced out of band is reinstalled", async () => {
    await run(`CREATE OR REPLACE FUNCTION task_latest_conversation__conversations_maintain()
               RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`);
    const [result] = await installRollups(t.db, [rollup]);
    expect(result!.definitionChanged).toBe(true);
    await seed();
    await run(`UPDATE conversations SET title = 'retitled' WHERE id = 'c3'`);
    expect((await rollupRows())[0]!.title).toBe("retitled");
    await expectConsistent();
  });

  test("a sweep drops a rollup nobody declares, triggers then functions", async () => {
    expect(
      await installDbTriggers(t.db, [], { sweep: { schema: "public" } }),
    ).toEqual([
      { id: `rollup.${TASK_LATEST_CONVERSATION_TABLE}`, outcome: "dropped" },
    ]);
    const left = await executeRows(t.db, {
      query: sql.raw(
        `SELECT (SELECT count(*)::int FROM pg_trigger WHERE tgname LIKE 'task_latest_conversation%') AS triggers,
                (SELECT count(*)::int FROM pg_proc WHERE proname LIKE 'task_latest_conversation%') AS functions`,
      ),
      row: z.object({ triggers: z.number(), functions: z.number() }),
    });
    expect(left).toEqual([{ triggers: 0, functions: 0 }]);
    const [result] = await installRollups(t.db, [rollup]);
    expect(result!.definitionChanged).toBe(true);
    await seed();
    await expectConsistent();
  });
});

describe("define-rollup oracle — adopting the previous installer's triggers", () => {
  // The previous installer kept no comment on a rollup trigger, only a
  // `triggers:<table>` signature row. Its triggers, installed as written, are
  // restamped (COMMENT only) — never re-created, which would lock every source
  // table at once on the first boot of the one installer.
  test("a recorded table's triggers are restamped, not re-created", async () => {
    await run(`DO $$
      DECLARE r record;
      BEGIN
        FOR r IN SELECT t.tgname, c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE obj_description(t.oid, 'pg_trigger') LIKE 'db-triggers:rollup.%'
        LOOP
          EXECUTE format('COMMENT ON TRIGGER %I ON %I IS NULL', r.tgname, r.relname);
        END LOOP;
      END $$`);
    await run(
      `CREATE TABLE "${DERIVED_TABLE_OBJECT_STATE_TABLE}" (name text PRIMARY KEY, signature text NOT NULL)`,
    );
    for (const source of rollup.sources) {
      const sig = sha256Hex(
        [...source.triggers]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((t) => t.ddl)
          .join("\n--\n"),
      );
      await run(
        `INSERT INTO "${DERIVED_TABLE_OBJECT_STATE_TABLE}" VALUES ('triggers:${source.table}', '${sig}')`,
      );
    }
    const before = await triggerRows();
    await installRollups(t.db, [rollup]);
    const after = await triggerRows();
    expect(after.map((r) => r.xmin)).toEqual(before.map((r) => r.xmin));
    expect(after.every((r) => r.stamp?.startsWith("db-triggers:rollup."))).toBe(
      true,
    );
    await run(`DROP TABLE "${DERIVED_TABLE_OBJECT_STATE_TABLE}"`);
    await seed();
    await expectConsistent();
  });

  test("an unrecorded table's triggers are re-created", async () => {
    await run(
      `COMMENT ON TRIGGER task_latest_conversation__attempts_d ON attempts IS NULL`,
    );
    const before = await triggerRows();
    await installRollups(t.db, [rollup]);
    const after = await triggerRows();
    const xmin = (rows: typeof before, name: string) =>
      rows.find((r) => r.name === name)!.xmin;
    expect(xmin(after, "task_latest_conversation__attempts_d")).not.toBe(
      xmin(before, "task_latest_conversation__attempts_d"),
    );
  });
});

// Every rollup trigger: its catalog row's xmin (moved by a re-create, not by a
// COMMENT) and its stamp.
async function triggerRows(): Promise<
  { name: string; xmin: string; stamp: string | null }[]
> {
  return executeRows(t.db, {
    query: sql.raw(
      `SELECT tgname::text AS name, xmin::text AS xmin, obj_description(oid, 'pg_trigger') AS stamp
         FROM pg_trigger WHERE tgname LIKE 'task_latest_conversation%' ORDER BY 1`,
    ),
    row: z.object({
      name: z.string(),
      xmin: z.string(),
      stamp: z.string().nullable(),
    }),
  });
}

describe("define-rollup oracle — the select against its declaration", () => {
  test("a read column no source declares is refused", async () => {
    const bad = latestRollup({
      reads: [conversations.kind, conversations.title, conversations.createdAt],
    });
    expect(installRollups(t.db, [bad])).rejects.toThrow(
      /reads conversations\.status, which no declaration names/,
    );
  });

  test("a table that is neither a source nor a via is refused", async () => {
    const bad = latestRollup({
      select: (scope) => `
        SELECT DISTINCT ON (a.task_id)
               a.task_id, c.id AS conversation_id, c.title, c.status, c.created_at
          FROM conversations c JOIN attempts a ON a.id = c.attempt_id
          JOIN tasks k ON k.id = a.task_id
         WHERE c.kind <> 'system' AND ${scope("a.task_id")}
         ORDER BY a.task_id, c.created_at DESC, c.id DESC`,
    });
    expect(installRollups(t.db, [bad])).rejects.toThrow(
      /reads public\.tasks, which is neither a source nor a via table/,
    );
  });

  test("a column the table does not have is refused, not dropped", async () => {
    const bad = latestRollup({
      select: (scope) => `
        SELECT DISTINCT ON (a.task_id)
               a.task_id, c.id AS conversation_id, c.title, c.status, c.created_at,
               c.kind
          FROM conversations c JOIN attempts a ON a.id = c.attempt_id
         WHERE c.kind <> 'system' AND ${scope("a.task_id")}
         ORDER BY a.task_id, c.created_at DESC, c.id DESC`,
    });
    expect(installRollups(t.db, [bad])).rejects.toThrow(
      /returns "kind", not a column of the table/,
    );
  });
});

describe("define-rollup oracle — the older builds' state table", () => {
  // Older builds keep ONE whole-layer signature row in it. Reshaping it would
  // fail their INSERT … ON CONFLICT (id) and so their whole schema layer; left
  // holding its row, they would trust it and skip installing their triggers.
  test("is emptied every boot, its shape kept", async () => {
    await run(`DROP TABLE IF EXISTS "${DERIVED_TABLE_STATE_TABLE}"`);
    await run(`CREATE TABLE "${DERIVED_TABLE_STATE_TABLE}" (
      id boolean PRIMARY KEY DEFAULT true CHECK (id), signature text NOT NULL)`);
    await run(
      `INSERT INTO "${DERIVED_TABLE_STATE_TABLE}" (signature) VALUES ('old')`,
    );
    await installRollups(t.db, [rollup]);
    const cols = await executeRows(t.db, {
      query: sql.raw(
        `SELECT column_name::text AS c FROM information_schema.columns WHERE table_name = '${DERIVED_TABLE_STATE_TABLE}' ORDER BY ordinal_position`,
      ),
      row: z.object({ c: z.string() }),
    });
    expect(cols.map((r) => r.c)).toEqual(["id", "signature"]);
    const rows = await executeRows(t.db, {
      query: sql.raw(
        `SELECT count(*)::int AS n FROM "${DERIVED_TABLE_STATE_TABLE}"`,
      ),
      row: z.object({ n: z.number() }),
    });
    expect(rows).toEqual([{ n: 0 }]);
    await run(`DROP TABLE "${DERIVED_TABLE_STATE_TABLE}"`);
  });
});

// Wait (bounded) until some backend of this database waits on an advisory
// lock — the reconcile, queued behind a writer's per-key lock.
async function waitUntilAdvisoryWaiter(): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const rows = await executeRows(t.db, {
      query: sql`SELECT count(*)::int AS n FROM pg_stat_activity
                  WHERE datname = current_database() AND wait_event = 'advisory'`,
      row: z.object({ n: z.number() }),
    });
    if (rows[0]!.n > 0) return;
    await Bun.sleep(10);
  }
  throw new Error("no backend ever waited on an advisory lock");
}

// Wait (bounded) until a backend is blocked on a lock — so a test can order a
// commit after a statement it knows is already waiting.
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
