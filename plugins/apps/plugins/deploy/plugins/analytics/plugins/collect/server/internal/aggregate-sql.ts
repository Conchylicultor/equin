import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import {
  DailyDimensionSchema,
  NONE_VALUE,
  TOTAL_DIMENSION,
  UNFILTERED_LEVEL,
  VISIT_DIMENSIONS,
  type AdditiveMetrics,
  type AnalyticsFilter,
  type DailyDimension,
  type Granularity,
  type VisitDimension,
} from "../../core";
import type { AnalyticsDb } from "./collect";
import { analyticsVisits } from "./tables";

/**
 * The ONE definition of "which (dimension, value) pairs a visit has, and what
 * it contributes to each". Every aggregate — the nightly rollup at every filter
 * level, the raw report, the hourly chart — is built on it, which is what makes
 * a report read from the daily totals agree with the same report computed
 * from raw rows.
 *
 * `m(visit_id, dim, value, pageviews, duration_ms, events)` holds:
 * - `('none', '')` and `('total', '')` for every visit — the unfiltered level
 *   and the summary line;
 * - one row per visit dimension, `NULL` spelled {@link NONE_VALUE};
 * - `('page', path)` per distinct path the visit hit, contributing that page's
 *   views, visible time and events;
 * - `('event', name)` per distinct event, contributing that event's count.
 */

// Closed constants, validated, so they can be inlined as literals: a bound
// parameter in a VALUES list has no type for Postgres to resolve.
function literal(dim: string): SQL {
  if (!/^[a-z_]+$/.test(dim))
    throw new Error(`analytics: bad dimension literal ${dim}`);
  return sql.raw(`'${dim}'::text`);
}

const VISIT_DIMENSION_COLUMN: Record<VisitDimension, string> = {
  entry_page: analyticsVisits.entryPath.name,
  exit_page: analyticsVisits.exitPath.name,
  channel: analyticsVisits.channel.name,
  referrer_host: analyticsVisits.referrerHost.name,
  referrer_path: analyticsVisits.referrerPath.name,
  utm_campaign: analyticsVisits.utmCampaign.name,
  country: analyticsVisits.country.name,
  language: analyticsVisits.language.name,
  device: analyticsVisits.device.name,
  browser: analyticsVisits.browser.name,
  os: analyticsVisits.os.name,
};

const membershipValues = sql.join(
  [
    sql`(${literal(UNFILTERED_LEVEL)}, ''::text)`,
    sql`(${literal(TOTAL_DIMENSION)}, ''::text)`,
    ...VISIT_DIMENSIONS.map(
      (dim) =>
        sql`(${literal(dim)}, b.${sql.raw(VISIT_DIMENSION_COLUMN[dim])}::text)`,
    ),
  ],
  sql`, `,
);

/**
 * `base` (the visits matching `where`, over alias `v`, with their duration)
 * and `m` (their memberships). Continue the WITH list after it.
 */
function visitsAndMemberships(where: SQL): SQL {
  return sql`
    base AS (
      SELECT v.*,
        (GREATEST(EXTRACT(EPOCH FROM (v.exit_at - v.started_at)) * 1000, 0))::bigint
          + v.exit_engaged_ms AS duration_ms
      FROM analytics_visits v
      WHERE ${where}
    ),
    m AS (
      SELECT b.id AS visit_id, x.dim, COALESCE(x.value, ${NONE_VALUE}::text) AS value,
        b.pageviews::bigint AS pageviews, b.duration_ms, b.events::bigint AS events
      FROM base b CROSS JOIN LATERAL (VALUES ${membershipValues}) AS x(dim, value)
      UNION ALL
      SELECT h.visit_id, ${literal("page")}, h.path,
        count(*) FILTER (WHERE h.kind = 'pageview'),
        COALESCE(sum(h.engaged_ms) FILTER (WHERE h.kind = 'pageview'), 0)::bigint,
        count(*) FILTER (WHERE h.kind = 'event')
      FROM analytics_hits h JOIN base b ON b.id = h.visit_id
      GROUP BY h.visit_id, h.path
      UNION ALL
      SELECT h.visit_id, ${literal("event")}, h.event_name,
        b.pageviews::bigint, b.duration_ms, count(*)
      FROM analytics_hits h JOIN base b ON b.id = h.visit_id
      WHERE h.kind = 'event'
      GROUP BY h.visit_id, h.event_name, b.pageviews, b.duration_ms
    )`;
}

/**
 * The additive metric columns, over membership alias `mm` and visit alias `k`.
 * Unique visitors are not among them: they do not add up across days, and are
 * counted by {@link visitorCounts} over the whole span instead.
 */
