import { captureTrace } from "@plugins/debug/plugins/trace/plugins/engine/server";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import { sentinelLog } from "./log-sink";
import type { WorkerToMainFrame } from "./worker/protocol";

// Main's best-effort re-emitter for the worker's onset transitions (Stage 5:
// the detector AND the duress latch live on the sentinel worker — see
// worker/entry.ts). On trip, mirror the event into the durable trace store;
// on clear, log. Deliberately nothing else: main is NOT on the latch's
// critical path, so a wedged main can only delay these mirrors, never the
// lease. ALL setDuress/refreshDuress/clearDuress calls are gone from main —
// the worker is the single latch owner.

/** Extra lookback added to the run-up so the trace window shows the prologue. */
const ONSET_WINDOW_PAD_MS = 60_000;

export function handleTripFrame(
  frame: Extract<WorkerToMainFrame, { type: "trip" }>,
): void {
  // critical: bypasses the global per-minute cap (the onset trace must land
  // even mid-storm); the per-kind cooldown still dedupes. The widened
  // durationMs widens the persisted window to cover the elevation run-up.
  const trace = captureTrace({
    kind: "cluster-onset",
    label: "cluster",
    critical: true,
    durationMs: frame.runUpMs + ONSET_WINDOW_PAD_MS,
    thresholdMs: 0,
    detail: { signals: frame.signals, elevated: frame.elevated },
  });
  sentinelLog.publish(
    `onset TRIP (${frame.elevated.join(", ")}) trace=${trace?.id ?? "rate-limited"}`,
  );
}

export function handleClearFrame(
  frame: Extract<WorkerToMainFrame, { type: "clear" }>,
): void {
  sentinelLog.publish(
    frame.forced ? "onset CLEAR (max-episode-hold forced)" : "onset CLEAR",
  );

  // File the duress-episode report — the report/bell half of the signal, filed
  // once per episode on clear (the detector emits exactly one trip and one clear
  // per episode). The enrichment fields are present whenever the clear ended a
  // real episode; a bare clear with no episode (defensive impossibility) carries
  // none, so the report is skipped rather than filed with a hole.
  const { reason, elevated, episodeSetAt, wall } = frame;
  if (reason === undefined || elevated === undefined || episodeSetAt === undefined || wall === undefined) {
    return;
  }
  // Plain `void`: recordReport wraps its own DB/bell writes in
  // runInBackgroundLane(runWithoutProfiling(…)) — the caller must not double-wrap
  // (stall-monitor precedent). Satisfies no-floating-promises; no catch needed.
  void recordReport({
    kind: "duress-episode",
    source: "server-duress-monitor",
    data: {
      reason,
      elevated,
      episodeSetAt,
      endedAt: wall,
      durationMs: wall - episodeSetAt,
      forced: frame.forced,
    },
    message: `cluster duress episode cleared (${elevated.join(", ") || "adopted"}) — ${Math.round((wall - episodeSetAt) / 1000)}s${frame.forced ? ", forced" : ""}`,
  });
}
