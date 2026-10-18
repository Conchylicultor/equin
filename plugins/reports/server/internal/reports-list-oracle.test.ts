/**
 * Differential oracle for `reports.list` fed by its change PRODUCER (P5 of
 * research/2026-10-01-global-scoped-change-routing-p5-p8.md), on a throwaway
 * database seeded with the real migration chain: the real `reportsList`
 * declaration compiled exactly as its `serveCollection` compiles it, registered
 * on a resource runtime of the suite's own, and the real `reportsProducer`
 * mounted with `mountProducersForTest` routing into the feed's own routing
 * (`createChangeRouter`) — no trigger, no LISTEN consumer: `reports` has none.
 *
 * A random workload of the table's four writes, each through the REAL writer
 * — report upserts (`writeReport`, the rate-limited flag included), investigate
 * links (`linkReportTask`, `interactive`, which flushes on its own), noise
 * flips (`setReportNoise`) and retention sweeps (`sweepExpired` with the
 * reports policy's scope) — runs in batches, each closed by
 * a flush of the producer's window (`flushNow`), interleaved with subscribes
 * and unsubscribes of window, point and grouping tuples. After every flush:
 *
 * - every subscribed tuple's client view equals a fresh FULL load of it — the
 *   `:groups` counts included;
 * - no window or point tuple is ever reloaded FULL (the workload stays under
 *   `PRODUCER_IDS_CAP`);
 * - every refill names only ids the batch emitted, or a row the tuple now holds
 *   that one of them made room for (a window's tail entrant).
 *
 * Window tuples are read as head windows (a paged read's first page is one).
 *
 * Requires a running Postgres cluster (started by ./singularity build).
 * Run: `./singularity test plugins/reports`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, inArray, isNull } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import {
  assertRouteTablesCovered,
  createChangeRouter,
  findCarriedProducedRoutes,
  flushNow,
  mountProducersForTest,
} from "@plugins/database/plugins/change-feed/server/testing";
import {
  createResourceRuntime,
  type ResourceParams,
} from "@plugins/framework/plugins/resource-runtime/core";
import { sweepExpired } from "@plugins/infra/plugins/retention/server/testing";
import {
  makeClientView,
  type ClientView,
  type RecordedFrame,
} from "@plugins/framework/plugins/resource-runtime/core/testing";
import type { QueryDb } from "@plugins/infra/plugins/query-resource/server";
import { compileWindowQuery } from "@plugins/infra/plugins/query-resource/server/testing";
import { compileCollection } from "@plugins/network/plugins/live/server/testing";
import { reportsList } from "../../core";
import { writeReport, type ReportUpsertValues } from "./record-report";
import { linkReportTask } from "./investigate";
import { setReportNoise } from "./backfill-noise";
import { reportsProducer } from "./producer";
import { _reports } from "./tables";
import { reportIdKind } from "../../core/id-kind";

interface Load {
  key: string;
  params: string;
  ids: readonly string[] | "FULL";
}

let testDb: TestDb;
let unmount: () => void;
const routed: Parameters<typeof routeChange>[0][] = [];
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
// loads `reports/server` registers the real `reports.list` on the global
// registry at module eval — so registering it there too throws
// `defineResource: duplicate key`, whichever suite loads second (the
// events-core source-runs oracle does the same, for the same reason).
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

beforeAll(async () => {
  testDb = await createTestDb({ prefix: "reports_oracle" });
  await runMigrations(testDb.db);
  // The collection's three resources, compiled from the REAL declaration with
  // the options `list-resource.ts` serves it with, against this database —
  // registered on the suite's runtime `routeChange` feeds, every loader
  // run recorded. (No custom-column sets: none are contributed here.)
  const specs = compileCollection(reportsList, {
    from: _reports,
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
    reportsList.window,
    specs.window,
  ).serverOpts;
  const rowsOpts = compileWindowQuery(reportsList.rows, specs.rows).serverOpts;
  runtime.defineResource(reportsList.window, {
    ...windowOpts,
    loader: record(reportsList.key, windowOpts.loader),
  });
  runtime.defineResource(reportsList.rows, {
    ...rowsOpts,
    loader: record(reportsList.rows.key, rowsOpts.loader),
  });
  runtime.defineResource(reportsList.groups, {
    ...specs.groups,
    loader: record(reportsList.groups.key, specs.groups.loader),
  });
  truth.set(reportsList.key, (p) => windowOpts.loader(p as never));
  truth.set(reportsList.rows.key, (p) => rowsOpts.loader(p as never));
  truth.set(reportsList.groups.key, (p) => specs.groups.loader(p as never));

  // The producer, live without a booted graph, routing into the real router.
  unmount = mountProducersForTest([reportsProducer], {
    route: (change) => {
      routed.push(change);
      routeChange(change);
    },
  });
  handler.open(ws);
}, 30_000);

afterAll(async () => {
  handler.close(ws, 1000, "test");
  unmount?.();
  await testDb?.drop();
});

// ── Tuples ──────────────────────────────────────────────────────────────────

const w = reportsList.window.window;
const g = reportsList.groups.groups;
const POINT_IDS = ["r-fp-0", "r-fp-1", "r-fp-2", "r-fp-3"];
const TUPLES: Array<{ key: string; params: ResourceParams }> = [
  // The default order (last seen, newest first) — the pane's first page.
  { key: reportsList.key, params: w.encode({ limit: 4 }) },
  // Membership by a flipped flag.
  {
    key: reportsList.key,
    params: w.encode({ where: { noise: { eq: false } }, limit: 3 }),
  },
  // Membership by a counter every repeat moves.
  {
    key: reportsList.key,
    params: w.encode({ orderBy: [["count", "desc"]], limit: 3 }),
  },
  // The detail pane's by-id read.
  {
    key: reportsList.rows.key,
    params: reportsList.rows.point.encode(POINT_IDS),
  },
  // The filter options (facets).
  { key: reportsList.groups.key, params: g.encode({ groupBy: "kind" }) },
  { key: reportsList.groups.key, params: g.encode({ groupBy: "source" }) },
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

/**
 * A tuple's value as compared: a point set is unordered (an entrant appends,
 * a fresh load reads in whatever order the database answers), so by id.
 */
