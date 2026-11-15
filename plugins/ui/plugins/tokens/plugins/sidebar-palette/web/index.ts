import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { sidebarPaletteGroup } from "../core";

export default {
  description:
    "Sidebar palette token group. Its customizer section is the `customizer` child.",
  contributions: [
    ThemeEngine.TokenGroup({
      id: "sidebar-palette",
      label: "Sidebar Palette",
      descriptor: sidebarPaletteGroup,
    }),
  ],
} satisfies PluginDefinition;
