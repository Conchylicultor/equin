import { WebsitePages } from "@plugins/apps/plugins/website/plugins/crawlable/server";
import { guidePage, GUIDE_READY } from "../core";

/** The guide's sitemap entry, present only once the guide is written. */
export const guideSitemap = GUIDE_READY ? [WebsitePages.Page(guidePage)] : [];
