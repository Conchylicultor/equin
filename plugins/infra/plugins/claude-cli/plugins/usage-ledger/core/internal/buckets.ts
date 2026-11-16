// ─── Why the below/above split exists ─────────────────────────────────────────
//
// ccusage applies its 200k tier PER ENTRY: for one token kind with `t` tokens it
// charges `t*base` when `t <= 200k`, else `200k*base + (t-200k)*tiered`
// (`data-loader-9ESMosno.js:4739-4756`). Naively that means cost can only be
// computed while you still hold the individual entries — i.e. at parse time,
// forcing dollars to be baked into the archive.
//
// It is decomposable, because both halves are linear in the entry:
//
//     Σ f(t_i) = base · Σ min(t_i, 200k) + tiered · Σ max(0, t_i − 200k)
//
// So storing the two sums per token kind — `below = Σ min(t,200k)` and
// `above = Σ max(0, t−200k)` — reproduces the EXACT per-entry-tiered cost from
// tokens alone, at rollup, from an aggregate we can accumulate at parse time.
// That is what keeps the archive re-priceable forever instead of freezing
// whatever the price table happened to say the day a transcript was parsed.
//
// The `speed` multiplier is a whole-entry scalar, not a per-token rate, so it
// cannot be folded into these sums — it is a bucket KEY dimension instead.
//
// > Inert on today's corpus, but NOT merely future-proofing. Tiered Claude
// > models already exist — `claude-sonnet-4-5` carries the full set of
// > `*_above_200k_tokens` rates, at 2× the base input rate. It is only that none
// > of the six models present in our transcripts (`claude-opus-4-8`,
// > `claude-opus-5`, `claude-sonnet-5`, `claude-fable-5`, `claude-sonnet-4-6`,
// > `<synthetic>`) is tiered, so `tiered` is undefined and the base rate applies
// > throughout. The decomposition costs 5 extra numbers per bucket and becomes
// > load-bearing the first day anyone runs a tiered model — at which point
// > buckets already written are still priced correctly, because the sums were
// > there all along.

/** Σ min(t, 200k) and Σ max(0, t − 200k) accumulated over entries, per token kind. */
export interface TieredTokens {
  below: number;
  above: number;
}

/** The serving speed a bucket was billed at — a key dimension, not a rate (see above). */
export type UsageSpeed = "standard" | "fast";

/** The five token kinds a usage entry carries, in ledger column order. */
export const TOKEN_KINDS = [
  "input",
  "output",
  "cacheRead",
  "cacheCreate5m",
  "cacheCreate1h",
] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];

/** The two halves of a kind's tier split. */
export const TOKEN_TIERS = ["below", "above"] as const;
export type TokenTier = (typeof TOKEN_TIERS)[number];

/** A bucket's token counts: each kind, split at the tier. */
export type UsageTokens = Record<TokenKind, TieredTokens>;

/**
 * One `(date, model, speed)` token bucket — the unit both the live parse and the
 * permanent archive store, and the unit `priceBucket` prices.
 */
export interface DayBucket {
  date: string; // YYYY-MM-DD
  /**
   * The UTC hour of `date` (0–23) — set on every bucket the fold
   * (`foldUsageEntry`, always per hour) makes from a timestamped entry; absent
   * on a day bucket (the legacy cost archive banked day buckets, and a row
   * counted before the fold kept hours still holds them).
   */
  hour?: number;
  model: string;
  speed: UsageSpeed;
  input: TieredTokens;
  output: TieredTokens;
  cacheRead: TieredTokens;
  cacheCreate5m: TieredTokens;
  cacheCreate1h: TieredTokens;
}

/** The per-entry token count above which a model's `*_above_200k_tokens` rate applies. */
export const TIER_THRESHOLD = 200_000;
