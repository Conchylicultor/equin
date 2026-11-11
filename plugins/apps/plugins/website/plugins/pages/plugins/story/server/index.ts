import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { WebsitePages } from "@plugins/apps/plugins/website/plugins/crawlable/server";
import { storyPage } from "../core";

export default {
  description:
    "The story page of the equin website on the server: its sitemap entry (WebsitePages.Page).",
  contributions: [WebsitePages.Page(storyPage)],
} satisfies ServerPluginDefinition;
