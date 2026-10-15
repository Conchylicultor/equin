/**
 * The key-range pages against the REAL feed, on a throwaway database: the
 * change-feed's triggers and LISTEN consumer, `routeChange`, the server-core
 * runtime serving each page as its own window tuple (`after` / `until` cuts
 * on server-minted `$key`s), and the pages' own plan (`shared/page-plan.ts`)
 * driven by what those tuples' client views hold and by a moving viewport —
 * exactly as `useLive`'s paged read drives it: a page near the viewport subscribed,
 * one far from it unsubscribed and held stale.
 *
 * A random workload of inserts, updates and deletes interleaves with paging
 * (`loadMore`) and viewport moves. After every statement, once the feed has
 * landed:
 *
 * - every LIVE page's view equals a fresh FULL load of its tuple;
 * - no row is shown twice;
 * - no page already subscribed is reloaded FULL, and every refill names only
 *   rows the statement changed (or a row it made room for).
 *
 * Scrolled back over every page (all live again), the rows are a gap-free
 * prefix of a fresh `ORDER BY` read of the whole table. And a head that keeps
 * taking inserts splits page after page, the read growing past any segment
 * cap, its rows a gap-free prefix at every step.
 *
 * Seeded derivation (P3): a page a split or merge mints is subscribed with
 * its seed — the slices of the pages it replaces — as `useLive`'s paged read sends it
 * through live-state, so `loadMore` loads exactly the new page's `step` rows
 * and a merge loads nothing.
 *
 * Requires a running Postgres cluster (started by ./singularity build).
 * Run: `./singularity test plugins/network/plugins/live`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { Client } from "pg";
import { z } from "zod";
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
  type DeriveFrame,
  type DeriveSourceFrame,
  type RecordedFrame,
} from "@plugins/framework/plugins/resource-runtime/core/testing";
import type { QueryDb } from "@plugins/infra/plugins/query-resource/server";
import { compileWindowQuery } from "@plugins/infra/plugins/query-resource/server/testing";
import {
  liveCollection,
  LIVE_ROW_KEY,
} from "@plugins/network/plugins/live/core";
import { PROTOCOL } from "@plugins/packages/plugins/resource-protocol/core";
import {
  assemble,
  loadMore,
  reconcile,
  startPages,
  type Page,
  type PageEntry,
  type PageLimits,
  type PageObservation,
  type PagePlan,
  type PageViewport,
} from "../../shared/page-plan";
import { compileCollection } from "./serve-collection";
import { liveNumber } from "@plugins/network/plugins/live/plugins/filter/core";

const TABLE = "pgo_items";
const items = pgTable(TABLE, {
  id: text("id").primaryKey(),
  n: integer("n").notNull(),
});
const Row = z.object({ id: z.string(), n: z.number() });

const collection = liveCollection("test.live.pages-oracle.items", {
  row: Row,
  id: "id",
  filterable: { n: liveNumber() },
  sortable: ["n"],
  default: { orderBy: [["n", "asc"]], limit: 2 },
  maxLimit: 4,
});
const codec = collection.window.window;
// No stale budget here: the oracle checks what a released page holds.
const LIMITS: PageLimits = { step: 2, maxLimit: 4, staleRows: 1_000_000 };

interface Load {
  params: string;
  ids: readonly string[] | "FULL";
  /** How many rows it read. */
  rows: number;
}

let testDb: TestDb;
let client: Client;
let db: NodePgDatabase;
let listener: ReturnType<typeof createChangeFeedListener>;
const routed: FeedChange[] = [];
const loads: Load[] = [];
const frames: RecordedFrame[] = [];
let frameSeq = 0;
let truth: (params: ResourceParams) => Promise<unknown>;

const handler = notificationsWsHandler as unknown as {
  open(ws: unknown): void;
  message(ws: unknown, raw: string): void;
  close(ws: unknown, code: number, reason: string): void;
};
const ws = {
  send(raw: string) {
    const frame = JSON.parse(raw) as Omit<RecordedFrame, "seq" | "socket">;
    if (frame.kind !== "ping") {
      frames.push({ ...frame, seq: frameSeq++, socket: 0 });
    }
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
    await new Promise((r) => setTimeout(r, 100));
    if (loads.length === at[0] && frames.length === at[1]) return;
    if (Date.now() > deadline) throw new Error("the runtime never went quiet");
  }
}

