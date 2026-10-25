import { wholeList } from "@plugins/packages/plugins/list-bound/core";
import { liveValue } from "@plugins/network/plugins/live/core";
import { DeploySecretRowSchema } from "./schemas";

/**
 * Every secret one deployment's composition closure needs, with where each
 * stands — the Secrets section's rows. Recomputed when a grant is written (the
 * table is a declared read), when a value is set (notified), and when the
 * plugin tree changes (a declaration added or removed).
 */
export const deploySecretsStatus = liveValue("deploy-secrets.status", {
  schema: wholeList(DeploySecretRowSchema, {
    reason:
      "one row per deploy secret the deployment's composition closure declares — a handful",
  }),
  params: ["deploymentId"],
});
