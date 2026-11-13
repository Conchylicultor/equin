import type { CaretFlightAbortReport } from "@plugins/page/plugins/editor/web";
import { report } from "@plugins/reports/web";

// The handler of the editor's `caretFlightReportSink`, drained through a
// `ReportSinks.Collector` keyed by `page.editor` (so it ships only where the
// editor does). The page editor must not import `reports`, so its caret
// authority emits a neutral `CaretFlightAbortReport` whenever a claimed caret
// landing is given up on; this owns the mapping to a `kind: "caret-flight"`
// report — the inversion crash uses for error-boundary's boundaryReportSink.
//
// NO THRESHOLD HERE, deliberately, unlike the stale-drop collector: the
// authority already suppresses the benign case at the source (an abort with an
// EMPTY buffer is an ordinary cancellation — the user clicked away before the
// landing — and never reaches the sink). Every body that arrives here therefore
// represents keystrokes that had to be rescued or were lost, which is exactly one
// report each.
export function collectCaretFlight(d: CaretFlightAbortReport): void {
  void report({
    kind: "caret-flight",
    source: "client-caret-flight",
    message: `Caret flight aborted (${d.reason}): ${d.buffered} buffered keystrokes ${d.replayedInto === null ? "LOST" : "replayed into the origin"}`,
    url: window.location.href,
    userAgent: navigator.userAgent,
    data: d as unknown as Record<string, unknown>,
  });
}