beforeAll(async () => {
  // What change-feed's boot installs before its listener starts (D34). This
  // suite reaches only routed entries, but the legacy router runs on every
  // change too, over whatever legacy read-sets other suites in this bun
  // process left: with no bases set it would report on each one. No views
  // matter here, so every relation is its own base.
  setRelationBases((r) => [r]);
  testDb = await createTestDb({ prefix: "live_pages_oracle" });
  client = new Client({ connectionString: testDb.connectionString });
  await client.connect();
  db = drizzle(client);
  await db.execute(
    sql.raw(`CREATE TABLE ${TABLE} (id text PRIMARY KEY, n integer NOT NULL)`),
  );
  const specs = compileCollection(collection, {
    from: items,
    db: db as unknown as QueryDb,
  });
  const opts = compileWindowQuery(collection.window, specs.window).serverOpts;
  defineResource(collection.window, {
    ...opts,
    loader: async (p, ctx) => {
      const rows = await opts.loader(p, ctx);
      loads.push({
        params: JSON.stringify(p),
        ids: ctx ? [...ctx.affectedIds] : "FULL",
        rows: rows.length,
      });
      return rows;
    },
  });
  truth = async (p) => opts.loader(p as never);
  // Installed from the registered routes, as the booted server does.
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
    coveredTables: () => [TABLE],
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

/** One page's window tuple. */
const paramsOf = (page: Page): ResourceParams =>
  codec.encode(
    { limit: page.limit },
    {
      ...(page.after !== null ? { after: page.after } : {}),
      ...(page.until !== null ? { until: page.until } : {}),
    },
  );

type Wire = { id: string; n: number; $key: string | null };

/**
 * The pages as `useLive`'s paged read runs them: the plan, one subscribed window
 * tuple per LIVE page (subscribed by diff, a released page unsubscribed at
 * once), a client view per tuple, and the viewport the plan follows.
 */
class Pages {
  plan: PagePlan<PageEntry> = startPages(LIMITS);
  /** Derivations sent — each derived sub carries a fresh id, as live-state mints one. */
  private derivations = 0;
  viewport: PageViewport = { kind: "measuring" };
  private views = new Map<
    string,
    { params: ResourceParams; view: ClientView; from: number; seq: number }
  >();

  /** The tuples subscribed now. */
  subscribedParams(): string[] {
    return [...this.views.keys()];
  }

  private viewOf(params: ResourceParams) {
    const entry = this.views.get(JSON.stringify(params));
    if (!entry) return undefined;
    for (const f of frames.slice(entry.from)) {
      if (
        f.key !== collection.key ||
        JSON.stringify(f.params ?? {}) !== JSON.stringify(params)
      ) {
        continue;
      }
      entry.view.applyAll([f]);
      // The frame stream's own order: the page applied last holds the
      // freshest value (the client's apply sequence).
      if (f.version !== undefined) entry.seq = f.seq + 1;
    }
    entry.from = frames.length;
    return entry;
  }

  rowsOf(page: Page): Wire[] {
    return (this.viewOf(paramsOf(page))?.view.value ?? []) as Wire[];
  }

  observe = (page: Page): PageObservation<PageEntry> => {
    const entry = this.viewOf(paramsOf(page));
    if (entry === undefined || entry.view.value === undefined) {
      return { kind: "pending" };
    }
    return {
      kind: "settled",
      error: null,
      appliedSeq: entry.seq,
      entries: (entry.view.value as Wire[]).map((r) => ({
        id: r.id,
        key: r[LIVE_ROW_KEY as "$key"],
      })),
    };
  };

  /** Subscribe every live page's tuple — seeded where its plan page says so — and release the rest. */
  async sync(): Promise<void> {
    const want = new Map(
      this.plan.pages
        .filter((p) => p.live)
        .map((p) => [JSON.stringify(paramsOf(p.page)), p]),
    );
    for (const [k, p] of want) {
      if (this.views.has(k)) continue;
      const params = paramsOf(p.page);
      const from = frames.length;
      const view = makeClientView();
      const derive = p.seed === null ? null : this.seedOf(p.seed);
      if (derive !== null) view.expectDerived(derive.rows, derive.frame);
      this.views.set(k, { params, view, from, seq: 0 });
      handler.message(
        ws,
        JSON.stringify({
          op: "sub",
          key: collection.key,
          params,
          protocol: PROTOCOL,
          ...(derive !== null ? { derive: derive.frame } : {}),
        }),
      );
      await until(
        () =>
          frames
            .slice(from)
            .some(
              (f) =>
                f.kind === "sub-ack" &&
                f.key === collection.key &&
                JSON.stringify(f.params ?? {}) === k,
            ),
        () => `sub-ack ${k}`,
      );
    }
    for (const [k, { params }] of this.views) {
      if (want.has(k)) continue;
      handler.message(
        ws,
        JSON.stringify({ op: "unsub", key: collection.key, params }),
      );
      this.views.delete(k);
    }
  }

  /**
   * A seed's rows and wire derivation, cut from the source pages' views as
   * live-state cuts them from its cache — `null` when a source no longer
   * stands as the plan decided (not held, or applied since).
   */
  private seedOf(
    seed: NonNullable<PagePlan<PageEntry>["pages"][number]["seed"]>,
  ): {
    rows: Wire[];
    frame: DeriveFrame;
  } | null {
    const rows: Wire[] = [];
    const from: DeriveSourceFrame[] = [];
    for (const s of seed.from) {
      const params = paramsOf(s.page);
      const entry = this.viewOf(params);
      if (entry === undefined || entry.seq !== s.appliedSeq) return null;
      const held = entry.view.value as Wire[];
      const ids = held.map((r) => r.id);
      const start = s.after === null ? 0 : ids.indexOf(s.after) + 1;
      const end = s.until === null ? ids.length : ids.indexOf(s.until) + 1;
      if (
        (s.after !== null && start === 0) ||
        (s.until !== null && end === 0)
      ) {
        return null;
      }
      rows.push(...held.slice(start, end));
      from.push({
        params,
        version: entry.view.version,
        after: s.after,
        until: s.until,
      });
    }
    return { rows, frame: { id: `d${++this.derivations}`, from } };
  }

  /** Run the plan to a fixpoint, subscribing what each step asks for. */
  async settle(): Promise<void> {
    for (let i = 0; i < 200; i++) {
      await this.sync();
      const out = reconcile(this.plan, this.observe, this.viewport, LIMITS);
      if (out.plan === this.plan) return;
      this.plan = out.plan;
    }
    throw new Error("the pages never settled");
  }

  async loadMore(): Promise<boolean> {
    const next = loadMore(this.plan, this.observe, LIMITS);
    if (next === this.plan) return false;
    this.plan = next;
    await this.settle();
    return true;
  }

  /** The rows shown, as `useLive`'s paged read assembles them. */
  ids(): string[] {
    return assemble(this.plan, this.observe).entries.map((e) => e.id);
  }

  /** Look at shown rows `from..to` (clamped): the pages around them go live, the far ones release. */
  async look(from: number, to: number): Promise<void> {
    const shown = this.ids();
    if (shown.length === 0) return;
    const a = Math.max(0, Math.min(shown.length - 1, from));
    const b = Math.max(a, Math.min(shown.length - 1, to));
    this.viewport = { kind: "rows", first: shown[a]!, last: shown[b]! };
    await this.settle();
  }

  /** Look at every row: every page live. */
  async lookAtAll(): Promise<void> {
    await this.look(0, Number.MAX_SAFE_INTEGER);
  }

  /** The pages the viewport's rows are shown in — `null` while it names a row not shown. */
  band(): { lo: number; hi: number } | null {
    if (this.viewport.kind !== "rows") return null;
    const a = assemble(this.plan, this.observe);
    const pageOf = (id: string): number | null => {
      const at = a.entries.findIndex((e) => e.id === id);
      if (at === -1) return null;
      let page = 0;
      a.firstOf.forEach((start, i) => {
        if (start <= at) page = i;
      });
      return page;
    };
    // The rows may have moved since the viewport was measured: either end.
    const a1 = pageOf(this.viewport.first);
    const b1 = pageOf(this.viewport.last);
    return a1 === null || b1 === null
      ? null
      : { lo: Math.min(a1, b1), hi: Math.max(a1, b1) };
  }

  /** Every LIVE page's view equals a fresh FULL load of its tuple. */
  async converged(): Promise<boolean> {
    for (const p of this.plan.pages) {
      if (!p.live) continue;
      const fresh = await truth(paramsOf(p.page));
      if (JSON.stringify(this.rowsOf(p.page)) !== JSON.stringify(fresh)) {
        return false;
      }
    }
    return true;
  }
}

async function orderedIds(limit: number): Promise<string[]> {
  const res = await client.query<{ id: string }>(
    `SELECT id FROM ${TABLE} ORDER BY n ASC NULLS LAST, id ASC LIMIT ${limit}`,
  );
  return res.rows.map((r) => r.id);
}

/** Wait until every live page's view equals a fresh load of its tuple, and the runtime is quiet. */
async function converge(pages: Pages, what: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!(await pages.converged())) {
    if (Date.now() > deadline)
      throw new Error(`${what}: views never converged`);
    await new Promise((r) => setTimeout(r, 20));
  }
  await quiet();
}

/**
 * Settle the plan and converge its live pages, until the plan holds still
 * against what they converged to (a frame landing while they converge may
 * call for another step).
 */
async function steady(pages: Pages, what: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const before = pages.plan;
    await pages.settle();
    await converge(pages, what);
    await pages.settle();
    if (pages.plan === before) return;
  }
  throw new Error(`${what}: the pages never held still`);
}

