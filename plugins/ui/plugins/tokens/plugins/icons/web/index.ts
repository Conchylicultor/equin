import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Icons } from "@plugins/ui/plugins/icons/web";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { iconsGroup } from "../core";
import { IconThemeBridge } from "./components/icon-theme-bridge";

export default {
  description:
    "Icons token group (family — Material Symbols or their Lucide counterparts — and the shape, fill, active fill and stroke of the Material Symbols a scope draws; Material, outline, filled when active, by default), and the bridge that publishes each painted theme scope's icon style to the icons primitive. Its customizer section is the `customizer` child.",
  contributions: [
    ThemeEngine.TokenGroup({
      id: "icons",
      label: "Icons",
      descriptor: iconsGroup,
    }),
    Icons.Root({ component: IconThemeBridge, companion: true, scope: "each" }),
  ],
} satisfies PluginDefinition;
