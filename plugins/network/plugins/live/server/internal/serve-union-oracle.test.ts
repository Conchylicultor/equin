/**
 * Differential oracle for a UNION collection (`serveUnionCollection`, step 12
 * of research/2026-10-01-global-scoped-change-routing-p5-p8-v2.md), on a
 * throwaway database through the REAL feed: the change-feed's routed triggers
 * (with the `unchanged` gate), its LISTEN consumer, `routeChange`, and the
 * server-core runtime resolving the union's encoded routes — the arms'
 * identities and the deploy-like arm's server lookup (a `reverse` route,
 * `within` decoded per arm, its answer encoded).
 *
 * Two arms, the runs shape in miniature:
 *
 * - `a` (builds): an arm `where` (`ns = 'here'` — a worktree's own rows), an
 *   outcome CASE as an `ExprField`, its own `code` column, and a `pid` no
 *   shape reads;
 * - `b` (deploys): a LEFT lookup of its server, whose name its label reads
 *   through an `ExprField` (`comp || ' on ' || coalesce(server.name, …)`), an FK
 *   cascade from the server, and a `pid` too.
 *
 * Every step is followed by convergence — every subscribed tuple's client view
 * equals a fresh FULL load of it — and the steps that must cost nothing (a
 * `pid` write on either arm) are checked to load nothing at all. A server
 * rename under the reverse cap refills exactly that server's runs; over it
 * (501 runs) the reading windows recompute FULL. Raw ids containing `:` key
 * and decode like any other.
 *
 * Requires a running Postgres cluster (started by ./singularity build).
 * Run: `./singularity test plugins/network/plugins/live`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { Client } from "pg";
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
  type ResourceParams,
  setRelationBases,
} from "@plugins/framework/plugins/server-core/core";
import { clearRelationBases } from "@plugins/framework/plugins/server-core/core/testing";
import {
  makeClientView,
  type ClientView,
  type RecordedFrame,
} from "@plugins/framework/plugins/resource-runtime/core/testing";
import {
  expr,
  type LookupJoin,
} from "@plugins/infra/plugins/query-resource/core";
import type { QueryDb } from "@plugins/infra/plugins/query-resource/server";
import {
  LIVE_ROW_KEY,
  liveArm,
  liveCollection,
} from "@plugins/network/plugins/live/core";
import { nullable } from "@plugins/fields/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { floatField } from "@plugins/fields/plugins/float/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { compileUnion, type UnionArmBinding } from "./serve-union";

const SRV = "ou_servers";
const A = "ou_a";
const B = "ou_b";

const servers = pgTable(SRV, {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
});
const aRuns = pgTable(A, {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  status: text("status").notNull(),
  code: integer("code"),
  ns: text("ns").notNull(),
  pid: integer("pid"),
});
const bRuns = pgTable(B, {
  id: text("id").primaryKey(),
  serverId: text("server_id").notNull(),
  comp: text("comp").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  pid: integer("pid"),
});

const runs = liveCollection("test.live.union-oracle", {
  fields: {
    runKey: textField({ label: "Key", filterable: false }),
    kind: textField({ label: "Kind" }),
    id: textField({ label: "Id", filterable: false }),
    label: textField({ label: "Label" }),
    outcome: textField({ label: "Outcome" }),
    startedAt: dateField({ label: "Started" }),
    finishedAt: nullable(dateField({ label: "Finished", filterable: false })),
  },
  id: "runKey",
  arms: { discriminator: "kind" },
  sortable: ["kind", "label", "startedAt"],
  default: { orderBy: [["startedAt", "desc"]], limit: 4 },
  maxLimit: 12,
});
const aColumns = liveArm(runs, "a", {
  label: "A",
  order: 10,
  fields: { code: nullable(floatField({ label: "Code" })) },
  sortable: ["code"],
});
const bColumns = liveArm(runs, "b", {
  label: "B",
  order: 20,
  fields: { server: textField({ label: "Server" }) },
  sortable: ["server"],
});

const serverJoin: LookupJoin<"server", typeof servers> = {
  kind: "lookup",
  alias: "server",
  table: servers,
  pk: servers.id,
  on: { from: "base", col: bRuns.serverId },
  required: false,
};

type Refs = Record<string, Record<string, unknown>>;
const arms: UnionArmBinding[] = [
  {
    columns: aColumns,
    from: aRuns,
    id: aRuns.id,
    base: (j) => {
      const r = j as unknown as Refs;
      return {
        id: j.base!.id!,
        label: j.base!.label!,
        outcome: expr(
          sql`(case when ${r.base!.finishedAt} is null then 'running' else ${r.base!.status} end)`,
          { decoder: String, sqlType: "text", notNull: true },
        ),
        startedAt: j.base!.startedAt!,
        finishedAt: j.base!.finishedAt!,
      };
    },
    extra: (j) => ({ code: j.base!.code! }),
    where: (j) => eq(j.base!.ns!, "here"),
  },
  {
    columns: bColumns,
    from: bRuns,
    id: bRuns.id,
    joins: [serverJoin],
    base: (j) => {
      const r = j as unknown as Refs;
      return {
        id: j.base!.id!,
        label: expr(
          sql`${r.base!.comp} || ' on ' || coalesce(${r.server!.name}, ${r.base!.serverId})`,
          { decoder: String, sqlType: "text", notNull: true },
        ),
        outcome: expr(
          sql`(case when ${r.base!.finishedAt} is null then 'running' else 'succeeded' end)`,
          { decoder: String, sqlType: "text", notNull: true },
        ),
        startedAt: j.base!.startedAt!,
        finishedAt: j.base!.finishedAt!,
      };
    },
    extra: (j) => ({ server: j.base!.serverId! }),
  },
];

interface Load {
  key: string;
  params: string;
  ids: readonly string[] | "FULL";
}

let testDb: TestDb;
let client: Client;
let db: NodePgDatabase;
let listener: ReturnType<typeof createChangeFeedListener>;
const routed: FeedChange[] = [];
const loads: Load[] = [];
const frames: RecordedFrame[] = [];
let seq = 0;
const truth = new Map<string, (params: ResourceParams) => Promise<unknown>>();

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

async function quiet(): Promise<void> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const at = [loads.length, frames.length];
    await new Promise((r) => setTimeout(r, 120));
    if (loads.length === at[0] && frames.length === at[1]) return;
    if (Date.now() > deadline) throw new Error("the runtime never went quiet");
  }
}

async function until(cond: () => boolean, what: () => string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what()}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const tupleKey = (key: string, params: ResourceParams) =>
  `${key} ${JSON.stringify(params)}`;

beforeAll(async () => {
  // What change-feed's boot installs before its listener starts (D34): the
  // relation bases the router reaches a relation read through (and the drift
  // guard fails open through). No views matter here, so every relation is its
  // own base.
  setRelationBases((r) => [r]);
  testDb = await createTestDb({ prefix: "live_union_oracle" });
  client = new Client({ connectionString: testDb.connectionString });
  await client.connect();
  db = drizzle(client);
  await db.execute(
    sql.raw(
      `CREATE TABLE ${SRV} (id text PRIMARY KEY, name text NOT NULL);
       CREATE TABLE ${A} (id text PRIMARY KEY, label text NOT NULL,
                          started_at timestamptz NOT NULL, finished_at timestamptz,
                          status text NOT NULL, code integer, ns text NOT NULL, pid integer);
       CREATE TABLE ${B} (id text PRIMARY KEY,
                          server_id text NOT NULL REFERENCES ${SRV}(id) ON DELETE CASCADE,
                          comp text NOT NULL, started_at timestamptz NOT NULL,
                          finished_at timestamptz, pid integer);
       CREATE INDEX ON ${B} (server_id);`,
    ),
  );
  const compiled = compileUnion(runs, {
    arms: () => arms,
    db: db as unknown as QueryDb,
  });
  const record =
    <P extends ResourceParams, R>(
      key: string,
      loader: (p: P, ctx?: { affectedIds: readonly string[] }) => R,
    ) =>
    (p: P, ctx?: { affectedIds: readonly string[] }): R => {
      loads.push({
        key,
        params: JSON.stringify(p),
        ids: ctx ? [...ctx.affectedIds] : "FULL",
      });
      return loader(p, ctx);
    };
  defineResource(runs.window, {
    ...compiled.window,
    loader: record(runs.key, compiled.window.loader),
  });
  defineResource(runs.rows, {
    ...compiled.rows,
    loader: record(runs.rows.key, compiled.rows.loader),
  });
  defineResource(runs.groups, {
    ...compiled.groups,
    loader: record(runs.groups.key, compiled.groups.loader),
  } as never);
  truth.set(runs.key, async (p) => compiled.window.loader(p as never));
  truth.set(runs.rows.key, async (p) => compiled.rows.loader(p as never));
  truth.set(runs.groups.key, async (p) => compiled.groups.loader(p as never));
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
    coveredTables: () => [SRV, A, B],
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
const g = runs.groups.groups;
const TUPLES: Array<{ key: string; params: ResourceParams }> = [
  // The default window: both arms, newest first.
  { key: runs.key, params: w.encode() },
  // Kind-pruned: b only.
  { key: runs.key, params: w.encode({ where: { kind: "b" }, limit: 6 }) },
  // Sorted by the label — b's reads the server lookup as membership.
  {
    key: runs.key,
    params: w.encode({ orderBy: [["label", "asc"]], limit: 5 }),
  },
  // An arm column: prunes b (its `a.code` is a NULL constant).
  {
    key: runs.key,
    params: w.encode({
      where: { "a.code": { gt: 0 } },
      columns: [aColumns],
      limit: 8,
      // A wire name of an arm's set is not in the collection's own `F`.
    } as never),
  },
  {
    key: runs.rows.key,
    params: runs.rows.point.encode(["a:a1", "b:b1", "a:x:y", "q:1"]),
  },
  { key: runs.groups.key, params: g.encode({ groupBy: "kind" }) },
];

const views = new Map<string, { view: ClientView; from: number }>();

function viewOf(key: string, params: ResourceParams): ClientView {
  const entry = views.get(tupleKey(key, params))!;
  entry.view.applyAll(
    frames
      .slice(entry.from)
      .filter(
        (f) =>
          f.key === key &&
          JSON.stringify(f.params ?? {}) === JSON.stringify(params),
      ),
  );
  entry.from = frames.length;
  return entry.view;
}

async function subscribe(key: string, params: ResourceParams): Promise<void> {
  const from = frames.length;
  // A union row's key is its `runKey` (the client view's default reads `id`).
  views.set(tupleKey(key, params), {
    view: makeClientView((r) => (r as { runKey: string }).runKey),
    from,
  });
  handler.message(ws, JSON.stringify({ op: "sub", key, params }));
  await until(
    () =>
      frames
        .slice(from)
        .some(
          (f) =>
            f.kind === "sub-ack" &&
            f.key === key &&
            JSON.stringify(f.params ?? {}) === JSON.stringify(params),
        ),
    () => `sub-ack ${key}`,
  );
}

/** JSON with every object's keys sorted: a frame-applied row and a fresh one list fields in different orders. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : 1,
          ),
        )
      : v,
  );
}

function comparable(key: string, value: unknown): string {
  if (key !== runs.rows.key || !Array.isArray(value)) return canonical(value);
  return canonical(
    [...(value as { runKey: string }[])].sort((x, y) =>
      x.runKey < y.runKey ? -1 : 1,
    ),
  );
}

async function converge(
  tuples: readonly { key: string; params: ResourceParams }[],
  what: string,
): Promise<void> {
  const expected = new Map<number, unknown>();
  for (const [i, t] of tuples.entries()) {
    expected.set(
      i,
      JSON.parse(JSON.stringify(await truth.get(t.key)!(t.params))),
    );
  }
  const off = () =>
    [...tuples.entries()].find(
      ([i, t]) =>
        comparable(t.key, viewOf(t.key, t.params).value) !==
        comparable(t.key, expected.get(i)),
    );
  await until(
    () => off() === undefined,
    () => {
      const [i, t] = off()!;
      return `${what}: tuple ${JSON.stringify(t)} holds ${JSON.stringify(
        viewOf(t.key, t.params).value,
      )}, a fresh load reads ${JSON.stringify(expected.get(i))}`;
    },
  );
  await quiet();
  expect(off()).toBeUndefined();
}

/** Run one statement and wait for its change to be routed. */
async function step(
  table: string,
  statement: ReturnType<typeof sql>,
): Promise<number> {
  const routedAt = routed.length;
  const loadsAt = loads.length;
  await db.execute(statement);
  await until(
    () => routed.slice(routedAt).some((c) => c.table === table),
    () => `the change to ${table} was never routed`,
  );
  return loadsAt;
}

