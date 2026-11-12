import { isBrowserRequest } from "@plugins/framework/plugins/principal/core";
import { HttpError, implement } from "@plugins/infra/plugins/endpoints/server";
import { DEPLOY_SECRET_KEY_PATTERN } from "@plugins/apps/plugins/deploy/plugins/deploy-secrets/core";
import {
  adoptLocalDeploySecretValue,
  approveDeploySecret,
  deliverDeploySecrets,
  setDeploySecretValue,
} from "../../core/endpoints";
import { fingerprintKey } from "./fingerprint";
import { readLocalValue } from "./local";
import { approvalMessage, pendingSecrets } from "./plan";
import { grantSecret, storeSecretValue } from "./approve";
import { loadSecretPlan } from "./state";

function assertSecretKey(key: string): void {
  if (!DEPLOY_SECRET_KEY_PATTERN.test(key)) {
    throw new HttpError(
      400,
      `"${key}" is not a deploy secret key (${DEPLOY_SECRET_KEY_PATTERN}).`,
    );
  }
}

/** Store a value typed or pasted in the Set value dialog. */
export const handleSetValue = implement(
  setDeploySecretValue,
  async ({ params, body }) => {
    assertSecretKey(params.key);
    await storeSecretValue(params.key, body.value);
  },
);

/**
 * Store this computer's counterpart as the value: read here, never from the
 * request (the browser only ever saw its preview), and only when it is still
 * the value whose fingerprint the row showed — a local value changed since is
 * a 409, never stored blind. Approving it stays a separate click.
 */
export const handleAdoptLocalValue = implement(
  adoptLocalDeploySecretValue,
  async ({ params, body }) => {
    assertSecretKey(params.key);
    const local = await readLocalValue(await fingerprintKey(), params.key);
    if (local === undefined) {
      throw new HttpError(
        409,
        `This computer has no value for ${params.key} any more.`,
      );
    }
    if (local.reading.kind === "unusable") {
      throw new HttpError(409, local.reading.reason);
    }
    if (local.reading.fingerprint !== body.fingerprint) {
      throw new HttpError(
        409,
        `This computer's value of ${params.key} changed since it was shown. Review it and try again.`,
      );
    }
    await storeSecretValue(params.key, local.value);
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
    const plan = await loadSecretPlan(params.deploymentId, {
      withLocal: false,
    });
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
    await grantSecret(params.deploymentId, body.key, row.fingerprint);
  },
);

/**
 * The approved env for converge: every required key's current value (an
 * optional one only when it has a value), provided EVERY one is approved — otherwise the same `needs-approval` the gate gives.
 * Re-checked here rather than trusted from the run's gate, because a value can
 * be replaced between the gate and the converge leg (and converge can be run
 * by hand): what is delivered is always exactly what was approved.
 */
export const handleDeliver = implement(
  deliverDeploySecrets,
  async ({ params, req }) => {
    // The approved env is the one response carrying secret values, and no
    // page — this app's own included — has any business reading it: refused
    // to any browser, owner or not (`callEndpoint` from the CLI sends no
    // browser headers). Narrower than the principal gate, which lets the
    // owner's own page in.
    if (isBrowserRequest(req)) {
      throw new HttpError(
        403,
        "The approved deploy env is read only by `./equin deploy converge`, never by a browser.",
      );
    }
    const plan = await loadSecretPlan(params.deploymentId, {
      withLocal: false,
    });
    const pending = pendingSecrets(plan.rows);
    if (pending.length > 0) {
      return { kind: "needs-approval", message: approvalMessage(pending) };
    }
    return {
      kind: "ready",
      // An optional secret with no value ships nothing: the box reads it
      // `unset`, and converge removes a credential delivered before.
      env: plan.rows
        .filter((r) => r.status !== "not-set")
        .map((r) => {
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
