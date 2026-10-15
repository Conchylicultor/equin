import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ServerDetail } from "@plugins/apps/plugins/deploy/plugins/servers/web";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { DeploymentsSection } from "./components/deployments-section";
import { DeploymentOverview } from "./components/deployment-overview";
import {
  DeploymentItemActions,
  DeployAction,
  DeleteDeploymentAction,
} from "./components/deployment-item-actions";
import { deploymentDetailPane } from "./panes";
import { DeploymentDetail } from "./slots";
import { IdKinds } from "@plugins/ids/web";
import { deploymentIdKind, deployRunIdKind } from "../core";

export {
  DeploymentItemActions,
  useBlockedReason,
} from "./components/deployment-item-actions";
export { DeploymentDetail } from "./slots";
export { deploymentDetailPane } from "./panes";

export default {
  description:
    "Deployments section of a server's page: this server's deployments as a DataView (composition, last run, plus contributed columns), an add affordance whose composition picker reads the compositions config, a Deploy row action that launches the CLI's whole converge-build-ship run, and the per-deployment pane whose sections (overview, plus contributed ones) carry the record, its derived install and the remote-deploy surface.",
  contributions: [
    IdKinds.Kind({ kind: deploymentIdKind }),
    IdKinds.Kind({ kind: deployRunIdKind }),
    ServerDetail.Section({
      id: "deployments",
      label: "Deployments",
      component: DeploymentsSection,
    }),
    Pane.Register({ pane: deploymentDetailPane }),
    // The record and its derived install: this plugin's own content, contributed
    // through the same slot every other section uses — the pane's owner gets no
    // privileged mount point.
    DeploymentDetail.Section({
      id: "overview",
      label: "Overview",
      component: DeploymentOverview,
    }),
    // Deploy and Delete are contributed into this plugin's own row-action slot
    // rather than hard-rendered, so the row's affordances stay a set the reorder
    // config orders and a later plugin can extend (a rollback action, say)
    // without touching the list.
    DeploymentItemActions({ id: "deploy", component: DeployAction }),
    DeploymentItemActions({ id: "delete", component: DeleteDeploymentAction }),
  ],
  slots: {
    ...DeploymentDetail,
    itemActions: DeploymentItemActions,
    "deploy-deployment-detail": deploymentDetailPane,
  },
} satisfies PluginDefinition;
