// `core/` here means RUNTIME-NEUTRAL NODE, not web-safe: this barrel reaches
// `node:fs` / `node:path`. Never import this from `web/`.
//
// It carries two unrelated contracts, both of which need a home outside `bin/`
// because a second plugin has to read them:
//
//   1. The generated-artifact normalize contract, so the CLI that PERFORMS it
//      (`bin/git/normalize-generated`, `push`, `build`) and the check that
//      ASSERTS it (`tooling/plugins/checks/plugins/generated-artifacts-normalized`)
//      read the same marker names, git-dir resolution and conflict scan instead
//      of each hand-rolling them.
//
//   2. The CLI command declaration (`defineCliCommand` and friends), which every
//      contributing plugin's `cli/index.ts` imports. Node builtins only, and
//      NOTHING here may grow an npm import: a declaration loads on every single
//      `./singularity` invocation, and `cli:command-declarations-light` measures
//      that closure.

export { resolveGitDir } from "./internal/git-dir";
export {
  MERGE_MARKER_KINDS,
  mergeMarkerDir,
  readMergeMarkers,
  clearMergeMarkers,
} from "./internal/merge-markers";
export type { MergeMarkerKind } from "./internal/merge-markers";
export { findClaudeMdConflicts } from "./internal/claudemd-conflicts";
export type { ClaudeMdRepo } from "./internal/claudemd-conflicts";

export { defineCliCommand, isCliCommand } from "./internal/command";
export {
  cliEntrySourcePath,
  isCliEntryPresent,
} from "./internal/registry-entry";
export type {
  CliAction,
  CliArgumentSpec,
  CliCommand,
  CliCommandSpec,
  CliOptionSpec,
} from "./internal/command";

export { CLI_NAME, CLI_NAMES, isCliName } from "./internal/cli-name";
