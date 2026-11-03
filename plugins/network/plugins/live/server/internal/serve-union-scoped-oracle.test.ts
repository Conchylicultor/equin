/**
 * Oracle for SCOPED columns on a union (C1 of
 * research/2026-11-03-global-live-collections-item7-remaining.md, item 7
 * session 3), on a throwaway database: the runs shape in miniature — two
 * ledgers in one window — listed on TWO surfaces, each with its own custom
 * column `prio` (a number on one, text on the other: the same member id, two
 * definitions). Each surface's values are keyed by the union's row key
 * (`<kind>:<id>`), as a DataView keys a row.
 *
 * - Sorted by a surface's custom column, rows of both arms interleave by its
 *   value, cast as that surface defines it; hosts with no value (NULL) sort
 *   last, in both directions, by row key.
 * - Paged: a cut on a NULL row (and one just before the NULLs) continues
 *   across arms with no row dropped or repeated — the pages tile the order.
 * - Filtered by it in each arm; `isEmpty` keeps the hosts with no value.
 * - The two surfaces read apart: the other surface's values never leak in.
 * - A row ordered by a member carries it under `$scoped` (its order
 *   signature reads it); `$columns` is unchanged.
 * - Routing: one family route per arm, keeping that arm's row keys only, read
 *   by a tuple matching the scope it names and the members it reads; its
 *   `recomputeOn` is the members' tuple of that scope.
 * - The params gate refuses a scope no set serves.
 * - Through the REAL feed (the routed triggers, the LISTEN consumer,
 *   `routeChange`, the server-core runtime): a custom-value write of either
 *   surface, on either arm, refills only the tuples of its surface reading
 *   that column — never FULL, never the other surface's tuples — and every
 *   view converges to a fresh load; a surface's definitions moving recomputes
 *   exactly that surface's tuples.
 *
 * Requires a running Postgres cluster (started by ./equin build).
 * Run: `./equin test plugins/network/plugins/live`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { Client } from "pg";
import { z } from "zod";
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
  type ResourceParams,
} from "@plugins/framework/plugins/server-core/core";
import { clearRelationBases } from "@plugins/framework/plugins/server-core/core/testing";
import {
  makeClientView,
  type ClientView,
  type RecordedFrame,
} from "@plugins/network/plugins/live/plugins/resource-runtime/core/testing";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import type { ColumnRef } from "@plugins/network/plugins/live/plugins/query-resource/core";
import type { QueryDb } from "@plugins/network/plugins/live/plugins/query-resource/server";
import {
  LIVE_ROW_KEY,
  LIVE_SCOPED_KEY,
  liveArm,
  liveCollection,
  liveValue,
  scopedLiveColumns,
  type LiveScopedColumns,
  type LiveWindowParams,
} from "@plugins/network/plugins/live/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { compileUnion, type UnionArmBinding } from "./serve-union";
import {
  serveScopedColumns,
  type ScopedMemberRead,
  type ServedScopedColumns,
} from "./serve-columns";
import { serveValue } from "./serve-value";

const A = "osc_a";
const B = "osc_b";
const VALUES = "osc_custom_values";
const ledger = (name: string) =>
  pgTable(name, {
    id: text("id").primaryKey(),
    label: text("label").notNull(),
  });
const aRuns = ledger(A);
const bRuns = ledger(B);
const valuesTable = pgTable(
  VALUES,
  {
    dataViewId: text("data_view_id").notNull(),
    rowKey: text("row_key").notNull(),
    columnId: text("column_id").notNull(),
    value: text("value").notNull(),
  },
  (t) => [primaryKey({ columns: [t.dataViewId, t.rowKey, t.columnId] })],
);

/** The runs list's surface: `prio` is a number. */
const RUNS = "test.runs";
/** The Deploy Activity page's surface: `prio` is text. */
const DEPLOY = "test.deploy-activity";

