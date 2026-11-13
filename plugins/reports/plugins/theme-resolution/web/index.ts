import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { themeResolutionReportSink } from "@plugins/ui/plugins/theme-engine/web";
import { drain } from "@plugins/primitives/plugins/report-sink/web";
import { ReportSinks } from "@plugins/reports/plugins/collectors/web";
import { collectThemeResolution } from "./internal/theme-resolution-collector";
import { ThemeResolutionKindView } from "./components/theme-resolution-kind-view";

export default {
  description:
    "Theme-resolution collector: drains theme-engine's themeResolutionReportSink into a report whenever a scope's theme cannot be painted as stored (its selected theme does not exist, or a stored theme carries values the token groups no longer declare), plus the Debug → Reports summary view.",
  contributions: [
    ReportSinks.Collector({
      from: "ui.theme-engine",
      collect: drain(themeResolutionReportSink, collectThemeResolution),
      companion: true,
    }),
    Reports.KindView({
      match: "theme-resolution",
      component: ThemeResolutionKindView,
    }),
  ],
} satisfies PluginDefinition;
