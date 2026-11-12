import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { SiteMessageBodySchema, SiteMessageResponseSchema } from "./message";

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
