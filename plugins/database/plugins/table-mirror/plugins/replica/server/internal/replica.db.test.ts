import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  bigint,
  date,
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { Client } from "pg";
import { z } from "zod";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import {
  executeOne,
  executeRows,
} from "@plugins/database/plugins/sql-rows/core";
import type { MirrorPk } from "@plugins/database/plugins/table-mirror/core";
import {
  defineMirrorSet,
  readMirrorChanges,
  readMirrorCopy,
  readMirrorKeys,
  readMirrorRows,
  type MirrorSetDefinition,
} from "@plugins/database/plugins/table-mirror/plugins/source/server";
import {
  installMirrorSource,
  pruneMirrorLog,
} from "@plugins/database/plugins/table-mirror/plugins/source/server/testing";
import type { MirrorFetch, MirrorSinkBatch } from "./pull";
import { ConcurrentPullError, pullReplica } from "./pull";
import {
  dropReplica,
  ensureReplica,
  sweepOrphanReplicaSchemas,
  withReplicaSchema,
} from "./replicas";
import { REPLICA_CHANNEL } from "./notify";

// The replica half against a real Postgres, with the source in the same
// database (the demo's stand-in box): the source writes public.* and its log,
// the replica its own tm_* schema. `fetch` calls the source's readers
// in-process and counts what travels.

const rpParent = pgTable("rp_parent", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull(),
  secret: text("secret"),
});
const rpChild = pgTable("rp_child", {
  id: text("id").primaryKey(),
  parentId: uuid("parent_id")
    .notNull()
    .references(() => rpParent.id, { onDelete: "cascade" }),
  path: text("path").notNull(),
});
const rpPair = pgTable(
  "rp_pair",
  {
    day: date("day", { mode: "string" }).notNull(),
    hash: text("hash").notNull(),
    v: integer("v").notNull(),
  },
  (t) => [primaryKey({ columns: [t.day, t.hash] })],
);
// `extra` is declared from the start but created later: the local migration
// the rebuild test plays.
const rpWide = pgTable("rp_wide", {
  id: integer("id").primaryKey(),
  label: text("label").notNull(),
  extra: text("extra"),
});
const rpNum = pgTable("rp_num", {
  id: integer("id").primaryKey(),
  amount: numeric("amount"),
  doc: jsonb("doc"),
  big: bigint("big", { mode: "number" }),
  at: timestamp("at", { withTimezone: true }),
});
const rpKv = pgTable("rp_kv", {
  k: text("k").primaryKey(),
  v: text("v").notNull(),
});

// Reserved words as names: every name the generated SQL spells must parse.
const rpReserved = pgTable("user", {
  order: text("order").primaryKey(),
  returning: boolean("returning").notNull(),
  select: text("select"),
});

const mainSet = defineMirrorSet({
  id: "rp_main",
  tables: [rpParent, rpChild, rpPair],
  omit: [rpParent.secret],
});
const wideSet = defineMirrorSet({ id: "rp_wide", tables: [rpWide] });
const kvSet = defineMirrorSet({ id: "rp_kv", tables: [rpKv] });
const numSet = defineMirrorSet({ id: "rp_num", tables: [rpNum] });
const reservedSet = defineMirrorSet({
  id: "rp_reserved",
  tables: [rpReserved],
  omit: [rpReserved.select],
});

let t: TestDb;
let db: NodePgDatabase;

