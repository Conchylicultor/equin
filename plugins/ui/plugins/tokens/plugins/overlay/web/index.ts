import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { tokenGroupMatchesSearch } from "@plugins/ui/plugins/theme-engine/core";
import { ThemeCustomizer } from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import { overlayGroup } from "../core";
import { OverlaySection } from "./components/overlay-section";

export default {
  description:
    "Overlay token group (how a floating panel enters — instant by default — and the tooltip's fill, ink, ring, corners, padding, shadow, distance and arrow) with its customizer section.",
  contributions: [
    ThemeEngine.TokenGroup({
      id: "overlay",
      label: "Overlay",
      descriptor: overlayGroup,
    }),
    ThemeCustomizer.Section({
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
