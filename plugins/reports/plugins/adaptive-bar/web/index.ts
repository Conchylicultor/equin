import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { adaptiveBarReportSink } from "@plugins/primitives/plugins/adaptive-bar/web";
import { drain } from "@plugins/primitives/plugins/report-sink/web";
import { ReportSinks } from "@plugins/reports/plugins/collectors/web";
import { collectAdaptiveBar } from "./internal/adaptive-bar-collector";
import { AdaptiveBarKindView } from "./components/adaptive-bar-kind-view";

export default {
  description:
    "Adaptive-bar collector: drains the adaptive-bar primitive's adaptiveBarReportSink into a deduped report whenever a bar's layout contract is violated (it was given no slack, it was written inside another bar, its fit disagrees with the layout engine, its placement never converged, it refused to relocate an iframe, or one of its widgets declared a form it does not render), plus the Debug → Reports summary view.",
  contributions: [
    ReportSinks.Collector({
      from: "primitives.adaptive-bar",
      collect: drain(adaptiveBarReportSink, collectAdaptiveBar),
      companion: true,
    }),
    Reports.KindView({ match: "adaptive-bar", component: AdaptiveBarKindView }),
  ],
} satisfies PluginDefinition;
