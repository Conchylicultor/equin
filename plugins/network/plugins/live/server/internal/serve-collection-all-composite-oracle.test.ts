/**
 * Runtime oracle for a scoped `all` collection over a COMPOSITE primary key
 * (`id: compositeKey(["surface", "rowKey", "idx"])`, `all: { by: ["surface"] }`;
 * research/2026-11-02-global-live-composite-key-collections.md) on a throwaway
 * database through the REAL feed — the twin of
 * `serve-collection-all-scoped-oracle.test.ts`. The table has no single-column
 * key, so the change feed fills no `ids`: every host id is composed from the
 * key columns the routed trigger carries (the composite identity route lists
 * them all), and every refill decodes its ids back to key tuples.
 *
 * Two tuples are subscribed, surface A and surface B. After every statement
 * each view equals a fresh FULL load of its scope, and each statement costs
 * exactly what the scope promises:
 *
 * - a write to a row of B reaches no A tuple: B refills that row (its composed
 *   id), A loads nothing and is sent nothing;
 * - an insert into A is one refill and one `orderOf` for A, nothing for B;
 * - moving a row from A to B (a key part changes: its id changes too) is an
 *   EXIT for A and an ENTRANT for B, each one refill;
 * - a delete in B is an exit with no load at all;
 * - over the 7000-byte NOTIFY cap the change carries no keys: FULL for both.
 *
 * The integer part (`idx`) is carried as `int::text`, which the codec's
 * decimal text equals. `:rows` reads an id the codec cannot decode, or whose
 * integer part is not canonical, as absent.
 *
 * Requires a running Postgres cluster (started by ./equin build).
 * Run: `./equin test plugins/network/plugins/live`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
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
} from "@plugins/network/plugins/live/plugins/change-feed/server";
import {
  createChangeFeedListener,
  rebuildTriggers,
} from "@plugins/network/plugins/live/plugins/change-feed/server/testing";
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
} from "@plugins/network/plugins/live/plugins/resource-runtime/core/testing";
import { compositeKey } from "@plugins/network/plugins/live/plugins/query-resource/core";
import type { QueryDb } from "@plugins/network/plugins/live/plugins/query-resource/server";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { compileCollection } from "./serve-collection";

const CELLS = "scc_cells";
const KEY = "test.live.all-composite-oracle";

const cells = pgTable(
  CELLS,
  {
    surface: text("surface").notNull(),
    rowKey: text("row_key").notNull(),
    idx: integer("idx").notNull(),
    value: text("value").notNull(),
  },
  (t) => [primaryKey({ columns: [t.surface, t.rowKey, t.idx] })],
);

const cellKey = compositeKey(["surface", "rowKey", "idx"]);
const collection = liveCollection(KEY, {
  fields: {
    surface: textField({ label: "Surface" }),
    rowKey: textField({ label: "Row" }),
    idx: intField({ label: "Index" }),
    value: textField({ label: "Value" }),
  },
  id: cellKey,
  all: {
    by: ["surface"],
    orderBy: [["value", "asc"]],
    unbounded: { reason: "one surface's cells" },
  },
});
const id = (surface: string, rowKey: string, idx: number) =>
  cellKey.encode({ surface, rowKey, idx });

type Surface = "sa" | "sb";
const A: { surface: Surface } = { surface: "sa" };
const B: { surface: Surface } = { surface: "sb" };

interface Load {
  surface: string;
  ids: readonly string[] | "FULL";
}

let testDb: TestDb;
let client: Client;
let db: NodePgDatabase;
let listener: ReturnType<typeof createChangeFeedListener>;
let truth: (surface: Surface) => Promise<unknown>;
let rowsLoader: (ids: string) => Promise<unknown[]>;
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

/** Wait until the feed delivered a change on `CELLS` past `from`, then until nothing moves. */
async function settled(from: number): Promise<void> {
  await until(
    () => routed.slice(from).some((c) => c.table === CELLS),
    () => `a change on ${CELLS}`,
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
const views = new Map<Surface, View>();

/** The frames for one tuple since `from`. */
function framesOf(params: Record<string, string>, from: number) {
  const p = JSON.stringify(params);
  return frames
    .slice(from)
    .filter((f) => f.key === KEY && JSON.stringify(f.params ?? {}) === p);
}

function valueOf(surface: Surface): unknown {
  const v = views.get(surface)!;
  v.view.applyAll(framesOf(v.params, v.from));
  v.from = frames.length;
  return v.view.value;
}

async function subscribe(params: { surface: Surface }): Promise<void> {
  const from = frames.length;
  // The client keys rows with the descriptor's own `keyOf` — the codec.
  views.set(params.surface, {
    params,
    view: makeClientView(collection.all.keyed.keyOf),
    from,
  });
  handler.message(ws, JSON.stringify({ op: "sub", key: KEY, params }));
  await until(
    () => framesOf(params, from).some((f) => f.kind === "sub-ack"),
    () => `sub-ack ${KEY} ${params.surface}`,
  );
}

beforeAll(async () => {
  setRelationBases((r) => [r]);
  testDb = await createTestDb({ prefix: "live_all_composite_oracle" });
  client = new Client({ connectionString: testDb.connectionString });
  await client.connect();
  db = drizzle(client);
  await db.execute(
    sql.raw(
      `CREATE TABLE ${CELLS} (surface text NOT NULL, row_key text NOT NULL,
                              idx integer NOT NULL, value text NOT NULL,
                              PRIMARY KEY (surface, row_key, idx));`,
    ),
  );
  const specs = compileCollection(collection, {
    from: cells,
    db: db as unknown as QueryDb,
  });
  const all = specs.all;
  const membership = all.scopedMembership;
  if (membership === undefined) {
    throw new Error("an `all` collection's scope policy is the routed alias");
  }
  defineResource(collection.all, {
    ...all,
    loader: (p, ctx) => {
      loads.push({
        surface: p.surface,
        ids: ctx ? [...ctx.affectedIds].sort() : "FULL",
      });
      return all.loader(p, ctx);
    },
    scopedMembership: {
      ...membership,
      orderOf: (p) => {
        orderOf.push(p.surface);
        return membership.orderOf(p);
      },
    },
  } as typeof all);
  defineResource(collection.rows, specs.rows);
  truth = async (surface) =>
    collection.all.schema.parse(await all.loader({ surface }));
  rowsLoader = async (ids) => specs.rows.loader({ ids }) as Promise<unknown[]>;
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
    coveredTables: () => [CELLS],
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
  expect(canonical(valueOf("sa"))).toBe(canonical(await truth("sa")));
  expect(canonical(valueOf("sb"))).toBe(canonical(await truth("sb")));
  return {
    loads: loads.slice(at.loads),
    orderOf: orderOf.slice(at.orderOf),
    framesA: framesOf(A, at.frames).length,
    framesB: framesOf(B, at.frames).length,
  };
}

const bySurface = (x: Load, y: Load) => (x.surface < y.surface ? -1 : 1);
const valuesOf = (surface: Surface) =>
  (valueOf(surface) as { value: string }[]).map((r) => r.value);

describe("a composite-keyed scoped `all` — runtime oracle over the real feed", () => {
  test("the trigger carries every key part: the composite identity route names them", () => {
    const req = routedTableRequirements().find((r) => r.table === CELLS);
    expect(req?.carry).toEqual(["idx", "row_key", "surface"]);
  });

  test("another scope's write reaches no tuple; an insert is one refill + orderOf; a key move is an exit here and an entrant there; a delete costs no load", async () => {
    const seedFrom = routed.length;
    await db.execute(
      sql.raw(`INSERT INTO ${CELLS} VALUES ('sa', 'r/1', 0, 'a1'), ('sa', 'r,2', 0, 'a2'),
                                           ('sb', 'q', 0, 'b1'), ('sb', 'q', 1, 'b2')`),
    );
    await settled(seedFrom);
    await subscribe(A);
    await subscribe(B);
    expect(valuesOf("sa")).toEqual(["a1", "a2"]);
    expect(valuesOf("sb")).toEqual(["b1", "b2"]);
    const baseline = loads.length;

    // A value write to a row of B: B refills that row by its composed id;
    // A loads nothing and is sent nothing.
    expect(
      await step(
        `UPDATE ${CELLS} SET value = 'b1x' WHERE surface = 'sb' AND row_key = 'q' AND idx = 0`,
      ),
    ).toEqual({
      loads: [{ surface: "sb", ids: [id("sb", "q", 0)] }],
      orderOf: ["sb"],
      framesA: 0,
      framesB: 1,
    });
    // An insert into A: one refill and one orderOf for A, nothing for B.
    expect(
      await step(`INSERT INTO ${CELLS} VALUES ('sa', 'r3', 7, 'a0')`),
    ).toEqual({
      loads: [{ surface: "sa", ids: [id("sa", "r3", 7)] }],
      orderOf: ["sa"],
      framesA: 1,
      framesB: 0,
    });
    expect(valuesOf("sa")).toEqual(["a0", "a1", "a2"]);
    // A key move from A to B: the row's id changes with its scope. The old
    // row (A's id) exits A; the new row (B's id) enters B.
    const move = await step(
      `UPDATE ${CELLS} SET surface = 'sb' WHERE surface = 'sa' AND row_key = 'r/1' AND idx = 0`,
    );
    expect([...move.loads].sort(bySurface)).toEqual([
      { surface: "sa", ids: [id("sa", "r/1", 0)] },
      { surface: "sb", ids: [id("sb", "r/1", 0)] },
    ]);
    expect(valuesOf("sa")).toEqual(["a0", "a2"]);
    expect(valuesOf("sb")).toEqual(["a1", "b1x", "b2"]);
    // A delete in B: an exit with no load; A is not touched.
    expect(
      await step(
        `DELETE FROM ${CELLS} WHERE surface = 'sb' AND row_key = 'q' AND idx = 1`,
      ),
    ).toEqual({ loads: [], orderOf: [], framesA: 0, framesB: 1 });
    // Never once FULL after the subscribes.
    expect(loads.slice(baseline).some((l) => l.ids === "FULL")).toBe(false);
  }, 60_000);

  test("`:rows` reads composite ids; one the codec cannot decode, or with a non-canonical integer part, is absent", async () => {
    const rows = await rowsLoader(
      [
        id("sa", "r,2", 0),
        "not-an-id",
        cellKey.encodeParts(["sa", "r,2", "00"]),
        cellKey.encodeParts(["sa", "r3", "x"]),
      ].join(","),
    );
    expect(rows).toEqual([
      { surface: "sa", rowKey: "r,2", idx: 0, value: "a2" },
    ]);
  });

  test("a `:rows` tuple of one composite id (a widget reading its own row) is reached by its row's write only", async () => {
    const ROWS = `${KEY}:rows`;
    const params = { ids: id("sa", "r,2", 0) };
    const from = frames.length;
    handler.message(ws, JSON.stringify({ op: "sub", key: ROWS, params }));
    await until(
      () =>
        frames.slice(from).some((f) => f.key === ROWS && f.kind === "sub-ack"),
      () => `sub-ack ${ROWS}`,
    );
    const rowFrames = (since: number) =>
      frames.slice(since).filter((f) => f.key === ROWS).length;
    // A sibling row in the same scope: the point tuple is sent nothing.
    let at = frames.length;
    await step(
      `UPDATE ${CELLS} SET value = 'a0x' WHERE surface = 'sa' AND row_key = 'r3' AND idx = 7`,
    );
    expect(rowFrames(at)).toBe(0);
    // Its own row: one frame.
    at = frames.length;
    await step(
      `UPDATE ${CELLS} SET value = 'a2x' WHERE surface = 'sa' AND row_key = 'r,2' AND idx = 0`,
    );
    expect(rowFrames(at)).toBe(1);
  }, 60_000);

  test("over the 7000-byte NOTIFY cap the change carries no keys: FULL for every tuple, A and B both, and both converge", async () => {
    const values = Array.from(
      { length: 200 },
      (_, i) => `('sa', 'bulk-${"x".repeat(40)}', ${i}, 'bulk')`,
    ).join(", ");
    const cost = await step(`INSERT INTO ${CELLS} VALUES ${values}`);
    const change = routed.at(-1)!;
    expect(change.keys).toBeNull();
    expect([...cost.loads].sort(bySurface)).toEqual([
      { surface: "sa", ids: "FULL" },
      { surface: "sb", ids: "FULL" },
    ]);
    expect((valueOf("sa") as unknown[]).length).toBe(202);
  }, 60_000);
});
