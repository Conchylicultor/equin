import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import type { HOST_ONLY_PREFIX } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/host-only/core";
import { SiteMessageBodySchema, SiteMessageResponseSchema } from "./message";
import {
  SiteMessagesListQuerySchema,
  SiteMessagesPageSchema,
  type SiteMessagesListQuery,
} from "./record";

/** Public: the contact form posts one message. */
export const sendSiteMessageEndpoint = defineEndpoint({
  route: "POST /api/site-messages",
  body: SiteMessageBodySchema,
  response: SiteMessageResponseSchema,
  access: {
    public:
      "a deployed site's visitors send it from the contact form — anonymous by design, limited by the body cap, rate limit and spam rules",
  },
  unpredicted: {
    reason: "response",
    why: "the form renders the sent versus rate-limited result inline",
  },
});

/**
 * The stored messages, answered only on the box (wrapped in `hostOnly`,
 * refused by Caddy publicly). The deploy app's inbox reads it over SSH with
 * {@link siteMessagesListPath}.
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

/** Path + query string for one list ask, to append to `http://127.0.0.1:<port>`. */
export function siteMessagesListPath(query: SiteMessagesListQuery): string {
  const params = new URLSearchParams();
  if (query.verdict !== undefined) params.set("verdict", query.verdict);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const search = params.toString();
  return search === ""
    ? siteMessagesListEndpoint.path
    : `${siteMessagesListEndpoint.path}?${search}`;
}