const metricColumns = sql`
  count(DISTINCT k.id)::int AS "visits",
  sum(mm.pageviews)::int AS "pageviews",
  (count(DISTINCT k.id) FILTER (WHERE k.pageviews = 1))::int AS "bounces",
  (count(DISTINCT k.id) FILTER (WHERE k.returning))::int AS "returningVisits",
  sum(mm.duration_ms)::bigint AS "durationMs",
  sum(mm.events)::int AS "events"`;

const MetricsRow = {
  visits: z.coerce.number().int(),
  pageviews: z.coerce.number().int(),
  bounces: z.coerce.number().int(),
  returningVisits: z.coerce.number().int(),
  durationMs: z.coerce.number().int(),
  events: z.coerce.number().int(),
};

export function metricsOf(row: AdditiveMetrics): AdditiveMetrics {
  return {
    visits: row.visits,
    pageviews: row.pageviews,
    bounces: row.bounces,
    returningVisits: row.returningVisits,
    durationMs: row.durationMs,
    events: row.events,
  };
}

const DailyRowSchema = z.object({
  key: z.string(),
  dimension: DailyDimensionSchema,
  value: z.string(),
  ...MetricsRow,
});
/** Additive metrics of one (key, dimension, value); `key` is a UTC day or an hour bucket. */
export type KeyedRow = z.infer<typeof DailyRowSchema>;

/** Keep the visits that have EVERY filter's value. */
function keptVisits(filters: readonly AnalyticsFilter[]): SQL {
  const conditions = filters.map(
    (f) =>
      sql`EXISTS (SELECT 1 FROM m mf WHERE mf.visit_id = b.id AND mf.dim = ${f.dimension} AND mf.value = ${f.value})`,
  );
  return sql`kept AS (
    SELECT b.* FROM base b
    WHERE ${conditions.length === 0 ? sql`TRUE` : sql.join(conditions, sql` AND `)}
  )`;
}

const isRolledUp = sql`EXISTS (
  SELECT 1 FROM analytics_daily d
  WHERE d.day = v.day AND d.filter_dim = ${UNFILTERED_LEVEL}
    AND d.filter_value = '' AND d.dimension = ${TOTAL_DIMENSION}
)`;

const hasMembers = sql`EXISTS (
  SELECT 1 FROM analytics_visit_members s WHERE s.day = v.day
)`;

/**
 * Raw per-day rows (every dimension plus `total`) for visits that started on
 * days `from..to` and match all `filters`. With `onlyNotRolledUp`, days that
 * already have daily totals are skipped — the raw half of a totals report.
 */
export async function rawDailyRows(
  dbx: AnalyticsDb,
  opts: {
    from: string;
    to: string;
    filters: readonly AnalyticsFilter[];
    onlyNotRolledUp: boolean;
  },
): Promise<KeyedRow[]> {
  const where = sql`v.day BETWEEN ${opts.from} AND ${opts.to}${
    opts.onlyNotRolledUp ? sql` AND NOT ${isRolledUp}` : sql``
  }`;
  return executeRows(dbx, {
    label: "analytics.rawDailyRows",
    row: DailyRowSchema,
    query: sql`
      WITH ${visitsAndMemberships(where)}, ${keptVisits(opts.filters)}
      SELECT k.day::text AS "key", mm.dim AS "dimension", mm.value AS "value", ${metricColumns}
      FROM m mm JOIN kept k ON k.id = mm.visit_id
      WHERE mm.dim <> ${UNFILTERED_LEVEL}
      GROUP BY k.day, mm.dim, mm.value`,
  });
}

/** Raw `total` rows per UTC hour (`YYYY-MM-DDTHH:00:00Z`) of visit start, for one day. */
export async function rawHourlyTotals(
  dbx: AnalyticsDb,
  opts: { day: string; filters: readonly AnalyticsFilter[] },
): Promise<KeyedRow[]> {
  return executeRows(dbx, {
    label: "analytics.rawHourlyTotals",
    row: DailyRowSchema,
    query: sql`
      WITH ${visitsAndMemberships(sql`v.day = ${opts.day}`)}, ${keptVisits(opts.filters)}
      SELECT to_char(date_trunc('hour', k.started_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24":00:00Z"') AS "key",
        mm.dim AS "dimension", mm.value AS "value", ${metricColumns}
      FROM m mm JOIN kept k ON k.id = mm.visit_id
      WHERE mm.dim = ${TOTAL_DIMENSION}
      GROUP BY 1, mm.dim, mm.value`,
  });
}

