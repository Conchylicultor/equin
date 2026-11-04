import { mkdir, rename, writeFile } from "node:fs/promises";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { dirname } from "node:path";
import { safeFetch } from "@plugins/infra/plugins/safe-fetch/server";
import type { ModelPrice, PriceTable } from "../../core";

// ─── What this is ──────────────────────────────────────────────────────────────
//
// Our OWN copy of the pricing authority, replacing ccusage on the serving path.
//
// This is not a new trust dependency: ccusage's `mode:"auto"` is
// `costUSD ?? computeFromLiteLLMTable`, and `costUSD` is absent from every
// transcript entry we sampled (0 of 5,247) — so ccusage was already pure
// arithmetic over the same LiteLLM table. Owning it removes a 9.8 s / 3.3 GB
// whole-corpus subprocess from the read path and, more importantly, lets us
// KEEP prices for models LiteLLM later drops (see `mergePriceTable`).
//
// The reference implementation this mirrors is ccusage's `LiteLLMPricingFetcher`
// (`node_modules/.bun/ccusage@18.0.11/.../data-loader-9ESMosno.js:4610-4770`);
// `resolveModel` and `priceBucket` (`core/pricing.ts`, pure and shared) reproduce
// its `getModelPricing` and `calculateCostFromPricing` semantics exactly, with ONE
// deliberate divergence documented at `cacheCreate1h` below.

const LITELLM_PRICING_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

// ─── Parse LiteLLM's table ───────────────────────────────────────────────────

/** Read a field as a finite non-negative number, or `undefined` if unusable. */
function num(record: Record<string, unknown>, key: string): number | undefined {
  const v = record[key];
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return undefined;
  return v;
}

/**
 * True for keys we keep. LiteLLM ships ~3,000 models; we persist only the
 * Anthropic-relevant slice to keep the on-disk table small.
 *
 * Deliberately GENEROUS (key OR provider match, every vendor spelling: bare
 * `claude-*`, `anthropic/*`, `bedrock/…anthropic.claude…`, `vertex_ai/claude-*`,
 * regional `eu.anthropic.*` …). An over-filter does not fail loudly — it makes a
 * model unpriceable, and once transcripts age out that history is unrecoverable.
 * A few dozen extra rows cost nothing; a missing one costs the archive.
 */
function isAnthropicRelevant(
  key: string,
  record: Record<string, unknown>,
): boolean {
  const k = key.toLowerCase();
  if (k.includes("claude") || k.includes("anthropic")) return true;
  const provider = record["litellm_provider"];
  return (
    typeof provider === "string" && provider.toLowerCase().includes("anthropic")
  );
}

/**
 * Pure: LiteLLM's `model_prices_and_context_window.json` → our table. `fetchedAt`
 * is injectable so the parse itself has no clock dependency (tests, and the
 * vendored fallback's frozen stamp).
 *
 * Entries that yield no usable rate at all (LiteLLM carries priceless
 * commitment-plan placeholders) are skipped rather than stored as all-zero,
 * which would look like a real free model to `priceBucket`.
 */
