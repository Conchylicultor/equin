import { z } from "zod";
import {
  cappedList,
  wholeList,
} from "@plugins/packages/plugins/list-bound/core";
import { AudienceSchema, DEFAULT_AUDIENCE } from "./audience";
import { DIMENSIONS, DimensionSchema, type Dimension } from "./dimensions";
import { parseEventPropValue } from "./event-prop";
import {
  AnalyticsRangeSchema,
  DaySchema,
  GranularitySchema,
  MAX_SERIES_BUCKETS,
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
    /**
     * Whose visits (`audience.ts`). Absent = {@link DEFAULT_AUDIENCE}, which
     * the encoder also leaves out — so a site released before audiences still
     * answers the default question.
     */
    audience: AudienceSchema.default(DEFAULT_AUDIENCE),
  })
  .strict()
  .refine(
    (q) =>
      new Set(q.filters.map((f) => JSON.stringify([f.dimension, f.value])))
        .size === q.filters.length,
    { message: "duplicate filter" },
  );
export type AnalyticsQuery = z.infer<typeof AnalyticsQuerySchema>;

/**
 * Whether `source` can answer `audience`: the daily totals hold visitors only
 * (the rollup leaves the owner's visits out), so a `totals` report answers the
 * default audience and nothing else.
 */
export function audienceAvailable(
  source: ReportSource,
  audience: AnalyticsQuery["audience"],
): boolean {
  return source === "raw" || audience === DEFAULT_AUDIENCE;
}

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
 * - `durationMs` — summed visit duration (collect's one definition, its
 *   CLAUDE.md § Visit duration): wall-clock from the visit's first page to the
 *   end of its last — the last page's visible time plus its recorded
 *   background stretches.
 *
 * On a report row, counts are restricted to the row's value: for `page`,
 * `pageviews` counts views of that page, `durationMs` sums the time that page
 * was visible (time on page) and `events` counts events fired on it; for
 * `event`, `events` counts that event; for `event_prop`, the events that
 * carried that prop. `visitors` / `visits` / `bounces` / `returningVisits`
 * always count the visits that have the value.
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
    series: cappedList(SeriesPointSchema, { max: MAX_SERIES_BUCKETS }),
  })
  .strict();
export type PeriodReport = z.infer<typeof PeriodReportSchema>;

export const ReportRowSchema = MetricsSchema.extend({
  value: z.string(),
}).strict();
export type ReportRow = z.infer<typeof ReportRowSchema>;

/**
 * Rows kept per dimension, ranked by visitors, then pageviews, then value —
 * per {@link reportRowGroup}: an `event_prop` keeps this many per (event, key),
 * so one busy event's props never crowd out another's.
 */
export const REPORT_ROWS_PER_DIMENSION = 50;

/** The group a row is ranked and capped within: its event and key for `event_prop`, else the whole dimension. */
export function reportRowGroup(dimension: Dimension, value: string): string {
  if (dimension !== "event_prop") return "";
  const { event, key } = parseEventPropValue(value);
  return `${event}.${key}`;
}

// Every dimension is capped at its top rows; `event_prop` keeps that many per
// (event, key), so its list grows only with the props the site's code sends.
const ReportRowsSchema = cappedList(ReportRowSchema, {
  max: REPORT_ROWS_PER_DIMENSION,
});
const EventPropRowsSchema = wholeList(ReportRowSchema, {
  reason: `the top ${REPORT_ROWS_PER_DIMENSION} rows per (event, key) the site's code sends — bounded by its tracking calls, not its visitors`,
});
const rowsShape = Object.fromEntries(
  DIMENSIONS.map((dimension) => [
    dimension,
    dimension === "event_prop" ? EventPropRowsSchema : ReportRowsSchema,
  ]),
) as Record<Dimension, typeof ReportRowsSchema>;

