import type { RunningAccount } from "@plugins/conversations/server";
import type { UsageTokens } from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/core";

/**
 * The account a backfill pass files one counted bucket under, or `null`
 * (unknown) — never a guess.
 *
 * Only the running agent's account, and only for a bucket that starts (an
 * hour's, or a legacy day bucket's midnight) at or after its process started:
 * an agent keeps its account until its process restarts, so every token of
 * that bucket is its own. An earlier bucket may hold another process's tokens,
 * on another account. A take-back (a negative count, a chain re-read) stays
 * unknown too: what it takes back may have been filed under unknown, and the
 * account was never charged it.
 */
export function backfillAccountOf(
  running: RunningAccount | null,
  hour: Date,
  tokens: UsageTokens,
): string | null {
  if (running === null || !(hour >= running.since)) return null;
  const takesBack = Object.values(tokens).some(
    (t) => t.below < 0 || t.above < 0,
  );
  return takesBack ? null : running.account;
}
