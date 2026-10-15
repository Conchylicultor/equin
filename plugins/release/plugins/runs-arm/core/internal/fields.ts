import { nullable, type FieldOptionMeta } from "@plugins/fields/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { liveArm } from "@plugins/network/plugins/live/core";
import { RELEASE_RUN_KIND, type ReleaseRun } from "@plugins/release/core";
import { runs } from "@plugins/runs/core";

/**
 * The two ways a release run is cut, and how each reads.
 *
 * A `Record<ReleaseRun["kind"], …>` rather than a hand-written value list, so
 * a third kind is a `tsc` error here rather than a value that filters to
 * nothing because the dropdown never offered it.
 */
const RELEASE_KIND_OPTIONS = {
  staged: {
    label: "Staged",
    hint: "A --dev run: previewable, claiming no latest-<platform> pointer.",
  },
  candidate: {
    label: "Candidate",
    hint: "Packed and built for a named platform — a bundle `ship` can pick.",
  },
} as const satisfies Record<ReleaseRun["kind"], FieldOptionMeta>;

const RELEASE_KINDS = Object.keys(RELEASE_KIND_OPTIONS) as [
  ReleaseRun["kind"],
  ...ReleaseRun["kind"][],
];

/**
 * The fields only a release row has — its slice of the `runs` union
 * (`$columns.release`), ids and wire names `release.<field>`, listed under
 * the "Release" band of every list of the union.
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
  fields: {
    kind: enumTextField(RELEASE_KINDS, {
      label: "Release kind",
      options: RELEASE_KIND_OPTIONS,
    }),
    composition: textField({ label: "Composition" }),
    target: textField({ label: "Target" }),
    platform: nullable(textField({ label: "Platform" })),
    commitSha: nullable(textField({ label: "Commit" })),
    commitDirty: nullable(boolField({ label: "Dirty tree" })),
    artifactPath: nullable(textField({ label: "Artifact" })),
  },
  sortable: ["kind", "composition", "target", "platform"],
});
