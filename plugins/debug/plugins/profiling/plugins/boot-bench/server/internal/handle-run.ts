import { implement } from "@plugins/infra/plugins/endpoints/server";
import {
  measureSubscribeCycle,
  type ResourceParams,
} from "@plugins/framework/plugins/server-core/core";
import {
  assembleBootSnapshot,
  preloadedKeys,
} from "@plugins/infra/plugins/boot-snapshot/server";
import { clearPersistedSnapshots } from "@plugins/database/plugins/live-state-snapshot/server";
import {
  getRuntimeProfile,
  resetRuntimeProfile,
  waitSplit,
  type Aggregate,
} from "@plugins/infra/plugins/runtime-profiler/core";
import {
  bootBenchRun,
  type IterResult,
  type SnapshotBytes,
} from "../../shared/endpoints";
import { resolveFixtures } from "./fixtures";
import { resetEldProbe, readEldProbe } from "./eld-probe";
import { startHostGateLoad } from "./load-generator";
import { readSnapshotBloat, type SnapshotBloat } from "./snapshot-bloat";
import { measureSnapshotBytes } from "./snapshot-bytes";

const DEFAULT_ITERATIONS = 10;
const DEFAULT_WARMUP = 2;

// commits-graph's `whileSubscribed` stop evicts its per-worktree git memo via a
// DETACHED promise (`void worktreeFor(id).then(evict)`), so the memo is not
// guaranteed clear when measureSubscribeCycle returns. This fixed one-shot settle
// gives that eviction time to land before the next (cold) iteration reads a warm
// memo. Known footgun — a follow-up makes that stop awaitable so this is no
// longer needed; do NOT replace it with a polling loop.
const SETTLE_MS = 150;

type ProfileEntry = IterResult["runtimeProfile"]["loaders"][number];

// Map every runtime-profiler aggregate (loader or db) to its per-call wall-clock
// decomposition, rounding at the edge for readability (matching the runtime MCP
// tool). `waits` holds the per-call amortized wait union by layer; `selfMs` is
// own work (wall − union(waits ∪ direct children)), `childMs` the direct-child
// union. Sorted by avg duration desc. The boot burst touches only a handful of
// labels, so the full (small) list is captured rather than a top-N slice.
function toProfileEntries(aggs: Aggregate[]): ProfileEntry[] {
  return aggs
    .map((agg): ProfileEntry => {
      const ws = waitSplit(agg);
      const waits: Record<string, number> = {};
      for (const layer in ws.waits) waits[layer] = Math.round(ws.waits[layer]!);
      return {
        label: agg.label,
        count: agg.count,
        avgMs: Math.round(ws.avgMs),
        selfMs: Math.round(ws.selfMs),
        childMs: Math.round(ws.childMs),
        maxMs: agg.maxMs,
        waits: Object.keys(waits).length > 0 ? waits : undefined,
      };
    })
    .sort((a, b) => b.avgMs - a.avgMs);
}

// Peak per-call heavy-read wait (acquire + local) across the burst's own loader
// entries — the in-process proof the gate was contended this iteration. Read from
// the measured profile, NOT the host queue-depth gauge (wrong tier — a host-wide
// gauge can't be attributed to this burst).
function peakGateWait(loaders: Aggregate[]): number {
  let peak = 0;
  for (const agg of loaders) {
    const { waits } = waitSplit(agg);
    const local =
      (waits["heavy-read-acquire"] ?? 0) + (waits["heavy-read-local"] ?? 0);
    if (local > peak) peak = local;
  }
  return peak;
}

