import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { colorPaletteGroup } from "../core";

export default {
  description:
    "Color palette token group (surfaces, text, accents, status colors). Its customizer section is the `customizer` child.",
  contributions: [
    ThemeEngine.TokenGroup({
      id: "color-palette",
      label: "Color Palette",
      descriptor: colorPaletteGroup,
    }),
  ],
} satisfies PluginDefinition;
