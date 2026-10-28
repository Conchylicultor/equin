import { serveValue } from "@plugins/network/plugins/live/server";
import { onPluginTreeChanged } from "@plugins/plugin-meta/plugins/plugin-tree/server";
import { deploySecretsStatus } from "../../core/resources";
import { _deployDeployments } from "@plugins/apps/plugins/deploy/plugins/deployments/server";
import { loadSecretPlan } from "./state";
import { _deploySecretGrants } from "./tables";

/**
 * One deployment's Secrets rows. External, because its truth is three places
 * and only one of them is Postgres:
 *
 * - the grants table — a declared read, so an Approve recomputes it (and the
 *   deployments table, the composition the closure is read from);
 * - the local secrets store — no change feed, so Set value `notify()`s;
 * - the plugin tree (which secrets the closure declares) — the tree watcher,
 *   while a tab holds the value.
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
  loader: async ({ deploymentId }) => (await loadSecretPlan(deploymentId)).rows,
  whileSubscribed: (_params, notify) => onPluginTreeChanged(notify),
  throttleMs: 2_000,
});
