import { useDeploymentShips } from "@plugins/apps/plugins/deploy/plugins/host-query/web";
import { INTAKE_PLUGIN_ID } from "./intake-plugin-id";

/**
 * The section gate: does the deployment's composition ship the intake? `true`
 * while loading (the card shows its own loading state rather than popping in a
 * frame late) and when the answer failed, so the card can show that failure.
 */
export function useMessagesAvailable({
  deploymentId,
}: {
  deploymentId: string;
}): boolean {
  return useDeploymentShips(deploymentId, INTAKE_PLUGIN_ID).kind !== "no";
}
