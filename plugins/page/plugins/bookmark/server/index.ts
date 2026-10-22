import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Editor } from "@plugins/page/plugins/editor/server";
import { bookmarkBlock, linkMetaEndpoint } from "../core";
import { handleLinkMeta } from "./internal/handle-link-meta";
import { linkPreviewServed } from "./internal/link-preview-served";

export default {
  description:
    "Link-preview scraper for the bookmark block (the live bookmark.link-preview value): fetches a URL (SSRF-guarded), extracts OG/Twitter metadata via HTMLRewriter, and caches og:image + favicon as same-origin attachments. Also serves a title-only lookup (/api/link-meta, no image downloads) for the pasted-link Mention, and registers the bookmark `data` schema at the server write boundary.",
  httpRoutes: {
    [linkMetaEndpoint.route]: handleLinkMeta,
  },
  contributions: [
    Editor.BlockData(bookmarkBlock),
    ...linkPreviewServed.declare,
  ],
} satisfies ServerPluginDefinition;
