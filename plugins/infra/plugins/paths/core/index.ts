export {
  REPO_ROOT,
  repoConfigDir,
  PLUGINS_DIR,
  SERVER_CORE_RELATIVE,
  HOME_DIR,
  BACKUPS_DIR,
  worktreesDir,
  worktreeDataDir,
  worktreeArtifacts,
  WORKTREE_SPEC_FILE,
  CLAUDE_DIR,
  CLAUDE_PROJECTS_DIR,
  CLAUDE_USER_CONFIG,
  CLAUDE_SESSIONS_DIR,
  isRelease,
  isHostSingleton,
  releaseIdentity,
  setReleaseIdentity,
  checkoutWorktreeName,
} from "./internal/paths";
export type { ReleaseIdentity } from "./internal/paths";
// The toolchain a process belongs to: its own checkout's locked mise tools,
// whatever cwd a shim runs in. Applied by each backend and central at boot.
export { toolchainPin } from "./internal/toolchain-pin";

// The registry's own directory listing, and the two questions a CHECKOUT asks
// of it. All three sit in `core` rather than `server` because their readers are
// not backends: the CLI mints a checkout's namespace, and an e2e script — which
// may import no `server` barrel at all — resolves the deploy it is about to
// drive. The `server` barrel re-exports `listWorktreeDirs` and `checkoutRef`, so
// their existing server-side callers are unchanged.
export { listWorktreeDirs } from "./internal/worktree-dirs";
export {
  actAsCheckoutNamespace,
  checkoutRef,
  checkoutNamespace,
} from "./internal/checkout-ref";
// Who acts as a namespace: stamped by the CLI, read by the reaper.
export { readCheckoutOwner } from "./internal/checkout-owner";
export type { CheckoutOwnerRead } from "./internal/checkout-owner";
export {
  deploysForCheckout,
  resolveCheckoutDeploy,
} from "./internal/checkout-deploys";
export type {
  CheckoutDeploy,
  CheckoutDeployResolution,
} from "./internal/checkout-deploys";

// The declared-directory registry for the data root. `dataRoot()` is the ONLY
// way to name the root and `defineDataDir` the only way to name anything under
// it — the plain `SINGULARITY_DIR` string that used to sit above is gone, and
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
  pruneWorktreeCheckArtifacts,
  pruneWorktreeTestArtifacts,
  CHECK_ARTIFACTS_RETENTION,
} from "./internal/prune-artifacts";
