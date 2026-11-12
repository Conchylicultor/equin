import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  ensureMainWorktreeRoot,
  listWorktreePaths,
  listWorktreeEntries,
  type WorktreeEntry,
  type WorktreeHead,
  gitWorktreesDir,
  appCheckoutOf,
  worktreePathFor,
  isCanonicalWorktreePath,
  setupWorktree,
  type WorktreeSetup,
  checkoutState,
  type CheckoutState,
  type CheckoutSource,
  addCheckout,
  type CheckoutHead,
  removeWorktree,
  type WorktreeRemoval,
  emptyWorktreeTrash,
  WorktreeGitTimeoutError,
} from "./internal/worktree";
export {
  createSpareWorktree,
  pruneSpares,
  countReadySpares,
} from "./internal/spare";
export { withWorktreeMutateSlot } from "./internal/mutate-gate";
export {
  dropRetiredBranchReflogs,
  type RetiredReflogSweep,
} from "./internal/retired-reflogs";
export {
  type AdoptResult,
  type HarvestResult,
  describeAdoption,
  describeHarvest,
} from "./internal/dep-store-pool";
export {
  type TreeStart,
  type TreeHarvestResult,
  describeTreeStart,
  describeTreeHarvest,
} from "./internal/tree-pool";
export { isCanonicalWorktreeName } from "./internal/worktree-name";
export {
  type WorktreeOp,
  type WorktreeOpInfo,
  probeWorktreeOp,
  isWorktreeOpActive,
  listWorktreeOps,
  listActiveWorktreeOps,
} from "./internal/worktree-op";
export {
  type WorktreeOpMarker,
  type MarkWorktreeOpOptions,
  markWorktreeOpStart,
} from "./internal/worktree-op-marker";
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
  loadCompositionMarker,
  isCompositionMarkerPath,
  hasCompositionMarker,
} from "./internal/composition-namespace";

export default {} satisfies ServerPluginDefinition;
