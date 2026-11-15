import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { chartGroup } from "../core";

export default {
  description:
    "Chart color token group: the chart-1…5 ramp. Its customizer section is the `customizer` child.",
  contributions: [
    ThemeEngine.TokenGroup({
      id: "chart",
      label: "Chart",
      descriptor: chartGroup,
    }),
  ],
} satisfies PluginDefinition;
