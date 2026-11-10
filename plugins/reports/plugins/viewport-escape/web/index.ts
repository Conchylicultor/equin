import {
  Core,
  type PluginDefinition,
} from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { ViewportEscapeCollector } from "./components/viewport-escape-collector";
import { ViewportEscapeKindView } from "./components/viewport-escape-kind-view";

export default {
  description:
    "Viewport-escape collector: drains the viewport-overlay primitive's viewportEscapeReportSink into a deduped report whenever an ancestor stops a viewport-filling box from reaching the viewport (a containing block) or from painting over the chrome beside it (a stacking context), plus the Debug → Reports summary view.",
  contributions: [
    Core.Root({ component: ViewportEscapeCollector, scope: "page" }),
    Reports.KindView({
      match: "viewport-escape",
      component: ViewportEscapeKindView,
    }),
  ],
} satisfies PluginDefinition;
