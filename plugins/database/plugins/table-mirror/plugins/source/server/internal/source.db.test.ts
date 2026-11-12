import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  date,
  integer,
  jsonb,
  bigint,
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
import type {
  MirrorChange,
  MirrorChangesPage,
  MirrorCursor,
} from "@plugins/database/plugins/table-mirror/core";
import {
  assertMirrorSetsAllowed,
  defineMirrorSet,
  NeverMirrored,
} from "./define";
import { readSourceIdentity, readTableFingerprints } from "./identity";
import { installMirrorSource } from "./install";
import { pruneMirrorLog } from "./prune";
import {
  readMirrorChanges,
  readMirrorCopy,
  readMirrorKeys,
  readMirrorRows,
} from "./read";
import { tableMirrorMarks } from "./tables";

// The source half against a real Postgres: the generated triggers, the
// readers' cursor and bounds, the horizon, and the key + hash walk.

const tmParent = pgTable("tm_parent", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull(),
  props: jsonb("props"),
  n: bigint("n", { mode: "number" }),
  secret: text("secret"),
});
const tmChild = pgTable("tm_child", {
  id: text("id").primaryKey(),
  parentId: uuid("parent_id")
    .notNull()
    .references(() => tmParent.id, { onDelete: "cascade" }),
  path: text("path").notNull(),
});
const tmPair = pgTable(
  "tm_pair",
  {
    day: date("day", { mode: "string" }).notNull(),
    hash: text("hash").notNull(),
    v: integer("v").notNull(),
  },
  (t) => [primaryKey({ columns: [t.day, t.hash] })],
);
const tmSalt = pgTable("tm_salt", {
  day: date("day").primaryKey(),
  salt: text("salt"),
});

NeverMirrored({ tables: [tmSalt], reason: "test salts" });
const set = defineMirrorSet({
  id: "tm_test",
  tables: [tmParent, tmChild, tmPair],
  omit: [tmParent.secret],
});

let t: TestDb;
let db: NodePgDatabase;

beforeAll(async () => {
  t = await createTestDb({ prefix: "tm_source" });
  db = t.db;
  await runMigrations(db);
  await db.execute(
    sql.raw(`
    CREATE TABLE tm_parent (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
      at timestamptz NOT NULL, props jsonb, n bigint, secret text);
    CREATE TABLE tm_child (id text PRIMARY KEY,
      parent_id uuid NOT NULL REFERENCES tm_parent(id) ON DELETE CASCADE, path text NOT NULL);
    CREATE TABLE tm_pair (day date NOT NULL, hash text NOT NULL, v int NOT NULL, PRIMARY KEY (day, hash));
    CREATE TABLE tm_salt (day date PRIMARY KEY, salt text);
  `),
  );
  await installMirrorSource(
    db,
    [set],
    [{ tables: ["tm_salt"], reason: "test salts" }],
  );
});

afterAll(async () => {
  await t.drop();
});

const P1 = "00000000-0000-4000-8000-000000000001";
const P2 = "00000000-0000-4000-8000-000000000002";

function asPage(
  p: Awaited<ReturnType<typeof readMirrorChanges>>,
): MirrorChangesPage {
  if (p.kind !== "changes")
    throw new Error(`expected a page, got ${JSON.stringify(p)}`);
  return p;
}

/** Pull every page from `floor`; returns the changes and the next floor (the first page's xmin). */
async function pullAll(
  floor: string,
  bounds: { maxRows?: number; maxBytes?: number } = {},
): Promise<{
  changes: MirrorChange[];
  nextFloor: string;
  pages: MirrorChangesPage[];
}> {
  let cursor: MirrorCursor = { floor, after: null };
  const pages: MirrorChangesPage[] = [];
  for (;;) {
    const page = asPage(
      await readMirrorChanges(db, { set, cursor, ...bounds }),
    );
    pages.push(page);
    cursor = page.next;
    if (page.done) break;
    if (pages.length > 1000) throw new Error("pull did not end");
  }
  return {
    changes: pages.flatMap((p) => p.changes),
    nextFloor: pages[0]!.xmin,
    pages,
  };
}

