import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import {
  SiteOverview,
  SiteTabs,
} from "@plugins/apps/plugins/deploy/plugins/deployments/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { DeployOverviewCard } from "./components/deploy-overview-card";
import { DeployHistorySection } from "./components/deploy-history-section";
import { DeployRunItemActions } from "./slots";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { Deploy } from "@plugins/apps/plugins/deploy/plugins/shell/web";
import { opensPane } from "@plugins/primitives/plugins/app-shell/web";
import { activityPane } from "./panes";

export { DeployRunItemActions } from "./slots";

export default {
  description:
    "The Activity page (/deploy/activity, its sidebar entry): every deploy run across every site as the merged runs surface (RunsDataView) with its own view pills — Recent, Running, Needs approval, Failed. Deployments tab of a site's page: this deployment's durable run ledger (`deploy_runs`) as a live DataView window (`deployRunHistory`, sortable and filterable by the surface's custom columns) — outcome and the leg a failure died on, verb, short commit, pinned release run, duration and relative time, with a failed run's CLI message verbatim. The record beside the in-memory live view, so what happened here survives a backend restart. Owns the row-action slot its children hang a failed run's next step off.",
  contributions: [
    Pane.Register({ pane: activityPane }),
    Deploy.Sidebar({
      id: "activity",
      title: "Activity",
      icon: symbol("monitoring"),
      opens: opensPane(activityPane, {}),
    }),
    SiteTabs.View({
      id: "deployments",
      title: "Deployments",
      icon: symbol("history"),
      component: DeployHistorySection,
    }),
    SiteOverview.Card({
      id: "deployments",
      column: "side",
      component: DeployOverviewCard,
    }),
  ],
  slots: {
    itemActions: DeployRunItemActions,
    "deploy-activity": activityPane,
  },
} satisfies PluginDefinition;
