import {
  useDeploymentShips,
  type DeploymentShips,
} from "@plugins/apps/plugins/deploy/plugins/host-query/web";
import { COLLECT_PLUGIN_ID } from "./collect-plugin-id";

/**
 * Does this deployment's software record visits? Whether the resolved closure
 * of the composition it ships includes the collect plugin — never decided from
 * the composition's name (host-query's `useDeploymentShips`).
 */
export function useShipsAnalytics(deploymentId: string): DeploymentShips {
  return useDeploymentShips(deploymentId, COLLECT_PLUGIN_ID);
}

/**
 * The section gate. `true` while loading: the card shows its own loading state
 * rather than popping in a frame late (the detail-sections contract) — and
 * `true` when the answer failed, so the card can show that failure.
 */
export function useAnalyticsAvailable({
  deploymentId,
}: {
  deploymentId: string;
}): boolean {
  return useShipsAnalytics(deploymentId).kind !== "no";
}
