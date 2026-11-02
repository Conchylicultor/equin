import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Editor } from "@plugins/page/plugins/editor/server";
import { imageBlock } from "../core";

export default {
  description:
    "Image block type: registers its `data` schema (attachment + width) at the server write boundary.",
  contributions: [Editor.BlockData(imageBlock)],
} satisfies ServerPluginDefinition;
