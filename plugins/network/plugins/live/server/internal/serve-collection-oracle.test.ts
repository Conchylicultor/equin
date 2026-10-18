/**
 * Differential oracle for a collection over a 1:1 extension join (Verification
 * §3 of research/2026-09-29-global-scoped-change-routing.md, the extension
 * case), on a throwaway database through the REAL feed: the change-feed's
 * triggers, its LISTEN consumer, `routeChange`, and the server-core runtime.
 *
 * A random workload of host and extension writes (inserts, updates, deletes,
 * cascaded deletes, multi-row statements) runs interleaved with subscribes and
 * unsubscribes of window, point and grouping tuples. After every statement:
 *
 * - every subscribed tuple's client view (the faithful client simulator)
 *   equals a fresh FULL load of that tuple;
 * - every scoped refill names only host ids the statement changed (O(changed)),
 *   and no subscribed window or point tuple is ever reloaded FULL;
 * - a grouping whose SQL never reads the extension logs no load at all for an
 *   extension-only statement (outcome 2: only the tuples whose query reads the
 *   table).
 *
 * Requires a running Postgres cluster (started by ./singularity build);
 * createTestDb() throws loudly when it is unreachable.
 * Run: `./singularity test plugins/network/plugins/live`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { Client } from "pg";
import { nullable } from "@plugins/fields/core";
import { floatField } from "@plugins/fields/plugins/float/plugins/config/core";
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
  type ResourceParams,
  setRelationBases,
} from "@plugins/framework/plugins/server-core/core";
import { clearRelationBases } from "@plugins/framework/plugins/server-core/core/testing";
import {
  makeClientView,
  type ClientView,
  type RecordedFrame,
} from "@plugins/framework/plugins/resource-runtime/core/testing";
import type { ExtensionJoin } from "@plugins/infra/plugins/query-resource/core";
import type { QueryDb } from "@plugins/infra/plugins/query-resource/server";
import { compileWindowQuery } from "@plugins/infra/plugins/query-resource/server/testing";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { compileCollection } from "./serve-collection";

const HOST = "orc_songs";
const EXT = "orc_songs_ext_x";

const songs = pgTable(HOST, {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  n: integer("n").notNull(),
});
const ext = pgTable(EXT, {
  parentId: text("parent_id").primaryKey(),
  score: integer("score"),
  note: text("note"),
});
const extJoin: ExtensionJoin<"x", typeof ext> = {
  kind: "extension",
  alias: "x",
  table: ext,
  key: ext.parentId,
  parentKey: songs.id,
};

const songsCollection = liveCollection("test.live.oracle.songs", {
  fields: {
    id: textField({ label: "Id", filterable: false }),
    title: textField({ label: "Title", filterable: false }),
    n: intField({ label: "N" }),
    score: nullable(floatField({ label: "Score" })),
    note: nullable(textField({ label: "Note" })),
  },
  id: "id",
  sortable: ["n", "score", "title"],
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
  // What change-feed's boot installs before its listener starts (D34): the
  // relation bases the router reaches a relation read through (and the drift
  // guard fails open through). No views matter here, so every relation is its
  // own base.
  setRelationBases((r) => [r]);
  testDb = await createTestDb({ prefix: "live_oracle_test" });
  client = new Client({ connectionString: testDb.connectionString });
  await client.connect();
  db = drizzle(client);
  await db.execute(
    sql.raw(
      `CREATE TABLE ${HOST} (id text PRIMARY KEY, title text NOT NULL, n integer NOT NULL);
       CREATE TABLE ${EXT} (parent_id text PRIMARY KEY REFERENCES ${HOST}(id) ON DELETE CASCADE,
                            score integer, note text);`,
    ),
  );
  // Register the collection's three resources on the server-core runtime —
  // the one `routeChange` feeds — with every loader run recorded.
  const specs = compileCollection(songsCollection, {
    from: songs,
    joins: [extJoin],
    columns: {
      score: (j) => j.x.score,
      note: (j) => j.x.note,
    },
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
    songsCollection.window,
    specs.window,
  ).serverOpts;
  const rowsOpts = compileWindowQuery(
    songsCollection.rows,
    specs.rows,
  ).serverOpts;
  defineResource(songsCollection.window, {
    ...windowOpts,
    loader: record(songsCollection.key, windowOpts.loader),
  });
  defineResource(songsCollection.rows, {
    ...rowsOpts,
    loader: record(songsCollection.rows.key, rowsOpts.loader),
  });
  defineResource(songsCollection.groups, {
    ...specs.groups,
    loader: record(songsCollection.groups.key, specs.groups.loader),
  });
  truth.set(songsCollection.key, (p) => windowOpts.loader(p as never));
  truth.set(songsCollection.rows.key, (p) => rowsOpts.loader(p as never));
  truth.set(songsCollection.groups.key, (p) => specs.groups.loader(p as never));
  // The feed, installed from the routes just registered: the host and the
  // extension each get the routed trigger (old ∪ new ids, the changed gate) —
  // the layout the booted server derives the same way.
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
    coveredTables: () => [HOST, EXT],
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

const w = songsCollection.window.window;
const g = songsCollection.groups.groups;
const TUPLES: Array<{
  key: string;
  params: ResourceParams;
  readsExt: boolean;
}> = [
  // Value role: the extension is only projected.
  { key: songsCollection.key, params: w.encode(), readsExt: true },
  {
    key: songsCollection.key,
    params: w.encode({ where: { n: { lte: 5 } }, orderBy: [["title", "asc"]] }),
    readsExt: true,
  },
  // Membership role: sorted, filtered by an extension column.
  {
    key: songsCollection.key,
    params: w.encode({ orderBy: [["score", "desc"]], limit: 3 }),
    readsExt: true,
  },
  {
    key: songsCollection.key,
    params: w.encode({ where: { score: { gt: 3 } }, limit: 5 }),
    readsExt: true,
  },
  {
    key: songsCollection.rows.key,
    params: songsCollection.rows.point.encode(["s1", "s2", "s3"]),
    readsExt: true,
  },
  // A grouping by an extension column reads it; by a base column it does not.
  {
    key: songsCollection.groups.key,
    params: g.encode({ groupBy: "note" }),
    readsExt: true,
  },
  {
    key: songsCollection.groups.key,
    params: g.encode({ groupBy: "n" }),
    readsExt: false,
  },
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
  run: () => Promise<void>;
  /** The host ids the statement may change (its refills' bound). */
  hosts: readonly string[];
  /** Touches only the extension table. */
  extOnly: boolean;
  /** The tables whose NOTIFY must have been routed before the step settles. */
  tables: readonly string[];
}

