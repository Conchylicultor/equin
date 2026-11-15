import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { shapeGroup } from "../core";

export default {
  description:
    "Shape token group (border radius, base spacing). Its customizer section is the `customizer` child.",
  contributions: [
    ThemeEngine.TokenGroup({
      id: "shape",
      label: "Shape",
      descriptor: shapeGroup,
    }),
  ],
} satisfies PluginDefinition;
