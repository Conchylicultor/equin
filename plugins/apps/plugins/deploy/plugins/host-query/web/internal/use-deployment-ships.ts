import {
  useLiveRow,
  type LiveRowResult,
} from "@plugins/network/plugins/live/web";
import type { ResourceError } from "@plugins/primitives/plugins/live-state/web";
import { useCompositionIncludes } from "@plugins/plugin-meta/plugins/composition/web";
import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";
import {
  deployments,
  type Deployment,
} from "@plugins/apps/plugins/deploy/plugins/deployments/core";

/**
 * Does this deployment's software include a plugin? Decided from the resolved
 * closure of the composition it ships — never from the composition's name.
 *
 * - `pending` — the deployment row or the plugin graph is still loading.
 * - `failed` — the plugin graph could not be read, so the answer is unknown:
 *   the section shows the failure with its Retry.
 * - `no` — it does not ship the plugin, or there is nothing to ask about (the
 *   deployment is gone or unreadable, or its composition name no longer
 *   resolves — the overview and composition sections already say so).
 */
export type DeploymentShips =
  | { kind: "pending" }
  | { kind: "failed"; error: ResourceError; refetch: () => Promise<void> }
  | { kind: "yes" }
  | { kind: "no" };

const PENDING: DeploymentShips = { kind: "pending" };
const YES: DeploymentShips = { kind: "yes" };
const NO: DeploymentShips = { kind: "no" };

type DeploymentComposition =
  | { kind: "pending" }
  | { kind: "gone" }
  // The row could not be read: nothing to ask about, like `gone` — the
  // overview section renders the failure with its Retry.
  | { kind: "unreadable" }
  | { kind: "named"; name: string };

function compositionOf(
  deployment: LiveRowResult<Deployment>,
): DeploymentComposition {
  switch (deployment.status) {
    case "loading":
      return { kind: "pending" };
    case "error":
      return { kind: "unreadable" };
    case "ready":
      return deployment.found
        ? { kind: "named", name: deployment.row.compositionId }
        : { kind: "gone" };
  }
}

export function useDeploymentShips(
  deploymentId: string,
  pluginId: PluginId,
): DeploymentShips {
  const composition = compositionOf(useLiveRow(deployments, deploymentId));
  const inclusion = useCompositionIncludes(
    composition.kind === "named" ? composition.name : null,
    pluginId,
  );

  switch (composition.kind) {
    case "pending":
      return PENDING;
    case "gone":
    case "unreadable":
      return NO;
    case "named":
      switch (inclusion.kind) {
        case "pending":
          return PENDING;
        case "failed":
          return inclusion;
        case "unknown-composition":
          return NO;
        case "ready":
          return inclusion.included ? YES : NO;
      }
  }
}
