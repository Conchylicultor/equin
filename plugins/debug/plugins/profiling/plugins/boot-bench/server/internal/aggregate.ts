import type {
  IterResult,
  BootBenchRunResponse,
  SnapshotBytes,
} from "../../shared/endpoints";

export interface Stat {
  min: number;
  median: number;
  p95: number;
}

// Linear-interpolation percentile (numpy default): for p=50 this is the true
// median (mean of the two middle values on an even count). Caller passes a list
// already validated non-empty.
function percentile(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 1) return sorted[0]!;
  const rank = (p / 100) * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  const w = rank - lo;
  return sorted[lo]! * (1 - w) + sorted[hi]! * w;
}

export function min(xs: number[]): number {
  if (xs.length === 0) throw new Error("min of empty array");
  return Math.min(...xs);
}

export function median(xs: number[]): number {
  if (xs.length === 0) throw new Error("median of empty array");
  return percentile(
    [...xs].sort((a, b) => a - b),
    50,
  );
}

export function p95(xs: number[]): number {
  if (xs.length === 0) throw new Error("p95 of empty array");
  return percentile(
    [...xs].sort((a, b) => a - b),
    95,
  );
}

export function stat(xs: number[]): Stat {
  return { min: min(xs), median: median(xs), p95: p95(xs) };
}

// Per runtime-profiler label (loader or db): each metric aggregated across the
// iterations where that label appeared, plus a Stat per wait layer over the
// iterations where that label charged that layer.
export interface ProfileAggregate {
  avgMs: Stat;
  selfMs: Stat;
  childMs: Stat;
  maxMs: Stat;
  waits: Record<string, Stat>;
}

export interface ModeAggregate {
  iterations: number;
  bootSnapshotTotalMs: Stat;
  // The single batched persisted-snapshot read, aggregated across iterations.
  bootSnapshotPersistedReadMs: Stat;
  // Per boot-critical key: where the value came from and the (amortized for
  // persisted) work cost across iterations.
  bootSnapshotPerKey: Record<string, { source: string; workMs: Stat }>;
  // Per first-subscribe target: aggregated latency, or null when the fixture was
  // missing so the target was skipped every iteration.
  firstSubscribe: Record<
    string,
    { loaderMs: Stat; onFirstSubscribeMs: Stat } | null
  >;
  eventLoopMaxMs: Stat;
  // Per-label loader/db wait-vs-work aggregates (union-by-label across iterations).
  loaders: Record<string, ProfileAggregate>;
  db: Record<string, ProfileAggregate>;
  // Present only when the set ran under a host-gate load (loadConcurrency>0).
  load?: { concurrency: number; peakGateWaitMs: Stat };
  // The mode's `live_state_snapshot` bloat, captured once at the start of the set
  // (attached by buildReport — not aggregated over iterations).
  snapshotBloat?: ModeBloat;
  // The mode's boot-snapshot bytes (total / per key / row-key bytes per row),
  // captured once at the start of the set (attached by buildReport).
  snapshotBytes?: SnapshotBytes;
}

type ModeBloat = NonNullable<BootBenchRunResponse["snapshotBloat"]>["cold"];

// Union-by-label aggregation of a per-iteration profile-entry list (loaders or db):
// for each label seen in any iteration, aggregate avg/self/child/max over the
// iterations where it appeared, and a Stat per wait layer over the iterations
// where it waited.
function aggregateProfile(
  iters: IterResult[],
  pick: (it: IterResult) => IterResult["runtimeProfile"]["loaders"],
): Record<string, ProfileAggregate> {
  const labels = new Set<string>();
  for (const it of iters) for (const e of pick(it)) labels.add(e.label);

  const out: Record<string, ProfileAggregate> = {};
  for (const label of labels) {
    const avgMs: number[] = [];
    const selfMs: number[] = [];
    const childMs: number[] = [];
    const maxMs: number[] = [];
    const waitsByLayer: Record<string, number[]> = {};
    for (const it of iters) {
      const e = pick(it).find((x) => x.label === label);
      if (!e) continue;
      avgMs.push(e.avgMs);
      selfMs.push(e.selfMs);
      childMs.push(e.childMs);
      maxMs.push(e.maxMs);
      if (e.waits) {
        for (const layer in e.waits) {
          (waitsByLayer[layer] ??= []).push(e.waits[layer]!);
        }
      }
    }
    const waits: Record<string, Stat> = {};
    for (const layer in waitsByLayer) waits[layer] = stat(waitsByLayer[layer]!);
    out[label] = {
      avgMs: stat(avgMs),
      selfMs: stat(selfMs),
      childMs: stat(childMs),
      maxMs: stat(maxMs),
      waits,
    };
  }
  return out;
}

