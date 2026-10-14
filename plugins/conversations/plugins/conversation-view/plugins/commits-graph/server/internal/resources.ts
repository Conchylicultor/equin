import { serveValue } from "@plugins/network/plugins/live/server";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { WorktreeGoneError } from "@plugins/primitives/plugins/commit-list/server";
import {
  resolved,
  unresolved,
} from "@plugins/primitives/plugins/live-state/core";
import { refHeadServed } from "@plugins/infra/plugins/git/plugins/git-watcher/server";
import { getAttemptRow } from "@plugins/tasks/plugins/tasks-core/server";
import { assertCapability } from "@plugins/conversations/plugins/workspace/core";
import {
  probeHeadMain,
  readLandedShas,
} from "@plugins/tasks/plugins/attempt-work/server";
import { commitsGraph } from "../../shared/resources";
import { computeGraph, evictWorktree } from "./compute-graph";
import { graphEtag } from "./etag";

// The attempt's own row (the `attempts` table), never `attempts_v`: this
// loader does git work, and the view's read-set would make every conversation
// and push write recompute it (C36). An attempt with no git (a scratch
// workspace) is a caller bug — the chip is gated on the git capability — so it
// throws rather than reading as "no worktree".
async function worktreeFor(attemptId: string): Promise<string | null> {
  const row = await getAttemptRow(attemptId);
  if (!row) return null;
  assertCapability(row.workspace.kind, "git", "commits-graph");
  return row.worktreePath;
}

// An attempt outlives its worktree: the row (and the chip subscribed to it) stay
// after worktree-cleanup reaps the directory, so `worktreePath` is a DB-held
// claim about a dir that may be gone. That is the SAME determinate state as "no
// worktree at all" — not a failed read — so both collapse onto the caller's
// `gone` value. Checked by catching, not by stat-then-run: a reap racing the
// compute would slip past any pre-check. Every other git failure propagates.
async function onWorktree<T>(
  attemptId: string,
  gone: T,
  compute: (worktreePath: string) => Promise<T>,
): Promise<T> {
  const wt = await worktreeFor(attemptId);
  if (!wt) return gone;
  try {
    return await compute(wt);
  } catch (err) {
    if (!(err instanceof WorktreeGoneError)) throw err;
    evictWorktree(wt);
    return gone;
  }
}

// The `whileSubscribed` stop is sync while `worktreeFor` is async, so drop the
// cache entry fire-and-forget. Dropping a still-referenced entry is harmless — it
// just forces a cheap cold re-probe on the next read — so no coordination is
// needed.
function evictWorktreeFor(attemptId: string): void {
  void runTracked("commits-graph:evict", () =>
    worktreeFor(attemptId).then((wt) => {
      if (wt) evictWorktree(wt);
    }),
  );
}

// A db-arm value: the loader's DB read (the attempt row's worktree path) is
// captured by the change feed, and a git ref advance (local commit / rebase /
// sync-to-head, or main moving) changes the graph of every visible attempt.
export const commitsGraphServed = serveValue(commitsGraph, {
  source: "db",
  // A `main` or branch advance is the COMPLETE refresh signal, and the bare form
  // recomputes every subscribed attempt — exactly the panes on screen. The landed
  // set is derived from `main`'s own history (attempt-work greps the
  // Singularity-Conversation trailers), so a commit can only join it by landing
  // on `main` — which git-watcher reports. There is deliberately no pushes
  // dependency: the graph does not read the ledger at all. git-watcher only
  // tracks `main` + this worktree's own branch, so a notify already implies a
  // relevant ref moved — no need to inspect the refName.
  recomputeOn: [refHeadServed],
  loader: ({ attemptId }) =>
    onWorktree(attemptId, unresolved("worktree unavailable"), async (wt) =>
      // `readLandedShas` THROWS on an unmeasurable standing rather than returning
      // `[]` (which would be indistinguishable from "this attempt landed
      // nothing"). It is unmeasurable only when the attempt row is gone — the very
      // state `onWorktree`'s `worktreeFor` lookup just excluded — so the only way
      // to reach the throw is a delete racing this compute. That gets the same
      // treatment as every other racing failure here: it propagates, and the
      // error gate keeps the client on its last vouched-for value.
      resolved(await computeGraph(wt, await readLandedShas(attemptId))),
    ),
  // Cheap ETag: the graph value derives from (headSha, mainSha, mergeBase,
  // landedShas). mergeBase is a pure function of the two tips (immutable history),
  // and the landed set can only grow by a commit landing on `main`, so both tips
  // cover every input — no DB read, and no separate landed-shas dimension. No
  // worktree ⇒ `unresolved(...)`, so a stable "no-worktree" sentinel keeps that
  // determinate non-value up-to-date — ETag and value are one consistent pair
  // from the SAME `onWorktree` branch, honest ("unknown") rather than an empty
  // graph stand-in. Cost: 1–2 ungated `rev-parse`, vs. the loader's additional
  // `merge-base` and up-to-250-commit `git log`s.
  revalidate: ({ attemptId }) =>
    onWorktree(attemptId, "no-worktree", async (wt) => {
      const { headSha, mainSha } = await probeHeadMain(wt);
      return graphEtag(headSha, mainSha);
    }),
  // Drop the worktree's git memo once nobody watches the attempt.
  whileSubscribed:
    ({ attemptId }) =>
    () =>
      evictWorktreeFor(attemptId),
});
