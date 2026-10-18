// Zero-dependency, isomorphic runtime profiling recorder.
//
// This module imports NOTHING from other plugins (and no Node APIs) so it can
// sit at the very bottom of the dependency DAG. It is imported by
// `endpoints/core`, `database/server`, and `server-core/core` — all
// load-bearing — and must never form a back-edge that would create a cycle.
//
// The store is in-memory and bounded: per-(kind,label) rolling aggregates plus
// a small "slowest recent" ring per kind. Tiny and lost on restart, which is
// fine for live iterate-and-measure profiling.
//
// ## Ambient caller attribution
//
// Each `db`/`loader` span also records the single innermost enclosing request
// or loader it ran under (its immediate "parent"), so repeated-query (N+1)
// problems point straight at their source. The ambient context is supplied by
// an injected `SpanContextRuntime`: this module stays pure (no `node:async_hooks`,
// so the web bundle is unaffected); the server installs an AsyncLocalStorage-backed
// runtime at boot via `installSpanContextRuntime`. On the web the default no-op
// runtime makes every entry point a transparent passthrough.
//
// ## Wall-clock decomposition (wait / child / self)
//
// Every entry span decomposes its wall-clock into `waitMs` (time spent queued
// on named gates/pools, at any depth of its subtree), `childMs` (time covered
// by direct-child entry spans), and `selfMs` (the remainder: its own
// orchestration/CPU). Gate waits propagate to EVERY open ancestor — not just
// the innermost entry — so a composite span (e.g. a `flush` draining many
// loaders) names the gates its subtree waited on instead of showing a huge
// wall-clock with empty `waits`.
//
// The load-bearing constraint is concurrency: a flush drains many loaders in
// parallel, so SUMMING child waits into an ancestor can exceed the ancestor's
// wall-clock (20 loaders × 60s gate wait inside a 90s flush would read as
// "1200s of wait"). Each ancestor therefore accumulates waits as an
// interval-UNION over its own timeline (`Track`), guaranteeing
// `waitMs ≤ wall` and `selfMs ≥ 0` at every level. Because every charge
// arrives at its interval's END time (gates call `onWait` at slot acquisition;
// children charge at finish), the charge stream is end-ordered by
// construction, so a streaming union — O(1) state per track, no interval list
// — is exact for these streams; an interval that reaches back before the
// track's covered frontier contributes only the part past it (conservative:
// never overcounts, so `selfMs` can never go negative).
//
// A finished child charges its execution interval into the NEAREST open
// ancestor only: each parent's own interval propagates upward when *it*
// finishes, so charging every ancestor would double-count grandchildren.
// Gate waits, by contrast, go to ALL open ancestors — a union is idempotent
// under re-covering the same time range, so the same wait interval landing in
// every level is exactly what makes each level's `waits` self-contained.

// `http` / `db` / `loader` are spans of real work. `sub` / `push` are *origin*
// entries: the WS-subscription ack and the cascade/push flush that trigger a
// loader. They exist so a loader run is never `parent: null` — the loader span's
// parent names the request class that triggered it (sub = a tab subscribed,
// push = a notify cascade), making head-of-line blocking attributable to its
// origin. `flush` is the live-state notify-flush cycle: each `flushNotifies`
// drain runs inside a `flush` entry, so the per-resource `push` loads it triggers
// nest under it — `aggregates.flush[*].byParent` is the head-of-line attribution
// (which resource dominated a flush cycle) for free. See
// research/2026-06-19-global-wait-attribution-instrumentation.md and
// research/2026-06-19-global-observability-frequency-delivery-and-dead-job-gc.md.
// `job` is a top-level background-work entry recorded around each
// graphile-worker `job.run()`, analogous to `http` but triggered by the queue
// rather than an incoming request; its label is the job name.
// `cascade` is an origin entry (sibling to `sub`/`push`) recorded around a
// routed resource's reverse-route resolve (`resolveReverseRoutes`): the
// id-translation read that maps a changed lookup row to the host ids that
// reference it, run in the drain before the refill. It exists so those reads
// (a) route through the loader DB gate like a loader and (b) are attributed as
// their own kind in the profiler, instead of running unmeasured and ungated
// under the enclosing `flush` entry. Its label is the routed resource's key.
// Deliberately NOT a `loader` kind: a resolve is routing work, not the
// resource's value dependencies, so it must NOT enter the loader read-set index.
// (A `dependsOn` / `recomputeOn` cascade opens no `cascade` entry: it only
// schedules the downstream, whose recompute is a `push` load.) See
// research/2026-07-07-global-read-set-notifications-attribution-noise.md.
// `route` is the change-feed's routing of one Postgres change notification into
// the resource runtime (label = the changed table): a leaf span recorded with no
// parent (the listener runs outside any entry). `membership` is a window resource's ids-only membership query
// (`windowIdsOf`, label = the resource key), recorded under its `push` origin —
// its own kind for the same reason as `cascade`: a membership read must not
// enter the loader read-set index, and it must be told apart from the value
// query. See research/2026-09-23-global-live-state-plumbing-slow-op-coverage.md.
//
// SINGLE SOURCE OF TRUTH: `SPAN_KINDS` is the one enumeration of every span kind.
// `SpanKind`, this module's iteration set, the MCP tool's filter, and the
// endpoint response's zod enum are all DERIVED from it — so adding a kind here
// updates every mirror at once. (The `Record<SpanKind, …>` literals below are
// tsc-enforced to be exhaustive, so they need no derivation.) Do not hand-write a
// parallel list of kinds anywhere.
export const SPAN_KINDS = [
  "http",
  "db",
  "loader",
  "sub",
  "push",
  "flush",
  "job",
  "cascade",
  "bg",
  "route",
  "membership",
] as const;
export type SpanKind = (typeof SPAN_KINDS)[number];

/**
 * The closed set of numbers a span can carry beside its duration. Closed (like
 * `SPAN_KINDS`) so a misspelt measure is a tsc error and every surface can label
 * and format each one:
 * - `subscribers` — sockets a delivery was sent to (fan-out).
 * - `frameChars` — length of the serialized delivery frame, in UTF-16 chars
 *   (not bytes: a byte count would re-scan every frame on the flush path).
 * - `ids` — ids a read was scoped to (a scoped refill's affected ids, a
 *   change notification's changed ids).
 * - `sinceChangeMs` — time from the Postgres trigger firing to this span
 *   (includes how long the writing transaction stayed open).
 */
export const SPAN_MEASURES = [
  "subscribers",
  "frameChars",
  "ids",
  "sinceChangeMs",
] as const;
export type SpanMeasure = (typeof SPAN_MEASURES)[number];
export type SpanMeasures = Partial<Record<SpanMeasure, number>>;

/**
 * Optional per-run detail a span carries beside `(kind, label, duration)`.
 * `variant` names WHICH instance of the operation ran (e.g. a loader's
 * canonical params) without splitting the label: the label stays a bounded
 * operation-class identifier, so one resource stays one aggregate row, and
 * consumers break a row down by variant themselves (bounded on their side).
 */
export interface SpanDetail {
  variant?: string;
  measures?: SpanMeasures;
}

/** A reference to an enclosing entry point (the immediate parent of a span). */
export interface SpanRef {
  kind: SpanKind;
  label: string;
}

// --- Per-instance span identity ---
//
// `{kind,label}` names a span CLASS, not a span RUN: two concurrent
// `loader:tasks` runs under different parents are indistinguishable by label, so
// a captured flight window cannot be reassembled into a call tree from labels
// alone. Every span run therefore gets an `id` from this counter, and carries
// the `id` of the entry it ran inside as `parentId` — the exact edge, resolved
// against the live `EntryContext.parent` chain the recorder already threads.
//
// Monotonic and process-lifetime. NEVER reset it — not even in
// `resetRuntimeProfile()`, which deliberately leaves live EntryContexts alone
// (they deregister in their own `finally`). A restarted counter would hand an
// in-flight parent's id to a fresh child, silently splicing one call tree into
// another.
//
// A parent always OPENS before its child, so `parentId < id` holds for every
// span: the tree a consumer builds from these edges is acyclic by construction.
let nextSpanId = 1;

/**
 * Per-layer wait breakdown charged to an entry while it ran: gate/lock name →
 * ms of the entry's own timeline covered by waits on that layer (an interval
 * UNION per record, so each value is ≤ the record's wall-clock — never a sum
 * across concurrent waiters). Populated via `chargeWait` from each concurrency
 * gate; propagated to every open ancestor entry.
 */
