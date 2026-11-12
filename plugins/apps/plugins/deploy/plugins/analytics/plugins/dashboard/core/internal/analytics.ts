import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { canonicalJson } from "@plugins/network/plugins/live/plugins/canonical-params/core";
import {
  AnalyticsQueryResultSchema,
  AnalyticsQuerySchema,
  type AnalyticsFilter,
} from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";

/**
 * The most bytes a question's filters may take, as canonical JSON (UTF-8).
 * With the deployment id capped at {@link DEPLOYMENT_ID_MAX_LENGTH} and the
 * range / compare fields' few dozen bytes, a question that passes it always
 * fits `LIVE_QUERY_MAX_BYTES` (2 KiB) — pinned by a test — so the read never
 * meets the size refusal: the dashboard checks {@link filtersFit} before it
 * adds or replaces a filter, and a row whose filter would not fit is disabled
 * with the reason.
 */
export const FILTERS_MAX_BYTES = 1536;

/** A deployment id's length cap in a question (ids are `dpl-<stamp>-<suffix>`, far shorter). */
export const DEPLOYMENT_ID_MAX_LENGTH = 128;

/** True when `filters` fit a question's {@link FILTERS_MAX_BYTES} budget. */
export function filtersFit(filters: readonly AnalyticsFilter[]): boolean {
  return (
    new TextEncoder().encode(canonicalJson(filters)).length <= FILTERS_MAX_BYTES
  );
}

/** One question to a deployment: which one, and collect's own query. */
export const DeploymentAnalyticsQuestionSchema = z
  .object({
    deploymentId: z.string().min(1).max(DEPLOYMENT_ID_MAX_LENGTH),
    query: AnalyticsQuerySchema.refine((q) => filtersFit(q.filters), {
      message: `the filters are over ${FILTERS_MAX_BYTES} bytes`,
    }),
  })
  .strict();
export type DeploymentAnalyticsQuestion = z.infer<
  typeof DeploymentAnalyticsQuestionSchema
>;

/**
 * This computer's copy of the site's analytics tables is not readable yet: no
 * whole first copy is in place (site-mirror is copying it, or no pull has
 * run). A pending state — the dashboard renders it as loading, beside the
 * freshness line that says how the copy is going — never an empty report.
 */
export const NotCopiedSchema = z
  .object({ kind: z.literal("not-copied") })
  .strict();

/**
 * What asking a deployment for its analytics answered: `report` / `refused`
 * (collect's own result, verbatim — run on this computer's copy of the site's
 * tables, as of the site's clock at the last page synced), or `not-copied`.
 * None of them is an empty report.
 */
export const DeploymentAnalyticsResultSchema = z.discriminatedUnion("kind", [
  ...AnalyticsQueryResultSchema.options,
  NotCopiedSchema,
]);
export type DeploymentAnalyticsResult = z.infer<
  typeof DeploymentAnalyticsResultSchema
>;

/**
 * A deployment's analytics report — collect's own `runAnalyticsQuery`, run on
 * this computer's copy of the site's analytics tables (site-mirror's
 * `analytics` set), as of the site's clock at the last page synced, so it is
 * exactly what the box would have answered then. One answer per
 * (deployment, query), pushed: every page the mirror applies recomputes it. A
 * deployment that does not exist is refused `missing`.
 *
 * Bounded: two periods' series (at most 24 hourly / 30 daily / 12 monthly
 * points each) and collect's top `REPORT_ROWS_PER_DIMENSION` (50) rows per
 * dimension — per (event, key) for `event_prop`, so that list grows only with
 * the event props the site's code sends, not with its visitors.
 */
export const deploymentAnalytics = liveValue("deploy-analytics.report", {
  schema: DeploymentAnalyticsResultSchema,
  query: DeploymentAnalyticsQuestionSchema,
  refusals: ["missing"],
});
