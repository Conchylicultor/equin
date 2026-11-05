// Runtime-agnostic half of the worktree plugin. NOTHING here may import `node:*`
// or the sibling `server/` tree — browser code (the profiling Gantt, the op detail
// pane, the op-status banner) imports this barrel to read the branch convention
// and the op-kind vocabulary.
export {
  ATTEMPT_BRANCH_PREFIX,
  attemptBranchName,
  attemptBranchRef,
  stripAttemptBranchPrefix,
} from "./internal/branch";
export { OP_KINDS, OP_KIND_IDS, isOpKind } from "./internal/op-kind";
export type { OpKind, OpKindMeta } from "./internal/op-kind";
