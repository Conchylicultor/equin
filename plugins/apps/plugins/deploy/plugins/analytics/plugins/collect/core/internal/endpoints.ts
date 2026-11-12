import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { CollectBodySchema, CollectResponseSchema } from "./collect-body";

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
