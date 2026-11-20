import { _deployDeployments } from "@plugins/apps/plugins/deploy/plugins/deployments/server";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import { boxLinkRowShape } from "../../shared/shape";

// A deployment's link at its last state change: an entity extension (like
// health's `deploy_servers_ext_health`) — link-written state with its own
// writer and lifecycle, cascading with the deployment.
export const deploymentBoxLink = defineExtension(
  _deployDeployments,
  "box_link",
  boxLinkRowShape,
);
// Re-exported so drizzle-kit discovers the underlying pgTable.
export const _deployDeploymentsBoxLinkExt = deploymentBoxLink.table;
