import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BASELINE_MODELS,
  ConversationModelSchema,
  cliFlagFor,
} from "@plugins/conversations/plugins/model-provider/core";
import type { DayBucket, TieredTokens } from "../../core/buckets";
import { priceBucket, resolveModel, type PriceTable } from "../../core/pricing";
import { loadFallbackPriceTable } from "./litellm-fallback";
import {
  loadPriceTable,
  mergePriceTable,
  parseLiteLlmTable,
  savePriceTable,
} from "./price-table";

// ─── Fixture ─────────────────────────────────────────────────────────────────
//
// A hand-written slice of LiteLLM's `model_prices_and_context_window.json`,
// carrying one of each interesting shape: an untiered model, a tiered one, one
// with the `fast` speed multiplier, a priceless commitment-plan placeholder, and
// a non-Anthropic model that must be filtered out.

const RAW_LITELLM = {
  // Untiered — no `*_above_200k_tokens` at all. This is every model we run today.
  "claude-untiered": {
    litellm_provider: "anthropic",
    input_cost_per_token: 1e-6,
    output_cost_per_token: 1e-5,
    cache_creation_input_token_cost: 2e-6,
    cache_creation_input_token_cost_above_1hr: 4e-6,
    cache_read_input_token_cost: 1e-7,
  },
  // Tiered — carries the long-context rates on every kind.
  "claude-tiered": {
    litellm_provider: "anthropic",
    input_cost_per_token: 1e-6,
    input_cost_per_token_above_200k_tokens: 2e-6,
    output_cost_per_token: 1e-5,
    output_cost_per_token_above_200k_tokens: 2e-5,
    cache_creation_input_token_cost: 2e-6,
    cache_creation_input_token_cost_above_200k_tokens: 4e-6,
    cache_creation_input_token_cost_above_1hr: 3e-6,
    cache_creation_input_token_cost_above_1hr_above_200k_tokens: 6e-6,
    cache_read_input_token_cost: 1e-7,
    cache_read_input_token_cost_above_200k_tokens: 2e-7,
  },
  // Speed multiplier lives under `provider_specific_entry.fast`.
  "claude-speedy": {
    litellm_provider: "anthropic",
    input_cost_per_token: 1e-6,
    output_cost_per_token: 1e-5,
    cache_creation_input_token_cost: 0,
    cache_read_input_token_cost: 0,
    provider_specific_entry: { us: 1.1, fast: 2 },
  },
  // A real LiteLLM shape: a commitment-plan row with context limits and no
  // prices at all. Storing it as all-zero would look like a free model.
  "bedrock/eu-central-1/1-month-commitment/anthropic.claude-v2:1": {
    litellm_provider: "bedrock",
    max_input_tokens: 100_000,
  },
  // Not Anthropic in key or provider — must not reach the persisted table.
  "gpt-5": {
    litellm_provider: "openai",
    input_cost_per_token: 1e-6,
    output_cost_per_token: 1e-5,
  },
};

const FIXTURE: PriceTable = parseLiteLlmTable(RAW_LITELLM, 1_000);

const ZERO: TieredTokens = { below: 0, above: 0 };

function bucket(over: Partial<DayBucket> = {}): DayBucket {
  return {
    date: "2026-08-06",
    model: "claude-untiered",
    speed: "standard",
    input: ZERO,
    output: ZERO,
    cacheRead: ZERO,
    cacheCreate5m: ZERO,
    cacheCreate1h: ZERO,
    ...over,
  };
}

/** Unwrap the ok arm; fails loudly rather than defaulting when it is not ok. */
function cost(b: DayBucket, table: PriceTable = FIXTURE): number {
  const priced = priceBucket(b, table);
  if (!priced.ok)
    throw new Error(
      `expected priced, got ${priced.reason} for ${priced.model}`,
    );
  return priced.cost;
}

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "price-table-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ─── parseLiteLlmTable ───────────────────────────────────────────────────────

test("parse keeps Anthropic models and drops the rest", () => {
  expect(Object.keys(FIXTURE.models).sort()).toEqual([
    "claude-speedy",
    "claude-tiered",
    "claude-untiered",
  ]);
  expect(FIXTURE.fetchedAt).toBe(1_000);
});

test("parse maps the 1h cache-creation rate ccusage's schema omits", () => {
  // The +8.1% divergence: `cache_creation_input_token_cost_above_1hr` is a real
  // field ccusage does not read, so it prices 1h writes at the 5m rate.
  expect(FIXTURE.models["claude-untiered"]?.cacheCreate5m).toBe(2e-6);
  expect(FIXTURE.models["claude-untiered"]?.cacheCreate1h).toBe(4e-6);
  // No 1h field ⇒ the 5m rate, which is what the two were before the split.
  expect(FIXTURE.models["claude-speedy"]?.cacheCreate1h).toBe(0);
});

