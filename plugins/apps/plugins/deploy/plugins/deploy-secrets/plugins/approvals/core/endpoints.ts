import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { DeploySecretValueSchema } from "./schemas";

/**
 * Enter (or replace) a deploy secret's value in the local secrets store.
 *
 * One value per key, shared by every deployment that needs it — so replacing
 * it turns every grant of the old value into `changed`, and each deployment
 * has to approve the new one before it reaches that box.
 */
export const setDeploySecretValue = defineEndpoint({
  route: "PUT /api/deploy-secrets/values/:key",
  body: z.object({ value: DeploySecretValueSchema }),
});

/**
 * Approve the current value of `key` for one deployment. `fingerprint` is the
 * one the user was shown: a value replaced since is a 409, never approved
 * blind. One key per call — there is deliberately no approve-all.
 */
export const approveDeploySecret = defineEndpoint({
  route: "POST /api/deploy-secrets/deployments/:deploymentId/approve",
  body: z.object({ key: z.string(), fingerprint: z.string() }),
});

/**
 * The approved env for one deployment, for converge to deliver over SSH
 * stdin. The ONE response carrying secret values, so its handler refuses any
 * request a browser made: only the CLI on this machine reads it.
 */
export const deliverDeploySecrets = defineEndpoint({
  route: "POST /api/deploy-secrets/deployments/:deploymentId/env",
  response: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("ready"),
      env: z.array(z.object({ key: z.string(), value: z.string() })),
    }),
    z.object({ kind: z.literal("needs-approval"), message: z.string() }),
  ]),
  internal: {
    why: "called by the deploy CLI on this machine; the handler refuses any request a browser made",
  },
});
