import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Editor } from "@plugins/page/plugins/editor/server";
import { bulletedListBlock } from "../core";

export default {
  description:
    "Bulleted-list block type: registers its `data` schema at the server write boundary.",
  contributions: [Editor.BlockData(bulletedListBlock)],
} satisfies ServerPluginDefinition;
