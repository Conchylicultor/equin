/**
 * Differential oracle for a collection over N:1 LOOKUPS and a keyed side table
 * (Verification §3 of research/2026-09-29-global-scoped-change-routing.md —
 * the lookup, keyed-side and self-join cases, P4), on a throwaway database
 * through the REAL feed: the change-feed's routed triggers (old ∪ new keys,
 * the `unchanged` gate), its LISTEN consumer, `routeChange`, and the
 * server-core runtime resolving each lookup's REVERSE route in the drain.
 *
 * The collection is the events list's shape, plus a self-join and a keyed side:
 *
 * - `items` (the host) joins its `source` — a REQUIRED lookup (INNER), whose
 *   `enabled` is a DEFAULT scope the tuple drops when its filter names `srcId`;
 * - its `parent` — a LEFT lookup on the host table itself (a self-join: an
 *   identity and a reverse route on one table);
 * - its `note` — a keyed side table (`view_id = 'v'`, `col = 'c1'`).
 *
 * A random workload of host, source and note writes (inserts, updates, key
 * moves, deletes, FK cascades, multi-row statements, primary-key changes of a
 * host and of a source — the latter cascading onto its items — and bulk
 * statements over the NOTIFY cap) runs interleaved with subscribes and
 * unsubscribes. After every statement:
 *
 * - every subscribed tuple's client view equals a fresh FULL load of it;
 * - every scoped refill names only hosts the statement could have changed —
 *   the host itself, the hosts referencing a changed source, the children of a
 *   changed item — or a row the tuple now holds (a window backfill): O(changed);
 * - no subscribed window or point tuple is ever reloaded FULL (every write here
 *   is under the reverse cap), except after a statement over the NOTIFY cap
 *   (its ids and keys dropped — the bounded FULL is the specified outcome);
 * - a write to a column no route reads (a source's `status`, an item's
 *   `touched` — even over the NOTIFY cap, where only `unchanged` survives), to
 *   another member of the keyed side (`c2`) or to another surface's rows
 *   (`w`) loads nothing at all.
 *
 * A second test drives the cap: an `enabled` flip over more than 500 hosts
 * recomputes the reading windows FULL (bounded), one under it refills exactly
 * the source's hosts.
 *
 * Requires a running Postgres cluster (started by ./singularity build);
 * createTestDb() throws loudly when it is unreachable.
 * Run: `./singularity test plugins/network/plugins/live`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  boolean,
  integer,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";
import { Client } from "pg";
import { nullable } from "@plugins/fields/core";
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
  installedLayouts,
  readInstalledTriggers,
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
  type KeyedSideJoin,
  type LookupJoin,
} from "@plugins/infra/plugins/query-resource/core";
import type { QueryDb } from "@plugins/infra/plugins/query-resource/server";
import { compileWindowQuery } from "@plugins/infra/plugins/query-resource/server/testing";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { compileCollection } from "./serve-collection";

const HOST = "olk_items";
const SRC = "olk_sources";
const NOTES = "olk_notes";

const sources = pgTable(SRC, {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  enabled: boolean("enabled").notNull(),
  status: text("status").notNull(),
});
const items = pgTable(HOST, {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  n: integer("n").notNull(),
  srcId: text("src_id").notNull(),
  parentId: text("parent_id"),
});
const notes = pgTable(
  NOTES,
  {
    viewId: text("view_id").notNull(),
    rowKey: text("row_key").notNull(),
    col: text("col").notNull(),
    value: text("value"),
  },
  (t) => [primaryKey({ columns: [t.viewId, t.rowKey, t.col] })],
);

const sourceJoin: LookupJoin<"source", typeof sources> = {
  kind: "lookup",
  alias: "source",
  table: sources,
  pk: sources.id,
  on: { from: "base", col: items.srcId },
  required: true,
};
const parentJoin: LookupJoin<"parent", typeof items> = {
  kind: "lookup",
  alias: "parent",
  table: items,
  pk: items.id,
  on: { from: "base", col: items.parentId },
  required: false,
};
const noteJoin: KeyedSideJoin<"note", typeof notes> = {
  kind: "keyed-side",
  alias: "note",
  table: notes,
  selectors: [
    { col: notes.viewId, value: "v" },
    { col: notes.col, value: "c1" },
  ],
  hostKey: notes.rowKey,
};

const itemsCollection = liveCollection("test.live.lookup-oracle.items", {
  fields: {
    id: textField({ label: "Id", filterable: false }),
    title: textField({ label: "Title", filterable: false }),
    n: intField({ label: "N" }),
    srcId: textField({ label: "Source id" }),
    srcLabel: textField({ label: "Source label" }),
    parentTitle: nullable(textField({ label: "Parent title" })),
    note: nullable(textField({ label: "Note" })),
  },
  id: "id",
  sortable: ["n", "title", "srcLabel"],
  default: { orderBy: [["n", "asc"]], limit: 4 },
  maxLimit: 20,
});

// An EXPRESSION over the lookup (step 10 of
// research/2026-10-01-global-scoped-change-routing-p5-p8-v2.md): `tag` reads
// the source's label through its reverse route, and the host's title through
// its identity route — a label rename refills exactly the source's items.
const tagCollection = liveCollection("test.live.lookup-oracle.tags", {
  fields: {
    id: textField({ label: "Id", filterable: false }),
    tag: textField({ label: "Tag" }),
    n: intField({ label: "N", filterable: false }),
  },
  id: "id",
  sortable: ["tag", "n"],
  default: { orderBy: [["n", "asc"]], limit: 4 },
  maxLimit: 20,
});

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

/** The unwrapped loaders, for the oracle's fresh FULL loads. */
const truth = new Map<
  string,
  (params: ResourceParams) => Promise<unknown> | unknown
