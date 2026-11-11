import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { WebsitePages } from "@plugins/apps/plugins/website/plugins/crawlable/server";
import { landingPage } from "../core";

export default {
  description:
    "The website's landing page on the server: its sitemap entry (WebsitePages.Page).",
  contributions: [WebsitePages.Page(landingPage)],
} satisfies ServerPluginDefinition;
