import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { deploySecretsVisibilityEndpoint } from "../core";
import { handleDeploySecretsVisibility } from "./internal/visibility-route";

export {
  DeploySecretSource,
  readDeploySecret,
  type DeploySecretSourceImpl,
  type DeploySecretValue,
} from "./internal/read";
export {
  DeploySecrets,
  type DeploySecretLocalValue,
} from "./internal/local-value";

export default {
  description:
    "readDeploySecret(decl) reads an approved deploy secret on the box, as a set/unset state, through the DeploySecretSource host service (the machine half reads the credential systemd decrypted into the service's credentials directory). The host-only GET /api/host-only/deploy-secrets answers set/unset per named key (never a value) — what ship's health gate asks of the running app. Owns DeploySecrets.LocalValue: a plugin names where a deploy secret's counterpart lives on the computer (read + watch, masked or plain preview, an optional caution), which the Secrets section offers as \"Use this computer's value\".",
  httpRoutes: {
    [deploySecretsVisibilityEndpoint.route]: handleDeploySecretsVisibility,
  },
} satisfies ServerPluginDefinition;
