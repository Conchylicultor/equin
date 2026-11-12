import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { SiteReportsBodySchema, SiteReportsResponseSchema } from "./body";

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
