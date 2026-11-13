import type { UndoConflictReport } from "@plugins/page/plugins/editor/web";
import { report } from "@plugins/reports/web";

// The handler of the editor's `undoConflictReportSink`, drained through a
// `ReportSinks.Collector` keyed by `page.editor` (so it ships only where the
// editor does). The page editor must not import `reports`, so it emits a
// neutral `UndoConflictReport` whenever a data-based text undo entry meets a
// block that is not the one it recorded; this owns the mapping to a
// `kind: "page-undo-conflict"` report — the same inversion caret-flight and
// collab-hydration use.
//
// NO THRESHOLD, deliberately: both arms are a second writer landing on a block
// between record and replay, which is never a benign steady state — one arm
// clobbered that writer, the other dropped an undo step to avoid doing so.
// Every body that arrives here is one occurrence of the residual the design
// accepts only while it is measurably rare.
export function collectUndoConflict(d: UndoConflictReport): void {
  void report({
    kind: "page-undo-conflict",
    source: "client-page-undo-conflict",
    message: undoConflictMessage(d),
    url: window.location.href,
    userAgent: navigator.userAgent,
    data: d as unknown as Record<string, unknown>,
  });
}

export function undoConflictMessage(d: UndoConflictReport): string {
  switch (d.reason) {
    case "stale-entry":
      return `${d.direction === "redo" ? "Redo" : "Undo"} replay found block text of ${d.actualLength} chars where the entry expected ${d.expectedLength} (${d.direction ?? "unknown direction"})`;
    case "run-aborted":
      return `A typing run in block ${d.blockId} was dropped because a remote change landed mid-run (${d.expectedLength} → ${d.actualLength} chars)`;
  }
}