test("parse leaves untiered rates ABSENT, not zero", () => {
  // `undefined` means "base rate at every token count"; a `0` would mean free.
  const untiered = FIXTURE.models["claude-untiered"];
  expect(untiered).toBeDefined();
  expect("inputAbove200k" in untiered!).toBe(false);
  expect(FIXTURE.models["claude-tiered"]?.inputAbove200k).toBe(2e-6);
  expect(FIXTURE.models["claude-tiered"]?.cacheCreate1hAbove200k).toBe(6e-6);
});

// ─── priceBucket: the arithmetic ─────────────────────────────────────────────

test("untiered kind: below and above recombine at the base rate", () => {
  // No tiered rate ⇒ `(below + above) * base`, i.e. the split is inert.
  const split = cost(bucket({ input: { below: 200_000, above: 300_000 } }));
  const whole = cost(bucket({ input: { below: 500_000, above: 0 } }));
  expect(split).toBeCloseTo(0.5, 12);
  expect(split).toBe(whole);
});

test("tiered kind: below and above are priced by their own rates", () => {
  const c = cost(
    bucket({
      model: "claude-tiered",
      input: { below: 200_000, above: 300_000 },
    }),
  );
  // 200_000 * 1e-6 + 300_000 * 2e-6
  expect(c).toBeCloseTo(0.2 + 0.6, 12);
  // …and this reproduces ccusage's PER-ENTRY tiering exactly: one 500k entry is
  // `min(500k,200k)*base + (500k-200k)*tiered`, which is the same two terms.
});

test("tiered rates apply to every kind, including the 1h cache split", () => {
  const c = cost(
    bucket({
      model: "claude-tiered",
      output: { below: 100_000, above: 50_000 },
      cacheCreate5m: { below: 10_000, above: 5_000 },
      cacheCreate1h: { below: 10_000, above: 5_000 },
      cacheRead: { below: 1_000_000, above: 2_000_000 },
    }),
  );
  const expected =
    100_000 * 1e-5 +
    50_000 * 2e-5 + // output
    10_000 * 2e-6 +
    5_000 * 4e-6 + // 5m create
    10_000 * 3e-6 +
    5_000 * 6e-6 + // 1h create
    1_000_000 * 1e-7 +
    2_000_000 * 2e-7; // cache read
  expect(c).toBeCloseTo(expected, 12);
});

test("the fast multiplier scales the whole bucket, and only when speed is fast", () => {
  const tokens = { input: { below: 1_000_000, above: 0 } };
  const standard = cost(bucket({ model: "claude-speedy", ...tokens }));
  const fast = cost(
    bucket({ model: "claude-speedy", speed: "fast", ...tokens }),
  );
  expect(standard).toBeCloseTo(1, 12);
  expect(fast).toBeCloseTo(2, 12);
  // A model without a `fast` entry is unaffected by the speed dimension.
  const noMultiplier = cost(bucket({ speed: "fast", ...tokens }));
  expect(noMultiplier).toBe(cost(bucket(tokens)));
});

test("ground truth: a realistic opus-5 day, hand-computed", async () => {
  const fallback = await loadFallbackPriceTable();
  // Real rates from the vendored snapshot's entry for this flag:
  //   input 5e-6, output 2.5e-5, cacheCreate5m 6.25e-6, cacheCreate1h 1e-5,
  //   cacheRead 5e-7 — untiered, fast multiplier 2.
  const day = bucket({
    model: cliFlagFor(ConversationModelSchema.parse("opus-5")),
    input: { below: 100_000, above: 0 }, // 100_000 * 5e-6    = 0.50
    output: { below: 20_000, above: 0 }, //  20_000 * 2.5e-5  = 0.50
    cacheCreate5m: { below: 40_000, above: 0 }, //  40_000 * 6.25e-6 = 0.25
    cacheCreate1h: { below: 30_000, above: 0 }, //  30_000 * 1e-5    = 0.30
    cacheRead: { below: 200_000, above: 1_800_000 }, // 2_000_000 * 5e-7 = 1.00
  });
  expect(cost(day, fallback)).toBeCloseTo(2.55, 10);
  // Same day served fast: opus-5 carries `provider_specific_entry.fast = 2`.
  expect(cost({ ...day, speed: "fast" }, fallback)).toBeCloseTo(5.1, 10);
});

// ─── priceBucket: the failure arm ────────────────────────────────────────────

test("an unknown model is a discriminated failure, never a silent $0", () => {
  const priced = priceBucket(
    bucket({
      model: "some-model-nobody-has-priced",
      input: { below: 1_000, above: 0 },
    }),
    FIXTURE,
  );
  expect(priced.ok).toBe(false);
  if (priced.ok) throw new Error("unreachable");
  expect(priced.reason).toBe("unknown-model");
  expect(priced.model).toBe("some-model-nobody-has-priced");
  expect(priced.tokens).toBe(1_000);
});

