// `listRepoFiles`: the repo's file set as a plain sorted array.
//
// The listing itself is `tooling/core`'s `loadRepoFiles` — ONE implementation,
// shared with `ctx.repo()`'s fallback and with build-time codegen, which is why
// it lives below this plugin. See that file for why the set comes from git and
// never from a filesystem walk.
//
// CHECK CODE TAKES THE SET FROM `ctx.repo()` instead: the same universe, listed
// once per run for every check (off the cache key's own tree when the run has
// one), with in-memory `under`/`has`, async bounded reads, and read-set
// recording for an input-keyed check.

import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { loadRepoFiles } from "@plugins/framework/plugins/tooling/core";

/**
 * Every repo-relevant path, repo-relative and sorted: tracked + untracked-not-
 * ignored, minus index entries whose file is gone from the worktree — EXACTLY
 * the membership `computeTreeHash` folds into the check cache key. A fresh,
 * mutable array; `loadRepoFiles` documents the universe.
 *
 * In a check, use `ctx.repo()`. Throws on any git failure.
 */
export async function listRepoFiles(root: AppPath): Promise<string[]> {
  return [...(await loadRepoFiles(root)).all()];
}
