// The `claude-web/<attemptId>` branch convention, in both directions, as the ONE
// definition of it.
//
// Why this lives in `core/` and not next to `setupWorktree`, which is the only
// thing that ever CREATES such a branch: the branch outlives the checkout.
// `git worktree remove` deletes the directory and leaves `refs/heads/claude-web/<id>`
// standing, so the branch is the last durable trace of a reaped attempt — the only
// place its unpushed commits can still be measured, and the string a recovery
// message tells the user to run `git worktree add` against. It is therefore read by
// far more code than writes it, and read from the browser as often as from the
// server (a Gantt row label, an op detail title). Every reader that spells the
// prefix itself is a place the convention can silently drift out of step with the
// writer.
//
// Web-safe by construction, for that reason: string literals only, no `node:*`, no
// import of the sibling `server/` tree. Same rule, and same reason, as
// `infra/paths/display`.

export const ATTEMPT_BRANCH_PREFIX = "claude-web/";

/**
 * The branch `setupWorktree` creates for an attempt. Everything that looks a
 * branch up by attempt id — a measurement, a recovery command, an op match —
 * builds it from here rather than interpolating the prefix again.
 */
export function attemptBranchName(attemptId: string): string {
  return `${ATTEMPT_BRANCH_PREFIX}${attemptId}`;
}

/**
 * The same branch as a fully-qualified ref (`refs/heads/claude-web/<id>`), which is
 * what a git read against the MAIN repo needs: the attempt's own checkout may be
 * gone, and an unqualified name would resolve against whatever branch happens to be
 * checked out there.
 */
export function attemptBranchRef(attemptId: string): string {
  return `refs/heads/${attemptBranchName(attemptId)}`;
}

/**
 * The inverse: the attempt id a branch name (or a worktree identifier recorded as
 * one) carries. Returns the input unchanged when it does not carry the prefix —
 * callers hand it identifiers that are already bare ids, and a bare id is the
 * correct answer for one, not a failure.
 */
export function stripAttemptBranchPrefix(branchOrWorktree: string): string {
  return branchOrWorktree.startsWith(ATTEMPT_BRANCH_PREFIX)
    ? branchOrWorktree.slice(ATTEMPT_BRANCH_PREFIX.length)
    : branchOrWorktree;
}
