import { DeployGates } from "@plugins/apps/plugins/deploy/plugins/deployments/server";
import { approvalMessage, pendingSecrets } from "./plan";
import { planFor } from "./state";
import { SECRETS_SECTION_ID } from "../../core/schemas";

/**
 * The deploy gate: a run whose closure needs a secret that has no value, was
 * never approved for this deployment, or whose value changed since it was,
 * ends `needs-approval` before any leg spawns. Removing a secret needs no
 * approval — a key no longer required simply has no row.
 */
export const deploySecretsGate = DeployGates.Gate({
  id: "deploy-secrets",
  check: async ({ deploymentId, compositionId }) => {
    const pending = pendingSecrets(
      (await planFor(deploymentId, compositionId)).rows,
    );
    return pending.length === 0
      ? { kind: "pass" }
      : {
          kind: "needs-approval",
          message: approvalMessage(pending),
          resolveIn: SECRETS_SECTION_ID,
        };
  },
});
