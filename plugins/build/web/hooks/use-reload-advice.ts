import { useFailedPluginPaths } from "@plugins/framework/plugins/web-sdk/core";
import { useResourceContractMismatches } from "@plugins/network/plugins/live/plugins/live-state/web";
import { useStaleFrontend } from "./use-stale-frontend";

/**
 * Whether this tab should be reloaded, and why. Every reason has one answer
 * (reload), so they are one signal:
 *
 * - `stale` — the server now serves a different frontend than the one this tab
 *   is running.
 * - `outdated` — the server refused `count` of this tab's live resources as a
 *   contract mismatch judged `skew`, and this tab is not known to run the
 *   served bundle: it asks for data in a shape the server no longer speaks, so
 *   those reads cannot load until a reload. Stronger than `stale` (something
 *   is already failing), so it wins; `stale` rides along.
 * - `broken` — at least one plugin failed to load in this tab, so part of the
 *   app is missing until a reload re-fetches it. The strongest reason, so it
 *   wins over both; `stale` rides along (an outdated tab is stale too) so the
 *   copy can name both.
 *
 * A `skew` refusal of a tab that runs exactly the served bundle is NOT here:
 * the tab is current, so the server's code is what is behind (a deploy that
 * published the frontend and did not restart the backend onto it), and a
 * reload would fetch the same bundle into the same refusal. That is
 * {@link useServerBehind}'s, which the Build tray states as the server's
 * condition.
 *
 * A plugin that failed during the background (deferred) tier shows NO banner —
 * this is its only app-wide surface. Core-stage failures land in the same set
 * and additionally keep their boot banner. Likewise a resource refused for
 * skew renders only its own failed read; this is what says "reload".
 */
export type ReloadAdvice =
  | { kind: "none" }
  | { kind: "stale" }
  | { kind: "outdated"; stale: boolean; count: number }
  | { kind: "broken"; stale: boolean; failedCount: number };

/**
 * Whether the server's own code is behind the bundle it serves: it refuses
 * `count` resources of a tab that runs exactly that bundle. Cleared as the
 * refused reads are answered — a backend that catches up answers them.
 */
export type ServerBehind = { behind: false } | { behind: true; count: number };

/** The one reading both answers derive from, so they can never disagree. */
function useTabFreshness(): {
  stale: boolean;
  /** Skew refusals while the tab runs the served bundle: the server is behind. */
  serverBehind: number;
  /** Skew refusals the tab's own age explains (or may: its graph is unknown). */
  tabOutdated: number;
} {
  // `stale` / `current` are both false while the deployment is still loading —
  // correct, not a collapse (see useStaleFrontend): neither is knowable yet.
  const { stale, current } = useStaleFrontend();
  // Only `skew`: a same-build or unknown mismatch is a bug neither a reload
  // nor a rebuild fixes, and the server reports it.
  const skew = useResourceContractMismatches().filter(
    (m) => m.verdict === "skew",
  ).length;
  // Until the tab is KNOWN to run the served bundle, a skew refusal keeps its
  // old reading (this tab is out of date): that is what it means by far most
  // often, and the one case the served graph can prove otherwise is `current`.
  return current
    ? { stale, serverBehind: skew, tabOutdated: 0 }
    : { stale, serverBehind: 0, tabOutdated: skew };
}

export function useReloadAdvice(): ReloadAdvice {
  const { stale, tabOutdated } = useTabFreshness();
  const failedPluginPaths = useFailedPluginPaths();
  if (failedPluginPaths.size > 0) {
    return {
      kind: "broken",
      stale: stale || tabOutdated > 0,
      failedCount: failedPluginPaths.size,
    };
  }
  if (tabOutdated > 0) return { kind: "outdated", stale, count: tabOutdated };
  return stale ? { kind: "stale" } : { kind: "none" };
}

export function useServerBehind(): ServerBehind {
  const { serverBehind } = useTabFreshness();
  return serverBehind > 0
    ? { behind: true, count: serverBehind }
    : { behind: false };
}
