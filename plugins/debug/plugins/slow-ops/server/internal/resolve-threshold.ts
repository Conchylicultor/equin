import type {
  SlowSpan,
  SlowWait,
} from "@plugins/infra/plugins/runtime-profiler/core";
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
 * The quantity a span is judged on: its **own time** (`durationMs −
 * excludedMs`), for every kind — the part of the run that is a property of the
 * span itself. `excludedMs` (runtime-profiler, "Own time") is the union of:
 *
 * - every `queue` / `join` wait the span made itself, filed or not. Time
 *   queued on a named gate is the gate's: a `sub` waits on the 6-slot `read-admit` gate for ~85% of
 *   its wall time on average (2026-10-29 audit: `config-v2.values` 7.7e9 of
 *   9e9 ms was `read-admit`). The queue is reported against the gate — once
 *   per wait past the bar, as a `wait <layer>` op (`onSlowWait`,
 *   install-slow-span.ts), else summed as residue up the chain and onto the
 *   gate's busy stretches — and never comes back as the span's own: on main
 *   (2026-11-19) a `loader prototypes.list` filed at 2.78 s "own" held 1.62 s
 *   of unfiled `read-admit` queue handed back to it, during a restart's
 *   replay. A `join` wait is the joined run's.
 * - every `io` wait it made that was filed as its own op (`wait git:status`).
 *   One under the bar is work the span awaited and stays in its own time,
 *   named by its layer — so `bg watch-edited-files:pass`, 2.4–3 s of git
 *   children each under the bar, is judged on their sum, once.
 * - its child ops' executions, filed or not: each is judged on its own span,
 *   so a `sub` is never filed for the loader it ran (main, 2026-11-19: `sub
 *   prototypes.list` 3.2 s "of its own" was its 3.5 s loader).
 * - enclosed spans already filed as their own slow op (`claims` — the install
 *   hook calls `claim()` on every span it files), so a slow query is filed
 *   once, not again by the loader around it.
 *
 * What is left is the span's own code, its leaves (queries — its work), the
 * `io` work it awaited that was not slow on its own, awaits nothing meters, plus the time its continuations sat behind other ops
 * on a busy event loop: the runtime gives no per-context turn signal, so that
 * last part cannot be told from the span's own synchronous work and stays in
 * (runtime-profiler CLAUDE.md, "Event-loop stalls").
 *
 * `excludedMs` is a wall-clock-overlapping OVERLAY, not an additive component:
 * the recorder accumulates it as an interval union over the span's own
 * timeline, so `excludedMs ≤ durationMs` holds at every level and this
 * subtraction can never go negative.
 *
 * Machine sleep needs no subtraction here: the profiler's clock
 * (`performance.now()` in Bun on macOS) stops while the machine sleeps —
 * measured on main, 2026-10-30: a process up since 16:48 stamped 1,956 s at
 * 22:12, the 18:02 sleep never reaching it.
 *
 * The recorded row still carries wall-clock `durationMs` plus its per-layer
 * `waits` (the child ops and the claims among them), so the wait-vs-work
 * split stays readable off the row.
 */
export function slowSpanMs(span: SlowSpan): number {
  return Math.max(0, span.durationMs - span.excludedMs);
}

