import type { SlowSpan } from "@plugins/infra/plugins/runtime-profiler/core";
import {
  ceilingMsFor,
  getJobHold,
  getJobSlowThresholdMs,
  HOLD_CLASSES,
} from "@plugins/infra/plugins/jobs/server";
import { getRouteSlowThresholdMs } from "@plugins/infra/plugins/endpoints/core";
import type { ConfigValues } from "@plugins/config_v2/core";
import type { slowOpConfig } from "../../core";

export type Thresholds = ConfigValues<(typeof slowOpConfig)["fields"]>;

// This file owns BOTH halves of "is this span slow": which quantity is compared
// (`slowSpanMs`) and what it is compared against (`resolveSlowThreshold`), plus
// the perf floor that keeps fast spans out of the profiler hot path
// (`perfFloorMs`). They are one decision and must not be split across files —
// a threshold below the floor is a threshold nobody can ever reach.

/**
 * The quantity a span is judged on.
 *
 * Wall-clock for every kind EXCEPT `job`, which is judged on **work time**
 * (`durationMs − waitMs`): the part of the run that is actually a property of
 * the handler.
 *
 * A job's slot-hold is substantially not its own doing. `jobs.dead-gc` was
 * measured holding a worker slot for **77 s while doing 254 ms of work** — the
 * rest blocked on `background-tx-acquire`, an admission gate entered *after*
 * graphile had already handed it a slot. `debug.session-divergence-monitor`:
 * 25.6 s hold, 4.2 s work. `mail.sync-tick`: 85% wait. Judging a job on hold
 * would file a slot-hog report against a correctly-classified `instant` job
 * every time the DB background lane got busy — punishing it for someone else's
 * congestion, and training every author to inflate their `hold` class until the
 * signal is worthless.
 *
 * `waitMs` is a wall-clock-overlapping OVERLAY, not an additive component: the
 * recorder accumulates it as an interval union over the span's own timeline, so
 * `waitMs ≤ durationMs` holds at every level and this subtraction can never go
 * negative (`runtime-profiler/core/recorder.ts`, "Wall-clock decomposition").
 * Only *named gate* waits count as wait — a model call's latency is work, which
 * is what makes a `seconds` job's own timeout the thing that bounds it.
 *
 * Note this is deliberately NOT `selfMs`. `selfMs` also subtracts child-span
 * execution, which would credit a job for the work its own DB queries did. For
 * a leaf-shaped handler the two coincide (`77,111 − 76,858 = 253 ≈ selfMs 254`);
 * where they differ, work-including-children is the quantity a hold class means.
 *
 * The recorded slow-op row still carries wall-clock `durationMs` plus its
 * per-layer `waits`, so the wait-vs-work split stays recoverable from the row.
 */
export function slowSpanMs(span: SlowSpan): number {
  if (span.kind !== "job") return span.durationMs;
  return Math.max(0, span.durationMs - span.waitMs);
}

// Map a span to its configured threshold — the single source of "what is slow",
// internal to the slow-ops pipeline (the sole consumer, since flight-recorder
// was folded into the trace engine). The
// `sub`/`push` origin entries and the `flush` notify-flush cycle all wrap
// loaders, so they share the loader threshold (no separate config knob). The
// `job` case is the hold class's ceiling on work time, with the per-job
// override (`defineJob({ slowThresholdMs })`) still winning and the global
// `jobMs` config as the fallback for a job this backend does not know.
export function resolveSlowThreshold(span: SlowSpan, t: Thresholds): number {
  switch (span.kind) {
    case "http":
      // A route may hold a tighter bar than the global `httpMs` via
      // `defineEndpoint({ slowThresholdMs })` (regression backstop). The span
      // label is the route. Honored as long as it sits at/above the perf floor
      // below (min config threshold; `dbMs` default 500 ms, well under 1 s uses).
      return getRouteSlowThresholdMs(span.label) ?? t.httpMs;
    case "db":
      return t.dbMs;
    case "job": {
      // A per-job `slowThresholdMs` is a regression backstop tighter than the
      // class, so it wins outright. Otherwise the bar IS the declared class's
      // ceiling — that is what makes a lie about `hold` loud: a job declaring
      // `instant` and spending 10 s WORKING files a report naming itself, every
      // tick, until it is reclassified or fixed. A job name with no registration
      // in this backend (a queue row from a plugin this composition does not
      // load) has no class to read, so it falls back to the global default.
      const override = getJobSlowThresholdMs(span.label);
      if (override !== undefined) return override;
      const hold = getJobHold(span.label);
      return hold === undefined ? t.jobMs : ceilingMsFor(hold);
    }
    case "loader":
    case "sub":
    case "push":
    case "flush":
    // `cascade` is a dependsOn edge's ids-translation DB reads run inside the
    // flush cascade — loader-class background work, so it shares the loader bar.
    case "cascade":
    // `bg` is a runTracked root — detached background work (warmups, pollers,
    // watcher callbacks). Background-class like the above, so it shares the
    // loader bar (no separate config knob).
    case "bg":
    // `route` (change-feed routing of one change) and `membership` (a window
    // resource's ids query) are live-state plumbing around the loader — they
    // share the loader bar rather than adding a knob, which would also lower
    // the perf floor for every span.
    case "route":
    case "membership":
      return t.loaderMs;
  }
}

/**
 * The perf floor handed to `onSlowSpan`: the profiler only calls back for spans
 * at least this long, so a fast span never reaches the handler at all.
 *
 * It must sit at or below EVERY threshold `resolveSlowThreshold` can return, or
 * that threshold is unreachable. The config knobs are one source of thresholds;
 * the hold-class ceilings are now a second, so they are folded in here rather
 * than assumed to be larger. (The profiler gates on wall-clock `durationMs`
 * while a job is judged on work time — sound in this direction only, since work
 * ≤ wall: a job whose work passes its ceiling necessarily ran at least that
 * long.)
 *
 * The client knobs (`pageLoadMs`, `elementMs`, `updateMs`, `confirmMs`) stay
 * OUT: no server span is ever judged by them, so including one would only
 * lower the profiler floor for every server span.
 */
export function perfFloorMs(t: Thresholds): number {
  return Math.min(
    t.loaderMs,
    t.httpMs,
    t.dbMs,
    t.jobMs,
    ...HOLD_CLASSES.map(ceilingMsFor),
  );
}
