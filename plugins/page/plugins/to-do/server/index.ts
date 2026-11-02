import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Editor } from "@plugins/page/plugins/editor/server";
import { toDoBlock } from "../core";

export default {
  description:
    "To-do (checkbox) block type: registers its `data` schema at the server write boundary.",
  contributions: [Editor.BlockData(toDoBlock)],
} satisfies ServerPluginDefinition;
