import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { typeScaleGroup } from "../core";

export default {
  description:
    "Type-scale token group (font sizes, line heights, weights). Its customizer section is the `customizer` child.",
  contributions: [
    ThemeEngine.TokenGroup({
      id: "type-scale",
      label: "Type Scale",
      descriptor: typeScaleGroup,
    }),
  ],
} satisfies PluginDefinition;
