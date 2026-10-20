import {
  _attemptDeliveries,
  _attempts,
  _conversations,
  pushes,
} from "@plugins/tasks/plugins/tasks-core/server";
import { serveValue } from "@plugins/network/plugins/live/machine";
import { refHeadServed } from "@plugins/infra/plugins/git/plugins/git-watcher/server";
import { attemptWork } from "../../core/resources";
import {
  attemptWorkSignature,
  evictAttemptWork,
  getAttemptWork,
} from "../../server/internal/work";

// A db-arm value: the loader's DB reads (the attempt row, its conversation set,
// the push ledger) are declared in `reads`, and a git ref advance (local commit / rebase /
// sync-to-head, or main moving) changes the standing of every visible attempt —
// so `recomputeOn: [refHeadServed]` recomputes every subscribed attempt.
// git-watcher only tracks `main` + this worktree's own branch, so a notify
// already implies a relevant ref moved — no need to inspect the refName.
//
// There is deliberately NO `recomputeOn` edge from the pushes ledger (the
// `pushes` collection). The landed
// set is now git-measured, so a ref advance is the COMPLETE refresh signal; the
// ledger only corroborates, and its own arrival moves the signature (see
// `attemptWorkEtag`) so a push row landing without a ref advance still
// invalidates on the next read.
export const attemptWorkServed = serveValue(attemptWork, {
  source: "db",
  reads: {
    // The memo's inputs and the push-ledger freshness reconcile: the attempt
    // row, its conversation ids (the signature folds them in), the ledger count.
    // A scratch attempt's standing is its delivery row instead.
    tables: [_attempts, _conversations, pushes, _attemptDeliveries],
    reason:
      "an attempt's standing reads its attempt row, conversation set and push ledger (a scratch attempt's: its delivery); any write to them may move any subscribed attempt, whole-table until it reads through a collection",
  },
  recomputeOn: [refHeadServed],
  // A missing worktree is NOT automatically unresolved here, unlike
  // commits-graph's `onWorktree` collapse: `landed` is measurable from the main
  // repo even when the checkout is gone, and so is `pending` (the branch ref
  // survives `git worktree remove`). The only unresolved arm is a genuinely
  // unmeasurable standing — an attempt row that no longer exists. Every real git
  // failure THROWS rather than resolving to a confident-looking zero.
  loader: ({ attemptId }) => getAttemptWork(attemptId),
  // Cheap ETag: literally the memo's own signature — the very key the loader's
  // read-through caches under, not a separately-maintained twin of it. The two
  // cannot drift, so a fresh ETag can never certify a stale value (see
  // research/2026-07-09-global-etag-value-coproduction.md). Cost: 1–2 ungated
  // `rev-parse` plus the same small DB reads the loader does, against the loader's
  // `merge-base` + `rev-list --count` + trailer-bearing `git log`.
  revalidate: ({ attemptId }) => attemptWorkSignature(attemptId),
  // Drop the attempt's memo once nobody watches it. Keyed by attemptId, so the
  // eviction needs no DB lookup. Dropping a still-referenced entry is harmless —
  // it forces one cheap cold re-probe.
  whileSubscribed:
    ({ attemptId }) =>
    () =>
      evictAttemptWork(attemptId),
});
