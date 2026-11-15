import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeCustomizer } from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import { tokenGroupMatchesSearch } from "@plugins/ui/plugins/theme-engine/core";
import { MaterialSection } from "./components/material-section";
import { materialGroup } from "@plugins/ui/plugins/tokens/plugins/material/core";

export default {
  description: "Customizer section for the material token group.",
  contributions: [
    ThemeCustomizer.Section({
      companion: true,
      id: "material",
      label: "Material",
      component: MaterialSection,
      // No token in this group answers the search box ⇒ no card, rather
      // than a titled bar over a filtered-to-empty list.
      useAvailable: ({ search }) =>
        tokenGroupMatchesSearch(materialGroup, search, [
          "glass",
          "frosted",
          "blur",
          "translucent",
        ]),
    }),
  ],
} satisfies PluginDefinition;
