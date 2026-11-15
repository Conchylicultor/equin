import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeCustomizer } from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import { tokenGroupMatchesSearch } from "@plugins/ui/plugins/theme-engine/core";
import { DataViewTokensSection } from "./components/data-view-tokens-section";
import { dataViewGroup } from "@plugins/ui/plugins/tokens/plugins/data-view/core";

export default {
  description: "Customizer section for the DataView token group.",
  contributions: [
    ThemeCustomizer.Section({
      companion: true,
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
