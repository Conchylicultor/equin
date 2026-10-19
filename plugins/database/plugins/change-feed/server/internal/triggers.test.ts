import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { ensureChangelogTable, rebuildTriggers } from "./triggers";
import { assertNoOtherDeferredTriggers } from "./txn-end";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";

// Real-DB trigger-rebuild suite, pinning the SKIP-WHAT-IS-UNCHANGED fast-path
// (per table: a change rebuilds only the tables it changed) AND the
// single-relation rebuild contract.
//
// On a hot-swap restart the previous backend is still reading these tables, so a
// rebuild that held AccessExclusive locks on many tables in ONE transaction could
// deadlock and take boot down with it — build build-1784288281433-w62dep died
// exactly that way. Two properties now keep that from recurring, both load-bearing
// and under test here: (1) the rebuild is SKIPPED entirely when the live trigger
// layer already IS the desired one (no locks at all), and (2) when a rebuild does
// run, it is split into ONE transaction per table, so no transaction ever holds
// more than a single relation's lock and a deadlock cycle is impossible by
// construction.
//
// The witness for skip-vs-rebuild is TRIGGER OID IDENTITY: a rebuild is
// DROP+CREATE, which necessarily mints a new pg_trigger row (new oid). Unchanged
// oids across two calls therefore prove no DROP+CREATE ran — the actual property,
// observed directly rather than through a spy or a log line.
//
// Requires a running Postgres cluster (started by ./singularity build). If the
// cluster is unreachable, createTestDb() throws loudly rather than skipping.

let testDb: TestDb;

// A throwaway database carries no rollups and no opt-outs; the booted server
// reads both from its contributions.
const NO_EXCLUSIONS = {
  feedExempt: new Set<string>(),
  optedOut: new Set<string>(),
  produced: new Set<string>(),
};

// The feed's own trigger rows, keyed name → oid, for the tables this suite makes
// (the changelog's end marker is the shared layer's — see `markerOid`).
async function triggerOids(): Promise<Map<string, string>> {
  const res = await testDb.db.execute<{ tgname: string; oid: string }>(
    sql`SELECT t.tgname, t.oid::text AS oid
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND NOT t.tgisinternal
          AND t.tgname LIKE 'live_state_%'
          AND c.relname <> 'live_state_changelog'
        ORDER BY t.tgname`,
  );
  return new Map(res.rows.map((r) => [r.tgname, r.oid]));
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
  test("installs the feed on a public table", async () => {
    await rebuildTriggers(testDb.db, NO_EXCLUSIONS, []);

    const oids = await triggerOids();
    expect([...oids.keys()]).toEqual([
      "live_state_widgets_d",
      "live_state_widgets_i",
      "live_state_widgets_u",
    ]);
  });

  test("skips an unchanged rebuild — same trigger oids, no DROP+CREATE", async () => {
    const before = await triggerOids();
    await rebuildTriggers(testDb.db, NO_EXCLUSIONS, []);
    const after = await triggerOids();

    // Identical oids ⇒ the rows were never dropped and recreated ⇒ the rebuild
    // (and its per-table lock windows) was skipped.
    expect(after).toEqual(before);
  });

  test("rebuilds when a trigger was dropped out of band — the signature alone is not trusted", async () => {
    const before = await triggerOids();
    await testDb.db.execute(sql`DROP TRIGGER live_state_widgets_u ON widgets`);

    // The stored signature still matches (nothing about the desired layer changed),
    // so only the physical-presence guard can catch this.
    await rebuildTriggers(testDb.db, NO_EXCLUSIONS, []);

    const after = await triggerOids();
    expect([...after.keys()]).toEqual([...before.keys()]);
    // Fresh oids: a real rebuild ran rather than a false skip.
    expect(after.get("live_state_widgets_i")).not.toBe(
      before.get("live_state_widgets_i"),
    );
  });

  test("a new table installs its own feed and rebuilds no other table", async () => {
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
    // widgets' compiled DDL did not change: its triggers were not touched.
    for (const op of ["i", "u", "d"]) {
      expect(after.get(`live_state_widgets_${op}`)).toBe(
        before.get(`live_state_widgets_${op}`)!,
      );
    }
  });

  test("skips again once the new table's feed is installed", async () => {
    const before = await triggerOids();
    await rebuildTriggers(testDb.db, NO_EXCLUSIONS, []);
    expect(await triggerOids()).toEqual(before);
  });

  test("a route changing one table's layout rebuilds that table alone", async () => {
    const before = await triggerOids();
    await rebuildTriggers(testDb.db, NO_EXCLUSIONS, [
      { table: "gadgets", carry: [], reads: [] },
    ]);
    const after = await triggerOids();
    expect(after.get("live_state_gadgets_u")).not.toBe(
      before.get("live_state_gadgets_u"),
    );
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

  test("a dropped table's signature is forgotten, and nothing else rebuilds", async () => {
    const before = await triggerOids();
    await testDb.db.execute(sql`DROP TABLE gadgets`);
    await rebuildTriggers(testDb.db, NO_EXCLUSIONS, []);
    expect(await triggerOids()).toEqual(
      new Map([...before].filter(([name]) => name.includes("widgets"))),
    );
    const rows = await testDb.db.execute<{ relname: string }>(
      sql`SELECT relname FROM live_state_trigger_state ORDER BY relname`,
    );
    // The shared layer's row ('') and widgets'.
    expect(rows.rows.map((r) => r.relname)).toEqual(["", "widgets"]);
  });

  test("the first, one-row state table is replaced — one rebuild of every table, then skips", async () => {
    await testDb.db.execute(sql`DROP TABLE live_state_trigger_state`);
    await testDb.db.execute(
      sql`CREATE TABLE live_state_trigger_state (id boolean PRIMARY KEY DEFAULT true CHECK (id), signature text NOT NULL)`,
    );
    await testDb.db.execute(
      sql`INSERT INTO live_state_trigger_state (signature) VALUES ('old')`,
    );
    const before = await triggerOids();
    await rebuildTriggers(testDb.db, NO_EXCLUSIONS, []);
    const after = await triggerOids();
    expect(after.get("live_state_widgets_i")).not.toBe(
      before.get("live_state_widgets_i"),
    );
    await rebuildTriggers(testDb.db, NO_EXCLUSIONS, []);
    expect(await triggerOids()).toEqual(after);
  });
});

describe("the end-of-transaction marker", () => {
  test("is installed with the shared layer: deferred, and kept by a skipped rebuild", async () => {
    await rebuildTriggers(testDb.db, NO_EXCLUSIONS, []);
    const marker = await markerOid();
    expect(marker).toMatchObject({ deferrable: true, deferred: true });
    await rebuildTriggers(testDb.db, NO_EXCLUSIONS, []);
    expect((await markerOid())?.oid).toBe(marker!.oid);
  });

  test("is re-created when dropped out of band — and no table rebuilds for it", async () => {
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
      // `expect(p).rejects` is typed `void` under bun:test: settle it by hand.
      const err = await assertNoOtherDeferredTriggers(testDb.db, [
        "widgets",
      ]).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/"late_writer" on "widgets"/);
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
