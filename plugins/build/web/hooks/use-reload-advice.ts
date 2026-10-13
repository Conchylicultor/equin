import { useFailedPluginPaths } from "@plugins/framework/plugins/web-sdk/core";
import { useResourceContractMismatches } from "@plugins/primitives/plugins/live-state/web";
import { useStaleFrontend } from "./use-stale-frontend";

/**
 * Whether this tab should be reloaded, and why. Every reason has one answer
 * (reload), so they are one signal:
 *
 * - `stale` — the server now serves a different frontend than the one this tab
 *   is running.
 * - `outdated` — the server refused `count` of this tab's live resources as a
 *   contract mismatch judged `skew`: this bundle asks for data in a shape the
 *   server no longer speaks, so those reads cannot load until a reload. It is
 *   stronger than `stale` (something is already failing), so it wins;
 *   `stale` rides along.
 * - `broken` — at least one plugin failed to load in this tab, so part of the
 *   app is missing until a reload re-fetches it. The strongest reason, so it
 *   wins over both; `stale` rides along (an outdated tab is stale too) so the
 *   copy can name both.
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

export function useReloadAdvice(): ReloadAdvice {
  // `stale` is false while the deployment is still loading — correct, not a
  // collapse (see useStaleFrontend): staleness is unknowable until then.
  const { stale } = useStaleFrontend();
  const failedPluginPaths = useFailedPluginPaths();
  // Only `skew`: a same-build or unknown mismatch is a bug a reload does not
  // fix, and the server reports it.
  const outdated = useResourceContractMismatches().filter(
    (m) => m.verdict === "skew",
  ).length;
  if (failedPluginPaths.size > 0) {
    return {
      kind: "broken",
      stale: stale || outdated > 0,
      failedCount: failedPluginPaths.size,
    };
  }
  if (outdated > 0) return { kind: "outdated", stale, count: outdated };
  return stale ? { kind: "stale" } : { kind: "none" };
}
