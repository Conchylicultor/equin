import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Editor } from "@plugins/page/plugins/editor/server";
import { promptBlock } from "../core";

export default {
  description:
    "Prompt block type: registers its `data` schema (plain block text) at the server write boundary.",
  contributions: [Editor.BlockData(promptBlock)],
} satisfies ServerPluginDefinition;
