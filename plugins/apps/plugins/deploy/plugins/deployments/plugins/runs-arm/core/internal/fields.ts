import { liveArm } from "@plugins/network/plugins/live/core";
import { deployRunsEntityRef } from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import { runs } from "@plugins/runs/core";
import { DEPLOY_RUN_KIND } from "./kind";

/**
 * The fields only a deploy run has — its slice of the `runs` union
 * (`$columns.deploy`), ids and wire names `deploy.<field>`, listed under the
 * "Deploy" band of every list of the union.
 *
 * Declared FROM the deploy-run entity (`deployRunsEntityRef`): every field is
 * a stored one, picked by name with the entity's labels and options (the verb
 * and phase sets come from the deployments plugin's own declaration, so a
 * fourth verb added there appears here for free), and every field a plugin
 * exposes on a deploy run is listed in this band with no code here.
 *
 * `verb` is also projected as the base `trigger`, deliberately: the verb is the
 * closest thing a deploy has to "how did this start", and `trigger` is the
 * column a person filters across kinds by. Keeping it here too lets the same
 * fact be filtered *precisely* — a closed three-value set with chips.
 *
 * The four ids (`serverId`, `deploymentId`, `compositionId`, `releaseRunId`) are
 * dimensions: "every run that touched this box" or "everything that shipped
 * this release" is a query rather than a scroll.
 */
export const deployRunArm = liveArm(runs, DEPLOY_RUN_KIND, {
  label: "Deploy",
  // After release: `deploy.releaseRunId` points INTO the release arm, so a
  // reader following it scans forward (`runs` core, "Arm order").
  order: 30,
  from: deployRunsEntityRef,
  pick: [
    "verb",
    "phaseFailed",
    "compositionId",
    "serverId",
    "deploymentId",
    "commitSha",
    "releaseRunId",
    "exitCode",
  ],
  sortable: [
    "verb",
    "phaseFailed",
    "serverId",
    "deploymentId",
    "compositionId",
    "commitSha",
    "releaseRunId",
    "exitCode",
  ],
});
