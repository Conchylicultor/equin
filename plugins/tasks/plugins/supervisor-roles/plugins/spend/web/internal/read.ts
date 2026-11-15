import { useMemo } from "react";
import { claudeUsage } from "@plugins/conversations/plugins/runtime-sdk/core";
import { claudeAccounts } from "@plugins/infra/plugins/claude-cli/plugins/accounts/core";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  combineResources,
  mapResource,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import { useNow } from "@plugins/primitives/plugins/relative-time/web";
import {
  supervisorsSpend,
  type SpendBreakdown,
  type SpendNode,
} from "../../core";
import { accountWindows, spendWindows, type AccountWindow } from "./windows";

/** The breakdown and the windows it was counted over. */
export interface SpendRead {
  tree: SpendNode;
  windows: AccountWindow[];
  /** When the ledger began attributing spend, if after a window's start. */
  countedSince: number | null;
}

/**
 * This week's breakdown: the accounts' windows (from their usage readings),
 * then the read over them. Loading until both are known — never a $0 stand-in.
 */
export function useSpend() {
  const accounts = useLive(claudeAccounts);
  const usage = useLive(claudeUsage);
  // A minute's tick: a window moves only at an account's weekly reset or, for
  // a 7-day one, at the hour — the question stays one tuple in between.
  const now = useNow(60_000);
  const windows = useMemo(
    () =>
      accounts.status === "ready" && usage.status === "ready"
        ? accountWindows(accounts.data, usage.data, now)
        : null,
    [accounts, usage, now],
  );
  // A re-tick that moves no window asks the same question: a tuple is its
  // canonical JSON, not the object's identity.
  const query = useMemo(
    () => (windows === null ? null : { windows: spendWindows(windows) }),
    [windows],
  );
  const spend = useLive(supervisorsSpend, query);
  return useMemo(
    () =>
      mapResource(combineResources({ accounts, usage, spend }), (d) =>
        readOf(d.spend, accountWindows(d.accounts, d.usage, now)),
      ),
    [accounts, usage, spend, now],
  );
}

function readOf(spend: SpendBreakdown, windows: AccountWindow[]): SpendRead {
  const first =
    spend.attributedSince === null ? null : Date.parse(spend.attributedSince);
  const earliest = Math.min(...windows.map((w) => w.since));
  return {
    tree: spend.tree,
    windows,
    countedSince: first !== null && first > earliest ? first : null,
  };
}
