import { z } from "zod";
import {
  doublePrecision,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { idColumn } from "@plugins/ids/server";
import {
  parsedJson,
  parsedText,
} from "@plugins/database/plugins/sql-column/server";
import type { UsageSpeed } from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/core";
import {
  ModelPriceSchema,
  PriceVersionSourceSchema,
  priceVersionIdKind,
} from "../../core";

const UsageSpeedSchema: z.ZodType<UsageSpeed> = z.enum(["standard", "fast"]);

// ─── Dated price history ──────────────────────────────────────────────────────
//
// A price version is the price table in force from `effective_from` on: an
// hour of usage is priced with the NEWEST version whose `effective_from` is at
// or before it (`claude_spend_hours_v`). The first version is effective from
// `-infinity` (LiteLLM has no history, so all earlier usage is priced at the
// first table we hold); a refresh that changes any rate records one effective
// now; a correction is a version effective from a past instant.
//
// `effective_from` is read as text (`mode: "string"`): `-infinity` has no JS
// Date. `models` is the whole table the version was recorded from, so a model
// first seen later is resolved (`resolveModel`) against the prices of each
// version's own day, not today's.
export const _claudePriceVersions = pgTable("claude_price_versions", {
  id: idColumn(priceVersionIdKind),
  effectiveFrom: timestamp("effective_from", {
    withTimezone: true,
    mode: "string",
  }).notNull(),
  source: parsedText("source", PriceVersionSourceSchema).notNull(),
  models: parsedJson(
    "models",
    z.record(z.string(), ModelPriceSchema),
  ).notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// One version's per-token rates for one OBSERVED model string (as the ledger
// holds it) and speed — the fuzzy model-name resolution (`resolveModel`) runs
// once, in TS, when the row is written, never per read. Every rate is
// materialized: an untiered model's `_above` rate is its base rate, and a
// `fast` row carries the version's fast multiplier (×1 when it has none), so
// pricing a ledger row is one dot product. A model the version cannot price
// has no row: its cost reads NULL, never $0.
const rate = (name: string) => doublePrecision(name).notNull();

export const _claudeModelRates = pgTable(
  "claude_model_rates",
  {
    versionId: text("version_id")
      .notNull()
      .references(() => _claudePriceVersions.id, { onDelete: "cascade" }),
    model: text("model").notNull(),
    speed: parsedText("speed", UsageSpeedSchema).notNull(),
    inputBelow: rate("input_below"),
    inputAbove: rate("input_above"),
    outputBelow: rate("output_below"),
    outputAbove: rate("output_above"),
    cacheReadBelow: rate("cache_read_below"),
    cacheReadAbove: rate("cache_read_above"),
    cacheCreate5mBelow: rate("cache_create_5m_below"),
    cacheCreate5mAbove: rate("cache_create_5m_above"),
    cacheCreate1hBelow: rate("cache_create_1h_below"),
    cacheCreate1hAbove: rate("cache_create_1h_above"),
  },
  (t) => [primaryKey({ columns: [t.versionId, t.model, t.speed] })],
);
