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
  chargeWait(layer: string, ms: number, kind: "queue" | "join"): void;
  /** A wait that just started, shown until the returned end is called (the profiler's `beginWait`). */
  beginWait(layer: string, kind: "queue" | "join"): () => void;
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

/**
 * Charge a wait to the enclosing spans. `kind`: `queue` — for capacity on a
 * shared gate (the gate's time); `join` — for an identical run already in
 * flight, or a 0 ms marker (that run's time). See runtime-profiler's `WaitKind`.
 */
export function chargeWait(
  layer: string,
  ms: number,
  kind: "queue" | "join",
): void {
  hooks?.chargeWait(layer, ms, kind);
}

const NO_WAIT_END = (): void => {};

/**
 * Show a wait while it is still in progress; call the returned function when
 * it ends (it charges nothing — `chargeWait` at the end still does). See
 * runtime-profiler's `beginWait`: a wait charged only at its end makes the
 * waiter look busy with its own work until then.
 */
export function beginWait(layer: string, kind: "queue" | "join"): () => void {
  return hooks ? hooks.beginWait(layer, kind) : NO_WAIT_END;
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
