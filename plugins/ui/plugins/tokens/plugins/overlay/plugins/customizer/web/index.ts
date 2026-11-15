import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeCustomizer } from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import { tokenGroupMatchesSearch } from "@plugins/ui/plugins/theme-engine/core";
import { OverlaySection } from "./components/overlay-section";
import { overlayGroup } from "@plugins/ui/plugins/tokens/plugins/overlay/core";

export default {
  description: "Customizer section for the overlay token group.",
  contributions: [
    ThemeCustomizer.Section({
      companion: true,
      id: "overlay",
      label: "Overlay",
      component: OverlaySection,
      // No token in this group answers the search box ⇒ no card, rather
      // than a titled bar over a filtered-to-empty list.
      useAvailable: ({ search }) =>
        tokenGroupMatchesSearch(overlayGroup, search, [
          "popover",
          "tooltip",
          "animation",
          "motion",
        ]),
    }),
  ],
} satisfies PluginDefinition;
