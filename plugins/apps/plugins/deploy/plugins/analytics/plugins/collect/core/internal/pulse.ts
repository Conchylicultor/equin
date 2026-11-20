import { z } from "zod";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";

/** How far back "visitors now" looks: a visit active within it is someone on the site. */
export const VISITORS_NOW_WINDOW_MS = 5 * 60 * 1000;

/** How many one-minute buckets the pulse's sparkline holds: the last hour. */
export const PULSE_MINUTES = 60;

/**
 * The site's pulse as of an instant `asOf` (the box's clock — on a copy, the
 * last page synced): the visitors only (the owner's own visits never count).
 *
 * - `visitorsNow` — distinct visitors with any activity (a pageview, an
 *   event, an engagement beacon) in the last {@link VISITORS_NOW_WINDOW_MS}.
 * - `visitorsToday` — distinct visitors of the UTC day of `asOf`, the report's
 *   own count (`visitorCounts` on the raw visits of that day).
 * - `sparkline` — {@link PULSE_MINUTES} per-minute distinct-visitor counts,
 *   oldest first, the last one the minute ending at `asOf`: a visitor counts
 *   in each minute they had a pageview or an event in.
 */
export const VisitorPulseSchema = z
  .object({
    visitorsNow: z.number().int().nonnegative(),
    visitorsToday: z.number().int().nonnegative(),
    sparkline: cappedList(z.number().int().nonnegative(), {
      max: PULSE_MINUTES,
    }).min(PULSE_MINUTES),
    /** ISO instant the numbers are as of. */
    asOf: z.string(),
  })
  .strict();
export type VisitorPulse = z.infer<typeof VisitorPulseSchema>;
