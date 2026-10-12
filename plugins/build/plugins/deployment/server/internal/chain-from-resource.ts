import { serveValue } from "@plugins/network/plugins/live/server";
import { refHeadServed } from "@plugins/infra/plugins/git/plugins/git-watcher/server";
import { chainFrom, type ChainFrom } from "../../shared/chain-from";
import { chainTo, isAncestor, readTarget } from "./git-chain";

/**
 * The chain from one client-held pin up to HEAD.
 *
 * Every arm that cannot produce a walk says WHY, and the reason is the one the
 * client shows the user — so a tab whose commit was rebased away reads as
 * "rebased away", not as a blank chain.
 *
 * Deliberately not memoized and not behind `withHeavyReadSlot`, for the same
 * reason `computeDeploymentState` is not: this is one `merge-base` probe plus a
 * log walk capped at `CHAIN_CAP`, and it is read only while a human has the
 * Build popover open on a tab that is actually stale.
 *
 * The return type is stated, not inferred: without it TypeScript widens each
 * literal's `kind` to `string`, and the union stops being discriminated.
 */
async function loadChainFrom(commit: string): Promise<ChainFrom> {
  const target = await readTarget();
  if (!target.resolved) return { kind: "unplaceable", reason: target.reason };

  const onLine = await isAncestor(commit, target.value);
  if (!onLine.resolved) return { kind: "unplaceable", reason: onLine.reason };
  if (!onLine.value)
    return {
      kind: "unplaceable",
      reason:
        "this commit is not on the way to HEAD — the checkout was rebased or force-pushed since it was loaded",
    };

  return { kind: "chain", chain: await chainTo(commit, target.value) };
}

/**
 * External: the truth is git (three reads of `REPO_ROOT`, no Postgres). The
 * answer moves only when HEAD does, which is any tracked ref advance — the same
 * edge `deploymentServed` recomputes on — so every subscribed tuple recomputes
 * on `refHeadServed`, and nothing else can change it.
 */
export const chainFromServed = serveValue(chainFrom, {
  source: "external",
  changes: "notified",
  recomputeOn: [refHeadServed],
  loader: ({ commit }) => loadChainFrom(commit),
});
