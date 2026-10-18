import { defineRefReaction } from "@plugins/infra/plugins/git/plugins/git-watcher/server";
import { ensurePushLedgerFresh } from "./freshness";

/**
 * The PUSH half of the ledger's freshness: re-derive it the instant
 * `refs/heads/main` moves, in-process, in every backend.
 *
 * It is a reaction rather than a job on purpose. The durable `git.refAdvanced`
 * event is `isMain()`-gated, so a job hung off it never runs in a worktree
 * backend at all — which is why those ledgers sat frozen at fork time. And it
 * would reach the work through two hops of a graphile pool shared with DB forks,
 * builds and agent spawns, so a 150 ms git read could queue behind minutes of
 * unrelated work. Neither is acceptable for a fact the task list derives status
 * from.
 *
 * Nothing here needs durability: `ensurePushLedgerFresh` re-derives on read and
 * at boot, so a reaction that is skipped or throws costs latency only.
 */
export const pushLedgerReaction = defineRefReaction({
  name: "tasks.push-ledger",
  refName: "refs/heads/main",
  run: async () => {
    await ensurePushLedgerFresh();
  },
});