export function aggregateMode(iters: IterResult[]): ModeAggregate {
  if (iters.length === 0) throw new Error("aggregateMode: empty iteration set");

  const perKeyKeys = new Set<string>();
  for (const it of iters) {
    for (const k of Object.keys(it.bootSnapshot.perKey)) perKeyKeys.add(k);
  }
  const bootSnapshotPerKey: ModeAggregate["bootSnapshotPerKey"] = {};
  for (const k of perKeyKeys) {
    const vals: number[] = [];
    const sources = new Set<string>();
    for (const it of iters) {
      const e = it.bootSnapshot.perKey[k];
      if (e) {
        vals.push(e.workMs);
        sources.add(e.source);
      }
    }
    bootSnapshotPerKey[k] = {
      source: sources.size === 1 ? [...sources][0]! : "mixed",
      workMs: stat(vals),
    };
  }

  const fsKeys = new Set<string>();
  for (const it of iters) {
    for (const k of Object.keys(it.firstSubscribe)) fsKeys.add(k);
  }
  const firstSubscribe: ModeAggregate["firstSubscribe"] = {};
  for (const k of fsKeys) {
    const loaderMs: number[] = [];
    const onFirstSubscribeMs: number[] = [];
    for (const it of iters) {
      const e = it.firstSubscribe[k];
      if (e) {
        loaderMs.push(e.loaderMs);
        onFirstSubscribeMs.push(e.onFirstSubscribeMs);
      }
    }
    firstSubscribe[k] =
      loaderMs.length > 0
        ? {
            loaderMs: stat(loaderMs),
            onFirstSubscribeMs: stat(onFirstSubscribeMs),
          }
        : null;
  }

  // Carry the per-iteration load summary through: concurrency is constant across a
  // set, peakGateWaitMs aggregated over the iterations that ran under load.
  const loadIters = iters
    .map((it) => it.load)
    .filter((l): l is NonNullable<IterResult["load"]> => l !== undefined);
  const load =
    loadIters.length > 0
      ? {
          concurrency: loadIters[0]!.concurrency,
          peakGateWaitMs: stat(loadIters.map((l) => l.peakGateWaitMs ?? 0)),
        }
      : undefined;

  return {
    iterations: iters.length,
    bootSnapshotTotalMs: stat(iters.map((it) => it.bootSnapshot.totalMs)),
    bootSnapshotPersistedReadMs: stat(
      iters.map((it) => it.bootSnapshot.persistedReadMs),
    ),
    bootSnapshotPerKey,
    firstSubscribe,
    eventLoopMaxMs: stat(iters.map((it) => it.eventLoop.maxMs)),
    loaders: aggregateProfile(iters, (it) => it.runtimeProfile.loaders),
    db: aggregateProfile(iters, (it) => it.runtimeProfile.db),
    ...(load ? { load } : {}),
  };
}

export interface BootBenchReport {
  fixtures: BootBenchRunResponse["fixtures"];
  scope: string;
  modes: { cold?: ModeAggregate; warm?: ModeAggregate };
}

export function buildReport(res: BootBenchRunResponse): BootBenchReport {
  // Attach each mode's once-per-set captures — bloat and snapshot bytes (not
  // aggregated over iterations).
  const cold = res.runs.cold ? aggregateMode(res.runs.cold) : undefined;
  if (cold && res.snapshotBloat?.cold)
    cold.snapshotBloat = res.snapshotBloat.cold;
  if (cold && res.snapshotBytes?.cold)
    cold.snapshotBytes = res.snapshotBytes.cold;
  const warm = res.runs.warm ? aggregateMode(res.runs.warm) : undefined;
  if (warm && res.snapshotBloat?.warm)
    warm.snapshotBloat = res.snapshotBloat.warm;
  if (warm && res.snapshotBytes?.warm)
    warm.snapshotBytes = res.snapshotBytes.warm;

  return {
    fixtures: res.fixtures,
    scope:
      "live-server cold: clears the L2 persisted snapshot (no restart); excludes server-boot work (catch-up, derived-table rebuild, pool warm)",
    modes: { cold, warm },
  };
}
