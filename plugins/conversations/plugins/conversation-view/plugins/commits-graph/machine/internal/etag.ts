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
// landedShas needs no separate dimension any more. It used to be a `pushes` DB
// read that could move on its own, so it had to be folded in. It is now the set
// of `main` commits carrying this attempt's conversation trailers (attempt-work's
// `readLandedShas`), and a commit can only join that set by landing on `main` —
// which advances `mainSha`. So the two tips determine the landed set as well.
export function graphEtag(headSha: string, mainSha: string): string {
  return `${headSha}|${mainSha}`;
}
