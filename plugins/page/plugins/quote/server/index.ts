import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Editor } from "@plugins/page/plugins/editor/server";
import { quoteBlock } from "../core";

export default {
  description:
    "Quote block type: registers its (empty) `data` schema at the server write boundary, rejecting stray keys like an injected `text`.",
  contributions: [Editor.BlockData(quoteBlock)],
} satisfies ServerPluginDefinition;
