import { z } from "zod";

/**
 * Dimensions an analytics report breaks visits down by — a CLOSED list.
 *
 * Two kinds, because they attach to visits differently:
 * - a **visit dimension** has exactly one value per visit (its entry page, its
 *   channel, its browser…), read from one column of `analytics_visits`;
 * - a **hit dimension** can have several values per visit (every page it
 *   viewed, every event it fired, every prop those events carried), read from
 *   `analytics_hits`. `event_prop` values are `<event>.<key>=<value>`
 *   (`event-prop.ts`): one event name with a prop (which card was opened)
 *   counts once in `event`, and breaks down here.
 *
 * Every dimension is also a filter: a filter `(dimension, value)` keeps the
 * visits that HAVE that value — for a hit dimension, visits with at least one
 * such hit.
 */
export const VISIT_DIMENSIONS = [
  "entry_page",
  "exit_page",
  "channel",
  "referrer_host",
  "referrer_path",
  "utm_campaign",
  "country",
  "language",
  "device",
  "browser",
  "os",
] as const;
export type VisitDimension = (typeof VISIT_DIMENSIONS)[number];

export const HIT_DIMENSIONS = ["page", "event", "event_prop"] as const;
export type HitDimension = (typeof HIT_DIMENSIONS)[number];

export const DIMENSIONS = [...HIT_DIMENSIONS, ...VISIT_DIMENSIONS] as const;
export const DimensionSchema = z.enum(DIMENSIONS);
export type Dimension = z.infer<typeof DimensionSchema>;

/**
 * The value a visit dimension takes when the visit has nothing to record
 * there: no referrer, no campaign, no language header, no country yet. A real
 * value so it can be counted, shown ("(none)") and filtered on like any other.
 */
export const NONE_VALUE = "(none)";

/**
 * The `analytics_daily` row that summarises the whole level: `dimension =
 * "total"`, `value = ""`. It is also the chart's series.
 */
export const TOTAL_DIMENSION = "total";
export const DailyDimensionSchema = z.enum([...DIMENSIONS, TOTAL_DIMENSION]);
export type DailyDimension = z.infer<typeof DailyDimensionSchema>;

/**
 * The `analytics_daily` filter level that is not filtered at all:
 * `filter_dim = "none"`, `filter_value = ""`.
 */
export const UNFILTERED_LEVEL = "none";
export const FilterLevelSchema = z.enum([...DIMENSIONS, UNFILTERED_LEVEL]);
export type FilterLevel = z.infer<typeof FilterLevelSchema>;
