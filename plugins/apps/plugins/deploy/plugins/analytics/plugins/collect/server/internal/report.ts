import {
  DIMENSIONS,
  MAX_TOTALS_FILTERS,
  RAW_RETENTION_DAYS,
  REPORT_ROWS_PER_DIMENSION,
  reportRowGroup,
  TOTAL_DIMENSION,
  ZERO_ADDITIVE_METRICS,
  addMetrics,
  addMonths,
  planPeriods,
  reportSourceFor,
  type AdditiveMetrics,
  type AnalyticsFilter,
  type AnalyticsQuery,
  type AnalyticsQueryResult,
  type AnalyticsReport,
  type Dimension,
  type PeriodReport,
  type ReportPeriod,
  type ReportRow,
  type ReportSource,
} from "../../core";
import {
  dailyTotalsRows,
  metricsOf,
  rawDailyRows,
  rawHourlyTotals,
  visitorCounts,
  type KeyedRow,
  type VisitorGrouping,
  type VisitorRow,
} from "./aggregate-sql";
import type { AnalyticsDb } from "./collect";

/**
 * Answer one analytics query as of `now`.
 *
 * - `raw` source: per-visit rows for every day, any number of filters.
 * - `totals` source: `analytics_daily` for the days it holds, plus raw rows for
 *   the days not rolled up yet (today, and any night the rollup missed), at
 *   most one filter — a second one is refused, not approximated.
 *
 * Either way, unique visitors are counted distinct over each period, row and
 * bucket from the same visits (`visitorCounts`), never summed per day.
 */
export async function runAnalyticsQuery(
  dbx: AnalyticsDb,
  query: AnalyticsQuery,
  now: Date,
): Promise<AnalyticsQueryResult> {
  const source = reportSourceFor(query, now);
  if (source === "totals" && query.filters.length > MAX_TOTALS_FILTERS) {
    return {
      kind: "refused",
      reason: "stacked-filters-beyond-raw-window",
      maxFilters: MAX_TOTALS_FILTERS,
      rawWindowDays: RAW_RETENTION_DAYS,
    };
  }
  const periods = planPeriods(query.range, now);
  const current = await periodData(dbx, source, periods.current, query.filters);
  const previous = query.compare
    ? await periodData(dbx, source, periods.previous, query.filters)
    : null;
  const report: AnalyticsReport = {
    source,
    range: query.range,
    granularity: periods.current.granularity,
    filters: query.filters,
    generatedAt: now.toISOString(),
    current: current.period,
    previous: previous?.period ?? null,
    rows: current.rows,
  };
  return { kind: "report", report };
}

interface PeriodData {
  period: PeriodReport;
  rows: Record<Dimension, ReportRow[]>;
}

async function periodData(
  dbx: AnalyticsDb,
  source: ReportSource,
  period: ReportPeriod,
  filters: readonly AnalyticsFilter[],
): Promise<PeriodData> {
  const visitors = (groupBy: VisitorGrouping) =>
    visitorCounts(dbx, {
      from: period.from,
      to: period.to,
      filters,
      source,
      groupBy,
    });
  const [daily, hourly, summaryVisitors, rowVisitors, bucketVisitors] =
    await Promise.all([
      dailyRows(dbx, source, period, filters),
      period.granularity === "hour"
        ? rawHourlyTotals(dbx, { day: period.from, filters })
        : null,
      visitors({ kind: "total" }),
      visitors({ kind: "dimension" }),
      visitors({ kind: "bucket", granularity: period.granularity }),
    ]);
  const totals = daily.filter((r) => r.dimension === TOTAL_DIMENSION);
  return {
    period: {
      from: period.from,
      to: period.to,
      summary: {
        visitors: summaryVisitors[0]?.visitors ?? 0,
        ...sumMetrics(totals),
      },
      series: denseSeries(period, hourly ?? totals, bucketVisitors),
    },
    rows: topRows(daily, rowVisitors),
  };
}

function dailyRows(
  dbx: AnalyticsDb,
  source: ReportSource,
  period: ReportPeriod,
  filters: readonly AnalyticsFilter[],
): Promise<KeyedRow[]> {
  if (source === "raw") {
    return rawDailyRows(dbx, {
      from: period.from,
      to: period.to,
      filters,
      onlyNotRolledUp: false,
    });
  }
  return totalsSourceRows(dbx, period, filters);
}

