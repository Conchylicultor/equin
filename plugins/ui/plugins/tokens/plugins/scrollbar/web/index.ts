import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { scrollbarGroup } from "../core";

export default {
  description:
    "Scrollbar token group (the thumb and track colours of the native scrollbar, `auto` by default). Its customizer section is the `customizer` child.",
  contributions: [
    ThemeEngine.TokenGroup({
      id: "scrollbar",
      label: "Scrollbar",
      descriptor: scrollbarGroup,
    }),
  ],
} satisfies PluginDefinition;
