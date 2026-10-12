export { checkCollectedDir } from "./collected-dir";
export { runChecks, listAllChecks, scopeOf, requestedJobs } from "./runner";
export type { RunChecksOptions } from "./runner";
export { repoProgram, tsBuildInfoPath } from "./discover";
export type { TscProgram } from "./discover";
export { materializeWarmBase, publishWarmBase } from "./warm-base";
export type { WarmBaseOutcome, WarmBasePublish } from "./warm-base";
export { realGitFacts } from "./warm-base-git";
export type { WarmBaseGitFacts, GitFactResult } from "./warm-base-git";
export { readProgramFileList } from "./buildinfo";
export type { ProgramFileList } from "./buildinfo";
export { hashFileBytes, hashFileCached } from "./content-hash";
export type { ContentHashMemo } from "./content-hash";
export { listRepoFiles } from "./repo-files";
export { computeTreeHash } from "./tree-hash";
export { readTranscriptVerdict } from "./transcript";
export { openCheckCache } from "./cache";
export type { CheckCache } from "./cache";
export { readCheckProgress } from "./progress-log";
export type {
  CheckRunProgress,
  OutstandingCheck,
  ProgressRecord,
} from "./progress-log";
export { fingerprint, computeCheckSourceHash } from "./read-set";
export type {
  TreeSnapshot,
  FileSystemView,
  FileFact,
  DirFact,
  GlobFact,
  QueryFact,
  ValidateResult,
  ValidateOptions,
} from "./read-set";
export { currentScanView } from "./scan-context";
export {
  grepCode,
  grepImports,
  listCandidateSources,
  gitGrepList,
} from "./grep-code";
export {
  isBuildInProgress,
  isBuildProcess,
  markBuildInProgress,
} from "./run-context";
export type {
  CodeMatch,
  ImportMatch,
  CandidateSource,
  ListCandidateSourcesOptions,
} from "./grep-code";
// NOTE: token-group-vars.generated.ts is intentionally NOT re-exported. Checks
// must read token-group vars FRESH via codegen core's collectTokenGroupVars() —
// a static import of the generated manifest is frozen in the ESM module cache
// before codegen rewrites the file in the same build, which made token-var
// renames pass only on the second build. The committed file remains a
// reviewable, token-group-vars-in-sync-guarded snapshot.