beforeAll(async () => {
  t = await createTestDb({ prefix: "tm_replica" });
  db = t.db;
  await runMigrations(db);
  await db.execute(
    sql.raw(`
    CREATE TABLE rp_parent (id uuid PRIMARY KEY, name text NOT NULL UNIQUE,
      at timestamptz NOT NULL, secret text);
    CREATE TABLE rp_child (id text PRIMARY KEY,
      parent_id uuid NOT NULL REFERENCES rp_parent(id) ON DELETE CASCADE, path text NOT NULL);
    CREATE INDEX rp_child_parent_idx ON rp_child (parent_id);
    CREATE TABLE rp_pair (day date NOT NULL, hash text NOT NULL, v int NOT NULL, PRIMARY KEY (day, hash));
    CREATE TABLE rp_wide (id int PRIMARY KEY, label text NOT NULL);
    CREATE TABLE rp_kv (k text PRIMARY KEY, v text NOT NULL);
    CREATE TABLE rp_num (id int PRIMARY KEY, amount numeric, doc jsonb, big bigint, at timestamptz);
    CREATE TABLE "user" ("order" text PRIMARY KEY, "returning" boolean NOT NULL, "select" text);
  `),
  );
  await installMirrorSource(
    db,
    [mainSet, wideSet, kvSet, numSet, reservedSet],
    [],
  );
});

afterAll(async () => {
  await t.drop();
});

/** The source's readers called in-process, with what travelled counted. */
function directFetch(set: MirrorSetDefinition) {
  const stats = { rowsFetched: 0, copied: 0, rowKeys: [] as MirrorPk[] };
  const fetch: MirrorFetch = {
    changes: (req) => readMirrorChanges(db, { ...req, set }),
    async copy(req) {
      const page = await readMirrorCopy(db, { ...req, set });
      if (page.kind === "copy") stats.copied += page.rows.length;
      return page;
    },
    keys: (req) => readMirrorKeys(db, { ...req, set }),
    async rows(req) {
      const answer = await readMirrorRows(db, { ...req, set });
      if (answer.kind === "rows") {
        stats.rowsFetched += answer.rows.length;
        stats.rowKeys.push(...answer.rows.map((r) => r.pk));
      }
      return answer;
    },
  };
  return { fetch, stats };
}

/** Pull until caught up (a small budget per chunk, so chunks resume). */
async function sync(
  replicaId: string,
  set: MirrorSetDefinition,
  fetch: MirrorFetch,
  more: Partial<Parameters<typeof pullReplica>[0]> = {},
) {
  for (let i = 0; i < 200; i++) {
    const r = await pullReplica({
      db,
      replicaId,
      set,
      fetch,
      budget: { pages: 3 },
      bounds: { maxRows: 2, maxKeys: 3 },
      ...more,
    });
    if (r.outcome.kind !== "stopped") return r;
  }
  throw new Error("sync did not settle");
}

const Rows = z.array(z.record(z.string(), z.unknown()));

/** A table's rows on the source (`public`) or in the replica, ordered, as JSON text values. */
async function rowsOf(
  schema: string,
  table: string,
  cols: string,
): Promise<unknown[]> {
  const rows = await executeRows(db, {
    query: sql.raw(
      `SELECT to_jsonb(x) AS r FROM (SELECT ${cols} FROM ${schema}.${table} ORDER BY 1, 2) x`,
    ),
    row: z.object({ r: z.record(z.string(), z.unknown()) }),
  });
  return Rows.parse(rows.map((r) => r.r));
}

async function schemaOf(replicaId: string): Promise<string> {
  const row = await executeOne(db, {
    query: sql`SELECT schema_name FROM table_mirror_replicas WHERE id = ${replicaId}`,
    row: z.object({ schema_name: z.string() }),
  });
  return row.schema_name;
}

async function expectMirrored(replicaId: string): Promise<void> {
  const s = await schemaOf(replicaId);
  expect(await rowsOf(s, "rp_parent", "id, name, at")).toEqual(
    await rowsOf("public", "rp_parent", "id, name, at"),
  );
  expect(await rowsOf(s, "rp_child", "id, parent_id, path")).toEqual(
    await rowsOf("public", "rp_child", "id, parent_id, path"),
  );
  expect(await rowsOf(s, "rp_pair", "day, hash, v")).toEqual(
    await rowsOf("public", "rp_pair", "day, hash, v"),
  );
}

