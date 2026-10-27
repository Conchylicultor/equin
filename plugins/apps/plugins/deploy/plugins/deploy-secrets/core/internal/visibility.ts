import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import type { HOST_ONLY_PREFIX } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/host-only/core";
import { cappedRecord } from "@plugins/packages/plugins/list-bound/core";
import { DEPLOY_SECRET_KEY_PATTERN } from "./declare";

/** The most secrets one visibility ask may name — far above any closure's. */
export const MAX_VISIBILITY_KEYS = 32;

/** One or more secret keys, comma-separated — shell-safe in a curl URL as is. */
const KeyListSchema = z
  .string()
  .refine((s) => s.split(",").every((k) => DEPLOY_SECRET_KEY_PATTERN.test(k)), {
    message: "keys must be comma-separated deploy secret keys",
  })
  .transform((s) => s.split(","));

export const DeploySecretVisibilitySchema = z.enum(["set", "unset"]);

/**
 * Which of the named deploy secrets the RUNNING app can read — `set` / `unset`
 * per key, never a value. Answered only on the box (`hostOnly`, refused by
 * Caddy publicly); ship's health gate asks it for every credential converge
 * installed, so a secret that is approved and delivered but unreadable by the
 * app fails the ship instead of the feature that needs it, silently, later.
 */
export const deploySecretsVisibilityEndpoint = defineEndpoint({
  route:
    "GET /api/host-only/deploy-secrets" satisfies `GET ${typeof HOST_ONLY_PREFIX}${string}`,
  query: z.object({ keys: KeyListSchema }),
  response: z.object({
    secrets: cappedRecord(DeploySecretVisibilitySchema, {
      max: MAX_VISIBILITY_KEYS,
    }),
  }),
});
