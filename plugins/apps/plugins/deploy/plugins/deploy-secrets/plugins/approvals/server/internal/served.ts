import { serveValue } from "@plugins/network/plugins/live/server";
import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { deploymentIdKind } from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import { deploySecretsStatus } from "../../core/resources";
import { _deployDeployments } from "@plugins/apps/plugins/deploy/plugins/deployments/server";
import { watchLocalValues } from "./local";
import { watchRequiredDeploySecrets } from "./required";
import { loadSecretPlan } from "./state";
import { _deploySecretGrants } from "./tables";

/**
 * One deployment's Secrets rows. External, because its truth is three places
 * and only one of them is Postgres:
 *
 * - the grants table — a declared read, so an Approve recomputes it (and the
 *   deployments table, the composition the closure is read from);
 * - the local secrets store — no change feed, so Set value `notify()`s;
 * - the plugin tree (which secrets the closure declares) — the composition's
 *   required set, re-derived on each faceted-tree change while a tab holds
 *   the value, heard only when that set moved (`watchRequiredDeploySecrets`:
 *   the tree changes on nearly every push, the set almost never);
 * - this computer's counterparts (`DeploySecrets.LocalValue`) — each
 *   source's own watch, while a tab holds the value.
 *
 * Rows carry fingerprints, never values.
 */
export const deploySecretsStatusServed = serveValue(deploySecretsStatus, {
  source: "external",
  changes: "notified",
  reads: {
    tables: [_deploySecretGrants, _deployDeployments],
    reason:
      "a grant written or replaced moves a row to approved; the deployment's composition decides which secrets its closure declares",
  },
  loader: async ({ deploymentId }) =>
    (await loadSecretPlan(deploymentId, { withLocal: true })).rows,
  whileSubscribed: async ({ deploymentId }, notify) => {
    // The composition whose closure is watched. A deployment moved to another
    // composition is a write to the deployments table (a declared read): its
    // rows recompute at once, and read the new set unwatched.
    const [deployment] = await db
      .select({ compositionId: _deployDeployments.compositionId })
      .from(_deployDeployments)
      .where(eq(_deployDeployments.id, deploymentIdKind.key(deploymentId)));
    const stopLocal = await watchLocalValues(notify);
    // No such deployment: the loader refuses it (404); nothing to watch.
    let stopTree: () => void = () => undefined;
    try {
      if (deployment)
        stopTree = await watchRequiredDeploySecrets(
          deployment.compositionId,
          notify,
        );
    } catch (err) {
      stopLocal();
      throw err;
    }
    return () => {
      stopTree();
      stopLocal();
    };
  },
});