let markAt = Date.now() - 400 * 24 * 3600 * 1000;
/** Move the source's horizon past everything logged so far (a 30-day absence). */
async function pastTheHorizon(): Promise<void> {
  const { xmin } = await executeOne(db, {
    query: sql.raw(
      `SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS xmin`,
    ),
    row: z.object({ xmin: z.string() }),
  });
  markAt += 1000;
  await db.execute(
    sql`INSERT INTO table_mirror_marks (at, snapshot_xmin) VALUES (${new Date(markAt).toISOString()}, ${xmin}::xid8)`,
  );
  await pruneMirrorLog(db, new Date(markAt + 31 * 24 * 3600 * 1000), 30);
}

const P1 = "00000000-0000-4000-8000-000000000001";
const P2 = "00000000-0000-4000-8000-000000000002";
const P3 = "00000000-0000-4000-8000-000000000003";

describe("a schema replica", () => {
  const id = "rp-main-1";
  const { fetch, stats } = directFetch(mainSet);

  test("before its first copy it is not readable, and the first sync copies it in pages", async () => {
    await db.execute(
      sql.raw(`
      INSERT INTO rp_parent VALUES ('${P1}', 'one', '2026-11-12T10:00:00Z', 's1'),
        ('${P2}', 'two', '2026-11-12T11:00:00Z', NULL), ('${P3}', 'three', '2026-11-12T12:00:00+05', NULL);
      INSERT INTO rp_child VALUES ('c1', '${P1}', '/a'), ('c2', '${P1}', '/b'), ('c3', '${P2}', '/c'),
        ('c4', '${P3}', '/d'), ('c5', '${P3}', '/e');
      INSERT INTO rp_pair VALUES ('2026-11-01', 'x', 1), ('2026-11-01', 'y', 2), ('2026-11-02', 'x', 3);
    `),
    );
    await ensureReplica(db, { id, set: mainSet });
    const before = await withReplicaSchema(db, id, async () => 1);
    expect(before).toEqual({ ready: false, phase: "empty", progress: null });

    const first = await pullReplica({
      db,
      replicaId: id,
      set: mainSet,
      fetch,
      budget: { pages: 1 },
      bounds: { maxRows: 2 },
    });
    expect(first).toMatchObject({
      phase: "copying",
      outcome: { kind: "stopped" },
      caughtUp: false,
    });
    const mid = await withReplicaSchema(db, id, async () => 1);
    expect(mid.ready).toBe(false);

    const done = await sync(id, mainSet, fetch);
    expect(done).toMatchObject({
      phase: "live",
      outcome: { kind: "synced" },
      caughtUp: true,
    });
    expect(stats.copied).toBe(11);
    await expectMirrored(id);
    // The omitted column never arrived, and has no column in the copy.
    const s = await schemaOf(id);
    const cols = await executeRows(db, {
      query: sql`SELECT column_name::text AS c FROM information_schema.columns WHERE table_schema = ${s} AND table_name = 'rp_parent'`,
      row: z.object({ c: z.string() }),
    });
    expect(cols.map((c) => c.c).sort()).toEqual(["at", "id", "name"]);
  });

  test("the owner's own SQL runs unchanged on the copy, and nothing outside it is visible", async () => {
    const read = await withReplicaSchema(db, id, async (tx) =>
      executeOne(tx, {
        query: sql.raw(
          `SELECT count(*)::int AS n FROM rp_child WHERE path <> '/zzz'`,
        ),
        row: z.object({ n: z.number() }),
      }),
    );
    expect(read).toMatchObject({ ready: true, value: { n: 5 } });
    expect(
      withReplicaSchema(db, id, (tx) =>
        tx.execute(sql.raw(`SELECT 1 FROM rp_wide`)),
      ),
    ).rejects.toThrow(/rp_wide/);
  });

  test("updates, deletes and a cascaded delete round-trip", async () => {
    await db.execute(
      sql.raw(`UPDATE rp_child SET path = '/a2' WHERE id = 'c1'`),
    );
    await db.execute(
      sql.raw(
        `UPDATE rp_pair SET hash = 'z' WHERE day = '2026-11-01' AND hash = 'y'`,
      ),
    );
    await db.execute(sql.raw(`DELETE FROM rp_parent WHERE id = '${P2}'`)); // cascades c3
    await db.execute(
      sql.raw(`INSERT INTO rp_child VALUES ('c6', '${P1}', '/f')`),
    );
    const r = await sync(id, mainSet, fetch);
    expect(r.outcome.kind).toBe("synced");
    await expectMirrored(id);
    const s = await schemaOf(id);
    expect(await rowsOf(s, "rp_child", "id, path")).not.toContainEqual({
      id: "c3",
      path: "/c",
    });
  });

  test("a retention sweep on the source, with its cascade, removes the rows and their children", async () => {
    await db.execute(
      sql.raw(`DELETE FROM rp_parent WHERE at < '2026-11-12T11:00:00Z'`),
    ); // P3 (07:00Z) and P1
    expect(await rowsOf("public", "rp_child", "id, path")).toEqual([]);
    await sync(id, mainSet, fetch);
    await expectMirrored(id);
    const s = await schemaOf(id);
    expect(await rowsOf(s, "rp_parent", "id, name")).toEqual([]);
    expect(await rowsOf(s, "rp_child", "id, path")).toEqual([]);
  });

  test("a value moved between rows applies whatever the order (unique constraints are relaxed in the copy)", async () => {
    await db.execute(
      sql.raw(
        `INSERT INTO rp_parent VALUES ('${P1}', 'a', now(), NULL), ('${P2}', 'b', now(), NULL)`,
      ),
    );
    await sync(id, mainSet, fetch);
    await db.transaction(async (tx) => {
      await tx.execute(
        sql.raw(`UPDATE rp_parent SET name = 'tmp' WHERE id = '${P1}'`),
      );
      await tx.execute(
        sql.raw(`UPDATE rp_parent SET name = 'a' WHERE id = '${P2}'`),
      );
      await tx.execute(
        sql.raw(`UPDATE rp_parent SET name = 'b' WHERE id = '${P1}'`),
      );
    });
    expect((await sync(id, mainSet, fetch)).outcome.kind).toBe("synced");
    await expectMirrored(id);
  });

  test("behind the horizon it reconciles: deletes made while away are gone, updates arrive, unchanged rows do not travel", async () => {
    await db.execute(
      sql.raw(`
      INSERT INTO rp_child VALUES ('k1', '${P1}', '/1'), ('k2', '${P1}', '/2'), ('k3', '${P2}', '/3'),
        ('k4', '${P2}', '/4'), ('k5', '${P2}', '/5');
    `),
    );
    await sync(id, mainSet, fetch);
    // Away: a delete, a cascade, an update — then the log is pruned past the replica's floor.
    await db.execute(sql.raw(`DELETE FROM rp_child WHERE id = 'k1'`));
    await db.execute(sql.raw(`DELETE FROM rp_parent WHERE id = '${P2}'`)); // k3, k4, k5
    await db.execute(
      sql.raw(`UPDATE rp_child SET path = '/2b' WHERE id = 'k2'`),
    );
    await db.execute(
      sql.raw(`INSERT INTO rp_pair VALUES ('2026-11-03', 'n', 9)`),
    );
    await pastTheHorizon();
    expect(
      (
        await readMirrorChanges(db, {
          set: mainSet,
          cursor: { floor: "1", after: null },
        })
      ).kind,
    ).toBe("reconcile-required");

    stats.rowsFetched = 0;
    stats.rowKeys = [];
    stats.copied = 0;
    const seen: string[] = [];
    let r = await pullReplica({
      db,
      replicaId: id,
      set: mainSet,
      fetch,
      budget: { pages: 1 },
    });
    seen.push(r.phase);
    r = await sync(id, mainSet, fetch);
    expect(seen).toEqual(["reconciling"]);
    expect(r).toMatchObject({ phase: "live", outcome: { kind: "synced" } });
    await expectMirrored(id);
    // Only the rows that differ travelled: k2 (updated) and the new pair;
    // the deletes needed no row.
    expect(stats.copied).toBe(0);
    expect(stats.rowKeys.map((k) => JSON.stringify(k)).sort()).toEqual(
      [{ id: "k2" }, { day: "2026-11-03", hash: "n" }]
        .map((k) => JSON.stringify(k))
        .sort(),
    );
  });

  test("an epoch change (a TRUNCATE on the source) reconciles", async () => {
    await db.execute(
      sql.raw(`INSERT INTO rp_pair VALUES ('2026-11-04', 'q', 4)`),
    );
    await sync(id, mainSet, fetch);
    await db.execute(sql.raw(`TRUNCATE rp_pair`));
    stats.rowKeys = [];
    const r = await sync(id, mainSet, fetch);
    expect(r.outcome.kind).toBe("synced");
    await expectMirrored(id);
    const s = await schemaOf(id);
    expect(await rowsOf(s, "rp_pair", "day, hash")).toEqual([]);
    expect(stats.rowKeys).toEqual([]);
  });

  test("a write in flight across a pull is not skipped", async () => {
    const other = new Client({ connectionString: t.connectionString });
    await other.connect();
    try {
      const odb = drizzle(other);
      await odb.execute(sql.raw(`BEGIN`));
      await odb.execute(
        sql.raw(`INSERT INTO rp_child VALUES ('inflight', '${P1}', '/f')`),
      );
      await db.execute(
        sql.raw(`INSERT INTO rp_child VALUES ('committed', '${P1}', '/g')`),
      );
      await sync(id, mainSet, fetch);
      const s = await schemaOf(id);
      expect(
        (await rowsOf(s, "rp_child", "id, path")).map(
          (r) => (r as { id: string }).id,
        ),
      ).not.toContain("inflight");
      await odb.execute(sql.raw(`COMMIT`));
      await sync(id, mainSet, fetch);
      await expectMirrored(id);
    } finally {
      await other.end();
    }
  });

  test("each applied page NOTIFYs table_mirror in its transaction", async () => {
    const listener = new Client({ connectionString: t.connectionString });
    await listener.connect();
    try {
      const heard: string[] = [];
      listener.on("notification", (n) => {
        if (n.channel === REPLICA_CHANNEL) heard.push(n.payload ?? "");
      });
      await listener.query(`LISTEN ${REPLICA_CHANNEL}`);
      await db.execute(
        sql.raw(`INSERT INTO rp_child VALUES ('heard', '${P1}', '/h')`),
      );
      await sync(id, mainSet, fetch);
      await listener.query(`SELECT 1`); // drains pending notifications
      expect(heard.map((p) => JSON.parse(p))).toContainEqual({
        replicaId: id,
        setId: "rp_main",
      });
    } finally {
      await listener.end();
    }
  });

  test("two pulls of one replica never interleave", async () => {
    const a = pullReplica({
      db,
      replicaId: id,
      set: mainSet,
      fetch,
      budget: { pages: 5 },
    });
    const b = pullReplica({
      db,
      replicaId: id,
      set: mainSet,
      fetch,
      budget: { pages: 5 },
    });
    const results = await Promise.allSettled([a, b]);
    // Either one lost the race (loudly), or they ran one after the other.
    for (const r of results) {
      if (r.status === "rejected")
        expect(r.reason).toBeInstanceOf(ConcurrentPullError);
    }
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
  });
});

