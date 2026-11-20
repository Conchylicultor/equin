import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
// Side-effect registration only: eagerly registers the boot-critical
// build.deployment web descriptor (see ./internal/register).
import "./internal/register";

export { DeploymentChain } from "./internal/deployment-chain";
export { useDeployment } from "./internal/use-deployment";
export type { DeploymentReading } from "./internal/use-deployment";

export default {
  description:
    "The client half of the deployment description: `useDeployment()` composes THIS tab's own baked pin in beside the server's two deployable carriers, and `<DeploymentChain/>` renders the four arms — one commit row when converged, the chain with a carrier chip on each carrier's own commit when behind, and the raw pins plus the reason when there is no line to draw. Also eagerly registers the boot-critical build.deployment resource descriptor so boot-snapshot can hydrate it before first paint.",
  contributions: [],
} satisfies PluginDefinition;
