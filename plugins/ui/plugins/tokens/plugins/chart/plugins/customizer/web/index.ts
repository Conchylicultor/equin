import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeCustomizer } from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import { tokenGroupMatchesSearch } from "@plugins/ui/plugins/theme-engine/core";
import { ChartSection } from "./components/chart-section";
import { chartGroup } from "@plugins/ui/plugins/tokens/plugins/chart/core";

export default {
  description:
    "Customizer section for the chart color token group (chart-1…5).",
  contributions: [
    ThemeCustomizer.Section({
      companion: true,
      id: "chart",
      label: "Chart",
      component: ChartSection,
      // No token in this group answers the search box ⇒ no card. The body
      // does not filter itself, so without this the section stayed put
      // (full) under a query that matched nothing in it.
      useAvailable: ({ search }) => tokenGroupMatchesSearch(chartGroup, search),
    }),
  ],
} satisfies PluginDefinition;
