import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Editor } from "@plugins/page/plugins/editor/server";
import { textBlock } from "../core";

export default {
  description:
    "Plain-text block type: registers its `data` schema at the server write boundary.",
  contributions: [Editor.BlockData(textBlock)],
} satisfies ServerPluginDefinition;