async function totalsSourceRows(
  dbx: AnalyticsDb,
  period: ReportPeriod,
  filters: readonly AnalyticsFilter[],
): Promise<KeyedRow[]> {
  const [filter, ...rest] = filters;
  if (rest.length > 0) {
    throw new Error("analytics: totals source reached with stacked filters");
  }
  const [stored, notRolledUp] = await Promise.all([
    dailyTotalsRows(dbx, {
      from: period.from,
      to: period.to,
      level: filter ? { kind: "filter", filter } : { kind: "unfiltered" },
      dimensions: "all",
    }),
    rawDailyRows(dbx, {
      from: period.from,
      to: period.to,
      filters,
      onlyNotRolledUp: true,
    }),
  ]);
  return [...stored, ...notRolledUp];
}

function sumMetrics(rows: readonly AdditiveMetrics[]): AdditiveMetrics {
  return rows.reduce<AdditiveMetrics>(
    (acc, row) => addMetrics(acc, metricsOf(row)),
    ZERO_ADDITIVE_METRICS,
  );
}

/** Every bucket of the period in order, zeros where nothing happened. */
function denseSeries(
  period: ReportPeriod,
  totals: readonly KeyedRow[],
  visitors: readonly VisitorRow[],
): PeriodReport["series"] {
  const byBucket = new Map<string, AdditiveMetrics>();
  for (const row of totals) {
    const bucket =
      period.granularity === "month" ? addMonths(row.key, 0) : row.key;
    byBucket.set(
      bucket,
      addMetrics(byBucket.get(bucket) ?? ZERO_ADDITIVE_METRICS, metricsOf(row)),
    );
  }
  const visitorsByBucket = new Map(visitors.map((r) => [r.key, r.visitors]));
  return period.buckets.map((bucket) => ({
    bucket,
    metrics: {
      visitors: visitorsByBucket.get(bucket) ?? 0,
      ...(byBucket.get(bucket) ?? ZERO_ADDITIVE_METRICS),
    },
  }));
}

function rankRows(a: ReportRow, b: ReportRow): number {
  return (
    b.visitors - a.visitors ||
    b.pageviews - a.pageviews ||
    b.events - a.events ||
    a.value.localeCompare(b.value)
  );
}

const rowKey = (dimension: string, value: string) => `${dimension}\t${value}`;

/**
 * Sum the per-day rows by (dimension, value), attach each one's distinct
 * visitors over the period, and keep each dimension's (or `event_prop`
 * group's) top rows.
 */
function topRows(
  daily: readonly KeyedRow[],
  visitors: readonly VisitorRow[],
): Record<Dimension, ReportRow[]> {
  const visitorsByRow = new Map(
    visitors.map((r) => [rowKey(r.dimension, r.value), r.visitors]),
  );
  const byDimension = new Map<Dimension, Map<string, AdditiveMetrics>>(
    DIMENSIONS.map((d) => [d, new Map()]),
  );
  for (const row of daily) {
    if (row.dimension === TOTAL_DIMENSION) continue;
    const values = byDimension.get(row.dimension);
    if (!values)
      throw new Error(`analytics: unknown dimension ${row.dimension}`);
    values.set(
      row.value,
      addMetrics(
        values.get(row.value) ?? ZERO_ADDITIVE_METRICS,
        metricsOf(row),
      ),
    );
  }
  const rows = {} as Record<Dimension, ReportRow[]>;
  for (const dimension of DIMENSIONS) {
    rows[dimension] = [
      ...(byDimension.get(dimension) ?? new Map<string, AdditiveMetrics>()),
    ]
      .map(([value, metrics]) => {
        // Both sides read the same visits, so a row with metrics has visitors.
        const rowVisitors = visitorsByRow.get(rowKey(dimension, value));
        if (rowVisitors === undefined) {
          throw new Error(
            `analytics: ${dimension}=${value} has metrics but no visitor count`,
          );
        }
        return { value, visitors: rowVisitors, ...metrics };
      })
      .sort(rankRows)
      .filter(keepTop(dimension));
  }
  return rows;
}

/** Keeps the first {@link REPORT_ROWS_PER_DIMENSION} ranked rows of each `reportRowGroup`. */
function keepTop(dimension: Dimension): (row: ReportRow) => boolean {
  const kept = new Map<string, number>();
  return (row) => {
    const group = reportRowGroup(dimension, row.value);
    const n = kept.get(group) ?? 0;
    kept.set(group, n + 1);
    return n < REPORT_ROWS_PER_DIMENSION;
  };
}
