import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { guideSitemap } from "./sitemap";

export default {
  description:
    "The getting-started guide of the equin website on the server: its sitemap entry (WebsitePages.Page), listed only once the guide is written (GUIDE_READY).",
  contributions: guideSitemap,
} satisfies ServerPluginDefinition;
