import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { canonicalJson } from "@plugins/packages/plugins/canonical-params/core";
import { HOST_QUERY_FAILURE_ARMS } from "@plugins/apps/plugins/deploy/plugins/host-query/core";
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
 * What asking a deployment for its analytics answered. Every member is a state
 * the dashboard renders — none of them is an empty report: `report` /
 * `refused` (collect's own result, verbatim), or one of host-query's failure
 * arms (no SSH key, unverified host, SSH or the request failed, an unreadable
 * answer).
 */
export const DeploymentAnalyticsResultSchema = z.discriminatedUnion("kind", [
  ...AnalyticsQueryResultSchema.options,
  ...HOST_QUERY_FAILURE_ARMS,
]);
export type DeploymentAnalyticsResult = z.infer<
  typeof DeploymentAnalyticsResultSchema
>;

/**
 * A deployment's analytics report, read over SSH from its box — one answer per
 * (deployment, query). A snapshot: the report is the deployed site's own data,
 * which changes with every visit and has no change signal here, so it is
 * measured when a reader asks (each mount, and the dashboard's Refresh,
 * `refresh()`), never on a timer — each measure is an SSH session. A
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
  load: "snapshot",
  refusals: ["missing"],
});
