import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * Cargo's `target/` dirs for every crate the rust kind builds, one per crate
 * (`<crate path with / as __>/`). Shared by every checkout, so a worktree's
 * first build of a crate compiles incrementally from what main already built
 * instead of cold; cargo serializes concurrent builds over one target dir with
 * its own file lock. Only the copy a build leaves in the deps cache is ever
 * run, so reclaiming this costs a cold compile and nothing else.
 */
export const cargoTargetDir = defineDataDir({
  kind: "cache",
  name: "cargo-target",
  owner: "infra/deps/rust",
  description:
    "Shared cargo target dirs (one per rust/ crate) the rust kind of infra/deps compiles into, so a crate builds incrementally across checkouts",
  reclaim: { kind: "safe" },
});

export default [cargoTargetDir];
