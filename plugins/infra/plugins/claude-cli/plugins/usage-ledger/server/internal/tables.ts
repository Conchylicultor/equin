import { z } from "zod";
import {
  bigint,
  boolean,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { parsedText } from "@plugins/database/plugins/sql-column/server";
import type { UsageOrigin, UsageSpeed } from "../../core";

const UsageSpeedSchema: z.ZodType<UsageSpeed> = z.enum(["standard", "fast"]);
const UsageOriginSchema: z.ZodType<UsageOrigin> = z.enum([
  "counted",
  "imported",
]);

// ─── The token ledger ─────────────────────────────────────────────────────────
//
// What each Claude account USED, per UTC hour, per source, per model and speed
// — tokens, never dollars. A cost is a read: `claude_spend_hours_v` (the
// `pricing` child) prices each row with the price version in force at its
// hour, so a corrected price reaches every surface and a price change never
// rewrites the past (design: research/2026-11-16-global-unified-claude-cost.md).
//
// The ten token columns are `DayBucket`'s five kinds split at the 200k tier
// (`core/internal/buckets.ts`), so per-entry tiering survives aggregation.
// Whole tokens: a writer rounds its buckets before taking a delta (rounding
// each side, never the difference, so the deltas telescope to the exact
// rounded total). Written only through `usageLedgerUpsert`, which ADDS — a
// delta may be negative (a chain re-read takes tokens back).
//
// `account_id` is `UNKNOWN_ACCOUNT` for usage no pass could attribute.
//
// `origin` (`UsageOrigin`, part of the key) tells what wrote a row: a writer
// counting what it read now (`counted` — the scanners, the call recorder), or
// the one-shot history import (`imported` — the permanent archive of
// transcripts already gone, and the conversations' counts from before the
// ledger; conversations/usage's history import). The scanners' take-backs (a
// session adopted by a conversation, a source recounted whole) reach their own
// `counted` rows only: what was imported describes transcripts no scanner can
// read again, so no scanner may take it back. Readers sum both.
const tokens = (name: string) =>
  bigint(name, { mode: "number" }).notNull().default(0);

export const _claudeUsageHours = pgTable(
  "claude_usage_hours",
  {
    accountId: text("account_id").notNull(),
    /** The UTC hour the tokens were used in (minutes and seconds zero). */
    hour: timestamp("hour", { withTimezone: true }).notNull(),
    /** What used them — `conv:<id>`, `cli:<name>` or `session:<id>` (`SpendSource`). */
    source: text("source").notNull(),
    /** The model string as observed (a transcript's `message.model`, a result's `modelUsage` key). */
    model: text("model").notNull(),
    speed: parsedText("speed", UsageSpeedSchema).notNull(),
    /** What wrote it (`UsageOrigin`): a writer's count, or the history import. */
    origin: parsedText("origin", UsageOriginSchema)
      .notNull()
      .default("counted"),
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
  },
  (t) => [
    primaryKey({
      columns: [t.accountId, t.hour, t.source, t.model, t.speed, t.origin],
    }),
    // The readers' axes: an hour range (account spend, Stats per day), and a
    // source's rows (a conversation's cost, supervisors spend).
    index("claude_usage_hours_hour_idx").on(t.hour),
    index("claude_usage_hours_source_idx").on(t.source),
  ],
);

// One row per ledger source: what the readers need about it without reading
// the transcript corpus — the encoded Claude project dir its transcripts live
// in (`null` for a source with none, a `cli:` call), whether it is equin's own
// spend (Stats' repo scope) and a display title (`null`: the reader names it
// from the source itself, a conversation's live title).
export const _claudeUsageSources = pgTable("claude_usage_sources", {
  source: text("source").primaryKey(),
  projectDir: text("project_dir"),
  isRepo: boolean("is_repo").notNull().default(false),
  title: text("title"),
});
