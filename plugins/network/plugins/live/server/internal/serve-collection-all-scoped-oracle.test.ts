/**
 * Runtime oracle for a SCOPED `all` collection (`all: { by: ["pageId"] }`,
 * track item [12] §A of research/2026-10-19-global-live-compiled-narrowing.md)
 * on a throwaway database through the REAL feed: the change-feed's routed
 * triggers (installed from the routes the compile registered — the base
 * route's declared `match` makes them carry `page_id` as a key), its LISTEN
 * consumer, `routeChange`, and the server-core runtime.
 *
 * Two tuples are subscribed, page A and page B. After every statement each
 * view equals a fresh FULL load of its scope, and each statement costs
 * exactly what the scope promises:
 *
 * - a write to a row of B reaches no A tuple: B refills that row, A loads
 *   nothing and is sent nothing (the router skips it on the key match);
 * - an insert into A is one refill and one `orderOf` for A, nothing for B;
 * - moving a row from A to B is an EXIT for A (its refill omits the row, no
 *   `orderOf`) and an ENTRANT for B (one refill, one `orderOf`);
 * - a delete in B is an exit with no load at all, nothing for A;
 * - a statement whose NOTIFY passes the 7000-byte cap carries no keys, so it
 *   is FULL for every tuple — A and B both — and both still converge.
 *
 * Requires a running Postgres cluster (started by ./singularity build).
 * Run: `./singularity test plugins/network/plugins/live`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { Client } from "pg";
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
  notificationsWsHandler,
  routedTableRequirements,
  setRelationBases,
} from "@plugins/framework/plugins/server-core/core";
import { clearRelationBases } from "@plugins/framework/plugins/server-core/core/testing";
import {
  makeClientView,
  type ClientView,
  type RecordedFrame,
} from "@plugins/framework/plugins/resource-runtime/core/testing";
import type { QueryDb } from "@plugins/infra/plugins/query-resource/server";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { compileCollection } from "./serve-collection";

const BLOCKS = "sco_blocks";
const KEY = "test.live.all-scoped-oracle";

const blocks = pgTable(BLOCKS, {
  id: text("id").primaryKey(),
  pageId: text("page_id").notNull(),
  rank: integer("rank").notNull(),
  title: text("title").notNull(),
  /**
   * Server-only: no row field and no route reads it, so the routed trigger
   * compares old and new for the route's columns (a route reading every
   * column is never compared) — an UPDATE then arrives with its `unchanged`
   * set, and a title edit is a value change for the tuple holding the row.
   */
  memo: text("memo"),
});

const collection = liveCollection(KEY, {
  fields: {
    id: textField({ label: "Id" }),
    pageId: textField({ label: "Page" }),
    rank: intField({ label: "Rank" }),
    title: textField({ label: "Title" }),
  },
  id: "id",
  all: {
    by: ["pageId"],
    orderBy: [["rank", "asc"]],
    unbounded: { reason: "one page's blocks" },
  },
});

type Page = "pa" | "pb";
const A: { pageId: Page } = { pageId: "pa" };
const B: { pageId: Page } = { pageId: "pb" };

interface Load {
  page: string;
  ids: readonly string[] | "FULL";
}

let testDb: TestDb;
let client: Client;
let db: NodePgDatabase;
let listener: ReturnType<typeof createChangeFeedListener>;
let truth: (page: Page) => Promise<unknown>;
const routed: FeedChange[] = [];
const loads: Load[] = [];
const orderOf: string[] = [];
const frames: RecordedFrame[] = [];
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

