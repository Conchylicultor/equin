import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeCustomizer } from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import { tokenGroupMatchesSearch } from "@plugins/ui/plugins/theme-engine/core";
import { TypeScaleSection } from "./components/type-scale-section";
import { typeScaleGroup } from "@plugins/ui/plugins/tokens/plugins/type-scale/core";

export default {
  description: "Customizer section for the type-scale token group.",
  contributions: [
    ThemeCustomizer.Section({
      companion: true,
      id: "type-scale",
      label: "Type Scale",
      component: TypeScaleSection,
      // No token in this group answers the search box ⇒ no card, rather
      // than a titled bar over a filtered-to-empty list.
      useAvailable: ({ search }) =>
        tokenGroupMatchesSearch(typeScaleGroup, search),
    }),
  ],
} satisfies PluginDefinition;
