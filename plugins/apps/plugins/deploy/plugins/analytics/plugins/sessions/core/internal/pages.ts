import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";

/**
 * The most paths a site's page list holds. A site's own paths number in the
 * dozens; past this the list would be the wrong tool (a filter picker over
 * thousands of paths), so the read refuses rather than drop some — a picker
 * missing a path could not filter by it.
 */
export const MAX_SITE_PAGES = 500;

/** One path a site's visits hit, with how many of them hit it. */
export const SitePageSchema = z
  .object({ path: z.string(), visits: z.number().int() })
  .strict();
export type SitePage = z.infer<typeof SitePageSchema>;

/**
 * Every path a site's visits hit — the values the Sessions list's `pages`
 * column takes, so its Pages filter offers them — read from this computer's
 * copy of the site's analytics (collect's own SQL), most visited first. Pushed
 * as the sessions list is: every page a pull applies to the copy re-reads it.
 */
export const deploymentPages = liveValue("deploy-analytics.pages", {
  schema: cappedList(SitePageSchema, { max: MAX_SITE_PAGES }),
  params: ["deploymentId"],
});
