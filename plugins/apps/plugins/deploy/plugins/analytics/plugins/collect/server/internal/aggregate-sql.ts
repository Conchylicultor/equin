import { eq, sql, type SQL } from "drizzle-orm";
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
  type Audience,
  type DailyDimension,
  type Granularity,
  type VisitDimension,
} from "../../core";
import type { AnalyticsDb, AnalyticsReadDb } from "./collect";
import {
  analyticsDaily,
  analyticsVisitMembers,
  analyticsVisits,
} from "./tables";

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
 * - `('event', name)` per distinct event, contributing that event's count;
 * - `('event_prop', '<event>.<key>=<value>')` per distinct prop of its events
 *   (the spelling of `eventPropValue`), contributing how many events carried it.
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

/** A visit alias inlined into SQL: a closed set of short names, validated. */
function visitAlias(alias: string): SQL {
  if (!/^[a-z]+$/.test(alias))
    throw new Error(`analytics: bad visit alias ${alias}`);
  return sql.raw(alias);
}

/**
 * Which visits {@link memberships} lists:
 * - `one` — the visit under `alias` (an `analytics_visits` row in scope), as a
 *   subquery for FROM: `(dim, value)` only, which is all a filter reads. Its
 *   hit branches read that visit's own hits (`analytics_hits_visit_idx`), so
 *   checking a visit costs its hits, whatever the range around it.
 * - `all` — every visit of the `base` CTE (alias `b`), set-based (one join of
 *   the hits per branch, which a whole range is cheapest as), with what each
 *   contributes: `(visit_id, dim, value, pageviews, duration_ms, events)`.
 */
type MembershipScope = { kind: "one"; alias: string } | { kind: "all" };

/**
 * The membership definition above, as SQL — the ONE place it is written. Both
 * scopes are built from the same branch list, so a filter ({@link visitHasAll},
 * `one`) keeps exactly the visits whose memberships a report row counts
 * (`m`, `all`).
 */
function memberships(scope: MembershipScope): SQL {
  const all = scope.kind === "all";
  const v = all ? sql.raw("b") : visitAlias(scope.alias);
  const values = sql.join(
    [
      sql`(${literal(UNFILTERED_LEVEL)}, ''::text)`,
      sql`(${literal(TOTAL_DIMENSION)}, ''::text)`,
      ...VISIT_DIMENSIONS.map(
        (dim) =>
          sql`(${literal(dim)}, ${v}.${sql.raw(VISIT_DIMENSION_COLUMN[dim])}::text)`,
      ),
    ],
    sql`, `,
  );
  // A branch's row: the pair, plus (set-based) what the visit contributes to it.
  const row = (
    dim: SQL,
    value: SQL,
    contributes: { pageviews: SQL; durationMs: SQL; events: SQL },
  ) =>
    all
      ? sql`b.id AS visit_id, ${dim} AS dim, ${value} AS value,
          ${contributes.pageviews} AS pageviews, ${contributes.durationMs} AS duration_ms,
          ${contributes.events} AS events`
      : sql`${dim} AS dim, ${value} AS value`;
  const hits = (where: SQL, lateral: SQL = sql``) =>
    all
      ? sql`FROM analytics_hits h JOIN base b ON b.id = h.visit_id ${lateral} WHERE ${where}`
      : sql`FROM analytics_hits h ${lateral} WHERE h.visit_id = ${v}.id AND ${where}`;
  // Per visit, one row per pair; the `one` scope only asks whether a pair exists.
  const perPair = (key: SQL) =>
    all ? sql`GROUP BY b.id, b.pageviews, b.duration_ms, ${key}` : sql``;
  const visitWide = {
    pageviews: sql`b.pageviews::bigint`,
    durationMs: sql`b.duration_ms`,
  };
  const propValue = sql`h.event_name || '.' || p.key || '=' || p.value`;
  const body = sql`
    SELECT ${row(sql`x.dim`, sql`COALESCE(x.value, ${NONE_VALUE}::text)`, { ...visitWide, events: sql`b.events::bigint` })}
    FROM ${all ? sql`base b CROSS JOIN LATERAL ` : sql``}(VALUES ${values}) AS x(dim, value)
    UNION ALL
    SELECT ${row(literal("page"), sql`h.path`, {
      pageviews: sql`count(*) FILTER (WHERE h.kind = 'pageview')`,
      durationMs: sql`COALESCE(sum(h.engaged_ms) FILTER (WHERE h.kind = 'pageview'), 0)::bigint`,
      events: sql`count(*) FILTER (WHERE h.kind = 'event')`,
    })}
    ${hits(sql`TRUE`)}
    ${perPair(sql`h.path`)}
    UNION ALL
    SELECT ${row(literal("event"), sql`h.event_name`, { ...visitWide, events: sql`count(*)` })}
    ${hits(sql`h.kind = 'event'`)}
    ${perPair(sql`h.event_name`)}
    UNION ALL
    SELECT ${row(literal("event_prop"), propValue, { ...visitWide, events: sql`count(*)` })}
    ${hits(sql`h.kind = 'event'`, sql`CROSS JOIN LATERAL jsonb_each_text(h.event_props) AS p(key, value)`)}
    ${perPair(propValue)}`;
  return all ? body : sql`(${body})`;
}

