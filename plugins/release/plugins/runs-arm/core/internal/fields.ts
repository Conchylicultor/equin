import { liveArm } from "@plugins/network/plugins/live/core";
import { RELEASE_RUN_KIND, releaseRunsEntityRef } from "@plugins/release/core";
import { runs } from "@plugins/runs/core";

/**
 * The fields only a release row has — its slice of the `runs` union
 * (`$columns.release`), ids and wire names `release.<field>`, listed under
 * the "Release" band of every list of the union.
 *
 * Declared FROM the release-run entity (`releaseRunsEntityRef`): every field
 * is a stored one, picked by name with the entity's labels and options, and
 * every field a plugin exposes on a release run is listed in this band with
 * no code here.
 *
 * **`kind` is why the ids are prefixed.** `release_runs` has a `kind`
 * column of its own — `staged` (a `--dev` run, previewable only) vs
 * `candidate` (packed for a named platform, shippable) — meaning something
 * entirely different from the run *kind* the whole union is discriminated on.
 * As `release.kind` the two sit side by side in one filter bar.
 *
 * `composition` and `target` are fields even though `label` already joins
 * them: a label is text a person reads, and these are dimensions a person
 * filters and groups by.
 */
export const releaseRunArm = liveArm(runs, RELEASE_RUN_KIND, {
  label: "Release",
  // After build: the shipping pair, in pipeline order (`runs` core, "Arm order").
  order: 20,
  from: releaseRunsEntityRef,
  pick: [
    "kind",
    "composition",
    "target",
    "platform",
    "commitSha",
    "commitDirty",
    "artifactPath",
  ],
  sortable: ["kind", "composition", "target", "platform"],
});
