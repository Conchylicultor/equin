import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { undoConflictReportSink } from "@plugins/page/plugins/editor/web";
import { drain } from "@plugins/primitives/plugins/report-sink/web";
import { ReportSinks } from "@plugins/reports/plugins/collectors/web";
import { Reports } from "@plugins/reports/web";
import { collectUndoConflict } from "./internal/page-undo-conflict-collector";
import { PageUndoConflictKindView } from "./components/page-undo-conflict-kind-view";

export default {
  description:
    "Page-undo-conflict collector: drains the page editor's undoConflictReportSink into a report whenever a data-based text undo entry meets a second writer — a replay that found text other than what the entry recorded and applied the entry anyway (stale-entry), or a typing run dropped because a remote change landed inside it (run-aborted) — plus the Debug → Reports summary view. A companion of the page editor: it ships only where the editor (and the reports collectors) do.",
  contributions: [
    ReportSinks.Collector({
      from: "page.editor",
      collect: drain(undoConflictReportSink, collectUndoConflict),
      companion: true,
    }),
    Reports.KindView({
      match: "page-undo-conflict",
      component: PageUndoConflictKindView,
    }),
  ],
} satisfies PluginDefinition;
