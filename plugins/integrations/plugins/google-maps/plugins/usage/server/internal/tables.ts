import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Places calls made, one row per (billing month, SKU). `usage_key`
 * (`${month}:${sku}`) is the counting upsert's conflict target; `month` is
 * `YYYY-MM` in Google's billing clock (Pacific time). Additive: concurrent
 * calls sum. `last_called_at` is when the latest call was counted — a write
 * stamp, not a derived `updated_at`.
 */
export const _googleMapsUsage = pgTable("google_maps_usage", {
  usageKey: text("usage_key").primaryKey(),
  month: text("month").notNull(),
  sku: text("sku").notNull(),
  calls: integer("calls").notNull().default(0),
  lastCalledAt: timestamp("last_called_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
