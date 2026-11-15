import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeCustomizer } from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import { tokenGroupMatchesSearch } from "@plugins/ui/plugins/theme-engine/core";
import { SpendPaletteSection } from "./components/spend-palette-section";
import { spendPaletteGroup } from "@plugins/ui/plugins/tokens/plugins/spend-palette/core";

export default {
  description:
    "Customizer section for the spend colour token group (--spend-1…5, --spend-rest).",
  contributions: [
    ThemeCustomizer.Section({
      companion: true,
      id: "spend-palette",
      label: "Spend colours",
      component: SpendPaletteSection,
      useAvailable: ({ search }) =>
        tokenGroupMatchesSearch(spendPaletteGroup, search),
    }),
  ],
} satisfies PluginDefinition;
