import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeCustomizer } from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import { tokenGroupMatchesSearch } from "@plugins/ui/plugins/theme-engine/core";
import { DensitySection } from "./components/density-section";
import { densityGroup } from "@plugins/ui/plugins/tokens/plugins/density/core";

export default {
  description:
    'Customizer section for the density token group, with "Fill from…" shortcuts.',
  contributions: [
    ThemeCustomizer.Section({
      companion: true,
      id: "density",
      label: "Density",
      component: DensitySection,
      // No token in this group answers the search box ⇒ no card, rather
      // than a titled bar over a filtered-to-empty list.
      useAvailable: ({ search }) =>
        tokenGroupMatchesSearch(densityGroup, search),
    }),
  ],
} satisfies PluginDefinition;
