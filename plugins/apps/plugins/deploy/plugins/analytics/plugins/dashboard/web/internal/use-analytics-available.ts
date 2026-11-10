import {
  useDeploymentShips,
  useShipsGate,
  type DeploymentShips,
} from "@plugins/apps/plugins/deploy/plugins/host-query/web";
import { COLLECT_PLUGIN_ID } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";

/**
 * Does this deployment's software record visits? Whether the resolved closure
 * of the composition it ships includes the collect plugin — never decided from
 * the composition's name (host-query's `useDeploymentShips`).
 */
export function useShipsAnalytics(deploymentId: string): DeploymentShips {
  return useDeploymentShips(deploymentId, COLLECT_PLUGIN_ID);
}

/** The Analytics tab's gate: host-query's shared rule over collect's id. */
export function useAnalyticsAvailable({
  deploymentId,
}: {
  deploymentId: string;
}): boolean {
  return useShipsGate(deploymentId, COLLECT_PLUGIN_ID);
}
