import {
  captureFlightWindow,
  readGateGauges,
  resolveGateGauges,
  type GateReading,
} from "@plugins/infra/plugins/runtime-profiler/core";
import { defineTimer } from "@plugins/infra/plugins/background/plugins/timer/server";
import { captureTrace } from "@plugins/debug/plugins/trace/plugins/engine/server";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import type { ReportSource } from "@plugins/reports/core";
import {
  GATE_HOLDERS_MAX,
  GATE_WAITERS_MAX,
  SPAN_STUCK_KIND,
  type StuckSpanPayload,
} from "../../core";
import { stuckSpanMessage } from "../../shared/message";
import {
  createStuckSpanWatcher,
  groupByGate,
  groupByOperation,
  type OwnWorkFinding,
  type QueuedFinding,
  type StuckSpanFinding,
} from "./detect";

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
});

// A throw in a tick is recorded by the timer and rethrown as an unhandled
// rejection, which the reports plugin files — loud, never eaten.
export const stuckSpanTimer = defineTimer({
  name: "stuck-spans.watchdog",
  description:
    "Looks every 15 seconds for a request or background step that has been running far too long, and files a report with a trace while it is still stuck.",
  everyMs: TICK_MS,
  run: async () => {
    const fresh = watcher.tick();
    if (fresh.length > 0) await fileStuckSpans(fresh);
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

// Evidence first, then one report per newly stuck OPERATION, and one per GATE
// whose waiters were found queued past their threshold.
//
// ONE trace per tick, shared by every report of that tick: a trace is a capture
// of everything in flight at one instant, and all the spans found stuck on a
// tick are stuck at the same instant — N captures would be N copies of one
// picture. It is `critical` so neither the global per-minute cap nor duress
// shedding can drop the evidence for a hang; that is safe because it fires only
// on a tick that found a span never reported before.
async function fileStuckSpans(
  findings: readonly StuckSpanFinding[],
): Promise<void> {
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
        cause: f.cause,
        ...(f.cause === "queued" && { layer: f.layer, waitedMs: f.waitedMs }),
        ancestors: f.ancestors.map((a) => a.id),
      })),
    },
  });
  const traceId = trace ? trace.id : null;

  const ownWork: OwnWorkFinding[] = [];
  const queued: QueuedFinding[] = [];
  for (const f of findings) {
    if (f.cause === "queued") queued.push(f);
    else ownWork.push(f);
  }

  for (const { lead: f, runs } of groupByOperation(ownWork))
    file({ ...basePayload(f, traceId), ...(runs > 1 && { runs }) });

  if (queued.length === 0) return;
  // Read once for the tick, as the waiters stand: who holds each gate now.
  // In memory, synchronously; the occupancy that lives in other processes (a
  // host pool's) is probed off the thread before the gate reports are filed.
  await fileGateFindings(queued, traceId, readGateGauges());
}

async function fileGateFindings(
  queued: readonly QueuedFinding[],
  traceId: string | null,
  readings: Record<string, GateReading>,
): Promise<void> {
  const groups = groupByGate(queued);
  // Only the gates waited on are probed: a probe is file I/O, and a tick that
  // found waiters on one gate has no business opening every pool's slots.
  const waitedOn = new Set(groups.map((g) => g.lead.layer));
  const gauges = await resolveGateGauges(
    Object.fromEntries(
      Object.entries(readings).filter(([layer]) => waitedOn.has(layer)),
    ),
  );
  for (const { lead: f, runs, waiters } of groups) {
    const gauge = gauges[f.layer];
    file({
      ...basePayload(f, traceId),
      ...(runs > 1 && { runs }),
      gate: {
        layer: f.layer,
        waitKind: f.waitKind,
        waitedMs: Math.round(f.waitedMs),
        occupancy: gauge
          ? { active: gauge.active, queued: gauge.queued, max: gauge.max }
          : null,
        holders: (gauge?.holders ?? [])
          .slice(0, GATE_HOLDERS_MAX)
          .map((h) => ({ label: h.label, heldMs: Math.round(h.heldMs) })),
        waiters: waiters.slice(0, GATE_WAITERS_MAX),
      },
    });
  }
}

function basePayload(
  f: StuckSpanFinding,
  traceId: string | null,
): StuckSpanPayload {
  return {
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
    traceId,
  };
}

// Fire-and-forget: recordReport runs its own writes in the background lane
// with profiling suppressed. The span is already remembered, so a write that
// fails (or hangs, if the database is what is stuck) is not retried — the
// failure surfaces as an unhandled rejection report instead.
function file(data: StuckSpanPayload): void {
  void recordReport({
    kind: SPAN_STUCK_KIND,
    source: SOURCE,
    data,
    message: stuckSpanMessage(data),
  });
}
