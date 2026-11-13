import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { WebsitePages } from "@plugins/apps/plugins/website/plugins/crawlable/server";
import { privacyPage } from "../core";

export default {
  description:
    "The privacy page of the equin website on the server: its sitemap entry (WebsitePages.Page).",
  contributions: [WebsitePages.Page(privacyPage)],
} satisfies ServerPluginDefinition;
