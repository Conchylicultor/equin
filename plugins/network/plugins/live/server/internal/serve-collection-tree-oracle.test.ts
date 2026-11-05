/**
 * A tree collection (`liveCollection(key, { tree })`), on a throwaway
 * database through the REAL feed (routed triggers, LISTEN consumer,
 * `routeChange`, the server-core runtime):
 *
 * - `:ancestors` — a random workload of renames, moves (re-parenting, the
 *   old ∪ new keys of the feed), inserts, deletes (`ON DELETE SET NULL`) and
 *   `where` flips runs against subscribed seed sets; after every statement
 *   each view equals a fresh FULL load, and that load equals an independent
 *   oracle (the closure walked in JS over the whole table);
 * - a chain 24 deep is answered whole; one past `LIVE_TREE_MAX_DEPTH` and a
 *   cycle are loud loader errors;
 * - `$childCount` is a REAL materialized count (`materializeJoin` of a
 *   self-referencing children join: the table counting its own rows by
 *   parent, its `where` the collection's): inserting / deleting a child,
 *   re-parenting one (both parents recount) and a `where` flip reach the
 *   subscribed window and `:rows` views; a host with no children reads the
 *   count's `ifNone` (0);
 * - the compile refuses a tree served without `childCount`, and a count of
 *   another table or column.
 *
 * Requires a running Postgres cluster (started by ./equin build).
 * Run: `./equin test plugins/network/plugins/live`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { index, integer, pgTable, text } from "drizzle-orm/pg-core";
import { Client } from "pg";
import { nullable } from "@plugins/fields/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { routeChange } from "@plugins/network/plugins/live/plugins/change-feed/server";
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
  setWatermarkSource,
} from "@plugins/framework/plugins/server-core/core";
import { snapshotWatermark } from "@plugins/database/server/testing";
import { clearRelationBases } from "@plugins/framework/plugins/server-core/core/testing";
import {
  makeClientView,
  type ClientView,
  type RecordedFrame,
} from "@plugins/network/plugins/live/plugins/resource-runtime/core/testing";
import {
  aggregate,
  childrenJoin,
} from "@plugins/network/plugins/live/plugins/query-resource/core";
import {
  compileAncestorsQuery,
  materializeJoin,
  type QueryDb,
} from "@plugins/network/plugins/live/plugins/query-resource/server";
import { installRollups } from "@plugins/database/plugins/derived-tables/server/testing";
import { ATTEMPT_CONV_AGG_TABLE } from "@plugins/database/plugins/derived-views/core";
import { compileWindowQuery } from "@plugins/network/plugins/live/plugins/query-resource/server/testing";
import {
  LIVE_TREE_MAX_DEPTH,
  liveCollection,
} from "@plugins/network/plugins/live/core";
import { compileCollection } from "./serve-collection";

const NODES = "otr_nodes";
// A rollup's table must be an allowlisted imperative name (defineRollup
// asserts it); a throwaway database borrows one, as query-resource's
// rollup-routes tests do — its real shape is irrelevant here.
const KIDS = ATTEMPT_CONV_AGG_TABLE;

const nodes = pgTable(
  NODES,
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    parentId: text("parent_id"),
    rank: text("rank").notNull(),
    kind: text("kind").notNull(),
  },
  (t) => [index("otr_nodes_parent_rank").on(t.parentId, t.rank)],
);
const kidsTable = pgTable(KIDS, {
  parentId: text("parent_id").primaryKey(),
  count: integer("count").notNull(),
});

// The tree's child count: the table's own rows grouped by parent, the
// collection's `where` applied — materialized as a rollup keyed by the parent.
const kids = materializeJoin(
  childrenJoin({
    alias: "kids",
    table: nodes,
    fk: nodes.parentId,
    where: (c) => sql`${c.kids.kind} = 'page'`,
    aggregates: () => ({
      count: aggregate(sql`count(*)::int`, {
        decoder: Number,
        sqlType: "integer",
        notNull: true,
        ifNone: sql`0`,
      }),
    }),
  }),
  { host: nodes, table: kidsTable },
);

const tree = liveCollection("test.live.tree-oracle.nodes", {
  fields: {
    id: textField({ label: "Id" }),
    title: textField({ label: "Title" }),
    parentId: nullable(textField({ label: "Parent" })),
    rank: textField({ label: "Rank" }),
  },
  id: "id",
  sortable: ["rank", "title"],
  default: { orderBy: [["rank", "asc"]], limit: 5 },
  maxLimit: 20,
  tree: { parent: "parentId", rank: "rank" },
});

let testDb: TestDb;
let client: Client;
let db: NodePgDatabase;
let listener: ReturnType<typeof createChangeFeedListener>;
const frames: RecordedFrame[] = [];
let seq = 0;
/** Every FULL load of an `:ancestors` tuple (a sub, or a drain falling back to one). */
const fullLoads: string[] = [];
let truthAncestors: (params: ResourceParams) => Promise<unknown>;
let truthRows: (params: ResourceParams) => Promise<unknown>;
let truthWindow: (params: ResourceParams) => Promise<unknown>;

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

