/**
 * Differential oracle for `events.source-runs` (I7a of
 * research/2026-10-01-global-scoped-change-routing-p5-p8-v2.md) on a throwaway
 * database seeded with the real migration chain, through the REAL feed: the
 * real `eventSourceRuns` declaration compiled exactly as its `serveCollection`
 * compiles it, registered on a resource runtime of the suite's own, the
 * change-feed's routed triggers installed from the routes it registered, its
 * LISTEN consumer, and the feed's own routing (`createChangeRouter`).
 *
 * The tuples are the ones the app subscribes: the source pane's window scoped
 * to one source (`.scoped({ where: { sourceId } })`), narrowed further by a
 * saved view's filter and re-sorted by a count, a whole-ledger sort, and the
 * run pane's by-id point read. A seeded random workload of the ledger's
 * writes — a run landing (insert), a row rewritten in place, the retention
 * sweep's delete, and a source delete cascading its runs away — runs one
 * statement at a time. After every statement:
 *
 * - every subscribed tuple's client view equals a fresh FULL load of it;
 * - no tuple is reloaded FULL: every change names its run ids;
 * - every refill names only runs the statement changed, or a run the tuple
 *   now holds that one of them made room for (a window's tail entrant).
 *
 * Requires a running Postgres cluster (started by ./singularity build).
 * Run: `./singularity test plugins/apps/plugins/events/plugins/events-core`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import type { FeedChange } from "@plugins/database/plugins/change-feed/server";
import {
  createChangeFeedListener,
  createChangeRouter,
  rebuildTriggers,
} from "@plugins/database/plugins/change-feed/server/testing";
import {
  createResourceRuntime,
  type ResourceParams,
} from "@plugins/framework/plugins/resource-runtime/core";
import {
  makeClientView,
  type ClientView,
  type RecordedFrame,
} from "@plugins/framework/plugins/resource-runtime/core/testing";
import type { QueryDb } from "@plugins/infra/plugins/query-resource/server";
import { compileWindowQuery } from "@plugins/infra/plugins/query-resource/server/testing";
import { compileCollection } from "@plugins/network/plugins/live/server/testing";
import { eventSourceRuns, RUN_OUTCOMES } from "../../core";
import { _eventSourceRuns, _eventSources } from "./tables";
import { eventRunIdKind, eventSourceIdKind } from "../../core";

interface Load {
  key: string;
  params: string;
  ids: readonly string[] | "FULL";
}

let testDb: TestDb;
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

// The suite's OWN runtime, never server-core's process-global one:
// `./singularity test` runs every bun suite in one process, and any suite that
// loads `events-core/server` (a source type's, the refresh engine's) registers
// the real `events.source-runs` on the global registry at module eval — so
// registering it there too throws `defineResource: duplicate key`, whichever
// suite loads second. The tree oracle (`tasks-core/server/testing`) does the
// same for the same reason.
const runtime = createResourceRuntime();
const routeChange = createChangeRouter(runtime);

const handler = runtime.notificationsWsHandler as unknown as {
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

/** Wait (bounded) for a condition the async runtime makes true. */
async function until(cond: () => boolean, what: () => string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what()}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const tupleKey = (key: string, params: ResourceParams) =>
  `${key} ${JSON.stringify(params)}`;

const SOURCES = ["src-a", "src-b", "src-c"] as const;

async function insertSource(id: string): Promise<void> {
  await testDb.db.insert(_eventSources).values({
    id,
    type: "oracle",
    name: id,
    config: {},
    refresh: "daily",
    enabled: true,
    status: "idle",
  } as typeof _eventSources.$inferInsert);
}

