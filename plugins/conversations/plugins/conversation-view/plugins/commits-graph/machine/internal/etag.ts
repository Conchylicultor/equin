// Conditional-revalidation ETag signature for the commits-graph resource.
// This is the cheap "did anything change?" content fingerprint the live-state
// read path compares against the client's last-known value before running the
// full loader (see the resource `revalidate` field). It is a conservative
// over-approximation: it folds in exactly the git-state inputs the loader reads,
// so an ETag miss can never hide a value change (serving stale is a correctness
// bug; a needless recompute is merely a missed optimization).
//
// Factored out as a pure string-format function so the soundness (distinct input
// dimension ⇒ distinct string) is unit-testable without spawning git.

// `computeGraph` reads (headSha, mainSha, mergeBase, landedShas) — its three
// internal cache keys are `${headSha}|${mergeBase}` (pending), `${mainSha}|
// ${mergeBase}` (behind) and `${headSha}|${mergeBase}|${landedShas}` (landed).
// mergeBase is a pure function of (headSha, mainSha) (immutable history), so
// folding in both tips covers it without spawning `merge-base` here.
//
// landedShas is the set of `main` commits carrying this attempt's conversation
// trailers (attempt-work's landed memo, `landedShasFrom`). It moves when a
// commit lands on `main` — which advances `mainSha` — AND when a conversation
// joins the attempt (an adoption, a fork) with no ref moving: so the
// conversation set is its own dimension (sorted: order-independent). The
// checkout is too: the tips are read in it, and an attempt's `worktree_path`
// can be re-pointed under an unchanged head.
export function graphEtag(
  headSha: string,
  mainSha: string,
  convIds: readonly string[],
  worktreePath: string,
): string {
  return `${headSha}|${mainSha}|${[...convIds].sort().join(",")}|${worktreePath}`;
}