const served = () =>
  compileCollection(tree, {
    from: nodes,
    where: eq(nodes.kind, "page"),
    childCount: { of: kids, count: "count" },
    db: db as unknown as QueryDb,
  });

beforeAll(async () => {
  setRelationBases((r) => [r]);
  testDb = await createTestDb({ prefix: "live_tree_oracle" });
  client = new Client({ connectionString: testDb.connectionString });
  await client.connect();
  db = drizzle(client);
  setWatermarkSource(() => snapshotWatermark(db));
  await db.execute(
    sql.raw(
      `CREATE TABLE ${NODES} (id text PRIMARY KEY, title text NOT NULL,
                              parent_id text REFERENCES ${NODES}(id) ON DELETE SET NULL,
                              rank text NOT NULL, kind text NOT NULL);
       CREATE INDEX otr_nodes_parent_rank ON ${NODES} (parent_id, rank);`,
    ),
  );
  await installRollups(db, [kids.rollup]);
  const specs = served();
  const ancestors = specs.ancestors!;
  const ancestorsOpts = compileAncestorsQuery(
    tree.ancestors,
    ancestors.spec,
    ancestors.closure,
  ).serverOpts;
  const rowsOpts = compileWindowQuery(tree.rows, specs.rows).serverOpts;
  const windowOpts = compileWindowQuery(tree.window, specs.window).serverOpts;
  defineResource(tree.ancestors, {
    ...ancestorsOpts,
    loader: (p, ctx) => {
      if (ctx === undefined) fullLoads.push(JSON.stringify(p));
      return ancestorsOpts.loader(p, ctx);
    },
  });
  defineResource(tree.rows, rowsOpts);
  defineResource(tree.window, windowOpts);
  truthAncestors = async (p) => await ancestorsOpts.loader(p as never);
  truthRows = async (p) => await rowsOpts.loader(p as never);
  truthWindow = async (p) => await windowOpts.loader(p as never);
  await rebuildTriggers(
    testDb.db,
    { feedExempt: new Set(), optedOut: new Set(), produced: new Set() },
    routedTableRequirements(),
  );
  listener = createChangeFeedListener({
    connectionString: () => testDb.connectionString,
    route: (change) => routeChange(change),
    coveredTables: () => [NODES, KIDS],
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
  setWatermarkSource(null);
  handler.close(ws, 1000, "test");
  await listener?.stop();
  await client?.end();
  await testDb?.drop();
});

const views = new Map<string, { view: ClientView; from: number }>();
const tupleKey = (key: string, params: ResourceParams) =>
  `${key} ${JSON.stringify(params)}`;

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
  views.set(tupleKey(key, params), { view: makeClientView(), from });
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

const byId = (rows: unknown): string =>
  JSON.stringify(
    [...(rows as { id: string }[])].sort((a, b) => (a.id < b.id ? -1 : 1)),
  );

interface Node {
  id: string;
  parentId: string | null;
  kind: string;
}

/** The closure of `seeds` in the collection, walked in JS over every row. */
async function oracle(seeds: readonly string[]): Promise<string[]> {
  const all = (
    await db.execute(
      sql.raw(`SELECT id, parent_id AS "parentId", kind FROM ${NODES}`),
    )
  ).rows as unknown as Node[];
  const map = new Map(all.map((n) => [n.id, n]));
  const out = new Set<string>();
  for (const s of seeds) {
    let at = map.get(s);
    while (at !== undefined && at.kind === "page" && !out.has(at.id)) {
      out.add(at.id);
      at = at.parentId === null ? undefined : map.get(at.parentId);
    }
  }
  return [...out].sort();
}

async function insert(
  id: string,
  parentId: string | null,
  kind = "page",
): Promise<void> {
  await db.execute(
    sql`INSERT INTO ${nodes} (id, title, parent_id, rank, kind)
        VALUES (${id}, ${`t-${id}`}, ${parentId}, ${id}, ${kind})`,
  );
}

/** Every seed set's view equals a fresh FULL load, and that load the oracle. */
async function converge(
  seedSets: readonly (readonly string[])[],
  what: string,
): Promise<void> {
  for (const seeds of seedSets) {
    const params = tree.ancestors.point.encode(seeds);
    const fresh = (await truthAncestors(params)) as { id: string }[];
    expect([...fresh.map((r) => r.id)].sort()).toEqual(await oracle(seeds));
    await until(
      () => byId(viewOf(tree.ancestors.key, params).value) === byId(fresh),
      () =>
        `${what}: ${JSON.stringify(seeds)} holds ${JSON.stringify(
          viewOf(tree.ancestors.key, params).value,
        )}, a fresh load reads ${JSON.stringify(fresh)}`,
    );
  }
}

/** A small deterministic PRNG (mulberry32), so a failing run replays. */
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

describe("a tree collection — :ancestors and $childCount on the real feed", () => {
  test("random renames, moves, inserts, deletes and where flips: every :ancestors view converges to its closure", async () => {
    // Two roots, a chain under each, a few branches.
    await insert("r1", null);
    await insert("r2", null);
    for (let i = 1; i <= 6; i++) {
      await insert(`a${i}`, i === 1 ? "r1" : `a${i - 1}`);
      await insert(`b${i}`, i === 1 ? "r2" : `b${i - 1}`);
    }
    await insert("c1", "a3");
    await insert("c2", "c1");
    await insert("x1", "b2", "other");
    const seedSets = [["a6"], ["c2", "b4"], ["b6", "a2", "r2"], ["zz"]];
    for (const seeds of seedSets) {
      await subscribe(tree.ancestors.key, tree.ancestors.point.encode(seeds));
    }
    await converge(seedSets, "initial");
    const subsLoaded = fullLoads.length;

    const rand = prng(4242);
    const pages = () => [
      "r1",
      "r2",
      ...[1, 2, 3, 4, 5, 6].flatMap((i) => [`a${i}`, `b${i}`]),
      "c1",
      "c2",
    ];
    let fresh = 0;
    for (let step = 0; step < 120; step++) {
      const any = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
      const roll = rand();
      let what: string;
      if (roll < 0.3) {
        // A move: never under its own descendant (that would be a cycle).
        const id = any(pages());
        const to = any([...pages(), null]);
        const under = await oracle(to === null ? [] : [to]);
        if (to === id || under.includes(id)) continue;
        await db.execute(
          sql`UPDATE ${nodes} SET parent_id = ${to} WHERE id = ${id}`,
        );
        what = `move ${id} under ${to}`;
      } else if (roll < 0.5) {
        const id = any(pages());
        await db.execute(
          sql`UPDATE ${nodes} SET title = ${`t${step}`} WHERE id = ${id}`,
        );
        what = `rename ${id}`;
      } else if (roll < 0.65) {
        const id = `n${fresh++}`;
        await insert(id, any(pages()));
        what = `insert ${id}`;
      } else if (roll < 0.8) {
        const id = any(pages());
        const kind = rand() < 0.5 ? "other" : "page";
        await db.execute(
          sql`UPDATE ${nodes} SET kind = ${kind} WHERE id = ${id}`,
        );
        what = `flip ${id} to ${kind}`;
      } else {
        const id = any(pages().filter((p) => !p.startsWith("r")));
        // Settled between the two: a re-insert racing the delete's drain is
        // the runtime's torn read (one bounded FULL, by design) — not what
        // this oracle measures.
        await db.execute(sql`DELETE FROM ${nodes} WHERE id = ${id}`);
        await converge(seedSets, `step ${step} (delete ${id})`);
        await insert(id, any(["r1", "r2"]));
        what = `re-insert ${id}`;
      }
      await converge(seedSets, `step ${step} (${what})`);
    }
    // Every change was a scoped refill (+ the closure ids): no tuple was
    // ever reloaded whole.
    expect(fullLoads.length).toBe(subsLoaded);
    // Released before the next tests write: nothing drains past the suite.
    for (const seeds of seedSets) {
      const params = tree.ancestors.point.encode(seeds);
      handler.message(
        ws,
        JSON.stringify({ op: "unsub", key: tree.ancestors.key, params }),
      );
      views.delete(tupleKey(tree.ancestors.key, params));
    }
  }, 120_000);

  test("a chain 24 deep is answered whole; past the depth bound and a cycle are loud", async () => {
    await insert("d0", null);
    for (let i = 1; i <= 24; i++) await insert(`d${i}`, `d${i - 1}`);
    const deep = (await truthAncestors(
      tree.ancestors.point.encode(["d24"]),
    )) as { id: string }[];
    expect(deep.map((r) => r.id).sort()).toEqual(
      Array.from({ length: 25 }, (_, i) => `d${i}`).sort(),
    );
    for (let i = 25; i <= LIVE_TREE_MAX_DEPTH + 1; i++) {
      await insert(`d${i}`, `d${i - 1}`);
    }
    expect(
      truthAncestors(
        tree.ancestors.point.encode([`d${LIVE_TREE_MAX_DEPTH + 1}`]),
      ),
    ).rejects.toThrow(/reaches 64 levels/);
    await insert("y1", null);
    await insert("y2", "y1");
    await db.execute(sql`UPDATE ${nodes} SET parent_id = 'y2' WHERE id = 'y1'`);
    expect(truthAncestors(tree.ancestors.point.encode(["y2"]))).rejects.toThrow(
      /is a cycle/,
    );
  });

  test("$childCount: a child inserted, deleted, re-parented or flipped out of the `where` recounts its parents on the window and on :rows", async () => {
    await insert("kp1", null);
    await insert("kp2", null);
    await insert("kc1", "kp1");
    const winParams = tree.window.window.encode({
      where: { id: { in: ["kp1", "kp2"] } },
    });
    const rowsParams = tree.rows.point.encode(["kp1", "kp2"]);
    await subscribe(tree.key, winParams);
    await subscribe(tree.rows.key, rowsParams);
    const counts = (rows: unknown) =>
      Object.fromEntries(
        (rows as { id: string; $childCount: number }[]).map((r) => [
          r.id,
          r.$childCount,
        ]),
      );
    const expectCounts = async (
      want: Record<string, number>,
      what: string,
    ): Promise<void> => {
      // A fresh load reads the stored count …
      expect(counts(await truthWindow(winParams))).toEqual(want);
      expect(counts(await truthRows(rowsParams))).toEqual(want);
      // … and both views were told.
      for (const [key, params] of [
        [tree.key, winParams],
        [tree.rows.key, rowsParams],
      ] as const) {
        await until(
          () =>
            JSON.stringify(counts(viewOf(key, params).value)) ===
            JSON.stringify(want),
          () =>
            `${what}: ${key} holds ${JSON.stringify(counts(viewOf(key, params).value))}, want ${JSON.stringify(want)}`,
        );
      }
    };
    await expectCounts({ kp1: 1, kp2: 0 }, "initial");
    await insert("kc2", "kp2");
    await expectCounts({ kp1: 1, kp2: 1 }, "insert kc2 under kp2");
    await db.execute(
      sql`UPDATE ${nodes} SET parent_id = 'kp2' WHERE id = 'kc1'`,
    );
    await expectCounts({ kp1: 0, kp2: 2 }, "re-parent kc1 kp1 → kp2");
    await db.execute(sql`DELETE FROM ${nodes} WHERE id = 'kc2'`);
    await expectCounts({ kp1: 0, kp2: 1 }, "delete kc2");
    await db.execute(sql`UPDATE ${nodes} SET kind = 'other' WHERE id = 'kc1'`);
    await expectCounts({ kp1: 0, kp2: 0 }, "kc1 leaves the `where`");
    await db.execute(
      sql`UPDATE ${nodes} SET kind = 'page', parent_id = 'kp1' WHERE id = 'kc1'`,
    );
    await expectCounts({ kp1: 1, kp2: 0 }, "kc1 back, under kp1");
    expect(
      tree.row.safeParse(((await truthRows(rowsParams)) as unknown[])[0])
        .success,
    ).toBe(true);
    for (const [key, params] of [
      [tree.key, winParams],
      [tree.rows.key, rowsParams],
    ] as const) {
      handler.message(ws, JSON.stringify({ op: "unsub", key, params }));
      views.delete(tupleKey(key, params));
    }
  });

  test("the compile refuses a tree without its count, a count of another tree, a count that is no integer", () => {
    const base = {
      from: nodes,
      where: eq(nodes.kind, "page"),
      db: db as unknown as QueryDb,
    };
    expect(() => compileCollection(tree, base as never)).toThrow(
      /pass `childCount: \{ of, count \}`/,
    );
    const counting = (source: object) => ({ ...kids, source, join: kids.join });
    expect(() =>
      compileCollection(tree, {
        ...base,
        childCount: {
          of: counting({ kind: "children", table: nodes, fk: nodes.rank }),
          count: "count",
        },
      } as never),
    ).toThrow(/counts children by "rank"/);
    expect(() =>
      compileCollection(tree, {
        ...base,
        childCount: {
          of: counting({
            kind: "children",
            table: kidsTable,
            fk: kidsTable.parentId,
          }),
          count: "count",
        },
      } as never),
    ).toThrow(/counts rows of "attempt_conv_agg"/);
    expect(() =>
      compileCollection(tree, {
        ...base,
        childCount: { of: kids, count: "parentId" },
      }),
    ).toThrow(/is the host key/);
  });
});
