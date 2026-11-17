import { useFailedPluginPaths } from "@plugins/framework/plugins/web-sdk/core";
import { useResourceContractMismatches } from "@plugins/network/plugins/live/plugins/live-state/web";
import { useStaleFrontend } from "./use-stale-frontend";

/**
 * The version this tab runs against the version the server serves — the one
 * reading the update policy (`UpdatePolicyRoot`), the Update pill and the Build
 * tray all derive from, so they can never disagree.
 *
 * - `current` — nothing to do: the tab runs the served build, or the served
 *   build is not known yet (unknown is never a reason to reload).
 * - `available` — the server serves a newer build and nothing in this tab
 *   fails because of it. An update, not a fault: the policy reloads at a safe
 *   moment (hidden, or idle), never asking.
 * - `required` — the old build already fails here, and the version change
 *   explains it: the server refused `count` of this tab's live resources as
 *   `skew` (`outdated`), or plugins failed to load in a tab that runs an older
 *   build than the one served (`missing-plugins` — the files it needs belong
 *   to a retired build). Still an update: the policy reloads as soon as no
 *   process holds the page.
 * - `fault` — plugins failed to load and NO version change explains it: the
 *   tab is not known to run an older build. A real bug, reported by the
 *   loader (`plugin-load`); a reload is only a retry.
 *
 * `target` is the served build's graph the update moves to — `null` when only
 * the server's refusals (not its graph) say the tab is behind.
 *
 * A `skew` refusal of a tab that runs exactly the served bundle is NOT here:
 * the tab is current, so the server's code is what is behind (a deploy that
 * published the frontend and did not restart the backend onto it), and a
 * reload would fetch the same bundle into the same refusal. That is
 * {@link useServerBehind}'s, which the Build tray states as the server's
 * condition.
 */
export type TabUpdate =
  | { kind: "current" }
  | { kind: "available"; target: string }
  | {
      kind: "required";
      why: "outdated" | "missing-plugins";
      count: number;
      target: string | null;
    }
  | { kind: "fault"; failedPaths: readonly string[] };

/** A tab update the policy acts on — a newer build is served. */
export type PendingUpdate = Extract<
  TabUpdate,
  { kind: "available" } | { kind: "required" }
>;

/**
 * Whether the server's own code is behind the bundle it serves: it refuses
 * `count` resources of a tab that runs exactly that bundle. Cleared as the
 * refused reads are answered — a backend that catches up answers them.
 */
export type ServerBehind = { behind: false } | { behind: true; count: number };

/** The one reading both answers derive from, so they can never disagree. */
function useTabFreshness(): {
  stale: boolean;
  serverGraph: string | null;
  /** Skew refusals while the tab runs the served bundle: the server is behind. */
  serverBehind: number;
  /** Skew refusals the tab's own age explains (or may: its graph is unknown). */
  tabOutdated: number;
} {
  // `stale` / `current` are both false while the deployment is still loading —
  // correct, not a collapse (see useStaleFrontend): neither is knowable yet.
  const { stale, current, serverGraph } = useStaleFrontend();
  // Only `skew`: a same-build or unknown mismatch is a bug neither a reload
  // nor a rebuild fixes, and the server reports it.
  const skew = useResourceContractMismatches().filter(
    (m) => m.verdict === "skew",
  ).length;
  // Until the tab is KNOWN to run the served bundle, a skew refusal keeps its
  // old reading (this tab is out of date): that is what it means by far most
  // often, and the one case the served graph can prove otherwise is `current`.
  return current
    ? { stale, serverGraph, serverBehind: skew, tabOutdated: 0 }
    : { stale, serverGraph, serverBehind: 0, tabOutdated: skew };
}

export function useTabUpdate(): TabUpdate {
  const { stale, serverGraph, tabOutdated } = useTabFreshness();
  const failedPluginPaths = useFailedPluginPaths();
  const target = stale ? serverGraph : null;
  const behind = stale || tabOutdated > 0;
  if (failedPluginPaths.size > 0) {
    return behind
      ? {
          kind: "required",
          why: "missing-plugins",
          count: failedPluginPaths.size,
          target,
        }
      : { kind: "fault", failedPaths: [...failedPluginPaths].sort() };
  }
  if (tabOutdated > 0) {
    return { kind: "required", why: "outdated", count: tabOutdated, target };
  }
  return stale && serverGraph !== null
    ? { kind: "available", target: serverGraph }
    : { kind: "current" };
}

export function useServerBehind(): ServerBehind {
  const { serverBehind } = useTabFreshness();
  return serverBehind > 0
    ? { behind: true, count: serverBehind }
    : { behind: false };
}
