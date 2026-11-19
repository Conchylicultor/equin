import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@plugins/database/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";

/**
 * The report history since `sinceDay` (inclusive, UTC `YYYY-MM-DD`), from the
 * trend tables (./tables.ts) the triggers fill (./trend-triggers.ts).
 *
 * - `occurrences`: per day and kind, from the day the triggers were installed
 *   (2026-11-19). Earlier days are not known: `hourly` keeps 24 hours.
 * - `newCauses`: fingerprints by the day they were first seen — the seen set,
 *   joined with the live `reports` rows so the week before the triggers is
 *   counted too (a report row lives 7 days).
 * - `fixes`: per landing day and kind, fixes landed and how many of them came
 *   back since (a cohort). A day
 *   reads the larger of the counter and the ledger rows still alive — before
 *   the triggers the counter is 0, after them the ledger can only have lost
 *   rows (a report's fixes leave with it).
 */
export async function loadReportTrend(sinceDay: string): Promise<ReportTrend> {
  // A UTC instant as a parameter: the session runs in the machine's own zone,
  // so `'…'::date::timestamptz` would be local midnight.
  const since = new Date(`${sinceDay}T00:00:00Z`);
  // The day the history tables began: the first occurrence day they hold.
  const startRows = await executeRows(db, {
    label: "reports:trend-start",
    row: z.object({ day: z.string().nullable() }),
    query: sql`SELECT min(day)::text AS day FROM report_trend_days`,
  });
  const historyFrom = startRows[0]?.day ?? null;
  const occurrences = await executeRows(db, {
    label: "reports:trend-occurrences",
    row: z.object({
      day: z.string(),
      kind: z.string(),
      n: z.coerce.number(),
    }),
    query: sql`
      SELECT day::text AS day, kind, occurrences AS n
      FROM report_trend_days WHERE day >= ${sinceDay}::date
      ORDER BY day, kind`,
  });
  const newCauses = await executeRows(db, {
    label: "reports:trend-new-causes",
    row: z.object({
      day: z.string(),
      kind: z.string(),
      n: z.coerce.number(),
    }),
    query: sql`
      -- Bounded by first_seen_at on both sides (an index on the seen set; the
      -- reports table is itself bounded by its 7-day retention): a cause is
      -- new in the window when nothing saw it before the window began.
      WITH firsts AS (
        SELECT s.fingerprint, s.kind, s.first_seen_at
        FROM report_fingerprints_seen s
        WHERE s.first_seen_at >= ${since}
        UNION ALL
        SELECT r.fingerprint, r.kind, r.first_seen_at
        FROM reports r
        WHERE r.first_seen_at >= ${since}
          AND NOT EXISTS (
            SELECT 1 FROM report_fingerprints_seen s
            WHERE s.fingerprint = r.fingerprint AND s.first_seen_at < ${since})
      ),
      per_cause AS (
        SELECT fingerprint, min(kind) AS kind, min(first_seen_at) AS first_seen_at
        FROM firsts GROUP BY fingerprint
      )
      SELECT (first_seen_at AT TIME ZONE 'UTC')::date::text AS day, kind,
             count(*)::int4 AS n
      FROM per_cause
      GROUP BY 1, 2 ORDER BY 1, 2`,
  });
  const fixes = await executeRows(db, {
    label: "reports:trend-fixes",
    row: z.object({
      day: z.string(),
      kind: z.string(),
      landed: z.coerce.number(),
      regressed: z.coerce.number(),
    }),
    query: sql`
      WITH live AS (
        SELECT (f.landed_at AT TIME ZONE 'UTC')::date AS day, r.kind,
               1 AS landed, 0 AS regressed
        FROM report_fixes f JOIN reports r ON r.id = f.report_id
        WHERE f.landed_at >= ${since}
        UNION ALL
        SELECT (f.landed_at AT TIME ZONE 'UTC')::date, r.kind, 0, 1
        FROM report_fixes f JOIN reports r ON r.id = f.report_id
        WHERE f.landed_at >= ${since} AND f.regressed_at IS NOT NULL
      ),
      live_days AS (
        SELECT day, kind, sum(landed)::int4 AS landed,
               sum(regressed)::int4 AS regressed
        FROM live GROUP BY day, kind
      )
      SELECT coalesce(c.day, l.day)::text AS day,
             coalesce(c.kind, l.kind) AS kind,
             greatest(coalesce(c.landed, 0), coalesce(l.landed, 0)) AS landed,
             greatest(coalesce(c.regressed, 0), coalesce(l.regressed, 0)) AS regressed
      FROM (SELECT * FROM report_fix_days WHERE day >= ${sinceDay}::date) c
      FULL JOIN live_days l ON l.day = c.day AND l.kind = c.kind
      ORDER BY 1, 2`,
  });
  return {
    historyFrom,
    occurrences: occurrences.map((r) => ({
      day: r.day,
      kind: r.kind,
      count: r.n,
    })),
    newCauses: newCauses.map((r) => ({ day: r.day, kind: r.kind, count: r.n })),
    fixes,
  };
}

export interface ReportTrend {
  /**
   * The first day the history tables hold (the triggers' install day), or null
   * before any. Occurrences are known from the day AFTER it (it is partial);
   * new causes and the fix counts from 7 days before it (the oldest report rows
   * alive then) — earlier days are undercounts, never zeros to plot.
   */
  historyFrom: string | null;
  occurrences: { day: string; kind: string; count: number }[];
  newCauses: { day: string; kind: string; count: number }[];
  /**
   * Per day the fixes LANDED and the fixed report's kind: how many landed, and
   * how many of those have come back since (a cohort, so it can still grow).
   */
  fixes: { day: string; kind: string; landed: number; regressed: number }[];
}
