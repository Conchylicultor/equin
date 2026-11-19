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
  isUnfinishedEntry,
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
  type SetupStep,
  type SetupStepName,
  type OnSetupStep,
  describeSetupStep,
  recordSetupSteps,
} from "./internal/setup-steps";
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
  type NamespaceKind,
  classifyNamespace,
  isPersistentNamespace,
} from "./internal/namespace-kind";
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
  type WorktreeSpecRead,
  readWorktreeSpec,
  writeWorktreeSpec,
  removeWorktreeSpec,
  unpublishWorktreeSpec,
  hasWorktreeSpec,
  isWorktreeSpecPath,
} from "./internal/spec";
export {
  type CompositionMarker,
  type NamespaceProbe,
  type NamespaceClaimant,
  probeNamespace,
  namespaceCollision,
  stampCompositionMarker,
  claimingMarker,
  markerServes,
  loadCompositionMarker,
  isCompositionMarkerPath,
  hasCompositionMarker,
} from "./internal/composition-namespace";

export default {} satisfies ServerPluginDefinition;
