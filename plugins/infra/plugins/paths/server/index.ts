export {
  REPO_ROOT,
  repoConfigDir,
  PLUGINS_DIR,
  WEB_CORE_RELATIVE,
  SERVER_CORE_RELATIVE,
  webDistDir,
  HOME_DIR,
  BACKUPS_DIR,
  worktreesDir,
  worktreeDataDir,
  worktreeArtifacts,
  RUN_TRANSCRIPT_SUFFIX,
  RUN_TERMINAL_SUFFIX,
  CLAUDE_DIR,
  CLAUDE_PROJECTS_DIR,
  CLAUDE_SESSIONS_DIR,
  isRelease,
  isHostSingleton,
  releaseIdentity,
  setReleaseIdentity,
  checkoutWorktreeName,
} from "../core/internal/paths";
export type { ReleaseIdentity } from "../core/internal/paths";

// The declared-directory registry for the data root, re-exported from the
// server barrel exactly as the core barrel exports it — same module, so a
// declaration made through either specifier lands in the one registry. Server
// plugins are the bulk of the writers under the root, and a server file that
// had to reach into `…/paths/core` for `defineDataDir` while taking every other
// path from `…/paths/server` is the friction that keeps people joining the root
// by hand. There is no `SINGULARITY_DIR` above any more: `dataRoot()` is the
// only spelling of the root, and `paths:data-root-not-joined` fails on joining
// it or on re-reading its environment variable.
export {
  DATA_DIR_KINDS,
  META_APP_ROOTS,
  dataRoot,
  defineAppDataDir,
  defineDataDir,
  getDataDirs,
  relativeToDataRoot,
} from "../core/internal/data-dir";
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
} from "../core/internal/data-dir";

export {
  GIT,
  PGREP,
  PS,
  TMUX,
  CLAUDE_CANDIDATES,
  resolveClaudeBin,
} from "./internal/bins";
export type { ClaudeBinLookup } from "./internal/bins";

export {
  listWorktreeDirs,
  listWorktreeDirsAsync,
} from "../core/internal/worktree-dirs";

// The checkout half of a namespace, and the namespace that mints from it.
// Answering the first means asking git which root owns `.git`, not comparing a
// basename to a literal — which is why it is a function and not an expression.
// It lives in `core` now, where the CLI and an e2e script can reach it (neither
// may import a `server` barrel from every runtime they run in), and is
// re-exported here so the server-side callers that take every other path from
// this barrel keep one import.
export {
  actAsCheckoutNamespace,
  checkoutRef,
  checkoutNamespace,
} from "../core/internal/checkout-ref";

export {
  pruneWorktreeBuildArtifacts,
  pruneWorktreeCheckArtifacts,
  pruneWorktreeRunArtifacts,
  BUILD_ARTIFACTS_RETENTION,
  CHECK_ARTIFACTS_RETENTION,
  RUN_ARTIFACTS_RETENTION,
} from "../core/internal/prune-artifacts";

import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { publishDataDirsManifest } from "./internal/publish-data-dirs";

export { publishDataDirsManifest } from "./internal/publish-data-dirs";

export default {
  description:
    "Canonical machine paths, plus the boot-time publication of this namespace's declared data-dir set so an audit running in another checkout can tell one of this branch's directories from an orphan.",
  onReady: async () => {
    await publishDataDirsManifest();
  },
} satisfies ServerPluginDefinition;
