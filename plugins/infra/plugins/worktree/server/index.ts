import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  ensureMainWorktreeRoot,
  listWorktreePaths,
  gitWorktreesDir,
  worktreePathFor,
  isCanonicalWorktreePath,
  setupWorktree,
  type WorktreeSetup,
  type CheckoutSource,
  removeWorktree,
  emptyWorktreeTrash,
  WorktreeGitTimeoutError,
} from "./internal/worktree";
export {
  createSpareWorktree,
  pruneSpares,
  countReadySpares,
} from "./internal/spare";
export { withWorktreeMutateSlot } from "./internal/mutate-gate";
export { isCanonicalWorktreeName } from "./internal/worktree-name";
export {
  type WorktreeOp,
  type WorktreeOpInfo,
  type WorktreeOpMarker,
  markWorktreeOpStart,
  probeWorktreeOp,
  isWorktreeOpActive,
  listWorktreeOps,
  listActiveWorktreeOps,
} from "./internal/worktree-op";
export {
  type WorktreeSpec,
  writeWorktreeSpec,
  removeWorktreeSpec,
} from "./internal/spec";
export {
  type CompositionMarker,
  type NamespaceProbe,
  type NamespaceClaimant,
  probeNamespace,
  namespaceCollision,
  stampCompositionMarker,
  readCompositionMarker,
  hasCompositionMarker,
} from "./internal/composition-namespace";

export default {} satisfies ServerPluginDefinition;
