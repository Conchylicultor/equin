import type { CollabHydrationReport } from "@plugins/page/plugins/editor/web";
import { report } from "@plugins/reports/web";

// The handler of the editor's `collabHydrationReportSink`, drained through a
// `ReportSinks.Collector` keyed by `page.editor` (so it ships only where the
// editor does). The page editor must not import `reports`, so it emits a
// neutral `CollabHydrationReport` whenever a block's rendered text stops
// agreeing with its content doc; this owns the mapping to a
// `kind: "collab-hydration"` report — the same inversion caret-flight and
// crash use.
//
// NO THRESHOLD, deliberately: the editor only emits after it has established
// that two independent witnesses of one block's content disagree, which is never
// a benign steady state. Every body that arrives here is one defect occurrence.
export function collectCollabHydration(d: CollabHydrationReport): void {
  void report({
    kind: "collab-hydration",
    source: "client-collab-hydration",
    message:
      d.reason === "blind-binding"
        ? `Block text stopped rendering: the editor showed ${d.shownLength} chars while its content doc held ${d.docLength} (re-attached)`
        : `Block content doc was starved: the doc held ${d.docLength} chars while the row held ${d.rowLength} (re-read)`,
    url: window.location.href,
    userAgent: navigator.userAgent,
    data: d as unknown as Record<string, unknown>,
  });
}
