import type { TimelineSeverity } from "../../core";

// ---------------------------------------------------------------------------
// Per-source severity mapping — pure functions so the rules are unit-tested
// and live in exactly one place.
// ---------------------------------------------------------------------------

// A critical trigger (event-loop stall, cluster onset) is the most severe
// signal the trace engine knows; everything else that tripped a trace is
// already a threshold breach, hence warning.
export function traceSeverity(critical: boolean): TimelineSeverity {
  return critical ? "error" : "warning";
}

// A slow-op sample is a threshold breach by construction (warning). At 5× its
// own threshold it stops being "slow" and becomes "broken" (error).
export const SLOW_OP_ERROR_FACTOR = 5;
export function slowOpSeverity(
  durationMs: number,
  thresholdMs: number,
): TimelineSeverity {
  if (thresholdMs > 0 && durationMs >= SLOW_OP_ERROR_FACTOR * thresholdMs)
    return "error";
  return "warning";
}

// Report kinds that mean "something is broken" (crashes and correctness
// failures) rather than "something is slow / unhealthy" (perf and queue
// monitors). Closed set by design: an unknown kind defaults to warning, so a
// new monitor kind can never silently render as an error.
export const CRASH_LIKE_REPORT_KINDS: ReadonlySet<string> = new Set([
  "crash",
  "render-loop",
  // A frozen browser tab: user-visible breakage, not mere slowness.
  "main-thread-stall",
  "optimistic-divergence",
  "optimistic-rejection",
]);
export function reportSeverity(kind: string, noise: boolean): TimelineSeverity {
  if (noise) return "info";
  return CRASH_LIKE_REPORT_KINDS.has(kind) ? "error" : "warning";
}

// A build is a load event, not a problem: in-flight (null) and clean exits are
// info; any non-zero exit (including the reconciler's stamped -1) is an error.
export function buildSeverity(exitCode: number | null): TimelineSeverity {
  if (exitCode !== null && exitCode !== 0) return "error";
  return "info";
}
