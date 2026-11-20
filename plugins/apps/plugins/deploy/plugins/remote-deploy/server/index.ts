import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { runningCommitServed } from "./internal/running-commit-resource";

export { readRunningCommit } from "./internal/running-commit-resource";

export default {
  description:
    "Serves deploy.running-commit: the commit a deployment's newest succeeded ship recorded, its subject, and how many commits the main ref holds that it does not — recomputed when a deploy run lands or main advances — and readRunningCommit(deploymentId), the same answer for a server-side reader.",
  contributions: [...runningCommitServed.declare],
} satisfies ServerPluginDefinition;
