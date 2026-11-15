import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeCustomizer } from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import { tokenGroupMatchesSearch } from "@plugins/ui/plugins/theme-engine/core";
import { PlacePaletteSection } from "./components/place-palette-section";
import { placePaletteGroup } from "@plugins/ui/plugins/tokens/plugins/place-palette/core";

export default {
  description: "Customizer section for the place colour token group.",
  contributions: [
    ThemeCustomizer.Section({
      companion: true,
      id: "place",
      label: "Places",
      component: PlacePaletteSection,
      useAvailable: ({ search }) =>
        tokenGroupMatchesSearch(placePaletteGroup, search),
    }),
  ],
} satisfies PluginDefinition;