/** Wait for the feed to route this statement's change, then for every view to converge. */
async function landed(pages: Pages, routedAt: number, what: string) {
  await until(
    () => routed.slice(routedAt).some((c) => c.table === TABLE),
    () => `${what}: its change was never routed`,
  );
  await converge(pages, what);
}

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

describe("key-range pages over the real feed — differential oracle", () => {
  test("random writes, paging and viewport moves: live pages converge, no row twice, refills stay O(changed); all in view, a gap-free prefix", async () => {
    const rand = prng(20261009);
    await client.query(`DELETE FROM ${TABLE}`);
    let next = 0;
    const present = new Set<string>();
    const values = Array.from({ length: 40 }, () => {
      const id = `r${next++}`;
      present.add(id);
      return `('${id}', ${Math.floor(rand() * 60)})`;
    });
    let routedAt = routed.length;
    await client.query(
      `INSERT INTO ${TABLE} (id, n) VALUES ${values.join(", ")}`,
    );
    const pages = new Pages();
    await until(
      () => routed.slice(routedAt).some((c) => c.table === TABLE),
      () => "seed",
    );
    await pages.settle();
    for (let i = 0; i < 10; i++) await pages.loadMore();
    expect(pages.plan.pages.length).toBeGreaterThan(5);

    for (let step = 0; step < 50; step++) {
      const move = rand();
      if (move < 0.15) await pages.loadMore();
      else if (move < 0.45) {
        const at = Math.floor(rand() * pages.ids().length);
        await pages.look(at, at + 2);
      }
      const before = new Set(pages.subscribedParams());
      const any = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
      const roll = rand();
      let what: string;
      let hosts: string[];
      if (roll < 0.4 || present.size < 5) {
        const id = `r${next++}`;
        const n = Math.floor(rand() * 60);
        what = `insert ${id} n=${n}`;
        hosts = [id];
        present.add(id);
        routedAt = routed.length;
        await client.query(`INSERT INTO ${TABLE} (id, n) VALUES ($1, $2)`, [
          id,
          n,
        ]);
      } else if (roll < 0.8) {
        const id = any([...present]);
        const n = Math.floor(rand() * 60);
        what = `update ${id} n=${n}`;
        hosts = [id];
        routedAt = routed.length;
        await client.query(`UPDATE ${TABLE} SET n = $2 WHERE id = $1`, [id, n]);
      } else {
        const id = any([...present]);
        what = `delete ${id}`;
        hosts = [id];
        present.delete(id);
        routedAt = routed.length;
        await client.query(`DELETE FROM ${TABLE} WHERE id = $1`, [id]);
      }
      const loadsAt = loads.length;
      await landed(pages, routedAt, `step ${step} (${what})`);
      const stepLoads = loads.slice(loadsAt);
      await steady(pages, `step ${step} settle`);

      // No row shown twice, however the pages hold it.
      const shown = pages.ids();
      expect({ step, what, dup: shown.length - new Set(shown).size }).toEqual({
        step,
        what,
        dup: 0,
      });
      // No page already subscribed reloads FULL; refills name changed rows
      // (or a row a window admitted after an exit).
      for (const load of stepLoads) {
        if (load.ids === "FULL") {
          expect({
            step,
            what,
            fullReloadOf: load.params,
            subscribed: before.has(load.params),
          }).toEqual({
            step,
            what,
            fullReloadOf: load.params,
            subscribed: false,
          });
          continue;
        }
        expect(load.ids.length).toBeLessThanOrEqual(Math.max(1, hosts.length));
      }
      // Live pages only near the viewport: none beyond the band (two pages
      // either side of what is on screen).
      const band = pages.band();
      if (band !== null) {
        pages.plan.pages.forEach((p, i) => {
          if (!p.live) return;
          expect({ step, what, i, band }).toEqual({
            step,
            what,
            i: Math.min(Math.max(i, band.lo - 2), band.hi + 2),
            band,
          });
        });
      }
    }

    // Every page back in view: all live, and the rows are exactly a prefix
    // of the table's order — no duplicate, no gap.
    await pages.lookAtAll();
    await steady(pages, "all in view");
    expect(pages.plan.pages.every((p) => p.live)).toBe(true);
    const prefix = pages.ids();
    expect(new Set(prefix).size).toBe(prefix.length);
    expect(prefix).toEqual(await orderedIds(prefix.length));
  }, 240_000);

  test("a released page keeps its rows stale, and reads the truth again once it is in view", async () => {
    await client.query(`DELETE FROM ${TABLE}`);
    const values = Array.from({ length: 24 }, (_, i) => `('s${i}', ${i * 10})`);
    let routedAt = routed.length;
    await client.query(
      `INSERT INTO ${TABLE} (id, n) VALUES ${values.join(", ")}`,
    );
    const pages = new Pages();
    await until(
      () => routed.slice(routedAt).some((c) => c.table === TABLE),
      () => "seed",
    );
    await pages.settle();
    while (await pages.loadMore());
    await pages.look(0, 1);
    const far = pages.plan.pages.length - 2;
    expect(pages.plan.pages[far]!.live).toBe(false);
    const farHeld = pages.plan.pages[far]!.held;
    if (farHeld?.kind !== "rows") throw new Error("expected held rows");
    const held = farHeld.entries.map((e) => e.id);
    expect(held.length).toBeGreaterThan(0);
    const subscribed = new Set(pages.subscribedParams());
    expect(
      subscribed.has(JSON.stringify(paramsOf(pages.plan.pages[far]!.page))),
    ).toBe(false);

    // A write to the released page's range reloads nothing whole, and the
    // page it was in still shows it: it is stale until it is in view.
    routedAt = routed.length;
    const loadsAt = loads.length;
    await client.query(`DELETE FROM ${TABLE} WHERE id = $1`, [held[0]]);
    await landed(pages, routedAt, "delete in a released page");
    for (const load of loads.slice(loadsAt)) expect(load.ids).not.toBe("FULL");
    expect(pages.ids()).toContain(held[0]!);

    // In view again: re-subscribed, and the deleted row is gone.
    const at = pages.ids().indexOf(held[1]!);
    await pages.look(at, at);
    await steady(pages, "back in view");
    expect(pages.ids()).not.toContain(held[0]!);
  }, 120_000);

  test("seeded: loadMore loads exactly the new page's step rows, and a merge loads nothing", async () => {
    await client.query(`DELETE FROM ${TABLE}`);
    const values = Array.from({ length: 8 }, (_, i) => `('m${i}', ${i * 10})`);
    let routedAt = routed.length;
    await client.query(
      `INSERT INTO ${TABLE} (id, n) VALUES ${values.join(", ")}`,
    );
    const pages = new Pages();
    await until(
      () => routed.slice(routedAt).some((c) => c.table === TABLE),
      () => "seed",
    );
    await steady(pages, "first page");
    const derivedAcks = () =>
      frames.filter(
        (f) =>
          f.kind === "sub-ack" &&
          f.key === collection.key &&
          f.derived !== undefined,
      ).length;

    // Three pages past the first: each `loadMore` reads only its new last
    // page — one FULL load of `step` rows — and the page it cut off its old
    // last page `(a, k]` is derived from the rows the client held.
    for (let i = 0; i < 3; i++) {
      const loadsAt = loads.length;
      const derivedAt = derivedAcks();
      expect(await pages.loadMore()).toBe(true);
      await steady(pages, `loadMore ${i}`);
      const last = pages.plan.pages.at(-1)!.page;
      expect({ i, loads: loads.slice(loadsAt) }).toEqual({
        i,
        loads: [
          {
            params: JSON.stringify(paramsOf(last)),
            ids: "FULL",
            rows: LIMITS.step,
          },
        ],
      });
      expect(derivedAcks() - derivedAt).toBe(1);
    }
    expect(pages.ids()).toEqual(await orderedIds(8));
    expect(pages.plan.pages.length).toBe(4);

    // Two deletes leave two neighbours one row each — they merge, and the
    // merged page is derived from both: no load at all.
    for (const id of ["m2", "m4"]) {
      routedAt = routed.length;
      await client.query(`DELETE FROM ${TABLE} WHERE id = $1`, [id]);
      await landed(pages, routedAt, `delete ${id}`);
    }
    const loadsAt = loads.length;
    const derivedAt = derivedAcks();
    await steady(pages, "merge");
    expect(pages.plan.pages.length).toBe(3);
    expect(loads.slice(loadsAt)).toEqual([]);
    expect(derivedAcks() - derivedAt).toBe(1);
    expect(pages.ids()).toEqual(await orderedIds(6));
  }, 120_000);

  test("a head that keeps taking inserts splits page after page past any segment cap — a gap-free prefix at every step", async () => {
    await client.query(`DELETE FROM ${TABLE}`);
    const values = Array.from(
      { length: 60 },
      (_, i) => `('h${i}', ${1000 + i * 2})`,
    );
    let routedAt = routed.length;
    await client.query(
      `INSERT INTO ${TABLE} (id, n) VALUES ${values.join(", ")}`,
    );
    const pages = new Pages();
    await until(
      () => routed.slice(routedAt).some((c) => c.table === TABLE),
      () => "seed",
    );
    await pages.settle();
    // Deeper than the old segmented scroll's 16-segment cap.
    for (let i = 0; i < 20; i++) await pages.loadMore();
    expect(pages.plan.pages.length).toBeGreaterThan(16);
    const depth = pages.plan.pages.length;

    // Every insert lands at the order's start: in the head page, which is in
    // view (the far pages released).
    await pages.look(0, 1);
    let n = 999;
    for (let i = 0; i < 20; i++, n--) {
      routedAt = routed.length;
      await client.query(`INSERT INTO ${TABLE} (id, n) VALUES ($1, $2)`, [
        `front${i}`,
        n,
      ]);
      await landed(pages, routedAt, `front insert ${i}`);
      await pages.look(0, 1);
      await steady(pages, `front insert ${i} settle`);
      // The head's live pages: the rows up to the first released page are
      // exactly the table's first rows.
      const firstReleased = pages.plan.pages.findIndex((p) => !p.live);
      const a = assemble(pages.plan, pages.observe);
      const prefix = a.entries
        .slice(
          0,
          firstReleased === -1 ? a.entries.length : a.firstOf[firstReleased],
        )
        .map((e) => e.id);
      expect(prefix).toEqual(await orderedIds(prefix.length));
    }
    expect(pages.plan.pages.length).toBeGreaterThan(depth);

    await pages.lookAtAll();
    await steady(pages, "all in view");
    const all = pages.ids();
    expect(all).toEqual(await orderedIds(all.length));
  }, 240_000);
});
