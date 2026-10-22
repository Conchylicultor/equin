import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { canonicalJson } from "@plugins/packages/plugins/canonical-params/core";
import { SshFailureKindSchema } from "@plugins/infra/plugins/ssh/core";
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

/** curl's own exit codes a failed remote request is explained by. */
export const CURL_EXIT = {
  /** Nothing listening on the loopback port: the install is down. */
  couldNotConnect: 7,
  /** HTTP status >= 400 (`-f`): typically 404, the site ships no analytics yet. */
  httpError: 22,
  /** `-m` deadline passed: the report query took too long. */
  timedOut: 28,
} as const;

/**
 * What asking a deployment for its analytics answered. Every member is a state
 * the dashboard renders — none of them is an empty report:
 *
 * - `report` / `refused` — the box answered (collect's own result, verbatim).
 * - `no-ssh-key` — the server has no SSH key yet.
 * - `unverified` — the server's host key was never pinned: the connection check
 *   has not succeeded once, so the box's identity is unknown.
 * - `ssh-failed` — SSH itself failed (unreachable, auth, host key changed…).
 * - `request-failed` — SSH worked; the curl on the box failed (`exitCode` is
 *   curl's, see {@link CURL_EXIT}).
 * - `unreadable-answer` — the box answered something that is not a report.
 */
export const DeploymentAnalyticsResultSchema = z.discriminatedUnion("kind", [
  ...AnalyticsQueryResultSchema.options,
  z.object({ kind: z.literal("no-ssh-key") }).strict(),
  z.object({ kind: z.literal("unverified") }).strict(),
  z
    .object({
      kind: z.literal("ssh-failed"),
      failure: SshFailureKindSchema,
      message: z.string(),
      stderr: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("request-failed"),
      exitCode: z.number().int().nullable(),
      stderr: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unreadable-answer"),
      /** Why parsing failed, and the head of what came back. */
      detail: z.string(),
    })
    .strict(),
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