/** Wait until the feed delivered a change on `BLOCKS` past `from`, then until nothing moves. */
async function settled(from: number): Promise<void> {
  await until(
    () => routed.slice(from).some((c) => c.table === BLOCKS),
    () => `a change on ${BLOCKS}`,
  );
  const deadline = Date.now() + 8000;
  for (;;) {
    const at = [loads.length, frames.length, orderOf.length];
    await new Promise((r) => setTimeout(r, 120));
    if (
      loads.length === at[0] &&
      frames.length === at[1] &&
      orderOf.length === at[2]
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

interface View {
  params: Record<string, string>;
  view: ClientView;
  from: number;
}
const views = new Map<Page, View>();

/** The frames for one tuple since `from`. */
function framesOf(params: Record<string, string>, from: number) {
  const p = JSON.stringify(params);
  return frames
    .slice(from)
    .filter((f) => f.key === KEY && JSON.stringify(f.params ?? {}) === p);
}

function valueOf(page: Page): unknown {
  const v = views.get(page)!;
  v.view.applyAll(framesOf(v.params, v.from));
  v.from = frames.length;
  return v.view.value;
}

async function subscribe(params: { pageId: Page }): Promise<void> {
  const from = frames.length;
  views.set(params.pageId, { params, view: makeClientView(), from });
  handler.message(ws, JSON.stringify({ op: "sub", key: KEY, params }));
  await until(
    () => framesOf(params, from).some((f) => f.kind === "sub-ack"),
    () => `sub-ack ${KEY} ${params.pageId}`,
  );
}

beforeAll(async () => {
  setRelationBases((r) => [r]);
  testDb = await createTestDb({ prefix: "live_all_scoped_oracle" });
  client = new Client({ connectionString: testDb.connectionString });
  await client.connect();
  db = drizzle(client);
  await db.execute(
    sql.raw(
      `CREATE TABLE ${BLOCKS} (id text PRIMARY KEY, page_id text NOT NULL,
                               rank integer NOT NULL, title text NOT NULL,
                               memo text);`,
    ),
  );
  const specs = compileCollection(collection, {
    from: blocks,
    db: db as unknown as QueryDb,
  });
  const all = specs.all;
  const membership = all.scopedMembership;
  if (membership === undefined) {
    throw new Error("an `all` collection's scope policy is the routed alias");
  }
  // The compiled options with the loader and `orderOf` counted per scope —
  // the same policy arm (`routes` + `scopedMembership`), so the cast only
  // restates it.
  defineResource(collection.all, {
    ...all,
    loader: (p, ctx) => {
      loads.push({
        page: p.pageId,
        ids: ctx ? [...ctx.affectedIds].sort() : "FULL",
      });
      return all.loader(p, ctx);
    },
    scopedMembership: {
      ...membership,
      orderOf: (p) => {
        orderOf.push(p.pageId);
        return membership.orderOf(p);
      },
    },
  } as typeof all);
  defineResource(collection.rows, specs.rows);
  truth = async (page) =>
    collection.all.schema.parse(await all.loader({ pageId: page }));
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
    coveredTables: () => [BLOCKS],
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
  await listener?.stop();
  await client?.end();
  await testDb?.drop();
});

/** What one statement cost: the loads and `orderOf` calls per scope, and the frames each tuple was sent. */
interface Cost {
  loads: Load[];
  orderOf: string[];
  framesA: number;
  framesB: number;
}

async function step(statement: string): Promise<Cost> {
  const at = {
    loads: loads.length,
    orderOf: orderOf.length,
    routed: routed.length,
    frames: frames.length,
  };
  await db.execute(sql.raw(statement));
  await settled(at.routed);
  // Both views converge on their scope's truth after every statement.
  expect(canonical(valueOf("pa"))).toBe(canonical(await truth("pa")));
  expect(canonical(valueOf("pb"))).toBe(canonical(await truth("pb")));
  return {
    loads: loads.slice(at.loads),
    orderOf: orderOf.slice(at.orderOf),
    framesA: framesOf(A, at.frames).length,
    framesB: framesOf(B, at.frames).length,
  };
}

describe("a scoped `all` — runtime oracle over the real feed", () => {
  test("the trigger carries the scope column: the routes' layout names it", () => {
    const req = routedTableRequirements().find((r) => r.table === BLOCKS);
    expect(req?.carry).toEqual(["page_id"]);
  });

  test("another scope's write reaches no tuple; an insert is one refill + orderOf; a move is an exit here and an entrant there; a delete costs no load", async () => {
    const seedFrom = routed.length;
    await db.execute(
      sql.raw(`INSERT INTO ${BLOCKS} VALUES ('a1', 'pa', 1, 'A1'), ('a2', 'pa', 2, 'A2'),
                                            ('b1', 'pb', 1, 'B1'), ('b2', 'pb', 2, 'B2')`),
    );
    await settled(seedFrom);
    await subscribe(A);
    await subscribe(B);
    expect(canonical(valueOf("pa"))).toBe(canonical(await truth("pa")));
    expect(canonical(valueOf("pb"))).toBe(canonical(await truth("pb")));
    expect((valueOf("pa") as { id: string }[]).map((r) => r.id)).toEqual([
      "a1",
      "a2",
    ]);
    const baseline = loads.length;

    // A write to a row of B: B refills it (a value change, no orderOf); A
    // loads nothing and is sent nothing — skipped on the key match.
    expect(
      await step(`UPDATE ${BLOCKS} SET title = 'B1x' WHERE id = 'b1'`),
    ).toEqual({
      loads: [{ page: "pb", ids: ["b1"] }],
      orderOf: [],
      framesA: 0,
      framesB: 1,
    });
    // An insert into A: one refill and one orderOf for A, nothing for B.
    expect(
      await step(`INSERT INTO ${BLOCKS} VALUES ('a3', 'pa', 0, 'A3')`),
    ).toEqual({
      loads: [{ page: "pa", ids: ["a3"] }],
      orderOf: ["pa"],
      framesA: 1,
      framesB: 0,
    });
    // A move from A to B: the old and the new scope are both keys of the
    // change, so it reaches both — an exit for A (no orderOf), an entrant
    // for B (one orderOf).
    const move = await step(
      `UPDATE ${BLOCKS} SET page_id = 'pb' WHERE id = 'a1'`,
    );
    expect([...move.loads].sort((x, y) => (x.page < y.page ? -1 : 1))).toEqual([
      { page: "pa", ids: ["a1"] },
      { page: "pb", ids: ["a1"] },
    ]);
    expect(move.orderOf).toEqual(["pb"]);
    expect((valueOf("pa") as { id: string }[]).map((r) => r.id)).toEqual([
      "a3",
      "a2",
    ]);
    expect((valueOf("pb") as { id: string }[]).map((r) => r.id)).toEqual([
      "a1",
      "b1",
      "b2",
    ]);
    // A delete in B: an exit with no load at all; A is not touched.
    expect(await step(`DELETE FROM ${BLOCKS} WHERE id = 'b2'`)).toEqual({
      loads: [],
      orderOf: [],
      framesA: 0,
      framesB: 1,
    });
    // Never once FULL after the subscribes.
    expect(loads.slice(baseline).some((l) => l.ids === "FULL")).toBe(false);
  }, 60_000);

  test("over the 7000-byte NOTIFY cap the change carries no keys: FULL for every tuple, A and B both, and both converge", async () => {
    // 200 rows whose ids alone pass the cap.
    const values = Array.from(
      { length: 200 },
      (_, i) =>
        `('bulk-${String(i).padStart(4, "0")}-${"x".repeat(40)}', 'pa', ${100 + i}, 'bulk')`,
    ).join(", ");
    const cost = await step(`INSERT INTO ${BLOCKS} VALUES ${values}`);
    const change = routed.at(-1)!;
    expect(change.ids).toBeNull();
    expect([...cost.loads].sort((x, y) => (x.page < y.page ? -1 : 1))).toEqual([
      { page: "pa", ids: "FULL" },
      { page: "pb", ids: "FULL" },
    ]);
    expect((valueOf("pa") as unknown[]).length).toBe(202);
  }, 60_000);
});
