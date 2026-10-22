import { liveValue } from "@plugins/network/plugins/live/core";
import { LinkPreviewSchema } from "./schemas";

/**
 * The rich preview of one link, keyed by its `url`: title, description, site
 * name, and the og:image + favicon cached as same-origin attachments (their
 * ids). Read by a bookmark block while it has no preview yet; the block copies
 * the answer into its data and stops reading.
 *
 * On-demand: a scrape of a third-party page nothing pushes a change to.
 *
 * Refusals:
 * - `blocked` — the url is not a public http(s) address (SSRF guard), or does
 *   not parse;
 * - `unreachable` — the page answered with a non-2xx status.
 */
export const linkPreview = liveValue("bookmark.link-preview", {
  schema: LinkPreviewSchema,
  params: ["url"],
  refusals: ["blocked", "unreachable"],
  load: "on-demand",
});
