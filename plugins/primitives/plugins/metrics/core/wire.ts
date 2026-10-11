import { z } from "zod";
import { BREAKDOWN_ORDERS, MEASURES, POLARITIES, UNITS } from "./define-metric";
import { BUCKET_UNITS, PRESETS, isTimeZone } from "./intervals";
import { ParamSpecWireSchema } from "./params";

// The wire contract between the served metrics values (`./live.ts`) and every
// surface that draws a metric. The browser never imports a provider: it reads
// the catalog and asks queries.

const isoInstant = z.string().datetime({ offset: true });

export const IntervalSchema = z.object({ start: isoInstant, end: isoInstant });

export const BucketSchema = IntervalSchema.extend({
  partial: z.boolean(),
  short: z.string(),
  label: z.string(),
});

export const RangeSpecSchema = z.union([
  z.object({ preset: z.enum(PRESETS) }).strict(),
  z.object({ interval: IntervalSchema, bucket: z.enum(BUCKET_UNITS) }).strict(),
]);

const queryBase = {
  /** A metric or breakdown global id, `<source>.<id>`. */
  metric: z.string(),
  range: RangeSpecSchema,
  tz: z.string().refine(isTimeZone, { message: "unknown time zone" }),
  /** Raw values, parsed server-side against the metric's own ParamSpecs. */
  params: z.record(z.unknown()),
};

/**
 * Either split by one dimension, or compare with the previous period — never
 * both: a previous-period line only reads against a single total, so the pair
 * has no spelling (strict objects reject a body carrying both).
 */
export const MetricQuerySchema = z.union([
  z.object({ ...queryBase, split: z.string() }).strict(),
  z.object({ ...queryBase, compare: z.boolean() }).strict(),
]);
export type MetricQuery = z.infer<typeof MetricQuerySchema>;

/** A value per bucket; `null` = not covered (drawn as a gap, never as 0). */
const values = z.array(z.number().nullable());

export const SeriesSchema = z.object({
  key: z.string(),
  label: z.string(),
  values,
  /** This series' tile value (see `tileValue`); null when not covered. */
  total: z.number().nullable(),
});
export type Series = z.infer<typeof SeriesSchema>;

export const EntityLinkSchema = z.object({ href: z.string() });
export type EntityLink = z.infer<typeof EntityLinkSchema>;

export const BreakdownRowSchema = z.object({
  key: z.string(),
  label: z.string(),
  value: z.number(),
  link: EntityLinkSchema.optional(),
});
export type BreakdownRow = z.infer<typeof BreakdownRowSchema>;

export const SeriesResultSchema = z.object({
  kind: z.literal("series"),
  buckets: z.array(BucketSchema),
  series: z.array(SeriesSchema),
  /** The tile value of the whole query; for a split query, from an unsplit evaluation. */
  total: z.number().nullable(),
  /** Present iff the query asked to compare (and so is unsplit). */
  previous: z
    .object({
      buckets: z.array(BucketSchema),
      values,
      total: z.number().nullable(),
      label: z.string(),
    })
    .optional(),
});
export type SeriesResult = z.infer<typeof SeriesResultSchema>;

export const BreakdownResultSchema = z.object({
  kind: z.literal("breakdown"),
  rows: z.array(BreakdownRowSchema),
});
export type BreakdownResult = z.infer<typeof BreakdownResultSchema>;

export const MetricResultSchema = z.discriminatedUnion("kind", [
  SeriesResultSchema,
  BreakdownResultSchema,
]);
export type MetricResult = z.infer<typeof MetricResultSchema>;

/**
 * One record behind a bucket. `at` is a UTC instant at exactly millisecond
 * precision (`2026-10-01T09:30:00.000Z` — `Date#toISOString`), so its text
 * order IS its time order: the drill-down pages cut at it
 * (`metricDetails`'s key).
 */
export const DrillItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  subtitle: z.string().optional(),
  value: z.number().optional(),
  at: z.string().datetime({ precision: 3 }),
  link: EntityLinkSchema.optional(),
});
export type DrillItem = z.infer<typeof DrillItemSchema>;

/**
 * What a drill-down's question shares, whatever page is read: how many
 * records the bucket holds — `null` when its metric does not count them (no
 * `detailsTotal`).
 */
export const DrillMetaSchema = z.object({
  total: z.number().int().nonnegative().nullable(),
});
export type DrillMeta = z.infer<typeof DrillMetaSchema>;

/**
 * Which records to list: one bucket (or one series of it). The page — its key
 * range and limit — is the paged value's own tuple, never part of the question.
 */
export const DetailsSelectorSchema = z
  .object({
    metric: z.string(),
    interval: IntervalSchema,
    /** The split dimension and the one key whose records to list; null = every record. */
    split: z.object({ id: z.string(), key: z.string() }).nullable(),
    params: z.record(z.unknown()),
  })
  .strict();
export type DetailsSelector = z.infer<typeof DetailsSelectorSchema>;

const SplitDeclSchema = z.object({ id: z.string(), label: z.string() });

export const CatalogMetricSchema = z.object({
  id: z.string(),
  source: z.string(),
  label: z.string(),
  description: z.string().optional(),
  unit: z.enum(UNITS),
  polarity: z.enum(POLARITIES),
  measure: z.enum(MEASURES),
  splits: z.array(SplitDeclSchema),
  params: z.array(z.string()),
  drill: z.object({ label: z.string() }).optional(),
});
export type CatalogMetric = z.infer<typeof CatalogMetricSchema>;

export const CatalogBreakdownSchema = z.object({
  id: z.string(),
  source: z.string(),
  label: z.string(),
  unit: z.enum(UNITS),
  order: z.enum(BREAKDOWN_ORDERS),
  params: z.array(z.string()),
});
export type CatalogBreakdown = z.infer<typeof CatalogBreakdownSchema>;

export const CatalogSourceSchema = z.object({
  id: z.string(),
  label: z.string(),
  params: z.array(ParamSpecWireSchema),
});
export type CatalogSource = z.infer<typeof CatalogSourceSchema>;

export const CatalogSchema = z.object({
  sources: z.array(CatalogSourceSchema),
  metrics: z.array(CatalogMetricSchema),
  breakdowns: z.array(CatalogBreakdownSchema),
});
export type Catalog = z.infer<typeof CatalogSchema>;