const short = (c: MirrorChange) =>
  `${c.kind}:${c.tbl}:${Object.values(c.pk).join("/")}`;

describe("the change log", () => {
  let floor = "0";

  test("inserts arrive as upserts with the row (omitted columns left out) and its hash", async () => {
    await db.execute(
      sql.raw(`
      INSERT INTO tm_parent (id, name, at, props, n, secret)
        VALUES ('${P1}', 'one', '2026-11-12T10:00:00Z', '{"b": 1, "a": [1, 2]}', 9007199254740993, 'hidden'),
               ('${P2}', 'two', '2026-11-12T11:00:00Z', NULL, NULL, NULL);
      INSERT INTO tm_child VALUES ('c1', '${P1}', '/a'), ('c2', '${P1}', '/b'), ('c3', '${P2}', '/c');
    `),
    );
    const { changes, nextFloor } = await pullAll(floor);
    expect(changes.map(short).sort()).toEqual([
      `upsert:tm_child:c1`,
      `upsert:tm_child:c2`,
      `upsert:tm_child:c3`,
      `upsert:tm_parent:${P1}`,
      `upsert:tm_parent:${P2}`,
    ]);
    const one = changes.find((c) => c.tbl === "tm_parent" && c.pk.id === P1);
    if (one?.kind !== "upsert") throw new Error("no upsert for P1");
    expect(JSON.parse(one.row)).toEqual({
      id: P1,
      name: "one",
      at: "2026-11-12T10:00:00+00:00",
      props: { a: [1, 2], b: 1 },
      n: 9007199254740993,
    });
    expect("secret" in JSON.parse(one.row)).toBe(false);
    expect(one.h).toMatch(/^[0-9a-f]{32}$/);
    floor = nextFloor;
  });

  test("an update re-delivers the row; a delete becomes a tombstone", async () => {
    await db.execute(
      sql.raw(`UPDATE tm_child SET path = '/a2' WHERE id = 'c1'`),
    );
    await db.execute(sql.raw(`DELETE FROM tm_child WHERE id = 'c3'`));
    const { changes, nextFloor } = await pullAll(floor);
    expect(changes.map(short)).toEqual([
      `upsert:tm_child:c1`,
      `tombstone:tm_child:c3`,
    ]);
    const c1 = changes[0];
    if (c1?.kind !== "upsert") throw new Error("c1 is not an upsert");
    expect(JSON.parse(c1.row).path).toBe("/a2");
    floor = nextFloor;
  });

  test("a parent delete reaches the mirror for the cascaded children too", async () => {
    await db.execute(sql.raw(`DELETE FROM tm_parent WHERE id = '${P1}'`));
    const { changes, nextFloor } = await pullAll(floor);
    expect(changes.map(short).sort()).toEqual([
      `tombstone:tm_child:c1`,
      `tombstone:tm_child:c2`,
      `tombstone:tm_parent:${P1}`,
    ]);
    floor = nextFloor;
  });

  test("a key moved by an UPDATE tombstones the old key and upserts the new one", async () => {
    await db.execute(
      sql.raw(`INSERT INTO tm_pair VALUES ('2026-11-01', 'x', 1)`),
    );
    await db.execute(sql.raw(`UPDATE tm_pair SET hash = 'y' WHERE hash = 'x'`));
    const { changes, nextFloor } = await pullAll(floor);
    expect(changes.map(short).sort()).toEqual([
      `tombstone:tm_pair:2026-11-01/x`,
      `upsert:tm_pair:2026-11-01/y`,
    ]);
    floor = nextFloor;
  });

  test("an upsert row with no table row behind it throws (a write bypassed the triggers)", async () => {
    await db.execute(
      sql.raw(`INSERT INTO tm_child VALUES ('bypass', '${P2}', '/z')`),
    );
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL session_replication_role = replica`));
      await tx.execute(sql.raw(`DELETE FROM tm_child WHERE id = 'bypass'`));
    });
    expect(
      readMirrorChanges(db, { set, cursor: { floor, after: null } }),
    ).rejects.toThrow(/bypassed the change-log triggers/);
    // Repair for the next tests: the log row goes with a real delete.
    await db.execute(
      sql.raw(`INSERT INTO tm_child VALUES ('bypass', '${P2}', '/z')`),
    );
    await db.execute(sql.raw(`DELETE FROM tm_child WHERE id = 'bypass'`));
    floor = (await pullAll(floor)).nextFloor;
  });

  test("TRUNCATE moves the epoch and drops the table's log rows", async () => {
    const before = (await readSourceIdentity(db)).identity;
    await db.execute(
      sql.raw(`INSERT INTO tm_pair VALUES ('2026-11-02', 'z', 2)`),
    );
    await db.execute(sql.raw(`TRUNCATE tm_pair`));
    const { changes, pages } = await pullAll(floor);
    expect(changes.filter((c) => c.tbl === "tm_pair")).toEqual([]);
    expect(pages[0]!.identity.epoch).toBe(before.epoch + 1);
    expect(pages[0]!.identity.sourceId).toBe(before.sourceId);
  });
});

describe("page bounds", () => {
  test("maxRows and maxBytes each cut a page, and the pages chain to the end", async () => {
    const start = (await pullAll("0")).nextFloor;
    const values = Array.from(
      { length: 7 },
      (_, i) => `('b${i}', '${P2}', '${"x".repeat(200)}')`,
    );
    await db.execute(
      sql.raw(`INSERT INTO tm_child VALUES ${values.join(", ")}`),
    );
    const byRows = await pullAll(start, { maxRows: 3 });
    expect(byRows.pages.map((p) => p.changes.length)).toEqual([3, 3, 1]);
    expect(byRows.changes.map(short).sort()).toEqual(
      Array.from({ length: 7 }, (_, i) => `upsert:tm_child:b${i}`),
    );
    // About 250 bytes a row: 600 bytes takes two, a page always takes one.
    const byBytes = await pullAll(start, { maxBytes: 600 });
    expect(byBytes.pages.map((p) => p.changes.length)).toEqual([2, 2, 2, 1]);
    const tiny = await pullAll(start, { maxBytes: 1 });
    expect(tiny.pages.every((p) => p.changes.length === 1)).toBe(true);
    expect(tiny.changes.length).toBe(7);
  });
});

describe("cursor correctness", () => {
  test("a write in flight across a pull is not skipped by the next pull", async () => {
    const start = (await pullAll("0")).nextFloor;
    const other = new Client({ connectionString: t.connectionString });
    await other.connect();
    try {
      const odb = drizzle(other);
      await odb.execute(sql.raw(`BEGIN`));
      // Takes an xid before the pull's snapshot; commits after the pull ends.
      await odb.execute(
        sql.raw(`INSERT INTO tm_child VALUES ('inflight', '${P2}', '/f')`),
      );
      await db.execute(
        sql.raw(`INSERT INTO tm_child VALUES ('committed', '${P2}', '/g')`),
      );
      const first = await pullAll(start);
      expect(first.changes.map(short)).toEqual([`upsert:tm_child:committed`]);
      await odb.execute(sql.raw(`COMMIT`));
      const second = await pullAll(first.nextFloor);
      expect(second.changes.map(short)).toContain(`upsert:tm_child:inflight`);
    } finally {
      await other.end();
    }
  });
});

describe("the horizon", () => {
  test("the prune deletes log rows below the newest mark past retention, and a floor below it is refused", async () => {
    const old = (await pullAll("0")).nextFloor;
    // A mark 31 days ago at the current xmin: everything logged so far is older.
    const markXmin = (await pullAll("0")).pages[0]!.xmin;
    const now = new Date();
    await db.insert(tableMirrorMarks).values({
      at: new Date(now.getTime() - 31 * 24 * 3600 * 1000),
      snapshotXmin: sql`${markXmin}::xid8`,
    });
    await db.execute(
      sql.raw(`INSERT INTO tm_child VALUES ('after-mark', '${P2}', '/h')`),
    );
    const { horizon } = await pruneMirrorLog(db, now, 30);
    expect(horizon).toBe(markXmin);
    const refused = await readMirrorChanges(db, {
      set,
      cursor: { floor: "0", after: null },
    });
    expect(refused.kind).toBe("reconcile-required");
    const ok = await pullAll(old);
    expect(ok.changes.map(short)).toContain(`upsert:tm_child:after-mark`);
    const rest = await db.execute<{ n: string }>(
      sql.raw(
        `SELECT count(*)::text AS n FROM table_mirror_log WHERE xid < '${markXmin}'::xid8`,
      ),
    );
    expect(rest.rows[0]!.n).toBe("0");
    // A second run with no older mark keeps the horizon.
    expect((await pruneMirrorLog(db, now, 30)).horizon).toBe(markXmin);
  });
});

describe("key + hash reads", () => {
  const RowSchema = z.object({ h: z.string() });

  test("copy, keys and rows agree on keys and hashes, whatever the session time zone", async () => {
    await db.execute(sql.raw(`DELETE FROM tm_child; DELETE FROM tm_parent`));
    await db.execute(
      sql.raw(`
      INSERT INTO tm_parent (id, name, at, props, n, secret)
        VALUES ('${P1}', 'one', '2026-11-12T10:00:00Z', '{"k": "v"}', 1, 's');
      INSERT INTO tm_child VALUES ('B', '${P1}', '/1'), ('a', '${P1}', '/2'), ('_', '${P1}', '/3'), ('Z', '${P1}', '/4');
    `),
    );
    await db.execute(sql.raw(`SET TimeZone = 'Pacific/Kiritimati'`));
    const copy1 = await readMirrorCopy(db, {
      set,
      table: "tm_child",
      afterPk: null,
      maxRows: 2,
    });
    if (copy1.kind !== "copy") throw new Error(JSON.stringify(copy1));
    // COLLATE "C": upper case before '_' before lower case.
    expect(copy1.rows.map((r) => r.pk.id)).toEqual(["B", "Z"]);
    expect(copy1.done).toBe(false);
    const copy2 = await readMirrorCopy(db, {
      set,
      table: "tm_child",
      afterPk: copy1.lastPk,
      maxRows: 2,
    });
    if (copy2.kind !== "copy") throw new Error(JSON.stringify(copy2));
    expect(copy2.rows.map((r) => r.pk.id)).toEqual(["_", "a"]);
    expect(copy2.done).toBe(true);

    const columns = ["at", "id", "n", "name", "props", "not_on_source"];
    const keys = await readMirrorKeys(db, {
      set,
      table: "tm_parent",
      columns,
      afterPk: null,
    });
    if (keys.kind !== "keys") throw new Error(JSON.stringify(keys));
    expect(keys.columns).toEqual(["at", "id", "n", "name", "props"]);
    expect(keys.done).toBe(true);
    await db.execute(sql.raw(`SET TimeZone = 'UTC'`));
    const keysUtc = await readMirrorKeys(db, {
      set,
      table: "tm_parent",
      columns,
      afterPk: null,
    });
    if (keysUtc.kind !== "keys") throw new Error(JSON.stringify(keysUtc));
    expect(keysUtc.keys).toEqual(keys.keys);
    // The hash a replica computes over the same columns of the delivered row.
    const rows = await readMirrorRows(db, {
      set,
      table: "tm_parent",
      columns,
      pks: [{ id: P1 }, { id: P2 }],
    });
    if (rows.kind !== "rows") throw new Error(JSON.stringify(rows));
    expect(rows.missing).toEqual([{ id: P2 }]);
    expect(rows.rows.map((r) => r.h)).toEqual(keys.keys.map((k) => k.h));
    const replicaHash = (
      await db.execute(
        sql`SELECT md5((${rows.rows[0]!.row}::jsonb)::text) AS h`,
      )
    ).rows.map((r) => RowSchema.parse(r))[0]?.h;
    expect(replicaHash).toBe(keys.keys[0]!.h);
    // A narrower column list hashes differently.
    const narrow = await readMirrorKeys(db, {
      set,
      table: "tm_parent",
      columns: ["id"],
      afterPk: null,
    });
    if (narrow.kind !== "keys") throw new Error(JSON.stringify(narrow));
    expect(narrow.keys[0]!.h).not.toBe(keys.keys[0]!.h);
  });

  test("keys page by maxKeys; rows past the byte cap come back as remaining", async () => {
    const k1 = await readMirrorKeys(db, {
      set,
      table: "tm_child",
      columns: ["id", "path"],
      afterPk: null,
      maxKeys: 3,
    });
    if (k1.kind !== "keys") throw new Error(JSON.stringify(k1));
    expect(k1.keys.map((k) => k.pk.id)).toEqual(["B", "Z", "_"]);
    expect(k1.done).toBe(false);
    const k2 = await readMirrorKeys(db, {
      set,
      table: "tm_child",
      columns: ["id", "path"],
      afterPk: k1.lastPk,
      maxKeys: 3,
    });
    if (k2.kind !== "keys") throw new Error(JSON.stringify(k2));
    expect(k2.keys.map((k) => k.pk.id)).toEqual(["a"]);
    expect(k2.done).toBe(true);
    const rows = await readMirrorRows(db, {
      set,
      table: "tm_child",
      columns: ["id", "path"],
      pks: [{ id: "a" }, { id: "B" }, { id: "Z" }],
      maxBytes: 1,
    });
    if (rows.kind !== "rows") throw new Error(JSON.stringify(rows));
    expect(rows.rows.map((r) => r.pk.id)).toEqual(["a"]);
    expect(rows.remaining).toEqual([{ id: "B" }, { id: "Z" }]);
  });

  test("an unknown table is a named refusal", async () => {
    const r = await readMirrorCopy(db, {
      set,
      table: "tm_salt",
      afterPk: null,
    });
    expect(r).toEqual({
      kind: "unknown-table",
      setId: "tm_test",
      table: "tm_salt",
    });
  });
});

describe("fingerprints", () => {
  test("a column change moves the table's fingerprint; an omitted column does not count", async () => {
    const tables = set.tables;
    const before = await readTableFingerprints(db, "public", tables);
    expect(Object.keys(before).sort()).toEqual([
      "tm_child",
      "tm_pair",
      "tm_parent",
    ]);
    // Every row has a secret by now; the constraint is on an omitted column.
    await db.execute(
      sql.raw(`ALTER TABLE tm_parent ALTER COLUMN secret SET NOT NULL`),
    );
    expect((await readTableFingerprints(db, "public", tables)).tm_parent).toBe(
      before.tm_parent,
    );
    await db.execute(sql.raw(`ALTER TABLE tm_child ADD COLUMN extra text`));
    const after = await readTableFingerprints(db, "public", tables);
    expect(after.tm_child).not.toBe(before.tm_child);
    expect(after.tm_pair).toBe(before.tm_pair);
  });
});

describe("never mirrored", () => {
  test("a NeverMirrored table in a set throws at module eval", () => {
    expect(() => defineMirrorSet({ id: "tm_bad", tables: [tmSalt] })).toThrow(
      /NeverMirrored/,
    );
  });

  test("a set's table declared NeverMirrored afterwards throws too", () => {
    expect(() => NeverMirrored({ tables: [tmPair], reason: "late" })).toThrow(
      /already in mirror set "tm_test"/,
    );
  });

  test("the boot guard refuses the pair whatever the import order", () => {
    expect(() =>
      assertMirrorSetsAllowed([set], [{ tables: ["tm_pair"], reason: "x" }]),
    ).toThrow(/declared NeverMirrored/);
    expect(() => assertMirrorSetsAllowed([set, set], [])).toThrow(
      /contributed twice/,
    );
  });
});
