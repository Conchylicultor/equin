import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { collabHydrationReportSink } from "@plugins/page/plugins/editor/web";
import { drain } from "@plugins/primitives/plugins/report-sink/web";
import { ReportSinks } from "@plugins/reports/plugins/collectors/web";
import { Reports } from "@plugins/reports/web";
import { collectCollabHydration } from "./internal/collab-hydration-collector";
import { CollabHydrationKindView } from "./components/collab-hydration-kind-view";

export default {
  description:
    "Collab-hydration collector: drains the page editor's collabHydrationReportSink into a report whenever a block's rendered text stops agreeing with its content doc (a binding that never hydrated) or with the server (a doc that never received its push), plus the Debug → Reports summary view. A companion of the page editor: it ships only where the editor (and the reports collectors) do.",
  contributions: [
    ReportSinks.Collector({
      from: "page.editor",
      collect: drain(collabHydrationReportSink, collectCollabHydration),
      companion: true,
    }),
    Reports.KindView({ match: "collab-hydration", component: CollabHydrationKindView }),
  ],
} satisfies PluginDefinition;
