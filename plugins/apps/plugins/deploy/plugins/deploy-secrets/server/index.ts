import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { readDeploySecret, type DeploySecretValue } from "./internal/read";

export default {
  description:
    "readDeploySecret(decl) reads an approved deploy secret from the box's environment, as a set/unset state.",
} satisfies ServerPluginDefinition;
