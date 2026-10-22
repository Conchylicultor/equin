import {
  claimPending,
  claimed,
  declined,
  type CodeClaim,
} from "@plugins/active-data/web";
import { useCommitInfo } from "@plugins/code-explorer/plugins/commit-detail/web";
import type { CommitRow } from "@plugins/primitives/plugins/commit-list/core";
import { COMMIT_WORKTREE } from "./commit-worktree";

/**
 * The semantic gate for `` `862de5c72` ``: resolve the backticked token against
 * the repository's object database (see {@link COMMIT_WORKTREE} for why that is
 * always the main checkout).
 *
 * `error` maps to a SETTLED decline, not `pending`: pending stops the arbitration
 * chain by design (see `CodeClaim`), so treating a dead backend as pending would
 * park the token forever and starve every other candidate for it. "I cannot
 * answer, move on" is the honest claim.
 */
export function useCommitClaim(sha: string): CodeClaim<CommitRow> {
  const state = useCommitInfo(COMMIT_WORKTREE, sha);

  switch (state.kind) {
    case "loading":
      return claimPending();
    case "found":
      return claimed(state.commit);
    case "not-found":
      return declined(state.reason);
    case "error":
      return declined(`commit lookup unavailable: ${state.message}`);
    // No computer to ask (the demo): the token is not claimed as a commit.
    case "unavailable":
      return declined(state.message);
  }
}