/**
 * Over visit alias `alias`: the visit has EVERY filter's value, under the
 * membership definition ({@link memberships}) — the ONE filter every reader
 * applies (the report's and visitor counts' `base`, the sessions list, its
 * counts). A per-visit check: its cost is the visit's own hits, never the
 * range's — so it narrows the visits BEFORE their memberships are built.
 */
export function visitHasAll(
  alias: string,
  filters: readonly AnalyticsFilter[],
): SQL {
  if (filters.length === 0) return sql`TRUE`;
  return sql.join(
    filters.map(
      (f) =>
        sql`EXISTS (SELECT 1 FROM ${memberships({ kind: "one", alias })} AS mf WHERE mf.dim = ${f.dimension} AND mf.value = ${f.value})`,
    ),
    sql` AND `,
  );
}

/**
 * The ONE definition of a visit's duration, over visit alias `v`: wall-clock
 * time from its start to the end of its exit page, every page on the same
 * scale — background time included.
 *
 * Every page before the exit lasts until the next pageview (`exit_at −
 * started_at`, wall-clock). The exit page has no next pageview, so its time is
 * what its beacons measured: its visible time (`exit_engaged_ms`, idle
 * included — idle is visible) plus its `hidden` stretches from the exit
 * pageview's recorded `gaps`. An exit pageview whose gaps were never recorded
 * (`NULL`: an older tracker, a visit from before `gaps` existed, no beacon
 * yet) adds no background time — its visible time is all that is known.
 *
 * The report (every aggregate below, through `base.duration_ms`) and the
 * sessions list (its page's `durationMs`) both read it, so a visit lasts as long in one as in the other.
 */
export const visitDurationMs = sql`(
  (GREATEST(EXTRACT(EPOCH FROM (v.exit_at - v.started_at)) * 1000, 0))::bigint
  + v.exit_engaged_ms
  + COALESCE((
      SELECT sum((g.value->>'endMs')::bigint - (g.value->>'startMs')::bigint)
      FROM analytics_hits xh
        CROSS JOIN LATERAL jsonb_array_elements(xh.gaps) AS g(value)
      WHERE xh.id = v.exit_pageview_id AND g.value->>'kind' = 'hidden'
    ), 0)::bigint
)`;

/**
 * `base` (the visits matching `where`, over alias `v`, with their duration —
 * {@link visitDurationMs}) and `m` (their memberships). Continue the WITH list
 * after it.
 */
