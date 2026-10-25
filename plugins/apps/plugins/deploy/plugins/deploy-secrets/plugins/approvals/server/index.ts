import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  approveDeploySecret,
  deliverDeploySecrets,
  setDeploySecretValue,
} from "../core/endpoints";
import { deploySecretsGate } from "./internal/gate";
import {
  handleApprove,
  handleDeliver,
  handleSetValue,
} from "./internal/handlers";
import { deploySecretsStatusServed } from "./internal/served";

export default {
  description:
    "Deploy-secret approvals on the local machine: values in the secrets store (namespace deploy-secrets), per-deployment grants of a value's HMAC fingerprint (deploy_secret_grants), the deploy gate that ends a run needs-approval while any secret its composition's closure declares is missing, new or changed, the deploy-secrets.status live value behind the Secrets section, and the browser-refusing endpoint converge reads the approved env from.",
  httpRoutes: {
    [setDeploySecretValue.route]: handleSetValue,
    [approveDeploySecret.route]: handleApprove,
    [deliverDeploySecrets.route]: handleDeliver,
  },
  contributions: [deploySecretsGate, ...deploySecretsStatusServed.declare],
} satisfies ServerPluginDefinition;
