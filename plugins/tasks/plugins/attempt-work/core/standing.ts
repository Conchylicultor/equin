import type { AttemptWork } from "./protocol";

/**
 * The decision-grade standing of an attempt: is any of its work at stake, and if
 * so which kind. A discriminated value, NOT a count a consumer compares to zero
 * (invariant I4) — `pushes.length === 0` must have no spelling at a decision
 * site, because that is exactly the expression that read a lagging ledger as
 * proof that nothing was pushed.
 */
export type Standing = "none" | "pending" | "landed";

/**
 * The ONLY place a count is compared to zero, with the reasoning written down
 * once.
 *
 * `pending` wins over `landed`: unpushed commits are the actionable state — an
 * attempt that has both landed work and local commits still needs a push, so
 * reporting it as merely "landed" would offer the wrong action.
 *
 * `ledgerPushes` is ORed in, never subtracted: a ledger row PROVES a push
 * happened (invariant I3), which is what keeps a pre-trailer-era attempt — whose
 * commits carry no `Singularity-Conversation` trailer to grep for — from reading
 * as droppable. Its absence is not evidence of anything.
 *
 * `delivered` is a scratch workspace's whole landed fact: it has no git to
 * measure, so a recorded delivery is what "landed" means there.
 */
export function standingOf(w: AttemptWork): Standing {
  if (w.pending.kind === "measured" && w.pending.ahead > 0) return "pending";
  if (w.landedCommits > 0 || w.ledgerPushes > 0 || w.delivered) return "landed";
  return "none";
}
