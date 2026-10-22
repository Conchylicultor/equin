import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { sql } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { TableLayoutRequirement } from "@plugins/framework/plugins/server-core/core";
import { rebuildTriggers } from "@plugins/database/plugins/change-feed/server/testing";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import type { Db } from "@plugins/database/server";
import { createPgliteDriver } from "./pglite-driver";

// The change feed's trigger layer on PGlite (research/2026-10-22-global-demo-
// writes-render-portable-change-feed.md G0): the real `rebuildTriggers` on a
// tiny schema, then the Postgres behaviours the feed's consumer leans on —
// observed on the WASM build the browser host runs, not assumed from the
// desktop's cluster:
//
// - STATEMENT triggers with `REFERENCING OLD/NEW TABLE` (both trigger
//   functions), and `pg_current_xact_id()` in their payloads;
// - the DEFERRABLE INITIALLY DEFERRED end-marker constraint trigger firing at
//   commit;
// - notifications delivered only once their transaction commits, a
//   transaction's `live_state` ones before its `live_state_end`, and none for a
//   rollback;
// - `pg_trigger.tgargs` (bytea) read back as a `Uint8Array`.
//
// Driven through the PGlite driver's own drizzle instance (the scripts-through-
// `exec` routing included) and its root client's `onNotification`.
//
// It runs in a FRESH bun process (this same file, re-run as a child with
// `PGLITE_NOTIFICATIONS_CHILD` set), as every PGlite suite here does: PGlite's
// Emscripten build picks its environment from `typeof window`, and the shared
// `bun test` process may hold barrel-import's stub `window` (installed by any
// earlier suite that calls `registerBarrelStubs`, e.g. migrations/check's
// schema-layer replay) — on which PGlite takes its browser path and dies in
// `ready()` on `window.encodeURIComponent`.

setDefaultTimeout(120_000);

const IN_CHILD = process.env.PGLITE_NOTIFICATIONS_CHILD === "1";