export const handleBootBenchRun = implement(bootBenchRun, async ({ body }) => {
  const iterations = body.iterations ?? DEFAULT_ITERATIONS;
  const warmup = body.warmup ?? DEFAULT_WARMUP;
  const mode = body.mode ?? "both";
  const loadConcurrency = body.loadConcurrency ?? 0;

  const fixtures = await resolveFixtures(body);

  // Fixed first-subscribe target set. A null fixture id means the target is
  // skipped (reported null in the result) rather than crashing the run.
  const targetSpecs: [key: string, params: ResourceParams | null][] = [
    [
      "edited-files",
      fixtures.conversationId ? { id: fixtures.conversationId } : null,
    ],
    [
      "commits-graph.graph",
      fixtures.attemptId ? { attemptId: fixtures.attemptId } : null,
    ],
  ];
  const liveTargets = targetSpecs.filter(
    (t): t is [string, ResourceParams] => t[1] !== null,
  );
  const skippedKeys = targetSpecs.filter((t) => t[1] === null).map((t) => t[0]);

  async function runIteration(cold: boolean): Promise<IterResult> {
    if (cold) await clearPersistedSnapshots(preloadedKeys());

    // Saturate the host-wide heavy-read gate BEFORE opening the measurement window
    // so the burst is forced onto the real broker wait path. Occupants emit no
    // spans (runWithoutProfiling) and release on stop().
    const load =
      loadConcurrency > 0 ? await startHostGateLoad(loadConcurrency) : null;

    // Open clean measurement windows immediately before the burst.
    resetEldProbe();
    resetRuntimeProfile();

    // Reproduce the boot burst: ONE Promise.all over DISTINCT keys (distinct
    // inflight slots → real concurrent loader contention; same-key concurrency
    // would wrongly collapse via single-flight).
    const [snap, ...subs] = await Promise.all([
      (async () => {
        const t = performance.now();
        // Cold mode bypasses the memory path too: a cleared L2 must measure the
        // loaders, not a persisted alias's kept in-memory snapshot.
        const r = await assembleBootSnapshot({ memory: !cold });
        return {
          totalMs: performance.now() - t,
          perKey: r.timings,
          persistedReadMs: r.persistedReadMs,
        };
      })(),
      ...liveTargets.map(([key, params]) =>
        measureSubscribeCycle(key, params).then(
          (v): [string, { onFirstSubscribeMs: number; loaderMs: number }] => [
            key,
            v,
          ],
        ),
      ),
    ]);

    const eventLoop = readEldProbe();
    const profile = getRuntimeProfile();

    // Release occupants AFTER reading the probes (the burst's waits are already
    // recorded). Fails loudly if an occupant rejected.
    if (load) await load.stop();

    const firstSubscribe: IterResult["firstSubscribe"] = {};
    for (const key of skippedKeys) firstSubscribe[key] = null;
    for (const [key, v] of subs) firstSubscribe[key] = v;

    const loaders = toProfileEntries(profile.aggregates.loader);
    const db = toProfileEntries(profile.aggregates.db);

    return {
      bootSnapshot: {
        totalMs: snap.totalMs,
        perKey: snap.perKey,
        persistedReadMs: snap.persistedReadMs,
      },
      firstSubscribe,
      eventLoop,
      runtimeProfile: { loaders, db },
      ...(load
        ? {
            load: {
              concurrency: loadConcurrency,
              peakGateWaitMs: peakGateWait(profile.aggregates.loader),
            },
          }
        : {}),
    };
  }

  async function runSet(cold: boolean, count: number): Promise<IterResult[]> {
    const out: IterResult[] = [];
    for (let i = 0; i < count; i++) {
      out.push(await runIteration(cold));
      // Bounded settle so detached teardown (commits-graph eviction) lands before
      // the next iteration. One-shot, never a polling loop.
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    }
    return out;
  }

  // The snapshot's bytes: one extra assemble, OUTSIDE the timed burst (the
  // set's warmup iterations absorb whatever it warmed). The same path the mode
  // measures, so a cold capture reads no kept in-memory snapshot.
  const measureBytes = async (cold: boolean): Promise<SnapshotBytes> =>
    measureSnapshotBytes(await assembleBootSnapshot({ memory: !cold }));

  // WARM iterations run BEFORE any cold-clear (the snapshot is naturally warm on a
  // running backend). Discard the first `warmup` of each set to absorb GC. Capture
  // each mode's snapshot bloat ONCE at the start of its set — before any cold-clear
  // DELETE churns `live_state_snapshot` (the very table being measured) — and its
  // snapshot bytes right after.
  let warm: IterResult[] | undefined;
  let warmBloat: SnapshotBloat | undefined;
  let warmBytes: SnapshotBytes | undefined;
  if (mode !== "cold") {
    warmBloat = await readSnapshotBloat();
    warmBytes = await measureBytes(false);
    warm = (await runSet(false, warmup + iterations)).slice(warmup);
  }

  let cold: IterResult[] | undefined;
  let coldBloat: SnapshotBloat | undefined;
  let coldBytes: SnapshotBytes | undefined;
  if (mode !== "warm") {
    coldBloat = await readSnapshotBloat();
    coldBytes = await measureBytes(true);
    cold = (await runSet(true, warmup + iterations)).slice(warmup);
  }

  return {
    fixtures,
    runs: { cold, warm },
    snapshotBloat: { cold: coldBloat, warm: warmBloat },
    snapshotBytes: { cold: coldBytes, warm: warmBytes },
  };
});
