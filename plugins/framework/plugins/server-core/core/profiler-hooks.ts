// Profiler seam (dependency inversion).
//
// server-core's resource runtime needs profiler instrumentation, but the
// profiler (`infra/plugins/runtime-profiler`) is an INFRA plugin that sits ABOVE
// the framework core — every server plugin (runtime-profiler included) imports
// `ServerPluginDefinition` from here, so a direct `server-core → runtime-profiler`
// import made the cross-plugin graph cyclic. Instead, server-core declares the
// hooks it needs here with safe no-op defaults, and runtime-profiler INJECTS the
// real implementation at boot via `setProfilerHooks`.

/** Minimal view of a loader aggregate that server-core reads for the _debug endpoint. */
export interface LoaderAggregateView {
  label: string;
  count: number;
  maxMs: number;
}

/** Minimal view of the runtime profile server-core reads (loader aggregates + window origin). */
export interface RuntimeProfileView {
  aggregates: { loader: LoaderAggregateView[] };
  sinceMs: number;
}

/**
 * The measure names a span can carry — the profiler's `SPAN_MEASURES`, spelled
 * here because server-core cannot import the profiler. runtime-profiler's
 * install asserts the two sets are equal at the type level, so they cannot drift.
 */
export type ProfilerMeasureName =
  "subscribers" | "frameChars" | "ids" | "sinceChangeMs" | "waitCount";

/**
 * One loader entry's own table read-set as its span closes (`[]` included),
 * with each table's read tags (`undefined` when none was tagged) — the
 * resource runtime's `RunCapture`, seen through the seam.
 */
export type LoaderReadsSink = (
  tables: ReadonlySet<string>,
  tags: ReadonlyMap<string, ReadonlySet<string | null>> | undefined,
) => void;

/** The profiler's `SpanDetail`, seen through the seam. */
export interface ProfilerSpanDetail {
  variant?: string;
  measures?: Partial<Record<ProfilerMeasureName, number>>;
}

/**
 * The profiler's `LeafSpanOptions`, seen through the seam: a `queue` exists
 * only on a latency leaf.
 */
export type ProfilerLeafOptions =
  | { waits?: Record<string, number>; latency?: false }
  | {
      waits?: Record<string, number>;
      latency: true;
      queue?: { layer: string; ms: number };
      /** The entry run this window delivers: its join waits are not the leaf's (the profiler's `joinsOf`). */
      joinsOf?: { kind: string; label: string };
    };

/** The profiler's `EntrySpanOptions`, seen through the seam (the part server-core uses). */
export interface ProfilerEntryOptions {
  /** Handed the entry's subtree join waits (ms) as it closes. */
  onJoined?: (joinedMs: number) => void;
}

/**
 * The profiler operations server-core's resource runtime depends on. Param types
 * are deliberately widened (`kind`/`layer` as `string`) so the framework core
 * carries no profiler-internal type (`SpanKind`, `GateGauge`); runtime-profiler
 * supplies a matching implementation and owns any casts.
 */
export interface ProfilerHooks {
  /** `onReads` (a `loader` entry only): its own capture, as its span closes. */
  recordEntrySpan<T>(
    kind: string,
    label: string,
    fn: () => T | Promise<T>,
    detail?: ProfilerSpanDetail,
    onReads?: LoaderReadsSink,
    opts?: ProfilerEntryOptions,
  ): Promise<T>;
  /** `opts.budgetMs`: the bar the call site declares (the profiler's `SlowSpan.budgetMs`). */
  runTracked<T>(
    label: string,
    fn: () => T | Promise<T>,
    opts?: { budgetMs?: number },
  ): Promise<T>;
  recordSpan(
    kind: string,
    label: string,
    durationMs: number,
    detail?: ProfilerSpanDetail,
    opts?: ProfilerLeafOptions,
  ): void;
  /** A wait that just started: shown until the returned end, which charges it (the profiler's `beginWait`). */
  beginWait(layer: string, kind: "queue" | "join"): () => void;
  /** A semaphore gate's announce/charge pair for one layer (the profiler's `gateWaitHooks`). */
  gateWaitHooks(layer: string): GateWaitHooks;
  getRuntimeProfile(): RuntimeProfileView;
  registerGateGauge(layer: string, read: () => unknown): void;
  /** Run `fn` outside every entry, lane and suppression scope (the profiler's `runInRootContext`). */
  runInRootContext<T>(fn: () => T): T;
}