const runs = liveCollection("test.live.union-scoped-oracle", {
  fields: {
    kind: textField({ label: "Kind" }),
    label: textField({ label: "Label" }),
  },
  carry: { fields: { runKey: textField(), id: textField() } },
  id: "runKey",
  arms: { discriminator: "kind" },
  sortable: ["label"],
  default: { orderBy: [["label", "asc"]], limit: 10 },
  maxLimit: 20,
  scopedColumns: true,
});
const aColumns = liveArm(runs, "a", { label: "A", order: 10, fields: {} });
const bColumns = liveArm(runs, "b", { label: "B", order: 20, fields: {} });

type Refs = Record<string, Record<string, ColumnRef>>;
const armOf = (
  columns: typeof aColumns,
  table: typeof aRuns,
): UnionArmBinding => ({
  columns,
  from: table,
  id: table.id,
  base: (j) => {
    const r = j as unknown as Refs;
    return { id: r.base!.id!, label: r.base!.label! };
  },
  extra: () => ({}),
});
const arms = [armOf(aColumns, aRuns), armOf(bColumns, bRuns)];

const DEFS = new Map<string, ReadonlyMap<string, ScopedMemberRead>>([
  [
    RUNS,
    new Map<string, ScopedMemberRead>([
      [
        "prio",
        {
          domain: "number",
          cast: { sql: (raw) => sql`(${raw})::numeric`, sqlType: "numeric" },
        },
      ],
    ]),
  ],
  [DEPLOY, new Map<string, ScopedMemberRead>([["prio", { domain: "text" }]])],
]);
// The external value a surface's definitions move with (its tuple per scope).
let defsVersion = 0;
const defs = liveValue("test.live.union-scoped-oracle.defs", {
  schema: z.number(),
  params: ["dataViewId"],
});
let defsServed: ReturnType<typeof serveDefs>;
function serveDefs() {
  return serveValue(defs, {
    source: "external",
    changes: "notified",
    loader: () => defsVersion,
  });
}
let set: ServedScopedColumns;
const handles: Readonly<Record<string, LiveScopedColumns>> = {
  [RUNS]: scopedLiveColumns(RUNS, "custom", {
    prio: { domain: "number", sortable: true },
  }),
  [DEPLOY]: scopedLiveColumns(DEPLOY, "custom", {
    prio: { domain: "text", sortable: true },
  }),
};

let testDb: TestDb;
let client: Client;
let db: NodePgDatabase;
let compiled: ReturnType<typeof compileUnion>;
let listener: ReturnType<typeof createChangeFeedListener>;
const routed: FeedChange[] = [];
const loads: { params: string; ids: readonly string[] | "FULL" }[] = [];
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

