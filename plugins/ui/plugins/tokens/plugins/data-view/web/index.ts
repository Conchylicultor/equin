import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { dataViewGroup } from "../core";

export default {
  description:
    "DataView token group (each part's type pick — rung, emphasis, family — plus the inks and metrics of the toolbar pills, view chips, gallery card and cover, group headers and the soft table; every default reproduces today's look). Its customizer section is the `customizer` child.",
  contributions: [
    ThemeEngine.TokenGroup({
      id: "data-view",
      label: "DataView",
      descriptor: dataViewGroup,
    }),
  ],
} satisfies PluginDefinition;