/** A daily-totals filter level: unfiltered, or exactly one filter. */
export type TotalsLevel =
  { kind: "unfiltered" } | { kind: "filter"; filter: AnalyticsFilter };

/** Rows read back from `analytics_daily` for one level, days `from..to`. */
export async function dailyTotalsRows(
  dbx: AnalyticsDb,
  opts: {
    from: string;
    to: string;
    level: TotalsLevel;
    dimensions: "all" | "total";
  },
): Promise<KeyedRow[]> {
  const [filterDim, filterValue] =
    opts.level.kind === "unfiltered"
      ? [UNFILTERED_LEVEL, ""]
      : [opts.level.filter.dimension, opts.level.filter.value];
  const dimensionScope: DailyDimension | null =
    opts.dimensions === "total" ? TOTAL_DIMENSION : null;
  return executeRows(dbx, {
    label: "analytics.dailyTotalsRows",
    row: DailyRowSchema,
    query: sql`
      SELECT day::text AS "key", dimension, value,
        visits, pageviews, bounces, returning_visits AS "returningVisits",
        duration_ms AS "durationMs", events
      FROM analytics_daily
      WHERE filter_dim = ${filterDim} AND filter_value = ${filterValue}
        AND day BETWEEN ${opts.from} AND ${opts.to}
        ${dimensionScope === null ? sql`` : sql`AND dimension = ${dimensionScope}`}`,
  });
}

/**
 * Replace `day`'s daily totals — every level (unfiltered and every single
 * filter a visit that day had) — and its visit memberships with a fresh sum of
 * its raw rows, atomically. Safe to rerun; a day with no visits ends with no
 * rows.
 */
