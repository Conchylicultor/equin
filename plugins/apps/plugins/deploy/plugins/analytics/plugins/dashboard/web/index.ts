import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import {
  SiteOverview,
  SiteTabs,
} from "@plugins/apps/plugins/deploy/plugins/deployments/web";
import { TopCards, TrafficCard } from "./components/overview-cards";
import { AnalyticsSection } from "./components/analytics-section";
import { OwnerDevicesCard } from "./components/owner-devices-card";
import { useAnalyticsAvailable } from "./internal/use-analytics-available";
import { symbol } from "@plugins/ui/plugins/icons/core";

import { SiteLive } from "@plugins/apps/plugins/deploy/plugins/box-link/plugins/site-row/web";
import { SiteVisitors } from "./slots";
import {
  VisitorsNow,
  VisitorsNowExhibit,
  VisitorsSection,
  VisitorsSectionExhibit,
} from "./components/site-visitors";

export { SiteVisitors } from "./slots";
export type { SiteVisitorsNote, SiteVisitorsNoteProps } from "./slots";

export default {
  description:
    "Analytics tab of a site's page, shown only when the deployment's composition ships the collect plugin: range and comparison controls, KPI tiles choosing a trend line with a dashed previous period, ranked Pages / Sources / Locations / Devices / Events panels whose rows filter the whole dashboard (one filter on ranges past the raw window), and what one visit records. In the health report's deployed-site row: visitors now on its title line and the Visitors block (today with its SiteVisitors.Note notes, the last hour as a sparkline with its freshness). Reads the report computed from this computer's copy of the site's tables (pushed as the copy syncs), under the copy's freshness line; loading until a first copy is in place, an explicit state for a refusal or a failed read.",
  contributions: [
    // The deployed-site row in the health report: visitors now on its title
    // line, and the Visitors block (today, the last hour) in its body.
    SiteLive.Glance({
      id: "visitors-now",
      component: VisitorsNow,
      exhibit: VisitorsNowExhibit,
    }),
    SiteLive.Section({
      id: "visitors",
      component: VisitorsSection,
      exhibit: VisitorsSectionExhibit,
    }),
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
    // How the owner marks their own browsers, so their reading never counts.
    SiteOverview.Card({
      id: "owner-devices",
      column: "side",
      component: OwnerDevicesCard,
    }),
  ],
  slots: SiteVisitors,
} satisfies PluginDefinition;
