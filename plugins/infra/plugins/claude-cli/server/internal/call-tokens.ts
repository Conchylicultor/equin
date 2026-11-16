import type { ClaudeTurnResult } from "@plugins/infra/plugins/claude-cli/plugins/sdk/server";
import {
  TIER_THRESHOLD,
  type TieredTokens,
  type UsageTokens,
} from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/core";

/** One model's tokens in a recorded call, as the token ledger files them. */
export interface CallModelTokens {
  /** The model string as the result names it (a `modelUsage` key). */
  model: string;
  tokens: UsageTokens;
}

const split = (t: number): TieredTokens => ({
  below: Math.min(t, TIER_THRESHOLD),
  above: Math.max(0, t - TIER_THRESHOLD),
});

/**
 * A turn result's `modelUsage` as token-ledger counts, one entry per model
 * that used any token.
 *
 * - **Cache creation by TTL**: `cacheCreationEphemeral1hInputTokens` is the
 *   1h share; everything else of `cacheCreationInputTokens` is 5m — including
 *   writes whose response reported no lifetime, which the SDK's own `costUSD`
 *   prices at the 5-minute rate too (and all of it on a CLI too old to split).
 * - **The 200k tier** is per API request (`buckets.ts`), but `modelUsage` sums
 *   the call's requests, so it is applied to each model's totals: exact for
 *   the one request a tool-less generation makes, an upper bound on the
 *   `above` share for a call that made several. Cache creation is tiered on
 *   its combined count and apportioned between 5m and 1h, as the transcript
 *   fold does — rounded to whole tokens, the 1h side taking the remainder.
 */
export function callModelTokens(
  modelUsage: ClaudeTurnResult["modelUsage"],
): CallModelTokens[] {
  const out: CallModelTokens[] = [];
  for (const [model, u] of Object.entries(modelUsage)) {
    const create = u.cacheCreationInputTokens;
    const create1h = Math.min(
      u.cacheCreationEphemeral1hInputTokens ?? 0,
      create,
    );
    const create5m = create - create1h;
    const { below, above } = split(create);
    const below5m = create > 0 ? Math.round((below * create5m) / create) : 0;
    const above5m = create5m - below5m;
    const tokens: UsageTokens = {
      input: split(u.inputTokens),
      output: split(u.outputTokens),
      cacheRead: split(u.cacheReadInputTokens),
      cacheCreate5m: { below: below5m, above: above5m },
      cacheCreate1h: { below: below - below5m, above: above - above5m },
    };
    const used =
      u.inputTokens + u.outputTokens + u.cacheReadInputTokens + create > 0;
    if (used) out.push({ model, tokens });
  }
  return out;
}
