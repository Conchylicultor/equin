import {
  bigint,
  boolean,
  date,
  doublePrecision,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

// ─── Stats → Cost's rollups of the priced ledger ──────────────────────────────
//
// What the Stats → Cost values read instead of aggregating every priced hour
// (`claude_spend_hours_v`) on every ledger write: two tables DERIVED from the
// view by the database (`./rollups.ts` — statement-level triggers on the
// ledger, the rates, the price versions and the sources' rows, each
// re-aggregating only the keys a write moved). Costs are the view's (the price
// in force at each hour), summed; an hour the view cannot price adds tokens and
// no dollars, as everywhere.
//
// Migration-managed tables, not `derived-tables` rollups: a rollup's `select`
// may read only declared source TABLES, and the one pricing function is a view
// (see rollups.ts).

const tokens = (name: string) =>
  bigint(name, { mode: "number" }).notNull().default(0);

/**
 * One row per ledger source (`conv:` / `cli:` / `session:`): its whole
 * history's cost and tokens, its last hour, the models it used. The sessions'
 * charts (top sessions, per day of last activity, the distribution) read it,
 * joined to `claude_usage_sources` for the repo scope and a title.
 */
export const _claudeSpendSources = pgTable(
  "claude_spend_sources",
  {
    source: text("source").primaryKey(),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    input: tokens("input"),
    output: tokens("output"),
    /** 5m + 1h cache writes. */
    cacheCreation: tokens("cache_creation"),
    cacheRead: tokens("cache_read"),
    lastHour: timestamp("last_hour", { withTimezone: true }).notNull(),
    models: text("models").array().notNull(),
  },
  // The top sessions: the dearest first.
  (t) => [index("claude_spend_sources_cost_idx").on(t.costUsd)],
);

/**
 * One row per (UTC day, model, repo flag of the source): the day's cost and
 * tokens — `is_repo` is the source's `claude_usage_sources.is_repo` (false
 * with no row), so the repo scope is a filter, the whole scope a sum. A few
 * rows per day of use.
 */
export const _claudeSpendDays = pgTable(
  "claude_spend_days",
  {
    day: date("day", { mode: "string" }).notNull(),
    model: text("model").notNull(),
    isRepo: boolean("is_repo").notNull(),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    input: tokens("input"),
    output: tokens("output"),
    cacheCreation: tokens("cache_creation"),
    cacheRead: tokens("cache_read"),
  },
  (t) => [primaryKey({ columns: [t.day, t.model, t.isRepo] })],
);
