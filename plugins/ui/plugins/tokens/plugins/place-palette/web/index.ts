import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { tokenGroupMatchesSearch } from "@plugins/ui/plugins/theme-engine/core";
import { ThemeCustomizer } from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import { placePaletteGroup } from "../core";
import { PlacePaletteSection } from "./components/place-palette-section";

export default {
  description:
    "Place colour token group: the --place-<family> colours place cards are painted with (Google Maps' own pin colours by default), plus --place-overlay — the accent of a page's places laid over the Places map — and their customizer section.",
  contributions: [
    ThemeEngine.TokenGroup({
      id: "place",
      label: "Places",
      descriptor: placePaletteGroup,
    }),
    ThemeCustomizer.Section({
      id: "place",
      label: "Places",
      component: PlacePaletteSection,
      useAvailable: ({ search }) =>
        tokenGroupMatchesSearch(placePaletteGroup, search),
    }),
  ],
} satisfies PluginDefinition;