export function parseLiteLlmTable(
  json: unknown,
  fetchedAt: number = Date.now(),
): PriceTable {
  if (typeof json !== "object" || json === null) {
    throw new Error("parseLiteLlmTable: expected a JSON object at the root");
  }
  const models: Record<string, ModelPrice> = {};
  for (const [key, value] of Object.entries(json as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const record = value as Record<string, unknown>;
    if (!isAnthropicRelevant(key, record)) continue;

    const input = num(record, "input_cost_per_token");
    const output = num(record, "output_cost_per_token");
    const cacheCreate5m = num(record, "cache_creation_input_token_cost");
    const cacheRead = num(record, "cache_read_input_token_cost");
    // THE DELIBERATE DIVERGENCE FROM ccusage. Its valibot schema (`:4612-4626`)
    // omits `cache_creation_input_token_cost_above_1hr` entirely, so it prices 1h
    // cache writes at the 5m rate — under-reporting by ~$1,136 (+8.1%) on our
    // corpus, where 261M of 661M cache-creation tokens carry a 1h TTL. We price
    // it at its real rate; falling back to the 5m rate only when LiteLLM has no
    // 1h entry (older models, where the two rates were the same anyway).
    const cacheCreate1h =
      num(record, "cache_creation_input_token_cost_above_1hr") ?? cacheCreate5m;

    if (
      input === undefined &&
      output === undefined &&
      cacheCreate5m === undefined &&
      cacheCreate1h === undefined &&
      cacheRead === undefined
    ) {
      continue;
    }

    const psl = record["provider_specific_entry"];
    const fastMultiplier =
      typeof psl === "object" && psl !== null
        ? num(psl as Record<string, unknown>, "fast")
        : undefined;

    // ── Why `?? 0` is not "unknown means free" here ──────────────────────────
    //
    // A `0` standing in for an unknown rate is the absorbable-failure shape the
    // repo bans, so this needs an argument rather than a shrug. Measured against
    // the live table (2,987 models, 258 kept):
    //
    //   • All 25 bare `claude-*` keys — the ONLY keys a Claude Code transcript's
    //     model id resolves to, and always by the exact-match path — carry the
    //     complete rate set. On the resolution path we actually take, no `??`
    //     ever fires.
    //   • The 61 kept entries with a gap are third-party rehosts
    //     (`vertex_ai/…`, `snowflake/…`, `databricks/…`, `openrouter/…`) plus
    //     pre-caching-era models (`claude-v1`, `claude-instant-v1`,
    //     `claude-v2:1`). For the legacy ones the kind genuinely is not billed;
    //     for the rehosts LiteLLM simply omits a rate that IS billed.
    //   • Those keys are reachable only through `resolveModel`'s substring
    //     fallback, i.e. only for a model id we do not recognize at all.
    //
    // So the residual exposure is exactly: an unrecognized model id that
    // substring-matches a reseller key would under-report its cache kinds rather
    // than fail. That is strictly better than the alternative it replaced (the
    // whole entry skipped ⇒ unknown-model ⇒ the bucket's INPUT AND OUTPUT cost
    // lost too), and it is visible — the rate is on disk as `0`, not inferred.
    // If a first-party key ever ships with a gap, the honest fix is to make the
    // five rates optional and give `priceBucket` an `unpriced-kind` arm; today
    // that arm would be unreachable code.
    const price: ModelPrice = {
      input: input ?? 0,
      output: output ?? 0,
      cacheCreate5m: cacheCreate5m ?? 0,
      cacheCreate1h: cacheCreate1h ?? 0,
      cacheRead: cacheRead ?? 0,
    };
    // Assigned conditionally: `undefined` (untiered) must stay ABSENT, not be a
    // present-but-undefined key that `JSON.stringify` drops asymmetrically.
    const inputAbove200k = num(
      record,
      "input_cost_per_token_above_200k_tokens",
    );
    if (inputAbove200k !== undefined) price.inputAbove200k = inputAbove200k;
    const outputAbove200k = num(
      record,
      "output_cost_per_token_above_200k_tokens",
    );
    if (outputAbove200k !== undefined) price.outputAbove200k = outputAbove200k;
    const create5mAbove = num(
      record,
      "cache_creation_input_token_cost_above_200k_tokens",
    );
    if (create5mAbove !== undefined)
      price.cacheCreate5mAbove200k = create5mAbove;
    // LiteLLM DOES carry a distinct 1h × >200k rate (e.g. `claude-sonnet-4-5`:
    // 1.2e-5 vs the 5m tier's 7.5e-6 — the 1.6× 1h premium again). Same fallback
    // chain as the base rate: the 5m tier only when there is no 1h tier, so a
    // model with a long-context tier is never priced as if it had none.
    const create1hAbove =
      num(
        record,
        "cache_creation_input_token_cost_above_1hr_above_200k_tokens",
      ) ?? create5mAbove;
    if (create1hAbove !== undefined)
      price.cacheCreate1hAbove200k = create1hAbove;
    const readAbove = num(
      record,
      "cache_read_input_token_cost_above_200k_tokens",
    );
    if (readAbove !== undefined) price.cacheReadAbove200k = readAbove;
    if (fastMultiplier !== undefined) price.fastMultiplier = fastMultiplier;

    models[key] = price;
  }
  return { fetchedAt, models };
}

// ─── Merge ───────────────────────────────────────────────────────────────────

/**
 * Union of `existing` and `fetched`; fetched values win on collision.
 *
 * **NEVER deletes a key.** The archive spans years. When BerriAI prunes a
 * deprecated model from LiteLLM's table, a merge that mirrored the upstream key
 * set would drop that model's price — and every archived bucket priced by it
 * would silently reprice to `$0` (or, with `priceBucket`, become an
 * unknown-model result) on the next read. Keeping every price we have ever
 * learned IS the deprecated-model story, and it is what replaces ccusage's
 * substring fallback.
 */
export function mergePriceTable(
  existing: PriceTable,
  fetched: PriceTable,
): PriceTable {
  return {
    fetchedAt: Math.max(existing.fetchedAt, fetched.fetchedAt),
    models: { ...existing.models, ...fetched.models },
  };
}

// ─── Persistence ─────────────────────────────────────────────────────────────

/**
 * Read the persisted table. `null` ONLY for a genuinely absent file (ENOENT).
 *
 * A corrupt or unparseable file **throws**. This is deliberately NOT the shape of
 * the old `loadPricing` (`usage-index.ts:139-142`), which returned `undefined` on
 * a `SyntaxError`: that is right for a rebuildable cache and catastrophic here,
 * because the very next save would overwrite a recoverable file — the only record
 * of prices for models LiteLLM has since dropped — with a table rebuilt from
 * upstream alone.
 */
export async function loadPriceTable(path: string): Promise<PriceTable | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return null;
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Corrupt price table at ${path}: expected a JSON object`);
  }
  const { fetchedAt, models } = parsed as Record<string, unknown>;
  if (
    typeof fetchedAt !== "number" ||
    typeof models !== "object" ||
    models === null
  ) {
    throw new Error(`Corrupt price table at ${path}: unexpected shape`);
  }
  return { fetchedAt, models: models as Record<string, ModelPrice> };
}

/**
 * Atomic whole-file snapshot (temp + rename), mirroring `savePricing`
 * (`usage-index.ts:154-161`). A whole-file write, so `sink-safety`'s
 * append-sink rule does not apply.
 */
export async function savePriceTable(
  path: string,
  table: PriceTable,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(table), "utf8");
  await rename(tmp, path);
}

/** Fetch LiteLLM's live table. Throws loudly on a non-ok response. */
export async function fetchPriceTable(): Promise<PriceTable> {
  const res = await safeFetch(LITELLM_PRICING_URL, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(
      `Failed to fetch LiteLLM pricing: ${res.status} ${res.statusText} (${LITELLM_PRICING_URL})`,
    );
  }
  return parseLiteLlmTable(await res.json());
}
