import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { linkMetaServed } from "./internal/link-meta-served";
import { linkPreviewServed } from "./internal/link-preview-served";

export default {
  description:
    "Link-preview scraper for the bookmark block, desktop-only half (the bookmark.link-preview and bookmark.link-meta values, both needsMachine): fetches a URL (SSRF-guarded, its DNS resolved and the dial pinned), extracts OG/Twitter metadata via HTMLRewriter, and caches og:image + favicon as same-origin attachments. bookmark.link-meta is the title-only lookup (no image downloads) for the pasted-link Mention.",
  contributions: [...linkPreviewServed.declare, ...linkMetaServed.declare],
} satisfies MachinePluginDefinition;
