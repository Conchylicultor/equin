import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { rawEndpointHandler } from "@plugins/infra/plugins/endpoints/server";
import { robotsTxtEndpoint, sitemapXmlEndpoint } from "../core";
import { handleRobotsTxt, handleSitemapXml } from "./internal/routes";

export { WebsitePages } from "./internal/pages";

export default {
  description:
    "The website's pages on the server: the WebsitePages.Page collection every page plugin contributes its defineWebsitePage declaration to, and the public /robots.txt (allow all, pointing at the sitemap) and /sitemap.xml (one URL per page) built from it per request, origin from the request's X-Forwarded-Host (else Host) and X-Forwarded-Proto; both 404 in a composition with no pages.",
  httpRoutes: {
    [robotsTxtEndpoint.route]: rawEndpointHandler(
      robotsTxtEndpoint,
      handleRobotsTxt,
    ),
    [sitemapXmlEndpoint.route]: rawEndpointHandler(
      sitemapXmlEndpoint,
      handleSitemapXml,
    ),
  },
} satisfies ServerPluginDefinition;
