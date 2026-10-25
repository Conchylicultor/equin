import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  HostQueryErrorState,
  HostQueryFailureState,
  type HostQuerySubject,
} from "./components/host-query-failure-state";
export {
  useDeploymentShips,
  type DeploymentShips,
} from "./internal/use-deployment-ships";

export default {
  description:
    "The deploy app's shared pieces for a section that reads its deployment's box over SSH: HostQueryFailureState renders every way the read can fail (no SSH key, unverified host, SSH failure, failed request, unreadable answer) in one vocabulary, and useDeploymentShips(deploymentId, pluginId) answers whether the deployment's composition closure includes a plugin.",
  contributions: [],
} satisfies PluginDefinition;
