import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { overlayGroup } from "../core";

export default {
  description:
    "Overlay token group (how a floating panel enters — instant by default — and the tooltip's fill, ink, ring, corners, padding, shadow, distance and arrow). Its customizer section is the `customizer` child.",
  contributions: [
    ThemeEngine.TokenGroup({
      id: "overlay",
      label: "Overlay",
      descriptor: overlayGroup,
    }),
  ],
} satisfies PluginDefinition;