describe("a local schema change", () => {
  const id = "rp-wide-1";
  const { fetch, stats } = directFetch(wideSet);

  test("rebuilds the table locally, keeps its rows, and reconciles only rows whose new column differs", async () => {
    await db.execute(
      sql.raw(
        `INSERT INTO rp_wide SELECT g, 'l' || g FROM generate_series(1, 20) g`,
      ),
    );
    await ensureReplica(db, { id, set: wideSet });
    expect((await sync(id, wideSet, fetch)).outcome.kind).toBe("synced");
    expect(stats.copied).toBe(20);

    // The migration: a nullable column, back-filled without the triggers seeing it.
    await db.execute(sql.raw(`ALTER TABLE rp_wide ADD COLUMN extra text`));
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL session_replication_role = replica`));
      await tx.execute(
        sql.raw(`UPDATE rp_wide SET extra = 'e' WHERE id IN (3, 7)`),
      );
    });
    stats.copied = 0;
    stats.rowsFetched = 0;
    stats.rowKeys = [];
    const r = await sync(id, wideSet, fetch);
    expect(r).toMatchObject({ phase: "live", outcome: { kind: "synced" } });
    expect(stats.copied).toBe(0);
    expect(stats.rowKeys.map((k) => k.id).sort()).toEqual([3, 7]);
    const s = await schemaOf(id);
    expect(await rowsOf(s, "rp_wide", "id, label, extra")).toEqual(
      await rowsOf("public", "rp_wide", "id, label, extra"),
    );
  });

  test("a source that does not send a column this computer requires is refused as source-older, and nothing is applied", async () => {
    await db.execute(sql.raw(`INSERT INTO rp_wide VALUES (99, 'new', NULL)`));
    // An older source: its rows lack `label` (NOT NULL, no default here).
    const older: MirrorFetch = {
      ...fetch,
      async changes(req) {
        const page = await fetch.changes(req);
        if (page.kind !== "changes") return page;
        return {
          ...page,
          changes: page.changes.map((c) => {
            if (c.kind !== "upsert") return c;
            const { label: _label, ...row } = z
              .record(z.string(), z.unknown())
              .parse(JSON.parse(c.row));
            return { ...c, row: JSON.stringify(row) };
          }),
        };
      },
    };
    const r = await pullReplica({
      db,
      replicaId: id,
      set: wideSet,
      fetch: older,
      budget: { pages: 5 },
    });
    expect(r.outcome).toEqual({
      kind: "source-older",
      table: "rp_wide",
      columns: ["label"],
    });
    const s = await schemaOf(id);
    expect(await rowsOf(s, "rp_wide", "id, label")).not.toContainEqual({
      id: 99,
      label: "new",
    });
    // The same pages, from a source that sends it, apply.
    expect((await sync(id, wideSet, fetch)).outcome.kind).toBe("synced");
    expect(await rowsOf(s, "rp_wide", "id, label")).toContainEqual({
      id: 99,
      label: "new",
    });
  });
});

describe("a local rebuild that cannot keep its rows", () => {
  test("starts the table empty, is unreadable meanwhile, and the reconcile refills it", async () => {
    const id = "rp-wide-1";
    const { fetch, stats } = directFetch(wideSet);
    // The local migration: `extra` back-filled (unseen by the triggers), then NOT NULL —
    // the copy still holds NULLs there, which the new DDL refuses.
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL session_replication_role = replica`));
      await tx.execute(
        sql.raw(`UPDATE rp_wide SET extra = 'z' WHERE extra IS NULL`),
      );
    });
    await db.execute(
      sql.raw(`ALTER TABLE rp_wide ALTER COLUMN extra SET NOT NULL`),
    );
    const first = await pullReplica({
      db,
      replicaId: id,
      set: wideSet,
      fetch,
      budget: { pages: 0 },
    });
    expect(first.phase).toBe("reconciling");
    expect((await withReplicaSchema(db, id, async () => 1)).ready).toBe(false);
    stats.rowKeys = [];
    expect((await sync(id, wideSet, fetch)).outcome.kind).toBe("synced");
    expect(stats.rowKeys.length).toBe(21);
    const s = await schemaOf(id);
    expect(await rowsOf(s, "rp_wide", "id, label, extra")).toEqual(
      await rowsOf("public", "rp_wide", "id, label, extra"),
    );
    expect((await withReplicaSchema(db, id, async () => 1)).ready).toBe(true);
  });
});

