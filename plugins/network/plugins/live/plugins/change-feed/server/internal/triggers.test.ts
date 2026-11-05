import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { sha256Hex } from "@plugins/packages/plugins/string-hash/core";
import { ensureChangelogTable, rebuildTriggers } from "./triggers";
import { assertNoOtherDeferredTriggers } from "./txn-end";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";

// Real-DB trigger-install suite. The feed's triggers are one `db-triggers` set
// installed one table per transaction, so it pins: (1) a steady-state install
// re-runs NOTHING (no table lock at all); (2) a change re-runs exactly the
// tables it changed; (3) each table commits on its own — the property that
// makes a lock cycle with the previous backend's writers impossible during a
// hot swap (build-1784288281433-w62dep died of one); (4) the former
// installer's triggers are adopted, not re-created.
//
// The witness for re-run vs skip is the trigger row's VERSION (oid + xmin):
// `CREATE OR REPLACE TRIGGER` rewrites the pg_trigger row (new xmin), a
// re-create mints a new oid, and a COMMENT (an adoption's restamp) touches
// neither — observed directly rather than through a spy or a log line.
//
// Requires a running Postgres cluster (started by ./equin build). If the
// cluster is unreachable, createTestDb() throws loudly rather than skipping.

let testDb: TestDb;

// A throwaway database carries no rollups and no opt-outs; the booted server
// reads both from its contributions.
const NO_EXCLUSIONS = {
  feedExempt: new Set<string>(),
  optedOut: new Set<string>(),
  produced: new Set<string>(),
};

// The feed's own trigger rows, keyed name → version, for the tables this suite
// makes (the changelog's end marker is not the set's — see `markerOid`).
async function triggerOids(): Promise<Map<string, string>> {
  const res = await testDb.db.execute<{ tgname: string; version: string }>(
    sql`SELECT t.tgname, t.oid::text || ':' || t.xmin::text AS version
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND NOT t.tgisinternal
          AND t.tgname LIKE 'live_state_%'
          AND c.relname <> 'live_state_changelog'
        ORDER BY t.tgname`,
  );
  return new Map(res.rows.map((r) => [r.tgname, r.version]));
}

// One trigger's COMMENT (its installer's stamp), or null.
async function stampOf(table: string, name: string): Promise<string | null> {
  const res = await testDb.db.execute<{ comment: string | null }>(
    sql.raw(
      `SELECT obj_description(oid, 'pg_trigger') AS comment FROM pg_trigger
        WHERE tgrelid = '${table}'::regclass AND tgname = '${name}'`,
    ),
  );
  return res.rows[0]?.comment ?? null;
}

// The end-of-transaction marker's trigger row on the changelog, or undefined.
async function markerOid(): Promise<
  { oid: string; deferrable: boolean; deferred: boolean } | undefined
> {
  const res = await testDb.db.execute<{
    oid: string;
    deferrable: boolean;
    deferred: boolean;
  }>(
    sql`SELECT t.oid::text AS oid, t.tgdeferrable AS deferrable, t.tginitdeferred AS deferred
        FROM pg_trigger t
        WHERE t.tgrelid = 'live_state_changelog'::regclass
          AND t.tgname = 'live_state_txn_end'`,
  );
  return res.rows[0];
}

beforeAll(async () => {
  testDb = await createTestDb({ prefix: "cf_trig_test" });
  await testDb.db.execute(
    sql`CREATE TABLE widgets (id text PRIMARY KEY, name text)`,
  );
});

afterAll(async () => {
  await testDb?.drop();
});

