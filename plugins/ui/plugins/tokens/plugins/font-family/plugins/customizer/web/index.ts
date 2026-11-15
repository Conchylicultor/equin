import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeCustomizer } from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import { tokenGroupMatchesSearch } from "@plugins/ui/plugins/theme-engine/core";
import { FontFamilySection } from "./components/font-family-section";
import { fontFamilyGroup } from "@plugins/ui/plugins/tokens/plugins/font-family/core";

export default {
  description: "Customizer section for the font-family token group.",
  contributions: [
    ThemeCustomizer.Section({
      companion: true,
      id: "font-family",
      label: "Fonts",
      component: FontFamilySection,
      // No token in this group answers the search box ⇒ no card, rather
      // than a titled bar over a filtered-to-empty list.
      useAvailable: ({ search }) =>
        tokenGroupMatchesSearch(fontFamilyGroup, search),
    }),
  ],
} satisfies PluginDefinition;
