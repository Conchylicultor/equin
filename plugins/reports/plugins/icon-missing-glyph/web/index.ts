import {
  Core,
  type PluginDefinition,
} from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { IconMissingGlyphCollector } from "./components/icon-missing-glyph-collector";
import { IconMissingGlyphKindView } from "./components/icon-missing-glyph-kind-view";

export default {
  description:
    "Icon-missing-glyph collector: drains the icons plugin's iconMissingGlyphReportSink into a deduped report whenever a held sprite has no symbol for an icon <Icon> draws (the build's icon manifest missed the name; the icon shows the missing-glyph marker), plus the Debug → Reports summary view.",
  contributions: [
    Core.Root({ component: IconMissingGlyphCollector, scope: "page" }),
    Reports.KindView({
      match: "icon-missing-glyph",
      component: IconMissingGlyphKindView,
    }),
  ],
} satisfies PluginDefinition;