export type WaitBreakdown = Record<string, number>;

/**
 * A streaming interval-union accumulator over one entry's timeline.
 * `prevEnd` is the covered frontier: because charges arrive end-ordered (see
 * module header), everything at/before `prevEnd` that will ever be covered
 * already is, so a single scalar suffices — no interval list.
 */
export interface Track {
  unionMs: number;
  prevEnd: number;
}

/**
 * A positioned wait interval on one entry's timeline: the layer that blocked
 * and the exact `[t0, t1]` (profiler clock, already clipped to the owning
 * entry's lifetime) it covered. Where `Track` is the scalar MEASURE of an
 * entry's covered wait set on a layer, a `WaitBand[]` is that set itself —
 * truncated to a fixed budget. Each band is the coverage delta `contribute`
 * returns, so `Σ band widths` can never drift from `track.unionMs`.
 */
export interface WaitBand {
  layer: string;
  t0: number;
  t1: number;
}

/** Per-parent breakdown of an aggregate: who issued this label, how often. */
export interface ParentBreakdown {
  parent: SpanRef;
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface SlowSpan {
  /** This span RUN's identity — see `nextSpanId`. Names the exact instance that tripped. */
  id: number;
  /** The `id` of the enclosing entry RUN, or null at the top level. */
  parentId: number | null;
  kind: SpanKind;
  label: string;
  durationMs: number;
  atMs: number;
  /** Immediate enclosing request/loader, if any. */
  parent: SpanRef | null;
  /** Wait charged to this entry by layer, if it waited (entry spans only). */
  waits?: WaitBreakdown;
  /** Union of all gate waits over this span's timeline (0 for leaf spans). */
  waitMs: number;
  /** Union of direct-child entry executions over this span's timeline (0 for leaves). */
  childMs: number;
  /** durationMs − union(waits ∪ child executions): own orchestration/CPU. Leaves: durationMs. */
  selfMs: number;
  /** Variant + measures the call site attached, if any. Variant capped at `MAX_VARIANT_LEN`. */
  detail?: SpanDetail;
}

export type SlowSpanHandler = (span: SlowSpan) => void;

export interface Aggregate {
  label: string;
  count: number;
  totalMs: number;
  maxMs: number;
  lastMs: number;
  /** Σ per-record waitMs (each a union ≤ that record's wall). Per-call avg = /count. */
  waitTotalMs: number;
  /** Σ per-record childMs. */
  childTotalMs: number;
  /** Σ per-record selfMs. */
  selfTotalMs: number;
  /** Max duration within the recent rolling window (~5 min). 0 if idle past the window. */
  recentMaxMs: number;
  /** How long ago the all-time `maxMs` was set — so a stale peak reads as stale. */
  maxAgeMs: number;
  /** Attribution by immediate parent, sorted by count desc. */
  byParent: ParentBreakdown[];
  /** Summed per-record wait unions by layer across all records of this label, if any waited. */
  waits?: WaitBreakdown;
  /** Largest value of each measure any record of this label carried, if any did. */
  measuresMax?: SpanMeasures;
}

/**
 * Split an aggregate's average per-call duration into wait / child / self.
 * The `*TotalMs` fields are SUMMED across every record of the label (see
 * `record()`), so dividing by `count` amortizes each component per call.
 * Returns RAW floats (no rounding) — callers format. Per-record each component
 * is an interval union ≤ wall, so `waitMs ≤ avgMs` and `selfMs ≥ 0` hold on
 * the averages too.
 */
export function waitSplit(agg: Aggregate): {
  avgMs: number;
  waitMs: number;
  childMs: number;
  selfMs: number;
  waits: Record<string, number>;
} {
  const avgMs = agg.totalMs / agg.count;
  const waits: Record<string, number> = {};
  if (agg.waits) {
    for (const layer in agg.waits) {
      waits[layer] = agg.waits[layer]! / agg.count;
    }
  }
  return {
    avgMs,
    waitMs: agg.waitTotalMs / agg.count,
    childMs: agg.childTotalMs / agg.count,
    selfMs: agg.selfTotalMs / agg.count,
    waits,
  };
}

const MAX_LABEL_LEN = 500;
const MAX_VARIANT_LEN = 200;
const SLOWEST_CAP = 50;

// Rolling-max window: per-aggregate max durations are bucketed into
// BUCKET_MS-wide bins; `recentMaxMs` is the max over the last WINDOW_BUCKETS
// live bins (~5 min). Bounded at O(WINDOW_BUCKETS) per aggregate.
const BUCKET_MS = 30_000;
const WINDOW_BUCKETS = 10;

const KINDS: readonly SpanKind[] = SPAN_KINDS;

// --- Injected clock ---

// Single clock seam used by every timestamp in this module (record, chargeWait,
// recordEntrySpan, getRuntimeProfile). Injectable so union/bucket arithmetic is
// deterministic under test; default behavior identical to performance.now().
let now: () => number = () => performance.now();

export function installClock(fn: () => number): void {
  now = fn;
}

/** The current profiler clock reading (same domain as captureFlightWindow's atMs). */
export function profilerNowMs(): number {
  return now();
}

// --- Streaming interval union ---

// Contribute the interval [start, end] to a track, returning the newly-covered
// ms (0 when the interval added nothing). `floor` clips the interval to the
// owning context's lifetime (a wait that started before the entry did must not
// count against the entry's wall-clock). The frontier check makes it a union,
// not a sum: only time past `prevEnd` is new coverage. An interval fully
// at/before the frontier contributes 0 — with end-ordered arrival this means
// "already covered"; in the theoretical non-end-ordered case it undercounts,
// never overcounts (so selfMs stays ≥ 0). The returned slice is exactly
// `[end − covered, end]`, which a caller records as a positioned wait band —
// bands and the scalar union then share one source and cannot diverge.
function contribute(
  track: Track,
  start: number,
  end: number,
  floor: number,
): number {
  if (start < floor) start = floor;
  const lo = start > track.prevEnd ? start : track.prevEnd;
  if (end > lo) {
    track.unionMs += end - lo;
    track.prevEnd = end;
    return end - lo;
  }
  return 0;
}

// Test-only export: the streaming union is the load-bearing math of the whole
// decomposition, so it is unit-tested directly. Not part of the public API.
export { contribute as __contribute };

// Max positioned wait bands retained per (entry, layer). A Gantt wants the
// largest stalls, not all of them; overflow drops the smallest (see pushBand).
export const WAIT_BAND_CAP = 12;

// Append the covered slice `[t0, t1]` to a per-layer band list. Charges arrive
// END-ORDERED by construction (the same premise the streaming union rests on —
// see the module header), so this is a tail op: extend the last band when the
// new slice touches it (`t0 <= last.t1`), else push a fresh band. Over `cap`,
// drop the SMALLEST band — NEVER merge across a gap to make room, which would
// paint time the span was not waiting (the recorder is conservative in the UNDER
// direction everywhere). `waitMs` stays the authoritative total, so a dropped
// band's ms is still recoverable as `waitMs − crossLayerUnion(bands)`.
function pushBand(
  bands: WaitBand[],
  layer: string,
  t0: number,
  t1: number,
  cap: number,
): void {
  const last = bands[bands.length - 1];
  if (last && last.layer === layer && t0 <= last.t1) {
    last.t1 = t1;
  } else {
    bands.push({ layer, t0, t1 });
  }
  if (bands.length > cap) {
    let minIdx = 0;
    for (let i = 1; i < bands.length; i++) {
      if (bands[i]!.t1 - bands[i]!.t0 < bands[minIdx]!.t1 - bands[minIdx]!.t0)
        minIdx = i;
    }
    bands.splice(minIdx, 1);
  }
}

// Test-only export, mirroring `__contribute`: the tail-merge + drop-smallest
// policy is unit-tested directly.
export { pushBand as __pushBand };

// --- Injected ambient-context runtime ---

/**
 * The mutable ambient entry context: the innermost enclosing entry's identity
 * plus its live parent chain and interval-union accumulators. A gate charges
 * its queue-wait here (via `chargeWait`) while the entry runs — into this
 * context AND every open ancestor up the chain; `recordEntrySpan` materializes
 * the unions into `waits`/`waitMs`/`childMs`/`selfMs` on finish. Stored by
 * identity in the server's AsyncLocalStorage, so a gate awaited deep inside
 * the entry mutates the SAME tracks — this is why per-entry wait accumulation
 * works without threading state.
 */
export interface EntryContext {
  /**
   * This entry RUN's identity (see `nextSpanId`), minted when the entry OPENS —
   * before `fn` runs — so a child can name its parent while the parent is still
   * in flight. There is deliberately no `parentId` field: `parent?.id` already
   * answers it off the live chain below.
   */
  id: number;
  kind: SpanKind;
  label: string;
  /**
   * The live enclosing entry chain (unlike the `SpanRef` snapshot `record()`
   * attributes to, these are the mutable contexts wait/child intervals
   * propagate into). `undefined` at the top level.
   */
  parent: EntryContext | undefined;
  /** Entry start on the profiler clock; the clip floor for all its tracks. */
  startMs: number;
  /**
   * Set in `recordEntrySpan`'s finally, after the entry recorded itself. A
   * closed context must never be mutated again: a detached child (or a late
   * gate callback) finishing after its parent closed would otherwise write
   * into unions the parent already materialized — silently lost at best,
   * corrupting a reused timeline at worst. Walkers skip closed ancestors.
   */
  closed: boolean;
  /** Per-gate-layer wait unions → materialized into the record's `waits`. */
  layerUnions: Map<string, Track>;
  /**
   * Per-gate-layer POSITIONED wait bands: the intervals each `layerUnions`
   * track actually covered, bounded at `WAIT_BAND_CAP` per layer. The Map is
   * allocated with the context (like `layerUnions`); each per-layer list is
   * lazily created on that layer's first covered charge, so an entry that never
   * waits allocates none. Materialized flat into the record's `waitBands`.
   */
  layerBands: Map<string, WaitBand[]>;
  /** Union of ALL gate-wait intervals (across layers) → `waitMs`. */
  waitUnion: Track;
  /** Union of gate-waits ∪ child executions → `selfMs = wall − busy`. */
  busyUnion: Track;
  /** Union of direct-child entry execution intervals → `childMs`. */
  childUnion: Track;
  /**
   * The set of DB tables this entry read, lazily created on first
   * `recordReadTables` (unlike the tracks, which are always allocated). Handed
   * to the installed loader read-set sink by `recordEntrySpan` for loader
   * entries only, so the many non-loader entries that never read tables don't
   * allocate a Set.
   */
  tables?: Set<string>;
}

interface SpanContextRuntime {
  run<T>(ctx: EntryContext, fn: () => T): T;
  current(): EntryContext | undefined;
}

// Default: transparent passthrough with no ambient context (the web case, and
// the server before install.ts runs). The server replaces this at boot.
let contextRuntime: SpanContextRuntime = {
  run: (_ctx, fn) => fn(),
  current: () => undefined,
};

export function installSpanContextRuntime(runtime: SpanContextRuntime): void {
  contextRuntime = runtime;
}

// --- Injected profiling-suppression runtime ---
//
// The observability subsystem (reports, slow-ops) issues its own DB writes. Left
// unguarded, those writes are themselves `db` spans that the recorder aggregates
// and pushes to `onSlowSpan` — re-entering the very code that produced them, a
// self-amplifying feedback loop that storms the connection pool. The fix: an
// injected suppression scope (mirroring the SpanContextRuntime injection so core
// stays pure). Any span produced inside `runWithoutProfiling(fn)` is dropped at
// the top of `record()` before any aggregation or push work. The server installs
// an AsyncLocalStorage-backed runtime at boot; on the web the default no-op makes
// it a transparent passthrough.

interface ProfilingSuppressionRuntime {
  run<T>(fn: () => T): T;
  suppressed(): boolean;
}

let suppressionRuntime: ProfilingSuppressionRuntime = {
  run: (fn) => fn(),
  suppressed: () => false,
};

export function installProfilingSuppressionRuntime(
  rt: ProfilingSuppressionRuntime,
): void {
  suppressionRuntime = rt;
}

// --- Monitoring self-meter ---
//
// Suppression makes monitoring's own cost structurally invisible: every
// observability write runs inside runWithoutProfiling, so the profiler — the
// tool you'd reach for — cannot see it, and a monitoring-overload cannot be
// diagnosed from the data (the observer-effect audit's finding). The fix is to
// meter the suppression scope itself: everything inside runWithoutProfiling is
// BY DEFINITION monitoring work, so two module counters at this one chokepoint
// attribute all of it with zero per-callsite edits — and, being plain numbers
// outside the recorder's span path, they can never re-feed the profiler.
//
// Semantics: one "op" = one OUTERMOST runWithoutProfiling scope; `totalMs` is
// that scope's wall-clock from call to settlement (synchronous return, sync
// throw, or promise settle). A scope opened while suppression is already active
// (`suppressed()` — ALS semantics on the server, so nesting is detected across
// awaits, not just sync frames) is the same monitoring op and adds neither
// count nor time — nested wall time inside an outer scope is never
// double-counted. Two CONCURRENT outermost scopes each meter their full wall
// (a sum, like CPU-time accounting), which is correct: they are separate
// monitoring work items. On the web the default runtime's `suppressed()` is
// always false, so nesting is not detected there — acceptable: the meter is
// consumed server-side (health sampler).
//
// Cumulative since boot and NEVER reset (not by resetRuntimeProfile either):
// the consumer diffs successive readings, and a reset would surface as a
// negative delta.
let selfMeterCount = 0;
let selfMeterTotalMs = 0;

/**
 * Cumulative monitoring self-cost since boot: `count` outermost
 * `runWithoutProfiling` scopes, `totalMs` their summed wall-clock. Monotonic —
 * consumers (the health sampler) diff successive readings for per-tick deltas.
 */
export function getSelfMeter(): { count: number; totalMs: number } {
  return { count: selfMeterCount, totalMs: selfMeterTotalMs };
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}

/**
 * Run `fn` in a scope where every span the recorder would otherwise capture is
 * dropped. Use this to wrap the observability subsystem's own I/O so the
 * profiler never measures itself. Suppression propagates to async continuations
 * spawned synchronously within `fn` (AsyncLocalStorage semantics on the server),
 * so an awaited DB operation kicked off inside `fn` is fully suppressed.
 *
 * The scope is also the monitoring self-meter's chokepoint (see above): the
 * outermost scope's wall-clock accumulates into `getSelfMeter()`. An async `fn`
 * is timed to settlement by observing the returned promise on a detached
 * derived promise (both handlers, so it can never surface an unhandled
 * rejection) — the ORIGINAL result is returned untouched, so the return type
 * and promise identity are unchanged. Sync overhead beyond suppression: two
 * clock reads and two number adds; the async path adds one closure.
 */
export function runWithoutProfiling<T>(fn: () => T): T {
  if (suppressionRuntime.suppressed()) return suppressionRuntime.run(fn);
  selfMeterCount += 1;
  const t0 = now();
  let syncSettle = true;
  try {
    const result = suppressionRuntime.run(fn);
    if (isThenable(result)) {
      syncSettle = false;
      const settle = (): void => {
        selfMeterTotalMs += now() - t0;
      };
      void result.then(settle, settle);
    }
    return result;
  } finally {
    // A sync return or a sync throw settles here; a thenable settles in
    // `settle` above instead.
    if (syncSettle) selfMeterTotalMs += now() - t0;
  }
}

// --- Injected background-lane runtime ---
//
// The origin walk below infers a work item's lane from the outermost entry that
// triggered it. Some work is background REGARDLESS of what triggered it: the
// observability subsystem's own writes (slow-ops / reports / trace / contention)
// and the queue's job-cleanup writes would otherwise inherit the origin of
// whatever human request happened to trip them, and ride the interactive lane
// they exist to protect. This scope is that explicit declaration.
//
// Deliberately SEPARATE from `runWithoutProfiling`: "don't record" and "is
// background" are different claims on orthogonal axes. `debug/profiling/boot-bench`'s
// load generator relies on suppression precisely while wanting real gate slots,
// and the observability writes want the reverse — suppressed AND background.
//
// Same injection shape as the two runtimes above, so core stays Node-free; the
// server installs an AsyncLocalStorage-backed runtime at boot.

interface BackgroundLaneRuntime {
  run<T>(fn: () => T): T;
  active(): boolean;
}

let backgroundLaneRuntime: BackgroundLaneRuntime = {
  run: (fn) => fn(),
  active: () => false,
};

export function installBackgroundLaneRuntime(rt: BackgroundLaneRuntime): void {
  backgroundLaneRuntime = rt;
}

/**
 * Declare that the work in `fn` is background, whatever triggered it — the
 * explicit override `currentOriginClass()` honors before it walks the entry
 * chain. Use it for the observability subsystem's own DB writes and the queue's
 * job-cleanup writes, whose transactions must never charge against the capacity
 * reserved for human-blocking work.
 *
 * Not `async` by design: `fn`'s return value passes straight through, so an
 * awaited DB operation kicked off inside `fn` stays in scope for its whole life
 * (AsyncLocalStorage semantics on the server) — that propagation is what routes
 * a nested `db.transaction()`'s `pool.connect()` into the background lane.
 */
export function runInBackgroundLane<T>(fn: () => T): T {
  return backgroundLaneRuntime.run(fn);
}

/**
 * Run detached/background `fn` as a first-class `bg` entry span so its cost is
 * ATTRIBUTED (get_runtime_profile / slow_ops / flight recorder) instead of
 * silently inflating whatever span happens to be open. A `bg` root maps to the
 * background lane (see ORIGIN_CLASS), so this also routes the work's DB queries
 * through the background gate for free — no separate `runInBackgroundLane` wrap.
 *
 * The detached-work triad:
 * - `runTracked`          — detached work we WANT attributed (opens a `bg` span).
 * - `runInBackgroundLane` — declare the lane only, NO span (observability-internal).
 * - `runWithoutProfiling` — suppress recording entirely (observability-internal).
 */
export function runTracked<T>(
  label: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  return recordEntrySpan("bg", label, fn);
}

// --- Slow-span push seam ---

// The push counterpart to the pull-only getRuntimeProfile(). Subscribers are
// notified synchronously from record() for any span at/over their thresholdMs.
const slowSpanSubs: { thresholdMs: number; handler: SlowSpanHandler }[] = [];

/**
 * Subscribe to spans whose duration meets `thresholdMs`. This is the push seam
 * consumed by the `reports` plugin to file slow-op reports. The static
 * `thresholdMs` is a coarse performance floor so the hot path never calls back
 * for fast spans; consumers still do final per-kind gating in their handler.
 * Returns a disposer that unsubscribes.
 */
export function onSlowSpan(
  handler: SlowSpanHandler,
  opts: { thresholdMs: number },
): { dispose: () => void } {
  const sub = { thresholdMs: opts.thresholdMs, handler };
  slowSpanSubs.push(sub);
  return {
    dispose: () => {
      const i = slowSpanSubs.indexOf(sub);
      if (i >= 0) slowSpanSubs.splice(i, 1);
    },
  };
}

// --- Store ---

// Internal aggregate keeps byParent as a Map for O(1) updates; materialized to
// a sorted array in getRuntimeProfile().
interface AggregateInternal {
  label: string;
  count: number;
  totalMs: number;
  maxMs: number;
  /** Profiler-clock timestamp of the record that set (or last beat) maxMs. */
  maxAtMs: number;
  lastMs: number;
  waitTotalMs: number;
  childTotalMs: number;
  selfTotalMs: number;
  /**
   * Per-bucket max durations for the rolling recent-max window. `at` is the
   * bucket index (atMs / BUCKET_MS); records within the same bucket fold into
   * one entry, and expired entries are dropped on append — bounded at
   * O(WINDOW_BUCKETS).
   */
  recentBuckets: { at: number; max: number }[];
  byParent: Map<string, ParentBreakdown>;
  /** Summed per-record wait unions by layer, lazily created on first wait. */
  waits?: WaitBreakdown;
  /** Per-measure max across records, lazily created on the first measure. */
  measuresMax?: SpanMeasures;
}

// Per-kind aggregate maps keyed by label.
const aggregates: Record<SpanKind, Map<string, AggregateInternal>> = {
  http: new Map(),
  db: new Map(),
  loader: new Map(),
  sub: new Map(),
  push: new Map(),
  flush: new Map(),
  job: new Map(),
  cascade: new Map(),
  bg: new Map(),
  route: new Map(),
  membership: new Map(),
};

// Per-kind "slowest recent" buffer. We keep a slowest-N set rather than a plain
// recency ring: the question this surfaces is "what was the worst recently",
// and a slowest-N answers that directly. Implementation: append, then if over
// the cap drop the single fastest entry. O(n) per insert with n<=50 is trivial.
const slowest: Record<SpanKind, SlowSpan[]> = {
  http: [],
  db: [],
  loader: [],
  sub: [],
  push: [],
  flush: [],
  job: [],
  cascade: [],
  bg: [],
  route: [],
  membership: [],
};

let sinceMs = now();

// Loader → table read-set sink. Each loader entry's captured `tables` (built up
// via `recordReadTables` mid-load) is handed to it once, when the entry finishes.
// The index it feeds is runtime state owned by the resource runtime
// (server-core's read-set) — not profile data: it survives
// `resetRuntimeProfile`, and it is fed whatever the SINGULARITY_PROFILING
// kill-switch says, because the route drift guard (A8 / D5) and the persisted
// `tables_read` depend on it. This module only
// owns the capture scope (the ambient loader entry). The server installs the
// sink at boot (install.ts); none installed (the web, a bare test) = nothing
// captured. See research/2026-09-29-global-scoped-change-routing.md (P0).
export type LoaderReadSetSink = (
  label: string,
  tables: ReadonlySet<string>,
) => void;
let loaderReadSetSink: LoaderReadSetSink | null = null;

export function installLoaderReadSetSink(sink: LoaderReadSetSink): void {
  loaderReadSetSink = sink;
}

function parentKey(parent: SpanRef): string {
  return `${parent.kind}:${parent.label}`;
}

// --- Flight-recorder substrate ---
//
// Three side-structures let a slow-event consumer materialize ONE coherent
// instant (who was in flight, who just finished, how saturated each gate was)
// via `captureFlightWindow`. All hot-path writes are O(1) and allocation-free;
// allocation happens only at capture time — i.e. only on a (rate-limited)
// slow-event trip. See research/2026-07-02-global-slow-event-flight-recorder.md.

// Side-table of currently-open ENTRY contexts. EntryContexts are otherwise
// reachable only via the ambient async chain of one request, so this is what
// lets a snapshot enumerate every concurrently in-flight op. Maintained by
// `recordEntrySpan` (add before run, delete in the finally — exactly paired on
// every path, including throws). Leaf `db` spans have no context and are not
// registered; they are covered by the completed ring below.
const openEntries = new Set<EntryContext>();

// Preallocated circular buffer of recently-completed spans: the blocker often
// finishes before its victim's span ends, so open entries alone can't name it.
// Slots are mutable and overwritten in place — a ring write is a comparison +
// ~12 field writes. A completed ENTRY span additionally stores two references
// already built in recordEntrySpan's finally (its `waits` breakdown and one flat
// `waitBands` array); a leaf `db` span passes both undefined, so the per-query
// path stays fully allocation-free.
const FLIGHT_RING_CAPACITY = 4096;
const FLIGHT_RING_MIN_MS = 5; // sub-5ms spans can't matter to a >=500ms window

interface FlightRingSlot {
  used: boolean;
  id: number;
  parentId: number | null;
  kind: SpanKind;
  label: string;
  t0: number;
  t1: number;
  waitMs: number;
  childMs: number;
  selfMs: number;
  waits: WaitBreakdown | undefined;
  waitBands: WaitBand[] | undefined;
}

const flightRing: FlightRingSlot[] = Array.from(
  { length: FLIGHT_RING_CAPACITY },
  () => ({
    used: false,
    id: 0,
    parentId: null,
    kind: "db" as SpanKind,
    label: "",
    t0: 0,
    t1: 0,
    waitMs: 0,
    childMs: 0,
    selfMs: 0,
    waits: undefined,
    waitBands: undefined,
  }),
);
let flightRingHead = 0;

// Called from record(), just above the slow-span notify loop, so it sits behind
// the SINGULARITY_PROFILING kill-switch and suppression early-returns while
// still landing BEFORE any handler can capture a window (see `record`).
function pushCompleted(
  kind: SpanKind,
  label: string,
  t1: number,
  durationMs: number,
  spanId: number,
  parentId: number | null,
  waitMs: number,
  childMs: number,
  selfMs: number,
  waits: WaitBreakdown | undefined,
  waitBands: WaitBand[] | undefined,
): void {
  if (durationMs < FLIGHT_RING_MIN_MS) return;
  const slot = flightRing[flightRingHead]!;
  slot.used = true;
  slot.id = spanId;
  slot.parentId = parentId;
  slot.kind = kind;
  slot.label = label;
  slot.t0 = t1 - durationMs;
  slot.t1 = t1;
  slot.waitMs = waitMs;
  slot.childMs = childMs;
  slot.selfMs = selfMs;
  slot.waits = waits;
  slot.waitBands = waitBands;
  flightRingHead = (flightRingHead + 1) % FLIGHT_RING_CAPACITY;
}

/** Point-in-time occupancy of one concurrency gate. */
export interface GateGauge {
  active: number;
  queued: number;
  max: number;
}

const gateGauges = new Map<string, () => GateGauge>();

/**
 * Register a live occupancy reader for a concurrency gate. `layer` uses the
 * SAME vocabulary as `chargeWait` layer names, so a snapshot's gate occupancy
 * joins directly to span `waits`. Gate OWNERS self-register (the recorder
 * never names a gate); a duplicate layer is a wiring bug — fail loudly.
 */
export function registerGateGauge(layer: string, read: () => GateGauge): void {
  if (gateGauges.has(layer)) {
    throw new Error(`registerGateGauge: duplicate layer ${layer}`);
  }
  gateGauges.set(layer, read);
}

/** Invoke every registered gate gauge, keyed by its `chargeWait` layer name. */
export function readGateGauges(): Record<string, GateGauge> {
  const out: Record<string, GateGauge> = {};
  for (const [layer, read] of gateGauges) out[layer] = read();
  return out;
}

/** One span in a captured flight window — open (still running) or completed. */
export interface FlightSpan {
  /** This span RUN's identity — unique across `open ∪ completed` (see `nextSpanId`). */
  id: number;
  /**
   * The enclosing entry RUN's `id`, or null at the top level. Always `< id`, so
   * the edge set is an acyclic forest. A `parentId` that resolves to nothing in
   * the window is an ORPHAN, not corruption: the parent may be a sub-5 ms span
   * the ring never took, or one evicted before capture. Consumers render such a
   * span as a root.
   */
  parentId: number | null;
  kind: SpanKind;
  label: string;
  t0: number;
  /** null => still open at capture. */
  t1: number | null;
  /** (t1 ?? captureAt) − t0. */
  ageMs: number;
  waitMs: number;
  childMs: number;
  selfMs: number;
  /** Per-layer wait unions (open spans: live layerUnions; completed: the ring slot). */
  waits?: WaitBreakdown;
  /**
   * Positioned wait intervals, one flat list across layers, each clipped to this
   * span's lifetime. `crossLayerUnion(waitBands) ≤ waitMs`; the shortfall is wait
   * whose position was dropped to the band budget. Absent on a pre-band trace.
   */
  waitBands?: WaitBand[];
}

export interface FlightWindow {
  atMs: number;
  open: FlightSpan[];
  completed: FlightSpan[];
}

/**
 * Synchronously materialize the flight-recorder state: every in-flight entry
 * (from the open-entry registry) plus the recently-completed spans overlapping
 * `[windowStartMs, now]` (from the ring, newest first). Reading a live
 * context's `unionMs` mid-flight is sound — a track's union is monotonic
 * accumulated coverage, so a partial read is simply the coverage so far. This
 * is the only place in the substrate that allocates (trip-time only).
 *
 * The open set is **ancestor-closed**: `maxOpen` bounds the entries taken from
 * the registry, then every still-open ancestor of a taken entry is pulled in
 * too. So `maxOpen` is a SOFT cap (hard-bounded by `openEntries.size`) — the
 * alternative, a hole in the middle of a chain, would silently reparent a whole
 * subtree onto a root it never ran under, which is worse than a few extra rows.
 */
export function captureFlightWindow(opts: {
  windowStartMs: number;
  maxOpen?: number;
  maxCompleted?: number;
}): FlightWindow {
  const atMs = now();
  const maxOpen = opts.maxOpen ?? 200;
  const maxCompleted = opts.maxCompleted ?? 400;

  const ctxs: EntryContext[] = [];
  const taken = new Set<EntryContext>();
  for (const ctx of openEntries) {
    if (ctxs.length >= maxOpen) break;
    ctxs.push(ctx);
    taken.add(ctx);
  }
  // Ancestor closure. `ctxs` grows in place while the index loop walks it, so a
  // pulled-in ancestor is itself visited and its own chain closed — one pass
  // suffices. The walk stops at a CLOSED ancestor: nothing above it can be the
  // `parentId` of an open span that isn't already covered by that span's own
  // walk (a closed ancestor is a legitimate orphan edge, not a hole we can fill).
  //
  // Today this pass adds nothing: `openEntries` is a Set, a parent is always
  // added before its child, and a Set iterates in insertion order — so any
  // `maxOpen` prefix is already ancestor-closed. It is kept because that is an
  // accident of the registry's *representation*, not of this function's
  // contract: the moment `openEntries` stops being an insertion-ordered Set (a
  // Map re-keyed by id, a re-registration, a bucketed store), a silent
  // mid-chain hole would reparent a whole subtree onto a root it never ran
  // under. The cost is one bounded walk on a (rate-limited) trip.
  for (let i = 0; i < ctxs.length; i++) {
    for (let a = ctxs[i]!.parent; a && !a.closed; a = a.parent) {
      if (taken.has(a)) break;
      taken.add(a);
      ctxs.push(a);
    }
  }

  const open: FlightSpan[] = [];
  for (const ctx of ctxs) {
    const ageMs = atMs - ctx.startMs;
    let waits: WaitBreakdown | undefined;
    if (ctx.layerUnions.size > 0) {
      waits = {};
      for (const [layer, track] of ctx.layerUnions)
        waits[layer] = track.unionMs;
    }
    let waitBands: WaitBand[] | undefined;
    if (ctx.layerBands.size > 0) {
      waitBands = [];
      // Copy each band: this context is still live, so pushBand may extend its
      // last band in place after this snapshot is taken.
      for (const bands of ctx.layerBands.values()) {
        for (const b of bands)
          waitBands.push({ layer: b.layer, t0: b.t0, t1: b.t1 });
      }
    }
    open.push({
      id: ctx.id,
      parentId: ctx.parent ? ctx.parent.id : null,
      kind: ctx.kind,
      label: ctx.label,
      t0: ctx.startMs,
      t1: null,
      ageMs,
      waitMs: ctx.waitUnion.unionMs,
      childMs: ctx.childUnion.unionMs,
      selfMs: Math.max(0, ageMs - ctx.busyUnion.unionMs),
      waits,
      waitBands,
    });
  }

  // Completed spans need NO closure pass: a parent finishes AFTER its child, so
  // it is newer in the ring and its `t1 ≥ child.t1 ≥ windowStartMs`. It
  // therefore survives both the window filter and the newest-first `maxCompleted`
  // cut strictly before its children do — a truncation can drop a child, never
  // strand one. (A parent that closed in <5 ms never entered the ring at all;
  // its children are orphans by construction, which the consumer renders as roots.)
  const completed: FlightSpan[] = [];
  for (
    let i = 0;
    i < FLIGHT_RING_CAPACITY && completed.length < maxCompleted;
    i++
  ) {
    const slot =
      flightRing[
        (flightRingHead - 1 - i + FLIGHT_RING_CAPACITY) % FLIGHT_RING_CAPACITY
      ]!;
    if (!slot.used) continue;
    if (slot.t1 < opts.windowStartMs) continue;
    completed.push({
      id: slot.id,
      parentId: slot.parentId,
      kind: slot.kind,
      label: slot.label,
      t0: slot.t0,
      t1: slot.t1,
      ageMs: slot.t1 - slot.t0,
      waitMs: slot.waitMs,
      childMs: slot.childMs,
      selfMs: slot.selfMs,
      waits: slot.waits,
      waitBands: slot.waitBands,
    });
  }

  return { atMs, open, completed };
}

/**
 * The SINGULARITY_PROFILING kill-switch (`"0"` disables span recording). Read
 * through `globalThis.process?.env` so the recorder also loads where there is
 * no `process` (a browser host of the resource runtime): there it is never
 * disabled.
 */
function profilingDisabled(): boolean {
  return globalThis.process?.env?.SINGULARITY_PROFILING === "0";
}

// Core write path: update aggregates + slowest ring, attributing to `parent`.
// `spanId`/`parentId` identify this span RUN and its enclosing entry run (see
// `nextSpanId`) — the per-instance edge, carried alongside the per-label
// `parent` snapshot the aggregates group by. `waitMs`/`childMs`/`selfMs` are the
// entry's decomposition (see module header); leaf spans take the defaults (no
// waits, no children, all self).

function record(
  kind: SpanKind,
  label: string,
  durationMs: number,
  spanId: number,
  parentId: number | null,
  parent: SpanRef | null,
  waits?: WaitBreakdown,
  waitMs = 0,
  childMs = 0,
  selfMs = durationMs,
  waitBands?: WaitBand[],
  rawDetail?: SpanDetail,
): void {
  if (profilingDisabled()) return;
  // Drop spans produced inside a runWithoutProfiling scope before any aggregate,
  // slowest-ring, or onSlowSpan work — this is what breaks the observability
  // self-feedback loop (see installProfilingSuppressionRuntime).
  if (suppressionRuntime.suppressed()) return;

  const cappedLabel =
    label.length > MAX_LABEL_LEN ? label.slice(0, MAX_LABEL_LEN) : label;
  const atMs = now();
  const detail = capDetail(rawDetail);

  const byLabel = aggregates[kind];
  let agg = byLabel.get(cappedLabel);
  if (agg) {
    agg.count += 1;
    agg.totalMs += durationMs;
    agg.lastMs = durationMs;
    agg.waitTotalMs += waitMs;
    agg.childTotalMs += childMs;
    agg.selfTotalMs += selfMs;
    if (durationMs > agg.maxMs) {
      agg.maxMs = durationMs;
      agg.maxAtMs = atMs;
    }
  } else {
    agg = {
      label: cappedLabel,
      count: 1,
      totalMs: durationMs,
      maxMs: durationMs,
      maxAtMs: atMs,
      lastMs: durationMs,
      waitTotalMs: waitMs,
      childTotalMs: childMs,
      selfTotalMs: selfMs,
      recentBuckets: [],
      byParent: new Map(),
    };
    byLabel.set(cappedLabel, agg);
  }

  // Rolling recent-max: fold into the current bucket, or open a new one and
  // evict everything that has left the window. Eviction only happens on bucket
  // rollover, so an idle aggregate keeps stale buckets — getRuntimeProfile()
  // filters by liveness against the CURRENT time, so they never leak into
  // recentMaxMs.
  const bucketIdx = Math.floor(atMs / BUCKET_MS);
  const buckets = agg.recentBuckets;
  const lastBucket = buckets[buckets.length - 1];
  if (lastBucket && lastBucket.at === bucketIdx) {
    if (durationMs > lastBucket.max) lastBucket.max = durationMs;
  } else {
    buckets.push({ at: bucketIdx, max: durationMs });
    while (buckets.length > 0 && buckets[0]!.at <= bucketIdx - WINDOW_BUCKETS) {
      buckets.shift();
    }
  }

  if (parent) {
    const pk = parentKey(parent);
    const pb = agg.byParent.get(pk);
    if (pb) {
      pb.count += 1;
      pb.totalMs += durationMs;
      if (durationMs > pb.maxMs) pb.maxMs = durationMs;
    } else {
      agg.byParent.set(pk, {
        parent: { kind: parent.kind, label: parent.label },
        count: 1,
        totalMs: durationMs,
        maxMs: durationMs,
      });
    }
  }

  // Sum the entry's per-layer wait into the aggregate so a label's wait split
  // is durable across all its records, not just the latest. Each incoming
  // value is a per-record union (≤ that record's wall), so the summed value
  // divided by count stays a meaningful per-call average.
  if (waits) {
    agg.waits ??= {};
    for (const layer in waits) {
      agg.waits[layer] = (agg.waits[layer] ?? 0) + waits[layer]!;
    }
  }

  const measures = detail?.measures;
  if (measures) {
    const max = (agg.measuresMax ??= {});
    for (const m of SPAN_MEASURES) {
      const v = measures[m];
      if (v !== undefined && !(v <= (max[m] ?? -Infinity))) max[m] = v;
    }
  }

  const ring = slowest[kind];
  ring.push({
    id: spanId,
    parentId,
    kind,
    label: cappedLabel,
    durationMs,
    atMs,
    parent,
    waits,
    waitMs,
    childMs,
    selfMs,
    detail,
  });
  if (ring.length > SLOWEST_CAP) {
    // Drop the single fastest entry to keep the slowest N.
    let minIdx = 0;
    for (let i = 1; i < ring.length; i++) {
      if (ring[i]!.durationMs < ring[minIdx]!.durationMs) minIdx = i;
    }
    ring.splice(minIdx, 1);
  }

  // The flight-ring write MUST precede the notify loop: a slow-span handler
  // calls captureFlightWindow synchronously, and by the time we get here the
  // span is already out of `openEntries` (recordEntrySpan's finally deregisters
  // before record()). Written after, the tripping span would be in neither
  // source — absent from its own trace, with its children rendering as orphan
  // roots. Both early-returns above still guard it, so the kill-switch and
  // suppression semantics are unchanged, and the write is allocation-free.
  pushCompleted(
    kind,
    cappedLabel,
    atMs,
    durationMs,
    spanId,
    parentId,
    waitMs,
    childMs,
    selfMs,
    waits,
    waitBands,
  );

  // Push seam: notify subscribers past their floor. Only build the span when
  // someone is listening to keep the hot path cheap. The handler is a
  // non-throwing fire-and-forget scheduler, so we don't guard it — failing
  // loudly is correct per repo policy.
  if (slowSpanSubs.length > 0) {
    const span: SlowSpan = {
      id: spanId,
      parentId,
      kind,
      label: cappedLabel,
      durationMs,
      atMs,
      parent,
      waits,
      waitMs,
      childMs,
      selfMs,
      detail,
    };
    for (const sub of slowSpanSubs) {
      if (durationMs >= sub.thresholdMs) sub.handler(span);
    }
  }
}

/**
 * Record a leaf span (e.g. a DB query), attributed to the innermost enclosing
 * entry point if one is active. Used by the DB pool wrapper. A leaf has no
 * decomposition: waitMs/childMs default to 0, selfMs to the full duration.
 *
 * A leaf never opens an `EntryContext`, so it mints its id here, at record time
 * — it has no in-flight window during which a child could reference it.
 */
export function recordSpan(
  kind: SpanKind,
  label: string,
  durationMs: number,
  detail?: SpanDetail,
): void {
  const cur = contextRuntime.current();
  record(
    kind,
    label,
    durationMs,
    nextSpanId++,
    cur ? cur.id : null,
    cur ? { kind: cur.kind, label: cur.label } : null,
    undefined,
    0,
    0,
    durationMs,
    undefined,
    detail,
  );
}

// Cap the variant at MAX_VARIANT_LEN and drop empty parts, so an absent detail
// is `undefined` rather than `{}` on every downstream surface.
function capDetail(detail: SpanDetail | undefined): SpanDetail | undefined {
  if (!detail) return undefined;
  const variant =
    detail.variant === undefined || detail.variant === ""
      ? undefined
      : detail.variant.length > MAX_VARIANT_LEN
        ? detail.variant.slice(0, MAX_VARIANT_LEN)
        : detail.variant;
  let measures: SpanMeasures | undefined;
  if (detail.measures) {
    for (const m of SPAN_MEASURES) {
      const v = detail.measures[m];
      if (v !== undefined) (measures ??= {})[m] = v;
    }
  }
  if (variant === undefined && measures === undefined) return undefined;
  return {
    ...(variant !== undefined && { variant }),
    ...(measures && { measures }),
  };
}

/**
 * Charge `ms` of wait time, under layer name `layer`, to EVERY open enclosing
 * entry (innermost included). A concurrency gate calls this from its `onWait`
 * callback at slot acquisition, so the interval `[now − ms, now]` is exact and
 * arrives end-ordered (the invariant the streaming union relies on). Each open
 * ancestor unions the interval into its own per-layer track, `waitUnion`, and
 * `busyUnion` — so a composite entry (flush) sees the gates its subtree waited
 * on, while concurrent waiters can never push an ancestor's wait past its
 * wall-clock. Closed ancestors are skipped (already recorded — see
 * `EntryContext.closed`); the interval is clipped to each ancestor's own start.
 *
 * A zero-ms charge still creates the layer key (with 0): git-memo hit/miss
 * markers use this to surface *that* a layer was consulted, not just how long
 * it blocked.
 *
 * If no entry is active (context-less: jobs, pollers, migrations), fall back
 * to a standalone `db [layer]` span so the wait is never silently lost.
 * Suppression is honored here (unlike the old innermost-only version) because
 * a wait incurred inside `runWithoutProfiling` would otherwise pollute the
 * unions of ancestors whose own records are NOT suppressed.
 */
export function chargeWait(layer: string, ms: number): void {
  if (profilingDisabled()) return;
  if (suppressionRuntime.suppressed()) return;
  const cur = contextRuntime.current();
  if (!cur) {
    // Context-less by definition, so the fallback span is a root leaf: mint an
    // id, no parent.
    record("db", `[${layer}]`, ms, nextSpanId++, null, null);
    return;
  }
  const end = now();
  const start = end - ms;
  for (let a: EntryContext | undefined = cur; a; a = a.parent) {
    if (a.closed) continue;
    let track = a.layerUnions.get(layer);
    if (!track) {
      track = { unionMs: 0, prevEnd: a.startMs };
      a.layerUnions.set(layer, track);
    }
    const covered = contribute(track, start, end, a.startMs);
    contribute(a.waitUnion, start, end, a.startMs);
    contribute(a.busyUnion, start, end, a.startMs);
    // Record a band for exactly the slice the layer track just counted:
    // `[end − covered, end]`. A charge that covered nothing (a fully re-covered
    // interval, or a 0 ms git-memo marker) adds no band, since it added no union
    // — `waitUnion`/`busyUnion` are cross-layer measures and get no bands.
    if (covered > 0) {
      let bands = a.layerBands.get(layer);
      if (!bands) {
        bands = [];
        a.layerBands.set(layer, bands);
      }
      pushBand(bands, layer, end - covered, end, WAIT_BAND_CAP);
    }
  }
}

/**
 * Capture the loader's table read-set into the ambient `EntryContext`. The DB
 * pool wrapper calls this with the tables a loader query touched (extracted from
 * the compiled SQL) while the loader's ambient context is still active. The names
 * accumulate on `cur.tables` (lazily created — read-set only applies to entries
 * that actually query) and are handed to the loader read-set sink by
 * `recordEntrySpan` when the loader entry finishes. If no entry is active, do
 * nothing: a read-set only makes sense inside an entry. Read+charge
 * synchronously, before any await, so the ambient context is still active.
 *
 * NOT gated on the SINGULARITY_PROFILING kill-switch: the read-set is runtime
 * state (see `installLoaderReadSetSink`), and a kill-switched profiler must not
 * silently blind the route drift guard or the persisted `tables_read`.
 *
 * Honors `runWithoutProfiling` suppression for the same reason `record` does:
 * the observability subsystem (reports, slow-ops) issues its own DB writes
 * synchronously inside a slow-span handler — i.e. inside whatever loader
 * triggered the slow span. Without this guard those suppressed writes (e.g.
 * `INSERT INTO reports`, the report's `createTask`/`getTask`) would be
 * mis-attributed to that loader's read-set, fabricating dependency edges.
 *
 * Skips a CLOSED context (`!cur.closed`), exactly like `chargeWait` and
 * `recordEntrySpan`'s child-propagation loop: a detached/fire-and-forget
 * continuation still carries its originating loader's `EntryContext` via the
 * ambient runtime after `recordEntrySpan`'s `finally` has closed the entry and
 * flushed `ctx.tables` to the sink. An append to a finished context's
 * `tables` would be silently lost (the entry flushes exactly once), so making
 * it a structural no-op keeps capture correctness from silently depending on
 * every loader DB read completing before the loader's own return chain settles.
 */
export function recordReadTables(tables: readonly string[]): void {
  if (suppressionRuntime.suppressed()) return;
  const cur = contextRuntime.current();
  if (cur && !cur.closed) {
    cur.tables ??= new Set();
    for (const table of tables) cur.tables.add(table);
  }
}

/**
 * The kind of the innermost enclosing entry point at the current call site, or
 * `undefined` when none is active (e.g. a background job, migration, or poller).
 * A thin read of the same ambient context `recordEntrySpan` maintains — the DB
 * pool wrapper uses it to gate loader-originated queries (caps background load
 * below the pool `max` so interactive work keeps reserved connections) without
 * the runtime needing a separate cost-class taxonomy. Must be read synchronously
 * (before any await) so the ambient context is still active.
 */
export function currentCallerKind(): SpanKind | undefined {
  return contextRuntime.current()?.kind;
}

/**
 * The label of the innermost enclosing entry point at the current call site
 * (the same entry `currentCallerKind` reads), or `undefined` when none is
 * active. The DB pool wrapper stamps it on a lost query's deadline error, so the
 * report names the resource / route / job that issued the query. Must be read
 * synchronously (before any await) so the ambient context is still active.
 */
export function currentEntryLabel(): string | undefined {
  return contextRuntime.current()?.label;
}

/**
 * The lane a unit of work belongs to: `interactive` = a human is blocked on it;
 * `background` = nobody is waiting on this millisecond. Shared-capacity layers
 * (the DB pool gates) partition by this so background demand, however deep its
 * queue grows, can never eat the capacity reserved for a human.
 */
export type OriginClass = "interactive" | "background";

// The lane of an entry kind when it is the ROOT of a chain. Exhaustive over
// `SpanKind` by type, so adding a span kind is a tsc error until it picks a lane
// — the classification can never silently default.
const ORIGIN_CLASS: Record<SpanKind, OriginClass> = {
  // A request handler or mutation: the browser is waiting on the response. Also
  // the root of boot-snapshot's cold fan-out, which awaits its `loadResourceByKey`
  // calls inside the endpoint's own `http` entry rather than detaching.
  http: "interactive",
  // A legitimate root, and interactive: a tab subscribed and is waiting on the
  // ack. (The `GET /api/resources/:key` fallback's `sub` origin now nests under
  // that request's own `http` entry — the runtime's `wrapHttp`.)
  sub: "interactive",
  // A bare `loader` root is reachable only via `loadResourceByKey` /
  // `measureSubscribeCycle`, both human reads today. A future background caller
  // must declare itself by wrapping in its own origin (or `runInBackgroundLane`)
  // rather than relying on this default.
  loader: "interactive",
  // A leaf kind — a `db` span never opens an EntryContext, so it can never be a
  // root. Present for exhaustiveness only.
  db: "interactive",
  // The live-state notify-flush cycle. Nobody is blocked on a recompute landing
  // this millisecond; a late recompute still computes current truth.
  flush: "background",
  // Cascade recompute. Never a root: every `wrapOrigin("push", …)` in
  // `resource-runtime/core/runtime.ts` is reachable only under `flushNotifies` →
  // `wrapFlush`, so a push chain's root is always `flush`. Classified anyway so
  // the table states the intent rather than relying on that reachability.
  push: "background",
  // A dependsOn edge's ids-translation reads. Never a root, for the same reason
  // as `push`.
  cascade: "background",
  // A graphile-worker job body: queued work, by definition nobody is waiting.
  job: "background",
  // A runTracked root: declared detached work we WANT attributed. Background because nobody is blocked on its millisecond, which also routes its DB work through the background lane for free.
  bg: "background",
  // A change-feed notification being routed. Recorded as a leaf, so never a
  // root — classified for exhaustiveness; nobody is blocked on its millisecond.
  route: "background",
  // A window resource's ids query. Never a root — it runs under a `push`
  // origin inside `flush` — classified for the same reason as `cascade`.
  membership: "background",
};

/**
 * The lane of the OUTERMOST enclosing entry at the current call site, or
 * `undefined` when no entry is active — boot, migrations, `warmPool`, graphile
 * internals, the change-feed listener. Context-less work stays UNGATED so boot
 * can never deadlock on a lane gate.
 *
 * The explicit `runInBackgroundLane` declaration wins over the walk: work
 * declared background is background even when a human triggered it.
 *
 * Unlike `currentCallerKind`, this reads the ROOT of the chain, not the
 * innermost entry — inside a resource load the innermost kind is `loader`
 * regardless of *why* the load runs, which is precisely the blindness that let a
 * human's cold sub-ack queue behind hundreds of cascade recomputes. The walk does
 * NOT skip closed ancestors: a detached continuation's origin is still the entry
 * it was spawned from. (Contrast `chargeWait`, which skips them because it
 * MUTATES their materialized tracks; this only reads `kind`.)
 *
 * Deliberately does not honor `runWithoutProfiling`: suppression means "don't
 * record", not "isn't background" — separate axes.
 *
 * Must be read synchronously, before any await, so the ambient context is still
 * active. Allocation-free: a pointer walk of a chain that is ≤4 deep.
 */
export function currentOriginClass(): OriginClass | undefined {
  if (backgroundLaneRuntime.active()) return "background";
  let ctx = contextRuntime.current();
  if (!ctx) return undefined;
  while (ctx.parent) ctx = ctx.parent;
  return ORIGIN_CLASS[ctx.kind];
}

/**
 * Run `fn` as an entry point of the given kind/label: children executed inside
 * `fn` see this entry as their ambient parent, while the entry span itself is
 * recorded against the *outer* parent (so an entry is never its own parent).
 * Used at the HTTP and loader chokepoints.
 *
 * On finish (`finally`), the entry:
 * 1. charges its own execution interval `[t0, t1]` into the NEAREST open
 *    ancestor's `childUnion` + `busyUnion` — nearest only, because each
 *    ancestor's own interval propagates upward when IT finishes; charging
 *    every ancestor would double-count grandchild time;
 * 2. closes its context so late detached work can never mutate it;
 * 3. records with the materialized decomposition: `waitMs` (union of all gate
 *    waits), `childMs` (union of direct-child executions), and
 *    `selfMs = max(0, wall − busyUnion)` — busy is the union of waits AND
 *    child executions, so overlapping wait/child time is not subtracted twice.
 */
export async function recordEntrySpan<T>(
  kind: SpanKind,
  label: string,
  fn: () => T | Promise<T>,
  detail?: SpanDetail,
): Promise<T> {
  const cur = contextRuntime.current();
  const parent: SpanRef | null = cur
    ? { kind: cur.kind, label: cur.label }
    : null;
  const t0 = now();
  // Fresh accumulators per entry, chained to the live parent context: a gate
  // charge deep inside `fn` walks this chain and unions into every open level.
  // All tracks start their frontier at t0 so pre-entry time can never count.
  // The id is minted HERE, at open — children run inside `fn` and must be able
  // to name this run as their parent while it is still in flight.
  const ctx: EntryContext = {
    id: nextSpanId++,
    kind,
    label,
    parent: cur,
    startMs: t0,
    closed: false,
    layerUnions: new Map(),
    layerBands: new Map(),
    waitUnion: { unionMs: 0, prevEnd: t0 },
    busyUnion: { unionMs: 0, prevEnd: t0 },
    childUnion: { unionMs: 0, prevEnd: t0 },
  };
  openEntries.add(ctx);
  try {
    return await contextRuntime.run(ctx, fn);
  } finally {
    const t1 = now();
    // (1) Propagate this entry's execution interval to the nearest OPEN
    // ancestor only (see doc comment). Skipping closed ancestors keeps a
    // detached child (finishing after its parent already recorded) from
    // mutating a finished timeline; if everything up the chain is closed, the
    // interval is dropped — conservative, the ancestors' records are final.
    for (let a: EntryContext | undefined = ctx.parent; a; a = a.parent) {
      if (a.closed) continue;
      contribute(a.childUnion, t0, t1, a.startMs);
      contribute(a.busyUnion, t0, t1, a.startMs);
      break;
    }
    // (2) Close before recording so nothing can race a mutation in between.
    ctx.closed = true;
    // Deregister before record() so the tripping span is never in its own
    // captured `open` list (it is the snapshot's trip). Paired with the add
    // above on every path — the finally guarantees no leak.
    openEntries.delete(ctx);
    // (3) Materialize the decomposition and record.
    const wall = t1 - t0;
    const waitMs = ctx.waitUnion.unionMs;
    const childMs = ctx.childUnion.unionMs;
    const selfMs = Math.max(0, wall - ctx.busyUnion.unionMs);
    let waits: WaitBreakdown | undefined;
    if (ctx.layerUnions.size > 0) {
      waits = {};
      for (const [layer, track] of ctx.layerUnions)
        waits[layer] = track.unionMs;
    }
    // Flatten the per-layer bands into one list. The context is closed and about
    // to be discarded, so the band objects can be handed off by reference.
    let waitBands: WaitBand[] | undefined;
    if (ctx.layerBands.size > 0) {
      waitBands = [];
      for (const bands of ctx.layerBands.values()) {
        for (const b of bands) waitBands.push(b);
      }
    }
    const parentId = ctx.parent ? ctx.parent.id : null;
    record(
      kind,
      label,
      wall,
      ctx.id,
      parentId,
      parent,
      waits,
      waitMs,
      childMs,
      selfMs,
      waitBands,
      detail,
    );
    // Hand the loader's captured table read-set to the sink, keyed by label
    // (the resource key). Gating on `loader` kind means a stray table captured
    // under a non-loader entry is never indexed. Done after `record` so it can
    // never affect span recording — and whatever `record` decided to keep.
    if (kind === "loader" && ctx.tables && ctx.tables.size > 0) {
      loaderReadSetSink?.(label, ctx.tables);
    }
  }
}

export function getRuntimeProfile(): {
  aggregates: Record<SpanKind, Aggregate[]>;
  slowest: Record<SpanKind, SlowSpan[]>;
  sinceMs: number;
} {
  const nowMs = now();
  // A bucket is live while its index is within the window of the CURRENT
  // bucket index — matching the eviction rule in record(), which only runs on
  // rollover, so idle aggregates decay here rather than there.
  const liveFloor = Math.floor(nowMs / BUCKET_MS) - WINDOW_BUCKETS;
  const aggOut = {} as Record<SpanKind, Aggregate[]>;
  const slowOut = {} as Record<SpanKind, SlowSpan[]>;
  for (const kind of KINDS) {
    aggOut[kind] = Array.from(aggregates[kind].values())
      .map((agg) => {
        let recentMaxMs = 0;
        for (const bucket of agg.recentBuckets) {
          if (bucket.at > liveFloor && bucket.max > recentMaxMs)
            recentMaxMs = bucket.max;
        }
        return {
          label: agg.label,
          count: agg.count,
          totalMs: agg.totalMs,
          maxMs: agg.maxMs,
          lastMs: agg.lastMs,
          waitTotalMs: agg.waitTotalMs,
          childTotalMs: agg.childTotalMs,
          selfTotalMs: agg.selfTotalMs,
          recentMaxMs,
          maxAgeMs: nowMs - agg.maxAtMs,
          byParent: Array.from(agg.byParent.values()).sort(
            (a, b) => b.count - a.count,
          ),
          waits: agg.waits ? { ...agg.waits } : undefined,
          measuresMax: agg.measuresMax ? { ...agg.measuresMax } : undefined,
        };
      })
      // Live relevance first: a label spiking NOW outranks one whose since-boot
      // peak is stale (the aged peak stays readable via maxMs + maxAgeMs).
      .sort((a, b) => b.recentMaxMs - a.recentMaxMs);
    // Most-recent-slowest first: sort the slowest-N buffer by duration desc.
    slowOut[kind] = [...slowest[kind]].sort(
      (a, b) => b.durationMs - a.durationMs,
    );
  }
  return { aggregates: aggOut, slowest: slowOut, sinceMs };
}

// Clears every per-aggregate accumulator (the new maxAtMs/recentBuckets/totals
// live on the aggregate objects, so dropping the maps drops them too). Live
// EntryContexts are intentionally untouched: an in-flight entry records into
// the fresh store when it finishes.
export function resetRuntimeProfile(): void {
  for (const kind of KINDS) {
    aggregates[kind].clear();
    slowest[kind].length = 0;
  }
  // The flight ring is profile data — clear it. Gate gauges are structural
  // registrations (like slow-span subscribers), not profile data, so they
  // survive. `openEntries` is owned by the in-flight calls themselves: each
  // live context deregisters in its own finally, so clearing here would only
  // break the add/delete pairing. `nextSpanId` is likewise NOT reset: those
  // same live contexts keep their ids, and a restarted counter would reissue
  // them to fresh spans (see `nextSpanId`).
  for (const slot of flightRing) {
    slot.used = false;
    // Drop the stored references so a reset frees them (and a stale band can
    // never be read back through a slot marked unused).
    slot.waits = undefined;
    slot.waitBands = undefined;
  }
  flightRingHead = 0;
  sinceMs = now();
}
