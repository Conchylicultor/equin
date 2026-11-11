import { blob, defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

const PUBLIC_REASON =
  "what a crawler reads before anything else: a search engine or an AI agent is never the owner";

/**
 * `/robots.txt` — allow everything, point at the sitemap. Declared at the
 * root, where crawlers look for it (RFC 9309), not under `/api/`: the gateway
 * forwards these two exact paths to the backend.
 */
export const robotsTxtEndpoint = defineEndpoint({
  route: "GET /robots.txt",
  access: { public: PUBLIC_REASON },
  response: blob(),
});

/** `/sitemap.xml` — one `<url>` per declared website page. */
export const sitemapXmlEndpoint = defineEndpoint({
  route: "GET /sitemap.xml",
  access: { public: PUBLIC_REASON },
  response: blob(),
});
