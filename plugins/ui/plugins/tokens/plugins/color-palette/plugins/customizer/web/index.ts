import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeCustomizer } from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import { tokenGroupMatchesSearch } from "@plugins/ui/plugins/theme-engine/core";
import { ColorPaletteHeaderDots } from "./components/color-palette-header-dots";
import { ColorPaletteSection } from "./components/color-palette-section";
import { colorPaletteGroup } from "@plugins/ui/plugins/tokens/plugins/color-palette/core";

export default {
  description:
    "Customizer section for the color palette token group, with the palette dots in its header.",
  contributions: [
    ThemeCustomizer.Section({
      companion: true,
      id: "color-palette",
      label: "Color Palette",
      component: ColorPaletteSection,
      actions: ColorPaletteHeaderDots,
      // No token in this group answers the search box ⇒ no card, rather
      // than a titled bar over a filtered-to-empty list.
      useAvailable: ({ search }) =>
        tokenGroupMatchesSearch(colorPaletteGroup, search),
    }),
  ],
} satisfies PluginDefinition;
