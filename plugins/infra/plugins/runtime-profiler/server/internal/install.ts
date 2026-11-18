// Server-only: install an AsyncLocalStorage-backed ambient-context runtime into
// the (otherwise pure) recorder. This file lives under server/ and is never
// imported by the web bundle, so it may freely use node:async_hooks. Importing
// it (via the server barrel, which the plugin registry loads at boot) installs
// the runtime before Bun.serve starts handling requests.

import { AsyncLocalStorage } from "node:async_hooks";
import {
  FS_WAIT_FLOOR_MS,
  installFsUse,
  installFsWaitMeter,
} from "@plugins/packages/plugins/timed-fs/core";
import {
  recordLoaderReadSet,
  setProfilerHooks,
  type LoaderReadsSink,
  type ProfilerEntryCost,
  type ProfilerEntryOptions,
  type ProfilerLeafOptions,
  type ProfilerMeasureName,
  type ProfilerSpanDetail,
} from "@plugins/framework/plugins/server-core/core";
import {
  installSpanContextRuntime,
  installProfilingSuppressionRuntime,
  installBackgroundLaneRuntime,
  installAsyncContextRuntime,
  installBootHookScopeRuntime,
  installLoaderReadSetSink,
  recordEntrySpan,
  runTracked,
  runBootHook,
  recordSpan,
  beginWait,
  beginDeferredWait,
  gateWaitHooks,
  runInRootContext,
  getRuntimeProfile,
  registerGateGauge,
  type BootHookScope,
  type EntryContext,
  type EntryCost,
  type SpanKind,
  type SpanMeasure,
  type GateReading,
  type LeafSpanOptions,
} from "../../core";
import { installInflightJoinMeter } from "@plugins/packages/plugins/inflight/core";
import {
  installLeaseContextRuntime,
  usingSlot,
  type LeaseScope,
} from "@plugins/packages/plugins/semaphore/core";
import { installSpawnUse } from "@plugins/infra/plugins/spawn/core";

// Stores the EntryContext by identity: AsyncLocalStorage preserves the same
// object reference across the entry's async continuation, so a gate awaited deep
// inside a loader mutates the very wait map `recordEntrySpan` later reads.
const als = new AsyncLocalStorage<EntryContext>();

// A file call past timed-fs's floor is the disk's time, not the caller's: it is
// an `io` wait on its layer (`fs-read` / `fs-readdir` / `fs-stat` / `fs-glob`),
// so the enclosing entries name it and slow-ops files it as `wait fs-<op>`
// instead of folding it into the caller's own time. Metered as it STARTS, in the
// caller's ambient context — a deferred wait, since nearly every call is over
// in microseconds: one still running past the floor is shown in progress (a
// read hung on a dead mount reads to the stuck-span watchdog as a wait on the
// filesystem), and its end charges it. Measured overhead per call
// (scripts/fs-meter-bench.ts): see the plugin's CLAUDE.md.
installFsWaitMeter((layer) => beginDeferredWait(layer, "io", FS_WAIT_FLOOR_MS));

// A joiner of a deduplicated flight waits on the starter's work: every
// `createInflight(name)` join its caller names no layer for is the
// `inflight:<name>` join wait, so the joiner's span never books the starter's
// time as its own. Installed, not imported: the resource runtime builds on
// inflight, and this plugin's server half on the runtime.
installInflightJoinMeter((layer) => beginWait(layer, "join"));

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

// Separate ALS for the semaphore's use-scoped slots (packages/semaphore,
// `lease-scope.ts`): which gate slots the running code may hold, so a leaf use
// of a resource (`usingSlot`) holds its live read's slot for exactly its own
// length and nothing else does. Without it a use-scoped gate holds its slot for
// the whole body. Installed here, with the server's other ambient contexts,
// because a server barrel of the semaphore's own would cycle through
// server-core.
const leaseAls = new AsyncLocalStorage<LeaseScope>();

installLeaseContextRuntime({
  run: (scope, fn) => leaseAls.run(scope, fn),
  current: () => leaseAls.getStore(),
});

// A file call is a use of the disk: inside a live read it holds the read-admit
// slot for its own length (taken back first when the read gave it back), so
// the gate bounds the reads' concurrent file work and nothing else. A child
// process is a use of the `read-spawn` gate the same way: waiting on it holds
// no read-admit slot. research/2026-11-18-network-read-admit-use-scoped-slots.md
installFsUse((start) => usingSlot("fs", start));
installSpawnUse((start) => usingSlot("spawn", start));

// Separate ALS for the boot-hook scope: which boot hook started the running
// code, so the work a hook leaves running when it returns is named however deep
// in its call chain it was started (`runBootHook`, read by server-core's boot
// phases). A runTracked declared `outlivesBootHook` runs with no scope.
const bootHookAls = new AsyncLocalStorage<BootHookScope | undefined>();

installBootHookScopeRuntime({
  run: (scope, fn) => bootHookAls.run(scope, fn),
  current: () => bootHookAls.getStore(),
});

// The root context, captured here — at module eval, outside every scope above —
// so `runInRootContext` (a change producer's coalescing timer and flush) runs
// there whoever triggered it. `captureContext` snapshots the caller's own, for
// work run later on its behalf (a coalescer's trailing run).
const inRoot = AsyncLocalStorage.snapshot();

installAsyncContextRuntime({
  root: (fn) => inRoot(fn),
  capture: () => AsyncLocalStorage.snapshot(),
});

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
// Same for the cost an entry hands `onCost`: the seam's spelling and the
// recorder's must stay one shape.
const _seamCoversCost: ProfilerEntryCost = null as unknown as EntryCost;
const _costCoversSeam: EntryCost = null as unknown as ProfilerEntryCost;
void _seamCoversCost;
void _costCoversSeam;

setProfilerHooks({
  recordEntrySpan: <T>(
    kind: string,
    label: string,
    fn: () => T | Promise<T>,
    detail?: ProfilerSpanDetail,
    onReads?: LoaderReadsSink,
    opts?: ProfilerEntryOptions,
  ): Promise<T> =>
    recordEntrySpan(kind as SpanKind, label, fn, detail, onReads, opts),
  runTracked,
  recordSpan: (
    kind: string,
    label: string,
    durationMs: number,
    detail?: ProfilerSpanDetail,
    opts?: ProfilerLeafOptions,
  ): void =>
    recordSpan(
      kind as SpanKind,
      label,
      durationMs,
      detail,
      opts?.latency && opts.joinsOf
        ? {
            ...opts,
            joinsOf: {
              kind: opts.joinsOf.kind as SpanKind,
              label: opts.joinsOf.label,
            },
          }
        : (opts as LeafSpanOptions | undefined),
    ),
  beginWait,
  gateWaitHooks,
  runInRootContext,
  runBootHook,
  registerGateGauge: (layer: string, read: () => unknown): void =>
    registerGateGauge(layer, read as () => GateReading),
  getRuntimeProfile: () => {
    const p = getRuntimeProfile();
    return { aggregates: { loader: p.aggregates.loader }, sinceMs: p.sinceMs };
  },
});
