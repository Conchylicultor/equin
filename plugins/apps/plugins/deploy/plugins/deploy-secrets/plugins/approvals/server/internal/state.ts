import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import { getSecret } from "@plugins/infra/plugins/secrets/server";
import { _deployDeployments } from "@plugins/apps/plugins/deploy/plugins/deployments/server";
import { deploymentIdKind } from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import type { DeploySecretRow } from "../../core/schemas";
import { fingerprintKey, fingerprintSecret } from "./fingerprint";
import { diffSecrets } from "./plan";
import { requiredDeploySecrets } from "./required";
import { _deploySecretGrants } from "./tables";

/**
 * The local secrets-store namespace deploy secret values live in, keyed by the
 * env var (`RESEND_API_KEY`). One value per key, shared by every deployment.
 * Spelled once, here.
 */
export const DEPLOY_SECRETS_NAMESPACE = "deploy-secrets";

/** Read one secret's current local value, or `undefined` when none is set. */
export function readSecretValue(key: string): Promise<string | undefined> {
  return getSecret({ namespace: DEPLOY_SECRETS_NAMESPACE, key });
}

/** Everything the gate, the Secrets section and delivery decide from, read once. */
export interface SecretPlan {
  readonly rows: DeploySecretRow[];
  /**
   * The current value of every required key that has one. Server memory only:
   * handed to delivery, never to the live value or a log.
   */
  readonly values: ReadonlyMap<string, string>;
}

/**
 * Compute where every secret one deployment's closure needs stands: the
 * required set (closure declarations), each current local value's fingerprint,
 * and this deployment's grants — diffed by {@link diffSecrets}.
 *
 * A deployment that does not exist is a 404 (an endpoint asked about it); a
 * store or closure read that fails throws — never an empty plan, which would
 * read as "nothing to approve".
 */
export async function loadSecretPlan(
  deploymentId: string,
): Promise<SecretPlan> {
  const [deployment] = await db
    .select({ compositionId: _deployDeployments.compositionId })
    .from(_deployDeployments)
    .where(eq(_deployDeployments.id, deploymentIdKind.key(deploymentId)));
  if (!deployment) throw new HttpError(404, `No deployment ${deploymentId}.`);
  return planFor(deploymentId, deployment.compositionId);
}

/** {@link loadSecretPlan} for a deployment whose composition the caller already holds. */
export async function planFor(
  deploymentId: string,
  compositionId: string,
): Promise<SecretPlan> {
  const required = await requiredDeploySecrets(compositionId);
  const values = new Map<string, string>();
  const fingerprints = new Map<string, string>();
  if (required.length > 0) {
    const hmacKey = await fingerprintKey();
    for (const r of required) {
      const value = await readSecretValue(r.key);
      if (value === undefined || value === "") continue;
      values.set(r.key, value);
      fingerprints.set(r.key, await fingerprintSecret(hmacKey, r.key, value));
    }
  }
  const grantRows = await db
    .select({
      key: _deploySecretGrants.key,
      valueFingerprint: _deploySecretGrants.valueFingerprint,
    })
    .from(_deploySecretGrants)
    .where(
      eq(_deploySecretGrants.deploymentId, deploymentIdKind.key(deploymentId)),
    );
  const grants = new Map(grantRows.map((g) => [g.key, g.valueFingerprint]));
  return { rows: diffSecrets(required, fingerprints, grants), values };
}
