/**
 * Runtime oracle for a collection declared `all` (P8 v3 step 16b.6) on a
 * throwaway database through the REAL feed: the change-feed's routed
 * triggers (installed from the routes the compile registered), its LISTEN
 * consumer, `routeChange`, and the server-core runtime — with the L2 hooks
 * installed, so the whole set is a PERSISTED alias (its `{}` tuple kept
 * current with nobody subscribed).
 *
 * After every statement the subscribed `{}` view equals a fresh FULL load,
 * no load is ever FULL, and each statement costs exactly what the alias
 * promises:
 *
 * - an insert is an ENTRANT: one scoped refill of the new id, one `orderOf`;
 * - a delete is an EXIT: no load, no `orderOf` (the order is the snapshot's);
 * - a where-flip out is an EXIT (the refill omits the id), back in an entrant;
 * - an order-field move costs one refill and ONE `orderOf`;
 * - a value-only write (a title, a child row an aggregate reads) costs one
 *   refill and NO `orderOf`;
 * - with nobody subscribed, the `{}` snapshot stays current (scoped, never
 *   FULL), and its trailing floor persist writes the current value.
 *
 * The `:rows` point sibling is subscribed beside it for three ids and follows
 * the same routes: after every statement its view is the whole set's truth
 * restricted to those ids (a where-flip out makes a row absent, a delete
 * drops it, a child insert refills its host's aggregate, a flip back returns
 * it), and none of its loads is FULL after its subscribe either. The third id
 * is an archived row — requested, never a member until it is flipped in — so
 * a value-only write to it (a title, a child row its aggregate reads) costs
 * the point tuple no load, and its where-flip in is an entrant.
 *
 * Then the C39 old-bundle harness (`subscribeAsOldDescriptor`) against the
 * same entry: what a tab still running a bundle that declared the key with a
 * param-less legacy descriptor gets.
 *
 * Requires a running Postgres cluster (started by ./singularity build).
 * Run: `./singularity test plugins/network/plugins/live`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { boolean, index, integer, pgTable, text } from "drizzle-orm/pg-core";
import { Client } from "pg";
import { z } from "zod";
import { fieldsToZodObject } from "@plugins/fields/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import {
  routeChange,
  type FeedChange,
} from "@plugins/database/plugins/change-feed/server";
import {
  createChangeFeedListener,
  rebuildTriggers,
} from "@plugins/database/plugins/change-feed/server/testing";
import {
  defineResource,
  dropPendingPersists,
  keptSnapshotValue,
  notificationsWsHandler,
  routedTableRequirements,
  setClientBuildIdentity,
  setLiveStateSnapshotHooks,
  type PersistMeta,
  setRelationBases,
} from "@plugins/framework/plugins/server-core/core";
import { clearRelationBases } from "@plugins/framework/plugins/server-core/core/testing";
import {
  makeClientView,
  type ClientView,
  type RecordedFrame,
} from "@plugins/framework/plugins/resource-runtime/core/testing";
import {
  aggregate,
  childrenJoin,
} from "@plugins/infra/plugins/query-resource/core";
import type { QueryDb } from "@plugins/infra/plugins/query-resource/server";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { compileCollection } from "./serve-collection";
import { subscribeAsOldDescriptor } from "../testing/old-subscription";

const ITEMS = "sao_items";
const NOTES = "sao_notes";
const KEY = "test.live.all-oracle";

const items = pgTable(ITEMS, {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  rank: integer("rank").notNull(),
  archived: boolean("archived").notNull(),
  /**
   * Server-only: no row field and no route reads it. A routed trigger compares
   * old and new only for the columns of a route that reads FEWER than the
   * table has, so without it the one route on this table reads every column,
   * nothing is compared, and every UPDATE arrives with `unchanged` unknown —
   * a membership change for every tuple, never a value-only one.
   */
  memo: text("memo"),
});
const notes = pgTable(
  NOTES,
  {
    id: text("id").primaryKey(),
    itemId: text("item_id").notNull(),
  },
  (t) => [index("sao_notes_item_idx").on(t.itemId)],
);

const ROW_FIELDS = {
  id: textField({ label: "Id" }),
  title: textField({ label: "Title" }),
  rank: intField({ label: "Rank" }),
  notes: intField({ label: "Notes" }),
};
const RowSchema = fieldsToZodObject(ROW_FIELDS);

