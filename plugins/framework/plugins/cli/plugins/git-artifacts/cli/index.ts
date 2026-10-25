/**
 * The two halves of the generated-artifact merge contract that RUN as part of a
 * CLI command: re-deriving generated files after a merge driver took the cheap
 * side (`normalize-generated`), and installing the drivers themselves
 * (`register-merge-drivers`).
 *
 * Its own plugin because three commands need it — `push` (around its rebase),
 * `build` (which reaches the same state by regenerating everything) and the
 * `normalize-generated` command the `post-rewrite` hook invokes.
 *
 * The marker names, git-dir resolution and conflict scan deliberately stay in
 * `@plugins/framework/plugins/cli/core`: the OTHER side of that contract is a
 * check (`tooling/…/generated-artifacts-normalized`), which must read the same
 * facts, and a check may not import a `cli/` barrel.
 */

export { normalizeGeneratedArtifacts } from "./normalize-generated";

export { registerMergeDrivers } from "./register-merge-drivers";
