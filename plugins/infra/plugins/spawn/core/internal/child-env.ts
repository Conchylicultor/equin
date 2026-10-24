import type { ParentLifeline } from "@plugins/packages/plugins/flock/core";

// Every child this primitive starts runs with git's optional locks OFF.
//
// A git READ is not lock-free by default: `git status`, `git diff` and friends
// refresh the index's cached file stats and write them back, briefly holding
// `.git/index.lock` to do it. In a checkout shared by several processes that
// turns a read into a collision with a real write: main's auto-build runs
// `git status` in main's checkout while a queued `./equin push` runs
// `git merge --ff-only` there, and the merge fails outright on
// "index.lock: File exists" (seven failed pushes, Sep 16–22 2026).
//
// `GIT_OPTIONAL_LOCKS=0` tells git to skip exactly those opportunistic writes;
// commands that must write (merge, add, commit, update-index) still take the
// lock as before. Set here, at the one chokepoint every runtime's async spawns
// go through, so no read we issue can take the lock, whoever writes the call.
// The cost is the stat cache not being saved by reads, which the next real
// index write refreshes anyway.
const GIT_READS_TAKE_NO_LOCK = { GIT_OPTIONAL_LOCKS: "0" } as const;

/**
 * The child's environment: the caller's `env` (a FULL replacement, as with
 * `Bun.spawn`) or, when none is given, the parent's — plus
 * `GIT_OPTIONAL_LOCKS=0` and the path of the lifeline this spawn holds for it
 * (`holdParentLifeline`, read by the child's `exitWithParent`).
 */
export function childEnv(
  env: Record<string, string | undefined> | undefined,
  lifeline: ParentLifeline,
): Record<string, string | undefined> {
  return {
    ...(env ?? process.env),
    ...GIT_READS_TAKE_NO_LOCK,
    ...lifeline.env,
  };
}
