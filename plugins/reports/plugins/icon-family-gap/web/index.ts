import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { iconFamilyGapReportSink } from "@plugins/ui/plugins/icons/web";
import { drain } from "@plugins/primitives/plugins/report-sink/web";
import { ReportSinks } from "@plugins/reports/plugins/collectors/web";
import { collectIconFamilyGap } from "./internal/icon-family-gap-collector";
import { IconFamilyGapKindView } from "./components/icon-family-gap-kind-view";

export default {
  description:
    "Icon-family-gap collector: drains the icons plugin's iconFamilyGapReportSink into a deduped report whenever a scope whose icon family is strict draws a symbol the family does not map (it shows the family's gap glyph), plus the Debug → Reports summary view.",
  contributions: [
    ReportSinks.Collector({
      from: "ui.icons",
      collect: drain(iconFamilyGapReportSink, collectIconFamilyGap),
      companion: true,
    }),
    Reports.KindView({
      match: "icon-family-gap",
      component: IconFamilyGapKindView,
    }),
  ],
} satisfies PluginDefinition;
