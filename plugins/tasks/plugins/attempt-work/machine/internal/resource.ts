import {
  attemptConversationIdsServed,
  attemptDeliveriesServed,
  attemptPushIdsServed,
  attemptWorkspacesServed,
  PushLedger,
} from "@plugins/tasks/plugins/tasks-core/server";
import { serveValue } from "@plugins/network/plugins/live/machine";
import { refHeadServed } from "@plugins/infra/plugins/git/plugins/git-watcher/server";
import { attemptWork } from "../../core/resources";
import {
  attemptFactsFrom,
  attemptWorkFrom,
  attemptWorkSignature,
  evictAttemptWork,
  type AttemptFacts,
} from "../../server/internal/work";

// The facts of one load, from the rows its follows just read. The push ledger
// is pulled current first — its own `bg` span at the provider
// (`tasks-core/machine`), so this loader captures none of the reconcile's
// reads or writes. The rows were read before it ran, so a reconcile that
// inserts this attempt's pushes lands on the NEXT load: its insert reaches
// `pushIds` through the feed (the ledger count is positive-only evidence, I3,
// so one load of lag is never a wrong answer).
async function factsOf(
  followed: Parameters<typeof attemptFactsFrom>[0],
): Promise<AttemptFacts> {
  await PushLedger.get().ensureFresh();
  return attemptFactsFrom(followed);
}

// A db-arm value whose DB reads are its FOLLOWS — the attempt's row, its
// conversation set, its pushes and its delivery, each one collection tuple —
// so a write reaches only the attempts whose facts it moves (a `viewed` write
// on a conversation, a write to another attempt: nothing). A git ref advance
// (local commit / rebase / sync-to-head, or main moving) changes the standing
// of every visible attempt — so `recomputeOn: [refHeadServed]` recomputes every
// subscribed attempt. git-watcher only tracks `main` + this worktree's own
// branch, so a notify already implies a relevant ref moved — no need to
// inspect the refName.
//
// The landed set is git-measured, so a ref advance is the COMPLETE refresh
// signal for it; the ledger only corroborates, and its own arrival moves the
// signature (see `attemptWorkEtag`) through the `pushIds` follow.
export const attemptWorkServed = serveValue(attemptWork, {
  source: "db",
  follows: (follow) => ({
    attempt: follow(attemptWorkspacesServed, ({ attemptId }) => ({
      ids: [attemptId],
    })),
    convIds: follow(attemptConversationIdsServed, ({ attemptId }) => ({
      where: { attemptId },
    })),
    pushIds: follow(attemptPushIdsServed, ({ attemptId }) => ({
      where: { attemptId },
    })),
    delivery: follow(attemptDeliveriesServed, ({ attemptId }) => ({
      ids: [attemptId],
    })),
  }),
  recomputeOn: [refHeadServed],
  // A missing worktree is NOT automatically unresolved here, unlike
  // commits-graph's `onWorktree` collapse: `landed` is measurable from the main
  // repo even when the checkout is gone, and so is `pending` (the branch ref
  // survives `git worktree remove`). The only unresolved arm is a genuinely
  // unmeasurable standing — an attempt row that no longer exists. Every real git
  // failure THROWS rather than resolving to a confident-looking zero.
  loader: async ({ attemptId }, { followed }) =>
    attemptWorkFrom(attemptId, await factsOf(followed)),
  // Cheap ETag: literally the memo's own signature over the same followed
  // facts — the very key the loader's read-through caches under, not a
  // separately-maintained twin of it. The two cannot drift, so a fresh ETag can
  // never certify a stale value (see
  // research/2026-07-09-global-etag-value-coproduction.md). Cost: 1–2 ungated
  // `rev-parse`, against the loader's `merge-base` + `rev-list --count` +
  // trailer-bearing `git log`.
  revalidate: async ({ attemptId }, { followed }) =>
    attemptWorkSignature(attemptId, await factsOf(followed)),
  // Drop the attempt's memos once nobody watches it. Keyed by attemptId, so the
  // eviction needs no rows. Dropping a still-referenced entry is harmless —
  // it forces one cheap cold re-probe.
  whileSubscribed:
    ({ attemptId }) =>
    () =>
      evictAttemptWork(attemptId),
});
