import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { tokenGroupMatchesSearch } from "@plugins/ui/plugins/theme-engine/core";
import { ThemeCustomizer } from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import { dataViewGroup } from "../core";
import { DataViewTokensSection } from "./components/data-view-tokens-section";

export default {
  description:
    "DataView token group (each part's type pick — rung, emphasis, family — plus the inks and metrics of the toolbar pills, view chips, gallery card and cover, group headers and the soft table; every default reproduces today's look) with its customizer section.",
  contributions: [
    ThemeEngine.TokenGroup({
      id: "data-view",
      label: "DataView",
      descriptor: dataViewGroup,
    }),
    ThemeCustomizer.Section({
      id: "data-view",
      label: "DataView",
      component: DataViewTokensSection,
      // No token in this group answers the search box ⇒ no card.
      useAvailable: ({ search }) =>
        tokenGroupMatchesSearch(dataViewGroup, search, [
          "data view",
          "gallery",
          "table",
          "toolbar",
        ]),
    }),
  ],
} satisfies PluginDefinition;
