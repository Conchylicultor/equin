import { sql } from "drizzle-orm";
import { _deployDeployments } from "@plugins/apps/plugins/deploy/plugins/deployments/server";
import { db } from "@plugins/database/server";
import { HttpError, implement } from "@plugins/infra/plugins/endpoints/server";
import { setSecret } from "@plugins/infra/plugins/secrets/server";
import { DEPLOY_SECRET_KEY_PATTERN } from "@plugins/apps/plugins/deploy/plugins/deploy-secrets/core";
import { deploymentIdKind } from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import {
  approveDeploySecret,
  deliverDeploySecrets,
  setDeploySecretValue,
} from "../../core/endpoints";
import { approvalMessage, pendingSecrets } from "./plan";
import { deploySecretsStatusServed } from "./served";
import { DEPLOY_SECRETS_NAMESPACE, loadSecretPlan } from "./state";
import { _deploySecretGrants } from "./tables";

/** Store a value. Every deployment's rows recompute (a grant of the old value now names another one). */
export const handleSetValue = implement(
  setDeploySecretValue,
  async ({ params, body }) => {
    if (!DEPLOY_SECRET_KEY_PATTERN.test(params.key)) {
      throw new HttpError(
        400,
        `"${params.key}" is not a deploy secret key (${DEPLOY_SECRET_KEY_PATTERN}).`,
      );
    }
    await setSecret(
      { namespace: DEPLOY_SECRETS_NAMESPACE, key: params.key },
      body.value,
    );
    // A value's `notify()` with no params reaches only the `{}` tuple, and the
    // store has no change feed — so every deployment's tuple is told by name
    // (one row per install: bounded by the servers you deploy to).
    const deployments = await db
      .select({ id: _deployDeployments.id })
      .from(_deployDeployments);
    for (const d of deployments) {
      deploySecretsStatusServed.notify({ deploymentId: d.id });
    }
  },
);

/**
 * Approve exactly the value the user was shown, for one deployment.
 *
 * The fingerprint is re-derived from the store NOW and compared to the one the
 * row showed, so a value replaced in between is a 409 instead of a blind
 * approval of something nobody looked at.
 */
export const handleApprove = implement(
  approveDeploySecret,
  async ({ params, body }) => {
    const plan = await loadSecretPlan(params.deploymentId);
    const row = plan.rows.find((r) => r.key === body.key);
    if (!row) {
      throw new HttpError(
        404,
        `This deployment's composition does not need ${body.key}.`,
      );
    }
    if (row.fingerprint === null) {
      throw new HttpError(409, `${body.key} has no value yet — set it first.`);
    }
    if (row.fingerprint !== body.fingerprint) {
      throw new HttpError(
        409,
        `${body.key}'s value changed since it was shown. Review it and approve again.`,
      );
    }
    await db
      .insert(_deploySecretGrants)
      .values({
        deploymentId: deploymentIdKind.key(params.deploymentId),
        key: body.key,
        valueFingerprint: row.fingerprint,
        approvedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [_deploySecretGrants.deploymentId, _deploySecretGrants.key],
        set: { valueFingerprint: row.fingerprint, approvedAt: sql`now()` },
      });
  },
);

/**
 * True when the request came from a browser. Every browser sends a
 * `Sec-Fetch-Site` (and an `Origin` on a POST); `callEndpoint` from the CLI
 * sends neither. The approved env is the one response carrying secret values,
 * and no page — this app's or another — has any business reading it.
 */
function fromBrowser(req: Request): boolean {
  return (
    req.headers.has("sec-fetch-site") ||
    req.headers.has("sec-fetch-mode") ||
    req.headers.has("origin")
  );
}

/**
 * The approved env for converge: every required key's current value, provided
 * EVERY one is approved — otherwise the same `needs-approval` the gate gives.
 * Re-checked here rather than trusted from the run's gate, because a value can
 * be replaced between the gate and the converge leg (and converge can be run
 * by hand): what is delivered is always exactly what was approved.
 */
export const handleDeliver = implement(
  deliverDeploySecrets,
  async ({ params, req }) => {
    if (fromBrowser(req)) {
      throw new HttpError(
        403,
        "The approved deploy env is read only by `./equin deploy converge`, never by a browser.",
      );
    }
    const plan = await loadSecretPlan(params.deploymentId);
    const pending = pendingSecrets(plan.rows);
    if (pending.length > 0) {
      return { kind: "needs-approval", message: approvalMessage(pending) };
    }
    return {
      kind: "ready",
      env: plan.rows.map((r) => {
        const value = plan.values.get(r.key);
        if (value === undefined) {
          throw new Error(
            `[deploy-secrets] ${r.key} is approved but has no value in this plan — the diff and the values disagree.`,
          );
        }
        return { key: r.key, value };
      }),
    };
  },
);