let hooks: ProfilerHooks | null = null;

// Gate gauges registered before the profiler is installed. The resource runtime
// registers its read-admit gauge at module-load of resources.ts — which happens
// (server-core/core is imported by every plugin) before the runtime-profiler
// plugin's boot side-effect calls setProfilerHooks. Buffer and replay on inject
// so the gauge is never silently dropped.
const pendingGauges: Array<{ layer: string; read: () => unknown }> = [];

export function setProfilerHooks(impl: ProfilerHooks): void {
  hooks = impl;
  for (const g of pendingGauges) impl.registerGateGauge(g.layer, g.read);
  pendingGauges.length = 0;
}

export function recordEntrySpan<T>(
  kind: string,
  label: string,
  fn: () => T | Promise<T>,
  detail?: ProfilerSpanDetail,
  onReads?: LoaderReadsSink,
  opts?: ProfilerEntryOptions,
): Promise<T> {
  return hooks
    ? hooks.recordEntrySpan(kind, label, fn, detail, onReads, opts)
    : Promise.resolve(fn());
}

export function runTracked<T>(
  label: string,
  fn: () => T | Promise<T>,
  opts?: { budgetMs?: number },
): Promise<T> {
  return hooks ? hooks.runTracked(label, fn, opts) : Promise.resolve(fn());
}

export function recordSpan(
  kind: string,
  label: string,
  durationMs: number,
  detail?: ProfilerSpanDetail,
  opts?: ProfilerLeafOptions,
): void {
  hooks?.recordSpan(kind, label, durationMs, detail, opts);
}

const NO_WAIT_END = (): void => {};

/**
 * A wait that has just STARTED: shown on the enclosing spans while it lasts,
 * and charged to them when the returned function is called — once. `kind`:
 * `queue` — for capacity on a shared gate (the gate's time); `join` — for an
 * identical run already in flight (that run's time). See runtime-profiler's
 * `beginWait`: there is no bare after-the-fact charge, so a wait the profiler
 * meters is always shown while it is in progress.
 */
export function beginWait(layer: string, kind: "queue" | "join"): () => void {
  return hooks ? hooks.beginWait(layer, kind) : NO_WAIT_END;
}

/**
 * A concurrency gate's two observers for one `queue` layer — what a
 * `packages/semaphore` gate's `SlotOptions` take: `onQueued` shows a caller
 * that has to queue, `onWait` charges the wait at admission. One value, so a
 * gate cannot charge a wait it never shows. See runtime-profiler's
 * `gateWaitHooks`.
 */
export interface GateWaitHooks {
  onQueued: () => () => void;
  onWait: (ms: number) => void;
}

export function gateWaitHooks(layer: string): GateWaitHooks {
  // Resolved per call, never captured: a gate built at module eval (the read
  // gate's, in resources.ts) exists before the profiler is installed.
  return {
    onQueued: () =>
      hooks ? hooks.gateWaitHooks(layer).onQueued() : NO_WAIT_END,
    onWait: (ms) => hooks?.gateWaitHooks(layer).onWait(ms),
  };
}

export function getRuntimeProfile(): RuntimeProfileView {
  return hooks
    ? hooks.getRuntimeProfile()
    : { aggregates: { loader: [] }, sinceMs: performance.now() };
}

export function registerGateGauge(layer: string, read: () => unknown): void {
  if (hooks) hooks.registerGateGauge(layer, read);
  else pendingGauges.push({ layer, read });
}

/**
 * Run `fn` in the root async context: outside every request, loader, lane and
 * suppression scope, so the work it starts is attributed to itself, never to
 * whatever happened to trigger it. Identity until the profiler is installed.
 */
export function runInRootContext<T>(fn: () => T): T {
  return hooks ? hooks.runInRootContext(fn) : fn();
}
