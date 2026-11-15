import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeCustomizer } from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import { tokenGroupMatchesSearch } from "@plugins/ui/plugins/theme-engine/core";
import { ScrollbarSection } from "./components/scrollbar-section";
import { scrollbarGroup } from "@plugins/ui/plugins/tokens/plugins/scrollbar/core";

export default {
  description: "Customizer section for the scrollbar token group.",
  contributions: [
    ThemeCustomizer.Section({
      companion: true,
      id: "scrollbar",
      label: "Scrollbar",
      component: ScrollbarSection,
      // No token in this group answers the search box ⇒ no card, rather
      // than a titled bar over a filtered-to-empty list.
      useAvailable: ({ search }) =>
        tokenGroupMatchesSearch(scrollbarGroup, search),
    }),
  ],
} satisfies PluginDefinition;
