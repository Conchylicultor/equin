import {
  Core,
  type PluginDefinition,
} from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { PageUndoConflictCollector } from "./components/page-undo-conflict-collector";
import { PageUndoConflictKindView } from "./components/page-undo-conflict-kind-view";

export default {
  description:
    "Page-undo-conflict collector: drains the page editor's undoConflictReportSink into a report whenever a data-based text undo entry meets a second writer — a replay that found text other than what the entry recorded and applied the entry anyway (stale-entry), or a typing run dropped because a remote change landed inside it (run-aborted) — plus the Debug → Reports summary view.",
  contributions: [
    Core.Root({ component: PageUndoConflictCollector, scope: "page" }),
    Reports.KindView({
      match: "page-undo-conflict",
      component: PageUndoConflictKindView,
    }),
  ],
} satisfies PluginDefinition;