>();

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

/** Wait until no loader has run and no frame arrived for a while. */
async function quiet(): Promise<void> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const at = [loads.length, frames.length];
    await new Promise((r) => setTimeout(r, 120));
    if (loads.length === at[0] && frames.length === at[1]) return;
    if (Date.now() > deadline) throw new Error("the runtime never went quiet");
  }
}

const tupleKey = (key: string, params: ResourceParams) =>
  `${key} ${JSON.stringify(params)}`;

/** Wait (bounded) for a condition the async feed and loaders make true. */
async function until(cond: () => boolean, what: () => string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what()}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeAll(async () => {
  // What change-feed's boot installs before its listener starts (D34). This
  // suite reaches only routed entries, but the legacy router runs on every
  // change too, over whatever legacy read-sets other suites in this bun
  // process left: with no bases set it would report on each one. No views
  // matter here, so every relation is its own base.
  setRelationBases((r) => [r]);
  testDb = await createTestDb({ prefix: "live_lookup_oracle" });
  client = new Client({ connectionString: testDb.connectionString });
  await client.connect();
  db = drizzle(client);
  await db.execute(
    sql.raw(
      `CREATE TABLE ${SRC} (id text PRIMARY KEY, label text NOT NULL,
                            enabled boolean NOT NULL, status text NOT NULL);
       CREATE TABLE ${HOST} (id text PRIMARY KEY, title text NOT NULL, n integer NOT NULL,
                             src_id text NOT NULL REFERENCES ${SRC}(id)
                               ON DELETE CASCADE ON UPDATE CASCADE,
                             parent_id text,
                             touched integer NOT NULL DEFAULT 0);
       CREATE INDEX ON ${HOST} (src_id);
       CREATE INDEX ON ${HOST} (parent_id);
       CREATE TABLE ${NOTES} (view_id text NOT NULL, row_key text NOT NULL,
                              col text NOT NULL, value text,
                              PRIMARY KEY (view_id, row_key, col));`,
    ),
  );
  const specs = compileCollection(itemsCollection, {
    from: items,
    joins: [sourceJoin, parentJoin, noteJoin],
    columns: {
      srcLabel: (j) => j.source.label,
      parentTitle: (j) => j.parent.title,
      note: (j) => j.note.value,
    },
    defaults: [{ unless: "srcId", where: (j) => eq(j.source.enabled, true) }],
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
  const windowOpts = compileWindowQuery(
    itemsCollection.window,
    specs.window,
  ).serverOpts;
  const rowsOpts = compileWindowQuery(
    itemsCollection.rows,
    specs.rows,
  ).serverOpts;
  defineResource(itemsCollection.window, {
    ...windowOpts,
    loader: record(itemsCollection.key, windowOpts.loader),
  });
  defineResource(itemsCollection.rows, {
    ...rowsOpts,
    loader: record(itemsCollection.rows.key, rowsOpts.loader),
  });
  defineResource(itemsCollection.groups, {
    ...specs.groups,
    loader: record(itemsCollection.groups.key, specs.groups.loader),
  });
  const tagSpecs = compileCollection(tagCollection, {
    from: items,
    joins: [sourceJoin],
    columns: {
      tag: (j) =>
        expr(sql`${j.source.label} || '/' || ${j.base.title}`, {
          decoder: String,
          sqlType: "text",
          notNull: true,
        }),
    },
    db: db as unknown as QueryDb,
  });
  const tagWindow = compileWindowQuery(
    tagCollection.window,
    tagSpecs.window,
  ).serverOpts;
  defineResource(tagCollection.window, {
    ...tagWindow,
    loader: record(tagCollection.key, tagWindow.loader),
  });
  truth.set(tagCollection.key, (p) => tagWindow.loader(p as never));
  truth.set(itemsCollection.key, (p) => windowOpts.loader(p as never));
  truth.set(itemsCollection.rows.key, (p) => rowsOpts.loader(p as never));
  truth.set(itemsCollection.groups.key, (p) => specs.groups.loader(p as never));
  // The feed, installed from the routes just registered: every table gets the
  // routed trigger, `olk_sources` gated (its routes read id, label, enabled —
  // never status), `olk_items` too (no route reads `touched`, a column the
  // drizzle table does not even declare).
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
    coveredTables: () => [HOST, SRC, NOTES],
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

// ── Tuples ──────────────────────────────────────────────────────────────────

const w = itemsCollection.window.window;
const g = itemsCollection.groups.groups;
const TUPLES: Array<{ key: string; params: ResourceParams }> = [
  // The default: the source is membership (required, and the enabled default),
  // the parent and the note projected only (value).
  { key: itemsCollection.key, params: w.encode() },
  // Naming the source drops the enabled default: a disabled source's items
  // show, and its enabled flip cannot move this tuple.
  {
    key: itemsCollection.key,
    params: w.encode({ where: { srcId: { in: ["a", "b"] } }, limit: 6 }),
  },
  // Sorted by the looked-up label: a label edit reorders.
  {
    key: itemsCollection.key,
    params: w.encode({ orderBy: [["srcLabel", "asc"]], limit: 5 }),
  },
  // Filtered through the self-join and the keyed side (membership).
  {
    key: itemsCollection.key,
    params: w.encode({ where: { parentTitle: { contains: "1" } }, limit: 8 }),
  },
  { key: itemsCollection.key, params: w.encode({ where: { note: "x" } }) },
  {
    key: itemsCollection.rows.key,
    params: itemsCollection.rows.point.encode(["i1", "i2", "i3"]),
  },
  { key: itemsCollection.groups.key, params: g.encode({ groupBy: "n" }) },
  { key: itemsCollection.groups.key, params: g.encode({ groupBy: "note" }) },
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

function unsubscribe(key: string, params: ResourceParams): void {
  handler.message(ws, JSON.stringify({ op: "unsub", key, params }));
  views.delete(tupleKey(key, params));
}

/**
 * A tuple's value as compared: a point set is unordered (an entrant appends,
 * a fresh load reads in whatever order the database answers), so by id.
 */
function comparable(key: string, value: unknown): string {
  if (key !== itemsCollection.rows.key || !Array.isArray(value)) {
    return JSON.stringify(value);
  }
  return JSON.stringify(
    [...(value as { id: string }[])].sort((a, b) => (a.id < b.id ? -1 : 1)),
  );
}

/** Every subscribed view equals a fresh FULL load of its tuple. */
async function converge(
  tuples: readonly { key: string; params: ResourceParams }[],
  what: string,
): Promise<Map<number, unknown>> {
  const expected = new Map<number, unknown>();
  for (const [i, t] of tuples.entries()) {
    expected.set(i, await truth.get(t.key)!(t.params));
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
  return expected;
}

// ── The workload ────────────────────────────────────────────────────────────

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

interface Step {
  what: string;
  /**
   * One statement over the NOTIFY cap: its ids and keys are dropped, so its
   * readers recompute FULL (bounded) — checked to have really gone over.
   */
  overCap?: boolean;
  /** A write to a looked-up row — reaching hosts only through a reverse route. */
  reverse?: boolean;
  run: () => Promise<void>;
  /** The host ids the statement may change (its refills' bound). */
  hosts: () => readonly string[];
  /** The tables whose NOTIFY must have been routed before the step settles. */
  tables: readonly string[];
  /** The statement changes nothing any tuple reads: no load at all. */
  inert?: boolean;
}

describe("serveCollection over lookups, a self-join and a keyed side — differential oracle", () => {
  test("reverse routes on a PK carry no key (A17): the derived layout and the installed triggers both carry [] for the looked-up tables", async () => {
    // `source` and `parent` look up by their table's own PK, so their changed
    // values are the feed's `ids` — no `column`, nothing carried. (`items` is
    // also the identity table, which reads `ids` too.) The keyed side still
    // carries its selectors and host key.
    const required = new Map(
      routedTableRequirements().map((r) => [r.table, r.carry]),
    );
    expect(required.get(SRC)).toEqual([]);
    expect(required.get(HOST)).toEqual([]);
    expect(required.get(NOTES)).toEqual(["col", "row_key", "view_id"]);
    const installed = installedLayouts(
      await readInstalledTriggers(testDb.db, [SRC, HOST]),
    );
    for (const table of [SRC, HOST]) {
      const layout = installed.get(table)!;
      expect(layout.pk).toBe("id");
      expect([...layout.triggers.values()]).toEqual([
        { pk: "id", carry: [] },
        { pk: "id", carry: [] },
        { pk: "id", carry: [] },
      ]);
    }
  });

  test("random host / source / note writes: every view converges, refills stay O(changed), unread columns reach nothing", async () => {
    const rand = prng(7171);
    const any = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
    const itemIds = ["i1", "i2", "i3", "i4", "i5", "i6", "i7", "i8", "i9"];
    // `d` starts absent: a source's primary key moves onto it.
    const sourceIds = ["a", "b", "c", "d"];
    // The model the refill bounds are computed from: item → its source and parent.
    const model = new Map<string, { src: string; parent: string | null }>();
    const live = new Set<string>();

    for (const s of sourceIds.slice(0, 3)) {
      await db.execute(
        sql`INSERT INTO ${sources} (id, label, enabled, status) VALUES (${s}, ${`L-${s}`}, ${s !== "c"}, 'idle')`,
      );
      live.add(s);
    }
    for (const [k, id] of itemIds.slice(0, 6).entries()) {
      const src = sourceIds[k % 3]!;
      const parent = k > 0 && rand() < 0.5 ? itemIds[k - 1]! : null;
      await db.execute(
        sql`INSERT INTO ${items} (id, title, n, src_id, parent_id) VALUES (${id}, ${`t${k}`}, ${Math.floor(rand() * 10)}, ${src}, ${parent})`,
      );
      model.set(id, { src, parent });
    }
    await db.execute(
      sql`INSERT INTO ${notes} (view_id, row_key, col, value) VALUES ('v', 'i1', 'c1', 'x'), ('v', 'i2', 'c1', 'y')`,
    );
    // Fillers under a disabled source no step picks: long ids, so a statement
    // touching them all is over the NOTIFY cap. No default tuple shows them.
    await db.execute(
      sql.raw(
        `INSERT INTO ${SRC} (id, label, enabled, status) VALUES ('f', 'L-f', false, 'idle');
         INSERT INTO ${HOST} (id, title, n, src_id)
           SELECT 'filler-' || lpad(g::text, 200, '0'), 'f' || g, 50, 'f'
           FROM generate_series(1, 40) g;`,
      ),
    );
    await until(
      () => routed.some((c) => c.table === NOTES),
      () => "seed changes",
    );

    const subscribed = new Set<number>();
    for (let i = 0; i < TUPLES.length; i++) {
      await subscribe(TUPLES[i]!.key, TUPLES[i]!.params);
      subscribed.add(i);
    }

    const itemsOf = (src: string) =>
      [...model].filter(([, m]) => m.src === src).map(([id]) => id);
    const childrenOf = (ids: readonly string[]) =>
      [...model]
        .filter(([, m]) => ids.includes(m.parent ?? ""))
        .map(([id]) => id);

    const history: string[] = [];
    let inertSteps = 0;
    let overCapSteps = 0;
    // Reverse-route writes that did refill a tuple, scoped.
    let reverseRefills = 0;
    const nextStep = (): Step => {
      const steps: Array<() => Step> = [];
      const present = [...model.keys()];
      const absent = itemIds.filter((id) => !model.has(id));
      const srcs = [...live];
      if (absent.length > 0 && srcs.length > 0) {
        steps.push(() => {
          const id = any(absent);
          const src = any(srcs);
          const parent =
            present.length > 0 && rand() < 0.5 ? any(present) : null;
          const n = Math.floor(rand() * 10);
          return {
            what: `insert item ${id} src=${src} parent=${parent}`,
            tables: [HOST],
            hosts: () => [id],
            run: async () => {
              await db.execute(
                sql`INSERT INTO ${items} (id, title, n, src_id, parent_id) VALUES (${id}, ${`t-${id}`}, ${n}, ${src}, ${parent})`,
              );
              model.set(id, { src, parent });
            },
          };
        });
      }
      if (present.length > 0) {
        steps.push(() => {
          const id = any(present);
          const n = Math.floor(rand() * 10);
          return {
            what: `update item ${id} n=${n}`,
            tables: [HOST],
            hosts: () => [id],
            run: async () => {
              await db.execute(
                sql`UPDATE ${items} SET n = ${n} WHERE id = ${id}`,
              );
            },
          };
        });
        // A title a child reads through the self-join: the parent route's
        // reverse refills the children.
        steps.push(() => {
          const id = any(present);
          const title = `t${Math.floor(rand() * 20)}`;
          return {
            what: `retitle item ${id} → ${title}`,
            reverse: true,
            tables: [HOST],
            hosts: () => [id, ...childrenOf([id])],
            run: async () => {
              await db.execute(
                sql`UPDATE ${items} SET title = ${title} WHERE id = ${id}`,
              );
            },
          };
        });
        if (srcs.length > 0) {
          steps.push(() => {
            const id = any(present);
            const src = any(srcs);
            return {
              what: `move item ${id} to source ${src}`,
              tables: [HOST],
              hosts: () => [id],
              run: async () => {
                await db.execute(
                  sql`UPDATE ${items} SET src_id = ${src} WHERE id = ${id}`,
                );
                model.get(id)!.src = src;
              },
            };
          });
        }
        steps.push(() => {
          const id = any(present);
          const parent = rand() < 0.3 ? null : any(present);
          return {
            what: `reparent item ${id} → ${parent}`,
            tables: [HOST],
            hosts: () => [id],
            run: async () => {
              await db.execute(
                sql`UPDATE ${items} SET parent_id = ${parent} WHERE id = ${id}`,
              );
              model.get(id)!.parent = parent;
            },
          };
        });
        // No FK on parent_id: the children keep naming a gone parent, and
        // their parentTitle turns NULL — the parent route's reverse on a D.
        steps.push(() => {
          const id = any(present);
          const children = childrenOf([id]);
          return {
            what: `delete item ${id}`,
            tables: [HOST],
            hosts: () => [id, ...children],
            run: async () => {
              await db.execute(sql`DELETE FROM ${items} WHERE id = ${id}`);
              model.delete(id);
            },
          };
        });
        steps.push(() => {
          const id = any(present);
          const value = rand() < 0.5 ? "x" : "y";
          return {
            what: `note c1 on ${id} = ${value}`,
            tables: [NOTES],
            hosts: () => [id],
            run: async () => {
              await db.execute(
                sql`INSERT INTO ${notes} (view_id, row_key, col, value) VALUES ('v', ${id}, 'c1', ${value})
                    ON CONFLICT (view_id, row_key, col) DO UPDATE SET value = EXCLUDED.value`,
              );
            },
          };
        });
        steps.push(() => {
          const id = any(present);
          return {
            what: `delete note c1 of ${id}`,
            tables: [NOTES],
            hosts: () => [id],
            run: async () => {
              await db.execute(
                sql`DELETE FROM ${notes} WHERE view_id = 'v' AND row_key = ${id} AND col = 'c1'`,
              );
              // A delete of nothing sends no NOTIFY: make sure there is a row.
            },
          };
        });
        // Another member of the keyed side, another surface: read by nothing.
        steps.push(() => {
          const id = any(present);
          const [view, col] = rand() < 0.5 ? ["v", "c2"] : ["w", "c1"];
          return {
            what: `note ${view}/${col} on ${id} (unread)`,
            tables: [NOTES],
            hosts: () => [],
            inert: true,
            run: async () => {
              await db.execute(
                sql`INSERT INTO ${notes} (view_id, row_key, col, value) VALUES (${view}, ${id}, ${col}, ${String(rand())})
                    ON CONFLICT (view_id, row_key, col) DO UPDATE SET value = EXCLUDED.value`,
              );
            },
          };
        });
        // Every item's n at once: one multi-row statement.
        steps.push(() => ({
          what: "bump every item's n",
          tables: [HOST],
          hosts: () => [...model.keys()],
          run: async () => {
            await db.execute(
              sql`UPDATE ${items} SET n = (n + 3) % 10 WHERE src_id <> 'f'`,
            );
          },
        }));
        // The same over the cap (the fillers too): ids and keys dropped.
        steps.push(() => ({
          what: "bump every row's n (over the NOTIFY cap)",
          overCap: true,
          tables: [HOST],
          hosts: () => [...model.keys()],
          run: async () => {
            await db.execute(
              sql`UPDATE ${items} SET n = CASE WHEN src_id = 'f' THEN 50 ELSE (n + 7) % 10 END`,
            );
          },
        }));
        // Over the cap too, but of a column no route reads: `unchanged`
        // survives the dropped ids, and nothing loads.
        steps.push(() => ({
          what: "touch every row (over the NOTIFY cap, unread)",
          overCap: true,
          inert: true,
          tables: [HOST],
          hosts: () => [],
          run: async () => {
            await db.execute(sql`UPDATE ${items} SET touched = touched + 1`);
          },
        }));
        // A host's primary key moves: old and new ids both arrive (old ∪
        // new), and the children naming either id re-read their parent.
        if (absent.length > 0) {
          steps.push(() => {
            const from = any(present);
            const to = any(absent);
            return {
              what: `rekey item ${from} → ${to}`,
              tables: [HOST],
              hosts: () => [from, to, ...childrenOf([from, to])],
              run: async () => {
                await db.execute(
                  sql`UPDATE ${items} SET id = ${to} WHERE id = ${from}`,
                );
                model.set(to, model.get(from)!);
                model.delete(from);
              },
            };
          });
        }
      }
      if (srcs.length > 0) {
        steps.push(() => {
          const s = any(srcs);
          return {
            what: `relabel source ${s}`,
            reverse: true,
            tables: [SRC],
            hosts: () => itemsOf(s),
            run: async () => {
              await db.execute(
                sql`UPDATE ${sources} SET label = ${`L-${s}-${Math.floor(rand() * 9)}`} WHERE id = ${s}`,
              );
            },
          };
        });
        steps.push(() => {
          const s = any(srcs);
          return {
            what: `flip source ${s} enabled`,
            reverse: true,
            tables: [SRC],
            hosts: () => itemsOf(s),
            run: async () => {
              await db.execute(
                sql`UPDATE ${sources} SET enabled = NOT enabled WHERE id = ${s}`,
              );
            },
          };
        });
        // What a run writes: a column no route reads — gated away.
        steps.push(() => {
          const s = any(srcs);
          return {
            what: `status flip on source ${s} (unread)`,
            tables: [SRC],
            hosts: () => [],
            inert: true,
            run: async () => {
              await db.execute(
                sql`UPDATE ${sources} SET status = CASE WHEN status = 'idle' THEN 'running' ELSE 'idle' END WHERE id = ${s}`,
              );
            },
          };
        });
        if (srcs.length > 1) {
          // Its items cascade: the source D reaches no host by itself (a
          // reverse over a gone row finds its referencing hosts' own Ds), the
          // items arrive as identity Ds, and their children's parent reads NULL.
          steps.push(() => {
            const s = any(srcs);
            const gone = itemsOf(s);
            const children = childrenOf(gone);
            return {
              what: `delete source ${s} (cascade ${gone.join(",")})`,
              tables: gone.length > 0 ? [SRC, HOST] : [SRC],
              hosts: () => [...gone, ...children],
              run: async () => {
                await db.execute(sql`DELETE FROM ${sources} WHERE id = ${s}`);
                live.delete(s);
                for (const id of gone) model.delete(id);
              },
            };
          });
        }
      }
      const gone = sourceIds.filter((s) => !live.has(s));
      // A source's primary key moves, cascading onto its items' `src_id`.
      if (srcs.length > 0 && gone.length > 0) {
        steps.push(() => {
          const from = any(srcs);
          const to = any(gone);
          const moved = itemsOf(from);
          return {
            what: `rekey source ${from} → ${to} (cascade ${moved.join(",")})`,
            tables: moved.length > 0 ? [SRC, HOST] : [SRC],
            hosts: () => moved,
            run: async () => {
              await db.execute(
                sql`UPDATE ${sources} SET id = ${to} WHERE id = ${from}`,
              );
              live.delete(from);
              live.add(to);
              for (const id of moved) model.get(id)!.src = to;
            },
          };
        });
      }
      if (gone.length > 0) {
        steps.push(() => {
          const s = any(gone);
          return {
            what: `recreate source ${s}`,
            tables: [SRC],
            hosts: () => [],
            run: async () => {
              await db.execute(
                sql`INSERT INTO ${sources} (id, label, enabled, status) VALUES (${s}, ${`L-${s}`}, true, 'idle')`,
              );
              live.add(s);
            },
          };
        });
      }
      return any(steps)();
    };

    for (let step = 0; step < 70; step++) {
      if (rand() < 0.1) {
        const i = Math.floor(rand() * TUPLES.length);
        const t = TUPLES[i]!;
        if (subscribed.has(i)) {
          unsubscribe(t.key, t.params);
          subscribed.delete(i);
        } else {
          await subscribe(t.key, t.params);
          subscribed.add(i);
        }
      }

      const s = nextStep();
      // A delete of a note that is not there changes no row, so sends nothing.
      if (s.what.startsWith("delete note")) {
        const id = s.what.split(" ").at(-1)!;
        await db.execute(
          sql`INSERT INTO ${notes} (view_id, row_key, col, value) VALUES ('v', ${id}, 'c1', 'z')
              ON CONFLICT DO NOTHING`,
        );
        await quiet();
      }
      const bound = s.hosts();
      history.push(s.what);
      const routedAt = routed.length;
      const loadsAt = loads.length;
      await s.run();
      await until(
        () =>
          s.tables.every((t) =>
            routed.slice(routedAt).some((c) => c.table === t),
          ),
        () => `step ${step} (${s.what}): its change was never routed`,
      );
      if (s.overCap) {
        overCapSteps++;
        const change = routed
          .slice(routedAt)
          .find((c) => c.table === HOST && c.op === "U")!;
        // Really over the cap: no ids, no keys — only the unchanged columns.
        expect(change.ids).toBeNull();
        expect(change.keys).toBeNull();
        expect(change.unchanged).not.toBeNull();
      }
      const tuples = [...subscribed].map((i) => TUPLES[i]!);
      const expected = await converge(tuples, `step ${step} (${s.what})`);

      const stepLoads = loads.slice(loadsAt);
      if (s.inert) {
        inertSteps++;
        if (stepLoads.length > 0) {
          throw new Error(
            `step ${step} (${s.what}) reached ${JSON.stringify(stepLoads)} — a write no route reads must load nothing`,
          );
        }
        continue;
      }
      if (
        s.reverse &&
        stepLoads.some((l) => l.ids !== "FULL" && l.ids.length > 0)
      ) {
        reverseRefills++;
      }
      const holds = (load: Load, id: string) =>
        [...tuples.entries()].some(
          ([i, t]) =>
            t.key === load.key &&
            JSON.stringify(t.params) === load.params &&
            (expected.get(i) as { id: string }[]).some((r) => r.id === id),
        );
      for (const load of stepLoads) {
        if (load.ids === "FULL") {
          if (load.key !== itemsCollection.groups.key && !s.overCap) {
            throw new Error(
              `step ${step} (${s.what}) loaded ${load.key} ${load.params} FULL — ` +
                `this step's loads: ${JSON.stringify(stepLoads)}; ` +
                `history: ${history.slice(-4).join(" | ")}`,
            );
          }
          continue;
        }
        const stray = load.ids.filter(
          (id) => !bound.includes(id) && !holds(load, id),
        );
        if (stray.length > 0) {
          throw new Error(
            `step ${step} (${s.what}; bound ${bound.join(",")}) refilled ${JSON.stringify(load.ids)} ` +
              `for ${load.key} ${load.params} — this step's loads: ${JSON.stringify(stepLoads)}; ` +
              `history: ${history.slice(-4).join(" | ")}`,
          );
        }
      }
    }
    // The workload did exercise the gated-away writes, and the reverse routes.
    expect(inertSteps).toBeGreaterThan(0);
    expect(reverseRefills).toBeGreaterThan(0);
    expect(overCapSteps).toBeGreaterThan(0);
    // Both primary-key moves ran.
    expect(history.some((h) => h.startsWith("rekey item"))).toBe(true);
    expect(history.some((h) => h.startsWith("rekey source"))).toBe(true);
    for (const i of subscribed) {
      unsubscribe(TUPLES[i]!.key, TUPLES[i]!.params);
    }
  }, 180_000);

  test("an enabled flip over the reverse cap recomputes the reading window FULL; under it, it refills exactly the source's items", async () => {
    await db.execute(
      sql.raw(
        `INSERT INTO ${SRC} (id, label, enabled, status) VALUES ('big', 'L-big', true, 'idle'), ('small', 'L-small', true, 'idle');
         INSERT INTO ${HOST} (id, title, n, src_id)
           SELECT 'big-' || g, 'b' || g, 100 + g, 'big' FROM generate_series(1, 501) g;
         INSERT INTO ${HOST} (id, title, n, src_id)
           SELECT 'small-' || g, 's' || g, 200 + g, 'small' FROM generate_series(1, 3) g;`,
      ),
    );
    await quiet();
    const tuple = { key: itemsCollection.key, params: w.encode({ limit: 20 }) };
    await subscribe(tuple.key, tuple.params);
    await converge([tuple], "subscribed");

    let at = loads.length;
    await db.execute(
      sql`UPDATE ${sources} SET enabled = false WHERE id = 'big'`,
    );
    await until(
      () => loads.slice(at).some((l) => l.key === tuple.key),
      () => "the over-cap flip reached the window",
    );
    await converge([tuple], "over-cap flip");
    const over = loads.slice(at).filter((l) => l.key === tuple.key);
    expect(over.map((l) => l.ids)).toContain("FULL");

    at = loads.length;
    await db.execute(
      sql`UPDATE ${sources} SET enabled = false WHERE id = 'small'`,
    );
    await until(
      () => loads.slice(at).some((l) => l.key === tuple.key),
      () => "the under-cap flip reached the window",
    );
    await converge([tuple], "under-cap flip");
    const under = loads.slice(at).filter((l) => l.key === tuple.key);
    expect(under.some((l) => l.ids === "FULL")).toBe(false);
    const now = (await truth.get(tuple.key)!(tuple.params)) as { id: string }[];
    // The source's own items, or a row their exits made room for.
    const stray = under
      .flatMap((l) => l.ids as string[])
      .filter(
        (id) => !id.startsWith("small-") && !now.some((r) => r.id === id),
      );
    expect(stray).toEqual([]);
    unsubscribe(tuple.key, tuple.params);
  }, 60_000);

  test("an expression over the lookup: a label rename refills exactly the source's items, sorted and filtered by it", async () => {
    await db.execute(
      sql.raw(
        `INSERT INTO ${SRC} (id, label, enabled, status) VALUES ('ea', 'A', true, 'idle'), ('eb', 'B', true, 'idle');
         INSERT INTO ${HOST} (id, title, n, src_id)
           SELECT 'ea-' || g, 't' || g, 300 + g, 'ea' FROM generate_series(1, 3) g;
         INSERT INTO ${HOST} (id, title, n, src_id)
           SELECT 'eb-' || g, 't' || g, 400 + g, 'eb' FROM generate_series(1, 3) g;`,
      ),
    );
    await quiet();
    const tw = tagCollection.window.window;
    const tuples = [
      // Sorted by the expression: the lookup is membership.
      {
        key: tagCollection.key,
        params: tw.encode({ orderBy: [["tag", "desc"]], limit: 5 }),
      },
      // Filtered by it: a rename moves items in and out.
      {
        key: tagCollection.key,
        params: tw.encode({ where: { tag: { contains: "Z/" } }, limit: 10 }),
      },
    ];
    for (const t of tuples) await subscribe(t.key, t.params);
    await converge(tuples, "subscribed");

    for (const [src, label] of [
      ["ea", "Z"],
      ["eb", "ZZ"],
      ["ea", "A2"],
    ] as const) {
      const at = loads.length;
      await db.execute(
        sql`UPDATE ${sources} SET label = ${label} WHERE id = ${src}`,
      );
      await until(
        () => loads.slice(at).some((l) => l.key === tagCollection.key),
        () => `the rename of ${src} reached the tag windows`,
      );
      const expected = await converge(tuples, `rename ${src} → ${label}`);
      const refills = loads
        .slice(at)
        .filter((l) => l.key === tagCollection.key);
      expect(refills.some((l) => l.ids === "FULL")).toBe(false);
      // The source's own items, or a row their moves made room for.
      const held = new Set(
        [...expected.values()].flatMap((v) =>
          (v as { id: string }[]).map((r) => r.id),
        ),
      );
      const stray = refills
        .flatMap((l) => l.ids as string[])
        .filter((id) => !id.startsWith(`${src}-`) && !held.has(id));
      expect(stray).toEqual([]);
    }
    // The filtered tuple now holds exactly the items whose tag reads "…Z/…".
    expect(
      (viewOf(tuples[1]!.key, tuples[1]!.params).value as { id: string }[])
        .map((r) => r.id)
        .sort(),
    ).toEqual(["eb-1", "eb-2", "eb-3"]);
    for (const t of tuples) unsubscribe(t.key, t.params);
  }, 60_000);
});