// Map a span to its configured threshold — the single source of "what is slow",
// internal to the slow-ops pipeline (the sole consumer, since flight-recorder
// was folded into the trace engine). The
// `sub`/`push` origin entries and the `flush` notify-flush cycle all wrap
// loaders, so they share the loader threshold (no separate config knob). The
// `job` case is the hold class's ceiling on work time, with the per-job
// override (`defineJob({ slowThresholdMs })`) still winning and the global
// `jobMs` config as the fallback for a job this backend does not know.
//
// A bar the call site DECLARED on the span (`SlowSpan.budgetMs` — a warm-up's
// `budgetMs`, `runTracked(label, fn, { budgetMs })`) wins over every kind
// default: the work said how long it is expected to take, and judging it on a
// global knob instead files reports against work that is on budget. Like a
// per-job `slowThresholdMs`, a declared budget below `perfFloorMs` is not
// honored (the profiler never calls back for the span).
export function resolveSlowThreshold(
  span: Pick<SlowSpan, "kind" | "label" | "budgetMs" | "latency">,
  t: Thresholds,
): number {
  if (span.budgetMs !== undefined) return span.budgetMs;
  // A latency leaf (a `deliver:<key>`: first notify → send) is the server half
  // of the client's `update`, which no longer counts that window
  // (`EXCLUDED_PHASES`, owner `server`) — so it is held to the update's bar,
  // or a 1–2 s delivery would be judged by nobody.
  if (span.latency) return t.updateMs;
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
 * Whether a wait is filed (`wait <layer>`) at all.
 *
 * - An `io` wait — one piece of work another party did: a git child, a
 *   worker's answer, a file call — always is: it is slow or not on its own,
 *   whoever waited. Unfiled, it is not dropped: it stays the waiter's own
 *   time (runtime-profiler, "Own time"), so the op that awaited it is judged
 *   on it.
 * - A `queue` wait is not when the one op that waited is a `bg` span —
 *   detached background work (a warm-up, a watcher pass, a build's slot
 *   holder) that no reader is behind, so its queue is no one's latency.
 *   Declined, it climbs on as residue like any unfiled queue wait, and is
 *   never the `bg` op's own time either. Every other waiter — a loader, a
 *   `sub`, an `http` request, a flush or job — is a reader of the gate, and
 *   its wait is judged by `resolveWaitThreshold`. A gate's busy stretch
 *   (`busy`) is the gate's queue across independent ops: a reader's when any
 *   op of another kind queued in it (`waiterKinds`) — else it is only that
 *   background work's waits.
 *
 * Before (main, 2026-11-15): a restart's 2.3 s faceted-index build, awaited by
 * the boot warm-up and the session's `plugin-tree:first-build` slot holder,
 * filed `wait worker:plugin-tree.faceted-index` once per waiter. The worker
 * now runs one cold build (its waiters join it), so it is one `io` wait, filed
 * once. Declining every `bg` waiter's wait instead (2026-11-15 → this change)
 * relied on the wait coming back as the `bg` op's own time; once unfiled
 * waits stopped being own time (2026-11-19), a slow worker or git child under
 * background work was filed by no one (main, 7 days: 72
 * `plugin-tree:first-build` traces, 68 of them a 2–3 s worker build).
 */
export function isReaderWait(wait: SlowWait): boolean {
  if (wait.kind === "io") return true;
  return wait.busy
    ? wait.waiterKinds.some((kind) => kind !== "bg")
    : wait.caller.kind !== "bg";
}

/**
 * The bar a wait is judged against, by what it measures:
 *
 * - An `io` wait (a child process, a worker, the disk): the bar of the op
 *   that awaited it, at least the loader bar — the waiter's declared budget
 *   or hold class says how long its work, this piece included, may take.
 *
 * - What ONE op waited (a single wait, or one entry's waits summed): a
 *   latency. A gate's queue holds work back, so it shares the loader bar (no
 *   separate knob, which would also lower the perf floor for every span). A
 *   latency leaf's queue (`latency`: a delivery waiting for the flush lane) is
 *   staleness a tab shows, so it is held to the update bar — the bar the
 *   delivery itself would have been judged on had the queue been counted
 *   against it. So a request that waits 2 s in total across many small waits
 *   is still filed, per request.
 * - A gate's BUSY STRETCH (`busy` set): how long its queue held without a
 *   break, across independent ops — the time a burst took to drain, so the
 *   longest a reader arriving at its start could have waited. A latency too,
 *   held to the same loader bar as one op's wait: a burst that drains within
 *   what one read may take cost no reader more than that. Never a sum across
 *   waiters — the summed 60 s window it replaces (mean depth ≥ 0.25 waiters)
 *   fired on every restart's 0.5 s replay burst, whose 250 waits summed to
 *   15–20 s while no reader waited 1 s (main, 2026-11-13).
 */
export function resolveWaitThreshold(wait: SlowWait, t: Thresholds): number {
  if (wait.busy) return t.loaderMs;
  if (wait.kind === "io") {
    // Work the op awaited is part of the work it expects to do: held to the
    // waiter's own bar (a job's hold class, a warm-up's declared budget, a
    // route's), never below the wait bar. A backup job's minute-long archive
    // child is not slow against the 2 s default; a page's 2.5 s git child is.
    const waiter = resolveSlowThreshold(
      {
        kind: wait.caller.kind,
        label: wait.caller.label,
        ...(wait.callerBudgetMs !== undefined && {
          budgetMs: wait.callerBudgetMs,
        }),
      },
      t,
    );
    return Math.max(t.loaderMs, waiter);
  }
  return wait.latency ? t.updateMs : t.loaderMs;
}

/**
 * The perf floor handed to `onSlowSpan`: the profiler only calls back for spans
 * at least this long, so a fast span never reaches the handler at all.
 *
 * It must sit at or below EVERY threshold `resolveSlowThreshold` can return, or
 * that threshold is unreachable. The config knobs are one source of thresholds;
 * the hold-class ceilings are now a second, so they are folded in here rather
 * than assumed to be larger. (The profiler gates on wall-clock `durationMs`
 * while a span is judged on its own time — sound in this direction only, since
 * own ≤ wall: a span whose own time passes its bar necessarily ran at least
 * that long.) `onSlowWait` takes the lowest of `resolveWaitThreshold`'s bars.
 *
 * The other client knobs (`pageLoadMs`, `elementMs`, `confirmMs`,
 * `browserHostBootMs`) stay OUT:
 * no server span is ever judged by them, so including one would only lower the
 * profiler floor for every server span. `updateMs` is IN: a latency leaf (a
 * delivery) is judged by it.
 */
export function perfFloorMs(t: Thresholds): number {
  return Math.min(
    t.loaderMs,
    // A latency leaf is judged on the update bar (see resolveSlowThreshold).
    t.updateMs,
    t.httpMs,
    t.dbMs,
    t.jobMs,
    ...HOLD_CLASSES.map(ceilingMsFor),
  );
}
