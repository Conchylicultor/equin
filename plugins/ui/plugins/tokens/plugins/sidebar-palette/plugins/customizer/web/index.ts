import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeCustomizer } from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import { tokenGroupMatchesSearch } from "@plugins/ui/plugins/theme-engine/core";
import { SidebarPaletteHeaderDots } from "./components/sidebar-palette-header-dots";
import { SidebarPaletteSection } from "./components/sidebar-palette-section";
import { sidebarPaletteGroup } from "@plugins/ui/plugins/tokens/plugins/sidebar-palette/core";

export default {
  description:
    "Customizer section for the sidebar palette token group, with the palette dots in its header.",
  contributions: [
    ThemeCustomizer.Section({
      companion: true,
      id: "sidebar-palette",
      label: "Sidebar Palette",
      component: SidebarPaletteSection,
      actions: SidebarPaletteHeaderDots,
      // No token in this group answers the search box ⇒ no card, rather
      // than a titled bar over a filtered-to-empty list.
      useAvailable: ({ search }) =>
        tokenGroupMatchesSearch(sidebarPaletteGroup, search),
    }),
  ],
} satisfies PluginDefinition;
