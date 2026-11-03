/**
 * Differential oracle for a collection over a SCOPED column set — a DataView
 * surface's custom columns (P3 of research/2026-09-29-global-scoped-change-routing.md)
 * — on a throwaway database through the REAL feed: the change-feed's routed
 * triggers (installed from the registered routes: the composite-keyed values
 * table carries its key layout), its LISTEN consumer, `routeChange`, and the
 * server-core runtime.
 *
 * ONE collection is listed on TWO surfaces, each with its own definitions (a
 * scope per query): a seeded random workload of host writes and custom-value
 * writes (both surfaces', single- and multi-row) runs against window tuples
 * that sort and filter by either surface's custom columns, and one that reads
 * none. After every statement:
 *
 * - every subscribed tuple's client view equals a fresh FULL load of it;
 * - no subscribed tuple is reloaded FULL, and every refill names only hosts the
 *   statement changed (or a row it made room for);
 * - a custom-value write loads nothing in a tuple of another surface, nor in
 *   one reading no custom column (the one route's per-tuple scope `match`);
 * - a write to a column a tuple does not read loads nothing in it (the
 *   per-tuple member `match`).
 *
 * Then one surface's definitions change (`recomputeOn`, per tuple): exactly
 * that surface's subscribed tuples recompute FULL, once, and converge.
 *
 * Requires a running Postgres cluster (started by ./equin build).
 * Run: `./equin test plugins/network/plugins/live`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { Client } from "pg";
import { z } from "zod";
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
  type ResourceParams,
  setRelationBases,
} from "@plugins/framework/plugins/server-core/core";
import { clearRelationBases } from "@plugins/framework/plugins/server-core/core/testing";
import {
  makeClientView,
  type ClientView,
  type RecordedFrame,
} from "@plugins/network/plugins/live/plugins/resource-runtime/core/testing";
import type { QueryDb } from "@plugins/network/plugins/live/plugins/query-resource/server";
import { compileWindowQuery } from "@plugins/network/plugins/live/plugins/query-resource/server/testing";
import {
  liveCollection,
  liveValue,
  scopedLiveColumns,
  type LiveScopedColumns,
} from "@plugins/network/plugins/live/core";
import { compileCollection } from "./serve-collection";
import { serveScopedColumns, type ScopedMemberRead } from "./serve-columns";
import { serveValue } from "./serve-value";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";

const HOST = "sco_hosts";
const VALUES = "sco_custom_values";
const SCOPE = "test.scoped.surface";
const OTHER = "test.scoped.other";

const hostsTable = pgTable(HOST, {
  id: text("id").primaryKey(),
  n: integer("n").notNull(),
});
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

const collection = liveCollection("test.live.scoped-oracle", {
  fields: {
    id: textField({ label: "Id", filterable: false }),
    n: intField({ label: "N" }),
  },
  id: "id",
  sortable: ["n"],
  default: { orderBy: [["n", "asc"]], limit: 4 },
  maxLimit: 20,
  scopedColumns: true,
});

const NUMERIC: ScopedMemberRead = {
  domain: "number",
  cast: { sql: (raw) => sql`(${raw})::numeric`, sqlType: "numeric" },
};
// Each surface's definitions: SCOPE's `tag` (text) and `score` (a number,
// cast); OTHER's `tag` too — a member id both define, read apart — and `rank`.
const members = new Map<string, ReadonlyMap<string, ScopedMemberRead>>([
  [
    SCOPE,
    new Map<string, ScopedMemberRead>([
      ["tag", { domain: "text" }],
      ["score", NUMERIC],
    ]),
  ],
  [
    OTHER,
    new Map<string, ScopedMemberRead>([
      ["tag", { domain: "text" }],
      ["rank", NUMERIC],
    ]),
  ],
]);
let defsVersion = 0;
const defs = liveValue("test.live.scoped-oracle.defs", {
  schema: z.number(),
  params: ["scope"],
});

interface Load {
  params: string;
  ids: readonly string[] | "FULL";
}

let testDb: TestDb;
let client: Client;
let db: NodePgDatabase;
let listener: ReturnType<typeof createChangeFeedListener>;
let defsServed: ReturnType<typeof serveDefs>;
let truth: (params: ResourceParams) => Promise<unknown>;
const routed: FeedChange[] = [];
const loads: Load[] = [];
const frames: RecordedFrame[] = [];
let seq = 0;

function serveDefs() {
  return serveValue(defs, {
    source: "external",
    changes: "notified",
    loader: () => defsVersion,
  });
}

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

async function quiet(): Promise<void> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const at = [loads.length, frames.length];
    await new Promise((r) => setTimeout(r, 120));
    if (loads.length === at[0] && frames.length === at[1]) return;
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

// Each surface's browser view of its members, for encoding tuples.
const handles: Readonly<Record<string, LiveScopedColumns>> = {
  [SCOPE]: scopedLiveColumns(SCOPE, "custom", {
    tag: { domain: "text", sortable: true },
    score: { domain: "number", sortable: true },
  }),
  [OTHER]: scopedLiveColumns(OTHER, "custom", {
    tag: { domain: "text", sortable: true },
    rank: { domain: "number", sortable: true },
  }),
};
const encode = (
  scope: string,
  q: {
    where?: object;
    orderBy?: readonly (readonly [string, "asc" | "desc"])[];
    limit?: number;
  },
) =>
  collection.window.window.encode({
    ...q,
    columns: [handles[scope]!],
  } as never);

const TUPLES: Array<{
  params: ResourceParams;
  /** The surface it is asked from — `null` when it names no custom column. */
  scope: string | null;
  reads: readonly string[];
}> = [
  // Reads no custom column (whichever surface lists it: one tuple).
  { params: encode(SCOPE, {}), scope: null, reads: [] },
  // Sorted by a custom column (membership: its order).
  {
    params: encode(SCOPE, { orderBy: [["custom.tag", "asc"]], limit: 3 }),
    scope: SCOPE,
    reads: ["tag"],
  },
  // Filtered by the cast one.
  {
    params: encode(SCOPE, { where: { "custom.score": { gt: 4 } } }),
    scope: SCOPE,
    reads: ["score"],
  },
  // Both, and a host column.
  {
    params: encode(SCOPE, {
      where: { "custom.tag": { eq: "b" }, n: { lte: 7 } },
      orderBy: [["custom.score", "desc"]],
    }),
    scope: SCOPE,
    reads: ["tag", "score"],
  },
  // The other surface: the same member id, its own values.
  {
    params: encode(OTHER, { orderBy: [["custom.tag", "desc"]], limit: 3 }),
    scope: OTHER,
    reads: ["tag"],
  },
  // The other surface's own column, sorted with NULLs (no row) last.
  {
    params: encode(OTHER, { orderBy: [["custom.rank", "asc"]] }),
    scope: OTHER,
    reads: ["rank"],
  },
];

