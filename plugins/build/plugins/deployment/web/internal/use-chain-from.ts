import { useLive } from "@plugins/network/plugins/live/web";
import type { ResourceError } from "@plugins/primitives/plugins/live-state/core";
import { chainFrom, type ChainFrom } from "../../shared/chain-from";

/**
 * What this client knows about the chain below the server's own.
 *
 * `idle` is a real arm, not an absence: when no carrier sits off the server's
 * chain there is nothing to ask, which is a different state from "asked and
 * still waiting". Collapsing the two is what would make a settled chain flash
 * a loading row on every popover open.
 */
export type ChainFromReading =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "failed"; error: ResourceError; refetch: () => Promise<void> }
  | ChainFrom;

/**
 * The chain from a commit only this browser knows about, up to HEAD — the live
 * `build.chain-from` value, so a HEAD advance while the popover is open redraws
 * it rather than leaving a walk to the old target.
 *
 * `commit === null` means nothing is off-chain, and nothing is read at all.
 */
export function useChainFrom(commit: string | null): ChainFromReading {
  const result = useLive(chainFrom, commit === null ? null : { commit });
  if (commit === null) return { kind: "idle" };
  switch (result.status) {
    case "loading":
      return { kind: "pending" };
    // A failed read is not "unplaceable" — the commit may be perfectly
    // placeable and the read simply did not land — so it gets its own arm.
    case "error":
      return { kind: "failed", error: result.error, refetch: result.refetch };
    case "ready":
      return result.data;
  }
}