const collection = liveCollection(KEY, {
  fields: ROW_FIELDS,
  id: "id",
  all: { orderBy: [["rank", "asc"]], unbounded: { reason: "an oracle set" } },
});

interface Load {
  ids: readonly string[] | "FULL";
}

let testDb: TestDb;
let client: Client;
let db: NodePgDatabase;
let listener: ReturnType<typeof createChangeFeedListener>;
let truth: () => Promise<unknown>;
const routed: FeedChange[] = [];
const loads: Load[] = [];
/** The `:rows` point sibling's loads. */
const rowLoads: Load[] = [];
const frames: RecordedFrame[] = [];
const persists: { value: unknown; meta: PersistMeta }[] = [];
let orderOfCalls = 0;
let seq = 0;

const handler = notificationsWsHandler as unknown as {
  open(ws: unknown): void;
  message(ws: unknown, raw: string): void;
  close(ws: unknown, code: number, reason: string): void;
};
const ws = {
  send(raw: string) {
    const frame = JSON.parse(raw) as Omit<RecordedFrame, "seq" | "socket">;
    if (frame.kind !== "ping") frames.push({ ...frame, seq: seq++, socket: 0 });
  },
};

async function until(cond: () => boolean, what: () => string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what()}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Wait until the feed delivered a change on `table` past `from`, then until nothing moves. */
async function settled(table: string, from: number): Promise<void> {
  await until(
    () => routed.slice(from).some((c) => c.table === table),
    () => `a change on ${table}`,
  );
  const deadline = Date.now() + 8000;
  for (;;) {
    const at = [loads.length, frames.length, orderOfCalls, rowLoads.length];
    await new Promise((r) => setTimeout(r, 120));
    if (
      loads.length === at[0] &&
      frames.length === at[1] &&
      orderOfCalls === at[2] &&
      rowLoads.length === at[3]
    ) {
      return;
    }
    if (Date.now() > deadline) throw new Error("the runtime never went quiet");
  }
}

/** JSON with sorted keys, so a row compares by content whatever its key order. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x !== null && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : x,
  );
}

/** The `:rows` tuple the oracle watches beside `{}`: canonical, as a client sends it. */
const ROWS_KEY = `${KEY}:rows`;
/** `x` is archived — requested, but no member until it is flipped in. */
const POINT_IDS = ["a", "b", "x"];
const pointParams = collection.rows.point.encode(POINT_IDS);

interface View {
  key: string;
  params: Record<string, string>;
  view: ClientView;
  from: number;
}
let view: View | undefined;
let pointView: View | undefined;

function valueOf(v: View): unknown {
  const params = JSON.stringify(v.params);
  v.view.applyAll(
    frames
      .slice(v.from)
      .filter(
        (f) => f.key === v.key && JSON.stringify(f.params ?? {}) === params,
      ),
  );
  v.from = frames.length;
  return v.view.value;
}
const viewValue = (): unknown => valueOf(view!);

