/**
 * How far back a ledger walk reaches — a COVERAGE frontier, not an insertion one.
 *
 * The distinction is the whole file. The walk used to start at the ledger's own
 * high-water mark (`max(pushes.created_at) - 24h`) on the reasoning that anything
 * older is already recorded. It is not: `plan.ts` cannot attribute a commit whose
 * conversation is absent from THIS database, and that absence is not permanent —
 * the conversation row can still appear later, at which
 * point the commit becomes attributable. By then the ledger's newest row has
 * moved past it, so a walk bounded by insertions never offers it again and the
 * row can never be written.
 *
 * That breaks I5 (`pushes` covers every trailer-bearing commit reachable from
 * `refs/heads/main`), and it breaks it in the direction that hurts:
 * `attempts_v.status` only reaches `completed` through a ledger row, and
 * `task_blocking_v` blocks dependents on the absence of a completed attempt — so
 * one permanently missing row keeps dependent tasks blocked and their armed
 * auto-start from ever firing.
 *
 * So the bound answers "how far back must a walk RE-OFFER commits it may not have
 * been able to attribute yet", which is a different and strictly larger question
 * than "how far back might a commit be missing from the ledger". Pure — no DB, no
 * git — so the policy is pinned by `walk-bound.test.ts` directly, the same split
 * `read-main.ts` and `plan.ts` already keep.
 */

/**
 * How far back of its own high-water mark a walk starts. A commit landing while
 * a previous walk ran, and clock adjustment between the machine that committed
 * and the one reading, both fit inside a day. This is the CATCH-UP half: it is
 * what a backend that was down for a month walks.
 */
export const WATERMARK_PAD_MS = 24 * 60 * 60 * 1000;

/**
 * How far back EVERY walk reaches regardless of what it has recorded — the window
 * in which a DEFERRED commit is re-offered.
 *
 * A deferral is not a skip. From inside this database "foreign, this instance
 * will never own it" and "not mine yet, the conversation row has not been adopted
 * here" are the same observation, and nothing distinguishes them at the moment
 * the walk makes it. So the walk re-offers every commit younger than this on
 * every walk, rather than losing it the instant the ledger's newest row moves
 * past it.
 *
 * The residual policy, stated rather than pretended away: a commit that stays
 * unattributable for longer than this IS treated as foreign. That is a horizon
 * this file chooses, not an accident of the pad — and it is the honest shape of a
 * bounded walk, because no finite bound can also be exact.
 *
 * The cost is what picks the number. Measured on this repo, 30 days is ~390
 * commits / ~80 KB of `git log` output, against ~3700 / ~720 KB for the whole
 * history. It is a constant as the repo grows rather than a number that tracks
 * total history, which is what keeps this on the correctness path (every read,
 * behind the freshness memo) instead of in a deferred warm-up.
 */
export const DEFERRAL_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Where the walk starts. `null` means "the whole history", the only right answer
 * for an empty ledger — there is no high-water mark to catch up from, and a
 * bounded first walk would silently define everything older as foreign.
 *
 * With a ledger present, two bounds apply and the EARLIER one wins, because each
 * covers a case the other does not. The high-water mark minus
 * {@link WATERMARK_PAD_MS} is the catch-up bound: a backend that was down for a
 * month must walk that month, and the horizon alone would not reach it. `now`
 * minus {@link DEFERRAL_HORIZON_MS} is the deferral bound: a ledger written to a
 * minute ago must still re-offer the commits it could not attribute, and the
 * watermark alone would not reach them. Taking the minimum satisfies both at once.
 */
export function ledgerWalkStart(
  newestRecorded: Date | null,
  now: Date,
): Date | null {
  if (!newestRecorded) return null;
  return new Date(
    Math.min(
      newestRecorded.getTime() - WATERMARK_PAD_MS,
      now.getTime() - DEFERRAL_HORIZON_MS,
    ),
  );
}
