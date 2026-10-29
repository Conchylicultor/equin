// Conditional-revalidation ETag signatures for the attempt-work measurement.
// These are the cheap "did anything change?" content fingerprints the live-state
// read path compares against the client's last-known value before running the
// full loader (see the resource `revalidate` field). They are conservative
// over-approximations: they fold in exactly the inputs the measurement reads, so
// an ETag miss can never hide a value change (serving stale is a correctness bug;
// a needless recompute is merely a missed optimization).
//
// Factored out as pure string-format functions so the soundness (distinct input
// dimension ⇒ distinct string) is unit-testable without spawning git.

// The pending half reads only: branch (rev-parse HEAD), merge-base(main, <rev>),
// and `rev-list --left-right --count main...<rev>`. Every one of those is fully
// determined by the pair (headSha, mainSha): commits are immutable, so if neither
// tip moved the merge-base and both rev-lists are unchanged.
export function deltaEtag(headSha: string, mainSha: string): string {
  return `${headSha}|${mainSha}`;
}

// The whole attempt-work value adds three inputs the tips do NOT determine:
//
// - `convIds` — the attempt's conversation set, which the landed grep filters on.
//   It GROWS while an attempt runs (a fork, a resume), and a new conversation can
//   match commits the previous set did not, so it must be folded in.
// - `ledgerPushes` — a DB read. A push row can land without any local ref moving
//   (the ingest job reacting to `main` on another worktree), and the value carries
//   the count, so head/main alone would certify a stale payload.
// - `worktreePath` — where the pending half reads from: the checkout (its own
//   HEAD's branch) or, once cleanup reaped it (`null`), the branch ref. A path
//   moving with the tips unchanged changes what `pending` says, so an entry
//   computed from the other path is never a hit.
//
// The conversation ids are sorted so the signature is order-independent.
//
// This is `workMemo`'s bound `signature` — the ETag on the wire and the key the
// loader's read-through caches under are the same string from the same call, not
// two twins kept in step by hand (see
// research/2026-07-09-global-etag-value-coproduction.md).
export function attemptWorkEtag(
  headSha: string,
  mainSha: string,
  convIds: readonly string[],
  ledgerPushes: number,
  worktreePath: string | null,
): string {
  return `${deltaEtag(headSha, mainSha)}|${[...convIds].sort().join(",")}|${ledgerPushes}|${worktreePath ?? ""}`;
}
