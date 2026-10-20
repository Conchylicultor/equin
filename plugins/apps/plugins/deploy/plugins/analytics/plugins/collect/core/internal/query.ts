import { z } from "zod";
import { DIMENSIONS, DimensionSchema, type Dimension } from "./dimensions";
import {
  AnalyticsRangeSchema,
  DaySchema,
  GranularitySchema,
  RAW_RETENTION_DAYS,
  firstRawDay,
  planPeriods,
} from "./periods";

// ── The query ────────────────────────────────────────────────────────────

/** Keep visits that have this value (for page/event: at least one such hit). */
export const AnalyticsFilterSchema = z
  .object({
    dimension: DimensionSchema,
    value: z.string().max(2048),
  })
  .strict();
export type AnalyticsFilter = z.infer<typeof AnalyticsFilterSchema>;

/** Filters stack (AND). More than this is refused as malformed. */
export const MAX_FILTERS = 8;
/**
 * A `totals` report reads the daily totals, which hold every SINGLE-filter
 * level but no combination — so it accepts at most this many filters.
 */
export const MAX_TOTALS_FILTERS = 1;

export const AnalyticsQuerySchema = z
  .object({
    range: AnalyticsRangeSchema,
    /** Also compute the previous, equally long period. */
    compare: z.boolean(),
    filters: z.array(AnalyticsFilterSchema).max(MAX_FILTERS),
  })
  .strict()
  .refine(
    (q) =>
      new Set(q.filters.map((f) => JSON.stringify([f.dimension, f.value])))
        .size === q.filters.length,
    { message: "duplicate filter" },
  );
export type AnalyticsQuery = z.infer<typeof AnalyticsQuerySchema>;

export const REPORT_SOURCES = ["raw", "totals"] as const;
export type ReportSource = (typeof REPORT_SOURCES)[number];

/**
 * Which store answers `query` at `now`:
 * - `raw` — every day it needs (the previous period included, when compared)
 *   still has its per-visit rows: any number of filters, applied to every panel.
 * - `totals` — it reaches past the 90-day raw window: completed days come from
 *   the daily totals, at most {@link MAX_TOTALS_FILTERS} filter.
 *
 * The dashboard calls this to disable a second filter chip BEFORE asking; the
 * server calls it to decide, and refuses what the dashboard should not send.
 */
export function reportSourceFor(
  query: Pick<AnalyticsQuery, "range" | "compare">,
  now: Date,
): ReportSource {
  const { current, previous } = planPeriods(query.range, now);
  const earliest = query.compare ? previous.from : current.from;
  return earliest >= firstRawDay(now) ? "raw" : "totals";
}

// ── The report ───────────────────────────────────────────────────────────

/**
 * A period's (or a row's, or a bucket's) counts. Every field except `visitors`
 * is additive — summing two days' values is exact (see `AdditiveMetrics` in
 * `metrics.ts`). Rates (bounce rate, views per visit, average duration,
 * conversion) are derived from these by the helpers in `metrics.ts`.
 *
 * - `visitors` — distinct visitor ids over the whole period / row / bucket. An
 *   id persists while its visitor keeps returning within 30 days, so someone
 *   who came on ten days counts once. NOT additive: it is counted, never summed.
 * - `visits` / `pageviews` / `events` — counts.
 * - `bounces` — visits with exactly one pageview.
 * - `returningVisits` — visits by a visitor who had visited before (their id
 *   was already known when the visit opened); `visits - returningVisits` are
 *   first visits. `null` when the site's release predates the count: the
 *   dashboard reads reports from deployed sites of any age.
 * - `durationMs` — summed visit duration: from the visit's first page to its
 *   last page, plus the time that last page was visible.
 *
 * On a report row, counts are restricted to the row's value: for `page`,
 * `pageviews` counts views of that page, `durationMs` sums the time that page
 * was visible (time on page) and `events` counts events fired on it; for
 * `event`, `events` counts that event. `visitors` / `visits` / `bounces` /
 * `returningVisits` always count the visits that have the value.
 */
export const MetricsSchema = z
  .object({
    visitors: z.number().int().nonnegative(),
    visits: z.number().int().nonnegative(),
    pageviews: z.number().int().nonnegative(),
    bounces: z.number().int().nonnegative(),
    // Absent from a report of an older release — read as "not counted".
    returningVisits: z.number().int().nonnegative().nullable().default(null),
    durationMs: z.number().int().nonnegative(),
    events: z.number().int().nonnegative(),
  })
  .strict();