const views = new Map<string, { view: ClientView; from: number }>();

function viewOf(params: ResourceParams): ClientView {
  const entry = views.get(JSON.stringify(params))!;
  entry.view.applyAll(
    frames
      .slice(entry.from)
      .filter(
        (f) =>
          f.key === collection.key &&
          JSON.stringify(f.params ?? {}) === JSON.stringify(params),
      ),
  );
  entry.from = frames.length;
  return entry.view;
}

async function subscribe(params: ResourceParams): Promise<void> {
  const from = frames.length;
  views.set(JSON.stringify(params), { view: makeClientView(), from });
  handler.message(
    ws,
    JSON.stringify({ op: "sub", key: collection.key, params }),
  );
  await until(
    () =>
      frames
        .slice(from)
        .some(
          (f) =>
            f.kind === "sub-ack" &&
            f.key === collection.key &&
            JSON.stringify(f.params ?? {}) === JSON.stringify(params),
        ),
    () => `sub-ack ${JSON.stringify(params)}`,
  );
}

beforeAll(async () => {
  // What change-feed's boot installs before its listener starts (D34): the
  // relation bases the router reaches a relation read through (and the drift
  // guard fails open through). No views matter here, so every relation is its
  // own base.
  setRelationBases((r) => [r]);
  testDb = await createTestDb({ prefix: "live_scoped_oracle" });
  client = new Client({ connectionString: testDb.connectionString });
  await client.connect();
  db = drizzle(client);
  await db.execute(
    sql.raw(
      `CREATE TABLE ${HOST} (id text PRIMARY KEY, n integer NOT NULL);
       CREATE TABLE ${VALUES} (data_view_id text NOT NULL, row_key text NOT NULL,
                               column_id text NOT NULL, value text NOT NULL,
                               PRIMARY KEY (data_view_id, row_key, column_id));`,
    ),
  );
  // The external value the surface's definitions move with — registered
  // before the collection, which recomputes on it.
  defsServed = serveDefs();
  const set = serveScopedColumns({
    name: "custom",
    table: valuesTable,
    scope: valuesTable.dataViewId,
    hostKey: valuesTable.rowKey,
    member: valuesTable.columnId,
    value: valuesTable.value,
    serves: (scope) => members.has(scope),
    members: (scope) => members.get(scope)!,
    recomputeOn: { resource: defsServed, params: (scope) => ({ scope }) },
    watch: () => {},
  });
  const specs = compileCollection(
    collection,
    { from: hostsTable, db: db as unknown as QueryDb },
    [set],
  );
  const opts = compileWindowQuery(collection.window, specs.window).serverOpts;
  defineResource(collection.window, {
    ...opts,
    loader: (p, ctx) => {
      loads.push({
        params: JSON.stringify(p),
        ids: ctx ? [...ctx.affectedIds] : "FULL",
      });
      return opts.loader(p, ctx);
    },
  });
  truth = async (p) =>
    collection.window.schema.parse(await opts.loader(p as never));
  // The feed, installed from the routes just registered: the values table's
  // routed trigger carries `data_view_id`, `row_key` and `column_id`.
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
    coveredTables: () => [HOST, VALUES],
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

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Step {
  what: string;
  run: () => Promise<void>;
  /** The host ids the statement may change. */
  hosts: readonly string[];
  /** The custom columns it writes (null = the host table). */
  columns: readonly string[] | null;
  /** The surface whose custom values it writes (null = the host table). */
  scope: string | null;
  table: string;
}

describe("serveCollection over a scoped column set — differential oracle", () => {
  test("random host / custom-value writes: views converge, refills stay O(changed) and reach only the tuples reading the column", async () => {
    const rand = prng(9001);
    const ids = ["h1", "h2", "h3", "h4", "h5", "h6", "h7"];
    const hosts = new Set<string>();
    for (const id of ids.slice(0, 6)) {
      await db.execute(
        sql`INSERT INTO ${hostsTable} (id, n) VALUES (${id}, ${Math.floor(rand() * 10)})`,
      );
      hosts.add(id);
    }
    await db.execute(
      sql`INSERT INTO ${valuesTable} VALUES
        (${SCOPE}, 'h1', 'tag', 'a'), (${SCOPE}, 'h2', 'tag', 'b'),
        (${SCOPE}, 'h3', 'score', '7'), (${SCOPE}, 'h4', 'score', '2'),
        (${OTHER}, 'h1', 'tag', 'z'), (${OTHER}, 'h3', 'rank', '5')`,
    );
    await until(
      () => routed.some((c) => c.table === VALUES),
      () => "seed changes",
    );
    for (const t of TUPLES) await subscribe(t.params);

    const any = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
    const nextStep = (): Step => {
      const present = [...hosts];
      const choices: Array<() => Step> = [
        () => {
          const id = any(present);
          const column = any(["tag", "score"]);
          const value =
            column === "tag"
              ? any(["a", "b", "c"])
              : String(Math.floor(rand() * 10));
          return {
            what: `set ${column}=${value} on ${id}`,
            hosts: [id],
            columns: [column],
            scope: SCOPE,
            table: VALUES,
            run: async () => {
              await db.execute(
                sql`INSERT INTO ${valuesTable} VALUES (${SCOPE}, ${id}, ${column}, ${value})
                    ON CONFLICT (data_view_id, row_key, column_id) DO UPDATE SET value = EXCLUDED.value`,
              );
            },
          };
        },
        () => {
          const id = any(present);
          const column = any(["tag", "score"]);
          return {
            what: `clear ${column} on ${id}`,
            hosts: [id],
            columns: [column],
            scope: SCOPE,
            table: VALUES,
            run: async () => {
              // A delete that may match nothing sends no NOTIFY: make it match.
              await db.execute(
                sql`INSERT INTO ${valuesTable} VALUES (${SCOPE}, ${id}, ${column}, '0')
                    ON CONFLICT DO NOTHING`,
              );
              await db.execute(
                sql`DELETE FROM ${valuesTable}
                    WHERE data_view_id = ${SCOPE} AND row_key = ${id} AND column_id = ${column}`,
              );
            },
          };
        },
        () => ({
          what: "bump every score",
          hosts: present,
          columns: ["score"],
          scope: SCOPE,
          table: VALUES,
          run: async () => {
            await db.execute(
              sql`INSERT INTO ${valuesTable} VALUES (${SCOPE}, 'h1', 'score', '1')
                  ON CONFLICT DO NOTHING`,
            );
            await db.execute(
              sql`UPDATE ${valuesTable} SET value = ((value)::numeric + 1)::text
                  WHERE data_view_id = ${SCOPE} AND column_id = 'score'`,
            );
          },
        }),
        () => {
          const id = any(present);
          const column = any(["tag", "rank"]);
          const value =
            column === "tag"
              ? any(["b", "q"])
              : String(Math.floor(rand() * 10));
          return {
            what: `the other surface's ${column}=${value} on ${id}`,
            hosts: [id],
            columns: [column],
            scope: OTHER,
            table: VALUES,
            run: async () => {
              await db.execute(
                sql`INSERT INTO ${valuesTable} VALUES (${OTHER}, ${id}, ${column}, ${value})
                    ON CONFLICT (data_view_id, row_key, column_id) DO UPDATE SET value = EXCLUDED.value || '0'`,
              );
            },
          };
        },
        () => {
          const id = any(present);
          const n = Math.floor(rand() * 10);
          return {
            what: `host ${id} n=${n}`,
            hosts: [id],
            columns: null,
            scope: null,
            table: HOST,
            run: async () => {
              await db.execute(
                sql`UPDATE ${hostsTable} SET n = ${n} WHERE id = ${id}`,
              );
            },
          };
        },
      ];
      const absent = ids.filter((id) => !hosts.has(id));
      if (absent.length > 0) {
        choices.push(() => {
          const id = any(absent);
          return {
            what: `insert host ${id}`,
            hosts: [id],
            columns: null,
            scope: null,
            table: HOST,
            run: async () => {
              await db.execute(
                sql`INSERT INTO ${hostsTable} (id, n) VALUES (${id}, ${Math.floor(rand() * 10)})`,
              );
              hosts.add(id);
            },
          };
        });
      }
      return any(choices)();
    };

    const history: string[] = [];
    let matchSkips = 0;
    let scopeSkips = 0;
    for (let step = 0; step < 60; step++) {
      const s = nextStep();
      history.push(s.what);
      const routedAt = routed.length;
      const loadsAt = loads.length;
      await s.run();
      await until(
        () => routed.slice(routedAt).some((c) => c.table === s.table),
        () => `step ${step} (${s.what}): never routed`,
      );
      const expected = new Map<string, string>();
      for (const t of TUPLES) {
        expected.set(
          JSON.stringify(t.params),
          canonical(await truth(t.params)),
        );
      }
      const off = () =>
        TUPLES.find(
          (t) =>
            canonical(viewOf(t.params).value) !==
            expected.get(JSON.stringify(t.params)),
        );
      await until(
        () => off() === undefined,
        () => {
          const t = off()!;
          return `step ${step} (${s.what}): ${JSON.stringify(t.params)} holds ${canonical(
            viewOf(t.params).value,
          )}, a fresh load reads ${expected.get(JSON.stringify(t.params))}; history ${history.slice(-4).join(" | ")}`;
        },
      );
      await quiet();
      expect(off()).toBeUndefined();

      const stepLoads = loads.slice(loadsAt);
      for (const load of stepLoads) {
        if (load.ids === "FULL") {
          throw new Error(
            `step ${step} (${s.what}) reloaded ${load.params} FULL — loads ${JSON.stringify(stepLoads)}`,
          );
        }
        const holds = (id: string) =>
          (JSON.parse(expected.get(load.params)!) as { id: string }[]).some(
            (r) => r.id === id,
          );
        const stray = load.ids.filter(
          (id) => !s.hosts.includes(id) && !holds(id),
        );
        if (stray.length > 0) {
          throw new Error(
            `step ${step} (${s.what}) refilled ${JSON.stringify(load.ids)} for ${load.params}`,
          );
        }
      }
      // A custom-value write reaches only the tuples of its surface reading
      // that column.
      if (s.columns !== null) {
        for (const t of TUPLES) {
          if (
            t.scope === s.scope &&
            t.reads.some((c) => s.columns!.includes(c))
          )
            continue;
          const mine = stepLoads.filter(
            (l) => l.params === JSON.stringify(t.params),
          );
          expect(mine).toEqual([]);
          if (t.scope !== null && t.scope !== s.scope) scopeSkips++;
          else if (t.reads.length > 0) matchSkips++;
        }
      }
    }
    // The per-tuple match really skipped writes to columns a reading tuple
    // did not name, and writes of the other surface (not just the tuple that
    // reads none).
    expect(matchSkips).toBeGreaterThan(0);
    expect(scopeSkips).toBeGreaterThan(0);

    // One surface's definitions change: exactly its subscribed tuples
    // recompute FULL, once, and converge.
    const at = loads.length;
    (members.get(SCOPE) as Map<string, ScopedMemberRead>).set("added", {
      domain: "text",
    });
    defsVersion++;
    defsServed.notify({ scope: SCOPE });
    await quiet();
    const full = loads.slice(at).filter((l) => l.ids === "FULL");
    expect(full.map((l) => l.params).sort()).toEqual(
      TUPLES.filter((t) => t.scope === SCOPE)
        .map((t) => JSON.stringify(t.params))
        .sort(),
    );
    for (const t of TUPLES) {
      expect(canonical(viewOf(t.params).value)).toBe(
        canonical(await truth(t.params)),
      );
    }
  }, 120_000);
});
