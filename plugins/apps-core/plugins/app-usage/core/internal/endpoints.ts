import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

/** A wall-clock day in the user's own timezone, `YYYY-MM-DD`. */
export const LocalDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One (day, app) delta: what happened in that app on that local day since the
 * last flush. Every number is ADDED to the stored row, so a delta is never a
 * total and two flushes of the same day simply sum.
 */
export const AppUsageEntrySchema = z.object({
  day: LocalDaySchema,
  appId: z.string().min(1).max(200),
  launches: z.number().int().min(0).max(100_000),
  // A day holds at most 24h of active time; a larger delta is a tracker bug.
  focusedMs: z.number().int().min(0).max(DAY_MS),
  /** When the latest of `launches` happened; null when `launches` is 0. */
  lastOpenedAt: z.string().datetime().nullable(),
});
export type AppUsageEntry = z.infer<typeof AppUsageEntrySchema>;

export const FlushAppUsageBodySchema = z.object({
  entries: z.array(AppUsageEntrySchema).min(1).max(500),
});
export type FlushAppUsageBody = z.infer<typeof FlushAppUsageBodySchema>;

/**
 * Add a batch of per-(day, app) deltas to `app_usage_daily`, in one additive
 * upsert. Not idempotent by design: each entry IS new usage.
 */
export const flushAppUsageEndpoint = defineEndpoint({
  route: "POST /api/app-usage/flush",
  body: FlushAppUsageBodySchema,
});
