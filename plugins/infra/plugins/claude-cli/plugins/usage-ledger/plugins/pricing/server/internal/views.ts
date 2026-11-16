import { sql } from "drizzle-orm";
import {
  bigint,
  doublePrecision,
  pgView,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { _claudeUsageHours } from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/server";
import { _claudeModelRates, _claudePriceVersions } from "./tables";

// Derived (plain) view — rebuilt from source on every boot (derived-views), so
// it lives here and not in `tables.ts`. See
// plugins/database/plugins/derived-views/CLAUDE.md.
//
// THE one pricing function: every ledger row (`claude_usage_hours`) priced
// with the rates of the NEWEST price version whose `effective_from` is at or
// before the row's hour — so a price change never re-prices the past, and a
// correction (a version effective from a past instant) re-prices exactly the
// hours it covers, on every surface at once.
//
// `cost_usd` is NULL when that version has no rate for the row's model (or no
// version is in force at all) — never 0: an unpriced hour is a fact to report,
// not a free one. `price_version_id` names the version that priced it (NULL
// when none is in force).
const tokens = (name: string) => bigint(name, { mode: "number" }).notNull();

export const claudeSpendHoursView = pgView("claude_spend_hours_v", {
  accountId: text("account_id").notNull(),
  hour: timestamp("hour", { withTimezone: true }).notNull(),
  source: text("source").notNull(),
  model: text("model").notNull(),
  speed: text("speed").notNull(),
  origin: text("origin").notNull(),
  inputBelow: tokens("input_below"),
  inputAbove: tokens("input_above"),
  outputBelow: tokens("output_below"),
  outputAbove: tokens("output_above"),
  cacheReadBelow: tokens("cache_read_below"),
  cacheReadAbove: tokens("cache_read_above"),
  cacheCreate5mBelow: tokens("cache_create_5m_below"),
  cacheCreate5mAbove: tokens("cache_create_5m_above"),
  cacheCreate1hBelow: tokens("cache_create_1h_below"),
  cacheCreate1hAbove: tokens("cache_create_1h_above"),
  priceVersionId: text("price_version_id"),
  costUsd: doublePrecision("cost_usd"),
}).as(
  sql`
    SELECT u.account_id, u.hour, u.source, u.model, u.speed, u.origin,
           u.input_below, u.input_above,
           u.output_below, u.output_above,
           u.cache_read_below, u.cache_read_above,
           u.cache_create_5m_below, u.cache_create_5m_above,
           u.cache_create_1h_below, u.cache_create_1h_above,
           v.id AS price_version_id,
           ( u.input_below           * r.input_below
           + u.input_above           * r.input_above
           + u.output_below          * r.output_below
           + u.output_above          * r.output_above
           + u.cache_read_below      * r.cache_read_below
           + u.cache_read_above      * r.cache_read_above
           + u.cache_create_5m_below * r.cache_create_5m_below
           + u.cache_create_5m_above * r.cache_create_5m_above
           + u.cache_create_1h_below * r.cache_create_1h_below
           + u.cache_create_1h_above * r.cache_create_1h_above
           )::double precision AS cost_usd
      FROM ${_claudeUsageHours} u
      LEFT JOIN LATERAL (
        SELECT pv.id
          FROM ${_claudePriceVersions} pv
         WHERE pv.effective_from <= u.hour
         ORDER BY pv.effective_from DESC, pv.id DESC
         LIMIT 1
      ) v ON true
      LEFT JOIN ${_claudeModelRates} r
        ON r.version_id = v.id AND r.model = u.model AND r.speed = u.speed
  `,
);