describe("rebuildTriggers", () => {
  test("installs the feed on a public table, stamped as the change-feed set", async () => {
    await rebuildTriggers(testDb.db, NO_EXCLUSIONS, []);

    const oids = await triggerOids();
    expect([...oids.keys()]).toEqual([
      "live_state_widgets_d",
      "live_state_widgets_i",
      "live_state_widgets_u",
    ]);
    expect(await stampOf("widgets", "live_state_widgets_i")).toStartWith(
      "db-triggers:change-feed:",
    );
  });

  test("re-runs nothing when unchanged — same trigger rows", async () => {
    const before = await triggerOids();
    await rebuildTriggers(testDb.db, NO_EXCLUSIONS, []);
    expect(await triggerOids()).toEqual(before);
  });

  test("re-creates a trigger dropped out of band", async () => {
    const before = await triggerOids();
    await testDb.db.execute(sql`DROP TRIGGER live_state_widgets_u ON widgets`);
    await rebuildTriggers(testDb.db, NO_EXCLUSIONS, []);

    const after = await triggerOids();
    expect([...after.keys()]).toEqual([...before.keys()]);
    expect(after.get("live_state_widgets_u")).not.toBe(
      before.get("live_state_widgets_u"),
    );
    // Its siblings were current: untouched.
    expect(after.get("live_state_widgets_i")).toBe(
      before.get("live_state_widgets_i")!,
    );
  });

  test("re-runs a trigger replaced out of band — its stamp kept, its definition not", async () => {
    await testDb.db.execute(
      sql`CREATE OR REPLACE TRIGGER live_state_widgets_i AFTER INSERT ON widgets
          REFERENCING NEW TABLE AS new_rows
          FOR EACH STATEMENT EXECUTE FUNCTION live_state_notify('')`,
    );
    const replaced = await triggerOids();
    await rebuildTriggers(testDb.db, NO_EXCLUSIONS, []);
    expect((await triggerOids()).get("live_state_widgets_i")).not.toBe(
      replaced.get("live_state_widgets_i"),
    );
    const args = await testDb.db.execute<{ args: string }>(
      sql`SELECT encode(tgargs, 'escape') AS args FROM pg_trigger
          WHERE tgrelid = 'widgets'::regclass AND tgname = 'live_state_widgets_i'`,
    );
    expect(args.rows[0]!.args).toBe("id\\000");
  });

  test("a new table installs its own feed and re-runs no other table", async () => {
    const before = await triggerOids();
    await testDb.db.execute(sql`CREATE TABLE gadgets (id text PRIMARY KEY)`);

    await rebuildTriggers(testDb.db, NO_EXCLUSIONS, []);

    const after = await triggerOids();
    expect([...after.keys()]).toEqual([
      "live_state_gadgets_d",
      "live_state_gadgets_i",
      "live_state_gadgets_u",
      "live_state_widgets_d",
      "live_state_widgets_i",
      "live_state_widgets_u",
    ]);
    for (const op of ["i", "u", "d"]) {
      expect(after.get(`live_state_widgets_${op}`)).toBe(
        before.get(`live_state_widgets_${op}`)!,
      );
    }
  });

  test("a route changing one table's layout replaces that table's triggers in place, alone", async () => {
    const before = await triggerOids();
    await rebuildTriggers(testDb.db, NO_EXCLUSIONS, [
      { table: "gadgets", carry: [], reads: [] },
    ]);
    const after = await triggerOids();
    // Replaced in place — the UPDATE trigger's REFERENCING clause gains OLD
    // TABLE — so the same oid, a new row version.
    const [oidBefore] = before.get("live_state_gadgets_u")!.split(":");
    const [oidAfter] = after.get("live_state_gadgets_u")!.split(":");
    expect(oidAfter).toBe(oidBefore!);
    expect(after.get("live_state_gadgets_u")).not.toBe(
      before.get("live_state_gadgets_u"),
    );
    const def = await testDb.db.execute<{ def: string }>(
      sql`SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger
          WHERE tgrelid = 'gadgets'::regclass AND tgname = 'live_state_gadgets_u'`,
    );
    expect(def.rows[0]!.def).toContain(
      "REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows",
    );
    expect(def.rows[0]!.def).toContain("live_state_notify_routed(");
    for (const op of ["i", "u", "d"]) {
      expect(after.get(`live_state_widgets_${op}`)).toBe(
        before.get(`live_state_widgets_${op}`)!,
      );
    }
    // And back: the PK-only layout is again a change of gadgets alone.
    await rebuildTriggers(testDb.db, NO_EXCLUSIONS, []);
    const back = await triggerOids();
    expect(back.get("live_state_widgets_u")).toBe(
      before.get("live_state_widgets_u")!,
    );
    expect(back.get("live_state_gadgets_u")).not.toBe(
      after.get("live_state_gadgets_u"),
    );
  });

  test("drops the feed of a table now excluded, and nothing else", async () => {
    const before = await triggerOids();
    await rebuildTriggers(
      testDb.db,
      { ...NO_EXCLUSIONS, optedOut: new Set(["gadgets"]) },
      [],
    );
    expect(await triggerOids()).toEqual(
      new Map([...before].filter(([name]) => name.includes("widgets"))),
    );
    await rebuildTriggers(testDb.db, NO_EXCLUSIONS, []);
    expect([...(await triggerOids()).keys()]).toEqual([...before.keys()]);
  });

  test("commits each table on its own: one table's writer never holds back another's install", async () => {
    // Both tables' triggers are stale; a writer holds ROW EXCLUSIVE on
    // widgets (the later of the two in the fixed order). gadgets' replacement
    // must commit — visible from another session — while the install still
    // waits on widgets.
    await testDb.db.execute(
      sql`COMMENT ON TRIGGER live_state_gadgets_i ON gadgets IS NULL`,
    );
    await testDb.db.execute(
      sql`COMMENT ON TRIGGER live_state_widgets_i ON widgets IS NULL`,
    );
    const before = await triggerOids();
    // The suite's `db` is one connection, busy with the install while it
    // waits: watch from a session of our own.
    const writer = new Client({ connectionString: testDb.connectionString });
    const observer = new Client({ connectionString: testDb.connectionString });
    await writer.connect();
    await observer.connect();
    const gadgetsVersion = async () =>
      (
        await observer.query<{ version: string }>(
          `SELECT oid::text || ':' || xmin::text AS version FROM pg_trigger
            WHERE tgrelid = 'gadgets'::regclass AND tgname = 'live_state_gadgets_i'`,
        )
      ).rows[0]?.version;
    try {
      await writer.query("BEGIN");
      await writer.query("INSERT INTO widgets VALUES ('w-held', 'x')");
      const install = rebuildTriggers(testDb.db, NO_EXCLUSIONS, []);
      const deadline = Date.now() + 10_000;
      let gadgets = before.get("live_state_gadgets_i");
      while (
        gadgets === before.get("live_state_gadgets_i") &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 50));
        gadgets = await gadgetsVersion();
      }
      expect(gadgets).not.toBe(before.get("live_state_gadgets_i"));
      const widgets = await observer.query<{ version: string }>(
        `SELECT oid::text || ':' || xmin::text AS version FROM pg_trigger
          WHERE tgrelid = 'widgets'::regclass AND tgname = 'live_state_widgets_i'`,
      );
      expect(widgets.rows[0]?.version).toBe(
        before.get("live_state_widgets_i")!,
      );
      await writer.query("ROLLBACK");
      await install;
    } finally {
      await writer.end();
      await observer.end();
    }
    expect((await triggerOids()).get("live_state_widgets_i")).not.toBe(
      before.get("live_state_widgets_i"),
    );
  }, 30_000);

  test("a dropped table's feed goes with it, and nothing else re-runs", async () => {
    const before = await triggerOids();
    await testDb.db.execute(sql`DROP TABLE gadgets`);
    await rebuildTriggers(testDb.db, NO_EXCLUSIONS, []);
    expect(await triggerOids()).toEqual(
      new Map([...before].filter(([name]) => name.includes("widgets"))),
    );
  });
});

