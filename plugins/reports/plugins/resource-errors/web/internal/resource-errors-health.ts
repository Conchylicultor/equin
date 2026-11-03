import type { HealthStatus } from "@plugins/shell/plugins/health-report/core";
import type { FailingResource } from "@plugins/network/plugins/live/plugins/live-state/web";

/**
 * The health row's verdict over the reads failing on this page. Never
 * `unknown`: the failing set is page-local bookkeeping, known from the first
 * render (empty until a read fails). A failure from an out-of-date tab counts
 * too — the read is failing either way — but its summary points at the reload.
 */
export function resourceErrorsVerdict(
  failing: readonly FailingResource[],
): HealthStatus {
  if (failing.length === 0) {
    return { state: "ok", summary: "Every live read is loading normally" };
  }
  const first = failing[0]!;
  const outdated = failing.every((f) => f.error.kind === "client-outdated");
  const noun = failing.length === 1 ? "resource" : "resources";
  const lead = `${failing.length} ${noun} failing`;
  if (outdated) {
    return {
      state: "attention",
      summary: `${lead} — this tab is out of date; reload to fix`,
    };
  }
  const more = failing.length > 1 ? ` (and ${failing.length - 1} more)` : "";
  return {
    state: "attention",
    summary: `${lead}: ${first.key} — ${first.error.message}${more}`,
  };
}
