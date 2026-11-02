import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Editor } from "@plugins/page/plugins/editor/server";
import { numberedListBlock } from "../core";

export default {
  description:
    "Numbered-list block type: registers its `data` schema at the server write boundary.",
  contributions: [Editor.BlockData(numberedListBlock)],
} satisfies ServerPluginDefinition;
