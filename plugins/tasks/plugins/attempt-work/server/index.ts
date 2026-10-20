import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  getAttemptWork,
  readLandedShas,
  attemptWorkSignature,
  evictAttemptWork,
} from "./internal/work";
// The pending-side git reads, shared with commits-graph (which measures the same
// branch for its chip and pane). One home, so "ahead of main" is one question with
// one answer.
export {
  readBranch,
  readMergeBase,
  readDeltaCounts,
  refExists,
  probeHeadMain,
  probeRefMain,
  readPendingInWorktree,
  readPendingFromBranchRef,
  readLanded,
} from "./internal/measure";
export { deltaEtag, attemptWorkEtag } from "./internal/etag";

export default {
  description:
    "The attempt-work authority: where an attempt stands relative to `main`, measured from git (branch counts + Singularity-Conversation trailers on main) rather than from the lagging pushes ledger — the direct read for the server-side exit-drop guard and the git measurements commits-graph shares. The live value is served by the machine half.",
} satisfies ServerPluginDefinition;
