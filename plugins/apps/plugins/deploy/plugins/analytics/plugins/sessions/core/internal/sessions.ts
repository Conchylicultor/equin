import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { HOST_QUERY_FAILURE_ARMS } from "@plugins/apps/plugins/deploy/plugins/host-query/core";
import {
  AnalyticsRangeSchema,
  AudienceSchema,
  MAX_SESSIONS_LIMIT,
  RAW_RETENTION_DAYS,
  SESSIONS_PAGE,
  SessionCountsSchema,
  SessionSchema,
  SessionShapeSchema,
} from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";

/** A deployment id's length cap in a question (ids are `dpl-<stamp>-<suffix>`, far shorter). */
const DEPLOYMENT_ID_MAX_LENGTH = 128;

/**
 * One question to a deployment: which one, which days, which visits. Paging
 * (`after` / `until` / `limit`) is the paged value's, never the question's.
 */
export const DeploymentSessionsQuestionSchema = z
  .object({
    deploymentId: z.string().min(1).max(DEPLOYMENT_ID_MAX_LENGTH),
    range: AnalyticsRangeSchema,
    shape: SessionShapeSchema,
    /** Whose visits: everyone but the site's owner, the owner's own, or both. */
    audience: AudienceSchema,
  })
  .strict();
export type DeploymentSessionsQuestion = z.infer<
  typeof DeploymentSessionsQuestionSchema
>;

/**
 * What the question's per-question sibling answers: the visits per shape over
 * the whole range (the switch's counts, the summary's total) — or why the box
 * could not say. Every member is a state the tab renders, never an empty list:
 * `sessions` (the counts), `refused` (the range reaches past the raw window),
 * or one of host-query's failure arms (no SSH key, unverified host, SSH or the
 * request failed, an unreadable answer).
 */
export const DeploymentSessionsMetaSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("sessions"),
      /** ISO instant the box answered at. */
      generatedAt: z.iso.datetime(),
      counts: SessionCountsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("refused"),
      reason: z.literal("beyond-raw-window"),
      rawWindowDays: z.literal(RAW_RETENTION_DAYS),
    })
    .strict(),
  ...HOST_QUERY_FAILURE_ARMS,
]);
export type DeploymentSessionsMeta = z.infer<
  typeof DeploymentSessionsMetaSchema
>;

/**
 * A deployment's visits, newest first, read over SSH from its box as
 * key-range pages — one SSH session per page, measured when a read first
 * needs it (page 0 on mount, the next as the list scrolls) and re-measured by
 * `refresh()`, never on a timer: the box has no change signal here.
 *
 * The order is collect's `(started_at desc, id desc)`, so the key spells BOTH
 * parts (the primitive's own tie-break is id ascending, which would disagree
 * with the box on two visits started in the same millisecond). `startedAt` is
 * `toISOString()`'s fixed-width spelling, so its text order is its time order.
 *
 * A page that cannot be read is refused (`missing`: the deployment is gone;
 * `unreachable`: SSH or the request failed — the meta sibling carries which,
 * typed, for the tab to render; `beyond-raw-window`: the range reaches past
 * the raw rows). Bounded: ≤ {@link MAX_SESSIONS_LIMIT} visits a page, each
 * with ≤ 200 hits (collect's caps).
 */
export const deploymentSessions = liveValue("deploy-analytics.sessions", {
  query: DeploymentSessionsQuestionSchema,
  paged: {
    item: SessionSchema,
    id: "id",
    key: { of: (v) => [v.startedAt, v.id], order: ["desc", "desc"] },
    limit: SESSIONS_PAGE,
    maxLimit: MAX_SESSIONS_LIMIT,
    meta: DeploymentSessionsMetaSchema,
  },
  load: "snapshot",
  refusals: ["missing", "unreachable", "beyond-raw-window"],
});
