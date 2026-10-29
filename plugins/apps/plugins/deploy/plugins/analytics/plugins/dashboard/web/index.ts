import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import {
  SiteOverview,
  SiteTabs,
} from "@plugins/apps/plugins/deploy/plugins/deployments/web";
import { TopCards, TrafficCard } from "./components/overview-cards";
import { AnalyticsSection } from "./components/analytics-section";
import { useAnalyticsAvailable } from "./internal/use-analytics-available";
import { symbol } from "@plugins/ui/plugins/icons/core";

export default {
  description:
    "Analytics tab of a site's page, shown only when the deployment's composition ships the collect plugin: range and comparison controls, KPI tiles choosing a trend line with a dashed previous period, ranked Pages / Sources / Locations / Devices / Events panels whose rows filter the whole dashboard (one filter on ranges past the raw window), and what one visit records. Reads the report over SSH on demand, with explicit states for every failure.",
  contributions: [
    SiteTabs.View({
      id: "analytics",
      title: "Analytics",
      icon: symbol("insights"),
      component: AnalyticsSection,
      useAvailable: useAnalyticsAvailable,
    }),
    // The Overview's analytics cards: ONE shared 30-day report — the Analytics
    // tab's own opening question — drawn as Traffic and, beneath it, the top
    // pages and sources.
    SiteOverview.Card({
      id: "traffic",
      column: "main",
      component: TrafficCard,
    }),
    SiteOverview.Card({ id: "top", column: "main", component: TopCards }),
  ],
} satisfies PluginDefinition;