/** The point view's rows, by id — a point read's order is not the set's. */
function pointValue(): unknown {
  const rows = valueOf(pointView!) as Array<{ id: string }>;
  return [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** The whole set's truth restricted to the watched ids, by id. */
async function pointTruth(): Promise<unknown> {
  const rows = (await truth()) as Array<{ id: string }>;
  return rows
    .filter((r) => POINT_IDS.includes(r.id))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

async function subscribeTo(
  key: string,
  params: Record<string, string>,
): Promise<View> {
  const from = frames.length;
  const v: View = { key, params, view: makeClientView(), from };
  handler.message(ws, JSON.stringify({ op: "sub", key, params }));
  await until(
    () => frames.slice(from).some((f) => f.kind === "sub-ack" && f.key === key),
    () => `sub-ack ${key}`,
  );
  return v;
}

async function subscribe(): Promise<void> {
  view = await subscribeTo(KEY, {});
}

beforeAll(async () => {
  // What change-feed's boot installs before its listener starts (D34): the
  // relation bases the router reaches a relation read through (and the drift
  // guard fails open through). No views matter here, so every relation is its
  // own base.
  setRelationBases((r) => [r]);
  testDb = await createTestDb({ prefix: "live_all_oracle" });
  client = new Client({ connectionString: testDb.connectionString });
  await client.connect();
  db = drizzle(client);
  await db.execute(
    sql.raw(
      `CREATE TABLE ${ITEMS} (id text PRIMARY KEY, title text NOT NULL,
                              rank integer NOT NULL, archived boolean NOT NULL,
                              memo text);
       CREATE TABLE ${NOTES} (id text PRIMARY KEY, item_id text NOT NULL);
       CREATE INDEX sao_notes_item_idx ON ${NOTES} (item_id);`,
    ),
  );
  // L2 on, for this key only: the whole set is a PERSISTED alias, so the
  // runtime keeps its `{}` tuple current with nobody subscribed.
  setLiveStateSnapshotHooks({
    shouldPersist: (key) => key === KEY,
    captureWatermark: async () => {
      const res = await db.execute<{ xmin: string }>(
        sql`SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS xmin`,
      );
      return res.rows[0]!.xmin;
    },
    persistSnapshot: async (_key, _pk, value, _watermark, meta) => {
      persists.push({ value, meta });
    },
  });
  const specs = compileCollection(collection, {
    from: items,
    joins: [
      childrenJoin({
        alias: "kids",
        table: notes,
        fk: notes.itemId,
        aggregates: (c) => ({
          count: aggregate(sql`count(${c.kids.id})::int`, {
            decoder: Number,
            sqlType: "integer",
            notNull: true,
            ifNone: sql`0`,
          }),
        }),
      }),
    ],
    columns: { notes: (j) => j.kids.count },
    where: (j) => sql`${j.base.archived} = false`,
    db: db as unknown as QueryDb,
  });
  const all = specs.all;
  const membership = all.scopedMembership;
  if (membership === undefined) {
    throw new Error("an `all` collection's scope policy is the routed alias");
  }
  // The compiled options with the loader and `orderOf` counted — the same
  // policy arm (`routes` + `scopedMembership`), so the cast only restates it.
  defineResource(collection.all, {
    ...all,
    loader: (p, ctx) => {
      loads.push({ ids: ctx ? [...ctx.affectedIds].sort() : "FULL" });
      return all.loader(p, ctx);
    },
    scopedMembership: {
      ...membership,
      orderOf: (p) => {
        orderOfCalls++;
        return membership.orderOf(p);
      },
    },
  } as typeof all);
  const rows = specs.rows;
  defineResource(collection.rows, {
    ...rows,
    loader: (p, ctx) => {
      rowLoads.push({ ids: ctx ? [...ctx.affectedIds].sort() : "FULL" });
      return rows.loader(p, ctx);
    },
  } as typeof rows);
  truth = async () => collection.all.schema.parse(await all.loader({}));
  await rebuildTriggers(
    testDb.db,
    { feedExempt: new Set(), optedOut: new Set(), produced: new Set() },
    routedTableRequirements(),
  );
  listener = createChangeFeedListener({
    connectionString: () => testDb.connectionString,
    route: (change) => {
      routed.push(change);
      routeChange(change);
    },
    coveredTables: () => [ITEMS, NOTES],
    livenessIntervalMs: 60_000,
  });
  listener.start();
  const deadline = Date.now() + 8000;
  for (;;) {
    const res = await testDb.db.execute(
      sql`SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database()
            AND query LIKE 'LISTEN live_state%'
            AND pid <> pg_backend_pid()`,
    );
    if (res.rows.length > 0) break;
    if (Date.now() > deadline) throw new Error("timed out waiting for LISTEN");
    await new Promise((r) => setTimeout(r, 20));
  }
  handler.open(ws);
}, 30_000);

afterAll(async () => {
  clearRelationBases();
  handler.close(ws, 1000, "test");
  dropPendingPersists();
  setLiveStateSnapshotHooks(null);
  setClientBuildIdentity(() => null);
  await listener?.stop();
  await client?.end();
  await testDb?.drop();
});

/** Run one statement and return what it cost: the loads and `orderOf` calls it caused. */
async function step(
  table: string,
  statement: string,
): Promise<{ loads: Load[]; orderOf: number }> {
  const at = {
    loads: loads.length,
    orderOf: orderOfCalls,
    routed: routed.length,
  };
  await db.execute(sql.raw(statement));
  await settled(table, at.routed);
  return { loads: loads.slice(at.loads), orderOf: orderOfCalls - at.orderOf };
}

describe("serveCollection `all` — runtime oracle over the real feed", () => {
  test("insert = entrant, delete / where-flip = exit, an order move costs one orderOf, a value-only write none", async () => {
    // The seed: the persisted `{}` tuple has no snapshot yet, so it is built
    // FULL once (and persisted) — the only FULL load of the run.
    const seedFrom = routed.length;
    await db.execute(
      sql.raw(`INSERT INTO ${ITEMS} VALUES ('a', 'A', 1, false), ('b', 'B', 2, false), ('c', 'C', 3, false),
                                           ('x', 'X', 5, true);
               INSERT INTO ${NOTES} VALUES ('n1', 'a');`),
    );
    await settled(NOTES, seedFrom);
    await subscribe();
    pointView = await subscribeTo(ROWS_KEY, pointParams);
    expect(canonical(viewValue())).toBe(canonical(await truth()));
    expect(canonical(pointValue())).toBe(canonical(await pointTruth()));
    const baseline = loads.length;
    const rowBaseline = rowLoads.length;
    const check = async (cost: { loads: Load[]; orderOf: number }) => {
      expect(canonical(viewValue())).toBe(canonical(await truth()));
      // The point sibling follows the same routes as the whole set.
      expect(canonical(pointValue())).toBe(canonical(await pointTruth()));
      return cost;
    };

    // Entrant: one scoped refill of the new id, one orderOf.
    expect(
      await check(
        await step(ITEMS, `INSERT INTO ${ITEMS} VALUES ('d', 'D', 0, false)`),
      ),
    ).toEqual({ loads: [{ ids: ["d"] }], orderOf: 1 });
    // Value-only (a column no order or where reads): one refill, no orderOf.
    expect(
      await check(
        await step(ITEMS, `UPDATE ${ITEMS} SET title = 'B2' WHERE id = 'b'`),
      ),
    ).toEqual({ loads: [{ ids: ["b"] }], orderOf: 0 });
    // An order move: one refill, ONE orderOf.
    expect(
      await check(
        await step(ITEMS, `UPDATE ${ITEMS} SET rank = 9 WHERE id = 'c'`),
      ),
    ).toEqual({ loads: [{ ids: ["c"] }], orderOf: 1 });
    // A child row an aggregate reads: its host's refill, no orderOf.
    expect(
      await check(await step(NOTES, `INSERT INTO ${NOTES} VALUES ('n2', 'b')`)),
    ).toEqual({ loads: [{ ids: ["b"] }], orderOf: 0 });
    expect(pointValue()).toContainEqual({
      id: "b",
      title: "B2",
      rank: 2,
      notes: 1,
    });
    // A where-flip out: the refill omits the id — an exit, no orderOf.
    expect(
      await check(
        await step(ITEMS, `UPDATE ${ITEMS} SET archived = true WHERE id = 'a'`),
      ),
    ).toEqual({ loads: [{ ids: ["a"] }], orderOf: 0 });
    expect((pointValue() as Array<{ id: string }>).map((r) => r.id)).toEqual([
      "b",
    ]);
    // A delete: an exit with no load at all.
    expect(
      await check(await step(ITEMS, `DELETE FROM ${ITEMS} WHERE id = 'b'`)),
    ).toEqual({ loads: [], orderOf: 0 });
    expect(pointValue()).toEqual([]);
    // A where-flip back in: an entrant.
    expect(
      await check(
        await step(
          ITEMS,
          `UPDATE ${ITEMS} SET archived = false WHERE id = 'a'`,
        ),
      ),
    ).toEqual({ loads: [{ ids: ["a"] }], orderOf: 1 });
    expect((pointValue() as Array<{ id: string }>).map((r) => r.id)).toEqual([
      "a",
    ]);
    // `x` — requested by the point tuple, archived so no member — takes a
    // value-only write of each kind. Neither the whole set (no snapshot row)
    // nor the point tuple (an id it does not hold) loads anything.
    const pointCost = async (table: string, statement: string) => {
      const from = rowLoads.length;
      const cost = await check(await step(table, statement));
      return { ...cost, rowLoads: rowLoads.slice(from) };
    };
    expect(
      await pointCost(ITEMS, `UPDATE ${ITEMS} SET title = 'X2' WHERE id = 'x'`),
    ).toEqual({ loads: [], orderOf: 0, rowLoads: [] });
    expect(
      await pointCost(NOTES, `INSERT INTO ${NOTES} VALUES ('n3', 'x')`),
    ).toEqual({ loads: [], orderOf: 0, rowLoads: [] });
    // Its where-flip in is an entrant in both, carrying the writes it skipped.
    expect(
      await pointCost(
        ITEMS,
        `UPDATE ${ITEMS} SET archived = false WHERE id = 'x'`,
      ),
    ).toEqual({
      loads: [{ ids: ["x"] }],
      orderOf: 1,
      rowLoads: [{ ids: ["x"] }],
    });
    expect(pointValue()).toContainEqual({
      id: "x",
      title: "X2",
      rank: 5,
      notes: 1,
    });
    // Never once FULL after the subscribe — the whole set nor its point sibling.
    expect(loads.slice(baseline).some((l) => l.ids === "FULL")).toBe(false);
    expect(rowLoads.slice(rowBaseline).some((l) => l.ids === "FULL")).toBe(
      false,
    );
    // The point sibling did load (the routes reached it): not vacuous.
    expect(rowLoads.length).toBeGreaterThan(rowBaseline);
    handler.message(
      ws,
      JSON.stringify({ op: "unsub", key: ROWS_KEY, params: pointParams }),
    );
  }, 60_000);

  test("with nobody subscribed, the `{}` snapshot stays current (scoped, never FULL) and its floor persist writes it", async () => {
    handler.message(ws, JSON.stringify({ op: "unsub", key: KEY, params: {} }));
    await new Promise((r) => setTimeout(r, 50));
    const baseline = loads.length;
    const idle = async (table: string, statement: string) => {
      const cost = await step(table, statement);
      expect(canonical(keptSnapshotValue(KEY))).toBe(canonical(await truth()));
      return cost;
    };
    expect(
      await idle(ITEMS, `UPDATE ${ITEMS} SET title = 'D2' WHERE id = 'd'`),
    ).toEqual({ loads: [{ ids: ["d"] }], orderOf: 0 });
    expect(
      await idle(ITEMS, `INSERT INTO ${ITEMS} VALUES ('e', 'E', 4, false)`),
    ).toEqual({ loads: [{ ids: ["e"] }], orderOf: 1 });
    expect(await idle(ITEMS, `DELETE FROM ${ITEMS} WHERE id = 'd'`)).toEqual({
      loads: [],
      orderOf: 0,
    });
    expect(loads.slice(baseline).some((l) => l.ids === "FULL")).toBe(false);
    // The trailing floor window writes the kept value (the L2 row a cold boot
    // seeds from), never a FULL replace.
    const current = canonical(await truth());
    await until(
      () =>
        persists.some(
          (p) => p.meta.mode === "floor" && canonical(p.value) === current,
        ),
      () => "a floor persist of the current value",
    );
    // A fresh subscriber is served the kept value.
    await subscribe();
    expect(canonical(viewValue())).toBe(current);
  }, 60_000);
});

describe("the C39 old-bundle harness against an `all` entry", () => {
  test("a param-less old descriptor subscribing `{}` passes the gate and parses the rows with ITS schema", async () => {
    const current = await truth();
    // Byte-compatible: the old row IS the new one — the old tab renders it.
    const same = await subscribeAsOldDescriptor({
      key: KEY,
      schema: z.array(RowSchema),
    });
    expect(same.kind).toBe("parsed");
    expect(canonical(same.kind === "parsed" ? same.value : null)).toBe(
      canonical(current),
    );
    // A row that changed under the same key: no `skew` verdict reaches the
    // old tab — it fails a PARSE. What a converting step must never ship.
    const moved = await subscribeAsOldDescriptor({
      key: KEY,
      schema: z.array(
        z.object({ id: z.string(), title: z.string(), noteCount: z.number() }),
      ),
    });
    expect(moved.kind).toBe("parse-failed");
  });

  test("a tuple that SENT params is `contract-mismatch`, and a renamed key `unknown-key` — both `skew` for an out-of-date build", async () => {
    setClientBuildIdentity(() => "build-now");
    try {
      const withParams = await subscribeAsOldDescriptor(
        { key: KEY, schema: z.array(RowSchema) },
        { params: { limit: "100" }, build: "build-old" },
      );
      expect(withParams).toEqual({
        kind: "refused",
        reason: "contract-mismatch",
        verdict: "skew",
      });
      const renamed = await subscribeAsOldDescriptor(
        { key: `${KEY}.before-rename`, schema: z.array(RowSchema) },
        { build: "build-old" },
      );
      expect(renamed).toEqual({
        kind: "refused",
        reason: "unknown-key",
        verdict: "skew",
      });
    } finally {
      setClientBuildIdentity(() => null);
    }
  });
});
