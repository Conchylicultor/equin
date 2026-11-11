import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { WebsitePages } from "@plugins/apps/plugins/website/plugins/crawlable/server";
import { appsPage } from "../core";

export default {
  description:
    "The apps gallery of the equin website on the server: its sitemap entry (WebsitePages.Page).",
  contributions: [WebsitePages.Page(appsPage)],
} satisfies ServerPluginDefinition;
