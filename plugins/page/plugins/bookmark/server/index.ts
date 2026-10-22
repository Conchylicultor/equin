import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Editor } from "@plugins/page/plugins/editor/server";
import { bookmarkBlock } from "../core";

export default {
  portable: true,
  description:
    "Registers the bookmark block's `data` schema at the server write boundary. Its link scraping (the bookmark.link-preview value, /api/link-meta) is the machine half's.",
  contributions: [Editor.BlockData(bookmarkBlock)],
} satisfies ServerPluginDefinition;
