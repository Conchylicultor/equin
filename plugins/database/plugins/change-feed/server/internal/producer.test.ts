/**
 * The in-process change producer (`./producer`): `mutate` emits exactly the PKs
 * its statement returned, the source-side coalescer, the root context, and the
 * runtime guards (A12, A13). The statements run on a throwaway database
 * (db-test-fixture); the routed changes are captured through
 * `mountProducersForTest`'s `route`. Run with
 * `./singularity test plugins/database/plugins/change-feed`.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
// Installs the profiler's AsyncLocalStorage runtimes, so `runWithoutProfiling`
// really suppresses — the root-context test needs a scope to escape.
import "@plugins/infra/plugins/runtime-profiler/server";
import {
  onSlowSpan,
  runWithoutProfiling,
  type SlowSpan,
} from "@plugins/infra/plugins/runtime-profiler/core";
import { setErrorReporter } from "@plugins/framework/plugins/server-core/core";
import {
  changesOf,
  defineChangeProducer,
  flushNow,
  mountProducersForTest,
  PRODUCER_IDS_CAP,
} from "./producer";
import type { RoutedChange } from "./route-change";

const _items = pgTable("pt_items", {
  id: text("id").primaryKey(),
  n: integer("n").notNull(),
});
const _now = pgTable("pt_now", {
  id: text("id").primaryKey(),
  n: integer("n").notNull(),
});
const _other = pgTable("pt_other", { id: text("id").primaryKey() });
const _unmounted = pgTable("pt_unmounted", { id: text("id").primaryKey() });

const WINDOW_MS = 100;
const items = defineChangeProducer({
  table: _items,
  durability: "volatile",
  reason: "suite fixture",
  coalesce: { ms: WINDOW_MS, reason: "suite window" },
});
const now = defineChangeProducer({
  table: _now,
  durability: "volatile",
  reason: "suite fixture",
  coalesce: "none",
});
const unmounted = defineChangeProducer({
  table: _unmounted,
  durability: "volatile",
  reason: "suite fixture — never mounted",
  coalesce: "none",
});

// Never called: each line is a statement tsc must refuse (T4, T6, T7).
function typeContract(db: NodePgDatabase): void {
  // @ts-expect-error — a builder on another table (T7)
  void items.mutate(db, (q) => q.update(_other).set({ id: "x" }), {
    latency: "background",
  });
  // @ts-expect-error — `latency` is required (T6)
  void items.mutate(db, (q, t) => q.delete(t), {});
  // @ts-expect-error — the producer appends RETURNING; a builder may not
  void items.mutate(db, (q, t) => q.delete(t).returning(), {
    latency: "background",
  });
  // @ts-expect-error — `update(t)` without `.set()` is no statement yet
  void items.mutate(db, (q, t) => q.update(t), { latency: "background" });
  void db.transaction(async (tx) => {
    // @ts-expect-error — a transaction is not the pool (T4)
    await items.mutate(tx, (q, t) => q.delete(t), { latency: "background" });
  });
}
void typeContract;

let t: TestDb;
let routed: RoutedChange[];
let unmount: () => void;

beforeAll(async () => {
  t = await createTestDb({ prefix: "cf_producer" });
  for (const table of ["pt_items", "pt_now"]) {
    await t.db.execute(
      sql.raw(
        `CREATE TABLE ${table} (id text PRIMARY KEY, n integer NOT NULL)`,
      ),
    );
  }
  await t.db.execute(sql`CREATE TABLE pt_unmounted (id text PRIMARY KEY)`);
});

afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  await t.db.execute(sql`DELETE FROM pt_items`);
  await t.db.execute(sql`DELETE FROM pt_now`);
  routed = [];
  unmount = mountProducersForTest([items, now], {
    route: (c) => routed.push(c),
  });
});

afterEach(() => unmount());

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const sortedIds = (c: RoutedChange) => [...(c.ids ?? [])].sort();

describe("mutate", () => {
  test("emits exactly the PKs the statement returned — an insert or upsert is a U, a delete a D", async () => {
    const rows = await now.mutate(
      t.db,
      (q, tb) =>
        q
          .insert(tb)
          .values([
            { id: "a", n: 1 },
            { id: "b", n: 2 },
          ])
          .onConflictDoUpdate({ target: tb.id, set: { n: 9 } }),
      { latency: "background", returning: { n: _now.n } },
    );
    expect(rows.map((r) => r.n).sort()).toEqual([1, 2]);
    expect(Object.keys(rows[0]!)).toEqual(["n"]); // the PK rode along, then left
    await now.mutate(
      t.db,
      (q, tb) => q.update(tb).set({ n: 3 }).where(eq(tb.id, "zzz")),
      { latency: "background" },
    );
    await now.mutate(t.db, (q, tb) => q.delete(tb).where(eq(tb.id, "a")), {
      latency: "background",
    });
    expect(routed.map((c) => [c.source, c.table, c.op, sortedIds(c)])).toEqual([
      ["producer", "pt_now", "U", ["a", "b"]],
      // the UPDATE matched no row: nothing to emit
      ["producer", "pt_now", "D", ["a"]],
    ]);
  });

  test("a coalesced producer holds its changes until the window; last op wins per id", async () => {
    await items.mutate(
      t.db,
      (q, tb) =>
        q.insert(tb).values([
          { id: "a", n: 1 },
          { id: "b", n: 1 },
        ]),
      { latency: "background" },
    );
    flushNow(items);
    routed = [];
    // a: U then D → D. b: D then U (re-inserted) → U.
    await items.mutate(t.db, (q, tb) => q.update(tb).set({ n: 2 }), {
      latency: "background",
    });
    await items.mutate(t.db, (q, tb) => q.delete(tb).where(eq(tb.id, "a")), {
      latency: "background",
    });
    await items.mutate(t.db, (q, tb) => q.delete(tb).where(eq(tb.id, "b")), {
      latency: "background",
    });
    await items.mutate(
      t.db,
      (q, tb) => q.insert(tb).values({ id: "b", n: 3 }),
      {
        latency: "background",
      },
    );
    expect(routed).toEqual([]); // still inside the window
    flushNow(items);
    expect(routed.map((c) => [c.op, sortedIds(c)])).toEqual([
      ["D", ["a"]],
      ["U", ["b"]],
    ]);
  });

  test("the window is fixed: armed on the first change, never re-armed", async () => {
    await items.mutate(
      t.db,
      (q, tb) => q.insert(tb).values({ id: "x", n: 1 }),
      {
        latency: "background",
      },
    );
    const firstDone = Date.now();
    await sleep(WINDOW_MS * 0.7);
    await items.mutate(
      t.db,
      (q, tb) => q.insert(tb).values({ id: "y", n: 1 }),
      {
        latency: "background",
      },
    );
    // Past the first window's end, short of a re-armed one's.
    await sleep(WINDOW_MS * 0.7);
    expect(routed).toHaveLength(1);
    expect(sortedIds(routed[0]!)).toEqual(["x", "y"]);
    // `changedAt` is the flush, not the earliest buffered emit: the window is a
    // declared delay, so measured change → tab latency starts when it closes.
    const at = (routed[0] as { changedAt: number }).changedAt;
    expect(at).toBeGreaterThanOrEqual(firstDone + WINDOW_MS * 0.9);
  });

  test("an interactive write flushes the whole buffer as soon as it resolves", async () => {
    await items.mutate(
      t.db,
      (q, tb) => q.insert(tb).values({ id: "p", n: 1 }),
      {
        latency: "background",
      },
    );
    expect(routed).toEqual([]);
    await items.mutate(
      t.db,
      (q, tb) => q.insert(tb).values({ id: "q", n: 1 }),
      {
        latency: "interactive",
      },
    );
    expect(routed.map((c) => [c.op, sortedIds(c)])).toEqual([
      ["U", ["p", "q"]],
    ]);
  });

  test("a flush armed inside runWithoutProfiling still records its route span (root context)", async () => {
    const spans: SlowSpan[] = [];
    const sub = onSlowSpan((s) => spans.push(s), { thresholdMs: 0 });
    try {
      await runWithoutProfiling(() =>
        items.mutate(t.db, (q, tb) => q.insert(tb).values({ id: "r", n: 1 }), {
          latency: "background",
        }),
      );
      await sleep(WINDOW_MS * 1.5);
    } finally {
      sub.dispose();
    }
    expect(routed).toHaveLength(1);
    expect(
      spans.some((s) => s.kind === "route" && s.label === "pt_items"),
    ).toBe(true);
  });
});

describe("flush", () => {
  test("a throw routing one change is filed, and the flush's other changes still route", async () => {
    unmount();
    const reports: Parameters<Parameters<typeof setErrorReporter>[0]>[0][] = [];
    setErrorReporter((r) => reports.push(r));
    unmount = mountProducersForTest([items, now], {
      route: (c) => {
        if (c.op === "D") throw new Error("router broke");
        routed.push(c);
      },
    });
    try {
      await items.mutate(
        t.db,
        (q, tb) =>
          q.insert(tb).values([
            { id: "a", n: 1 },
            { id: "b", n: 1 },
          ]),
        { latency: "background" },
      );
      flushNow(items);
      routed = [];
      await items.mutate(t.db, (q, tb) => q.delete(tb).where(eq(tb.id, "a")), {
        latency: "background",
      });
      await items.mutate(t.db, (q, tb) => q.update(tb).set({ n: 2 }), {
        latency: "background",
      });
      expect(() => flushNow(items)).not.toThrow();
      // The D threw; the U (routed after it) still went out.
      expect(routed.map((c) => [c.op, sortedIds(c)])).toEqual([["U", ["b"]]]);
      expect(reports).toHaveLength(1);
      expect(reports[0]!.errorType).toBe("ChangeProducerRouteError");
      expect(reports[0]!.message).toContain("router broke");
    } finally {
      setErrorReporter(() => {});
    }
  });
});

describe("changesOf", () => {
  test("deletes route before upserts, each with every id of its op", () => {
    const pending = new Map<string, "U" | "D">([
      ["a", "U"],
      ["b", "D"],
      ["c", "U"],
    ]);
    expect(changesOf("t", pending, 5)).toEqual([
      { source: "producer", table: "t", op: "D", ids: ["b"], changedAt: 5 },
      {
        source: "producer",
        table: "t",
        op: "U",
        ids: ["a", "c"],
        changedAt: 5,
      },
    ]);
  });

  test("over the id cap, one id-less change (FULL per reading tuple)", () => {
    const pending = new Map<string, "U" | "D">();
    for (let i = 0; i <= PRODUCER_IDS_CAP; i++) pending.set(`r${i}`, "U");
    expect(changesOf("t", pending, 5)).toEqual([
      { source: "producer", table: "t", op: "U", ids: null, changedAt: 5 },
    ]);
  });
});

describe("guards", () => {
  test("A12: a producer that is not mounted refuses to write", async () => {
    let err: unknown;
    try {
      await unmounted.mutate(
        t.db,
        (q, tb) => q.insert(tb).values({ id: "u" }),
        {
          latency: "background",
        },
      );
    } catch (e) {
      err = e;
    }
    expect(String(err)).toContain("is not mounted");
    const rows = await t.db.execute(sql`SELECT id FROM pt_unmounted`);
    expect(rows.rows).toEqual([]); // refused before the statement ran
  });

  test("A13: outside the serving backend, a write is refused", async () => {
    unmount();
    unmount = mountProducersForTest([now], { mode: "exec" });
    let err: unknown;
    try {
      await now.mutate(
        t.db,
        (q, tb) => q.insert(tb).values({ id: "e", n: 1 }),
        {
          latency: "background",
        },
      );
    } catch (e) {
      err = e;
    }
    expect(String(err)).toContain('boot mode "exec"');
  });

  test("A2′: a second producer on the same table throws at definition", () => {
    expect(() =>
      defineChangeProducer({
        table: _items,
        durability: "volatile",
        reason: "duplicate",
        coalesce: "none",
      }),
    ).toThrow('table "pt_items" already has a change producer');
  });

  test("a table without a single-column primary key throws at definition", () => {
    const composite = pgTable(
      "pt_composite",
      { a: text("a").notNull(), b: text("b").notNull() },
      (tb) => [primaryKey({ columns: [tb.a, tb.b] })],
    );
    expect(() =>
      defineChangeProducer({
        table: composite,
        durability: "volatile",
        reason: "composite",
        coalesce: "none",
      }),
    ).toThrow("single-column primary key");
  });
});
