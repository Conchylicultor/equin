import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { tokenGroupMatchesSearch } from "@plugins/ui/plugins/theme-engine/core";
import { ThemeCustomizer } from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import { materialGroup } from "../core";
import { MaterialSection } from "./components/material-section";

export default {
  description:
    "Material token group (a floating panel's fill and backdrop filter — opaque, unfiltered by default; frosted glass when a theme sets them) with its customizer section.",
  contributions: [
    ThemeEngine.TokenGroup({
      id: "material",
      label: "Material",
      descriptor: materialGroup,
    }),
    ThemeCustomizer.Section({
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
