// The lint universe: which files of a tree the check lints, and the files the
// outer read-set records a content fact for.
//
// What remains of eslint's ignore list once git has done its part. `.gitignore`
// already withholds node_modules, dist (and dist.staging/live/old.*), .check-*,
// .claude/worktrees and web-core/dist, so a git-enumerated set never contains
// them and this predicate must not restate them. What is left are TRACKED files
// lint skips on purpose — generated sources and `prototypes/` — and those come
// from `lint/core`'s one shared list, the same one the ESLint config spreads.
// This used to be a hand-copy of that list, which is how `prototypes/**` had
// drifted out of the walk while ESLint still ignored it.

import { isLintScopeExcluded } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export function isLintable(rel: string): boolean {
  if (!(rel.endsWith(".ts") || rel.endsWith(".tsx"))) return false;
  return !isLintScopeExcluded(rel);
}

/**
 * The lint universe of a tree's paths: the files the check lints, and the
 * files the outer read-set records a content fact for.
 *
 * ONE function for both on purpose. The read-set is recorded on the check
 * runner's thread from the run's snapshot, while the preparation thread lints
 * from its own load of the same tree (by hash); both call this over that
 * tree's paths, so the recorded set and the linted set cannot disagree.
 */
export function lintableFiles(paths: readonly string[]): string[] {
  return paths.filter(isLintable);
}
