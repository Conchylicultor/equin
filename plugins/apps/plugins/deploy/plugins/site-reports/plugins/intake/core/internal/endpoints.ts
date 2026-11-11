import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import type { HOST_ONLY_PREFIX } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/host-only/core";
import { SiteReportsBodySchema, SiteReportsResponseSchema } from "./body";
import { SiteReportsListQuerySchema, SiteReportsPageSchema } from "./record";

/**
 * Public: a site page's report channel posts a batch of error reports. The one
 * route a site's live demo reaches on the page's server for its errors — the
 * page's collectors call it, never the demo's own code.
 */
export const siteReportsEndpoint = defineEndpoint({
  route: "POST /api/site-reports",
  body: SiteReportsBodySchema,
  response: SiteReportsResponseSchema,
  access: {
    public:
      "a deployed site's visitors' pages report the errors they hit — anonymous by design, bounded by the body cap, per-visitor and global batch budgets, the reports fan-out ceiling and a row cap, aggregated one row per fingerprint",
  },
});

/**
 * The aggregated reports and drop counts, answered only on the box (wrapped
 * in `hostOnly`, refused by Caddy publicly) — read over SSH by the deploy app.
 */
export const siteReportsListEndpoint = defineEndpoint({
  route:
    "GET /api/host-only/site-reports" satisfies `GET ${typeof HOST_ONLY_PREFIX}${string}`,
  query: SiteReportsListQuerySchema,
  response: SiteReportsPageSchema,
  dedupe: true,
});
