import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { HOST_ONLY_PREFIX } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/host-only/core";
import { CollectBodySchema, CollectResponseSchema } from "./collect-body";
import { AnalyticsQueryParamSchema, AnalyticsQueryResultSchema } from "./query";
import {
  SessionCountsQueryParamSchema,
  SessionCountsResultSchema,
  SessionsQueryParamSchema,
  SessionsResultSchema,
} from "./sessions";

/**
 * Public ingest. The tracker posts one body per pageview / event / engagement
 * beacon (`fetchEndpoint(collectEndpoint, {}, { body, keepalive: true })`).
 */
export const collectEndpoint = defineEndpoint({
  route: "POST /api/analytics/collect",
  body: CollectBodySchema,
  response: CollectResponseSchema,
  access: {
    public:
      "a deployed site's visitors send its beacons — anonymous by design, bounded by the body cap and schema",
  },
});

/**
 * The report, answered only on the box (wrapped in `hostOnly`, refused by
 * Caddy publicly). The deploy dashboard reads it over SSH with
 * the analytics dashboard's server half.
 */
export const analyticsQueryEndpoint = defineEndpoint({
  // `satisfies`: the route fails to compile if it ever leaves the host-only
  // prefix, which is what Caddy refuses publicly.
  route:
    "GET /api/host-only/analytics/query" satisfies `GET ${typeof HOST_ONLY_PREFIX}${string}`,
  query: AnalyticsQueryParamSchema,
  response: AnalyticsQueryResultSchema,
  dedupe: true,
});

/**
 * Individual visits with their hits, newest first, one key range at a time —
 * host-only like the report, read over SSH by the deploy app's Sessions tab.
 */
export const analyticsSessionsEndpoint = defineEndpoint({
  route:
    "GET /api/host-only/analytics/sessions" satisfies `GET ${typeof HOST_ONLY_PREFIX}${string}`,
  query: SessionsQueryParamSchema,
  response: SessionsResultSchema,
  dedupe: true,
});

/**
 * How many visits of a range pass the filters, per shape — host-only, read
 * over SSH by the Sessions tab once per question (its meta), apart from the
 * pages: counting costs the whole range, a page only its own visits.
 */
export const analyticsSessionCountsEndpoint = defineEndpoint({
  route:
    "GET /api/host-only/analytics/session-counts" satisfies `GET ${typeof HOST_ONLY_PREFIX}${string}`,
  query: SessionCountsQueryParamSchema,
  response: SessionCountsResultSchema,
  dedupe: true,
});