// What the feed's former installer ran for widgets (PK `id`, no layout), and
// the signature it kept for it in `live_state_trigger_state`.
const FORMER_WIDGETS_DDL = [
  `DROP TRIGGER IF EXISTS "live_state_widgets_i" ON "widgets"`,
  `DROP TRIGGER IF EXISTS "live_state_widgets_u" ON "widgets"`,
  `DROP TRIGGER IF EXISTS "live_state_widgets_d" ON "widgets"`,
  `CREATE TRIGGER "live_state_widgets_i" AFTER INSERT ON "widgets"
           REFERENCING NEW TABLE AS new_rows
           FOR EACH STATEMENT EXECUTE FUNCTION live_state_notify('id')`,
  `CREATE TRIGGER "live_state_widgets_u" AFTER UPDATE ON "widgets"
           REFERENCING NEW TABLE AS new_rows
           FOR EACH STATEMENT EXECUTE FUNCTION live_state_notify('id')`,
  `CREATE TRIGGER "live_state_widgets_d" AFTER DELETE ON "widgets"
           REFERENCING OLD TABLE AS old_rows
           FOR EACH STATEMENT EXECUTE FUNCTION live_state_notify('id')`,
];

async function formerInstall(signature: string): Promise<void> {
  for (const stmt of FORMER_WIDGETS_DDL) await testDb.db.execute(sql.raw(stmt));
  await testDb.db.execute(
    sql`CREATE TABLE IF NOT EXISTS live_state_trigger_state (relname text PRIMARY KEY, signature text NOT NULL)`,
  );
  await testDb.db.execute(
    sql`INSERT INTO live_state_trigger_state VALUES ('widgets', ${signature})
        ON CONFLICT (relname) DO UPDATE SET signature = EXCLUDED.signature`,
  );
}