if (!IN_CHILD) {
  test("the change feed's trigger layer on PGlite (in a fresh process)", async () => {
    const result = await spawnCaptured(
      [process.execPath, "test", import.meta.path],
      {
        // The repo root, so the child reads the same bunfig (test preload).
        cwd: REPO_ROOT,
        env: { ...process.env, PGLITE_NOTIFICATIONS_CHILD: "1" },
        timeoutMs: 100_000,
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `PGlite notifications child exited ${result.exitCode}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
      );
    }
    expect(result.exitCode).toBe(0);
  });
}

const NO_EXCLUSIONS = {
  feedExempt: new Set<string>(),
  optedOut: new Set<string>(),
  produced: new Set<string>(),
};

// `gadgets` is routed (carries `widget_id`, its UPDATE reads both transition
// tables); `widgets` keeps the PK-only trigger.
const LAYOUTS: TableLayoutRequirement[] = [
  { table: "gadgets", carry: ["widget_id"], reads: [["id", "widget_id"]] },
];

let db: Db;
let client: PGlite;
const heard: { channel: string; payload: string }[] = [];
let stopHearing: () => void;

/** Let every queued notification callback run (PGlite queues them as microtasks). */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function drain(): { channel: string; payload: Record<string, unknown> }[] {
  return heard.splice(0).map((n) => ({
    channel: n.channel,
    payload: JSON.parse(n.payload) as Record<string, unknown>,
  }));
}

describe.if(IN_CHILD)("the change feed's trigger layer on PGlite", () => {
  beforeAll(async () => {
    const driver = createPgliteDriver();
    await driver.ready();
    db = driver.db();
    client = (db as unknown as { $client: PGlite }).$client;
    await db.execute(
      sql`CREATE TABLE widgets (id text PRIMARY KEY, name text)`,
    );
    await db.execute(
      sql`CREATE TABLE gadgets (id text PRIMARY KEY, widget_id text, label text)`,
    );
    await rebuildTriggers(db, NO_EXCLUSIONS, LAYOUTS);
    stopHearing = client.onNotification((channel, payload) => {
      heard.push({ channel, payload });
    });
    await client.exec("LISTEN live_state; LISTEN live_state_end");
  });

  afterAll(async () => {
    stopHearing();
    await client.close();
  });

  test("rebuildTriggers installs both trigger kinds and the deferred end marker", async () => {
    const rows = await db.execute<{
      relname: string;
      tgname: string;
      deferrable: boolean;
      deferred: boolean;
    }>(
      sql`SELECT c.relname, t.tgname, t.tgdeferrable AS deferrable, t.tginitdeferred AS deferred
          FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          WHERE NOT t.tgisinternal ORDER BY c.relname, t.tgname`,
    );
    const byTable = new Map<string, string[]>();
    for (const r of rows.rows) {
      byTable.set(r.relname, [...(byTable.get(r.relname) ?? []), r.tgname]);
    }
    expect(byTable.get("widgets")?.length).toBeGreaterThan(0);
    expect(byTable.get("gadgets")?.length).toBeGreaterThan(0);
    const marker = rows.rows.find((r) => r.tgname === "live_state_txn_end");
    expect(marker).toMatchObject({
      relname: "live_state_changelog",
      deferrable: true,
      deferred: true,
    });
  });

  test("pg_current_xact_id() answers", async () => {
    const res = await db.execute<{ x: string }>(
      sql`SELECT pg_current_xact_id()::text AS x`,
    );
    expect(res.rows[0]?.x).toMatch(/^\d+$/);
  });

  test("tgargs comes back as a Uint8Array", async () => {
    const res = await db.execute<{ tgargs: unknown; tgnargs: number }>(
      sql`SELECT t.tgargs, t.tgnargs::int AS tgnargs FROM pg_trigger t
          JOIN pg_class c ON c.oid = t.tgrelid
          WHERE c.relname = 'gadgets' AND NOT t.tgisinternal LIMIT 1`,
    );
    const row = res.rows[0]!;
    expect(row.tgargs).toBeInstanceOf(Uint8Array);
    expect(row.tgnargs).toBe(3);
    // NUL-terminated arguments: the PK column first.
    const args = new TextDecoder()
      .decode(row.tgargs as Uint8Array)
      .split("\0")
      .slice(0, row.tgnargs);
    expect(args[0]).toBe("id");
    expect(JSON.parse(args[1]!)).toEqual(["widget_id"]);
  });

  test("a transaction's changes arrive at commit, before its end marker, across both channels", async () => {
    drain();
    let xid = "";
    await db.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO widgets VALUES ('w1', 'one')`);
      await tx.execute(sql`INSERT INTO gadgets VALUES ('g1', 'w1', 'a')`);
      await tx.execute(
        sql`UPDATE gadgets SET widget_id = 'w2' WHERE id = 'g1'`,
      );
      xid = (
        await tx.execute<{ x: string }>(
          sql`SELECT pg_current_xact_id()::text AS x`,
        )
      ).rows[0]!.x;
      await settle();
      // Nothing before commit.
      expect(heard).toEqual([]);
    });
    await settle();
    const got = drain();
    expect(got.map((n) => n.channel)).toEqual([
      "live_state",
      "live_state",
      "live_state",
      "live_state_end",
    ]);
    expect(got.map((n) => n.payload.x)).toEqual([xid, xid, xid, xid]);
    expect(got.slice(0, 3).map((n) => [n.payload.t, n.payload.op])).toEqual([
      ["widgets", "I"],
      ["gadgets", "I"],
      ["gadgets", "U"],
    ]);
    // The routed UPDATE read OLD and NEW: both hosts of the moved key.
    expect(got[2]!.payload.k).toEqual({
      c: ["widget_id"],
      r: expect.arrayContaining([["w1"], ["w2"]]) as unknown,
    });
    expect(got[3]!.payload.n).toBe(3);
  });

  test("an autocommit statement is its own transaction, ended by its marker", async () => {
    drain();
    await db.execute(sql`DELETE FROM widgets WHERE id = 'w1'`);
    await settle();
    const got = drain();
    expect(got.map((n) => [n.channel, n.payload.op ?? null])).toEqual([
      ["live_state", "D"],
      ["live_state_end", null],
    ]);
    expect(got[1]!.payload.n).toBe(1);
  });

  test("a rolled-back transaction notifies nothing", async () => {
    drain();
    const rollback = new Error("roll back");
    const outcome = await db
      .transaction(async (tx) => {
        await tx.execute(sql`INSERT INTO widgets VALUES ('w9', 'nine')`);
        throw rollback;
      })
      .then(
        () => "committed",
        (err: unknown) => err,
      );
    expect(outcome).toBe(rollback);
    await settle();
    expect(drain()).toEqual([]);
    const rows = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM live_state_changelog WHERE t = 'widgets' AND op = 'I' AND 'w9' = ANY(ids)`,
    );
    expect(rows.rows[0]?.n).toBe(0);
  });
});
