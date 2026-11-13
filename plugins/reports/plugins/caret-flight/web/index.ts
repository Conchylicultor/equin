import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { caretFlightReportSink } from "@plugins/page/plugins/editor/web";
import { drain } from "@plugins/primitives/plugins/report-sink/web";
import { ReportSinks } from "@plugins/reports/plugins/collectors/web";
import { Reports } from "@plugins/reports/web";
import { collectCaretFlight } from "./internal/caret-flight-collector";
import { CaretFlightKindView } from "./components/caret-flight-kind-view";

export default {
  description:
    "Caret-flight collector: drains the page editor's caretFlightReportSink into a report whenever a claimed caret landing is abandoned and the keystrokes it was holding had to be replayed into the origin block (or were lost), plus the Debug → Reports summary view. A companion of the page editor: it ships only where the editor (and the reports collectors) do.",
  contributions: [
    ReportSinks.Collector({
      from: "page.editor",
      collect: drain(caretFlightReportSink, collectCaretFlight),
      companion: true,
    }),
    Reports.KindView({ match: "caret-flight", component: CaretFlightKindView }),
  ],
} satisfies PluginDefinition;
