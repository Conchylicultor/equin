import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { densityGroup } from "../core";

export default {
  description:
    "Density token group (padding intents, control heights, the spacing ramp). Its customizer section is the `customizer` child.",
  contributions: [
    ThemeEngine.TokenGroup({
      id: "density",
      label: "Density",
      descriptor: densityGroup,
    }),
  ],
} satisfies PluginDefinition;
