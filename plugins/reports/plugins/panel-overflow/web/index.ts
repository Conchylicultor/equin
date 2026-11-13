import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { panelOverflowReportSink } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { drain } from "@plugins/primitives/plugins/report-sink/web";
import { ReportSinks } from "@plugins/reports/plugins/collectors/web";
import { collectPanelOverflow } from "./internal/panel-overflow-collector";
import { PanelOverflowKindView } from "./components/panel-overflow-kind-view";

export default {
  description:
    "Panel-overflow collector: drains the control-panel primitive's panelOverflowReportSink into a deduped report whenever a popover panel's showing page is wider than the panel — content needing a width bucket (picker, builder, described) nothing on the page declared — plus the Debug → Reports summary view.",
  contributions: [
    ReportSinks.Collector({
      from: "primitives.css.control-panel",
      collect: drain(panelOverflowReportSink, collectPanelOverflow),
      companion: true,
    }),
    Reports.KindView({
      match: "panel-overflow",
      component: PanelOverflowKindView,
    }),
  ],
} satisfies PluginDefinition;
