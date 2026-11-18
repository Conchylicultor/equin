import { liveArm } from "@plugins/network/plugins/live/core";
import {
  githubRunFields,
  githubRunsEntityRef,
} from "@plugins/integrations/plugins/github-events/core";
import { runs } from "@plugins/runs/core";

/** The run kind of a watched GitHub workflow's run in the `runs` union. */
export const GITHUB_RUN_KIND = "github";

/**
 * The fields only a GitHub run has — its slice of the `runs` union
 * (`$columns.github`), ids and wire names `github.<field>`, listed under the
 * "GitHub" band of every list of the union.
 *
 * Its rows are the watched workflows' runs (`GitHubEvents.Watch`): the
 * release workflow that publishes a cut release (install.sh, the installer
 * binaries) and the embedded packages' daily Build and Publish — the
 * publication steps of shipping that happen on GitHub rather than on this
 * machine, so they are tracked in the same list as the builds and releases
 * that lead to them.
 *
 * Declared FROM the github-run entity: every listed field is a stored one,
 * picked by name with the entity's labels. `url` is carried (never listed):
 * a row opens its run on GitHub.
 */
export const githubRunArm = liveArm(runs, GITHUB_RUN_KIND, {
  label: "GitHub",
  // After release (20) and deploy (30): the publication a release ends in.
  order: 35,
  from: githubRunsEntityRef,
  pick: [
    "workflowName",
    "head",
    "repo",
    "headSha",
    "status",
    "conclusion",
    "attempt",
  ],
  carry: { url: githubRunFields.url },
  sortable: ["workflowName", "head", "repo"],
});
