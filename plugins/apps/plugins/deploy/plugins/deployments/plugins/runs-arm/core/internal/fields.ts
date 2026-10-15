import { nullable, type FieldOptionMeta } from "@plugins/fields/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { liveArm } from "@plugins/network/plugins/live/core";
import {
  DeployPhaseSchema,
  DeployVerbSchema,
} from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import { runs } from "@plugins/runs/core";
import { DEPLOY_RUN_KIND } from "./kind";

/** Each value of a closed set, reading as itself. */
function asOptions(values: readonly string[]): Record<string, FieldOptionMeta> {
  return Object.fromEntries(values.map((value) => [value, { label: value }]));
}

/**
 * The fields only a deploy run has — its slice of the `runs` union
 * (`$columns.deploy`), ids and wire names `deploy.<field>`, listed under the
 * "Deploy" band of every list of the union.
 *
 * `verb` is also projected as the base `trigger`, deliberately: the verb is the
 * closest thing a deploy has to "how did this start", and `trigger` is the
 * column a person filters across kinds by. Keeping it here too lets the same
 * fact be filtered *precisely* — a closed three-value set with chips.
 *
 * The verb and phase options come from the deployments plugin's own schemas,
 * not from the loaded rows: the window is server-paginated, so deriving them
 * would offer only the verbs that happen to be on screen — and a fourth verb
 * added there appears here for free. Their VALUES stay plain text: the ledger's
 * columns are, and the union binds each field to its column by type.
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
  fields: {
    /** `converge` / `ship` / `update` — what the run was asked to do. */
    verb: textField({
      label: "Verb",
      optionMeta: asOptions(DeployVerbSchema.options),
    }),
    /** Which leg of an `update` died. Null on a success, and on a single-verb run. */
    phaseFailed: nullable(
      textField({
        label: "Failed phase",
        optionMeta: asOptions(DeployPhaseSchema.options),
      }),
    ),
    compositionId: textField({ label: "Composition" }),
    /** The remote box. An opaque id — a dimension to filter by, not a name. */
    serverId: textField({ label: "Server" }),
    /** The (composition × server) install this run belongs to. */
    deploymentId: textField({ label: "Deployment" }),
    /** The commit the shipped bundle was built from. Null where genuinely unknown. */
    commitSha: nullable(textField({ label: "Commit" })),
    /** The `release_runs.id` this `ship` pinned. Null on a converge, or a bare ship. */
    releaseRunId: nullable(textField({ label: "Release run" })),
    /** The CLI's exit code. Null while running, and when it could not be spawned. */
    exitCode: nullable(intField({ label: "Exit code" })),
  },
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
