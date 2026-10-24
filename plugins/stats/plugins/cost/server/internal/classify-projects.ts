// Is an encoded Claude project dir an equin project (the main repo or one
// of its worktrees)? Claude encodes project paths by replacing `/`, `.`, and `_`
// with `-`, so /Users/<user>/.../singularity becomes `-Users-<user>-...-singularity`
// and a worktree under it becomes `-Users-<user>-...-singularity--claude-worktrees-...`.
// We match any dir ending in `-<basename>` (the main repo) or containing
// `-<basename>-` (a worktree). This deliberately ignores the user prefix so older
// sessions recorded under a different macOS user (e.g. `admin`) still count.
//
// A PURE predicate on the directory NAME on purpose: it must answer for a project
// whose directory no longer exists on disk. Reading `~/.claude/projects` and
// resolving anything absent from that listing to `false` would silently drop
// archived sessions from the default (`singularity`-scoped) view of every chart
// the moment Claude Code's transcript GC removes the directory.
export function isSingularityProjectDir(
  dir: string,
  repoBasename: string,
): boolean {
  const tail = `-${repoBasename}`;
  return dir.endsWith(tail) || dir.includes(`${tail}-`);
}
