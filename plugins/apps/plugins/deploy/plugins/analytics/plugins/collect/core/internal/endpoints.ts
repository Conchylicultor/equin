import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { HOST_ONLY_PREFIX } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/host-only/core";
import { CollectBodySchema, CollectResponseSchema } from "./collect-body";
import {
  AnalyticsQueryParamSchema,
  AnalyticsQueryResultSchema,
  encodeAnalyticsQuery,
  type AnalyticsQuery,
} from "./query";

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
 * {@link analyticsQueryPath}.
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

/** Path + query string for `query`, to append to `http://127.0.0.1:<port>`. */
export function analyticsQueryPath(query: AnalyticsQuery): string {
  return `${analyticsQueryEndpoint.path}?q=${encodeAnalyticsQuery(query)}`;
}
