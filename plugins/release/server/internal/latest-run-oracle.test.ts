/**
 * Differential oracle for the release info's "newest run" read (I7c of
 * research/2026-10-01-global-scoped-change-routing-p5-p8-v2.md): the
 * `release.history` window at limit 1, scoped to one composition — what the
 * Deploy app's `useReleaseInfo` subscribes in place of the deleted
 * `GET /api/release/latest` + `release.history-revision` tick — on a throwaway
 * database seeded with the real migration chain, through the REAL feed: the
 * real `releaseHistory` declaration compiled as `release-runs-resource.ts`
 * serves it (this namespace's runs only), registered on a resource runtime of
 * the suite's own, the change-feed's routed triggers installed from the routes
 * it registered, its LISTEN consumer, and the feed's own routing
 * (`createChangeRouter`).
 *
 * A seeded random workload of the engine's own writes runs one statement at a
 * time: a release claimed (INSERT — in this namespace or another, whose rows a
 * worktree inherits through its fork and must never see), its child's pid
 * recorded, its row closed (the guarded UPDATE `closeReleaseRow` makes), and a
 * row deleted. After every statement:
 *
 * - every subscribed tuple's client view equals a fresh FULL load of it;
 * - no tuple is reloaded FULL: every change names its run ids;
 * - every refill names only runs the statement changed, or a run the tuple
 *   now holds that one of them made room for (the next-newest run, when the
 *   newest is deleted).
 *
 * Requires a running Postgres cluster (started by ./singularity build).
 * Run: `./singularity test plugins/release`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, isNull, sql } from "drizzle-orm";
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
import { releaseHistory } from "../../core/resources";
import { _releaseRuns } from "./tables";
import { releaseRunIdKind } from "@plugins/release/plugins/bundles/core";

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
// loads `release/server` (directly, or through a barrel import of a plugin
// that reads it) registers the real `release.history` on the global registry
// at module eval — so registering it there too throws `defineResource:
// duplicate key`, whichever suite loads second (the events-core source-runs
// oracle does the same, for the same reason).
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

/** The serving backend's namespace, and one whose rows it inherited. */
const NS = "oracle-ns";
const FOREIGN_NS = "singularity";
const COMPOSITIONS = ["comp-a", "comp-b"] as const;