describe("values JSON cannot hold", () => {
  const id = "rp-num-1";
  const { fetch, stats } = directFetch(numSet);

  test("numeric scale, jsonb numbers and bigints past 2^53 arrive exactly, and hash equal", async () => {
    await db.execute(
      sql.raw(`
      INSERT INTO rp_num VALUES
        (1, 1.50, '{"x": 2.0, "y": [1.10, 9007199254740993]}', 9007199254740993, '2026-11-12T10:00:00.123456+02'),
        (2, 12345678901234567890.123456789, '{"n": 1e2}', -9223372036854775808, NULL),
        (3, NULL, NULL, NULL, NULL);
    `),
    );
    await ensureReplica(db, { id, set: numSet });
    expect((await sync(id, numSet, fetch)).outcome.kind).toBe("synced");
    const s = await schemaOf(id);
    const text = (schema: string) =>
      executeRows(db, {
        query: sql.raw(
          `SELECT id, amount::text AS amount, doc::text AS doc, big::text AS big, at::text AS at FROM ${schema}.rp_num ORDER BY id`,
        ),
        row: z.object({
          id: z.number(),
          amount: z.string().nullable(),
          doc: z.string().nullable(),
          big: z.string().nullable(),
          at: z.string().nullable(),
        }),
      });
    expect(await text(s)).toEqual(await text("public"));
    // A reconcile finds nothing different: no row travels again.
    await pastTheHorizon();
    stats.rowKeys = [];
    expect((await sync(id, numSet, fetch)).outcome.kind).toBe("synced");
    expect(stats.rowKeys).toEqual([]);
  });
});