beforeAll(async () => {
  setRelationBases((r) => [r]);
  testDb = await createTestDb({ prefix: "live_union_scoped" });
  client = new Client({ connectionString: testDb.connectionString });
  await client.connect();
  db = drizzle(client);
  for (const name of [A, B]) {
    await db.execute(
      sql.raw(
        `CREATE TABLE ${name} (id text PRIMARY KEY, label text NOT NULL);`,
      ),
    );
  }
  await db.execute(
    sql.raw(
      `CREATE TABLE ${VALUES} (data_view_id text NOT NULL, row_key text NOT NULL,
         column_id text NOT NULL, value text NOT NULL,
         PRIMARY KEY (data_view_id, row_key, column_id));`,
    ),
  );
  await db
    .insert(aRuns)
    .values(["a1", "a2", "a3"].map((id) => ({ id, label: id })));
  await db
    .insert(bRuns)
    .values(["b1", "b2", "b3"].map((id) => ({ id, label: id })));
  // RUNS: a1=3, b1=1, a2=10 (10 > 3 as a number, not as text); a3, b2, b3
  // have none. DEPLOY: b2='x', a3='y' — and a value for a1 under a member id
  // RUNS does not define.
  await db.insert(valuesTable).values([
    { dataViewId: RUNS, rowKey: "a:a1", columnId: "prio", value: "3" },
    { dataViewId: RUNS, rowKey: "b:b1", columnId: "prio", value: "1" },
    { dataViewId: RUNS, rowKey: "a:a2", columnId: "prio", value: "10" },
    { dataViewId: DEPLOY, rowKey: "b:b2", columnId: "prio", value: "x" },
    { dataViewId: DEPLOY, rowKey: "a:a3", columnId: "prio", value: "y" },
    { dataViewId: DEPLOY, rowKey: "a:a1", columnId: "other", value: "z" },
  ]);
  // The definitions' value, registered before the window recomputing on it.
  defsServed = serveDefs();
  set = serveScopedColumns({
    name: "custom",
    table: valuesTable,
    scope: valuesTable.dataViewId,
    hostKey: valuesTable.rowKey,
    member: valuesTable.columnId,
    value: valuesTable.value,
    serves: (scope) => DEFS.has(scope),
    members: (scope) => DEFS.get(scope)!,
    recomputeOn: {
      resource: defsServed,
      params: (scope) => ({ dataViewId: scope }),
    },
    watch: () => {},
  });
  compiled = compileUnion(runs, {
    arms: () => arms,
    scoped: [set],
    db: db as unknown as QueryDb,
  });
  defineResource(runs.window, {
    ...compiled.window,
    loader: (p, ctx) => {
      loads.push({
        params: JSON.stringify(p),
        ids: ctx ? [...ctx.affectedIds] : "FULL",
      });
      return compiled.window.loader(p, ctx);
    },
  });
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
    coveredTables: () => [A, B, VALUES],
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

const w = runs.window.window;
type Row = Record<string, unknown>;
const encode = (
  scope: string,
  q: {
    where?: object;
    orderBy?: readonly (readonly [string, "asc" | "desc"])[];
    limit?: number;
  },
  cuts?: { after?: string; until?: string },
): LiveWindowParams =>
  w.encode({ ...q, columns: [handles[scope]!] } as never, cuts);
const load = async (params: LiveWindowParams): Promise<Row[]> =>
  (await compiled.window.loader(params)) as unknown as Row[];
const keys = (rows: readonly Row[]) => rows.map((r) => r.runKey);

/** Every page of `q` at `limit`, cut at each page's last `$key`. */
async function pages(
  scope: string,
  q: { orderBy: readonly (readonly [string, "asc" | "desc"])[] },
  limit: number,
): Promise<{ pages: string[][]; cuts: unknown[] }> {
  const out: string[][] = [];
  const cuts: unknown[] = [];
  let after: string | undefined;
  for (;;) {
    const rows = await load(
      encode(scope, { ...q, limit }, after === undefined ? {} : { after }),
    );
    if (rows.length === 0) break;
    out.push(keys(rows) as string[]);
    if (rows.length < limit) break;
    after = rows.at(-1)![LIVE_ROW_KEY] as string;
    cuts.push(JSON.parse(after));
  }
  return { pages: out, cuts };
}

describe("scoped columns on a union", () => {
  test("sorted by one surface's column: arms interleave by its cast value, NULLs last both ways", async () => {
    const asc = await load(encode(RUNS, { orderBy: [["custom.prio", "asc"]] }));
    expect(keys(asc)).toEqual(["b:b1", "a:a1", "a:a2", "a:a3", "b:b2", "b:b3"]);
    const desc = await load(
      encode(RUNS, { orderBy: [["custom.prio", "desc"]] }),
    );
    expect(keys(desc)).toEqual([
      "a:a2",
      "a:a1",
      "b:b1",
      "a:a3",
      "b:b2",
      "b:b3",
    ]);
  });

  test("the other surface reads its own definition and values: same member id, text, its own rows", async () => {
    const desc = await load(
      encode(DEPLOY, { orderBy: [["custom.prio", "desc"]] }),
    );
    expect(keys(desc)).toEqual([
      "a:a3",
      "b:b2",
      "a:a1",
      "a:a2",
      "b:b1",
      "b:b3",
    ]);
  });

  test("paged: a cut on a NULL row, and one just before the NULLs, continue across arms — the pages tile the order", async () => {
    const full = keys(
      await load(encode(RUNS, { orderBy: [["custom.prio", "asc"]] })),
    );
    // Limit 4: page 1 ends on a:a3 (NULL) — the next page continues with the
    // other arm's NULL rows.
    const four = await pages(RUNS, { orderBy: [["custom.prio", "asc"]] }, 4);
    expect(four.pages).toEqual([
      ["b:b1", "a:a1", "a:a2", "a:a3"],
      ["b:b2", "b:b3"],
    ]);
    expect(four.cuts[0]).toEqual([null, "a:a3"]);
    // Limit 3: page 1 ends on the last non-NULL row (a:a2, an `a` row): the
    // NULLs of both arms follow.
    const three = await pages(RUNS, { orderBy: [["custom.prio", "asc"]] }, 3);
    expect(three.pages).toEqual([
      ["b:b1", "a:a1", "a:a2"],
      ["a:a3", "b:b2", "b:b3"],
    ]);
    expect(three.cuts[0]).toEqual(["10", "a:a2"]);
    // Limit 1..5, both directions: the concatenation is the full order.
    for (const dir of ["asc", "desc"] as const) {
      const order = keys(
        await load(encode(RUNS, { orderBy: [["custom.prio", dir]] })),
      );
      if (dir === "asc") expect(order).toEqual(full);
      for (let limit = 1; limit <= 5; limit++) {
        const p = await pages(RUNS, { orderBy: [["custom.prio", dir]] }, limit);
        expect(p.pages.flat()).toEqual(order as string[]);
      }
    }
  });

  test("filtered by it in each arm; isEmpty keeps the hosts with no value", async () => {
    const gt = await load(
      encode(RUNS, {
        where: { "custom.prio": { gt: 2 } },
        orderBy: [["label", "asc"]],
      }),
    );
    expect(keys(gt)).toEqual(["a:a1", "a:a2"]);
    const none = await load(
      encode(RUNS, {
        where: { "custom.prio": { isEmpty: true } },
        orderBy: [["label", "asc"]],
      }),
    );
    expect(keys(none)).toEqual(["a:a3", "b:b2", "b:b3"]);
    const text = await load(
      encode(DEPLOY, { where: { "custom.prio": { eq: "x" } } }),
    );
    expect(keys(text)).toEqual(["b:b2"]);
  });

  test("a row ordered by a member carries it under `$scoped`; one that is not carries none", async () => {
    const ordered = await load(
      encode(RUNS, { orderBy: [["custom.prio", "asc"]], limit: 2 }),
    );
    expect(ordered.map((r) => r[LIVE_SCOPED_KEY])).toEqual([
      { "custom.prio": "1" },
      { "custom.prio": "3" },
    ]);
    const filtered = await load(
      encode(RUNS, { where: { "custom.prio": { gt: 2 } } }),
    );
    for (const row of filtered) expect(row).not.toHaveProperty(LIVE_SCOPED_KEY);
    // The member moving moves the order signature.
    const membership = compiled.window.membership!;
    if (membership.kind !== "window") throw new Error("a window");
    const params = encode(RUNS, { orderBy: [["custom.prio", "asc"]] });
    const moved = { ...ordered[0]!, [LIVE_SCOPED_KEY]: { "custom.prio": "9" } };
    expect(membership.orderSignatureOf!(ordered[0], params)).not.toBe(
      membership.orderSignatureOf!(moved, params),
    );
  });

  test("routing: one family route per arm, keeping its own row keys; a tuple matches its scope and members", () => {
    const routes = compiled.window.routes!;
    for (const kind of ["a", "b"]) {
      const route = routes.routes.find((r) => r.id === `${kind}.custom`)!;
      expect(route.table).toBe(VALUES);
      expect(route.match).toEqual(["column_id", "data_view_id"]);
      if (route.map.kind !== "alias") throw new Error("an alias route");
      const other = kind === "a" ? "b" : "a";
      expect(route.map.encode!(`${kind}:${kind}1`)).toBe(`${kind}:${kind}1`);
      expect(route.map.encode!(`${other}:${other}1`)).toBeNull();
    }
    const uses = routes.usesOf(
      encode(RUNS, { orderBy: [["custom.prio", "asc"]] }),
    );
    for (const kind of ["a", "b"]) {
      const use = uses.get(`${kind}.custom`)!;
      expect(use.role).toBe("membership");
      expect([...use.match!.data_view_id!]).toEqual([RUNS]);
      expect([...use.match!.column_id!]).toEqual(["prio"]);
    }
    // A tuple naming no custom column reads no family route.
    const plain = routes.usesOf(encode(RUNS, {}));
    expect([...plain.keys()].some((id) => id.endsWith(".custom"))).toBe(false);
  });

  test("recomputeOn is the members' tuple of the scope a tuple names", () => {
    const [on] = compiled.window.recomputeOn!;
    expect(on!.resource).toBe(defsServed);
    expect(
      on!.paramsOf!(encode(DEPLOY, { orderBy: [["custom.prio", "asc"]] })),
    ).toEqual({ dataViewId: DEPLOY });
    expect(on!.paramsOf!(encode(RUNS, {}))).toBeNull();
  });

  test("the params gate refuses a scope no set serves, and a member the scope does not define", () => {
    const params = encode(RUNS, { orderBy: [["custom.prio", "asc"]] });
    compiled.window.validateParams!(params);
    expect(() =>
      compiled.window.validateParams!({ ...params, scope: "nowhere" }),
    ).toThrow(/served by no scoped column set/);
    const other = scopedLiveColumns(DEPLOY, "custom", {
      other: { domain: "text", sortable: true },
    });
    expect(() =>
      compiled.window.validateParams!(
        w.encode({
          orderBy: [["custom.other", "asc"]],
          columns: [other],
        } as never),
      ),
    ).toThrow(/custom\.other/);
  });
});

// ── Through the real feed ───────────────────────────────────────────────────

async function until(cond: () => boolean, what: () => string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what()}`);
    await new Promise((r) => setTimeout(r, 5));
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

async function quiet(): Promise<void> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const at = [loads.length, frames.length];
    await new Promise((r) => setTimeout(r, 120));
    if (loads.length === at[0] && frames.length === at[1]) return;
    if (Date.now() > deadline) throw new Error("the runtime never went quiet");
  }
}

const views = new Map<string, { view: ClientView; from: number }>();
function viewOf(params: ResourceParams): ClientView {
  const entry = views.get(JSON.stringify(params))!;
  entry.view.applyAll(
    frames
      .slice(entry.from)
      .filter(
        (f) =>
          f.key === runs.key &&
          JSON.stringify(f.params ?? {}) === JSON.stringify(params),
      ),
  );
  entry.from = frames.length;
  return entry.view;
}
async function subscribe(params: ResourceParams): Promise<void> {
  const from = frames.length;
  views.set(JSON.stringify(params), {
    view: makeClientView((r) => (r as { runKey: string }).runKey),
    from,
  });
  handler.message(ws, JSON.stringify({ op: "sub", key: runs.key, params }));
  await until(
    () =>
      frames
        .slice(from)
        .some(
          (f) =>
            f.kind === "sub-ack" &&
            f.key === runs.key &&
            JSON.stringify(f.params ?? {}) === JSON.stringify(params),
        ),
    () => `sub-ack ${JSON.stringify(params)}`,
  );
}

describe("scoped columns on a union, through the real feed", () => {
  test("a custom-value write refills only its surface's tuples reading it, on either arm; views converge; definitions recompute their surface only", async () => {
    const tuples: { params: LiveWindowParams; scope: string | null }[] = [
      { params: encode(RUNS, { limit: 4 }), scope: null },
      {
        params: encode(RUNS, { orderBy: [["custom.prio", "asc"]], limit: 4 }),
        scope: RUNS,
      },
      {
        params: encode(RUNS, { where: { "custom.prio": { gt: 2 } } }),
        scope: RUNS,
      },
      {
        params: encode(DEPLOY, {
          orderBy: [["custom.prio", "desc"]],
          limit: 4,
        }),
        scope: DEPLOY,
      },
    ];
    for (const t of tuples) await subscribe(t.params);
    const check = async (what: string) => {
      const off = async () => {
        for (const t of tuples) {
          const fresh = canonical(
            runs.window.schema.parse(await compiled.window.loader(t.params)),
          );
          if (canonical(viewOf(t.params).value) !== fresh) return t;
        }
        return undefined;
      };
      const deadline = Date.now() + 8000;
      while ((await off()) !== undefined) {
        if (Date.now() > deadline) {
          const t = (await off())!;
          throw new Error(
            `${what}: ${JSON.stringify(t.params)} holds ${canonical(viewOf(t.params).value)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      await quiet();
    };
    const steps: {
      what: string;
      scope: string;
      run: () => Promise<unknown>;
    }[] = [
      {
        what: "RUNS: b3 gets prio 0 (an entrant at the head of the sorted page)",
        scope: RUNS,
        run: () =>
          db.insert(valuesTable).values({
            dataViewId: RUNS,
            rowKey: "b:b3",
            columnId: "prio",
            value: "0",
          }),
      },
      {
        what: "RUNS: a2 drops from 10 to 2 (leaves the gt-2 filter)",
        scope: RUNS,
        run: () =>
          db.execute(
            sql`UPDATE ${valuesTable} SET value = '2'
                WHERE data_view_id = ${RUNS} AND row_key = 'a:a2' AND column_id = 'prio'`,
          ),
      },
      {
        what: "DEPLOY: a1 gets prio 'zz' (heads the DEPLOY desc page)",
        scope: DEPLOY,
        run: () =>
          db.insert(valuesTable).values({
            dataViewId: DEPLOY,
            rowKey: "a:a1",
            columnId: "prio",
            value: "zz",
          }),
      },
      {
        what: "DEPLOY: b2's value is cleared",
        scope: DEPLOY,
        run: () =>
          db.execute(
            sql`DELETE FROM ${valuesTable}
                WHERE data_view_id = ${DEPLOY} AND row_key = 'b:b2' AND column_id = 'prio'`,
          ),
      },
    ];
    for (const step of steps) {
      const routedAt = routed.length;
      const loadsAt = loads.length;
      await step.run();
      await until(
        () => routed.slice(routedAt).some((c) => c.table === VALUES),
        () => `${step.what}: never routed`,
      );
      await check(step.what);
      const stepLoads = loads.slice(loadsAt);
      expect(stepLoads.filter((l) => l.ids === "FULL")).toEqual([]);
      for (const t of tuples) {
        if (t.scope === step.scope) continue;
        // Another surface's tuples, and the one naming no custom column,
        // load nothing.
        expect(
          stepLoads.filter((l) => l.params === JSON.stringify(t.params)),
        ).toEqual([]);
      }
      // The write reached its surface's readers through the arm its row key
      // names (a refill naming only that row).
      expect(stepLoads.length).toBeGreaterThan(0);
    }
    // RUNS's definitions move: exactly RUNS's tuples recompute FULL.
    const at = loads.length;
    defsVersion++;
    defsServed.notify({ dataViewId: RUNS });
    await quiet();
    const full = loads.slice(at).filter((l) => l.ids === "FULL");
    expect(full.map((l) => l.params).sort()).toEqual(
      tuples
        .filter((t) => t.scope === RUNS)
        .map((t) => JSON.stringify(t.params))
        .sort(),
    );
    await check("after the definitions moved");
  }, 60_000);
});
