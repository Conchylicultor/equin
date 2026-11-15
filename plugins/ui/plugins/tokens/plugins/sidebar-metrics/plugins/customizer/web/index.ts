import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeCustomizer } from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import { tokenGroupMatchesSearch } from "@plugins/ui/plugins/theme-engine/core";
import { SidebarMetricsSection } from "./components/sidebar-metrics-section";
import { sidebarMetricsGroup } from "@plugins/ui/plugins/tokens/plugins/sidebar-metrics/core";

export default {
  description: "Customizer section for the sidebar metrics token group.",
  contributions: [
    ThemeCustomizer.Section({
      companion: true,
      id: "sidebar-metrics",
      label: "Sidebar Metrics",
      component: SidebarMetricsSection,
      // No token in this group answers the search box ⇒ no card, rather
      // than a titled bar over a filtered-to-empty list.
      useAvailable: ({ search }) =>
        tokenGroupMatchesSearch(sidebarMetricsGroup, search),
    }),
  ],
} satisfies PluginDefinition;
