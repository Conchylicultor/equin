import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { shadowGroup } from "../core";

export default {
  description:
    "Shadow token group (the shadow-2xs…2xl tiers). Its param-driven customizer section is the `customizer` child.",
  contributions: [
    ThemeEngine.TokenGroup({
      id: "shadow",
      label: "Shadow",
      descriptor: shadowGroup,
    }),
  ],
} satisfies PluginDefinition;
