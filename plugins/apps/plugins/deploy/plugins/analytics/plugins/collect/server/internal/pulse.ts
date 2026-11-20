import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import {
  PULSE_MINUTES,
  VISITORS_NOW_WINDOW_MS,
  utcDay,
  type VisitorPulse,
} from "../../core";
import type { AnalyticsReadDb } from "./collect";
import { visitorCounts } from "./aggregate-sql";

const CountRow = z.object({ n: z.coerce.number().int() });
const MinuteRow = z.object({
  m: z.coerce.number().int(),
  n: z.coerce.number().int(),
});

/**
 * The site's pulse as of `now` (core's `VisitorPulse`): visitors only, read
 * from the tables wherever they are — the box's own, or the deploy app's copy
 * inside `withReplicaSchema` with the copy's `sourceNow` as `now`. Reads no
 * clock and no table outside the analytics mirror set.
 *
 * Both recent reads start from `analytics_visits (last_at)` (the
 * `analytics_visits_last_at_idx`): the visits active since an instant, then
 * — for the sparkline — their hits of the last hour (`analytics_hits_visit_idx`).
 */
export async function readVisitorPulse(
  dbx: AnalyticsReadDb,
  now: Date,
): Promise<VisitorPulse> {
  const nowIso = now.toISOString();
  const nowAt = sql`${nowIso}::timestamptz`;
  const nowSince = new Date(
    now.getTime() - VISITORS_NOW_WINDOW_MS,
  ).toISOString();
  const [current] = await executeRows(dbx, {
    label: "analytics.pulse.now",
    row: CountRow,
    query: sql`
      SELECT count(DISTINCT visitor_id)::int AS "n"
      FROM analytics_visits
      WHERE last_at > ${nowSince}::timestamptz AND last_at <= ${nowAt} AND NOT owner`,
  });
  // Minute m (0 = the minute ending at `now`) of each hit in the hour
  // `(now - 1h, now]`: every visit with such a hit was active after the
  // hour's start, so `last_at` bounds the visits read.
  const minutes = await executeRows(dbx, {
    label: "analytics.pulse.sparkline",
    row: MinuteRow,
    query: sql`
      WITH v AS (
        SELECT id, visitor_id FROM analytics_visits
        WHERE last_at > ${nowAt} - make_interval(mins => ${PULSE_MINUTES}) AND NOT owner
      )
      SELECT floor(extract(epoch FROM ${nowAt} - h.ts) / 60)::int AS "m",
        count(DISTINCT v.visitor_id)::int AS "n"
      FROM analytics_hits h JOIN v ON h.visit_id = v.id
      WHERE h.ts > ${nowAt} - make_interval(mins => ${PULSE_MINUTES}) AND h.ts <= ${nowAt}
      GROUP BY 1`,
  });
  const sparkline = new Array<number>(PULSE_MINUTES).fill(0);
  for (const { m, n } of minutes) {
    // `h.ts > now - 1h` keeps m in [0, PULSE_MINUTES - 1]; anything else is a broken assumption.
    if (m < 0 || m >= PULSE_MINUTES)
      throw new Error(`analytics: pulse minute ${m} outside the last hour`);
    sparkline[PULSE_MINUTES - 1 - m] = n;
  }
  const today = utcDay(now);
  const [day] = await visitorCounts(dbx, {
    from: today,
    to: today,
    audience: "visitors",
    filters: [],
    source: "raw",
    groupBy: { kind: "total" },
  });
  return {
    visitorsNow: current!.n,
    // No membership row is no visit today: a real zero, not a missing answer.
    visitorsToday: day?.visitors ?? 0,
    sparkline,
    asOf: nowIso,
  };
}