beforeAll(async () => {
  testDb = await createTestDb({ prefix: "release_latest_oracle" });
  await runMigrations(testDb.db);
  // The collection's resources, compiled from the REAL declaration with the
  // options `release-runs-resource.ts` serves it with (its base predicate over
  // a fixed namespace: a test process declares none) — registered on the
  // suite's runtime `routeChange` feeds, every loader run recorded. No
  // custom-column sets: none are contributed here.
  const specs = compileCollection(releaseHistory, {
    from: _releaseRuns,
    where: (j) => eq(j.base.namespace, NS),
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
    releaseHistory.window,
    specs.window,
  ).serverOpts;
  runtime.defineResource(releaseHistory.window, {
    ...windowOpts,
    loader: record(releaseHistory.key, windowOpts.loader),
  });
  truth.set(releaseHistory.key, (p) => windowOpts.loader(p as never));

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
    coveredTables: () => ["release_runs"],
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

const w = releaseHistory.window.window;
// Exactly the query `useReleaseInfo` reads, once per composition.
const TUPLES: Array<{ key: string; params: ResourceParams }> = COMPOSITIONS.map(
  (composition) => ({
    key: releaseHistory.key,
    params: w.encode({
      where: { composition: { eq: composition } },
      orderBy: [["startedAt", "desc"]],
      limit: 1,
    }),
  }),
);

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

/** A tuple's value as compared: each row's fields as a set (`sortedKeys`). */
function comparable(value: unknown): string {
  return JSON.stringify(Array.isArray(value) ? value.map(sortedKeys) : value);
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

describe("release.history at limit 1 — the newest run, scoped differential oracle", () => {
  test("the collection routes release_runs", () => {
    expect(
      runtime.routedTableRequirements().some((r) => r.table === "release_runs"),
    ).toBe(true);
  });

  test("random engine writes: every view converges to a fresh load, refills stay O(changed)", async () => {
    const rand = prng(7171);
    const any = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
    interface Present {
      namespace: string;
      composition: string;
      open: boolean;
    }
    const present = new Map<string, Present>();
    let nextRun = 0;
    let clock = 0;

    /** Claim a release: refused (as the in-flight index would) when one is open. */
    const claim = async (): Promise<string | null> => {
      const namespace = rand() < 0.75 ? NS : FOREIGN_NS;
      const composition = any(COMPOSITIONS);
      const open = [...present.values()].some(
        (p) =>
          p.open && p.namespace === namespace && p.composition === composition,
      );
      if (open) return null;
      const id = releaseRunIdKind.key(`run-${nextRun++}`);
      clock += 1 + Math.floor(rand() * 5);
      await testDb.db.insert(_releaseRuns).values({
        id,
        composition,
        target: rand() < 0.8 ? "web" : "tauri",
        namespace,
        kind: rand() < 0.6 ? "candidate" : "staged",
        startedAt: new Date(T0 + clock * 60_000),
        pid: 1000 + nextRun,
      });
      present.set(id, { namespace, composition, open: true });
      return id;
    };

    for (let i = 0; i < 6; i++) {
      const id = await claim();
      if (id !== null) {
        // Seed a closed history, so the newest is not always the open one.
        await testDb.db
          .update(_releaseRuns)
          .set({
            status: "succeeded",
            finishedAt: new Date(T0 + clock * 60_000 + 30_000),
            exitCode: 0,
            platform: "linux-x64",
          })
          .where(eq(_releaseRuns.id, releaseRunIdKind.key(id)));
        present.get(id)!.open = false;
      }
    }
    await until(
      () => routed.some((c) => c.table === "release_runs"),
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
      const openIds = ids.filter((id) => present.get(id)!.open);
      if (r < 0.35 || ids.length < 2) {
        const id = await claim();
        if (id === null) continue;
        const p = present.get(id)!;
        what = `claim ${id} (${p.namespace}/${p.composition})`;
        changed.add(id);
      } else if (r < 0.5 && openIds.length > 0) {
        // The child's pid recorded: a write to a column the window never reads.
        const id = any(openIds);
        what = `setPid ${id}`;
        await testDb.db
          .update(_releaseRuns)
          .set({ pid: 5000 + round })
          .where(eq(_releaseRuns.id, releaseRunIdKind.key(id)));
        changed.add(id);
      } else if (r < 0.85 && openIds.length > 0) {
        // `closeReleaseRow`'s guarded UPDATE.
        const id = any(openIds);
        const succeeded = rand() < 0.6;
        what = `close ${id} → ${succeeded ? "succeeded" : "failed"}`;
        clock += 1;
        await testDb.db
          .update(_releaseRuns)
          .set({
            finishedAt: new Date(T0 + clock * 60_000),
            exitCode: succeeded ? 0 : 1,
            status: succeeded ? "succeeded" : "failed",
            platform: "linux-x64",
            error: succeeded ? null : `boom ${id}`,
          })
          .where(
            and(
              eq(_releaseRuns.id, releaseRunIdKind.key(id)),
              isNull(_releaseRuns.finishedAt),
            ),
          );
        present.get(id)!.open = false;
        changed.add(id);
      } else {
        const id = any(ids);
        what = `delete ${id}`;
        await testDb.db
          .delete(_releaseRuns)
          .where(eq(_releaseRuns.id, releaseRunIdKind.key(id)));
        present.delete(id);
        changed.add(id);
      }
      history.push(what);

      await until(
        () =>
          routed
            .slice(routedAt)
            .filter((c) => c.table === "release_runs")
            .flatMap((c) => c.ids ?? [])
            .some((id) => changed.has(id)),
        () => `round ${round} (${what}): its change was never routed`,
      );
      for (const c of routed.slice(routedAt)) {
        if (c.table === "release_runs") expect(c.ids).not.toBeNull();
      }

      const expected = new Map<number, unknown>();
      for (let i = 0; i < TUPLES.length; i++) {
        const t = TUPLES[i]!;
        expected.set(i, await truth.get(t.key)!(t.params));
      }
      const same = (i: number) =>
        comparable(viewOf(TUPLES[i]!.key, TUPLES[i]!.params).value) ===
        comparable(expected.get(i));
      const converged = () => TUPLES.every((_, i) => same(i));
      await until(converged, () => {
        const off = TUPLES.findIndex((_, i) => !same(i));
        return `round ${round} (${what}): tuple ${JSON.stringify(TUPLES[off])} holds ${JSON.stringify(
          viewOf(TUPLES[off]!.key, TUPLES[off]!.params).value,
        )}, a fresh load reads ${JSON.stringify(expected.get(off))}`;
      });
      await quiet();
      expect(converged()).toBe(true);
      // Another namespace's runs never surface.
      for (let i = 0; i < TUPLES.length; i++) {
        for (const row of expected.get(i) as { namespace: string }[]) {
          expect(row.namespace).toBe(NS);
        }
      }

      const roundLoads = loads.slice(loadsAt);
      const holds = (load: Load, id: string) =>
        TUPLES.some(
          (t, i) =>
            t.key === load.key &&
            JSON.stringify(t.params) === load.params &&
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