function comparable(key: string, value: unknown): string {
  if (!Array.isArray(value)) return JSON.stringify(value);
  const rows = value.map(sortedKeys) as { id: string }[];
  if (key !== reportsList.rows.key) return JSON.stringify(rows);
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

const T0 = Date.parse("2026-10-01T00:00:00.000Z");

describe("reports.list fed by the reports producer — differential oracle", () => {
  test("the compiled routes pass the feed's boot checks for a produced table", () => {
    // What production boot asserts in change-feed's `installFeed`, on the REAL
    // compiled routes: A3p — no route on `reports` needs a carried column (a
    // producer emits ids only; a carried column would degrade every change to
    // a membership refill, which the oracle below would not notice), and A1′
    // — every table the collection depends on has a change source.
    const produced = new Set(["reports"]);
    const keys = new Set([
      reportsList.key,
      reportsList.rows.key,
      reportsList.groups.key,
    ]);
    const requirements = runtime.routedTableRequirements();
    expect(requirements.some((r) => r.table === "reports")).toBe(true);
    expect(findCarriedProducedRoutes(requirements, produced)).toEqual([]);
    const scoped = runtime
      .scopedResourceTables()
      .filter((r) => keys.has(r.key));
    expect(scoped.length).toBeGreaterThan(0);
    expect(() =>
      assertRouteTablesCovered(scoped, produced, new Set(), new Set()),
    ).not.toThrow();
  });

  test("random report writes: every view converges to a fresh load, refills stay O(emitted)", async () => {
    const rand = prng(7171);
    const any = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
    const fingerprints = Array.from({ length: 10 }, (_, i) => `fp-${i}`);
    // fingerprint → the row's id (stable across repeats: the first insert's).
    const present = new Map<string, string>();
    const noise = new Map<string, boolean>();
    let clock = 0;

    const upsert = async (fp: string): Promise<string> => {
      clock += 1 + Math.floor(rand() * 5);
      const v: ReportUpsertValues = {
        // A deterministic id per fingerprint, so the point tuple names rows
        // that come and go.
        id: reportIdKind.key(`r-${fp}`),
        kind: any(["crash", "slow-op", "render-loop"]),
        fingerprint: fp,
        worktree: "wt-oracle",
        source: any(["server-crash", "client-error", "server-caught"]),
        message: `m-${fp}-${clock}`,
        url: null,
        userAgent: null,
        data: { n: clock },
        limited: rand() < 0.3,
        noise: rand() < 0.3,
        clientId: null,
        buildId: null,
        // Occasionally an out-of-order (replayed) occurrence.
        occurredAt: new Date(T0 + (clock - (rand() < 0.2 ? 7 : 0)) * 1000),
      };
      const [row] = await writeReport(v, testDb.db);
      present.set(fp, row!.id);
      noise.set(fp, row!.noise);
      return row!.id;
    };

    // Seed half the fingerprints, then flush once before subscribing.
    for (const fp of fingerprints.slice(0, 5)) await upsert(fp);
    flushNow(reportsProducer);

    const subscribed = new Set<number>();
    for (let i = 0; i < TUPLES.length; i++) {
      await subscribe(TUPLES[i]!.key, TUPLES[i]!.params);
      subscribed.add(i);
    }

    const history: string[] = [];
    let interactiveFlushes = 0;
    for (let round = 0; round < 40; round++) {
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

      const routedAt = routed.length;
      const loadsAt = loads.length;
      // A batch of one to four writes inside one coalescing window. Every
      // write changes at least one row, so the batch always emits.
      const emitted = new Set<string>();
      const batch: string[] = [];
      const writes = 1 + Math.floor(rand() * 4);
      for (let k = 0; k < writes; k++) {
        const ids = [...present.values()];
        const r = rand();
        if (r < 0.5 || ids.length === 0) {
          const fp = any(fingerprints);
          batch.push(`upsert ${fp}`);
          emitted.add(await upsert(fp));
        } else if (r < 0.65) {
          // investigateReport's write: links a task, and flushes at once.
          const id = any(ids);
          batch.push(`investigate ${id}`);
          await linkReportTask(testDb.db, id, `task-${round}-${k}`);
          emitted.add(id);
          interactiveFlushes++;
        } else if (r < 0.85) {
          // The noise backfill's write: one flip.
          const fp = any([...present.keys()]);
          const id = present.get(fp)!;
          const next = !noise.get(fp);
          batch.push(`noise ${id}=${next}`);
          await setReportNoise(testDb.db, id, next);
          emitted.add(id);
          noise.set(fp, next);
        } else {
          // The retention sweep: the reports policy's scope (unlinked rows
          // only), narrowed to a random subset by an extra predicate, with a
          // cutoff every row is older than — through the real sweep body,
          // which deletes a produced table through its producer.
          const doomed = [...present.keys()].filter(() => rand() < 0.35);
          if (doomed.length === 0) doomed.push(any([...present.keys()]));
          batch.push(`sweep ${doomed.join(",")}`);
          await sweepExpired(testDb.db, {
            table: _reports,
            column: _reports.createdAt,
            cutoff: new Date(Date.now() + 86_400_000),
            where: and(
              isNull(_reports.taskId),
              inArray(_reports.fingerprint, doomed),
            ),
          });
          const left = new Set(
            (
              await testDb.db
                .select({ fingerprint: _reports.fingerprint })
                .from(_reports)
                .where(inArray(_reports.fingerprint, doomed))
            ).map((row) => row.fingerprint),
          );
          // A linked report survives the sweep, as in production.
          for (const fp of doomed) {
            if (left.has(fp)) continue;
            emitted.add(present.get(fp)!);
            present.delete(fp);
            noise.delete(fp);
          }
        }
      }
      // Close the window.
      flushNow(reportsProducer);
      history.push(batch.join("; "));
      if (emitted.size === 0) continue; // a sweep that met only linked rows

      await until(
        () =>
          routed
            .slice(routedAt)
            .flatMap((c) => c.ids ?? [])
            .some((id) => emitted.has(id)),
        () =>
          `round ${round} (${batch.join("; ")}): its change was never routed`,
      );
      // Every routed change is the producer's, with ids (never over the cap).
      for (const c of routed.slice(routedAt)) {
        expect(c.source).toBe("producer");
        expect(c.ids).not.toBeNull();
      }

      // Every view converges to a fresh FULL load of its tuple.
      const expected = new Map<number, unknown>();
      for (const i of subscribed) {
        const t = TUPLES[i]!;
        expected.set(i, await truth.get(t.key)!(t.params));
      }
      const same = (i: number) =>
        comparable(
          TUPLES[i]!.key,
          viewOf(TUPLES[i]!.key, TUPLES[i]!.params).value,
        ) === comparable(TUPLES[i]!.key, expected.get(i));
      const converged = () => [...subscribed].every(same);
      await until(converged, () => {
        const off = [...subscribed].find((i) => !same(i))!;
        return `round ${round} (${batch.join("; ")}): tuple ${JSON.stringify(TUPLES[off])} holds ${JSON.stringify(
          viewOf(TUPLES[off]!.key, TUPLES[off]!.params).value,
        )}, a fresh load reads ${JSON.stringify(expected.get(off))}`;
      });
      // Let every late drain land, then re-check.
      await quiet();
      expect(converged()).toBe(true);

      const roundLoads = loads.slice(loadsAt);
      const holds = (load: Load, id: string) =>
        [...subscribed].some((i) => {
          const t = TUPLES[i]!;
          return (
            t.key === load.key &&
            JSON.stringify(t.params) === load.params &&
            Array.isArray(expected.get(i)) &&
            (expected.get(i) as { id?: string }[]).some((r) => r.id === id)
          );
        });
      for (const load of roundLoads) {
        if (load.ids === "FULL") {
          // A grouping recomputes whole — its only shape. A window or point
          // tuple already subscribed is never reloaded whole: every change the
          // producer routes names its ids.
          if (load.key !== reportsList.groups.key) {
            throw new Error(
              `round ${round} (${batch.join("; ")}) loaded ${load.key} ${load.params} FULL — ` +
                `this round's loads: ${JSON.stringify(roundLoads)}; history: ${history.slice(-4).join(" | ")}`,
            );
          }
          continue;
        }
        // Refill ids ⊆ emitted ∪ the tuple's tail entrants.
        const stray = load.ids.filter(
          (id) => !emitted.has(id) && !holds(load, id),
        );
        if (stray.length > 0) {
          throw new Error(
            `round ${round} (${batch.join("; ")}; emitted ${[...emitted].join(",")}) refilled ${JSON.stringify(load.ids)} ` +
              `for ${load.key} ${load.params} — this round's loads: ${JSON.stringify(roundLoads)}; ` +
              `history: ${history.slice(-4).join(" | ")}`,
          );
        }
      }
    }
    // The workload did exercise the interactive flush.
    expect(interactiveFlushes).toBeGreaterThan(0);
  }, 120_000);
});