describe("reserved words as table and column names", () => {
  test("copy, delta, delete and reconcile all run (every name is quoted)", async () => {
    const id = "rp-reserved-1";
    const { fetch, stats } = directFetch(reservedSet);
    const both = async () => {
      const s = await schemaOf(id);
      const read = (schema: string) =>
        executeRows(db, {
          query: sql.raw(
            `SELECT "order", "returning" FROM ${schema}."user" ORDER BY 1`,
          ),
          row: z.object({ order: z.string(), returning: z.boolean() }),
        });
      expect(await read(s)).toEqual(await read("public"));
    };
    await db.execute(
      sql.raw(
        `INSERT INTO "user" VALUES ('a', true, 'x'), ('b', false, 'y'), ('c', true, NULL)`,
      ),
    );
    await ensureReplica(db, { id, set: reservedSet });
    expect((await sync(id, reservedSet, fetch)).outcome.kind).toBe("synced");
    await both();
    await db.execute(
      sql.raw(
        `UPDATE "user" SET "returning" = NOT "returning" WHERE "order" = 'a'; DELETE FROM "user" WHERE "order" = 'b'; UPDATE "user" SET "order" = 'd' WHERE "order" = 'c'`,
      ),
    );
    expect((await sync(id, reservedSet, fetch)).outcome.kind).toBe("synced");
    await both();
    await db.execute(
      sql.raw(`UPDATE "user" SET "returning" = true WHERE "order" = 'a'`),
    );
    await pastTheHorizon();
    stats.rowKeys = [];
    expect((await sync(id, reservedSet, fetch)).outcome.kind).toBe("synced");
    await both();
    expect(stats.rowKeys).toEqual([{ order: "a" }]);
  });
});

