import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { categoricalGroup } from "../core";

export default {
  description:
    "Categorical color palette token group: the categorical-1…10 series colors. Its customizer section is the `customizer` child.",
  contributions: [
    ThemeEngine.TokenGroup({
      id: "categorical",
      label: "Categorical",
      descriptor: categoricalGroup,
    }),
  ],
} satisfies PluginDefinition;