async function stateTableExists(): Promise<boolean> {
  const res = await testDb.db.execute<{ t: string | null }>(
    sql`SELECT to_regclass('public.live_state_trigger_state')::text AS t`,
  );
  return res.rows[0]!.t !== null;
}

describe("the former installer's triggers", () => {
  test("are adopted (restamped, never re-created) when its signature matches, and its state table dropped", async () => {
    await formerInstall(sha256Hex(FORMER_WIDGETS_DDL.join("\n")));
    const before = await triggerOids();
    expect(await stampOf("widgets", "live_state_widgets_i")).toBeNull();

    await rebuildTriggers(testDb.db, NO_EXCLUSIONS, []);

    expect(await triggerOids()).toEqual(before);
    expect(await stampOf("widgets", "live_state_widgets_i")).toStartWith(
      "db-triggers:change-feed:",
    );
    expect(await stateTableExists()).toBe(false);
  });

  test("are re-run when its signature does not match", async () => {
    await formerInstall("not-this-ddl");
    const before = await triggerOids();
    await rebuildTriggers(testDb.db, NO_EXCLUSIONS, []);
    expect((await triggerOids()).get("live_state_widgets_i")).not.toBe(
      before.get("live_state_widgets_i"),
    );
    expect(await stateTableExists()).toBe(false);
  });
});

