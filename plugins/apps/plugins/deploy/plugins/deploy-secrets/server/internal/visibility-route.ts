import { implement } from "@plugins/infra/plugins/endpoints/server";
import { hostOnly } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/host-only/server";
import { deploySecretsVisibilityEndpoint } from "../../core";
import { readDeploySecretKey } from "./read";

/**
 * `set` / `unset` for each named key, read through the SAME path a consumer
 * reads (the `DeploySecretSource` host service), so a `set` here is the proof
 * ship's gate wants: the running app can read it. Never a value.
 */
export const handleDeploySecretsVisibility = hostOnly(
  implement(deploySecretsVisibilityEndpoint, async ({ query }) => ({
    secrets: Object.fromEntries(
      await Promise.all(
        query.keys.map(
          async (key) => [key, (await readDeploySecretKey(key)).kind] as const,
        ),
      ),
    ),
  })),
);
