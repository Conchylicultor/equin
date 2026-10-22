import { captureFlightWindow } from "@plugins/infra/plugins/runtime-profiler/core";
import { defineTimer } from "@plugins/infra/plugins/background/plugins/timer/server";
import { captureTrace } from "@plugins/debug/plugins/trace/plugins/engine/server";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import type { ReportSource } from "@plugins/reports/core";
import { SPAN_STUCK_KIND, type StuckSpanPayload } from "../../core";
import { stuckSpanMessage } from "../../shared/message";
import { createStuckSpanWatcher, type StuckSpanFinding } from "./detect";

// The stuck-span watchdog: a raw `setInterval` on the backend's own event loop,
// started from `onReady` and stopped in `onShutdown`.
//
// WHY IT IS NOT A `defineJob`. A monitor must not run through the machinery it
// watches. This one watches, among other things, the jobs worker's own nested
// work and the live-state flush — and a scheduled job is dispatched by the same
// worker and would be queued behind the very wedge it exists to report. That is
// what happened to the queue monitor on 2026-08-17 (eleven copies of it sat in
// the frozen backlog it existed to report); the doctrine, and the structure
// this file copies — a `defineTimer`, start/stop pair, spanned tick —
// are written down in `plugins/debug/plugins/queue-health/server/internal/watchdog.ts`,
// itself modeled on the jobs plugin's stuck-lock sweeper.
//
// WHAT IT CANNOT SEE: it rides the event loop it runs on, so a frozen LOOP
// silences it. That class belongs one level lower (the health sampler's stall
// detector, `debug/stall-monitor`). A monitor runs one level below what it
// watches, and no lower: an operation stuck on an await leaves the loop free,
// which is exactly the case this catches.
//
// WHY PER-BACKEND. The runtime profiler's open-entry registry is per-process
// memory, and reports are filed under this backend's worktree, so every backend
// watches its own process and nothing else — no backend can see, or
// double-report, another's spans. Supervised exec children run no `onReady`, so
// they run no watchdog either.

// 15 s, so a span past its threshold is filed within 15 s of crossing it. A
// module constant, not config, for the reason the queue-health watchdog gives:
// it is a property of the detector, not a knob. The thresholds live in
// `policy.ts`.
const TICK_MS = 15_000;

// The report source. The reports engine's source union has no entry for this
// monitor yet, so it files under the runtime profiler's span-signal source —
// the same stream the slow-op reports come from. One constant so switching to a
// dedicated source is a one-line change.
const SOURCE: ReportSource = "server-slow-op";

const watcher = createStuckSpanWatcher({
  // The whole open set: `maxOpen: Infinity` because both "is it stuck" and the
  // prune of the remembered ids are claims about every open span, and a capped
  // read could forget a remembered id and file it twice. The set is the
  // backend's concurrently in-flight entries — tens normally — and nothing from
  // the completed ring is read (`maxCompleted: 0`).
  readOpen: () =>
    captureFlightWindow({
      windowStartMs: Number.POSITIVE_INFINITY,
      maxOpen: Number.POSITIVE_INFINITY,
      maxCompleted: 0,
    }).open,
  onStuck: fileStuckSpans,
});

// A throw in a tick is recorded by the timer and rethrown as an unhandled
// rejection, which the reports plugin files — loud, never eaten.
export const stuckSpanTimer = defineTimer({
  name: "stuck-spans.watchdog",
  description:
    "Looks every 15 seconds for a request or background step that has been running far too long, and files a report with a trace while it is still stuck.",
  everyMs: TICK_MS,
  run: () => {
    watcher.tick();
  },
});

export function startStuckSpanWatchdog(): void {
  stuckSpanTimer.start();
}

export function stopStuckSpanWatchdog(): void {
  if (!stuckSpanTimer.running) return;
  stuckSpanTimer.stop();
  // A restarted watchdog has not reported anything yet.
  watcher.reset();
}

// Evidence first, then one report per newly stuck span.
//
// ONE trace per tick, shared by every report of that tick: a trace is a capture
// of everything in flight at one instant, and all the spans found stuck on a
// tick are stuck at the same instant — N captures would be N copies of one
// picture. It is `critical` so neither the global per-minute cap nor duress
// shedding can drop the evidence for a hang; that is safe because it fires only
// on a tick that found a span never reported before.
function fileStuckSpans(findings: readonly StuckSpanFinding[]): void {
  const lead = findings[0]!;
  const trace = captureTrace({
    kind: SPAN_STUCK_KIND,
    label: `${lead.kind} ${lead.label}`,
    durationMs: lead.ageMs,
    thresholdMs: lead.thresholdMs,
    critical: true,
    detail: {
      spanId: lead.id,
      stuck: findings.map((f) => ({
        id: f.id,
        kind: f.kind,
        label: f.label,
        ageMs: f.ageMs,
        ancestors: f.ancestors.map((a) => a.id),
      })),
    },
  });

  for (const f of findings) {
    const data: StuckSpanPayload = {
      spanId: f.id,
      kind: f.kind,
      label: f.label,
      ageMs: Math.round(f.ageMs),
      thresholdMs: f.thresholdMs,
      ancestors: f.ancestors.map((a) => ({
        id: a.id,
        kind: a.kind,
        label: a.label,
        ageMs: Math.round(a.ageMs),
      })),
      traceId: trace ? trace.id : null,
    };
    // Fire-and-forget: recordReport runs its own writes in the background lane
    // with profiling suppressed. The span is already remembered, so a write that
    // fails (or hangs, if the database is what is stuck) is not retried — the
    // failure surfaces as an unhandled rejection report instead.
    void recordReport({
      kind: SPAN_STUCK_KIND,
      source: SOURCE,
      data,
      message: stuckSpanMessage(data),
    });
  }
}
