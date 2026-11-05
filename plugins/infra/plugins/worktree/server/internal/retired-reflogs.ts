import { GIT } from "@plugins/infra/plugins/paths/server";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { ATTEMPT_BRANCH_PREFIX } from "../../core";
import {
  ensureMainWorktreeRoot,
  listWorktreeEntries,
  WorktreeGitTimeoutError,
} from "./worktree";

// Reflogs of retired attempt branches: the factor git's object walk multiplies.
//
// Every `--reflog` walk — `pack-objects --all --reflog` under each auto-gc's
// repack, `git prune`'s reachability, fsck — reads every SHARED reflog once for
// the main worktree and AGAIN for every linked one (revision.c
// add_reflogs_to_pending iterates each worktree's ref store, whose reflog
// iterator merges the common `logs/` in). One walk is O(worktrees × shared
// reflogs): with 324 worktrees and 10.6k reflogs (one per attempt branch ever
// made, plus one per remote-tracking ref a push wrote) that was ~3.4M file
// reads, 7-9 min per repack on the host (2026-11-05,
// research/2026-11-05-global-git-repack-reflog-walk.md).
//
// The worktree count is retention policy; the reflog count is not. A branch
// outlives its checkout on purpose (branch.ts) and stays — only its reflog
// goes, and only once nothing can want it: the branch is checked out nowhere
// and its tip is already in main, so every state the reflog records is either
// in main's history or the pre-rebase draft of work that landed there. What
// remains is bounded by the live checkouts (their branch and its
// remote-tracking ref), not by every attempt ever run.

const REF_TIMEOUT_MS = 60_000; // ref listings: same starvation exposure as worktree.ts's
const DROP_TIMEOUT_MS = 120_000; // one batch of reflog unlinks
// Refs per `git reflog drop`: keeps the argv far under ARG_MAX (~70 bytes a ref).
const DROP_BATCH = 500;

export interface RetiredReflogSweep {
  /** Reflogs of attempt-namespace refs before the sweep. */
  attemptReflogs: number;
  /** Of those, dropped: merged into main and checked out nowhere. */
  dropped: number;
}

async function gitLines(repoRoot: AppPath, args: string[]): Promise<string[]> {
  const argv = [GIT, "-C", repoRoot, ...args];
  const r = await spawnCaptured(argv, {
    tier: "background",
    timeoutMs: REF_TIMEOUT_MS,
  });
  if (r.timedOut) {
    throw new WorktreeGitTimeoutError({
      message: `${argv.join(" ")} did not finish within ${REF_TIMEOUT_MS} ms and was killed`,
      command: argv.join(" "),
      timeoutMs: REF_TIMEOUT_MS,
    });
  }
  if (r.exitCode !== 0) {
    throw new Error(
      `${argv.join(" ")} failed (exit ${r.exitCode}): ${r.stderr.trim() || "<no stderr>"}`,
    );
  }
  return r.stdout.split("\n").filter((l) => l !== "");
}

// `refs/heads/claude-web/<id>` or `refs/remotes/<remote>/claude-web/<id>` →
// the local branch ref it is about; null for any other ref.
function attemptBranchOf(ref: string): string | null {
  const local = `refs/heads/${ATTEMPT_BRANCH_PREFIX}`;
  if (ref.startsWith(local)) return ref;
  const m = /^refs\/remotes\/[^/]+\/(.*)$/.exec(ref);
  if (m !== null && m[1]!.startsWith(ATTEMPT_BRANCH_PREFIX))
    return `refs/heads/${m[1]}`;
  return null;
}

/** {@link dropRetiredBranchReflogs} against an explicit repo. */
export async function dropRetiredBranchReflogsIn(
  repoRoot: AppPath,
): Promise<RetiredReflogSweep> {
  const attemptReflogs = (await gitLines(repoRoot, ["reflog", "list"])).filter(
    (ref) => attemptBranchOf(ref) !== null,
  );
  const merged = new Set(
    await gitLines(repoRoot, [
      "for-each-ref",
      "--merged",
      "refs/heads/main",
      "--format=%(refname)",
      `refs/heads/${ATTEMPT_BRANCH_PREFIX}`,
      `refs/remotes/*/${ATTEMPT_BRANCH_PREFIX}*`,
    ]),
  );
  // Checked-out branches LAST, so a checkout made before the merged read is
  // seen. One made after it can at worst lose the log of a branch whose tip
  // is in main (a fresh `claude-web/<id>` at main's tip: its "Created from").
  const checkedOut = new Set(
    (await listWorktreeEntries(repoRoot)).flatMap((e) =>
      e.head?.kind === "branch" ? [e.head.ref] : [],
    ),
  );
  const retired = attemptReflogs.filter(
    (ref) => merged.has(ref) && !checkedOut.has(attemptBranchOf(ref)!),
  );
  for (let i = 0; i < retired.length; i += DROP_BATCH) {
    const argv = [
      GIT,
      "-C",
      repoRoot,
      "reflog",
      "drop",
      ...retired.slice(i, i + DROP_BATCH),
    ];
    const r = await spawnCaptured(argv, {
      tier: "background",
      timeoutMs: DROP_TIMEOUT_MS,
    });
    if (r.timedOut) {
      throw new WorktreeGitTimeoutError({
        message: `git reflog drop (${retired.length - i} retired reflogs left) did not finish within ${DROP_TIMEOUT_MS} ms and was killed`,
        command: argv.slice(0, 5).join(" "),
        timeoutMs: DROP_TIMEOUT_MS,
      });
    }
    if (r.exitCode !== 0) {
      throw new Error(
        `git reflog drop (${retired.length - i} retired reflogs left) failed (exit ${r.exitCode}): ${r.stderr.trim() || "<no stderr>"}`,
      );
    }
  }
  return { attemptReflogs: attemptReflogs.length, dropped: retired.length };
}

/**
 * Drops the reflogs of attempt branches (and their remote-tracking refs) that
 * are merged into main and checked out by no worktree. The refs themselves
 * stay. Idempotent; the worktree reaper runs it every sweep.
 */
export async function dropRetiredBranchReflogs(): Promise<RetiredReflogSweep> {
  return dropRetiredBranchReflogsIn(await ensureMainWorktreeRoot());
}