export type Metrics = z.infer<typeof MetricsSchema>;

export const SeriesPointSchema = z
  .object({ bucket: z.string(), metrics: MetricsSchema })
  .strict();
export type SeriesPoint = z.infer<typeof SeriesPointSchema>;

/** One period: its inclusive UTC days, its summary, and a dense series (every bucket, zeros included). */
export const PeriodReportSchema = z
  .object({
    from: DaySchema,
    to: DaySchema,
    summary: MetricsSchema,
    series: z.array(SeriesPointSchema),
  })
  .strict();
export type PeriodReport = z.infer<typeof PeriodReportSchema>;

export const ReportRowSchema = MetricsSchema.extend({
  value: z.string(),
}).strict();
export type ReportRow = z.infer<typeof ReportRowSchema>;

/** Rows kept per dimension, ranked by visitors, then pageviews, then value. */
export const REPORT_ROWS_PER_DIMENSION = 50;

const ReportRowsSchema = z.array(ReportRowSchema);
const rowsShape = Object.fromEntries(
  DIMENSIONS.map((dimension) => [dimension, ReportRowsSchema]),
) as Record<Dimension, typeof ReportRowsSchema>;

export const AnalyticsReportSchema = z
  .object({
    source: z.enum(REPORT_SOURCES),
    range: AnalyticsRangeSchema,
    granularity: GranularitySchema,
    filters: z.array(AnalyticsFilterSchema),
    /** ISO instant the server computed this at. */
    generatedAt: z.string(),
    current: PeriodReportSchema,
    /** The equally long period before `current`; null when `compare` was off. */
    previous: PeriodReportSchema.nullable(),
    /** Top rows of the CURRENT period, per dimension. */
    rows: z.object(rowsShape).strict(),
  })
  .strict();
export type AnalyticsReport = z.infer<typeof AnalyticsReportSchema>;

/**
 * The query endpoint's answer. `refused` is not an error to paper over: the
 * query asked for stacked filters on a range only the daily totals can answer,
 * and those hold single filters only.
 */
export const AnalyticsQueryResultSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("report"), report: AnalyticsReportSchema })
    .strict(),
  z
    .object({
      kind: z.literal("refused"),
      reason: z.literal("stacked-filters-beyond-raw-window"),
      maxFilters: z.literal(MAX_TOTALS_FILTERS),
      rawWindowDays: z.literal(RAW_RETENTION_DAYS),
    })
    .strict(),
]);
export type AnalyticsQueryResult = z.infer<typeof AnalyticsQueryResultSchema>;

// ── Wire encoding ────────────────────────────────────────────────────────

export const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * The query travels as ONE base64url query-string value. base64url's alphabet
 * (`A-Z a-z 0-9 - _`) needs no quoting in a URL nor in the remote shell
 * `sshRun` joins its argv into, so the dashboard can curl it over SSH as-is.
 */
export function encodeAnalyticsQuery(query: AnalyticsQuery): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(JSON.stringify(query))) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** The JSON text inside an encoded query. Throws on a value that is not base64url. */
export function decodeAnalyticsQueryJson(encoded: string): string {
  if (!BASE64URL_PATTERN.test(encoded)) {
    throw new Error("analytics query: not base64url");
  }
  const binary = atob(encoded.replaceAll("-", "+").replaceAll("_", "/"));
  return new TextDecoder().decode(
    Uint8Array.from(binary, (char) => char.charCodeAt(0)),
  );
}

/** The `?q=` query-string schema: decodes and validates in one step. */
export const AnalyticsQueryParamSchema = z
  .object({
    q: z
      .string()
      .max(4096)
      .regex(BASE64URL_PATTERN)
      .transform((encoded, ctx) => {
        try {
          return JSON.parse(decodeAnalyticsQueryJson(encoded)) as unknown;
        } catch (err) {
          // atob's malformed-length DOMException, JSON.parse's SyntaxError:
          // both are a bad request, not a server fault.
          if (!(err instanceof SyntaxError || err instanceof DOMException)) {
            throw err;
          }
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "q is not base64url-encoded JSON",
          });
          return z.NEVER;
        }
      })
      .pipe(AnalyticsQuerySchema),
  })
  .strict();
