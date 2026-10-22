import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { LinkMetaSchema } from "./schemas";

/**
 * The light twin of the `linkPreview` value: the same SSRF-guarded fetch and
 * parse, but it downloads no image. For callers that want only the page's
 * title (the pasted-link Mention) — every link-preview read caches the
 * og:image and favicon as attachments, which nothing would ever link.
 */
export const linkMetaEndpoint = defineEndpoint({
  route: "GET /api/link-meta",
  query: z.object({ url: z.string() }),
  response: LinkMetaSchema,
});
