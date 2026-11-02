import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Editor } from "@plugins/page/plugins/editor/server";
import { codeBlock } from "../core";

export default {
  description:
    "Code block type: registers its `data` schema (code + language) at the server write boundary.",
  contributions: [Editor.BlockData(codeBlock)],
} satisfies ServerPluginDefinition;