test("a zero-token unknown model reports tokens: 0 so the caller can suppress it", () => {
  // The `<synthetic>` pseudo-model has all-zero usage; reporting it would be
  // pure noise, so `tokens` is the caller's suppression signal.
  const priced = priceBucket(bucket({ model: "<synthetic>" }), FIXTURE);
  expect(priced.ok).toBe(false);
  if (priced.ok) throw new Error("unreachable");
  expect(priced.tokens).toBe(0);
});

// ─── resolveModel ────────────────────────────────────────────────────────────

test("every baseline model resolves by exact key", async () => {
  // The set is DERIVED from `BASELINE_MODELS`, not restated, so a baseline
  // model without a vendored price — which would send its whole history down
  // `resolveModel`'s substring fallback, or to `unknown-model` — fails here
  // rather than silently. A model discovered at runtime is priced by the daily
  // LiteLLM refresh, and surfaces as a cost-unpriced-model report until it is.
  const fallback = await loadFallbackPriceTable();
  const ids = BASELINE_MODELS.versions.map((v) => v.id);
  expect(ids.length).toBeGreaterThan(0);
  for (const id of ids) {
    const flag = cliFlagFor(id);
    const price = resolveModel(fallback, flag);
    expect(price).not.toBeNull();
    expect(price).toBe(fallback.models[flag]!);
  }
});

test("resolveModel falls back through provider prefixes, then substring, then null", () => {
  const table: PriceTable = {
    fetchedAt: 0,
    models: {
      "anthropic/claude-prefixed": {
        input: 1,
        output: 0,
        cacheCreate5m: 0,
        cacheCreate1h: 0,
        cacheRead: 0,
      },
      "claude-substring-3-7-sonnet": {
        input: 2,
        output: 0,
        cacheCreate5m: 0,
        cacheCreate1h: 0,
        cacheRead: 0,
      },
    },
  };
  // Prefix pass: `anthropic/` + the name.
  expect(resolveModel(table, "claude-prefixed")?.input).toBe(1);
  // Substring pass, table-key-contains-model direction.
  expect(resolveModel(table, "substring-3-7")?.input).toBe(2);
  // Substring pass, model-contains-table-key direction.
  expect(
    resolveModel(table, "claude-substring-3-7-sonnet-20250219")?.input,
  ).toBe(2);
  expect(resolveModel(table, "gemini-3-pro")).toBeNull();
});

// ─── merge ───────────────────────────────────────────────────────────────────

test("merge is a union that never drops a key, and fetched wins on collision", () => {
  const existing: PriceTable = {
    fetchedAt: 100,
    models: {
      // Deprecated upstream — LiteLLM has since pruned it. Years of archived
      // buckets still reference it, so losing it would reprice them to nothing.
      "claude-retired": {
        input: 9,
        output: 0,
        cacheCreate5m: 0,
        cacheCreate1h: 0,
        cacheRead: 0,
      },
      "claude-untiered": {
        input: 1,
        output: 0,
        cacheCreate5m: 0,
        cacheCreate1h: 0,
        cacheRead: 0,
      },
    },
  };
  const fetched: PriceTable = {
    fetchedAt: 200,
    models: {
      "claude-untiered": {
        input: 5,
        output: 0,
        cacheCreate5m: 0,
        cacheCreate1h: 0,
        cacheRead: 0,
      },
      "claude-brand-new": {
        input: 7,
        output: 0,
        cacheCreate5m: 0,
        cacheCreate1h: 0,
        cacheRead: 0,
      },
    },
  };
  const merged = mergePriceTable(existing, fetched);
  expect(Object.keys(merged.models).sort()).toEqual([
    "claude-brand-new",
    "claude-retired",
    "claude-untiered",
  ]);
  expect(merged.models["claude-retired"]?.input).toBe(9); // survived the prune
  expect(merged.models["claude-untiered"]?.input).toBe(5); // fetched wins
  expect(merged.fetchedAt).toBe(200);
});

// ─── persistence ─────────────────────────────────────────────────────────────

test("save then load round-trips", async () => {
  const path = join(dir, "price-table.json");
  await savePriceTable(path, FIXTURE);
  expect(await loadPriceTable(path)).toEqual(FIXTURE);
});

test("an absent file is null, a corrupt one throws", async () => {
  expect(
    await loadPriceTable(join(dir, "nested", "never-written.json")),
  ).toBeNull();

  // Truncated JSON — the classic half-written file.
  const truncated = join(dir, "truncated.json");
  await writeFile(truncated, '{"fetchedAt":1,"models":{"a":', "utf8");
  expect(loadPriceTable(truncated)).rejects.toThrow(/./);

  // Parseable but not a price table. Absorbing this would let the next save
  // overwrite the only record of retired models' prices with a fresh fetch.
  const wrongShape = join(dir, "wrong-shape.json");
  await writeFile(wrongShape, '{"pricedAt":1,"projectCosts":[]}', "utf8");
  expect(loadPriceTable(wrongShape)).rejects.toThrow(/Corrupt price table/);
});
