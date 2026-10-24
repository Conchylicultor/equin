import {
  Core,
  type PluginDefinition,
} from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { IconFamilyGapCollector } from "./components/icon-family-gap-collector";
import { IconFamilyGapKindView } from "./components/icon-family-gap-kind-view";

export default {
  description:
    "Icon-family-gap collector: drains the icons plugin's iconFamilyGapReportSink into a deduped report whenever a scope whose icon family is strict draws a symbol the family does not map (it shows the family's gap glyph), plus the Debug → Reports summary view.",
  contributions: [
    Core.Root({ component: IconFamilyGapCollector }),
    Reports.KindView({
      match: "icon-family-gap",
      component: IconFamilyGapKindView,
    }),
  ],
} satisfies PluginDefinition;