describe("serveUnionCollection — differential oracle over two arms", () => {
  test("arm-where flips, pid writes, a server rename, retention and cascade deletes, running → finished, kind-pruned tuples, raw ids with ':' — every view converges", async () => {
    await db.execute(
      sql.raw(
        `INSERT INTO ${SRV} VALUES ('s1', 'alpha'), ('s2', 'beta');
         INSERT INTO ${A} VALUES
           ('a1', 'one',   now() - interval '9 min', now() - interval '8 min', 'failed', 1, 'here', 10),
           ('a2', 'two',   now() - interval '7 min', NULL, 'running', NULL, 'here', 11),
           ('x:y', 'colon', now() - interval '6 min', now(), 'ok', 3, 'here', 12),
           ('a9', 'other', now() - interval '1 min', NULL, 'running', 4, 'there', 13);
         INSERT INTO ${B} VALUES
           ('b1', 's1', 'web', now() - interval '5 min', now() - interval '4 min', 20),
           ('b2', 's2', 'api', now() - interval '3 min', NULL, 21),
           ('b3', 's1', 'db',  now() - interval '2 min', NULL, 22);`,
      ),
    );
    await quiet();
    for (const t of TUPLES) await subscribe(t.key, t.params);
    await converge(TUPLES, "subscribed");
    // The arm `where` holds: a9 is another namespace's.
    const first = viewOf(runs.key, TUPLES[0]!.params).value as {
      runKey: string;
    }[];
    expect(first.some((r) => r.runKey === "a:a9")).toBe(false);
    // The raw id with a `:` is one key, and the point read finds it; an
    // unknown kind is simply absent.
    const points = viewOf(runs.rows.key, TUPLES[4]!.params).value as {
      runKey: string;
    }[];
    expect(points.map((r) => r.runKey).sort()).toEqual([
      "a:a1",
      "a:x:y",
      "b:b1",
    ]);

    // pid-only writes on either arm: no route reads `pid` — nothing loads.
    for (const [table, statement] of [
      [A, sql`UPDATE ${aRuns} SET pid = pid + 1`],
      [B, sql`UPDATE ${bRuns} SET pid = pid + 1`],
    ] as const) {
      const at = await step(table, statement);
      await quiet();
      expect(loads.slice(at)).toEqual([]);
    }

    // running → finished.
    let at = await step(
      A,
      sql`UPDATE ${aRuns} SET finished_at = now(), status = 'ok' WHERE id = 'a2'`,
    );
    await converge(TUPLES, "a2 finished");
    expect(
      loads
        .slice(at)
        .filter((l) => l.key === runs.key)
        .some((l) => l.ids === "FULL"),
    ).toBe(false);

    // The arm `where` flips a row in, and out again.
    await step(A, sql`UPDATE ${aRuns} SET ns = 'here' WHERE id = 'a9'`);
    await converge(TUPLES, "a9 enters");
    await step(A, sql`UPDATE ${aRuns} SET ns = 'there' WHERE id = 'a9'`);
    await converge(TUPLES, "a9 leaves");

    // A server rename relabels exactly that server's runs (a reverse route).
    at = await step(
      SRV,
      sql`UPDATE ${servers} SET name = 'ALPHA' WHERE id = 's1'`,
    );
    await converge(TUPLES, "s1 renamed");
    const refills = loads.slice(at).filter((l) => l.key === runs.key);
    expect(refills.length).toBeGreaterThan(0);
    expect(refills.some((l) => l.ids === "FULL")).toBe(false);
    for (const l of refills) {
      for (const id of l.ids as string[])
        expect(["b:b1", "b:b3"]).toContain(id);
    }

    // A raw id with `:` moves like any other.
    await step(A, sql`UPDATE ${aRuns} SET label = 'colon2' WHERE id = 'x:y'`);
    await converge(TUPLES, "x:y relabelled");

    // Retention: a delete by age.
    await step(
      A,
      sql`DELETE FROM ${aRuns} WHERE started_at < now() - interval '8 min'`,
    );
    await converge(TUPLES, "retention delete");

    // A cascade: deleting a server deletes its runs.
    await step(B, sql`DELETE FROM ${servers} WHERE id = 's2'`);
    await converge(TUPLES, "cascade delete");

    // New runs of both kinds.
    await step(
      B,
      sql`INSERT INTO ${bRuns} VALUES ('b4', 's1', 'cdn', now(), NULL, 30)`,
    );
    await step(
      A,
      sql`INSERT INTO ${aRuns} VALUES ('a5', 'five', now(), NULL, 'running', 7, 'here', 31)`,
    );
    await converge(TUPLES, "inserts");
  }, 120_000);

  test("a server rename over the reverse cap recomputes the reading windows FULL", async () => {
    await db.execute(
      sql.raw(
        `INSERT INTO ${SRV} VALUES ('big', 'big');
         INSERT INTO ${B} (id, server_id, comp, started_at)
           SELECT 'big-' || g, 'big', 'c' || g, now() - (g || ' sec')::interval
           FROM generate_series(1, 501) g;`,
      ),
    );
    await quiet();
    const tuple = {
      key: runs.key,
      params: w.encode({ orderBy: [["label", "asc"]], limit: 10 }),
    };
    if (!views.has(tupleKey(tuple.key, tuple.params)))
      await subscribe(tuple.key, tuple.params);
    await converge([tuple], "subscribed");
    const at = await step(
      SRV,
      sql`UPDATE ${servers} SET name = 'BIG' WHERE id = 'big'`,
    );
    await until(
      () => loads.slice(at).some((l) => l.key === runs.key),
      () => "the over-cap rename reached the window",
    );
    await converge([tuple], "over-cap rename");
    expect(
      loads
        .slice(at)
        .filter((l) => l.key === runs.key)
        .map((l) => l.ids),
    ).toContain("FULL");
  }, 60_000);

  test("scroll cuts against real Postgres: every row's key splits the order at that row, and paging by `after` walks both arms with no duplicate and no gap", async () => {
    // A fresh, small set (≤ maxLimit), so one load is the whole order.
    await db.execute(
      sql.raw(
        `DELETE FROM ${A}; DELETE FROM ${SRV};
         INSERT INTO ${SRV} VALUES ('p1', 'pa'), ('p2', 'pb');
         INSERT INTO ${A} VALUES
           ('t1', 'same',  '2026-10-01 10:00:00.123456+00', NULL, 'running', 2,    'here', 1),
           ('t2', 'same',  '2026-10-01 10:00:00.123456+00', now(), 'ok',    NULL, 'here', 1),
           ('t3', 'zz',    '2026-10-01 09:00:00+00',        now(), 'ok',    2,    'here', 1),
           ('x:1', 'aa',   '2026-10-01 11:00:00+00',        NULL, 'running', NULL, 'here', 1),
           ('t5', 'mm',    '2026-10-01 08:00:00+00',        now(), 'failed', 9,   'here', 1);
         INSERT INTO ${B} VALUES
           ('u1', 'p1', 'same', '2026-10-01 10:00:00.123456+00', NULL, 1),
           ('u2', 'p2', 'same', '2026-10-01 10:00:00.123456+00', now(), 1),
           ('u3', 'p1', 'aa',   '2026-10-01 11:00:00+00', NULL, 1),
           ('u4', 'p2', 'qq',   '2026-10-01 07:00:00+00', now(), 1);`,
      ),
    );
    await quiet();
    const load = truth.get(runs.key)!;
    type R = Record<string, unknown>;
    const orders = [
      // Ties on the instant across both arms (µs precision).
      [["startedAt", "desc"]],
      [["startedAt", "asc"]],
      // An arm-only column: a NULL constant on every b row, nullable in a.
      [["a.code", "asc"]],
      [["a.code", "desc"]],
      // The discriminator (a constant per arm), then ties broken by the key.
      [
        ["kind", "desc"],
        ["label", "asc"],
      ],
    ] as const;
    let checked = 0;
    for (const orderBy of orders) {
      const query = { orderBy, columns: [aColumns], limit: 12 } as never;
      const all = (await load(w.encode(query))) as R[];
      expect(all).toHaveLength(9);
      const order = all.map((r) => r.runKey as string);
      for (let i = 0; i < all.length; i++) {
        const key = all[i]![LIVE_ROW_KEY] as string;
        const upTo = (await load(w.encode(query, { until: key }))) as R[];
        const past = (await load(w.encode(query, { after: key }))) as R[];
        expect({
          orderBy,
          at: order[i],
          upTo: upTo.map((r) => r.runKey),
        }).toEqual({
          orderBy,
          at: order[i],
          upTo: order.slice(0, i + 1),
        });
        expect({
          orderBy,
          at: order[i],
          past: past.map((r) => r.runKey),
        }).toEqual({
          orderBy,
          at: order[i],
          past: order.slice(i + 1),
        });
        checked++;
      }
      // Paged two at a time by the last row's key: the pages concatenate to
      // the one full load.
      const paged: string[] = [];
      let cut: string | undefined;
      for (;;) {
        const pageQuery = { orderBy, columns: [aColumns], limit: 2 } as never;
        const page = (await load(
          cut === undefined
            ? w.encode(pageQuery)
            : w.encode(pageQuery, { after: cut }),
        )) as R[];
        if (page.length === 0) break;
        paged.push(...page.map((r) => r.runKey as string));
        cut = page.at(-1)![LIVE_ROW_KEY] as string;
      }
      expect({ orderBy, paged }).toEqual({ orderBy, paged: order });
    }
    expect(checked).toBe(orders.length * 9);
  }, 60_000);
});
