import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { sidebarMetricsGroup } from "../core";

export default {
  description:
    "Sidebar metrics token group (panel width, nav row height, padding, icon size, icon gap — no type: the nav label is the `label` role). Its customizer section is the `customizer` child.",
  contributions: [
    ThemeEngine.TokenGroup({
      id: "sidebar-metrics",
      label: "Sidebar Metrics",
      descriptor: sidebarMetricsGroup,
    }),
  ],
} satisfies PluginDefinition;
