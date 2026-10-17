import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Icons } from "@plugins/ui/plugins/icons/web";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { tokenGroupMatchesSearch } from "@plugins/ui/plugins/theme-engine/core";
import { ThemeCustomizer } from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import { iconsGroup } from "../core";
import { IconsSection } from "./components/icons-section";
import { IconThemeBridge } from "./components/icon-theme-bridge";

export default {
  description:
    "Icons token group (family — Material Symbols or their Lucide counterparts — and the shape, fill, active fill and stroke of the Material Symbols a scope draws; Material, outline, filled when active, by default) with its customizer section, and the bridge that publishes each painted theme scope's icon style to the icons primitive.",
  contributions: [
    ThemeEngine.TokenGroup({
      id: "icons",
      label: "Icons",
      descriptor: iconsGroup,
    }),
    ThemeCustomizer.Section({
      id: "icons",
      label: "Icons",
      component: IconsSection,
      useAvailable: ({ search }) => tokenGroupMatchesSearch(iconsGroup, search),
    }),
    Icons.Root({ component: IconThemeBridge, companion: true }),
  ],
} satisfies PluginDefinition;