function visitsAndMemberships(where: SQL): SQL {
  return sql`
    base AS (
      SELECT v.*, ${visitDurationMs} AS duration_ms
      FROM analytics_visits v
      WHERE ${where}
    ),
    m AS (${memberships({ kind: "all" })}
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

/**
 * Over visit alias `v`: the visit belongs to `audience` — the owner's own
 * visits (`analytics_visits.owner`) are `you`, everyone else's `visitors`.
 */
export function audienceCondition(audience: Audience): SQL {
  switch (audience) {
    case "visitors":
      return sql`NOT v.owner`;
    case "you":
      return sql`v.owner`;
    case "all":
      return sql`TRUE`;
  }
}

/**
 * Over visit alias `v`: its day is rolled up. Memberships are the marker, not
 * the daily totals: the rollup writes every visit's memberships (the owner's
 * included) but sums visitors only, so a day whose only visits were the
 * owner's has memberships and no totals — and is still summed.
 */
const isRolledUp = sql`EXISTS (
  SELECT 1 FROM analytics_visit_members s WHERE s.day = v.day
)`;

/**
 * Raw per-day rows (every dimension plus `total`) for visits that started on
 * days `from..to` and match all `filters`. With `onlyNotRolledUp`, days that
 * already have daily totals are skipped — the raw half of a totals report.
 */
export async function rawDailyRows(
  dbx: AnalyticsReadDb,
  opts: {
    from: string;
    to: string;
    audience: Audience;
    filters: readonly AnalyticsFilter[];
    onlyNotRolledUp: boolean;
  },
): Promise<KeyedRow[]> {
  const where = sql`v.day BETWEEN ${opts.from} AND ${opts.to} AND ${audienceCondition(opts.audience)}${
    opts.onlyNotRolledUp ? sql` AND NOT ${isRolledUp}` : sql``
  } AND ${visitHasAll("v", opts.filters)}`;
  return executeRows(dbx, {
    label: "analytics.rawDailyRows",
    row: DailyRowSchema,
    query: sql`
      WITH ${visitsAndMemberships(where)}
      SELECT k.day::text AS "key", mm.dim AS "dimension", mm.value AS "value", ${metricColumns}
      FROM m mm JOIN base k ON k.id = mm.visit_id
      WHERE mm.dim <> ${UNFILTERED_LEVEL}
      GROUP BY k.day, mm.dim, mm.value`,
  });
}

/** Raw `total` rows per UTC hour (`YYYY-MM-DDTHH:00:00Z`) of visit start, for one day. */
export async function rawHourlyTotals(
  dbx: AnalyticsReadDb,
  opts: {
    day: string;
    audience: Audience;
    filters: readonly AnalyticsFilter[];
  },
): Promise<KeyedRow[]> {
  return executeRows(dbx, {
    label: "analytics.rawHourlyTotals",
    row: DailyRowSchema,
    query: sql`
      WITH ${visitsAndMemberships(sql`v.day = ${opts.day} AND ${audienceCondition(opts.audience)} AND ${visitHasAll("v", opts.filters)}`)}
      SELECT to_char(date_trunc('hour', k.started_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24":00:00Z"') AS "key",
        mm.dim AS "dimension", mm.value AS "value", ${metricColumns}
      FROM m mm JOIN base k ON k.id = mm.visit_id
      WHERE mm.dim = ${TOTAL_DIMENSION}
      GROUP BY 1, mm.dim, mm.value`,
  });
}

/** A daily-totals filter level: unfiltered, or exactly one filter. */
export type TotalsLevel =
  { kind: "unfiltered" } | { kind: "filter"; filter: AnalyticsFilter };

/** Rows read back from `analytics_daily` for one level, days `from..to`. */
export async function dailyTotalsRows(
  dbx: AnalyticsReadDb,
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
 * its raw rows, atomically. The totals sum the `visitors` audience only (the
 * owner's own visits are left out); the memberships keep every visit, each
 * with its `owner` flag, and mark the day rolled up. Safe to rerun; a day with no visits ends with no
 * rows.
 */
export async function rollupDay(dbx: AnalyticsDb, day: string): Promise<void> {
  await dbx.transaction(async (tx) => {
    await tx.delete(analyticsDaily).where(eq(analyticsDaily.day, day));
    // sql-writes:hand-written — set-based INSERT … SELECT over the WITH aggregation of a day's raw visits
    await tx.execute(sql`
      WITH ${visitsAndMemberships(sql`v.day = ${day} AND ${audienceCondition("visitors")}`)}
      INSERT INTO analytics_daily
        (day, filter_dim, filter_value, dimension, value,
         visits, pageviews, bounces, returning_visits, duration_ms, events)
      SELECT k.day, f.dim, f.value, mm.dim, mm.value, ${metricColumns}
      FROM m f
        JOIN m mm ON mm.visit_id = f.visit_id
        JOIN base k ON k.id = f.visit_id
      WHERE f.dim <> ${TOTAL_DIMENSION} AND mm.dim <> ${UNFILTERED_LEVEL}
      GROUP BY k.day, f.dim, f.value, mm.dim, mm.value`);
    await tx
      .delete(analyticsVisitMembers)
      .where(eq(analyticsVisitMembers.day, day));
    // sql-writes:hand-written — set-based INSERT … SELECT over the WITH aggregation of a day's raw visits
    await tx.execute(sql`
      WITH ${visitsAndMemberships(sql`v.day = ${day}`)}
      INSERT INTO analytics_visit_members (visit_id, day, visitor_id, owner, dim, value)
      SELECT DISTINCT mm.visit_id, b.day, b.visitor_id, b.owner, mm.dim, mm.value
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
  dbx: AnalyticsReadDb,
  opts: {
    from: string;
    to: string;
    audience: Audience;
    filters: readonly AnalyticsFilter[];
    source: MembershipSource;
    groupBy: VisitorGrouping;
  },
): Promise<VisitorRow[]> {
  // The stored half must count the same visits as the daily totals beside it.
  if (opts.source === "totals" && opts.audience !== "visitors")
    throw new Error(
      `analytics: the daily totals hold visitors only, not ${opts.audience}`,
    );
  // The filters narrow the visits before their memberships are listed: raw
  // visits by the membership definition itself (visitHasAll), rolled-up ones
  // by the memberships the rollup stored from it (their primary key).
  const inSpan = sql`v.day BETWEEN ${opts.from} AND ${opts.to} AND ${audienceCondition(opts.audience)} AND ${visitHasAll("v", opts.filters)}`;
  const storedKept = opts.filters.map(
    (f) =>
      sql` AND EXISTS (SELECT 1 FROM analytics_visit_members sf WHERE sf.visit_id = s.visit_id AND sf.dim = ${f.dimension} AND sf.value = ${f.value})`,
  );
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
          WHERE s.day BETWEEN ${opts.from} AND ${opts.to} AND NOT s.owner${sql.join(storedKept, sql``)}
          UNION ALL ${rawArm}
        )`;
  const [key, dimScope, groupBy] = visitorGrouping(opts.groupBy, opts.source);
  return executeRows(dbx, {
    label: "analytics.visitorCounts",
    row: VisitorRowSchema,
    query: sql`
      ${mem}
      SELECT ${key} AS "key", mm.dim AS "dimension", mm.value AS "value",
        count(DISTINCT mm.visitor_id)::int AS "visitors"
      FROM mem mm
      WHERE ${dimScope}
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
 * Completed days (before `today`) that have visits but are not rolled up (no
 * memberships): a night the rollup did not run (or ran before memberships
 * existed). The rollup backfills them.
 */
export async function daysMissingTotals(
  dbx: AnalyticsReadDb,
  today: string,
): Promise<string[]> {
  const rows = await executeRows(dbx, {
    label: "analytics.daysMissingTotals",
    row: DayRow,
    query: sql`
      SELECT DISTINCT v.day::text AS day FROM analytics_visits v
      WHERE v.day < ${today}
        AND NOT ${isRolledUp}
      ORDER BY 1`,
  });
  return rows.map((r) => r.day);
}

/** Which of `days` are rolled up (have their memberships; see {@link isRolledUp}). */
export async function rolledUpDays(
  dbx: AnalyticsReadDb,
  days: readonly string[],
): Promise<Set<string>> {
  if (days.length === 0) return new Set();
  const rows = await executeRows(dbx, {
    label: "analytics.rolledUpDays",
    row: DayRow,
    query: sql`
      SELECT DISTINCT v.day::text AS day FROM analytics_visit_members v
      WHERE v.day IN (${sql.join(
          days.map((d) => sql`${d}`),
          sql`, `,
        )})`,
  });
  return new Set(rows.map((r) => r.day));
}

/**
 * Over visit alias `alias`: the distinct values the visit has under hit
 * dimension `dim` (its pages, its event names), as a `text[]` in code-point
 * order — read from the membership definition ({@link memberships}, `one`
 * scope), so a list filtering on them keeps exactly the visits a report row
 * under that dimension counts.
 */
export function visitMembershipValues(
  alias: string,
  dim: "page" | "event",
): SQL {
  return sql`ARRAY(SELECT DISTINCT mv.value COLLATE "C" FROM ${memberships({ kind: "one", alias })} AS mv WHERE mv.dim = ${literal(dim)} ORDER BY 1)`;
}
