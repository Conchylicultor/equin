import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { viewportEscapeReportSink } from "@plugins/primitives/plugins/css/plugins/viewport-overlay/web";
import { drain } from "@plugins/primitives/plugins/report-sink/web";
import { ReportSinks } from "@plugins/reports/plugins/collectors/web";
import { collectViewportEscape } from "./internal/viewport-escape-collector";
import { ViewportEscapeKindView } from "./components/viewport-escape-kind-view";

export default {
  description:
    "Viewport-escape collector: drains the viewport-overlay primitive's viewportEscapeReportSink into a deduped report whenever an ancestor stops a viewport-filling box from reaching the viewport (a containing block) or from painting over the chrome beside it (a stacking context), plus the Debug → Reports summary view.",
  contributions: [
    ReportSinks.Collector({
      from: "primitives.css.viewport-overlay",
      collect: drain(viewportEscapeReportSink, collectViewportEscape),
      companion: true,
    }),
    Reports.KindView({
      match: "viewport-escape",
      component: ViewportEscapeKindView,
    }),
  ],
} satisfies PluginDefinition;
