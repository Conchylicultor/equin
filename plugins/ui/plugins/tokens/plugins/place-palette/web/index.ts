import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { placePaletteGroup } from "../core";

export default {
  description:
    "Place colour token group: the --place-<family> colours place cards are painted with (Google Maps' own pin colours by default), plus --place-overlay — the accent of a page's places laid over the Places map. Its customizer section is the `customizer` child.",
  contributions: [
    ThemeEngine.TokenGroup({
      id: "place",
      label: "Places",
      descriptor: placePaletteGroup,
    }),
  ],
} satisfies PluginDefinition;
