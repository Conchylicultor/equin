import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * One detached git checkout per in-flight release, `<run-id>/`, plus the
 * `<run-id>.lock` flock file its owning `./equin release` process holds
 * for as long as the checkout is in use.
 *
 * Not `.claude/worktrees/`: that directory is Claude Code's own and is swept by
 * it, and the reaper there (worktree-cleanup) is about agent checkouts. A
 * release checkout is scratch build input with no branch and no task.
 */
export const releaseCheckoutsDir = defineDataDir({
  kind: "cache",
  name: "release-checkouts",
  owner: "release/source-checkout",
  description:
    "Private detached checkouts a release builds from (<run-id>/ + <run-id>.lock), removed when the release ends and swept by the next release if its owner died",
  // `restart`, not `safe`: a checkout whose owning release is still running is
  // that release's source tree, and deleting it mid-build fails the release.
  // Once no release is running every entry is reclaimable — which is exactly
  // what the flock-guarded sweep at the start of each release does.
  reclaim: { kind: "restart" },
});

/**
 * The shared cargo `target/` dir a release's `tauri build` compiles into.
 *
 * A release checkout is fresh, so its own `tauri/src-tauri/target` would start
 * empty and every desktop release would compile the Rust shell cold. Cargo
 * serializes concurrent builds over one target dir with its own file lock.
 */
export const releaseCargoTargetDir = defineDataDir({
  kind: "cache",
  name: "release-cargo-target",
  owner: "release/source-checkout",
  description:
    "Shared cargo target dir for the tauri build of releases cut from a private checkout, so the Rust shell compiles incrementally instead of cold",
  reclaim: { kind: "safe" },
});

export default [releaseCheckoutsDir, releaseCargoTargetDir];
