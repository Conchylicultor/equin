// Module-level, in-process accumulator of per-resource live-state push outcomes.
// PURE MEMORY — no DB writes (like health-monitor's module-level counters). The
// resource-runtime fires `recordPush` once per keyed or value recompute for >=1
// subscriber (an unchanged value recompute — no frame — as a no-op); we
// bucket those outcomes so the scheduled monitor can read a trailing-window rate
// without touching the DB.
//
// Bucket math: each tracked key keeps a ring of 1-second buckets covering the
// max supported window (MAX_WINDOW_SECONDS). Bucket index for a wall-clock
// millisecond `ms` is `floor(ms / 1000) mod RING_SIZE`. Each bucket records the
// epoch-second it currently represents (`sec`) so a stale bucket (left over from
// >RING_SIZE seconds ago) is detected and cleared lazily on next touch — no
// background sweeping. `total` counts every push, `noop` only the empty-diff
// (`!changed`) ones, and the `noop*Ms` sums what those no-ops cost (the
// runtime's `RecomputeCost`: own work, io waited on, every wait) — a no-op whose
// cost the host did not measure counts in `noopUnmeasured` instead. A window query sums buckets whose `sec` lies within the
// trailing `windowSeconds`. Everything is O(1) per push and O(windowSeconds) per
// snapshot per key — both bounded by the constants below.
//
// What a no-op is CHARGED (`wastedMsPerMinute`) is not what it measured. A
// no-op recomputes one tuple's value from the same rows to the same answer, so
// its runs do the same work, and whatever else a run's own time holds — the
// host's CPU contention, our event loop busy with other work, Postgres and
// PgBouncer starved, a round trip waiting to be read — only ever ADDS to it.
// So each bucket keeps, per tuple, its measured no-ops and the cheapest one
// (`Bucket.tuples`), and the window charges every no-op of a tuple at that
// tuple's cheapest run in the window: never below the work a run did, and
// free of what the busy host added. Measured on main (2026-11-14 23:43 UTC,
// load 57 on 18 cores, the backend's event loop p99 451 ms):
// `tasks.tree.v2:groups` measured ~50 ms per no-op against its ~3 ms quiet
// cost, and the burst filed seven resources at once. A tuple whose every run
// is costly still files at its cheapest — an expensive no-op is never hidden.

const MAX_WINDOW_SECONDS = 600;
const RING_SIZE = MAX_WINDOW_SECONDS;
// Cap distinct tracked keys; the least-recently-active is evicted past this. A
// keyed resource churning on one key can never grow memory unbounded, and a flood
// of distinct keys is bounded to this many ring buffers.
const MAX_KEYS = 512;
// Cap distinct tuples remembered per bucket (one key, one second). A no-op of a
// tuple past the cap is charged what it measured (`Bucket.overflowMs`): the
// cap can only make a report costlier, never hide one.
const MAX_TUPLES_PER_BUCKET = 32;

/** One tuple's measured no-ops in one bucket. */
interface TupleNoops {
  count: number;
  /** The cheapest of them: own work + io, ms. */
  minMs: number;
}

interface Bucket {
  // Epoch-second this bucket currently represents. -1 = never written.
  sec: number;
  total: number;
  noop: number;
  noopOwnMs: number;
  noopIoMs: number;
  noopWaitMs: number;
  noopUnmeasured: number;
  /** Measured no-ops per tuple (canonical params key), at most MAX_TUPLES_PER_BUCKET. */
  tuples: Map<string, TupleNoops>;
  /** Own work + io of measured no-ops whose tuple found the bucket full, ms. */
  overflowMs: number;
}

/** What one recompute cost, as `onResourcePush` hands it (`null`: not measured). */
export interface PushCost {
  ownMs: number;
  waitMs: number;
  ioMs: number;
}

/** One push outcome, as `onResourcePush` hands it. */
export interface PushInfo {
  /** The recomputed tuple (its canonical params key). */
  tuple: string;
  subscribers: number;
  changed: boolean;
  cost: PushCost | null;
}

function emptyBucket(sec: number): Bucket {
  return {
    sec,
    total: 0,
    noop: 0,
    noopOwnMs: 0,
    noopIoMs: 0,
    noopWaitMs: 0,
    noopUnmeasured: 0,
    tuples: new Map(),
    overflowMs: 0,
  };
}

interface KeyState {
  buckets: Bucket[];
  subscribers: number;
  lastActiveMs: number;
}

const states = new Map<string, KeyState>();

function makeBuckets(): Bucket[] {
  const arr: Bucket[] = new Array(RING_SIZE);
  for (let i = 0; i < RING_SIZE; i++) arr[i] = emptyBucket(-1);
  return arr;
}

function evictIfNeeded(): void {
  if (states.size <= MAX_KEYS) return;
  let oldestKey: string | undefined;
  let oldestMs = Infinity;
  for (const [k, s] of states) {
    if (s.lastActiveMs < oldestMs) {
      oldestMs = s.lastActiveMs;
      oldestKey = k;
    }
  }
  if (oldestKey !== undefined) states.delete(oldestKey);
}

// Touch the bucket for `nowMs`, clearing it first if it holds a stale second.
function touchBucket(state: KeyState, nowMs: number): Bucket {
  const sec = Math.floor(nowMs / 1000);
  const idx = ((sec % RING_SIZE) + RING_SIZE) % RING_SIZE;
  const bucket = state.buckets[idx]!;
  if (bucket.sec !== sec) Object.assign(bucket, emptyBucket(sec));
  return bucket;
}

