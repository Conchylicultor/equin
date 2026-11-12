import { sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { deploymentIdKind } from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import { setSecret } from "@plugins/infra/plugins/secrets/server";
import { _deployDeployments } from "@plugins/apps/plugins/deploy/plugins/deployments/server";
import { DEPLOY_SECRETS_NAMESPACE, loadSecretPlan } from "./state";
import { _deploySecretGrants } from "./tables";
import { deploySecretsStatusServed } from "./served";

/**
 * The one write of a deploy secret's value — Set value, Use this computer's
 * value and a demo seed all land here. Every deployment's rows recompute (a
 * grant of the old value now names another one): a value's `notify()` with no
 * params reaches only the `{}` tuple, and the store has no change feed — so
 * every deployment's tuple is told by name (one row per install: bounded by
 * the servers you deploy to).
 */
export async function storeSecretValue(
  key: string,
  value: string,
): Promise<void> {
  await setSecret({ namespace: DEPLOY_SECRETS_NAMESPACE, key }, value);
  const deployments = await db
    .select({ id: _deployDeployments.id })
    .from(_deployDeployments);
  for (const d of deployments) {
    deploySecretsStatusServed.notify({ deploymentId: d.id });
  }
}

/** Record `fingerprint` as the value `deploymentId` approved for `key`. */
export async function grantSecret(
  deploymentId: string,
  key: string,
  fingerprint: string,
): Promise<void> {
  await db
    .insert(_deploySecretGrants)
    .values({
      deploymentId: deploymentIdKind.key(deploymentId),
      key,
      valueFingerprint: fingerprint,
      approvedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [_deploySecretGrants.deploymentId, _deploySecretGrants.key],
      set: { valueFingerprint: fingerprint, approvedAt: sql`now()` },
    });
}

/**
 * Set a deploy secret's value and approve it for one deployment, as the Secrets
 * section's Set value then Approve do. For a demo's seed. Throws when the
 * deployment's composition does not need `key`.
 */
export async function setAndApproveDeploySecret(
  deploymentId: string,
  key: string,
  value: string,
): Promise<void> {
  await storeSecretValue(key, value);
  const plan = await loadSecretPlan(deploymentId, { withLocal: false });
  const row = plan.rows.find((r) => r.key === key);
  if (!row) {
    throw new Error(
      `[deploy-secrets] deployment ${deploymentId}'s composition does not need ${key} (needs: ${plan.rows.map((r) => r.key).join(", ") || "nothing"})`,
    );
  }
  if (row.fingerprint === null) {
    throw new Error(
      `[deploy-secrets] ${key} has no value right after it was set`,
    );
  }
  await grantSecret(deploymentId, key, row.fingerprint);
  deploySecretsStatusServed.notify({ deploymentId });
}
