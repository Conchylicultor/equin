import { nullable, type FieldOptionMeta } from "@plugins/fields/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { liveArm } from "@plugins/network/plugins/live/core";
import type { ReleaseRun } from "@plugins/release/core";
import { runs } from "@plugins/runs/core";

/**
 * This arm's name, in one place: the kind string is the server's discriminator,
 * the list row's dispatch key, the field extension's id, and the `kind` half of
 * the `{ kind, id }` pair a surface builds to highlight a selected row. A rename
 * with literals in each spot breaks the highlight silently.
 *
 * It is this arm's kind (`liveArm`), so every wire name
 * (`release.<field>`) and every row key (`release:<id>`) is prefixed by it.
 *
 * Unlike the build arm's twin — which had to move down into
 * `run-ledger/core` — this one stays in the arm, and the asymmetry is a
 * decision. That constant closed a cycle: `build/web` needed it AND this arm
 * needs `build/web` for a detail pane. Nothing in `release/{core,server}` can
 * import this arm (the release run-detail pane lives in Studio, and this arm
 * contributes no `open`), so there is no edge back and no cycle to break. If a
 * release-OWNED surface ever needs the string, move it to `release/core` and
 * import it from there — do not re-export it from here, which is banned.
 */
export const RELEASE_RUN_KIND = "release";

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
