import {
  Core,
  type PluginDefinition,
} from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { ThemeResolutionCollector } from "./components/theme-resolution-collector";
import { ThemeResolutionKindView } from "./components/theme-resolution-kind-view";

export default {
  description:
    "Theme-resolution collector: drains theme-engine's themeResolutionReportSink into a report whenever a scope's theme cannot be painted as stored (its selected theme does not exist, or a stored theme carries values the token groups no longer declare), plus the Debug → Reports summary view.",
  contributions: [
    Core.Root({ component: ThemeResolutionCollector, scope: "page" }),
    Reports.KindView({
      match: "theme-resolution",
      component: ThemeResolutionKindView,
    }),
  ],
} satisfies PluginDefinition;
