// Server-only: install an AsyncLocalStorage-backed ambient-context runtime into
// the (otherwise pure) recorder. This file lives under server/ and is never
// imported by the web bundle, so it may freely use node:async_hooks. Importing
// it (via the server barrel, which the plugin registry loads at boot) installs
// the runtime before Bun.serve starts handling requests.

import { AsyncLocalStorage } from "node:async_hooks";
import {
  installFsAwait,
  onSlowFsCall,
} from "@plugins/packages/plugins/timed-fs/core";
import {
  recordLoaderReadSet,
  setProfilerHooks,
  type LoaderReadsSink,
  type ProfilerLeafOptions,
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
import {
  installLeaseContextRuntime,
  whileWaiting,
  type LeaseScope,
} from "@plugins/packages/plugins/semaphore/core";

// Stores the EntryContext by identity: AsyncLocalStorage preserves the same
// object reference across the entry's async continuation, so a gate awaited deep
// inside a loader mutates the very wait map `recordEntrySpan` later reads.
const als = new AsyncLocalStorage<EntryContext>();

// A file read past timed-fs's floor is the disk's time, not the caller's: charge
// it as an `io` wait on its layer (`fs-read` / `fs-readdir` / `fs-stat` /
// `fs-glob`), so the enclosing entries name it and slow-ops files it as
// `wait fs-<op>` instead of folding it into the caller's own time. Called as the
// call returns, still inside the caller's ambient context.
onSlowFsCall((call) => chargeWait(call.layer, call.ms, "io"));

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

// Separate ALS for the semaphore's yieldable-slot scope (packages/semaphore,
// `lease-scope.ts`): which gate slots the running code holds, so a wait on
// another caller's work (`whileWaiting` — an inflight join) gives them back for
// the wait. Without it the live read-admission slot is held while its read
// only waits, and reads waiting on one slow read stall every unrelated one.
// Installed here, with the server's other ambient contexts, because a server
// barrel of the semaphore's own would cycle through server-core.
const leaseAls = new AsyncLocalStorage<LeaseScope>();

installLeaseContextRuntime({
  run: (scope, fn) => leaseAls.run(scope, fn),
  current: () => leaseAls.getStore(),
});

// A read waiting on the disk waits like one waiting on another caller's work:
// every awaited timed-fs call gives the read-admit slot back while it is
// pending. Without it, six reads stalled in their own file calls (main,
// 2026-11-03: the projects-dir glob, a transcript lstat) hold every slot and
// each unrelated read queues behind the disk. Measured
// (resource-runtime/scripts/fs-yield-bench.ts): unrelated reads behind six reads
// stalled 2 s answered at a median of ~2,050 ms holding the slot, 33–49 ms
// yielding; a herd of 60 reads × 40 stats showed no thrash (67–113 ms held,
// 66–69 ms yielded), at most 6 calls in flight.
installFsAwait((pending) => whileWaiting(pending));

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
    onReads?: LoaderReadsSink,
  ): Promise<T> =>
    recordEntrySpan(kind as SpanKind, label, fn, detail, onReads),
  runTracked,
  recordSpan: (
    kind: string,
    label: string,
    durationMs: number,
    detail?: ProfilerSpanDetail,
    opts?: ProfilerLeafOptions,
  ): void => recordSpan(kind as SpanKind, label, durationMs, detail, opts),
  chargeWait,
  registerGateGauge: (layer: string, read: () => unknown): void =>
    registerGateGauge(layer, read as () => GateGauge),
  getRuntimeProfile: () => {
    const p = getRuntimeProfile();
    return { aggregates: { loader: p.aggregates.loader }, sinceMs: p.sinceMs };
  },
});
