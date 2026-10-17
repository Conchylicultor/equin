import {
  Core,
  type PluginDefinition,
} from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { PanelOverflowCollector } from "./components/panel-overflow-collector";
import { PanelOverflowKindView } from "./components/panel-overflow-kind-view";

export default {
  description:
    "Panel-overflow collector: drains the control-panel primitive's panelOverflowReportSink into a deduped report whenever a popover panel's showing page is wider than the panel — content needing a width bucket (picker, builder, described) nothing on the page declared — plus the Debug → Reports summary view.",
  contributions: [
    Core.Root({ component: PanelOverflowCollector }),
    Reports.KindView({
      match: "panel-overflow",
      component: PanelOverflowKindView,
    }),
  ],
} satisfies PluginDefinition;