export const AnalyticsReportSchema = z
  .object({
    source: z.enum(REPORT_SOURCES),
    range: AnalyticsRangeSchema,
    granularity: GranularitySchema,
    filters: cappedList(AnalyticsFilterSchema, { max: MAX_FILTERS }),
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
 * Why a query was refused, one arm per `reason`. Its own union: zod 4 refuses
 * two arms with the same `kind` in one discriminated union (lazily — on the
 * first parse, not at declaration), so the refusals nest under `kind:
 * "refused"` and are told apart by `reason`.
 */
const AnalyticsRefusalSchema = z.discriminatedUnion("reason", [
  z
    .object({
      kind: z.literal("refused"),
      reason: z.literal("stacked-filters-beyond-raw-window"),
      maxFilters: z.literal(MAX_TOTALS_FILTERS),
      rawWindowDays: z.literal(RAW_RETENTION_DAYS),
    })
    .strict(),
  z
    .object({
      kind: z.literal("refused"),
      reason: z.literal("audience-beyond-raw-window"),
      rawWindowDays: z.literal(RAW_RETENTION_DAYS),
    })
    .strict(),
]);

/**
 * The query endpoint's answer. `refused` is not an error to paper over: the
 * query asked for stacked filters on a range only the daily totals can answer
 * (those hold single filters only), or for an audience only the raw visits
 * know, beyond their window.
 */
export const AnalyticsQueryResultSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("report"), report: AnalyticsReportSchema })
    .strict(),
  AnalyticsRefusalSchema,
]);
export type AnalyticsQueryResult = z.infer<typeof AnalyticsQueryResultSchema>;

// ── Wire encoding ────────────────────────────────────────────────────────

export const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * A host-only question travels as ONE base64url query-string value.
 * base64url's alphabet (`A-Z a-z 0-9 - _`) needs no quoting in a URL nor in
 * the remote shell `sshRun` joins its argv into, so the dashboard can curl it
 * over SSH as-is.
 */
export function encodeBase64UrlJson(value: unknown): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(JSON.stringify(value))) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** The JSON text inside an encoded question. Throws on a value that is not base64url. */
export function decodeBase64UrlJson(encoded: string): string {
  if (!BASE64URL_PATTERN.test(encoded)) {
    throw new Error("analytics query: not base64url");
  }
  const binary = atob(encoded.replaceAll("-", "+").replaceAll("_", "/"));
  return new TextDecoder().decode(
    Uint8Array.from(binary, (char) => char.charCodeAt(0)),
  );
}

/** The `?q=` query-string schema of a question `schema`: decodes and validates in one step. */
export function base64UrlJsonParamSchema<S extends z.ZodType>(schema: S) {
  return z
    .object({
      q: z
        .string()
        .max(4096)
        .regex(BASE64URL_PATTERN)
        .transform((encoded, ctx) => {
          try {
            return JSON.parse(decodeBase64UrlJson(encoded)) as unknown;
          } catch (err) {
            // atob's malformed-length DOMException, JSON.parse's SyntaxError:
            // both are a bad request, not a server fault.
            if (!(err instanceof SyntaxError || err instanceof DOMException)) {
              throw err;
            }
            ctx.addIssue({
              code: "custom",
              message: "q is not base64url-encoded JSON",
            });
            return z.NEVER;
          }
        })
        .pipe(schema),
    })
    .strict();
}

/** The report's question on the wire (see {@link encodeBase64UrlJson}). */
export function encodeAnalyticsQuery(query: AnalyticsQuery): string {
  return encodeBase64UrlJson(withoutDefaultAudience(query));
}

/**
 * `query` without its `audience` when it is the default, which the schema
 * fills back in: a site released before audiences refuses the unknown key, and
 * still answers the default question.
 */
export function withoutDefaultAudience<Q extends { audience: string }>(
  query: Q,
): Omit<Q, "audience"> | Q {
  if (query.audience !== DEFAULT_AUDIENCE) return query;
  const { audience: _default, ...rest } = query;
  return rest;
}

/** The report endpoint's `?q=` schema. */
export const AnalyticsQueryParamSchema =
  base64UrlJsonParamSchema(AnalyticsQuerySchema);