beforeAll(async () => {
  testDb = await createTestDb({ prefix: "events_runs_oracle" });
  await runMigrations(testDb.db);
  // The collection's resources, compiled from the REAL declaration with the
  // options `resources.ts` serves it with, against this database — registered
  // on the suite's runtime `routeChange` feeds, every loader run recorded.
  // (No custom-column sets: none are contributed here.)
  const specs = compileCollection(eventSourceRuns, {
    from: _eventSourceRuns,
    db: testDb.db as unknown as QueryDb,
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
    eventSourceRuns.window,
    specs.window,
  ).serverOpts;
  const rowsOpts = compileWindowQuery(
    eventSourceRuns.rows,
    specs.rows,
  ).serverOpts;
  runtime.defineResource(eventSourceRuns.window, {
    ...windowOpts,
    loader: record(eventSourceRuns.key, windowOpts.loader),
  });
  runtime.defineResource(eventSourceRuns.rows, {
    ...rowsOpts,
    loader: record(eventSourceRuns.rows.key, rowsOpts.loader),
  });
  truth.set(eventSourceRuns.key, (p) => windowOpts.loader(p as never));
  truth.set(eventSourceRuns.rows.key, (p) => rowsOpts.loader(p as never));

  for (const id of SOURCES) await insertSource(id);

  // The feed, installed from the routes just registered — the first routed
  // layout on `event_source_runs`.
  await rebuildTriggers(
    testDb.db,
    { feedExempt: new Set(), optedOut: new Set(), produced: new Set() },
    runtime.routedTableRequirements(),
  );
  listener = createChangeFeedListener({
    connectionString: () => testDb.connectionString,
    route: (change) => {
      routed.push(change);
      routeChange(change);
    },
    coveredTables: () => ["event_source_runs", "event_sources"],
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
}, 60_000);

afterAll(async () => {
  handler.close(ws, 1000, "test");
  await listener?.stop();
  await testDb?.drop();
});

// ── Tuples ──────────────────────────────────────────────────────────────────

const w = eventSourceRuns.window.window;
const POINT_IDS = ["run-0", "run-1", "run-2", "run-3", "run-4"];
const TUPLES: Array<{ key: string; params: ResourceParams }> = [
  // The source pane's first segment: one source, newest first.
  {
    key: eventSourceRuns.key,
    params: w.encode({ where: { sourceId: { eq: "src-a" } }, limit: 4 }),
  },
  // The "Failures" saved view, scoped to the same source.
  {
    key: eventSourceRuns.key,
    params: w.encode({
      where: { sourceId: { eq: "src-a" }, outcome: { eq: "failed" } },
      limit: 3,
    }),
  },
  // Another source, re-sorted by a count a rewrite moves.
  {
    key: eventSourceRuns.key,
    params: w.encode({
      where: { sourceId: { eq: "src-c" } },
      orderBy: [["durationMs", "desc"]],
      limit: 3,
    }),
  },
  // The whole ledger by a count.
  {
    key: eventSourceRuns.key,
    params: w.encode({ orderBy: [["eventsFound", "asc"]], limit: 3 }),
  },
  // The run pane's by-id read.
  {
    key: eventSourceRuns.rows.key,
    params: eventSourceRuns.rows.point.encode(POINT_IDS),
  },
];

const views = new Map<string, { view: ClientView; from: number }>();

/**
 * A row's fields compare as a set: a fresh load folds `$columns` after the
 * server-minted `$key`, a client view applies them in frame order.
 */
function sortedKeys(row: unknown): unknown {
  return row !== null && typeof row === "object" && !Array.isArray(row)
    ? Object.fromEntries(
        Object.entries(row).sort(([a], [b]) => (a < b ? -1 : 1)),
      )
    : row;
}

/** A point set is unordered (an entrant appends), so it compares by id. */
function comparable(key: string, value: unknown): string {
  if (!Array.isArray(value)) return JSON.stringify(value);
  const rows = value.map(sortedKeys) as { id: string }[];
  if (key !== eventSourceRuns.rows.key) return JSON.stringify(rows);
  return JSON.stringify(rows.sort((a, b) => (a.id < b.id ? -1 : 1)));
}

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

const T0 = Date.parse("2026-10-01T00:00:00.000Z");

describe("events.source-runs — scoped differential oracle", () => {
  test("the collection routes event_source_runs", () => {
    expect(
      runtime
        .routedTableRequirements()
        .some((r) => r.table === "event_source_runs"),
    ).toBe(true);
  });

  test("random ledger writes: every view converges to a fresh load, refills stay O(changed)", async () => {
    const rand = prng(4242);
    const any = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
    // run id → its source.
    const present = new Map<string, string>();
    let nextRun = 0;
    let clock = 0;

    const insertRun = async (): Promise<string> => {
      const id = eventRunIdKind.key(`run-${nextRun++}`);
      const sourceId = any(SOURCES);
      clock += 1 + Math.floor(rand() * 5);
      const startedAt = new Date(T0 + clock * 60_000);
      const outcome = any(RUN_OUTCOMES);
      await testDb.db.insert(_eventSourceRuns).values({
        id,
        sourceId,
        startedAt,
        finishedAt: new Date(startedAt.getTime() + 5_000),
        outcome,
        eventsFound: Math.floor(rand() * 8),
        eventsCreated: Math.floor(rand() * 3),
        eventsUpdated: Math.floor(rand() * 3),
        eventsDisappeared: Math.floor(rand() * 2),
        fingerprint: rand() < 0.5 ? `fp-${id}` : null,
        // Some runs never recorded one: a NULL sorts among the counts.
        durationMs: rand() < 0.2 ? null : Math.floor(rand() * 10_000),
        error: outcome === "failed" ? `boom ${id}` : null,
        flags: rand() < 0.2 ? ["a caveat"] : [],
      });
      present.set(id, sourceId);
      return id;
    };

    for (let i = 0; i < 10; i++) await insertRun();
    await until(
      () => routed.some((c) => c.table === "event_source_runs"),
      () => "seed changes",
    );
    await quiet();
    for (const t of TUPLES) await subscribe(t.key, t.params);

    const history: string[] = [];
    for (let round = 0; round < 40; round++) {
      const routedAt = routed.length;
      const loadsAt = loads.length;
      const changed = new Set<string>();
      let what: string;
      const r = rand();
      const ids = [...present.keys()];
      if (r < 0.4 || ids.length < 3) {
        const id = await insertRun();
        what = `insert ${id} (${present.get(id)})`;
        changed.add(id);
      } else if (r < 0.7) {
        // A row rewritten in place: the outcome, a count and the duration.
        const id = any(ids);
        const outcome = any(RUN_OUTCOMES);
        what = `rewrite ${id} → ${outcome}`;
        await testDb.db
          .update(_eventSourceRuns)
          .set({
            outcome,
            eventsFound: Math.floor(rand() * 8),
            durationMs: Math.floor(rand() * 10_000),
            error: outcome === "failed" ? `rewritten ${id}` : null,
          })
          .where(eq(_eventSourceRuns.id, eventRunIdKind.key(id)));
        changed.add(id);
      } else if (r < 0.9) {
        // The retention sweep: a multi-row delete.
        const doomed = ids.filter(() => rand() < 0.25);
        if (doomed.length === 0) doomed.push(any(ids));
        what = `sweep ${doomed.join(",")}`;
        await testDb.db
          .delete(_eventSourceRuns)
          .where(inArray(_eventSourceRuns.id, doomed.map(eventRunIdKind.key)));
        for (const id of doomed) {
          changed.add(id);
          present.delete(id);
        }
      } else {
        // A source deleted: its runs cascade away; then it comes back empty.
        const sourceId = any(SOURCES);
        const cascaded = ids.filter((id) => present.get(id) === sourceId);
        what = `delete source ${sourceId} (${cascaded.length} runs)`;
        await testDb.db
          .delete(_eventSources)
          .where(eq(_eventSources.id, eventSourceIdKind.key(sourceId)));
        await insertSource(sourceId);
        for (const id of cascaded) {
          changed.add(id);
          present.delete(id);
        }
      }
      history.push(what);
      if (changed.size === 0) continue;

      await until(
        () =>
          routed
            .slice(routedAt)
            .filter((c) => c.table === "event_source_runs")
            .flatMap((c) => c.ids ?? [])
            .some((id) => changed.has(id)),
        () => `round ${round} (${what}): its change was never routed`,
      );
      // Every ledger change names its run ids.
      for (const c of routed.slice(routedAt)) {
        if (c.table === "event_source_runs") expect(c.ids).not.toBeNull();
      }

      const expected = new Map<number, unknown>();
      for (let i = 0; i < TUPLES.length; i++) {
        const t = TUPLES[i]!;
        expected.set(i, await truth.get(t.key)!(t.params));
      }
      const same = (i: number) =>
        comparable(
          TUPLES[i]!.key,
          viewOf(TUPLES[i]!.key, TUPLES[i]!.params).value,
        ) === comparable(TUPLES[i]!.key, expected.get(i));
      const converged = () => TUPLES.every((_, i) => same(i));
      await until(converged, () => {
        const off = TUPLES.findIndex((_, i) => !same(i));
        return `round ${round} (${what}): tuple ${JSON.stringify(TUPLES[off])} holds ${JSON.stringify(
          viewOf(TUPLES[off]!.key, TUPLES[off]!.params).value,
        )}, a fresh load reads ${JSON.stringify(expected.get(off))}`;
      });
      await quiet();
      expect(converged()).toBe(true);

      const roundLoads = loads.slice(loadsAt);
      const holds = (load: Load, id: string) =>
        TUPLES.some(
          (t, i) =>
            t.key === load.key &&
            JSON.stringify(t.params) === load.params &&
            Array.isArray(expected.get(i)) &&
            (expected.get(i) as { id?: string }[]).some((row) => row.id === id),
        );
      for (const load of roundLoads) {
        if (load.ids === "FULL") {
          throw new Error(
            `round ${round} (${what}) loaded ${load.key} ${load.params} FULL — ` +
              `this round's loads: ${JSON.stringify(roundLoads)}; history: ${history.slice(-4).join(" | ")}`,
          );
        }
        const stray = load.ids.filter(
          (id) => !changed.has(id) && !holds(load, id),
        );
        if (stray.length > 0) {
          throw new Error(
            `round ${round} (${what}; changed ${[...changed].join(",")}) refilled ${JSON.stringify(load.ids)} ` +
              `for ${load.key} ${load.params} — this round's loads: ${JSON.stringify(roundLoads)}; ` +
              `history: ${history.slice(-4).join(" | ")}`,
          );
        }
      }
    }
  }, 180_000);
});