describe("the end-of-transaction marker", () => {
  test("is installed by the prelude: deferred, and kept by a later install", async () => {
    await rebuildTriggers(testDb.db, NO_EXCLUSIONS, []);
    const marker = await markerOid();
    expect(marker).toMatchObject({ deferrable: true, deferred: true });
    await rebuildTriggers(testDb.db, NO_EXCLUSIONS, []);
    expect((await markerOid())?.oid).toBe(marker!.oid);
  });

  test("is re-created when dropped out of band — and no table re-runs for it", async () => {
    const before = await triggerOids();
    await testDb.db.execute(
      sql`DROP TRIGGER live_state_txn_end ON live_state_changelog`,
    );
    await rebuildTriggers(testDb.db, NO_EXCLUSIONS, []);
    expect(await markerOid()).toMatchObject({ deferred: true });
    expect(await triggerOids()).toEqual(before);
  });

  test("is re-created when its function was dropped out of band", async () => {
    await testDb.db.execute(sql`DROP FUNCTION live_state_txn_end() CASCADE`);
    expect(await markerOid()).toBeUndefined();
    await rebuildTriggers(testDb.db, NO_EXCLUSIONS, []);
    expect(await markerOid()).toMatchObject({ deferred: true });
  });

  test("is replaced when made immediate out of band", async () => {
    await testDb.db.execute(
      sql`DROP TRIGGER live_state_txn_end ON live_state_changelog`,
    );
    await testDb.db.execute(
      sql`CREATE CONSTRAINT TRIGGER live_state_txn_end AFTER INSERT ON live_state_changelog
          NOT DEFERRABLE FOR EACH ROW EXECUTE FUNCTION live_state_txn_end()`,
    );
    expect(await markerOid()).toMatchObject({ deferrable: false });
    await rebuildTriggers(testDb.db, NO_EXCLUSIONS, []);
    expect(await markerOid()).toMatchObject({
      deferrable: true,
      deferred: true,
    });
  });

  test("emits once per transaction, at commit, counting its statements", async () => {
    const watcher = new Client({ connectionString: testDb.connectionString });
    await watcher.connect();
    const got: Array<{ channel: string; payload: string }> = [];
    watcher.on("notification", (n) =>
      got.push({ channel: n.channel, payload: n.payload ?? "" }),
    );
    await watcher.query("LISTEN live_state; LISTEN live_state_end");
    try {
      await testDb.db.transaction(async (tx) => {
        await tx.execute(sql`INSERT INTO widgets VALUES ('m1', 'a')`);
        await tx.execute(sql`UPDATE widgets SET name = 'b' WHERE id = 'm1'`);
        await tx.execute(sql`DELETE FROM widgets WHERE id = 'm1'`);
      });
      const deadline = Date.now() + 5000;
      while (got.length < 4 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(got.map((g) => g.channel)).toEqual([
        "live_state",
        "live_state",
        "live_state",
        "live_state_end",
      ]);
      const x = (JSON.parse(got[0]!.payload) as { x: string }).x;
      expect(JSON.parse(got[3]!.payload)).toEqual({ x, n: 3 });
    } finally {
      await watcher.end();
    }
  });
});

describe("assertNoOtherDeferredTriggers", () => {
  test("passes with only the marker deferred, and names any other deferred trigger", async () => {
    await assertNoOtherDeferredTriggers(testDb.db, ["widgets"]);
    await testDb.db.execute(
      sql`CREATE CONSTRAINT TRIGGER late_writer AFTER INSERT ON widgets
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION live_state_txn_end()`,
    );
    try {
      // Not a table the feed routes: out of scope.
      await assertNoOtherDeferredTriggers(testDb.db, []);
      expect(
        assertNoOtherDeferredTriggers(testDb.db, ["widgets"]),
      ).rejects.toThrow(/"late_writer" on "widgets"/);
    } finally {
      await testDb.db.execute(sql`DROP TRIGGER late_writer ON widgets`);
    }
  });
});

describe("ensureChangelogTable", () => {
  // Every trigger on every table INSERTs into the changelog, so a statement
  // that locks it — even one with nothing to do — queues behind any open
  // writing transaction, and every other writer queues behind it.
  test("takes no lock on a changelog already in shape", async () => {
    await ensureChangelogTable(testDb.db);
    const writer = new Client({ connectionString: testDb.connectionString });
    await writer.connect();
    try {
      await writer.query("BEGIN");
      await writer.query(
        "INSERT INTO live_state_changelog (xid, t, op) VALUES (1, 'x', 'I')",
      );
      // The writer holds ROW EXCLUSIVE until it ends: an ALTER / CREATE INDEX
      // would wait for it. Nothing does.
      const settled = await Promise.race([
        ensureChangelogTable(testDb.db).then(() => "done" as const),
        new Promise<"blocked">((resolve) =>
          setTimeout(() => resolve("blocked"), 3000),
        ),
      ]);
      expect(settled).toBe("done");
    } finally {
      await writer.query("ROLLBACK");
      await writer.end();
    }
  });

  test("adds the columns a changelog created before them lacks", async () => {
    await testDb.db.execute(
      sql`ALTER TABLE live_state_changelog DROP COLUMN keys, DROP COLUMN unchanged`,
    );
    await ensureChangelogTable(testDb.db);
    const cols = await testDb.db.execute<{ attname: string }>(
      sql`SELECT attname FROM pg_attribute
          WHERE attrelid = 'live_state_changelog'::regclass AND attnum > 0 AND NOT attisdropped
          ORDER BY attnum`,
    );
    expect(cols.rows.map((r) => r.attname)).toEqual([
      "seq",
      "xid",
      "t",
      "op",
      "ids",
      "at",
      "keys",
      "unchanged",
    ]);
  });
});
