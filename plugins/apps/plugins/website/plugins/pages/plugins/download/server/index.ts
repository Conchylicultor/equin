import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { WebsitePages } from "@plugins/apps/plugins/website/plugins/crawlable/server";
import { downloadPage } from "../core";

export default {
  description:
    "The download page of the equin website on the server: its sitemap entry (WebsitePages.Page).",
  contributions: [WebsitePages.Page(downloadPage)],
} satisfies ServerPluginDefinition;