// Internal, clock-injectable core of recordPush (deterministic for tests).
export function recordPushAt(key: string, info: PushInfo, nowMs: number): void {
  let state = states.get(key);
  if (!state) {
    state = { buckets: makeBuckets(), subscribers: info.subscribers, lastActiveMs: nowMs };
    states.set(key, state);
    evictIfNeeded();
  }
  state.subscribers = info.subscribers;
  state.lastActiveMs = nowMs;
  const bucket = touchBucket(state, nowMs);
  bucket.total += 1;
  if (info.changed) return;
  bucket.noop += 1;
  if (info.cost === null) {
    bucket.noopUnmeasured += 1;
    return;
  }
  bucket.noopOwnMs += info.cost.ownMs;
  bucket.noopIoMs += info.cost.ioMs;
  bucket.noopWaitMs += info.cost.waitMs;
  const runMs = info.cost.ownMs + info.cost.ioMs;
  const t = bucket.tuples.get(info.tuple);
  if (t) {
    t.count += 1;
    if (runMs < t.minMs) t.minMs = runMs;
  } else if (bucket.tuples.size < MAX_TUPLES_PER_BUCKET) {
    bucket.tuples.set(info.tuple, { count: 1, minMs: runMs });
  } else {
    bucket.overflowMs += runMs;
  }
}

export interface KeySnapshot {
  resourceKey: string;
  noopCount: number;
  totalCount: number;
  subscribers: number;
  noopRate: number;
  /** The no-op recomputes' own work over the window (server thread + database), ms. */
  noopOwnMs: number;
  /** The git / file io they waited on, ms. */
  noopIoMs: number;
  /** Every wait they had (io included), ms. */
  noopWaitMs: number;
  /** No-ops whose cost the host did not measure (no profiler: a browser host). */
  unmeasuredNoops: number;
  /** `(noopOwnMs + noopIoMs)` per minute of window: what the no-ops measured, contention included. */
  measuredMsPerMinute: number;
  /**
   * What the monitor judges: every measured no-op charged at the cheapest run
   * of its tuple in the window (see the file comment), per minute of window.
   * ≤ `measuredMsPerMinute`.
   */
  wastedMsPerMinute: number;
  /** How many distinct tuples the measured no-ops recomputed. */
  noopTuples: number;
}

// Internal, clock-injectable core of snapshot (deterministic for tests). Sums the
// buckets within the trailing `windowSeconds` for each tracked key. Prunes keys
// whose last activity is fully outside the max window (no live data to report).
export function snapshotAt(windowSeconds: number, nowMs: number): KeySnapshot[] {
  const win = Math.min(Math.max(1, windowSeconds), MAX_WINDOW_SECONDS);
  const nowSec = Math.floor(nowMs / 1000);
  const cutoffSec = nowSec - win + 1;
  const out: KeySnapshot[] = [];

  for (const [key, state] of states) {
    // Prune keys that have seen no activity for the whole max window.
    if (nowMs - state.lastActiveMs > MAX_WINDOW_SECONDS * 1000) {
      states.delete(key);
      continue;
    }
    const sum = emptyBucket(nowSec);
    // Per tuple over the window: its measured no-ops and its cheapest run.
    const tuples = new Map<string, TupleNoops>();
    for (const b of state.buckets) {
      if (b.sec >= cutoffSec && b.sec <= nowSec) {
        sum.noop += b.noop;
        sum.total += b.total;
        sum.noopOwnMs += b.noopOwnMs;
        sum.noopIoMs += b.noopIoMs;
        sum.noopWaitMs += b.noopWaitMs;
        sum.noopUnmeasured += b.noopUnmeasured;
        sum.overflowMs += b.overflowMs;
        for (const [tuple, t] of b.tuples) {
          const w = tuples.get(tuple);
          if (!w) tuples.set(tuple, { count: t.count, minMs: t.minMs });
          else {
            w.count += t.count;
            if (t.minMs < w.minMs) w.minMs = t.minMs;
          }
        }
      }
    }
    if (sum.total === 0) continue;
    let chargedMs = sum.overflowMs;
    for (const t of tuples.values()) chargedMs += t.count * t.minMs;
    out.push({
      resourceKey: key,
      noopCount: sum.noop,
      totalCount: sum.total,
      subscribers: state.subscribers,
      noopRate: sum.noop / win,
      noopOwnMs: sum.noopOwnMs,
      noopIoMs: sum.noopIoMs,
      noopWaitMs: sum.noopWaitMs,
      unmeasuredNoops: sum.noopUnmeasured,
      measuredMsPerMinute: ((sum.noopOwnMs + sum.noopIoMs) * 60) / win,
      wastedMsPerMinute: (chargedMs * 60) / win,
      noopTuples: tuples.size,
    });
  }
  return out;
}

// Public API — real-clock wrappers. Normal server code may use Date.now() freely.
export function recordPush(key: string, info: PushInfo): void {
  recordPushAt(key, info, Date.now());
}

export function snapshot(windowSeconds: number): KeySnapshot[] {
  return snapshotAt(windowSeconds, Date.now());
}

// Test-only: reset module state between deterministic cases.
export function _resetForTest(): void {
  states.clear();
}
