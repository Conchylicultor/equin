/**
 * The closure property test (A23 of
 * research/2026-10-01-global-scoped-change-routing-p5-p8-v2.md; P8 v3 step
 * 16b.5): 200 random statements over a small CYCLIC dependency graph, against
 * a throwaway database. After every statement:
 *
 * - **Full is right.** The compiled whole set equals an oracle computed in JS
 *   from the raw rows — every node's transitive ancestors (cycles included:
 *   a node in a cycle is its own ancestor), and the aggregates over them.
 * - **The routes reach every moved host.** Each row the statement wrote (read
 *   back from a row-level change log, so FK cascades count) is routed the way
 *   the runtime routes it: through each route on its table whose `columns`
 *   gate the write touches — `identity` / `alias` by its key values, `reverse`
 *   by `resolve`, `full` to everything. Every host whose value changed must be
 *   among them (a missed one is a silently stale row).
 * - **Scoped ≡ Full ∩ S.** The scoped refill of the routed hosts equals the
 *   full value restricted to them (a deleted or filtered host simply absent).
 *
 * Requires a running Postgres cluster (started by ./equin build).
 * Run: `./equin test plugins/infra/plugins/query-resource`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import {
  aggregate,
  childrenJoin,
  closureJoin,
  jsonAgg,
  type AllQueryResourceContract,
  type PointQueryResourceContract,
} from "@plugins/infra/plugins/query-resource/core";
import {
  compileAllCollection,
  type CompiledAllCollection,
} from "./compile-alias";
import type { QueryDb } from "./spec";

const nodes = pgTable("c_nodes", {
  id: text("id").primaryKey(),
  flag: boolean("flag").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  note: text("note"),
});
const edges = pgTable(
  "c_edges",
  {
    child: text("child").notNull(),
    parent: text("parent").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.child, t.parent] }),
    index("c_edges_parent_idx").on(t.parent),
  ],
);
const items = pgTable(
  "c_items",
  {
    id: text("id").primaryKey(),
    nodeId: text("node_id").notNull(),
    done: boolean("done").notNull(),
  },
  (t) => [index("c_items_node_id_idx").on(t.nodeId)],
);

const ancItems = childrenJoin({
  alias: "items",
  table: items,
  fk: items.nodeId,
  aggregates: (c) => ({
    allDone: aggregate(sql`bool_and(${c.items.done})`, {
      decoder: Boolean,
      sqlType: "boolean",
      notNull: true,
      ifNone: sql`true`,
    }),
  }),
});
const up = closureJoin({
  alias: "up",
  edges,
  child: edges.child,
  parent: edges.parent,
  nodes,
  ancestorJoins: [ancItems],
  aggregates: (c) => ({
    blocked: aggregate(
      sql`bool_or(NOT ${c.anc.flag} AND NOT ${c.items.allDone})`,
      {
        decoder: Boolean,
        sqlType: "boolean",
        notNull: true,
        ifNone: sql`false`,
      },
    ),
    ancestors: jsonAgg({ id: c.anc.id }, { orderBy: [[c.anc.id, "asc"]] }),
  }),
});
const own = childrenJoin({
  alias: "own",
  table: items,
  fk: items.nodeId,
  aggregates: (c) => ({
    n: aggregate(sql`count(${c.own.id})::integer`, {
      decoder: Number,
      sqlType: "integer",
      notNull: true,
      ifNone: sql`0`,
    }),
  }),
});

interface NodeRow {
  id: string;
  flag: boolean;
  createdAt: Date;
  blocked: boolean;
  ancestors: { id: string }[];
  n: number;
}

const CONTRACTS = {
  all: {
    key: "closure-prop",
    schema: z.array(z.unknown()),
    keyed: { keyOf: (r: unknown) => (r as NodeRow).id },
    all: {
      orderBy: [["createdAt", "desc"]],
      unbounded: { reason: "a test graph" },
    },
    queryPk: "id",
  } as unknown as AllQueryResourceContract<NodeRow>,
  rows: {
    key: "closure-prop:rows",
    queryPk: "id",
    point: {
      decode: (p: Record<string, string>) => (p.ids ? p.ids.split(",") : []),
      encode: (ids: readonly string[]) => ({ ids: [...ids].join(",") }),
    },
  } as unknown as PointQueryResourceContract<NodeRow>,
};

let t: TestDb;
let compiled: CompiledAllCollection<NodeRow>;

beforeAll(async () => {
  t = await createTestDb({ prefix: "all_closure" });
  for (const ddl of [
    `CREATE TABLE c_nodes (id text PRIMARY KEY, flag boolean NOT NULL, created_at timestamptz NOT NULL, note text)`,
    `CREATE TABLE c_edges (child text NOT NULL REFERENCES c_nodes(id) ON DELETE CASCADE, parent text NOT NULL REFERENCES c_nodes(id) ON DELETE CASCADE, PRIMARY KEY (child, parent))`,
    `CREATE INDEX c_edges_parent_idx ON c_edges (parent)`,
    `CREATE TABLE c_items (id text PRIMARY KEY, node_id text NOT NULL REFERENCES c_nodes(id) ON DELETE CASCADE, done boolean NOT NULL)`,
    `CREATE INDEX c_items_node_id_idx ON c_items (node_id)`,
    // The change log: every row written, cascades included.
    `CREATE TABLE c_log (seq bigserial PRIMARY KEY, tbl text NOT NULL, op text NOT NULL, old jsonb, new jsonb)`,
    `CREATE FUNCTION c_log() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         INSERT INTO c_log (tbl, op, old, new) VALUES (TG_TABLE_NAME, TG_OP,
           CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
           CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END);
         RETURN NULL;
       END $$`,
    ...["c_nodes", "c_edges", "c_items"].map(
      (tbl) =>
        `CREATE TRIGGER ${tbl}_log AFTER INSERT OR UPDATE OR DELETE ON ${tbl} FOR EACH ROW EXECUTE FUNCTION c_log()`,
    ),
  ]) {
    await t.db.execute(sql.raw(ddl));
  }
  compiled = compileAllCollection(CONTRACTS, {
    from: nodes,
    joins: [up, own],
    select: ({ j, render, aggregate: agg }) => ({
      id: render(j.base.id),
      flag: render(j.base.flag),
      createdAt: render(j.base.createdAt),
      blocked: agg(j.up.blocked),
      ancestors: agg(j.up.ancestors),
      n: agg(j.own.n),
    }),
    db: t.db as unknown as QueryDb,
  });
});

afterAll(async () => {
  await t?.drop();
});

// ── The oracle ───────────────────────────────────────────────────────────────

interface Graph {
  nodes: Map<string, { flag: boolean; createdAt: Date }>;
  edges: [string, string][];
  items: Map<string, { nodeId: string; done: boolean }>;
}

async function readGraph(): Promise<Graph> {
  const n = await executeRows(t.db, {
    query: sql`SELECT id, flag, created_at::text AS created_at FROM c_nodes`,
    row: z.object({
      id: z.string(),
      flag: z.boolean(),
      created_at: z.string(),
    }),
    label: "oracle:nodes",
  });
  const e = await executeRows(t.db, {
    query: sql`SELECT child, parent FROM c_edges`,
    row: z.object({ child: z.string(), parent: z.string() }),
    label: "oracle:edges",
  });
  const i = await executeRows(t.db, {
    query: sql`SELECT id, node_id, done FROM c_items`,
    row: z.object({ id: z.string(), node_id: z.string(), done: z.boolean() }),
    label: "oracle:items",
  });
  return {
    nodes: new Map(
      n.map((r) => [r.id, { flag: r.flag, createdAt: new Date(r.created_at) }]),
    ),
    edges: e.map((r) => [r.child, r.parent]),
    items: new Map(i.map((r) => [r.id, { nodeId: r.node_id, done: r.done }])),
  };
}

function expected(g: Graph): NodeRow[] {
  const parents = new Map<string, string[]>();
  for (const [c, p] of g.edges) {
    parents.set(c, [...(parents.get(c) ?? []), p]);
  }
  const ancestorsOf = (id: string): Set<string> => {
    const out = new Set<string>();
    const stack = [...(parents.get(id) ?? [])];
    while (stack.length > 0) {
      const a = stack.pop()!;
      if (out.has(a)) continue;
      out.add(a);
      stack.push(...(parents.get(a) ?? []));
    }
    return out;
  };
  const itemsOf = (id: string) =>
    [...g.items.values()].filter((i) => i.nodeId === id);
  const rows = [...g.nodes].map(([id, node]): NodeRow => {
    const anc = [...ancestorsOf(id)].sort();
    return {
      id,
      flag: node.flag,
      createdAt: node.createdAt,
      blocked: anc.some(
        (a) => !g.nodes.get(a)!.flag && !itemsOf(a).every((i) => i.done),
      ),
      ancestors: anc.map((a) => ({ id: a })),
      n: itemsOf(id).length,
    };
  });
  return rows.sort(
    (a, b) =>
      b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? -1 : 1),
  );
}

// ── Routing, as the runtime does it ──────────────────────────────────────────

interface Change {
  tbl: string;
  op: string;
  old: Record<string, unknown> | null;
  new: Record<string, unknown> | null;
}

async function drainLog(): Promise<Change[]> {
  const rows = await executeRows(t.db, {
    query: sql`DELETE FROM c_log RETURNING seq, tbl, op, old, new`,
    row: z.object({
      seq: z.coerce.number(),
      tbl: z.string(),
      op: z.string(),
      old: z.record(z.string(), z.unknown()).nullable(),
      new: z.record(z.string(), z.unknown()).nullable(),
    }),
    label: "log",
  });
  return rows.sort((a, b) => a.seq - b.seq);
}

const PK: Record<string, string> = { c_nodes: "id", c_items: "id" };

async function routed(
  changes: readonly Change[],
): Promise<Set<string> | "all"> {
  const out = new Set<string>();
  for (const route of compiled.all.routes!.routes) {
    const mine = changes.filter((c) => c.tbl === route.table);
    // The `unchanged` gate: an UPDATE touching none of the route's columns
    // does not reach it.
    const gated = mine.filter(
      (c) =>
        c.op !== "UPDATE" ||
        route.columns.some(
          (col) => JSON.stringify(c.old![col]) !== JSON.stringify(c.new![col]),
        ),
    );
    if (gated.length === 0) continue;
    const map = route.map;
    if (map.kind === "full") return "all";
    const column = "column" in map ? map.column : undefined;
    const keyCol = column ?? PK[route.table];
    if (keyCol === undefined) {
      throw new Error(
        `route "${route.id}" on a composite-keyed table names no column`,
      );
    }
    const values = [
      ...new Set(
        gated.flatMap((c) =>
          [c.old?.[keyCol], c.new?.[keyCol]].filter(
            (v): v is string => typeof v === "string",
          ),
        ),
      ),
    ];
    if (map.kind === "reverse") {
      const hosts = await map.resolve(values, null, 10_000);
      if (hosts === "over-cap") return "all";
      for (const h of hosts) out.add(h);
    } else {
      for (const v of values) out.add(v);
    }
  }
  return out;
}

// ── The walk ─────────────────────────────────────────────────────────────────

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("the closure property (A23)", () => {
  test("200 random statements over a cyclic graph: full right, routes complete, scoped ≡ full ∩ S", async () => {
    const rand = prng(23);
    const pick = <T>(xs: readonly T[]): T =>
      xs[Math.floor(rand() * xs.length)]!;
    const ids = Array.from({ length: 12 }, (_, i) => `n${i}`);
    for (const [i, id] of ids.slice(0, 8).entries()) {
      await t.db.execute(
        sql`INSERT INTO c_nodes (id, flag, created_at) VALUES (${id}, ${i % 3 === 0}, ${`2026-01-01T00:00:${String(i).padStart(2, "0")}Z`}::timestamptz)`,
      );
    }
    await drainLog();
    let item = 0;
    let before = expected(await readGraph());
    let cyclesSeen = 0;
    let routedFull = 0;
    for (let step = 0; step < 200; step++) {
      const g = await readGraph();
      const present = [...g.nodes.keys()];
      const r = rand();
      if (r < 0.25 && present.length >= 2) {
        const c = pick(present);
        const p = pick(present);
        await t.db.execute(
          sql`INSERT INTO c_edges (child, parent) VALUES (${c}, ${p}) ON CONFLICT DO NOTHING`,
        );
      } else if (r < 0.4 && g.edges.length > 0) {
        const [c, p] = pick(g.edges);
        await t.db.execute(
          sql`DELETE FROM c_edges WHERE child = ${c} AND parent = ${p}`,
        );
      } else if (r < 0.5 && present.length > 0) {
        await t.db.execute(
          sql`UPDATE c_nodes SET flag = NOT flag WHERE id = ${pick(present)}`,
        );
      } else if (r < 0.55 && present.length > 0) {
        // A column nothing reads: routes nowhere, moves nothing.
        await t.db.execute(
          sql`UPDATE c_nodes SET note = ${`s${step}`} WHERE id = ${pick(present)}`,
        );
      } else if (r < 0.7 && present.length > 0) {
        await t.db.execute(
          sql`INSERT INTO c_items (id, node_id, done) VALUES (${`i${item++}`}, ${pick(present)}, ${rand() < 0.5})`,
        );
      } else if (r < 0.8 && g.items.size > 0) {
        await t.db.execute(
          sql`UPDATE c_items SET done = NOT done WHERE id = ${pick([...g.items.keys()])}`,
        );
      } else if (r < 0.85 && g.items.size > 0 && present.length > 0) {
        await t.db.execute(
          sql`UPDATE c_items SET node_id = ${pick(present)} WHERE id = ${pick([...g.items.keys()])}`,
        );
      } else if (r < 0.9 && g.items.size > 0) {
        await t.db.execute(
          sql`DELETE FROM c_items WHERE id = ${pick([...g.items.keys()])}`,
        );
      } else if (r < 0.95) {
        const missing = ids.filter((id) => !g.nodes.has(id));
        if (missing.length > 0) {
          await t.db.execute(
            sql`INSERT INTO c_nodes (id, flag, created_at) VALUES (${pick(missing)}, ${rand() < 0.5}, ${`2026-02-01T00:00:${String(step % 60).padStart(2, "0")}Z`}::timestamptz)`,
          );
        }
      } else if (present.length > 3) {
        // Cascades to its edges and items.
        await t.db.execute(
          sql`DELETE FROM c_nodes WHERE id = ${pick(present)}`,
        );
      }
      const changes = await drainLog();
      const after = expected(await readGraph());
      if (after.some((row) => row.ancestors.some((a) => a.id === row.id))) {
        cyclesSeen++;
      }

      // Full is right.
      const full = (await compiled.all.loader({})) as NodeRow[];
      expect({ step, full }).toEqual({ step, full: after });

      // Every moved host is routed.
      const prev = new Map(before.map((row) => [row.id, JSON.stringify(row)]));
      const next = new Map(after.map((row) => [row.id, JSON.stringify(row)]));
      const moved = new Set<string>();
      for (const id of new Set([...prev.keys(), ...next.keys()])) {
        if (prev.get(id) !== next.get(id)) moved.add(id);
      }
      const reached = await routed(changes);
      if (reached === "all") routedFull++;
      else {
        const missed = [...moved].filter((id) => !reached.has(id));
        expect({ step, changes, missed }).toEqual({
          step,
          changes,
          missed: [],
        });
      }

      // Scoped ≡ Full ∩ S over what was routed.
      const s = reached === "all" ? [...next.keys()] : [...reached];
      if (s.length > 0) {
        const scoped = (await compiled.all.loader(
          {},
          { affectedIds: s },
        )) as NodeRow[];
        const want = after.filter((row) => s.includes(row.id));
        const byId = (a: NodeRow, b: NodeRow) => (a.id < b.id ? -1 : 1);
        expect({ step, scoped: [...scoped].sort(byId) }).toEqual({
          step,
          scoped: [...want].sort(byId),
        });
        const point = (await compiled.rows.loader({
          ids: s.join(","),
        })) as NodeRow[];
        expect({ step, point: [...point].sort(byId) }).toEqual({
          step,
          point: [...want].sort(byId),
        });
      }
      before = after;
    }
    // The walk exercised cycles, and no route degraded to a FULL.
    expect(cyclesSeen).toBeGreaterThan(0);
    expect(routedFull).toBe(0);
  }, 300_000);
});
