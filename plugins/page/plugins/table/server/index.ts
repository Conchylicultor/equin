import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Editor } from "@plugins/page/plugins/editor/server";
import { tableBlock } from "../core";

export default {
  description:
    "Table block type: registers its `data` schema (column alignment, header cells, body rows) at the server write boundary.",
  contributions: [Editor.BlockData(tableBlock)],
} satisfies ServerPluginDefinition;
