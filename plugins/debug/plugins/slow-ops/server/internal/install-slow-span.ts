import {
  onSlowSpan,
  onSlowWait,
  type SlowSpan,
  type SlowWait,
} from "@plugins/infra/plugins/runtime-profiler/core";
import { captureTrace } from "@plugins/debug/plugins/trace/plugins/engine/server";
import { WAIT_KIND } from "../../shared/endpoints";
import { recordSlowOp } from "./record-slow-op";
import {
  perfFloorMs,
  resolveSlowThreshold,
  slowSpanMs,
  type Thresholds,
} from "./resolve-threshold";

// The current onSlowSpan subscription. Reinstalled on every config change so the
// perf-floor (the static `thresholdMs` guard) tracks the lowest configured
// threshold. The handler closure reads the LATEST thresholds object (captured
// per (re)install) and does the final per-kind gating.
let disposer: { dispose(): void } | null = null;
let waitDisposer: { dispose(): void } | null = null;

export function installSlowSpanHook(thresholds: Thresholds): void {
  // Dispose the prior subscription before creating a new one so config changes
  // never leave a stale hook installed.
  if (disposer) {
    disposer.dispose();
    disposer = null;
  }
  if (waitDisposer) {
    waitDisposer.dispose();
    waitDisposer = null;
  }

  // Perf floor: the profiler only calls back for spans at least this long, so a
  // fast span never reaches our handler. The handler then applies the precise
  // per-kind threshold. Config knobs are no longer the only source of
  // thresholds — a job's bar is its hold class's ceiling — so the floor is
  // computed where both live (`perfFloorMs`), never re-derived here.
  const floor = perfFloorMs(thresholds);

  // The handler runs SYNCHRONOUSLY in the profiler hot path — it must only
  // schedule, never block or throw.
  disposer = onSlowSpan(
    (span: SlowSpan) => {
      const threshold = resolveSlowThreshold(span, thresholds);
      // Every kind is judged on its OWN time (`durationMs − waitMs`) — see
      // `slowSpanMs`. Time queued on a gate is the gate's, filed against it by
      // the `onSlowWait` subscription below; a `sub` that spent 7.7 s of 9 s
      // queued on `read-admit` is not itself slow.
      const ownMs = slowSpanMs(span);
      if (ownMs < threshold) return;
      // 1. Evidence FIRST, synchronously: captureTrace's admission + the sync
      // coherent-instant capture must run before any await so the flight window
      // (open spans, gate occupancy) describes THIS trip's instant. Admission is
      // one Map lookup per slow span in a storm; enrich + persist detach inside.
      // Returns the minted trace id (for linkage) or null when rate-limited /
      // disabled — never throws into this profiler hot path.
      const trace = captureTrace({
        kind: span.kind,
        label: span.label,
        durationMs: span.durationMs,
        thresholdMs: threshold,
        detail: {
          // The tripping span's per-instance id: the captured flight window
          // contains this exact run (the ring write precedes this notify), so a
          // reader can root the call tree at it rather than guessing by label.
          spanId: span.id,
          parent: span.parent,
          waits: span.waits,
          waitMs: span.waitMs,
          childMs: span.childMs,
          selfMs: span.selfMs,
          ...(span.detail && { spanDetail: span.detail }),
        },
      });
      // 2. Aggregate + report — the existing funnel, now stamped with the link.
      // Fire-and-forget: detaching the promise keeps the profiler hot path
      // non-blocking, and a failed recordSlowOp surfaces as an unhandled
      // rejection that the reports plugin captures and files — never silently
      // swallowed. `span.parent` carries the caller attribution this refactor
      // exists to capture.
      // eslint-disable-next-line detached-work-safety/no-untracked-detached-work -- observability write: recordSlowOp persists via its own background-lane/suppressed path; must stay profiler-invisible
      void recordSlowOp({
        operationKind: span.kind,
        operation: span.label,
        durationMs: span.durationMs,
        ownMs,
        thresholdMs: threshold,
        source: "server-slow-op",
        caller: span.parent,
        waits: span.waits,
        detail: span.detail,
        traceId: trace?.id,
      });
    },
    { thresholdMs: floor },
  );

  // The gate as the slow op: a `queue` wait at least the loader bar long files
  // `wait <layer>` — once per wait, where it happened, its waiter the caller —
  // so a congested gate is ONE row and one report naming it, with every op
  // that queued on it among its callers, instead of a report against each of
  // them. The profiler hands only `queue` waits here (a `join` is the run it
  // joined, which reports itself). Judged against `loaderMs`: no separate knob,
  // which would also lower the perf floor for every span.
  waitDisposer = onSlowWait(
    (wait: SlowWait) => {
      const threshold = thresholds.loaderMs;
      const trace = captureTrace({
        kind: WAIT_KIND,
        label: wait.layer,
        durationMs: wait.ms,
        thresholdMs: threshold,
        detail: { caller: wait.caller },
      });
      // eslint-disable-next-line detached-work-safety/no-untracked-detached-work -- observability write: recordSlowOp persists via its own background-lane/suppressed path; must stay profiler-invisible
      void recordSlowOp({
        operationKind: WAIT_KIND,
        operation: wait.layer,
        durationMs: wait.ms,
        ownMs: wait.ms,
        thresholdMs: threshold,
        source: "server-slow-op",
        caller: wait.caller,
        traceId: trace?.id,
      });
    },
    { thresholdMs: thresholds.loaderMs },
  );
}