export async function rollupDay(dbx: AnalyticsDb, day: string): Promise<void> {
  await dbx.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM analytics_daily WHERE day = ${day}`);
    await tx.execute(sql`
      WITH ${visitsAndMemberships(sql`v.day = ${day}`)}
      INSERT INTO analytics_daily
        (day, filter_dim, filter_value, dimension, value,
         visits, pageviews, bounces, returning_visits, duration_ms, events)
      SELECT k.day, f.dim, f.value, mm.dim, mm.value, ${metricColumns}
      FROM m f
        JOIN m mm ON mm.visit_id = f.visit_id
        JOIN base k ON k.id = f.visit_id
      WHERE f.dim <> ${TOTAL_DIMENSION} AND mm.dim <> ${UNFILTERED_LEVEL}
      GROUP BY k.day, f.dim, f.value, mm.dim, mm.value`);
    await tx.execute(
      sql`DELETE FROM analytics_visit_members WHERE day = ${day}`,
    );
    await tx.execute(sql`
      WITH ${visitsAndMemberships(sql`v.day = ${day}`)}
      INSERT INTO analytics_visit_members (visit_id, day, visitor_id, dim, value)
      SELECT DISTINCT mm.visit_id, b.day, b.visitor_id, mm.dim, mm.value
      FROM m mm JOIN base b ON b.id = mm.visit_id
      WHERE mm.dim <> ${UNFILTERED_LEVEL}`);
  });
}

/**
 * Where {@link visitorCounts} reads memberships from — the same split as the
 * report's additive rows, so a row's visitors and its other metrics always
 * come from the same visits:
 * - `raw`: the raw visits of every day in the span;
 * - `totals`: the stored memberships of rolled-up days, plus the raw visits of
 *   the days not rolled up yet (today, a missed night).
 */
export type MembershipSource = "raw" | "totals";

/** How {@link visitorCounts} groups: the whole span, each (dimension, value), or each series bucket. */
export type VisitorGrouping =
  | { kind: "total" }
  | { kind: "dimension" }
  | { kind: "bucket"; granularity: Granularity };

const VisitorRowSchema = z.object({
  key: z.string(),
  dimension: DailyDimensionSchema,
  value: z.string(),
  visitors: z.coerce.number().int(),
});
export type VisitorRow = z.infer<typeof VisitorRowSchema>;

/**
 * Distinct visitors over days `from..to`, among the visits that have EVERY
 * filter's value. Counted over the whole span, never summed per day: a
 * visitor keeps one id while they keep returning, so they count once however
 * many days they came.
 */
export async function visitorCounts(
  dbx: AnalyticsDb,
  opts: {
    from: string;
    to: string;
    filters: readonly AnalyticsFilter[];
    source: MembershipSource;
    groupBy: VisitorGrouping;
  },
): Promise<VisitorRow[]> {
  const inSpan = sql`v.day BETWEEN ${opts.from} AND ${opts.to}`;
  const rawArm = sql`
    SELECT mm.visit_id, b.day, b.started_at, b.visitor_id, mm.dim, mm.value
    FROM m mm JOIN base b ON b.id = mm.visit_id
    WHERE mm.dim <> ${UNFILTERED_LEVEL}`;
  const mem =
    opts.source === "raw"
      ? sql`WITH ${visitsAndMemberships(inSpan)}, mem AS (${rawArm})`
      : sql`WITH ${visitsAndMemberships(sql`${inSpan} AND NOT ${isRolledUp}`)},
        mem AS (
          SELECT s.visit_id, s.day, NULL::timestamptz AS started_at, s.visitor_id, s.dim, s.value
          FROM analytics_visit_members s
          WHERE s.day BETWEEN ${opts.from} AND ${opts.to}
          UNION ALL ${rawArm}
        )`;
  const kept = opts.filters.map(
    (f) =>
      sql`EXISTS (SELECT 1 FROM mem mf WHERE mf.visit_id = mm.visit_id AND mf.dim = ${f.dimension} AND mf.value = ${f.value})`,
  );
  const [key, dimScope, groupBy] = visitorGrouping(opts.groupBy, opts.source);
  return executeRows(dbx, {
    label: "analytics.visitorCounts",
    row: VisitorRowSchema,
    query: sql`
      ${mem}
      SELECT ${key} AS "key", mm.dim AS "dimension", mm.value AS "value",
        count(DISTINCT mm.visitor_id)::int AS "visitors"
      FROM mem mm
      WHERE ${dimScope}${kept.length === 0 ? sql`` : sql` AND ${sql.join(kept, sql` AND `)}`}
      GROUP BY ${groupBy}`,
  });
}

function visitorGrouping(
  grouping: VisitorGrouping,
  source: MembershipSource,
): [key: SQL, dimScope: SQL, groupBy: SQL] {
  const total = sql`mm.dim = ${TOTAL_DIMENSION}`;
  switch (grouping.kind) {
    case "total":
      return [sql`''`, total, sql`mm.dim, mm.value`];
    case "dimension":
      return [
        sql`''`,
        sql`mm.dim <> ${TOTAL_DIMENSION}`,
        sql`mm.dim, mm.value`,
      ];
    case "bucket": {
      const key = bucketKey(grouping.granularity, source);
      return [key, total, sql`1, mm.dim, mm.value`];
    }
  }
}

function bucketKey(granularity: Granularity, source: MembershipSource): SQL {
  switch (granularity) {
    case "hour":
      // Stored memberships keep the day, not the hour: an hourly series only
      // exists for a single recent day, which the raw source always covers.
      if (source !== "raw")
        throw new Error("analytics: an hourly series needs the raw source");
      return sql`to_char(date_trunc('hour', mm.started_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24":00:00Z"')`;
    case "day":
      return sql`mm.day::text`;
    case "month":
      return sql`to_char(date_trunc('month', mm.day), 'YYYY-MM-DD')`;
  }
}

const DayRow = z.object({ day: z.string() });

/**
 * Completed days (before `today`) that have visits but no summary row or no
 * memberships: a night the rollup did not run (or ran before memberships
 * existed). The rollup backfills them.
 */
export async function daysMissingTotals(
  dbx: AnalyticsDb,
  today: string,
): Promise<string[]> {
  const rows = await executeRows(dbx, {
    label: "analytics.daysMissingTotals",
    row: DayRow,
    query: sql`
      SELECT DISTINCT v.day::text AS day FROM analytics_visits v
      WHERE v.day < ${today}
        AND (NOT ${isRolledUp} OR NOT ${hasMembers})
      ORDER BY 1`,
  });
  return rows.map((r) => r.day);
}

/** Which of `days` have their summary row and their memberships. */
export async function rolledUpDays(
  dbx: AnalyticsDb,
  days: readonly string[],
): Promise<Set<string>> {
  if (days.length === 0) return new Set();
  const rows = await executeRows(dbx, {
    label: "analytics.rolledUpDays",
    row: DayRow,
    query: sql`
      SELECT v.day::text AS day FROM analytics_daily v
      WHERE v.filter_dim = ${UNFILTERED_LEVEL} AND v.filter_value = ''
        AND v.dimension = ${TOTAL_DIMENSION}
        AND ${hasMembers}
        AND v.day IN (${sql.join(
          days.map((d) => sql`${d}`),
          sql`, `,
        )})`,
  });
  return new Set(rows.map((r) => r.day));
}
