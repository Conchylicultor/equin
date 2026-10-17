import {
  Core,
  type PluginDefinition,
} from "@plugins/framework/plugins/web-sdk/core";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { tokenGroupMatchesSearch } from "@plugins/ui/plugins/theme-engine/core";
import { ThemeCustomizer } from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import { fontFamilyGroup } from "../core";
import { FontFamilySection } from "./components/font-family-section";
import { FontFamily } from "./slots";

export { FontFamily } from "./slots";

export default {
  description:
    "Font-family token group (sans/serif/mono families, letter-spacing) with its customizer section.",
  contributions: [
    ThemeEngine.TokenGroup({
      id: "font-family",
      label: "Fonts",
      descriptor: fontFamilyGroup,
    }),
    ThemeCustomizer.Section({
      id: "font-family",
      label: "Fonts",
      component: FontFamilySection,
      // No token in this group answers the search box ⇒ no card, rather
      // than a titled bar over a filtered-to-empty list.
      useAvailable: ({ search }) =>
        tokenGroupMatchesSearch(fontFamilyGroup, search),
    }),
    Core.Root({ slot: FontFamily.Root }),
  ],
  slots: FontFamily,
} satisfies PluginDefinition;
