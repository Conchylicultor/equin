import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  newReleaseRunId,
  releaseOutDir,
  compositionReleaseDir,
} from "./internal/out-dir";
export {
  bundleRoot,
  latestPointerName,
  latestPointerPath,
  isPointerName,
} from "./internal/pointer";
export { claimLatestPointer } from "./internal/claim-pointer";
export { bundleSignature, resolveBundle } from "./internal/resolve-bundle";
export {
  readGitProvenance,
  readHeadSha,
  compareToHead,
  readCommitSubject,
  readRefSha,
  countCommitsBehind,
} from "./internal/provenance";
export type { CommitLookup, GitProvenance } from "./internal/provenance";
export { pruneReleaseRunDirs } from "./internal/prune";
export type { PruneResult } from "./internal/prune";

export default {
  description:
    "The on-disk release-bundle registry: run-dir layout, the `latest-<platform>` pointer, resolveBundle()'s discriminated verdict, git provenance + staleness, and run-dir retention. Strictly DB-free so a CLI process can import it.",
} satisfies ServerPluginDefinition;
