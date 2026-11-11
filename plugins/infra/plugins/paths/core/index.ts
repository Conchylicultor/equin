export {
  repoConfigDir,
  PLUGINS_DIR,
  SERVER_CORE_RELATIVE,
  backendEntryFor,
  HOME_DIR,
  backupsDir,
  backupsDirs,
  dataRootLayout,
  declareDataRootLayoutSync,
  worktreesDir,
  worktreeDataDir,
  worktreeArtifacts,
  RUN_TERMINAL_SUFFIX,
  WORKTREE_SPEC_FILE,
  CLAUDE_DIR,
  CLAUDE_PROJECTS_DIR,
  CLAUDE_USER_CONFIG,
  CLAUDE_SESSIONS_DIR,
  claudeProjectDirName,
  claudeTranscriptPath,
  isRelease,
  isHostSingleton,
  releaseIdentity,
  setReleaseIdentity,
  checkoutWorktreeName,
} from "./internal/paths";
export type { ReleaseIdentity } from "./internal/paths";
// A served namespace's graph records (which web graphs its tabs may still run).
export {
  webGraphRecordPath,
  webGraphRecordsDir,
} from "./internal/graph-records";
// Where the root is when the environment does not say — decided by what is
// installed (`~/.equin`, or the legacy dir until `./equin data-dir migrate`
// moves it). `dataRootLayout()` (above) is this process's answer, declared at
// its tree's root by `declareDataRootLayoutSync()`; the migration
// reads the disk afresh, since it is the one thing that changes it.
export {
  DATA_DIR_NAME,
  DataRootSplitError,
  homeDataRoots,
  readHomeDataRootLayoutSync,
} from "./internal/data-root-layout";
export type { DataRootLayout } from "./internal/data-root-layout";
// The toolchain a process belongs to: its own checkout's locked mise tools,
// whatever cwd a shim runs in. Applied by each backend and central at boot.
export { toolchainPin } from "./internal/toolchain-pin";

// The registry's own directory listing, and the two questions a CHECKOUT asks
// of it. All three sit in `core` rather than `server` because their readers are
// not backends: the CLI mints a checkout's namespace, and an e2e script — which
// may import no `server` barrel at all — resolves the deploy it is about to
// drive. The `server` barrel re-exports `listWorktreeDirsSync` and `checkoutRef`, so
// their existing server-side callers are unchanged.
export {
  listWorktreeDirsSync,
  listWorktreeDirsAsync,
} from "./internal/worktree-dirs";
export {
  actAsCheckoutNamespace,
  checkoutRef,
  checkoutNamespace,
} from "./internal/checkout-ref";
// Who acts as a namespace: stamped by the CLI, read by the reaper.
export {
  readCheckoutOwner,
  readCheckoutOwnerSync,
} from "./internal/checkout-owner";
export type { CheckoutOwnerRead } from "./internal/checkout-owner";
// Which backend minted an agent checkout: stamped by worktree.prepare, read by the reaper.
export {
  readCheckoutMinter,
  readCheckoutMinterSync,
  stampCheckoutMinter,
  stampCheckoutMinterSync,
} from "./internal/checkout-minter";
export type { CheckoutMinterRead } from "./internal/checkout-minter";
export {
  deploysForCheckoutSync,
  lookupCheckoutDeploy,
  lookupCheckoutDeploySync,
  resolveCheckoutDeploySync,
} from "./internal/checkout-deploys";
export type {
  CheckoutDeploy,
  CheckoutDeployResolution,
} from "./internal/checkout-deploys";

// The declared-directory registry for the data root. `dataRoot()` is the ONLY
// way to name the root and `defineDataDir` the only way to name anything under
// it — the plain `EQUIN_DIR` string that used to sit above is gone, and
// `paths:data-root-not-joined` fails on both ways back to it (joining the root,
// or re-reading its environment variable).
//
// An app's ONE directory, `apps/<app>/`, comes from `defineAppDataDir` at the
// app's root plugin instead — `defineDataDir` refuses the `apps` kind — and a
// sub-plugin's space inside it is a `subdir()` area, never a second dir.
export {
  DATA_DIR_KINDS,
  dataRoot,
  defineAppDataDir,
  defineDataDir,
  getDataDirs,
  relativeToDataRoot,
} from "./internal/data-dir";
// A directory's declared moves (`movedFrom`) are settled once per process tree,
// at its entry point, before anything reads a path: a backend's boot performs a
// pending one (main only), every other entry inspects. The getters then read
// the declaration, never the disk.
export { settleDeclaredDataDirMoves } from "./internal/settle-declared-moves";
export type {
  AppIdentity,
  DataDir,
  DataDirArea,
  DataDirInput,
  DataDirKind,
  DataDirRef,
  DataDirSpec,
  MovedFrom,
  ReclaimPolicy,
} from "./internal/data-dir";

// Log claims: which log files a data dir holds and what bounds each, read by
// `paths:logs-claimed` and published in each namespace's data-dirs manifest.
export {
  LOG_FILE_RE,
  logPatternMatches,
  publishedLogClaim,
} from "./internal/log-claims";
export type { LogBound, LogClaim } from "./internal/log-claims";

// The one legacy table: where each declared directory USED to sit, and what has
// to happen to it. Two consumers read it — `paths:no-undeclared-data-dirs`
// (which derives its grandfathering from the `from` names, so the check's to-do
// list and the migration's plan are the same fact) and the one-off
// `scripts/migrate-data-layout.ts` (which executes it). Self-liquidating: table,
// planner and the check's symlink-verified grandfathering are deleted together
// once the drop-legacy pass has run everywhere.
export { LEGACY_LAYOUT, planMigration } from "./internal/legacy-layout";
export type { LegacyMove, MigrationStep } from "./internal/legacy-layout";

// The check transcript is written by the check runner, which is a `core`-runtime
// module — so its prune has to be reachable from `core`. The build prune stays a
// `server`-only export because every one of its writers is server-side; exporting
// it here too would only widen the surface for no caller.
//
// The test-run record is written by `cli/test`'s `core` too (`writeTestStatus`),
// so its prune sits here for the same reason.
export {
  pruneWorktreeCheckArtifactsSync,
  pruneWorktreeTestArtifactsSync,
  CHECK_ARTIFACTS_RETENTION,
} from "./internal/prune-artifacts";