describe("an unfinished first copy", () => {
  test("stays unreadable when the source changes under it and it reconciles instead", async () => {
    const id = "rp-num-2";
    const { fetch } = directFetch(numSet);
    await ensureReplica(db, { id, set: numSet });
    const one = {
      db,
      replicaId: id,
      set: numSet,
      fetch,
      budget: { pages: 1 },
      bounds: { maxRows: 1 },
    };
    expect((await pullReplica(one)).phase).toBe("copying");
    // Another epoch: the source was truncated or restored mid-copy.
    await db.execute(
      sql.raw(`UPDATE table_mirror_source SET epoch = epoch + 1`),
    );
    expect((await pullReplica(one)).phase).toBe("reconciling");
    expect((await withReplicaSchema(db, id, async () => 1)).ready).toBe(false);
    expect((await sync(id, numSet, fetch)).outcome.kind).toBe("synced");
    expect((await withReplicaSchema(db, id, async () => 1)).ready).toBe(true);
  });
});

describe("a custom sink", () => {
  const id = "rp-kv-1";
  const { fetch, stats } = directFetch(kvSet);
  const applied: {
    batch: MirrorSinkBatch[];
    reconciling: boolean;
    firstCopy: boolean;
  }[] = [];
  const sink = {
    async apply(
      _tx: unknown,
      batch: readonly MirrorSinkBatch[],
      opts: { reconciling: boolean; firstCopy: boolean },
    ) {
      applied.push({ batch: [...batch], ...opts });
    },
  };

  test("gets every change, with only keys and hashes kept locally; a reconcile hands it only rows that changed", async () => {
    await db.execute(
      sql.raw(`INSERT INTO rp_kv VALUES ('a', '1'), ('b', '2'), ('c', '3')`),
    );
    await ensureReplica(db, { id, set: kvSet, sink: "custom" });
    await sync(id, kvSet, fetch, { sink });
    expect(
      applied
        .flatMap((a) => a.batch.flatMap((b) => b.upserts.map((u) => u.pk.k)))
        .sort(),
    ).toEqual(["a", "b", "c"]);
    expect(applied.every((a) => a.firstCopy)).toBe(true);
    const keys = await executeRows(db, {
      query: sql`SELECT pk->>'k' AS k FROM table_mirror_keys WHERE replica_id = ${id} ORDER BY 1`,
      row: z.object({ k: z.string() }),
    });
    expect(keys.map((k) => k.k)).toEqual(["a", "b", "c"]);

    await db.execute(sql.raw(`UPDATE rp_kv SET v = '22' WHERE k = 'b'`));
    await db.execute(sql.raw(`DELETE FROM rp_kv WHERE k = 'c'`));
    await pastTheHorizon();
    applied.length = 0;
    stats.rowKeys = [];
    const r = await sync(id, kvSet, fetch, { sink });
    expect(r.outcome.kind).toBe("synced");
    expect(stats.rowKeys).toEqual([{ k: "b" }]);
    const rec = applied.filter((a) => a.reconciling);
    expect(
      rec.flatMap((a) => a.batch.flatMap((b) => b.upserts.map((u) => u.pk.k))),
    ).toEqual(["b"]);
    expect(
      rec.flatMap((a) => a.batch.flatMap((b) => b.deletes.map((d) => d.k))),
    ).toEqual(["c"]);
    const after = await executeRows(db, {
      query: sql`SELECT pk->>'k' AS k FROM table_mirror_keys WHERE replica_id = ${id} ORDER BY 1`,
      row: z.object({ k: z.string() }),
    });
    expect(after.map((k) => k.k)).toEqual(["a", "b"]);
  });

  test("a schema replica read of a custom one throws; a missing sink throws", async () => {
    expect(withReplicaSchema(db, id, async () => 1)).rejects.toThrow(
      /custom sink/,
    );
    expect(
      pullReplica({
        db,
        replicaId: id,
        set: kvSet,
        fetch,
        budget: { pages: 1 },
      }),
    ).rejects.toThrow(/custom sink; none was passed/);
  });
});

describe("ownership", () => {
  test("dropReplica drops its schema; the sweep drops schemas no replica names", async () => {
    const { fetch } = directFetch(wideSet);
    await ensureReplica(db, { id: "rp-wide-2", set: wideSet });
    await sync("rp-wide-2", wideSet, fetch);
    const s = await schemaOf("rp-wide-2");
    await dropReplica(db, "rp-wide-2");
    const left = await executeRows(db, {
      query: sql`SELECT nspname::text AS n FROM pg_namespace WHERE nspname = ${s}`,
      row: z.object({ n: z.string() }),
    });
    expect(left).toEqual([]);

    await db.execute(sql.raw(`CREATE SCHEMA tm_orphan_0123456789`));
    expect(await sweepOrphanReplicaSchemas(db)).toEqual([
      "tm_orphan_0123456789",
    ]);
    // Live replicas' schemas are kept.
    expect(await sweepOrphanReplicaSchemas(db)).toEqual([]);
  });

  test("an id names one copy", async () => {
    expect(
      ensureReplica(db, { id: "rp-main-1", set: wideSet }),
    ).rejects.toThrow(/copies set "rp_main"/);
  });
});