describe("serveCollection over an extension join — differential oracle", () => {
  test("random host / extension writes: every view converges to a fresh load, refills stay O(changed)", async () => {
    const rand = prng(4242);
    const ids = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"];
    const hosts = new Set<string>();

    // Seed a few hosts, some with an extension row.
    for (const id of ids.slice(0, 5)) {
      await db.execute(
        sql`INSERT INTO ${songs} (id, title, n) VALUES (${id}, ${`t-${id}`}, ${Math.floor(rand() * 10)})`,
      );
      hosts.add(id);
    }
    await db.execute(
      sql`INSERT INTO ${ext} (parent_id, score, note) VALUES ('s1', 5, 'a'), ('s2', 1, NULL), ('s4', 8, 'b')`,
    );
    await until(
      () => routed.some((c) => c.table === EXT),
      () => "seed changes",
    );

    const history: string[] = [];
    // Extension-only steps the default (value-role) tuple skipped outright:
    // the write reached rows it does not hold.
    let valueSkips = 0;
    const subscribed = new Set<number>();
    for (let i = 0; i < TUPLES.length; i++) {
      await subscribe(TUPLES[i]!.key, TUPLES[i]!.params);
      subscribed.add(i);
    }

    const exts = new Set(["s1", "s2", "s4"]);
    // Every step changes at least one row: a statement that changes none
    // sends no NOTIFY, so there would be nothing to wait for.
    const nextStep = (): Step => {
      const steps: Array<() => Step> = [];
      const absent = ids.filter((id) => !hosts.has(id));
      const present = [...hosts];
      const withExt = [...exts];
      const any = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
      if (absent.length > 0) {
        steps.push(() => {
          const id = any(absent);
          const n = Math.floor(rand() * 10);
          return {
            what: `insert host ${id} n=${n}`,
            hosts: [id],
            extOnly: false,
            tables: [HOST],
            run: async () => {
              await db.execute(
                sql`INSERT INTO ${songs} (id, title, n) VALUES (${id}, ${`t-${id}`}, ${n})`,
              );
              hosts.add(id);
            },
          };
        });
      }
      if (present.length > 0) {
        steps.push(() => {
          const id = any(present);
          const n = Math.floor(rand() * 10);
          return {
            what: `update host ${id} n=${n}`,
            hosts: [id],
            extOnly: false,
            tables: [HOST],
            run: async () => {
              await db.execute(
                sql`UPDATE ${songs} SET n = ${n} WHERE id = ${id}`,
              );
            },
          };
        });
        // Cascades to its extension row: an ext D and a host D, one transaction.
        steps.push(() => {
          const id = any(present);
          return {
            what: `delete host ${id} (cascade)`,
            hosts: [id],
            extOnly: false,
            tables: [HOST],
            run: async () => {
              await db.execute(sql`DELETE FROM ${songs} WHERE id = ${id}`);
              hosts.delete(id);
              exts.delete(id);
            },
          };
        });
        for (let k = 0; k < 3; k++) {
          steps.push(() => {
            const id = any(present);
            const score = rand() < 0.2 ? null : Math.floor(rand() * 10);
            const note = rand() < 0.5 ? null : rand() < 0.5 ? "a" : "b";
            return {
              what: `upsert ext ${id} score=${score} note=${note}`,
              hosts: [id],
              extOnly: true,
              tables: [EXT],
              run: async () => {
                await db.execute(
                  sql`INSERT INTO ${ext} (parent_id, score, note) VALUES (${id}, ${score}, ${note})
                      ON CONFLICT (parent_id) DO UPDATE SET score = EXCLUDED.score, note = EXCLUDED.note`,
                );
                exts.add(id);
              },
            };
          });
        }
      }
      if (withExt.length > 0) {
        steps.push(() => {
          const id = any(withExt);
          return {
            what: `delete ext ${id}`,
            hosts: [id],
            extOnly: true,
            tables: [EXT],
            run: async () => {
              await db.execute(sql`DELETE FROM ${ext} WHERE parent_id = ${id}`);
              exts.delete(id);
            },
          };
        });
        // A multi-row statement over the extension.
        steps.push(() => {
          const delta = 1 + Math.floor(rand() * 3);
          return {
            what: `bump every ext score by ${delta}`,
            hosts: withExt,
            extOnly: true,
            tables: [EXT],
            run: async () => {
              await db.execute(
                sql`UPDATE ${ext} SET score = coalesce(score, 0) + ${delta}`,
              );
            },
          };
        });
      }
      return any(steps)();
    };

    for (let step = 0; step < 60; step++) {
      // Now and then, drop a tuple or bring one back.
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
      history.push(s.what);
      const routedAt = routed.length;
      const loadsAt = loads.length;
      await s.run();
      // The statement's NOTIFYs have been routed…
      await until(
        () =>
          s.tables.every((t) =>
            routed.slice(routedAt).some((c) => c.table === t),
          ),
        () => `step ${step} (${s.what}): its change was never routed`,
      );
      // …and every view converges to a fresh FULL load of its tuple.
      const expected = new Map<number, unknown>();
      for (const i of subscribed) {
        const t = TUPLES[i]!;
        expected.set(i, await truth.get(t.key)!(t.params));
      }
      const converged = () =>
        [...subscribed].every(
          (i) =>
            JSON.stringify(viewOf(TUPLES[i]!.key, TUPLES[i]!.params).value) ===
            JSON.stringify(expected.get(i)),
        );
      await until(converged, () => {
        const off = [...subscribed].find(
          (i) =>
            JSON.stringify(viewOf(TUPLES[i]!.key, TUPLES[i]!.params).value) !==
            JSON.stringify(expected.get(i)),
        )!;
        return `step ${step} (${s.what}): tuple ${JSON.stringify(TUPLES[off])} holds ${JSON.stringify(
          viewOf(TUPLES[off]!.key, TUPLES[off]!.params).value,
        )}, a fresh load reads ${JSON.stringify(expected.get(off))}`;
      });
      // Let every late drain of this step land — a refill that changes no
      // value (a membership-role write to a row the tuple does not hold)
      // leaves the views converged before it runs — then re-check.
      await quiet();
      expect(converged()).toBe(true);

      const stepLoads = loads.slice(loadsAt);
      // Refills are O(changed): each reads at most as many rows as the
      // statement changed hosts, and each id is a changed host — or a row the
      // tuple now holds that one of them made room for (a window backfill, the
      // entrant `windowIdsOf` admitted after an exit).
      const holds = (load: Load, id: string) =>
        [...subscribed].some((i) => {
          const t = TUPLES[i]!;
          return (
            t.key === load.key &&
            JSON.stringify(t.params) === load.params &&
            (expected.get(i) as { id: string }[]).some((r) => r.id === id)
          );
        });
      for (const load of stepLoads) {
        if (load.ids === "FULL") {
          // A grouping recomputes whole — its only shape. A window or point
          // tuple already subscribed is never reloaded whole: every write in
          // this workload names its rows (identity and extension alias
          // routes), so a FULL here is a route that lost its ids.
          if (load.key !== songsCollection.groups.key) {
            throw new Error(
              `step ${step} (${s.what}) loaded ${load.key} ${load.params} FULL — ` +
                `this step's loads: ${JSON.stringify(stepLoads)}; ` +
                `history: ${history.slice(-4).join(" | ")}`,
            );
          }
          continue;
        }
        const stray = load.ids.filter(
          (id) => !s.hosts.includes(id) && !holds(load, id),
        );
        if (load.ids.length > s.hosts.length || stray.length > 0) {
          throw new Error(
            `step ${step} (${s.what}; hosts ${s.hosts.join(",")}) refilled ${JSON.stringify(load.ids)} ` +
              `for ${load.key} ${load.params} — this step's loads: ${JSON.stringify(stepLoads)}; ` +
              `history: ${history.slice(-4).join(" | ")}`,
          );
        }
      }
      if (
        s.extOnly &&
        subscribed.has(0) &&
        !stepLoads.some(
          (l) =>
            l.key === TUPLES[0]!.key &&
            l.params === JSON.stringify(TUPLES[0]!.params),
        )
      ) {
        valueSkips++;
      }
      // A tuple whose SQL never reads the extension is never loaded for an
      // extension-only statement.
      if (s.extOnly) {
        for (const t of TUPLES.filter((t) => !t.readsExt)) {
          expect(
            stepLoads.filter(
              (l) => l.key === t.key && l.params === JSON.stringify(t.params),
            ),
          ).toEqual([]);
        }
      }
    }
    // The workload did exercise the value-role drop.
    expect(valueSkips).toBeGreaterThan(0);
  }, 120_000);
});
