import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  adoptLocalDeploySecretValue,
  approveDeploySecret,
  deliverDeploySecrets,
  setDeploySecretValue,
} from "../core/endpoints";
import { deploySecretsGate } from "./internal/gate";
import {
  handleAdoptLocalValue,
  handleApprove,
  handleDeliver,
  handleSetValue,
} from "./internal/handlers";
import { deploySecretsStatusServed } from "./internal/served";

// A demo's seed approves a deployment's secrets through this.
export { setAndApproveDeploySecret } from "./internal/approve";

export default {
  description:
    "Deploy-secret approvals on the local machine: values in the secrets store (namespace deploy-secrets), per-deployment grants of a value's HMAC fingerprint (deploy_secret_grants), the deploy gate that ends a run needs-approval while any secret its composition's closure declares is missing, new or changed, the deploy-secrets.status live value behind the Secrets section (each row with this computer's counterpart, from DeploySecrets.LocalValue, previewed — masked for a credential — never its value), the Use-this-computer's-value endpoint that stores it through the same write as Set value, and the browser-refusing endpoint converge reads the approved env from.",
  httpRoutes: {
    [setDeploySecretValue.route]: handleSetValue,
    [adoptLocalDeploySecretValue.route]: handleAdoptLocalValue,
    [approveDeploySecret.route]: handleApprove,
    [deliverDeploySecrets.route]: handleDeliver,
  },
  contributions: [deploySecretsGate, ...deploySecretsStatusServed.declare],
} satisfies ServerPluginDefinition;
