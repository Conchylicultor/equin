import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Editor } from "@plugins/page/plugins/editor/server";
import { audioBlock } from "../core";

export default {
  description:
    "Audio block type: registers its `data` schema (attachment) at the server write boundary.",
  contributions: [Editor.BlockData(audioBlock)],
} satisfies ServerPluginDefinition;
