import { Core, type PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { CaretFlightCollector } from "./components/caret-flight-collector";
import { CaretFlightKindView } from "./components/caret-flight-kind-view";

export default {
  description:
    "Caret-flight collector: drains the page editor's caretFlightReportSink into a report whenever a claimed caret landing is abandoned and the keystrokes it was holding had to be replayed into the origin block (or were lost), plus the Debug → Reports summary view.",
  contributions: [
    Core.Root({ component: CaretFlightCollector, scope: "page" }),
    Reports.KindView({ match: "caret-flight", component: CaretFlightKindView }),
  ],
} satisfies PluginDefinition;
