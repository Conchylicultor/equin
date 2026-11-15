import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { materialGroup } from "../core";

export default {
  description:
    "Material token group (a floating panel's fill and backdrop filter — opaque, unfiltered by default; frosted glass when a theme sets them). Its customizer section is the `customizer` child.",
  contributions: [
    ThemeEngine.TokenGroup({
      id: "material",
      label: "Material",
      descriptor: materialGroup,
    }),
  ],
} satisfies PluginDefinition;
