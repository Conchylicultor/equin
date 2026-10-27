import { liveValue } from "@plugins/network/plugins/live/core";
import { LinkMetaSchema, LinkPreviewSchema } from "./schemas";

/**
 * What fetching a link needs: the computer's network, through the SSRF guard
 * (its DNS resolved and the dial pinned) — a host without the computer
 * answers the link-preview and link-meta values unavailable.
 */
const LINK_FETCH = { feature: "Fetching a link's preview" } as const;

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
  // Scraped over the computer's network (SSRF-guarded, dial pinned).
  needsMachine: LINK_FETCH,
});

/**
 * The light twin of {@link linkPreview}: the same SSRF-guarded fetch and
 * parse, but only the page's title and no image download — every link-preview
 * read caches the og:image and favicon as attachments, which a caller wanting
 * the title alone (the pasted-link Mention) would never link. Same refusals,
 * same on-demand load, same computer.
 */
export const linkMeta = liveValue("bookmark.link-meta", {
  schema: LinkMetaSchema,
  params: ["url"],
  refusals: ["blocked", "unreachable"],
  load: "on-demand",
  needsMachine: LINK_FETCH,
});
