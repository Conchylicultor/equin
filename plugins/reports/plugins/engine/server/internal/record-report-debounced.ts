import { recordReport } from "./record-report";
import { createReportDebounce } from "./debounce";
import type { ReportInput } from "@plugins/reports/core";

// One gate for the whole process: keys are caller-supplied and namespaced by
// the caller (kind + subject), so sharing the map costs nothing and keeps the
// sweep in one place.
const gate = createReportDebounce();

/**
 * File a report, dropped when `key` was already filed inside `windowMs`.
 *
 * For callers whose condition is persistent rather than transient and whose
 * call site runs on a loop — the conversations poller ticks once a second per
 * live pane, a transcript read runs several times a second while an agent
 * talks. `recordReport` is a DB upsert; without a gate in front of it the
 * report engine ends up on those hot paths, and the row it writes counts loop
 * iterations instead of occurrences. See `debounce.ts` for the window.
 *
 * **Never throws into the caller, and never hands it a promise to wait on.**
 * Every caller is on an error or observability path, where a report that
 * cannot be written must not be able to break the work being observed. The
 * `void` is the repo's sanctioned fire-and-forget — an unhandled rejection is
 * captured by this plugin's own process hook and filed as a crash, so the
 * failure stays loud in Debug → Reports instead of surfacing as broken
 * behaviour at the call site.
 */
export function recordReportDebounced(
  key: string,
  windowMs: number,
  input: ReportInput,
): void {
  if (!gate.admit(key, windowMs)) return;
  void recordReport(input);
}
