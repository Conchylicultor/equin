import { serveValue } from "@plugins/network/plugins/live/machine";
import { WorktreeGoneError } from "@plugins/primitives/plugins/commit-list/server";
import {
  resolved,
  unresolved,
} from "@plugins/primitives/plugins/live-state/core";
import { refHeadServed } from "@plugins/infra/plugins/git/plugins/git-watcher/server";
import {
  attemptConversationIdsServed,
  attemptWorkspacesServed,
} from "@plugins/tasks/plugins/tasks-core/server";
import {
  assertCapability,
  type WorkspaceKind,
} from "@plugins/conversations/plugins/workspace/core";
import {
  evictLandedShas,
  landedShasFrom,
  probeHeadMain,
} from "@plugins/tasks/plugins/attempt-work/server";
import { commitsGraph } from "../../shared/resources";
import { computeGraph, evictWorktree } from "./compute-graph";
import { graphEtag } from "./etag";

/** The graph's followed rows: the attempt's row and its conversation set. */
interface GraphFollowed {
  readonly attempt: readonly GraphAttempt[];
  readonly convIds: readonly { readonly id: string }[];
}
interface GraphAttempt {
  readonly workspace: { readonly kind: WorkspaceKind };
  readonly worktreePath: string | null;
  readonly createdAt: Date;
}

// An attempt outlives its worktree: the row (and the chip subscribed to it) stay
// after worktree-cleanup reaps the directory, so `worktreePath` is a DB-held
// claim about a dir that may be gone. That is the SAME determinate state as "no
// worktree at all" (or no attempt row) — not a failed read — so all collapse
// onto the caller's `gone` value. Checked by catching, not by stat-then-run: a
// reap racing the compute would slip past any pre-check. Every other git
// failure propagates. An attempt with no git (a scratch workspace) is a caller
// bug — the chip is gated on the git capability — so it throws rather than
// reading as "no worktree".
async function onWorktree<T>(
  followed: GraphFollowed,
  gone: T,
  compute: (worktreePath: string, attempt: GraphAttempt) => Promise<T>,
): Promise<T> {
  const attempt = followed.attempt[0];
  if (!attempt) return gone;
  assertCapability(attempt.workspace.kind, "git", "commits-graph");
  const wt = attempt.worktreePath;
  if (!wt) return gone;
  try {
    return await compute(wt, attempt);
  } catch (err) {
    if (!(err instanceof WorktreeGoneError)) throw err;
    evictWorktree(wt);
    return gone;
  }
}

// A db-arm value whose DB reads are its FOLLOWS — the attempt's row (its
// checkout and start) and its conversation set (the landed grep's trailer
// filter), each one collection tuple — so a write reaches only the attempts
// whose rows it moves. It follows those two, not attempt-work's value: the
// wire payload drops the landed shas, and the two share them through
// attempt-work's landed memo (`landedShasFrom`) — one trailer grep.
export const commitsGraphServed = serveValue(commitsGraph, {
  source: "db",
  follows: (follow) => ({
    attempt: follow(attemptWorkspacesServed, ({ attemptId }) => ({
      ids: [attemptId],
    })),
    convIds: follow(attemptConversationIdsServed, ({ attemptId }) => ({
      where: { attemptId },
    })),
  }),
  // A `main` or branch advance recomputes every subscribed attempt — exactly
  // the panes on screen. The landed set is derived from `main`'s own history
  // (attempt-work greps the conversation trailers), so a commit can only join
  // it by landing on `main` — which git-watcher reports — or by a
  // conversation joining the attempt, which the `convIds` follow reports.
  // There is deliberately no pushes dependency: the graph does not read the
  // ledger at all. git-watcher only tracks `main` + this worktree's own
  // branch, so a notify already implies a relevant ref moved — no need to
  // inspect the refName.
  recomputeOn: [refHeadServed],
  loader: ({ attemptId }, { followed }) =>
    onWorktree(
      followed,
      unresolved("worktree unavailable"),
      async (wt, attempt) =>
        resolved(
          await computeGraph(
            wt,
            await landedShasFrom(attemptId, {
              createdAt: attempt.createdAt,
              convIds: followed.convIds.map((c) => c.id),
            }),
          ),
        ),
    ),
  // Cheap ETag over the same followed rows: the graph value derives from
  // (headSha, mainSha, mergeBase, landedShas) of one checkout. mergeBase is a
  // pure function of the two tips (immutable history); the landed set of
  // `main`'s history and the conversation set — so the tips, the conversation
  // ids and the checkout cover every input, with no DB read of its own (an
  // adopted conversation moves the landed set with no ref moving: without its
  // ids here, a stale 304). No worktree ⇒ `unresolved(...)`, so a stable
  // "no-worktree" sentinel keeps that determinate non-value up-to-date — ETag
  // and value are one consistent pair from the SAME `onWorktree` branch,
  // honest ("unknown") rather than an empty graph stand-in. Cost: 1–2 ungated
  // `rev-parse`, vs. the loader's additional `merge-base` and
  // up-to-250-commit `git log`s.
  revalidate: (_params, { followed }) =>
    onWorktree(followed, "no-worktree", async (wt) => {
      const { headSha, mainSha } = await probeHeadMain(wt);
      return graphEtag(
        headSha,
        mainSha,
        followed.convIds.map((c) => c.id),
        wt,
      );
    }),
  // Drop the attempt's landed set once nobody watches the attempt — keyed by
  // attemptId, so it needs no rows and a moved row never restarts it.
  // Dropping a still-referenced entry is harmless — it forces a cheap cold
  // re-probe.
  whileSubscribed:
    ({ attemptId }) =>
    () =>
      evictLandedShas(attemptId),
  // Drop the worktree's git memo once nobody watches it — the checkout this
  // start was handed (`over`, the attempt's path alone): a re-point (the
  // attempt's `worktree_path` moved) drops the old one, and a conversation
  // joining or leaving the attempt restarts nothing.
  whileFollowing: {
    over: (followed) => followed.attempt[0]?.worktreePath ?? null,
    start:
      (_params, { over: wt }) =>
      () => {
        if (wt) evictWorktree(wt);
      },
  },
});
