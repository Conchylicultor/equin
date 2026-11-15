import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { spendPaletteGroup } from "../core";

export default {
  description:
    "Spend colour token group: --spend-1…5 (a spend breakdown's parts, in order) and --spend-rest (the folded remainder). Its customizer section is the `customizer` child.",
  contributions: [
    ThemeEngine.TokenGroup({
      id: "spend-palette",
      label: "Spend colours",
      descriptor: spendPaletteGroup,
    }),
  ],
} satisfies PluginDefinition;
