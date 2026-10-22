import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { linkMetaEndpoint } from "../core";
import { handleLinkMeta } from "./internal/handle-link-meta";
import { linkPreviewServed } from "./internal/link-preview-served";

export default {
  description:
    "Link-preview scraper for the bookmark block, desktop-only half (the bookmark.link-preview value and /api/link-meta, both needsMachine): fetches a URL (SSRF-guarded, its DNS resolved and the dial pinned), extracts OG/Twitter metadata via HTMLRewriter, and caches og:image + favicon as same-origin attachments. Also serves a title-only lookup (/api/link-meta, no image downloads) for the pasted-link Mention.",
  httpRoutes: {
    [linkMetaEndpoint.route]: handleLinkMeta,
  },
  contributions: [...linkPreviewServed.declare],
} satisfies MachinePluginDefinition;
