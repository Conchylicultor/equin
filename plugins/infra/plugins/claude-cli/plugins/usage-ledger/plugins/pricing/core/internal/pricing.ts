import type {
  DayBucket,
  TieredTokens,
} from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/core";

// The pure pricing arithmetic of the cost pipeline: the price-table shape, the
// model-name resolution and the per-bucket price. Loading, fetching and merging
// the table stay server-side (`server/internal/price-table.ts`); this half is
// shared so any plugin pricing token buckets prices them exactly as Stats → Cost.

/**
 * ccusage's `DEFAULT_PROVIDER_PREFIXES` (`:4630-4638`), in order. A model name is
 * looked up verbatim first, then with each of these prepended.
 */
const PROVIDER_PREFIXES = [
  "anthropic/",
  "claude-3-5-",
  "claude-3-",
  "claude-",
  "openai/",
  "azure/",
  "openrouter/openai/",
] as const;

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Per-token rates for one model. `*Above200k` are optional because most models
 * are untiered — `undefined` means "the base rate applies at every token count",
 * which is materially different from a `0` rate.
 */
export interface ModelPrice {
  input: number;
  output: number;
  cacheCreate5m: number;
  cacheCreate1h: number;
  cacheRead: number;
  inputAbove200k?: number;
  outputAbove200k?: number;
  cacheCreate5mAbove200k?: number;
  cacheCreate1hAbove200k?: number;
  cacheReadAbove200k?: number;
  /** Whole-request multiplier applied when the entry was served at `speed: "fast"`. */
  fastMultiplier?: number;
}

/** The persisted price table. `fetchedAt` is a wall-clock ms stamp of the last fetch. */
export interface PriceTable {
  fetchedAt: number;
  models: Record<string, ModelPrice>;
}

/**
 * The result of pricing one bucket. A discriminated result rather than a number,
 * because "we have no price for this model" must NOT be expressible as `$0` — a
 * silent zero is indistinguishable from a genuinely free bucket and would quietly
 * under-report the archive forever. `tokens` is the bucket's total token count so
 * the caller can suppress reporting for all-zero pseudo-models (`<synthetic>`).
 */
export type PricedBucket =
  | { ok: true; cost: number }
  | { ok: false; reason: "unknown-model"; model: string; tokens: number };

// ─── Resolve a model name ────────────────────────────────────────────────────

/**
 * ccusage's `getModelPricing` (`:4722-4735`), reproduced exactly: exact key, then
 * each provider prefix prepended, then a case-insensitive substring match in
 * EITHER direction over the table in insertion order, then `null`.
 *
 * Every model we actually run (`claude-opus-5`, `claude-sonnet-5`,
 * `claude-fable-5`, `claude-opus-4-8`) hits the exact path today; the fallbacks
 * exist for older/renamed keys in years-old archived buckets.
 *
 * `null` is a lookup MISS, not a failure — the caller (`priceBucket`) turns it
 * into the `{ok:false}` arm that must be branched on.
 */
export function resolveModel(
  table: PriceTable,
  modelName: string,
): ModelPrice | null {
  const direct = table.models[modelName];
  if (direct !== undefined) return direct;
  for (const prefix of PROVIDER_PREFIXES) {
    const prefixed = table.models[`${prefix}${modelName}`];
    if (prefixed !== undefined) return prefixed;
  }
  const lower = modelName.toLowerCase();
  for (const [key, value] of Object.entries(table.models)) {
    const comparison = key.toLowerCase();
    if (comparison.includes(lower) || lower.includes(comparison)) return value;
  }
  return null;
}

// ─── Pricing ─────────────────────────────────────────────────────────────────

/**
 * `Σ f(t_i)` for one token kind, from the pre-accumulated tier sums. See
 * `buckets.ts` for why this equals ccusage's per-entry tiering exactly.
 *
 * `tiered === undefined` (the untiered case, which is every Claude model today)
 * means the base rate applies at every token count — so the two sums simply
 * recombine into the total.
 */
function kindCost(
  tokens: TieredTokens,
  base: number,
  tiered: number | undefined,
): number {
  if (tiered !== undefined) return tokens.below * base + tokens.above * tiered;
  return (tokens.below + tokens.above) * base;
}

function bucketTokens(bucket: DayBucket): number {
  return (
    bucket.input.below +
    bucket.input.above +
    bucket.output.below +
    bucket.output.above +
    bucket.cacheRead.below +
    bucket.cacheRead.above +
    bucket.cacheCreate5m.below +
    bucket.cacheCreate5m.above +
    bucket.cacheCreate1h.below +
    bucket.cacheCreate1h.above
  );
}

/**
 * Price one `(date, model, speed)` bucket. The whole arithmetic of the cost
 * pipeline lives here — everything upstream is tokens, everything downstream is
 * summation.
 *
 * An unknown model yields `{ok:false}`, never `$0`.
 */
export function priceBucket(
  bucket: DayBucket,
  table: PriceTable,
): PricedBucket {
  const price = resolveModel(table, bucket.model);
  if (price === null) {
    return {
      ok: false,
      reason: "unknown-model",
      model: bucket.model,
      tokens: bucketTokens(bucket),
    };
  }
  const base =
    kindCost(bucket.input, price.input, price.inputAbove200k) +
    kindCost(bucket.output, price.output, price.outputAbove200k) +
    kindCost(bucket.cacheRead, price.cacheRead, price.cacheReadAbove200k) +
    kindCost(
      bucket.cacheCreate5m,
      price.cacheCreate5m,
      price.cacheCreate5mAbove200k,
    ) +
    kindCost(
      bucket.cacheCreate1h,
      price.cacheCreate1h,
      price.cacheCreate1hAbove200k,
    );
  // A whole-request scalar (ccusage `:4770`), applied after the per-token sum.
  const multiplier = bucket.speed === "fast" ? (price.fastMultiplier ?? 1) : 1;
  return { ok: true, cost: base * multiplier };
}
