import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";
import type { WebsitePage } from "../../core";

/**
 * The website's pages, as the server knows them: each page plugin's
 * `server/index.ts` contributes its `defineWebsitePage` declaration —
 * `WebsitePages.Page(downloadPage)`. Read only through the generic collection
 * (robots.txt, sitemap.xml); no consumer names a page. That every page with a
 * pane is contributed here, and nothing else, is the
 * `crawlable:pages-declared` check.
 */
export const WebsitePages = {
  Page: defineServerContribution<WebsitePage>("apps.website.crawlable.page", {
    docLabel: (p) => p.path,
  }),
};
