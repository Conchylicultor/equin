// Server-only: install an AsyncLocalStorage-backed ambient-context runtime into
// the (otherwise pure) recorder. This file lives under server/ and is never
// imported by the web bundle, so it may freely use node:async_hooks. Importing
// it (via the server barrel, which the plugin registry loads at boot) installs
// the runtime before Bun.serve starts handling requests.

import { AsyncLocalStorage } from "node:async_hooks";
import {
  recordLoaderReadSet,
  setProfilerHooks,
  type ProfilerMeasureName,
  type ProfilerSpanDetail,
} from "@plugins/framework/plugins/server-core/core";
import {
  installSpanContextRuntime,
  installProfilingSuppressionRuntime,
  installBackgroundLaneRuntime,
  installRootContextRuntime,
  installLoaderReadSetSink,
  recordEntrySpan,
  runTracked,
  recordSpan,
  chargeWait,
  getRuntimeProfile,
  registerGateGauge,
  type EntryContext,
  type SpanKind,
  type SpanMeasure,
  type GateGauge,
} from "../../core";

// Stores the EntryContext by identity: AsyncLocalStorage preserves the same
// object reference across the entry's async continuation, so a gate awaited deep
// inside a loader mutates the very wait map `recordEntrySpan` later reads.
const als = new AsyncLocalStorage<EntryContext>();

installSpanContextRuntime({
  run: (ctx, fn) => als.run(ctx, fn),
  current: () => als.getStore(),
});

// Separate ALS for the profiling-suppression scope. Backs runWithoutProfiling so
// the observability subsystem's own DB writes (reports/slow-ops inserts) never
// re-enter the recorder. AsyncLocalStorage propagates `true` across the awaited
// DB work spawned synchronously inside the scope, so the connection-acquire and
// query spans recorded by the pool wrapper during the await are suppressed too.
const suppressAls = new AsyncLocalStorage<true>();

installProfilingSuppressionRuntime({
  run: (fn) => suppressAls.run(true, fn),
  suppressed: () => suppressAls.getStore() === true,
});

// Separate ALS for the background-lane declaration. Backs runInBackgroundLane so
// the observability subsystem's own writes and the queue's job-cleanup writes are
// classified background whatever triggered them. AsyncLocalStorage propagates
// `true` across the awaited DB work spawned synchronously inside the scope — that
// propagation is exactly what routes a nested `db.transaction()`'s
// `pool.connect()` (and every query it awaits) into the background lane, rather
// than only the first synchronous statement.
const backgroundLaneAls = new AsyncLocalStorage<true>();

installBackgroundLaneRuntime({
  run: (fn) => backgroundLaneAls.run(true, fn),
  active: () => backgroundLaneAls.getStore() === true,
});

// The root context, captured here — at module eval, outside every scope above —
// so `runInRootContext` (a change producer's coalescing timer and flush) runs
// there whoever triggered it.
const inRoot = AsyncLocalStorage.snapshot();

installRootContextRuntime({ run: (fn) => inRoot(fn) });

// Each finished loader entry hands its captured tables to server-core's
// runtime-owned read-set — what the route drift guard (A8 / D5) and the persisted
// `tables_read` read, so it lives with the runtime rather than in this recorder (whose profile data
// a reset clears and whose kill-switch drops spans). This plugin owns only the
// capture scope: the ambient loader entry installed above.
installLoaderReadSetSink(recordLoaderReadSet);

// Inject the profiler into server-core's resource runtime. server-core declares
// the seam (core/profiler-hooks.ts) with no-op defaults and never imports this
// plugin — inverting what would otherwise be a server-core ⇄ runtime-profiler
// cross-plugin cycle. The thin wrappers carry the profiler-internal types
// (SpanKind, GateGauge) that the widened seam deliberately omits.
//
// The seam spells the measure names itself (`ProfilerMeasureName`); these two
// assignments fail to compile the moment it and SPAN_MEASURES disagree in
// either direction, so the detail passes through without a cast.
const _seamCoversMeasures: ProfilerMeasureName = null as unknown as SpanMeasure;
const _measuresCoverSeam: SpanMeasure = null as unknown as ProfilerMeasureName;
void _seamCoversMeasures;
void _measuresCoverSeam;

setProfilerHooks({
  recordEntrySpan: <T>(
    kind: string,
    label: string,
    fn: () => T | Promise<T>,
    detail?: ProfilerSpanDetail,
  ): Promise<T> => recordEntrySpan(kind as SpanKind, label, fn, detail),
  runTracked,
  recordSpan: (
    kind: string,
    label: string,
    durationMs: number,
    detail?: ProfilerSpanDetail,
  ): void => recordSpan(kind as SpanKind, label, durationMs, detail),
  chargeWait,
  registerGateGauge: (layer: string, read: () => unknown): void =>
    registerGateGauge(layer, read as () => GateGauge),
  getRuntimeProfile: () => {
    const p = getRuntimeProfile();
    return { aggregates: { loader: p.aggregates.loader }, sinceMs: p.sinceMs };
  },
});
