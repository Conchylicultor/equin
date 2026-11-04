import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import type { HOST_ONLY_PREFIX } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/host-only/core";
import { SiteMessageBodySchema, SiteMessageResponseSchema } from "./message";
import { SiteMessagesListQuerySchema, SiteMessagesPageSchema } from "./record";

/** Public: the contact form posts one message. */
export const sendSiteMessageEndpoint = defineEndpoint({
  route: "POST /api/site-messages",
  body: SiteMessageBodySchema,
  response: SiteMessageResponseSchema,
  access: {
    public:
      "a deployed site's visitors send it from the contact form — anonymous by design, limited by the body cap, rate limit and spam rules",
  },
});

/**
 * The stored messages, answered only on the box (wrapped in `hostOnly`,
 * refused by Caddy publicly). The deploy app's inbox reads it over SSH with
 * the inbox's server half.
 */
export const siteMessagesListEndpoint = defineEndpoint({
  // `satisfies`: the route fails to compile if it ever leaves the host-only
  // prefix, which is what Caddy refuses publicly.
  route:
    "GET /api/host-only/site-messages" satisfies `GET ${typeof HOST_ONLY_PREFIX}${string}`,
  query: SiteMessagesListQuerySchema,
  response: SiteMessagesPageSchema,
  dedupe: true,
});
